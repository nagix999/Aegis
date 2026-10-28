/** Lossless form edits over the same raw JSON Schema used by save and test.
 * This is an editing aid; the Python schema validator remains authoritative.
 */
export type SchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
export type SchemaPath = readonly string[];
export type SchemaNode = Record<string, unknown>;
export type SchemaEditability = { editable: boolean; type: SchemaType | 'complex'; warning?: string };
export type SchemaBuilderRow = {
  path: string[]; id: string; label: string; name: string; type: SchemaType | 'complex';
  required: boolean; nullable: boolean; depth: number; editable: boolean; locked: boolean;
  warning?: string; reason?: string;
};

const TYPES: SchemaType[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const MAX_BYTES = 32768, MAX_DEPTH = 12, MAX_ROWS = 100;
const ADVANCED = ['$ref', '$dynamicRef', '$dynamicAnchor', '$anchor', '$id', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'const', 'dependentSchemas', 'dependentRequired', 'patternProperties', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems', 'prefixItems', 'contains', 'minContains', 'maxContains'];
const ANNOTATIONS = new Set(['title', 'description', '$comment']);
const TYPE_KEYS: Record<string, readonly string[]> = {
  object: ['properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties'],
  array: ['items', 'minItems', 'maxItems', 'uniqueItems'],
  string: ['minLength', 'maxLength', 'pattern', 'format', 'contentEncoding', 'contentMediaType'],
  number: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
};

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function record(value: unknown): value is SchemaNode {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function put(target: SchemaNode, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}
function jsonClone<T>(value: T): T {
  let nodes = 0;
  const visit = (part: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 20) throw new Error('JSON의 깊이 또는 항목 수 제한을 초과했습니다. JSON 편집에서 구조를 확인하세요.');
    if (part === null || typeof part === 'string' || typeof part === 'boolean') return part;
    if (typeof part === 'number' && Number.isFinite(part) && Math.abs(part) <= Number.MAX_SAFE_INTEGER) return part;
    if (Array.isArray(part)) return Array.from({length:part.length}, (_, index) => {
      if (!own(part, String(index))) throw new Error('비어 있는 배열 항목은 JSON 값으로 먼저 지정하세요.');
      return visit(part[index], depth + 1);
    });
    if (!record(part)) throw new Error('스키마에는 유한한 숫자와 JSON 값만 사용할 수 있습니다.');
    const result: SchemaNode = {};
    for (const key of Object.keys(part)) {
      const descriptor = Object.getOwnPropertyDescriptor(part, key);
      if (!descriptor || !own(descriptor, 'value')) throw new Error('JSON 속성만 편집할 수 있습니다.');
      put(result, key, visit(descriptor.value, depth + 1));
    }
    return result;
  };
  return visit(value, 0) as T;
}
function assertBudget(schema: SchemaNode) {
  if (new TextEncoder().encode(JSON.stringify(schema)).byteLength > MAX_BYTES) throw new Error('출력 스키마는 32KiB 이하로 작성하세요.');
  let count = 0;
  const visit = (node: unknown, depth: number) => {
    if (++count > 256 || depth > MAX_DEPTH) throw new Error('스키마의 깊이 또는 필드 수 제한을 초과했습니다.');
    if (!record(node)) return;
    for (const key of ['properties', '$defs', 'patternProperties', 'dependentSchemas']) if (record(node[key])) for (const child of Object.values(node[key])) visit(child, depth + 1);
    for (const key of ['items', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else']) if (own(node, key)) visit(node[key], depth + 1);
    for (const key of ['prefixItems', 'allOf', 'anyOf', 'oneOf']) if (Array.isArray(node[key])) for (const child of node[key]) visit(child, depth + 1);
  };
  visit(schema, 0);
}
function finish(schema: SchemaNode) { assertBudget(schema); return schema; }
function fieldName(name: string) {
  if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error('필드 이름은 공백 외의 문자를 포함해 120자 이하로 입력하세요.');
  return name;
}
function nodeType(node: SchemaNode): { type: SchemaType | 'complex'; nullable: boolean } {
  if (typeof node.type === 'string' && TYPES.includes(node.type as SchemaType)) return { type: node.type as SchemaType, nullable: node.type === 'null' };
  if (Array.isArray(node.type) && node.type.length === 2 && node.type.includes('null')) {
    const primary = node.type.find(type => type !== 'null');
    if (typeof primary === 'string' && primary !== 'null' && TYPES.includes(primary as SchemaType)) return { type: primary as SchemaType, nullable: true };
  }
  return { type: 'complex', nullable: false };
}

export function schemaEditable(value: unknown): SchemaEditability {
  if (!record(value)) return { editable: false, type: 'complex', warning: 'Boolean 스키마와 복합 구조는 JSON 편집에서 수정하세요.' };
  const { type, nullable } = nodeType(value);
  const locked = (warning: string): SchemaEditability => ({ editable: false, type, warning });
  if (ADVANCED.some(key => own(value, key))) return locked('참조, 조건 또는 복합 제약이 있습니다. 이 구조는 JSON 편집에서 수정하세요.');
  if (type === 'complex') return locked('자료형이 없거나 여러 자료형을 조합한 스키마입니다. JSON 편집을 사용하세요.');
  if (own(value, 'enum') && (type !== 'string' || !Array.isArray(value.enum) || value.enum.some(item => typeof item !== 'string' && !(nullable && item === null)))) return locked('문자열 이외의 허용값은 JSON 편집에서 수정하세요.');
  if (type === 'object' && ((own(value, 'properties') && !record(value.properties)) || (own(value, 'required') && (!Array.isArray(value.required) || value.required.some(name => typeof name !== 'string'))) || (own(value, 'additionalProperties') && typeof value.additionalProperties !== 'boolean'))) return locked('고급 객체 제약은 JSON 편집에서 수정하세요.');
  if (type === 'array' && own(value, 'items') && !record(value.items)) return locked('Boolean 또는 여러 항목 스키마는 JSON 편집에서 수정하세요.');
  return { editable: true, type };
}

/** Raw-schema tokens, e.g. ['properties', 'risk', 'properties', 'score']. */
export function getSchemaNode(schema: SchemaNode, path: SchemaPath): SchemaNode | undefined {
  let node: unknown = schema;
  for (const token of path) {
    if (!record(node) || !own(node, token)) return undefined;
    node = node[token];
  }
  return record(node) ? node : undefined;
}
function requireNode(schema: SchemaNode, path: SchemaPath): SchemaNode {
  const node = getSchemaNode(schema, path);
  if (!node) throw new Error('편집할 스키마 필드를 찾을 수 없습니다.');
  return node;
}
function requireEditable(node: SchemaNode, type?: SchemaType) {
  const info = schemaEditable(node);
  if (!info.editable) throw new Error(info.warning);
  if (type && info.type !== type) throw new Error('객체 필드 목록에서 이 작업을 실행하세요.');
  return info;
}

/** Omitted keys are retained. Only an explicit undefined removes a keyword. */
export function updateSchemaNode(schema: SchemaNode, path: SchemaPath, patch: SchemaNode | ((node: SchemaNode) => SchemaNode)): SchemaNode {
  const next = jsonClone(schema), node = requireNode(next, path);
  const change = typeof patch === 'function' ? patch(jsonClone(node)) : patch;
  if (!record(change)) throw new Error('필드 변경 내용을 확인하세요.');
  if (Array.isArray(change.enum) && change.enum.length > 32) throw new Error('허용값은 null을 포함해 최대 32개까지 지정하세요.');
  if (!schemaEditable(node).editable && Object.keys(change).some(key => !ANNOTATIONS.has(key))) throw new Error('복합 스키마의 구조는 JSON 편집에서 수정하세요.');
  for (const key of Object.keys(change)) {
    const descriptor = Object.getOwnPropertyDescriptor(change, key);
    if (!descriptor || !own(descriptor, 'value')) throw new Error('JSON 속성만 편집할 수 있습니다.');
    if (descriptor.value === undefined) delete node[key];
    else put(node, key, jsonClone(descriptor.value));
  }
  return finish(next);
}

function newNode(type: SchemaType): SchemaNode {
  if (!TYPES.includes(type)) throw new Error('필드 자료형을 확인하세요.');
  if (type === 'object') return { type, properties: {}, required: [], additionalProperties: false };
  if (type === 'array') return { type, items: { type: 'string' } };
  return { type };
}
export function addSchemaProperty(schema: SchemaNode, path: SchemaPath, name: string, type: SchemaType = 'string'): SchemaNode {
  fieldName(name);
  const next = jsonClone(schema), parent = requireNode(next, path);
  requireEditable(parent, 'object');
  const properties = record(parent.properties) ? parent.properties : {};
  if (own(properties, name)) throw new Error('같은 이름의 필드가 이미 있습니다.');
  put(properties, name, newNode(type)); put(parent, 'properties', properties);
  return finish(next);
}
export function renameSchemaProperty(schema: SchemaNode, path: SchemaPath, from: string, to: string): SchemaNode {
  fieldName(to);
  const next = jsonClone(schema), parent = requireNode(next, path);
  requireEditable(parent, 'object');
  if (!record(parent.properties) || !own(parent.properties, from)) throw new Error('이름을 바꿀 필드를 찾을 수 없습니다.');
  if (from !== to && own(parent.properties, to)) throw new Error('같은 이름의 필드가 이미 있습니다.');
  const properties: SchemaNode = {};
  for (const key of Object.keys(parent.properties)) put(properties, key === from ? to : key, parent.properties[key]);
  put(parent, 'properties', properties);
  if (Array.isArray(parent.required)) put(parent, 'required', parent.required.map(name => name === from ? to : name));
  return finish(next);
}
export function removeSchemaProperty(schema: SchemaNode, path: SchemaPath, name: string): SchemaNode {
  const next = jsonClone(schema), parent = requireNode(next, path);
  requireEditable(parent, 'object');
  if (!record(parent.properties) || !own(parent.properties, name)) throw new Error('삭제할 필드를 찾을 수 없습니다.');
  delete parent.properties[name];
  if (Array.isArray(parent.required)) put(parent, 'required', parent.required.filter(item => item !== name));
  return finish(next);
}
export function setSchemaPropertyRequired(schema: SchemaNode, path: SchemaPath, name: string, required: boolean): SchemaNode {
  const next = jsonClone(schema), parent = requireNode(next, path);
  requireEditable(parent, 'object');
  if (!record(parent.properties) || !own(parent.properties, name)) throw new Error('필수 여부를 바꿀 필드를 찾을 수 없습니다.');
  const names = Array.isArray(parent.required) ? parent.required as string[] : [];
  put(parent, 'required', required ? (names.includes(name) ? names : [...names, name]) : names.filter(item => item !== name));
  return finish(next);
}

export function setSchemaType(schema: SchemaNode, path: SchemaPath, type: SchemaType, nullable = false): SchemaNode {
  const next = jsonClone(schema), node = requireNode(next, path), before = requireEditable(node).type;
  if (!TYPES.includes(type)) throw new Error('필드 자료형을 확인하세요.');
  const family = (value: string) => value === 'integer' ? 'number' : value;
  const changed = family(before) !== family(type);
  if (changed) {
    if (record(node.properties) && Object.keys(node.properties).length || Array.isArray(node.required) && node.required.length) throw new Error('하위 필드가 있는 객체의 자료형은 JSON 편집에서 변경하세요.');
    const items = node.items;
    if (record(items) && Object.keys(items).some(key => key !== 'type' || items.type !== 'string')) throw new Error('배열 항목에 설정이 있습니다. 자료형은 JSON 편집에서 변경하세요.');
    for (const [owner, keys] of Object.entries(TYPE_KEYS)) if (owner !== family(type)) for (const key of keys) {
      if (!own(node, key)) continue;
      const emptyDefault = key === 'properties' && record(node[key]) && !Object.keys(node[key]).length || key === 'required' && Array.isArray(node[key]) && !node[key].length || key === 'additionalProperties' && typeof node[key] === 'boolean' || key === 'items' && record(node[key]) && (Object.keys(node[key]).length === 0 || Object.keys(node[key]).length === 1 && node[key].type === 'string');
      if (!emptyDefault) throw new Error('기존 자료형의 제약이 있습니다. 제약을 먼저 지우거나 JSON 편집에서 변경하세요.');
      delete node[key];
    }
    if (own(node, 'enum')) throw new Error('허용값이 있습니다. 허용값을 먼저 지운 뒤 자료형을 변경하세요.');
    const defaults = newNode(type);
    for (const key of Object.keys(defaults)) if (key !== 'type' && !own(node, key)) put(node, key, defaults[key]);
  }
  put(node, 'type', nullable && type !== 'null' ? [type, 'null'] : type);
  if (type === 'string' && Array.isArray(node.enum)) {
    const values = node.enum.filter(value => value !== null);
    if (!nullable && !values.length) throw new Error('문자열 허용값을 하나 이상 지정하거나 허용값 제약을 지우세요.');
    if (values.length + (nullable ? 1 : 0) > 32) throw new Error('허용값은 null을 포함해 최대 32개까지 지정하세요.');
    put(node, 'enum', nullable ? [...values, null] : values);
  }
  return finish(next);
}

export function schemaBuilderTree(schema: SchemaNode): SchemaBuilderRow[] {
  const rows: SchemaBuilderRow[] = [];
  const visit = (node: unknown, path: string[], label: string, required: boolean, depth: number) => {
    if (rows.length >= MAX_ROWS || depth > MAX_DEPTH) return;
    const info = schemaEditable(node), nullable = record(node) && nodeType(node).nullable;
    rows.push({ path, id: path.length ? '/' + path.map(token => token.replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : '/', label, name: label, type: info.type, required, nullable: Boolean(nullable), depth, editable: info.editable, locked: !info.editable, ...(info.warning ? { warning: info.warning, reason: info.warning } : {}) });
    if (!record(node)) return;
    if (record(node.properties)) for (const [name, child] of Object.entries(node.properties)) visit(child, [...path, 'properties', name], name, Array.isArray(node.required) && node.required.includes(name), depth + 1);
    if (own(node, 'items')) visit(node.items, [...path, 'items'], '배열 항목', false, depth + 1);
  };
  visit(schema, [], '출력', true, 0);
  return rows;
}

// Descriptive aliases for form components.
export const schemaNode = getSchemaNode;
export const addSchemaField = addSchemaProperty;
export const renameSchemaField = renameSchemaProperty;
export const removeSchemaField = removeSchemaProperty;
export const setSchemaRequired = setSchemaPropertyRequired;
