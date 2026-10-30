"""Administrator-only ephemeral node details never enter public or stored data."""
import base64
import copy
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from aegis.api import create_router, record_log
from aegis.console_inspection import ConsoleInspection
from aegis.engine import execute_workflow
from aegis.graph import create_stage_graph
from aegis.policy_graph import execute_policy_graph
from aegis.store import Store
from test_switch_policy_graph import switch_fixture, switch_graph


def fixture_state():
    state = json.loads((Path(__file__).parents[1] / "aegis" / "seed.json").read_text())
    workflow = copy.deepcopy(state["workflows"][0])
    workflow.update(pre=[], post=[])
    return state, workflow


def group(identifier, pattern):
    return {"id": identifier, "name": identifier, "mode": "any", "rules": [
        {"id": identifier + "-rule", "name": "합성 검사", "description": "", "kind": "keyword", "enabled": True, "config": {"pattern": pattern}},
    ]}


def node(details, key, attempt=None):
    return next(item for item in details["nodes"] if item["nodeId"] == key and (attempt is None or item.get("attempt") == attempt))


@pytest.mark.parametrize("scope,expected", [
    ("conversation", "시스템😀\n첫 질문\n이전 답변\n마지막 질문"),
    ("user_messages", "첫 질문\n마지막 질문"),
    ("last_user", "마지막 질문"),
])
async def test_inspection_uses_actual_request_scope_but_main_receives_the_original_conversation(scope, expected):
    state, workflow = fixture_state()
    workflow["inputScope"] = scope
    messages = [{"role": role, "content": content} for role, content in [
        ("system", "시스템😀"), ("user", "첫 질문"), ("assistant", "이전 답변"), ("user", "마지막 질문"),
    ]]
    inspection = ConsoleInspection(workflow, messages)
    result = await execute_workflow(workflow, state["connections"], state["ingress"], {}, messages, {"mockResponse": "안전한 최종 응답"}, inspection=inspection)
    assert result["status"] == "allow"
    details = inspection.finalize(result)
    assert details["request"] == {"messages": messages, "inputScope": scope, "inspectionText": expected}
    assert node(details, "input")["output"]["length"] == len(expected.encode("utf-16-le")) // 2
    assert node(details, "main")["input"]["messageCount"] == len(messages)
    assert node(details, "main")["input"]["source"] == "request_messages"


@pytest.fixture
async def console(tmp_path):
    store = Store(tmp_path / "inspection.sqlite")
    await store.seed()
    env = {"ADMIN_USER": "inspection-admin", "ADMIN_PASSWORD": "inspection-test-password"}
    app = FastAPI()
    app.include_router(create_router(store, env))
    authorization = "Basic " + base64.b64encode(b"inspection-admin:inspection-test-password").decode()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 1)), base_url="http://test", headers={"Authorization": authorization}) as client:
            state = (await client.get("/api/console")).json()["state"]
            workflow = copy.deepcopy(state["workflows"][0])
            workflow.update(pre=[], post=[], inputScope="last_user")
            saved = await client.post("/api/console", json={"action": "save_workflow", "workflow": workflow})
            assert saved.status_code == 200, saved.text
            yield client, store, env, workflow
    finally:
        await store.close()


@pytest.mark.parametrize("progress", [False, True])
async def test_playground_inspection_is_explicit_console_only_and_not_stored(console, progress):
    client, store, _, workflow = console
    messages = [{"role": "system", "content": "SUBMITTED_SYSTEM"}, {"role": "user", "content": "PRIVATE_SUBMITTED_REQUEST"}]
    response = await client.post("/api/console", json={"action": "playground", "workflowId": workflow["id"], "messages": messages, "mockResponse": "SAFE_FINAL", "inspect": True, "progress": progress})
    assert response.status_code == 200, response.text
    assert "no-store" in response.headers["cache-control"]
    if progress:
        events = [json.loads(line) for line in response.text.splitlines() if line]
        assert all("inspection" not in event and "PRIVATE_SUBMITTED_REQUEST" not in json.dumps(event) for event in events if event["type"] == "progress")
        body = next(event for event in events if event["type"] == "result")
    else:
        body = response.json()
    assert "inspection" not in body["result"]
    details = body["inspection"]
    assert details["request"] == {"messages": messages, "inputScope": "last_user", "inspectionText": "PRIVATE_SUBMITTED_REQUEST"}
    assert node(details, "input")["output"]["source"] == "request_inspection"
    assert node(details, "main", 1)["output"]["source"] == "final_response"
    assert node(details, "output")["output"]["value"]["output"] == "SAFE_FINAL"
    logs = (await store.state())["logs"]
    encoded = json.dumps(logs)
    assert "inspection" not in encoded and "PRIVATE_SUBMITTED_REQUEST" not in encoded and "SAFE_FINAL" not in encoded
    # A later read cannot retrieve the ephemeral details from console state.
    assert '"inspection"' not in json.dumps((await client.get("/api/console")).json())


