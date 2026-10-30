"""Switch selects one bounded DAG output from validated JSON scalar values."""
import json

import httpx
import pytest
from pydantic import ValidationError

from aegis import engine
from aegis.policy_graph import execute_policy_graph, validate_policy_graph
from aegis.schemas import PolicyGraph, PolicyRouting
from test_policy_graph import condition, fixture, generated, messages, post_rule


def switch_graph(path='/value', values=None):
    values = ['ALLOW', 1, True, None] if values is None else values
    cases = [{'id': f'case-{index}', 'value': value} for index, value in enumerate(values)]
    actions = [{'id': f'action-{index}', 'name': '등록 응답', 'kind': 'action',
                'action': 'respond', 'responseText': f'경로 {index}'} for index in range(len(cases))]
    return {'version': 1, 'entryNodeId': 'switch', 'nodes': [
        {'id': 'switch', 'name': '값 선택', 'kind': 'switch', 'path': path, 'cases': cases},
        *actions,
        {'id': 'fallback', 'name': '기본 처리', 'kind': 'action', 'action': 'error',
         'errorCode': 'NO_MATCH', 'errorMessage': '등록된 경로가 없습니다.'}],
        'edges': [*({'id': f'edge-{index}', 'from': 'switch', 'to': f'action-{index}', 'port': case['id']}
                    for index, case in enumerate(cases)),
                  {'id': 'edge-default', 'from': 'switch', 'to': 'fallback', 'port': 'default'}]}


def switch_schema():
    return {'type': 'object', 'properties': {'value': {'type': ['string', 'number', 'boolean', 'null', 'object', 'array']}},
            'additionalProperties': False}


def switch_fixture(*, actual=False):
    state, workflow = fixture(actual=actual)
    policy = workflow['policyRouting']['policy']
    policy['outputSchema'] = switch_schema()
    policy['examples'] = [{'id': 'example', 'input': '배송', 'expectedOutput': {'value': 'ALLOW'}}]
    workflow['policyRouting']['graph'] = switch_graph()
    return state, workflow


@pytest.mark.parametrize('value,expected', [
    ('ALLOW', 'action-0'), (1, 'action-1'), (1.0, 'action-1'), (True, 'action-2'), (None, 'action-3'),
    ('allow', 'fallback'), (' ALLOW', 'fallback'), ('ALLOW ', 'fallback'), ('1', 'fallback'),
    (False, 'fallback'), (0, 'fallback'), ({}, 'fallback'), ([], 'fallback'),
])
def test_switch_selects_exactly_one_case_without_coercion(value, expected):
    graph = switch_graph()
    assert validate_policy_graph(graph, switch_schema()) == []
    result = execute_policy_graph(graph, {'value': value})
    assert result['path'] == ['switch', expected]
    assert result['route']['id'] == expected


def test_missing_field_is_distinct_from_null_and_null_survives_exclude_none():
    graph = switch_graph()
    assert execute_policy_graph(graph, {})['path'] == ['switch', 'fallback']
    assert execute_policy_graph(graph, {'value': None})['path'] == ['switch', 'action-3']
    model = PolicyGraph.model_validate(graph)
    assert model.model_dump(by_alias=True, exclude_none=True) == graph
    assert json.loads(model.model_dump_json(by_alias=True, exclude_none=True)) == graph
    _, workflow = switch_fixture()
    assert PolicyRouting.model_validate(workflow['policyRouting']).model_dump(by_alias=True, exclude_none=True)['graph'] == graph


@pytest.mark.parametrize('path,schema,value', [
    ('/risk/level', {'type': 'object', 'properties': {'risk': {'type': 'object', 'properties': {'level': {'type': 'string'}}}}}, {'risk': {'level': 'ALLOW'}}),
    ('/a~1b/~0key/0', {'type': 'object', 'properties': {'a/b': {'type': 'object', 'properties': {'~key': {'type': 'array', 'items': {'type': 'string'}}}}}}, {'a/b': {'~key': ['ALLOW']}}),
    ('', {'type': 'string'}, 'ALLOW'),
    ('/', {'type': 'object', 'properties': {'': {'type': 'string'}}}, {'': 'ALLOW'}),
    ('/ key ', {'type': 'object', 'properties': {' key ': {'type': 'string'}}}, {' key ': 'ALLOW'}),
])
def test_switch_uses_json_pointer_including_nested_escaped_root_and_literal_whitespace(path, schema, value):
    graph = switch_graph(path, ['ALLOW'])
    assert validate_policy_graph(graph, schema) == []
    assert execute_policy_graph(graph, value)['path'] == ['switch', 'action-0']


@pytest.mark.parametrize('values', [[True, 1, '1', None], [False, 0, '0', ''], ['ALLOW', 'allow', ' ALLOW', 'ALLOW ']])
def test_different_json_types_and_untrimmed_strings_are_distinct_cases(values):
    graph = switch_graph(values=values)
    assert validate_policy_graph(graph, switch_schema()) == []
    for index, value in enumerate(values):
        assert execute_policy_graph(graph, {'value': value})['path'] == ['switch', f'action-{index}']


