"""Policy routing is part of the shared engine, never a Gateway-only shortcut."""
import asyncio
import copy
import json
import time
from pathlib import Path

import httpx
import pytest

from aegis import engine
from aegis.compatibility import inspect_dataset_compatibility
from aegis.evaluation import _run_row
from aegis.review import configuration_fingerprint, dataset_fingerprint, matches_expectation, referenced_connections
from aegis.store import Store


def fixture(*, actual=False):
    state = json.loads((Path(__file__).parents[1] / 'aegis' / 'seed.json').read_text())
    workflow = state['workflows'][0]
    workflow['pre'], workflow['post'] = [], []
    main, guard = state['connections']
    main['model'], guard['model'] = 'main-model', 'policy-model'
    if actual:
        for connection in state['connections']:
            connection.update(mode='vllm', baseUrl='https://models.example/v1')
        state['ingress']['allowedOrigins'] = ['https://models.example']
    policy = {'id': 'policy', 'name': '문의 분류', 'description': '', 'prompt': '문의의 업무 범위를 분류하세요.',
              'connectionId': guard['id'], 'connectionSnapshot': copy.deepcopy(guard), 'version': 1, 'updatedAt': '2026-10-26T00:00:00Z',
              'decisions': [{'code': code, 'label': code, 'description': ''} for code in ('IN_SCOPE', 'OUT_OF_SCOPE', 'PII_RESTRICTED')],
              'examples': [{'id': str(index), 'input': text, 'expectedDecision': decision} for index, (text, decision) in enumerate([
                  ('배송', 'IN_SCOPE'), ('날씨', 'OUT_OF_SCOPE'), ('개인정보', 'PII_RESTRICTED')])]}
    workflow['policyRouting'] = {'policy': policy, 'routes': [
        {'decision': 'IN_SCOPE', 'action': 'main'},
        {'decision': 'OUT_OF_SCOPE', 'action': 'respond', 'responseText': '배송과 환불 관련 문의만 안내합니다.'},
        {'decision': 'PII_RESTRICTED', 'action': 'error', 'errorCode': 'PII_RESTRICTED', 'errorMessage': '개인정보 처리 정책에 따라 제한됩니다.'}]}
    return state, workflow


def messages(text='배송'):
    return [{'role': 'user', 'content': text}]


def post_rule(kind='keyword', **config):
    return {'id': 'post', 'name': '응답 검사', 'mode': 'any', 'rules': [
        {'id': 'post-rule', 'name': '응답 검사', 'description': '', 'enabled': True, 'kind': kind, 'config': config}]}


def generated(content, *, finish='stop', usage=True, message_fields=None):
    body = {'choices': [{'message': {'content': content, **(message_fields or {})}, 'finish_reason': finish}]}
    if usage:
        body['usage'] = {'prompt_tokens': 2, 'completion_tokens': 3, 'total_tokens': 5}
    return httpx.Response(200, json=body)


@pytest.mark.asyncio
@pytest.mark.parametrize('text,decision,route,status', [
    ('배송', 'IN_SCOPE', 'main', 'allow'), ('날씨', 'OUT_OF_SCOPE', 'respond', 'allow'),
    ('개인정보', 'PII_RESTRICTED', 'error', 'block')])
async def test_demo_three_routes_and_finished_progress(text, decision, route, status):
    state, workflow = fixture()
    events = []
    result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(text), on_progress=events.append)
    assert result['status'] == status
    assert (result['policyDecision'], result['policyRoute']) == (decision, route)
    assert events[-1]['nodeId'] == 'end' and events[-1]['stage'] == 'complete'
    policy_trace = next(trace for trace in result['traces'] if trace['ruleId'] == 'policy')
    assert policy_trace['stage'] == 'pre' and policy_trace['groupId'] == 'policy'
    main_trace = next(trace for trace in result['traces'] if trace['ruleId'] == 'main')
    assert main_trace['status'] == ('allow' if route == 'main' else 'skipped')
    if route == 'respond':
        assert result['output'] == workflow['policyRouting']['routes'][1]['responseText']
        assert 'usage' not in result
    elif route == 'error':
        assert result['output'] == '' and result['stage'] == 'pre'
        assert result['policyCode'] == 'PII_RESTRICTED'
        assert result['publicMessage'] == workflow['policyRouting']['routes'][2]['errorMessage']


@pytest.mark.asyncio
async def test_mandatory_pre_still_blocks_before_any_policy_call():
    state, workflow = fixture(actual=True)
    workflow['pre'] = [post_rule(pattern='DENY')]
    calls = []
    async def fetch(request):
        calls.append(request)
        raise AssertionError('PRE blocked request must never reach a model')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages('DENY'), client=client)
    assert result['status'] == 'block' and result['stage'] == 'pre'
    assert result['output'] == '' and 'policyDecision' not in result and not calls


