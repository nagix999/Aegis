import asyncio
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3
import uuid

import pytest

from aegis.store import Store, DeploymentRequestConflict, ModelCapacityError, UNSET, dump, iso_at, now_ms


@pytest.fixture
async def store():
    value = Store()
    await value.seed()
    yield value
    await value.close()


def deployment(identifier='deployment-1', alias='support-assistant'):
    return {'id': identifier, 'workflowId': 'wf-support', 'alias': alias, 'createdAt': iso_at(),
            'workflow': {'id': 'wf-support', 'alias': alias}, 'connections': []}


def event(identifier='audit-1'):
    return {'id': identifier, 'actor': 'admin', 'action': 'publish', 'target': 'wf-support', 'createdAt': iso_at(), 'detail': '완료'}


def request_log(identifier, created=None):
    return {'id': identifier, 'source': 'gateway', 'workflowName': '상담', 'workflowId': 'wf-support', 'version': 'v1',
            'createdAt': created or iso_at(), 'status': 'block', 'stage': 'post', 'latencyMs': 1, 'reason': 'SECRET_INPUT',
            'traces': [{'ruleId': 'rule', 'ruleName': '검사', 'stage': 'post', 'groupId': 'group', 'status': 'block', 'latencyMs': 1, 'reason': 'SECRET_INPUT'}],
            'attempts': [{'number': 1, 'stage': 'post', 'status': 'block', 'latencyMs': 1, 'reason': 'SECRET_INPUT'}],
            'flowTraces': [{'nodeId': 'group:group', 'stage': 'post', 'status': 'block', 'edgeIds': ['edge'], 'attempt': 1}],
            'output': 'SECRET_OUTPUT', 'messages': [{'role': 'user', 'content': 'SECRET_INPUT'}]}


async def test_import_existing_node_sqlite_preserves_payload_keys_and_history(tmp_path):
    database = tmp_path / 'existing.sqlite'
    raw = sqlite3.connect(database)
    root = Path(__file__).resolve().parents[2]
    for file in sorted((root / 'drizzle').glob('[0-9]*.sql')):
        raw.executescript(file.read_text())
    old_payload = '{"id":"legacy-workflow", "name":"기존 설정", "updatedAt":"2026-10-01T00:00:00.000Z"}'
    raw.execute('INSERT INTO aegis_records(namespace,id,payload,updated_at) VALUES(?,?,?,?)', ('workflow', 'legacy-workflow', old_payload, iso_at()))
    key = 'ag_' + 'a' * 64
    raw.execute('INSERT INTO aegis_gateway_keys VALUES(?,?,?,?,?,?)', ('legacy-key', '기존 키', key[:11], hashlib.sha256(key.encode()).hexdigest(), iso_at(), 0))
    raw.execute('INSERT INTO aegis_deployments VALUES(?,?,?,?,?,?)', ('legacy-deploy', 'legacy-workflow', 'legacy-model', 1, dump({'workflow': {'id': 'legacy-workflow'}}), iso_at()))
    raw.commit()
    raw.close()
    # Import an exported schema without the Node runtime migration ledger.
    migrated = Store(database)
    captured = await migrated.get_record_with_version('workflow', 'legacy-workflow')
    assert captured['revision'] == old_payload
    assert (await migrated.authenticate(key))['id'] == 'legacy-key'
    assert (await migrated.get_deployment('legacy-deploy'))['version'] == 1
    assert await migrated.compare_and_swap('workflow', 'legacy-workflow', old_payload, {'id': 'legacy-workflow', 'name': '수정'})
    assert not await migrated.compare_and_swap('workflow', 'legacy-workflow', old_payload, {'id': 'legacy-workflow', 'name': '오래된 수정'})
    await migrated.close()
    reopened = Store(database)
    assert (await reopened.get_record('workflow', 'legacy-workflow'))['name'] == '수정'
    assert {row[0] for row in reopened.db.execute('SELECT name FROM _aegis_local_migrations')} == {
        '0000_brief_unicorn.sql', '0001_record_revisions.sql', '0002_admin_sessions.sql',
    }
    await reopened.close()


async def test_checked_saves_advance_revisions_and_enforce_capacity(store):
    workflow = (await store.state())['workflows'][0]
    original = workflow['updatedAt']
    assert await store.save_record_checked('workflow', workflow['id'], {**workflow, 'name': 'first'}, original)
    first = await store.get_record('workflow', workflow['id'])
    assert first['updatedAt'] > original
    assert not await store.save_record_checked('workflow', workflow['id'], {**workflow, 'name': 'stale'}, original)
    assert not await store.save_record_checked('workflow', workflow['id'], workflow, None)
    for i in range(29):
        assert await store.save_record_checked('workflow', f'w-{i}', {'id': f'w-{i}'}, None)
    assert not await store.save_record_checked('workflow', 'overflow', {'id': 'overflow'}, UNSET)
    assert (await store.get_record('workflow', workflow['id']))['name'] == 'first'


