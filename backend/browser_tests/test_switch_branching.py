"""Switch authoring and exact-value routing on isolated authenticated consoles."""
from __future__ import annotations

import json

import pytest
from playwright.sync_api import expect


WORKFLOW_ID = 'wf-switch-browser'


def enter(page, server):
    page.goto(server.base_url, wait_until='networkidle')
    page.get_by_label('관리자 계정', exact=True).fill(server.username)
    page.get_by_label('비밀번호', exact=True).fill(server.password)
    page.get_by_role('button', name='로그인', exact=True).click()
    expect(page.get_by_role('navigation', name='관리 메뉴')).to_be_visible()


def seed_workflow(page, *, complete_switch=False):
    """Only the fixture's authenticated API and synthetic demo model are used."""
    result = page.evaluate('''async completeSwitch => {
      const state = (await (await fetch('/api/console')).json()).state;
      const guard = state.connections.find(item => ['guard','both'].includes(item.role));
      const main = state.connections.find(item => ['main','both'].includes(item.role));
      const schema = {type:'object',properties:{risk:{type:'object',properties:{level:{type:['string','number','boolean','null','object','array']}},additionalProperties:false}},required:['risk'],additionalProperties:false};
      const values = [' ALLOW ',1,true,null];
      const examples = values.map((value,index)=>({id:'sample-'+index,input:['공백 문자열','숫자','불리언','널'][index],expectedOutput:{risk:{level:value}}}));
      examples.push({id:'sample-untrimmed',input:'같은 문자열',expectedOutput:{risk:{level:'ALLOW'}}},
        {id:'sample-missing',input:'누락',expectedOutput:{risk:{}}},
        {id:'sample-object',input:'객체',expectedOutput:{risk:{level:{}}}});
      const policy = {id:'policy-switch-browser',name:'Switch 브라우저 정책',description:'합성 예제',formatVersion:2,prompt:'예제의 risk.level 값을 구조화하세요.',connectionId:guard.id,decisions:[],examples,outputSchema:schema,maxOutputTokens:1024};
      const send = async payload => {
        const response = await fetch('/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        return {status:response.status,body:await response.json()};
      };
      const savedPolicy = await send({action:'save_policy',policy,expectedVersion:0});
      if(savedPolicy.status!==200)return savedPolicy;
      const respond = {id:'fixture-respond',name:'일치 안내',kind:'action',action:'respond',responseText:'정확히 일치한 등록 응답입니다.'};
      const fallback = {id:'fixture-error',name:'기본 오류',kind:'action',action:'error',errorCode:'NO_MATCH',errorMessage:'일치하는 값이 없습니다.'};
      let graph = {version:1,entryNodeId:'fixture-condition',nodes:[
        {id:'fixture-condition',name:'첫 조건',kind:'branch',condition:{mode:'all',predicates:[{path:'/risk',operator:'exists'}]}},respond,fallback],
        edges:[{id:'condition-yes',from:'fixture-condition',to:respond.id,port:'true'},{id:'condition-no',from:'fixture-condition',to:fallback.id,port:'false'}]};
      if(completeSwitch){
        const actions=values.map((_,index)=>({id:'typed-action-'+index,name:'자료형 안내 '+index,kind:'action',action:'respond',responseText:'선택된 경로 '+index}));
        graph={version:1,entryNodeId:'fixture-switch',nodes:[{id:'fixture-switch',name:'자료형 Switch',kind:'switch',path:'/risk/level',cases:values.map((value,index)=>({id:'case-'+(index+1),value}))},...actions,fallback],
          edges:[...actions.map((action,index)=>({id:'typed-edge-'+index,from:'fixture-switch',to:action.id,port:'case-'+(index+1)})),{id:'typed-default',from:'fixture-switch',to:fallback.id,port:'default'}]};
      }
      const workflow={id:'wf-switch-browser',name:'Switch 브라우저 워크플로우',description:'합성 브라우저 회귀',alias:'switch-browser',mainConnectionId:main.id,pre:[],post:[],updatedAt:new Date().toISOString(),policyRouting:{policy:savedPolicy.body.policy,routes:[],graph}};
      return await send({action:'save_workflow',workflow,expectedUpdatedAt:null});
    }''', complete_switch)
    assert result['status'] == 200, result['body']


