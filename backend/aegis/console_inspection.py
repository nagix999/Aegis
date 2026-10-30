"""Bounded business I/O for the administrator's ephemeral playground inspector.

Separate from ExecutionResult and persisted Trace. This collector never accepts
connections, environment variables, HTTP headers or authentication objects.
"""
from __future__ import annotations

import copy
import json
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


def _encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _policy_parameters(policy):
    # A policy snapshot contains connection metadata. Copy business fields only.
    return {key: copy.deepcopy(policy[key]) for key in
            ("id", "version", "prompt", "formatVersion", "outputSchema", "maxOutputTokens", "decisions") if key in policy}


class ConsoleInspection:
    MAX_NODES = 4096
    MAX_VALUE_BYTES = 256 * 1024
    MAX_TOTAL_BYTES = 8 * 1024 * 1024

    def __init__(self, workflow, messages):
        self.workflow = copy.deepcopy(workflow)
        self.messages = [{"role": message["role"], "content": message["content"]} for message in messages]
        self.request_text = request_inspection_text(workflow, messages)
        self.started = time.monotonic()
        self.events, self.inputs, self.responses, self.main_inputs = {}, {}, {}, {}
        self.rule_inputs, self.rule_outputs, self.rule_raw = {}, {}, {}
        self.control_inputs, self.control_outputs = {}, {}
        self.policy_inputs, self.policy_outputs, self.policy_raw, self.policy_steps = {}, {}, {}, {}
        self.schema_valid, self.skips = {}, {}
        self.captured_bytes = 0
        self.truncated = False

    def capture(self, payload, kind="json", summary="실제로 처리한 JSON 값입니다.", **metadata):
        """Bound data during observation, before another node or retry retains it."""
        text = _encoded(payload)
        raw = text.encode("utf-8")
        size = len(raw)
        budget = max(0, min(self.MAX_VALUE_BYTES, self.MAX_TOTAL_BYTES - self.captured_bytes))
        value = _value("available", kind, summary, **metadata)
        if size <= budget:
            value["value"] = copy.deepcopy(payload)
            self.captured_bytes += size
        else:
            preview = raw[:budget].decode("utf-8", errors="ignore")
            value.update(truncated=True, originalChars=js_length(text), originalBytes=size,
                         summary=summary + " 표시 한도를 초과해 원문 일부를 생략했습니다.")
            if preview:
                value["preview"] = preview
                self.captured_bytes += len(preview.encode("utf-8"))
            self.truncated = True
        return value

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
        self.inputs[(stage, _attempt(stage, attempt))] = self.capture(text, "text", "이 단계가 실제로 검사한 텍스트입니다.", length=js_length(text))

    def main_input(self, messages, attempt, settings=None):
        payload = {"messages": [{"role": item["role"], "content": item["content"]} for item in messages]}
        if settings:
            payload.update({key: copy.deepcopy(settings[key]) for key in ("model", "temperature", "max_tokens", "top_p") if key in settings})
        self.main_inputs[_attempt("main", attempt)] = self.capture(payload, "json", "이 회차의 응답 모델에 전달한 메시지와 생성 설정입니다.",
            length=sum(js_length(item["content"]) for item in messages), messageCount=len(messages),
            **({"source": "request_messages"} if _attempt("main", attempt) == 1 else {}))

    def response(self, text, attempt):
        self.responses[_attempt("post", attempt)] = self.capture(text, "text", "이 회차에서 생성하거나 선택한 응답 원문입니다.", length=js_length(text))

    def rule_input(self, stage, rule, group, text, attempt):
        config = rule.get("config", {})
        parameters = {key: copy.deepcopy(config[key]) for key in
                      ("pattern", "maxLength", "prompt", "piiTypes", "requiredKeys", "jsonMode", "matchMode", "guardProfile") if key in config}
        if rule.get("kind") == "policy" and config.get("policyRouting"):
            parameters["policy"] = _policy_parameters(config["policyRouting"]["policy"])
        self.rule_inputs[(stage, rule["id"], _attempt(stage, attempt))] = self.capture({"text": text, "parameters": parameters,
            "group": {"id": group["id"], "mode": group["mode"]}}, "json", "검사한 텍스트와 실제 검사 설정입니다.", length=js_length(text))

    def rule_output(self, stage, rule, group, verdict, attempt):
        self.rule_outputs[(stage, rule["id"], _attempt(stage, attempt))] = self.capture(verdict, "json", "이 검사의 실제 판정 결과입니다.")

    def rule_model_input(self, payload, stage, rule_id, attempt):
        safe = {key: copy.deepcopy(payload[key]) for key in
                ("model", "messages", "temperature", "max_tokens", "top_p") if key in payload}
        self.rule_inputs[(stage, rule_id, _attempt(stage, attempt))] = self.capture(safe, "json", "검사 모델에 실제로 전달한 업무 요청입니다.")

    def rule_raw_output(self, raw, stage, rule_id, attempt, valid):
        value = raw
        if valid:
            try:
                value = json.loads(raw)
            except (ValueError, TypeError):
                pass  # Llama Guard text is a supported non-JSON model output.
        self.rule_raw[(stage, rule_id, _attempt(stage, attempt))] = self.capture(value, "text" if isinstance(value, str) else "json",
            "검사 모델이 반환한 원문입니다." if valid else "검사 결과 검증에 실패한 모델 출력 원문입니다.")

    def control_input(self, stage, node, payload, attempt):
        key = node.get("id") if isinstance(node, dict) else node
        self.control_inputs[(stage, key, _attempt(stage, attempt))] = self.capture(payload)

    def control_output(self, stage, node, payload, attempt):
        key = node.get("id") if isinstance(node, dict) else node
        self.control_outputs[(stage, key, _attempt(stage, attempt))] = self.capture(payload)

    def policy_input(self, payload, stage="pre", owner_rule_id=None, attempt=None):
        # A second projection prevents newly added transport fields leaking.
        safe = {key: copy.deepcopy(payload[key]) for key in
                ("model", "messages", "text", "prompt", "outputSchema", "maxOutputTokens", "temperature", "max_tokens", "response_format") if key in payload}
        self.policy_inputs[(stage, owner_rule_id, _attempt(stage, attempt))] = self.capture(safe)

    def policy_validated(self, stage="pre", owner_rule_id=None, attempt=None):
        self.schema_valid[(stage, owner_rule_id, _attempt(stage, attempt))] = True

    def policy_output(self, output, stage="pre", owner_rule_id=None, attempt=None):
        key = (stage, owner_rule_id, _attempt(stage, attempt))
        self.policy_outputs[key] = self.capture(output, "json", "스키마 검증을 통과한 정책 JSON 원문입니다.")
        self.schema_valid[key] = True

    def policy_raw_output(self, raw, stage="pre", owner_rule_id=None, attempt=None, valid=False):
        key = (stage, owner_rule_id, _attempt(stage, attempt))
        self.schema_valid[key] = bool(valid)
        if not valid:
            self.policy_raw[key] = self.capture(raw, "text", "JSON 구문 또는 스키마 검증에 실패한 정책 모델의 출력 원문입니다.", length=js_length(raw))

    def policy_step(self, step, stage="pre", owner_rule_id=None, attempt=None):
        self.policy_steps[(stage, owner_rule_id, step["nodeId"], _attempt(stage, attempt))] = {
            "selectedPort": step["selectedPort"], "selectedEdgeIds": list(step["edgeIds"])}

    def skip(self, stage, node, attempt, reason):
        self.skips[(stage, node, _attempt(stage, attempt))] = reason

    def finalize(self, result):
        nodes = []
        final_attempt = max(self.responses, default=1)
        allowed = result["status"] == "allow"
        sent_bytes = 0

        def bounded(value):
            # Charge repeated wire occurrences: Python object sharing is not JSON sharing.
            nonlocal sent_bytes
            value = copy.deepcopy(value)
            if "value" not in value and "preview" not in value:
                return value
            text = _encoded(value["value"]) if "value" in value else value["preview"]
            size = len(text.encode("utf-8"))
            budget = max(0, min(self.MAX_VALUE_BYTES, self.MAX_TOTAL_BYTES - sent_bytes))
            if size > budget:
                value.pop("value", None)
                value.pop("preview", None)
                preview = text.encode("utf-8")[:budget].decode("utf-8", errors="ignore")
                if preview:
                    value["preview"] = preview
                value.update(truncated=True, originalChars=value.get("originalChars", js_length(text)), originalBytes=value.get("originalBytes", size))
                self.truncated = True
                size = len(preview.encode("utf-8"))
            sent_bytes += size
            return value

        request_messages = self.capture(self.messages, "messages", "호출자가 제출한 원래 대화입니다.", source="request_messages",
            length=sum(js_length(item["content"]) for item in self.messages), messageCount=len(self.messages))
        request_text = self.capture(self.request_text, "text", "설정된 요청 검사 범위로 선택한 내용입니다.", source="request_inspection", length=js_length(self.request_text))

        def response_input(attempt):
            value = self.responses.get(attempt)
            if value is None:
                return _none("응답 생성을 완료하지 않아 출력값이 없습니다.")
            value = copy.deepcopy(value)
            if allowed and attempt == final_attempt:
                value.update(source="final_response", summary="응답 검사를 통과한 최종 답변입니다.")
            return value

        def status_output(status):
            return self.capture({"status": status}, "json", "이 노드의 처리 상태입니다.") if status != "skipped" else _none()

        def append(node_id, kind, stage, status, input_value, output_value, *, attempt=None, latency=None, skip_reason=None, **metadata):
            status = _status(status)
            event = self.events.get((stage, node_id, _attempt(stage, attempt)), {})
            value = {"nodeId": node_id, "kind": kind, "stage": stage, "status": status,
                     "input": _none() if status == "skipped" else bounded(input_value),
                     "output": _none() if status == "skipped" else bounded(output_value), **metadata}
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
            else:
                self.truncated = True

        append("input", "input", "pre", "completed", request_messages, request_text)
        traces = result.get("traces", [])
        for stage in ("pre", "post"):
            attempts = {(_attempt(stage, trace.get("attempt")) or 0) for trace in traces if trace.get("stage") == stage}
            attempts |= {(attempt or 0) for event_stage, _, attempt in self.events if event_stage == stage}
            for number in sorted(attempts or {0 if stage == "pre" else 1}):
                attempt = number or None
                stage_input = self.inputs.get((stage, attempt), request_text if stage == "pre" else response_input(attempt))
                for group in self.workflow[stage]:
                    group_traces = [trace for trace in traces if trace.get("traceType") != "policy" and trace.get("stage") == stage and trace.get("groupId") == group["id"] and _attempt(stage, trace.get("attempt")) == attempt]
                    event = self.events.get((stage, f'group:{group["id"]}', attempt), {})
                    active = [trace for trace in group_traces if trace["status"] != "skipped"]
                    blocked = [trace for trace in active if trace["status"] == "block"]
                    group_status = event.get("status") or ("error" if any(trace["status"] == "error" for trace in active) else "block" if blocked and (group["mode"] == "any" or len(blocked) == len(active)) else "completed" if active else "skipped")
                    group_output = self.capture({"status": group_status, "rules": group_traces, "selectedEdgeIds": list(event.get("edgeIds", []))})
                    append(f'group:{group["id"]}', "group", stage, group_status, stage_input, group_output, attempt=attempt,
                           skip_reason=next((trace["reason"] for trace in group_traces if trace["status"] == "skipped"), None), selectedEdgeIds=list(event.get("edgeIds", [])))
                    for rule in group["rules"]:
                        key = (stage, rule["id"], attempt)
                        trace = next((trace for trace in group_traces if trace.get("ruleId") == rule["id"]), None)
                        status = _status(trace["status"]) if trace else "skipped"
                        output = self.rule_raw.get(key, self.rule_outputs.get(key))
                        if output is None:
                            output = status_output(status)
                        routing = rule.get("config", {}).get("policyRouting") if rule.get("kind") == "policy" else None
                        if routing:
                            output = self.policy_outputs.get(key, self.policy_raw.get(key, output))
                        append(f'rule:{rule["id"]}', "policy" if routing else "rule", stage, status,
                               self.policy_inputs.get(key, self.rule_inputs.get(key, stage_input)) if routing else self.rule_inputs.get(key, stage_input), output,
                               attempt=attempt, latency=trace.get("latencyMs") if trace else None,
                               skip_reason=trace.get("reason") if trace and status == "skipped" else None,
                               **({"schemaValid": self.schema_valid[key]} if key in self.schema_valid else {}))
                for control in self.workflow.get("graph", {}).get(stage, {}).get("nodes", []):
                    node_key = f'control:{control["id"]}'
                    event = self.events.get((stage, node_key, attempt), {})
                    status, selected = event.get("status", "skipped"), list(event.get("edgeIds", []))
                    ports = [edge.get("port") for edge in self.workflow["graph"][stage]["edges"] if edge["id"] in selected]
                    metadata = {"selectedEdgeIds": selected}
                    if control["kind"] == "condition" and len(ports) == 1:
                        metadata["selectedPort"] = ports[0]
                    control_input = self.control_inputs.get((stage, control["id"], attempt), self.control_inputs.get((stage, node_key, attempt), stage_input))
                    control_output = self.control_outputs.get((stage, control["id"], attempt), self.control_outputs.get((stage, node_key, attempt)))
                    append(node_key, "control", stage, status, control_input, control_output if control_output is not None else status_output(status), attempt=attempt, **metadata)

        routings = []
        if self.workflow.get("policyRouting"):
            routings.append(("pre", None, None, self.workflow["policyRouting"]))
        for stage in ("pre", "post"):
            for group in self.workflow[stage]:
                for rule in group["rules"]:
                    routing = rule.get("config", {}).get("policyRouting") if rule.get("kind") == "policy" else None
                    if routing:
                        attempts = {attempt for current_stage, owner, attempt in self.schema_valid if current_stage == stage and owner == rule["id"]}
                        attempts |= {_attempt(stage, trace.get("attempt")) for trace in traces if trace.get("stage") == stage and trace.get("ruleId") == rule["id"]}
                        routings.extend((stage, rule["id"], attempt, routing) for attempt in sorted(attempts or {_attempt(stage, None)}, key=lambda value: value or 0))
        for stage, owner, attempt, routing in routings:
            key = (stage, owner, attempt)
            policy_traces = [trace for trace in traces if trace.get("traceType") == "policy" and trace.get("stage") == stage and _attempt(stage, trace.get("attempt")) == attempt]
            valid = self.schema_valid.get(key)
            policy_output = self.policy_outputs.get(key, self.policy_raw.get(key, _none("정책 모델 출력을 관찰하지 못했습니다.")))
            if owner is None:
                event = self.events.get((stage, "policy", attempt), {})
                status = event.get("status") or ("completed" if result.get("policyPath") or result.get("policyRoute") else "error" if policy_traces else "skipped")
                payload = {"text": self.request_text, **_policy_parameters(routing["policy"])}
                policy_input = self.policy_inputs[key] if key in self.policy_inputs else self.capture(payload)
                append("policy", "policy", stage, status, policy_input, policy_output, **({"schemaValid": valid} if valid is not None else {}))
            for policy_node in routing.get("graph", {}).get("nodes", []):
                local_id = f'{owner}/{policy_node["id"]}' if owner is not None else policy_node["id"]
                trace = next((trace for trace in policy_traces if trace.get("ruleId") == f'policy:{local_id}'), None)
                status = _status(trace["status"]) if trace else "skipped"
                step = self.policy_steps.get((stage, owner, policy_node["id"], attempt), {})
                action = {field: copy.deepcopy(policy_node[field]) for field in ("action", "responseText", "errorCode", "errorMessage") if field in policy_node}
                output = self.capture({**action, **step}, "json", "이 정책 노드가 선택한 경로와 액션입니다.") if step or action else status_output(status)
                if policy_node.get("action") == "respond" and status != "skipped" and "responseText" in policy_node:
                    output = self.capture(policy_node["responseText"], "text", "정책 액션이 선택한 등록 응답 원문입니다.", length=js_length(policy_node["responseText"]))
                append(f'policy-node:{local_id}', "policy-node", stage, status,
                       self.policy_outputs.get(key, _none("검증을 통과한 정책 JSON 입력이 없습니다.")), output,
                       attempt=attempt, skip_reason="선택되지 않은 정책 경로입니다." if valid else "정책 검사를 완료하기 전에 종료되었습니다.", **step)

        main_traces = [trace for trace in traces if trace.get("ruleId") == "main" and trace.get("stage") == "main"]
        for trace in main_traces or [{"status": "skipped", "reason": "응답 생성 모델을 실행하지 않았습니다."}]:
            attempt = _attempt("main", trace.get("attempt"))
            append("main", "main", "main", trace["status"], self.main_inputs.get(attempt, _none("모델 입력을 관찰하지 못했습니다.")), response_input(attempt),
                   attempt=attempt, latency=trace.get("latencyMs"), skip_reason=trace.get("reason"))
        final_value = self.capture({"status": result["status"], "output": result.get("output", ""),
            **{key: result[key] for key in ("reason", "finishReason", "policyCode", "publicMessage") if key in result}}, "json", "호출자에게 실제로 반환하는 업무 결과입니다.")
        append("output", "output", "complete", "completed" if allowed else result["status"], response_input(final_attempt), final_value)
        details = {"request": {"messages": copy.deepcopy(self.messages), "inputScope": self.workflow.get("inputScope", "conversation"), "inspectionText": self.request_text}, "nodes": nodes}
        if self.truncated:
            details["truncated"] = True
        # Include repeated raw fields and metadata in the final wire size budget.
        size = len(_encoded(details).encode("utf-8"))
        if size > self.MAX_TOTAL_BYTES:
            for item in reversed(nodes):
                for field in ("output", "input"):
                    value = item[field]
                    if "value" not in value and "preview" not in value:
                        continue
                    before = len(_encoded(value).encode("utf-8"))
                    raw = _encoded(value["value"]) if "value" in value else value["preview"]
                    value.pop("value", None)
                    value.pop("preview", None)
                    value.update(truncated=True, originalChars=value.get("originalChars", js_length(raw)), originalBytes=value.get("originalBytes", len(raw.encode("utf-8"))))
                    size -= before - len(_encoded(value).encode("utf-8"))
                    self.truncated = True
                    if size <= self.MAX_TOTAL_BYTES - 64:
                        break
                if size <= self.MAX_TOTAL_BYTES - 64:
                    break
        # Large numbers of skipped nodes or edge IDs can exhaust the budget
        # through metadata alone. Do not rely only on trimming raw value fields.
        while size > self.MAX_TOTAL_BYTES - 64 and nodes:
            removed = nodes.pop()
            size -= len(_encoded(removed).encode("utf-8")) + (1 if nodes else 0)
            self.truncated = True
        if self.truncated:
            details["truncated"] = True
        return details
