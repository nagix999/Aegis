"""Explicit registered-response termination matches the visible graph."""
import json

import pytest
from playwright.sync_api import expect
from workflow_events import observe_playground, playground_events

from test_switch_branching import WORKFLOW_ID, close_panel, enter, open_editor, save_editor, seed_workflow


@pytest.mark.parametrize('width', [1450, 390])
def test_registered_response_selects_immediate_or_post_and_keeps_saved_choice(page, console_server, width):
    page.set_viewport_size({'width':width,'height':1000})
    enter(page,console_server)
    seed_workflow(page,complete_switch=True)
    saved=page.evaluate('''async () => {
      const state=(await(await fetch('/api/console')).json()).state;
      const workflow=state.workflows.find(item=>item.id==='wf-switch-browser');
      workflow.post=[{id:'post-block',name:'공통 POST 검사',mode:'any',rules:[{id:'post-check',name:'공통 문구 검사',kind:'keyword',enabled:true,description:'',config:{pattern:'선택된 경로'}}]}];
      workflow.responseRetry={enabled:true,maxRetries:3};
      const response=await fetch('/api/console',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save_workflow',workflow,expectedUpdatedAt:workflow.updatedAt})});
      return {status:response.status,body:await response.json()};
    }''')
    assert saved['status']==200,saved['body']
    open_editor(page,console_server,'typed-action-0')
    selector=page.get_by_label('정책 액션 응답 반환 방식',exact=True)
    expect(selector).to_have_value('post')
    def run():
        close_panel(page)
        page.locator('.we-top-actions').get_by_role('button',name='실행',exact=True).click()
        page.get_by_label('워크플로우 실행 질문',exact=True).fill('공백 문자열')
        observe_playground(page)
        with page.expect_response(lambda r:r.url.endswith('/api/console') and r.request.method=='POST' and r.request.post_data_json.get('action')=='playground') as pending:
            page.get_by_role('button',name='질문 실행',exact=True).click()
        assert pending.value.status==200
        expect(page.locator('.wr-last-result')).to_be_visible()
        message=next(event for event in playground_events(page) if event['type']=='result')
        return message['result']
    for mode in ['immediate','post']:
        if mode=='post':
            open_editor(page,console_server,'typed-action-0')
        selector.select_option(mode)
        target='output' if mode=='immediate' else 'rule:post-check'
        expect(page.locator(f'g[data-from="policy-node:typed-action-0"][data-to="{target}"]')).to_have_count(1)
        unwanted='rule:post-check' if mode=='immediate' else 'output'
        expect(page.locator(f'g[data-from="policy-node:typed-action-0"][data-to="{unwanted}"]')).to_have_count(0)
        workflow=save_editor(page)
        action=next(node for node in workflow['policyRouting']['graph']['nodes'] if node['id']=='typed-action-0')
        assert action['responseMode']==mode
        open_editor(page,console_server,'typed-action-0')
        expect(selector).to_have_value(mode)
        result=run()
        assert result['policyResponseMode']==mode
        assert all(trace['status']=='skipped' for trace in result['traces'] if trace['stage']=='main')
        post=[trace for trace in result['traces'] if trace['stage']=='post']
        assert post
        if mode=='immediate':
            assert result['status']=='allow' and result['output']=='선택된 경로 0'
            assert all(trace['status']=='skipped' for trace in post)
        else:
            assert result['status']=='block' and result['output']==''
            assert any(trace['status']=='block' for trace in post)
        assert not result.get('regenerationCount')