@pytest.mark.parametrize("inspect", [None, False])
async def test_ordinary_playground_contract_is_unchanged_without_opt_in(console, inspect):
    client, _, _, workflow = console
    payload = {"action": "playground", "workflowId": workflow["id"], "input": "배송 문의"}
    if inspect is not None:
        payload["inspect"] = inspect
    response = await client.post("/api/console", json=payload)
    assert response.status_code == 200, response.text
    assert "inspection" not in response.json() and "inspection" not in response.json()["result"]


@pytest.mark.parametrize("progress", [False, True])
async def test_editor_execution_still_works_but_cannot_receive_administrator_details(console, progress):
    client, _, env, workflow = console
    env["AEGIS_ROLE_MAP"] = {"inspection-admin": "editor"}
    response = await client.post("/api/console", json={"action": "playground", "workflowId": workflow["id"], "input": "배송 문의", "inspect": True, "progress": progress})
    assert response.status_code == 200, response.text
    assert '"inspection"' not in response.text


@pytest.mark.parametrize("invalid", [1, "true", {}, None])
async def test_inspection_flag_is_a_strict_boolean(console, invalid):
    client, _, _, workflow = console
    response = await client.post("/api/console", json={"action": "playground", "workflowId": workflow["id"], "input": "배송 문의", "inspect": invalid})
    assert response.status_code == 400


async def test_admin_inspection_keeps_each_actual_generation_and_never_reuses_it_as_repair_guidance():
    state, workflow = fixture_state()
    workflow.update(post=[group("post-check", "FORBIDDEN")], responseRetry={"enabled": True, "maxRetries": 1})
    model = state["connections"][0]
    model.update(mode="vllm", baseUrl="https://model.example/v1")
    state["ingress"]["allowedOrigins"] = ["https://model.example"]
    requests = []
    async def respond(request):
        requests.append(json.loads(request.content))
        output = "FORBIDDEN PRIVATE_BLOCKED_GENERATION" if len(requests) == 1 else "SAFE_FINAL"
        return httpx.Response(200, json={"choices": [{"message": {"content": output}, "finish_reason": "stop"}]})
    messages = [{"role": "user", "content": "배송 문의"}]
    inspection = ConsoleInspection(workflow, messages)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await execute_workflow(workflow, state["connections"], state["ingress"], {}, messages, client=client, inspection=inspection)
    assert result["status"] == "allow" and result["regenerationCount"] == 1
    details = inspection.finalize(result)
    assert node(details, "main", 1)["output"]["value"] == "FORBIDDEN PRIVATE_BLOCKED_GENERATION"
    assert node(details, "rule:post-check-rule", 1)["input"]["value"]["text"] == "FORBIDDEN PRIVATE_BLOCKED_GENERATION"
    assert node(details, "main", 2)["input"]["value"]["messages"] == requests[1]["messages"]
    assert node(details, "main", 2)["output"]["source"] == "final_response"
    assert node(details, "rule:post-check-rule", 2)["input"]["value"]["text"] == "SAFE_FINAL"
    assert "PRIVATE_BLOCKED_GENERATION" not in json.dumps(requests[1])
    assert "inspection" not in result


async def test_blocked_response_is_visible_only_in_admin_inspection_and_final_public_output_remains_empty():
    state, workflow = fixture_state()
    workflow["post"] = [group("post-check", "PRIVATE_BLOCKED_GENERATION")]
    messages = [{"role": "user", "content": "배송 문의"}]
    inspection = ConsoleInspection(workflow, messages)
    result = await execute_workflow(workflow, state["connections"], state["ingress"], {}, messages, {"mockResponse": "PRIVATE_BLOCKED_GENERATION"}, inspection=inspection)
    assert result["status"] == "block" and result["output"] == ""
    details = inspection.finalize(result)
    assert "final_response" not in json.dumps(details)
    assert node(details, "main")["output"]["value"] == "PRIVATE_BLOCKED_GENERATION"
    assert node(details, "output")["output"]["value"]["output"] == ""
    assert "PRIVATE_BLOCKED_GENERATION" not in json.dumps(result)
    assert node(details, "main")["output"]["length"] == len("PRIVATE_BLOCKED_GENERATION")


