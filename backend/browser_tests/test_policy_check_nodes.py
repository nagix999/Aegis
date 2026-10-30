"""Independent PRE/POST policy editing and administrator JSON inspection."""
import json

from playwright.sync_api import expect

from test_switch_branching import WORKFLOW_ID, choose_node, close_panel, enter, open_editor, save_editor, seed_workflow


def seed_checks(page):
    seed_workflow(page, complete_switch=True)
    result = page.evaluate('''async () => {
      const state=(await(await fetch('/api/console')).json()).state;
      const workflow=state.workflows.find(item=>item.id==='wf-switch-browser');
      const routing=workflow.policyRouting;delete workflow.policyRouting;
      routing.graph.nodes=routing.graph.nodes.map(node=>node.kind==='action'&&node.action==='respond'?{id:node.id,name:node.name,kind:'action',action:'main'}:node);
      const group=id=>({id:'group-'+id,name:id,mode:'any',rules:[{id,name:id,description:'',kind:'policy',enabled:true,config:{policyRouting:structuredClone(routing)}}]});
      workflow.pre=['pre-a','pre-b'].map(group);workflow.post=['post-a','post-b'].map(group);
      const response=await fetch('/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_workflow',workflow,expectedUpdatedAt:workflow.updatedAt})});
      return {status:response.status,body:await response.json()};
    }''')
    assert result['status']==200, result['body']


def test_multiple_policy_nodes_preserve_independent_settings_and_admin_json(page, console_server):
    enter(page,console_server)
    seed_checks(page)
    open_editor(page,console_server,'post-b/fixture-switch')
    expect(page.get_by_label('Switch 필드 경로',exact=True)).to_have_value('/risk/level')
    expect(page.locator('.we-inspector-node')).to_contain_text('응답 검사 / post-b')
    page.get_by_label('정책 노드 이름',exact=True).fill('POST 전용 Switch')
    saved=save_editor(page)
    assert saved['post'][1]['rules'][0]['config']['policyRouting']['graph']['nodes'][0]['name']=='POST 전용 Switch'
    assert saved['pre'][1]['rules'][0]['config']['policyRouting']['graph']['nodes'][0]['name']=='자료형 Switch'
    close_panel(page)
    page.locator('.we-top-actions').get_by_role('button',name='실행',exact=True).click()
    page.get_by_label('워크플로우 실행 질문',exact=True).fill('공백 문자열')
    page.locator('.wr-advanced').get_by_text('생성 옵션과 모의 응답',exact=True).click()
    page.get_by_label('응답 생성을 모의 응답으로 대체',exact=False).check()
    page.get_by_label('응답 검사 모의 응답',exact=True).fill('공백 문자열')
    with page.expect_response(lambda r:r.url.endswith('/api/console') and r.request.method=='POST' and r.request.post_data_json.get('action')=='playground') as pending:
        page.get_by_role('button',name='질문 실행',exact=True).click()
    pending.value.finished()
    message=next(json.loads(line) for line in pending.value.text().splitlines() if json.loads(line)['type']=='result')
    assert message['result']['status']=='allow'
    assert [(check['ruleId'],check['stage']) for check in message['result']['policyChecks']]==[('pre-a','pre'),('pre-b','pre'),('post-a','post'),('post-b','post')]
    assert 'policyOutput' not in message['result'] and 'inspection' not in message['result']
    details=message['inspection']['nodes']
    for identifier in ['pre-a','pre-b','post-a','post-b']:
        model=next(node for node in details if node['nodeId']=='rule:'+identifier)
        assert model['output']['value']=={'risk':{'level':' ALLOW '}}
        branch=next(node for node in details if node['nodeId']=='policy-node:'+identifier+'/fixture-switch')
        assert branch['input']['value']=={'risk':{'level':' ALLOW '}}
        assert branch['selectedPort']=='case-1'
    page.locator('.we-run-dock-toggle').click()
    page.get_by_role('button',name='전체 보기',exact=True).click()
    page.get_by_role('button',name='post-b 실행 내역',exact=True).click()
    expect(page.get_by_label('노드 출력 JSON',exact=True)).to_contain_text(' ALLOW ')
    choose_node(page,'POST 전용 Switch')
    page.get_by_role('tab',name='실행 내역',exact=False).click()
    expect(page.get_by_label('노드 입력 JSON',exact=True)).to_contain_text(' ALLOW ')
    expect(page.get_by_label('노드 출력 JSON',exact=True)).to_contain_text('case-1')
    close_panel(page)
    page.locator('[data-layout-key="main"] + button.wc-inspect-status').click()
    expect(page.get_by_label('노드 입력 JSON',exact=True)).to_contain_text('messages')
    expect(page.get_by_label('노드 출력 JSON',exact=True)).to_contain_text('공백 문자열')


def test_add_pre_and_post_policy_checks_from_node_library(page,console_server):
    enter(page,console_server)
    seed_checks(page)
    open_editor(page,console_server,'pre-a/fixture-switch')
    for stage in ['pre','post']:
        close_panel(page)
        page.locator('.we-commandbar').get_by_role('button',name='노드 추가',exact=True).click()
        page.get_by_label('실행 구간',exact=True).select_option(stage)
        page.get_by_role('button',name='정책 검사 (구조화 출력) 노드 추가',exact=True).click()
        page.get_by_label('추가할 정책 버전',exact=True).select_option('policy-switch-browser:1')
        page.get_by_role('button',name='선택한 정책 노드 추가',exact=True).click()
        expect(page.get_by_label('검사 이름',exact=True)).to_have_value('Switch 브라우저 정책')
        page.get_by_label('검사 이름',exact=True).fill(stage+' 새 정책')
        page.locator('.we-inspector-body').get_by_role('button',name='노드 추가',exact=True).click()
        expect(page.get_by_label('분기를 연결할 정책 검사',exact=True)).not_to_have_value('')
        page.get_by_role('button',name='Switch 분기 노드 추가',exact=True).click()
        expect(page.get_by_label('Switch 필드 경로',exact=True)).to_be_visible()
        expect(page.locator('.we-inspector-node')).to_contain_text(('요청 검사' if stage=='pre' else '응답 검사')+' / '+stage+' 새 정책')
        # Delete the new child and parent, then undo the parent deletion. The
        # other policies and the original legacy-free data must stay intact.
        page.get_by_role('button',name='노드 삭제',exact=True).click()
        expect(page.get_by_label('검사 이름',exact=True)).to_have_value(stage+' 새 정책')
        page.get_by_role('button',name='검사 삭제',exact=True).click()
        page.get_by_role('button',name='실행 취소',exact=True).click()
        expect(page.locator('.wc-node').filter(has_text=stage+' 새 정책')).to_have_count(1)
