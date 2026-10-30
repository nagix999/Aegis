import type { Workflow } from './aegis-types';

/** This stores working configuration only. Evaluation inputs and results never belong here. */
export const WORKFLOW_RECOVERY_KEY = 'aegis:workflow-recovery:v1';
export const MAX_WORKFLOW_RECOVERIES = 30;
export const MAX_WORKFLOW_RECOVERY_BYTES = 4 * 1024 * 1024;
export type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type WorkflowRecovery = { workflowId: string; draft: Workflow; base: Workflow; savedAt: string };
export type RecoveryResult = { ok: boolean; records: WorkflowRecovery[]; error?: string };
type ObjectValue = Record<string, unknown>;

const unsafeKey = (key: string) => ['__proto__', 'constructor', 'prototype'].includes(key);
function object(value: unknown): value is ObjectValue { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function shape(value: unknown, keys: string[]): value is ObjectValue {
  return object(value) && Object.keys(value).every(key => !unsafeKey(key) && keys.includes(key));
}
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const identifier = (value: unknown, max = 120): value is string => string(value, max) && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value) && !unsafeKey(value);
const number = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const member = (value: unknown, values: readonly string[]): boolean => typeof value === 'string' && values.includes(value);
const optional = (value: unknown, valid: (value: unknown) => boolean): boolean => value === undefined || valid(value);
function array(value: unknown, max: number, valid: (value: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.length <= max && value.every(valid);
}
function config(value: unknown): boolean {
  if (!shape(value, ['pattern', 'maxLength', 'prompt', 'connectionId', 'piiTypes', 'requiredKeys', 'jsonMode', 'matchMode', 'guardProfile', 'policyRouting'])) return false;
  return optional(value.pattern, item => string(item, 2000)) && optional(value.maxLength, item => number(item, -1_000_000, 1_000_000))
    && optional(value.prompt, item => string(item, 4000)) && optional(value.connectionId, item => string(item, 120))
    && optional(value.piiTypes, item => array(item, 3, part => member(part, ['email', 'phone', 'resident'])))
    && optional(value.requiredKeys, item => array(item, 32, part => string(part, 100)))
    && optional(value.jsonMode, item => member(item, ['object', 'any'])) && optional(value.matchMode, item => member(item, ['any', 'all']))
    && optional(value.guardProfile, item => member(item, ['custom', 'injection', 'safety'])) && optional(value.policyRouting,policyRouting);
}
function rule(value: unknown): boolean {
  return shape(value, ['id', 'name', 'description', 'kind', 'enabled', 'config']) && identifier(value.id)
    && string(value.name, 120) && string(value.description, 1000) && member(value.kind, ['keyword', 'regex', 'length', 'llm', 'pii', 'json', 'required', 'policy'])
    && typeof value.enabled === 'boolean' && config(value.config);
}
function group(value: unknown): boolean {
  return shape(value, ['id', 'name', 'mode', 'rules', 'required']) && identifier(value.id) && string(value.name, 120)
    && member(value.mode, ['any', 'all']) && array(value.rules, 12, rule) && optional(value.required, item => typeof item === 'boolean');
}
function condition(value: unknown): boolean {
  return shape(value, ['operator', 'value', 'caseSensitive']) && member(value.operator, ['contains', 'not_contains', 'length_gte', 'length_lte'])
    && string(value.value, 2000) && optional(value.caseSensitive, item => typeof item === 'boolean');
}
function stageGraph(value: unknown): boolean {
  return shape(value, ['nodes', 'edges']) && array(value.nodes, 12, node => shape(node, ['id', 'kind', 'name', 'condition'])
    && identifier(node.id) && member(node.kind, ['condition', 'fork', 'join']) && string(node.name, 120) && optional(node.condition, condition))
    && array(value.edges, 64, edge => shape(edge, ['id', 'from', 'to', 'port']) && identifier(edge.id)
      && string(edge.from, 150) && string(edge.to, 150) && optional(edge.port, item => member(item, ['next', 'true', 'false'])));
}
function point(value: unknown): boolean {
  return shape(value, ['x', 'y']) && number(value.x, 0, 40000) && number(value.y, 0, 40000);
}
function layout(value: unknown): boolean {
  if (!shape(value, ['version', 'positions', 'zones', 'pinnedKeys']) || value.version !== 1 || !object(value.positions)) return false;
  const entries = Object.entries(value.positions);
  if (entries.length > 1280 || !entries.every(([key, position]) => identifier(key, 260) && point(position))) return false;
  return optional(value.pinnedKeys, pins => array(pins, 1280, key => identifier(key, 260)) && new Set(pins as string[]).size === (pins as string[]).length) && optional(value.zones, zones => array(zones, 32, zone => shape(zone, ['id', 'name', 'color', 'nodeKeys', 'x', 'y', 'width', 'height'])
    && identifier(zone.id, 100) && string(zone.name, 120) && member(zone.color, ['slate', 'blue', 'green', 'amber', 'violet'])
    && array(zone.nodeKeys, 1280, key => identifier(key, 260)) && number(zone.x, 0, 40000) && number(zone.y, 0, 40000)
    && number(zone.width, 1, 50000) && number(zone.height, 1, 50000)));
}
function cloneSource(value: unknown): boolean {
  if (!shape(value, ['workflowId', 'ruleIds']) || !identifier(value.workflowId) || !object(value.ruleIds)) return false;
  const entries = Object.entries(value.ruleIds);
  return entries.length <= 864 && entries.every(([source, target]) => identifier(source) && identifier(target))
    && new Set(entries.map(([, target]) => target)).size === entries.length;
}

function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (Array.isArray(value)) return value.length <= 1024 && value.every(item=>jsonValue(item,depth+1));
  return object(value) && Object.keys(value).length <= 1024 && Object.values(value).every(item=>jsonValue(item,depth+1));
}
function switchValue(value:unknown):boolean {
  return (value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER)
    && new TextEncoder().encode(JSON.stringify(value)).length<=4096;
}
function policyGraph(value: unknown): boolean {
  return shape(value,['version','entryNodeId','nodes','edges']) && value.version === 1 && (value.entryNodeId === '' || identifier(value.entryNodeId))
    && array(value.nodes,24,node => shape(node,['id','name','kind','condition','path','cases','action','responseText','errorCode','errorMessage']) && identifier(node.id) && string(node.name,100)
      && (member(node.kind,['branch','rule']) ? shape(node.condition,['mode','predicates']) && member(node.condition.mode,['all','any'])
        && array(node.condition.predicates,12,p=>shape(p,['path','operator','value']) && string(p.path,512) && member(p.operator,['eq','ne','gt','gte','lt','lte','contains','in','exists']) && optional(p.value,jsonValue))
        : node.kind === 'switch' ? string(node.path,512) && array(node.cases,12,item=>shape(item,['id','value'])&&identifier(item.id)&&Object.prototype.hasOwnProperty.call(item,'value')&&switchValue(item.value))
        : node.kind === 'action' && member(node.action,['main','respond','error']) && optional(node.responseText,v=>string(v,4000)) && optional(node.errorCode,v=>string(v,64)) && optional(node.errorMessage,v=>string(v,500))))
    && array(value.edges,48,e=>shape(e,['id','from','to','port']) && identifier(e.id) && string(e.from,120) && string(e.to,120) && identifier(e.port));
}
function policyRouting(value: unknown): boolean {
  if (!shape(value, ['policy', 'routes','graph'])) return false;
  const policy = value.policy;
  if (!shape(policy, ['id', 'name', 'description', 'prompt', 'connectionId', 'decisions', 'examples', 'connectionSnapshot', 'version', 'updatedAt','formatVersion','outputSchema','maxOutputTokens'])) return false;
  const connection = policy.connectionSnapshot;
  return identifier(policy.id) && string(policy.name, 100) && string(policy.description, 1000) && string(policy.prompt, 4000)
    && string(policy.connectionId, 120) && Number.isInteger(policy.version) && number(policy.version, 1, 1_000_000_000) && string(policy.updatedAt, 100)
    && array(policy.decisions, 12, item => shape(item, ['code', 'label', 'description']) && string(item.code, 64) && string(item.label, 80) && string(item.description, 1000))
    && array(policy.examples, 30, item => shape(item, ['id', 'input', 'expectedDecision','expectedOutput','expectation']) && optional(item.expectation,v=>shape(v,['mode','fields'])&&member(v.mode,['exact','schema','fields'])&&(v.mode==='fields'?array(v.fields,12,p=>shape(p,['path','operator','value'])&&string(p.path,512)&&member(p.operator,['eq','ne','gt','gte','lt','lte','contains','in','exists'])&&optional(p.value,jsonValue)):v.fields===undefined)) && identifier(item.id) && string(item.input, 16000) && (policy.formatVersion === 2 ? Object.prototype.hasOwnProperty.call(item,'expectedOutput') && jsonValue(item.expectedOutput) : string(item.expectedDecision, 64)))
    && optional(policy.formatVersion,v=>v===2) && optional(policy.outputSchema,v=>object(v) && jsonValue(v)) && optional(policy.maxOutputTokens,v=>number(v,256,4096))
    && optional(value.graph,policyGraph)
    && shape(connection, ['id', 'name', 'baseUrl', 'model', 'role', 'mode', 'secretEnv', 'timeoutMs']) && identifier(connection.id)
    && string(connection.name, 100) && string(connection.baseUrl, 2000) && string(connection.model, 200)
    && member(connection.role, ['main', 'guard', 'both']) && member(connection.mode, ['demo', 'vllm']) && string(connection.secretEnv, 80) && number(connection.timeoutMs, 1000, 60000)
    && array(value.routes, 12, route => shape(route, ['decision', 'action', 'responseText', 'errorCode', 'errorMessage']) && string(route.decision, 64)
      && member(route.action, ['main', 'respond', 'error']) && optional(route.responseText, item => string(item, 4000))
      && optional(route.errorCode, item => string(item, 64)) && optional(route.errorMessage, item => string(item, 500)));
}

