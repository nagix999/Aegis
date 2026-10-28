"""Typed policy DAG execution, shared Gateway/evaluation and private outputs."""
import copy
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from aegis import engine
from aegis.api import create_router
from aegis.compatibility import inspect_dataset_compatibility
from aegis.policy_graph import (execute_policy_graph, predicate_matches, schema_at_pointer,
                               validate_policy_graph, value_at_pointer, MISSING)
from aegis.review import configuration_fingerprint, matches_expectation
from aegis.schemas import PolicyRouting
from aegis.store import Store


def condition(path='', operator='exists', value=True):
    return {'mode': 'all', 'predicates': [{'path': path, 'operator': operator, 'value': value}]}


def graph():
    return {'version': 1, 'entryNodeId': 'branch', 'nodes': [
        {'id': 'branch', 'name': '업무 분기', 'kind': 'branch', 'condition': condition('/context/topic', 'eq', 'service')},
        {'id': 'risk', 'name': '위험 점수 규칙', 'kind': 'rule', 'condition': condition('/risk/score', 'gte', 80)},
        {'id': 'other', 'name': '범위 규칙', 'kind': 'rule', 'condition': condition('/context/scope', 'eq', 'out')},
        {'id': 'main-action', 'name': '응답 모델', 'kind': 'action', 'action': 'main'},
        {'id': 'respond-action', 'name': '범위 안내', 'kind': 'action', 'action': 'respond', 'responseText': '배송과 환불 문의만 안내합니다.'},
        {'id': 'error-action', 'name': '위험 요청 거부', 'kind': 'action', 'action': 'error', 'errorCode': 'RISK_RESTRICTED', 'errorMessage': '위험 처리 정책에 따라 제한됩니다.'}],
        'edges': [{'id': 'b-true', 'from': 'branch', 'to': 'risk', 'port': 'true'},
                  {'id': 'b-false', 'from': 'branch', 'to': 'other', 'port': 'false'},
                  {'id': 'r-true', 'from': 'risk', 'to': 'error-action', 'port': 'true'},
                  {'id': 'r-false', 'from': 'risk', 'to': 'main-action', 'port': 'false'},
                  {'id': 'o-true', 'from': 'other', 'to': 'respond-action', 'port': 'true'},
                  {'id': 'o-false', 'from': 'other', 'to': 'error-action', 'port': 'false'}]}


def compact_graph(kind='branch', action='error'):
    terminal = {'id': 'finish', 'name': '최종 처리', 'kind': 'action', 'action': action}
    if action == 'respond':
        terminal['responseText'] = '등록된 안내입니다.'
    elif action == 'error':
        terminal.update(errorCode='RISK_RESTRICTED', errorMessage='정책에 따라 제한됩니다.')
    return {'version': 1, 'entryNodeId': 'check', 'nodes': [
        {'id': 'check', 'name': '조건 분기', 'kind': kind, 'condition': condition('/risk/score', 'gte', 80)}, terminal],
        'edges': [{'id': 'yes', 'from': 'check', 'to': 'finish', 'port': 'true'},
                  {'id': 'no', 'from': 'check', 'to': 'finish', 'port': 'false'}]}


def unified_graph():
    """A saved rule can start the DAG and lead to a branch or an action."""
    plan = graph()
    plan['nodes'] = [node for node in plan['nodes'] if node['id'] != 'other']
    plan['nodes'][0]['kind'] = 'rule'
    plan['nodes'][1]['kind'] = 'branch'
    plan['edges'] = [edge for edge in plan['edges'] if not edge['id'].startswith('o-')]
    plan['edges'][1]['to'] = 'respond-action'
    return plan


def output(topic='service', scope='in', score=10, secret='PRIVATE_POLICY_OUTPUT'):
    return {'context': {'topic': topic, 'scope': scope}, 'risk': {'score': score}, 'findings': [{'category': 'example', 'detail': secret}], 'nullable': None}


