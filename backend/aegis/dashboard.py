"""Read-only dashboard aggregates over retained, explicitly selected metadata.

Do not use ``Store.state()`` here: it returns only 200 logs and ten recent runs,
and includes evaluation inputs and outputs that dashboard users do not need.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
import json
import math
from typing import Any

from .errors import ApiError
from .store import DEFAULT_RETENTION, iso_at, now_ms

KST = timezone(timedelta(hours=9), "Asia/Seoul")
LOG_LIMIT = 1000
ROW_LIMIT = 100
DAY_MS = 86_400_000


def _date(value: str, name: str) -> int:
    try:
        if not isinstance(value, str) or len(value) > 40 or "T" not in value:
            raise ValueError()
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError()
        return int(parsed.timestamp() * 1000)
    except (ValueError, TypeError, OverflowError, OSError) as exc:
        raise ApiError(f"대시보드 {name} 시각은 시간대를 포함한 ISO 날짜로 보내세요.", "invalid_dashboard_query") from exc


def _number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def _rate(count: int, total: int) -> float | None:
    return round(count * 100 / total, 2) if total else None


def _column(key: str, label: str, kind: str = "number", unit: str | None = "count") -> dict:
    return {"key": key, "label": label, "type": kind, **({"unit": unit} if unit else {})}


def _dataset(label: str, columns: list[dict], rows: list[dict], description: str) -> dict:
    return {"label": label, "columns": columns, "rows": rows[:ROW_LIMIT], "totalRows": len(rows),
            "truncated": len(rows) > ROW_LIMIT, "description": description}


def _metrics(logs: list[dict]) -> dict:
    latencies = sorted(log["latencyMs"] for log in logs if _number(log["latencyMs"]))
    usage = [log["totalTokens"] for log in logs if _number(log["totalTokens"]) and log["usageType"] in {"integer", "real"}]
    counts = {status: sum(log["status"] == status for log in logs) for status in ("allow", "block", "error")}
    return {"requestCount": len(logs), **{status + "Count": count for status, count in counts.items()},
            "blockRate": _rate(counts["block"], len(logs)), "errorRate": _rate(counts["error"], len(logs)),
            "avgLatencyMs": round(sum(latencies) / len(latencies), 2) if latencies else None,
            "p95LatencyMs": latencies[math.ceil(len(latencies) * .95) - 1] if latencies else None,
            "regenerationCount": sum(log["regenerationCount"] for log in logs if type(log["regenerationCount"]) is int and 0 <= log["regenerationCount"] <= 3),
            "totalTokens": sum(usage) if usage or not logs else None}


async def aggregate_dashboard(store: Any, options: dict | None = None) -> dict:
    options = options or {}
    clock = now_ms()
    end = _date(options["to"], "종료") if "to" in options else clock
    start = _date(options["from"], "시작") if "from" in options else end - 7 * DAY_MS
    if not 0 < end - start <= 90 * DAY_MS:
        raise ApiError("대시보드 조회 기간은 시작 이후 최대 90일로 지정하세요.", "invalid_dashboard_query")
    source = options.get("source", "gateway")
    workflow_id = options.get("workflowId")
    status_filter = options.get("status")
    if source not in {"gateway", "evaluation", "playground", "all"} or workflow_id is not None and (not isinstance(workflow_id, str) or not workflow_id.strip() or len(workflow_id) > 120):
        raise ApiError("대시보드 호출 구분이나 워크플로우를 확인하세요.", "invalid_dashboard_query")
    if status_filter is not None and status_filter not in {"allow", "block", "error"}:
        raise ApiError("대시보드 요청 판정은 allow, block 또는 error로 지정하세요.", "invalid_dashboard_query")

    # Every query projects only fields used by the dashboard. In particular, run
    # snapshots/results and deployment connections never leave the database.
    with store.lock:
        row = store.db.execute("SELECT payload FROM aegis_records WHERE namespace='meta' AND id='retention'").fetchone()
        retention = {**DEFAULT_RETENTION, **(json.loads(row[0]) if row else {})}
        log_days, evaluation_days = retention["logDays"], retention["evaluationDays"]
        logs = [dict(row) for row in store.db.execute("""SELECT created_at AS createdAt,
          json_extract(payload,'$.source') AS source,json_extract(payload,'$.workflowId') AS workflowId,
          json_extract(payload,'$.workflowName') AS workflowName,json_extract(payload,'$.status') AS status,
          json_extract(payload,'$.latencyMs') AS latencyMs,json_extract(payload,'$.regenerationCount') AS regenerationCount,
          json_extract(payload,'$.usage.total_tokens') AS totalTokens,json_type(payload,'$.usage.total_tokens') AS usageType
          FROM aegis_request_logs WHERE created_at>=? ORDER BY created_at DESC,id DESC LIMIT ?""",
          (iso_at(clock - log_days * DAY_MS), LOG_LIMIT)).fetchall()]
        runs = [dict(row) for row in store.db.execute("""SELECT id AS runId,
          json_extract(payload,'$.workflowId') AS workflowId,json_extract(payload,'$.workflowName') AS workflowName,
          json_extract(payload,'$.datasetName') AS datasetName,COALESCE(json_extract(payload,'$.createdAt'),updated_at) AS createdAt,
          COALESCE(json_extract(payload,'$.status'),'completed') AS status,
          COALESCE(json_extract(payload,'$.total'),json_array_length(payload,'$.datasetSnapshot.rows'),json_array_length(payload,'$.results'),0) AS total,
          COALESCE(json_array_length(payload,'$.results'),0) AS completed,
          (SELECT COUNT(*) FROM json_each(payload,'$.results') result WHERE json_type(result.value,'$.expectationMatched')='true') AS matched,
          (SELECT COUNT(*) FROM json_each(payload,'$.results') result WHERE json_type(result.value,'$.expectationMatched') IN ('true','false')) AS comparable
          FROM aegis_records WHERE namespace='run' AND (json_extract(payload,'$.status')='running' OR COALESCE(json_extract(payload,'$.createdAt'),updated_at)>=?)
          ORDER BY createdAt DESC,id DESC""", (iso_at(clock - evaluation_days * DAY_MS),)).fetchall()]
        deployments = [dict(row) for row in store.db.execute("""SELECT d.id AS deploymentId,d.workflow_id AS workflowId,
          json_extract(d.payload,'$.workflow.name') AS workflowName,d.alias,d.version,d.created_at AS createdAt,
          json_extract(d.payload,'$.engineVersion') AS engineVersion FROM aegis_deployments d
          WHERE d.version=(SELECT MAX(latest.version) FROM aegis_deployments latest WHERE latest.alias=d.alias)
          ORDER BY d.alias,d.id""").fetchall()]
        known = {row[0] for row in store.db.execute("SELECT id FROM aegis_records WHERE namespace='workflow'")}
    if workflow_id is not None and workflow_id not in known | {row["workflowId"] for row in logs + runs + deployments}:
        raise ApiError("조회할 워크플로우를 찾을 수 없습니다.", "invalid_dashboard_query")

    def in_period(value: str) -> bool:
        try:
            return start <= _date(value, "기록") < end
        except ApiError:
            return False

    selected = [log for log in logs if in_period(log["createdAt"]) and (source == "all" or log["source"] == source) and (workflow_id is None or log["workflowId"] == workflow_id) and (status_filter is None or log["status"] == status_filter)]
    runs = [run for run in runs if in_period(run["createdAt"]) and (workflow_id is None or run["workflowId"] == workflow_id)]
    deployments = [deployment for deployment in deployments if workflow_id is None or deployment["workflowId"] == workflow_id]
    summary = _metrics(selected)
    matched, comparable = sum(run["matched"] for run in runs), sum(run["comparable"] for run in runs)
    summary.update(matchedCount=matched, evaluatedCount=comparable, matchRate=_rate(matched, comparable), deploymentCount=len(deployments))

    hourly = end - start <= 2 * DAY_MS
    step = timedelta(hours=1) if hourly else timedelta(days=1)
    bucket = datetime.fromtimestamp(start / 1000, KST).replace(minute=0, second=0, microsecond=0)
    if not hourly:
        bucket = bucket.replace(hour=0)
    grouped = defaultdict(list)
    for log in selected:
        timestamp = datetime.fromisoformat(log["createdAt"].replace("Z", "+00:00")).astimezone(KST)
        timestamp = timestamp.replace(minute=0, second=0, microsecond=0)
        if not hourly:
            timestamp = timestamp.replace(hour=0)
        grouped[timestamp].append(log)
    trend = []
    while bucket.timestamp() * 1000 < end:
        metrics = _metrics(grouped[bucket])
        trend.append({"bucket": bucket.isoformat(timespec="seconds"), "bucketLabel": bucket.strftime("%m-%d %H:00" if hourly else "%m-%d"),
                      "requests": metrics["requestCount"], **{status: metrics[status + "Count"] for status in ("allow", "block", "error")}, "avgLatencyMs": metrics["avgLatencyMs"]})
        bucket += step
    workflows = defaultdict(list)
    for log in selected:
        workflows[log["workflowId"] or ""].append(log)
    workflow_rows = []
    for selected_id, grouped_logs in workflows.items():
        metrics = _metrics(grouped_logs)
        workflow_rows.append({"workflowId": selected_id or None, "workflowName": grouped_logs[0]["workflowName"] or "알 수 없는 워크플로우", "requests": metrics["requestCount"],
                              **{status: metrics[status + "Count"] for status in ("allow", "block", "error")},
                              **{key: metrics[key] for key in ("blockRate", "avgLatencyMs", "regenerationCount", "totalTokens")}})
    workflow_rows.sort(key=lambda row: (-row["requests"], row["workflowName"], row["workflowId"] or ""))
    evaluation_rows = [{key: run[key] for key in ("runId", "workflowId", "workflowName", "datasetName", "createdAt", "status", "total", "completed", "matched")} | {"matchRate": _rate(run["matched"], run["comparable"])} for run in runs]
    deployment_rows = [dict(row) for row in deployments]
    missing_usage = sum(not (_number(log["totalTokens"]) and log["usageType"] in {"integer", "real"}) for log in selected)
    notes = ["요청 지표는 보관된 실행 기록 기준입니다. 인증 실패와 실행 전 거부를 포함한 전체 HTTP 요청 통계가 아닙니다.",
             "호출 구분과 요청 판정 필터는 요청 지표에만 적용합니다.",
             "검증 지표는 조회 기간과 워크플로우에 해당하는 검증 결과의 기대 판정 비교 기준이며 호출 구분과 요청 판정 필터를 적용하지 않습니다. 비교 기준이 없는 행과 비교 실행의 기준 버전 결과는 제외합니다.",
             "배포 지표는 현재 별칭별 최신 배포이며 조회 기간, 호출 구분과 요청 판정 필터를 적용하지 않습니다.",
             "토큰은 응답 생성과 추가 재작성의 알려진 usage 합계이며 검사 모델 비용을 포함하지 않습니다. 재작성은 요청 수에 중복 가산하지 않습니다."]
    if missing_usage:
        notes.append(f"선택한 요청 {missing_usage}건에 토큰 usage가 없어 토큰 합계가 불완전합니다.")
    if start < clock - log_days * DAY_MS:
        notes.append(f"조회 기간이 요청 보관 기간 {log_days}일보다 깁니다. 보관 기간 이전의 요청은 집계하지 않습니다.")
    if len(logs) >= LOG_LIMIT:
        notes.append("요청 기록 보관 한도 1,000건에 도달했습니다. 선택 기간의 이전 기록이 누락되었을 수 있습니다.")
    summary_columns = [_column(key, label, unit=unit) for key, label, unit in [
        ("requestCount", "처리 요청 수", "count"), ("allowCount", "허용 수", "count"), ("blockCount", "차단 수", "count"), ("errorCount", "실행 오류 수", "count"),
        ("blockRate", "차단률", "percent"), ("errorRate", "실행 오류율", "percent"), ("avgLatencyMs", "평균 실행 시간", "ms"), ("p95LatencyMs", "P95 실행 시간", "ms"),
        ("regenerationCount", "추가 재작성 수", "count"), ("totalTokens", "알려진 토큰 합계", "tokens"), ("matchedCount", "기대 판정 일치 수", "count"),
        ("evaluatedCount", "기대 판정 비교 수", "count"), ("matchRate", "기대 판정 일치율", "percent"), ("deploymentCount", "현재 배포 수", "count")]]
    statuses = [{"label": label, "status": status, "count": summary[status + "Count"]} for status, label in [("allow", "허용"), ("block", "차단"), ("error", "실행 오류")]]
    other = len(selected) - sum(row["count"] for row in statuses)
    if other:
        statuses.append({"label": "기타", "status": "other", "count": other})
    return {"generatedAt": iso_at(clock), "filters": {"from": iso_at(start), "to": iso_at(end), "workflowId": workflow_id, "source": source, "status": status_filter, "timezone": "Asia/Seoul"},
            "coverage": {"logDays": log_days, "logLimit": LOG_LIMIT, "storedLogCount": len(logs), "matchedLogCount": len(selected),
                         "oldestLogAt": logs[-1]["createdAt"] if logs else None, "newestLogAt": logs[0]["createdAt"] if logs else None,
                         "capacityReached": len(logs) >= LOG_LIMIT, "missingUsageCount": missing_usage, "notes": notes},
            "datasets": {
                "summary": _dataset("운영 요약", summary_columns, [summary], "요청은 선택한 호출 구분과 요청 판정 기준, 검증은 기간 내 비교 가능한 결과 기준, 배포는 현재 상태 기준입니다."),
                "requestTrend": _dataset("시간대별 요청 추이", [_column("bucket", "시각", "datetime", None), _column("bucketLabel", "시간대", "string", None)] + [_column(key, label) for key, label in [("requests", "요청"), ("allow", "허용"), ("block", "차단"), ("error", "실행 오류")]] + [_column("avgLatencyMs", "평균 실행 시간", unit="ms")], trend, "한국 시간 기준으로 2일 이하는 시간별, 그 외는 일별 집계합니다. 요청이 없는 시간대도 표시합니다."),
                "requestStatus": _dataset("요청 판정 분포", [_column("label", "판정", "string", None), _column("status", "판정 코드", "string", None), _column("count", "요청 수")], statuses, "정책 차단과 실행 오류를 구분한 보관 요청의 판정입니다."),
                "workflowRequests": _dataset("워크플로우별 요청", [_column("workflowId", "워크플로우 ID", "string", None), _column("workflowName", "워크플로우", "string", None)] + [_column(key, label) for key, label in [("requests", "요청"), ("allow", "허용"), ("block", "차단"), ("error", "실행 오류")]] + [_column("blockRate", "차단률", unit="percent"), _column("avgLatencyMs", "평균 실행 시간", unit="ms"), _column("regenerationCount", "추가 재작성 수"), _column("totalTokens", "알려진 토큰 합계", unit="tokens")], workflow_rows, "워크플로우 ID별 집계입니다. 토큰은 usage가 있는 요청의 합계이며 재작성 호출을 요청 수에 중복 가산하지 않습니다."),
                "evaluations": _dataset("검증 실행 결과", [_column(key, label, "string", None) for key, label in [("runId", "검증 ID"), ("workflowId", "워크플로우 ID"), ("workflowName", "워크플로우"), ("datasetName", "데이터셋")]] + [_column("createdAt", "실행 시각", "datetime", None), _column("status", "상태", "string", None)] + [_column(key, label) for key, label in [("total", "전체 행"), ("completed", "완료 행"), ("matched", "기대 판정 일치 행")]] + [_column("matchRate", "기대 판정 일치율", unit="percent")], evaluation_rows, f"기간 내 보관 검증의 요약이며 완료 검증 보관 기간은 {evaluation_days}일입니다. 호출 구분과 요청 판정 필터와 독립적이며 일치율 분모는 기대 판정을 비교할 수 있는 행만 포함합니다. 원문과 답변은 제공하지 않습니다."),
                "deployments": _dataset("현재 배포 현황", [_column(key, label, "string", None) for key, label in [("deploymentId", "배포 ID"), ("workflowId", "워크플로우 ID"), ("workflowName", "워크플로우"), ("alias", "모델 별칭")]] + [_column("version", "버전"), _column("createdAt", "배포 시각", "datetime", None), _column("engineVersion", "엔진 버전", "string", None)], deployment_rows, "현재 별칭별 최신 배포입니다. 워크플로우 필터만 적용하며 조회 기간, 호출 구분과 요청 판정 필터는 적용하지 않습니다.")}}