@pytest.mark.asyncio
async def test_policy_snapshot_is_independent_of_live_guard_connection():
    state, workflow = fixture()
    state['connections'][1].update(model='changed', role='main', mode='vllm', baseUrl='https://unapproved.example/v1')
    state['connections'] = state['connections'][:1]
    result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages('날씨'))
    assert result['status'] == 'allow' and result['policyRoute'] == 'respond'
    assert [connection['id'] for connection in referenced_connections(workflow, state['connections'])] == ['conn-main']


@pytest.mark.asyncio
async def test_registered_response_must_pass_post_once_without_main_fallback_or_rewrites():
    state, workflow = fixture(actual=True)
    private = 'PRIVATE_REGISTERED_RESPONSE'
    workflow['policyRouting']['routes'][1]['responseText'] = private
    workflow['post'] = [post_rule(pattern=private)]
    workflow['responseRetry'] = {'enabled': True, 'maxRetries': 3}
    calls = []
    async def fetch(request):
        calls.append(json.loads(request.content))
        return generated('{"decision":"OUT_OF_SCOPE"}')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(), client=client)
    assert result['status'] == 'block' and result['stage'] == 'post' and result['output'] == ''
    assert result['regenerationCount'] == 0 and len(result['attempts']) == 1 and len(calls) == 1
    assert private not in json.dumps(result)
    assert 'usage' not in result and 'publicMessage' not in result


@pytest.mark.asyncio
async def test_registered_response_post_errors_do_not_return_output_or_retry():
    state, workflow = fixture(actual=True)
    workflow['post'] = [post_rule('llm', connectionId='conn-guard', prompt='검사', guardProfile='custom')]
    workflow['responseRetry'] = {'enabled': True, 'maxRetries': 3}
    calls = []
    async def fetch(request):
        calls.append(json.loads(request.content))
        return generated('{"decision":"OUT_OF_SCOPE"}') if len(calls) == 1 else httpx.Response(503, text='PRIVATE_UPSTREAM_ERROR')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(), client=client)
    assert result['status'] == 'error' and result['stage'] == 'post' and result['output'] == ''
    assert len(calls) == 2 and result['regenerationCount'] == 0
    assert 'PRIVATE_UPSTREAM_ERROR' not in json.dumps(result)


@pytest.mark.asyncio
async def test_policy_runs_once_then_main_keeps_three_additional_rewrites_and_usage_contract():
    state, workflow = fixture(actual=True)
    workflow['post'] = [post_rule(pattern='PRIVATE_BLOCKED')]
    workflow['responseRetry'] = {'enabled': True, 'maxRetries': 3}
    calls, main_calls = [], []
    original = messages()
    async def fetch(request):
        body = json.loads(request.content)
        calls.append(body)
        if body['model'] == 'policy-model':
            return generated('{"decision":"IN_SCOPE"}')
        main_calls.append(body)
        return generated('PRIVATE_BLOCKED' if len(main_calls) < 4 else 'safe')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, original, client=client)
    assert result['status'] == 'allow' and result['output'] == 'safe'
    assert len(calls) == 5 and len(main_calls) == 4 and result['regenerationCount'] == 3
    assert result['usage']['total_tokens'] == 20  # Existing usage means Main generation, excluding inspectors.
    assert main_calls[0]['messages'] == original
    assert all('response_format' not in body for body in main_calls)
    assert calls[0]['response_format']['json_schema']['strict'] is True
    assert calls[0]['response_format']['json_schema']['schema']['additionalProperties'] is False
    assert sum(trace['ruleId'] == 'policy' for trace in result['traces']) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('content', [
    'PRIVATE_FREE_TEXT', '```json\n{"decision":"IN_SCOPE"}\n```', '[]',
    '{"decision":"UNKNOWN"}', '{"decision":"IN_SCOPE","reason":"PRIVATE_REASON"}',
    '{"decision":"IN_SCOPE","decision":"PII_RESTRICTED"}', '{"decision":null}',
    '{"decision":NaN}', '{"decision":123}'])
async def test_invalid_policy_output_fails_closed_and_never_reaches_main(content):
    state, workflow = fixture(actual=True)
    calls = []
    async def fetch(request):
        calls.append(json.loads(request.content))
        return generated(content)
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(), client=client)
    assert result['status'] == 'error' and result['stage'] == 'pre' and result['output'] == ''
    assert len(calls) == 1 and 'PRIVATE_' not in json.dumps(result)
    assert 'policyDecision' not in result