def output_schema():
    return {'type': 'object', 'properties': {
        'context': {'type': 'object', 'properties': {'topic': {'type': 'string', 'enum': ['service', 'general']}, 'scope': {'type': 'string', 'enum': ['in', 'out']}}, 'required': ['topic', 'scope'], 'additionalProperties': False},
        'risk': {'type': 'object', 'properties': {'score': {'type': 'integer', 'minimum': 0, 'maximum': 100}}, 'required': ['score'], 'additionalProperties': False},
        'findings': {'type': 'array', 'maxItems': 5, 'items': {'type': 'object', 'properties': {'category': {'type': 'string', 'maxLength': 100}, 'detail': {'type': 'string', 'maxLength': 200}}, 'required': ['category', 'detail'], 'additionalProperties': False}},
        'nullable': {'type': ['string', 'null'], 'maxLength': 100}},
        'required': ['context', 'risk', 'findings', 'nullable'], 'additionalProperties': False}


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
    policy = {'id': 'policy-v2', 'name': '복합 정책', 'description': '', 'prompt': '위험과 업무 범위를 구조화하세요.', 'connectionId': guard['id'],
              'formatVersion': 2, 'outputSchema': output_schema(), 'decisions': [], 'maxOutputTokens': 1024,
              'connectionSnapshot': copy.deepcopy(guard), 'version': 1, 'updatedAt': '2026-10-27T00:00:00Z',
              'examples': [{'id': 'main-example', 'input': '배송', 'expectedOutput': output()},
                           {'id': 'respond-example', 'input': '날씨', 'expectedOutput': output('general', 'out', 0)},
                           {'id': 'error-example', 'input': '위험', 'expectedOutput': output(score=95)}]}
    workflow['policyRouting'] = {'policy': policy, 'routes': [], 'graph': graph()}
    return state, workflow


def messages(text='배송'):
    return [{'role': 'user', 'content': text}]


def post_rule(pattern='PRIVATE_REGISTERED_RESPONSE'):
    return {'id': 'post', 'name': '응답 검사', 'mode': 'any', 'rules': [{'id': 'post-rule', 'name': '금지 표현', 'description': '', 'enabled': True, 'kind': 'keyword', 'config': {'pattern': pattern}}]}


