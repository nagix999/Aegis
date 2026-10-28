"""Browser administrator sessions at the complete FastAPI boundary.

All credentials, clocks, files and SQLite databases are isolated fixtures.  The
tests preserve the machine-authentication boundaries while exercising the new
cookie authentication through public requests rather than router stubs.
"""
import base64
import hashlib
import json

import httpx
import pytest

from aegis.main import create_app
from aegis.store import Store


USERNAME = "admin"
PASSWORD = "test-session-password-only"
BASE_URL = "http://test"


class Clock:
    def __init__(self):
        self.value = 1_800_000_000.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


def basic(password=PASSWORD):
    value = base64.b64encode(f"{USERNAME}:{password}".encode()).decode()
    return {"Authorization": f"Basic {value}"}


@pytest.fixture
async def session_app(tmp_path, request):
    frontend = tmp_path / "frontend"
    (frontend / "assets").mkdir(parents=True)
    (frontend / "index.html").write_text(
        '<!doctype html><script type="module" src="/assets/login-main-A1b2c3d4.js"></script>'
        '<link rel="stylesheet" href="/assets/login-main-A1b2c3d4.css">'
    )
    (frontend / "assets/login-main-A1b2c3d4.js").write_text('console.log("login shell");')
    (frontend / "assets/login-main-A1b2c3d4.css").write_text("body { color: black; }")
    (frontend / "assets/unreferenced.js").write_text("window.privateAssetFixture = true;")
    (frontend / "asset.js").write_text("window.privateFixture = true;")
    (frontend / ".private-fixture").write_text("never-public")
    clock = Clock()
    store = Store(str(tmp_path / "sessions.sqlite"))
    await store.seed()
    env = {
        "ADMIN_USER": USERNAME, "ADMIN_PASSWORD": PASSWORD, "ADMIN_PASSWORD_HASH": "",
        "AEGIS_ROLE_MAP": "", "AEGIS_ADMIN_TOKEN": "",
        "AEGIS_TRUST_PROXY_IDENTITY": "false", "AEGIS_TRUSTED_PROXY_IPS": "",
        "AEGIS_REQUIRE_ADMIN_IDENTITY": "false", "PUBLIC_BASE_URL": "",
        "AEGIS_ALLOWED_HOSTS": "", "AEGIS_EVALUATION_WORKER_ENABLED": "false",
        "AEGIS_FRONTEND_PATH": str(frontend), "_auth_clock": clock,
        "AEGIS_SESSION_IDLE_SECONDS": "60", "AEGIS_SESSION_MAX_SECONDS": "180",
        "AEGIS_LOGIN_WINDOW_SECONDS": "10", "AEGIS_LOGIN_ACCOUNT_LIMIT": "3",
        "AEGIS_LOGIN_IP_LIMIT": "5", "AEGIS_LOGIN_GLOBAL_LIMIT": "10",
    }
    env.update(getattr(request, "param", {}))
    app = create_app(env, store=store)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 45000)),
        base_url=BASE_URL,
    ) as client:
        yield client, store, app.state.env, clock, app
    await store.close()


async def login(client, password=PASSWORD, **kwargs):
    return await client.post(
        "/api/auth/login", json={"username": USERNAME, "password": password},
        headers={"Origin": str(client.base_url).rstrip("/")}, **kwargs,
    )


def csrf_headers(data, origin=BASE_URL):
    return {"Origin": origin, "X-Aegis-CSRF": data["csrfToken"]}


async def test_only_login_shell_and_hashed_build_assets_are_public(session_app):
    client, _, _, _, _ = session_app
    for path in ["/", "/index.html", "/assets/login-main-A1b2c3d4.js", "/assets/login-main-A1b2c3d4.css"]:
        response = await client.get(path)
        assert response.status_code == 200, (path, response.text)
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
    for path in ["/asset.js", "/assets/unreferenced.js", "/.private-fixture", "/docs", "/openapi.json", "/api/console"]:
        response = await client.get(path, headers={"oai-authenticated-user-id": USERNAME})
        assert response.status_code == 401, (path, response.text)
        assert "www-authenticate" not in response.headers
    assert (await client.get("/asset.js", headers=basic())).status_code == 200


