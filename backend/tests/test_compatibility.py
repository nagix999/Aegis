import copy

import pytest

from aegis.compatibility import (apply_dataset_rule_mappings, evaluation_preflight, get_workflow_rule_options,
                                  inspect_dataset_compatibility, suggest_dataset_rule_mappings,
                                  validate_zones, zone_membership_issue)
from aegis.errors import ApiError


def fixture():
    workflow = {'id': 'w', 'name': '이름', 'description': '설명', 'alias': 'chat', 'mainConnectionId': 'c',
                'pre': [{'id': 'g', 'name': '검사', 'mode': 'any', 'rules': [
                    {'id': 'r', 'name': '금지', 'description': '', 'kind': 'keyword', 'enabled': True, 'config': {'pattern': '비밀'}}]}],
                'post': [], 'updatedAt': ''}
    connections = [{'id': 'c', 'name': '모델', 'baseUrl': '', 'model': 'model', 'role': 'main', 'mode': 'demo', 'secretEnv': '', 'timeoutMs': 1000}]
    dataset = {'id': 'd', 'name': '검증 😀', 'description': '', 'rows': [
        {'id': 'row', 'input': '질문 😀', 'expected': 'block', 'expectedRuleId': 'r', 'expectedStage': 'pre'}]}
    return workflow, connections, dataset


def test_preflight_matches_javascript_golden_with_unicode_and_engine_version(monkeypatch):
    # Computed from the existing TypeScript production preflight/review modules,
    # with ENGINE_VERSION='3-python'. No Node runtime is used by Python services.
    # Keep that historical fixture fixed rather than regenerating it on an
    # engine version bump. Current-version identities are covered separately.
    monkeypatch.setattr('aegis.review.ENGINE_VERSION', '3-python')
    workflow, connections, dataset = fixture()
    result = evaluation_preflight(dataset, [{'key': 'candidate', 'label': '현재 초안', 'workflow': workflow, 'connections': connections}])
    assert result == {
        'fingerprint': '37a5239df1396fb7f18b99765e2ef09fbbb79b773cc753613f645036d056908b',
        'issues': [], 'requiresAcknowledgement': False,
        'sideFingerprints': [{'key': 'candidate', 'workflowFingerprint': 'c4c9be47a34d5d72eab76b1d01ef831599d3aebe48ef1acb8910d58970a65fb7'}],
        'datasetFingerprint': 'a1c9a5553973163a192cd503e98080e7ba25aa4b8d2380017d680309bf99b5e0'}


def test_preflight_side_order_and_acknowledgement_are_tied_to_configuration():
    workflow, connections, dataset = fixture()
    baseline = copy.deepcopy(workflow)
    baseline['pre'][0]['rules'][0]['enabled'] = False
    candidate = {'key': 'candidate', 'label': '수정본', 'workflow': workflow, 'connections': connections}
    before = {'key': 'baseline', 'label': '이전 배포', 'workflow': baseline, 'connections': connections}
    proof = evaluation_preflight(dataset, [before, candidate])
    assert proof == evaluation_preflight(dataset, [candidate, before])
    assert proof['requiresAcknowledgement']
    assert [issue['sideKey'] for issue in proof['issues']] == ['baseline']
    baseline['pre'][0]['rules'][0]['enabled'] = True
    assert evaluation_preflight(dataset, [before, candidate])['fingerprint'] != proof['fingerprint']
    with pytest.raises(ApiError):
        evaluation_preflight(dataset, [candidate, candidate])


def test_missing_disabled_ambiguous_and_impossible_expectations_are_reported():
    workflow, _, dataset = fixture()
    dataset['rows'] = [{'id': 'a', 'input': 'x', 'expected': 'allow', 'expectedStage': 'pre'},
                       {'id': 'b', 'input': 'x', 'expected': 'block', 'expectedStage': 'main', 'expectedRuleId': 'missing'},
                       {'id': 'c', 'input': 'x', 'expected': 'block', 'expectedStage': 'post', 'expectedRuleId': 'r'}]
    workflow['pre'][0]['rules'][0]['enabled'] = False
    issues = inspect_dataset_compatibility(dataset, workflow)
    assert [issue['code'] for issue in issues['issues']] == ['impossible_stage', 'impossible_stage', 'missing_rule', 'disabled_rule', 'rule_stage_mismatch']
    assert issues['affectedRowIds'] == ['a', 'b', 'c']
    assert issues['requiresAcknowledgement']
    workflow['pre'][0]['rules'].append(copy.deepcopy(workflow['pre'][0]['rules'][0]))
    assert inspect_dataset_compatibility(dataset, workflow)['issues'][-1]['code'] == 'ambiguous_rule'


