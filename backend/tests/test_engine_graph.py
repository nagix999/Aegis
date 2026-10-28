from copy import deepcopy

from aegis.graph import (
    condition_matches, create_stage_graph, endpoint_label, get_stage_graph,
    graph_node_keys, js_length, validate_workflow_graph,
)


def group(identifier, required=False):
    return {"id": identifier, "name": identifier, "rules": [], "required": required}


def serial():
    return {"pre": [group("a"), group("b")], "post": []}


def branch():
    workflow = serial()
    workflow["graph"] = {
        "version": 1,
        "pre": {"nodes": [
            {"id": "condition", "name": "분기", "kind": "condition", "condition": {"operator": "contains", "value": "test"}},
            {"id": "join", "name": "합류", "kind": "join"},
        ], "edges": [
            {"id": "s", "from": "start", "to": "control:condition"},
            {"id": "t", "from": "control:condition", "to": "group:a", "port": "true"},
            {"id": "f", "from": "control:condition", "to": "group:b", "port": "false"},
            {"id": "a", "from": "group:a", "to": "control:join"},
            {"id": "b", "from": "group:b", "to": "control:join"},
            {"id": "e", "from": "control:join", "to": "end"},
        ]},
        "post": create_stage_graph([]),
    }
    return workflow


def test_serial_and_empty_graphs_keep_legacy_order():
    workflow = serial()
    assert validate_workflow_graph(workflow) == []
    assert graph_node_keys(workflow, "pre") == ["start", "group:a", "group:b", "end"]
    assert get_stage_graph(workflow, "pre")["edges"][1] == {"id": "serial-2", "from": "group:a", "to": "group:b", "port": "next"}
    assert create_stage_graph([]) == {"nodes": [], "edges": [{"id": "serial-1", "from": "start", "to": "end", "port": "next"}]}


def test_conditions_and_utf16_length_match_existing_javascript():
    assert js_length("가😀") == 3
    assert condition_matches({"operator": "length_gte", "value": "3"}, "가😀")
    assert not condition_matches({"operator": "length_lte", "value": "2"}, "가😀")
    assert condition_matches({"operator": "contains", "value": "TEST"}, "test")
    assert not condition_matches({"operator": "contains", "value": "TEST", "caseSensitive": True}, "test")
    assert condition_matches({"operator": "not_contains", "value": "xyz"}, "test")
    for value in ("01", "1.0", "-1", "40001", "١"):
        assert not condition_matches({"operator": "length_gte", "value": value}, "test")
    assert not condition_matches({"operator": "contains", "value": ""}, "test")


def test_condition_branch_and_parallel_fork_both_validate():
    workflow = branch()
    assert validate_workflow_graph(workflow) == []
    workflow["graph"]["pre"]["nodes"][0] = {"id": "condition", "name": "병렬", "kind": "fork"}
    for edge in workflow["graph"]["pre"]["edges"][1:3]:
        edge["port"] = "next"
    assert validate_workflow_graph(workflow) == []


def test_required_group_cannot_be_bypassed_by_structural_path():
    workflow = branch()
    workflow["pre"][0]["required"] = True
    assert any("필수 검사를 우회" in issue for issue in validate_workflow_graph(workflow))
    workflow["pre"][0]["required"] = False
    assert validate_workflow_graph(workflow) == []
    workflow = serial()
    workflow["pre"][0]["required"] = True
    assert validate_workflow_graph(workflow) == []


def test_cycle_disconnected_nodes_and_cross_stage_edges_fail():
    workflow = branch()
    workflow["graph"]["pre"]["edges"][-1]["to"] = "control:condition"
    issues = validate_workflow_graph(workflow)
    assert any("순환" in issue for issue in issues)
    assert any("종료 노드" in issue for issue in issues)
    workflow = branch()
    workflow["graph"]["pre"]["edges"][0]["to"] = "group:missing"
    issues = validate_workflow_graph(workflow)
    assert any("다른 단계" in issue for issue in issues)
    assert any("시작 노드에서 도달" in issue for issue in issues)


def test_port_and_duplicate_edge_constraints():
    workflow = branch()
    workflow["graph"]["pre"]["edges"][1]["port"] = "next"
    assert any("true 및 false" in issue for issue in validate_workflow_graph(workflow))
    workflow = branch()
    workflow["graph"]["pre"]["edges"].append(deepcopy(workflow["graph"]["pre"]["edges"][1]))
    issues = validate_workflow_graph(workflow)
    assert any("연결선 ID" in issue for issue in issues)
    assert any("연결선이 중복" in issue for issue in issues)
    workflow["graph"]["pre"]["edges"][1]["port"] = None
    assert any("포트" in issue for issue in validate_workflow_graph(workflow))


def test_id_collisions_and_bounded_input_are_rejected():
    workflow = branch()
    workflow["graph"]["pre"]["nodes"][0]["id"] = "a"
    assert any("제어 노드 ID는" in issue for issue in validate_workflow_graph(workflow))
    workflow = serial()
    workflow["pre"] = [group(str(i)) for i in range(37)]
    assert any("최대 36" in issue for issue in validate_workflow_graph(workflow))
    workflow = branch()
    workflow["graph"]["post"] = {"nodes": [None] * 13, "edges": []}
    assert any("최대 12" in issue for issue in validate_workflow_graph(workflow))
    assert validate_workflow_graph({"graph": {"version": True}}) == ["워크플로우 그래프 버전은 1이어야 합니다."]
    assert validate_workflow_graph(None) == ["워크플로우 그래프 설정을 확인하세요."]


def test_labels_use_single_rule_name_or_group_name():
    workflow = serial()
    workflow["pre"][0]["rules"] = [{"id": "r", "name": "검사명"}]
    assert endpoint_label(workflow, "pre", "group:a") == "검사명"
    assert endpoint_label(workflow, "pre", "start") == "요청 입력"
    assert endpoint_label(workflow, "post", "start") == "모델 응답"
    assert endpoint_label(workflow, "post", "end") == "응답 검사 완료"