async def test_anonymous_session_metadata_has_no_identity_or_csrf_secret(session_app):
    client, _, _, _, _ = session_app
    response = await client.get("/api/auth/session")
    assert response.status_code == 200
    data = response.json()
    assert data["authenticated"] is False and data["loginAvailable"] is True
    assert data["authMethod"] is None
    assert not data.get("identity") and not data.get("csrfToken")
    assert PASSWORD not in response.text


async def test_login_issues_opaque_http_only_cookie_and_allows_real_console_write(session_app):
    client, store, _, _, _ = session_app
    response = await login(client)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["authenticated"] is True and data["authMethod"] == "session"
    assert data["identity"] == USERNAME and data["csrfToken"] and data["expiresAt"]
    cookie = response.headers["set-cookie"].lower()
    assert "aegis_session=" in cookie and "httponly" in cookie and "path=/" in cookie
    assert "samesite=strict" in cookie or "samesite=lax" in cookie
    assert "secure" not in cookie
    token = client.cookies.get("aegis_session")
    assert len(token) >= 32 and PASSWORD not in token and USERNAME not in token
    assert (await client.get("/api/console")).status_code == 200
    accepted = await client.post("/api/console", headers=csrf_headers(data),
                                 json={"action": "create_key", "name": "session-created"})
    assert accepted.status_code == 200, accepted.text
    assert len((await store.state())["keys"]) == 1
    state = (await client.get("/api/console")).json()["state"]
    serialized = json.dumps(state)
    assert token not in serialized and data["csrfToken"] not in serialized and PASSWORD not in serialized
    # SQLite must retain only a hash of the bearer cookie, never its plaintext.
    persisted = store.db.execute("SELECT token_hash FROM aegis_admin_sessions").fetchall()
    assert len(persisted) == 1 and persisted[0][0] == hashlib.sha256(token.encode()).hexdigest()


async def test_https_public_base_sets_secure_cookie_without_trusting_forwarded_headers(session_app):
    client, _, env, _, _ = session_app
    env["PUBLIC_BASE_URL"] = "https://console.example"
    response = await client.post("/api/auth/login", json={"username": USERNAME, "password": PASSWORD},
                                 headers={"Origin": "https://console.example", "Host": "console.example"})
    assert response.status_code == 200, response.text
    assert "; secure" in response.headers["set-cookie"].lower()
    env["PUBLIC_BASE_URL"] = ""
    client.cookies.clear()
    response = await client.post("/api/auth/login", json={"username": USERNAME, "password": PASSWORD},
                                 headers={"Origin": BASE_URL, "X-Forwarded-Proto": "https"})
    assert response.status_code == 200, response.text
    assert "; secure" not in response.headers["set-cookie"].lower()


@pytest.mark.parametrize("kind", ["missing-token", "wrong-token", "foreign-origin", "null-origin", "missing-origin"])
async def test_session_writes_require_both_same_origin_and_matching_csrf(session_app, kind):
    client, store, _, _, _ = session_app
    data = (await login(client)).json()
    headers = csrf_headers(data)
    if kind == "missing-token":
        headers.pop("X-Aegis-CSRF")
    elif kind == "wrong-token":
        headers["X-Aegis-CSRF"] = "incorrect-test-csrf"
    elif kind == "foreign-origin":
        headers["Origin"] = "https://attacker.example"
    elif kind == "null-origin":
        headers["Origin"] = "null"
    else:
        headers.pop("Origin")
    for path, body in [("/api/console", {"action": "create_key", "name": "blocked"}),
                       ("/api/auth/logout", {})]:
        response = await client.post(path, headers=headers, json=body)
        assert response.status_code == 403, (kind, path, response.text)
    assert not (await store.state())["keys"]
    assert (await client.get("/api/auth/session")).json()["authenticated"] is True


