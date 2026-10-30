"""Stable workspace and schema-assisted routing against isolated demo data."""
from __future__ import annotations

import json

import pytest
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, expect

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


def close_from_canvas_background(page):
    """Use exposed canvas space, or its dismissing backdrop on narrow screens."""
    point = page.evaluate("""() => {
      const canvas=document.querySelector('.wc-viewport'), box=canvas.getBoundingClientRect();
      const backdrop=document.querySelector('.we-panel-backdrop');
      const bottom=Math.min(box.bottom-8,window.innerHeight-8);
      for(const y of [box.top+20,(box.top+bottom)/2,bottom]) {
        for(const x of [box.left+5,box.left+20,box.left+box.width*.2,box.left+box.width*.4]) {
          const target=document.elementFromPoint(x,y);
          if(target===backdrop || (canvas.contains(target) && !target.closest('button,a,input,select,textarea,[role="button"],[data-layout-key],[data-edge-id],[data-connect-port]')))
            return {x,y};
        }
      }
      return null;
    }""")
    assert point, 'The open inspector must leave a canvas or backdrop dismissal target.'
    page.mouse.click(point['x'], point['y'])
    expect(page.locator('#workflow-node-inspector')).to_have_count(0)


def activate_policy_edge(page, edge_id):
    """Click a genuinely exposed stroke; coincident paths must not pass via keys."""
    edge = page.locator(f'g[data-policy-edge-id="{edge_id}"] path.wc-edge-hit')
    # getPointAtLength is in SVG coordinates; the screen matrix includes the
    # existing canvas zoom and scroll. Never refit or force a covered click.
    probe = """edgeId => {
      const path=document.querySelector(`g[data-policy-edge-id="${edgeId}"] path.wc-edge-hit`);
      if(!path)return {edgeId,missing:true};
      const matrix=path.getScreenCTM(),length=path.getTotalLength();
      if(!matrix||!length)return {edgeId,matrix:!!matrix,length};
      const samples=[];
      const fractions=[.5,.4,.6,.3,.7,.2,.8,.1,.9,.05,.95,
        ...Array.from({length:99},(_,index)=>(index+1)/100)];
      for(const fraction of fractions) {
        const local=path.getPointAtLength(length*fraction);
        const point=new DOMPoint(local.x,local.y).matrixTransform(matrix);
        const hit=document.elementFromPoint(point.x,point.y);
        if(samples.length<11)samples.push({fraction,x:point.x,y:point.y,tag:hit?.tagName,
          class:hit?.getAttribute('class'),edge:hit?.closest('[data-policy-edge-id]')?.getAttribute('data-policy-edge-id')});
        if(hit===path)return {point:{x:point.x,y:point.y}};
      }
      const canvas=document.querySelector('.wc-viewport'),box=canvas.getBoundingClientRect();
      return {edgeId,length,path:path.getAttribute('d'),strokeWidth:getComputedStyle(path).strokeWidth,
        viewport:{width:innerWidth,height:innerHeight},canvas:{x:box.x,y:box.y,width:box.width,height:box.height,
        scrollLeft:canvas.scrollLeft,scrollTop:canvas.scrollTop},samples};
    }"""
    try:
        handle = page.wait_for_function(f"edgeId => ({{probe:({probe})(edgeId)}}).probe.point", arg=edge_id, timeout=5000)
    except PlaywrightTimeoutError as error:
        diagnostic = page.evaluate(probe, edge_id)
        raise AssertionError(f'No exposed mouse target for policy edge {edge_id}: '
                             + json.dumps(diagnostic, ensure_ascii=False)) from error
    point = handle.json_value()
    handle.dispose()
    page.mouse.click(point['x'], point['y'])
    expect(edge).to_have_attribute('aria-pressed', 'true')


def expect_selected_route_in_panel(page, edge_id):
    selected = page.locator(f'[data-policy-selected-edge="{edge_id}"]')
    expect(selected).to_have_count(1)
    expect(selected).to_have_attribute('aria-current', 'true')
    expect(page.locator('.policy-switch-route-selected')).to_have_count(1)
    # The selected card can be taller than the panel. Its heading must appear
    # in the intersection of the panel and the actual browser viewport.
    page.wait_for_function("""edgeId => {
      const card=document.querySelector(`[data-policy-selected-edge="${edgeId}"]`);
      const scroll=card?.closest('.we-inspector-scroll');
      if(!card||!scroll)return false;
      const box=card.getBoundingClientRect(),viewport=scroll.getBoundingClientRect();
      return box.top>=Math.max(viewport.top,0)&&box.top<Math.min(viewport.bottom,innerHeight)-20;
    }""", arg=edge_id)


