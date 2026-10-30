"""Only an explicitly selected legacy response action may skip POST checks."""
import copy
import json

import pytest
from pydantic import ValidationError

from aegis import engine
from aegis.compatibility import _zone_graph, zone_membership_issue
from aegis.console_inspection import ConsoleInspection
from aegis.review import configuration_fingerprint
from aegis.schemas import PolicyActionNode, PolicyRoute, validate_payload
from test_policies import definition, routing
from test_policy_graph import api_fixture, fixture as graph_fixture, messages, post_rule, save_workflow


def fixture(version=2):
    state, workflow = graph_fixture()
    text = "날씨"
    if version == 1:
        guard = state["connections"][1]
        policy = {**definition(guard["id"]), "connectionSnapshot": copy.deepcopy(guard), "version": 1, "updatedAt": "2026-10-30T00:00:00Z"}
        workflow["policyRouting"] = routing(policy)
        text = "날씨 문의"
    workflow["post"] = [post_rule("REGISTERED_RESPONSE")]
    response = next(item for item in workflow["policyRouting"].get("graph", {}).get("nodes", workflow["policyRouting"]["routes"]) if item.get("action") == "respond")
    response["responseText"] = "  REGISTERED_RESPONSE\n "
    return state, workflow, response, text


@pytest.mark.parametrize("version", [1, 2])
@pytest.mark.parametrize("mode", [None, "post", "immediate"], ids=["existing-default", "explicit-post", "explicit-immediate"])
@pytest.mark.parametrize("retry", [False, True])
async def test_selected_response_mode_preserves_default_post_and_never_calls_main(version, mode, retry):
    state, workflow, response, text = fixture(version)
    if mode is not None:
        response["responseMode"] = mode
    if retry:
        workflow["responseRetry"] = {"enabled": True, "maxRetries": 3}
    before = copy.deepcopy(workflow)
    events = []
    inspection = ConsoleInspection(workflow, messages(text))
    result = await engine.execute_workflow(workflow, state["connections"], state["ingress"], {}, messages(text), on_progress=events.append, inspection=inspection)
    assert workflow == before and result["policyRoute"] == "respond"
    assert result["policyResponseMode"] == (mode or "post")
    assert next(trace for trace in result["traces"] if trace["ruleId"] == "main")["status"] == "skipped"
    post = next(trace for trace in result["traces"] if trace["ruleId"] == "post-rule")
    if mode == "immediate":
        assert result["status"] == "allow" and result["stage"] == "complete" and result["output"] == response["responseText"]
        assert post["status"] == "skipped" and all(event["status"] == "skipped" for event in events if event["stage"] == "post")
        details = inspection.finalize(result)
        assert next(node for node in details["nodes"] if node["nodeId"] == "rule:post-rule")["status"] == "skipped"
    else:
        assert result["status"] == "block" and result["stage"] == "post" and result["output"] == ""
        assert post["status"] == "block" and "REGISTERED_RESPONSE" not in json.dumps(result)
    if retry:
        assert result["regenerationCount"] == 0 and len(result["attempts"]) == (0 if mode == "immediate" else 1)
    assert "PRIVATE_POLICY_OUTPUT" not in json.dumps(result)


@pytest.mark.parametrize("version", [1, 2])
async def test_immediate_response_does_not_bypass_pre_checks(version):
    state, workflow, response, text = fixture(version)
    response["responseMode"] = "immediate"
    workflow["pre"] = [post_rule(text)]
    workflow["post"] = []
    result = await engine.execute_workflow(workflow, state["connections"], state["ingress"], {}, messages(text))
    assert result["status"] == "block" and result["stage"] == "pre" and result["output"] == ""
    assert "policyRoute" not in result and "policyResponseMode" not in result


@pytest.mark.parametrize("model", [PolicyRoute, PolicyActionNode])
def test_response_mode_is_optional_camel_case_and_valid_only_on_response_actions(model):
    base = {"decision": "RESPOND"} if model is PolicyRoute else {"id": "reply", "name": "안내 응답", "kind": "action"}
    original = {**base, "action": "respond", "responseText": " 안내 "}
    assert model.model_validate(original).model_dump(exclude_none=True) == original
    for mode in ("post", "immediate"):
        value = {**original, "responseMode": mode}
        assert model.model_validate(value).model_dump(exclude_none=True) == value
    for mode in (None, True, 1, "IMMEDIATE", "unknown"):
        with pytest.raises(ValidationError):
            model.model_validate({**original, "responseMode": mode})
    with pytest.raises(ValidationError):
        model.model_validate({**original, "response_mode": "immediate"})
    for value in ({**base, "action": "main"}, {**base, "action": "error", "errorCode": "DENIED", "errorMessage": "차단"}):
        with pytest.raises(ValidationError, match="안내 응답"):
            model.model_validate({**value, "responseMode": "post"})


