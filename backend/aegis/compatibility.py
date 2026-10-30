"""Dataset criteria and visual-area validation without execution side effects."""
from __future__ import annotations

import copy
import hashlib
import json
import re
import unicodedata
from typing import Any

from .errors import ApiError


def get_workflow_rule_options(workflow: dict) -> list[dict]:
    return [{"id": rule["id"], "name": rule["name"], "kind": rule["kind"], "enabled": rule["enabled"],
             "stage": stage, "groupId": group["id"], "groupName": group["name"], "rule": copy.deepcopy(rule)}
            for stage in ("pre", "post") for group in workflow.get(stage, []) for rule in group.get("rules", [])]


def inspect_dataset_compatibility(dataset: dict, workflow: dict) -> dict:
    options = get_workflow_rule_options(workflow)
    issues: list[dict] = []
    for index, row in enumerate(dataset["rows"]):
        def add(code, message, stage=None):
            issue = {"code": code, "rowId": row["id"], "rowNumber": index + 1,
                     "severity": "warning", "message": message}
            if row.get("expectedRuleId"):
                issue["ruleId"] = row["expectedRuleId"]
            if stage:
                issue["stage"] = stage
            issues.append(issue)
        if row["expected"] == "allow" and row.get("expectedStage") and row["expectedStage"] != "complete":
            add("impossible_stage", "허용 결과는 모든 검사를 마친 완료 단계에서 반환됩니다. 예상 종료 단계를 확인하세요.")
        if row["expected"] == "block" and row.get("expectedStage") and row["expectedStage"] not in ("pre", "post"):
            add("impossible_stage", "정책 차단은 요청 검사 또는 응답 검사에서 발생합니다. 예상 종료 단계를 확인하세요.")
        from .policy_checks import select_policy_binding, workflow_policy_bindings
        binding = select_policy_binding(workflow, row.get("expectedPolicyNodeId"))
        routing = binding["routing"] if binding else None
        if any(row.get(key) for key in ("expectedDecision", "expectedRoute", "expectedPolicyCode", "expectedPolicyFields", "expectedPolicyNodeId")):
            if not binding:
                ambiguous = not row.get("expectedPolicyNodeId") and len(workflow_policy_bindings(workflow)) > 1
                add("ambiguous_policy" if ambiguous else "missing_policy", "정책 검사가 여러 개입니다. 예상 출력 조건에 사용할 정책 검사 노드를 선택하세요." if ambiguous else "예상 출력 조건에 지정한 정책 검사 노드를 찾을 수 없습니다.")
            else:
                if not binding["enabled"]:
                    add("disabled_policy", "예상 출력 조건의 정책 검사가 사용 중지되어 있습니다.", binding["stage"])
                if row.get("expectedPolicyFields"):
                    try:
                        from .output_expectations import validate_field_assertions
                        from .policies import policy_output_schema
                        validate_field_assertions(row["expectedPolicyFields"], policy_output_schema(routing["policy"]))
                    except (ValueError, TypeError, KeyError):
                        add("policy_field_mismatch", "예상 출력 필드 조건을 연결된 정책의 스키마에 맞게 확인하세요.", binding["stage"])
                routes = [node for node in routing["graph"]["nodes"] if node["kind"] == "action"] if routing["policy"].get("formatVersion", 1) == 2 else routing["routes"]
                expected_decision = row.get("expectedDecision")
                candidates = [route for route in routes if not expected_decision or route.get("decision") == expected_decision]
                if expected_decision and not candidates:
                    add("missing_policy_decision", "예상 판정 코드가 선택한 정책 버전에 없습니다.", binding["stage"])
                elif row.get("expectedRoute") and not any(route["action"] == row["expectedRoute"] for route in candidates):
                    add("policy_route_mismatch", "예상 판정과 실행 경로의 연결이 현재 정책 설정과 다릅니다.", binding["stage"])
                if row.get("expectedPolicyCode") and not any(route["action"] == "error" and route.get("errorCode") == row["expectedPolicyCode"] for route in candidates):
                    add("policy_code_mismatch", "예상 오류 코드가 현재 정책의 오류 경로에 없습니다.", binding["stage"])
        if not row.get("expectedRuleId"):
            continue
        matches = [option for option in options if option["id"] == row["expectedRuleId"]]
        if not matches:
            add("missing_rule", "지정한 검사가 이 워크플로우에 없습니다. 현재 검사를 연결하거나 예상 기준을 확인하세요.")
            continue
        if len(matches) > 1:
            add("ambiguous_rule", "같은 ID의 검사가 여러 개 있어 예상 검사를 구분할 수 없습니다. 워크플로우의 검사 ID를 확인하세요.")
            continue
        selected = matches[0]
        if not selected["enabled"]:
            add("disabled_rule", "지정한 검사가 사용 중지되어 검사 결과 일치 여부를 확인할 수 없습니다.", selected["stage"])
        if row["expected"] == "block" and row.get("expectedStage") in ("pre", "post") and row["expectedStage"] != selected["stage"]:
            label = "요청 검사" if selected["stage"] == "pre" else "응답 검사"
            add("rule_stage_mismatch", f"지정한 검사는 {label}에 있지만 예상 종료 단계가 다릅니다.", selected["stage"])
    return {"issues": issues, "affectedRowIds": list(dict.fromkeys(issue["rowId"] for issue in issues)),
            "requiresAcknowledgement": bool(issues)}