def seed_shared_enum_switch(page):
    seed_enum_policy(page)
    result = page.evaluate("""async () => {
      const state=(await(await fetch('/api/console')).json()).state;
      const workflow=state.workflows.find(item=>item.id==='wf-switch-browser');
      const previous=workflow.policyRouting.graph;
      workflow.policyRouting.graph={version:1,entryNodeId:'fixture-switch',nodes:[
        {id:'fixture-switch',name:'공유 대상 Switch',kind:'switch',path:'/risk/level',cases:[
          {id:'case-1',value:'low'},{id:'case-2',value:'medium'},{id:'case-3',value:'high'}]},
        ...previous.nodes.filter(node=>node.kind==='action')],edges:[
          {id:'shared-edge-1',from:'fixture-switch',to:'fixture-respond',port:'case-1'},
          {id:'shared-edge-2',from:'fixture-switch',to:'fixture-respond',port:'case-2'},
          {id:'shared-edge-3',from:'fixture-switch',to:'fixture-error',port:'case-3'},
          {id:'shared-default',from:'fixture-switch',to:'fixture-error',port:'default'}]};
      const response=await fetch('/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_workflow',workflow,expectedUpdatedAt:workflow.updatedAt})});
      return {status:response.status,body:await response.json()};
    }""")
    assert result['status'] == 200, result['body']


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
    page.get_by_role('button', name='워크플로우 설정', exact=True).click()
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


@pytest.mark.parametrize('width', [1450, 390])
def test_canvas_background_preserves_draft_and_header_pin_survives_undo_save_and_layout(page, console_server, width):
    page.set_viewport_size({'width': width, 'height': 1000})
    enter(page, console_server)
    seed_workflow(page, complete_switch=True)
    open_editor(page, console_server, 'fixture-switch')
    panel = page.locator('#workflow-node-inspector')
    node = page.locator('button[data-layout-key="policy-node:fixture-switch"]')
    name = page.get_by_label('정책 노드 이름', exact=True)
    name.fill('저장 전 Switch 이름')
    baseline = workspace_view(page)
    close_from_canvas_background(page)
    assert workspace_view(page) == baseline
    expect(page.locator('.we-top-actions').get_by_role('button', name='저장', exact=True)).to_be_enabled()
    node.press('Enter')
    expect(name).to_have_value('저장 전 Switch 이름')
    close_panel(page)
    original_position = node.evaluate('(element)=>({left:element.style.left,top:element.style.top})')
    # Move away from the automatic position so retaining a pin has a real effect.
    node.press('Shift+ArrowDown')
    moved_position = node.evaluate('(element)=>({left:element.style.left,top:element.style.top})')
    assert moved_position != original_position
    node.press('Enter')
    panel.locator('.we-inspector-scroll').evaluate('(element)=>element.scrollTop=element.scrollHeight')
    pin = panel.locator('.we-inspector-head').get_by_role('button', name='자동 정렬에서 위치 고정', exact=True)
    expect(pin).to_be_in_viewport()
    expect(pin).to_have_attribute('aria-pressed', 'false')
    expect(pin.locator('svg')).to_have_count(1)
    assert pin.inner_text() == ''
    expect(panel.locator('.we-inspector-head').get_by_role('button', name='노드 삭제', exact=True)).to_be_in_viewport()
    expect(panel.get_by_text('배치 설정', exact=True)).to_have_count(0)
    pin.click()
    expect(node).to_have_attribute('data-pinned', 'true')
    expect(panel.get_by_role('button', name='자동 정렬 위치 고정 해제', exact=True)).to_have_attribute('aria-pressed', 'true')
    close_panel(page)
    page.get_by_role('button', name='실행 취소', exact=True).click()
    expect(node).not_to_have_attribute('data-pinned', 'true')
    page.get_by_role('button', name='다시 실행', exact=True).click()
    expect(node).to_have_attribute('data-pinned', 'true')
    saved = save_editor(page)
    assert 'policy-node:fixture-switch' in saved['layout']['pinnedKeys']
    assert next(item for item in saved['policyRouting']['graph']['nodes']
                if item['id'] == 'fixture-switch')['name'] == '저장 전 Switch 이름'
    open_editor(page, console_server, 'fixture-switch')
    expect(page.get_by_label('정책 노드 이름', exact=True)).to_have_value('저장 전 Switch 이름')
    expect(panel.get_by_role('button', name='자동 정렬 위치 고정 해제', exact=True)).to_have_attribute('aria-pressed', 'true')
    close_panel(page)
    persisted_position = node.evaluate('(element)=>({left:element.style.left,top:element.style.top})')
    assert persisted_position == moved_position
    page.get_by_role('button', name='자동 정렬', exact=True).click()
    assert node.evaluate('(element)=>({left:element.style.left,top:element.style.top})') == persisted_position
    expect(node).to_have_attribute('data-pinned', 'true')
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')