def test_mapping_preserves_original_and_rejects_disabled_wrong_stage_and_unsafe_targets():
    workflow, _, dataset = fixture()
    original = copy.deepcopy(dataset)
    dataset['rows'][0]['expectedRuleId'] = 'old'
    result = apply_dataset_rule_mappings(dataset, workflow, {'old': 'r'})
    assert result['rows'][0]['expectedRuleId'] == 'r'
    assert dataset['rows'][0]['expectedRuleId'] == 'old'
    for mapping in [{'old': '__proto__'}, {'wrong': 'r'}, {'old': 'missing'}]:
        with pytest.raises(ApiError):
            apply_dataset_rule_mappings(dataset, workflow, mapping)
    workflow['pre'][0]['rules'][0]['enabled'] = False
    with pytest.raises(ApiError):
        apply_dataset_rule_mappings(dataset, workflow, {'old': 'r'})
    workflow['pre'][0]['rules'][0]['enabled'] = True
    dataset['rows'][0]['expectedStage'] = 'post'
    with pytest.raises(ApiError):
        apply_dataset_rule_mappings(dataset, workflow, {'old': 'r'})
    assert original['rows'][0]['expectedRuleId'] == 'r'


def test_suggestions_use_explicit_clone_lineage_without_mutating_rule_options():
    workflow, _, dataset = fixture()
    target = copy.deepcopy(workflow)
    target['pre'][0]['rules'][0]['id'] = 'new'
    target['cloneSource'] = {'workflowId': 'w', 'ruleIds': {'r': 'new'}}
    suggestions = suggest_dataset_rule_mappings(dataset, target, {'workflows': [workflow], 'runs': [], 'deployments': []})
    assert suggestions[0]['suggestedRuleId'] == 'new'
    options = get_workflow_rule_options(target)
    options[0]['rule']['config']['pattern'] = 'mutated'
    assert target['pre'][0]['rules'][0]['config']['pattern'] == '비밀'


def serial():
    workflow, _, _ = fixture()
    workflow['pre'] = [{**copy.deepcopy(workflow['pre'][0]), 'id': f'g{i}', 'rules': [{**copy.deepcopy(workflow['pre'][0]['rules'][0]), 'id': f'r{i}'}]} for i in range(3)]
    return workflow


def zone(zone_id, keys):
    return {'id': zone_id, 'name': zone_id, 'nodeKeys': keys, 'color': 'blue', 'x': 0, 'y': 0, 'width': 240, 'height': 160}


def test_visual_areas_require_contiguous_members_and_do_not_depend_on_positions():
    workflow = serial()
    assert zone_membership_issue(workflow, ['rule:r0', 'rule:r1']) is None
    assert zone_membership_issue(workflow, ['rule:r0', 'rule:r2'])
    assert zone_membership_issue(workflow, ['input', 'rule:r1', 'output'])
    assert zone_membership_issue(workflow, ['group:g0', 'rule:r1']) is None
    workflow['layout'] = {'version': 1, 'positions': {'rule:r0': {'x': 10000, 'y': 5000}, 'rule:r1': {'x': 0, 'y': 0}},
                          'zones': [zone('a', ['rule:r0', 'rule:r1'])], 'pinnedKeys': ['rule:r2']}
    original = copy.deepcopy(workflow)
    assert validate_zones(workflow) == []
    assert workflow == original
    workflow['layout']['zones'].append(zone('b', ['rule:r1']))
    assert any('하나의 구역' in issue for issue in validate_zones(workflow))
    workflow['layout']['pinnedKeys'] = ['group:g0']  # Hidden alias is not a visible pin.
    assert any('위치를 고정' in issue for issue in validate_zones(workflow))


def test_parallel_area_cannot_skip_an_alternate_path_between_selected_ends():
    workflow = serial()
    workflow['graph'] = {'version': 1, 'pre': {'nodes': [{'id': 'fork', 'name': '분기', 'kind': 'fork'}, {'id': 'join', 'name': '합류', 'kind': 'join'}], 'edges': [
        {'id': 'a', 'from': 'start', 'to': 'control:fork'},
        {'id': 'b', 'from': 'control:fork', 'to': 'group:g0'}, {'id': 'c', 'from': 'control:fork', 'to': 'group:g1'},
        {'id': 'd', 'from': 'group:g0', 'to': 'control:join'}, {'id': 'e', 'from': 'group:g1', 'to': 'control:join'},
        {'id': 'f', 'from': 'control:join', 'to': 'group:g2'}, {'id': 'g', 'from': 'group:g2', 'to': 'end'}]},
        'post': {'nodes': [], 'edges': [{'id': 'post', 'from': 'start', 'to': 'end'}]}}
    assert zone_membership_issue(workflow, ['control:fork', 'rule:r0', 'control:join'])
    assert zone_membership_issue(workflow, ['control:fork', 'rule:r0', 'rule:r1', 'control:join']) is None
    assert zone_membership_issue(workflow, ['rule:r0', 'rule:r1'])
