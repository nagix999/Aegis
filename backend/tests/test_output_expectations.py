"""Typed expectation criteria observe the shared engine without exposing policy JSON."""
import copy
import json

import pytest

from aegis.engine import execute_workflow
from aegis.evaluation import _run_row
from aegis.output_expectations import check_policy_fields, compare_policy_example, validate_field_assertions
from aegis.review import dataset_fingerprint, matches_expectation
from aegis.schemas import DatasetRow, PolicyDefinition
from aegis.store import Store
from test_policy_graph import api_fixture, fixture, messages, post_rule, save_workflow


def test_exact_remains_default_and_schema_or_fields_ignore_unselected_dynamic_values():
    example = {"expectedOutput": {"score": 80, "explanation": "registered explanation"}}
    actual = {"score": 90, "explanation": "PRIVATE_ACTUAL_EXPLANATION"}
    assert compare_policy_example(actual, example)["expectationMatched"] is False
    assert compare_policy_example(actual, {**example, "expectation": {"mode": "schema"}}) == {"expectationMatched": True, "checks": []}
    fields = [{"path": "/score", "operator": "gte", "value": 80}]
    result = compare_policy_example(actual, {**example, "expectation": {"mode": "fields", "fields": fields}})
    assert result == {"expectationMatched": True, "checks": [{"path": "/score", "matched": True}]}
    assert "PRIVATE_ACTUAL_EXPLANATION" not in json.dumps(result) and "80" not in json.dumps(result)


@pytest.mark.parametrize("field", [
    {"path": "/risk~2score", "operator": "eq", "value": 1},
    {"path": "/risk/score", "operator": "gte", "value": True},
    {"path": "/risk/score", "operator": "eq"},
    {"path": "/risk/score", "operator": "in", "value": []},
    {"path": "/risk/score", "operator": "exists", "value": None},
    {"path": "/risk/score", "operator": "eq", "value": "x" * 5000},
])
def test_invalid_assertions_are_rejected_at_dataset_contract_boundary(field):
    with pytest.raises(ValueError):
        DatasetRow.model_validate({"id": "row", "input": "question", "expected": "allow", "expectedPolicyFields": [field]})


def test_policy_assertions_use_registered_schema_and_explicit_null_round_trips():
    _, workflow = fixture()
    policy = {key:value for key,value in workflow["policyRouting"]["policy"].items() if key not in {"connectionSnapshot", "version", "updatedAt"}}
    policy["examples"][0]["expectation"] = {"mode": "fields", "fields": [{"path": "/nullable", "operator": "eq", "value": None}]}
    parsed = PolicyDefinition.model_validate(policy).model_dump(exclude_none=True)
    assert parsed["examples"][0]["expectation"]["fields"][0]["value"] is None
    policy["examples"][0]["expectation"]["fields"][0] = {"path": "/missing", "operator": "eq", "value": "PRIVATE_EXPECTED"}
    with pytest.raises(ValueError):
        PolicyDefinition.model_validate(policy)


def test_pointer_arrays_types_and_missing_output_are_fail_closed():
    fields = [{"path": "/a~1b/0", "operator": "eq", "value": True}, {"path": "/none", "operator": "exists", "value": False}]
    assert check_policy_fields({"a/b": [True]}, fields) == [{"path": "/a~1b/0", "matched": True}, {"path": "/none", "matched": True}]
    assert check_policy_fields(None, fields, available=False) == [{"path": "/a~1b/0", "matched": False}, {"path": "/none", "matched": False}]
    assert check_policy_fields({"a/b": [1]}, fields)[0]["matched"] is False


def test_verification_requires_the_same_paths_and_true_booleans_and_criteria_change_fingerprint():
    row = {"id":"row","input":"question","expected":"allow","expectedPolicyFields":[{"path":"/risk/score","operator":"gte","value":80}]}
    result = {"status":"allow","stage":"complete","traces":[]}
    assert matches_expectation(row,result) is False
    for check in [{"path":"/another","matched":True},{"path":"/risk/score","matched":"true"},{"path":"/risk/score","matched":False}]:
        assert matches_expectation(row,{**result,"policyFieldChecks":[check]}) is False
    assert matches_expectation(row,{**result,"policyFieldChecks":[{"path":"/risk/score","matched":True}]})
    dataset = {"id":"dataset","name":"cases","description":"","rows":[row]}
    changed = copy.deepcopy(dataset); changed["rows"][0]["expectedPolicyFields"][0]["value"] = 90
    assert dataset_fingerprint(dataset) != dataset_fingerprint(changed)