@pytest.mark.parametrize("version", [1, 2])
def test_response_mode_is_preserved_in_workflow_and_execution_fingerprint(version):
    state, workflow, response, _ = fixture(version)
    before = configuration_fingerprint(workflow, state["connections"])
    response["responseMode"] = "post"
    assert configuration_fingerprint(workflow, state["connections"]) == before
    response["responseMode"] = "immediate"
    assert configuration_fingerprint(workflow, state["connections"]) != before
    assert validate_payload("workflow", workflow) == workflow
    if version == 2:
        _, outgoing, _, _ = _zone_graph(workflow)
        assert outgoing["policy-node:respond-action"] == ["output"]
        assert zone_membership_issue(workflow, ["policy-node:respond-action", "output"]) is None
        assert zone_membership_issue(workflow, ["policy-node:respond-action", "rule:post-rule"])


@pytest.mark.parametrize("mode", ["post", "immediate"])
async def test_new_standalone_policy_check_still_rejects_respond(mode):
    from test_policy_check_nodes import fixture as check_fixture, group
    state, workflow, routing = check_fixture()
    action = next(node for node in routing["graph"]["nodes"] if node.get("action") == "main")
    action.update(action="respond", responseText="안내", responseMode=mode)
    workflow["pre"] = [group("check", routing)]
    assert any("직접 응답" in issue for issue in engine.validate_workflow(workflow, state["connections"]))


async def test_gateway_and_evaluation_share_the_deployed_response_mode_and_rollback_snapshot(api_fixture):
    client, store, _, workflow = api_fixture
    response = next(node for node in workflow["policyRouting"]["graph"]["nodes"] if node.get("action") == "respond")
    response.update(responseMode="immediate", responseText="REGISTERED_RESPONSE")
    workflow["post"] = [post_rule("REGISTERED_RESPONSE")]
    workflow["responseRetry"] = {"enabled": True, "maxRetries": 3}
    workflow = await save_workflow(client, workflow)
    published = await client.post("/api/console", json={"action": "publish", "workflowId": workflow["id"]})
    assert published.status_code == 200, published.text
    original = published.json()["deployment"]
    created = await client.post("/api/console", json={"action": "create_key", "name": "response mode regression"})
    headers = {"Authorization": "Bearer " + created.json()["key"]}
    gateway = {"model": workflow["alias"], "messages": messages("날씨")}
    allowed = await client.post("/v1/chat/completions", headers=headers, json=gateway)
    assert allowed.status_code == 200 and allowed.json()["choices"][0]["message"]["content"] == "REGISTERED_RESPONSE"
    changed = copy.deepcopy(workflow)
    next(node for node in changed["policyRouting"]["graph"]["nodes"] if node.get("action") == "respond")["responseMode"] = "post"
    assert (await client.post("/api/console", json={"action": "save_workflow", "workflow": changed})).status_code == 200
    assert (await store.get_deployment(original["id"]))["workflow"]["policyRouting"] == workflow["policyRouting"]
    dataset = {"id": "response-modes", "name": "안내 응답", "description": "", "rows": [{"id": "reply", "input": "날씨", "expected": "allow", "expectedRoute": "respond"}]}
    assert (await client.post("/api/console", json={"action": "save_dataset", "dataset": dataset})).status_code == 200
    evaluated = await client.post("/api/console", json={"action": "run_evaluation", "workflowId": workflow["id"], "datasetId": dataset["id"], "target": "deployed"})
    assert evaluated.status_code == 200, evaluated.text
    result = evaluated.json()["run"]["results"][0]
    assert result["expectationMatched"] and result["policyResponseMode"] == "immediate"
    assert "PRIVATE_POLICY_OUTPUT" not in json.dumps(result)
    assert (await client.post("/api/console", json={"action": "publish", "workflowId": workflow["id"]})).status_code == 200
    blocked = await client.post("/v1/chat/completions", headers=headers, json=gateway)
    assert blocked.status_code == 403 and "REGISTERED_RESPONSE" not in blocked.text
    restored = await client.post("/api/console", json={"action": "rollback_deployment", "deploymentId": original["id"]})
    assert restored.status_code == 200, restored.text
    allowed = await client.post("/v1/chat/completions", headers=headers, json=gateway)
    assert allowed.status_code == 200
    logs = (await store.state())["logs"]
    assert {log.get("policyResponseMode") for log in logs} >= {"post", "immediate"}
    assert "REGISTERED_RESPONSE" not in json.dumps(logs) and "PRIVATE_POLICY_OUTPUT" not in json.dumps(logs)