/** Type and size checks deliberately do not require a connected or executable graph. */
export function isRecoverableWorkflow(value: unknown): value is Workflow {
  return shape(value, ['id', 'name', 'description', 'alias', 'mainConnectionId', 'pre', 'post', 'updatedAt', 'responseRetry', 'layout', 'graph', 'cloneSource', 'releasePolicy', 'inputScope', 'executionLimits', 'policyRouting'])
    && identifier(value.id) && string(value.name, 120) && string(value.description, 1000) && string(value.alias, 120)
    && string(value.mainConnectionId, 120) && string(value.updatedAt, 100) && array(value.pre, 36, group) && array(value.post, 36, group)
    && optional(value.inputScope, scope => member(scope, ['conversation', 'user_messages', 'last_user']))
    && optional(value.policyRouting, policyRouting)
    && optional(value.executionLimits, limits => shape(limits, ['timeoutMs', 'maxModelCalls']) && Number.isInteger(limits.timeoutMs) && number(limits.timeoutMs, 1000, 600000) && Number.isInteger(limits.maxModelCalls) && number(limits.maxModelCalls, 1, 1000))
    && optional(value.responseRetry, retry => shape(retry, ['enabled', 'maxRetries', 'instruction']) && typeof retry.enabled === 'boolean'
      && number(retry.maxRetries, 0, 100) && optional(retry.instruction, item => string(item, 2000)))
    && optional(value.layout, layout) && optional(value.graph, graph => shape(graph, ['version', 'pre', 'post']) && graph.version === 1
      && stageGraph(graph.pre) && stageGraph(graph.post)) && optional(value.cloneSource, cloneSource) && optional(value.releasePolicy, policy => shape(policy,['requireVerification','requiredDatasetIds']) && typeof policy.requireVerification==='boolean' && array(policy.requiredDatasetIds,30,item=>identifier(item)) && new Set(policy.requiredDatasetIds as string[]).size===(policy.requiredDatasetIds as string[]).length);
}
function record(value: unknown): value is WorkflowRecovery {
  return shape(value, ['workflowId', 'draft', 'base', 'savedAt']) && identifier(value.workflowId)
    && isRecoverableWorkflow(value.draft) && isRecoverableWorkflow(value.base) && value.draft.id === value.workflowId && value.base.id === value.workflowId
    && string(value.savedAt, 100) && Number.isFinite(Date.parse(value.savedAt));
}
function bytes(value: string): number { return new TextEncoder().encode(value).length; }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function failure(records: WorkflowRecovery[], error: string): RecoveryResult { return { ok: false, records, error }; }