def generated(content):
    return httpx.Response(200, json={'choices': [{'message': {'content': content}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 2, 'completion_tokens': 3, 'total_tokens': 5}})


def test_graph_validator_and_three_paths():
    plan = graph()
    assert validate_policy_graph(plan, output_schema()) == []
    for value, action, path in [(output(), 'main', ['branch', 'risk', 'main-action']),
        (output('general', 'out', 0), 'respond', ['branch', 'other', 'respond-action']),
        (output(score=95), 'error', ['branch', 'risk', 'error-action'])]:
        result = execute_policy_graph(plan, value)
        assert result['route']['action'] == action and result['path'] == path


@pytest.mark.parametrize('kind', ['branch', 'rule'])
@pytest.mark.parametrize('action', ['main', 'respond', 'error'])
def test_conditions_can_start_and_connect_directly_to_an_action(kind, action):
    plan = compact_graph(kind, action)
    assert validate_policy_graph(plan, output_schema()) == []
    _, workflow = fixture()
    routing = {**workflow['policyRouting'], 'graph': plan}
    # The API model accepts the smallest complete DAG, while preserving saved
    # condition IDs and kinds rather than migrating existing revisions.
    assert PolicyRouting.model_validate(routing).graph.model_dump(by_alias=True, exclude_none=True) == plan
    for score in (0, 95):
        result = execute_policy_graph(plan, output(score=score))
        assert result['route']['action'] == action
        assert result['path'] == ['check', 'finish']


@pytest.mark.parametrize('kinds', [('branch', 'branch'), ('rule', 'branch'), ('rule', 'rule')])
def test_condition_kinds_share_nested_routing_without_redundant_rules(kinds):
    plan = unified_graph()
    plan['nodes'][0]['kind'], plan['nodes'][1]['kind'] = kinds
    assert validate_policy_graph(plan, output_schema()) == []
    assert execute_policy_graph(plan, output())['path'] == ['branch', 'risk', 'main-action']
    assert execute_policy_graph(plan, output(score=95))['path'] == ['branch', 'risk', 'error-action']
    assert execute_policy_graph(plan, output('general', 'out'))['path'] == ['branch', 'respond-action']


@pytest.mark.parametrize('plan', [
    {'version': 1, 'entryNodeId': '', 'nodes': [], 'edges': []},
    {'version': 1, 'entryNodeId': 'finish', 'nodes': [{'id': 'finish', 'name': '최종 처리', 'kind': 'action', 'action': 'main'}], 'edges': []},
])
def test_empty_and_action_only_drafts_are_not_executable_or_saveable(plan):
    assert validate_policy_graph(plan, output_schema())
    _, workflow = fixture()
    with pytest.raises(ValueError):
        PolicyRouting.model_validate({**workflow['policyRouting'], 'graph': plan})


@pytest.mark.parametrize('limit', ['nodes', 'edges'])
def test_unified_conditions_keep_the_bounded_graph_limits(limit):
    plan = compact_graph()
    if limit == 'nodes':
        plan['nodes'].extend({'id': f'extra-{index}', 'name': '추가 처리', 'kind': 'action', 'action': 'main'} for index in range(23))
    else:
        plan['edges'].extend({'id': f'extra-{index}', 'from': 'check', 'to': 'finish', 'port': 'true'} for index in range(47))
    assert validate_policy_graph(plan, output_schema())


@pytest.mark.parametrize('mutation', ['missing-port', 'duplicate-port', 'duplicate-id', 'unknown-end', 'edge-to-entry', 'action-outgoing', 'cycle', 'unreachable', 'unknown-field', 'numeric-bool', 'array-index', 'bad-pointer', 'bad-in', 'bad-exists', 'bad-contains'])
def test_invalid_graph_is_rejected_without_interpolating_values(mutation):
    plan = graph()
    if mutation == 'missing-port': plan['edges'].pop()
    elif mutation == 'duplicate-port': plan['edges'][1]['port'] = 'true'
    elif mutation == 'duplicate-id': plan['nodes'][1]['id'] = 'branch'
    elif mutation == 'unknown-end': plan['edges'][0]['to'] = 'unknown'
    elif mutation == 'edge-to-entry': plan['edges'][2]['to'] = 'branch'
    elif mutation == 'action-outgoing': plan['edges'].append({'id': 'bad', 'from': 'main-action', 'to': 'risk', 'port': 'true'})
    elif mutation == 'cycle': plan['edges'][2]['to'] = 'risk'
    elif mutation == 'unreachable': plan['nodes'].append({'id': 'unused', 'name': '미연결', 'kind': 'action', 'action': 'main'})
    else:
        predicates = plan['nodes'][1]['condition']['predicates']
        if mutation == 'unknown-field': predicates[0]['path'] = '/PRIVATE_UNKNOWN'
        elif mutation == 'numeric-bool': predicates[0]['value'] = True
        elif mutation == 'array-index': predicates[0]['path'] = '/findings/-1/category'
        elif mutation == 'bad-pointer': predicates[0]['path'] = '/context/~bad'
        elif mutation == 'bad-in': predicates[0].update(operator='in', value='PRIVATE_LITERAL')
        elif mutation == 'bad-exists': predicates[0].update(operator='exists', value=1)
        elif mutation == 'bad-contains': predicates[0].update(operator='contains', value='PRIVATE_LITERAL')
    issues = validate_policy_graph(plan, output_schema())
    assert issues and 'PRIVATE_' not in json.dumps(issues)


def test_pointer_and_comparison_semantics_preserve_json_types_and_null():
    value = {'a/b': {'~key': [None, True, 1, 'abc']}}
    assert value_at_pointer(value, '/a~1b/~0key/0') is None
    assert value_at_pointer(value, '/missing') is MISSING
    assert predicate_matches({'path': '/a~1b/~0key/0', 'operator': 'exists'}, value)
    assert predicate_matches({'path': '/missing', 'operator': 'exists', 'value': False}, value)
    assert not predicate_matches({'path': '/missing', 'operator': 'ne', 'value': None}, value)
    assert not predicate_matches({'path': '/a~1b/~0key/1', 'operator': 'eq', 'value': 1}, value)
    assert not predicate_matches({'path': '/a~1b/~0key/1', 'operator': 'gt', 'value': 0}, value)
    assert predicate_matches({'path': '/a~1b/~0key/2', 'operator': 'eq', 'value': 1.0}, value)
    assert predicate_matches({'path': '/a~1b/~0key/3', 'operator': 'contains', 'value': 'b'}, value)
    assert predicate_matches({'path': '/a~1b/~0key', 'operator': 'contains', 'value': None}, value)
    assert predicate_matches({'path': '/a~1b/~0key/0', 'operator': 'in', 'value': [None, 'other']}, value)


def test_schema_pointer_resolves_local_refs_and_composite_variants():
    schema = {'type': 'object', '$defs': {'risk': output_schema()['properties']['risk']},
              'properties': {'result': {'oneOf': [{'$ref': '#/$defs/risk'}, {'type': 'null'}]}}}
    assert schema_at_pointer(schema, '/result/score') == output_schema()['properties']['risk']['properties']['score']
    plan = graph()
    for node in plan['nodes'][:3]:
        node['condition'] = condition('/result/score', 'gte', 80)
    assert validate_policy_graph(plan, schema) == []
    # Schema references are URI fragments; predicate JSON Pointers are not.
    schema['properties']['result'] = {'$ref': '#/$defs/r%69sk'}
    assert schema_at_pointer(schema, '/result/score') == {'type': 'integer', 'minimum': 0, 'maximum': 100}
    schema['$defs']['variants'] = {'oneOf': [{'$ref': '#/$defs/risk'}, {'type': 'null'}]}
    schema['properties']['result'] = {'$ref': '#/$defs/variants/oneOf/0'}
    assert validate_policy_graph(plan, schema) == []


@pytest.mark.parametrize('schema,value,operator,expected', [
    ({'const': 'ok'}, 'ok', 'eq', 'ok'),
    ({'enum': [True, False]}, True, 'eq', False),
    ({'anyOf': [{'type': 'integer'}, {'type': 'null'}]}, 10, 'gte', 5),
    ({'allOf': [{'type': 'number'}, {'minimum': 0}]}, 10, 'gte', 5),
    ({}, {'arbitrary': True}, 'exists', True),
    ({'type': 'array', 'prefixItems': [{'type': 'string'}, {'type': 'number'}], 'items': False}, ['a', 2], 'exists', True),
])
def test_graph_supports_scalar_nullable_composite_and_unconstrained_root_schemas(schema, value, operator, expected):
    plan = graph()
    for node in plan['nodes'][:3]:
        node['condition'] = condition('', operator, expected)
    assert validate_policy_graph(plan, schema) == []
    assert execute_policy_graph(plan, value)['route']['action'] in {'main', 'respond', 'error'}


def test_schema_pointer_supports_conditional_properties_and_prefix_items():
    schema = {'type': 'object', 'properties': {'variant': {'type': 'string'}},
              'if': {'properties': {'variant': {'const': 'a'}}},
              'then': {'properties': {'extra': {'type': 'array', 'prefixItems': [{'type': 'integer'}], 'items': False}}},
              'else': {'properties': {'reason': {'type': 'string'}}}}
    assert schema_at_pointer(schema, '/extra/0') == {'type': 'integer'}
    plan = graph()
    for node in plan['nodes'][:3]:
        node['condition'] = condition('/extra/0', 'gte', 1)
    assert validate_policy_graph(plan, schema) == []


@pytest.mark.asyncio
@pytest.mark.parametrize('text,action,status', [('배송', 'main', 'allow'), ('날씨', 'respond', 'allow'), ('위험', 'error', 'block')])
async def test_engine_v2_three_routes_private_output_and_safe_path(text, action, status):
    state, workflow = fixture()
    events = []
    result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(text), on_progress=events.append)
    assert result['status'] == status and result['policyRoute'] == action
    assert result['policyPath'][0] == 'branch' and result['policyPath'][-1] == f'{action}-action'
    assert 'policyDecision' not in result and 'PRIVATE_POLICY_OUTPUT' not in json.dumps(result)
    traces = [trace for trace in result['traces'] if trace.get('traceType') == 'policy']
    assert [trace['ruleId'] for trace in traces] == [f'policy:{node}' for node in result['policyPath']]
    assert events[-1]['stage'] == 'complete'
    if action == 'error':
        assert result['output'] == '' and result['policyCode'] == 'RISK_RESTRICTED'
    if action != 'main':
        assert next(trace for trace in result['traces'] if trace['ruleId'] == 'main')['status'] == 'skipped'


