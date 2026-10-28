import asyncio
import copy
import json
import uuid

import pytest

from aegis.errors import ApiError
from aegis.evaluation import handle_evaluation_action, process_background_evaluation_run
from aegis.review import ENGINE_VERSION, configuration_fingerprint
from aegis.store import Store
from aegis.worker import heartbeat_evaluation_worker, process_evaluation_queue, release_evaluation_worker


async def setup(rows=3):
    store = Store()
    state = await store.state()
    workflow = copy.deepcopy(state["workflows"][0])
    workflow.update(pre=[], post=[])
    dataset = {"id": "eval-data", "name": "평가", "description": "", "rows": [{"id": f"row-{index}", "input": f"질문 {index}", "expected": "allow"} for index in range(rows)]}
    await store.put("workflow", workflow["id"], workflow)
    await store.put("dataset", dataset["id"], dataset)
    return store, await store.state(), workflow, dataset


def allowed(output="답변"):
    return {"id": str(uuid.uuid4()), "status": "allow", "stage": "complete", "output": output, "reason": "통과", "latencyMs": 1, "traces": []}


@pytest.mark.asyncio
async def test_start_does_not_execute_and_steps_use_immutable_saved_messages(monkeypatch):
    from aegis import engine
    seen = []
    async def execute(workflow, connections, ingress, env, messages, options):
        seen.append(copy.deepcopy(messages))
        return allowed(messages[-1]["content"])
    monkeypatch.setattr(engine, "execute_workflow", execute)
    store, state, workflow, dataset = await setup()
    try:
        started = await handle_evaluation_action({"action": "start_evaluation", "workflowId": workflow["id"], "datasetId": dataset["id"], "executionMode": "manual"}, state, store, {})
        run = started["run"]
        assert not seen and run["status"] == "running" and "_lease" not in run
        dataset["rows"][0]["input"] = "편집한 질문"
        await store.put("dataset", dataset["id"], dataset)
        first = await handle_evaluation_action({"action": "step_evaluation", "runId": run["id"]}, state, store, {})
        assert len(first["run"]["results"]) == 2
        assert first["run"]["results"][0]["output"] == "질문 0"
        finished = await handle_evaluation_action({"action": "step_evaluation", "runId": run["id"]}, state, store, {})
        assert finished["run"]["status"] == "completed"
        assert len(finished["run"]["results"]) == 3
        assert all(result["expectationMatched"] for result in finished["run"]["results"])
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_inflight_batch_has_exclusive_lease_and_cannot_resurrect_cancelled_run(monkeypatch):
    from aegis import engine
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0
    async def execute(*args, **kwargs):
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return allowed()
    monkeypatch.setattr(engine, "execute_workflow", execute)
    store, state, workflow, dataset = await setup(rows=2)
    try:
        run = (await handle_evaluation_action({"action": "start_evaluation", "workflowId": workflow["id"], "datasetId": dataset["id"], "executionMode": "manual"}, state, store, {}))["run"]
        task = asyncio.create_task(handle_evaluation_action({"action": "step_evaluation", "runId": run["id"]}, state, store, {}))
        await entered.wait()
        busy = await handle_evaluation_action({"action": "step_evaluation", "runId": run["id"]}, state, store, {})
        assert busy["leaseActive"] is True and calls == 2
        cancelled = await handle_evaluation_action({"action": "cancel_evaluation", "runId": run["id"]}, state, store, {})
        assert cancelled["run"]["status"] == "cancelled"
        release.set()
        completed = await task
        assert completed["run"]["status"] == "cancelled"
        assert completed["run"]["results"] == []
    finally:
        release.set()
        await store.close()