function decode(raw: string | null): RecoveryResult {
  try {
    if (raw === null) return { ok: true, records: [] };
    if (bytes(raw) > MAX_WORKFLOW_RECOVERY_BYTES) return failure([], '임시 보관함이 읽을 수 있는 크기를 초과했습니다.');
    const value: unknown = JSON.parse(raw);
    if (!shape(value, ['version', 'records']) || value.version !== 1 || !Array.isArray(value.records) || value.records.length > MAX_WORKFLOW_RECOVERIES) {
      return failure([], '임시 보관함의 형식을 확인할 수 없습니다.');
    }
    const records: WorkflowRecovery[] = [], identifiers = new Set<string>();
    let invalid = false;
    for (const item of value.records) {
      if (!record(item) || identifiers.has(item.workflowId)) { invalid = true; continue; }
      identifiers.add(item.workflowId); records.push(item);
    }
    return invalid ? failure(records, '일부 임시 보관 내용을 읽지 못했습니다. 원본 보관함은 유지됩니다.') : { ok: true, records };
  } catch {
    return failure([], '임시 보관함의 형식을 확인할 수 없습니다.');
  }
}

/** Reading is safe during startup and does not overwrite corrupt or inaccessible browser data. */
export function readWorkflowRecovery(storage: RecoveryStorage | null | undefined): RecoveryResult {
  if (!storage) return failure([], '이 브라우저에서 임시 보관함을 사용할 수 없습니다.');
  try { return decode(storage.getItem(WORKFLOW_RECOVERY_KEY)); }
  catch { return failure([], '임시 보관함을 읽지 못했습니다. 브라우저 저장 권한을 확인하세요.'); }
}

