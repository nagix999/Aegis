"""Switch persistence, immutable releases and the shared Gateway/evaluation engine."""
import copy
import json

import httpx
import pytest
from fastapi import FastAPI

from aegis.api import create_router
from aegis.review import ENGINE_VERSION, configuration_fingerprint
from aegis.store import Store
from test_switch_policy_graph import switch_fixture


@pytest.fixture
async def switch_console(tmp_path):
    state, workflow = switch_fixture()
    policy = workflow['policyRouting']['policy']
    policy['outputSchema']['properties']['privateDetail'] = {'type': 'string'}
    values = [('배송', 'ALLOW'), ('숫자', 1), ('참', True), ('널', None), ('미등록', 'UNKNOWN')]
    policy['examples'] = [
        {'id': f'example-{index}', 'input': text, 'expectedOutput': {
            'value': value, 'privateDetail': 'PRIVATE_SWITCH_CLASSIFICATION'}}
        for index, (text, value) in enumerate(values)
    ] + [{'id': 'example-missing', 'input': '누락', 'expectedOutput': {'privateDetail': 'PRIVATE_SWITCH_CLASSIFICATION'}}]
    graph = workflow['policyRouting']['graph']
    graph['nodes'][1] = {'id': 'action-0', 'name': '응답 모델', 'kind': 'action', 'action': 'main'}
    store = Store(tmp_path / 'switch.sqlite')
    await store.seed()
    for connection in state['connections']:
        await store.save_connection(connection)
    app = FastAPI()
    app.include_router(create_router(store, {}))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=('127.0.0.1', 1)), base_url='http://test') as client:
            definition = {key: value for key, value in policy.items() if key not in {'connectionSnapshot', 'version', 'updatedAt'}}
            saved = await client.post('/api/console', json={'action': 'save_policy', 'policy': definition, 'expectedVersion': 0})
            assert saved.status_code == 200, saved.text
            workflow['policyRouting']['policy'] = saved.json()['policy']
            saved = await client.post('/api/console', json={'action': 'save_workflow', 'workflow': workflow})
            assert saved.status_code == 200, saved.text
            yield client, store, workflow
    finally:
        await store.close()


async def publish(client, workflow):
    response = await client.post('/api/console', json={
        'action': 'publish', 'workflowId': workflow['id'],
        'acknowledgeUnverified': True, 'unverifiedReason': 'Isolated Switch regression',
    })
    assert response.status_code == 200, response.text
    return response.json()['deployment']


async def gateway_key(client):
    response = await client.post('/api/console', json={'action': 'create_key', 'name': 'Switch regression'})
    assert response.status_code == 200, response.text
    return response.json()['key']


async def completion(client, workflow, key, text):
    return await client.post('/v1/chat/completions', headers={'Authorization': f'Bearer {key}'}, json={
        'model': workflow['alias'], 'messages': [{'role': 'user', 'content': text}],
    })


async def test_switch_gateway_and_evaluation_follow_same_typed_routes_without_raw_output(switch_console):
    client, store, workflow = switch_console
    deployed = await publish(client, workflow)
    assert deployed['engineVersion'] == ENGINE_VERSION
    key = await gateway_key(client)
    scenarios = [('배송', 'main', 200), ('숫자', 'respond', 200), ('참', 'respond', 200),
                 ('널', 'respond', 200), ('미등록', 'error', 403), ('누락', 'error', 403)]
    for text, action, status in scenarios:
        response = await completion(client, workflow, key, text)
        assert response.status_code == status, response.text
        assert 'PRIVATE_SWITCH_CLASSIFICATION' not in response.text
        if status == 403:
            assert response.json()['error']['policyCode'] == 'NO_MATCH'
    dataset = {'id': 'switch-data', 'name': 'Switch 자료형', 'description': '', 'rows': [
        {'id': f'row-{index}', 'input': text, 'expected': 'block' if status == 403 else 'allow',
         'expectedRoute': action, **({'expectedPolicyCode': 'NO_MATCH'} if status == 403 else {})}
        for index, (text, action, status) in enumerate(scenarios)
    ]}
    saved = await client.post('/api/console', json={'action': 'save_dataset', 'dataset': dataset})
    assert saved.status_code == 200, saved.text
    response = await client.post('/api/console', json={
        'action': 'run_evaluation', 'workflowId': workflow['id'], 'datasetId': dataset['id'], 'target': 'deployed',
    })
    assert response.status_code == 200, response.text
    run = response.json()['run']
    assert run['status'] == 'completed' and all(row['expectationMatched'] for row in run['results'])
    assert run['engineVersion'] == ENGINE_VERSION
    assert run['workflowSnapshot']['policyRouting']['graph'] == deployed['workflow']['policyRouting']['graph']
    assert [row['policyPath'] for row in run['results']] == [
        ['switch', node] for node in ('action-0', 'action-1', 'action-2', 'action-3', 'fallback', 'fallback')
    ]
    logs = (await store.state())['logs']
    assert len([log for log in logs if log.get('policyPath')]) == 12
    assert 'PRIVATE_SWITCH_CLASSIFICATION' not in json.dumps(run['results']) + json.dumps(logs)


async def test_switch_null_and_string_values_roundtrip_and_deployed_graph_is_immutable(switch_console):
    client, store, workflow = switch_console
    deployed = await publish(client, workflow)
    original = deployed['workflow']['policyRouting']['graph']
    assert original['nodes'][0]['cases'][3] == {'id': 'case-3', 'value': None}
    current = next(item for item in (await store.state())['workflows'] if item['id'] == workflow['id'])
    assert current['policyRouting']['graph'] == original
    before = configuration_fingerprint(current, (await store.state())['connections'])
    edited = copy.deepcopy(current)
    edited['policyRouting']['graph']['nodes'][0]['cases'][0]['value'] = ' ALLOW '
    response = await client.post('/api/console', json={'action': 'save_workflow', 'workflow': edited})
    assert response.status_code == 200, response.text
    state = (await client.get('/api/console')).json()['state']
    saved = next(item for item in state['workflows'] if item['id'] == workflow['id'])
    assert saved['policyRouting']['graph']['nodes'][0]['cases'][0]['value'] == ' ALLOW '
    assert saved['policyRouting']['graph']['nodes'][0]['cases'][3]['value'] is None
    assert configuration_fingerprint(saved, state['connections']) != before
    stored_release = next(item for item in state['deployments'] if item['id'] == deployed['id'])
    assert stored_release['workflow']['policyRouting']['graph'] == original
    response = await completion(client, workflow, await gateway_key(client), '배송')
    assert response.status_code == 200, response.text


@pytest.mark.parametrize('mutation', ['missing-default', 'duplicate-scalar', 'missing-null-value'])
async def test_invalid_switch_save_keeps_previous_persisted_graph(switch_console, mutation):
    client, store, workflow = switch_console
    edited = copy.deepcopy(workflow)
    graph = edited['policyRouting']['graph']
    if mutation == 'missing-default':
        graph['edges'] = [edge for edge in graph['edges'] if edge['port'] != 'default']
    elif mutation == 'duplicate-scalar':
        graph['nodes'][0]['cases'][0]['value'] = 1.0
    else:
        graph['nodes'][0]['cases'][3].pop('value')
    response = await client.post('/api/console', json={'action': 'save_workflow', 'workflow': edited})
    assert response.status_code == 400, response.text
    saved = next(item for item in (await store.state())['workflows'] if item['id'] == workflow['id'])
    assert saved['policyRouting']['graph'] == workflow['policyRouting']['graph']