@pytest.mark.asyncio
@pytest.mark.parametrize('unified', [False, True], ids=['legacy-condition-kinds', 'unified-conditions'])
async def test_v2_mandatory_pre_and_post_cannot_be_bypassed(unified):
    state, workflow = fixture()
    if unified:
        workflow['policyRouting']['graph'] = unified_graph()
    workflow['pre'] = [post_rule('위험')]
    result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages('위험'))
    assert result['status'] == 'block' and 'policyRoute' not in result and result['output'] == ''
    workflow['pre'] = []
    workflow['post'] = [post_rule()]
    workflow['responseRetry'] = {'enabled': True, 'maxRetries': 3}
    next(node for node in workflow['policyRouting']['graph']['nodes'] if node.get('action') == 'respond')['responseText'] = 'PRIVATE_REGISTERED_RESPONSE'
    result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages('날씨'))
    assert result['status'] == 'block' and result['stage'] == 'post' and result['output'] == ''
    assert len(result['attempts']) == 1 and result['regenerationCount'] == 0
    assert 'PRIVATE_REGISTERED_RESPONSE' not in json.dumps(result)


@pytest.mark.asyncio
async def test_v2_graph_cannot_execute_invalid_model_output_or_leak_model_text():
    state, workflow = fixture(actual=True)
    calls = []
    async def fetch(request):
        calls.append(json.loads(request.content))
        return generated(json.dumps({**output(), 'undeclared': 'PRIVATE_MODEL_LEAK'}))
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(), client=client)
    assert result['status'] == 'error' and result['stage'] == 'pre' and result['output'] == ''
    assert 'policyPath' not in result and 'PRIVATE_' not in json.dumps(result) and len(calls) == 1


