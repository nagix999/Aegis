"""Usable canvas space and reversible focus mode on isolated demo consoles."""
from __future__ import annotations

import json

import pytest
from playwright.sync_api import expect

from test_switch_branching import close_panel, enter, open_editor, seed_workflow


VIEWPORTS = [(1450, 900), (390, 844)]


def workspace_geometry(page):
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    return page.evaluate("""() => {
      const rect=selector=>{const value=document.querySelector(selector).getBoundingClientRect();
        return {x:value.x,y:value.y,width:value.width,height:value.height,bottom:value.bottom,right:value.right};};
      const canvas=document.querySelector('.wc-viewport');
      return {editor:rect('.we-editor'),canvas:rect('.wc-viewport'),bottom:rect('.wc-bottom'),
        transform:document.querySelector('.wc-plane').style.transform,
        scroll:{left:canvas.scrollLeft,top:canvas.scrollTop},
        viewport:{width:innerWidth,height:innerHeight}};
    }""")


def expect_usable_canvas(page, *, mobile):
    geometry = workspace_geometry(page)
    canvas, bottom = geometry['canvas'], geometry['bottom']
    # Check the canvas itself, not a nominal parent height below the fold.
    assert canvas['height'] >= (300 if mobile else 490), geometry
    assert canvas['width'] >= (350 if mobile else 1100), geometry
    assert canvas['y'] >= 0 and canvas['bottom'] <= geometry['viewport']['height'], geometry
    assert bottom['bottom'] <= geometry['viewport']['height'], geometry
    expect(page.locator('.wc-bottom')).to_be_in_viewport(ratio=1)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    return geometry


def expect_same_canvas(page, baseline):
    geometry = workspace_geometry(page)
    assert geometry['canvas'] == baseline['canvas'], geometry
    assert geometry['bottom'] == baseline['bottom'], geometry
    assert geometry['transform'] == baseline['transform'], geometry
    assert geometry['scroll'] == baseline['scroll'], geometry


@pytest.mark.parametrize('width,height', VIEWPORTS)
def test_wide_workspace_restores_draft_zoom_and_page_scroll(page, console_server, width, height, browser_artifact_dir):
    page.set_viewport_size({'width': width, 'height': height})
    enter(page, console_server)
    seed_workflow(page, complete_switch=True)
    open_editor(page, console_server, 'fixture-switch')
    page.get_by_label('정책 노드 이름', exact=True).fill('화면을 바꿔도 남는 초안')
    close_panel(page)
    expect(page.locator('.workspace-save-state')).not_to_have_attribute('open', '')
    page.get_by_role('button', name='100% 보기', exact=True).click()
    page.get_by_role('button', name='워크플로우 축소', exact=True).click()
    baseline = expect_usable_canvas(page, mobile=width < 700)
    page.screenshot(path=str(browser_artifact_dir / 'workspace-normal.png'))
    initial_overflow = page.evaluate('({body:document.body.style.overflow,html:document.documentElement.style.overflow})')
    expand = page.get_by_role('button', name='워크플로우 화면 넓게', exact=True)
    expand.click()
    expanded_editor = page.locator('.we-editor.is-expanded')
    expect(expanded_editor).to_be_visible()
    expanded = expect_usable_canvas(page, mobile=width < 700)
    page.screenshot(path=str(browser_artifact_dir / 'workspace-expanded.png'))
    assert expanded['editor'] == {'x': 0, 'y': 0, 'width': width, 'height': height, 'bottom': height, 'right': width}, expanded
    assert expanded['canvas']['width'] >= baseline['canvas']['width'] + (10 if width < 700 else 150), expanded
    assert expanded['canvas']['height'] >= baseline['canvas']['height'] + 70, expanded
    assert expanded['transform'] == baseline['transform'], expanded
    assert page.evaluate("document.body.style.overflow==='hidden'||document.documentElement.style.overflow==='hidden'")
    expect(page.locator('.we-dirty')).to_contain_text('저장되지 않음')
    page.locator('.we-panel-toggle').click()
    expect(page.get_by_label('정책 노드 이름', exact=True)).to_have_value('화면을 바꿔도 남는 초안')
    close_panel(page)
    page.get_by_role('button', name='워크플로우 화면 복원', exact=True).click()
    expect(expanded_editor).to_have_count(0)
    assert page.evaluate('({body:document.body.style.overflow,html:document.documentElement.style.overflow})') == initial_overflow
    expect_same_canvas(page, baseline)
    expand.click()
    page.get_by_role('button', name='워크플로우 화면 복원', exact=True).press('Escape')
    expect(expanded_editor).to_have_count(0)
    expect_same_canvas(page, baseline)
    assert page.evaluate('({body:document.body.style.overflow,html:document.documentElement.style.overflow})') == initial_overflow
    expect(page.get_by_role('button', name='워크플로우 목록', exact=True)).to_be_in_viewport()
    page.get_by_role('button', name='워크플로우 목록', exact=True).click()
    expect(page.locator('.we-editor')).to_have_count(0)
    expect(page.get_by_role('navigation', name='관리 메뉴')).to_be_visible()
    assert page.evaluate('({body:document.body.style.overflow,html:document.documentElement.style.overflow})') == initial_overflow
    (browser_artifact_dir / 'workspace-size.json').write_text(json.dumps({'normal':baseline,'expanded':expanded}, ensure_ascii=False), encoding='utf-8')


