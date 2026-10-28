import type { PolicyCondition, PolicyGraph, PolicyGraphNode, PolicyPredicate } from './aegis-types';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { policyGraphSchemaIssues } from './policy-schema-guidance.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
export { policyGraphSchemaIssues } from './policy-schema-guidance.ts';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
export function validPolicyPointer(path: unknown): path is string { return typeof path === 'string' && path.length <= 512 && (path === '' || path.startsWith('/')) && path.split('/').length <= 13 && !/~(?:[^01]|$)/.test(path); }
export function policyConditionErrors(condition: PolicyCondition): string[] {
  if (!object(condition) || !['all','any'].includes(condition.mode) || !Array.isArray(condition.predicates) || condition.predicates.length < 1 || condition.predicates.length > 12) return ['조건은 all 또는 any와 1~12개 필드 검사로 구성하세요.'];
  const errors: string[] = [];
  for (const p of condition.predicates) {
    if (!object(p) || !validPolicyPointer(p.path) || !['eq','ne','gt','gte','lt','lte','contains','in','exists'].includes(p.operator)) { errors.push('필드 경로와 조건 연산자를 확인하세요.'); continue; }
    if (p.operator === 'exists') { if (own(p,'value') && typeof p.value !== 'boolean') errors.push('존재 조건의 값은 true 또는 false여야 합니다.'); }
    else if (!own(p,'value') || p.value === undefined) errors.push('조건 비교값을 유효한 JSON으로 입력하세요.');
    else if (['gt','gte','lt','lte'].includes(p.operator) && (typeof p.value !== 'number' || !Number.isFinite(p.value))) errors.push('숫자 비교에는 숫자 값을 입력하세요.');
    else if (p.operator === 'in' && (!Array.isArray(p.value) || !p.value.length || p.value.length > 64)) errors.push('목록 포함 조건의 값은 1~64개 JSON 배열이어야 합니다.');
    if (own(p,'value') && JSON.stringify(p.value)?.length > 4096) errors.push('조건 비교값은 4,096자 이내로 입력하세요.');
  }
  return [...new Set(errors)];
}
export function policyGraphErrors(graph: PolicyGraph, schema?:Record<string,unknown>): string[] {
  if (!object(graph) || graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length < 2 || graph.nodes.length > 24 || graph.edges.length > 48) return ['정책 그래프는 버전 1, 노드 2~24개와 연결선 최대 48개로 구성하세요.'];
  const errors: string[] = [], nodes = new Map<string, PolicyGraphNode>();
  for (const node of graph.nodes) {
    if (!object(node) || !id(node.id) || typeof node.name !== 'string' || !node.name.trim() || node.name.length > 100 || !['branch','rule','action'].includes(node.kind)) { errors.push('정책 노드의 ID, 이름과 종류를 확인하세요.'); continue; }
    if (nodes.has(node.id)) errors.push('정책 노드 ID는 중복할 수 없습니다.');
    nodes.set(node.id,node);
    if (node.kind !== 'action') errors.push(...policyConditionErrors(node.condition));
    else {
      if (!['main','respond','error'].includes(node.action)) errors.push('액션을 선택하세요.');
      if (node.action === 'respond' && (typeof node.responseText !== 'string' || !node.responseText.trim() || node.responseText.length > 4000)) errors.push('등록 안내 응답은 1~4,000자로 입력하세요.');
      if (node.action === 'error' && (typeof node.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(node.errorCode) || typeof node.errorMessage !== 'string' || !node.errorMessage.trim() || node.errorMessage.length > 500)) errors.push('공개 오류 코드와 1~500자 메시지를 입력하세요.');
    }
  }
  if (!id(graph.entryNodeId) || !['branch','rule'].includes(nodes.get(graph.entryNodeId)?.kind ?? '')) errors.push('정책 그래프의 시작은 조건 분기 노드여야 합니다.');
  const edgeIds = new Set<string>(), outgoing = new Map([...nodes.keys()].map(key => [key,[] as PolicyGraph['edges']]));
  for (const edge of graph.edges) {
    if (!object(edge) || !id(edge.id) || edgeIds.has(edge.id) || !nodes.has(edge.from) || !nodes.has(edge.to) || !['true','false'].includes(edge.port)) { errors.push('정책 연결선의 ID, 노드와 참/거짓 포트를 확인하세요.'); continue; }
    edgeIds.add(edge.id); outgoing.get(edge.from)!.push(edge);
  }
  for (const node of nodes.values()) {
    const edges = outgoing.get(node.id)!;
    if (node.kind === 'action' ? edges.length > 0 : edges.length !== 2 || edges.filter(e => e.port === 'true').length !== 1 || edges.filter(e => e.port === 'false').length !== 1) errors.push('조건 분기는 참/거짓 연결이 각각 하나, 액션은 나가는 연결이 없어야 합니다.');
  }
  const visited = new Set<string>(), active = new Set<string>();
  function visit(key: string) {
    if (active.has(key)) { errors.push('정책 그래프에 순환 연결을 사용할 수 없습니다.'); return; }
    if (visited.has(key)) return;
    active.add(key); visited.add(key);
    for (const edge of outgoing.get(key) ?? []) visit(edge.to);
    active.delete(key);
  }
  visit(graph.entryNodeId);
  if ([...nodes.keys()].some(key => !visited.has(key))) errors.push('모든 정책 노드는 시작 조건에서 도달할 수 있어야 합니다.');
  if(schema)errors.push(...policyGraphSchemaIssues(graph,schema).map(issue=>`${issue.nodeName} / 조건 ${issue.predicateIndex+1} / ${issue.path||'(전체 출력)'}: ${issue.message}`));
  return [...new Set(errors)];
}

