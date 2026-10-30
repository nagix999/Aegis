"""Independent versioned policy checks share PRE/POST scheduling and privacy."""
import copy
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from aegis import engine
from aegis.api import create_router, record_log, validate_snapshot_connections
from aegis.compatibility import inspect_dataset_compatibility
from aegis.compatibility import validate_zones, zone_membership_issue
from aegis.errors import ApiError
from aegis.policy_checks import select_policy_binding
from aegis.review import configuration_fingerprint, matches_expectation
from aegis.schemas import validate_payload
from aegis.store import Store


def fixture():
    state = json.loads((Path(__file__).parents[1] / "aegis" / "seed.json").read_text())
    workflow = state["workflows"][0]
    workflow.update(pre=[], post=[])
    workflow.pop("graph", None)
    guard = state["connections"][1]
    policy = {"id": "checks-policy", "name": "구조화 검사", "description": "", "prompt": "PRIVATE_POLICY_PROMPT",
              "connectionId": guard["id"], "connectionSnapshot": copy.deepcopy(guard), "version": 1, "updatedAt": "2026-10-30T00:00:00Z",
              "formatVersion": 2, "outputSchema": {"type": "object", "properties": {"ok": {"type": "boolean"}, "private": {"type": "string"}}, "required": ["ok", "private"], "additionalProperties": False},
              "decisions": [], "examples": [{"id": "request", "input": "request", "expectedOutput": {"ok": True, "private": "PRIVATE_JSON"}}, {"id": "response", "input": "response", "expectedOutput": {"ok": True, "private": "PRIVATE_JSON"}}]}
    routing = {"policy": policy, "routes": [], "graph": {"version": 1, "entryNodeId": "check", "nodes": [
        {"id": "check", "name": "필드 분기", "kind": "switch", "path": "/ok", "cases": [{"id": "yes", "value": True}]},
        {"id": "continue", "name": "계속", "kind": "action", "action": "main"},
        {"id": "deny", "name": "차단", "kind": "action", "action": "error", "errorCode": "NODE_DENIED", "errorMessage": "등록된 공개 오류"}],
        "edges": [{"id": "ok", "from": "check", "to": "continue", "port": "yes"}, {"id": "other", "from": "check", "to": "deny", "port": "default"}]}}
    return state, workflow, routing


def group(identifier, routing):
    return {"id": f"group-{identifier}", "name": identifier, "mode": "any", "rules": [{"id": identifier, "name": identifier, "description": "", "enabled": True, "kind": "policy", "config": {"policyRouting": copy.deepcopy(routing)}}]}


async def run(state, workflow, **kwargs):
    return await engine.execute_workflow(workflow, state["connections"], state["ingress"], {}, [{"role": "user", "content": "request"}], {"mockResponse": "response"}, **kwargs)


async def test_multiple_pre_and_post_checks_keep_metadata_separate_and_private():
    state, workflow, routing = fixture()
    workflow.update(pre=[group("pre-a", routing), group("pre-b", routing)], post=[group("post-a", routing), group("post-b", routing)])
    assert validate_payload("workflow", workflow) == workflow
    assert engine.validate_workflow(workflow, state["connections"]) == []
    fields = [{"path": "/ok", "operator": "eq", "value": True}]
    result = await run(state, workflow, expected_policy_fields=fields, expected_policy_node_id="post-b")
    assert result["status"] == "allow" and result["output"] == "response"
    assert [(item["ruleId"], item["stage"], item["status"]) for item in result["policyChecks"]] == [("pre-a", "pre", "allow"), ("pre-b", "pre", "allow"), ("post-a", "post", "allow"), ("post-b", "post", "allow")]
    assert all(item["policyId"] == routing["policy"]["id"] and item["policyVersion"] == 1 for item in result["policyChecks"])
    assert [item["ruleId"] for item in result["policyChecks"] if "fieldChecks" in item] == ["post-b"]
    assert matches_expectation({"expected": "allow", "expectedPolicyNodeId": "post-b", "expectedRoute": "main", "expectedPolicyFields": fields}, result, workflow)
    assert "PRIVATE_JSON" not in json.dumps(result) and "PRIVATE_POLICY_PROMPT" not in json.dumps(result)
    assert "PRIVATE_JSON" not in json.dumps(record_log(result, "playground", workflow, "draft"))


