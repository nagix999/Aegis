"""Result inspection uses isolated, synthetic retained records and real management APIs."""
from __future__ import annotations

import asyncio
import csv
from concurrent.futures import ThreadPoolExecutor
import io
import json

from playwright.sync_api import expect

from aegis.store import Store, iso_at, now_ms
from test_console_auth import focus_session, login, open_login


def seed_results(server, count=33, policy_graph=False):
    async def seed():
        store = Store(server.root / "fixture.sqlite")
        try:
            state = await store.state()
            workflow, dataset = state["workflows"][0], state["datasets"][0]
            if policy_graph:
                guard = next(connection for connection in state["connections"] if connection["role"] in {"guard", "both"})
                policy = {"id": "fixture-policy", "name": "출력 필드 검사", "description": "", "formatVersion": 2, "prompt": "위험 점수를 JSON으로 반환하세요.", "connectionId": guard["id"], "connectionSnapshot": guard, "version": 1, "updatedAt": iso_at(), "decisions": [], "examples": [{"id": "example", "input": "배송", "expectedOutput": {"risk": {"score": 10}}}], "outputSchema": {"type": "object", "properties": {"risk": {"type": "object", "properties": {"score": {"type": "integer", "minimum": 0, "maximum": 100}}, "required": ["score"], "additionalProperties": False}}, "required": ["risk"], "additionalProperties": False}}
                workflow["policyRouting"] = {"policy": policy, "routes": [], "graph": {"version": 1, "entryNodeId": "fixture-branch", "nodes": [{"id": "fixture-branch", "name": "위험 점수 분기", "kind": "branch", "condition": {"mode": "all", "predicates": [{"path": "/risk/score", "operator": "gte", "value": 80}]}}, {"id": "fixture-main", "name": "응답 생성", "kind": "action", "action": "main"}, {"id": "fixture-error", "name": "위험 요청 거부", "kind": "action", "action": "error", "errorCode": "RISK_RESTRICTED", "errorMessage": "정책에 따라 제한합니다."}], "edges": [{"id": "fixture-yes", "from": "fixture-branch", "to": "fixture-error", "port": "true"}, {"id": "fixture-no", "from": "fixture-branch", "to": "fixture-main", "port": "false"}]}}
                await store.put("workflow", workflow["id"], workflow)
            await store.deploy({"id": "fixture-deployment", "workflowId": workflow["id"], "alias": workflow["alias"], "createdAt": iso_at(), "workflow": workflow, "connections": state["connections"]})
            results = [
                {"id": "result-allow", "rowId": "row-allow", "input": "공개 검증 질문", "expected": "allow", "status": "allow", "stage": "complete", "output": "공개 응답", "latencyMs": 1, "traces": [], "reason": "허용", "expectationMatched": True},
                {"id": "result-block", "rowId": "row-block", "input": '=HYPERLINK("https://example.invalid")', "expected": "block", "status": "block", "stage": "post", "output": "PRIVATE_BLOCKED_OUTPUT", "latencyMs": 2, "traces": [], "reason": "차단", "policyOutput": {"raw": "PRIVATE_POLICY_OUTPUT"}, "policyFieldChecks": [{"path": "/risk/score", "matched": False}], "expectationMatched": False},
                {"id": "result-error", "rowId": "row-error", "input": "오류 사례", "expected": "allow", "status": "error", "stage": "main", "output": "PRIVATE_ERROR_OUTPUT", "latencyMs": 3, "traces": [], "reason": "실행 오류", "expectationMatched": False},
            ]
            if policy_graph:
                results[0].update(policyRoute="main", policyPath=["fixture-branch", "fixture-main"])
            for index in range(count):
                identifier = f"retained-run-{index:03}"
                await store.put("run", identifier, {"id": identifier, "workflowId": workflow["id"], "workflowName": workflow["name"], "datasetId": dataset["id"], "datasetName": f"보관 사례 {index:03}", "createdAt": iso_at(now_ms() - index * 1000), "updatedAt": iso_at(now_ms() - index * 1000), "version": "draft", "target": "draft", "status": "completed", "executionMode": "manual", "total": 3, "results": results, "workflowSnapshot": workflow, "datasetSnapshot": dataset, "connectionsSnapshot": state["connections"], "_lease": {"token": "PRIVATE_LEASE"}})
            for index in range(3):
                await store.log({"id": f"log-{index}", "source": "gateway", "workflowId": workflow["id"], "workflowName": workflow["name"], "version": "v1", "createdAt": iso_at(now_ms() - index * 1000), "status": "allow", "stage": "complete", "latencyMs": 1, "reason": "검사 통과", "traces": []})
        finally:
            await store.close()
    # Playwright's synchronous facade already owns an event loop in this thread.
    with ThreadPoolExecutor(max_workers=1) as executor:
        executor.submit(lambda: asyncio.run(seed())).result(timeout=15)