def test_switch_supports_twelve_cases_and_shared_terminal_in_two_node_graph():
    graph = switch_graph(values=[f'value-{index}' for index in range(12)])
    graph['nodes'] = [graph['nodes'][0], graph['nodes'][-1]]
    for edge in graph['edges']:
        edge['to'] = 'fallback'
    assert validate_policy_graph(graph, switch_schema()) == []
    assert PolicyGraph.model_validate(graph).model_dump(by_alias=True, exclude_none=True) == graph
    assert execute_policy_graph(graph, {'value': 'value-11'})['path'] == ['switch', 'fallback']


@pytest.mark.parametrize('mutation', [
    'empty-cases', 'too-many-cases', 'duplicate-id', 'reserved-id', 'unsafe-id', 'long-id',
    'duplicate-value', 'duplicate-number', 'missing-value', 'object-value', 'array-value',
    'unsafe-number', 'infinite-number', 'nan-number', 'oversized-value', 'invalid-unicode',
    'missing-case-edge', 'missing-default', 'duplicate-edge-port', 'unknown-edge-port',
    'unknown-path', 'invalid-pointer', 'too-deep-pointer', 'too-long-pointer', 'invalid-unicode-path',
    'schema-type', 'cycle', 'unreachable', 'action-outgoing',
])
def test_switch_rejects_invalid_cases_paths_and_topology_without_private_literals(mutation):
    graph, schema = switch_graph(), switch_schema()
    switch = graph['nodes'][0]
    if mutation == 'empty-cases': switch['cases'] = []
    elif mutation == 'too-many-cases': switch['cases'] *= 4
    elif mutation == 'duplicate-id': switch['cases'][1]['id'] = switch['cases'][0]['id']
    elif mutation == 'reserved-id': switch['cases'][0]['id'] = 'default'
    elif mutation == 'unsafe-id': switch['cases'][0]['id'] = 'PRIVATE_VALUE.bad'
    elif mutation == 'long-id': switch['cases'][0]['id'] = 'x' * 81
    elif mutation == 'duplicate-value': switch['cases'][1]['value'] = switch['cases'][0]['value']
    elif mutation == 'duplicate-number': switch['cases'][0]['value'] = 1.0
    elif mutation == 'missing-value': switch['cases'][0].pop('value')
    elif mutation == 'object-value': switch['cases'][0]['value'] = {'PRIVATE_VALUE': 'hidden'}
    elif mutation == 'array-value': switch['cases'][0]['value'] = ['PRIVATE_VALUE']
    elif mutation == 'unsafe-number': switch['cases'][0]['value'] = 9007199254740992
    elif mutation == 'infinite-number': switch['cases'][0]['value'] = float('inf')
    elif mutation == 'nan-number': switch['cases'][0]['value'] = float('nan')
    elif mutation == 'oversized-value': switch['cases'][0]['value'] = 'x' * 4097
    elif mutation == 'invalid-unicode': switch['cases'][0]['value'] = '\ud800'
    elif mutation == 'missing-case-edge': graph['edges'].pop(0)
    elif mutation == 'missing-default': graph['edges'].pop()
    elif mutation == 'duplicate-edge-port': graph['edges'][1]['port'] = graph['edges'][0]['port']
    elif mutation == 'unknown-edge-port': graph['edges'][0]['port'] = 'unknown'
    elif mutation == 'unknown-path': switch['path'] = '/PRIVATE_VALUE'
    elif mutation == 'invalid-pointer': switch['path'] = '/~bad'
    elif mutation == 'too-deep-pointer': switch['path'] = '/a' * 13
    elif mutation == 'too-long-pointer': switch['path'] = '/' + 'x' * 512
    elif mutation == 'invalid-unicode-path': switch['path'] = '/\ud800'
    elif mutation == 'schema-type': schema['properties']['value'] = {'type': 'string'}
    elif mutation == 'cycle': graph['edges'][0]['to'] = 'switch'
    elif mutation == 'unreachable': graph['nodes'].append({'id': 'unused', 'name': '미연결', 'kind': 'action', 'action': 'main'})
    elif mutation == 'action-outgoing': graph['edges'].append({'id': 'invalid', 'from': 'fallback', 'to': 'action-0', 'port': 'default'})
    errors = validate_policy_graph(graph, schema)
    assert errors and 'PRIVATE_VALUE' not in json.dumps(errors)
    _, workflow = switch_fixture()
    workflow['policyRouting']['graph'] = graph
    workflow['policyRouting']['policy']['outputSchema'] = schema
    # An explicit null value is valid; an omitted comparison is always invalid.
    with pytest.raises((ValueError, ValidationError)):
        PolicyRouting.model_validate(workflow['policyRouting'])


