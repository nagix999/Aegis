"""Dashboard aggregates must use retained metadata, never browser history/raw data."""
import base64
from datetime import datetime
import json

import httpx
import pytest
from fastapi import FastAPI

from aegis.api import create_router
from aegis.dashboard import aggregate_dashboard
from aegis.store import Store, dump, iso_at


CLOCK = int(datetime.fromisoformat("2026-10-26T03:00:00+00:00").timestamp() * 1000)
DAY = 86_400_000
SECRET = "PRIVATE-INPUT-OUTPUT-REASON-KEY-SENTINEL"


@pytest.fixture
async def fixture(monkeypatch):
    monkeypatch.setattr("aegis.dashboard.now_ms", lambda: CLOCK)
    store = Store()
    await store.seed()
    env = {"ADMIN_USER": "dashboard-reader", "ADMIN_PASSWORD": "fixture-password", "AEGIS_ROLE_MAP": {"dashboard-reader": "viewer"}}
    app = FastAPI()
    app.include_router(create_router(store, env))
    headers = {"Authorization": "Basic " + base64.b64encode(b"dashboard-reader:fixture-password").decode()}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 45000)), base_url="http://test", headers=headers) as client:
        yield client, store, env
    await store.close()


def log(store, identifier, *, age=1, source="gateway", workflow="wf-a", name="동일 이름", status="allow", latency=10, usage=None, **extra):
    value = {"id": identifier, "createdAt": iso_at(CLOCK - age), "source": source, "workflowId": workflow,
             "workflowName": name, "status": status, "latencyMs": latency, **extra}
    if usage is not None:
        value["usage"] = {"prompt_tokens": 0, "completion_tokens": usage, "total_tokens": usage}
    store.db.execute("INSERT INTO aegis_request_logs VALUES(?,?,?)", (identifier, dump(value), value["createdAt"]))


async def dashboard(client, **params):
    response = await client.get("/api/console", params={"view": "dashboard", **params})
    assert response.status_code == 200, response.text
    return response.json()


def summary(response):
    return response["datasets"]["summary"]["rows"][0]


async def test_viewer_aggregates_more_than_console_200_and_defaults_to_gateway(fixture, monkeypatch):
    client, store, _ = fixture
    for number in range(275):
        log(store, str(number), age=1000 + number, source="gateway" if number < 250 else "evaluation", usage=2)

    async def forbidden(*args, **kwargs):
        raise AssertionError("dashboard must not use console state or its 200-row limit")

    monkeypatch.setattr(store, "state", forbidden)
    result = await dashboard(client)
    assert summary(result)["requestCount"] == 250
    assert summary(result)["totalTokens"] == 500
    assert result["filters"]["source"] == "gateway"
    assert result["filters"]["status"] is None
    assert result["coverage"]["storedLogCount"] == 275
    assert result["coverage"]["matchedLogCount"] == 250
    assert not result["coverage"]["capacityReached"]
    assert summary(await dashboard(client, source="all"))["requestCount"] == 275
    assert summary(await dashboard(client, source="evaluation"))["requestCount"] == 25
    assert summary(await dashboard(client, source="playground"))["requestCount"] == 0


async def test_workflow_identity_period_source_and_exclusive_end(fixture):
    client, store, _ = fixture
    log(store, "included", age=2000, workflow="wf-a", status="block", usage=7)
    log(store, "different-id-same-name", age=2000, workflow="wf-b", status="error", usage=9)
    log(store, "different-source", age=2000, workflow="wf-a", source="playground")
    log(store, "before-start", age=4000, workflow="wf-a")
    log(store, "at-exclusive-end", age=1000, workflow="wf-a")
    params = {"from": iso_at(CLOCK - 3000), "to": iso_at(CLOCK - 1000)}
    result = await dashboard(client, **params)
    assert summary(result)["requestCount"] == 2
    assert len(result["datasets"]["workflowRequests"]["rows"]) == 2
    filtered = await dashboard(client, workflowId="wf-a", **params)
    assert summary(filtered)["requestCount"] == 1
    assert summary(filtered)["blockRate"] == 100
    assert filtered["datasets"]["workflowRequests"]["rows"][0]["workflowId"] == "wf-a"


