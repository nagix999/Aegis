"""Execution identities and immutable release evidence shared by Python services."""
from __future__ import annotations

import copy
import hashlib
import json
import math
from decimal import Decimal
from typing import Any

ENGINE_VERSION = "7-python"


def _number(value: int | float) -> str:
    """JSON number spelling used by JSON.stringify for our finite JSON values."""
    if not math.isfinite(value):
        return "null"
    if value == 0:
        return "0"
    if isinstance(value, int) and abs(value) <= 9007199254740991:
        return str(value)
    text = repr(float(value)).lower()
    if 1e-6 <= abs(value) < 1e21:
        return format(Decimal(text), "f").rstrip("0").rstrip(".") if "." in format(Decimal(text), "f") else format(Decimal(text), "f")
    if "e" in text:
        coefficient, exponent = text.split("e")
        coefficient = coefficient.removesuffix(".0")
        n = int(exponent)
        return coefficient + "e" + ("+" if n >= 0 else "-") + str(abs(n))
    return text.removesuffix(".0")


def _string(value: str) -> str:
    # JSON.stringify escapes lone UTF-16 surrogates while preserving Unicode.
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return "".join(f"\\u{ord(char):04x}" if 0xD800 <= ord(char) <= 0xDFFF else char for char in encoded)


def js_json_dumps(value: Any, *, sort_keys: bool = False) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _number(value)
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(js_json_dumps(item, sort_keys=sort_keys) for item in value) + "]"
    if isinstance(value, dict):
        keys = list(value)
        if sort_keys:
            keys.sort(key=lambda item: str(item).encode("utf-16-be", errors="surrogatepass"))
        return "{" + ",".join(_string(str(key)) + ":" + js_json_dumps(value[key], sort_keys=sort_keys) for key in keys) + "}"
    raise TypeError("Only JSON-compatible values can be fingerprinted")


def canonical(value: Any) -> str:
    return js_json_dumps(value, sort_keys=True)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def referenced_connections(workflow: dict, connections: list[dict]) -> list[dict]:
    identifiers = {workflow.get("mainConnectionId")}
    for group in workflow.get("pre", []) + workflow.get("post", []):
        for rule in group.get("rules", []):
            if rule.get("enabled") and rule.get("kind") == "llm":
                identifiers.add(rule.get("config", {}).get("connectionId"))
    return sorted((connection for connection in connections if connection.get("id") in identifiers), key=lambda connection: connection["id"].encode("utf-16-be", errors="surrogatepass"))


def execution_configuration(workflow: dict) -> dict:
    excluded = {"updatedAt", "layout", "cloneSource", "releasePolicy", "name", "description", "alias"}
    configuration = {key: copy.deepcopy(value) for key, value in workflow.items() if key not in excluded}
    configuration["inputScope"] = workflow.get("inputScope", "conversation")
    configuration["executionLimits"] = copy.deepcopy(workflow.get("executionLimits", {"timeoutMs": 120000, "maxModelCalls": 64}))
    if "policyRouting" in configuration:
        routing = configuration["policyRouting"]
        policy = routing["policy"]
        routing["policy"] = {key: value for key, value in policy.items() if key not in {"id", "name", "description", "version", "updatedAt"}}
        routing["policy"]["connectionSnapshot"] = {key: value for key, value in policy["connectionSnapshot"].items() if key != "name"}
        routing["routes"] = [{key: value for key, value in route.items() if key in ({"decision", "action", "responseText"} if route["action"] == "respond" else {"decision", "action", "errorCode", "errorMessage"} if route["action"] == "error" else {"decision", "action"})} for route in routing["routes"]]
        if "graph" in routing:
            routing["graph"]["nodes"] = [{key: value for key, value in node.items() if key != "name"} for node in routing["graph"]["nodes"]]
    for stage in ("pre", "post"):
        configuration[stage] = []
        for original in workflow.get(stage, []):
            group = {key: copy.deepcopy(value) for key, value in original.items() if key != "name"}
            group["rules"] = [{key: copy.deepcopy(value) for key, value in rule.items() if key not in {"name", "description"}} for rule in original.get("rules", [])]
            configuration[stage].append(group)
    if "graph" in configuration:
        for stage in ("pre", "post"):
            configuration["graph"][stage]["nodes"] = [{key: value for key, value in node.items() if key != "name"} for node in configuration["graph"][stage].get("nodes", [])]
    return configuration


def configuration_fingerprint(workflow: dict, connections: list[dict]) -> str:
    return digest({"engineVersion": ENGINE_VERSION, "workflow": execution_configuration(workflow), "connections": [{key: value for key, value in connection.items() if key != "name"} for connection in referenced_connections(workflow, connections)]})


def dataset_fingerprint(dataset: dict) -> str:
    return digest({key: value for key, value in dataset.items() if key != "updatedAt"})