function write(storage: RecoveryStorage, records: WorkflowRecovery[], previous: WorkflowRecovery[]): RecoveryResult {
  try {
    const serialized = JSON.stringify({ version: 1, records });
    if (bytes(serialized) > MAX_WORKFLOW_RECOVERY_BYTES) return failure(previous, '임시 보관함이 가득 찼습니다. 저장한 다른 초안의 임시 보관 내용을 정리하세요.');
    storage.setItem(WORKFLOW_RECOVERY_KEY, serialized);
    return { ok: true, records: copy(records) };
  } catch {
    return failure(previous, '임시 보관하지 못했습니다. 브라우저 저장 공간과 저장 권한을 확인하세요.');
  }
}

/** Call synchronously when editing or leaving a screen, even while the graph is incomplete. */
export function saveWorkflowRecovery(storage: RecoveryStorage | null | undefined, draft: Workflow, base: Workflow, savedAt = new Date().toISOString()): RecoveryResult {
  const previous = readWorkflowRecovery(storage);
  if (!previous.ok || !storage) return previous;
  try {
    const item = copy({ workflowId: draft.id, draft, base, savedAt });
    if (!record(item)) return failure(previous.records, '현재 초안의 임시 보관 형식을 확인하지 못했습니다.');
    const records = previous.records.filter(existing => existing.workflowId !== draft.id);
    if (records.length >= MAX_WORKFLOW_RECOVERIES) return failure(previous.records, '임시 보관할 수 있는 초안 수를 초과했습니다.');
    records.unshift(item);
    return write(storage, records, previous.records);
  } catch {
    return failure(previous.records, '현재 초안을 임시 보관하지 못했습니다.');
  }
}

export function removeWorkflowRecovery(storage: RecoveryStorage | null | undefined, workflowId: string): RecoveryResult {
  const previous = readWorkflowRecovery(storage);
  if (!previous.ok || !storage) return previous;
  if (!identifier(workflowId)) return failure(previous.records, '삭제할 임시 보관 초안을 확인하지 못했습니다.');
  if (!previous.records.some(item => item.workflowId === workflowId)) return previous;
  const records = previous.records.filter(item => item.workflowId !== workflowId);
  if (records.length) return write(storage, records, previous.records);
  try { storage.removeItem(WORKFLOW_RECOVERY_KEY); return { ok: true, records: [] }; }
  catch { return failure(previous.records, '임시 보관 내용을 삭제하지 못했습니다. 브라우저 저장 권한을 확인하세요.'); }
}

/** Call only after explicit confirmation to discard unreadable entries, keeping readable drafts. */
export function repairWorkflowRecovery(storage: RecoveryStorage | null | undefined): RecoveryResult {
  if (!storage) return failure([], '이 브라우저에서 임시 보관함을 사용할 수 없습니다.');
  let previous: RecoveryResult;
  try { previous = decode(storage.getItem(WORKFLOW_RECOVERY_KEY)); }
  catch { return failure([], '임시 보관함을 읽지 못했습니다. 브라우저 저장 권한을 확인하세요.'); }
  if (previous.ok) return previous;
  // setItem replaces the envelope atomically; never clear first, including a fully corrupt store.
  return write(storage, previous.records, previous.records);
}

/** Explicit discard removes the whole envelope; repair can instead preserve readable entries. */
export function clearWorkflowRecovery(storage: RecoveryStorage | null | undefined): RecoveryResult {
  const previous = readWorkflowRecovery(storage);
  if (!storage) return previous;
  try { storage.removeItem(WORKFLOW_RECOVERY_KEY); return { ok: true, records: [] }; }
  catch { return failure(previous.records, '임시 보관함을 비우지 못했습니다. 브라우저 저장 권한을 확인하세요.'); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function workflowRecoveryEqual(a: Workflow, b: Workflow): boolean {
  const { updatedAt: _a, ...left } = a, { updatedAt: _b, ...right } = b;
  return canonical(left) === canonical(right);
}
export function recoveryBaselineChanged(recovery: WorkflowRecovery, current: Workflow | null | undefined): boolean {
  return !current || current.id !== recovery.workflowId || !workflowRecoveryEqual(recovery.base, current);
}
