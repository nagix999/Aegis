import pytest
import httpx
from fastapi import FastAPI

from aegis.api import create_router
from aegis.evaluation_history import evaluation_history
from aegis.store import Store, iso_at, now_ms


@pytest.fixture
async def store():
    value = Store()
    await value.seed()
    yield value
    await value.close()


def run(identifier, created=None, **overrides):
    return {"id": identifier, "workflowId": "wf-support", "workflowName": "상담 업무", "datasetId": "ds-one", "datasetName": "개인정보 사례",
            "createdAt": created or iso_at(), "updatedAt": iso_at(), "version": "draft", "status": "completed", "total": 1,
            "results": [{"rowId": "one", "output": "PRIVATE_RESULT"}], "workflowSnapshot": {"prompt": "PRIVATE_PROMPT"}, "_lease": {"token": "PRIVATE_LEASE"}, **overrides}


async def test_history_discovers_old_runs_with_stable_cursor_and_metadata_only(store):
    created = iso_at()
    for index in range(33):
        await store.put("run", f"run-{index:03}", run(f"run-{index:03}", created))
    first = await evaluation_history(store, {"limit": 20})
    assert first["total"] == 33 and len(first["runs"]) == 20
    assert first["runs"][0]["id"] == "run-032"
    assert first["runs"][0]["completedCount"] == 1
    assert "PRIVATE" not in str(first)
    # A new insertion ahead of the cursor must not repeat or skip older records.
    await store.put("run", "run-new", run("run-new", iso_at(now_ms() + 1000)))
    second = await evaluation_history(store, {"limit": 20, "cursor": first["nextCursor"]})
    ids = [value["id"] for value in first["runs"] + second["runs"]]
    assert len(ids) == len(set(ids)) == 33 and ids[-1] == "run-000"
    assert "nextCursor" not in second
    old = await evaluation_history(store, {"query": "run-000"}, "run-000")
    assert old["total"] == 1 and old["run"]["id"] == "run-000"
    assert "_lease" not in old["run"]
    assert (await store.get_record("run", "run-000"))["_lease"]["token"] == "PRIVATE_LEASE"


async def test_filters_search_only_metadata_and_keep_deleted_source_history(store):
    timestamp = iso_at()
    await store.put("run", "retained", run("retained", timestamp, workflowId="deleted-workflow", datasetId="deleted-dataset", status="error"))
    await store.put("run", "other", run("other", timestamp))
    result = await evaluation_history(store, {"workflowId": "deleted-workflow", "datasetId": "deleted-dataset", "status": "error", "query": "개인정보", "from": iso_at(now_ms() - 1000), "to": iso_at(now_ms() + 1000)})
    assert [value["id"] for value in result["runs"]] == ["retained"]
    assert (await evaluation_history(store, {"query": "PRIVATE_RESULT"}))["total"] == 0
    assert (await evaluation_history(store, {"query": "' OR 1=1 --"}))["total"] == 0


async def test_retention_omits_expired_completion_but_preserves_running(store):
    old = iso_at(now_ms() - 31 * 86_400_000)
    await store.put("run", "expired", run("expired", old))
    await store.put("run", "running", run("running", old, status="running"))
    result = await evaluation_history(store, {}, "expired")
    assert result["total"] == 1 and result["runs"][0]["id"] == "running"
    assert result["retention"] == {"days": 30} and "run" not in result
    assert (await evaluation_history(store, {}, "running"))["run"]["id"] == "running"
    # Discovery is read only, and does not remove records or change evidence.
    assert await store.get_record("run", "expired")


async def test_legacy_direct_lookup_uses_record_timestamp_when_created_at_is_missing(store):
    old = iso_at(now_ms() - 31 * 86_400_000)
    legacy = run("legacy-no-created")
    legacy.pop("createdAt")
    with store.lock:
        store._put("run", legacy["id"], legacy, old)
    reply = await evaluation_history(store, {}, legacy["id"])
    assert reply["total"] == 0 and "run" not in reply


async def test_legacy_timestamp_and_missing_status_remain_pageable(store):
    timestamp = iso_at().split(".")[0] + "Z"
    legacy = run("legacy", timestamp)
    legacy.pop("status")
    await store.put("run", "legacy", legacy)
    await store.put("run", "new", run("new", timestamp))
    first = await evaluation_history(store, {"limit": 1, "status": "completed"})
    second = await evaluation_history(store, {"limit": 1, "cursor": first["nextCursor"], "status": "completed"})
    assert len(first["runs"] + second["runs"]) == 2
    assert first["runs"][0]["id"] != second["runs"][0]["id"]


@pytest.mark.parametrize("options", [{"limit": True}, {"limit": 0}, {"limit": 101}, {"status": "allow"}, {"query": []}, {"query": "x" * 161}, {"workflowId": "x" * 121}, {"from": "invalid"}, {"to": "invalid"}, {"from": "2026-01-02T00:00:00Z", "to": "2026-01-01T00:00:00Z"}, {"cursor": "invalid"}])
async def test_invalid_queries_fail_before_broadening_search(store, options):
    with pytest.raises(ValueError):
        await evaluation_history(store, options)


async def test_history_endpoint_preserves_default_polling_and_authentication(store):
    app = FastAPI()
    app.include_router(create_router(store, {"ADMIN_USER": "review-admin", "ADMIN_PASSWORD": "synthetic-history-password", "AEGIS_ROLE_MAP": {"review-admin": "viewer"}}))
    for index in range(25):
        await store.put("run", f"api-{index:03}", run(f"api-{index:03}", iso_at(now_ms() - index * 1000)))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 1)), base_url="http://test") as client:
        assert (await client.get("/api/console?view=evaluations&history=true")).status_code == 401
        client.auth = ("review-admin", "synthetic-history-password")
        default = await client.get("/api/console?view=evaluations")
        assert default.status_code == 200 and len(default.json()["runs"]) == 10
        assert "total" not in default.json() and "retention" not in default.json()
        response = await client.get("/api/console?view=evaluations&history=true&limit=20&runId=api-024")
        body = response.json()
        assert response.status_code == 200 and body["total"] == 25 and len(body["runs"]) == 20
        assert body["run"]["id"] == "api-024" and "_lease" not in body["run"]
        page = await client.get("/api/console", params={"view": "evaluations", "history": "true", "cursor": body["nextCursor"]})
        assert page.status_code == 200 and len(page.json()["runs"]) == 5
        for query in ({"limit": "not-int"}, {"limit": "101"}, {"status": "allow"}, {"cursor": "invalid"}, {"from": "invalid"}):
            rejected = await client.get("/api/console", params={"view": "evaluations", "history": "true", **query})
            assert rejected.status_code == 400 and rejected.json()["error"]["code"] == "invalid_evaluation_query"
