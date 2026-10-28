"""Migration regressions at the real application boundary, not router stubs."""
import base64
import copy

import httpx
import pytest

from aegis.main import create_app
from aegis.review import configuration_fingerprint, dataset_fingerprint
from aegis.store import Store


@pytest.fixture
async def app_fixture(tmp_path):
    frontend = tmp_path / 'frontend'
    frontend.mkdir()
    (frontend / 'index.html').write_text('<!doctype html><title>Aegis console</title>')
    (frontend / 'asset.js').write_text('window.consoleReady = true;')
    (tmp_path / 'private.txt').write_text('SHOULD_NEVER_BE_SERVED')
    (frontend / 'outside.txt').symlink_to(tmp_path / 'private.txt')
    store = Store()
    await store.seed()
    env = {'ADMIN_USER': 'admin', 'ADMIN_PASSWORD': 'test-password', 'AEGIS_ADMIN_TOKEN': 's' * 32,
           'AEGIS_FRONTEND_PATH': str(frontend), 'AEGIS_EVALUATION_WORKER_ENABLED': 'false'}
    app = create_app(env, store=store)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=('127.0.0.1', 1), raise_app_exceptions=False), base_url='http://test') as client:
        auth = {'Authorization': 'Basic ' + base64.b64encode(b'admin:test-password').decode()}
        yield client, store, env, auth
    await store.close()


@pytest.mark.parametrize('policy', [False, [], 0, ''])
async def test_falsey_nonobject_key_policy_does_not_create_unrestricted_key(app_fixture, policy):
    client, store, _, auth = app_fixture
    response = await client.post('/api/console', headers=auth, json={'action': 'create_key', 'name': 'malformed-policy', 'policy': policy})
    assert response.status_code == 400, response.text
    assert not (await store.state())['keys']


@pytest.mark.parametrize('policy', [False, [], 0, ''])
async def test_falsey_policy_cannot_erase_existing_model_restrictions(app_fixture, policy):
    client, store, _, auth = app_fixture
    saved = await client.post('/api/console', headers=auth, json={'action': 'create_key', 'name': 'restricted', 'policy': {'allowedModels': []}})
    assert saved.status_code == 200, saved.text
    key_id = saved.json()['state']['keys'][0]['id']
    response = await client.post('/api/console', headers=auth, json={'action': 'update_key_policy', 'id': key_id, 'policy': policy})
    assert response.status_code == 400, response.text
    assert (await store.state())['keys'][0]['policy']['allowedModels'] == []


@pytest.mark.parametrize('header', ['authorization', 'x-aegis-admin-token'])
async def test_nonascii_authentication_header_is_unauthorized_not_server_error(app_fixture, header):
    client, _, _, _ = app_fixture
    response = await client.get('/docs', headers=[(header.encode(), b'Bearer \xff')])
    assert response.status_code == 401
    assert response.json()['error']['code'] == 'unauthorized'
    assert 'Traceback' not in response.text


async def test_login_shell_is_public_and_docs_schema_other_static_and_console_stay_protected(app_fixture):
    client, _, _, auth = app_fixture
    shell = await client.get('/')
    assert shell.status_code == 200
    assert 'Aegis console' in shell.text
    assert shell.headers['cache-control'] == 'no-store'
    assert "frame-ancestors 'none'" in shell.headers['content-security-policy']
    for path in ['/asset.js', '/docs', '/openapi.json', '/api/console']:
        denied = await client.get(path, headers={'oai-authenticated-user-id': 'admin', 'x-real-ip': '127.0.0.1'})
        assert denied.status_code == 401, (path, denied.text)
        # A normal browser loads the application login form without a native
        # Basic-authentication popup. Explicit Basic callers remain supported.
        assert 'www-authenticate' not in denied.headers
        challenged = await client.get(path, auth=('admin', 'wrong-fixture-password'))
        assert challenged.status_code == 401
        assert challenged.headers['www-authenticate'].startswith('Basic')
        accepted = await client.get(path, headers=auth)
        assert accepted.status_code == 200, (path, accepted.text)
        assert accepted.headers['cache-control'] == 'no-store'
        assert accepted.headers['x-content-type-options'] == 'nosniff'
    health = await client.get('/healthz')
    assert health.status_code == 200
    assert health.json()['backend'] == 'python-fastapi'
    gateway = await client.get('/v1/models', headers=auth)
    assert gateway.status_code == 401
    assert gateway.json()['error']['code'] == 'invalid_api_key'


async def test_static_file_resolution_never_exposes_outside_directory(app_fixture):
    client, _, _, auth = app_fixture
    for path in ['/outside.txt', '/%2e%2e/private.txt']:
        response = await client.get(path, headers=auth)
        assert response.status_code == 404, response.text
        assert 'SHOULD_NEVER_BE_SERVED' not in response.text


async def test_invalid_mapped_detector_preserves_original_and_error_contract(app_fixture):
    client, store, _, auth = app_fixture
    state = await store.state()
    workflow = state['workflows'][0]
    dataset = copy.deepcopy(state['datasets'][0])
    dataset['rows'] = [{'id': 'r', 'input': 'case', 'expected': 'block', 'expectedStage': 'pre', 'expectedRuleId': 'old-rule'}]
    saved = await client.post('/api/console', headers=auth, json={'action': 'save_dataset', 'dataset': dataset})
    assert saved.status_code == 200, saved.text
    source = next(item for item in saved.json()['state']['datasets'] if item['id'] == dataset['id'])
    response = await client.post('/api/console', headers=auth, json={
        'action': 'create_mapped_dataset', 'sourceDatasetId': source['id'], 'workflowId': workflow['id'], 'target': 'draft',
        'expectedDatasetFingerprint': dataset_fingerprint(source), 'expectedWorkflowFingerprint': configuration_fingerprint(workflow, state['connections']),
        'mappings': {'old-rule': 'missing-target'}, 'name': 'must not create'})
    assert response.status_code == 400, response.text
    assert response.json()['error']['code'] == 'invalid_dataset_mapping'
    current = await store.state()
    assert current['datasets'] == saved.json()['state']['datasets']