async def test_inspection_cannot_be_requested_through_gateway_or_saved_in_evaluation(console):
    client, store, _, workflow = console
    deployed = await client.post("/api/console", json={"action": "publish", "workflowId": workflow["id"], "acknowledgeUnverified": True, "unverifiedReason": "합성 회귀"})
    assert deployed.status_code == 200, deployed.text
    created_key = await client.post("/api/console", json={"action": "create_key", "name": "합성 테스트 키"})
    assert created_key.status_code == 200, created_key.text
    gateway = {"model": workflow["alias"], "messages": [{"role": "user", "content": "배송 문의"}]}
    headers = {"Authorization": "Bearer " + created_key.json()["key"]}
    denied = await client.post("/v1/chat/completions", headers=headers, json={**gateway, "inspect": True})
    assert denied.status_code == 400 and denied.json()["error"]["code"] == "unsupported_parameter"
    response = await client.post("/v1/chat/completions", headers=headers, json=gateway)
    assert response.status_code == 200, response.text
    assert "inspection" not in response.json() and "traces" not in response.json()
    dataset = {"id": "inspection-fixture-data", "name": "합성 검증", "description": "", "rows": [{"id": "sample", "input": "배송 문의", "expected": "allow"}]}
    saved = await client.post("/api/console", json={"action": "save_dataset", "dataset": dataset})
    assert saved.status_code == 200, saved.text
    evaluated = await client.post("/api/console", json={"action": "run_evaluation", "workflowId": workflow["id"], "datasetId": dataset["id"], "target": "draft", "inspect": True})
    assert evaluated.status_code == 200, evaluated.text
    assert '"inspection"' not in json.dumps(evaluated.json()["run"])
    assert '"inspection"' not in json.dumps((await store.state())["logs"])


async def test_registered_answer_blocked_by_post_is_available_in_admin_action_and_post_input_only():
    state, workflow = switch_fixture()
    workflow["policyRouting"]["graph"]["nodes"][1]["responseText"] = "PRIVATE_REGISTERED_ANSWER"
    workflow["post"] = [group("post-check", "PRIVATE_REGISTERED_ANSWER")]
    messages = [{"role": "user", "content": "배송"}]
    inspection = ConsoleInspection(workflow, messages)
    result = await execute_workflow(workflow, state["connections"], state["ingress"], {}, messages, inspection=inspection)
    details = inspection.finalize(result)
    assert result["status"] == "block" and result["output"] == ""
    assert node(details, "policy-node:action-0")["output"]["value"] == "PRIVATE_REGISTERED_ANSWER"
    assert node(details, "rule:post-check-rule")["input"]["value"]["text"] == "PRIVATE_REGISTERED_ANSWER"
    assert "PRIVATE_REGISTERED_ANSWER" not in json.dumps(result)


async def test_failed_model_does_not_invent_an_output_value():
    state, workflow = fixture_state()
    state["connections"][0].update(mode="vllm", baseUrl="https://model.example/v1")
    state["ingress"]["allowedOrigins"] = ["https://model.example"]
    messages = [{"role": "user", "content": "배송 문의"}]
    inspection = ConsoleInspection(workflow, messages)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(502, text="PRIVATE_FAILURE_BODY"))) as client:
        result = await execute_workflow(workflow, state["connections"], state["ingress"], {}, messages, client=client, inspection=inspection)
    assert result["status"] == "error"
    details = inspection.finalize(result)
    assert node(details, "main")["output"]["availability"] == "not_applicable"
    assert node(details, "output")["input"]["availability"] == "not_applicable"
    assert node(details, "output")["output"]["value"]["status"] == "error"
    assert "PRIVATE_FAILURE_BODY" not in json.dumps(details)


