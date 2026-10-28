"""Authentication settings as strings, matching the Compose environment boundary."""
import base64
import json

import httpx
import pytest

from aegis.main import create_app
from aegis.store import Store


@pytest.fixture
async def auth_app(tmp_path):
    store = Store(str(tmp_path / "auth.sqlite"))
    await store.seed()
    env = {
        "ADMIN_USER": "admin", "ADMIN_PASSWORD": "test-auth-only",
        "AEGIS_ROLE_MAP": "", "AEGIS_ADMIN_TOKEN": "",
        "AEGIS_TRUST_PROXY_IDENTITY": "false", "AEGIS_TRUSTED_PROXY_IPS": "",
        "AEGIS_REQUIRE_ADMIN_IDENTITY": "false",
        "AEGIS_EVALUATION_WORKER_ENABLED": "false",
        "AEGIS_FRONTEND_PATH": str(tmp_path / "frontend"),
    }
    app = create_app(env, store=store)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 45000)),
        base_url="http://test",
    ) as client:
        yield client, store, app.state.env
    await store.close()


def basic_auth():
    return {"Authorization": "Basic " + base64.b64encode(b"admin:test-auth-only").decode()}


async def test_empty_optional_settings_keep_basic_admin_and_reject_spoofing(auth_app):
    client, _, _ = auth_app
    response = await client.get("/api/console", headers=basic_auth())
    assert response.status_code == 200
    assert response.json()["state"]["role"] == "admin"
    for path in ["/api/console", "/docs", "/openapi.json"]:
        denied = await client.get(path, headers={"oai-authenticated-user-id": "admin"})
        assert denied.status_code == 401


@pytest.mark.parametrize("token_header", ["Authorization", "x-aegis-admin-token"])
async def test_string_role_map_limits_basic_account_but_service_token_remains_admin(auth_app, token_header):
    client, store, env = auth_app
    # This is a deliberately fake test credential, never a deployed secret.
    token = "test-admin-token-only-" + "x" * 32
    env.update(AEGIS_ROLE_MAP=json.dumps({"admin": "viewer"}), AEGIS_ADMIN_TOKEN=token)
    response = await client.get("/api/console", headers=basic_auth())
    assert response.status_code == 200
    assert response.json()["state"]["role"] == "viewer"
    denied = await client.post("/api/console", headers=basic_auth(), json={"action": "create_key", "name": "denied"})
    assert denied.status_code == 403
    assert not (await store.state())["keys"]
    headers = {token_header: f"Bearer {token}" if token_header == "Authorization" else token}
    accepted = await client.post("/api/console", headers=headers, json={"action": "create_key", "name": "service"})
    assert accepted.status_code == 200
    wrong_headers = {token_header: "Bearer wrong-test-token" if token_header == "Authorization" else "wrong-test-token"}
    assert (await client.get("/api/console", headers=wrong_headers)).status_code == 401
    # A console credential must not become a Gateway credential.
    assert (await client.get("/v1/models", headers=headers)).status_code == 401


@pytest.mark.parametrize("trusted,proxy_ips,expected", [
    ("false", "127.0.0.1", 401),
    ("true", "", 401),
    ("true", "198.51.100.20", 401),
    ("true", " 198.51.100.20, 127.0.0.1 ", 200),
])
async def test_proxy_identity_requires_opt_in_and_matching_socket_ip(auth_app, trusted, proxy_ips, expected):
    client, _, env = auth_app
    env.update(AEGIS_TRUST_PROXY_IDENTITY=trusted, AEGIS_TRUSTED_PROXY_IPS=proxy_ips,
               AEGIS_ROLE_MAP=json.dumps({"proxy-viewer": "viewer"}))
    headers = {"oai-authenticated-user-id": "proxy-viewer", "x-real-ip": "198.51.100.20"}
    for path in ["/api/console", "/docs", "/openapi.json"]:
        response = await client.get(path, headers=headers)
        assert response.status_code == expected, (path, response.text)
        if expected == 200 and path == "/api/console":
            assert response.json()["state"]["role"] == "viewer"
    if expected == 200:
        denied = await client.post("/api/console", headers=headers, json={"action": "create_key", "name": "denied"})
        assert denied.status_code == 403


async def test_gateway_forwarded_ip_uses_the_same_proxy_trust_boundary(auth_app):
    client, _, env = auth_app
    current = (await client.get("/api/console", headers=basic_auth())).json()["state"]
    response = await client.post("/api/console", headers=basic_auth(), json={"action": "publish", "workflowId": current["workflows"][0]["id"]})
    assert response.status_code == 200
    response = await client.post("/api/console", headers=basic_auth(), json={"action": "create_key", "name": "proxy-ip-test"})
    assert response.status_code == 200
    gateway_headers = {"Authorization": f"Bearer {response.json()['key']}", "x-real-ip": "203.0.113.5"}
    response = await client.post("/api/console", headers=basic_auth(), json={"action": "save_ingress", "ingress": {"enabled": True, "allowedCidrs": ["203.0.113.0/24"], "allowedOrigins": []}})
    assert response.status_code == 200
    for trusted, proxy_ips, expected in [("false", "127.0.0.1", 403), ("true", "198.51.100.20", 403), ("true", "127.0.0.1", 200)]:
        env.update(AEGIS_TRUST_PROXY_IDENTITY=trusted, AEGIS_TRUSTED_PROXY_IPS=proxy_ips)
        response = await client.get("/v1/models", headers=gateway_headers)
        assert response.status_code == expected, response.text
        if expected == 403:
            assert response.json()["error"]["code"] == "ip_not_allowed"


@pytest.mark.parametrize("require_identity,expected", [("false", 200), ("true", 401)])
async def test_require_identity_controls_only_credentialless_loopback_access(auth_app, require_identity, expected):
    client, _, env = auth_app
    env.update(ADMIN_USER="", ADMIN_PASSWORD="", AEGIS_REQUIRE_ADMIN_IDENTITY=require_identity)
    response = await client.get("/api/console")
    assert response.status_code == expected
    env.update(ADMIN_USER="admin", ADMIN_PASSWORD="test-auth-only")
    assert (await client.get("/api/console", headers=basic_auth())).status_code == 200
