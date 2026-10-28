"""Focused authoring journeys using the isolated browser fixture and synthetic data."""
from __future__ import annotations

import json

import pytest

from playwright.sync_api import Page, expect


def login(page: Page, server) -> None:
    page.goto(server.base_url, wait_until="networkidle")
    page.get_by_label("관리자 계정", exact=True).fill(server.username)
    page.get_by_label("비밀번호", exact=True).fill(server.password)
    page.get_by_role("button", name="로그인", exact=True).click()
    expect(page.get_by_role("navigation", name="관리 메뉴")).to_be_visible()


def navigate(page: Page, label: str) -> None:
    page.get_by_role("navigation", name="관리 메뉴").get_by_role("button", name=label, exact=True).click()


@pytest.mark.parametrize("width", [1450, 390])
def test_policy_required_field_preview_preserves_expected_answers_and_single_sticky_actions(page, console_server, width):
    page.set_viewport_size({"width":width,"height":1000})
    login(page, console_server)
    navigate(page, "정책 관리")
    page.get_by_role("button", name="정책 추가", exact=True).click()
    page.get_by_label("정책 이름", exact=True).fill("보완안 검토 정책")
    page.get_by_role("tab", name="JSON 직접 편집", exact=True).click()
    schema_field = page.get_by_label("정책 출력 스키마 JSON", exact=True)
    schema = json.loads(schema_field.input_value())
    schema["properties"]["reviewerNote"] = {"type": "string"}
    schema["required"].append("reviewerNote")
    original = page.get_by_label("정책 예제 예상 JSON 1", exact=True).input_value()
    schema_field.fill(json.dumps(schema))
    page.get_by_role("button", name="필수 필드 보완안", exact=True).click()
    expect(page.get_by_role("button", name="보완안 3개 예제에 적용", exact=True)).to_be_disabled()
    expect(page.get_by_label("정책 예제 예상 JSON 1", exact=True)).to_have_value(original)
    page.get_by_label("보완안을 검토했습니다.", exact=False).check()
    page.get_by_role("button", name="보완안 3개 예제에 적용", exact=True).click()
    changed = json.loads(page.get_by_label("정책 예제 예상 JSON 1", exact=True).input_value())
    assert changed == {**json.loads(original), "reviewerNote": ""}
    assert changed["risk"]["score"] == 10
    expect(page.get_by_role("button", name="정책 저장", exact=True)).to_have_count(1)
    expect(page.get_by_role("button", name="예제 테스트", exact=True)).to_have_count(1)
    page.evaluate("scrollTo(0, document.documentElement.scrollHeight)")
    toolbar = page.get_by_label("정책 편집 작업", exact=True)
    box = toolbar.bounding_box()
    assert box is not None and 0 <= box["y"] < 100
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
    page.get_by_role("button", name="정책 저장", exact=True).click()
    expect(page.get_by_role("button", name="새 버전 저장", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="새 버전 저장", exact=True)).to_be_disabled()


