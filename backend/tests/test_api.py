import asyncio
import base64
import copy
import json
import pytest
import httpx
from fastapi import FastAPI

from aegis.api import create_router
from aegis.store import Store
from aegis.review import ENGINE_VERSION, configuration_fingerprint


@pytest.fixture
async def fixture():
    store = Store()
    await store.seed()
    env = {"ADMIN_USER": "admin", "ADMIN_PASSWORD": "correct-horse"}
    app = FastAPI()
    app.include_router(create_router(store, env))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 45000)), base_url="http://test", headers={"Authorization": "Basic " + base64.b64encode(b"admin:correct-horse").decode()}) as client:
        yield client, store, env
    await store.close()


async def state(client):
    response = await client.get("/api/console")
    assert response.status_code == 200, response.text
    return response.json()["state"]


async def act(client, action, **payload):
    response = await client.post("/api/console", json={"action": action, **payload})
    assert response.status_code == 200, response.text
    return response.json()


async def deploy_and_key(client):
    current = await state(client)
    workflow = current["workflows"][0]
    deployment = (await act(client, "publish", workflowId=workflow["id"]))["deployment"]
    key = (await act(client, "create_key", name="external-service"))["key"]
    return workflow, deployment, {"Authorization": f"Bearer {key}"}


async def completion(client, workflow, headers, content="배송 문의", **extra):
    return await client.post("/v1/chat/completions", headers=headers, json={"model": workflow["alias"], "messages": [{"role": "user", "content": content}], **extra})


async def test_console_basic_csrf_and_spoofed_identity(fixture):
    client, store, env = fixture
    response = await client.get("/api/console", auth=("admin", "wrong"), headers={"oai-authenticated-user-id": "admin", "x-real-ip": "127.0.0.1"})
    assert response.status_code == 401
    assert response.headers["www-authenticate"].startswith("Basic")
    current = await state(client)
    response = await client.post("/api/console", headers={"Origin": "https://evil.example"}, json={"action": "save_workflow", "workflow": current["workflows"][0]})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "origin_not_allowed"


async def test_no_credentials_only_allows_actual_loopback():
    store = Store(); await store.seed()
    app = FastAPI(); app.include_router(create_router(store, {}))
    for host, expected in [("127.0.0.1", 200), ("203.0.113.10", 401)]:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(host, 1)), base_url="http://test") as client:
            response = await client.get("/api/console", headers={"x-real-ip": "127.0.0.1"})
            assert response.status_code == expected
    await store.close()


async def test_viewer_cannot_mutate_even_with_spoofed_admin_header(fixture):
    client, store, env = fixture
    env["AEGIS_ROLE_MAP"] = {"admin": "viewer", "spoofed": "admin"}
    current = await state(client)
    assert current["role"] == "viewer"
    response = await client.post("/api/console", headers={"oai-authenticated-user-id": "spoofed"}, json={"action": "create_key", "name": "unauthorized"})
    assert response.status_code == 403
    assert not (await store.state())["keys"]


async def test_workflow_and_dataset_cas_preserve_current_records(fixture):
    client, _, _ = fixture
    current = await state(client)
    for kind, record in [("workflow", current["workflows"][0]), ("dataset", current["datasets"][0])]:
        old = record.get("updatedAt", "")
        await act(client, "save_" + kind, **{kind: {**record, "name": "saved first"}, "expectedUpdatedAt": old})
        response = await client.post("/api/console", json={"action": "save_" + kind, kind: {**record, "name": "stale second"}, "expectedUpdatedAt": old})
        assert response.status_code == 409
        assert response.json()["error"]["code"] == f"stale_{kind}_save"
        records = (await state(client))["workflows" if kind == "workflow" else "datasets"]
        assert next(item for item in records if item["id"] == record["id"])["name"] == "saved first"