def open_console(page, server):
    open_login(page, server)
    assert login(page, server).status == 200


def open_history(page):
    page.get_by_role("navigation", name="관리 메뉴").get_by_role("button", name="검증 실행", exact=True).click()
    page.get_by_role("button", name="데이터셋 검증", exact=True).click()
    page.get_by_role("button", name="전체 실행 기록 검색", exact=False).click()


def test_log_drawer_visible_keyboard_mobile_and_closes_on_session_lock(page, context, console_server):
    seed_results(console_server, 1)
    open_console(page, console_server)
    page.get_by_role("navigation", name="관리 메뉴").get_by_role("button", name="요청 기록", exact=True).click()
    row = page.locator(".ev-log-table tbody tr").first
    expect(row).to_be_visible()
    row.click()
    drawer = page.get_by_role("dialog", name="요청 상세", exact=True)
    expect(drawer).to_be_visible()
    expect(drawer.get_by_text("1 / 3건", exact=True)).to_be_visible()
    box = drawer.bounding_box()
    assert box and box["y"] == 0 and box["height"] <= 1001
    drawer.get_by_role("button", name="다음 항목", exact=True).click()
    expect(drawer.get_by_text("2 / 3건", exact=True)).to_be_visible()
    page.keyboard.press("Escape")
    expect(drawer).not_to_be_visible()
    expect(row).to_be_focused()
    row.click()
    drawer.get_by_role("button", name="배포 흐름 보기", exact=True).click()
    flow = page.get_by_role("dialog", name="요청 당시 배포 흐름", exact=True)
    expect(drawer).not_to_be_visible()
    expect(flow).to_be_visible()
    flow.get_by_role("button", name="요청 흐름 닫기", exact=True).click()
    expect(flow).not_to_be_visible()
    page.set_viewport_size({"width": 390, "height": 844})
    row.press("Enter")
    expect(drawer).to_be_visible()
    box = drawer.bounding_box()
    assert box and box["x"] == 0 and box["width"] == 390
    # Native modal focus must not escape to the inert application.
    for _ in range(10):
        page.keyboard.press("Tab")
        assert page.evaluate("Boolean(document.activeElement?.closest('dialog[open]'))")
    drawer.get_by_role("button", name="요청 상세 닫기", exact=True).focus()
    page.keyboard.press("Shift+Tab")
    assert page.evaluate("Boolean(document.activeElement?.closest('dialog[open]'))")
    console_server.advance(61)
    body, _ = focus_session(page, console_server)
    assert body["authenticated"] is False
    expect(page.get_by_role("heading", name="다시 로그인", exact=True)).to_be_visible()
    assert page.locator("dialog[open]").count() == 0
    assert context.request.get("/api/console?view=logs").status == 401