def evaluation_preflight(dataset: dict, sides: list[dict]) -> dict:
    # Lazy imports keep schema/graph helpers independent from the runtime.
    from .review import configuration_fingerprint, dataset_fingerprint, js_json_dumps
    if not isinstance(sides, list) or not 1 <= len(sides) <= 2 or any(side.get("key") not in ("candidate", "baseline") for side in sides) or len({side["key"] for side in sides}) != len(sides):
        raise ApiError("점검할 검증 대상을 확인하세요.")
    ordered = sorted(sides, key=lambda side: 0 if side["key"] == "candidate" else 1)
    data_fingerprint = dataset_fingerprint(dataset)
    side_fingerprints = [{"key": side["key"], "workflowFingerprint": configuration_fingerprint(side["workflow"], side["connections"])} for side in ordered]
    envelope = {"version": 1, "datasetFingerprint": data_fingerprint, "sides": side_fingerprints}
    fingerprint = hashlib.sha256(js_json_dumps(envelope).encode("utf-8")).hexdigest()
    issues = [{**issue, "sideKey": side["key"], "sideLabel": side["label"]}
              for side in ordered for issue in inspect_dataset_compatibility(dataset, side["workflow"])["issues"]]
    return {"fingerprint": fingerprint, "issues": issues, "requiresAcknowledgement": bool(issues),
            "sideFingerprints": side_fingerprints, "datasetFingerprint": data_fingerprint}


def _compatible_target(option: dict, rows: list[dict]) -> bool:
    return option["enabled"] and all(row["expected"] != "block" or not row.get("expectedStage") or row["expectedStage"] == option["stage"] for row in rows)


def apply_dataset_rule_mappings(dataset: dict, workflow: dict, mappings: dict) -> dict:
    unsafe = {"__proto__", "constructor", "prototype"}
    if not isinstance(mappings, dict):
        raise ApiError("연결할 예상 검사 목록을 확인하세요.")
    source_ids = {row["expectedRuleId"] for row in dataset["rows"] if row.get("expectedRuleId")}
    if len(mappings) > 100 or any(source in unsafe or source not in source_ids or not isinstance(target, str) or not target.strip() or len(target.encode("utf-16-le", "surrogatepass")) // 2 > 120 or target in unsafe for source, target in mappings.items()):
        raise ApiError("데이터셋에서 사용하는 검사 ID와 연결할 대상 검사를 확인하세요.")
    options = get_workflow_rule_options(workflow)
    result = copy.deepcopy(dataset)
    for row in result["rows"]:
        if not row.get("expectedRuleId"):
            continue
        target_id = mappings.get(row["expectedRuleId"], row["expectedRuleId"])
        targets = [option for option in options if option["id"] == target_id]
        if len(targets) != 1:
            raise ApiError("현재 워크플로우에 없는 예상 검사가 남아 있습니다. 각 항목의 대상 검사를 선택하세요.")
        if not targets[0]["enabled"]:
            raise ApiError("사용 중지된 검사에는 예상 검사를 연결할 수 없습니다. 다른 검사를 선택하세요.")
        if not _compatible_target(targets[0], [row]):
            raise ApiError("예상 종료 단계와 대상 검사 구간이 다릅니다. 데이터셋의 단계를 수정하거나 같은 구간의 검사를 선택하세요.")
        row["expectedRuleId"] = target_id
    return result


def _normalize(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value).lower()).strip()