/** New bindings deliberately stop until their action is configured. */
export function createPolicyGraph(): PolicyGraph {
  const condition = (): PolicyCondition => ({mode:'all',predicates:[{path:'',operator:'exists'}]});
  return {version:1,entryNodeId:'policy-branch',nodes:[
    {id:'policy-branch',name:'출력 분기',kind:'branch',condition:condition()},
    {id:'policy-rule-true',name:'참 경로 룰',kind:'rule',condition:condition()},
    {id:'policy-rule-false',name:'거짓 경로 룰',kind:'rule',condition:condition()},
    {id:'policy-action',name:'설정 대기',kind:'action',action:'error',errorCode:'POLICY_UNCONFIGURED',errorMessage:'정책 액션이 아직 설정되지 않았습니다.'},
  ],edges:[
    {id:'policy-edge-1',from:'policy-branch',to:'policy-rule-true',port:'true'},
    {id:'policy-edge-2',from:'policy-branch',to:'policy-rule-false',port:'false'},
    ...['policy-rule-true','policy-rule-false'].flatMap((from,i) => (['true','false'] as const).map((port,j)=>({id:`policy-edge-${3+i*2+j}`,from,to:'policy-action',port}))),
  ]};
}

/** Schema hints only. Runtime field lookup always uses validated JSON Pointer. */
export function policySchemaPaths(schema: Record<string,unknown>): {path:string;type:string}[] {
  const paths = new Map<string,string>();
  function walk(node: unknown,path: string,depth: number,refs: Set<string>) {
    if (!object(node) || depth > 12 || paths.size >= 256) return;
    paths.set(path,typeof node.type === 'string' ? node.type : Array.isArray(node.type) ? node.type.join('|') : 'JSON');
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/') && !refs.has(node.$ref)) {
      let target: unknown = schema;
      for (const part of node.$ref.slice(2).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'))) target = object(target) && own(target,part) ? target[part] : undefined;
      walk(target,path,depth+1,new Set([...refs,node.$ref]));
    }
    if (object(node.properties)) for (const [key,part] of Object.entries(node.properties)) walk(part,`${path}/${key.replace(/~/g,'~0').replace(/\//g,'~1')}`,depth+1,refs);
    if (node.items) walk(node.items,`${path}/0`,depth+1,refs);
    for (const key of ['oneOf','anyOf','allOf']) if (Array.isArray(node[key])) for (const part of node[key]) walk(part,path,depth+1,refs);
  }
  walk(schema,'',0,new Set());
  return [...paths].map(([path,type])=>({path,type}));
}
