"""Dataset authoring journeys using temporary databases and explicit expectations."""
from __future__ import annotations

import pytest
from playwright.sync_api import expect


def login(page, server):
    page.goto(server.base_url, wait_until="networkidle")
    page.get_by_label("관리자 계정", exact=True).fill(server.username)
    page.get_by_label("비밀번호", exact=True).fill(server.password)
    page.get_by_role("button", name="로그인", exact=True).click()
    expect(page.get_by_role("navigation", name="관리 메뉴")).to_be_visible()


def post(page, payload):
    response = page.evaluate("""async payload => {
        const response = await fetch('/api/console', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        return {status:response.status,body:await response.json()};
    }""", payload)
    assert response["status"] == 200, response["body"]
    return response["body"]


def seed_switch(page):
    state = page.evaluate("async () => (await (await fetch('/api/console')).json()).state")
    connection = next(value for value in state["connections"] if value["role"] != "main")
    policy = post(page, {"action":"save_policy", "expectedVersion":0, "policy":{
        "id":"dataset-switch-policy", "name":"데이터셋 기준 정책", "description":"합성 검사", "prompt":"위험 수준을 JSON으로 분류하세요.",
        "connectionId":connection["id"], "formatVersion":2, "maxOutputTokens":1024, "decisions":[],
        "outputSchema":{"type":"object","properties":{"risk":{"type":"object","properties":{"level":{"type":"string","enum":["low","high"]},"score":{"type":"number"}},"required":["level"],"additionalProperties":False}},"required":["risk"],"additionalProperties":False},
        "examples":[{"id":"shipping","input":"배송","expectedOutput":{"risk":{"level":"low"}}}]
    }})["policy"]
    workflow = state["workflows"][0]
    workflow.update(id="dataset-switch-workflow", name="검증 초안 연결", alias="dataset-switch-workflow", pre=[], post=[])
    workflow.pop("graph", None)
    workflow.pop("layout", None)
    workflow["policyRouting"] = {"policy":policy,"routes":[],"graph":{"version":1,"entryNodeId":"switch","nodes":[
        {"id":"switch","name":"위험 수준 선택","kind":"switch","path":"/risk/level","cases":[{"id":"low","value":"low"}]},
        {"id":"error","name":"명시 오류","kind":"action","action":"error","errorCode":"POLICY_BLOCKED","errorMessage":"합성 제한"}],
        "edges":[{"id":"case-low","from":"switch","to":"error","port":"low"},{"id":"default","from":"switch","to":"error","port":"default"}]}}
    post(page, {"action":"save_workflow","workflow":workflow,"expectedUpdatedAt":None})
    return workflow


@pytest.mark.parametrize("width", [1450, 390])
def test_dataset_table_bulk_undo_and_paste_preview_keep_explicit_verdicts(page, console_server, width):
    page.set_viewport_size({"width":width,"height":1000})
    login(page, console_server)
    post(page, {"action":"save_dataset","expectedUpdatedAt":None,"dataset":{"id":"dataset-authoring","name":"일괄 편집 검토","description":"합성 요청","rows":[
        {"id":"one","input":"  첫 요청  ","expected":"allow"},{"id":"two","input":"두 번째 요청","expected":"block"},{"id":"three","input":"세 번째 요청","expected":"allow"}]}})
    page.reload(wait_until="networkidle")
    page.get_by_role("navigation", name="관리 메뉴").get_by_role("button", name="검증 데이터셋", exact=True).click()
    page.get_by_role("button", name="일괄 편집 검토", exact=True).click()
    expect(page.get_by_label("검증 항목 목록", exact=True).get_by_role("table")).to_be_visible()
    page.get_by_label("1번 항목 일괄 선택", exact=True).check()
    page.get_by_label("2번 항목 일괄 선택", exact=True).check()
    page.get_by_role("button", name="선택 항목 일괄 설정", exact=True).click()
    dialog = page.get_by_role("dialog", name="선택 항목 2개 일괄 설정")
    dialog.get_by_label("일괄 예상 결과", exact=True).select_option("block")
    dialog.get_by_role("button", name="선택한 설정 적용", exact=True).click()
    expect(page.get_by_label("1번 항목 예상 결과", exact=True)).to_have_value("block")
    page.get_by_role("button", name="마지막 일괄 작업 되돌리기", exact=True).click()
    expect(page.get_by_label("1번 항목 예상 결과", exact=True)).to_have_value("allow")
    page.get_by_role("button", name="붙여넣기", exact=True).click()
    preview = page.get_by_role("dialog", name="가져오기 미리보기")
    preview.get_by_label("데이터셋 붙여넣기", exact=True).fill('[{"input":"새 합성 요청","expected":"block","expectedPolicyFields":[{"path":"/risk/score","operator":"gte","value":80}]}]')
    preview.get_by_role("button", name="붙여넣은 내용 확인", exact=True).click()
    expect(page.get_by_label("검증 항목 목록", exact=True).get_by_role("button")).to_have_count(3)
    expect(preview.get_by_label("가져올 항목 미리보기", exact=True)).to_contain_text("새 합성 요청")
    preview.get_by_role("button", name="미리 본 항목 추가", exact=True).click()
    expect(page.get_by_label("검증 항목 목록", exact=True).get_by_role("button")).to_have_count(4)
    page.get_by_role("button", name="4번 항목 편집", exact=True).click()
    page.get_by_label("4번 항목 검증 기준", exact=True).click()
    expect(page.get_by_label("4번 항목 정책 출력 1 값 자료형", exact=True)).to_have_value("number")
    page.get_by_label("4번 항목 정책 출력 1 비교값", exact=True).fill("81")
    with page.expect_response(lambda response: response.url.endswith('/api/console') and response.request.method == 'POST') as pending:
        page.get_by_role("button", name="저장", exact=True).click()
    saved = pending.value.json()["state"]["datasets"]
    rows = next(dataset for dataset in saved if dataset["id"] == "dataset-authoring")["rows"]
    assert rows[0]["input"] == "  첫 요청  " and rows[0]["expected"] == "allow"
    assert rows[1]["expected"] == "block"
    assert rows[3]["expectedPolicyFields"] == [{"path":"/risk/score","operator":"gte","value":81}]
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")