@pytest.mark.parametrize("content_type", ["text/plain", "application/x-www-form-urlencoded", ""])
async def test_json_content_type_is_required_on_login_and_console(session_app, content_type):
    client, store, _, _, _ = session_app
    response = await client.post("/api/auth/login", content=json.dumps({"username": USERNAME, "password": PASSWORD}),
                                 headers={"Origin": BASE_URL, "Content-Type": content_type})
    assert response.status_code == 415, response.text
    data = (await login(client)).json()
    response = await client.post("/api/console", content='{"action":"create_key","name":"blocked"}',
                                 headers={**csrf_headers(data), "Content-Type": content_type})
    assert response.status_code == 415, response.text
    assert not (await store.state())["keys"]


async def test_attacker_cookie_cannot_fix_session_and_logout_revokes_server_side(session_app):
    client, _, _, _, _ = session_app
    attacker_token = "attacker-selected-session-fixture-" + "z" * 32
    client.cookies.set("aegis_session", attacker_token, domain="test.local", path="/")
    response = await login(client)
    assert response.status_code == 200, response.text
    data = response.json()
    token = client.cookies.get("aegis_session")
    assert token != attacker_token
    response = await client.post("/api/auth/logout", headers=csrf_headers(data))
    assert response.status_code == 200, response.text
    assert not client.cookies.get("aegis_session")
    client.cookies.set("aegis_session", token, domain="test.local", path="/")
    assert (await client.get("/api/console")).status_code == 401
    assert (await client.get("/api/auth/session")).json()["authenticated"] is False


async def test_relogin_rotates_session_and_rejects_previous_cookie(session_app):
    client, _, _, _, _ = session_app
    await login(client)
    previous = client.cookies.get("aegis_session")
    response = await login(client)
    assert response.status_code == 200, response.text
    assert client.cookies.get("aegis_session") != previous
    response = await client.get("/api/console", headers={"Cookie": f"aegis_session={previous}"})
    assert response.status_code == 401


@pytest.mark.parametrize("origin", [None, "null", "https://attacker.example"])
async def test_login_itself_requires_explicit_same_origin(session_app, origin):
    client, _, _, _, _ = session_app
    headers = {"Origin": origin} if origin is not None else {}
    response = await client.post("/api/auth/login", headers=headers, json={"username": USERNAME, "password": PASSWORD})
    assert response.status_code == 403, response.text
    assert not client.cookies.get("aegis_session")


async def test_idle_expiry_and_absolute_expiry_cannot_be_extended_by_activity(session_app):
    client, _, _, clock, _ = session_app
    await login(client)
    clock.advance(61)
    assert (await client.get("/api/console")).status_code == 401
    assert (await client.get("/api/auth/session")).json()["authenticated"] is False
    data = (await login(client)).json()
    for _ in range(3):
        clock.advance(50)
        assert (await client.get("/api/console", headers={**csrf_headers(data), "X-Aegis-Activity": "1"})).status_code == 200
    clock.advance(31)
    assert (await client.get("/api/console")).status_code == 401


@pytest.mark.parametrize("request_kind", ["passive-console", "passive-session", "forged-activity", "failed-write"])
async def test_background_polling_and_invalid_csrf_cannot_extend_idle_session(session_app, request_kind):
    client, _, _, clock, _ = session_app
    await login(client)
    clock.advance(50)
    if request_kind == "passive-console":
        response = await client.get("/api/console")
    elif request_kind == "passive-session":
        response = await client.get("/api/auth/session")
    elif request_kind == "forged-activity":
        response = await client.get("/api/console", headers={"X-Aegis-Activity": "1", "X-Aegis-CSRF": "wrong"})
    else:
        response = await client.post("/api/console", headers={"Origin": BASE_URL, "X-Aegis-CSRF": "wrong"},
                                     json={"action": "create_key", "name": "blocked"})
    assert response.status_code == (403 if request_kind == "failed-write" else 200), response.text
    clock.advance(11)
    assert (await client.get("/api/console")).status_code == 401


async def test_changing_admin_credentials_invalidates_existing_cookie(session_app):
    client, _, env, _, _ = session_app
    await login(client)
    env["ADMIN_PASSWORD"] = "test-rotated-password-only"
    assert (await client.get("/api/console")).status_code == 401
    assert (await client.get("/api/auth/session")).json()["authenticated"] is False
    response = await login(client, password=env["ADMIN_PASSWORD"])
    assert response.status_code == 200, response.text


