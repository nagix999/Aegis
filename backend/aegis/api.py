"""HTTP boundary for the Python console and OpenAI-compatible Gateway.

Public payloads deliberately retain the existing camelCase contract. Only this
module interprets authentication headers; workflow execution does not depend on
browser state or the TypeScript preview runtime.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .errors import ApiError
from .auth import client_ip
from .schemas import validate_payload
from .engine import (collect_connection_metrics, diagnose_connection,
                     execute_workflow, ipv4_allowed, test_connection,
                     validate_connection, validate_ingress, validate_workflow)
from .graph import validate_workflow_graph
from .compatibility import apply_dataset_rule_mappings, validate_zones
from .review import (ENGINE_VERSION, configuration_fingerprint,
                     dataset_fingerprint, referenced_connections,
                     verify_deployment_evidence)
from .evaluation import handle_evaluation_action
from .evaluation_history import evaluation_history
from .lifecycle import handle_lifecycle_action, MAX_POLICY_VERSIONS
from .output_expectations import compare_policy_example
from .dashboard import aggregate_dashboard
from .policies import classify_policy, classify_policy_output, policy_output_schema
from .store import UNSET
from .runtime import ExecutionRuntime, js_length, response_token_reservation, execution_lease_duration


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def require(condition: Any, message: str, code: str = "invalid_request", status: int = 400):
    if not condition:
        raise ApiError(message, code, status)


def text(value: Any, maximum: int = 160, *, empty: bool = False, trim: bool = True) -> str:
    require(isinstance(value, str), "문자열 입력값을 확인하세요.")
    value = value.strip() if trim else value
    require((empty or bool(value)) and js_length(value) <= maximum, "입력값의 길이를 확인하세요.")
    return value


def identifier(value: Any) -> str:
    return text(value, 120)


def fingerprint_value(value: Any) -> str:
    require(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value), "설정 확인값을 확인하세요.")
    return value


def json_response(value: Any, status: int = 200, headers: dict | None = None):
    return JSONResponse(value, status_code=status, headers={"Cache-Control": "no-store", **(headers or {})})


def error_response(error: Exception, gateway: bool = False):
    conflict = type(error).__name__ == "DeploymentRequestConflict"
    known = isinstance(error, ApiError) or (hasattr(error, "status") and hasattr(error, "code"))
    status = 409 if conflict else int(getattr(error, "status", 500)) if known else 500
    code = "idempotency_conflict" if conflict else getattr(error, "code", "server_error") if known else "server_error"
    message = str(error) if known or conflict else "요청을 처리하지 못했습니다. 관리자에게 서버 상태 확인을 요청하세요."
    result = {"message": message, "code": code}
    if gateway:
        result.update(type="authentication_error" if status == 401 else "rate_limit_error" if status == 429 else "server_error" if status >= 500 else "invalid_request_error", param=None)
    headers = {"Retry-After": "60"} if status == 429 else None
    if status == 401 and not gateway:
        headers = {"WWW-Authenticate": 'Basic realm="Aegis administrator", charset="UTF-8"'}
    return json_response({"error": result}, status, headers)


async def read_body(request: Request, limit: int = 2_000_000) -> dict:
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    require(media_type == "application/json" or media_type.startswith("application/") and media_type.endswith("+json"),
            "Content-Type을 application/json으로 보내세요.", "unsupported_media_type", 415)
    try:
        declared = int(request.headers.get("content-length", "0"))
    except ValueError:
        raise ApiError("요청 본문 크기를 확인하세요.")
    size_message = "요청 본문은 2MB 이하로 보내세요." if limit == 2_000_000 else f"요청 본문은 {limit:,}바이트 이하로 보내세요."
    require(declared <= limit, size_message, "request_too_large", 413)
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        require(size <= limit, size_message, "request_too_large", 413)
        chunks.append(chunk)
    try:
        result = json.loads(b"".join(chunks), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeDecodeError):
        raise ApiError("올바른 JSON 본문이 필요합니다.")
    require(isinstance(result, dict), "JSON 객체 본문이 필요합니다.")
    return result


def admin_allowed(request: Request, env: dict) -> str:
    """Authenticate console/static/docs; direct callers cannot spoof identity."""
    service = env.get("_auth_service")
    if service is None:
        # Also supports callers constructing the router outside create_app.
        from .auth import AuthService
        service = env["_auth_service"] = AuthService(env["_store"], env)
    return service.authenticate(request)["identity"]


def console_role(request: Request, env: dict, identity: str | None = None) -> str:
    identity = identity or admin_allowed(request, env)
    if identity == "service-admin":
        return "admin"
    roles = env.get("AEGIS_ROLE_MAP")
    if roles is None or roles == "":
        return "admin"
    try:
        roles = json.loads(roles) if isinstance(roles, str) else roles
    except ValueError:
        raise ApiError("서버 역할 설정을 확인하세요.", "invalid_role_configuration", 500)
    require(isinstance(roles, dict), "서버 역할 설정을 확인하세요.", "invalid_role_configuration", 500)
    role = roles.get(identity, "viewer")
    return role if role in {"admin", "editor", "viewer"} else "viewer"


EDITOR_ACTIONS = {"save_policy", "test_policy", "save_workflow", "save_dataset", "create_mapped_dataset", "delete_dataset", "playground", "run_evaluation", "start_evaluation", "step_evaluation", "cancel_evaluation", "retry_evaluation", "replay_evaluation"}


def require_action_role(role: str, action: str):
    require(role == "admin" or role == "editor" and action in EDITOR_ACTIONS, "이 작업을 수행할 권한이 없습니다.", "forbidden", 403)


def audit_target(data: dict) -> str:
    for field in ("workflowId", "deploymentId", "runId", "id"):
        if isinstance(data.get(field), str):
            return data[field][:120]
    for field in ("workflow", "connection", "dataset", "policy"):
        if isinstance(data.get(field), dict) and isinstance(data[field].get("id"), str):
            return data[field]["id"][:120]
    return "settings"


def audit_event(actor: str, data: dict) -> dict:
    return {"id": str(uuid.uuid4()), "actor": actor, "action": str(data.get("action", "")), "target": audit_target(data), "createdAt": now_iso(), "detail": "완료"}


def deployment_request(actor: str, key: str, data: dict) -> dict:
    def digest(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    return {"id": digest({"actor": actor, "key": key}), "requestHash": digest({k: v for k, v in data.items() if k != "idempotencyKey"})}


def record_log(result: dict, source: str, workflow: dict, version: str, key_id=None, deployment_id=None):
    value = {"id": result["id"], "source": source, "workflowId": workflow["id"], "workflowName": workflow["name"], "version": version, "createdAt": now_iso(), **{key: result[key] for key in ("status", "stage", "latencyMs", "reason", "traces", "usage", "flowTraces", "attempts", "regenerationCount", "policyDecision", "policyRoute", "policyCode", "policyPath") if key in result}}
    if key_id:
        value["keyId"] = key_id
    if deployment_id:
        value["deploymentId"] = deployment_id
    return value


def workflow_from(state: dict, workflow_id: Any, target: Any):
    workflow = next((w for w in state["workflows"] if w["id"] == workflow_id), None)
    require(workflow, "워크플로우를 찾을 수 없습니다.", "not_found", 404)
    if target == "deployed":
        deployments = sorted((d for d in state["deployments"] if d["workflowId"] == workflow_id), key=lambda d: (d["createdAt"], d["version"]), reverse=True)
        require(deployments, "먼저 워크플로우를 배포하세요.", "not_deployed")
        selected = deployments[0]
        return selected["workflow"], selected["connections"], f"v{selected['version']}"
    require(target in (None, "draft"), "target은 draft 또는 deployed여야 합니다.")
    return workflow, state["connections"], "draft"


def enforce_limit(items, item_id, limit, label):
    require(any(item["id"] == item_id for item in items) or len(items) < limit, f"{label}은 최대 {limit}개까지 저장할 수 있습니다.")


def parse_policy(value):
    policy = validate_payload("key_policy", {} if value is None else value)
    if policy.get("expiresAt"):
        require(_parse_time(policy["expiresAt"]) > time.time(), "만료 시각은 현재 이후로 설정하세요.")
    if "allowedModels" in policy:
        policy["allowedModels"] = list(dict.fromkeys(policy["allowedModels"]))
    return policy


def _parse_time(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError, AttributeError):
        return float("nan")


def validate_snapshot_connections(connections: list, ingress: dict, env: dict, workflow: dict | None = None):
    snapshots = list(connections)
    if workflow and workflow.get("policyRouting"):
        snapshots.append(workflow["policyRouting"]["policy"]["connectionSnapshot"])
    for connection in snapshots:
        if connection.get("mode") != "vllm":
            continue
        parsed = urlparse(connection["baseUrl"])
        origin = f"{parsed.scheme}://{parsed.netloc}"
        require(origin in ingress["allowedOrigins"], f"{connection['name']}: 접근 설정의 허용 모델 서버에 주소를 추가하세요.")
        secret = connection.get("secretEnv")
        if secret:
            require(isinstance(env.get(secret), str) and env[secret], f"{connection['name']}: 서버 환경변수 {secret}가 설정되지 않았습니다.")


async def capture_workflow(store, workflow_id):
    captured = await store.get_record_with_version("workflow", workflow_id)
    require(captured, "워크플로우를 찾을 수 없습니다.", "not_found", 404)
    workflow, connections = captured["value"], []
    checks = [{"namespace": "workflow", "id": workflow_id, "revision": captured["revision"]}]
    ids = {workflow["mainConnectionId"]}
    ids.update(rule["config"].get("connectionId") for group in workflow["pre"] + workflow["post"] for rule in group["rules"] if rule["enabled"] and rule["kind"] == "llm")
    for connection_id in sorted(v for v in ids if v):
        connection = await store.get_record_with_version("connection", connection_id)
        require(connection, "선택한 모델 서버 설정을 찾을 수 없습니다.")
        connections.append(connection["value"])
        checks.append({"namespace": "connection", "id": connection_id, "revision": connection["revision"]})
    return workflow, referenced_connections(workflow, connections), checks


async def capture_connection_check(store, connection_id):
    connection = await store.get_record_with_version("connection", connection_id)
    ingress = await store.get_record_with_version("meta", "ingress")
    require(connection, "모델 서버 설정을 찾을 수 없습니다.", "not_found", 404)
    require(ingress, "접근 정책을 찾을 수 없습니다.", "not_found", 404)
    return connection["value"], ingress["value"], [{"namespace": "connection", "id": connection_id, "revision": connection["revision"]}, {"namespace": "meta", "id": "ingress", "revision": ingress["revision"]}]



async def execute_attached(request: Request, *args, **kwargs) -> dict:
    """Attach non-streaming execution to an already-consumed HTTP request.

    Uvicorn does not cancel an ordinary endpoint when its peer disconnects.
    Polling the ASGI disconnect event forwards cancellation to the common
    engine while retaining that engine's own deadline and model-call budget.
    Call this only after ``read_body`` has consumed the complete request body.
    """
    cancel = kwargs.pop("cancel_event", None)
    if cancel is None:
        cancel = asyncio.Event()

    async def monitor():
        while not cancel.is_set():
            try:
                disconnected = await request.is_disconnected()
            except (OSError, RuntimeError):
                # A closed receive channel has the same consequence as an
                # explicit http.disconnect: stop launching more model work.
                disconnected = True
            if disconnected:
                cancel.set()
                return
            await asyncio.sleep(0.05)

    watcher = asyncio.create_task(monitor(), name="aegis-request-disconnect")
    try:
        return await execute_workflow(*args, **kwargs, cancel_event=cancel)
    finally:
        cancel.set()
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)


def create_router(store, env: dict) -> APIRouter:
    router = APIRouter()
    env["_store"] = store

    async def gateway_context(request):
        authorization = request.headers.get("authorization", "")
        require(re.fullmatch(r"Bearer ag_[a-f0-9]{64}", authorization), "Authorization 헤더에 유효한 Bearer API 키를 넣어 주세요.", "invalid_api_key", 401)
        key = await store.authenticate(authorization[7:])
        require(key, "API 키가 유효하지 않거나 폐기되었습니다.", "invalid_api_key", 401)
        if key.get("policy", {}).get("expiresAt"):
            require(_parse_time(key["policy"]["expiresAt"]) > time.time(), "API 키가 만료되었습니다.", "key_expired", 401)
        ingress = await store.get_record("meta", "ingress")
        require(ingress, "접근 정책을 불러오지 못했습니다. 관리자에게 서버 상태 확인을 요청하세요.", "ingress_unavailable", 503)
        if ingress["enabled"]:
            require(ipv4_allowed(client_ip(request, env), ingress["allowedCidrs"]), "호출한 IP가 API 허용 목록에 없습니다.", "ip_not_allowed", 403)
        return ingress, key

    async def reserve(key, tokens, lease_ms):
        value = await store.reserve_quota(key, tokens, lease_ms)
        if "denied" in value:
            messages = {"rpm_limit": "분당 요청 한도에 도달했습니다.", "tpm_limit": "분당 토큰 한도 안에서 이 요청의 최대 토큰을 예약할 수 없습니다. max_tokens를 줄이거나 잠시 뒤 다시 호출하세요.", "concurrency_limit": "동시에 처리할 수 있는 요청 수에 도달했습니다."}
            raise ApiError(messages[value["denied"]], value["denied"], 429)
        return value["reservation"]

    @router.get("/api/console", tags=["Console"], operation_id="console_state", openapi_extra={
        "description": "관리 상태 또는 view별 조회입니다. view=dashboard는 원문을 제외한 보관 데이터의 집계, 차트와 표용 데이터셋, 집계 범위를 반환합니다. 요청 출처와 요청 판정은 요청 지표에만 적용하며 현재 배포는 기간과 무관합니다. 검증과 배포의 워크플로우 ID는 탭 드릴다운에 사용할 수 있습니다.",
        "parameters": [
            {"in": "query", "name": "history", "schema": {"type": "boolean"}, "description": "view=evaluations의 전체 보관 실행 기록을 검색합니다. 기본 최근 실행 조회는 그대로 유지합니다."},
            {"in": "query", "name": "runId", "schema": {"type": "string", "maxLength": 120}},
            {"in": "query", "name": "datasetId", "schema": {"type": "string", "maxLength": 120}},
            {"in": "query", "name": "query", "schema": {"type": "string", "maxLength": 160}},
            {"in": "query", "name": "limit", "schema": {"type": "integer", "minimum": 1, "maximum": 100}},
            {"in": "query", "name": "cursor", "schema": {"type": "string"}},
            {"in": "query", "name": "view", "schema": {"type": "string", "enum": ["dashboard", "evaluations", "deployment", "logs", "verification"]}, "description": "생략하면 관리 상태를 반환합니다."},
            {"in": "query", "name": "from", "schema": {"type": "string", "format": "date-time"}, "description": "dashboard 또는 logs의 시작 시각. 대시보드는 시간대를 포함한 ISO 시각이며 기본 최근 7일, 조회 범위 최대 90일입니다."},
            {"in": "query", "name": "to", "schema": {"type": "string", "format": "date-time"}, "description": "종료 시각(미포함). 대시보드의 기본값은 현재 시각입니다."},
            {"in": "query", "name": "workflowId", "schema": {"type": "string", "maxLength": 120}, "description": "대상 워크플로우 ID입니다."},
            {"in": "query", "name": "source", "schema": {"type": "string", "enum": ["gateway", "evaluation", "playground", "all"]}, "description": "대시보드의 요청 출처는 기본 gateway이며 all을 허용합니다. logs 조회에는 all 대신 이 항목을 생략합니다."},
            {"in": "query", "name": "status", "schema": {"type": "string", "enum": ["allow", "block", "error", "running", "completed", "cancelled"]}, "description": "history=true 검증 조회에는 running, completed, cancelled, error 상태를 사용합니다. dashboard 또는 logs의 요청 판정입니다. 생략하면 모든 판정을 포함합니다. 대시보드의 검증 결과와 현재 배포에는 적용하지 않습니다."},
        ],
    })
    @router.post("/api/console", tags=["Console"], operation_id="console_action", openapi_extra={"requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["action"], "properties": {"action": {"type": "string", "description": "save_policy, test_policy, save_workflow, playground, start_evaluation, publish 등의 관리 작업"}, "workflowId": {"type": "string"}, "workflow": {"type": "object"}, "dataset": {"type": "object"}, "connection": {"type": "object"}, "policy": {"oneOf": [{"$ref": "#/components/schemas/PolicyDefinition"}, {"$ref": "#/components/schemas/KeyPolicy"}], "description": "save_policy와 test_policy는 PolicyDefinition, API 키 관리 작업은 KeyPolicy를 사용합니다."}, "expectedVersion": {"type": "integer", "minimum": 0, "maximum": 1000, "description": "save_policy의 현재 최신 버전. 신규 정책은 0입니다."}, "idempotencyKey": {"type": "string"}}, "additionalProperties": True}, "examples": {"playground": {"value": {"action": "playground", "workflowId": "wf-support", "input": "배송은 얼마나 걸리나요?"}}, "publish": {"value": {"action": "publish", "workflowId": "wf-support", "idempotencyKey": "example-unique-publish"}}}}}}})
    @router.api_route("/api/console", methods=["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], include_in_schema=False)
    async def console(request: Request):
        try:
            actor = admin_allowed(request, env)
            role = console_role(request, env, actor)
            params = request.query_params
            if request.method == "GET":
                view = params.get("view")
                if view == "dashboard":
                    return json_response(await aggregate_dashboard(store, {key: params[key] for key in ("from", "to", "workflowId", "source", "status") if key in params}))
                if view == "evaluations":
                    run_id = identifier(params["runId"]) if "runId" in params else None
                    if params.get("history") == "true":
                        try:
                            options = {key: params[key] for key in ("query", "workflowId", "datasetId", "status", "from", "to", "cursor") if key in params}
                            if "limit" in params:
                                try:
                                    options["limit"] = int(params["limit"])
                                except ValueError:
                                    raise ValueError("조회 건수를 확인하세요.") from None
                            return json_response(await evaluation_history(store, options, run_id))
                        except (ValueError, TypeError) as error:
                            raise ApiError(str(error), "invalid_evaluation_query", 400) from None
                    return json_response(await store.evaluation_status(run_id))
                if view == "deployment":
                    if "deploymentId" in params:
                        result = await store.get_deployment(identifier(params["deploymentId"]))
                    else:
                        try:
                            version = int(params.get("version", ""))
                        except ValueError:
                            raise ApiError("배포 버전을 확인하세요.")
                        require(version > 0, "배포 버전을 확인하세요.")
                        result = await store.get_deployment_for_request(identifier(params.get("workflowId")), version)
                    return json_response({"deployment": result})
                if view == "logs":
                    options = {}
                    for key in ("query", "workflowId", "keyId", "status", "source", "from", "to", "cursor"):
                        if params.get(key):
                            options[key] = params[key]
                    if "limit" in params:
                        try:
                            options["limit"] = int(params["limit"])
                        except ValueError:
                            raise ApiError("조회 건수를 확인하세요.")
                    try:
                        return json_response(await store.search_logs(options))
                    except (ValueError, TypeError) as exc:
                        raise ApiError("조회 조건이나 페이지 정보를 확인하세요.", "invalid_log_query") from exc
                if view == "verification":
                    if "deploymentId" in params:
                        target = await store.get_deployment(identifier(params["deploymentId"]))
                        require(target, "복원할 배포 버전을 찾을 수 없습니다.", "not_found", 404)
                        current = await store.get_record("workflow", target["workflowId"])
                        require(current, "현재 워크플로우를 찾을 수 없습니다.", "not_found", 404)
                        fingerprint = configuration_fingerprint(target["workflow"], target["connections"])
                        return json_response({"evidence": await store.verification_evidence(target["workflowId"], fingerprint), "fingerprint": fingerprint, "policy": current.get("releasePolicy", {"requireVerification": False, "requiredDatasetIds": []}), "currentWorkflowUpdatedAt": current.get("updatedAt", "")})
                    workflow, connections, _ = await capture_workflow(store, identifier(params.get("workflowId")))
                    fingerprint = configuration_fingerprint(workflow, connections)
                    return json_response({"evidence": await store.verification_evidence(workflow["id"], fingerprint), "fingerprint": fingerprint})
                state = await store.state()
                state["role"] = role
                return json_response({"state": state})

            require(request.method == "POST", "지원하지 않는 메서드입니다.", "method_not_allowed", 405)
            data = await read_body(request)
            action = text(data.get("action"), 100)
            require_action_role(role, action)
            state = await store.state()
            state["role"] = role
            extra, audit_handled = {}, False
            command_request = None
            if action in {"publish", "rollback_deployment"}:
                key = data.get("idempotencyKey", request.headers.get("idempotency-key"))
                if "idempotencyKey" in data and "idempotency-key" in request.headers:
                    require(data["idempotencyKey"] == request.headers["idempotency-key"], "배포 요청 번호가 서로 다릅니다.")
                if key is not None:
                    require(isinstance(key, str) and re.fullmatch(r"[a-zA-Z0-9_-]{8,120}", key), "배포 요청 번호를 확인하세요.")
                    command_request = deployment_request(actor, key, data)
                    previous = await store.deployment_for_request(command_request)
                    if previous:
                        return json_response({"state": state, "deployment": previous, "replayed": True})
            lifecycle = await handle_lifecycle_action(data, store, actor, role)
            evaluated = await handle_evaluation_action(data, state, store, env) if lifecycle is None else None
            if lifecycle is not None:
                extra, audit_handled = lifecycle, True
            elif evaluated is not None:
                extra = evaluated
            elif action in {"save_policy", "test_policy"}:
                definition = validate_payload("policy", data.get("policy"))
                connection = await store.get_record_with_version("connection", definition["connectionId"])
                require(connection, "정책에 사용할 모델 연결을 찾을 수 없습니다.", "not_found", 404)
                require(connection["value"].get("role") in {"guard", "both"}, "정책에는 검사 또는 공용 모델 연결을 선택하세요.")
                issues = validate_connection(connection["value"])
                require(not issues, "; ".join(issues))
                if action == "save_policy":
                    require(type(data.get("expectedVersion")) is int and 0 <= data["expectedVersion"] <= MAX_POLICY_VERSIONS, "정책 저장 기준 버전을 확인하세요.")
                    extra["policy"] = await store.save_policy_revision(definition, connection["value"], data["expectedVersion"], audit_event(actor, data), connection["revision"])
                    audit_handled = True
                else:
                    policy = {**definition, "connectionSnapshot": connection["value"], "version": 1, "updatedAt": now_iso()}
                    runtime = ExecutionRuntime({"timeoutMs": 120000, "maxModelCalls": len(definition["examples"])})
                    results = []
                    for example in definition["examples"]:
                        generic_output = definition.get("formatVersion", 1) == 2
                        result = {"exampleId": example["id"], **({} if generic_output else {"expectedDecision": example["expectedDecision"]})}
                        try:
                            if generic_output:
                                output = await classify_policy_output(policy, example["input"], state["ingress"], env, runtime=runtime, client=env.get("_client"))
                                verdict = compare_policy_example(output, example)
                                matched = verdict["expectationMatched"]
                                if verdict["checks"]:
                                    result["checks"] = verdict["checks"]
                                result.update(status="pass" if matched else "fail", schemaValid=True, expectationMatched=matched, message="예상 출력과 일치합니다." if matched else "형식은 유효하지만 예상 출력과 다릅니다.")
                                del output
                            else:
                                decision = await classify_policy(policy, example["input"], state["ingress"], env, runtime=runtime, client=env.get("_client"))
                                result.update(decision=decision, status="pass" if decision == example["expectedDecision"] else "fail", message="예상 판정과 일치합니다." if decision == example["expectedDecision"] else "예상 판정과 다릅니다.")
                        except Exception:
                            result.update(status="error", message="정책 판정에 실패했습니다. 모델 연결, 출력 형식과 실행 제한을 확인하세요.")
                        results.append(result)
                    extra["policyTest"] = {"results": results, "schema": policy_output_schema(policy), "mode": connection["value"]["mode"]}
            elif action == "save_workflow":
                workflow = validate_payload("workflow", data.get("workflow"))
                if workflow.get("policyRouting"):
                    from .structured_schema import strict_json_equal
                    snapshot = workflow["policyRouting"]["policy"]
                    registered = await store.get_record("policy", f"{snapshot['id']}:{snapshot['version']}")
                    require(strict_json_equal(registered, snapshot), "등록된 정책 버전을 다시 선택하세요. 정책 내용은 버전을 새로 저장한 뒤 연결해야 합니다.", "invalid_policy_snapshot")
                previous = next((w for w in state["workflows"] if w["id"] == workflow["id"]), None)
                if role != "admin":
                    require(workflow.get("releasePolicy") == (previous or {}).get("releasePolicy"), "배포 검증 기준은 관리자만 변경할 수 있습니다.", "forbidden", 403)
                require(not workflow.get("cloneSource") or workflow["cloneSource"]["workflowId"] != workflow["id"], "복제 원본은 현재 워크플로우와 달라야 합니다.")
                enforce_limit(state["workflows"], workflow["id"], 30, "워크플로우")
                issues = validate_workflow_graph(workflow)
                require(not issues, "; ".join(issues))
                groups = workflow["pre"] + workflow["post"]
                rule_ids = [r["id"] for g in groups for r in g["rules"]]
                group_ids = [g["id"] for g in groups]
                require(len(rule_ids) == len(set(rule_ids)), "워크플로우 안의 검사 ID는 서로 달라야 합니다.")
                require(len(group_ids) == len(set(group_ids)), "단계 ID는 고유해야 합니다.")
                controls = [f"control:{node['id']}" for stage in ("pre", "post") for node in workflow.get("graph", {}).get(stage, {}).get("nodes", [])]
                known = {"input", "main", "output", *controls, *(f"group:{v}" for v in group_ids), *(f"rule:{v}" for v in rule_ids)}
                visible = {"input", "main", "output", *controls, *(f"rule:{g['rules'][0]['id']}" if len(g["rules"]) == 1 else f"group:{g['id']}" for g in groups)}
                if workflow.get("policyRouting"):
                    policy_keys = {"policy", *(f"policy-node:{node['id']}" for node in workflow["policyRouting"].get("graph", {}).get("nodes", []))}
                    known.update(policy_keys)
                    visible.update(policy_keys)
                layout = workflow.get("layout", {})
                require(set(layout.get("positions", {})) <= known, "노드 위치에 현재 워크플로우에 없는 노드가 포함되어 있습니다.")
                require(set(layout.get("pinnedKeys", [])) <= visible, "위치를 고정할 노드를 현재 화면에서 다시 선택하세요.")
                issues = validate_zones(workflow)
                require(not issues, "; ".join(issues), "noncontiguous_zone")
                expected = data.get("expectedUpdatedAt", UNSET if role == "admin" else previous.get("updatedAt", "") if previous else None)
                if expected is not UNSET and expected is not None:
                    expected = text(expected, 100, empty=True, trim=False)
                require(await store.save_record_checked("workflow", workflow["id"], {**workflow, "updatedAt": now_iso()}, expected), "다른 화면에서 워크플로우를 변경했습니다. 현재 편집 내용은 유지되며, 서버 저장본과 비교한 뒤 다시 저장하세요.", "stale_workflow_save", 409)
            elif action == "delete_workflow":
                workflow_id = identifier(data.get("id"))
                require(any(w["id"] == workflow_id for w in state["workflows"]), "워크플로우를 찾을 수 없습니다.", "not_found", 404)
                require(not any(d["workflowId"] == workflow_id for d in state["deployments"]), "배포 이력이 있는 워크플로우는 삭제할 수 없습니다.", "deployed_workflow")
                await store.remove("workflow", workflow_id)
            elif action == "save_connection":
                connection = validate_payload("connection", data.get("connection"))
                enforce_limit(state["connections"], connection["id"], 30, "모델 서버")
                issues = validate_connection(connection)
                require(not issues, "; ".join(issues))
                await store.save_connection(connection)
            elif action == "delete_connection":
                connection_id = identifier(data.get("id"))
                used = any(w["mainConnectionId"] == connection_id or any(r["config"].get("connectionId") == connection_id for g in w["pre"] + w["post"] for r in g["rules"]) for w in state["workflows"])
                require(not used, "초안 워크플로우에서 사용 중인 모델 서버입니다. 해당 워크플로우의 서버 연결을 바꾼 뒤 삭제하세요.")
                await store.delete_connection(connection_id)
            elif action == "save_ingress":
                ingress = validate_payload("ingress", data.get("ingress"))
                issues = validate_ingress(ingress)
                require(not issues, "; ".join(issues))
                await store.save_ingress(ingress)
            elif action == "save_dataset":
                dataset = validate_payload("dataset", data.get("dataset"))
                enforce_limit(state["datasets"], dataset["id"], 30, "데이터셋")
                require(len({r["id"] for r in dataset["rows"]}) == len(dataset["rows"]), "데이터셋 행 ID는 고유해야 합니다.")
                expected = data.get("expectedUpdatedAt", UNSET)
                if expected is not UNSET and expected is not None:
                    expected = text(expected, 100, empty=True, trim=False)
                require(await store.save_record_checked("dataset", dataset["id"], {**dataset, "updatedAt": now_iso()}, expected), "다른 화면에서 데이터셋을 변경했습니다. 현재 편집 내용은 유지되며, 서버 저장본과 비교한 뒤 다시 저장하세요.", "stale_dataset_save", 409)
            elif action == "delete_dataset":
                dataset_id = identifier(data.get("id"))
                require(any(d["id"] == dataset_id for d in state["datasets"]), "데이터셋을 찾을 수 없습니다.", "not_found", 404)
                await store.remove("dataset", dataset_id)
            elif action == "create_mapped_dataset":
                source_id, workflow_id = identifier(data.get("sourceDatasetId")), identifier(data.get("workflowId"))
                captured = await store.get_record_with_version("dataset", source_id)
                require(captured, "원본 데이터셋을 찾을 수 없습니다.", "not_found", 404)
                source = captured["value"]
                checks = [{"namespace": "dataset", "id": source_id, "revision": captured["revision"]}]
                latest = None
                if data.get("target") == "deployed":
                    candidates = sorted((d for d in state["deployments"] if d["workflowId"] == workflow_id), key=lambda d: (d["createdAt"], d["version"]), reverse=True)
                    require(candidates, "먼저 워크플로우를 배포하세요.", "not_deployed")
                    latest = candidates[0]
                    workflow, connections = latest["workflow"], latest["connections"]
                else:
                    require(data.get("target") == "draft", "실행 대상을 확인하세요.")
                    workflow, connections, current_checks = await capture_workflow(store, workflow_id)
                    checks.extend(current_checks)
                require(dataset_fingerprint(source) == fingerprint_value(data.get("expectedDatasetFingerprint")), "원본 데이터셋이 변경되었습니다. 검사 연결을 다시 확인하세요.", "stale_dataset_mapping", 409)
                require(configuration_fingerprint(workflow, connections) == fingerprint_value(data.get("expectedWorkflowFingerprint")), "검토 중 워크플로우가 변경되었습니다. 검사 연결을 다시 확인하세요.", "stale_dataset_mapping", 409)
                try:
                    mapped = apply_dataset_rule_mappings(source, workflow, data.get("mappings"))
                except (ValueError, ApiError) as exc:
                    raise ApiError(str(exc), "invalid_dataset_mapping") from exc
                dataset = validate_payload("dataset", {**mapped, "id": str(uuid.uuid4()), "name": text(data.get("name"), 120), "rows": [{**r, "id": str(uuid.uuid4())} for r in mapped["rows"]], "updatedAt": now_iso()})
                require(len(state["datasets"]) < 30, "데이터셋은 최대 30개까지 저장할 수 있습니다.", "dataset_limit", 409)
                latest_check = {"workflowId": workflow_id, "id": latest["id"]} if latest else None
                require(await store.insert_mapped_dataset(dataset, checks, 30, latest_check), "검토 중 데이터셋이나 워크플로우가 변경되었습니다. 검사 연결을 다시 확인하세요.", "stale_dataset_mapping", 409)
                extra["dataset"] = dataset
            elif action in {"test_connection", "diagnose_connection", "collect_connection_metrics"}:
                connection, ingress, checks = await capture_connection_check(store, identifier(data.get("id")))
                if action == "test_connection":
                    extra["test"] = await test_connection(connection, ingress, env, client=env.get("_client"))
                else:
                    metrics = action == "collect_connection_metrics"
                    result = await (collect_connection_metrics if metrics else diagnose_connection)(connection, ingress, env, client=env.get("_client"))
                    require(await store.put_if_unchanged("model_metric" if metrics else "diagnostic", connection["id"], result, checks), "검사 중 모델 서버 설정이나 접근 정책이 변경되었습니다. 다시 검사하세요.", "connection_changed", 409)
                    extra["modelMetric" if metrics else "diagnostic"] = result
            elif action == "playground":
                messages = validate_payload("conversation", data["messages"]) if "messages" in data else [{"role": "user", "content": text(data.get("input"), 16000, trim=False)}]
                if "messages" not in data:
                    require(messages[0]["content"].strip(), "입력에는 공백 외의 문자가 필요합니다.")
                options = validate_payload("generation", data.get("generationOptions", {}))
                if "mockResponse" in data:
                    options["mockResponse"] = text(data["mockResponse"], 40000, empty=True, trim=False)
                require("progress" not in data or isinstance(data["progress"], bool), "진행 상태 표시 설정을 확인하세요.")
                workflow, connections, version = copy.deepcopy(workflow_from(state, data.get("workflowId"), data.get("target")))
                issues = validate_workflow(workflow, connections)
                require(not issues, "; ".join(issues))
                fingerprint = configuration_fingerprint(workflow, connections)
                if "expectedFingerprint" in data:
                    require(fingerprint_value(data["expectedFingerprint"]) == fingerprint, "실행할 워크플로우가 변경되었습니다. 현재 설정을 다시 확인하세요.", "stale_workflow_execution", 409)
                if data.get("progress"):
                    return progress_response(request, workflow, connections, state["ingress"], messages, options, fingerprint, version, actor)
                result = await execute_attached(request, workflow, connections, state["ingress"], env, messages, options, client=env.get("_client"))
                await store.log(record_log(result, "playground", workflow, version))
                extra.update(result=result, fingerprint=fingerprint)
            elif action in {"publish", "rollback_deployment"}:
                if action == "publish":
                    workflow, connections, checks = await capture_workflow(store, identifier(data.get("workflowId")))
                    target = None
                else:
                    target = await store.get_deployment(identifier(data.get("deploymentId")))
                    require(target, "복원할 배포 버전을 찾을 수 없습니다.", "not_found", 404)
                    current = await store.get_record_with_version("workflow", target["workflowId"])
                    require(current, "현재 워크플로우를 찾을 수 없습니다.", "not_found", 404)
                    if "expectedUpdatedAt" in data:
                        require(text(data["expectedUpdatedAt"], 100, empty=True, trim=False) == current["value"].get("updatedAt", ""), "배포 기준이 변경되었습니다. 복원 내용을 다시 확인하세요.", "stale_workflow", 409)
                    workflow = {**copy.deepcopy(target["workflow"]), "releasePolicy": current["value"].get("releasePolicy", {"requireVerification": False, "requiredDatasetIds": []})}
                    connections = target["connections"]
                    checks = [{"namespace": "workflow", "id": current["value"]["id"], "revision": current["revision"]}]
                issues = validate_workflow(workflow, connections)
                require(not issues, "; ".join(issues), "invalid_rollback_configuration" if target else "invalid_request")
                fingerprint = configuration_fingerprint(workflow, connections)
                if "expectedFingerprint" in data:
                    require(fingerprint_value(data["expectedFingerprint"]) == fingerprint, "검토한 설정이 변경되었습니다. 다시 검토하세요.", "stale_workflow", 409)
                policy = workflow.get("releasePolicy", {})
                proof_required = not target or policy.get("requireVerification") or policy.get("requiredDatasetIds") or any(k in data for k in ("verificationRunIds", "verificationRunId", "acknowledgeUnverified"))
                if proof_required:
                    evidence = await verify_deployment_evidence(store, workflow, fingerprint, data)
                    checks.extend(evidence.pop("checks"))
                else:
                    evidence = {k: copy.deepcopy(target[k]) for k in ("verificationRunId", "verificationRunIds", "verificationSummaries", "unverifiedReason") if k in target}
                    if any(evidence.get(k) for k in ("verificationRunId", "verificationRunIds", "verificationSummaries")):
                        evidence["verificationProvenance"] = "historical"
                ingress = await store.get_record_with_version("meta", "ingress")
                require(ingress, "접근 정책을 찾을 수 없습니다.", "not_found", 404)
                validate_snapshot_connections(connections, ingress["value"], env, workflow)
                checks.append({"namespace": "meta", "id": "ingress", "revision": ingress["revision"]})
                require(not any(d["alias"] == workflow["alias"] and d["workflowId"] != workflow["id"] for d in state["deployments"]), "다른 워크플로우에서 사용 중인 API 모델 이름입니다.")
                snapshot = {"id": str(uuid.uuid4()), "workflowId": workflow["id"], "alias": workflow["alias"], "createdAt": now_iso(), "workflow": workflow, "connections": connections, "fingerprint": fingerprint, **evidence, "engineVersion": ENGINE_VERSION}
                if "note" in data:
                    snapshot["note"] = text(data["note"], 1000, empty=True, trim=False)
                if target:
                    snapshot["rollbackOf"] = target["id"]
                deployment = await store.deploy_checked(snapshot, checks, {"audit": audit_event(actor, data), "request": command_request})
                require(deployment, "검토 중 설정이 변경되었거나 모델 이름이 사용되었습니다. 다시 검토하세요.", "stale_workflow", 409)
                audit_handled = True
                extra["deployment"] = deployment
            elif action == "create_key":
                require(len(state["keys"]) < 100, "API 키는 최대 100개까지 발급할 수 있습니다.")
                created = await store.create_key(text(data.get("name"), 80), parse_policy(data.get("policy")))
                extra["key"] = created["key"]
            elif action == "update_key_policy":
                key_id = identifier(data.get("id"))
                require(any(k["id"] == key_id for k in state["keys"]), "API 키를 찾을 수 없습니다.", "not_found", 404)
                await store.update_key_policy(key_id, parse_policy(data.get("policy")))
            elif action == "revoke_key":
                key_id = identifier(data.get("id"))
                require(any(k["id"] == key_id for k in state["keys"]), "API 키를 찾을 수 없습니다.", "not_found", 404)
                await store.revoke_key(key_id)
            elif action == "save_retention":
                retention = validate_payload("retention", data.get("retention"))
                await store.put("meta", "retention", retention)
                await store.prune_retention(retention)
            else:
                raise ApiError("지원하지 않는 관리 작업입니다.")
            if not audit_handled:
                await store.audit(audit_event(actor, data))
            result_state = await store.state()
            result_state["role"] = role
            return json_response({"state": result_state, **extra})
        except Exception as error:
            return error_response(error)

    def progress_response(request, workflow, connections, ingress, messages, options, fingerprint, version, actor):
        async def stream():
            queue = asyncio.Queue(maxsize=2008)
            cancel = asyncio.Event()
            def progress(event):
                try:
                    queue.put_nowait({"type": "progress", "event": event})
                except asyncio.QueueFull:
                    pass
            async def execute():
                try:
                    result = await execute_workflow(workflow, connections, ingress, env, messages, options, on_progress=progress, cancel_event=cancel, client=env.get("_client"))
                    await store.log(record_log(result, "playground", workflow, version))
                    await store.audit({"id": str(uuid.uuid4()), "actor": actor, "action": "playground", "target": workflow["id"], "createdAt": now_iso(), "detail": "완료"})
                    await queue.put({"type": "result", "result": result, "fingerprint": fingerprint})
                except asyncio.CancelledError:
                    raise
                except Exception:
                    await queue.put({"type": "error", "error": {"message": "검증을 완료하거나 결과를 저장하지 못했습니다. 서버 연결과 실행 기록을 확인하세요.", "code": "execution_failed"}})
                finally:
                    await queue.put(None)
            task = asyncio.create_task(execute())
            try:
                while True:
                    value = await queue.get()
                    if value is None:
                        break
                    yield json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
            finally:
                cancel.set()
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        return StreamingResponse(stream(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no"})

    @router.get("/v1/models", tags=["Gateway"], operation_id="list_models")
    @router.api_route("/v1/models", methods=["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], include_in_schema=False)
    async def models(request: Request):
        reservation = None
        try:
            require(request.method == "GET", "지원하지 않는 메서드입니다.", "method_not_allowed", 405)
            _, key = await gateway_context(request)
            reservation = await reserve(key, 0, 30_000)
            models = await store.active_model_summaries(key.get("policy", {}).get("allowedModels"))
            return json_response({"object": "list", "data": [{"id": d["alias"], "object": "model", "created": int(_parse_time(d["createdAt"])), "owned_by": "aegis-gateway"} for d in models]})
        except Exception as error:
            return error_response(error, True)
        finally:
            if reservation:
                await store.release_quota(reservation, 0)

    @router.post("/v1/chat/completions", tags=["Gateway"], operation_id="create_chat_completion", openapi_extra={"requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["model", "messages"], "additionalProperties": False, "properties": {"model": {"type": "string", "maxLength": 80}, "messages": {"type": "array", "minItems": 1, "maxItems": 32, "items": {"type": "object", "required": ["role", "content"], "additionalProperties": False, "properties": {"role": {"type": "string", "enum": ["system", "user", "assistant"]}, "content": {"type": "string", "minLength": 1, "maxLength": 16000}}}}, "temperature": {"type": "number", "minimum": 0, "maximum": 2}, "max_tokens": {"type": "integer", "minimum": 1, "maximum": 8192}, "top_p": {"type": "number", "minimum": 0, "maximum": 1}, "stream": {"type": "boolean", "enum": [False]}}}}}}})
    @router.api_route("/v1/chat/completions", methods=["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], include_in_schema=False)
    async def completions(request: Request):
        reservation, actual_tokens = None, None
        try:
            require(request.method == "POST", "지원하지 않는 메서드입니다.", "method_not_allowed", 405)
            ingress, key = await gateway_context(request)
            data = await read_body(request)
            require("stream" not in data or data["stream"] is False, "응답 검사를 마친 뒤 결과를 반환하므로 stream:true는 지원하지 않습니다.", "streaming_not_supported")
            unsupported = set(data) - {"model", "messages", "temperature", "max_tokens", "top_p", "stream"}
            require(not unsupported, "지원하지 않는 필드: " + ", ".join(sorted(unsupported)), "unsupported_parameter")
            alias = text(data.get("model"), 80)
            allowed = key.get("policy", {}).get("allowedModels")
            require(allowed is None or alias in allowed, "이 API 키에 허용되지 않은 모델입니다.", "model_not_allowed", 403)
            messages = validate_payload("conversation", data.get("messages"))
            options = validate_payload("generation", {k: data[k] for k in ("temperature", "max_tokens", "top_p") if k in data})
            deployment = await store.active_deployment(alias)
            require(deployment, "배포된 API 모델 이름을 찾을 수 없습니다.", "model_not_found", 404)
            reservation = await reserve(key, response_token_reservation(deployment["workflow"], messages, options.get("max_tokens", 1024)), execution_lease_duration(deployment["workflow"]))
            result = await execute_attached(request, deployment["workflow"], deployment["connections"], ingress, env, messages, options, client=env.get("_client"))
            # Token usage follows the existing Main-generation accounting. A
            # registered response never calls Main, including when POST blocks it.
            actual_tokens = result.get("usage", {}).get("total_tokens", 0 if result["stage"] == "pre" or result.get("policyRoute") == "respond" else reservation["reservedTokens"])
            await store.log(record_log(result, "gateway", deployment["workflow"], f"v{deployment['version']}", key["id"], deployment["id"]))
            headers = {"X-Aegis-Request-Id": result["id"], "X-Aegis-Workflow-Version": str(deployment["version"])}
            if result["status"] != "allow":
                blocked = result["status"] == "block"
                message = ("요청 검사" if result["stage"] == "pre" else "응답 검사") + "에서 차단되었습니다." if blocked else "모델 호출이나 검사 실행에 실패했습니다."
                error = {"message": message, "type": "policy_violation" if blocked else "server_error", "param": None, "code": "guardrail_blocked" if blocked else "guardrail_error", "request_id": result["id"], "stage": result["stage"]}
                if isinstance(result.get("policyCode"), str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", result["policyCode"]):
                    error["policyCode"] = result["policyCode"]
                    if blocked and result.get("policyRoute") == "error" and isinstance(result.get("publicMessage"), str):
                        error["message"] = result["publicMessage"]
                return json_response({"error": error}, 403 if blocked else 502, headers)
            response = {"id": f"chatcmpl-{result['id']}", "object": "chat.completion", "created": int(time.time()), "model": alias, "choices": [{"index": 0, "message": {"role": "assistant", "content": result["output"]}, "finish_reason": result.get("finishReason", "stop")}]}
            if result.get("usage"):
                response["usage"] = result["usage"]
            return json_response(response, headers=headers)
        except Exception as error:
            return error_response(error, True)
        finally:
            if reservation:
                await store.release_quota(reservation, actual_tokens if actual_tokens is not None else reservation["reservedTokens"])

    @router.post("/api/evaluations/worker", tags=["Worker"], operation_id="evaluation_worker", openapi_extra={"requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["action", "workerId"], "additionalProperties": False, "properties": {"action": {"type": "string", "enum": ["heartbeat", "process", "disconnect"]}, "workerId": {"type": "string", "maxLength": 120}}}}}}})
    async def evaluation_worker(request: Request):
        from .worker import handle_evaluation_worker
        return await handle_evaluation_worker(request, store, env)

    return router