@pytest.mark.asyncio
@pytest.mark.parametrize('finish,extra', [('length', {}), ('content_filter', {}), ('tool_calls', {}),
    ('function_call', {}), ('unknown', {}), (None, {}), ('stop', {'tool_calls': [{'id': 'private'}]})])
async def test_noncomplete_or_tool_policy_output_fails_closed(finish, extra):
    state, workflow = fixture(actual=True)
    calls = []
    async def fetch(request):
        calls.append(request)
        return generated('{"decision":"IN_SCOPE"}', finish=finish, message_fields=extra)
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(), client=client)
    assert result['status'] == 'error' and result['output'] == '' and len(calls) == 1


@pytest.mark.asyncio
async def test_policy_and_main_share_model_call_budget():
    state, workflow = fixture(actual=True)
    workflow['executionLimits'] = {'timeoutMs': 10000, 'maxModelCalls': 1}
    calls = []
    async def fetch(request):
        calls.append(request)
        return generated('{"decision":"IN_SCOPE"}')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(), client=client)
    assert result['status'] == 'error' and result['stage'] == 'main' and result['output'] == ''
    assert len(calls) == 1 and '호출 한도' in result['reason']


@pytest.mark.asyncio
async def test_registered_response_post_uses_same_model_budget_and_hides_response():
    state, workflow = fixture(actual=True)
    workflow['executionLimits'] = {'timeoutMs': 10000, 'maxModelCalls': 1}
    workflow['post'] = [post_rule('llm', connectionId='conn-guard', prompt='검사', guardProfile='custom')]
    calls = []
    async def fetch(request):
        calls.append(request)
        return generated('{"decision":"OUT_OF_SCOPE"}')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(), client=client)
    assert result['status'] == 'error' and result['stage'] == 'post' and result['output'] == ''
    assert len(calls) == 1 and '호출 한도' in result['reason']


@pytest.mark.asyncio
async def test_missing_policy_finish_reason_is_not_assumed_complete():
    state, workflow = fixture(actual=True)
    calls = []
    async def fetch(request):
        calls.append(request)
        return httpx.Response(200, json={'choices': [{'message': {'content': '{"decision":"IN_SCOPE"}'}}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(), client=client)
    assert result['status'] == 'error' and result['stage'] == 'pre' and result['output'] == ''
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['timeout', 'cancel', 'deadline'])
async def test_policy_timeout_cancellation_and_whole_execution_deadline_fail_closed(monkeypatch, failure):
    state, workflow = fixture(actual=True)
    cancelled = asyncio.Event()
    if failure == 'deadline':
        original_runtime = engine.ExecutionRuntime
        class FastRuntime(original_runtime):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.deadline = time.monotonic() + 0.02
        monkeypatch.setattr(engine, 'ExecutionRuntime', FastRuntime)
    calls = []
    async def fetch(request):
        calls.append(request)
        if failure == 'timeout':
            raise httpx.ReadTimeout('PRIVATE_TIMEOUT', request=request)
        if failure == 'cancel':
            cancelled.set()
        await asyncio.sleep(10)
        return generated('{"decision":"IN_SCOPE"}')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(), cancel_event=cancelled, client=client)
    assert result['status'] == 'error' and result['stage'] == 'pre' and result['output'] == ''
    assert len(calls) == 1 and 'PRIVATE_TIMEOUT' not in json.dumps(result)


@pytest.mark.asyncio
@pytest.mark.parametrize('mutation', ['missing_route', 'duplicate_route', 'wrong_role', 'bad_snapshot', 'missing_policy', 'null'])
async def test_invalid_policy_configuration_fails_before_any_model_call(mutation):
    state, workflow = fixture(actual=True)
    routing = workflow['policyRouting']
    if mutation == 'missing_route':
        routing['routes'].pop()
    elif mutation == 'duplicate_route':
        routing['routes'][1]['decision'] = routing['routes'][0]['decision']
    elif mutation == 'wrong_role':
        routing['policy']['connectionSnapshot']['role'] = 'main'
    elif mutation == 'bad_snapshot':
        routing['policy']['connectionSnapshot']['baseUrl'] = 'http://unsafe.example/v1'
    elif mutation == 'missing_policy':
        routing.pop('policy')
    else:
        workflow['policyRouting'] = None
    calls = []
    async def fetch(request):
        calls.append(request)
        raise AssertionError('Invalid configuration must not execute')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(), client=client)
    assert result['status'] == 'error' and result['output'] == '' and not calls


@pytest.mark.asyncio
async def test_policy_snapshot_cannot_bypass_current_model_origin_allowlist():
    state, workflow = fixture(actual=True)
    state['ingress']['allowedOrigins'] = []
    calls = []
    async def fetch(request):
        calls.append(request)
        raise AssertionError('An unapproved model origin must not be called')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(), client=client)
    assert result['status'] == 'error' and result['output'] == '' and not calls