def suggest_dataset_rule_mappings(dataset: dict, target_workflow: dict, state: dict) -> list[dict]:
    from .review import canonical
    target_options = get_workflow_rule_options(target_workflow)
    counts = {option["id"]: sum(candidate["id"] == option["id"] for candidate in target_options) for option in target_options}
    source_ids = list(dict.fromkeys(row["expectedRuleId"] for row in dataset["rows"] if row.get("expectedRuleId")))
    source_workflows = [*state.get("workflows", []), *[item["workflow"] for item in state.get("deployments", [])]]
    for run in state.get("runs", []):
        source_workflows.extend(run[key] for key in ("workflowSnapshot", "baselineWorkflowSnapshot") if run.get(key))
    known = [option for workflow in source_workflows for option in get_workflow_rule_options(workflow) if option["id"] in source_ids]
    lineage = target_workflow.get("cloneSource", {}).get("ruleIds", {})
    suggestions = []
    for source_id in source_ids:
        rows = [row for row in dataset["rows"] if row.get("expectedRuleId") == source_id]
        candidates = [option for option in target_options if counts[option["id"]] == 1 and _compatible_target(option, rows)]
        current = next((option for option in candidates if option["id"] == source_id), None)
        sources = [option for option in known if option["id"] == source_id]
        variants = {canonical({"name": _normalize(option["name"]), "kind": option["kind"], "stage": option["stage"], "config": option["rule"]["config"]}): option for option in sources}
        unique = next(iter(variants.values())) if len(variants) == 1 else None
        names = list(dict.fromkeys(option["name"] for option in sources))
        base = {"sourceRuleId": source_id, "rowIds": [row["id"] for row in rows], "candidates": candidates,
                "reason": "", "ambiguous": False, "requiresMapping": current is None}
        if len(names) == 1:
            base["sourceName"] = names[0]
        if unique:
            base.update(sourceKind=unique["kind"], sourceStage=unique["stage"])
        linked = next((option for option in candidates if option["id"] == lineage.get(source_id)), None)
        if current:
            base.update(suggestedRuleId=current["id"], reason="현재 워크플로우에서 같은 검사 ID를 사용하고 있습니다.")
        elif linked:
            base.update(suggestedRuleId=linked["id"], reason="복제 연결 정보에 기록된 검사입니다. 현재 설정을 확인한 뒤 저장하세요.")
        elif not candidates:
            base["reason"] = "사용 중인 검사와 예상 종료 단계가 맞는 대상이 없습니다. 먼저 검사 사용 여부나 데이터셋의 단계를 확인하세요."
        elif len(variants) > 1:
            base.update(ambiguous=True, reason="원래 검사의 기록마다 이름이나 설정이 다릅니다. 연결할 검사를 직접 선택하세요.")
        elif not unique:
            base["reason"] = "원래 검사 정보를 찾지 못했습니다. 연결할 검사를 직접 선택하세요."
        else:
            matches = [option for option in candidates if _normalize(option["name"]) == _normalize(unique["name"]) and option["kind"] == unique["kind"] and option["stage"] == unique["stage"]]
            if len(matches) == 1:
                base.update(suggestedRuleId=matches[0]["id"], reason="이름과 종류, 검사 구간이 같은 검사를 찾았습니다. 설정을 확인한 뒤 저장하세요.")
            else:
                base.update(ambiguous=len(matches) > 1, reason="같은 이름과 종류의 검사가 여러 개입니다. 연결할 검사를 직접 선택하세요." if len(matches) > 1 else "같은 이름과 종류의 검사를 찾지 못했습니다. 연결할 검사를 직접 선택하세요.")
        suggestions.append(base)
    return suggestions


