"""Browser acceptance tests for the single-administrator console.

Every test uses a fresh loopback server, temporary SQLite database and synthetic
credentials supplied by conftest. Browser interception only delays real backend
responses, except the explicitly documented 401 reauthentication trigger below.
"""
from __future__ import annotations

import json
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Any, Iterator

from playwright.sync_api import BrowserContext, Error, Page, Playwright, Route, expect

RECOVERY_KEY = "aegis:workflow-recovery:v1"
PREFERENCE_KEY = "aegis.dashboard.auth-acceptance-preference"


def open_login(page: Page, server: Any) -> None:
    response = page.goto(server.base_url, wait_until="networkidle")
    assert response is not None and response.status == 200
    expect(page.get_by_role("heading", name="관리자 로그인", exact=True)).to_be_visible()


def login(page: Page, server: Any, password: str | None = None) -> Any:
    page.get_by_label("관리자 계정", exact=True).fill(server.username)
    page.get_by_label("비밀번호", exact=True).fill(server.password if password is None else password)
    with page.expect_response(
        lambda response: response.url == server.base_url + "/api/auth/login"
        and response.request.method == "POST"
    ) as pending:
        page.get_by_role("button", name="로그인", exact=True).click()
    response = pending.value
    if response.status == 200:
        expect(page.get_by_role("navigation", name="관리 메뉴")).to_be_visible()
    else:
        # The response event precedes React's finally handler. Wait for the
        # cleared, enabled field before another attempt can fill its password.
        expect(page.get_by_label("비밀번호", exact=True)).to_have_value("")
        expect(page.get_by_label("비밀번호", exact=True)).to_be_enabled()
    return response


def session_cookie(context: BrowserContext, server: Any) -> dict:
    return next(cookie for cookie in context.cookies(server.base_url) if cookie["name"] == "aegis_session")


def console_write(page: Page, name: str) -> dict:
    # Use the application's fetch wrapper, rather than injecting a CSRF token.
    return page.evaluate(
        """async name => {
            const response = await fetch('/api/console', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({action: 'create_key', name})
            });
            return {status: response.status, body: await response.json()};
        }""",
        name,
    )


def edit_workflow_name(page: Page, name: str) -> Any:
    page.locator(".wf-list-name").first.click()
    page.get_by_role("button", name="워크플로우 설정", exact=True).click()
    field = page.locator(".we-workflow-settings input").first
    field.fill(name)
    page.wait_for_function(
        "([key, name]) => localStorage.getItem(key)?.includes(name)",
        arg=[RECOVERY_KEY, name],
    )
    return field


def logout(page: Page, server: Any) -> Any:
    page.get_by_role("button", name="로그아웃", exact=True).click()
    dialog = page.get_by_role("dialog", name="로그아웃할까요?", exact=True)
    expect(dialog).to_be_visible()
    with page.expect_response(
        lambda response: response.url == server.base_url + "/api/auth/logout"
        and response.request.method == "POST"
    ) as pending:
        dialog.get_by_role("button", name="로그아웃", exact=True).click()
    expect(page.get_by_role("heading", name="관리자 로그인", exact=True)).to_be_visible()
    return pending.value


def focus_session(page: Page, server: Any) -> tuple[dict, dict]:
    with page.expect_response(lambda response: response.url == server.base_url + "/api/auth/session") as pending:
        page.evaluate("dispatchEvent(new Event('focus'))")
    response = pending.value
    return response.json(), response.request.all_headers()


def release_response(held: dict) -> None:
    # Explicit logout aborts the fetch. Chromium may have already removed its
    # interception by the time a held response is delivered; that is expected.
    try:
        held["route"].fulfill(response=held["response"])
    except Error as error:
        message = str(error).lower()
        assert any(part in message for part in ("invalid interception", "already handled", "target closed", "interceptionid")), str(error)


