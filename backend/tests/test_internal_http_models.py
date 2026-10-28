"""HTTP vLLM connections keep origin and private-network protections.

The socket checks use an ephemeral loopback HTTP stub, never a real model server.
"""
import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI

from aegis.api import create_router, validate_snapshot_connections
from aegis.engine import (
    PolicyError,
    approved_url,
    collect_connection_metrics,
    diagnose_connection,
    model_chat,
    test_connection as check_connection,
    validate_connection,
    validate_ingress,
)
from aegis.store import Store
from aegis.upstream_transport import upstream_client


def connection(base_url, role="main"):
    return {
        "id": "internal-model", "name": "내부 모델", "model": "internal-model",
        "mode": "vllm", "role": role, "baseUrl": base_url,
        "secretEnv": "", "timeoutMs": 1000,
    }


def ingress(*origins):
    return {"enabled": False, "allowedCidrs": [], "allowedOrigins": list(origins)}


@pytest.mark.parametrize("scheme", ["http", "https"])
@pytest.mark.parametrize("host", ["model.example", "10.20.30.40:8000", "[fd00::8]:8000"])
def test_model_http_and_https_addresses_are_valid_configuration(scheme, host):
    origin = f"{scheme}://{host}"
    assert validate_connection(connection(origin + "/v1")) == []
    assert validate_ingress(ingress(origin)) == []


@pytest.mark.parametrize("base_url", [
    "ftp://model.example/v1", "file:///v1", "//model.example/v1",
    "http://user:password@model.example/v1", "http://model.example/v1?token=example",
    "http://model.example/v1#fragment", "http://model.example/", "http://model.example:65536/v1",
])
def test_http_support_does_not_allow_invalid_model_addresses(base_url):
    assert validate_connection(connection(base_url))


@pytest.mark.parametrize("origin", [
    "http://user:password@model.example", "http://model.example/v1",
    "http://model.example?token=example", "http://model.example#fragment", "ftp://model.example",
])
def test_http_allowed_origins_still_exclude_credentials_path_query_and_fragment(origin):
    assert validate_ingress(ingress(origin))


@pytest.mark.parametrize("origins", [[], ["https://model.example:8000"], ["http://model.example"], ["http://other.example:8000"]])
def test_http_model_requires_its_exact_scheme_host_and_port_in_allowlist(origins):
    with pytest.raises(PolicyError, match="허용 목록"):
        approved_url(connection("http://model.example:8000/v1"), ingress(*origins), {})


@pytest.mark.parametrize("base_url", ["http://10.20.30.40:8000/v1", "http://model.internal:8000/v1", "http://[fd00::8]:8000/v1"])
@pytest.mark.parametrize("env", [{}, {"AEGIS_ALLOW_PRIVATE_UPSTREAM": "false"}])
def test_private_http_models_require_existing_explicit_private_network_opt_in(base_url, env):
    origin = base_url.removesuffix("/v1")
    with pytest.raises(PolicyError, match="AEGIS_ALLOW_PRIVATE_UPSTREAM"):
        approved_url(connection(base_url), ingress(origin), env)
    assert approved_url(connection(base_url), ingress(origin), {"AEGIS_ALLOW_PRIVATE_UPSTREAM": "true"}) == base_url + "/"


@pytest.mark.parametrize("scheme,port", [("http", 80), ("https", 443)])
@pytest.mark.parametrize("frozen_policy", [False, True])
def test_default_port_origin_normalization_is_shared_by_runtime_and_snapshot_checks(scheme, port, frozen_policy):
    model = connection(f"{scheme}://model.internal:{port}/v1", "guard" if frozen_policy else "main")
    access = ingress(f"{scheme}://model.internal")
    env = {"AEGIS_ALLOW_PRIVATE_UPSTREAM": "true"}
    assert approved_url(model, access, env) == model["baseUrl"] + "/"
    snapshots = [] if frozen_policy else [model]
    workflow = {"policyRouting": {"policy": {"connectionSnapshot": model}}} if frozen_policy else None
    validate_snapshot_connections(snapshots, access, env, workflow)


async def test_http_model_settings_can_be_saved_and_roundtrip_in_temporary_database(tmp_path):
    store = Store(tmp_path / "http-model.sqlite")
    await store.seed()
    app = FastAPI()
    app.include_router(create_router(store, {}))
    model = connection("http://10.20.30.40:8000/v1")
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 12345)), base_url="http://test") as client:
            for payload in [
                {"action": "save_ingress", "ingress": ingress("http://10.20.30.40:8000")},
                {"action": "save_connection", "connection": model},
            ]:
                response = await client.post("/api/console", json=payload)
                assert response.status_code == 200, response.text
            state = (await client.get("/api/console")).json()["state"]
        assert next(item for item in state["connections"] if item["id"] == model["id"]) == model
        assert state["ingress"]["allowedOrigins"] == ["http://10.20.30.40:8000"]
    finally:
        await store.close()


