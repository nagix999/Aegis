import asyncio
import copy
import json
from pathlib import Path

import httpx
import pytest

from aegis.engine import execute_workflow, validate_workflow, validate_regex, parse_guard_verdict, PolicyError, check_rule
from aegis.runtime import ExecutionRuntime, execution_lease_duration, response_token_reservation


def seed():
    return json.loads((Path(__file__).parents[1] / 'aegis' / 'seed.json').read_text())


def setup():
    data = seed()
    workflow = copy.deepcopy(data['workflows'][0])
    workflow['pre'] = []
    workflow['post'] = []
    return data, workflow


def rule(identifier='r', kind='keyword', **config):
    return {'id': identifier, 'name': identifier, 'description': '', 'kind': kind, 'enabled': True, 'config': config}


def group(identifier='g', rules=None, mode='any'):
    return {'id': identifier, 'name': identifier, 'mode': mode, 'rules': rules or [rule(pattern='DENY')]}


def actual(data):
    connection = data['connections'][0]
    connection.update(mode='vllm', baseUrl='https://models.example/v1')
    data['ingress']['allowedOrigins'] = ['https://models.example']
    return connection


def generated(content, finish='stop'):
    return httpx.Response(200, json={'choices': [{'message': {'content': content}, 'finish_reason': finish}], 'usage': {'prompt_tokens': 2, 'completion_tokens': 3, 'total_tokens': 5}})


@pytest.mark.asyncio
async def test_seed_all_dataset_outcomes_and_blocked_output_masking():
    data = seed()
    decisions = []
    for row in data['datasets'][0]['rows']:
        result = await execute_workflow(data['workflows'][0], data['connections'], data['ingress'], {}, [{'role': 'user', 'content': row['input']}])
        decisions.append(result['status'])
        assert result['status'] == row['expected']
        if result['status'] != 'allow':
            assert result['output'] == ''
    assert decisions.count('allow') == 3


@pytest.mark.asyncio
async def test_input_scope_never_changes_original_generation_messages():
    data, workflow = setup()
    actual(data)
    workflow['pre'] = [group()]
    messages = [{'role': 'system', 'content': 'DENY'}, {'role': 'user', 'content': 'hello'}, {'role': 'assistant', 'content': 'DENY'}, {'role': 'user', 'content': 'latest'}]
    sent = []
    async def fetch(request):
        sent.append(json.loads(request.content))
        return generated('ok', 'length')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        blocked = await execute_workflow(workflow, data['connections'], data['ingress'], {}, messages, client=client)
        assert blocked['status'] == 'block' and not sent
        for scope in ('user_messages', 'last_user'):
            workflow['inputScope'] = scope
            allowed = await execute_workflow(workflow, data['connections'], data['ingress'], {}, messages, client=client)
            assert allowed['status'] == 'allow'
            assert allowed['finishReason'] == 'length'
            assert sent[-1]['messages'] == messages


@pytest.mark.asyncio
async def test_post_retry_only_trusted_criteria_and_original_conversation_pre_once():
    data, workflow = setup()
    actual(data)
    workflow['pre'] = [group('pre', [rule('pre-r', pattern='never')])]
    workflow['post'] = [group('post', [rule('post-r', pattern='PRIVATE_REJECTED')])]
    workflow['responseRetry'] = {'enabled': True, 'maxRetries': 2, 'instruction': '관리자 지시'}
    sent = []
    async def fetch(request):
        sent.append(json.loads(request.content))
        return generated('PRIVATE_REJECTED untrusted instructions' if len(sent) == 1 else 'safe')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await execute_workflow(workflow, data['connections'], data['ingress'], {}, [{'role': 'user', 'content': 'hello'}], client=client)
    assert result['status'] == 'allow' and result['output'] == 'safe'
    assert result['regenerationCount'] == 1 and len(result['attempts']) == 2
    assert len([t for t in result['traces'] if t['ruleId'] == 'pre-r']) == 1
    assert 'untrusted instructions' not in json.dumps(sent[1], ensure_ascii=False)
    assert 'PRIVATE_REJECTED' in sent[1]['messages'][0]['content']
    assert result['usage']['total_tokens'] == 10