def test_switch_and_conditions_chain_without_executing_unselected_paths():
    graph = switch_graph(values=['ALLOW'])
    graph['nodes'].insert(1, {'id': 'condition', 'name': '추가 조건', 'kind': 'branch', 'condition': condition('/value', 'eq', 'ALLOW')})
    graph['edges'][0]['to'] = 'condition'
    graph['edges'].extend([
        {'id': 'true-edge', 'from': 'condition', 'to': 'action-0', 'port': 'true'},
        {'id': 'false-edge', 'from': 'condition', 'to': 'fallback', 'port': 'false'},
    ])
    assert validate_policy_graph(graph, switch_schema()) == []
    assert execute_policy_graph(graph, {'value': 'ALLOW'})['path'] == ['switch', 'condition', 'action-0']
    assert execute_policy_graph(graph, {'value': 'UNKNOWN'})['path'] == ['switch', 'fallback']
    # Either condition kind can also enter the Switch, preserving existing IDs.
    graph['entryNodeId'] = 'condition'
    graph['edges'] = [edge for edge in graph['edges'] if edge['from'] != 'condition']
    graph['edges'][0]['to'] = 'action-0'
    graph['edges'].extend([
        {'id': 'true-edge', 'from': 'condition', 'to': 'switch', 'port': 'true'},
        {'id': 'false-edge', 'from': 'condition', 'to': 'fallback', 'port': 'false'},
    ])
    assert validate_policy_graph(graph, switch_schema()) == []
    assert execute_policy_graph(graph, {'value': 'ALLOW'})['path'] == ['condition', 'switch', 'action-0']


def test_switch_fails_closed_if_duplicate_matching_cases_reach_execution():
    graph = switch_graph(values=[1, 1.0])
    with pytest.raises(engine.PolicyError):
        execute_policy_graph(graph, {'value': 1})


@pytest.mark.parametrize('limit', ['nodes', 'edges'])
def test_switch_keeps_existing_graph_size_limits(limit):
    graph = switch_graph()
    if limit == 'nodes':
        graph['nodes'].extend({'id': f'extra-{index}', 'name': '추가 동작', 'kind': 'action', 'action': 'main'} for index in range(19))
    else:
        graph['edges'].extend({'id': f'extra-{index}', 'from': 'switch', 'to': 'fallback', 'port': 'default'} for index in range(44))
    assert validate_policy_graph(graph, switch_schema())
    with pytest.raises(ValueError):
        PolicyGraph.model_validate(graph)


@pytest.mark.asyncio
@pytest.mark.parametrize('value,expected_action', [('ALLOW', 'respond'), ('UNKNOWN', 'error')])
async def test_engine_switch_uses_private_validated_output_and_skips_main(value, expected_action):
    state, workflow = switch_fixture(actual=True)
    calls, events = [], []
    async def fetch(request):
        calls.append(json.loads(request.content))
        return generated(json.dumps({'value': value}))
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(), client=client, on_progress=events.append)
    assert result['policyRoute'] == expected_action and len(calls) == 1
    assert result['policyPath'] == ['switch', 'action-0' if expected_action == 'respond' else 'fallback']
    assert next(trace for trace in result['traces'] if trace['ruleId'] == 'main')['status'] == 'skipped'
    assert all('value' not in trace for trace in result['traces'])
    assert not any('output' in event for event in events)
    if expected_action == 'error':
        assert result['status'] == 'block' and result['output'] == ''


@pytest.mark.asyncio
@pytest.mark.parametrize('raw', ['{"value":"PRIVATE_OUTPUT","undeclared":true}', '{invalid PRIVATE_OUTPUT', '{"value":NaN}'])
async def test_schema_invalid_output_never_executes_switch_or_main(monkeypatch, raw):
    import aegis.policy_graph as policy_graph
    state, workflow = switch_fixture(actual=True)
    def must_not_execute(*args, **kwargs):
        pytest.fail('Switch must not execute before output schema validation succeeds')
    monkeypatch.setattr(policy_graph, 'execute_policy_graph', must_not_execute)
    calls = []
    async def fetch(request):
        calls.append(json.loads(request.content))
        return generated(raw)
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages(), client=client)
    assert result['status'] == 'error' and result['stage'] == 'pre' and result['output'] == ''
    assert len(calls) == 1 and 'policyPath' not in result and 'PRIVATE_OUTPUT' not in json.dumps(result)


@pytest.mark.asyncio
async def test_pre_block_skips_switch_and_post_block_hides_registered_answer():
    state, workflow = switch_fixture()
    workflow['pre'] = [post_rule('배송')]
    result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages())
    assert result['status'] == 'block' and 'policyPath' not in result
    workflow['pre'] = []
    workflow['post'] = [post_rule('PRIVATE_RESPONSE')]
    workflow['responseRetry'] = {'enabled': True, 'maxRetries': 3}
    workflow['policyRouting']['graph']['nodes'][1]['responseText'] = 'PRIVATE_RESPONSE'
    result = await engine.execute_workflow(workflow, state['connections'], state['ingress'], {}, messages())
    assert result['status'] == 'block' and result['stage'] == 'post' and result['output'] == ''
    assert result['regenerationCount'] == 0 and 'PRIVATE_RESPONSE' not in json.dumps(result)