async def test_gateway_openai_response_key_policy_and_readonly_snapshot(fixture):
    client, _, _ = fixture
    workflow, deployment, headers = await deploy_and_key(client)
    response = await completion(client, workflow, headers)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["object"] == "chat.completion"
    assert data["choices"][0]["finish_reason"] == "stop"
    assert response.headers["x-aegis-workflow-version"] == str(deployment["version"])
    assert response.headers["x-aegis-request-id"]
    renamed = {**workflow, "name": "new draft", "alias": "new-unpublished-alias"}
    await act(client, "save_workflow", workflow=renamed)
    models = await client.get("/v1/models", headers=headers)
    assert [item["id"] for item in models.json()["data"]] == [workflow["alias"]]
    assert (await completion(client, workflow, headers)).status_code == 200
    latest = await state(client)
    key = latest["keys"][0]
    await act(client, "update_key_policy", id=key["id"], policy={"allowedModels": []})
    assert (await completion(client, workflow, headers)).status_code == 403
    assert (await client.get("/v1/models", headers=headers)).json()["data"] == []


async def test_pre_and_post_blocks_withhold_answer_and_logs(fixture):
    client, _, _ = fixture
    workflow, _, headers = await deploy_and_key(client)
    pre = await completion(client, workflow, headers, "연락처 customer@example.com")
    assert pre.status_code == 403
    assert pre.json()["error"]["stage"] == "pre"
    post = await completion(client, workflow, headers, "담당자 연락처 예시")
    assert post.status_code == 403
    assert post.json()["error"]["stage"] == "post"
    for response in (pre, post):
        assert "choices" not in response.json()
        assert "support@example.com" not in response.text
    logs = (await state(client))["logs"]
    assert not any("customer@example.com" in json.dumps(item) or "support@example.com" in json.dumps(item) for item in logs)


async def test_playground_progress_and_mock_are_actual_engine_results(fixture):
    client, _, _ = fixture
    workflow = (await state(client))["workflows"][0]
    response = await client.post("/api/console", json={"action": "playground", "workflowId": workflow["id"], "input": "배송 문의", "progress": True})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    messages = [json.loads(line) for line in response.text.splitlines()]
    assert any(item["type"] == "progress" for item in messages)
    assert messages[-1]["type"] == "result"
    assert messages[-1]["result"]["status"] == "allow"
    assert messages[-1]["fingerprint"] == configuration_fingerprint(workflow, (await state(client))["connections"])
    result = await act(client, "playground", workflowId=workflow["id"], input="질문", mockResponse="support@example.com")
    assert result["result"]["status"] == "block"
    assert result["result"]["output"] == ""
    assert result["result"]["executionMode"] == "mock"


async def test_invalid_gateway_inputs_rejected_and_leases_released(fixture):
    client, _, _ = fixture
    workflow, _, headers = await deploy_and_key(client)
    for extra, code in [({"stream": True}, "streaming_not_supported"), ({"stream": None}, "streaming_not_supported"), ({"tools": []}, "unsupported_parameter"), ({"mockResponse": "bypass"}, "unsupported_parameter")]:
        response = await completion(client, workflow, headers, **extra)
        assert response.status_code == 400
        assert response.json()["error"]["code"] == code
    response = await client.post("/v1/chat/completions", headers=headers, json={"model": workflow["alias"], "messages": [{"role": "tool", "content": "unsupported"}]})
    assert response.status_code == 400
    response = await client.get("/v1/chat/completions", headers=headers)
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "method_not_allowed"
    assert (await completion(client, workflow, headers)).status_code == 200
    assert (await state(client))["keys"][0]["usage"]["active"] == 0


async def test_publish_retry_is_idempotent_and_changed_command_conflicts(fixture):
    client, _, _ = fixture
    workflow = (await state(client))["workflows"][0]
    request = {"workflowId": workflow["id"], "idempotencyKey": "test-publish-command"}
    first = await act(client, "publish", **request)
    await act(client, "save_workflow", workflow={**workflow, "description": "changed after response loss"})
    replay = await act(client, "publish", **request)
    assert replay["deployment"]["id"] == first["deployment"]["id"]
    assert replay["replayed"]
    conflict = await client.post("/api/console", json={"action": "publish", **request, "note": "different payload"})
    assert conflict.status_code == 409
    assert len((await state(client))["deployments"]) == 1


