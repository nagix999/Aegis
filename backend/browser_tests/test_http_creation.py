"""Creation actions on a real, non-secure browser HTTP origin.

The .test page is fulfilled from our owned loopback fixture, so no DNS or
external server is required. Only the forwarding request's Host and Origin are
translated to the fixture's configured origin; browser security settings and
Web Crypto are untouched. Login, CSRF writes and persistence use the real API.
"""
from __future__ import annotations

from urllib.parse import urlsplit

import pytest
from playwright.sync_api import Page, Route, expect

HTTP_ORIGIN = "http://aegis-console.test"


def open_http_console(page: Page, server, width: int) -> None:
    page.set_viewport_size({"width": width, "height": 1000})

    def forward(route: Route) -> None:
        parsed = urlsplit(route.request.url)
        assert parsed.scheme == "http" and parsed.netloc == "aegis-console.test"
        headers = route.request.all_headers()
        headers["host"] = urlsplit(server.base_url).netloc
        if headers.get("origin") == HTTP_ORIGIN:
            headers["origin"] = server.base_url
        if headers.get("referer", "").startswith(HTTP_ORIGIN + "/"):
            headers["referer"] = server.base_url + headers["referer"][len(HTTP_ORIGIN):]
        response = route.fetch(
            url=server.base_url + parsed.path + ("?" + parsed.query if parsed.query else ""),
            headers=headers,
        )
        route.fulfill(response=response)

    page.route(HTTP_ORIGIN + "/**", forward)
    response = page.goto(HTTP_ORIGIN, wait_until="networkidle")
    assert response is not None and response.status == 200
    assert page.evaluate("""() => ({
        origin: location.origin,
        secure: isSecureContext,
        randomUUID: typeof crypto.randomUUID,
        getRandomValues: typeof crypto.getRandomValues,
        subtle: typeof crypto.subtle
    })""") == {
        "origin": HTTP_ORIGIN, "secure": False,
        "randomUUID": "undefined", "getRandomValues": "function", "subtle": "undefined",
    }
    page.get_by_label("관리자 계정", exact=True).fill(server.username)
    page.get_by_label("비밀번호", exact=True).fill(server.password)
    page.get_by_role("button", name="로그인", exact=True).click()
    expect(page.get_by_role("navigation", name="관리 메뉴")).to_be_visible()


def navigate(page: Page, label: str) -> None:
    page.get_by_role("navigation", name="관리 메뉴").get_by_role("button", name=label, exact=True).click()


def state(page: Page) -> dict:
    result = page.evaluate("""async () => {
        const response = await fetch('/api/console');
        return {status: response.status, body: await response.json()};
    }""")
    assert result["status"] == 200
    return result["body"]["state"]


@pytest.mark.parametrize("width", [1450, 390])
def test_http_model_registration_opens_and_persists_demo_connection(page, console_server, width):
    open_http_console(page, console_server, width)
    navigate(page, "모델 서버")
    page.get_by_role("button", name="모델 서버 등록", exact=True).click()
    dialog = page.get_by_role("dialog", name="모델 서버 등록", exact=True)
    expect(dialog).to_be_visible()
    dialog.get_by_label("서버 이름", exact=True).fill("HTTP 생성 회귀 모델")
    dialog.get_by_label("연결 방식").select_option("demo")
    dialog.get_by_label("모델 ID", exact=True).fill("http-demo-model")
    with page.expect_response(lambda response: response.url.endswith("/api/console") and response.request.method == "POST") as pending:
        dialog.get_by_role("button", name="설정 저장", exact=True).click()
    assert pending.value.status == 200
    expect(dialog).to_have_count(0)
    created = next(item for item in state(page)["connections"] if item["name"] == "HTTP 생성 회귀 모델")
    assert created["mode"] == "demo" and created["model"] == "http-demo-model"
    assert created["id"].startswith("conn-")
    page.reload(wait_until="networkidle")
    expect(page.get_by_text("HTTP 생성 회귀 모델", exact=True)).to_be_visible()


@pytest.mark.parametrize("width", [1450, 390])
def test_http_new_policy_opens_and_persists_structured_examples(page, console_server, width):
    open_http_console(page, console_server, width)
    navigate(page, "정책 관리")
    page.get_by_role("button", name="정책 추가", exact=True).click()
    name = page.get_by_label("정책 이름", exact=True)
    expect(name).to_be_visible()
    name.fill("HTTP 생성 회귀 정책")
    with page.expect_response(lambda response: response.url.endswith("/api/console") and response.request.method == "POST") as pending:
        page.get_by_role("button", name="정책 저장", exact=True).click()
    assert pending.value.status == 200
    expect(page.get_by_role("button", name="새 버전 저장", exact=True)).to_be_visible()
    policy = next(item for item in state(page)["policies"] if item["name"] == "HTTP 생성 회귀 정책")
    assert policy["id"].startswith("policy-") and policy["formatVersion"] == 2
    assert len(policy["examples"]) == 3
    assert len({item["id"] for item in policy["examples"]}) == 3