async def test_deployment_audit_and_idempotency_are_one_transaction(store, monkeypatch):
    captured = await store.get_record_with_version('workflow', 'wf-support')
    checks = [{'namespace': 'workflow', 'id': 'wf-support', 'revision': captured['revision']}]
    command = {'id': 'request-one', 'requestHash': 'same-hash'}
    original = store._put
    def fail_audit(namespace, *args, **kwargs):
        if namespace == 'audit':
            raise sqlite3.OperationalError('fault injected')
        return original(namespace, *args, **kwargs)
    monkeypatch.setattr(store, '_put', fail_audit)
    with pytest.raises(sqlite3.OperationalError):
        await store.deploy_checked(deployment(), checks, {'audit': event(), 'request': command})
    assert store.db.execute('SELECT COUNT(*) FROM aegis_deployments').fetchone()[0] == 0
    assert await store.deployment_for_request(command) is None
    monkeypatch.setattr(store, '_put', original)
    saved = await store.deploy_checked(deployment(), checks, {'audit': event(), 'request': command})
    assert saved['version'] == 1
    replayed = await store.deploy_checked(deployment('deployment-2'), [], {'audit': event('audit-2'), 'request': command})
    assert replayed['id'] == saved['id']
    assert store.db.execute("SELECT COUNT(*) FROM aegis_records WHERE namespace='audit'").fetchone()[0] == 1
    with pytest.raises(DeploymentRequestConflict):
        await store.deployment_for_request({**command, 'requestHash': 'changed'})
    await store.put('workflow', 'wf-support', {**captured['value'], 'name': 'changed'})
    assert await store.deploy_checked(deployment('stale'), checks) is None


async def test_multiple_store_instances_atomically_reserve_quota_and_refund(tmp_path):
    first, second = Store(tmp_path / 'shared.sqlite'), Store(tmp_path / 'shared.sqlite')
    key = (await first.create_key('client', {'maxConcurrent': 1, 'rpmLimit': 3, 'tpmLimit': 100}))['summary']
    def attempt(store):
        return asyncio.run(store.reserve_quota(key, 50, 60_000))
    a, b = await asyncio.gather(asyncio.to_thread(attempt, first), asyncio.to_thread(attempt, second))
    reserved = next(result['reservation'] for result in (a, b) if 'reservation' in result)
    assert sum('reservation' in result for result in (a, b)) == 1
    assert next(result['denied'] for result in (a, b) if 'denied' in result) == 'concurrency_limit'
    await first.release_quota(reserved, 10)
    await second.release_quota(reserved, 90)  # duplicate release must not charge twice
    usage = await first.get_record('key_usage', key['id'])
    assert usage['tokens'] == 10 and not usage['leases']
    assert (await second.reserve_quota(key, 91, 60_000))['denied'] == 'tpm_limit'
    await first.close()
    await second.close()


async def test_quota_window_reset_keeps_active_leases(store, monkeypatch):
    clock = 120_000
    monkeypatch.setattr('aegis.store.now_ms', lambda: clock)
    key = (await store.create_key('client', {'maxConcurrent': 1, 'rpmLimit': 1, 'tpmLimit': 100}))['summary']
    reservation = (await store.reserve_quota(key, 30, 180_000))['reservation']
    clock += 60_001
    assert (await store.reserve_quota(key, 10, 60_000))['denied'] == 'concurrency_limit'
    await store.release_quota(reservation, 9)
    assert 'reservation' in await store.reserve_quota(key, 100, 60_000)


async def test_shared_model_capacity_releases_and_recovers_expired_leases(tmp_path, monkeypatch):
    first, second = Store(tmp_path / 'models.sqlite'), Store(tmp_path / 'models.sqlite')
    clock = 1_000_000
    monkeypatch.setattr('aegis.store.now_ms', lambda: clock)
    lease = await first.acquire_model_capacity('main', 1, 1000)
    with pytest.raises(ModelCapacityError, match='동시 호출'):
        await second.acquire_model_capacity('main', 1, 1000)
    independent = await second.acquire_model_capacity('other', 1, 1000)
    await first.release_model_capacity(lease)
    lease = await second.acquire_model_capacity('main', 1, 1000)
    clock += 1001
    recovered = await first.acquire_model_capacity('main', 1, 1000)
    await second.release_model_capacity(lease)  # expired old caller cannot remove a new lease
    assert recovered['leaseId'] in (await first.get_record('model_capacity', 'main'))['leases']
    await first.release_model_capacity(recovered)
    await second.release_model_capacity(independent)
    await first.close()
    await second.close()


