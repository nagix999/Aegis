"""Reversible operating state, separate from immutable policies and deployments."""
from __future__ import annotations

from datetime import datetime, timezone
import uuid

from .errors import ApiError

LIFECYCLE_NAMESPACES = {"workflows": "lifecycle_workflow", "policies": "lifecycle_policy", "deployments": "lifecycle_deployment"}
LIFECYCLE_ACTIONS = {"set_workflow_archived", "set_policy_archived", "set_deployment_paused"}
MAX_POLICY_VERSIONS = 1000


def policy_version_limit(env: dict) -> int:
    value = env.get("AEGIS_POLICY_MAX_VERSIONS", 100)
    try:
        if isinstance(value, bool) or str(value).strip() != str(int(value)):
            raise ValueError
        limit = int(value)
        if not 100 <= limit <= MAX_POLICY_VERSIONS:
            raise ValueError
    except (ValueError, TypeError, OverflowError):
        raise ApiError("AEGIS_POLICY_MAX_VERSIONS는 100~1,000 범위의 정수로 설정하세요.", "invalid_policy_capacity", 500) from None
    return limit


def _text(value, label: str, maximum: int = 120) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ApiError(f"{label}을 확인하세요.")
    return value.strip()


def _record(store, namespace: str, identifier: str) -> dict | None:
    record = store._get(namespace, identifier)
    return record["value"] if record else None


def workflow_archived(store, identifier: str) -> bool:
    return bool((_record(store, "lifecycle_workflow", identifier) or {}).get("archived"))


def policy_archived(store, identifier: str) -> bool:
    return bool((_record(store, "lifecycle_policy", identifier) or {}).get("archived"))


def deployment_paused(store, alias: str) -> bool:
    return bool((_record(store, "lifecycle_deployment", alias) or {}).get("paused"))


def lifecycle_summary(store) -> dict:
    """Call under the Store lock so this matches the rest of the console state."""
    import json
    lifecycle = {}
    for name, namespace in LIFECYCLE_NAMESPACES.items():
        lifecycle[name] = {row["id"]: json.loads(row["payload"]) for row in store.db.execute("SELECT id,payload FROM aegis_records WHERE namespace=?", (namespace,))}
    policies = store.db.execute("SELECT COUNT(*),COUNT(DISTINCT json_extract(payload,'$.id')) FROM aegis_records WHERE namespace='policy'").fetchone()
    return {"lifecycle": lifecycle, "policyCapacity": {"versions": policies[0], "families": policies[1], "maxVersions": policy_version_limit(store.env), "maxFamilies": 30}}


async def handle_lifecycle_action(data: dict, store, actor: str, role: str) -> dict | None:
    action = data.get("action")
    if action not in LIFECYCLE_ACTIONS:
        return None
    if role != "admin":
        raise ApiError("이 작업은 관리자만 실행할 수 있습니다.", "forbidden", 403)
    paused = action == "set_deployment_paused"
    field = "paused" if paused else "archived"
    value = data.get(field)
    if type(value) is not bool:
        raise ApiError("운영 상태는 true 또는 false로 지정하세요.")
    identifier = _text(data.get("alias" if paused else "workflowId" if action == "set_workflow_archived" else "policyId"), "작업 대상")
    namespace = "lifecycle_deployment" if paused else "lifecycle_workflow" if action == "set_workflow_archived" else "lifecycle_policy"
    with store._transaction():
        if paused:
            target = store.db.execute("SELECT id,workflow_id FROM aegis_deployments WHERE alias=? ORDER BY version DESC LIMIT 1", (identifier,)).fetchone()
            if not target:
                raise ApiError("배포된 API 모델 이름을 찾을 수 없습니다.", "not_found", 404)
            expected = _text(data.get("expectedDeploymentId"), "확인한 배포 버전")
            if target["id"] != expected:
                raise ApiError("확인한 뒤 배포가 변경되었습니다. 현재 배포를 다시 확인하세요.", "stale_lifecycle", 409)
            if not value and workflow_archived(store, target["workflow_id"]):
                raise ApiError("보관한 워크플로우입니다. 워크플로우를 복원한 뒤 호출을 재개하세요.", "workflow_archived", 409)
        elif action == "set_workflow_archived":
            if not store._get("workflow", identifier):
                raise ApiError("워크플로우를 찾을 수 없습니다.", "not_found", 404)
            if value:
                aliases = [row[0] for row in store.db.execute("SELECT DISTINCT alias FROM aegis_deployments WHERE workflow_id=?", (identifier,))]
                if any(not deployment_paused(store, alias) for alias in aliases):
                    raise ApiError("호출 중인 배포가 있습니다. API 배포에서 이 워크플로우의 모든 API 모델 호출을 중지한 뒤 보관하세요.", "workflow_in_service", 409)
        else:
            if not store.db.execute("SELECT 1 FROM aegis_records WHERE namespace='policy' AND json_extract(payload,'$.id')=? LIMIT 1", (identifier,)).fetchone():
                raise ApiError("정책을 찾을 수 없습니다.", "not_found", 404)
        previous = _record(store, namespace, identifier)
        if previous and previous.get(field) is value:
            return {}
        if "expectedUpdatedAt" in data:
            expected = data["expectedUpdatedAt"]
            if expected is not None and not isinstance(expected, str):
                raise ApiError("운영 상태 확인 기준을 확인하세요.")
            if expected != (previous or {}).get("updatedAt"):
                raise ApiError("다른 화면에서 운영 상태를 변경했습니다. 현재 상태를 다시 확인하세요.", "stale_lifecycle", 409)
        timestamp = datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
        store._put(namespace, identifier, {field: value, "updatedAt": timestamp, "actor": actor}, timestamp)
        event = {"id": str(uuid.uuid4()), "actor": actor, "action": action, "target": identifier, "createdAt": timestamp,
                 "detail": "호출 중지" if paused and value else "호출 재개" if paused else "보관" if value else "보관 해제"}
        store._put("audit", event["id"], event, timestamp)
    return {}