@pytest.fixture
async def local_http_model():
    state = {"requests": [], "redirect": None}

    async def handle(reader, writer):
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 2)
            lines = head.decode("ascii").split("\r\n")
            method, path, _ = lines[0].split(" ")
            headers = {name.lower(): value.strip() for name, value in (line.split(":", 1) for line in lines[1:] if line)}
            body = await reader.readexactly(int(headers.get("content-length", "0")))
            payload = json.loads(body) if body else None
            state["requests"].append({"method": method, "path": path, "headers": headers, "payload": payload})
            status, extra_headers = "200 OK", ""
            if state["redirect"]:
                status, extra_headers = "302 Found", f"Location: {state['redirect']}\r\n"
                response_body = b"private redirect body"
            elif path == "/v1/models":
                response_body = json.dumps({"data": [{"id": "internal-model"}]}).encode()
            elif path == "/v1/chat/completions":
                is_guard = any("classifier" in item["content"] for item in payload["messages"] if item["role"] == "system")
                content = '{"verdict":"allow","reason":"benign"}' if is_guard else "Hello from internal HTTP"
                response_body = json.dumps({"choices": [{"message": {"content": content}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}}).encode()
            elif path == "/metrics":
                response_body = b'vllm:num_requests_running{model_name="internal-model"} 2\nvllm:kv_cache_usage_perc{model_name="internal-model"} 0.25\n'
            else:
                status, response_body = "404 Not Found", b"not found"
            writer.write(f"HTTP/1.1 {status}\r\nContent-Length: {len(response_body)}\r\nConnection: close\r\n{extra_headers}\r\n".encode() + response_body)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    state["origin"] = f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}"
    try:
        yield state
    finally:
        server.close()
        await server.wait_closed()


@pytest.mark.parametrize("role", ["main", "guard"])
async def test_real_internal_http_transport_supports_diagnostics_inference_and_metrics(local_http_model, role):
    origin = local_http_model["origin"]
    model, access = connection(origin + "/v1", role), ingress(origin)
    env = {"AEGIS_ALLOW_PRIVATE_UPSTREAM": "true"}
    # Exercise the real DNS/IP-pinning transport rather than an HTTPX mock.
    async with upstream_client(env) as client:
        diagnosed = await diagnose_connection(model, access, env, client=client)
        assert diagnosed["ok"], diagnosed
        assert all(step["status"] == "pass" for step in diagnosed["steps"][:4])
        assert diagnosed["steps"][4]["status"] == ("pass" if role == "guard" else "skipped")
        assert "HTTPS" not in diagnosed["steps"][1]["message"]
        result = await model_chat(model, access, env, [{"role": "user", "content": "hello"}], client=client)
        assert result == {"content": "Hello from internal HTTP", "finishReason": "stop", "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}}
        metrics = await collect_connection_metrics(model, access, env, client=client)
        assert metrics["status"] == "ok", metrics
        assert metrics["metrics"] == {"running": 2, "cacheUsage": 0.25}
    assert [request["path"] for request in local_http_model["requests"]] == ["/v1/models", "/v1/chat/completions", "/v1/chat/completions", "/metrics"]
    assert all(request["headers"]["host"] == origin.removeprefix("http://") for request in local_http_model["requests"])
    assert all("authorization" not in request["headers"] for request in local_http_model["requests"])


async def test_real_http_private_network_default_blocks_before_sending(local_http_model):
    origin = local_http_model["origin"]
    async with upstream_client({}) as client:
        with pytest.raises(httpx.ConnectError, match="허용되지 않은"):
            await client.get(origin + "/v1/models")
    assert local_http_model["requests"] == []


@pytest.mark.parametrize("operation", ["models", "chat", "metrics"])
async def test_internal_http_redirects_are_rejected_without_following_or_exposing_body(local_http_model, operation):
    origin = local_http_model["origin"]
    local_http_model["redirect"] = origin + "/unapproved-destination"
    model, access, env = connection(origin + "/v1"), ingress(origin), {"AEGIS_ALLOW_PRIVATE_UPSTREAM": "true"}
    if operation == "models":
        result = await check_connection(model, access, env)
        assert result["ok"] is False
        message = result["message"]
    elif operation == "metrics":
        result = await collect_connection_metrics(model, access, env)
        assert result["status"] == "error"
        message = result["message"]
    else:
        with pytest.raises(PolicyError) as caught:
            await model_chat(model, access, env, [{"role": "user", "content": "hello"}])
        message = str(caught.value)
    assert "HTTP 302" in message
    assert "private redirect body" not in message
    assert len(local_http_model["requests"]) == 1
