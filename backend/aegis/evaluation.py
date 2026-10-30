"""Durable validation jobs shared by attached clients and server workers."""
from __future__ import annotations

import asyncio
import copy
import json
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from .review import ENGINE_VERSION, configuration_fingerprint, dataset_fingerprint, matches_expectation, referenced_connections

BATCH_SIZE = 2
MAX_RUN_BYTES = 1_500_000
MAX_RUNNING = 4
ACTIONS = {"run_evaluation", "start_evaluation", "step_evaluation", "cancel_evaluation", "retry_evaluation", "replay_evaluation"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _require(condition: Any, message: str, code: str = "invalid_request", status: int = 400) -> None:
    from .errors import ApiError
    if not condition:
        raise ApiError(message, code, status)


def _identifier(value: Any, label: str) -> str:
    _require(isinstance(value, str) and 0 < len(value.strip()) and len(value) <= 120, f"{label}을 확인하세요.")
    return value.strip()


def public_run(run: dict) -> dict:
    return copy.deepcopy({key: value for key, value in run.items() if key != "_lease"})


def _bytes(run: dict) -> int:
    return len(json.dumps(run, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _assert_size(run: dict) -> None:
    _require(_bytes(run) <= MAX_RUN_BYTES, "검증 설정과 결과의 저장 한도 1.5MB를 초과했습니다. 데이터셋을 나누어 실행하세요.", "evaluation_result_too_large", 413)


def _running_limit(state: dict) -> None:
    _require(sum(run.get("status") == "running" for run in state.get("runs", [])) < MAX_RUNNING, "동시에 진행할 수 있는 검증 작업은 4개입니다. 기존 작업을 완료하거나 중단하세요.", "evaluation_job_limit", 409)


async def _insert_run(store: Any, run: dict) -> None:
    _require(await store.insert_evaluation_run(run, MAX_RUNNING), "동시에 진행할 수 있는 검증 작업은 4개입니다. 기존 작업을 완료하거나 중단하세요.", "evaluation_job_limit", 409)


def _execution_mode(data: dict, state: dict) -> str:
    available = state.get("evaluationWorker", {}).get("available", False)
    mode = data.get("executionMode", "background" if available else "manual")
    _require(isinstance(mode, str) and mode in {"manual", "background"}, "검증 실행 방식을 확인하세요.")
    _require(mode != "background" or available, "검증 작업자가 연결되어 있지 않습니다. 연결 상태를 확인하거나 화면에서 실행하세요.", "evaluation_worker_unavailable", 409)
    return mode


def _validate_snapshot(workflow: dict, connections: list, dataset: dict) -> None:
    from .engine import validate_workflow
    issues = validate_workflow(workflow, connections)
    _require(not issues, "; ".join(issues))
    rows = dataset.get("rows")
    _require(isinstance(rows, list) and 1 <= len(rows) <= 100, "데이터셋에는 1~100개 행이 필요합니다.")
    _require(all(isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"] and isinstance(row.get("input"), str) and row["input"].strip() and len(row["input"]) <= 16000 and row.get("expected") in {"allow", "block"} for row in rows), "데이터셋 행의 입력과 예상 판정을 확인하세요.")
    _require(len({row["id"] for row in rows}) == len(rows), "데이터셋의 행 ID가 중복되었습니다.")


async def _create_run(data: dict, state: dict, selected_deployment: dict | None = None) -> dict:
    from .compatibility import evaluation_preflight
    _running_limit(state)
    mode = _execution_mode(data, state)
    workflow_id, dataset_id = _identifier(data.get("workflowId"), "워크플로우 ID"), _identifier(data.get("datasetId"), "데이터셋 ID")
    target = data.get("target", "draft")
    _require(isinstance(target, str) and target in {"draft", "deployed"}, "실행 대상은 draft 또는 deployed여야 합니다.")
    _require("compare" not in data or type(data["compare"]) is bool, "비교 실행 설정을 확인하세요.")
    compare = data.get("compare") is True
    _require(not compare or target == "draft", "변경 전후 비교는 수정본을 대상으로 실행하세요.")
    current = next((item for item in state.get("workflows", []) if item["id"] == workflow_id), None)
    dataset = next((item for item in state.get("datasets", []) if item["id"] == dataset_id), None)
    _require(current, "워크플로우를 찾을 수 없습니다.", "not_found", 404)
    _require(dataset, "데이터셋을 찾을 수 없습니다.", "not_found", 404)
    deployments = sorted((item for item in state.get("deployments", []) if item["workflowId"] == workflow_id), key=lambda item: (item["createdAt"], item["version"]), reverse=True)
    deployment = selected_deployment or (deployments[0] if deployments else None)
    _require(target != "deployed" or deployment, "먼저 워크플로우를 배포하세요.", "not_deployed")
    _require(not compare or deployment, "비교할 배포 버전이 없습니다. 먼저 워크플로우를 배포하세요.", "not_deployed")
    workflow = copy.deepcopy(deployment["workflow"] if target == "deployed" else current)
    connections = copy.deepcopy(referenced_connections(workflow, deployment["connections"] if target == "deployed" else state["connections"]))
    dataset = copy.deepcopy(dataset)
    _validate_snapshot(workflow, connections, dataset)
    baseline = copy.deepcopy(deployment["workflow"]) if compare else None
    baseline_connections = copy.deepcopy(referenced_connections(baseline, deployment["connections"])) if compare else None
    if baseline is not None:
        _validate_snapshot(baseline, baseline_connections, dataset)
    _require("acknowledgeCriteria" not in data or type(data["acknowledgeCriteria"]) is bool, "검사 기준 확인 설정을 확인하세요.")
    _require("preflightFingerprint" not in data or isinstance(data["preflightFingerprint"], str), "검사 기준 점검 값을 확인하세요.")
    sides = [{"key": "candidate", "label": f"배포 v{deployment['version']}" if target == "deployed" else "현재 초안", "workflow": workflow, "connections": connections}]
    if baseline is not None:
        sides.append({"key": "baseline", "label": f"비교 배포 v{deployment['version']}", "workflow": baseline, "connections": baseline_connections})
    preflight = evaluation_preflight(dataset, sides)
    if "preflightFingerprint" in data or data.get("acknowledgeCriteria") is True:
        _require(data.get("preflightFingerprint") == preflight["fingerprint"], "데이터셋이나 워크플로우가 점검 이후 변경되었습니다. 검사 기준을 다시 확인하세요.", "stale_dataset_preflight", 409)
    if preflight["requiresAcknowledgement"]:
        description = "; ".join(f"{issue['sideLabel']} {issue['rowNumber']}번: {issue['message']}" for issue in preflight["issues"][:3])
        _require(data.get("acknowledgeCriteria") is True and data.get("preflightFingerprint") == preflight["fingerprint"], f"검증 기준을 먼저 확인하세요. {description} 기준을 수정하거나 현재 기준으로 실행할지 확인하세요.", "dataset_criteria_review_required")
    timestamp = _now()
    run = {"id": str(uuid.uuid4()), "workflowId": workflow_id, "workflowName": workflow["name"], "datasetId": dataset_id, "datasetName": dataset["name"], "createdAt": timestamp, "updatedAt": timestamp,
           "version": f"v{deployment['version']}" if target == "deployed" else "draft", "target": target, "executionMode": mode, "status": "running", "total": len(dataset["rows"]), "results": [], "pendingRowIds": [row["id"] for row in dataset["rows"]],
           "workflowSnapshot": workflow, "connectionsSnapshot": connections, "datasetSnapshot": dataset, "engineVersion": ENGINE_VERSION, "fingerprint": configuration_fingerprint(workflow, connections), "datasetFingerprint": dataset_fingerprint(dataset),
           "preflight": {"fingerprint": preflight["fingerprint"], "acknowledged": preflight["requiresAcknowledgement"] and data.get("acknowledgeCriteria") is True, "issueCount": len(preflight["issues"])}}
    if target == "deployed":
        run["deploymentId"] = deployment["id"]
    if compare:
        run.update(baselineWorkflowSnapshot=baseline, baselineConnectionsSnapshot=baseline_connections, baselineVersion=f"v{deployment['version']}", baselineResults=[])
    _assert_size(run)
    return run


async def _get_run(store: Any, run_id: Any) -> dict:
    stored = await store.get_record_with_version("run", _identifier(run_id, "검증 작업 ID"))
    _require(stored, "검증 작업을 찾을 수 없습니다.", "not_found", 404)
    return stored


def _has_snapshots(run: dict) -> bool:
    return all(run.get(key) for key in ("workflowSnapshot", "connectionsSnapshot", "datasetSnapshot"))


def _lease_duration(run: dict) -> int:
    snapshots = [run.get("workflowSnapshot", {}), run.get("baselineWorkflowSnapshot", {})]
    return max(120000, *(snapshot.get("executionLimits", {}).get("timeoutMs", 120000) + 60000 for snapshot in snapshots))


def _execution_failure() -> dict:
    return {"id": str(uuid.uuid4()), "status": "error", "output": "", "stage": "pre", "latencyMs": 0, "traces": [], "reason": "검사 실행 중 오류가 발생했습니다. 연결과 설정을 확인하세요."}


def _evaluation_log(result: dict, workflow: dict, version: str) -> dict:
    reasons = {"allow": "검사를 통과했습니다.", "block": "검사 정책에 따라 차단했습니다.", "error": "검사 실행 중 오류가 발생했습니다.", "skipped": "실행하지 않았습니다."}
    log = {"id": result["id"], "source": "evaluation", "workflowId": workflow["id"], "workflowName": workflow["name"], "version": version, "createdAt": _now(), "status": result["status"], "stage": result["stage"], "latencyMs": result["latencyMs"], "reason": reasons[result["status"]], "traces": [{**trace, "reason": reasons[trace["status"]]} for trace in result["traces"]]}
    for key in ("flowTraces", "regenerationCount", "usage", "policyDecision", "policyRoute", "policyCode", "policyPath", "policyChecks", "policyResponseMode"):
        if key in result:
            log[key] = copy.deepcopy(result[key])
    if "attempts" in result:
        log["attempts"] = [{**attempt, "reason": reasons[attempt["status"]]} for attempt in result["attempts"]]
    return log


async def _run_row(row: dict, workflow: dict, connections: list, version: str, state: dict, store: Any, env: dict) -> dict:
    from .engine import execute_workflow
    try:
        result = await execute_workflow(workflow, connections, state["ingress"], env, row.get("messages", [{"role": "user", "content": row["input"]}]), row.get("generationOptions", {}), **({"expected_policy_fields": row["expectedPolicyFields"]} if row.get("expectedPolicyFields") else {}), **({"expected_policy_node_id": row["expectedPolicyNodeId"]} if row.get("expectedPolicyNodeId") else {}))
    except Exception:
        result = _execution_failure()
    await store.log(_evaluation_log(result, workflow, version))
    if result["status"] != "allow":
        result = {**result, "output": ""}
    metadata = {key: copy.deepcopy(value) for key, value in row.items() if key not in {"id", "expectedPolicyFields"}}
    return {**result, **metadata, "rowId": row["id"], "expectationMatched": matches_expectation(row, result, workflow)}


async def _step_run(run_id: Any, state: dict, store: Any, env: dict) -> dict:
    stored = await _get_run(store, run_id)
    run = stored["value"]
    if run.get("status") != "running":
        return {"run": public_run(run)}
    _require(_has_snapshots(run), "이 작업에는 실행 설정이 저장되어 있지 않습니다. 새 검증을 시작하세요.", "evaluation_snapshot_missing", 409)
    if run.get("_lease", {}).get("until", 0) > time.time() * 1000:
        return {"run": public_run(run), "leaseActive": True}
    if run.get("engineVersion") != ENGINE_VERSION:
        failed = {**run, "status": "error", "error": "실행 엔진이 변경되어 검증을 중단했습니다. 저장된 설정으로 다시 실행하세요.", "updatedAt": _now()}
        failed.pop("_lease", None)
        await store.compare_and_swap("run", run["id"], stored["revision"], failed)
        return {"run": public_run((await _get_run(store, run["id"]))["value"])}
    pending = run.get("pendingRowIds", [])
    if not pending:
        completed = {**run, "status": "completed", "updatedAt": _now()}
        completed.pop("_lease", None)
        if await store.compare_and_swap("run", run["id"], stored["revision"], completed):
            return {"run": public_run(completed)}
        return {"run": public_run((await _get_run(store, run["id"]))["value"]), "leaseActive": True}
    lease = {"token": str(uuid.uuid4()), "until": int(time.time() * 1000) + _lease_duration(run)}
    leased = {**run, "_lease": lease}
    if not await store.compare_and_swap("run", run["id"], stored["revision"], leased):
        return {"run": public_run((await _get_run(store, run["id"]))["value"]), "leaseActive": True}
    # The persisted serializer belongs to Store. Capture exactly its revision;
    # cancellation after this read still invalidates the final conditional write.
    captured = await _get_run(store, run["id"])
    if captured["value"].get("_lease", {}).get("token") != lease["token"]:
        return {"run": public_run(captured["value"]), "leaseActive": True}
    leased_revision = captured["revision"]
    row_ids = pending[:BATCH_SIZE]
    try:
        rows = [next((row for row in run["datasetSnapshot"]["rows"] if row["id"] == row_id), None) for row_id in row_ids]
        _require(all(row is not None for row in rows), "저장된 검증 행을 찾을 수 없습니다.", "evaluation_snapshot_invalid", 409)
        comparison = bool(run.get("baselineWorkflowSnapshot") and run.get("baselineConnectionsSnapshot"))
        async def pair(row: dict) -> tuple:
            work = [_run_row(row, run["workflowSnapshot"], run["connectionsSnapshot"], run["version"], state, store, env)]
            if comparison:
                work.append(_run_row(row, run["baselineWorkflowSnapshot"], run["baselineConnectionsSnapshot"], run.get("baselineVersion", "deployed"), state, store, env))
            results = await asyncio.gather(*work)
            return results[0], results[1] if comparison else None
        pairs = await asyncio.gather(*(pair(row) for row in rows))
        next_run = {**run, "results": run["results"] + [item[0] for item in pairs], "pendingRowIds": pending[len(row_ids):], "updatedAt": _now()}
        next_run.pop("_lease", None)
        if comparison:
            next_run["baselineResults"] = run.get("baselineResults", []) + [item[1] for item in pairs]
        next_run["status"] = "running" if next_run["pendingRowIds"] else "completed"
        if _bytes(next_run) > MAX_RUN_BYTES:
            next_run = {**run, "status": "error", "error": "검증 결과의 저장 한도 1.5MB를 초과했습니다. 완료된 이전 묶음은 유지됩니다. 데이터셋을 나누어 새로 실행하세요.", "updatedAt": _now()}
            next_run.pop("_lease", None)
        await store.compare_and_swap("run", run["id"], leased_revision, next_run)
    except asyncio.CancelledError:
        # Leave the expiring processing lease: another process can resume after
        # a server shutdown without treating an unfinished batch as committed.
        raise
    except Exception:
        failed = {**run, "status": "error", "error": "검증 묶음을 저장하지 못했습니다. 완료된 결과를 확인하고 다시 실행하세요.", "updatedAt": _now()}
        failed.pop("_lease", None)
        await store.compare_and_swap("run", run["id"], leased_revision, failed)
    return {"run": public_run((await _get_run(store, run["id"]))["value"])}


async def _cancel_run(run_id: Any, store: Any) -> dict:
    for _ in range(4):
        stored = await _get_run(store, run_id)
        run = stored["value"]
        if run.get("status") != "running":
            return {"run": public_run(run)}
        cancelled = {**run, "status": "cancelled", "updatedAt": _now()}
        cancelled.pop("_lease", None)
        if await store.compare_and_swap("run", run["id"], stored["revision"], cancelled):
            return {"run": public_run(cancelled)}
    _require(False, "검증 상태가 변경되고 있습니다. 잠시 후 중단을 다시 요청하세요.", "evaluation_busy", 409)


async def _restart_run(data: dict, state: dict, store: Any, retry: bool) -> dict:
    _running_limit(state)
    source = (await _get_run(store, data.get("runId")))["value"]
    _require(_has_snapshots(source), "이전 결과에는 재현할 설정이 없습니다. 현재 설정으로 새 검증을 시작하세요.", "evaluation_snapshot_missing", 409)
    row_ids = [row["id"] for row in source["datasetSnapshot"]["rows"]]
    if retry:
        failed = {result["rowId"] for result in source.get("results", []) + source.get("baselineResults", []) if result["status"] == "error"}
        row_ids = [row_id for row_id in row_ids if row_id in failed]
        _require(row_ids, "다시 실행할 오류 항목이 없습니다. 정책 차단은 실행 오류와 다릅니다.", "evaluation_no_errors")
    timestamp = _now()
    run = {**public_run(source), "engineVersion": ENGINE_VERSION, "fingerprint": configuration_fingerprint(source["workflowSnapshot"], source["connectionsSnapshot"]), "datasetFingerprint": dataset_fingerprint(source["datasetSnapshot"]), "executionMode": _execution_mode(data, state), "id": str(uuid.uuid4()), "createdAt": timestamp, "updatedAt": timestamp, "status": "running", "results": [], "pendingRowIds": row_ids, "total": len(row_ids)}
    for key in ("error", "retryOf", "replayOf"):
        run.pop(key, None)
    if source.get("baselineWorkflowSnapshot"):
        run["baselineResults"] = []
    run["retryOf" if retry else "replayOf"] = source["id"]
    _assert_size(run)
    return run


async def process_background_evaluation_run(run_id: str, state: dict, store: Any, env: dict) -> dict:
    stored = await _get_run(store, run_id)
    if stored["value"].get("executionMode") != "background" or stored["value"].get("status") != "running":
        return {"processed": False, "leaseActive": False}
    result = await _step_run(run_id, state, store, env)
    return {"processed": not result.get("leaseActive", False), "leaseActive": result.get("leaseActive") is True}


async def handle_evaluation_action(data: dict, state: dict, store: Any, env: dict) -> dict | None:
    if not isinstance(data.get("action"), str) or data["action"] not in ACTIONS:
        return None
    action = data["action"]
    if action == "step_evaluation":
        current = (await _get_run(store, data.get("runId")))["value"]
        _require(current.get("executionMode") != "background" or current.get("status") != "running", "이 검증은 서버에서 처리합니다. 실행 기록에서 진행 상태를 확인하세요.", "evaluation_background_managed", 409)
        return await _step_run(data.get("runId"), state, store, env)
    if action == "cancel_evaluation":
        return await _cancel_run(data.get("runId"), store)
    if action in {"retry_evaluation", "replay_evaluation"}:
        run = await _restart_run(data, state, store, action == "retry_evaluation")
        await _insert_run(store, run)
        return {"run": public_run(run)}
    selected = None
    if "deploymentId" in data:
        _require(data.get("target") == "deployed" and data.get("compare") is not True, "배포 ID를 지정한 검증은 배포본 실행만 지원합니다. 초안 비교 설정을 해제하세요.")
        selected = await store.get_deployment(_identifier(data["deploymentId"], "배포 ID"))
        _require(selected and selected["workflowId"] == data.get("workflowId"), "이 워크플로우의 배포 버전을 찾을 수 없습니다.", "not_found", 404)
    run = await _create_run({**data, "executionMode": "manual"} if action == "run_evaluation" else data, state, selected)
    await _insert_run(store, run)
    if action == "start_evaluation":
        return {"run": public_run(run)}
    current = public_run(run)
    while current["status"] == "running":
        stepped = await _step_run(current["id"], state, store, env)
        current = stepped["run"]
        _require(not stepped.get("leaseActive"), "검증 작업이 다른 요청에서 실행 중입니다. 작업 목록에서 진행 상태를 확인하세요.", "evaluation_busy", 409)
    return {"run": current}
