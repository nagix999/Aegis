"""Policy-specific dataset criteria use immutable owners and their own schemas."""
import pytest
from playwright.sync_api import expect

from test_policy_check_nodes import seed_checks
from test_switch_branching import WORKFLOW_ID, enter


def seed_distinct_policy_schemas(page):
    seed_checks(page)
    result = page.evaluate('''async () => {
      const state=(await(await fetch('/api/console')).json()).state;
      const workflow=state.workflows.find(item=>item.id==='wf-switch-browser');
      const send=async payload=>{
        const response=await fetch('/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        return {status:response.status,body:await response.json()};
      };
      let version=workflow.pre[0].rules[0].config.policyRouting.policy.version;
      for(const [stage,index,type,value] of [['pre',0,'string','PRE_VALUE'],['post',1,'number',7]]){
        const routing=workflow[stage][index].rules[0].config.policyRouting;
        const policy=structuredClone(routing.policy);
        delete policy.version;delete policy.updatedAt;delete policy.connectionSnapshot;
        policy.outputSchema.properties.score={type};
        policy.examples=policy.examples.map(example=>({...example,expectedOutput:{...example.expectedOutput,score:value}}));
        const saved=await send({action:'save_policy',policy,expectedVersion:version});
        if(saved.status!==200)return saved;
        routing.policy=saved.body.policy;version=saved.body.policy.version;
      }
      return send({action:'save_workflow',workflow,expectedUpdatedAt:workflow.updatedAt});
    }''')
    assert result['status'] == 200, result['body']


def post_dataset(page):
    result = page.evaluate('''async () => {
      const dataset={id:'policy-selector-dataset',name:'정책 선택 검증',description:'합성 요청',rows:[
        {id:'one',input:'공백 문자열',expected:'allow'},{id:'two',input:'숫자',expected:'allow'}]};
      const response=await fetch('/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_dataset',dataset,expectedUpdatedAt:null})});
      return {status:response.status,body:await response.json()};
    }''')
    assert result['status'] == 200, result['body']


def open_dataset(page, server):
    page.goto(f'{server.base_url}/?page=datasets&datasetId=policy-selector-dataset', wait_until='networkidle')
    page.get_by_label('데이터셋 점검 워크플로우', exact=True).select_option(WORKFLOW_ID)
    expect(page.get_by_label('데이터셋 점검 워크플로우', exact=True)).to_have_value(WORKFLOW_ID)


def save_dataset_editor(page):
    with page.expect_response(lambda response: response.url.endswith('/api/console') and response.request.method=='POST'
                              and response.request.post_data_json.get('action')=='save_dataset') as pending:
        page.get_by_role('button', name='저장', exact=True).click()
    assert pending.value.status == 200, pending.value.text()
    return next(item for item in pending.value.json()['state']['datasets'] if item['id']=='policy-selector-dataset')