@pytest.mark.asyncio
@pytest.mark.parametrize("text,status,score", [("배송", "allow", 10), ("위험", "block", 95)])
async def test_observer_does_not_change_routes_and_exports_only_path_boolean(text, status, score):
    state, workflow = fixture()
    fields = [{"path": "/risk/score", "operator": "eq", "value": score}]
    observed = await execute_workflow(workflow, state["connections"], state["ingress"], {}, messages(text), expected_policy_fields=fields)
    plain = await execute_workflow(workflow, state["connections"], state["ingress"], {}, messages(text))
    assert observed["status"] == plain["status"] == status
    assert observed["policyRoute"] == plain["policyRoute"]
    assert observed["output"] == plain["output"]
    assert observed["policyFieldChecks"] == [{"path": "/risk/score", "matched": True}]
    assert "policyFieldChecks" not in plain
    assert "PRIVATE_POLICY_OUTPUT" not in json.dumps(observed)
    assert matches_expectation({"expected":status,"expectedPolicyFields":fields}, observed)
    if status == "block":
        assert observed["output"] == "" and next(trace for trace in observed["traces"] if trace["ruleId"] == "main")["status"] == "skipped"


@pytest.mark.asyncio
async def test_unreached_policy_is_mismatch_even_when_missing_field_was_expected():
    state, workflow = fixture()
    workflow["pre"] = [post_rule(pattern="DENY")]
    fields = [{"path": "/none", "operator": "exists", "value": False}]
    result = await execute_workflow(workflow, state["connections"], state["ingress"], {}, messages("DENY"), expected_policy_fields=fields)
    assert result["status"] == "block" and result["policyFieldChecks"] == [{"path": "/none", "matched": False}]
    assert matches_expectation({"expected":"block","expectedPolicyFields":fields}, result) is False


@pytest.mark.asyncio
async def test_evaluation_does_not_reflect_assertion_values_or_output_into_results_or_logs():
    state, workflow = fixture()
    row = {"id":"row","input":"위험","expected":"block","expectedPolicyFields":[{"path":"/findings/0/detail","operator":"eq","value":"PRIVATE_POLICY_OUTPUT"}]}
    store = Store()
    try:
        result = await _run_row(row, workflow, state["connections"], "draft", state, store, {})
        assert result["expectationMatched"] is True
        assert result["policyFieldChecks"] == [{"path":"/findings/0/detail","matched":True}]
        assert "expectedPolicyFields" not in result and "PRIVATE_POLICY_OUTPUT" not in json.dumps(result)
        logs = (await store.state())["logs"]
        assert "PRIVATE_POLICY_OUTPUT" not in json.dumps(logs)
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_policy_api_compares_chosen_fields_and_preserves_default_exact_response(api_fixture):
    client, _, _, workflow = api_fixture
    definition = {key:value for key,value in workflow["policyRouting"]["policy"].items() if key not in {"connectionSnapshot", "version", "updatedAt"}}
    definition["examples"][0]["expectation"] = {"mode":"fields","fields":[{"path":"/risk/score","operator":"gte","value":80}]}
    definition["examples"][1]["expectation"] = {"mode":"schema"}
    response = await client.post("/api/console",json={"action":"test_policy","policy":definition})
    assert response.status_code == 200, response.text
    results = response.json()["policyTest"]["results"]
    assert results[0]["status"] == "fail" and results[0]["checks"] == [{"path":"/risk/score","matched":False}]
    assert results[1]["status"] == results[2]["status"] == "pass"
    assert "checks" not in results[1] and "checks" not in results[2]
    assert "PRIVATE_POLICY_OUTPUT" not in json.dumps(results)
    assert all("actual" not in result and "expectedOutput" not in result for result in results)


@pytest.mark.asyncio
async def test_dataset_api_round_trip_and_full_run_use_fields_without_changing_block_action(api_fixture):
    client, store, _, workflow = api_fixture
    workflow = await save_workflow(client,workflow)
    dataset = {"id":"field-cases","name":"필드 검증","description":"","rows":[
        {"id":"match","input":"위험","expected":"block","expectedPolicyFields":[{"path":"/risk/score","operator":"gte","value":90}]},
        {"id":"mismatch","input":"위험","expected":"block","expectedPolicyFields":[{"path":"/risk/score","operator":"gte","value":99}]}]}
    saved = await client.post("/api/console",json={"action":"save_dataset","dataset":dataset})
    assert saved.status_code == 200, saved.text
    assert next(item for item in (await store.state())["datasets"] if item["id"] == dataset["id"])["rows"] == dataset["rows"]
    response = await client.post("/api/console",json={"action":"run_evaluation","workflowId":workflow["id"],"datasetId":dataset["id"]})
    assert response.status_code == 200, response.text
    results = response.json()["run"]["results"]
    assert [item["status"] for item in results] == ["block","block"]
    assert [item["expectationMatched"] for item in results] == [True,False]
    assert all(item["output"] == "" for item in results)
    assert all(set(item["policyFieldChecks"][0]) == {"path","matched"} for item in results)
    assert all("expectedPolicyFields" not in item for item in results)