async def test_pre_policy_block_skips_main_and_returns_only_registered_error():
    state, workflow, routing = fixture()
    routing["policy"]["examples"][0]["expectedOutput"]["ok"] = False
    workflow.update(pre=[group("pre-deny", routing), group("never", routing)], post=[group("post", routing)])
    result = await run(state, workflow)
    assert result["status"] == "block" and result["stage"] == "pre" and result["output"] == ""
    assert result["policyCode"] == "NODE_DENIED" and result["publicMessage"] == "등록된 공개 오류"
    assert [(item["ruleId"], item["status"]) for item in result["policyChecks"]] == [("pre-deny", "block")]
    assert any(trace["ruleId"] == "main" and trace["status"] == "skipped" for trace in result["traces"])


async def test_post_policy_block_retries_all_post_checks_at_most_three_times():
    state, workflow, routing = fixture()
    denied = copy.deepcopy(routing)
    denied["policy"]["examples"][1]["expectedOutput"]["ok"] = False
    workflow.update(pre=[group("pre", routing)], post=[group("post-first", routing), group("post-deny", denied)], responseRetry={"enabled": True, "maxRetries": 3})
    seen = []
    class Observer:
        def main_input(self, messages, attempt, settings=None):
            seen.append(copy.deepcopy(messages))
    result = await run(state, workflow, inspection=Observer())
    assert result["status"] == "block" and result["stage"] == "post" and result["output"] == "" and result["regenerationCount"] == 3
    assert result["policyCode"] == "NODE_DENIED"
    assert [(item["ruleId"], item.get("attempt")) for item in result["policyChecks"]] == [("pre", None)] + [(identifier, attempt) for attempt in range(1, 5) for identifier in ("post-first", "post-deny")]
    assert len(seen) == 4
    assert "PRIVATE_POLICY_PROMPT" not in json.dumps(seen) and "PRIVATE_JSON" not in json.dumps(seen)


async def test_post_policy_schema_error_stops_without_rewriting(monkeypatch):
    state, workflow, routing = fixture()
    routing["policy"]["connectionSnapshot"].update(mode="vllm", baseUrl="https://policy.example/v1")
    workflow.update(post=[group("post", routing)], responseRetry={"enabled": True, "maxRetries": 3})
    async def invalid(*args, **kwargs):
        return {"content": '{"private":"PRIVATE_INVALID_JSON"}', "finishReason": "stop"}
    monkeypatch.setattr(engine, "model_chat", invalid)
    result = await run(state, workflow)
    assert result["status"] == "error" and result["stage"] == "post" and result["output"] == "" and result["regenerationCount"] == 0
    assert len(result["policyChecks"]) == 1 and result["policyChecks"][0]["status"] == "error"
    assert "PRIVATE_INVALID_JSON" not in json.dumps(result)


async def test_successful_post_rewrite_clears_previous_public_error_metadata(monkeypatch):
    state, workflow, routing = fixture()
    routing["policy"]["connectionSnapshot"].update(mode="vllm", baseUrl="https://policy.example/v1")
    workflow.update(post=[group("post", routing)], responseRetry={"enabled": True, "maxRetries": 3})
    calls = []
    async def classified(*args, **kwargs):
        calls.append(args[3])
        return {"content": json.dumps({"ok": len(calls) > 1, "private": "PRIVATE_JSON"}), "finishReason": "stop"}
    monkeypatch.setattr(engine, "model_chat", classified)
    fields = [{"path": "/ok", "operator": "eq", "value": True}]
    result = await run(state, workflow, expected_policy_fields=fields, expected_policy_node_id="post")
    assert result["status"] == "allow" and result["output"] == "response" and result["regenerationCount"] == 1
    assert "policyCode" not in result and "publicMessage" not in result
    assert [(item["status"], item["attempt"], item.get("policyCode")) for item in result["policyChecks"]] == [("block", 1, "NODE_DENIED"), ("allow", 2, None)]
    assert matches_expectation({"expected": "allow", "expectedPolicyNodeId": "post", "expectedRoute": "main", "expectedPolicyFields": fields}, result, workflow)


