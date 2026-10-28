"""Navigation races on isolated servers and real administrator session cookies."""
from __future__ import annotations

import json
from urllib.parse import parse_qs, urlencode, urlparse

from playwright.sync_api import expect

from test_console_auth import RECOVERY_KEY, edit_workflow_name, release_response
from test_console_navigation import enter


def test_brand_navigation_wins_over_delayed_initial_run_restoration(page, console_server):
    enter(page, console_server)
    held = {}
    run_url = console_server.base_url + "/api/console?view=evaluations&runId=delayed-navigation-fixture"

    def hold_missing_run(route):
        # Fetch the authenticated empty lookup from the real fixture backend.
        # Only delivery is delayed; the response and session stay untouched.
        held.update(route=route, response=route.fetch())
        page.evaluate("window.__navigationFixtureRunHeld = true")

    page.route(run_url, hold_missing_run)
    try:
        page.goto(console_server.base_url + "/?page=evaluation&runId=delayed-navigation-fixture", wait_until="domcontentloaded")
        page.wait_for_function("window.__navigationFixtureRunHeld === true")
        assert held["response"].status == 200
        assert held["response"].json().get("run") is None
        page.get_by_role("link", name="Aegis 관리 콘솔", exact=True).click()
        expect(page.get_by_role("heading", name="워크플로우", exact=True)).to_be_visible()
        with page.expect_response(lambda response: response.url == run_url) as pending:
            release_response(held)
        pending.value.finished()
        # Inspect after the response body and the following paints, so a late
        # React navigation cannot pass merely because the old page is visible.
        page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        expect(page.get_by_role("navigation", name="관리 메뉴").locator(".nav-item.active")).to_have_attribute("aria-label", "워크플로우")
        expect(page.locator(".wf-list-name").first).to_be_visible()
        assert parse_qs(urlparse(page.url).query) == {"page": ["workflows"]}
    finally:
        page.unroute(run_url, hold_missing_run)


def test_workflow_deep_link_restores_after_initial_state_failure_and_retry(page, context, console_server):
    enter(page, console_server)
    # Reuse the real session cookie. No credential or CSRF token is embedded in
    # a URL, browser storage, fixture payload or assertion.
    response = context.request.get(console_server.base_url + "/api/console")
    assert response.status == 200
    workflow_id = response.json()["state"]["workflows"][0]["id"]
    first = True

    def fail_first_state(route):
        nonlocal first
        if first and route.request.method == "GET":
            first = False
            # Explicitly simulated transient management failure, not an auth
            # failure. The subsequent retry reaches the real FastAPI backend.
            route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": {"code": "fixture_unavailable", "message": "합성 초기 조회 실패"}}))
        else:
            route.continue_()

    state_url = console_server.base_url + "/api/console"
    page.route(state_url, fail_first_state)
    try:
        query = urlencode({"page": "workflows", "workflowId": workflow_id, "nodeId": "main"})
        page.goto(console_server.base_url + "/?" + query, wait_until="networkidle")
        expect(page.get_by_role("button", name="다시 확인", exact=True)).to_be_visible()
        with page.expect_response(lambda value: value.url == state_url and value.status == 200):
            page.get_by_role("button", name="다시 확인", exact=True).click()
        expect(page.get_by_text("관리 서버 연결됨", exact=True)).to_be_visible()
        expect(page.locator(".we-top-actions")).to_be_visible()
        page.wait_for_function("([id]) => { const p=new URLSearchParams(location.search); return p.get('page')==='workflows' && p.get('workflowId')===id && p.get('nodeId')==='main'; }", arg=[workflow_id])
    finally:
        page.unroute(state_url, fail_first_state)


def test_unsaved_workflow_recovery_survives_initial_state_failure_and_retry(page, context, console_server):
    enter(page, console_server)
    state_url = console_server.base_url + "/api/console"
    saved = context.request.get(state_url).json()["state"]["workflows"][0]
    draft_name = "초기 연결 재시도 후 복구할 합성 초안"
    edit_workflow_name(page, draft_name)
    assert parse_qs(urlparse(page.url).query)["workflowId"] == [saved["id"]]
    assert page.evaluate("([key,name]) => localStorage.getItem(key)?.includes(name)", [RECOVERY_KEY, draft_name])
    first = True

    def fail_first_state(route):
        nonlocal first
        if first and route.request.method == "GET":
            first = False
            route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": {"code": "fixture_unavailable", "message": "합성 초기 조회 실패"}}))
        else:
            route.continue_()

    page.route(state_url, fail_first_state)
    try:
        page.reload(wait_until="networkidle")
        expect(page.get_by_role("button", name="다시 확인", exact=True)).to_be_visible()
        with page.expect_response(lambda response: response.url == state_url and response.status == 200):
            page.get_by_role("button", name="다시 확인", exact=True).click()
        recovery = page.get_by_role("dialog", name="임시 초안을 확인하세요", exact=True)
        expect(recovery).to_be_visible()
        expect(recovery.get_by_text(draft_name, exact=True)).to_be_visible()
        recovery.get_by_role("button", name="복구하여 계속", exact=True).click()
        expect(page.locator(".we-top-actions")).to_be_visible()
        page.get_by_role("button", name="기본 설정", exact=True).click()
        expect(page.locator(".we-workflow-settings input").first).to_have_value(draft_name)
        current = next(workflow for workflow in context.request.get(state_url).json()["state"]["workflows"] if workflow["id"] == saved["id"])
        assert current["name"] == saved["name"]
        assert page.evaluate("([key,name]) => localStorage.getItem(key)?.includes(name)", [RECOVERY_KEY, draft_name])
    finally:
        page.unroute(state_url, fail_first_state)