async def test_switch_exact_port_and_policy_json_are_available_only_in_admin_inspection():
    state, workflow = switch_fixture()
    graph = switch_graph(values=["ALLOW", "OTHER"])
    graph["nodes"] = [graph["nodes"][0], graph["nodes"][1], graph["nodes"][-1]]
    graph["edges"][1]["to"] = "action-0"
    workflow["policyRouting"]["graph"] = graph
    policy = workflow["policyRouting"]["policy"]
    policy["outputSchema"]["properties"]["privateDetail"] = {"type": "string"}
    policy["examples"][0]["expectedOutput"]["privateDetail"] = "PRIVATE_CLASSIFIED_JSON"
    messages = [{"role": "user", "content": "배송"}]
    inspection = ConsoleInspection(workflow, messages)
    result = await execute_workflow(workflow, state["connections"], state["ingress"], {}, messages, inspection=inspection)
    assert result["status"] == "allow"
    details = inspection.finalize(result)
    switch = node(details, "policy-node:switch")
    assert switch["selectedPort"] == "case-0" and switch["selectedEdgeIds"] == ["edge-0"]
    assert switch["input"]["value"]["privateDetail"] == "PRIVATE_CLASSIFIED_JSON"
    assert node(details, "policy")["schemaValid"] is True
    assert node(details, "policy")["output"]["value"]["privateDetail"] == "PRIVATE_CLASSIFIED_JSON"
    assert "PRIVATE_CLASSIFIED_JSON" not in json.dumps(result)
    assert "inspection" not in json.dumps(record_log(result, "playground", workflow, "draft"))


async def test_pre_block_explains_skipped_main_and_policy_without_inventing_values():
    state, workflow = switch_fixture()
    workflow["pre"] = [group("pre-check", "차단")]
    messages = [{"role": "user", "content": "차단 요청"}]
    inspection = ConsoleInspection(workflow, messages)
    result = await execute_workflow(workflow, state["connections"], state["ingress"], {}, messages, inspection=inspection)
    details = inspection.finalize(result)
    assert node(details, "main")["status"] == "skipped"
    assert "요청 검사" in node(details, "main")["skipReason"]
    assert node(details, "main")["input"]["availability"] == "not_applicable"
    assert node(details, "policy")["status"] == "skipped"
    assert "schemaValid" not in node(details, "policy")


@pytest.mark.parametrize("kind", ["condition", "fork"])
async def test_condition_and_parallel_join_details_keep_actual_edge_ids_and_skip_metadata(kind):
    state, workflow = fixture_state()
    workflow["pre"] = [group("left", "never-left"), group("right", "never-right")]
    workflow["graph"] = {"version": 1, "pre": {"nodes": [
        {"id": "select", "name": "선택", "kind": kind, **({"condition": {"operator": "contains", "value": "배송"}} if kind == "condition" else {})},
        {"id": "join", "name": "합류", "kind": "join"},
    ], "edges": [
        {"id": "start", "from": "start", "to": "control:select"},
        {"id": "left", "from": "control:select", "to": "group:left", "port": "true" if kind == "condition" else "next"},
        {"id": "right", "from": "control:select", "to": "group:right", "port": "false" if kind == "condition" else "next"},
        {"id": "left-join", "from": "group:left", "to": "control:join"},
        {"id": "right-join", "from": "group:right", "to": "control:join"},
        {"id": "end", "from": "control:join", "to": "end"},
    ]}, "post": create_stage_graph([])}
    messages = [{"role": "user", "content": "배송 문의"}]
    inspection = ConsoleInspection(workflow, messages)
    result = await execute_workflow(workflow, state["connections"], state["ingress"], {}, messages, inspection=inspection)
    assert result["status"] == "allow", result
    details = inspection.finalize(result)
    selection = node(details, "control:select")
    assert selection["selectedEdgeIds"] == (["left"] if kind == "condition" else ["left", "right"])
    assert selection["input"]["value"]["text"] == "배송 문의"
    assert selection["output"]["value"]["edgeIds"] == selection["selectedEdgeIds"]
    assert node(details, "control:join")["status"] == "completed"
    assert node(details, "control:join")["input"]["value"]["incomingEdgeIds"] == (["left-join"] if kind == "condition" else ["left-join", "right-join"])
    if kind == "condition":
        assert selection["selectedPort"] == "true"
        assert selection["output"]["value"]["matched"] is True
        assert node(details, "rule:right-rule")["status"] == "skipped"
        assert "분기" in node(details, "rule:right-rule")["skipReason"]


def test_policy_observer_failure_cannot_change_a_route():
    graph = switch_graph()
    def fail(_):
        raise RuntimeError("observer failure")
    assert execute_policy_graph(graph, {"value": "ALLOW"}, on_step=fail) == execute_policy_graph(graph, {"value": "ALLOW"})


