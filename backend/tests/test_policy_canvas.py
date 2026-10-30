"""Policy canvas keys and areas follow the same paths without changing execution."""
import copy

import pytest
from pydantic import ValidationError

from aegis.compatibility import _visible_keys, _zone_graph, validate_zones, zone_membership_issue
from aegis.schemas import CanvasZone, WorkflowLayout


def group(identifier):
    return {'id': identifier, 'name': identifier, 'mode': 'any', 'rules': [
        {'id': identifier + '-rule', 'name': identifier, 'kind': 'keyword', 'enabled': True, 'description': '', 'config': {'pattern': 'deny'}}]}


def workflow(version=2):
    value = {'pre': [group('pre')], 'post': [group('post')]}
    if not version:
        return value
    value['policyRouting'] = {'policy': {}, 'routes': [{'decision': decision, 'action': action} for decision, action in [('IN', 'main'), ('OUT', 'respond'), ('REJECT', 'error')]]}
    if version == 2:
        value['policyRouting'] = {'policy': {'formatVersion': 2}, 'routes': [], 'graph': {'version': 1, 'entryNodeId': 'branch', 'nodes': [
            {'id': 'branch', 'kind': 'branch'}, {'id': 'risk', 'kind': 'rule'}, {'id': 'other', 'kind': 'rule'},
            {'id': 'main-action', 'kind': 'action', 'action': 'main'}, {'id': 'respond-action', 'kind': 'action', 'action': 'respond'}, {'id': 'error-action', 'kind': 'action', 'action': 'error'}],
            'edges': [{'id': 'a', 'from': 'branch', 'to': 'risk', 'port': 'true'}, {'id': 'b', 'from': 'branch', 'to': 'other', 'port': 'false'},
                      {'id': 'c', 'from': 'risk', 'to': 'error-action', 'port': 'true'}, {'id': 'd', 'from': 'risk', 'to': 'main-action', 'port': 'false'},
                      {'id': 'e', 'from': 'other', 'to': 'respond-action', 'port': 'true'}, {'id': 'f', 'from': 'other', 'to': 'error-action', 'port': 'false'}]}}
    return value


def zone(keys):
    return {'id': 'zone', 'name': '시각 영역', 'nodeKeys': keys, 'color': 'blue', 'x': 0, 'y': 0, 'width': 240, 'height': 160}


@pytest.mark.parametrize('version,policy_keys', [(0, []), (1, ['policy']), (2, ['policy', 'policy-node:branch', 'policy-node:risk', 'policy-node:other', 'policy-node:main-action', 'policy-node:respond-action', 'policy-node:error-action'])])
def test_only_existing_policy_canvas_nodes_are_visible_and_pinnable(version, policy_keys):
    value = workflow(version)
    keys, known, aliases = _visible_keys(value)
    assert [key for key in keys if key.startswith('policy')] == policy_keys
    assert all(key in known and aliases[key] == key for key in policy_keys)
    value['layout'] = {'version': 1, 'positions': {key: {'x': 10, 'y': 20} for key in policy_keys}, 'pinnedKeys': policy_keys}
    original = copy.deepcopy(value)
    assert validate_zones(value) == []
    assert value == original
    value['layout']['positions']['policy-node:unknown'] = {'x': 0, 'y': 0}
    assert any('노드 위치' in issue for issue in validate_zones(value))
    value['layout']['pinnedKeys'] = ['policy-node:unknown']
    assert any('위치를 고정' in issue for issue in validate_zones(value))


def test_no_policy_projection_remains_the_previous_pre_main_post_flow():
    value = workflow(0)
    _, outgoing, incoming, _ = _zone_graph(value)
    assert outgoing['input'] == ['rule:pre-rule']
    assert outgoing['rule:pre-rule'] == ['main']
    assert outgoing['main'] == ['rule:post-rule']
    assert incoming['output'] == ['rule:post-rule']
    assert 'policy' not in outgoing


def test_v1_policy_fans_out_to_main_post_and_final_output_without_synthetic_actions():
    value = workflow(1)
    _, outgoing, incoming, _ = _zone_graph(value)
    assert outgoing['rule:pre-rule'] == ['policy']
    assert outgoing['policy'] == ['main', 'rule:post-rule', 'output']
    assert outgoing['main'] == ['rule:post-rule']
    assert set(incoming['rule:post-rule']) == {'main', 'policy'}
    assert not any(key.startswith('policy-node:') for key in outgoing)


def test_v2_policy_projection_keeps_pre_then_classifier_and_exact_graph_actions():
    value = workflow()
    original = copy.deepcopy(value)
    _, outgoing, incoming, _ = _zone_graph(value)
    assert outgoing['rule:pre-rule'] == ['policy']
    assert outgoing['policy'] == ['policy-node:branch']
    assert set(outgoing['policy-node:branch']) == {'policy-node:risk', 'policy-node:other'}
    assert outgoing['policy-node:main-action'] == ['main']
    assert outgoing['policy-node:respond-action'] == ['rule:post-rule']
    assert outgoing['policy-node:error-action'] == ['output']
    assert outgoing['main'] == ['rule:post-rule']
    assert set(incoming['rule:post-rule']) == {'main', 'policy-node:respond-action'}
    assert value == original