@pytest.mark.asyncio
async def test_v2_output_never_enters_main_or_repair_messages_and_policy_runs_once():
    state, workflow = fixture(actual=True)
    workflow['post'] = [post_rule('BAD_ANSWER')]
    workflow['responseRetry'] = {'enabled': True, 'maxRetries': 3}
    calls, main = [], []
    async def fetch(request):
        body = json.loads(request.content)
        calls.append(body)
        if body['model'] == 'policy-model':
            return generated(json.dumps(output()))
        main.append(body)
        return generated('BAD_ANSWER' if len(main) < 4 else 'safe')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(), client=client)
    assert result['status'] == 'allow' and len(calls) == 5 and len(main) == 4 and result['regenerationCount'] == 3
    assert result['usage']['total_tokens'] == 20
    assert 'PRIVATE_POLICY_OUTPUT' not in json.dumps(main) and main[0]['messages'] == messages()
    assert calls[0]['max_tokens'] == 1024


def test_v2_fingerprint_tracks_graph_schema_and_conditions_but_ignores_node_names():
    state, workflow = fixture()
    original = configuration_fingerprint(workflow, state['connections'])
    renamed = copy.deepcopy(workflow)
    renamed['policyRouting']['graph']['nodes'][0]['name'] = '새 이름'
    assert configuration_fingerprint(renamed, state['connections']) == original
    for field in ('condition', 'edge', 'schema', 'output-limit'):
        changed = copy.deepcopy(workflow)
        routing = changed['policyRouting']
        if field == 'condition': routing['graph']['nodes'][1]['condition']['predicates'][0]['value'] = 90
        elif field == 'edge': routing['graph']['edges'][2]['to'] = 'respond-action'
        elif field == 'schema': routing['policy']['outputSchema']['properties']['risk']['properties']['score']['maximum'] = 99
        else: routing['policy']['maxOutputTokens'] = 2048
        assert configuration_fingerprint(changed, state['connections']) != original