@pytest.mark.parametrize("status, tokens, latency", [("allow", 2, 10), ("block", 5, 20), ("error", 7, 30)])
async def test_status_drilldown_filters_all_request_aggregates_with_existing_filters(fixture, status, tokens, latency):
    client, store, _ = fixture
    for verdict, usage, duration in [("allow", 2, 10), ("block", 5, 20), ("error", 7, 30)]:
        log(store, verdict, age=2000, status=verdict, usage=usage, latency=duration,
            input=SECRET, output=SECRET, reason=SECRET)
        log(store, f"other-workflow-{verdict}", age=2000, status=verdict, workflow="wf-b", usage=100)
        log(store, f"other-source-{verdict}", age=2000, status=verdict, source="playground", usage=100)
        log(store, f"outside-period-{verdict}", age=4000, status=verdict, usage=100)
    result = await dashboard(client, workflowId="wf-a", status=status,
                             **{"from": iso_at(CLOCK - 3000), "to": iso_at(CLOCK - 1000)})
    assert result["filters"]["status"] == status
    assert result["filters"]["workflowId"] == "wf-a"
    assert result["coverage"]["storedLogCount"] == 12
    assert result["coverage"]["matchedLogCount"] == 1
    metrics = summary(result)
    assert metrics["requestCount"] == 1
    assert metrics["totalTokens"] == tokens
    assert metrics["avgLatencyMs"] == metrics["p95LatencyMs"] == latency
    assert metrics["blockRate"] == (100 if status == "block" else 0)
    assert metrics["errorRate"] == (100 if status == "error" else 0)
    assert {row["status"]: row["count"] for row in result["datasets"]["requestStatus"]["rows"]} == {
        verdict: int(verdict == status) for verdict in ("allow", "block", "error")}
    trend = result["datasets"]["requestTrend"]["rows"]
    assert sum(row["requests"] for row in trend) == 1
    assert sum(row[status] for row in trend) == 1
    assert all(sum(row[verdict] for row in trend) == int(verdict == status) for verdict in ("allow", "block", "error"))
    workflows = result["datasets"]["workflowRequests"]["rows"]
    assert len(workflows) == 1
    assert workflows[0]["workflowId"] == "wf-a"
    assert workflows[0]["requests"] == workflows[0][status] == 1
    assert workflows[0]["totalTokens"] == tokens
    assert SECRET not in json.dumps(result)


async def test_status_does_not_filter_evaluation_or_deployment_workflow_metadata(fixture):
    client, store, _ = fixture
    for workflow in ("wf-a", "wf-b"):
        await store.put("run", f"run-{workflow}", {"workflowId": workflow, "workflowName": "검증 워크플로우",
                        "createdAt": iso_at(CLOCK - 1000), "status": "completed", "total": 2,
                        "results": [{"expectationMatched": True, "output": SECRET}, {"expectationMatched": False}],
                        "datasetSnapshot": {"rows": [{"input": SECRET}]}})
        store.db.execute("INSERT INTO aegis_deployments VALUES(?,?,?,?,?,?)", (f"deploy-{workflow}", workflow, workflow, 1,
                         dump({"workflow": {"name": "배포 워크플로우", "prompt": SECRET}, "connections": [{"key": SECRET}]}), iso_at(CLOCK - 2 * DAY)))
    baseline = await dashboard(client, workflowId="wf-a", source="playground")
    result = await dashboard(client, workflowId="wf-a", source="playground", status="block")
    assert summary(result)["requestCount"] == 0
    assert summary(result)["matchedCount"] == 1
    assert summary(result)["evaluatedCount"] == 2
    assert summary(result)["matchRate"] == 50
    assert summary(result)["deploymentCount"] == 1
    for name in ("evaluations", "deployments"):
        table = result["datasets"][name]
        assert table == baseline["datasets"][name]
        assert table["rows"][0]["workflowId"] == "wf-a"
        assert "workflowId" in {column["key"] for column in table["columns"]}
        assert all(set(row) == {column["key"] for column in table["columns"]} for row in table["rows"])
    assert any("요청 판정 필터는 요청 지표에만 적용" in note for note in result["coverage"]["notes"])
    assert SECRET not in json.dumps(result)


async def test_retention_days_and_1000_record_capacity_without_mutating_store(fixture):
    client, store, _ = fixture
    await store.put("meta", "retention", {"logDays": 2, "evaluationDays": 30, "auditDays": 90})
    for number in range(1005):
        log(store, f"recent-{number}", age=1000 + number)
    log(store, "expired", age=3 * DAY)
    before = store.db.execute("SELECT COUNT(*) FROM aegis_request_logs").fetchone()[0]
    result = await dashboard(client)
    assert summary(result)["requestCount"] == 1000
    assert result["coverage"]["logDays"] == 2
    assert result["coverage"]["logLimit"] == 1000
    assert result["coverage"]["storedLogCount"] == 1000
    assert result["coverage"]["capacityReached"] is True
    assert result["coverage"]["oldestLogAt"] == iso_at(CLOCK - 1999)
    assert result["coverage"]["newestLogAt"] == iso_at(CLOCK - 1000)
    assert store.db.execute("SELECT COUNT(*) FROM aegis_request_logs").fetchone()[0] == before


