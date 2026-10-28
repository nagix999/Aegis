"""Bookmarks and cross-page usability, on owned servers with synthetic data only."""
from __future__ import annotations

import json
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect

from test_console_auth import login, open_login


def enter(page, server):
    open_login(page, server)
    assert login(page, server).status == 200
    expect(page.locator('.wf-list-name').first).to_be_visible()


def menu(page, name):
    page.get_by_role('navigation', name='관리 메뉴').get_by_role('button', name=name, exact=True).click()


def test_internal_back_forward_reload_and_workflow_bookmark(page, console_server):
    enter(page, console_server)
    page.locator('.wf-list-name').first.click()
    expect(page).to_have_url(__import__('re').compile(r'workflowId='))
    workflow_url = page.url
    menu(page, '대시보드')
    expect(page.get_by_role('heading', name='대시보드', exact=True)).to_be_visible()
    menu(page, '정책 관리')
    expect(page).to_have_url(__import__('re').compile(r'page=policies'))
    page.go_back()
    expect(page.get_by_role('heading', name='대시보드', exact=True)).to_be_visible()
    page.go_back()
    expect(page.locator('.we-top-actions')).to_be_visible()
    assert parse_qs(urlparse(page.url).query)['workflowId'] == parse_qs(urlparse(workflow_url).query)['workflowId']
    page.reload(wait_until='networkidle')
    expect(page.locator('.we-top-actions')).to_be_visible()
    page.go_forward()
    expect(page.get_by_role('heading', name='대시보드', exact=True)).to_be_visible()


def test_access_unsaved_input_survives_menu_and_failed_save(page, console_server):
    enter(page, console_server)
    menu(page, '접근 설정')
    field = page.get_by_label('허용 서버 주소 (HTTPS)', exact=False)
    field.fill('https://synthetic-review.example')
    menu(page, '모델 서버')
    menu(page, '접근 설정')
    expect(field).to_have_value('https://synthetic-review.example')

    def failed_save(route):
        if route.request.method == 'POST':
            route.fulfill(status=503, content_type='application/json', body=json.dumps({'error':{'message':'합성 저장 실패'}}))
        else:
            route.continue_()

    page.route('**/api/console', failed_save)
    page.get_by_role('button', name='설정 저장', exact=True).click()
    expect(page.get_by_text('관리 서버 연결 확인 필요', exact=True)).to_be_visible()
    expect(field).to_have_value('https://synthetic-review.example')
    expect(page.get_by_text('저장하지 않은 변경', exact=True)).to_be_visible()
    page.unroute('**/api/console', failed_save)
    page.get_by_role('button', name='다시 확인', exact=True).click()
    expect(page.get_by_text('관리 서버 연결됨', exact=True)).to_be_visible()
    expect(field).to_have_value('https://synthetic-review.example')
    page.get_by_role('button', name='변경 취소', exact=True).click()
    expect(field).to_have_value('')


def test_dashboard_value_opens_exact_filtered_logs_and_back_keeps_tab(page, console_server):
    enter(page, console_server)
    menu(page, '대시보드')
    page.get_by_role('button', name='24시간', exact=True).click()
    page.locator('#dashboard-default-errors .dashboard-value-link').click()
    expect(page.get_by_role('heading', name='요청 기록', exact=True)).to_be_visible()
    params = parse_qs(urlparse(page.url).query)
    assert params['page'] == ['logs'] and params['status'] == ['error'] and params['source'] == ['gateway']
    assert 'T' in params['from'][0] and 'T' in params['to'][0]
    from datetime import datetime
    assert (datetime.fromisoformat(params['to'][0].replace('Z','+00:00')) - datetime.fromisoformat(params['from'][0].replace('Z','+00:00'))).total_seconds() == 86400
    expect(page.get_by_text('대시보드에서 선택한 정확한 기간', exact=False)).to_be_visible()
    page.reload(wait_until='networkidle')
    expect(page.get_by_role('heading', name='요청 기록', exact=True)).to_be_visible()
    expect(page.get_by_text('대시보드에서 선택한 정확한 기간', exact=False)).to_be_visible()
    page.go_back()
    expect(page.get_by_role('heading', name='대시보드', exact=True)).to_be_visible()
    expect(page.get_by_role('button', name='24시간', exact=True)).to_have_attribute('aria-pressed','true')


def test_dashboard_templates_duplicate_and_reviewed_config_import(page, console_server, tmp_path):
    enter(page, console_server)
    menu(page, '대시보드')
    page.get_by_label('대시보드 시작 틀', exact=True).select_option('blocks')
    expect(page.get_by_role('tab', name='차단 분석', exact=True)).to_have_attribute('aria-selected','true')
    page.get_by_role('button', name='대시보드 탭 복제', exact=True).click()
    expect(page.get_by_role('tab', name='차단 분석 복사', exact=True)).to_have_attribute('aria-selected','true')
    with page.expect_download() as pending:
        page.get_by_role('button', name='구성 내보내기', exact=True).click()
    path = tmp_path/'dashboard.json'
    pending.value.save_as(path)
    exported = json.loads(path.read_text())
    assert exported['version'] == 2 and len(exported['tabs']) == 3
    assert all(set(tab) == {'id','name','layout','filters'} for tab in exported['tabs'])
    exported['tabs'][-1]['name'] = '검토 후 가져온 탭'
    path.write_text(json.dumps(exported))
    page.get_by_label('대시보드 구성 파일', exact=True).set_input_files(path)
    dialog = page.get_by_role('dialog', name='대시보드 구성 가져오기 확인', exact=True)
    expect(dialog).to_be_visible()
    expect(page.get_by_role('tab', name='검토 후 가져온 탭', exact=True)).to_have_count(0)
    dialog.get_by_role('button', name='구성 교체', exact=True).click()
    expect(page.get_by_role('tab', name='검토 후 가져온 탭', exact=True)).to_have_attribute('aria-selected','true')