async def test_current_policy_blocks_unverified_restore_and_historical_lookup(fixture):
    client, _, _ = fixture
    workflow, original, _ = await deploy_and_key(client)
    saved = await act(client, "save_workflow", workflow={**workflow, "releasePolicy": {"requireVerification": True, "requiredDatasetIds": []}})
    response = await client.post("/api/console", json={"action": "rollback_deployment", "deploymentId": original["id"]})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "required_verification_missing"
    review = await client.get("/api/console", params={"view": "verification", "deploymentId": original["id"]})
    assert review.status_code == 200
    assert review.json()["policy"]["requireVerification"]
    historical = await client.get("/api/console", params={"view": "deployment", "deploymentId": original["id"]})
    assert historical.json()["deployment"]["id"] == original["id"]


async def test_actual_ip_ingress_ignores_direct_forwarding_headers(fixture):
    client, _, _ = fixture
    workflow, _, headers = await deploy_and_key(client)
    await act(client, "save_ingress", ingress={"enabled": True, "allowedCidrs": ["203.0.113.0/24"], "allowedOrigins": []})
    response = await completion(client, workflow, {**headers, "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "203.0.113.5"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ip_not_allowed"
    await act(client, "save_ingress", ingress={"enabled": True, "allowedCidrs": ["127.0.0.1/32"], "allowedOrigins": []})
    assert (await completion(client, workflow, headers)).status_code == 200


async def test_request_limits_fail_before_mutation(fixture):
    client, _, _ = fixture
    response = await client.post("/api/console", headers={"Content-Type": "application/json"}, content=b"{" + b" " * 2_000_000)
    assert response.status_code == 413
    response = await client.post("/api/console", headers={"Content-Type": "application/json"}, content='{"action":NaN}')
    assert response.status_code == 400
    response = await client.post("/api/console", json={"action": "save_dataset", "dataset": {"name": "missing fields"}})
    assert response.status_code == 400
    assert len((await state(client))["datasets"]) == 1


async def test_connection_management_diagnostics_and_cache_invalidation(fixture):
    client, _, _ = fixture
    connection = {"id": "additional-demo", "name": "추가 모델", "baseUrl": "", "model": "demo", "role": "both", "mode": "demo", "secretEnv": "", "timeoutMs": 1000}
    await act(client, "save_connection", connection=connection)
    assert (await act(client, "test_connection", id=connection["id"]))["test"]["ok"]
    diagnosed = await act(client, "diagnose_connection", id=connection["id"])
    assert diagnosed["diagnostic"]["ok"]
    assert connection["id"] in diagnosed["state"]["diagnostics"]
    await act(client, "save_connection", connection={**connection, "name": "수정한 이름"})
    assert connection["id"] not in (await state(client))["diagnostics"]
    await act(client, "delete_connection", id=connection["id"])
    assert not any(c["id"] == connection["id"] for c in (await state(client))["connections"])
    used = await client.post("/api/console", json={"action": "delete_connection", "id": "conn-main"})
    assert used.status_code == 400


async def test_dataset_mapping_copies_rows_and_enforces_review_hash(fixture):
    client, store, _ = fixture
    from aegis.review import dataset_fingerprint
    current = await state(client)
    workflow = current["workflows"][0]
    original = {**current["datasets"][0], "rows": [{"id": "source-row", "input": "배송 문의", "expected": "allow", "expectedRuleId": "old-detector"}]}
    saved = await act(client, "save_dataset", dataset=original)
    original = saved["state"]["datasets"][0]
    request = {"sourceDatasetId": original["id"], "workflowId": workflow["id"], "target": "draft", "expectedDatasetFingerprint": dataset_fingerprint(original), "expectedWorkflowFingerprint": configuration_fingerprint(workflow, current["connections"]), "mappings": {"old-detector": "rule-length"}, "name": "연결한 복사본"}
    copied = await act(client, "create_mapped_dataset", **request)
    assert copied["dataset"]["id"] != original["id"]
    assert copied["dataset"]["rows"][0]["id"] != "source-row"
    assert copied["dataset"]["rows"][0]["expectedRuleId"] == "rule-length"
    assert (await store.get_record("dataset", original["id"]))["rows"][0]["expectedRuleId"] == "old-detector"
    await act(client, "save_dataset", dataset={**original, "description": "changed after review"})
    stale = await client.post("/api/console", json={"action": "create_mapped_dataset", **request})
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "stale_dataset_mapping"


async def test_complete_evaluation_proves_deploy_and_retained_summary_survives(fixture):
    client, store, _ = fixture
    current = await state(client)
    workflow, dataset = current["workflows"][0], current["datasets"][0]
    workflow = {**workflow, "releasePolicy": {"requireVerification": True, "requiredDatasetIds": [dataset["id"]]}}
    await act(client, "save_workflow", workflow=workflow)
    run = (await act(client, "run_evaluation", workflowId=workflow["id"], datasetId=dataset["id"], target="draft"))["run"]
    assert run["status"] == "completed"
    assert all(row["expectationMatched"] for row in run["results"])
    response = await act(client, "publish", workflowId=workflow["id"], verificationRunIds=[run["id"]])
    deployment = response["deployment"]
    assert deployment["engineVersion"] == ENGINE_VERSION
    assert deployment["verificationSummaries"][0]["matchedCount"] == len(dataset["rows"])
    await store.remove("run", run["id"])
    historical = await client.get("/api/console", params={"view": "deployment", "deploymentId": deployment["id"]})
    assert historical.json()["deployment"]["verificationSummaries"] == deployment["verificationSummaries"]


async def test_gateway_uses_exact_upstream_conversation_options_and_finish_reason(fixture):
    client, _, env = fixture
    current = await state(client)
    workflow = {**current["workflows"][0], "pre": [], "post": []}
    upstream = {**next(c for c in current["connections"] if c["id"] == workflow["mainConnectionId"]), "mode": "vllm", "baseUrl": "https://model.example/v1"}
    await act(client, "save_ingress", ingress={"enabled": False, "allowedCidrs": [], "allowedOrigins": ["https://model.example"]})
    await act(client, "save_connection", connection=upstream)
    await act(client, "save_workflow", workflow=workflow)
    await act(client, "publish", workflowId=workflow["id"])
    key = (await act(client, "create_key", name="live-test"))["key"]
    sent = []
    async def handle(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "실제 HTTP 어댑터 검사"}, "finish_reason": "length"}], "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7}})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as upstream_client:
        env["_client"] = upstream_client
        messages = [{"role": "system", "content": "시스템 설정"}, {"role": "user", "content": "질문"}, {"role": "assistant", "content": "앞선 답변"}, {"role": "user", "content": "후속 질문"}]
        response = await client.post("/v1/chat/completions", headers={"Authorization": f"Bearer {key}"}, json={"model": workflow["alias"], "messages": messages, "temperature": 0.4, "max_tokens": 20, "top_p": 0.8})
    assert response.status_code == 200, response.text
    assert response.json()["choices"][0]["finish_reason"] == "length"
    assert response.json()["usage"]["total_tokens"] == 7
    assert sent[0]["messages"] == messages
    assert sent[0]["max_tokens"] == 20
    assert sent[0]["temperature"] == 0.4
    assert sent[0]["top_p"] == 0.8