async def test_console_observer_failure_cannot_change_an_execution():
    state, workflow = fixture_state()
    class BrokenObserver:
        def __getattr__(self, _):
            raise RuntimeError("observer failure")
    result = await execute_workflow(workflow, state["connections"], state["ingress"], {}, [{"role": "user", "content": "배송 문의"}], inspection=BrokenObserver())
    assert result["status"] == "allow" and result["output"]


async def test_multiple_policy_checks_keep_owner_json_and_post_attempts_separate():
    from test_policy_check_nodes import fixture, group as policy_group, run
    state, workflow, routing = fixture()
    alternate = copy.deepcopy(routing)
    alternate["policy"]["examples"][0]["expectedOutput"]["private"] = "PRE_B_ONLY"
    denied = copy.deepcopy(routing)
    denied["policy"]["examples"][1]["expectedOutput"]["ok"] = False
    workflow.update(pre=[policy_group("pre-a", routing), policy_group("pre-b", alternate)],
                    post=[policy_group("post-a", denied)], responseRetry={"enabled": True, "maxRetries": 1})
    inspection = ConsoleInspection(workflow, [{"role": "user", "content": "request"}])
    result = await run(state, workflow, inspection=inspection)
    details = inspection.finalize(result)
    assert result["status"] == "block" and result["regenerationCount"] == 1
    assert node(details, "rule:pre-a")["output"]["value"]["private"] == "PRIVATE_JSON"
    assert node(details, "rule:pre-b")["output"]["value"]["private"] == "PRE_B_ONLY"
    for attempt in (1, 2):
        check = node(details, "rule:post-a", attempt)
        assert check["output"]["value"]["ok"] is False
        assert check["schemaValid"] is True
        child = node(details, "policy-node:post-a/check", attempt)
        assert child["status"] == "completed" and child["selectedPort"] == "default"
        assert child["selectedEdgeIds"] == ["other"]
        assert child["input"]["value"] == check["output"]["value"]
        assert node(details, "policy-node:post-a/deny", attempt)["status"] == "block"
        assert node(details, "policy-node:post-a/continue", attempt)["input"]["availability"] == "not_applicable"
    assert "PRIVATE_JSON" not in json.dumps(result)
    assert "PRE_B_ONLY" not in json.dumps(record_log(result, "playground", workflow, "draft"))


@pytest.mark.parametrize("raw", ['{invalid-json', '{"value":"ALLOW","extra":"PRIVATE_INVALID_SCHEMA"}'])
async def test_invalid_policy_model_output_is_only_available_in_admin_inspection(raw):
    state, workflow = switch_fixture(actual=True)
    inspection = ConsoleInspection(workflow, [{"role": "user", "content": "배송"}])
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"choices": [{"message": {"content": raw}, "finish_reason": "stop"}]}))) as client:
        result = await execute_workflow(workflow, state["connections"], state["ingress"], {}, [{"role": "user", "content": "배송"}], client=client, inspection=inspection)
    assert result["status"] == "error" and result["output"] == ""
    details = inspection.finalize(result)
    policy = node(details, "policy")
    assert policy["schemaValid"] is False
    assert policy["output"]["value"] == raw and policy["output"]["type"] == "text"
    assert raw not in json.dumps(result)


async def test_all_rule_inputs_and_verdicts_are_observed_and_transport_secrets_are_not_collected():
    state, workflow = fixture_state()
    workflow["pre"] = [group("first", "not-present")]
    workflow["post"] = [group("last", "also-not-present")]
    state["connections"][0].update(mode="vllm", baseUrl="https://model.example/v1", secretEnv="INSPECTION_MODEL_SECRET")
    state["ingress"]["allowedOrigins"] = ["https://model.example"]
    seen = []
    def respond(request):
        seen.append(request.headers["Authorization"])
        return httpx.Response(200, headers={"X-Private": "RESPONSE_HEADER_SECRET"}, json={"choices": [{"message": {"content": "business answer"}, "finish_reason": "stop"}]})
    inspection = ConsoleInspection(workflow, [{"role": "user", "content": "business input"}])
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await execute_workflow(workflow, state["connections"], state["ingress"], {"INSPECTION_MODEL_SECRET": "SYNTHETIC_MODEL_TOKEN"}, [{"role": "user", "content": "business input"}], {"temperature": .2}, client=client, inspection=inspection)
    details = inspection.finalize(result)
    assert seen == ["Bearer SYNTHETIC_MODEL_TOKEN"]
    assert node(details, "rule:first-rule")["input"]["value"]["parameters"] == {"pattern": "not-present"}
    assert node(details, "rule:first-rule")["output"]["value"]["status"] == "allow"
    assert node(details, "rule:last-rule")["input"]["value"]["text"] == "business answer"
    assert node(details, "main")["input"]["value"]["temperature"] == .2
    encoded = json.dumps(details)
    assert all(secret not in encoded for secret in ("INSPECTION_MODEL_SECRET", "SYNTHETIC_MODEL_TOKEN", "RESPONSE_HEADER_SECRET", "Authorization"))