@pytest.mark.asyncio
async def test_exact_historical_snapshot_and_compare_both_use_saved_settings(monkeypatch):
    from aegis import engine
    seen = []
    async def execute(workflow, *args, **kwargs):
        seen.append(workflow["mainConnectionId"])
        return allowed()
    monkeypatch.setattr(engine, "execute_workflow", execute)
    store, state, workflow, dataset = await setup(rows=1)
    try:
        old = await store.deploy({"id": "historical", "workflowId": workflow["id"], "alias": workflow["alias"], "createdAt": "2026-10-25T00:00:00.000Z", "workflow": workflow, "connections": state["connections"]})
        newer = {**workflow, "mainConnectionId": "conn-other"}
        other = {**next(connection for connection in state["connections"] if connection["id"] == "conn-main"), "id": "conn-other"}
        await store.deploy({"id": "latest", "workflowId": workflow["id"], "alias": workflow["alias"], "createdAt": "2026-10-26T00:00:00.000Z", "workflow": newer, "connections": [other]})
        state = await store.state()
        run = (await handle_evaluation_action({"action": "run_evaluation", "workflowId": workflow["id"], "datasetId": dataset["id"], "target": "deployed", "deploymentId": old["id"]}, state, store, {}))["run"]
        assert run["deploymentId"] == "historical" and seen == [workflow["mainConnectionId"]]
        seen.clear()
        comparison = (await handle_evaluation_action({"action": "run_evaluation", "workflowId": workflow["id"], "datasetId": dataset["id"], "target": "draft", "compare": True}, state, store, {}))["run"]
        assert set(seen) == {"conn-main", "conn-other"}
        assert len(comparison["baselineResults"]) == len(comparison["results"]) == 1
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_retry_selects_only_errors_and_replay_uses_current_engine(monkeypatch):
    from aegis import engine
    async def execute(*args, **kwargs):
        return allowed()
    monkeypatch.setattr(engine, "execute_workflow", execute)
    store, state, workflow, dataset = await setup(rows=2)
    try:
        completed = (await handle_evaluation_action({"action": "run_evaluation", "workflowId": workflow["id"], "datasetId": dataset["id"]}, state, store, {}))["run"]
        completed["results"][0]["status"] = "error"
        completed["engineVersion"] = "2"
        completed["fingerprint"] = "old"
        await store.put("run", completed["id"], completed)
        retry = (await handle_evaluation_action({"action": "retry_evaluation", "runId": completed["id"], "executionMode": "manual"}, state, store, {}))["run"]
        assert retry["pendingRowIds"] == ["row-0"]
        assert retry["total"] == 1 and retry["retryOf"] == completed["id"]
        assert retry["engineVersion"] == ENGINE_VERSION
        assert retry["fingerprint"] == configuration_fingerprint(workflow, completed["connectionsSnapshot"])
        replay = (await handle_evaluation_action({"action": "replay_evaluation", "runId": completed["id"], "executionMode": "manual"}, state, store, {}))["run"]
        assert replay["pendingRowIds"] == ["row-0", "row-1"] and replay["replayOf"] == completed["id"]
        assert (await store.get_record("run", completed["id"]))["engineVersion"] == "2"
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_background_worker_drives_jobs_and_http_steps_are_rejected(monkeypatch):
    from aegis import engine
    async def execute(*args, **kwargs):
        return allowed()
    monkeypatch.setattr(engine, "execute_workflow", execute)
    store, state, workflow, dataset = await setup(rows=1)
    try:
        await heartbeat_evaluation_worker(store, {"id": "test-worker", "kind": "local"})
        state = await store.state()
        run = (await handle_evaluation_action({"action": "start_evaluation", "workflowId": workflow["id"], "datasetId": dataset["id"]}, state, store, {}))["run"]
        assert run["executionMode"] == "background"
        with pytest.raises(ApiError) as error:
            await handle_evaluation_action({"action": "step_evaluation", "runId": run["id"]}, state, store, {})
        assert error.value.code == "evaluation_background_managed"
        progress = await process_evaluation_queue(store, {})
        assert progress == {"checked": 1, "processed": 1, "busy": 0, "failed": 0}
        assert (await store.get_record("run", run["id"]))["status"] == "completed"
        await release_evaluation_worker(store, "test-worker")
        assert not (await store.evaluation_worker_status())["available"]
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_preflight_ack_is_exact_and_oversized_snapshots_never_create_a_job(monkeypatch):
    from aegis import engine
    from aegis.compatibility import evaluation_preflight
    async def execute(*args, **kwargs):
        return allowed()
    monkeypatch.setattr(engine, "execute_workflow", execute)
    store, state, workflow, dataset = await setup(rows=1)
    try:
        dataset["rows"][0]["expectedRuleId"] = "missing-rule"
        await store.put("dataset", dataset["id"], dataset)
        state = await store.state()
        proof = evaluation_preflight(dataset, [{"key": "candidate", "label": "현재 초안", "workflow": workflow, "connections": state["connections"]}])
        for extra, code in [({}, "dataset_criteria_review_required"), ({"acknowledgeCriteria": True, "preflightFingerprint": "old"}, "stale_dataset_preflight")]:
            with pytest.raises(ApiError) as error:
                await handle_evaluation_action({"action": "start_evaluation", "workflowId": workflow["id"], "datasetId": dataset["id"], **extra}, state, store, {})
            assert error.value.code == code
            assert not (await store.state())["runs"]
        result = await handle_evaluation_action({"action": "start_evaluation", "workflowId": workflow["id"], "datasetId": dataset["id"], "acknowledgeCriteria": True, "preflightFingerprint": proof["fingerprint"]}, state, store, {})
        assert result["run"]["preflight"]["acknowledged"] is True
        await handle_evaluation_action({"action": "cancel_evaluation", "runId": result["run"]["id"]}, state, store, {})
        huge = {**dataset, "rows": [{"id": f"large-{index}", "input": "a" * 16000, "expected": "allow"} for index in range(100)]}
        await store.put("dataset", huge["id"], huge)
        with pytest.raises(ApiError) as error:
            await handle_evaluation_action({"action": "start_evaluation", "workflowId": workflow["id"], "datasetId": huge["id"]}, await store.state(), store, {})
        assert error.value.code == "evaluation_result_too_large"
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_stale_engine_pending_run_stops_without_starting_a_model_call(monkeypatch):
    from aegis import engine
    async def forbidden(*args, **kwargs):
        raise AssertionError("must not call model")
    monkeypatch.setattr(engine, "execute_workflow", forbidden)
    store, state, workflow, dataset = await setup(rows=1)
    try:
        run = (await handle_evaluation_action({"action": "start_evaluation", "workflowId": workflow["id"], "datasetId": dataset["id"]}, state, store, {}))["run"]
        await store.put("run", run["id"], {**run, "engineVersion": "2"})
        result = await handle_evaluation_action({"action": "step_evaluation", "runId": run["id"]}, state, store, {})
        assert result["run"]["status"] == "error"
        assert "엔진" in result["run"]["error"]
        assert result["run"]["results"] == []
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_atomic_running_capacity_holds_under_stale_state_concurrent_starts():
    store, state, workflow, dataset = await setup(rows=1)
    try:
        payload = {"action": "start_evaluation", "workflowId": workflow["id"], "datasetId": dataset["id"]}
        results = await asyncio.gather(*(handle_evaluation_action(payload, state, store, {}) for _ in range(5)), return_exceptions=True)
        assert sum(isinstance(result, dict) for result in results) == 4
        errors = [result for result in results if isinstance(result, ApiError)]
        assert len(errors) == 1 and errors[0].code == "evaluation_job_limit"
        assert len((await store.state())["runs"]) == 4
    finally:
        await store.close()