async def test_kst_hourly_buckets_include_empty_hours_and_daily_limit(fixture):
    client, store, _ = fixture
    # UTC 15:00 is the next calendar day at 00:00 in Korea.
    log(store, "before-midnight", age=CLOCK - int(datetime.fromisoformat("2026-10-24T14:30:00+00:00").timestamp() * 1000))
    log(store, "after-midnight", age=CLOCK - int(datetime.fromisoformat("2026-10-24T15:30:00+00:00").timestamp() * 1000))
    result = await dashboard(client, **{"from": "2026-10-24T14:00:00Z", "to": "2026-10-24T17:00:00Z"})
    rows = result["datasets"]["requestTrend"]["rows"]
    assert [row["bucket"] for row in rows] == ["2026-10-24T23:00:00+09:00", "2026-10-25T00:00:00+09:00", "2026-10-25T01:00:00+09:00"]
    assert [row["requests"] for row in rows] == [1, 1, 0]
    assert rows[-1]["avgLatencyMs"] is None
    daily = await dashboard(client, **{"from": iso_at(CLOCK - 90 * DAY), "to": iso_at(CLOCK)})
    assert daily["datasets"]["requestTrend"]["totalRows"] == 91
    assert not daily["datasets"]["requestTrend"]["truncated"]
    assert all(row["bucket"].endswith("00:00:00+09:00") for row in daily["datasets"]["requestTrend"]["rows"])


async def test_latency_percentile_and_usage_rewrite_are_not_counted_per_attempt(fixture):
    client, store, _ = fixture
    for number in range(1, 21):
        log(store, f"request-{number}", age=number, latency=number, usage=3, regenerationCount=2 if number == 1 else 0,
            attempts=[{"usage": {"total_tokens": 999}, "latencyMs": 999}] * 3)
    log(store, "unknown-usage", latency=None, status="block")
    log(store, "known-zero", latency=0, usage=0, status="error")
    result = await dashboard(client)
    metrics = summary(result)
    assert metrics["requestCount"] == 22
    assert metrics["totalTokens"] == 60
    assert metrics["regenerationCount"] == 2
    assert metrics["p95LatencyMs"] == 19  # nearest rank of 0,1,...,20
    assert metrics["avgLatencyMs"] == 10
    assert metrics["blockRate"] == metrics["errorRate"] == 4.55
    assert result["coverage"]["missingUsageCount"] == 1
    assert any("불완전" in note for note in result["coverage"]["notes"])
    assert sum(row["count"] for row in result["datasets"]["requestStatus"]["rows"]) == 22


async def test_zero_and_missing_measurements_remain_distinct(fixture):
    client, store, _ = fixture
    empty = summary(await dashboard(client))
    assert empty["requestCount"] == empty["totalTokens"] == empty["regenerationCount"] == 0
    assert empty["avgLatencyMs"] is empty["p95LatencyMs"] is empty["blockRate"] is empty["matchRate"] is None
    log(store, "missing", latency=None, usage=None)
    missing = summary(await dashboard(client))
    assert missing["totalTokens"] is missing["avgLatencyMs"] is missing["p95LatencyMs"] is None
    assert missing["blockRate"] == 0
    log(store, "zero", source="playground", latency=0, usage=0)
    zero = summary(await dashboard(client, source="playground"))
    assert zero["totalTokens"] == zero["avgLatencyMs"] == zero["p95LatencyMs"] == 0


async def test_all_retained_evaluations_comparable_denominator_and_table_truncation(fixture):
    client, store, _ = fixture
    for number in range(105):
        await store.put("run", f"run-{number:03}", {"id": f"run-{number:03}", "workflowId": "wf-a", "workflowName": "검증 워크플로우", "datasetName": "안전한 메타데이터",
                        "createdAt": iso_at(CLOCK - number - 1), "status": "completed", "total": 4,
                        "results": [{"expectationMatched": True}, {"expectationMatched": False}, {"output": SECRET}, {"expectationMatched": None}],
                        "baselineResults": [{"expectationMatched": True}], "datasetSnapshot": {"rows": [{"input": SECRET}]} ,"_lease": {"token": SECRET}})
    result = await dashboard(client)
    assert summary(result)["matchedCount"] == 105
    assert summary(result)["evaluatedCount"] == 210
    assert summary(result)["matchRate"] == 50
    table = result["datasets"]["evaluations"]
    assert table["totalRows"] == 105
    assert table["truncated"] is True
    assert len(table["rows"]) == 100
    assert table["rows"][0]["completed"] == 4
    assert table["rows"][0]["matched"] == 1
    assert table["rows"][0]["matchRate"] == 50
    assert SECRET not in json.dumps(result)