@pytest.mark.parametrize("width", [1450, 390])
def test_dataset_selected_item_navigation_retains_invalid_json_and_blocks_stale_save(page, console_server, width):
    page.set_viewport_size({"width":width,"height":1000})
    login(page, console_server)
    response = page.evaluate("""async () => {
        const response = await fetch('/api/console', {method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({action:'save_dataset', expectedUpdatedAt:null, dataset:{id:'authoring-fixture',name:'항목 이동 검토',description:'합성 요청',rows:Array.from({length:20},(_,i)=>({id:'fixture-row-'+(i+1),input:'검증 요청 '+(i+1),expected:'allow'}))}})});
        return {status:response.status,body:await response.json()};
    }""")
    assert response["status"] == 200
    page.reload(wait_until="networkidle")
    navigate(page, "검증 데이터셋")
    page.get_by_role("button", name="항목 이동 검토", exact=True).click()
    expect(page.locator("[data-dataset-row]")).to_have_count(1)
    page.get_by_label("이동할 검증 항목 번호", exact=True).fill("20")
    page.get_by_role("button", name="이동", exact=True).click()
    expect(page.get_by_label("20번 항목 요청 내용", exact=True)).to_be_visible()
    page.get_by_label("20번 항목 정책 출력 필드 조건 사용", exact=True).check()
    page.get_by_label("20번 항목 정책 출력 1 필드 경로", exact=True).fill("/risk/score")
    page.get_by_label("20번 항목 정책 출력 1 연산", exact=True).select_option("gte")
    page.get_by_label("20번 항목 정책 출력 1 비교값", exact=True).fill("-")
    page.get_by_role("button", name="이전 검증 항목", exact=True).click()
    page.get_by_role("button", name="다음 검증 항목", exact=True).click()
    criteria_box = page.get_by_label("20번 항목 검증 기준", exact=True).bounding_box()
    request_box = page.get_by_label("20번 항목 대화와 생성 옵션", exact=True).bounding_box()
    assert criteria_box is not None and request_box is not None
    assert criteria_box["y"] + criteria_box["height"] <= request_box["y"]
    page.get_by_label("20번 항목 검증 기준", exact=True).click()
    expect(page.get_by_label("20번 항목 정책 출력 1 비교값", exact=True)).to_have_value("-")
    page.get_by_role("button", name="저장", exact=True).click()
    expect(page.get_by_label("데이터셋 편집 작업", exact=True)).to_contain_text("입력 확인")
    page.get_by_label("20번 항목 정책 출력 1 비교값", exact=True).fill("80")
    page.get_by_label("20번 항목 대화와 생성 옵션", exact=True).click()
    page.get_by_label("20번 항목 대화 메시지 JSON", exact=True).fill("[")
    page.get_by_role("button", name="이전 검증 항목", exact=True).click()
    expect(page.get_by_label("19번 항목 요청 내용", exact=True)).to_be_visible()
    page.get_by_role("button", name="다음 검증 항목", exact=True).click()
    page.get_by_label("20번 항목 대화와 생성 옵션", exact=True).click()
    expect(page.get_by_label("20번 항목 대화 메시지 JSON", exact=True)).to_have_value("[")
    page.get_by_role("button", name="저장", exact=True).click()
    expect(page.get_by_label("데이터셋 편집 작업", exact=True)).to_contain_text("입력 확인")
    expect(page.get_by_label("20번 항목 대화 메시지 JSON", exact=True)).to_have_value("[")
    page.get_by_label("검증 항목 검색", exact=True).fill("검증 요청 5")
    expect(page.get_by_label("5번 항목 요청 내용", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="5번 항목 편집", exact=True)).to_be_visible()
    expect(page.get_by_label("검증 항목 목록", exact=True).get_by_role("button")).to_have_count(1)
    page.get_by_role("button", name="검증 항목 검색 지우기", exact=True).click()
    page.get_by_role("button", name="항목 추가", exact=True).click()
    expect(page.get_by_label("21번 항목 요청 내용", exact=True)).to_be_visible()
    expect(page.get_by_label("검증 항목 목록", exact=True).get_by_role("button")).to_have_count(21)


@pytest.mark.parametrize("width", [1450, 390])
def test_policy_chosen_field_comparison_uses_typed_value_and_shows_only_path_verdict(page, console_server, width):
    page.set_viewport_size({"width":width,"height":1000})
    login(page, console_server)
    navigate(page, "정책 관리")
    page.get_by_role("button", name="정책 추가", exact=True).click()
    page.get_by_label("정책 이름", exact=True).fill("선택 필드 검증")
    page.get_by_label("정책 예제 1 출력 비교 방식", exact=True).select_option("fields")
    page.get_by_label("정책 예제 1 1 필드 경로", exact=True).fill("/risk/score")
    page.get_by_label("정책 예제 1 1 연산", exact=True).select_option("gte")
    expect(page.get_by_label("정책 예제 1 1 값 자료형", exact=True)).to_have_value("number")
    page.get_by_label("정책 예제 1 1 비교값", exact=True).fill("80")
    page.get_by_label("정책 예제 2 출력 비교 방식", exact=True).select_option("schema")
    with page.expect_response(lambda response: response.url.endswith("/api/console") and response.request.method == "POST") as pending:
        page.get_by_role("button", name="예제 테스트", exact=True).click()
    response = pending.value
    assert response.status == 200
    results = response.json()["policyTest"]["results"]
    assert results[0]["checks"] == [{"path":"/risk/score","matched":False}]
    assert results[0]["status"] == "fail" and results[1]["status"] == "pass"
    assert "actual" not in results[0] and "expectedOutput" not in results[0]
    page.get_by_role("button", name="테스트 결과 보기", exact=True).click()
    expect(page.locator("[data-policy-section=results]")).to_contain_text("/risk/score")
    expect(page.locator("[data-policy-section=results]")).to_contain_text("불일치")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