async def test_precomputed_scrypt_password_authenticates_without_plaintext_config(session_app):
    client, _, env, _, _ = session_app
    # Construct a fixture independently of the production hash generator.
    salt = b"fixture-salt-16b"
    digest = hashlib.scrypt(PASSWORD.encode(), salt=salt, n=16384, r=8, p=5, dklen=32)
    env.update(ADMIN_PASSWORD="", ADMIN_PASSWORD_HASH="scrypt$16384$8$5$" +
               base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode())
    response = await login(client)
    assert response.status_code == 200, response.text
    client.cookies.clear()
    assert (await client.get("/api/console", headers=basic())).status_code == 200
    assert (await login(client, password="wrong-test-password")).status_code == 401


async def test_session_survives_new_app_and_logout_propagates_to_other_app(session_app):
    client, store, env, _, _ = session_app
    response = await login(client)
    data, token = response.json(), client.cookies.get("aegis_session")
    second_store = Store(store.db.execute("PRAGMA database_list").fetchone()[2])
    await second_store.seed()
    other = create_app({key: value for key, value in env.items() if not key.startswith("_store")}, store=second_store)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=other, client=("127.0.0.1", 45001)),
                                     base_url=BASE_URL, headers={"Cookie": f"aegis_session={token}"}) as second:
            response = await second.get("/api/auth/session")
            assert response.status_code == 200 and response.json()["authenticated"] is True
            assert response.json()["csrfToken"] == data["csrfToken"]
            assert (await second.get("/api/console")).status_code == 200
            assert (await client.post("/api/auth/logout", headers=csrf_headers(data))).status_code == 200
            assert (await second.get("/api/console")).status_code == 401
    finally:
        await second_store.close()


async def test_account_throttle_has_finite_cooldown_and_audits_do_not_contain_secrets(session_app):
    client, store, _, clock, _ = session_app
    statuses = [(await login(client, password="wrong-test-password")).status_code for _ in range(4)]
    assert statuses[:3] == [401] * 3 and statuses[3] == 429
    limited = await login(client)
    assert limited.status_code == 429 and int(limited.headers["retry-after"]) > 0
    clock.advance(11)
    response = await login(client)
    assert response.status_code == 200, response.text
    assert (await client.post("/api/auth/logout", headers=csrf_headers(response.json()))).status_code == 200
    events = (await store.state())["audit"]
    actions = {event["action"] for event in events}
    assert {"admin_login", "admin_login_failed", "admin_login_throttled", "admin_logout"} <= actions
    serialized = json.dumps(events)
    for forbidden in [PASSWORD, "wrong-test-password", response.json()["csrfToken"]]:
        assert forbidden not in serialized


@pytest.mark.parametrize("session_app", [{"AEGIS_LOGIN_ACCOUNT_LIMIT": "100"}], indirect=True)
async def test_ip_throttle_counts_distinct_account_names_and_ignores_untrusted_forwarded_ip(session_app):
    client, _, _, _, _ = session_app
    for index in range(5):
        response = await client.post("/api/auth/login", headers={"Origin": BASE_URL, "X-Real-IP": f"192.0.2.{index}"},
                                     json={"username": f"unknown-{index}", "password": "wrong"})
        assert response.status_code == 401, response.text
    response = await login(client)
    assert response.status_code == 429


@pytest.mark.parametrize("session_app", [{"AEGIS_LOGIN_ACCOUNT_LIMIT": "100"}], indirect=True)
async def test_global_throttle_is_shared_by_clients_and_clears_after_window(session_app):
    client, _, _, clock, app = session_app
    for index in range(10):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(f"192.0.2.{index + 1}", 45000)),
                                     base_url=BASE_URL) as remote:
            response = await remote.post("/api/auth/login", headers={"Origin": BASE_URL},
                                         json={"username": f"unknown-{index}", "password": "wrong"})
            assert response.status_code == 401, response.text
    assert (await login(client)).status_code == 429
    clock.advance(11)
    assert (await login(client)).status_code == 200


