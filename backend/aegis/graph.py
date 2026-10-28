"""Bounded workflow graphs shared by validation and the Python executor.

Node and edge identifiers retain the console's JSON representation. Layout and
visual areas do not participate in graph execution.
"""
from __future__ import annotations

import re
from typing import Any

LIMITS = {"groups": 36, "controls": 12, "edges": 64, "id": 120, "endpoint": 150, "name": 100, "condition": 2000}


def js_length(value: str) -> int:
    """Match JavaScript string.length, including astral characters/surrogates."""
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def _record(value: Any) -> bool:
    return isinstance(value, dict)


def _text(value: Any, maximum: int) -> bool:
    return isinstance(value, str) and 0 < js_length(value) <= maximum and bool(value.strip())


def _groups_for(workflow: dict, stage: str) -> list:
    groups = workflow.get(stage)
    return groups if isinstance(groups, list) else []


def create_stage_graph(groups: list) -> dict:
    usable = [group for group in groups if _record(group) and isinstance(group.get("id"), str)] if isinstance(groups, list) else []
    keys = ["start", *[f"group:{group['id']}" for group in usable], "end"]
    return {"nodes": [], "edges": [{"id": f"serial-{index + 1}", "from": source, "to": keys[index + 1], "port": "next"} for index, source in enumerate(keys[:-1])]}


def get_stage_graph(workflow: dict, stage: str) -> dict:
    graph = workflow.get("graph")
    selected = graph.get(stage) if isinstance(graph, dict) else None
    return selected if selected is not None else create_stage_graph(_groups_for(workflow, stage))


def graph_node_keys(workflow: dict, stage: str) -> list[str]:
    graph = get_stage_graph(workflow, stage)
    raw_nodes = graph.get("nodes") if isinstance(graph, dict) else None
    nodes = [node for node in raw_nodes if _record(node) and isinstance(node.get("id"), str)] if isinstance(raw_nodes, list) else []
    return ["start", *[f"group:{group['id']}" for group in _groups_for(workflow, stage) if _record(group) and isinstance(group.get("id"), str)], *[f"control:{node['id']}" for node in nodes], "end"]


def endpoint_label(workflow: dict, stage: str, key: Any) -> str:
    if key == "start":
        return "요청 입력" if stage == "pre" else "모델 응답"
    if key == "end":
        return "요청 검사 완료" if stage == "pre" else "응답 검사 완료"
    if not isinstance(key, str):
        return "알 수 없는 노드"
    if key.startswith("group:"):
        group = next((group for group in _groups_for(workflow, stage) if _record(group) and group.get("id") == key[6:]), None)
        name = None
        if group:
            rules = group.get("rules")
            name = rules[0].get("name") if isinstance(rules, list) and len(rules) == 1 and isinstance(rules[0], dict) else group.get("name")
        return name if isinstance(name, str) else key
    if key.startswith("control:"):
        graph = get_stage_graph(workflow, stage)
        nodes = graph.get("nodes") if isinstance(graph, dict) else None
        node = next((node for node in nodes if _record(node) and node.get("id") == key[8:]), None) if isinstance(nodes, list) else None
        name = node.get("name") if node else None
        return name if isinstance(name, str) else key
    return key


def condition_error(condition: Any) -> str | None:
    if not _record(condition) or condition.get("operator") not in ("contains", "not_contains", "length_gte", "length_lte"):
        return "조건 연산자를 선택하세요."
    value = condition.get("value")
    if not isinstance(value, str) or js_length(value) > LIMITS["condition"]:
        return "조건 값은 2,000자 이내 문자열로 입력하세요."
    if "caseSensitive" in condition and type(condition["caseSensitive"]) is not bool:
        return "조건의 대소문자 구분 설정을 확인하세요."
    if condition["operator"] in ("contains", "not_contains"):
        return None if js_length(value) > 0 else "포함 여부를 검사할 문구를 입력하세요."
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)", value) or int(value) > 40000:
        return "길이 조건은 0~40,000 사이의 정수를 입력하세요. 앞자리 0이나 소수는 사용할 수 없습니다."
    return None


def condition_matches(condition: dict, text: str) -> bool:
    if condition_error(condition) or not isinstance(text, str):
        return False
    operator, value = condition["operator"], condition["value"]
    if operator == "length_gte":
        return js_length(text) >= int(value)
    if operator == "length_lte":
        return js_length(text) <= int(value)
    source = text if condition.get("caseSensitive") else text.lower()
    needle = value if condition.get("caseSensitive") else value.lower()
    matched = needle in source
    return matched if operator == "contains" else not matched


