import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI, Request

from aegis.store import Store
from aegis.worker import handle_evaluation_worker, run_worker


def application(store, env):
    app = FastAPI()
    @app.api_route("/worker", methods=["GET", "POST"])
    async def worker(request: Request):
        return await handle_evaluation_worker(request, store, env)
    return app


@pytest.mark.asyncio
async def test_machine_worker_requires_its_own_token_before_reading_body():
    store = Store()
    token = "worker-only-" + "a" * 40
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(store, {"AEGIS_EVALUATION_WORKER_TOKEN": token})), base_url="http://test") as client:
            for auth in ("Basic YWRtaW46cGFzcw==", "Bearer ag_" + "a" * 64, "Bearer wrong"):
                response = await client.post("/worker", headers={"Authorization": auth}, content="not-json")
                assert response.status_code == 401
            response = await client.post("/worker", headers={"Authorization": f"Bearer {token}"}, json={"action": "heartbeat", "workerId": "remote-test"})
            assert response.status_code == 200
            assert response.json()["evaluationWorker"]["available"] is True
            assert (await store.evaluation_worker_status())["kind"] == "remote"
            response = await client.post("/worker", headers={"Authorization": f"Bearer {token}"}, json={"action": "process", "workerId": "remote-test"})
            assert response.json()["progress"] == {"checked": 0, "processed": 0, "busy": 0, "failed": 0}
            response = await client.post("/worker", headers={"Authorization": f"Bearer {token}"}, json={"action": "disconnect", "workerId": "remote-test"})
            assert response.json() == {"disconnected": True}
            assert not (await store.evaluation_worker_status())["available"]
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_worker_body_is_bounded_and_malformed_actions_are_client_errors():
    store = Store()
    token = "b" * 40
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application(store, {"AEGIS_EVALUATION_WORKER_TOKEN": token})), base_url="http://test", headers={"Authorization": f"Bearer {token}"}) as client:
            response = await client.post("/worker", content="x" * 2049)
            assert response.status_code == 413
            assert response.json()["error"]["code"] == "request_too_large"
            for body in ([], {"action": []}, {"action": {"bad": True}, "workerId": "valid"}, {"action": "heartbeat", "workerId": "../wrong"}, {"action": "heartbeat", "workerId": "valid", "extra": 1}):
                response = await client.post("/worker", json=body)
                assert response.status_code == 400
            assert (await client.get("/worker")).status_code == 405
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_lifespan_worker_stops_processing_and_removes_heartbeat(monkeypatch):
    from aegis import worker
    store = Store()
    stop, entered, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def process(store, env):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
    monkeypatch.setattr(worker, "process_evaluation_queue", process)
    try:
        task = asyncio.create_task(run_worker(store, {}, stop, worker_id="lifespan-worker"))
        await entered.wait()
        assert (await store.evaluation_worker_status())["available"] is True
        stop.set()
        await asyncio.wait_for(task, timeout=1)
        assert cancelled.is_set()
        assert not (await store.evaluation_worker_status())["available"]
    finally:
        await store.close()