def test_history_paginates_and_opens_old_runs_by_search_or_exact_id(page, console_server):
    seed_results(console_server, policy_graph=True)
    open_console(page, console_server)
    open_history(page)
    history = page.locator(".ev-run-history")
    expect(history.locator("tbody tr")).to_have_count(20)
    history.get_by_role("button", name="다음 페이지", exact=True).click()
    expect(history.locator("tbody tr")).to_have_count(13)
    history.get_by_label("검증 실행 기록 검색", exact=True).fill("retained-run-032")
    history.get_by_role("button", name="검색", exact=True).click()
    expect(history.locator("tbody tr")).to_have_count(1)
    history.get_by_role("button", name="기록 보기", exact=True).click()
    expect(page.locator(".ev-job-head h2")).to_have_text("보관 사례 032")
    # The direct ID path is independent from the currently applied search.
    page.get_by_role("button", name="전체 실행 기록 검색", exact=False).click()
    history.get_by_label("직접 열 검증 실행 ID", exact=True).fill("missing-run")
    history.get_by_role("button", name="기록 열기", exact=True).click()
    expect(history.get_by_role("alert")).to_contain_text("이 실행 기록을 찾을 수 없습니다")
    history.get_by_label("직접 열 검증 실행 ID", exact=True).fill("retained-run-017")
    history.get_by_role("button", name="기록 열기", exact=True).click()
    expect(page.locator(".ev-job-head h2")).to_have_text("보관 사례 017")
    first = page.locator(".ev-results-table tbody tr").first
    first.click()
    drawer = page.get_by_role("dialog", name="검증 항목 상세", exact=True)
    expect(drawer).to_be_visible()
    expect(drawer.get_by_text("공개 응답", exact=True)).to_be_visible()
    drawer.get_by_role("button", name="다음 항목", exact=True).click()
    expect(drawer.get_by_text("2 / 3건", exact=True)).to_be_visible()
    assert "PRIVATE_BLOCKED_OUTPUT" not in drawer.inner_text()
    expect(drawer.get_by_text("정책 출력 /risk/score 불일치", exact=True)).to_be_visible()
    page.keyboard.press("Escape")
    expect(first).to_be_focused()
    first.click()
    drawer.get_by_role("button", name="위험 점수 분기 노드 보기", exact=True).click()
    expect(page.get_by_label("정책 노드 이름", exact=True)).to_have_value("위험 점수 분기")
    page.get_by_role("button", name="검증 결과로 돌아가기", exact=True).click()
    expect(page.locator(".ev-job-head h2")).to_have_text("보관 사례 017")
    expect(page.get_by_role("dialog", name="검증 항목 상세", exact=True)).to_be_visible()


def test_filtered_result_downloads_redact_private_outputs_and_escape_csv(page, console_server, tmp_path):
    seed_results(console_server, 1)
    open_console(page, console_server)
    open_history(page)
    history = page.locator(".ev-run-history")
    expect(history.locator("tbody tr")).to_have_count(1)
    history.get_by_role("button", name="기록 보기", exact=True).click()
    results = page.locator(".ev-results-table")
    expect(results.locator("tbody tr")).to_have_count(3)
    with page.expect_download() as pending:
        results.get_by_role("button", name="JSON", exact=True).click()
    path = tmp_path / "results.json"
    pending.value.save_as(path)
    text = path.read_text()
    report = json.loads(text)
    assert report["displayedCount"] == 3 and "PRIVATE_" not in text
    assert report["results"][0]["output"] == "공개 응답"
    results.get_by_label("검증 결과 필터", exact=True).select_option("block")
    expect(results.locator("tbody tr")).to_have_count(1)
    with page.expect_download() as pending:
        results.get_by_role("button", name="CSV", exact=True).click()
    path = tmp_path / "results.csv"
    pending.value.save_as(path)
    text = path.read_text(encoding="utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(text)))
    assert len(rows) == 1 and rows[0]["status"] == "block" and rows[0]["output"] == ""
    assert rows[0]["input"].startswith("'=HYPERLINK") and "PRIVATE_" not in text
