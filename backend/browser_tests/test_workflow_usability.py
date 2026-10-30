"""Stable workspace and schema-assisted routing against isolated demo data."""
from __future__ import annotations

import json

import pytest
from playwright.sync_api import expect

from test_switch_branching import (WORKFLOW_ID, choose_node, close_panel, enter,
                                   open_editor, save_editor, seed_workflow)


def seed_enum_policy(page):
    seed_workflow(page)
    result = page.evaluate("""async () => {
      const state=(await(await fetch('/api/console')).json()).state;
      const workflow=state.workflows.find(item=>item.id==='wf-switch-browser');
      const policy=state.policies.find(item=>item.id==='policy-switch-browser');
      const send=async payload=>{const response=await fetch('/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});return {status:response.status,body:await response.json()};};
      policy.outputSchema={type:'object',properties:{risk:{type:'object',properties:{level:{type:'string',enum:['low','medium','high'],title:'위험 수준'}},required:['level'],additionalProperties:false}},required:['risk'],additionalProperties:false};
      policy.examples=['low','medium','high'].map((level,index)=>({id:'enum-'+index,input:['일반 문의','확인할 문의','위험 문의'][index],expectedOutput:{risk:{level}}}));
      const expectedVersion=policy.version;delete policy.version;delete policy.updatedAt;delete policy.connectionSnapshot;
      const saved=await send({action:'save_policy',policy,expectedVersion});
      if(saved.status!==200)return saved;
      workflow.policyRouting.policy=saved.body.policy;
      return send({action:'save_workflow',workflow,expectedUpdatedAt:workflow.updatedAt});
    }""")
    assert result['status'] == 200, result['body']


def workspace_view(page):
    return page.evaluate("""() => {
      const canvas=document.querySelector('.wc-viewport'), box=canvas.getBoundingClientRect();
      return {width:box.width,height:box.height,left:canvas.scrollLeft,top:canvas.scrollTop,
        transform:document.querySelector('.wc-plane').style.transform};
    }""")