@pytest.mark.parametrize("policy", [False, [], 0, ""])
async def test_malformed_key_policy_cannot_become_unrestricted(fixture, policy):
    client, _, _ = fixture
    before = len((await state(client))["keys"])
    response = await client.post("/api/console", json={"action": "create_key", "name": "malformed-policy", "policy": policy})
    assert response.status_code == 400
    assert len((await state(client))["keys"]) == before


async def test_attached_execution_forwards_cancel_and_cleans_monitor(monkeypatch):
    import aegis.api as api
    event, entered, options = asyncio.Event(), asyncio.Event(), {"max_tokens": 17}
    class Request:
        consumed_body = True
        calls = 0
        async def is_disconnected(self):
            assert self.consumed_body
            self.calls += 1
            return event.is_set()
    request = Request()
    external_cancel = asyncio.Event()
    async def execute(*args, cancel_event=None, **kwargs):
        assert args[-1] is options
        assert cancel_event is external_cancel
        entered.set()
        await cancel_event.wait()
        return {"status": "error", "output": ""}
    monkeypatch.setattr(api, "execute_workflow", execute)
    task = asyncio.create_task(api.execute_attached(request, {}, [], {}, {}, [], options, cancel_event=external_cancel))
    await entered.wait(); event.set()
    result = await asyncio.wait_for(task, timeout=1)
    assert result == {"status": "error", "output": ""}
    assert external_cancel.is_set()
    assert request.calls > 0
    assert not any(t.get_name() == "aegis-request-disconnect" and not t.done() for t in asyncio.all_tasks())


