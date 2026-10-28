"""A bounded, typed decision DAG over an already validated policy result.

This graph reads data only. It cannot execute expressions, change the workflow
graph or expose a classified value through its traces.
"""
from __future__ import annotations

import math
import re
from collections import deque
from typing import Any
from urllib.parse import unquote

MISSING = object()
SAFE_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$')
OPERATORS = {'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'exists'}
JSON_TYPES = {'null', 'boolean', 'integer', 'number', 'string', 'object', 'array'}


def pointer_tokens(path: str, *, maximum_depth=12) -> list[str]:
    if not isinstance(path, str) or len(path) > 512 or (path and not path.startswith('/')):
        raise ValueError('invalid pointer')
    if not path:
        return []
    parts = path[1:].split('/')
    if len(parts) > maximum_depth or any(re.search(r'~(?![01])', part) for part in parts):
        raise ValueError('invalid pointer')
    return [part.replace('~1', '/').replace('~0', '~') for part in parts]


def _local_ref(schema: dict, root: dict) -> dict | None:
    reference = schema.get('$ref')
    if not isinstance(reference, str):
        return None
    if not reference.startswith('#'):
        raise ValueError('nonlocal schema reference')
    selected = root
    for token in pointer_tokens(unquote(reference[1:]), maximum_depth=32):
        if isinstance(selected, dict) and token in selected:
            selected = selected[token]
        elif isinstance(selected, list) and re.fullmatch(r'0|[1-9][0-9]{0,4}', token) and int(token) < len(selected):
            selected = selected[int(token)]
        else:
            raise ValueError('unknown schema reference')
    if not isinstance(selected, dict):
        raise ValueError('invalid schema reference')
    return selected


def _schema_children(schema: dict, token: str, root: dict, depth=0, allow_open=True) -> list[dict]:
    if depth > 32:
        raise ValueError('schema reference limit')
    if type(schema) is bool:
        return [{}] if schema else []
    result = []
    referenced = _local_ref(schema, root)
    if referenced is not None:
        result.extend(_schema_children(referenced, token, root, depth + 1, allow_open))
    if token in schema.get('properties', {}):
        result.append(schema['properties'][token])
    if re.fullmatch(r'0|[1-9][0-9]{0,4}', token):
        prefix = schema.get('prefixItems', [])
        if int(token) < len(prefix):
            result.append(prefix[int(token)])
        elif type(schema.get('items')) in (dict, bool):
            result.append(schema['items'])
    for keyword in ('allOf', 'anyOf', 'oneOf'):
        for part in schema.get(keyword, []):
            result.extend(_schema_children(part, token, root, depth + 1, False))
    for keyword in ('then', 'else'):
        if keyword in schema:
            result.extend(_schema_children(schema[keyword], token, root, depth + 1, False))
    for part in schema.get('dependentSchemas', {}).values():
        result.extend(_schema_children(part, token, root, depth + 1, False))
    # An unconstrained schema or an explicitly open object permits data fields
    # without a fixed declaration. Closed object schemas still catch typos.
    if allow_open and not result and referenced is None and not any(keyword in schema for keyword in ('allOf', 'anyOf', 'oneOf', 'then', 'else', 'dependentSchemas')):
        declared = schema.get('type')
        types = set(declared if isinstance(declared, list) else [declared])
        extra = schema.get('additionalProperties', True)
        if (declared is None or 'object' in types) and extra is not False:
            result.append(extra if isinstance(extra, dict) else {})
        elif (declared is None or 'array' in types) and re.fullmatch(r'0|[1-9][0-9]{0,4}', token) and schema.get('items', True) is not False:
            result.append({})
    return result


def schema_at_pointer(schema: dict, path: str) -> dict:
    selected = [schema]
    for token in pointer_tokens(path):
        selected = [child for part in selected for child in _schema_children(part, token, schema)]
        if not selected:
            raise ValueError('unknown schema pointer')
    return selected[0] if len(selected) == 1 else {'anyOf': selected}


def _schema_types(schema: dict, root: dict, depth=0) -> set[str]:
    if depth > 32:
        raise ValueError('schema reference limit')
    if type(schema) is bool:
        return set(JSON_TYPES) if schema else set()
    declared = schema.get('type')
    types = set(declared if isinstance(declared, list) else [declared]) if declared is not None else set(JSON_TYPES)
    def literal_types(value):
        if value is None: return {'null'}
        if type(value) is bool: return {'boolean'}
        if type(value) in (int, float): return {'number', 'integer'} if int(value) == value else {'number'}
        if isinstance(value, str): return {'string'}
        if isinstance(value, list): return {'array'}
        return {'object'}
    if 'const' in schema:
        types.intersection_update(literal_types(schema['const']))
    if 'enum' in schema:
        types.intersection_update(set().union(*(literal_types(value) for value in schema['enum'])))
    referenced = _local_ref(schema, root)
    if referenced is not None:
        types.intersection_update(_schema_types(referenced, root, depth + 1))
    for keyword in ('allOf', 'anyOf', 'oneOf'):
        parts = schema.get(keyword, [])
        if keyword == 'allOf':
            for part in parts:
                types.intersection_update(_schema_types(part, root, depth + 1))
        elif parts:
            types.intersection_update(set().union(*(_schema_types(part, root, depth + 1) for part in parts)))
    return types


def value_at_pointer(output: Any, path: str) -> Any:
    selected = output
    for token in pointer_tokens(path):
        if isinstance(selected, dict) and token in selected:
            selected = selected[token]
        elif isinstance(selected, list) and re.fullmatch(r'0|[1-9][0-9]{0,4}', token) and int(token) < len(selected):
            selected = selected[int(token)]
        else:
            return MISSING
    return selected


def _number(value: Any) -> bool:
    return type(value) in (int, float) and abs(value) <= 9007199254740991 and math.isfinite(value)


def _json_type_matches(value: Any, schema: dict, root: dict) -> bool:
    types = _schema_types(schema, root)
    return ((value is None and 'null' in types) or (type(value) is bool and 'boolean' in types)
            or (isinstance(value, str) and 'string' in types)
            or (_number(value) and ('number' in types or ('integer' in types and int(value) == value)))
            or (isinstance(value, dict) and 'object' in types)
            or (isinstance(value, list) and 'array' in types))


def validate_policy_graph(graph: dict, output_schema: dict) -> list[str]:
    """Return safe errors; do not interpolate model values or predicate literals."""
    if not isinstance(graph, dict) or graph.get('version') != 1 or not isinstance(graph.get('nodes'), list) or not isinstance(graph.get('edges'), list):
        return ['정책 분기 그래프 형식을 확인하세요.']
    nodes, edges = graph['nodes'], graph['edges']
    if not 2 <= len(nodes) <= 24 or len(edges) > 48 or any(not isinstance(node, dict) for node in nodes) or any(not isinstance(edge, dict) for edge in edges):
        return ['정책 분기에는 노드 2~24개와 연결선 최대 48개를 사용할 수 있습니다.']
    ids = [node.get('id') for node in nodes]
    edge_ids = [edge.get('id') for edge in edges]
    if any(not isinstance(identifier, str) or not SAFE_ID.fullmatch(identifier) for identifier in ids + edge_ids) or len(set(ids)) != len(ids) or len(set(edge_ids)) != len(edge_ids):
        return ['정책 노드와 연결선 ID는 중복 없이 영문, 숫자, 밑줄과 하이픈으로 입력하세요.']
    by_id = {node['id']: node for node in nodes}
    entry = graph.get('entryNodeId')
    if not isinstance(entry, str) or entry not in by_id or by_id[entry].get('kind') not in ('branch', 'rule'):
        return ['정책 그래프의 시작 노드는 조건 분기여야 합니다.']
    outgoing = {identifier: [] for identifier in ids}
    incoming = {identifier: 0 for identifier in ids}
    for edge in edges:
        if edge.get('from') not in by_id or edge.get('to') not in by_id or edge.get('port') not in ('true', 'false'):
            return ['정책 연결선의 시작, 도착과 참 또는 거짓 경로를 확인하세요.']
        outgoing[edge['from']].append(edge)
        incoming[edge['to']] += 1
    for node in nodes:
        kind = node.get('kind')
        links = outgoing[node['id']]
        if kind == 'action':
            if links or node.get('action') not in ('main', 'respond', 'error'):
                return ['정책 동작은 Main, 안내 응답 또는 오류를 선택하며 다음 연결선이 없어야 합니다.']
            continue
        if kind not in ('branch', 'rule') or len(links) != 2 or {edge['port'] for edge in links} != {'true', 'false'}:
            return ['조건 분기에는 참과 거짓 연결선이 각각 하나씩 필요합니다.']
        # Both persisted condition kinds evaluate the same predicate contract.
        # Keep their IDs and kinds intact while allowing a condition to lead to
        # another condition or directly to a terminal action.
        condition = node.get('condition')
        if not isinstance(condition, dict) or condition.get('mode') not in ('all', 'any') or not isinstance(condition.get('predicates'), list) or not 1 <= len(condition['predicates']) <= 12:
            return ['정책 조건은 비교 항목 1~12개와 모두 또는 하나 이상 조건을 지정하세요.']
        for predicate in condition['predicates']:
            try:
                if not isinstance(predicate, dict) or predicate.get('operator') not in OPERATORS:
                    raise ValueError('invalid operator')
                selected = schema_at_pointer(output_schema, predicate.get('path'))
                operator = predicate['operator']
                value = predicate.get('value', MISSING)
                if value is not MISSING:
                    from .structured_schema import validate_json_value
                    validate_json_value(value, max_bytes=4096)
                types = _schema_types(selected, output_schema)
                if operator == 'exists':
                    if value is not MISSING and type(value) is not bool:
                        raise ValueError('exists value')
                elif value is MISSING:
                    raise ValueError('missing value')
                elif operator in ('gt', 'gte', 'lt', 'lte'):
                    if not types.intersection({'integer', 'number'}) or not _number(value):
                        raise ValueError('numeric comparison')
                elif operator == 'in':
                    if not isinstance(value, list) or not 1 <= len(value) <= 64 or any(not _json_type_matches(item, selected, output_schema) for item in value):
                        raise ValueError('membership comparison')
                elif operator == 'contains':
                    if 'string' in types and isinstance(value, str):
                        pass
                    elif 'array' in types and any(_json_type_matches(value, child, output_schema) for child in _schema_children(selected, '0', output_schema)):
                        pass
                    else:
                        raise ValueError('contains comparison')
                elif not _json_type_matches(value, selected, output_schema):
                    raise ValueError('comparison value type')
            except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
                return ['정책 조건의 필드 경로, 비교 연산과 값의 형식을 출력 스키마에 맞게 지정하세요.']
    # One traversal checks both cycles and unreachable fragments. Every condition
    # has two edges and every terminal is an action, so every path must finish.
    if incoming[entry] != 0:
        return ['정책 시작 조건으로 들어오는 연결선은 사용할 수 없습니다.']
    pending = deque(identifier for identifier in ids if incoming[identifier] == 0)
    remaining = dict(incoming)
    ordered = []
    while pending:
        current = pending.popleft()
        ordered.append(current)
        for edge in outgoing[current]:
            remaining[edge['to']] -= 1
            if remaining[edge['to']] == 0:
                pending.append(edge['to'])
    if len(ordered) != len(nodes):
        return ['정책 그래프에는 순환을 연결할 수 없습니다.']
    reachable, pending = set(), [entry]
    while pending:
        current = pending.pop()
        if current not in reachable:
            reachable.add(current)
            pending.extend(edge['to'] for edge in outgoing[current])
    if reachable != set(ids):
        return ['정책 그래프의 모든 노드는 시작 조건에서 이어져야 합니다.']
    return []


def predicate_matches(predicate: dict, output: Any) -> bool:
    from .structured_schema import strict_json_equal
    value = value_at_pointer(output, predicate['path'])
    operator = predicate['operator']
    expected = predicate.get('value')
    if operator == 'exists':
        return (value is not MISSING) == predicate.get('value', True)
    if value is MISSING:
        return False
    if operator in ('eq', 'ne'):
        equal = strict_json_equal(value, expected)
        return equal if operator == 'eq' else not equal
    if operator in ('gt', 'gte', 'lt', 'lte'):
        if not _number(value) or not _number(expected):
            return False
        return {'gt': lambda: value > expected, 'gte': lambda: value >= expected, 'lt': lambda: value < expected, 'lte': lambda: value <= expected}[operator]()
    if operator == 'in':
        return isinstance(expected, list) and any(strict_json_equal(value, item) for item in expected)
    if operator == 'contains':
        return (isinstance(value, str) and isinstance(expected, str) and expected in value) or (isinstance(value, list) and any(strict_json_equal(item, expected) for item in value))
    return False


def execute_policy_graph(graph: dict, output: Any) -> dict:
    """Execute only a graph that passed validate_policy_graph; fail closed anyway."""
    from .engine import PolicyError
    by_id = {node['id']: node for node in graph['nodes']}
    selected, path = graph['entryNodeId'], []
    for _ in range(24):
        if selected in path or selected not in by_id:
            break
        node = by_id[selected]
        path.append(selected)
        if node['kind'] == 'action':
            return {'route': node, 'path': path}
        condition = node['condition']
        matches = [predicate_matches(predicate, output) for predicate in condition['predicates']]
        matched = all(matches) if condition['mode'] == 'all' else any(matches)
        links = [edge for edge in graph['edges'] if edge['from'] == selected and edge['port'] == ('true' if matched else 'false')]
        if len(links) != 1:
            break
        selected = links[0]['to']
    raise PolicyError('정책 분기 그래프가 등록된 동작에 도달하지 못했습니다.')
