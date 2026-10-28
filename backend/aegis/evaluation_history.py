"""Bounded discovery of retained evaluation runs without loading result payloads."""
from __future__ import annotations

import base64
import json

from .store import DEFAULT_RETENTION, Store, date_ms, dump, iso_at, now_ms


async def evaluation_history(store: Store, options: dict | None = None, run_id: str | None = None) -> dict:
    options = options or {}
    limit = options.get("limit", 20)
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("검증 기록은 한 번에 1~100건까지 조회할 수 있습니다.")
    for field, maximum in (("query", 160), ("workflowId", 120), ("datasetId", 120)):
        if field in options and (not isinstance(options[field], str) or len(options[field]) > maximum):
            raise ValueError("검증 기록의 검색 조건을 확인하세요.")
    if options.get("status") is not None and options["status"] not in {"running", "completed", "cancelled", "error"}:
        raise ValueError("검증 기록의 실행 상태를 확인하세요.")
    if run_id is not None and (not isinstance(run_id, str) or not 0 < len(run_id) <= 120):
        raise ValueError("검증 실행 ID를 확인하세요.")
    try:
        start = iso_at(date_ms(options["from"])) if "from" in options else None
        end = iso_at(date_ms(options["to"])) if "to" in options else None
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError("검증 기록의 조회 기간을 확인하세요.") from exc
    if start and end and start >= end:
        raise ValueError("조회 종료 시각은 시작 시각보다 뒤여야 합니다.")
    await store.seed()
    retention = await store.get_record("meta", "retention") or DEFAULT_RETENTION
    cutoff = iso_at(now_ms() - retention["evaluationDays"] * 86_400_000)
    created = "strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(json_extract(payload,'$.createdAt'),updated_at))"
    status = "COALESCE(json_extract(payload,'$.status'),'completed')"
    conditions = ["namespace='run'", f"({status}='running' OR {created}>=?)"]
    values: list = [cutoff]
    if query := options.get("query", "").strip():
        conditions.append("(" + " OR ".join(f"instr(lower({field}),lower(?))>0" for field in ("id", "COALESCE(json_extract(payload,'$.workflowName'),'')", "COALESCE(json_extract(payload,'$.datasetName'),'')")) + ")")
        values += [query] * 3
    for field in ("workflowId", "datasetId", "status"):
        if field in options:
            expression = status if field == "status" else f"json_extract(payload,'$.{field}')"
            conditions.append(f"{expression}=?")
            values.append(options[field])
    if start:
        conditions.append(f"{created}>=?")
        values.append(start)
    if end:
        conditions.append(f"{created}<?")
        values.append(end)
    with store.lock:
        total = store.db.execute(f"SELECT COUNT(*) FROM aegis_records WHERE {' AND '.join(conditions)}", values).fetchone()[0]
        if "cursor" in options:
            position, identifier = Store._read_cursor(options["cursor"])
            conditions.append(f"({created}<? OR ({created}=? AND id<?))")
            values += [position, position, identifier]
        # Select scalar metadata only. No result, prompt, connection, or lease is in a summary.
        fields = ("workflowId", "workflowName", "datasetId", "datasetName", "updatedAt", "version", "executionMode", "baselineVersion")
        projection = ",".join(f"json_extract(payload,'$.{field}') AS {field}" for field in fields)
        rows = store.db.execute(f"""SELECT id,{projection},{created} AS createdAt,{status} AS status,
          COALESCE(json_extract(payload,'$.total'),json_array_length(payload,'$.datasetSnapshot.rows'),json_array_length(payload,'$.results'),0) AS total,
          COALESCE(json_array_length(payload,'$.results'),0) AS completedCount
          FROM aegis_records WHERE {' AND '.join(conditions)} ORDER BY {created} DESC,id DESC LIMIT ?""", values + [limit + 1]).fetchall()
    visible = rows[:limit]
    reply = {"runs": [{key: row[key] for key in row.keys() if row[key] is not None} for row in visible],
             "total": total, "retention": {"days": retention["evaluationDays"]}, "evaluationWorker": await store.evaluation_worker_status()}
    if len(rows) > limit and visible:
        reply["nextCursor"] = base64.urlsafe_b64encode(dump([visible[-1]["createdAt"], visible[-1]["id"]]).encode()).decode().rstrip("=")
    if run_id:
        with store.lock:
            captured = store.db.execute(f"SELECT payload FROM aegis_records WHERE namespace='run' AND id=? AND ({status}='running' OR {created}>=?)", (run_id, cutoff)).fetchone()
        if captured:
            run = json.loads(captured[0])
            run.pop("_lease", None)
            reply["run"] = run
    return reply