@contextmanager
def framing_origin(target: str) -> Iterator[str]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            body = (
                '<!doctype html><title>Cross-origin framing fixture</title>'
                f'<iframe title="Console fixture" src="{target}/"></iframe>'
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        assert not thread.is_alive()


def test_login_gates_private_data_and_authenticates_real_csrf_write(page: Page, context: BrowserContext, console_server: Any) -> None:
    private_requests: list[str] = []
    page.on("request", lambda request: private_requests.append(request.url) if "/api/console" in request.url else None)
    open_login(page, console_server)
    assert private_requests == []
    expect(page.get_by_role("navigation", name="관리 메뉴")).to_have_count(0)
    assert context.request.get(console_server.base_url + "/api/console").status == 401

    wrong = login(page, console_server, "incorrect-synthetic-password")
    assert wrong.status == 401
    assert "www-authenticate" not in wrong.headers
    expect(page.get_by_role("alert")).to_have_text("계정 또는 비밀번호를 확인하세요.")
    expect(page.get_by_label("비밀번호", exact=True)).to_have_value("")
    assert login(page, console_server).status == 200

    cookie = session_cookie(context, console_server)
    assert cookie["httpOnly"] and cookie["sameSite"] in ("Lax", "Strict")
    assert page.evaluate("token => !Object.values(localStorage).some(value => value.includes(token))", cookie["value"])
    written = console_write(page, "browser acceptance key")
    assert written["status"] == 200
    assert len(written["body"]["state"]["keys"]) == 1
    # Native API requests do not use the UI wrapper: a cookie alone cannot write.
    missing_csrf = context.request.post(
        console_server.base_url + "/api/console",
        headers={"Origin": console_server.base_url},
        data={"action": "create_key", "name": "must not exist"},
    )
    assert missing_csrf.status == 403
    assert missing_csrf.json()["error"]["code"] == "csrf_failed"


def test_logout_confirmation_cleans_private_drafts_in_other_tabs_only(page: Page, context: BrowserContext, console_server: Any) -> None:
    open_login(page, console_server)
    assert login(page, console_server).status == 200
    field = edit_workflow_name(page, "로그아웃 확인용 합성 초안")
    page.evaluate("([key, value]) => localStorage.setItem(key, value)", [PREFERENCE_KEY, "keep-layout"])
    other = context.new_page()
    other.goto(console_server.base_url, wait_until="networkidle")
    expect(other.get_by_role("navigation", name="관리 메뉴")).to_be_visible()
    old_cookie = session_cookie(context, console_server)["value"]

    page.get_by_role("button", name="로그아웃", exact=True).click()
    dialog = page.get_by_role("dialog", name="로그아웃할까요?", exact=True)
    expect(dialog).to_contain_text("임시 초안이 삭제")
    dialog.get_by_role("button", name="계속 작업", exact=True).click()
    expect(field).to_have_value("로그아웃 확인용 합성 초안")
    assert logout(page, console_server).status == 200
    expect(other.get_by_role("heading", name="관리자 로그인", exact=True)).to_be_visible()
    expect(page.locator(".console-private")).to_have_count(0)
    expect(other.locator(".console-private")).to_have_count(0)
    assert page.evaluate("key => localStorage.getItem(key)", RECOVERY_KEY) is None
    assert page.evaluate("key => localStorage.getItem(key)", PREFERENCE_KEY) == "keep-layout"
    assert not any(cookie["name"] == "aegis_session" for cookie in context.cookies(console_server.base_url))
    assert context.request.get(console_server.base_url + "/api/console").status == 401
    replay = context.request.get(console_server.base_url + "/api/console", headers={"Cookie": f"aegis_session={old_cookie}"})
    assert replay.status == 401


def test_idle_expiry_hides_editor_and_relogin_preserves_draft_without_replay(page: Page, context: BrowserContext, console_server: Any) -> None:
    open_login(page, console_server)
    assert login(page, console_server).status == 200
    name = "세션 만료 뒤 유지하는 합성 초안"
    field = edit_workflow_name(page, name)
    console_server.advance(61)
    assert page.evaluate("async () => (await fetch('/api/console')).status") == 401
    expect(page.get_by_role("heading", name="다시 로그인", exact=True)).to_be_visible()
    assert page.locator(".console-private").evaluate("element => element.hidden && element.inert")
    expect(page.locator(".console-login")).to_contain_text("현재 탭의 입력은 보관 중")
    assert login(page, console_server).status == 200
    expect(field).to_have_value(name)
    assert not any(item["name"] == name for item in context.request.get(console_server.base_url + "/api/console").json()["state"]["workflows"])
    with page.expect_response(
        lambda response: response.url == console_server.base_url + "/api/console"
        and response.request.method == "POST"
        and response.request.post_data_json.get("action") == "save_workflow"
    ) as saved:
        page.locator(".we-top-actions").get_by_role("button", name="저장", exact=True).click()
    assert saved.value.status == 200
    assert console_write(page, "fresh CSRF after idle expiry")["status"] == 200


def test_csp_blocks_authenticated_console_in_other_origin_iframe(page: Page, context: BrowserContext, console_server: Any) -> None:
    open_login(page, console_server)
    assert login(page, console_server).status == 200
    response = context.request.get(console_server.base_url)
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert response.headers["x-frame-options"] == "DENY"
    framed = context.new_page()
    with framing_origin(console_server.base_url) as attacker:
        with framed.expect_console_message(predicate=lambda message: "frame-ancestors" in message.text or "refused to frame" in message.text.lower()):
            framed.goto(attacker, wait_until="networkidle")
        expect(framed.frame_locator("iframe").get_by_role("navigation", name="관리 메뉴")).to_have_count(0)
        assert framed.locator("iframe").count() == 1


def test_late_successful_save_cannot_restore_logged_out_private_state(page: Page, context: BrowserContext, console_server: Any) -> None:
    open_login(page, console_server)
    assert login(page, console_server).status == 200
    name = "늦은 성공 응답의 합성 저장"
    edit_workflow_name(page, name)
    other = context.new_page()
    other.goto(console_server.base_url, wait_until="networkidle")
    expect(other.get_by_role("navigation", name="관리 메뉴")).to_be_visible()
    held: dict = {}
    saves: list[str] = []

    def hold_save(route: Route) -> None:
        request = route.request
        if request.method != "POST" or request.post_data_json.get("action") != "save_workflow":
            route.continue_()
            return
        saves.append(request.post_data or "")
        held.update(route=route, response=route.fetch())
        # A fixture rendezvous records that the real backend has finished, while
        # the browser still waits for its response. It does not change auth state.
        page.evaluate("window.__authAcceptanceSaveHeld = true")

    page.route(console_server.base_url + "/api/console", hold_save)
    page.locator(".we-top-actions").get_by_role("button", name="저장", exact=True).click()
    page.wait_for_function("window.__authAcceptanceSaveHeld === true")
    assert held["response"].status == 200
    assert page.evaluate("key => localStorage.getItem(key) !== null", RECOVERY_KEY)
    assert logout(other, console_server).status == 200
    expect(page.get_by_role("heading", name="관리자 로그인", exact=True)).to_be_visible()
    assert page.evaluate("key => localStorage.getItem(key)", RECOVERY_KEY) is None
    release_response(held)
    page.unroute(console_server.base_url + "/api/console", hold_save)
    assert context.request.get(console_server.base_url + "/api/console").status == 401
    expect(page.locator(".console-private")).to_have_count(0)
    assert page.evaluate("key => localStorage.getItem(key)", RECOVERY_KEY) is None
    assert len(saves) == 1
    assert login(page, console_server).status == 200
    state = context.request.get(console_server.base_url + "/api/console").json()["state"]
    assert sum(item["name"] == name for item in state["workflows"]) == 1
    assert page.evaluate("key => localStorage.getItem(key)", RECOVERY_KEY) is None
    assert console_write(page, "fresh controller after explicit logout")["status"] == 200


def test_cross_tab_logout_aborts_late_login_before_cookie_installation(page: Page, context: BrowserContext, playwright: Playwright, console_server: Any) -> None:
    open_login(page, console_server)
    assert login(page, console_server).status == 200
    other = context.new_page()
    other.goto(console_server.base_url, wait_until="networkidle")
    expect(other.get_by_role("navigation", name="관리 메뉴")).to_be_visible()
    old_cookie = session_cookie(context, console_server)["value"]
    # Only this trigger is synthetic: preserve the still-valid old cookie while
    # opening reauthentication. The delayed login itself uses real auth/SQLite.
    page.route(console_server.base_url + "/api/console", lambda route: route.fulfill(
        status=401, content_type="application/json",
        body=json.dumps({"error": {"code": "unauthorized", "message": "Reauthentication fixture"}}),
    ), times=1)
    assert page.evaluate("async () => (await fetch('/api/console')).status") == 401
    expect(page.get_by_role("heading", name="다시 로그인", exact=True)).to_be_visible()
    isolated = playwright.request.new_context(base_url=console_server.base_url)
    held: dict = {}

    def hold_login(route: Route) -> None:
        # route.fetch() shares the browser cookie jar and would install the new
        # Set-Cookie prematurely. Keep it in a genuinely independent API context.
        response = isolated.post("/api/auth/login", headers={
            "Origin": console_server.base_url, "Cookie": f"aegis_session={old_cookie}",
        }, data=route.request.post_data_json)
        held.update(route=route, response=response)
        page.evaluate("window.__authAcceptanceLoginHeld = true")

    page.route(console_server.base_url + "/api/auth/login", hold_login)
    try:
        page.get_by_label("관리자 계정", exact=True).fill(console_server.username)
        page.get_by_label("비밀번호", exact=True).fill(console_server.password)
        page.get_by_role("button", name="로그인", exact=True).click()
        page.wait_for_function("window.__authAcceptanceLoginHeld === true")
        assert held["response"].status == 200
        assert session_cookie(context, console_server)["value"] == old_cookie
        # Login rotated the old server session; this tab's cookie is now stale.
        assert logout(other, console_server).status == 401
        expect(page.get_by_role("heading", name="관리자 로그인", exact=True)).to_be_visible()
        release_response(held)
        assert context.request.get(console_server.base_url + "/api/console").status == 401
        assert context.request.get(console_server.base_url + "/api/auth/session").json()["authenticated"] is False
        assert not any(cookie["name"] == "aegis_session" and cookie["value"] != old_cookie for cookie in context.cookies(console_server.base_url))
        expect(page.locator(".console-private")).to_have_count(0)
    finally:
        page.unroute(console_server.base_url + "/api/auth/login", hold_login)
        isolated.dispose()


def test_only_trusted_activity_renews_idle_session(page: Page, context: BrowserContext, console_server: Any) -> None:
    open_login(page, console_server)
    assert login(page, console_server).status == 200
    page.reload(wait_until="networkidle")  # Start with no pending activity hint.
    initial = context.request.get(console_server.base_url + "/api/auth/session").json()
    console_server.advance(50)
    page.evaluate("""() => {
        dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
        dispatchEvent(new KeyboardEvent('keydown', {key: 'a', bubbles: true}));
    }""")
    passive, headers = focus_session(page, console_server)
    assert "x-aegis-activity" not in headers
    assert passive["expiresAt"] == initial["expiresAt"]
    console_server.advance(11)
    expired, _ = focus_session(page, console_server)
    assert expired["authenticated"] is False
    expect(page.get_by_role("heading", name="다시 로그인", exact=True)).to_be_visible()
    assert login(page, console_server).status == 200
    page.reload(wait_until="networkidle")
    baseline = context.request.get(console_server.base_url + "/api/auth/session").json()
    console_server.advance(50)
    page.keyboard.press("Shift")  # Chromium creates a trusted keyboard event.
    active, headers = focus_session(page, console_server)
    assert headers["x-aegis-activity"] == "1"
    assert headers["x-aegis-csrf"]
    assert active["expiresAt"] > baseline["expiresAt"]
    console_server.advance(11)
    still_active, headers = focus_session(page, console_server)
    assert still_active["authenticated"] is True
    assert "x-aegis-activity" not in headers


def test_throttled_login_countdown_recovers_after_server_window(page: Page, console_server: Any) -> None:
    page.clock.install()
    open_login(page, console_server)
    for _ in range(3):
        assert login(page, console_server, "incorrect-synthetic-password").status == 401
    response = login(page, console_server, "incorrect-synthetic-password")
    assert response.status == 429
    retry_after = int(response.headers["retry-after"])
    assert 1 <= retry_after <= 10
    retry = page.get_by_role("button", name="초 후 다시 시도", exact=False)
    expect(retry).to_be_disabled()
    expect(page.get_by_role("alert")).to_have_text("로그인 시도가 많습니다. 잠시 후 다시 시도하세요.")
    console_server.advance(11)
    page.clock.fast_forward(11_000)
    expect(page.get_by_role("button", name="로그인", exact=True)).to_be_visible()
    assert login(page, console_server).status == 200


def test_mobile_login_labels_keyboard_focus_and_viewport(page: Page, console_server: Any) -> None:
    page.set_viewport_size({"width": 390, "height": 844})
    open_login(page, console_server)
    username = page.get_by_label("관리자 계정", exact=True)
    password = page.get_by_label("비밀번호", exact=True)
    expect(username).to_have_attribute("autocomplete", "username")
    expect(password).to_have_attribute("autocomplete", "current-password")
    expect(password).to_have_attribute("type", "password")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    username.focus()
    expect(username).to_be_focused()
    username.fill(console_server.username)
    page.keyboard.press("Tab")
    expect(password).to_be_focused()
    password.fill(console_server.password)
    for control in (username, password, page.get_by_role("button", name="로그인", exact=True)):
        box = control.bounding_box()
        assert box is not None and box["height"] >= 36
        assert box["x"] >= 0 and box["x"] + box["width"] <= 390
    with page.expect_response(lambda response: response.url == console_server.base_url + "/api/auth/login") as pending:
        password.press("Enter")
    assert pending.value.status == 200
    expect(page.get_by_role("button", name="로그아웃", exact=True)).to_be_visible()