async def test_evaluation_retention_period_workflow_and_source_independence(fixture):
    client, store, _ = fixture
    await store.put("meta", "retention", {"logDays": 30, "evaluationDays": 1, "auditDays": 90})
    for identifier, workflow, age in [("selected", "wf-a", 1000), ("other", "wf-b", 1000), ("expired", "wf-a", 2 * DAY)]:
        await store.put("run", identifier, {"workflowId": workflow, "createdAt": iso_at(CLOCK - age), "results": [{"expectationMatched": True}], "status": "completed"})
    result = await dashboard(client, workflowId="wf-a", source="playground")
    assert summary(result)["matchedCount"] == summary(result)["evaluatedCount"] == 1
    assert result["datasets"]["evaluations"]["rows"][0]["runId"] == "selected"
    old = await dashboard(client, workflowId="wf-a", **{"to": iso_at(CLOCK - DAY), "from": iso_at(CLOCK - 3 * DAY)})
    assert old["datasets"]["evaluations"]["rows"] == []


async def test_deployment_latest_per_alias_ignores_period_source_and_excludes_snapshots(fixture):
    client, store, _ = fixture
    for identifier, alias, workflow, version in [("first", "alpha", "wf-a", 1), ("latest", "alpha", "wf-a", 2), ("second-alias", "beta", "wf-a", 1), ("other", "gamma", "wf-b", 1)]:
        value = {"workflow": {"name": workflow, "prompt": SECRET}, "connections": [{"key": SECRET}], "engineVersion": "3-python"}
        store.db.execute("INSERT INTO aegis_deployments VALUES(?,?,?,?,?,?)", (identifier, workflow, alias, version, dump(value), "2000-01-01T00:00:00.000Z"))
    result = await dashboard(client, workflowId="wf-a", source="playground")
    assert summary(result)["deploymentCount"] == 2
    assert [row["deploymentId"] for row in result["datasets"]["deployments"]["rows"]] == ["latest", "second-alias"]
    assert SECRET not in json.dumps(result)


async def test_dashboard_projects_safe_columns_and_does_not_create_or_prune_records(fixture):
    client, store, _ = fixture
    log(store, "raw-private", input=SECRET, output=SECRET, reason=SECRET, keyId=SECRET,
        traces=[{"reason": SECRET}], attempts=[{"output": SECRET}])
    before = list(store.db.execute("SELECT namespace,id,payload,updated_at FROM aegis_records ORDER BY namespace,id"))
    result = await dashboard(client)
    assert SECRET not in json.dumps(result)
    after = list(store.db.execute("SELECT namespace,id,payload,updated_at FROM aegis_records ORDER BY namespace,id"))
    assert [tuple(row) for row in before] == [tuple(row) for row in after]
    for dataset in result["datasets"].values():
        keys = {column["key"] for column in dataset["columns"]}
        assert all(set(row) == keys for row in dataset["rows"])


@pytest.mark.parametrize("params", [
    {"from": "not-a-date"}, {"to": "2026-10-26"}, {"from": "2026-10-25T00:00:00"},
    {"from": iso_at(CLOCK), "to": iso_at(CLOCK)}, {"from": iso_at(CLOCK), "to": iso_at(CLOCK - 1)},
    {"from": iso_at(CLOCK - 91 * DAY)}, {"source": "invalid"}, {"source": ""},
    {"status": ""}, {"status": "all"}, {"status": "completed"}, {"status": "BLOCK"},
    {"workflowId": ""}, {"workflowId": "w" * 121}, {"workflowId": "unknown-id"},
])
async def test_invalid_dashboard_filters_are_400(fixture, params):
    client, _, _ = fixture
    response = await client.get("/api/console", params={"view": "dashboard", **params})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_dashboard_query"


async def test_dashboard_requires_existing_console_authentication(fixture):
    client, _, _ = fixture
    assert (await client.get("/api/console?view=dashboard", headers={"Authorization": ""})).status_code == 401
    assert (await client.get("/api/console?view=dashboard", auth=("dashboard-reader", "wrong"))).status_code == 401


async def test_unseeded_dashboard_is_read_only():
    store = Store()
    result = await aggregate_dashboard(store)
    assert summary(result)["requestCount"] == 0
    assert store.db.execute("SELECT COUNT(*) FROM aegis_records").fetchone()[0] == 0
    await store.close()