def test_v2_compatibility_uses_actions_and_rejects_v1_decision_expectation():
    _, workflow = fixture()
    dataset = {'rows': [{'id': 'a', 'input': '배송', 'expected': 'allow', 'expectedRoute': 'main'},
                        {'id': 'b', 'input': '위험', 'expected': 'block', 'expectedRoute': 'error', 'expectedPolicyCode': 'RISK_RESTRICTED'}]}
    assert inspect_dataset_compatibility(dataset, workflow)['issues'] == []
    dataset['rows'][0]['expectedDecision'] = 'IN_SCOPE'
    assert inspect_dataset_compatibility(dataset, workflow)['issues'][0]['code'] == 'missing_policy_decision'


@pytest.fixture
async def api_fixture():
    store = Store()
    await store.seed()
    state, workflow = fixture()
    for connection in state['connections']:
        await store.save_connection(connection)
    env = {}
    app = FastAPI()
    app.include_router(create_router(store, env))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=('127.0.0.1', 1)), base_url='http://test') as client:
        yield client, store, env, workflow
    await store.close()


async def save_workflow(client, workflow):
    definition = {key: value for key, value in workflow['policyRouting']['policy'].items() if key not in {'connectionSnapshot', 'version', 'updatedAt'}}
    saved = await client.post('/api/console', json={'action': 'save_policy', 'policy': definition, 'expectedVersion': 0})
    assert saved.status_code == 200, saved.text
    workflow = copy.deepcopy(workflow)
    workflow['policyRouting']['policy'] = saved.json()['policy']
    response = await client.post('/api/console', json={'action': 'save_workflow', 'workflow': workflow})
    assert response.status_code == 200, response.text
    return workflow


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['branch', 'rule'])
async def test_api_saves_two_node_conditions_but_rejects_incomplete_graphs(api_fixture, kind):
    client, store, _, workflow = api_fixture
    workflow['policyRouting']['graph'] = compact_graph(kind)
    workflow = await save_workflow(client, workflow)
    saved = next(value for value in (await store.state())['workflows'] if value['id'] == workflow['id'])
    assert saved['policyRouting']['graph'] == compact_graph(kind)
    for graph_draft in ({'version': 1, 'entryNodeId': '', 'nodes': [], 'edges': []},
                        {**compact_graph(kind), 'edges': []}):
        incomplete = copy.deepcopy(saved)
        incomplete['policyRouting']['graph'] = graph_draft
        response = await client.post('/api/console', json={'action': 'save_workflow', 'workflow': incomplete})
        assert response.status_code == 400, response.text
        current = next(value for value in (await store.state())['workflows'] if value['id'] == saved['id'])
        assert current['policyRouting']['graph'] == saved['policyRouting']['graph']