@pytest.mark.asyncio
async def test_errors_are_failclosed_and_never_retried():
    data, workflow = setup()
    actual(data)
    workflow['responseRetry'] = {'enabled': True, 'maxRetries': 3}
    calls = 0
    async def fetch(request):
        nonlocal calls
        calls += 1
        return httpx.Response(502, text='secret raw error')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await execute_workflow(workflow, data['connections'], data['ingress'], {}, [{'role': 'user', 'content': 'hello'}], client=client)
    assert result['status'] == 'error' and result['stage'] == 'main' and result['output'] == ''
    assert calls == 1 and 'secret' not in result['reason']


@pytest.mark.asyncio
async def test_any_all_and_disabled_rules_preserve_meaning():
    data, workflow = setup()
    workflow['pre'] = [group(rules=[rule('a', pattern='DENY'), rule('b', pattern='different')], mode='all')]
    result = await execute_workflow(workflow, data['connections'], data['ingress'], {}, [{'role': 'user', 'content': 'DENY'}])
    assert result['status'] == 'allow'
    workflow['pre'][0]['mode'] = 'any'
    result = await execute_workflow(workflow, data['connections'], data['ingress'], {}, [{'role': 'user', 'content': 'DENY'}])
    assert result['status'] == 'block'
    workflow['pre'][0]['required'] = True
    for r in workflow['pre'][0]['rules']:
        r['enabled'] = False
    result = await execute_workflow(workflow, data['connections'], data['ingress'], {}, [{'role': 'user', 'content': 'DENY'}])
    assert result['status'] == 'allow'


@pytest.mark.asyncio
async def test_budget_shared_across_parallel_guards_and_main():
    data, workflow = setup()
    actual(data)
    data['connections'][1].update(mode='vllm', baseUrl='https://models.example/v1')
    workflow['pre'] = [group(rules=[rule('g1', 'llm', connectionId='conn-guard', prompt='policy'), rule('g2', 'llm', connectionId='conn-guard', prompt='policy')])]
    workflow['executionLimits'] = {'timeoutMs': 120000, 'maxModelCalls': 2}
    calls = 0
    async def fetch(request):
        nonlocal calls
        calls += 1
        return generated('{"verdict":"allow","reason":"fine"}')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await execute_workflow(workflow, data['connections'], data['ingress'], {}, [{'role': 'user', 'content': 'hello'}], client=client)
    assert result['status'] == 'error' and result['stage'] == 'main' and calls == 2
    assert '호출 한도' in result['reason']


@pytest.mark.asyncio
async def test_cancel_and_deadline_abort_upstream_and_stop_later_work():
    data, workflow = setup()
    actual(data)
    cancellation = asyncio.Event()
    entered = asyncio.Event()
    aborted = asyncio.Event()
    async def fetch(request):
        entered.set()
        try:
            await asyncio.sleep(20)
        finally:
            aborted.set()
        return generated('late')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        task = asyncio.create_task(execute_workflow(workflow, data['connections'], data['ingress'], {}, [{'role': 'user', 'content': 'hello'}], cancel_event=cancellation, client=client))
        await entered.wait()
        cancellation.set()
        result = await asyncio.wait_for(task, 1)
    assert result['status'] == 'error' and result['output'] == '' and aborted.is_set()
    runtime = ExecutionRuntime({'timeoutMs': 10, 'maxModelCalls': 2})
    with pytest.raises(Exception, match='제한 시간'):
        await runtime.wait(asyncio.sleep(1))


def test_strict_classifier_and_regex_boundaries():
    for text in ('{"verdict":"allow","reason":"ok","extra":1}', '```json\n{"verdict":"allow","reason":"ok"}\n```', '{"verdict":"ALLOW","reason":"ok"}', '{"verdict":"allow","reason":NaN}'):
        with pytest.raises(PolicyError):
            parse_guard_verdict(text, 'custom')
    assert parse_guard_verdict('unsafe S1,S2', 'Llama-Guard')['status'] == 'block'
    assert validate_regex('(a+)+')
    assert validate_regex('(?P<name>abc)')
    assert validate_regex(r'\Aabc')
    assert not validate_regex('[A-Za-z]+@[A-Za-z]+\\.[A-Za-z]{2,}')
    assert execution_lease_duration({}) == 180000
    assert response_token_reservation({}, [{'content': 'abc'}], 20) >= 20