def matches_expectation(row: dict, result: dict) -> bool:
    if result.get("status") != row.get("expected"):
        return False
    if row.get("expectedStage") and result.get("stage") != row["expectedStage"]:
        return False
    for expected_key, actual_key in (("expectedDecision", "policyDecision"), ("expectedRoute", "policyRoute"), ("expectedPolicyCode", "policyCode")):
        if row.get(expected_key) and result.get(actual_key) != row[expected_key]:
            return False
    if row.get("expectedPolicyFields"):
        checks = result.get("policyFieldChecks", [])
        if len(checks) != len(row["expectedPolicyFields"]) or any(check.get("path") != field["path"] or check.get("matched") is not True for field, check in zip(row["expectedPolicyFields"], checks)):
            return False
    if any(check.get("matched") is not True for check in result.get("policyFieldChecks", [])):
        return False
    attempts, traces = result.get("attempts", []), result.get("traces", [])
    final_attempt = attempts[-1]["number"] if attempts else max([0] + [trace.get("attempt", 0) for trace in traces])
    if row.get("expectedRuleId") and not any(trace.get("traceType") != "policy" and trace.get("ruleId") == row["expectedRuleId"] and trace.get("status") == row["expected"] and (trace.get("stage") == "pre" or not final_attempt or trace.get("attempt") == final_attempt) for trace in traces):
        return False
    return True


async def verify_deployment_evidence(store: Any, workflow: dict, fingerprint: str, data: dict) -> dict:
    from .errors import ApiError

    def require(value: Any, message: str, code: str = "verification_failed", status: int = 400) -> None:
        if not value:
            raise ApiError(message, code, status)

    raw = data.get("verificationRunIds", [data["verificationRunId"]] if data.get("verificationRunId") else [])
    require(isinstance(raw, list) and len(raw) <= 30 and all(isinstance(value, str) and 0 < len(value) <= 120 for value in raw), "배포 근거로 사용할 검증 기록을 확인하세요.")
    identifiers = list(dict.fromkeys(raw))
    policy = workflow.get("releasePolicy") or {}
    required = set(policy.get("requiredDatasetIds", []))
    covered, checks, summaries = set(), [], []
    for identifier in identifiers:
        captured = await store.get_record_with_version("run", identifier)
        run = captured["value"] if captured else None
        require(run and run.get("workflowId") == workflow["id"], "선택한 검증 기록을 찾을 수 없습니다.", "verification_not_found")
        require(run.get("status") == "completed", "완료된 검증만 배포 근거로 사용할 수 있습니다.", "verification_incomplete")
        require(run.get("engineVersion") == ENGINE_VERSION, "검증에 사용한 실행 엔진이 변경되었습니다. 현재 엔진으로 다시 검증하세요.", "verification_engine_stale", 409)
        require(run.get("fingerprint") == fingerprint, "검증한 설정과 현재 초안이 다릅니다. 다시 검증하세요.", "verification_stale", 409)
        require(not any(result.get("executionMode") == "mock" for result in run.get("results", [])), "모의 응답 실행은 배포 근거로 사용할 수 없습니다.")
        dataset_record = await store.get_record_with_version("dataset", run["datasetId"])
        dataset = dataset_record["value"] if dataset_record else None
        require(dataset and run.get("datasetFingerprint") == dataset_fingerprint(dataset), "검증 데이터셋이 변경되었거나 삭제되었습니다. 다시 검증하세요.", "verification_stale", 409)
        results = run.get("results", [])
        indexed = {result.get("rowId"): result for result in results}
        rows = dataset["rows"]
        require(run.get("datasetSnapshot") and len(results) == len(rows) == len(indexed) and all(row["id"] in indexed and matches_expectation(row, indexed[row["id"]]) for row in rows), "전체 데이터셋의 예상 결과를 모두 충족한 검증만 배포 근거로 사용할 수 있습니다. 일부 항목만 재시도한 기록은 전체 검증을 다시 실행하세요.")
        checks.extend([{"namespace": "run", "id": run["id"], "revision": captured["revision"]}, {"namespace": "dataset", "id": dataset["id"], "revision": dataset_record["revision"]}])
        summaries.append({"runId": run["id"], "datasetId": dataset["id"], "datasetName": dataset["name"], "datasetFingerprint": run["datasetFingerprint"], "fingerprint": fingerprint, "total": len(rows), "matchedCount": len(rows), "completedAt": run.get("updatedAt", run["createdAt"]), "engineVersion": ENGINE_VERSION})
        covered.add(dataset["id"])
    require(required <= covered, "필수 데이터셋의 검증을 모두 완료하고 배포 근거로 선택하세요.", "required_verification_missing")
    require(not policy.get("requireVerification") or identifiers, "이 워크플로우는 검증 근거가 있어야 배포할 수 있습니다.", "required_verification_missing")
    result: dict[str, Any] = {"checks": checks, "engineVersion": ENGINE_VERSION}
    if identifiers:
        result.update(verificationRunId=identifiers[0], verificationRunIds=identifiers, verificationSummaries=summaries)
    if not identifiers and "acknowledgeUnverified" in data:
        require(data["acknowledgeUnverified"] is True, "검증 근거 없는 배포 여부를 확인하세요.")
        reason = data.get("unverifiedReason")
        require(isinstance(reason, str) and bool(reason.strip()) and len(reason) <= 1000, "검증 근거 없이 배포하는 이유를 입력하세요.")
        result["unverifiedReason"] = reason.strip()
    return result
