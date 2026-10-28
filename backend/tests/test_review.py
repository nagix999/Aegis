import copy
import hashlib
import json
from pathlib import Path

import pytest

from aegis.errors import ApiError
from aegis.review import ENGINE_VERSION, canonical, configuration_fingerprint, dataset_fingerprint, js_json_dumps, matches_expectation, verify_deployment_evidence
from aegis.store import Store


def fixture():
    state = json.loads((Path(__file__).parents[1] / "aegis" / "seed.json").read_text())
    workflow = state["workflows"][0]
    workflow["pre"] = []
    workflow["post"] = []
    dataset = {"id": "proof-data", "name": "검증", "description": "", "rows": [{"id": "row", "input": "배송", "expected": "allow"}]}
    return workflow, state["connections"], dataset


def test_js_canonical_number_unicode_and_key_spellings():
    assert js_json_dumps({"name": "한글 😀", "options": [1.0, 1e-7, 1e-6, 1e20, 1e21, -0.0]}) == '{"name":"한글 😀","options":[1,1e-7,0.000001,100000000000000000000,1e+21,0]}'
    assert canonical({"z": 2, "a": {"한글": True, "x": None}}) == '{"a":{"x":null,"한글":true},"z":2}'
    assert js_json_dumps("\ud800") == '"\\ud800"'


def test_execution_identity_ignores_display_but_tracks_rules_scopes_and_engine():
    workflow, connections, _ = fixture()
    original = configuration_fingerprint(workflow, connections)
    changed = copy.deepcopy(workflow)
    changed.update(name="다른 이름", alias="other-alias", description="다른 설명", layout={"version": 1, "positions": {}, "pinnedKeys": ["input"]})
    renamed_connections = copy.deepcopy(connections)
    renamed_connections[0]["name"] = "다른 서버 이름"
    assert configuration_fingerprint(changed, renamed_connections) == original
    assert configuration_fingerprint({**workflow, "inputScope": "last_user"}, connections) != original
    assert configuration_fingerprint({**workflow, "executionLimits": {"timeoutMs": 1000, "maxModelCalls": 2}}, connections) != original
    explicit_defaults = {**workflow, "inputScope": "conversation", "executionLimits": {"timeoutMs": 120000, "maxModelCalls": 64}}
    assert configuration_fingerprint(explicit_defaults, connections) == original
    assert ENGINE_VERSION == "6-python"


def test_expectations_only_match_final_response_attempt():
    row = {"expected": "allow", "expectedRuleId": "rule"}
    result = {"status": "allow", "stage": "complete", "attempts": [{"number": 1}, {"number": 2}], "traces": [{"ruleId": "rule", "status": "allow", "stage": "post", "attempt": 1}]}
    assert not matches_expectation(row, result)
    result["traces"].append({"ruleId": "rule", "status": "allow", "stage": "post", "attempt": 2})
    assert matches_expectation(row, result)
    assert not matches_expectation({**row, "expectedStage": "pre"}, result)


async def saved_proof(store):
    workflow, connections, dataset = fixture()
    await store.put("dataset", dataset["id"], dataset)
    fingerprint = configuration_fingerprint(workflow, connections)
    run = {"id": "proof", "workflowId": workflow["id"], "datasetId": dataset["id"], "datasetName": dataset["name"], "createdAt": "2026-10-26T00:00:00.000Z", "updatedAt": "2026-10-26T00:01:00.000Z", "status": "completed", "engineVersion": ENGINE_VERSION, "fingerprint": fingerprint, "datasetFingerprint": dataset_fingerprint(dataset), "datasetSnapshot": copy.deepcopy(dataset), "results": [{"rowId": "row", "status": "allow", "stage": "complete", "output": "PRIVATE_RESPONSE", "traces": []}]}
    await store.put("run", run["id"], run)
    return workflow, fingerprint, dataset, run


@pytest.mark.asyncio
async def test_evidence_manifest_retains_hashes_counts_and_engine_without_original_text():
    store = Store()
    try:
        workflow, fingerprint, dataset, run = await saved_proof(store)
        workflow["releasePolicy"] = {"requireVerification": True, "requiredDatasetIds": [dataset["id"]]}
        result = await verify_deployment_evidence(store, workflow, fingerprint, {"verificationRunIds": [run["id"]]})
        summary = result["verificationSummaries"][0]
        assert summary["total"] == summary["matchedCount"] == 1
        assert summary["engineVersion"] == ENGINE_VERSION
        assert summary["datasetFingerprint"] == dataset_fingerprint(dataset)
        assert "PRIVATE_RESPONSE" not in json.dumps(summary)
        assert [check["namespace"] for check in result["checks"]] == ["run", "dataset"]
        await store.remove("run", run["id"])
        assert summary["runId"] == "proof"
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_old_engine_partial_mock_and_changed_data_are_not_new_release_evidence():
    store = Store()
    try:
        workflow, fingerprint, dataset, original = await saved_proof(store)
        for mutation, code in [({"engineVersion": "2"}, "verification_engine_stale"), ({"results": []}, "verification_failed"), ({"results": [{"rowId": "row", "status": "allow", "stage": "complete", "traces": [], "executionMode": "mock"}]}, "verification_failed")]:
            await store.put("run", original["id"], {**original, **mutation})
            with pytest.raises(ApiError) as error:
                await verify_deployment_evidence(store, workflow, fingerprint, {"verificationRunIds": [original["id"]]})
            assert error.value.code == code
        await store.put("run", original["id"], original)
        dataset["rows"][0]["note"] = "changed"
        await store.put("dataset", dataset["id"], dataset)
        with pytest.raises(ApiError) as error:
            await verify_deployment_evidence(store, workflow, fingerprint, {"verificationRunIds": [original["id"]]})
        assert error.value.code == "verification_stale"
    finally:
        await store.close()