@pytest.mark.parametrize('version', [1, 2])
def test_respond_targets_every_post_start_successor_including_controls(version):
    value = workflow(version)
    value['post'] = [group('left'), group('right')]
    value['graph'] = {'version': 1, 'pre': {'nodes': [], 'edges': [{'id': 'a', 'from': 'start', 'to': 'group:pre'}, {'id': 'b', 'from': 'group:pre', 'to': 'end'}]},
                      'post': {'nodes': [{'id': 'control-first', 'name': '조건', 'kind': 'condition'}], 'edges': [
                          {'id': 'c', 'from': 'start', 'to': 'control:control-first'}, {'id': 'd', 'from': 'start', 'to': 'group:right'},
                          {'id': 'e', 'from': 'control:control-first', 'to': 'group:left'}, {'id': 'f', 'from': 'group:left', 'to': 'end'}, {'id': 'g', 'from': 'group:right', 'to': 'end'}]}}
    _, outgoing, _, _ = _zone_graph(value)
    key = 'policy' if version == 1 else 'policy-node:respond-action'
    assert {'control:control-first', 'rule:right-rule'} <= set(outgoing[key])
    assert set(outgoing['main']) == {'control:control-first', 'rule:right-rule'}
    assert 'rule:left-rule' not in outgoing[key]


@pytest.mark.parametrize('version', [1, 2])
def test_respond_without_post_checks_goes_directly_to_output(version):
    value = workflow(version)
    value['post'] = []
    _, outgoing, _, _ = _zone_graph(value)
    key = 'policy' if version == 1 else 'policy-node:respond-action'
    assert 'output' in outgoing[key]
    if version == 2:
        assert outgoing[key] == ['output']


@pytest.mark.parametrize('keys', [
    ['policy', 'policy-node:branch'],
    ['policy-node:risk', 'policy-node:main-action', 'main'],
    ['policy-node:respond-action', 'rule:post-rule'],
    ['policy-node:error-action', 'output'],
    ['main', 'rule:post-rule', 'output'],
])
def test_contiguous_policy_canvas_areas_are_accepted(keys):
    assert zone_membership_issue(workflow(), keys) is None


@pytest.mark.parametrize('keys', [
    ['rule:pre-rule', 'main'],  # Classifier and action graph cannot be skipped.
    ['policy', 'policy-node:risk'],
    ['policy-node:branch', 'policy-node:risk', 'policy-node:error-action'],  # The other branch can also reach the same error action.
    ['policy-node:risk', 'main'],
    ['policy-node:respond-action', 'output'],  # The response checks are mandatory.
])
def test_skipped_middle_nodes_and_alternate_paths_are_rejected(keys):
    assert zone_membership_issue(workflow(), keys)


def test_complete_policy_subgraph_area_covers_all_paths_and_never_mutates_layout():
    value = workflow()
    visible, _, _ = _visible_keys(value)
    selected = [key for key in visible if key not in {'input', 'rule:pre-rule'}]
    value['layout'] = {'version': 1, 'positions': {}, 'pinnedKeys': ['policy', 'policy-node:risk'], 'zones': [zone(selected)]}
    original = copy.deepcopy(value)
    assert validate_zones(value) == []
    assert value == original


def test_existing_v1_area_members_are_never_automatically_rewritten():
    value = workflow(1)
    value['layout'] = {'version': 1, 'positions': {}, 'zones': [zone(['main', 'rule:post-rule', 'output'])]}
    original = copy.deepcopy(value)
    assert validate_zones(value) == []
    assert value == original
    value['layout']['zones'][0]['nodeKeys'] = ['input', 'rule:pre-rule', 'main']
    original = copy.deepcopy(value)
    assert validate_zones(value)  # Ask the user to include newly visible intervening nodes.
    assert value == original


@pytest.mark.parametrize('model,base,field,limit', [
    (WorkflowLayout, {'version': 1, 'positions': {}}, 'positions', 1280),
    (WorkflowLayout, {'version': 1, 'positions': {}}, 'pinnedKeys', 1280),
    (CanvasZone, zone([]), 'nodeKeys', 1280),
])
def test_layout_capacity_includes_twelve_independent_policy_graphs(model, base, field, limit):
    # Up to twelve classifiers each add twenty-four local graph nodes. The
    # visual capacity grows while PRE/POST group and DAG execution limits stay.
    def values(count):
        return {f'node-{index}': {'x': 0, 'y': 0} for index in range(count)} if field == 'positions' else [f'node-{index}' for index in range(count)]
    assert model.model_validate({**base, field: values(limit)})
    with pytest.raises(ValidationError):
        model.model_validate({**base, field: values(limit + 1)})


def test_scoped_policy_layout_key_length_is_bounded():
    key = 'policy-node:' + 'owner-' + 'a' * 94 + '/' + 'n' * 80
    assert len(key) > 150
    assert WorkflowLayout.model_validate({'version': 1, 'positions': {key: {'x': 0, 'y': 0}}, 'pinnedKeys': [key]})
    with pytest.raises(ValidationError):
        WorkflowLayout.model_validate({'version': 1, 'positions': {'n' * 261: {'x': 0, 'y': 0}}})