@pytest.mark.parametrize('width,height', VIEWPORTS)
def test_settings_and_real_execution_results_keep_wide_canvas_size(page, console_server, width, height):
    page.set_viewport_size({'width': width, 'height': height})
    enter(page, console_server)
    seed_workflow(page, complete_switch=True)
    open_editor(page, console_server, 'fixture-switch')
    close_panel(page)
    page.get_by_role('button', name='워크플로우 화면 넓게', exact=True).click()
    page.get_by_role('button', name='전체 보기', exact=True).click()
    baseline = expect_usable_canvas(page, mobile=width < 700)
    page.get_by_role('button', name='워크플로우 설정', exact=True).click()
    expect(page.locator('#workflow-node-inspector')).to_be_visible()
    expect_same_canvas(page, baseline)
    close_panel(page)
    page.locator('.we-top-actions').get_by_role('button', name='실행', exact=True).click()
    expect(page.locator('.we-run-dock-body')).to_be_visible()
    expect_same_canvas(page, baseline)
    page.get_by_label('워크플로우 실행 질문', exact=True).fill('공백 문자열')
    with page.expect_response(lambda response: response.url.endswith('/api/console')
                              and response.request.method == 'POST'
                              and response.request.post_data_json.get('action') == 'playground') as pending:
        page.get_by_role('button', name='질문 실행', exact=True).click()
    response = pending.value
    assert response.status == 200
    expect(page.locator('.wr-last-result')).to_be_visible()
    expect(page.locator('.wr-last-result')).to_contain_text('선택된 경로 0')
    expect_same_canvas(page, baseline)
    page.locator('.we-run-dock-toggle').click()
    expect(page.locator('.we-run-dock-body')).to_have_count(0)
    expect_same_canvas(page, baseline)
    page.locator('.we-run-dock-toggle').click()
    expect(page.locator('.we-run-dock-body')).to_be_visible()
    expect_same_canvas(page, baseline)
    page.locator('.we-run-dock-toggle').click()
    # Navigating from the expanded editor must also release the body scroll lock.
    page.locator('.we-top-actions').get_by_role('button', name='검증 화면', exact=True).click()
    expect(page.locator('.we-editor')).to_have_count(0)
    expect(page.get_by_role('navigation', name='관리 메뉴')).to_be_visible()
    assert page.evaluate("document.body.style.overflow!=='hidden'&&document.documentElement.style.overflow!=='hidden'")
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