@pytest.mark.parametrize('width', [1450, 390])
def test_same_target_switch_edges_select_exact_case_and_reveal_folded_default(page, console_server, width, browser_artifact_dir):
    page.set_viewport_size({'width': width, 'height': 1000})
    enter(page, console_server)
    seed_shared_enum_switch(page)
    open_editor(page, console_server, 'fixture-switch')
    header = page.evaluate("""async () => {
      const state=(await(await fetch('/api/console')).json()).state;
      const workflow=state.workflows.find(item=>item.id==='wf-switch-browser');
      const pin=document.querySelector('.we-inspector-head .we-position-pin'),box=pin?.getBoundingClientRect();
      return {formatVersion:workflow.policyRouting.policy.formatVersion,
        pinCount:document.querySelectorAll('.we-inspector-head .we-position-pin').length,
        display:pin?getComputedStyle(pin).display:null,
        box:box?{x:box.x,y:box.y,width:box.width,height:box.height}:null};
    }""")
    (browser_artifact_dir/'shared-switch-header.json').write_text(json.dumps(header), encoding='utf-8')
    assert header['formatVersion'] == 2 and header['pinCount'] == 1, header
    expect(page.locator('.policy-switch-default')).not_to_have_attribute('open', '')
    close_panel(page)
    page.get_by_role('button', name='전체 보기', exact=True).click()
    page.wait_for_timeout(180)
    expect(page.get_by_label('공유 대상 Switch 출력 경로 선택', exact=True)).to_have_count(0)
    expect(page.locator('[data-policy-connect-port^="fixture-switch:"]')).to_have_count(0)
    for edge_id, port in [('shared-edge-1', 'case-1'), ('shared-edge-2', 'case-2'),
                          ('shared-edge-3', 'case-3'), ('shared-default', 'default')]:
        baseline = workspace_view(page)
        activate_policy_edge(page, edge_id)
        expect_selected_route_in_panel(page, edge_id)
        expect(page.locator(f'[data-policy-route-port="{port}"]')).to_have_attribute('data-policy-selected-edge', edge_id)
        expect(page.locator('g[data-policy-edge-id].selected')).to_have_count(1)
        expect(page.locator('g[data-policy-edge-id] path.wc-edge-hit[aria-pressed="true"]')).to_have_count(1)
        assert workspace_view(page) == baseline
        if port == 'default':
            expect(page.locator('.policy-switch-default')).to_have_attribute('open', '')
            expect(page.get_by_label('Switch default 연결', exact=True)).to_have_value('fixture-error')
        else:
            target = 'fixture-respond' if port in ['case-1', 'case-2'] else 'fixture-error'
            expect(page.get_by_label(f'Switch {port} 연결', exact=True)).to_have_value(target)
        if port == 'case-2':
            page.screenshot(path=str(browser_artifact_dir/'selected-switch-case.png'))
        close_panel(page)
    # Returning to the same edge is a new navigation request even if its ID did
    # not change. Scroll it out of view, dismiss, and activate it again.
    activate_policy_edge(page, 'shared-default')
    expect_selected_route_in_panel(page, 'shared-default')
    page.locator('.we-inspector-scroll').evaluate('(element)=>element.scrollTop=0')
    page.wait_for_function("""() => {
      const card=document.querySelector('.policy-switch-default'),scroll=card.closest('.we-inspector-scroll');
      return card.getBoundingClientRect().top>=scroll.getBoundingClientRect().bottom;
    }""")
    close_panel(page)
    activate_policy_edge(page, 'shared-default')
    expect_selected_route_in_panel(page, 'shared-default')
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


def test_execution_badge_opens_admin_json_and_selected_switch_port(page, console_server):
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
    expect(details.get_by_label('노드 입력 JSON',exact=True)).to_contain_text('risk')
    expect(details.get_by_label('노드 출력 JSON',exact=True)).to_contain_text('selectedPort')
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


def test_blocked_post_response_is_visible_only_in_admin_node_details(page, console_server):
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
    assert '선택된 경로 0' not in json.dumps(message['result'],ensure_ascii=False)
    assert '선택된 경로 0' in json.dumps(message['inspection'],ensure_ascii=False)
    page.locator('.we-run-dock-toggle').click()
    page.get_by_role('button', name='전체 보기', exact=True).click()
    page.get_by_role('button', name='비공개 응답 검사 실행 내역', exact=True).click()
    panel=page.locator('.we-node-inspection')
    expect(panel.get_by_label('노드 입력 JSON', exact=True)).to_contain_text('선택된 경로 0')
    expect(panel.get_by_label('노드 출력 JSON', exact=True)).to_contain_text('block')