def _visible_keys(workflow: dict) -> tuple[list[str], set[str], dict[str, str]]:
    keys = ["input", "main", "output"]
    aliases = {key: key for key in keys}
    all_keys = set(keys)
    for stage in ("pre", "post"):
        for group in workflow.get(stage, []):
            visible = f"rule:{group['rules'][0]['id']}" if len(group.get("rules", [])) == 1 else f"group:{group['id']}"
            keys.append(visible)
            for alias in [f"group:{group['id']}", *[f"rule:{rule['id']}" for rule in group.get("rules", [])]]:
                aliases[alias] = visible
                all_keys.add(alias)
        for node in workflow.get("graph", {}).get(stage, {}).get("nodes", []):
            key = f"control:{node['id']}"
            keys.append(key)
            aliases[key] = key
            all_keys.add(key)
    routing = workflow.get("policyRouting")
    if routing:
        keys.append("policy")
        aliases["policy"] = "policy"
        all_keys.add("policy")
        if routing["policy"].get("formatVersion", 1) == 2:
            for node in routing.get("graph", {}).get("nodes", []):
                key = f"policy-node:{node['id']}"
                keys.append(key)
                aliases[key] = key
                all_keys.add(key)
    from .policy_checks import workflow_policy_bindings
    for binding in workflow_policy_bindings(workflow):
        if "rule" not in binding or binding["routing"]["policy"].get("formatVersion", 1) != 2:
            continue
        for node in binding["routing"].get("graph", {}).get("nodes", []):
            key = f"policy-node:{binding['id']}/{node['id']}"
            keys.append(key)
            aliases[key] = key
            all_keys.add(key)
    return keys, all_keys, aliases


def _zone_graph(workflow: dict) -> tuple[list[str], dict[str, list[str]], dict[str, list[str]], dict[str, str]]:
    from .graph import get_stage_graph
    keys, _, aliases = _visible_keys(workflow)
    outgoing = {key: [] for key in keys}
    incoming = {key: [] for key in keys}
    routing = workflow.get("policyRouting")
    def connect(start, end):
        if start in outgoing and end in incoming and start != end and end not in outgoing[start]:
            outgoing[start].append(end)
            incoming[end].append(start)
    for stage in ("pre", "post"):
        def endpoint(key):
            if key == "start":
                return "input" if stage == "pre" else "main"
            if key == "end":
                return ("policy" if routing else "main") if stage == "pre" else "output"
            return aliases.get(key)
        from .policy_checks import workflow_policy_bindings
        bindings = [item for item in workflow_policy_bindings(workflow) if item["stage"] == stage and "rule" in item and item["routing"]["policy"].get("formatVersion", 1) == 2]
        by_group = {f"group:{item['group']['id']}": item for item in bindings}
        for edge in get_stage_graph(workflow, stage).get("edges", []):
            binding = by_group.get(edge["from"])
            sources = [f"policy-node:{binding['id']}/{node['id']}" for node in binding["routing"]["graph"]["nodes"] if node["kind"] == "action" and node["action"] == "main"] if binding else [endpoint(edge["from"])]
            for start in sources:
                connect(start, endpoint(edge["to"]))
        for binding in bindings:
            plan, owner = binding["routing"]["graph"], binding["id"]
            connect(aliases[f"rule:{owner}"], f"policy-node:{owner}/{plan['entryNodeId']}")
            for edge in plan["edges"]:
                connect(f"policy-node:{owner}/{edge['from']}", f"policy-node:{owner}/{edge['to']}")
            for node in plan["nodes"]:
                if node["kind"] == "action" and node["action"] == "error":
                    connect(f"policy-node:{owner}/{node['id']}", "output")
    if routing:
        def post_endpoint(key):
            return "output" if key == "end" else aliases.get(key)
        post_targets = [post_endpoint(edge["to"]) for edge in get_stage_graph(workflow, "post").get("edges", []) if edge["from"] == "start"]
        def action_targets(action):
            return ["main"] if action == "main" else post_targets if action == "respond" else ["output"]
        if routing["policy"].get("formatVersion", 1) == 2:
            graph = routing.get("graph", {})
            connect("policy", f"policy-node:{graph.get('entryNodeId', '')}")
            for edge in graph.get("edges", []):
                connect(f"policy-node:{edge['from']}", f"policy-node:{edge['to']}")
            for node in graph.get("nodes", []):
                if node["kind"] == "action":
                    for target in action_targets(node["action"]):
                        connect(f"policy-node:{node['id']}", target)
        else:
            for route in routing.get("routes", []):
                for target in action_targets(route["action"]):
                    connect("policy", target)
    return keys, outgoing, incoming, aliases


