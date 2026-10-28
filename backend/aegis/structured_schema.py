"""Offline, bounded JSON Schema 2020-12 validation for policy model outputs.

The accepted keyword subset is explicit. References never fetch remote resources,
recursive schemas are rejected, and every model output remains internal data.
"""
from __future__ import annotations

from contextvars import ContextVar
from copy import deepcopy
from decimal import Decimal, localcontext
import json
import math
import time
from typing import Any
from urllib.parse import unquote

import regex
from jsonschema import Draft202012Validator, ValidationError, validators
from referencing import Registry

MAX_SCHEMA_BYTES = 32768
MAX_OUTPUT_BYTES = 65536
MAX_SCHEMA_DEPTH = 12
MAX_SCHEMA_NODES = 256
MAX_OUTPUT_DEPTH = 20
MAX_OUTPUT_NODES = 4096
MAX_SCHEMA_REFS = 32
MAX_COMBINATOR_BRANCHES = 64
MAX_EXPANDED_SCHEMA_NODES = 2048
MAX_JSON_NUMBER = 9007199254740991
JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"

SCHEMA_MAPS = {"properties", "patternProperties", "$defs", "dependentSchemas"}
SCHEMA_SINGLE = {"items", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else"}
SCHEMA_ARRAYS = {"prefixItems", "anyOf", "oneOf", "allOf"}
SUPPORTED_KEYWORDS = SCHEMA_MAPS | SCHEMA_SINGLE | SCHEMA_ARRAYS | {
    "$schema", "$ref", "title", "description", "$comment", "default", "examples",
    "type", "enum", "const", "required", "dependentRequired", "minProperties", "maxProperties",
    "minItems", "maxItems", "minContains", "maxContains", "uniqueItems", "minLength", "maxLength", "pattern",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
}


def validate_json_value(value: Any, *, max_bytes: int = MAX_OUTPUT_BYTES) -> Any:
    """Reject non-JSON Python values, nonfinite numbers and excessive nesting."""
    count = 0
    def visit(part, depth):
        nonlocal count
        count += 1
        if count > MAX_OUTPUT_NODES or depth > MAX_OUTPUT_DEPTH:
            raise ValueError("JSON의 깊이 또는 항목 수 제한을 초과했습니다.")
        if part is None or type(part) in (bool, str):
            if isinstance(part, str):
                part.encode("utf-8")
            return
        if type(part) in (int, float):
            if type(part) is float and not math.isfinite(part) or abs(part) > MAX_JSON_NUMBER:
                raise ValueError("JSON 숫자는 유한한 값이며 절댓값이 9,007,199,254,740,991 이하여야 합니다.")
            return
        if type(part) is list:
            for child in part:
                visit(child, depth + 1)
            return
        if type(part) is dict and all(type(key) is str for key in part):
            for key, child in part.items():
                key.encode("utf-8")
                visit(child, depth + 1)
            return
        raise ValueError("올바른 JSON 값이 필요합니다.")
    try:
        visit(value, 0)
        if len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")) > max_bytes:
            raise ValueError("JSON 크기 제한을 초과했습니다.")
    except (UnicodeError, OverflowError, RecursionError):
        raise ValueError("JSON 문자 또는 크기 제한을 확인하세요.") from None
    return value


def strict_json_equal(left: Any, right: Any) -> bool:
    """JSON semantic equality, including 1 == 1.0 but excluding True == 1."""
    if type(left) in (int, float) and type(right) in (int, float):
        return (type(left) is int or math.isfinite(left)) and (type(right) is int or math.isfinite(right)) and left == right
    if type(left) is not type(right):
        return False
    if type(left) is dict:
        return left.keys() == right.keys() and all(strict_json_equal(left[key], right[key]) for key in left)
    if type(left) is list:
        return len(left) == len(right) and all(strict_json_equal(a, b) for a, b in zip(left, right))
    return left == right


def _pointer(root: dict, reference: str):
    if not isinstance(reference, str) or not reference.startswith("#/$defs/") or len(reference) > 512:
        raise ValueError("$ref는 현재 스키마의 $defs를 가리키는 로컬 참조만 지원합니다.")
    target: Any = root
    # Match referencing's URI-fragment decoding before splitting Pointer parts.
    # Otherwise percent-encoded aliases could hide a reference cycle.
    for token in unquote(reference[2:]).split("/"):
        if regex.search(r"~(?![01])", token):
            raise ValueError("$ref의 JSON Pointer를 확인하세요.")
        token = token.replace("~1", "/").replace("~0", "~")
        if isinstance(target, dict) and token in target:
            target = target[token]
        elif isinstance(target, list) and token.isdigit() and str(int(token)) == token and int(token) < len(target):
            target = target[int(token)]
        else:
            raise ValueError("$ref가 가리키는 정의를 찾을 수 없습니다.")
    return target


def _pattern(pattern):
    if not isinstance(pattern, str) or len(pattern) > 256:
        raise ValueError("정규식은 최대 256자까지 지원합니다.")
    try:
        return regex.compile(pattern, regex.VERSION1)
    except regex.error:
        raise ValueError("정규식 문법을 확인하세요.") from None


def validate_output_schema(schema: dict) -> dict:
    if type(schema) is not dict:
        raise ValueError("출력 스키마는 JSON Schema 객체여야 합니다.")
    validate_json_value(schema, max_bytes=MAX_SCHEMA_BYTES)
    objects: dict[int, Any] = {}
    children: dict[int, list[int]] = {}
    references: list[tuple[int, str]] = []
    combinators = 0
    def visit(node, depth):
        nonlocal combinators
        if type(node) not in (dict, bool):
            raise ValueError("하위 스키마는 객체 또는 boolean이어야 합니다.")
        if depth > MAX_SCHEMA_DEPTH or len(objects) >= MAX_SCHEMA_NODES:
            raise ValueError("스키마 깊이 또는 항목 수 제한을 초과했습니다.")
        # bool singletons can occur in many positions without adding work.
        key = id(node)
        if key in objects:
            return key
        objects[key] = node
        children[key] = []
        if type(node) is bool:
            return key
        unknown = set(node) - SUPPORTED_KEYWORDS
        if unknown:
            raise ValueError("지원하지 않는 JSON Schema 키워드가 있습니다: " + ", ".join(sorted(unknown)[:3]))
        if "$schema" in node and (depth != 0 or node["$schema"] != JSON_SCHEMA_DIALECT):
            raise ValueError("JSON Schema Draft 2020-12만 지원합니다.")
        if "$ref" in node:
            references.append((key, node["$ref"]))
            if len(references) > MAX_SCHEMA_REFS:
                raise ValueError("스키마 참조는 최대 32개까지 지원합니다.")
        if "pattern" in node:
            _pattern(node["pattern"])
        if "enum" in node and (not isinstance(node["enum"], list) or not 1 <= len(node["enum"]) <= 32):
            raise ValueError("enum은 1~32개 값으로 작성하세요.")
        for keyword in SCHEMA_MAPS:
            if keyword not in node:
                continue
            mapping = node[keyword]
            if not isinstance(mapping, dict) or len(mapping) > 64:
                raise ValueError("스키마 속성 또는 정의는 최대 64개까지 지원합니다.")
            for name, child in mapping.items():
                if keyword == "patternProperties":
                    _pattern(name)
                children[key].append(visit(child, depth + 1))
        for keyword in SCHEMA_SINGLE:
            if keyword in node:
                children[key].append(visit(node[keyword], depth + 1))
        for keyword in SCHEMA_ARRAYS:
            if keyword not in node:
                continue
            parts = node[keyword]
            if not isinstance(parts, list) or not 1 <= len(parts) <= 12:
                raise ValueError("스키마 조합 또는 배열 앞부분은 1~12개로 작성하세요.")
            combinators += len(parts)
            if combinators > MAX_COMBINATOR_BRANCHES:
                raise ValueError("스키마 조합 수 제한을 초과했습니다.")
            children[key].extend(visit(child, depth + 1) for child in parts)
        return key
    root_key = visit(schema, 0)
    for source, reference in references:
        target = _pointer(schema, reference)
        if id(target) not in objects:
            raise ValueError("$ref는 스키마 정의를 가리켜야 합니다.")
        children[source].append(id(target))
    costs, heights = {}, {}
    visiting = set()
    def cost(key, depth):
        if key in visiting:
            raise ValueError("재귀 스키마 참조는 지원하지 않습니다.")
        if depth > MAX_SCHEMA_DEPTH * 2:
            raise ValueError("참조를 펼친 스키마가 너무 깊습니다.")
        if key in costs:
            if depth + heights[key] > MAX_SCHEMA_DEPTH * 2:
                raise ValueError("참조를 펼친 스키마가 너무 깊습니다.")
            return costs[key]
        visiting.add(key)
        total = 1 + sum(cost(child, depth + 1) for child in children[key])
        visiting.remove(key)
        if total > MAX_EXPANDED_SCHEMA_NODES:
            raise ValueError("참조와 조합을 펼친 스키마가 너무 큽니다.")
        costs[key] = total
        heights[key] = 1 + max((heights[child] for child in children[key]), default=0)
        return total
    cost(root_key, 0)
    try:
        Draft202012Validator.check_schema(schema)
    except Exception:
        raise ValueError("JSON Schema의 키워드 값과 자료형을 확인하세요.") from None
    return deepcopy(schema)


class _Budget:
    def __init__(self):
        self.deadline = time.monotonic() + 0.1
        self.steps = 0
    def tick(self):
        self.steps += 1
        if self.steps > 10000 or time.monotonic() > self.deadline:
            raise ValueError("출력 스키마 검증 실행 제한을 초과했습니다.")


_budget: ContextVar[_Budget | None] = ContextVar("policy_schema_budget", default=None)


def _search(pattern, value):
    budget = _budget.get()
    if budget:
        budget.tick()
    try:
        return _pattern(pattern).search(value, timeout=0.005) is not None
    except TimeoutError:
        raise ValueError("출력 스키마 정규식 실행 제한을 초과했습니다.") from None


def _validate_pattern(validator, pattern, instance, schema):
    if isinstance(instance, str) and not _search(pattern, instance):
        yield ValidationError("문자열 형식이 일치하지 않습니다.")


def _pattern_properties(validator, patterns, instance, schema):
    if not isinstance(instance, dict):
        return
    for pattern, subschema in patterns.items():
        for name, value in instance.items():
            if _search(pattern, name):
                yield from validator.descend(value, subschema, path=name, schema_path=pattern)


def _additional_properties(validator, additional, instance, schema):
    if not isinstance(instance, dict):
        return
    for name, value in instance.items():
        if name in schema.get("properties", {}) or any(_search(pattern, name) for pattern in schema.get("patternProperties", {})):
            continue
        if additional is False:
            yield ValidationError("정의하지 않은 속성이 포함되어 있습니다.")
        elif isinstance(additional, dict):
            yield from validator.descend(value, additional, path=name)


def _canonical(value):
    if type(value) is dict:
        return ("object", frozenset((key, _canonical(part)) for key, part in value.items()))
    if type(value) is list:
        return ("array", tuple(_canonical(part) for part in value))
    if type(value) in (int, float):
        return ("number", value)
    return (type(value).__name__, value)


def _unique_items(validator, unique, instance, schema):
    if unique and isinstance(instance, list):
        seen = set()
        for value in instance:
            if _budget.get():
                _budget.get().tick()
            key = _canonical(value)
            if key in seen:
                yield ValidationError("배열에 중복된 값이 있습니다.")
                return
            seen.add(key)


def _multiple_of(validator, divisor, instance, schema):
    if type(instance) not in (int, float):
        return
    value, denominator = Decimal(str(instance)), Decimal(str(divisor))
    with localcontext() as context:
        context.prec = max(64, len(value.as_tuple().digits) + len(denominator.as_tuple().digits) + abs(value.adjusted() - denominator.adjusted()) + 4)
        if value % denominator != 0:
            yield ValidationError("숫자의 배수 조건과 일치하지 않습니다.")


def _bounded(check):
    def run(validator, value, instance, schema):
        budget = _budget.get()
        if budget:
            budget.tick()
        yield from check(validator, value, instance, schema)
        if budget:
            budget.tick()
    return run


_checks = dict(Draft202012Validator.VALIDATORS)
_checks.update(pattern=_validate_pattern, patternProperties=_pattern_properties, additionalProperties=_additional_properties, uniqueItems=_unique_items, multipleOf=_multiple_of)
BoundedValidator = validators.extend(Draft202012Validator, {key: _bounded(check) for key, check in _checks.items()})


def schema_matches(value: Any, schema: dict | bool, root_schema: dict | None = None) -> bool:
    validate_json_value(value)
    token = _budget.set(_Budget())
    try:
        # A dialect annotation must not cause jsonschema.evolve to switch to its
        # unrestricted built-in validator. The approved dialect is fixed above.
        source = root_schema if root_schema is not None else schema
        clean_source = {key: part for key, part in source.items() if key != "$schema"} if isinstance(source, dict) else source
        clean_schema = {key: part for key, part in schema.items() if key != "$schema"} if isinstance(schema, dict) else schema
        # Explicitly empty retrieval registry disables jsonschema's historical
        # implicit remote fetching, including for callers of this low-level helper.
        validator = BoundedValidator(clean_source, registry=Registry())
        if root_schema is not None:
            validator = validator.evolve(schema=clean_schema)
        result = validator.is_valid(value)
        _budget.get().tick()
        return result
    except ValueError:
        raise
    except Exception:
        raise ValueError("출력 스키마를 검증할 수 없습니다.") from None
    finally:
        _budget.reset(token)


def validate_structured_output(value: Any, schema: dict) -> Any:
    if not schema_matches(value, schema):
        raise ValueError("정책 모델의 출력이 지정한 JSON Schema와 일치하지 않습니다.")
    return value
