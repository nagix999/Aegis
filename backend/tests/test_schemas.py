import copy
import json
from pathlib import Path

import pytest

from aegis.errors import ApiError
from aegis.schemas import Dataset, Workflow, validate_payload

SEED = json.loads((Path(__file__).parents[1] / 'aegis' / 'seed.json').read_text())


def test_existing_seed_roundtrips_without_added_defaults_or_field_changes():
    for kind, key in [('workflow', 'workflows'), ('connection', 'connections'), ('dataset', 'datasets')]:
        for value in SEED[key]:
            assert validate_payload(kind, value) == value
    assert validate_payload('ingress', SEED['ingress']) == SEED['ingress']


@pytest.mark.parametrize('kind,value', [
    ('conversation', []),
    ('conversation', [{'role': 'system', 'content': 'no user'}]),
    ('conversation', [{'role': 'tool', 'content': 'unsupported'}]),
    ('conversation', [{'role': 'user', 'content': 'x', 'tool_calls': []}]),
    ('conversation', [{'role': 'user', 'content': 'x'}] * 33),
    ('conversation', [{'role': 'user', 'content': 'x' * 16001}]),
    ('conversation', [{'role': 'user', 'content': 'x' * 14000}] * 3),
    ('generation', {'max_tokens': True}),
    ('generation', {'temperature': '0.5'}),
    ('generation', {'max_tokens': 1.5}),
    ('generation', {'max_tokens': 0}),
    ('generation', {'temperature': float('nan')}),
    ('generation', {'temperature': None}),
    ('generation', {'onProgress': 'injected'}),
    ('key_policy', {'expiresAt': '2026-02-30T00:00:00Z'}),
    ('retention', {'logDays': True, 'evaluationDays': 30, 'auditDays': 90}),
])
def test_invalid_message_and_generation_contracts_rejected(kind, value):
    with pytest.raises(ApiError) as error:
        validate_payload(kind, value)
    assert error.value.status == 400


def test_json_number_integer_and_utf16_boundaries_match_original_api():
    assert validate_payload('generation', {'max_tokens': 2.0}) == {'max_tokens': 2}
    assert validate_payload('conversation', [{'role': 'user', 'content': '😀' * 8000}])[0]['content'] == '😀' * 8000
    with pytest.raises(ApiError):
        validate_payload('conversation', [{'role': 'user', 'content': '😀' * 8001}])


def test_new_scope_limits_and_pinned_layout_are_retained():
    workflow = copy.deepcopy(SEED['workflows'][0])
    workflow.update(inputScope='last_user', executionLimits={'timeoutMs': 120000, 'maxModelCalls': 64},
                    layout={'version': 1, 'positions': {}, 'pinnedKeys': ['input']})
    assert validate_payload('workflow', workflow) == workflow
    for value in [False, 0, 600001, '1000']:
        changed = copy.deepcopy(workflow)
        changed['executionLimits']['timeoutMs'] = value
        with pytest.raises(ApiError):
            validate_payload('workflow', changed)
    changed = copy.deepcopy(workflow)
    changed['layout']['version'] = True
    with pytest.raises(ApiError):
        validate_payload('workflow', changed)


def test_save_contract_allows_temporarily_incomplete_rule_settings():
    workflow = copy.deepcopy(SEED['workflows'][0])
    workflow['pre'][0]['rules'][0]['config'] = {}
    assert validate_payload('workflow', workflow)['pre'][0]['rules'][0]['config'] == {}


def test_dataset_conversation_options_and_optional_null_contract():
    dataset = copy.deepcopy(SEED['datasets'][0])
    dataset['rows'] = [{'id': 'r', 'input': '원본', 'messages': [{'role': 'user', 'content': '구조화된 질문'}],
                        'generationOptions': {'temperature': 0.2, 'max_tokens': 5}, 'expected': 'allow'}]
    assert validate_payload('dataset', dataset) == dataset
    for field in ['messages', 'expectedRuleId', 'generationOptions']:
        changed = copy.deepcopy(dataset)
        changed['rows'][0][field] = None
        with pytest.raises(ApiError):
            validate_payload('dataset', changed)


def test_bounded_metadata_and_unknown_field_behavior():
    connection = copy.deepcopy(SEED['connections'][0])
    connection['unknown'] = 'not stored'
    assert 'unknown' not in validate_payload('connection', connection)
    workflow = copy.deepcopy(SEED['workflows'][0])
    workflow['releasePolicy'] = {'requireVerification': True, 'requiredDatasetIds': ['same', 'same']}
    with pytest.raises(ApiError):
        validate_payload('workflow', workflow)
    workflow['releasePolicy'] = {'requireVerification': True, 'requiredDatasetIds': [], 'unknown': True}
    with pytest.raises(ApiError):
        validate_payload('workflow', workflow)
    workflow.pop('releasePolicy')
    workflow['cloneSource'] = {'workflowId': '__proto__', 'ruleIds': {}}
    with pytest.raises(ApiError):
        validate_payload('workflow', workflow)


def test_models_expose_json_schema_for_openapi():
    assert 'properties' in Workflow.model_json_schema()
    assert Dataset.model_json_schema()['properties']['rows']['maxItems'] == 100