@pytest.mark.parametrize("username,password", [(None, None), (["admin"], {}), ("a" * 10_000, "x"), ("관리자\x00", "패스워드")], ids=["null", "wrong-types", "oversized", "unicode-nul"])
async def test_malformed_login_is_bounded_and_never_an_internal_error(session_app, username, password):
    client, _, _, _, _ = session_app
    response = await client.post("/api/auth/login", headers={"Origin": BASE_URL},
                                 json={"username": username, "password": password})
    assert response.status_code in {400, 401, 413}, response.text
    assert "Traceback" not in response.text


async def test_session_respects_role_map_and_does_not_authenticate_gateway_or_worker(session_app):
    client, _, env, _, _ = session_app
    env["AEGIS_ROLE_MAP"] = json.dumps({USERNAME: "viewer"})
    data = (await login(client)).json()
    response = await client.get("/api/console")
    assert response.status_code == 200 and response.json()["state"]["role"] == "viewer"
    response = await client.post("/api/console", headers=csrf_headers(data), json={"action": "create_key", "name": "denied"})
    assert response.status_code == 403
    assert (await client.get("/v1/models")).status_code == 401
    assert (await client.post("/api/evaluations/worker", json={})).status_code in {401, 503}
    env["AEGIS_ADMIN_TOKEN"] = "test-admin-token-fixture-" + "t" * 32
    client.cookies.clear()
    headers = {"x-aegis-admin-token": env["AEGIS_ADMIN_TOKEN"]}
    response = await client.get("/api/auth/session", headers=headers)
    assert response.status_code == 200 and response.json()["authMethod"] == "token"
    assert (await client.post("/api/console", headers=headers, json={"action": "create_key", "name": "machine-admin"})).status_code == 200
    assert (await client.get("/v1/models", headers=headers)).status_code == 401


async def test_default_loopback_development_access_remains_explicitly_identified(session_app):
    client, _, env, _, _ = session_app
    env.update(ADMIN_USER="", ADMIN_PASSWORD="")
    response = await client.get("/api/auth/session")
    assert response.status_code == 200
    data = response.json()
    assert data["authenticated"] is True and data["authMethod"] == "development"
    assert data["loginAvailable"] is False
    assert (await client.get("/api/console")).status_code == 200
    env["AEGIS_REQUIRE_ADMIN_IDENTITY"] = "true"
    assert (await client.get("/api/console")).status_code == 401


async def test_successful_basic_requests_do_not_exhaust_failure_limit(session_app):
    client, _, _, _, _ = session_app
    for _ in range(15):
        response = await client.get("/api/console", headers=basic())
        assert response.status_code == 200, response.text
    response = await client.get("/api/auth/session", headers=basic())
    assert response.status_code == 200 and response.json()["authMethod"] == "basic"


async def test_proxy_auth_method_requires_explicit_trust_and_matching_socket(session_app):
    client, _, env, _, _ = session_app
    headers = {"oai-authenticated-user-id": "trusted-proxy-admin"}
    response = await client.get("/api/auth/session", headers=headers)
    assert response.json()["authenticated"] is False
    env.update(AEGIS_TRUST_PROXY_IDENTITY="true", AEGIS_TRUSTED_PROXY_IPS="127.0.0.1")
    response = await client.get("/api/auth/session", headers=headers)
    assert response.json()["authenticated"] is True
    assert response.json()["authMethod"] == "proxy" and response.json()["identity"] == "trusted-proxy-admin"


@pytest.mark.parametrize("path,method", [("/", "get"), ("/api/console", "get"), ("/docs", "get"), ("/api/auth/login", "post")])
async def test_login_and_error_responses_always_deny_framing_and_sniffing(session_app, path, method):
    client, _, _, _, _ = session_app
    response = await getattr(client, method)(path)
    assert response.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "no-store"


async def test_configured_host_allowlist_rejects_host_spoofing_including_public_shell(session_app):
    client, _, env, _, _ = session_app
    env["AEGIS_ALLOWED_HOSTS"] = "test, console.example"
    for path in ["/", "/api/auth/session", "/api/console"]:
        denied = await client.get(path, headers={**basic(), "Host": "attacker.example"})
        assert denied.status_code == 400, (path, denied.text)
        assert "frame-ancestors 'none'" in denied.headers["content-security-policy"]
    assert (await client.get("/api/console", headers={**basic(), "Host": "console.example"})).status_code == 200