def graph_workflow(workflow, condition=False):
    workflow['pre'] = [group('a', [rule('a-rule', 'llm', connectionId='conn-guard', prompt='policy')]), group('b', [rule('b-rule', 'llm', connectionId='conn-guard', prompt='policy')])]
    workflow['graph'] = {'version': 1, 'pre': {'nodes': [{'id': 'branch', 'name': '분기', 'kind': 'condition' if condition else 'fork', **({'condition': {'operator': 'contains', 'value': 'selected'}} if condition else {})}, {'id': 'join', 'name': '합류', 'kind': 'join'}], 'edges': [
        {'id': 's', 'from': 'start', 'to': 'control:branch'},
        {'id': 'a', 'from': 'control:branch', 'to': 'group:a', 'port': 'true' if condition else 'next'},
        {'id': 'b', 'from': 'control:branch', 'to': 'group:b', 'port': 'false' if condition else 'next'},
        {'id': 'aj', 'from': 'group:a', 'to': 'control:join'}, {'id': 'bj', 'from': 'group:b', 'to': 'control:join'}, {'id': 'e', 'from': 'control:join', 'to': 'end'}]}, 'post': {'nodes': [], 'edges': [{'id': 'post-e', 'from': 'start', 'to': 'end'}]}}


@pytest.mark.asyncio
async def test_fork_guards_are_concurrent_join_runs_once_progress_has_only_metadata():
    data, workflow = setup()
    graph_workflow(workflow)
    data['connections'][1].update(mode='vllm', baseUrl='https://models.example/v1')
    data['ingress']['allowedOrigins'] = ['https://models.example']
    count = 0
    together = asyncio.Event()
    events = []
    async def fetch(request):
        nonlocal count
        count += 1
        if count == 2:
            together.set()
        await asyncio.wait_for(together.wait(), 1)
        return generated('{"verdict":"allow","reason":"not exposed"}')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await execute_workflow(workflow, data['connections'], data['ingress'], {}, [{'role': 'user', 'content': 'PRIVATE_INPUT'}], client=client, on_progress=events.append)
    assert result['status'] == 'allow' and count == 2
    assert len([t for t in result['flowTraces'] if t['stage'] == 'pre' and t['nodeId'] == 'control:join' and t['status'] == 'completed']) == 1
    assert [event['sequence'] for event in events] == list(range(1, len(events) + 1))
    assert 'PRIVATE_INPUT' not in json.dumps(events) and 'not exposed' not in json.dumps(events)


@pytest.mark.asyncio
async def test_condition_skips_unselected_path_and_join_resolves_skipped_edge():
    data, workflow = setup()
    graph_workflow(workflow, condition=True)
    data['connections'][1].update(mode='vllm', baseUrl='https://models.example/v1')
    data['ingress']['allowedOrigins'] = ['https://models.example']
    calls = 0
    async def fetch(request):
        nonlocal calls
        calls += 1
        return generated('{"verdict":"allow","reason":"ok"}')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await execute_workflow(workflow, data['connections'], data['ingress'], {}, [{'role': 'user', 'content': 'selected'}], client=client)
    assert result['status'] == 'allow' and calls == 1
    assert next(t for t in result['traces'] if t['ruleId'] == 'b-rule')['status'] == 'skipped'
    condition_trace = next(t for t in result['flowTraces'] if t['nodeId'] == 'control:branch')
    assert condition_trace['edgeIds'] == ['a']


@pytest.mark.asyncio
async def test_parallel_error_wins_over_block_and_pending_followup_is_skipped():
    data, workflow = setup()
    graph_workflow(workflow)
    data['connections'][1].update(mode='vllm', baseUrl='https://models.example/v1')
    data['ingress']['allowedOrigins'] = ['https://models.example']
    counter = 0
    async def fetch(request):
        nonlocal counter
        counter += 1
        first = counter == 1
        await asyncio.sleep(0 if first else 0.01)
        return generated('{"verdict":"block","reason":"violation"}' if first else 'not valid JSON')
    async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
        result = await execute_workflow(workflow, data['connections'], data['ingress'], {}, [{'role': 'user', 'content': 'hello'}], client=client)
    assert result['status'] == 'error' and result['stage'] == 'pre' and result['output'] == ''
    assert counter == 2
    assert next(t for t in result['traces'] if t['ruleId'] == 'main')['status'] == 'skipped'


