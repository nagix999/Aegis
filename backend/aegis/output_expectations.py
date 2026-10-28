"""Bounded comparison over in-memory policy JSON; verdicts never include values."""
from __future__ import annotations

from .policy_graph import OPERATORS, predicate_matches, pointer_tokens, validate_policy_graph
from .structured_schema import strict_json_equal, validate_json_value


def validate_field_assertions(fields: list, schema: dict | None = None) -> None:
    if not isinstance(fields, list) or not 1 <= len(fields) <= 12:
        raise ValueError("정책 출력 필드 조건은 1~12개를 지정하세요.")
    for field in fields:
        if not isinstance(field, dict) or set(field) - {"path", "operator", "value"} or field.get("operator") not in OPERATORS:
            raise ValueError("정책 출력 필드 조건의 형식을 확인하세요.")
        pointer_tokens(field.get("path"))
        operator, value = field["operator"], field.get("value")
        if "value" in field:
            validate_json_value(value, max_bytes=4096)
        if operator == "exists":
            if "value" in field and type(value) is not bool:
                raise ValueError("존재 여부 조건에는 불리언 값을 지정하세요.")
        elif "value" not in field:
            raise ValueError("정책 출력 필드 조건에 비교값이 필요합니다.")
        elif operator in {"gt", "gte", "lt", "lte"}:
            if type(value) not in {int, float} or abs(value) > 9007199254740991:
                raise ValueError("숫자 비교값을 확인하세요.")
        elif operator == "in" and (not isinstance(value, list) or not 1 <= len(value) <= 64):
            raise ValueError("목록 비교에는 1~64개 값을 지정하세요.")
    if schema is not None:
        # Reuse the existing typed routing contract without introducing a second
        # expression language. Both branches point to a harmless terminal node.
        graph = {"version": 1, "entryNodeId": "check", "nodes": [
            {"id": "check", "kind": "branch", "name": "check", "condition": {"mode": "all", "predicates": fields}},
            {"id": "done", "kind": "action", "name": "done", "action": "main"}],
            "edges": [{"id": port, "from": "check", "to": "done", "port": port} for port in ("true", "false")]}
        if validate_policy_graph(graph, schema):
            raise ValueError("출력 필드 경로와 비교값을 정책 스키마에 맞게 지정하세요.")


def check_policy_fields(output, fields: list, *, available: bool = True) -> list[dict]:
    """Only caller-authored paths and booleans leave this function."""
    validate_field_assertions(fields)
    return [{"path": field["path"], "matched": bool(available and predicate_matches(field, output))} for field in fields]


def compare_policy_example(output, example: dict) -> dict:
    expectation = example.get("expectation") or {"mode": "exact"}
    mode = expectation["mode"]
    if mode == "fields":
        checks = check_policy_fields(output, expectation["fields"])
        matched = all(check["matched"] for check in checks)
        return {"expectationMatched": matched, "checks": checks}
    # classify_policy_output already validates the complete registered schema.
    matched = mode == "schema" or strict_json_equal(output, example["expectedOutput"])
    return {"expectationMatched": matched, "checks": []}