def test_policy_execution_identity_tracks_semantics_and_ignores_display_metadata():
    state, workflow = fixture()
    original = configuration_fingerprint(workflow, state['connections'])
    changed = copy.deepcopy(workflow)
    changed['policyRouting']['policy'].update(id='other', name='다른 이름', description='설명', version=2, updatedAt='later')
    changed['policyRouting']['policy']['connectionSnapshot']['name'] = '다른 이름'
    assert configuration_fingerprint(changed, state['connections']) == original
    for mutation in ('prompt', 'meaning', 'example', 'model', 'response', 'error'):
        changed = copy.deepcopy(workflow)
        policy = changed['policyRouting']['policy']
        if mutation == 'prompt':
            policy['prompt'] += ' 다른 기준'
        elif mutation == 'meaning':
            policy['decisions'][0]['description'] = '새 의미'
        elif mutation == 'example':
            policy['examples'][0]['expectedDecision'] = 'OUT_OF_SCOPE'
        elif mutation == 'model':
            policy['connectionSnapshot']['model'] = 'other-model'
        elif mutation == 'response':
            changed['policyRouting']['routes'][1]['responseText'] = '다른 안내'
        else:
            changed['policyRouting']['routes'][2]['errorCode'] = 'OTHER_ERROR'
        assert configuration_fingerprint(changed, state['connections']) != original, mutation


def test_dataset_policy_expectations_are_fingerprinted_and_checked_individually():
    row = {'id': 'row', 'input': '배송', 'expected': 'allow', 'expectedDecision': 'IN_SCOPE', 'expectedRoute': 'main'}
    result = {'status': 'allow', 'stage': 'complete', 'policyDecision': 'IN_SCOPE', 'policyRoute': 'main', 'traces': []}
    assert matches_expectation(row, result)
    for key, value in [('expectedDecision', 'OUT_OF_SCOPE'), ('expectedRoute', 'respond'), ('expectedPolicyCode', 'PII_RESTRICTED')]:
        changed = {**row, key: value}
        assert not matches_expectation(changed, result)
        assert dataset_fingerprint({'rows': [changed]}) != dataset_fingerprint({'rows': [row]})
    state, workflow = fixture()
    dataset = {'rows': [{**row, 'expectedRoute': 'respond'}]}
    assert inspect_dataset_compatibility(dataset, workflow)['issues'][0]['code'] == 'policy_route_mismatch'
    workflow.pop('policyRouting')
    assert inspect_dataset_compatibility(dataset, workflow)['issues'][0]['code'] == 'missing_policy'


@pytest.mark.asyncio
async def test_policy_trace_cannot_satisfy_colliding_detector_expectation():
    state, workflow = fixture()
    workflow['pre'] = [post_rule(pattern='NEVER_BLOCK')]
    workflow['pre'][0]['id'] = 'pre-group'
    workflow['pre'][0]['rules'][0]['id'] = 'policy'
    result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages('개인정보'))
    traces = [trace for trace in result['traces'] if trace['ruleId'] == 'policy']
    assert [(trace.get('traceType'), trace['status']) for trace in traces] == [(None, 'allow'), ('policy', 'block')]
    assert not matches_expectation({'expected': 'block', 'expectedRuleId': 'policy'}, result)
    assert matches_expectation({'expected': 'block', 'expectedDecision': 'PII_RESTRICTED', 'expectedRoute': 'error', 'expectedPolicyCode': 'PII_RESTRICTED'}, result)
    # A real detector with this existing ID continues to match normally.
    detector_blocked = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages('NEVER_BLOCK'))
    assert matches_expectation({'expected': 'block', 'expectedRuleId': 'policy'}, detector_blocked)
    assert 'policyDecision' not in detector_blocked


@pytest.mark.asyncio
async def test_dataset_validation_uses_shared_policy_engine_and_logs_only_safe_metadata():
    state, workflow = fixture()
    row = {'id': 'row', 'input': '개인정보', 'expected': 'block', 'expectedDecision': 'PII_RESTRICTED', 'expectedRoute': 'error', 'expectedPolicyCode': 'PII_RESTRICTED'}
    store = Store()
    try:
        result = await _run_row(row, workflow, state['connections'], 'draft', state, store, {})
        assert result['expectationMatched'] is True and result['output'] == ''
        logs = (await store.state())['logs']
        log = next(log for log in logs if log['id'] == result['id'])
        assert log['policyDecision'] == 'PII_RESTRICTED' and log['policyRoute'] == 'error'
        assert log['policyCode'] == 'PII_RESTRICTED' and 'publicMessage' not in log
    finally:
        await store.close()