def reachable(start: str, outgoing: dict[str, list[str]], avoid: str | None = None) -> set[str]:
    visited: set[str] = set()
    stack = [] if start == avoid else [start]
    while stack:
        key = stack.pop()
        if key in visited or key == avoid:
            continue
        visited.add(key)
        stack.extend(target for target in outgoing.get(key, []) if target != avoid)
    return visited


def validate_stage(workflow: dict, stage: str, graph: Any) -> list[str]:
    prefix = "요청 검사" if stage == "pre" else "응답 검사"
    errors: list[str] = []

    def issue(message: str) -> None:
        errors.append(f"{prefix}: {message}")

    raw_groups = workflow.get(stage)
    if not isinstance(raw_groups, list) or len(raw_groups) > LIMITS["groups"]:
        issue("검사 노드는 최대 36개까지 구성할 수 있습니다.")
        return errors
    groups = [group for group in raw_groups if _record(group) and _text(group.get("id"), LIMITS["id"])]
    if len(groups) != len(raw_groups):
        issue("검사 노드 ID를 확인하세요.")
    for group in groups:
        if "required" in group and type(group["required"]) is not bool:
            issue("필수 검사 여부는 true 또는 false여야 합니다.")
    if not _record(graph) or not isinstance(graph.get("nodes"), list) or not isinstance(graph.get("edges"), list):
        issue("그래프에는 nodes와 edges 배열이 필요합니다.")
        return errors
    if len(graph["nodes"]) > LIMITS["controls"] or len(graph["edges"]) > LIMITS["edges"]:
        issue("제어 노드는 최대 12개, 연결선은 최대 64개까지 구성할 수 있습니다.")
        return errors
    nodes = []
    for candidate in graph["nodes"]:
        if not _record(candidate) or not _text(candidate.get("id"), LIMITS["id"]) or not _text(candidate.get("name"), LIMITS["name"]) or candidate.get("kind") not in ("condition", "fork", "join"):
            issue("제어 노드 ID, 이름과 종류를 확인하세요.")
            continue
        if candidate["kind"] == "condition":
            error = condition_error(candidate.get("condition"))
            if error:
                issue(f"{candidate['name']}: {error}")
        elif "condition" in candidate:
            issue(f"{candidate['name']}: 조건 설정은 조건 노드에서만 사용할 수 있습니다.")
        nodes.append(candidate)
    keys = ["start", *[f"group:{group['id']}" for group in groups], *[f"control:{node['id']}" for node in nodes], "end"]
    known = list(dict.fromkeys(keys))
    if len(known) != len(keys):
        issue("같은 단계에 중복된 노드 ID가 있습니다.")
    outgoing = {key: [] for key in known}
    incoming = {key: [] for key in known}
    forward = {key: [] for key in known}
    reverse = {key: [] for key in known}
    edge_ids: set[str] = set()
    signatures: set[tuple] = set()
    for candidate in graph["edges"]:
        if not _record(candidate) or not _text(candidate.get("id"), LIMITS["id"]) or not _text(candidate.get("from"), LIMITS["endpoint"]) or not _text(candidate.get("to"), LIMITS["endpoint"]):
            issue("연결선의 ID와 출발 및 도착 노드를 확인하세요.")
            continue
        if candidate["id"] in edge_ids:
            issue("연결선 ID는 같은 단계에서 중복될 수 없습니다.")
        edge_ids.add(candidate["id"])
        if "port" in candidate and candidate["port"] not in ("next", "true", "false"):
            issue("연결선 포트는 next, true, false만 사용할 수 있습니다.")
            continue
        if candidate["from"] not in outgoing or candidate["to"] not in incoming:
            issue("연결선이 없는 노드나 다른 단계의 노드를 가리킵니다.")
            continue
        signature = (candidate["from"], candidate["to"], candidate.get("port", "next"))
        if signature in signatures:
            issue("같은 노드와 포트를 잇는 연결선이 중복되어 있습니다.")
        signatures.add(signature)
        outgoing[candidate["from"]].append(candidate)
        incoming[candidate["to"]].append(candidate)
        forward[candidate["from"]].append(candidate["to"])
        reverse[candidate["to"]].append(candidate["from"])
    nodes_by_key = {f"control:{node['id']}": node for node in nodes}
    for key in known:
        ins, outs = incoming[key], outgoing[key]
        node = nodes_by_key.get(key)
        if key == "start":
            if ins or len(outs) != 1 or outs[0].get("port", "next") != "next":
                issue("시작 노드는 들어오는 선 없이 next 연결선 하나가 필요합니다.")
        elif key == "end":
            if len(ins) != 1 or outs:
                issue("종료 노드에는 들어오는 연결선 하나가 필요하며, 나가는 연결선은 추가할 수 없습니다.")
        elif node and node["kind"] == "condition":
            if len(ins) != 1 or len(outs) != 2 or sum(edge.get("port") == "true" for edge in outs) != 1 or sum(edge.get("port") == "false" for edge in outs) != 1:
                issue(f"{node['name']}: 들어오는 연결선 하나와 true 및 false 연결선이 각각 하나 필요합니다.")
        elif node and node["kind"] == "fork":
            if len(ins) != 1 or not 2 <= len(outs) <= 4 or any(edge.get("port", "next") != "next" for edge in outs) or len({edge["to"] for edge in outs}) != len(outs):
                issue(f"{node['name']}: 들어오는 선 하나와 서로 다른 노드로 가는 next 연결선 2~4개가 필요합니다.")
        elif node and node["kind"] == "join":
            if not 2 <= len(ins) <= 4 or len(outs) != 1 or outs[0].get("port", "next") != "next":
                issue(f"{node['name']}: 들어오는 연결선 2~4개와 next 연결선 하나가 필요합니다.")
        elif key.startswith("group:"):
            if len(ins) != 1 or len(outs) != 1 or outs[0].get("port", "next") != "next":
                issue(f"{endpoint_label(workflow, stage, key)}: 검사 노드에는 들어오는 연결선 하나와 next 연결선 하나가 필요합니다.")
    indegree = {key: len(incoming[key]) for key in known}
    ready = [key for key in known if indegree[key] == 0]
    processed = 0
    while ready:
        key = ready.pop()
        processed += 1
        for target in forward[key]:
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
    if processed != len(known):
        issue("순환 연결은 사용할 수 없습니다. 모든 연결은 한 방향으로 끝나야 합니다.")
    from_start, to_end = reachable("start", forward), reachable("end", reverse)
    if any(key not in from_start for key in known):
        issue("모든 노드는 시작 노드에서 도달할 수 있어야 합니다.")
    if any(key not in to_end for key in known):
        issue("모든 노드에서 종료 노드로 도달할 수 있어야 합니다.")
    for group in groups:
        if group.get("required") is True and "end" in reachable("start", forward, f"group:{group['id']}"):
            issue(f"{group.get('name', '')}: 필수 검사를 우회하는 시작→종료 경로가 있습니다.")
    return errors