async def test_policy_selector_is_explicit_when_multiple_and_unreached_never_matches():
    state, workflow, routing = fixture()
    workflow.update(pre=[group("pre", routing)], post=[group("post", routing)])
    fields = [{"path": "/ok", "operator": "eq", "value": True}]
    row = {"id": "row", "input": "request", "expected": "allow", "expectedPolicyFields": fields}
    assert select_policy_binding(workflow) is None
    assert inspect_dataset_compatibility({"rows": [row]}, workflow)["issues"][0]["code"] == "ambiguous_policy"
    result = await run(state, workflow, expected_policy_fields=fields)
    assert result["status"] == "allow" and result["policyFieldChecks"][0]["matched"] is False
    assert not matches_expectation(row, result, workflow)
    row["expectedPolicyNodeId"] = "post"
    selected = await run(state, workflow, expected_policy_fields=fields, expected_policy_node_id="post")
    assert matches_expectation(row, selected, workflow)
    selected["policyChecks"] = [item for item in selected["policyChecks"] if item["ruleId"] != "post"]
    assert not matches_expectation(row, selected, workflow)


async def test_unique_policy_is_automatic_and_legacy_binding_keeps_precedence():
    state, workflow, routing = fixture()
    workflow["post"] = [group("post", routing)]
    fields = [{"path": "/ok", "operator": "eq", "value": True}]
    assert select_policy_binding(workflow)["id"] == "post"
    result = await run(state, workflow, expected_policy_fields=fields)
    assert result["policyChecks"][0]["fieldChecks"][0]["matched"] is True
    assert matches_expectation({"expected": "allow", "expectedRoute": "main", "expectedPolicyFields": fields}, result, workflow)
    workflow["policyRouting"] = copy.deepcopy(routing)
    assert select_policy_binding(workflow)["id"] == "policy"
    result = await run(state, workflow, expected_policy_fields=fields)
    assert [item["ruleId"] for item in result["policyChecks"] if "fieldChecks" in item] == ["policy"]
    assert matches_expectation({"expected": "allow", "expectedPolicyFields": fields}, result, workflow)


async def test_policy_checks_follow_condition_and_parallel_join_and_namespace_child_progress():
    state, workflow, routing = fixture()
    workflow["pre"] = [group("left", routing), group("right", routing)]
    workflow["graph"] = {"version": 1, "pre": {"nodes": [{"id": "condition", "name": "조건", "kind": "condition", "condition": {"operator": "contains", "value": "request"}}, {"id": "join", "name": "합류", "kind": "join"}], "edges": [{"id": "start", "from": "start", "to": "control:condition"}, {"id": "left", "from": "control:condition", "to": "group:group-left", "port": "true"}, {"id": "right", "from": "control:condition", "to": "group:group-right", "port": "false"}, {"id": "left-end", "from": "group:group-left", "to": "control:join"}, {"id": "right-end", "from": "group:group-right", "to": "control:join"}, {"id": "end", "from": "control:join", "to": "end"}]}, "post": {"nodes": [], "edges": [{"id": "post-end", "from": "start", "to": "end"}]}}
    events = []
    result = await run(state, workflow, on_progress=events.append)
    assert result["status"] == "allow"
    assert [item["ruleId"] for item in result["policyChecks"]] == ["left"]
    assert any(item["nodeId"] == "policy:left/check" and item["stage"] == "pre" for item in events)
    assert any(trace["ruleId"] == "right" and trace["status"] == "skipped" for trace in result["traces"])
    workflow["graph"]["pre"]["nodes"][0] = {"id": "condition", "name": "병렬", "kind": "fork"}
    for edge in workflow["graph"]["pre"]["edges"]:
        edge.pop("port", None)
    result = await run(state, workflow)
    assert result["status"] == "allow" and {item["ruleId"] for item in result["policyChecks"]} == {"left", "right"}