def _reachable(start: str, edges: dict[str, list[str]]) -> set[str]:
    visited = set()
    pending = [start]
    while pending:
        key = pending.pop()
        if key not in visited:
            visited.add(key)
            pending.extend(edges.get(key, []))
    return visited


def zone_membership_issue(workflow: dict, node_keys: list[str]) -> str | None:
    keys, outgoing, incoming, aliases = _zone_graph(workflow)
    if any(key not in aliases for key in node_keys):
        return "영역에 없는 노드가 포함되어 있습니다. 현재 흐름의 노드를 다시 선택하세요."
    selected = set(aliases[key] for key in node_keys)
    if len(selected) < 2:
        return None
    visited = set()
    pending = [next(iter(selected))]
    while pending:
        key = pending.pop()
        if key not in visited and key in selected:
            visited.add(key)
            pending.extend(outgoing[key] + incoming[key])
    if visited != selected:
        return "영역에는 흐름에서 이어진 노드만 포함할 수 있습니다. 떨어진 노드 사이의 노드도 함께 선택하세요."
    forward, backward = set(), set()
    for key in selected:
        forward.update(_reachable(key, outgoing))
        backward.update(_reachable(key, incoming))
    if any(key not in selected and key in forward and key in backward for key in keys):
        return "영역 사이에 빠진 노드가 있습니다. 선택한 노드 사이의 모든 경로를 함께 포함하세요."
    return None


def validate_zones(workflow: dict) -> list[str]:
    """Check only layout references/membership; never mutate execution edges."""
    keys, all_keys, _ = _visible_keys(workflow)
    visible = set(keys)
    layout = workflow.get("layout", {})
    issues = []
    if any(key not in all_keys for key in layout.get("positions", {})):
        issues.append("노드 위치에 현재 워크플로우에 없는 노드가 포함되어 있습니다.")
    pins = layout.get("pinnedKeys", [])
    if any(key not in visible for key in pins) or len(pins) != len(set(pins)):
        issues.append("위치를 고정할 노드를 현재 화면에서 다시 선택하세요.")
    zones = layout.get("zones", [])
    if len(zones) > 32:
        issues.append("영역은 최대 32개까지 저장할 수 있습니다.")
    zone_ids, assigned = set(), set()
    for zone in zones:
        if zone["id"] in zone_ids:
            issues.append("구역 ID는 서로 달라야 합니다.")
        zone_ids.add(zone["id"])
        members = zone.get("nodeKeys", [])
        if len(members) != len(set(members)):
            issues.append("같은 구역에 노드를 중복해서 포함할 수 없습니다.")
        if any(key not in visible for key in members):
            issues.append("구역에는 현재 캔버스에 표시되는 노드만 포함할 수 있습니다.")
        if assigned.intersection(members):
            issues.append("한 노드는 하나의 구역에만 포함할 수 있습니다.")
        assigned.update(members)
        membership = zone_membership_issue(workflow, members)
        if membership:
            issues.append(f"{zone['name']}: {membership}")
    return list(dict.fromkeys(issues))