def validate_workflow_graph(workflow: Any) -> list[str]:
    if not _record(workflow):
        return ["워크플로우 그래프 설정을 확인하세요."]
    graph = workflow.get("graph")
    if "graph" in workflow and (not _record(graph) or type(graph.get("version")) is not int or graph["version"] != 1):
        return ["워크플로우 그래프 버전은 1이어야 합니다."]
    errors: list[str] = []
    used_ids: set[str] = set()
    for stage in ("pre", "post"):
        for group in _groups_for(workflow, stage):
            if not _record(group):
                continue
            if isinstance(group.get("id"), str):
                used_ids.add(group["id"])
            if isinstance(group.get("rules"), list):
                used_ids.update(rule["id"] for rule in group["rules"] if _record(rule) and isinstance(rule.get("id"), str))
    for stage in ("pre", "post"):
        selected = graph.get(stage) if graph is not None else create_stage_graph(_groups_for(workflow, stage))
        if _record(selected) and isinstance(selected.get("nodes"), list):
            for node in selected["nodes"]:
                if not _record(node) or not isinstance(node.get("id"), str):
                    continue
                if node["id"] in used_ids:
                    errors.append("제어 노드 ID는 검사 노드, 규칙 및 다른 제어 노드 ID와 달라야 합니다.")
                used_ids.add(node["id"])
        errors.extend(validate_stage(workflow, stage, selected))
    return list(dict.fromkeys(errors))
