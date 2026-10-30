"""SQLite persistence shared by the FastAPI gateway and evaluation workers.

The JSON payloads and table names intentionally match the former TypeScript
runtime. Transactions contain no await points; SQLite serializes other server
processes through BEGIN IMMEDIATE as well as the in-process lock.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from typing import Any
import uuid

UNSET = object()
DEFAULT_RETENTION = {"logDays": 30, "evaluationDays": 30, "auditDays": 90}
ROOT = Path(__file__).resolve().parents[2]


class DeploymentRequestConflict(ValueError):
    status = 409
    code = "idempotency_conflict"


class ModelCapacityError(RuntimeError):
    pass


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def iso_at(milliseconds: int | float | None = None) -> str:
    value = now_ms() if milliseconds is None else milliseconds
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def date_ms(value: str) -> int:
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _deployment(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {**json.loads(row["payload"]), "id": row["id"], "workflowId": row["workflow_id"],
            "alias": row["alias"], "version": row["version"], "createdAt": row["created_at"]}


def _key_summary(row: sqlite3.Row) -> dict:
    usage = json.loads(row["usage_payload"]) if "usage_payload" in row.keys() and row["usage_payload"] else {"window": 0, "requests": 0, "tokens": 0, "leases": {}}
    current = usage.get("window") == now_ms() // 60_000
    value = {"id": row["id"], "name": row["name"], "prefix": row["prefix"], "createdAt": row["created_at"], "revoked": bool(row["revoked"]),
             "usage": {"requests": usage.get("requests", 0) if current else 0, "tokens": usage.get("tokens", 0) if current else 0,
                       "active": sum(1 for expiry in usage.get("leases", {}).values() if expiry > now_ms())}}
    if "policy_payload" in row.keys() and row["policy_payload"]:
        value["policy"] = json.loads(row["policy_payload"])
    return value


class Store:
    def __init__(self, db_path: str | Path = ":memory:", env: dict | None = None):
        self.env = env or {}
        self.path = str(db_path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, isolation_level=None, check_same_thread=False, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.execute("PRAGMA foreign_keys=ON")
        self._migrate()

    @contextmanager
    def _transaction(self):
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def _migrate(self):
        with self.lock:
            self.db.execute("CREATE TABLE IF NOT EXISTS _aegis_local_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
        migrations = sorted((ROOT / "drizzle").glob("[0-9]*.sql"))
        if not migrations:
            raise RuntimeError("데이터베이스 마이그레이션 파일을 찾을 수 없습니다.")
        for migration in migrations:
            with self._transaction():
                if self.db.execute("SELECT name FROM _aegis_local_migrations WHERE name=?", (migration.name,)).fetchone():
                    continue
                # D1 exports may have the schema but no standalone migration ledger.
                existing = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                expected = {"aegis_records", "aegis_deployments", "aegis_gateway_keys", "aegis_request_logs"}
                if migration.name.startswith("0000") and expected <= existing:
                    self.db.execute("INSERT INTO _aegis_local_migrations VALUES (?,?)", (migration.name, iso_at()))
                    continue
                sql = migration.read_text()
                if migration.name.startswith("0001"):
                    columns = {row[1] for row in self.db.execute("PRAGMA table_info(aegis_records)")}
                    if "revision" in columns:
                        sql = re.sub(r"ALTER TABLE\s+`aegis_records`\s+ADD COLUMN\s+`revision`[^;]+;", "", sql)
                        sql = sql.replace("CREATE TRIGGER `", "CREATE TRIGGER IF NOT EXISTS `")
                # Split on migration markers, not semicolons inside trigger bodies.
                for statement in sql.split("--> statement-breakpoint"):
                    if statement.strip():
                        self.db.execute(statement)
                self.db.execute("INSERT INTO _aegis_local_migrations VALUES (?,?)", (migration.name, iso_at()))

    async def close(self):
        with self.lock:
            self.db.close()

    def _get(self, namespace: str, identifier: str) -> dict | None:
        row = self.db.execute("SELECT payload FROM aegis_records WHERE namespace=? AND id=?", (namespace, identifier)).fetchone()
        return {"value": json.loads(row[0]), "revision": row[0]} if row else None

    def _put(self, namespace: str, identifier: str, value: Any, timestamp: str | None = None):
        self.db.execute("INSERT INTO aegis_records(namespace,id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
                        (namespace, identifier, dump(value), timestamp or iso_at()))

    def _checks_match(self, checks: list[dict]) -> bool:
        return all(self.db.execute("SELECT 1 FROM aegis_records WHERE namespace=? AND id=? AND payload=?", (c["namespace"], c["id"], c["revision"])).fetchone() for c in checks)

    async def seed(self):
        with self._transaction():
            if self._get("meta", "initialized"):
                return
            seed = json.loads(Path(__file__).with_name("seed.json").read_text())
            timestamp = iso_at()
            rows = [(ns, value["id"], value) for ns, key in [("workflow", "workflows"), ("connection", "connections"), ("dataset", "datasets")] for value in seed[key]]
            rows += [("meta", "ingress", seed["ingress"]), ("meta", "initialized", True)]
            for namespace, identifier, value in rows:
                self.db.execute("INSERT OR IGNORE INTO aegis_records(namespace,id,payload,updated_at) VALUES(?,?,?,?)", (namespace, identifier, dump(value), timestamp))

    async def get_record_with_version(self, namespace: str, identifier: str) -> dict | None:
        with self.lock:
            return self._get(namespace, identifier)

    async def get_record(self, namespace: str, identifier: str) -> Any:
        captured = await self.get_record_with_version(namespace, identifier)
        return captured["value"] if captured else None

    async def put(self, namespace: str, identifier: str, value: Any):
        with self.lock:
            self._put(namespace, identifier, value)

    async def compare_and_swap(self, namespace: str, identifier: str, expected_revision: str, value: Any) -> bool:
        with self.lock:
            return self.db.execute("UPDATE aegis_records SET payload=?,updated_at=? WHERE namespace=? AND id=? AND payload=? RETURNING id", (dump(value), iso_at(), namespace, identifier, expected_revision)).fetchone() is not None

    async def save_record_checked(self, namespace: str, identifier: str, value: dict, expected_updated_at=UNSET) -> bool:
        if namespace not in {"workflow", "dataset"} or not isinstance(value, dict):
            raise ValueError("저장할 내용을 확인하세요.")
        if expected_updated_at is not UNSET and expected_updated_at is not None and not isinstance(expected_updated_at, str):
            raise ValueError("저장 기준을 확인하세요.")
        with self._transaction():
            if namespace == "workflow":
                from .lifecycle import workflow_archived
                if workflow_archived(self, identifier):
                    from .errors import ApiError
                    raise ApiError("보관한 워크플로우는 복원한 뒤 수정하세요.", "workflow_archived", 409)
            old = self._get(namespace, identifier)
            if expected_updated_at is None and old:
                return False
            if isinstance(expected_updated_at, str) and (not old or old["value"].get("updatedAt", "") != expected_updated_at):
                return False
            if not old and self.db.execute("SELECT COUNT(*) FROM aegis_records WHERE namespace=?", (namespace,)).fetchone()[0] >= 30:
                return False
            clock = now_ms()
            if isinstance(expected_updated_at, str):
                try:
                    clock = max(clock, date_ms(expected_updated_at) + 1)
                except (ValueError, TypeError, OverflowError):
                    pass
            updated = iso_at(clock)
            self._put(namespace, identifier, {**value, "updatedAt": updated}, updated)
            return True

    async def put_if_unchanged(self, namespace: str, identifier: str, value: Any, checks: list[dict]) -> bool:
        with self._transaction():
            if not self._checks_match(checks):
                return False
            self._put(namespace, identifier, value)
            return True

    async def remove(self, namespace: str, identifier: str):
        with self._transaction():
            if namespace == "workflow" and self.db.execute("SELECT 1 FROM aegis_deployments WHERE workflow_id=? LIMIT 1", (identifier,)).fetchone():
                from .errors import ApiError
                raise ApiError("배포 이력이 있는 워크플로우는 삭제할 수 없습니다. 보관 기능을 사용하세요.", "deployed_workflow", 409)
            self.db.execute("DELETE FROM aegis_records WHERE namespace=? AND id=?", (namespace, identifier))
            if namespace == "workflow":
                self.db.execute("DELETE FROM aegis_records WHERE namespace='lifecycle_workflow' AND id=?", (identifier,))

    async def save_connection(self, connection: dict):
        with self._transaction():
            self._put("connection", connection["id"], connection)
            self.db.execute("DELETE FROM aegis_records WHERE namespace IN ('diagnostic','model_metric') AND id=?", (connection["id"],))

    async def save_policy_revision(self, definition: dict, connection: dict, expected_version: int, audit: dict, connection_revision: str) -> dict:
        """Freeze one validated policy bundle and its audit in one transaction."""
        from .errors import ApiError
        from .lifecycle import MAX_POLICY_VERSIONS, policy_archived, policy_version_limit
        maximum = policy_version_limit(self.env)
        if type(expected_version) is not int or not 0 <= expected_version <= MAX_POLICY_VERSIONS:
            raise ApiError("정책 저장 기준 버전을 확인하세요.")
        with self._transaction():
            if policy_archived(self, definition["id"]):
                raise ApiError("보관한 정책은 복원한 뒤 새 버전을 저장하세요.", "policy_archived", 409)
            revisions = [json.loads(row[0]) for row in self.db.execute("SELECT payload FROM aegis_records WHERE namespace='policy'")]
            latest = max((revision["version"] for revision in revisions if revision["id"] == definition["id"]), default=0)
            if latest != expected_version:
                raise ApiError("다른 화면에서 정책을 변경했습니다. 저장된 버전을 확인한 뒤 다시 저장하세요.", "stale_policy_save", 409)
            if latest >= MAX_POLICY_VERSIONS or len(revisions) >= maximum or latest == 0 and len({revision["id"] for revision in revisions}) >= 30:
                raise ApiError(f"보관한 정책을 포함해 최대 30개, 전체 버전은 최대 {maximum:,}개까지 저장할 수 있습니다. 저장한 버전은 삭제하지 않습니다. 서버의 정책 버전 한도를 확인하세요.", "policy_limit", 409)
            if not self._checks_match([{"namespace": "connection", "id": connection["id"], "revision": connection_revision}]):
                raise ApiError("저장 중 모델 연결이 변경되었습니다. 다시 확인하세요.", "connection_changed", 409)
            timestamp = iso_at()
            value = {**deepcopy(definition), "connectionSnapshot": deepcopy(connection), "version": latest + 1, "updatedAt": timestamp}
            self.db.execute("INSERT INTO aegis_records(namespace,id,payload,updated_at) VALUES('policy',?,?,?)", (f"{definition['id']}:{latest + 1}", dump(value), timestamp))
            self._put("audit", audit["id"], audit, timestamp)
            return value

    async def delete_connection(self, identifier: str):
        with self.lock:
            self.db.execute("DELETE FROM aegis_records WHERE namespace IN ('connection','diagnostic','model_metric') AND id=?", (identifier,))

    async def save_ingress(self, ingress: dict):
        with self._transaction():
            self._put("meta", "ingress", ingress)
            self.db.execute("DELETE FROM aegis_records WHERE namespace IN ('diagnostic','model_metric')")

    async def insert_evaluation_run(self, run: dict, max_running: int = 4) -> bool:
        with self._transaction():
            running = self.db.execute("SELECT COUNT(*) FROM aegis_records WHERE namespace='run' AND json_extract(payload,'$.status')='running'").fetchone()[0]
            if running >= max_running:
                return False
            self.db.execute("INSERT INTO aegis_records(namespace,id,payload,updated_at) VALUES('run',?,?,?)", (run["id"], dump(run), iso_at()))
            return True

    async def insert_mapped_dataset(self, dataset: dict, checks: list[dict], max_datasets: int = 30, latest_deployment: dict | None = None) -> bool:
        with self._transaction():
            if not self._checks_match(checks) or self.db.execute("SELECT COUNT(*) FROM aegis_records WHERE namespace='dataset'").fetchone()[0] >= max_datasets:
                return False
            if latest_deployment:
                row = self.db.execute("SELECT id FROM aegis_deployments WHERE workflow_id=? ORDER BY created_at DESC,version DESC LIMIT 1", (latest_deployment["workflowId"],)).fetchone()
                if not row or row[0] != latest_deployment["id"]:
                    return False
            self.db.execute("INSERT INTO aegis_records(namespace,id,payload,updated_at) VALUES('dataset',?,?,?)", (dataset["id"], dump(dataset), iso_at()))
            return True

    async def evaluation_worker_status(self) -> dict:
        with self.lock:
            row = self.db.execute("SELECT payload FROM aegis_records WHERE namespace='evaluation_worker' ORDER BY CASE WHEN json_extract(payload,'$.expiresAt')>? THEN 0 ELSE 1 END,updated_at DESC LIMIT 1", (now_ms(),)).fetchone()
            if not row:
                return {"available": False}
            try:
                value = json.loads(row[0])
                if not isinstance(value.get("seenAt"), str) or type(value.get("expiresAt")) not in {int, float} or value.get("kind") not in {"local", "remote"}:
                    return {"available": False}
                return {"available": value["expiresAt"] > now_ms(), "lastSeenAt": value["seenAt"], "kind": value["kind"]}
            except (ValueError, TypeError):
                return {"available": False}

    async def heartbeat_evaluation_worker(self, identifier: str, kind: str) -> dict:
        clock = now_ms()
        seen = iso_at(clock)
        with self._transaction():
            self._put("evaluation_worker", identifier, {"seenAt": seen, "expiresAt": clock + 45_000, "kind": kind})
            self.db.execute("DELETE FROM aegis_records WHERE namespace='evaluation_worker' AND json_extract(payload,'$.expiresAt')<?", (clock - 86_400_000,))
        return {"available": True, "lastSeenAt": seen, "kind": kind}

    async def background_evaluation_ids(self) -> list[str]:
        with self.lock:
            return [row[0] for row in self.db.execute("SELECT id FROM aegis_records WHERE namespace='run' AND json_extract(payload,'$.status')='running' AND json_extract(payload,'$.executionMode')='background' ORDER BY json_extract(payload,'$.createdAt') ASC LIMIT 4")]

    async def evaluation_status(self, run_id: str | None = None) -> dict:
        await self.seed()
        with self.lock:
            rows = self.db.execute("""SELECT id,json_extract(payload,'$.workflowId') AS workflowId,json_extract(payload,'$.workflowName') AS workflowName,
              json_extract(payload,'$.datasetId') AS datasetId,json_extract(payload,'$.datasetName') AS datasetName,
              json_extract(payload,'$.createdAt') AS createdAt,json_extract(payload,'$.updatedAt') AS updatedAt,
              json_extract(payload,'$.version') AS version,json_extract(payload,'$.executionMode') AS executionMode,json_extract(payload,'$.baselineVersion') AS baselineVersion,
              COALESCE(json_extract(payload,'$.status'),'completed') AS status,
              COALESCE(json_extract(payload,'$.total'),json_array_length(payload,'$.datasetSnapshot.rows'),json_array_length(payload,'$.results'),0) AS total,
              COALESCE(json_array_length(payload,'$.results'),0) AS completedCount
              FROM aegis_records WHERE namespace='run' AND (json_extract(payload,'$.status')='running' OR id IN (SELECT id FROM aegis_records WHERE namespace='run' ORDER BY updated_at DESC LIMIT 10)) ORDER BY json_extract(payload,'$.createdAt') DESC""").fetchall()
            runs = [{key: row[key] for key in row.keys() if row[key] is not None} for row in rows]
        response = {"runs": runs, "evaluationWorker": await self.evaluation_worker_status()}
        if run_id:
            run = await self.get_record("run", run_id)
            if run:
                run.pop("_lease", None)
                response["run"] = run
        return response

    async def verification_evidence(self, workflow_id: str, fingerprint: str | None = None) -> list[dict]:
        if not isinstance(workflow_id, str) or not workflow_id or len(workflow_id) > 120 or fingerprint is not None and not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
            raise ValueError("배포 검증 대상과 설정 확인값을 확인하세요.")
        retention = await self.get_record("meta", "retention") or DEFAULT_RETENTION
        count = "COALESCE(json_array_length(r.payload,'$.results'),0)"
        snapshot = "COALESCE(json_array_length(r.payload,'$.datasetSnapshot.rows'),0)"
        query = f"""WITH evidence AS (
          SELECT r.id,json_extract(r.payload,'$.datasetId') AS datasetId,COALESCE(json_extract(r.payload,'$.datasetName'),'') AS datasetName,
          COALESCE(json_extract(r.payload,'$.createdAt'),r.updated_at) AS createdAt,
          COALESCE(json_extract(r.payload,'$.fingerprint'),'') AS fingerprint,COALESCE(json_extract(r.payload,'$.datasetFingerprint'),'') AS datasetFingerprint,
          COALESCE(json_extract(r.payload,'$.total'),{snapshot}) AS total,{count} AS completedCount,
          (SELECT COUNT(*) FROM json_each(r.payload,'$.results') result WHERE json_type(result.value,'$.expectationMatched')='true') AS matchedCount,
          CASE WHEN {snapshot}>0 AND {snapshot}={count} AND COALESCE(json_extract(r.payload,'$.total'),{snapshot})={count}
            AND (SELECT COUNT(DISTINCT json_extract(result.value,'$.rowId')) FROM json_each(r.payload,'$.results') result)={snapshot}
            AND NOT EXISTS (SELECT 1 FROM json_each(r.payload,'$.datasetSnapshot.rows') expected WHERE NOT EXISTS (SELECT 1 FROM json_each(r.payload,'$.results') actual WHERE json_extract(actual.value,'$.rowId')=json_extract(expected.value,'$.id')))
            THEN 1 ELSE 0 END AS completeCoverage,
          EXISTS (SELECT 1 FROM json_each(r.payload,'$.results') result WHERE json_extract(result.value,'$.executionMode')='mock') AS mock
          FROM aegis_records r WHERE r.namespace='run' AND json_extract(r.payload,'$.workflowId')=? AND json_extract(r.payload,'$.status')='completed'
            AND COALESCE(json_extract(r.payload,'$.createdAt'),r.updated_at)>=? {"AND json_extract(r.payload,'$.fingerprint')=?" if fingerprint is not None else ""}
            AND EXISTS (SELECT 1 FROM aegis_records dataset WHERE dataset.namespace='dataset' AND dataset.id=json_extract(r.payload,'$.datasetId'))
        ), ranked AS (
          SELECT *,ROW_NUMBER() OVER (PARTITION BY datasetId ORDER BY createdAt DESC,id DESC) AS recentRank,
          ROW_NUMBER() OVER (PARTITION BY datasetId,CASE WHEN completeCoverage=1 AND matchedCount=completedCount AND mock=0 THEN 1 ELSE 0 END ORDER BY createdAt DESC,id DESC) AS outcomeRank FROM evidence
        ) SELECT id,datasetId,datasetName,createdAt,fingerprint,datasetFingerprint,total,completedCount,matchedCount,completeCoverage,mock
          FROM ranked WHERE recentRank<=3 OR (completeCoverage=1 AND matchedCount=completedCount AND mock=0 AND outcomeRank<=3) ORDER BY createdAt DESC,id DESC LIMIT 180"""
        values = [workflow_id, iso_at(now_ms() - retention["evaluationDays"] * 86_400_000)] + ([fingerprint] if fingerprint is not None else [])
        with self.lock:
            rows = self.db.execute(query, values).fetchall()
            return [{**dict(row), "completeCoverage": bool(row["completeCoverage"]), "mock": bool(row["mock"])} for row in rows]

    async def get_deployment(self, identifier: str) -> dict | None:
        with self.lock:
            return _deployment(self.db.execute("SELECT * FROM aegis_deployments WHERE id=?", (identifier,)).fetchone())

    async def active_deployment(self, alias: str) -> dict | None:
        with self.lock:
            from .lifecycle import deployment_paused
            if deployment_paused(self, alias):
                return None
            return _deployment(self.db.execute("SELECT * FROM aegis_deployments WHERE alias=? ORDER BY version DESC LIMIT 1", (alias,)).fetchone())

    async def active_model_summaries(self, allowed_models: list[str] | None = None) -> list[dict]:
        with self.lock:
            rows = self.db.execute("""SELECT d.alias,d.created_at AS createdAt FROM aegis_deployments d
              WHERE d.version=(SELECT MAX(latest.version) FROM aegis_deployments latest WHERE latest.alias=d.alias)
              AND (? IS NULL OR d.alias IN (SELECT value FROM json_each(?))) ORDER BY d.alias""", (None if allowed_models is None else 1, dump(allowed_models or []))).fetchall()
            from .lifecycle import deployment_paused
            return [dict(row) for row in rows if not deployment_paused(self, row["alias"])]

    def _deployment_for_request(self, request: dict) -> dict | None:
        saved = self._get("deployment_request", request["id"])
        if not saved:
            return None
        if saved["value"]["requestHash"] != request["requestHash"]:
            raise DeploymentRequestConflict("같은 요청 번호로 다른 배포를 요청할 수 없습니다. 새 요청 번호로 다시 시도하세요.")
        return _deployment(self.db.execute("SELECT * FROM aegis_deployments WHERE id=?", (saved["value"]["deploymentId"],)).fetchone())

    async def deployment_for_request(self, request: dict) -> dict | None:
        with self.lock:
            return self._deployment_for_request(request)

    async def get_deployment_for_request(self, workflow_id: str, version: int) -> dict | None:
        if not isinstance(workflow_id, str) or not workflow_id or len(workflow_id) > 120 or type(version) is not int or version < 1:
            raise ValueError("요청에 사용한 배포 버전을 확인하세요.")
        with self.lock:
            rows = self.db.execute("SELECT * FROM aegis_deployments WHERE workflow_id=? AND version=? ORDER BY created_at DESC,id DESC LIMIT 2", (workflow_id, version)).fetchall()
            return _deployment(rows[0]) if len(rows) == 1 else None

    async def deploy_checked(self, deployment: dict, checks: list[dict], options: dict | None = None) -> dict | None:
        options = options or {}
        with self._transaction():
            request = options.get("request")
            if request:
                previous = self._deployment_for_request(request)
                if previous:
                    return previous
            from .lifecycle import workflow_archived
            if workflow_archived(self, deployment["workflowId"]):
                from .errors import ApiError
                raise ApiError("보관한 워크플로우는 복원한 뒤 배포하세요.", "workflow_archived", 409)
            if any(c["namespace"] not in {"workflow", "connection", "run", "dataset", "meta"} for c in checks):
                raise ValueError("지원하지 않는 배포 검사 범위입니다.")
            if not self._checks_match(checks):
                return None
            if self.db.execute("SELECT 1 FROM aegis_deployments WHERE alias=? AND workflow_id<>?", (deployment["alias"], deployment["workflowId"])).fetchone():
                return None
            version = self.db.execute("SELECT COALESCE(MAX(version),0)+1 FROM aegis_deployments WHERE alias=?", (deployment["alias"],)).fetchone()[0]
            self.db.execute("INSERT INTO aegis_deployments(id,workflow_id,alias,version,payload,created_at) VALUES(?,?,?,?,?,?)", (deployment["id"], deployment["workflowId"], deployment["alias"], version, dump(deployment), deployment["createdAt"]))
            if options.get("audit"):
                audit = options["audit"]
                self._put("audit", audit["id"], audit, audit["createdAt"])
            if request:
                self._put("deployment_request", request["id"], {"requestHash": request["requestHash"], "deploymentId": deployment["id"]}, deployment["createdAt"])
            return {**deepcopy(deployment), "version": version}

    async def deploy(self, deployment: dict) -> dict:
        value = await self.deploy_checked(deployment, [])
        if value is None:
            raise RuntimeError("배포 버전 저장에 실패했습니다.")
        return value

    async def state(self, include_history: bool = True) -> dict:
        await self.seed()
        retention = await self.get_record("meta", "retention") or deepcopy(DEFAULT_RETENTION)
        if include_history:
            await self.prune_retention(retention)
        from .lifecycle import MAX_POLICY_VERSIONS, lifecycle_summary
        # Lowering the configured save capacity must not hide saved revisions.
        maximum = MAX_POLICY_VERSIONS
        base = f"namespace IN ('workflow','connection','dataset','meta','diagnostic','model_metric') OR (namespace='policy' AND id IN (SELECT id FROM aegis_records WHERE namespace='policy' ORDER BY updated_at DESC LIMIT {maximum}))"
        query = f"SELECT namespace,id,payload FROM aegis_records WHERE {base}"
        if include_history:
            query += " OR (namespace='run' AND (json_extract(payload,'$.status')='running' OR id IN (SELECT id FROM aegis_records WHERE namespace='run' ORDER BY updated_at DESC LIMIT 10))) OR (namespace='audit' AND id IN (SELECT id FROM aegis_records WHERE namespace='audit' ORDER BY updated_at DESC LIMIT 100))"
        with self.lock:
            records = self.db.execute(query).fetchall()
            by = lambda namespace: [json.loads(row["payload"]) for row in records if row["namespace"] == namespace]
            deployments = self.db.execute("SELECT * FROM aegis_deployments WHERE version=(SELECT MAX(latest.version) FROM aegis_deployments latest WHERE latest.alias=aegis_deployments.alias) OR id IN (SELECT id FROM aegis_deployments ORDER BY created_at DESC,version DESC LIMIT 100) ORDER BY created_at DESC,version DESC").fetchall()
            keys = self.db.execute("SELECT k.id,k.name,k.prefix,k.created_at,k.revoked,p.payload AS policy_payload,u.payload AS usage_payload FROM aegis_gateway_keys k LEFT JOIN aegis_records p ON p.namespace='key_policy' AND p.id=k.id LEFT JOIN aegis_records u ON u.namespace='key_usage' AND u.id=k.id ORDER BY k.created_at DESC LIMIT 100").fetchall()
            logs = self.db.execute("SELECT payload FROM aegis_request_logs ORDER BY created_at DESC LIMIT 200").fetchall() if include_history else []
            runs = sorted(by("run"), key=lambda run: run["createdAt"], reverse=True)
            for run in runs:
                run.pop("_lease", None)
            ingress_row = next((row for row in records if row["namespace"] == "meta" and row["id"] == "ingress"), None)
            state = {"workflows": by("workflow"), "connections": by("connection"), "datasets": by("dataset"), "policies": sorted(by("policy"), key=lambda item: (item["id"], -item["version"])),
                     "ingress": json.loads(ingress_row["payload"]) if ingress_row else {"enabled": False, "allowedCidrs": [], "allowedOrigins": []},
                     "runs": runs, "deployments": [_deployment(row) for row in deployments], "keys": [_key_summary(row) for row in keys],
                     "logs": [json.loads(row[0]) for row in logs],
                     "diagnostics": {row["id"]: json.loads(row["payload"]) for row in records if row["namespace"] == "diagnostic"},
                     "modelMetrics": {row["id"]: json.loads(row["payload"]) for row in records if row["namespace"] == "model_metric"},
                     "audit": sorted(by("audit"), key=lambda item: item["createdAt"], reverse=True), "retention": retention}
            state.update(lifecycle_summary(self))
        state["evaluationWorker"] = await self.evaluation_worker_status()
        return state

    async def log(self, log: dict):
        reasons = {"allow": "검사를 통과했습니다.", "block": "정책에 따라 차단했습니다.", "skipped": "실행하지 않았습니다."}
        reason = lambda status: reasons.get(status, "실행 중 오류가 발생했습니다.")
        safe = {key: log[key] for key in ["id", "source", "workflowName", "version", "createdAt", "status", "stage", "latencyMs"]}
        safe["reason"] = reason(log["status"])
        for key in ["workflowId", "keyId"]:
            if log.get(key):
                safe[key] = log[key]
        if isinstance(log.get("deploymentId"), str) and 0 < len(log["deploymentId"]) <= 120:
            safe["deploymentId"] = log["deploymentId"]
        if log.get("usage"):
            safe["usage"] = {key: log["usage"][key] for key in ["prompt_tokens", "completion_tokens", "total_tokens"]}
        if "attempts" in log:
            safe["attempts"] = [{**{key: attempt[key] for key in ["number", "status", "stage", "latencyMs"]}, "reason": reason(attempt["status"])} for attempt in log["attempts"][:4]]
        if type(log.get("regenerationCount")) is int and 0 <= log["regenerationCount"] <= 3:
            safe["regenerationCount"] = log["regenerationCount"]
        for key in ("policyDecision", "policyCode"):
            if isinstance(log.get(key), str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", log[key]):
                safe[key] = log[key]
        if log.get("policyRoute") in {"main", "respond", "error"}:
            safe["policyRoute"] = log["policyRoute"]
        if isinstance(log.get("policyPath"), list) and len(log["policyPath"]) <= 24 and all(isinstance(identifier, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", identifier) for identifier in log["policyPath"]):
            safe["policyPath"] = list(log["policyPath"])
        if isinstance(log.get("policyChecks"), list):
            safe["policyChecks"] = []
            for check in log["policyChecks"][:48]:
                if not isinstance(check, dict) or check.get("stage") not in {"pre", "post"} or check.get("status") not in {"allow", "block", "error", "skipped"}:
                    continue
                if any(not isinstance(check.get(key), str) or not 0 < len(check[key]) <= 120 for key in ("ruleId", "policyId")) or type(check.get("policyVersion")) is not int or check["policyVersion"] < 1:
                    continue
                saved = {key: check[key] for key in ("ruleId", "policyId", "policyVersion", "stage", "status")}
                if type(check.get("attempt")) is int and 1 <= check["attempt"] <= 4:
                    saved["attempt"] = check["attempt"]
                if check.get("route") in {"main", "respond", "error"}:
                    saved["route"] = check["route"]
                for key in ("decision", "policyCode"):
                    if isinstance(check.get(key), str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", check[key]):
                        saved[key] = check[key]
                if isinstance(check.get("path"), list) and len(check["path"]) <= 24 and all(isinstance(identifier, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", identifier) for identifier in check["path"]):
                    saved["path"] = list(check["path"])
                safe["policyChecks"].append(saved)
        if "traces" in log:
            safe["traces"] = []
            for trace in log["traces"]:
                saved = {key: trace[key] for key in ["ruleId", "ruleName", "stage", "groupId", "status", "latencyMs"]}
                saved["reason"] = reason(trace["status"])
                if trace.get("traceType") == "policy":
                    saved["traceType"] = "policy"
                if type(trace.get("attempt")) is int and 1 <= trace["attempt"] <= 4:
                    saved["attempt"] = trace["attempt"]
                safe["traces"].append(saved)
        if "flowTraces" in log:
            safe["flowTraces"] = []
            for trace in log["flowTraces"][:256]:
                if not isinstance(trace.get("nodeId"), str) or len(trace["nodeId"]) > 150 or trace.get("stage") not in {"pre", "post"} or trace.get("status") not in {"completed", "skipped", "block", "error"}:
                    continue
                saved = {key: trace[key] for key in ["nodeId", "stage", "status"]}
                saved["edgeIds"] = [edge for edge in trace.get("edgeIds", []) if isinstance(edge, str) and len(edge) <= 120][:4]
                if type(trace.get("attempt")) is int and 1 <= trace["attempt"] <= 4:
                    saved["attempt"] = trace["attempt"]
                safe["flowTraces"].append(saved)
        retention = await self.get_record("meta", "retention") or DEFAULT_RETENTION
        with self._transaction():
            self.db.execute("INSERT INTO aegis_request_logs(id,payload,created_at) VALUES(?,?,?)", (safe["id"], dump(safe), safe["createdAt"]))
            self.db.execute("DELETE FROM aegis_request_logs WHERE created_at<? OR id IN (SELECT id FROM aegis_request_logs ORDER BY created_at DESC LIMIT -1 OFFSET 1000)", (iso_at(now_ms() - retention["logDays"] * 86_400_000),))

    async def search_logs(self, options: dict | None = None, **kwargs) -> dict:
        options = {**(options or {}), **kwargs}
        limit = options.get("limit", 50)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("요청 기록은 한 번에 1~100건까지 조회할 수 있습니다.")
        for key, maximum in [("query", 200), ("workflowId", 120), ("keyId", 120)]:
            if options.get(key) is not None and (not isinstance(options[key], str) or len(options[key]) > maximum):
                raise ValueError("요청 기록 검색 조건을 확인하세요.")
        if options.get("status") is not None and options["status"] not in {"allow", "block", "error"}:
            raise ValueError("요청 기록의 판정을 확인하세요.")
        if options.get("source") is not None and options["source"] not in {"playground", "evaluation", "gateway"}:
            raise ValueError("요청 기록의 호출 구분을 확인하세요.")
        try:
            start = iso_at(date_ms(options["from"])) if options.get("from") is not None else None
            end = iso_at(date_ms(options["to"])) if options.get("to") is not None else None
        except (ValueError, TypeError, OverflowError) as error:
            raise ValueError("요청 기록의 조회 기간을 확인하세요.") from error
        if start and end and start >= end:
            raise ValueError("조회 종료 시각은 시작 시각보다 뒤여야 합니다.")
        retention = await self.get_record("meta", "retention") or DEFAULT_RETENTION
        conditions = ["created_at>=?"]
        values = [iso_at(now_ms() - retention["logDays"] * 86_400_000)]
        query = options.get("query", "").strip()
        if query:
            conditions.append("(instr(lower(id),lower(?))>0 OR instr(lower(COALESCE(json_extract(payload,'$.workflowName'),'')),lower(?))>0 OR instr(lower(COALESCE(json_extract(payload,'$.reason'),'')),lower(?))>0)")
            values.extend([query] * 3)
        for field in ["workflowId", "keyId", "status", "source"]:
            if options.get(field) is not None:
                conditions.append(f"json_extract(payload,'$.{field}')=?")
                values.append(options[field])
        if start:
            conditions.append("created_at>=?")
            values.append(start)
        if end:
            conditions.append("created_at<?")
            values.append(end)
        with self.lock:
            total = self.db.execute(f"SELECT COUNT(*) FROM aegis_request_logs WHERE {' AND '.join(conditions)}", values).fetchone()[0]
            if options.get("cursor") is not None:
                created, identifier = self._read_cursor(options["cursor"])
                conditions.append("(created_at<? OR (created_at=? AND id<?))")
                values.extend([created, created, identifier])
            rows = self.db.execute(f"SELECT id,created_at,payload FROM aegis_request_logs WHERE {' AND '.join(conditions)} ORDER BY created_at DESC,id DESC LIMIT ?", values + [limit + 1]).fetchall()
        visible = rows[:limit]
        page = {"logs": [json.loads(row["payload"]) for row in visible], "total": total, "retention": {"days": retention["logDays"], "maxRecords": 1000}}
        if len(rows) > limit and visible:
            page["nextCursor"] = base64.urlsafe_b64encode(dump([visible[-1]["created_at"], visible[-1]["id"]]).encode()).decode().rstrip("=")
        return page

    @staticmethod
    def _read_cursor(cursor: str) -> list[str]:
        try:
            if not isinstance(cursor, str) or len(cursor) > 2048 or not re.fullmatch(r"[-_a-zA-Z0-9]+", cursor):
                raise ValueError()
            value = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode("utf-8"))
            if not isinstance(value, list) or len(value) != 2 or not isinstance(value[0], str) or iso_at(date_ms(value[0])) != value[0] or not isinstance(value[1], str) or not 0 < len(value[1]) <= 120:
                raise ValueError()
            return value
        except (ValueError, TypeError, UnicodeDecodeError, OverflowError) as error:
            raise ValueError("요청 기록의 페이지 위치를 확인하세요.") from error

    async def get_request_log(self, identifier: str) -> dict | None:
        if not isinstance(identifier, str) or not identifier or len(identifier) > 120:
            raise ValueError("요청 ID를 확인하세요.")
        retention = await self.get_record("meta", "retention") or DEFAULT_RETENTION
        with self.lock:
            row = self.db.execute("SELECT payload FROM aegis_request_logs WHERE id=? AND created_at>=?", (identifier, iso_at(now_ms() - retention["logDays"] * 86_400_000))).fetchone()
            return json.loads(row[0]) if row else None

    async def audit(self, event: dict):
        await self.put("audit", event["id"], event)

    async def prune_retention(self, retention: dict):
        clock = now_ms()
        with self._transaction():
            self.db.execute("DELETE FROM aegis_request_logs WHERE created_at<?", (iso_at(clock - retention["logDays"] * 86_400_000),))
            self.db.execute("DELETE FROM aegis_records WHERE namespace='run' AND COALESCE(json_extract(payload,'$.status'),'completed')!='running' AND COALESCE(json_extract(payload,'$.createdAt'),updated_at)<?", (iso_at(clock - retention["evaluationDays"] * 86_400_000),))
            self.db.execute("DELETE FROM aegis_records WHERE namespace='audit' AND updated_at<?", (iso_at(clock - retention["auditDays"] * 86_400_000),))

    async def create_key(self, name: str, policy: dict | None = None) -> dict:
        key = "ag_" + secrets.token_hex(32)
        summary = {"id": str(uuid.uuid4()), "name": name, "prefix": key[:11], "createdAt": iso_at(), "revoked": False}
        if policy is not None:
            summary["policy"] = deepcopy(policy)
        with self._transaction():
            self.db.execute("INSERT INTO aegis_gateway_keys(id,name,prefix,hash,created_at,revoked) VALUES(?,?,?,?,?,0)", (summary["id"], name, summary["prefix"], hashlib.sha256(key.encode()).hexdigest(), summary["createdAt"]))
            if policy is not None:
                self._put("key_policy", summary["id"], policy)
        return {"key": key, "summary": summary}

    async def update_key_policy(self, identifier: str, policy: dict):
        await self.put("key_policy", identifier, policy)

    async def revoke_key(self, identifier: str):
        with self.lock:
            self.db.execute("UPDATE aegis_gateway_keys SET revoked=1 WHERE id=?", (identifier,))

    async def authenticate(self, key: str) -> dict | None:
        with self.lock:
            row = self.db.execute("SELECT k.id,k.name,k.prefix,k.created_at,k.revoked,p.payload AS policy_payload FROM aegis_gateway_keys k LEFT JOIN aegis_records p ON p.namespace='key_policy' AND p.id=k.id WHERE k.hash=? AND k.revoked=0", (hashlib.sha256(key.encode()).hexdigest(),)).fetchone()
            return _key_summary(row) if row else None

    async def authorized(self, key: str) -> bool:
        return await self.authenticate(key) is not None

    async def reserve_quota(self, key: dict, reserved_tokens: int, lease_ms: int) -> dict:
        clock, lease_id = now_ms(), str(uuid.uuid4())
        window = clock // 60_000
        policy = key.get("policy") or {}
        with self._transaction():
            captured = self._get("key_usage", key["id"])
            usage = captured["value"] if captured else {"window": 0, "requests": 0, "tokens": 0, "leases": {}}
            leases = {identifier: expiry for identifier, expiry in usage.get("leases", {}).items() if expiry > clock}
            requests = usage.get("requests", 0) if usage.get("window") == window else 0
            tokens = usage.get("tokens", 0) if usage.get("window") == window else 0
            if policy.get("maxConcurrent") and len(leases) >= policy["maxConcurrent"]:
                return {"denied": "concurrency_limit"}
            if policy.get("rpmLimit") and requests >= policy["rpmLimit"]:
                return {"denied": "rpm_limit"}
            if policy.get("tpmLimit") and tokens + reserved_tokens > policy["tpmLimit"]:
                return {"denied": "tpm_limit"}
            leases[lease_id] = clock + lease_ms
            self._put("key_usage", key["id"], {"window": window, "requests": requests + 1, "tokens": tokens + reserved_tokens, "leases": leases})
        return {"reservation": {"keyId": key["id"], "leaseId": lease_id, "window": window, "reservedTokens": reserved_tokens}}

    async def release_quota(self, reservation: dict, actual_tokens: int | float):
        with self._transaction():
            captured = self._get("key_usage", reservation["keyId"])
            if not captured:
                return
            usage = captured["value"]
            if reservation["leaseId"] not in usage.get("leases", {}):
                return
            usage["leases"].pop(reservation["leaseId"])
            if usage.get("window") == reservation["window"]:
                usage["tokens"] = max(0, usage.get("tokens", 0) - reservation["reservedTokens"] + max(0, math.ceil(actual_tokens)))
            self._put("key_usage", reservation["keyId"], usage)

    async def acquire_model_capacity(self, connection_id: str, limit: int, lease_ms: int) -> dict:
        if type(limit) is not int or not 1 <= limit <= 1000 or type(lease_ms) is not int or lease_ms <= 0:
            raise ModelCapacityError("서버의 모델 동시 호출 한도 설정을 확인하세요.")
        try:
            with self._transaction():
                clock, lease_id = now_ms(), str(uuid.uuid4())
                captured = self._get("model_capacity", connection_id)
                old = captured["value"] if captured else {"leases": {}}
                leases = {identifier: expiry for identifier, expiry in old.get("leases", {}).items() if expiry > clock}
                if len(leases) >= limit:
                    raise ModelCapacityError("모델 서버의 동시 호출 한도에 도달했습니다. 진행 중인 요청이 끝난 뒤 다시 실행하세요.")
                leases[lease_id] = clock + lease_ms
                self._put("model_capacity", connection_id, {"leases": leases})
                return {"connectionId": connection_id, "leaseId": lease_id}
        except ModelCapacityError:
            raise
        except Exception as error:
            raise ModelCapacityError("모델 호출 수를 확인하지 못해 실행을 중단했습니다. 서버 저장소 상태를 확인하세요.") from error

    async def release_model_capacity(self, lease: dict):
        try:
            with self._transaction():
                captured = self._get("model_capacity", lease["connectionId"])
                if captured:
                    old = captured["value"]
                    if lease["leaseId"] in old.get("leases", {}):
                        old["leases"].pop(lease["leaseId"])
                        self._put("model_capacity", lease["connectionId"], old)
        except Exception as error:
            raise ModelCapacityError("모델 호출 종료를 저장하지 못했습니다. 서버 저장소 상태를 확인하세요.") from error
