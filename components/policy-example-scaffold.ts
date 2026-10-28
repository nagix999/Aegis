type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const escape = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const complex = ['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentSchemas'];
export type ExampleScaffold = { source: string; added: string[]; skipped: string[]; error?: string };

/** Editing help only: preserve every existing value and propose only missing required fields.
 * Placeholder values are never treated as correct expectations or automatically saved.
 * Ambiguous schemas and invalid raw JSON stay entirely under the administrator's control.
 */
export function scaffoldPolicyExample(schema: Schema, source: string): ExampleScaffold {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { return {source, added: [], skipped: [], error: '예상 JSON 문법을 먼저 수정하세요.'}; }
  const pending: {value:unknown;depth:number}[] = [{value:parsed,depth:0}];
  let checked = 0;
  while (pending.length) {
    const {value,depth} = pending.pop()!;
    if (++checked > 10000 || depth > 64 || typeof value === 'number' && !Number.isFinite(value)) return {source,added:[],skipped:[],error:'값이 너무 복잡하거나 유한하지 않은 숫자가 있습니다. 예상 JSON을 직접 확인하세요.'};
    if (value !== null && typeof value === 'object') for (const child of Object.values(value)) pending.push({value:child,depth:depth+1});
  }
  const added: string[] = [], skipped: string[] = [];
  let visited = 0;
  const seed = (node: unknown, path: string, depth: number): {value?: unknown; ok: boolean} => {
    if (!object(node) || depth > 10 || ++visited > 300 || complex.some(key => own(node, key))) { skipped.push(path || '/'); return {ok: false}; }
    // Enum/const values carry business meaning; choosing one would invent an expectation.
    if (own(node, 'enum') || own(node, 'const')) { skipped.push(path || '/'); return {ok: false}; }
    if (node.type === 'object') return {ok: true, value: fill(node, {}, path, depth + 1)};
    if (node.type === 'array' && (!node.minItems || node.minItems === 0)) return {ok: true, value: []};
    if (node.type === 'string') return {ok: true, value: ''};
    if (node.type === 'number' || node.type === 'integer') return {ok: true, value: 0};
    if (node.type === 'boolean') return {ok: true, value: false};
    if (node.type === 'null') return {ok: true, value: null};
    skipped.push(path || '/'); return {ok: false};
  };
  const fill = (node: unknown, value: unknown, path: string, depth: number): unknown => {
    if (!object(node) || depth > 10 || ++visited > 300 || complex.some(key => own(node, key))) { skipped.push(path || '/'); return value; }
    if (object(value) && object(node.properties)) {
      const result: Schema = structuredClone(value);
      for (const [key, child] of Object.entries(node.properties)) {
        const at = `${path}/${escape(key)}`;
        if (own(value, key)) Object.defineProperty(result, key, {value: fill(child, value[key], at, depth + 1), enumerable: true, configurable: true, writable: true});
        else if (Array.isArray(node.required) && node.required.includes(key)) {
          const proposal = seed(child, at, depth + 1);
          if (proposal.ok) { Object.defineProperty(result, key, {value: proposal.value, enumerable: true, configurable: true, writable: true}); added.push(at); }
        }
      }
      return result;
    }
    if (Array.isArray(value) && object(node.items)) return value.map((item, index) => fill(node.items, item, `${path}/${index}`, depth + 1));
    return value;
  };
  const value = fill(schema, parsed, '', 0);
  if (!added.length) return {source,added,skipped:[...new Set(skipped)]};
  const result = JSON.stringify(value, null, 2);
  if (new TextEncoder().encode(result).length > 64 * 1024) return {source, added: [], skipped, error: '보완한 예상 JSON이 64KiB를 초과합니다.'};
  return {source: added.length ? result : source, added, skipped: [...new Set(skipped)]};
}