@pytest.mark.parametrize('width', [1450, 390])
def test_row_and_bulk_policy_owner_survive_save_reload_and_apply_only_the_selected_schema(page, console_server, width):
    page.set_viewport_size({'width':width,'height':1000})
    enter(page, console_server)
    seed_distinct_policy_schemas(page)
    post_dataset(page)
    open_dataset(page, console_server)
    page.get_by_label('1번 항목 검증 기준', exact=True).click()
    page.get_by_label('1번 항목 검증할 정책 검사', exact=True).select_option('post-b')
    page.get_by_label('1번 항목 정책 출력 필드 조건 사용', exact=True).check()
    path=page.get_by_label('1번 항목 정책 출력 1 필드 경로', exact=True)
    path.fill('/score');path.press('Enter')
    expect(page.get_by_label('1번 항목 정책 출력 1 값 자료형', exact=True)).to_have_value('number')
    page.get_by_label('1번 항목 정책 출력 1 비교값', exact=True).fill('7')
    saved=save_dataset_editor(page)
    assert saved['rows'][0]['expectedPolicyNodeId']=='post-b'
    assert saved['rows'][0]['expectedPolicyFields']==[{'path':'/score','operator':'eq','value':7}]
    open_dataset(page, console_server)
    page.get_by_label('1번 항목 검증 기준', exact=True).click()
    expect(page.get_by_label('1번 항목 검증할 정책 검사', exact=True)).to_have_value('post-b')
    expect(page.get_by_label('1번 항목 정책 출력 1 값 자료형', exact=True)).to_have_value('number')
    page.get_by_label('1번 항목 일괄 선택', exact=True).check()
    page.get_by_label('2번 항목 일괄 선택', exact=True).check()
    page.get_by_role('button', name='선택 항목 일괄 설정', exact=True).click()
    dialog=page.get_by_role('dialog', name='선택 항목 2개 일괄 설정')
    dialog.get_by_label('정책 출력 필드 조건 교체', exact=True).check()
    dialog.get_by_label('일괄 검증할 정책 검사', exact=True).select_option('pre-a')
    dialog.get_by_role('button', name='필드 조건 추가', exact=True).click()
    path=dialog.get_by_label('일괄 정책 출력 1 필드 경로', exact=True)
    path.fill('/score');path.press('Enter')
    expect(dialog.get_by_label('일괄 정책 출력 1 값 자료형', exact=True)).to_have_value('string')
    dialog.get_by_label('일괄 정책 출력 1 비교값', exact=True).fill('EXPECTED_STRING')
    dialog.get_by_role('button', name='선택한 설정 적용', exact=True).click()
    saved=save_dataset_editor(page)
    assert [row['expectedPolicyNodeId'] for row in saved['rows']]==['pre-a','pre-a']
    assert all(row['expectedPolicyFields']==[{'path':'/score','operator':'eq','value':'EXPECTED_STRING'}] for row in saved['rows'])
    open_dataset(page, console_server)
    page.get_by_role('button', name='2번 항목 편집', exact=True).click()
    page.get_by_label('2번 항목 검증 기준', exact=True).click()
    expect(page.get_by_label('2번 항목 검증할 정책 검사', exact=True)).to_have_value('pre-a')
    expect(page.get_by_label('2번 항목 정책 출력 1 값 자료형', exact=True)).to_have_value('string')
    expect(page.get_by_label('2번 항목 정책 출력 1 비교값', exact=True)).to_have_value('EXPECTED_STRING')
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')


@pytest.mark.parametrize('width', [1450, 390])
def test_single_execution_case_saves_explicit_post_policy_owner_and_numeric_schema(page, console_server, width):
    page.set_viewport_size({'width':width,'height':1000})
    enter(page, console_server)
    seed_distinct_policy_schemas(page)
    page.goto(f'{console_server.base_url}/?page=evaluation&workflowId={WORKFLOW_ID}&tab=single', wait_until='networkidle')
    page.locator('#ev-prompt').fill('공백 문자열')
    page.get_by_role('main').get_by_role('button', name='검증 실행', exact=True).click()
    page.get_by_role('button', name='데이터셋에 저장', exact=True).click()
    dialog=page.get_by_role('dialog', name='검증 데이터셋에 저장')
    dialog.get_by_label('저장할 예상 결과', exact=True).select_option('allow')
    dialog.get_by_label('저장할 정책 검사', exact=True).select_option('post-b')
    dialog.get_by_label('저장할 정책 출력 필드 조건 사용', exact=True).check()
    dialog.get_by_role('button', name='필드 조건 추가', exact=True).click()
    path=dialog.get_by_label('저장할 정책 출력 1 필드 경로', exact=True)
    path.fill('/score');path.press('Enter')
    expect(dialog.get_by_label('저장할 정책 출력 1 값 자료형', exact=True)).to_have_value('number')
    dialog.get_by_label('저장할 정책 출력 1 비교값', exact=True).fill('7')
    dialog.get_by_label('예상 결과를 검증 기준으로 저장 확인', exact=True).check()
    with page.expect_response(lambda response: response.url.endswith('/api/console') and response.request.method=='POST'
                              and response.request.post_data_json.get('action')=='save_dataset') as pending:
        dialog.get_by_role('button', name='저장', exact=True).click()
    assert pending.value.status==200, pending.value.text()
    saved=next(item for item in pending.value.json()['state']['datasets'] if item['name']=='요청 검증 사례')
    assert saved['rows'][0]['expectedPolicyNodeId']=='post-b'
    assert saved['rows'][0]['expectedPolicyFields']==[{'path':'/score','operator':'eq','value':7}]
    assert 'output' not in saved['rows'][0]
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