def test_scoped_children_are_valid_layout_keys_and_obey_zone_continuity():
    _, workflow, routing = fixture()
    workflow["pre"] = [group("check", routing)]
    workflow["layout"] = {"version": 1, "positions": {"policy-node:check/check": {"x": 10, "y": 20}}, "pinnedKeys": ["policy-node:check/check"]}
    assert validate_payload("workflow", workflow)
    assert validate_zones(workflow) == []
    assert zone_membership_issue(workflow, ["rule:check", "policy-node:check/check"]) is None
    assert zone_membership_issue(workflow, ["rule:check", "policy-node:check/continue"])


def test_final_attempt_cannot_reuse_an_earlier_selected_policy_result():
    _, workflow, routing = fixture()
    workflow["post"] = [group("post", routing)]
    result = {"status": "block", "stage": "post", "traces": [], "attempts": [{"number": 1}, {"number": 2}], "policyChecks": [{"ruleId": "post", "stage": "post", "attempt": 1, "status": "block", "route": "error", "policyCode": "NODE_DENIED"}]}
    assert not matches_expectation({"expected": "block", "expectedPolicyNodeId": "post", "expectedPolicyCode": "NODE_DENIED"}, result, workflow)


def test_policy_capacity_respond_singleton_and_reserved_selector_are_validated():
    state, workflow, routing = fixture()
    workflow["pre"] = [group(f"check-{index}", routing) for index in range(12)]
    assert validate_payload("workflow", workflow)
    workflow["post"] = [group("extra", routing)]
    with pytest.raises(ApiError, match="12"):
        validate_payload("workflow", workflow)
    assert any("12" in issue for issue in engine.validate_workflow(workflow, state["connections"]))
    workflow.update(pre=[group("check", routing)], post=[])
    duplicate = copy.deepcopy(workflow["pre"][0]["rules"][0]); duplicate["id"] = "second"
    workflow["pre"][0]["rules"].append(duplicate)
    with pytest.raises(ApiError, match="독립"):
        validate_payload("workflow", workflow)
    workflow["pre"] = [group("policy", routing)]
    with pytest.raises(ApiError, match="정책 검사 ID"):
        validate_payload("workflow", workflow)
    routing["graph"]["nodes"][1].update(action="respond", responseText="응답")
    workflow["pre"] = [group("check", routing)]
    with pytest.raises(ApiError, match="직접 응답"):
        validate_payload("workflow", workflow)


def test_nested_policy_fingerprint_ignores_labels_and_tracks_actual_configuration():
    state, workflow, routing = fixture()
    workflow["pre"] = [group("check", routing)]
    original = configuration_fingerprint(workflow, state["connections"])
    renamed = copy.deepcopy(workflow)
    snapshot = renamed["pre"][0]["rules"][0]["config"]["policyRouting"]
    snapshot["policy"].update(name="다른 이름", version=2, updatedAt="later")
    snapshot["policy"]["connectionSnapshot"]["name"] = "다른 모델 이름"
    snapshot["graph"]["nodes"][0]["name"] = "다른 분기 이름"
    assert configuration_fingerprint(renamed, state["connections"]) == original
    snapshot["policy"]["prompt"] = "새 지침"
    assert configuration_fingerprint(renamed, state["connections"]) != original


def test_nested_policy_upstream_uses_frozen_snapshot_origin_and_secret_reference():
    _, workflow, routing = fixture()
    routing["policy"]["connectionSnapshot"].update(mode="vllm", baseUrl="http://policy.internal:8000/v1", secretEnv="SYNTHETIC_POLICY_KEY")
    workflow["post"] = [group("post", routing)]
    with pytest.raises(ApiError, match="허용 모델"):
        validate_snapshot_connections([], {"allowedOrigins": []}, {}, workflow)
    with pytest.raises(ApiError, match="환경변수"):
        validate_snapshot_connections([], {"allowedOrigins": ["http://policy.internal:8000"]}, {}, workflow)
    validate_snapshot_connections([], {"allowedOrigins": ["http://policy.internal:8000"]}, {"SYNTHETIC_POLICY_KEY": "test-placeholder"}, workflow)


