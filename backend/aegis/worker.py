"""Independent durable evaluation worker and narrowly authenticated endpoint."""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import re
import uuid
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

from .evaluation import process_background_evaluation_run

log = logging.getLogger("aegis.worker")
_WORKER_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$")


def _worker_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_WORKER_ID.fullmatch(value))


async def heartbeat_evaluation_worker(store: Any, identity: dict) -> dict:
    if not _worker_id(identity.get("id")) or identity.get("kind") not in {"local", "remote"}:
        raise ValueError("검증 작업자 정보를 확인하세요.")
    await store.seed()
    return await store.heartbeat_evaluation_worker(identity["id"], identity["kind"])


async def release_evaluation_worker(store: Any, worker_id: str) -> None:
    if not _worker_id(worker_id):
        raise ValueError("검증 작업자 정보를 확인하세요.")
    await store.remove("evaluation_worker", worker_id)


async def process_evaluation_queue(store: Any, env: dict) -> dict:
    await store.seed()
    identifiers = await store.background_evaluation_ids()
    progress = {"checked": len(identifiers), "processed": 0, "busy": 0, "failed": 0}

    async def process(run_id: str) -> None:
        try:
            ingress = await store.get_record("meta", "ingress")
            if ingress is None:
                raise ValueError("검증 접근 정책을 찾을 수 없습니다.")
            result = await process_background_evaluation_run(run_id, {"ingress": ingress}, store, env)
            progress["processed"] += int(result["processed"])
            progress["busy"] += int(result["leaseActive"])
        except asyncio.CancelledError:
            raise
        except Exception:
            progress["failed"] += 1
    await asyncio.gather(*(process(identifier) for identifier in identifiers))
    return progress


def _reply(value: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(value, status_code=status, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


async def handle_evaluation_worker(request: Request, store: Any, env: dict) -> JSONResponse:
    if request.method != "POST":
        return _reply({"error": {"code": "method_not_allowed", "message": "POST 요청이 필요합니다."}}, 405)
    secret = env.get("AEGIS_EVALUATION_WORKER_TOKEN")
    if not isinstance(secret, str) or not 32 <= len(secret) <= 512 or "\r" in secret or "\n" in secret:
        return _reply({"error": {"code": "evaluation_worker_not_configured", "message": "검증 작업자 인증이 설정되어 있지 않습니다."}}, 503)
    authorization = request.headers.get("authorization", "")
    candidate = authorization[7:] if authorization.startswith("Bearer ") else ""
    if not candidate or len(candidate) > 512 or not hmac.compare_digest(candidate.encode("utf-8"), secret.encode("utf-8")):
        return _reply({"error": {"code": "unauthorized", "message": "검증 작업자 인증이 필요합니다."}}, 401)
    try:
        raw = bytearray()
        length = request.headers.get("content-length")
        if length is not None and int(length) > 2048:
            return _reply({"error": {"code": "request_too_large", "message": "작업자 요청 본문은 2KB 이하로 보내세요."}}, 413)
        async for part in request.stream():
            raw.extend(part)
            if len(raw) > 2048:
                return _reply({"error": {"code": "request_too_large", "message": "작업자 요청 본문은 2KB 이하로 보내세요."}}, 413)
        body = json.loads(raw)
    except (ValueError, UnicodeError):
        return _reply({"error": {"code": "invalid_request", "message": "올바른 JSON 요청이 필요합니다."}}, 400)
    if not isinstance(body, dict) or set(body) - {"action", "workerId"} or not _worker_id(body.get("workerId")) or not isinstance(body.get("action"), str) or body["action"] not in {"heartbeat", "process", "disconnect"}:
        return _reply({"error": {"code": "invalid_request", "message": "작업자 요청을 확인하세요."}}, 400)
    try:
        identity = body["workerId"]
        if body["action"] == "disconnect":
            await release_evaluation_worker(store, identity)
            return _reply({"disconnected": True})
        status = await heartbeat_evaluation_worker(store, {"id": identity, "kind": "remote"})
        if body["action"] == "heartbeat":
            return _reply({"evaluationWorker": status})
        return _reply({"progress": await process_evaluation_queue(store, env)})
    except Exception:
        return _reply({"error": {"code": "evaluation_worker_error", "message": "검증 작업자가 요청을 처리하지 못했습니다. 서버 상태를 확인하세요."}}, 500)


async def run_worker(store: Any, env: dict, stop_event: asyncio.Event, *, worker_id: str | None = None, interval: float = 1.0) -> None:
    """Run inside application lifespan or an independent CLI process.

    Heartbeats have a separate task so a long model call cannot mark a live
    worker unavailable. Shutdown cancellation never commits a partial batch.
    """
    identity = {"id": worker_id or str(uuid.uuid4()), "kind": "local"}
    await heartbeat_evaluation_worker(store, identity)

    async def heartbeat() -> None:
        while not stop_event.is_set():
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=10.0)
            except TimeoutError:
                try:
                    await heartbeat_evaluation_worker(store, identity)
                except Exception:
                    log.warning("검증 작업자 상태를 저장하지 못했습니다. 다시 시도합니다.")

    async def process() -> None:
        while not stop_event.is_set():
            try:
                await process_evaluation_queue(store, env)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("검증 작업을 처리하지 못했습니다. 완료된 결과를 유지하고 다시 시도합니다.")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=interval)
            except TimeoutError:
                pass

    tasks = [asyncio.create_task(heartbeat()), asyncio.create_task(process())]
    try:
        await stop_event.wait()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await release_evaluation_worker(store, identity["id"])