@pytest.mark.asyncio
async def test_shared_capacity_between_guard_and_main_releases_on_cancel():
    from aegis.store import Store
    store = Store(':memory:')
    data, first_workflow = setup()
    actual(data)
    data['connections'][0]['role'] = 'both'
    first_workflow['pre'] = [group('guard', [rule('guard-r', 'llm', connectionId='conn-main', prompt='policy')])]
    second_workflow = copy.deepcopy(first_workflow)
    second_workflow['pre'] = []
    entered, cancel = asyncio.Event(), asyncio.Event()
    async def fetch(request):
        entered.set()
        await asyncio.sleep(20)
        return generated('unused')
    env = {'_store': store, 'AEGIS_MODEL_MAX_CONCURRENT': '1'}
    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(fetch)) as client:
            running = asyncio.create_task(execute_workflow(first_workflow, data['connections'], data['ingress'], env, [{'role': 'user', 'content': 'hello'}], client=client, cancel_event=cancel))
            await entered.wait()
            rejected = await execute_workflow(second_workflow, data['connections'], data['ingress'], env, [{'role': 'user', 'content': 'hello'}], client=client)
            assert rejected['status'] == 'error' and rejected['stage'] == 'main'
            assert '동시 호출 한도' in rejected['reason']
            cancel.set()
            result = await running
            assert result['status'] == 'error'
        lease = await store.acquire_model_capacity('conn-main', 1, 1000)
        await store.release_model_capacity(lease)
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_rules_json_required_pii_length_regex_and_mock_final_masking():
    connections = seed()['connections']
    ingress = seed()['ingress']
    cases = [
        (rule(kind='json', requiredKeys=['id']), '{"id":1}', 'allow'),
        (rule(kind='json', requiredKeys=['id']), '{}', 'block'),
        (rule(kind='json', jsonMode='any'), 'null', 'allow'),
        (rule(kind='json'), 'NaN', 'block'),
        (rule(kind='required', pattern='yes,no', matchMode='all'), 'yes', 'block'),
        (rule(kind='pii', piiTypes=['email', 'phone']), '010-1234-5678', 'block'),
        (rule(kind='length', maxLength=1), '😀', 'block'),
        (rule(kind='regex', pattern=r'\d{2}'), '１２', 'allow'),
        (rule(kind='regex', pattern=r'\d{2}'), '12', 'block'),
    ]
    for configured, content, expected in cases:
        assert (await check_rule(configured, 'pre', content, connections, ingress, {}))['status'] == expected
    data, workflow = setup()
    workflow['post'] = [group()]
    result = await execute_workflow(workflow, data['connections'], data['ingress'], {}, [{'role': 'user', 'content': 'hello'}], {'mockResponse': 'DENY'})
    assert result['status'] == 'block' and result['output'] == '' and result['executionMode'] == 'mock'


@pytest.mark.asyncio
async def test_js_regex_digit_word_whitespace_normalization_and_unicode_literals():
    connection = seed()['connections']
    ingress = seed()['ingress']
    cases = [
        (r'\s', '\u00a0', 'block'), (r'[\s]', '\ufeff', 'block'),
        (r'\S', '\u00a0', 'allow'), (r'[\S]', '\u00a0', 'allow'),
        (r'\D', '１', 'block'), (r'[\D]', '１', 'block'),
        (r'\w', '가', 'allow'), (r'[\W]', '가', 'block'),
        ('é', 'É', 'block'), (r'\s', '\u0085', 'allow'),
    ]
    for pattern, content, expected in cases:
        result = await check_rule(rule(kind='regex', pattern=pattern), 'pre', content, connection, ingress, {})
        assert result['status'] == expected, (pattern, content, result)