@pytest.mark.asyncio
@pytest.mark.parametrize('unified', [False, True], ids=['legacy-condition-kinds', 'unified-conditions'])
async def test_v2_gateway_and_dataset_evaluation_share_immutable_graph_and_safe_logs(api_fixture, unified):
    client, store, _, workflow = api_fixture
    if unified:
        workflow['policyRouting']['graph'] = unified_graph()
    workflow = await save_workflow(client, workflow)
    response = await client.post('/api/console', json={'action': 'publish', 'workflowId': workflow['id'], 'acknowledgeUnverified': True, 'unverifiedReason': 'local regression'})
    assert response.status_code == 200, response.text
    deployment = response.json()['deployment']
    key_response = await client.post('/api/console', json={'action': 'create_key', 'name': 'local regression'})
    key = key_response.json()['key']
    for text, status in [('배송', 200), ('날씨', 200), ('위험', 403)]:
        response = await client.post('/v1/chat/completions', headers={'Authorization': f'Bearer {key}'}, json={'model': workflow['alias'], 'messages': messages(text)})
        assert response.status_code == status, response.text
        assert 'PRIVATE_POLICY_OUTPUT' not in response.text
        if status == 403:
            assert response.json()['error']['policyCode'] == 'RISK_RESTRICTED'
    dataset = {'id': 'v2-graph-data', 'name': '정책 경로 검증', 'description': '', 'rows': [
        {'id': 'main', 'input': '배송', 'expected': 'allow', 'expectedRoute': 'main'},
        {'id': 'respond', 'input': '날씨', 'expected': 'allow', 'expectedRoute': 'respond'},
        {'id': 'error', 'input': '위험', 'expected': 'block', 'expectedRoute': 'error', 'expectedPolicyCode': 'RISK_RESTRICTED'}]}
    assert (await client.post('/api/console', json={'action': 'save_dataset', 'dataset': dataset})).status_code == 200
    evaluated = await client.post('/api/console', json={'action': 'run_evaluation', 'workflowId': workflow['id'], 'datasetId': dataset['id'], 'target': 'deployed'})
    assert evaluated.status_code == 200, evaluated.text
    run = evaluated.json()['run']
    assert run['status'] == 'completed' and all(row['expectationMatched'] for row in run['results'])
    assert 'PRIVATE_POLICY_OUTPUT' not in json.dumps(run['results'])
    assert run['workflowSnapshot']['policyRouting']['graph'] == deployment['workflow']['policyRouting']['graph']
    logs = (await store.state())['logs']
    assert len([log for log in logs if log.get('policyPath')]) == 6
    assert 'PRIVATE_POLICY_OUTPUT' not in json.dumps(logs)


@pytest.mark.asyncio
async def test_v2_policy_test_returns_flags_without_actual_output_and_compares_semantically(api_fixture):
    client, _, _, workflow = api_fixture
    definition = {key: value for key, value in workflow['policyRouting']['policy'].items() if key not in {'connectionSnapshot', 'version', 'updatedAt'}}
    response = await client.post('/api/console', json={'action': 'test_policy', 'policy': definition})
    assert response.status_code == 200, response.text
    results = response.json()['policyTest']['results']
    assert all(row['status'] == 'pass' and row['schemaValid'] and row['expectationMatched'] for row in results)
    assert 'PRIVATE_POLICY_OUTPUT' not in json.dumps(results)
    assert all(set(row) == {'exampleId', 'status', 'schemaValid', 'expectationMatched', 'message'} for row in results)


@pytest.mark.asyncio
async def test_v2_workflow_rejects_boolean_number_snapshot_forgery(api_fixture):
    client, _, _, workflow = api_fixture
    policy = workflow['policyRouting']['policy']
    policy['outputSchema'] = {'enum': [True, 1]}
    for example in policy['examples']:
        example['expectedOutput'] = 1
    for node in workflow['policyRouting']['graph']['nodes'][:3]:
        node['condition'] = condition()
    workflow = await save_workflow(client, workflow)
    forged = copy.deepcopy(workflow)
    forged['policyRouting']['policy']['examples'][0]['expectedOutput'] = True
    # Python's ordinary dict equality considers these the same; JSON does not.
    assert forged['policyRouting']['policy'] == workflow['policyRouting']['policy']
    response = await client.post('/api/console', json={'action': 'save_workflow', 'workflow': forged})
    assert response.status_code == 400
    assert response.json()['error']['code'] == 'invalid_policy_snapshot'