@pytest.mark.parametrize("width", [1450, 390])
def test_http_new_dataset_and_rows_open_and_persist(page, console_server, width):
    open_http_console(page, console_server, width)
    navigate(page, "검증 데이터셋")
    page.get_by_role("button", name="새 데이터셋", exact=True).first.click()
    name = page.get_by_label("데이터셋 이름", exact=True)
    expect(name).to_be_visible()
    name.fill("HTTP 생성 회귀 데이터셋")
    page.get_by_label("1번 항목 요청 내용", exact=True).fill("첫 번째 합성 질문")
    page.get_by_role("button", name="항목 추가", exact=True).click()
    page.get_by_label("2번 항목 요청 내용", exact=True).fill("두 번째 합성 질문")
    with page.expect_response(lambda response: response.url.endswith("/api/console") and response.request.method == "POST") as pending:
        page.get_by_role("button", name="저장", exact=True).click()
    assert pending.value.status == 200
    dataset = next(item for item in state(page)["datasets"] if item["name"] == "HTTP 생성 회귀 데이터셋")
    assert dataset["id"].startswith("ds-")
    assert [item["input"] for item in dataset["rows"]] == ["첫 번째 합성 질문", "두 번째 합성 질문"]
    assert len({item["id"] for item in dataset["rows"]}) == 2


@pytest.mark.parametrize("width", [1450, 390])
def test_http_new_workflow_and_rule_persist(page, console_server, width):
    open_http_console(page, console_server, width)
    navigate(page, "워크플로우")
    page.get_by_role("button", name="새 워크플로우", exact=True).first.click()
    dialog = page.get_by_role("dialog", name="새 워크플로우", exact=True)
    dialog.get_by_label("워크플로우 이름", exact=True).fill("HTTP 생성 회귀 워크플로우")
    with page.expect_response(lambda response: response.url.endswith("/api/console") and response.request.method == "POST") as pending:
        dialog.get_by_role("button", name="만들기", exact=True).click()
    assert pending.value.status == 200
    expect(dialog).to_have_count(0)
    page.locator(".we-commandbar").get_by_role("button", name="노드 추가", exact=True).click()
    page.locator('.we-library-card[data-kind="length"]').click()
    name = page.get_by_label("검사 이름", exact=True)
    expect(name).to_have_value("글자 수 제한")
    name.fill("HTTP 생성 회귀 검사")
    page.locator("#workflow-node-inspector").get_by_role("button", name="설정 패널 닫기", exact=True).click()
    with page.expect_response(lambda response: response.url.endswith("/api/console") and response.request.method == "POST") as pending:
        page.locator(".we-top-actions").get_by_role("button", name="저장", exact=True).click()
    assert pending.value.status == 200
    workflow = next(item for item in state(page)["workflows"] if item["name"] == "HTTP 생성 회귀 워크플로우")
    assert workflow["id"].startswith("wf-") and workflow["alias"].startswith("assistant-")
    rules = [rule for group in workflow["pre"] for rule in group["rules"]]
    assert len(rules) == 1 and rules[0]["kind"] == "length" and rules[0]["name"] == "HTTP 생성 회귀 검사"
    assert rules[0]["id"].startswith("rule-")
    # This also exercises SHA-256 evidence calculation while SubtleCrypto is
    # genuinely unavailable, then lets the server validate the fingerprint.
    page.locator(".we-top-actions").get_by_role("button", name="실행", exact=True).click()
    page.get_by_label("워크플로우 실행 질문", exact=True).fill("배송 기간을 알려주세요.")
    with page.expect_response(lambda response: response.url.endswith("/api/console")
                              and response.request.method == "POST"
                              and response.request.post_data_json.get("action") == "playground") as pending:
        page.get_by_role("button", name="질문 실행", exact=True).click()
    response = pending.value
    assert response.status == 200
    expect(page.locator(".wr-last-result")).to_contain_text("응답 반환")
    fingerprint = response.request.post_data_json["expectedFingerprint"]
    assert len(fingerprint) == 64 and all(value in "0123456789abcdef" for value in fingerprint)
