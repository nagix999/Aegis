"""Ephemeral, allowlisted execution details for the administrator playground.

Only submitted messages and a fully allowed final response may be referenced.
Generated text, classifier JSON and model instructions are never collected.
This object is kept outside ExecutionResult so logs, datasets and Gateway
responses cannot inherit it through their existing trace-copying paths.
"""
from __future__ import annotations

import copy
import time

from .runtime import js_length, request_inspection_text


def _attempt(stage, attempt):
    return int(attempt or 1) if stage in {"main", "post"} else None


def _status(value):
    return "completed" if value == "allow" else value if value in {"completed", "block", "error", "skipped"} else "skipped"


def _value(availability, kind, summary, **metadata):
    return {"availability": availability, "type": kind, "summary": summary, **metadata}


def _none(summary="실행하지 않아 값이 없습니다."):
    return _value("not_applicable", "none", summary)


class ConsoleInspection:
    MAX_NODES = 4096

    def __init__(self, workflow, messages):
        self.workflow = copy.deepcopy(workflow)
        self.messages = [{"role": message["role"], "content": message["content"]} for message in messages]
        self.request_text = request_inspection_text(workflow, messages)
        self.started = time.monotonic()
        self.events = {}
        self.inputs = {}
        self.responses = {}
        self.main_inputs = {}
        self.policy_steps = {}
        self.skips = {}
        self.schema_valid = False

    def progress(self, event):
        stage, node = event["stage"], event["nodeId"]
        if node.startswith("policy:"):
            node = "policy-node:" + node[len("policy:"):]
        key = (stage, node, _attempt(stage, event.get("attempt")))
        current = self.events.setdefault(key, {})
        elapsed = max(0, round((time.monotonic() - self.started) * 1000))
        if event["status"] == "running":
            current.setdefault("startedMs", elapsed)
        else:
            current.update(status=_status(event["status"]), edgeIds=list(event.get("edgeIds", [])), finishedMs=elapsed)

    def stage_input(self, stage, text, attempt):
        # Sizes only: a POST input may later become a blocked response.
        self.inputs[(stage, _attempt(stage, attempt))] = js_length(text)

    def main_input(self, messages, attempt):
        self.main_inputs[_attempt("main", attempt)] = {
            "length": sum(js_length(message["content"]) for message in messages),
            "messageCount": len(messages),
        }

    def response(self, text, attempt):
        self.responses[_attempt("post", attempt)] = js_length(text)

    def policy_validated(self):
        self.schema_valid = True

    def policy_step(self, step):
        # Values used for comparisons are deliberately absent from this event.
        self.policy_steps[step["nodeId"]] = {
            "selectedPort": step["selectedPort"], "selectedEdgeIds": list(step["edgeIds"]),
        }

    def skip(self, stage, node, attempt, reason):
        self.skips[(stage, node, _attempt(stage, attempt))] = reason

    def finalize(self, result):
        nodes = []
        final_attempt = max(self.responses, default=1)
        allowed = result["status"] == "allow"

        def request_input(messages=False):
            if messages:
                return _value("available", "messages", "호출자가 제출한 원래 대화입니다.", source="request_messages",
                              length=sum(js_length(message["content"]) for message in self.messages), messageCount=len(self.messages))
            return _value("available", "text", "설정된 요청 검사 범위로 선택한 내용입니다.", source="request_inspection", length=js_length(self.request_text))

        def response_input(attempt):
            length = self.inputs.get(("post", attempt), self.responses.get(attempt))
            metadata = {"length": length} if length is not None else {}
            if allowed and attempt == final_attempt:
                return _value("available", "text", "모든 응답 검사를 통과한 최종 답변입니다.", source="final_response", **metadata)
            if length is None:
                return _none("응답 생성을 완료하지 않아 출력값이 없습니다.")
            return _value("withheld", "text", "차단되었거나 최종 허용되지 않은 생성 답변은 표시하지 않습니다.", **metadata)

        def status_output(status):
            descriptions = {"completed": "이 노드의 검사를 완료했습니다.", "block": "이 노드에서 정책 위반을 확인했습니다.", "error": "이 노드를 완료하지 못했습니다.", "skipped": "이 노드는 실행하지 않았습니다."}
            return _value("available", "status", descriptions[status]) if status != "skipped" else _none()

        def append(node_id, kind, stage, status, input_value, output_value, *, attempt=None, latency=None, skip_reason=None, **metadata):
            status = _status(status)
            event = self.events.get((stage, node_id, _attempt(stage, attempt)), {})
            value = {"nodeId": node_id, "kind": kind, "stage": stage, "status": status,
                     "input": _none() if status == "skipped" else input_value,
                     "output": _none() if status == "skipped" else output_value, **metadata}
            if stage in {"main", "post"}:
                value["attempt"] = _attempt(stage, attempt)
            if latency is not None:
                value["latencyMs"] = max(0, latency)
            elif "startedMs" in event and "finishedMs" in event:
                value["latencyMs"] = max(0, event["finishedMs"] - event["startedMs"])
            for field in ("startedMs", "finishedMs"):
                if field in event:
                    value[field] = event[field]
            if status == "skipped":
                value["skipReason"] = skip_reason or self.skips.get((stage, node_id, _attempt(stage, attempt))) or "선택되지 않은 경로이거나 앞선 단계에서 종료되어 실행하지 않았습니다."
            if len(nodes) < self.MAX_NODES:
                nodes.append(value)

        append("input", "input", "pre", "completed", request_input(True), request_input())
        traces = result.get("traces", [])
        for stage in ("pre", "post"):
            groups = self.workflow[stage]
            attempts = sorted({(_attempt(stage, trace.get("attempt")) or 0) for trace in traces if trace.get("stage") == stage and trace.get("traceType") != "policy"})
            attempts = sorted(set(attempts) | {(attempt or 0) for event_stage, _, attempt in self.events if event_stage == stage})
            if not attempts:
                attempts = [0 if stage == "pre" else 1]
            for number in attempts:
                attempt = number or None
                input_value = request_input() if stage == "pre" else response_input(attempt)
                for group in groups:
                    group_traces = [trace for trace in traces if trace.get("traceType") != "policy" and trace.get("stage") == stage and trace.get("groupId") == group["id"] and _attempt(stage, trace.get("attempt")) == attempt]
                    event = self.events.get((stage, f'group:{group["id"]}', attempt), {})
                    active = [trace for trace in group_traces if trace["status"] != "skipped"]
                    failed = any(trace["status"] == "error" for trace in active)
                    blocked = [trace for trace in active if trace["status"] == "block"]
                    group_status = event.get("status") or ("error" if failed else "block" if blocked and (group["mode"] == "any" or len(blocked) == len(active)) else "completed" if active else "skipped")
                    skip_reason = next((trace["reason"] for trace in group_traces if trace["status"] == "skipped"), None)
                    append(f'group:{group["id"]}', "group", stage, group_status, input_value, status_output(group_status), attempt=attempt, skip_reason=skip_reason, selectedEdgeIds=list(event.get("edgeIds", [])))
                    for rule in group["rules"]:
                        trace = next((trace for trace in group_traces if trace.get("ruleId") == rule["id"]), None)
                        status = _status(trace["status"]) if trace else "skipped"
                        append(f'rule:{rule["id"]}', "rule", stage, status, input_value, status_output(status), attempt=attempt,
                               latency=trace.get("latencyMs") if trace else None,
                               skip_reason=trace.get("reason") if trace and status == "skipped" else None)
                for control in self.workflow.get("graph", {}).get(stage, {}).get("nodes", []):
                    node_key = f'control:{control["id"]}'
                    event = self.events.get((stage, node_key, attempt), {})
                    status = event.get("status", "skipped")
                    selected = list(event.get("edgeIds", []))
                    graph_edges = self.workflow["graph"][stage]["edges"]
                    ports = [edge.get("port") for edge in graph_edges if edge["id"] in selected]
                    metadata = {"selectedEdgeIds": selected}
                    if control["kind"] == "condition" and len(ports) == 1:
                        metadata["selectedPort"] = ports[0]
                    append(node_key, "control", stage, status, input_value, status_output(status), attempt=attempt, **metadata)

        routing = self.workflow.get("policyRouting")
        if routing:
            policy_traces = [trace for trace in traces if trace.get("traceType") == "policy"]
            policy_event = self.events.get(("pre", "policy", None), {})
            policy_status = policy_event.get("status") or ("completed" if result.get("policyPath") or result.get("policyRoute") else "error" if policy_traces else "skipped")
            policy_metadata = {"schemaValid": True} if self.schema_valid else {}
            append("policy", "policy", "pre", policy_status, request_input(),
                   _value("withheld", "json", "원시 정책 출력은 공개하지 않고 스키마 검증과 선택한 경로만 표시합니다."), **policy_metadata)
            for node in routing.get("graph", {}).get("nodes", []):
                trace = next((trace for trace in policy_traces if trace.get("ruleId") == f'policy:{node["id"]}'), None)
                status = _status(trace["status"]) if trace else "skipped"
                policy_input = _value("withheld", "json", "스키마 검증을 통과한 정책 JSON의 원문은 표시하지 않습니다.")
                output_value = status_output(status)
                if node.get("kind") == "action" and node.get("action") == "respond" and status != "skipped":
                    output_value = response_input(final_attempt)
                append(f'policy-node:{node["id"]}', "policy-node", "pre", status, policy_input, output_value,
                       skip_reason="선택되지 않은 정책 경로입니다." if self.schema_valid else "정책 검사를 완료하기 전에 종료되었습니다.",
                       **self.policy_steps.get(node["id"], {}))

        main_traces = [trace for trace in traces if trace.get("ruleId") == "main" and trace.get("stage") == "main"]
        for trace in main_traces or [{"status": "skipped", "reason": "응답 생성 모델을 실행하지 않았습니다."}]:
            attempt = _attempt("main", trace.get("attempt"))
            input_value = request_input(True) if attempt == 1 else _value("withheld", "messages", "재작성 지시를 포함한 모델 입력 원문은 표시하지 않습니다.", **self.main_inputs.get(attempt, {}))
            append("main", "main", "main", trace["status"], input_value, response_input(attempt), attempt=attempt,
                   latency=trace.get("latencyMs"), skip_reason=trace.get("reason"))
        final_value = response_input(final_attempt)
        append("output", "output", "complete", "completed" if allowed else result["status"], final_value, final_value)
        return {"request": {"messages": copy.deepcopy(self.messages), "inputScope": self.workflow.get("inputScope", "conversation"), "inspectionText": self.request_text},
                "nodes": nodes, **({"truncated": True} if len(nodes) >= self.MAX_NODES else {})}