@pytest.mark.parametrize("path", ["/v1/chat/completions", "/api/console"])
async def test_nonstream_disconnect_stops_upstream_and_releases_leases(fixture, path):
    """Exercise the actual ASGI receive disconnect after the full JSON body."""
    client, store, env = fixture
    current = await state(client)
    workflow = {**current["workflows"][0], "pre": [], "post": []}
    main = next(c for c in current["connections"] if c["id"] == workflow["mainConnectionId"])
    await act(client, "save_ingress", ingress={"enabled": False, "allowedCidrs": [], "allowedOrigins": ["https://disconnect-model.example"]})
    await act(client, "save_connection", connection={**main, "mode": "vllm", "baseUrl": "https://disconnect-model.example/v1"})
    await act(client, "save_workflow", workflow=workflow)
    await act(client, "publish", workflowId=workflow["id"])
    key = (await act(client, "create_key", name="disconnect-test"))["key"]
    started, released, disconnected = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def model(request):
        started.set()
        try:
            await asyncio.sleep(20)
            return httpx.Response(200, json={"choices": [{"message": {"content": "must not finish"}, "finish_reason": "stop"}]})
        finally:
            released.set()
    async with httpx.AsyncClient(transport=httpx.MockTransport(model)) as upstream:
        env["_client"] = upstream
        app = FastAPI(); app.include_router(create_router(store, env))
        body = json.dumps({"model": workflow["alias"], "messages": [{"role": "user", "content": "hello"}]} if path.startswith("/v1") else {"action": "playground", "workflowId": workflow["id"], "input": "hello"}).encode()
        authorization = ("Bearer " + key).encode() if path.startswith("/v1") else b"Basic " + base64.b64encode(b"admin:correct-horse")
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"", "headers": [(b"host", b"test"), (b"content-type", b"application/json"), (b"authorization", authorization)], "client": ("127.0.0.1", 45000), "server": ("test", 80)}
        body_delivered, disconnect_delivered = False, False
        async def receive():
            nonlocal body_delivered, disconnect_delivered
            if not body_delivered:
                body_delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            await disconnected.wait()
            disconnect_delivered = True
            return {"type": "http.disconnect"}
        sent = []
        async def send(message):
            sent.append(message)
        task = asyncio.create_task(app(scope, receive, send))
        await asyncio.wait_for(started.wait(), timeout=1)
        disconnected.set()
        await asyncio.wait_for(task, timeout=2)
        assert body_delivered and disconnect_delivered
        assert released.is_set()
        logs = (await store.state())["logs"]
        assert logs[0]["status"] == "error"
        assert "must not finish" not in json.dumps(logs)
        assert (await store.state())["keys"][0]["usage"]["active"] == 0
        capacity = await store.get_record("model_capacity", main["id"])
        assert not capacity["leases"]
    assert not any(t.get_name() == "aegis-request-disconnect" and not t.done() for t in asyncio.all_tasks())
