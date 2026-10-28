"""Resolve once, validate every answer, and connect only to a validated IP.

HTTP core retains the original origin for Host, SNI, certificate verification
and connection pooling. The network backend receives the hostname only once;
its delegate receives a numeric address, never an unchecked second DNS lookup.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
import time

import httpcore
import httpx


class ValidatedNetworkBackend(httpcore.AsyncNetworkBackend):
    def __init__(self, *, allow_private: bool = False, backend=None, resolver=None):
        self.allow_private = allow_private
        self.backend = backend if backend is not None else httpcore.AnyIOBackend()
        self.resolver = resolver

    async def _addresses(self, host: str, port: int) -> list[str]:
        try:
            return [str(ipaddress.ip_address(host))]
        except ValueError:
            resolver = self.resolver or asyncio.get_running_loop().getaddrinfo
            answers = await resolver(host, port, family=socket.AF_UNSPEC,
                                     type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
            return list(dict.fromkeys(str(ipaddress.ip_address(answer[4][0])) for answer in answers))

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        started = time.monotonic()
        try:
            addresses = await asyncio.wait_for(self._addresses(host, port), timeout)
        except TimeoutError as error:
            raise httpcore.ConnectTimeout("모델 서버 주소 확인 시간이 초과됐습니다.") from error
        except (OSError, ValueError, UnicodeError) as error:
            raise httpcore.ConnectError("모델 서버 주소를 확인하지 못했습니다.") from error
        if not addresses or (not self.allow_private and any(
            not ipaddress.ip_address(address).is_global
            or ipaddress.ip_address(address).is_multicast
            or getattr(ipaddress.ip_address(address), "ipv4_mapped", None) is not None
            for address in addresses
        )):
            raise httpcore.ConnectError("허용되지 않은 모델 서버 IP 주소입니다.")
        last_error = None
        for address in addresses:
            remaining = None if timeout is None else max(0, timeout - (time.monotonic() - started))
            if remaining == 0:
                raise httpcore.ConnectTimeout("모델 서버 연결 시간이 초과됐습니다.")
            try:
                return await self.backend.connect_tcp(address, port, timeout=remaining,
                                                      local_address=local_address, socket_options=socket_options)
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as error:
                last_error = error
        raise last_error or httpcore.ConnectError("모델 서버에 연결하지 못했습니다.")

    async def connect_unix_socket(self, *args, **kwargs):
        raise httpcore.ConnectError("모델 서버의 Unix 소켓 연결은 허용하지 않습니다.")

    async def sleep(self, seconds):
        await self.backend.sleep(seconds)


class UpstreamTransport(httpx.AsyncHTTPTransport):
    def __init__(self, *, allow_private: bool = False, backend=None, resolver=None):
        # HTTPX 0.28.1's adapter supplies exception/stream conversion. Its pool
        # is replaced using httpcore's public network-backend interface. Both
        # versions are pinned and the adapter has a full request regression.
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=httpcore.default_ssl_context(),
            max_connections=128, max_keepalive_connections=20, keepalive_expiry=5,
            network_backend=ValidatedNetworkBackend(allow_private=allow_private, backend=backend, resolver=resolver),
        )


def upstream_client(env: dict) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=UpstreamTransport(allow_private=env.get("AEGIS_ALLOW_PRIVATE_UPSTREAM") == "true"),
        follow_redirects=False, trust_env=False, timeout=60,
    )