async def test_api_requires_registered_nested_snapshot_and_deployment_keeps_it_immutable():
    store = Store(); await store.seed()
    state, workflow, routing = fixture()
    app = FastAPI(); app.include_router(create_router(store, {}))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 1)), base_url="http://test") as client:
            definition = {key: value for key, value in routing["policy"].items() if key not in {"connectionSnapshot", "version", "updatedAt"}}
            response = await client.post("/api/console", json={"action": "save_policy", "policy": definition, "expectedVersion": 0})
            assert response.status_code == 200, response.text
            routing["policy"] = response.json()["policy"]
            workflow.update(pre=[group("pre", routing)], post=[group("post", routing)])
            saved = await client.post("/api/console", json={"action": "save_workflow", "workflow": workflow})
            assert saved.status_code == 200, saved.text
            forged = copy.deepcopy(workflow); forged["post"][0]["rules"][0]["config"]["policyRouting"]["policy"]["prompt"] = "forged"
            rejected = await client.post("/api/console", json={"action": "save_workflow", "workflow": forged})
            assert rejected.status_code == 400 and rejected.json()["error"]["code"] == "invalid_policy_snapshot"
            published = await client.post("/api/console", json={"action": "publish", "workflowId": workflow["id"]})
            assert published.status_code == 200, published.text
            deployment = published.json()["deployment"]
            definition["prompt"] = "새 지침"
            changed = await client.post("/api/console", json={"action": "save_policy", "policy": definition, "expectedVersion": 1})
            assert changed.status_code == 200
            retained = await store.get_deployment(deployment["id"])
            assert retained["workflow"]["post"][0]["rules"][0]["config"]["policyRouting"]["policy"] == routing["policy"]
            # Archiving preserves immutable revisions and their existing users.
            archived = await client.post("/api/console", json={"action": "set_policy_archived", "policyId": definition["id"], "archived": True})
            assert archived.status_code == 200, archived.text
            assert (await store.get_record("policy", f"{definition['id']}:1")) == routing["policy"]
            restored = await client.post("/api/console", json={"action": "rollback_deployment", "deploymentId": deployment["id"]})
            assert restored.status_code == 200, restored.text
            restored_workflow = restored.json()["deployment"]["workflow"]
            assert restored_workflow["pre"][0]["rules"][0]["config"]["policyRouting"]["policy"] == routing["policy"]
            assert restored_workflow["post"][0]["rules"][0]["config"]["policyRouting"]["policy"] == routing["policy"]
            result = await run(state, restored_workflow)
            assert result["status"] == "allow" and len(result["policyChecks"]) == 2
    finally:
        await store.close()


async def test_observer_mutation_cannot_change_policy_routing_and_logs_discard_raw_fields():
    state, workflow, routing = fixture()
    workflow["pre"] = [group("pre", routing)]
    class Observer:
        def policy_output(self, output, *args):
            output["ok"] = False
        def rule_input(self, stage, rule, *args):
            rule["config"]["policyRouting"]["graph"]["nodes"][1]["action"] = "error"
    result = await run(state, workflow, inspection=Observer())
    assert result["status"] == "allow"
    result["policyChecks"][0].update(output={"private": "PRIVATE_JSON"}, rawOutput="PRIVATE_RAW", fieldChecks=[{"actual": "PRIVATE_ACTUAL"}])
    store = Store()
    try:
        await store.seed()
        await store.log(record_log(result, "playground", workflow, "draft"))
        saved = (await store.state())["logs"][0]
        assert saved["policyChecks"][0]["ruleId"] == "pre"
        assert "PRIVATE_" not in json.dumps(saved)
    finally:
        await store.close()