def test_switch_templates_leave_requests_and_final_answers_unset_and_preserve_field_values(page, console_server):
    login(page, console_server)
    workflow = seed_switch(page)
    page.goto(console_server.base_url + '/?page=workflows&workflowId=' + workflow['id'] + '&nodeId=policy:switch', wait_until="networkidle")
    page.get_by_role("button", name="검증 사례 만들기", exact=True).click()
    expect(page.get_by_label("1번 항목 요청 내용", exact=True)).to_have_value("")
    expect(page.get_by_label("1번 항목 예상 결과", exact=True)).to_have_value("")
    expect(page.get_by_label("검증 항목 목록", exact=True).get_by_role("button")).to_have_count(2)
    page.get_by_role("button", name="저장", exact=True).click()
    expect(page.get_by_label("데이터셋 편집 작업", exact=True)).to_contain_text("입력 확인")
    page.get_by_label("1번 항목 요청 내용", exact=True).fill("직접 작성한 낮은 위험 요청")
    page.get_by_label("1번 항목 예상 결과", exact=True).select_option("allow")
    page.get_by_role("button", name="2번 항목 편집", exact=True).click()
    expect(page.get_by_label("2번 항목 예상 결과", exact=True)).to_have_value("")
    page.get_by_label("2번 항목 요청 내용", exact=True).fill("직접 작성한 높은 위험 요청")
    page.get_by_label("2번 항목 예상 결과", exact=True).select_option("block")
    with page.expect_response(lambda response: response.url.endswith('/api/console') and response.request.method == 'POST') as pending:
        page.get_by_role("button", name="저장", exact=True).click()
    response = pending.value
    assert response.status == 200
    saved = next(dataset for dataset in response.json()["state"]["datasets"] if dataset["name"].endswith("Switch 사례"))
    assert [row["expected"] for row in saved["rows"]] == ["allow", "block"]
    assert [row["expectedPolicyFields"][0]["value"] for row in saved["rows"]] == ["low", "high"]
    assert all(row["expectedPolicyFields"][0]["path"] == "/risk/level" for row in saved["rows"])


@pytest.mark.parametrize("width", [1450, 390])
def test_single_request_case_saves_independent_policy_field_expectations(page, console_server, width):
    page.set_viewport_size({"width":width,"height":1000})
    login(page, console_server)
    workflow = seed_switch(page)
    page.goto(console_server.base_url + '/?page=evaluation&workflowId=' + workflow['id'] + '&tab=single', wait_until="networkidle")
    page.locator('#ev-prompt').fill("배송")
    page.get_by_role("main").get_by_role("button", name="검증 실행", exact=True).click()
    page.get_by_role("button", name="데이터셋에 저장", exact=True).click()
    dialog = page.get_by_role("dialog", name="검증 데이터셋에 저장")
    dialog.locator(".ev-case-form-grid select").first.select_option("allow")
    dialog.get_by_label("저장할 정책 출력 필드 조건 사용", exact=True).check()
    dialog.get_by_role("button", name="필드 조건 추가", exact=True).click()
    dialog.get_by_label("저장할 정책 출력 1 필드 경로", exact=True).fill("/risk/level")
    dialog.get_by_label("저장할 정책 출력 1 필드 경로", exact=True).press("Enter")
    dialog.get_by_label("저장할 정책 출력 1 비교값", exact=True).select_option(label='"low"')
    dialog.get_by_role("button", name="필드 조건 추가", exact=True).click()
    dialog.get_by_label("저장할 정책 출력 2 필드 경로", exact=True).fill("/risk/score")
    dialog.get_by_label("저장할 정책 출력 2 필드 경로", exact=True).press("Enter")
    expect(dialog.get_by_label("저장할 정책 출력 2 값 자료형", exact=True)).to_have_value("number")
    expect(dialog.get_by_label("저장할 정책 출력 2 비교값", exact=True)).to_have_value("")
    dialog.get_by_label("저장할 정책 출력 2 비교값", exact=True).fill("80")
    assert dialog.evaluate("node => node.scrollWidth <= node.clientWidth + 1")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
    dialog.get_by_label("예상 결과를 검증 기준으로 저장 확인", exact=True).check()
    with page.expect_response(lambda response: response.url.endswith('/api/console') and response.request.method == 'POST') as pending:
        dialog.get_by_role("button", name="저장", exact=True).click()
    response = pending.value
    assert response.status == 200
    saved = next(dataset for dataset in response.json()["state"]["datasets"] if dataset["name"] == "요청 검증 사례")
    assert saved["rows"][0]["expected"] == "allow"
    assert saved["rows"][0]["expectedPolicyFields"] == [{"path":"/risk/level","operator":"eq","value":"low"},{"path":"/risk/score","operator":"eq","value":80}]
    assert "output" not in saved["rows"][0]