@pytest.mark.parametrize("raw", ['{"verdict":"allow","reason":"PRIVATE_GUARD_REASON"}', 'PRIVATE_INVALID_GUARD'])
async def test_llm_rule_model_input_and_original_output_are_observed(raw):
    state, workflow = fixture_state()
    guard = state["connections"][1]
    guard.update(mode="vllm", baseUrl="https://guard.example/v1")
    state["ingress"]["allowedOrigins"] = ["https://guard.example"]
    workflow["pre"] = [{"id": "guard", "name": "검사", "mode": "any", "rules": [{
        "id": "guard-rule", "name": "검사", "description": "", "kind": "llm", "enabled": True,
        "config": {"connectionId": guard["id"], "prompt": "PRIVATE_CONFIGURED_GUARD_PROMPT"}}]}]
    inspection = ConsoleInspection(workflow, [{"role": "user", "content": "original input"}])
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"choices": [{"message": {"content": raw}, "finish_reason": "stop"}]}))) as client:
        result = await execute_workflow(workflow, state["connections"], state["ingress"], {}, [{"role": "user", "content": "original input"}], client=client, inspection=inspection)
    details = inspection.finalize(result)
    guard_node = node(details, "rule:guard-rule")
    assert "PRIVATE_CONFIGURED_GUARD_PROMPT" in json.dumps(guard_node["input"]["value"])
    assert guard_node["output"]["value"] == (json.loads(raw) if raw.startswith('{') else raw)
    assert "PRIVATE_CONFIGURED_GUARD_PROMPT" not in json.dumps(result)


def test_inspection_values_preserve_null_false_empty_and_nested_json_exactly():
    _, workflow = fixture_state()
    inspection = ConsoleInspection(workflow, [{"role": "user", "content": "Q"}])
    for value in (None, False, 0, "", [], {}, {"nested": [None, False, 0, "", {"한글": "😀"}]}):
        assert inspection.capture(value)["value"] == value


def test_inspection_raw_capture_and_complete_response_have_explicit_byte_budgets():
    _, workflow = fixture_state()
    inspection = ConsoleInspection(workflow, [{"role": "user", "content": "Q"}])
    inspection.MAX_VALUE_BYTES = 128
    inspection.MAX_TOTAL_BYTES = 4096
    value = inspection.capture({"long": "😀" * 100})
    assert value["truncated"] is True and "value" not in value
    assert len(value["preview"].encode('utf-8')) <= 128
    assert value["originalBytes"] == len(json.dumps({"long": "😀" * 100}, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    for attempt in range(1, 41):
        inspection.main_input([{"role": "user", "content": "Q"}], attempt)
        inspection.response("회차별 원문" * 100, attempt)
    result = {"status": "block", "output": "", "traces": [{"ruleId": "main", "stage": "main", "status": "allow", "attempt": attempt} for attempt in range(1, 41)]}
    details = inspection.finalize(result)
    assert details["truncated"] is True
    assert all(item["output"].get("truncated") for item in details["nodes"] if item["nodeId"] == "main")
    assert len(json.dumps(details, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) <= 4096
    # Production's 8MiB cap includes repeated values and all node metadata.
    production = ConsoleInspection(workflow, [{"role": "user", "content": "Q"}])
    for attempt in range(1, 5):
        production.response("😀" * 100_000, attempt)
    production.stage_input("post", "😀" * 100_000, 1)
    traces = []
    for index in range(100):
        workflow["post"].append(group(str(index), "absent"))
        traces.append({"ruleId": str(index) + "-rule", "groupId": str(index), "stage": "post", "status": "allow", "reason": "완료"})
    production.workflow = copy.deepcopy(workflow)
    details = production.finalize({"status": "block", "output": "", "traces": traces})
    assert len(json.dumps(details, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) <= production.MAX_TOTAL_BYTES