def open_editor(page, server, node_id='fixture-condition'):
    page.goto(f'{server.base_url}/?page=workflows&workflowId={WORKFLOW_ID}&nodeId=policy:{node_id}', wait_until='networkidle')
    expect(page.locator('.we-top-actions')).to_be_visible()


def choose_node(page, name):
    panel = page.locator('#workflow-node-inspector')
    search = panel.get_by_label('설정할 노드 검색', exact=True)
    if not search.is_visible():
        panel.get_by_role('button', name='다른 노드 찾기', exact=True).click()
    search.fill(name)
    panel.locator('.we-inspector-node-results').get_by_role('button', name=name, exact=False).click()


def close_panel(page):
    panel = page.locator('#workflow-node-inspector')
    if panel.is_visible():
        panel.get_by_role('button', name='설정 패널 닫기', exact=True).click()


def save_editor(page):
    close_panel(page)
    save = page.locator('.we-top-actions').get_by_role('button', name='저장', exact=True)
    expect(save).to_be_enabled()
    with page.expect_response(lambda response: response.url.endswith('/api/console')
                              and response.request.method == 'POST'
                              and response.request.post_data_json.get('action') == 'save_workflow') as pending:
        save.click()
    assert pending.value.status == 200, pending.value.text()
    body = pending.value.json()
    return next(item for item in body['state']['workflows'] if item['id'] == WORKFLOW_ID)


def run_question(page, text):
    close_panel(page)
    page.locator('.we-top-actions').get_by_role('button', name='실행', exact=True).click()
    page.get_by_label('워크플로우 실행 질문', exact=True).fill(text)
    with page.expect_response(lambda response: response.url.endswith('/api/console')
                              and response.request.method == 'POST'
                              and response.request.post_data_json.get('action') == 'playground') as pending:
        page.get_by_role('button', name='질문 실행', exact=True).click()
    response = pending.value
    response.finished()
    assert response.status == 200, response.text()
    events = [json.loads(line) for line in response.text().splitlines() if line.strip()]
    result = next(event['result'] for event in events if event['type'] == 'result')
    expect(page.locator('.wr-last-result')).to_be_visible()
    assert next(trace for trace in result['traces'] if trace['ruleId'] == 'main')['status'] == 'skipped'
    assert 'policyOutput' not in result
    return result


