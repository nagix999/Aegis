"""No real DNS or sockets: exercise the actual HTTPX/httpcore integration."""
import asyncio
import socket

import httpcore
import httpx
import pytest

from aegis.upstream_transport import UpstreamTransport, ValidatedNetworkBackend, upstream_client
from aegis.engine import PolicyError, approved_url


class RecordingStream(httpcore.AsyncMockStream):
    def __init__(self, buffer):
        super().__init__(buffer)
        self.writes = []

    async def write(self, buffer, timeout=None):
        self.writes.append(buffer)

    async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        self.sni = server_hostname
        self.verified = ssl_context.check_hostname
        return self


class RecordingBackend(httpcore.AsyncNetworkBackend):
    def __init__(self):
        self.connected = []
        self.streams = []

    async def connect_tcp(self, host, port, **kwargs):
        self.connected.append((host, port))
        stream = RecordingStream([b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK"])
        self.streams.append(stream)
        return stream


def answers(*addresses):
    async def resolve(host, port, **kwargs):
        return [(socket.AF_INET6 if ':' in address else socket.AF_INET, socket.SOCK_STREAM,
                 socket.IPPROTO_TCP, '', (address, port)) for address in addresses]
    return resolve


@pytest.mark.parametrize('address', ['127.0.0.1', '10.20.30.40', '169.254.169.254', '100.64.0.1', '0.0.0.0',
                                    '192.0.2.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:8.8.8.8'])
@pytest.mark.parametrize('scheme', ['http', 'https'])
async def test_private_reserved_and_mapped_dns_answers_never_connect(address, scheme):
    backend = RecordingBackend()
    transport = UpstreamTransport(backend=backend, resolver=answers(address))
    async with httpx.AsyncClient(transport=transport, trust_env=False) as client:
        with pytest.raises(httpx.ConnectError):
            await client.get(f'{scheme}://allowed.example/v1/models')
    assert backend.connected == []


@pytest.mark.parametrize('scheme', ['http', 'https'])
async def test_any_private_answer_blocks_the_entire_destination_before_connecting(scheme):
    backend = RecordingBackend()
    transport = UpstreamTransport(backend=backend, resolver=answers('8.8.8.8', '10.0.0.1'))
    async with httpx.AsyncClient(transport=transport, trust_env=False) as client:
        with pytest.raises(httpx.ConnectError):
            await client.get(f'{scheme}://allowed.example/v1/models')
    assert not backend.connected


async def test_connection_is_pinned_to_checked_ip_and_original_tls_hostname_is_preserved():
    backend, calls = RecordingBackend(), []
    async def resolver(host, port, **kwargs):
        calls.append(host)
        return await answers('8.8.8.8' if len(calls) == 1 else '127.0.0.1')(host, port, **kwargs)
    async with httpx.AsyncClient(transport=UpstreamTransport(backend=backend, resolver=resolver), trust_env=False) as client:
        response = await client.get('https://allowed.example/v1/models')
        assert response.text == 'OK'
        # Connection: close forces another resolution; changed DNS must fail.
        with pytest.raises(httpx.ConnectError):
            await client.get('https://allowed.example/v1/models')
    assert calls == ['allowed.example', 'allowed.example']
    assert backend.connected == [('8.8.8.8', 443)]
    assert backend.streams[0].sni == 'allowed.example'
    assert backend.streams[0].verified is True
    assert b'Host: allowed.example\r\n' in b''.join(backend.streams[0].writes)


@pytest.mark.parametrize('host', ['127.1', '2130706433', '0x7f000001', '0177.0.0.1', 'public.example.'])
async def test_alternate_host_spellings_are_validated_after_resolution(host):
    backend = RecordingBackend()
    protected = ValidatedNetworkBackend(backend=backend, resolver=answers('127.0.0.1'))
    with pytest.raises(httpcore.ConnectError):
        await protected.connect_tcp(host, 443)
    assert not backend.connected


async def test_private_model_opt_in_still_uses_a_pinned_ip_and_normal_tls():
    backend = RecordingBackend()
    async with httpx.AsyncClient(transport=UpstreamTransport(allow_private=True, backend=backend, resolver=answers('10.0.0.8')), trust_env=False) as client:
        assert (await client.get('https://internal.example/v1/models')).text == 'OK'
    assert backend.connected == [('10.0.0.8', 443)]
    assert backend.streams[0].sni == 'internal.example'
    assert backend.streams[0].verified is True


async def test_dns_timeout_is_bounded_and_mapped_to_httpx_timeout():
    async def never(host, port, **kwargs):
        await asyncio.Event().wait()
    async with httpx.AsyncClient(transport=UpstreamTransport(resolver=never), trust_env=False) as client:
        with pytest.raises(httpx.ConnectTimeout):
            await client.get('https://allowed.example/v1/models', timeout=.01)


async def test_ambient_proxy_settings_do_not_add_a_proxy_transport(monkeypatch):
    monkeypatch.setenv('HTTPS_PROXY', 'http://not-used.invalid:1')
    async with upstream_client({}) as client:
        assert client.trust_env is False
        assert isinstance(client._transport, UpstreamTransport)
        assert not client._mounts


@pytest.mark.parametrize('host', ['localhost.', 'model.local.', 'service.internal.'])
def test_trailing_dot_local_names_are_rejected_before_network(host):
    connection = {'id': 'm', 'name': 'model', 'model': 'example', 'mode': 'vllm', 'role': 'main',
                  'baseUrl': f'https://{host}/v1', 'secretEnv': '', 'timeoutMs': 1000}
    with pytest.raises(PolicyError):
        approved_url(connection, {'allowedOrigins': [f'https://{host}']}, {})