async def test_worker_state_and_cas_cancellation_preserve_completed_rows(store):
    assert await store.evaluation_worker_status() == {'available': False}
    assert (await store.heartbeat_evaluation_worker('worker', 'local'))['available']
    for index in range(4):
        assert await store.insert_evaluation_run({'id': f'run-{index}', 'status': 'running', 'executionMode': 'background', 'createdAt': iso_at(), 'workflowId': 'wf-support', 'results': []})
    assert not await store.insert_evaluation_run({'id': 'overflow', 'status': 'running'})
    assert len(await store.background_evaluation_ids()) == 4
    captured = await store.get_record_with_version('run', 'run-0')
    assert await store.compare_and_swap('run', 'run-0', captured['revision'], {**captured['value'], 'status': 'cancelled'})
    assert not await store.compare_and_swap('run', 'run-0', captured['revision'], {**captured['value'], 'results': [{'rowId': 'late'}]})
    status = await store.evaluation_status('run-0')
    assert status['run']['status'] == 'cancelled' and status['evaluationWorker']['available']


async def test_logs_are_sanitized_searchable_and_paginated(store):
    base = now_ms()
    for index in range(205):
        await store.log(request_log(f'request-{index:03}', iso_at(base - index * 1000)))
    state = await store.state()
    assert len(state['logs']) == 200
    assert 'SECRET_' not in dump(state['logs'])
    page = await store.search_logs({'workflowId': 'wf-support', 'source': 'gateway', 'limit': 100})
    assert page['total'] == 205 and len(page['logs']) == 100 and page['nextCursor']
    second = await store.search_logs({'workflowId': 'wf-support', 'limit': 100, 'cursor': page['nextCursor']})
    assert not {item['id'] for item in page['logs']} & {item['id'] for item in second['logs']}
    assert (await store.search_logs({'query': 'request-204'}))['logs'][0]['id'] == 'request-204'
    assert 'SECRET_' not in dump(await store.get_request_log('request-204'))
    for invalid in [{'cursor': 'bad'}, {'limit': 101}, {'from': 'bad-date'}, {'source': 'invalid'}]:
        with pytest.raises(ValueError):
            await store.search_logs(invalid)


async def test_proof_lookup_deduplicates_latest_and_passing_without_raw_payloads(store):
    dataset = (await store.state())['datasets'][0]
    for index in range(8):
        passed = index < 4
        run = {'id': f'proof-{index}', 'workflowId': 'wf-support', 'datasetId': dataset['id'], 'datasetName': dataset['name'],
               'createdAt': iso_at(now_ms() - index * 1000), 'status': 'completed', 'fingerprint': 'a' * 64, 'datasetFingerprint': 'b' * 64,
               'total': 1, 'datasetSnapshot': {'rows': [{'id': 'row'}]},
               'results': [{'rowId': 'row', 'expectationMatched': passed, 'input': 'PRIVATE_PROMPT', 'output': 'PRIVATE_ANSWER'}]}
        await store.put('run', run['id'], run)
    evidence = await store.verification_evidence('wf-support', 'a' * 64)
    assert [item['id'] for item in evidence] == ['proof-0', 'proof-1', 'proof-2']
    assert 'PRIVATE_' not in dump(evidence)
    await store.remove('dataset', dataset['id'])
    assert not await store.verification_evidence('wf-support', 'a' * 64)


async def test_retention_keeps_active_runs_and_immutable_deployments(store):
    old = iso_at(now_ms() - 100 * 86_400_000)
    await store.put('run', 'completed', {'id': 'completed', 'status': 'completed', 'createdAt': old})
    await store.put('run', 'running', {'id': 'running', 'status': 'running', 'createdAt': old})
    saved = await store.deploy({**deployment(), 'verificationSummaries': [{'runId': 'completed', 'total': 1, 'matchedCount': 1}]})
    await store.prune_retention({'logDays': 1, 'evaluationDays': 1, 'auditDays': 1})
    assert await store.get_record('run', 'completed') is None
    assert await store.get_record('run', 'running')
    assert (await store.get_deployment(saved['id']))['verificationSummaries'][0]['runId'] == 'completed'


async def test_active_deployment_and_legacy_request_lookup_handle_alias_rename(store):
    first = await store.deploy(deployment('first', 'old-alias'))
    second = await store.deploy(deployment('second', 'new-alias'))
    assert first['version'] == second['version'] == 1
    assert await store.get_deployment_for_request('wf-support', 1) is None
    assert (await store.active_deployment('old-alias'))['id'] == 'first'
    assert await store.active_model_summaries([]) == []
    assert [item['alias'] for item in await store.active_model_summaries(['new-alias'])] == ['new-alias']