@pytest.mark.parametrize('width', [1450, 390])
def test_canvas_does_not_resize_or_refit_when_panels_and_results_toggle(page, console_server, width):
    page.set_viewport_size({'width': width, 'height': 1000})
    enter(page, console_server)
    seed_workflow(page, complete_switch=True)
    open_editor(page, console_server, 'fixture-switch')
    close_panel(page)
    page.get_by_role('button', name='전체 보기', exact=True).click()
    page.wait_for_timeout(180)
    baseline=workspace_view(page)
    for _ in range(2):
        page.locator('.we-run-dock-toggle').click()
        expect(page.locator('.we-run-dock-body')).to_be_visible()
        assert workspace_view(page)==baseline
        page.locator('.we-run-dock-toggle').click()
        assert workspace_view(page)==baseline
    page.get_by_role('button', name='기본 설정', exact=True).click()
    assert workspace_view(page)==baseline
    close_panel(page)
    page.get_by_role('button', name='100% 보기', exact=True).click()
    expect(page.locator('.wc-plane')).to_have_css('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    page.get_by_role('button', name='이전 화면으로 복귀', exact=True).click()
    page.wait_for_timeout(100)
    assert workspace_view(page)==baseline
    page.get_by_role('button', name='100% 보기', exact=True).click()
    page.get_by_role('button', name='JSON', exact=True).click()
    page.get_by_role('button', name='편집', exact=True).click()
    expect(page.locator('.wc-plane')).to_have_css('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')


def test_switch_field_creates_typed_enum_cases_and_keeps_saved_routes(page, console_server, browser_artifact_dir):
    enter(page, console_server)
    seed_enum_policy(page)
    open_editor(page, console_server)
    close_panel(page)
    page.locator('.we-commandbar').get_by_role('button', name='노드 추가', exact=True).click()
    page.get_by_role('button', name='Switch 분기 노드 추가', exact=True).click()
    picker=page.get_by_label('Switch 필드 경로', exact=True)
    picker.fill('/risk/level')
    picker.press('Enter')
    expect(page.locator('[data-policy-switch-case]')).to_have_count(3)
    switch_id=page.locator('.policy-graph-editor').get_attribute('data-policy-node-id')
    case_ids=page.locator('[data-policy-switch-case]').evaluate_all('(rows)=>rows.map(row=>row.dataset.policySwitchCase)')
    for case_id in case_ids:
        page.get_by_label(f'Switch {case_id} 연결', exact=True).select_option('fixture-respond')
    page.get_by_label('Switch default 연결', exact=True).select_option('fixture-error')
    expect(page.locator('.policy-switch-default')).not_to_have_attribute('open', '')
    page.screenshot(path=str(browser_artifact_dir/'switch-settings.png'))
    choose_node(page, '첫 조건')
    page.get_by_label('정책 true 연결', exact=True).select_option(switch_id)
    saved=save_editor(page)
    graph=saved['policyRouting']['graph']
    switch=next(node for node in graph['nodes'] if node['id']==switch_id)
    assert [item['value'] for item in switch['cases']]==['low','medium','high']
    edges=[edge for edge in graph['edges'] if edge['from']==switch_id]
    open_editor(page, console_server, switch_id)
    page.get_by_role('button', name='스키마와 예제에서 비교값 가져오기', exact=True).click()
    page.get_by_role('button', name='선택한 비교값 적용', exact=True).click()
    saved=save_editor(page)
    assert [edge for edge in saved['policyRouting']['graph']['edges'] if edge['from']==switch_id]==edges


def test_execution_badge_opens_safe_node_input_output_and_selected_switch_port(page, console_server):
    enter(page, console_server)
    seed_workflow(page, complete_switch=True)
    open_editor(page, console_server, 'fixture-switch')
    close_panel(page)
    page.locator('.we-top-actions').get_by_role('button', name='실행', exact=True).click()
    page.get_by_label('워크플로우 실행 질문', exact=True).fill('공백 문자열')
    with page.expect_response(lambda response: response.url.endswith('/api/console') and response.request.method=='POST'
                              and response.request.post_data_json.get('action')=='playground') as pending:
        page.get_by_role('button', name='질문 실행', exact=True).click()
    pending.value.finished()
    events=[json.loads(line) for line in pending.value.text().splitlines() if line.strip()]
    message=next(event for event in events if event['type']=='result')
    assert message['result']['status']=='allow'
    assert message['inspection']['nodes']
    # Close the execution overlay before selecting an execution badge.
    page.locator('.we-run-dock-toggle').click()
    page.get_by_role('button', name='전체 보기', exact=True).click()
    page.get_by_role('button', name='자료형 Switch 실행 내역', exact=True).click()
    expect(page.get_by_role('tab', name='실행 내역', exact=False)).to_have_attribute('aria-selected','true')
    details=page.locator('.we-node-inspection')
    expect(details).to_contain_text('선택 경로:')
    expect(details).to_contain_text('비공개')
    expect(details.locator('pre')).to_have_count(0)
    page.get_by_role('tab', name='설정', exact=True).click()
    expect(page.get_by_label('Switch 필드 경로', exact=True)).to_be_visible()
    close_panel(page)
    page.get_by_role('button', name='최종 출력 실행 내역', exact=True).click()
    expect(page.locator('.we-node-inspection')).to_contain_text('선택된 경로 0')
    choose_node(page, '자료형 Switch')
    page.get_by_role('tab', name='실행 내역', exact=False).click()
    page.get_by_role('button', name='노드 삭제', exact=True).click()
    expect(page.locator('[data-layout-key="policy-node:fixture-switch"]')).to_have_count(0)
    page.get_by_role('button', name='실행 취소', exact=True).click()
    expect(page.locator('[data-layout-key="policy-node:fixture-switch"]')).to_have_count(1)


def test_blocked_post_response_is_withheld_from_the_node_panel(page, console_server):
    enter(page, console_server)
    seed_workflow(page, complete_switch=True)
    status=page.evaluate("""async () => {
      const state=(await(await fetch('/api/console')).json()).state;
      const workflow=state.workflows.find(item=>item.id==='wf-switch-browser');
      workflow.post=[{id:'private-post-group',name:'응답 검사',mode:'any',rules:[{id:'private-post',name:'비공개 응답 검사',kind:'keyword',enabled:true,description:'',config:{pattern:'선택된 경로'}}]}];
      return (await fetch('/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_workflow',workflow,expectedUpdatedAt:workflow.updatedAt})})).status;
    }""")
    assert status==200
    open_editor(page, console_server, 'fixture-switch')
    close_panel(page)
    page.locator('.we-top-actions').get_by_role('button', name='실행', exact=True).click()
    page.get_by_label('워크플로우 실행 질문', exact=True).fill('공백 문자열')
    with page.expect_response(lambda response: response.url.endswith('/api/console') and response.request.method=='POST'
                              and response.request.post_data_json.get('action')=='playground') as pending:
        page.get_by_role('button', name='질문 실행', exact=True).click()
    pending.value.finished()
    payload=pending.value.text()
    message=next(json.loads(line) for line in payload.splitlines() if json.loads(line)['type']=='result')
    assert message['result']['status']=='block'
    assert message['result']['output']==''
    assert '선택된 경로 0' not in json.dumps(message,ensure_ascii=False)
    page.locator('.we-run-dock-toggle').click()
    page.get_by_role('button', name='전체 보기', exact=True).click()
    page.get_by_role('button', name='비공개 응답 검사 실행 내역', exact=True).click()
    panel=page.locator('.we-node-inspection')
    expect(panel.get_by_label('노드 입력', exact=True)).to_contain_text('비공개')
    expect(panel.locator('pre')).to_have_count(0)