@pytest.mark.parametrize('width', [1450, 390])
def test_add_switch_connect_cases_preserve_whitespace_and_null_after_reopening(page, console_server, width):
    page.set_viewport_size({'width': width, 'height': 1000})
    enter(page, console_server)
    seed_workflow(page)
    open_editor(page, console_server)
    close_panel(page)
    page.locator('.we-commandbar').get_by_role('button', name='노드 추가', exact=True).click()
    page.get_by_role('button', name='Switch 분기 노드 추가', exact=True).click()
    expect(page.get_by_label('Switch 필드 경로', exact=True)).to_be_visible()
    page.get_by_label('정책 노드 이름', exact=True).fill('공백 Switch')
    page.get_by_label('Switch 필드 경로', exact=True).fill('/risk/level')
    page.get_by_label('Switch 비교값 1', exact=True).fill(' ALLOW ')
    page.get_by_label('Switch case-1 연결', exact=True).select_option('fixture-respond')
    page.get_by_role('button', name='비교값 추가', exact=True).click()
    page.get_by_label('Switch 비교값 2 자료형', exact=True).select_option('null')
    expect(page.get_by_label('Switch 비교값 2', exact=True)).to_have_value('null')
    page.get_by_label('Switch case-2 연결', exact=True).select_option('fixture-error')
    page.get_by_label('Switch default 연결', exact=True).select_option('fixture-error')
    switch_id = page.locator('.policy-graph-editor').get_attribute('data-policy-node-id')
    assert switch_id
    choose_node(page, '첫 조건')
    page.get_by_label('정책 true 연결', exact=True).select_option(switch_id)
    saved = save_editor(page)
    switch = next(node for node in saved['policyRouting']['graph']['nodes'] if node['id'] == switch_id)
    assert switch['cases'] == [{'id': 'case-1', 'value': ' ALLOW '}, {'id': 'case-2', 'value': None}]
    assert len([edge for edge in saved['policyRouting']['graph']['edges'] if edge['from'] == switch_id]) == 3
    open_editor(page, console_server, switch_id)
    expect(page.get_by_label('Switch 필드 경로', exact=True)).to_have_value('/risk/level')
    expect(page.get_by_label('Switch 비교값 1', exact=True)).to_have_value(' ALLOW ')
    expect(page.get_by_label('Switch 비교값 2 자료형', exact=True)).to_have_value('null')
    # Each exact case is configured on its own card. No canvas-level selector
    # can silently choose a different output while a shared handle is dragged.
    page.get_by_label('Switch case-2 연결', exact=True).select_option('fixture-respond')
    expect(page.get_by_label('Switch case-2 연결', exact=True)).to_have_value('fixture-respond')
    page.get_by_role('button', name='Switch 비교값 2 경로에 새 노드 추가', exact=True).click()
    page.get_by_role('button', name='액션 추가하고 연결', exact=False).click()
    expect(page.get_by_label('정책 다음 액션', exact=True)).to_have_value('error')
    new_action_id = page.locator('.policy-graph-editor').get_attribute('data-policy-node-id')
    assert new_action_id and new_action_id != switch_id
    page.get_by_label('정책 노드 이름', exact=True).fill('널 검사 오류')
    updated = save_editor(page)
    case_edge = next(edge for edge in updated['policyRouting']['graph']['edges']
                     if edge['from'] == switch_id and edge['port'] == 'case-2')
    assert case_edge['to'] == new_action_id
    assert next(node for node in updated['policyRouting']['graph']['nodes'] if node['id'] == switch_id)['cases'] == switch['cases']
    close_panel(page)
    page.get_by_role('button', name='전체 보기', exact=True).click()
    outputs = page.locator(f'g[data-from="policy-node:{switch_id}"]')
    expect(outputs).to_have_count(3)
    expect(page.get_by_label('공백 Switch 출력 경로 선택', exact=True)).to_have_count(0)
    expect(page.locator(f'[data-policy-connect-port^="{switch_id}:"]')).to_have_count(0)
    for port, value_label in [('case-1', '" ALLOW "'), ('case-2', 'null'), ('default', '기본 경로')]:
        edge = page.locator(f'g[data-from="policy-node:{switch_id}"][data-port="{port}"]')
        description = edge.locator('path.wc-edge > title').text_content()
        assert description and '공백 Switch' in description and value_label in description
        expect(edge.get_by_role('button')).to_have_attribute('aria-label', description + ' 연결 설정')
    exact = run_question(page, '공백 문자열')
    assert exact['policyPath'] == ['fixture-condition', switch_id, 'fixture-respond']
    assert exact['output'] == '정확히 일치한 등록 응답입니다.'
    different = run_question(page, '같은 문자열')
    assert different['policyPath'] == ['fixture-condition', switch_id, 'fixture-error']
    assert different['status'] == 'block' and different['output'] == ''


def test_switch_invalid_numeric_and_duplicate_values_block_save_then_typed_routes_execute(page, console_server):
    enter(page, console_server)
    seed_workflow(page, complete_switch=True)
    open_editor(page, console_server, 'fixture-switch')
    expect(page.get_by_label('Switch 비교값 2 자료형', exact=True)).to_have_value('number')
    number = page.get_by_label('Switch 비교값 2', exact=True)
    number.fill('1e')
    expect(number).to_have_value('1e')
    expect(number).to_have_attribute('aria-invalid', 'true')
    expect(page.locator('.we-top-actions').get_by_role('button', name='저장', exact=True)).to_be_disabled()
    number.fill('1')
    page.get_by_label('Switch 비교값 3 자료형', exact=True).select_option('number')
    page.get_by_label('Switch 비교값 3', exact=True).fill('1.0')
    expect(page.locator('.we-top-actions').get_by_role('button', name='저장', exact=True)).to_be_disabled()
    page.get_by_label('Switch 비교값 3 자료형', exact=True).select_option('boolean')
    page.get_by_label('Switch 비교값 3', exact=True).select_option('true')
    saved = save_editor(page)
    assert [case['value'] for case in saved['policyRouting']['graph']['nodes'][0]['cases']] == [' ALLOW ', 1, True, None]
    for text, terminal, output in [('숫자', 'typed-action-1', '선택된 경로 1'),
                                  ('불리언', 'typed-action-2', '선택된 경로 2'),
                                  ('널', 'typed-action-3', '선택된 경로 3'),
                                  ('누락', 'fixture-error', ''),
                                  ('객체', 'fixture-error', '')]:
        result = run_question(page, text)
        assert result['policyPath'] == ['fixture-switch', terminal]
        assert result['output'] == output
