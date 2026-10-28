// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { sha256Hex } from './sha256.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { fieldAssertionErrors } from './output-expectations.ts';
import type { AppState, Connection, Dataset, DatasetRow, Rule, RuleKind, Workflow } from './aegis-types';
// @ts-expect-error Node's source test runner uses explicit TypeScript imports.
import { configurationFingerprint, datasetFingerprint } from './workflow-review.ts';

export type WorkflowRuleOption = { id: string; name: string; kind: RuleKind; enabled: boolean; stage: 'pre' | 'post'; groupId: string; groupName: string; rule: Rule };
export type DatasetCompatibilityCode = 'missing_rule' | 'disabled_rule' | 'ambiguous_rule' | 'impossible_stage' | 'rule_stage_mismatch' | 'missing_policy' | 'missing_policy_decision' | 'policy_route_mismatch' | 'policy_code_mismatch' | 'policy_field_mismatch';
export type DatasetCompatibilityIssue = { code: DatasetCompatibilityCode; rowId: string; rowNumber: number; ruleId?: string; stage?: 'pre' | 'post'; severity: 'warning'; message: string };
export type DatasetCompatibility = { issues: DatasetCompatibilityIssue[]; affectedRowIds: string[]; requiresAcknowledgement: boolean };
export type PreflightSide = { key: 'candidate' | 'baseline'; label: string; workflow: Workflow; connections: Connection[] };
export type EvaluationPreflightIssue = DatasetCompatibilityIssue & { sideKey: PreflightSide['key']; sideLabel: string };
export type EvaluationPreflight = { fingerprint: string; issues: EvaluationPreflightIssue[]; requiresAcknowledgement: boolean; sideFingerprints: { key: PreflightSide['key']; workflowFingerprint: string }[]; datasetFingerprint: string };
export type DatasetRuleMappingSuggestion = { sourceRuleId: string; rowIds: string[]; sourceName?: string; sourceKind?: RuleKind; sourceStage?: 'pre' | 'post'; candidates: WorkflowRuleOption[]; suggestedRuleId?: string; reason: string; ambiguous: boolean; requiresMapping: boolean };

const stageName = (stage: 'pre' | 'post') => stage === 'pre' ? '요청 검사' : '응답 검사';
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const unsafe = (key: string) => ['__proto__', 'constructor', 'prototype'].includes(key);
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Options are independent values so a review cannot mutate a workflow through a returned rule. */
export function getWorkflowRuleOptions(workflow: Workflow): WorkflowRuleOption[] {
  return (['pre', 'post'] as const).flatMap(stage => workflow[stage].flatMap(group => group.rules.map(rule => ({ id: rule.id, name: rule.name, kind: rule.kind, enabled: rule.enabled, stage, groupId: group.id, groupName: group.name, rule: structuredClone(rule) }))));
}

/** This checks criteria that cannot match, without predicting conditional or model-based execution. */
export function inspectDatasetCompatibility(dataset: Dataset, workflow: Workflow): DatasetCompatibility {
  const options = getWorkflowRuleOptions(workflow), issues: DatasetCompatibilityIssue[] = [];
  dataset.rows.forEach((row, index) => {
    const add = (code: DatasetCompatibilityCode, message: string, stage?: 'pre' | 'post') => issues.push({ code, rowId: row.id, rowNumber: index + 1, ...(row.expectedRuleId ? { ruleId: row.expectedRuleId } : {}), ...(stage ? { stage } : {}), severity: 'warning', message });
    if (row.expected === 'allow' && row.expectedStage && row.expectedStage !== 'complete') add('impossible_stage', '허용 결과는 모든 검사를 마친 완료 단계에서 반환됩니다. 예상 종료 단계를 확인하세요.');
    if (row.expected === 'block' && row.expectedStage && !['pre', 'post'].includes(row.expectedStage)) add('impossible_stage', '정책 차단은 요청 검사 또는 응답 검사에서 발생합니다. 예상 종료 단계를 확인하세요.');
    const routing = workflow.policyRouting;
    if (row.expectedDecision || row.expectedRoute || row.expectedPolicyCode || row.expectedPolicyFields) {
      if (!routing) add('missing_policy', '예상 정책 판정이나 경로가 있지만 이 워크플로우에는 정책 분기가 없습니다.');
      else {
        if(row.expectedPolicyFields && fieldAssertionErrors(row.expectedPolicyFields,routing.policy.outputSchema).length)add('policy_field_mismatch','예상 출력 필드 조건을 연결된 정책의 스키마에 맞게 확인하세요.','pre');
        const candidates = routing.policy.formatVersion === 2 ? (row.expectedDecision ? [] : routing.graph?.nodes.filter(node=>node.kind==='action') ?? []) : routing.routes.filter(route => !row.expectedDecision || route.decision === row.expectedDecision);
        if (row.expectedDecision && !candidates.length) add('missing_policy_decision', '예상 판정 코드가 선택한 정책 버전에 없습니다.', 'pre');
        else if (row.expectedRoute && !candidates.some(route => route.action === row.expectedRoute)) add('policy_route_mismatch', '예상 판정과 실행 경로의 연결이 현재 정책 설정과 다릅니다.', 'pre');
        if (row.expectedPolicyCode && !candidates.some(route => route.action === 'error' && route.errorCode === row.expectedPolicyCode)) add('policy_code_mismatch', '예상 오류 코드가 현재 정책의 오류 경로에 없습니다.', 'pre');
      }
    }
    if (!row.expectedRuleId) return;
    const matches = options.filter(option => option.id === row.expectedRuleId);
    if (!matches.length) { add('missing_rule', '지정한 검사가 이 워크플로우에 없습니다. 현재 검사를 연결하거나 예상 기준을 확인하세요.'); return; }
    if (matches.length > 1) { add('ambiguous_rule', '같은 ID의 검사가 여러 개 있어 예상 검사를 구분할 수 없습니다. 워크플로우의 검사 ID를 확인하세요.'); return; }
    const selected = matches[0];
    if (!selected.enabled) add('disabled_rule', '지정한 검사가 사용 중지되어 검사 결과 일치 여부를 확인할 수 없습니다.', selected.stage);
    if (row.expected === 'block' && (row.expectedStage === 'pre' || row.expectedStage === 'post') && row.expectedStage !== selected.stage) add('rule_stage_mismatch', `지정한 검사는 ${stageName(selected.stage)}에 있지만 예상 종료 단계가 다릅니다.`, selected.stage);
  });
  return { issues, affectedRowIds: [...new Set(issues.map(issue => issue.rowId))], requiresAcknowledgement: issues.length > 0 };
}

/** The acknowledgement is tied to reviewed dataset contents and both exact execution snapshots. */
export async function evaluationPreflight(dataset: Dataset, sides: PreflightSide[]): Promise<EvaluationPreflight> {
  if (!Array.isArray(sides) || !sides.length || sides.length > 2 || sides.some(side => !['candidate', 'baseline'].includes(side.key)) || new Set(sides.map(side => side.key)).size !== sides.length) throw new Error('점검할 검증 대상을 확인하세요.');
  const ordered = [...sides].sort((a, b) => (a.key === 'candidate' ? 0 : 1) - (b.key === 'candidate' ? 0 : 1));
  const [dataFingerprint, ...workflowFingerprints] = await Promise.all([datasetFingerprint(dataset), ...ordered.map(side => configurationFingerprint(side.workflow, side.connections))]);
  const sideFingerprints = ordered.map((side, index) => ({ key: side.key, workflowFingerprint: workflowFingerprints[index] }));
  const fingerprint = await sha256Hex(JSON.stringify({ version: 1, datasetFingerprint: dataFingerprint, sides: sideFingerprints }));
  const issues = ordered.flatMap(side => inspectDatasetCompatibility(dataset, side.workflow).issues.map(issue => ({ ...issue, sideKey: side.key, sideLabel: side.label })));
  return { fingerprint, issues, requiresAcknowledgement: issues.length > 0, sideFingerprints, datasetFingerprint: dataFingerprint };
}

function compatibleTarget(option: WorkflowRuleOption, rows: DatasetRow[]): boolean {
  return option.enabled && rows.every(row => row.expected !== 'block' || !row.expectedStage || row.expectedStage === option.stage);
}

/** Changes only explicitly reviewed rule IDs. The caller gives the copy its own dataset and row IDs. */
export function applyDatasetRuleMappings(dataset: Dataset, workflow: Workflow, mappings: Record<string, string>): Dataset {
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings) || ![Object.prototype, null].includes(Object.getPrototypeOf(mappings))) throw new Error('연결할 예상 검사 목록을 확인하세요.');
  const sourceIds = new Set(dataset.rows.flatMap(row => row.expectedRuleId ? [row.expectedRuleId] : []));
  const entries = Object.entries(mappings);
  if (entries.length > 100 || entries.some(([source, target]) => unsafe(source) || !sourceIds.has(source) || typeof target !== 'string' || !target.trim() || target.length > 120 || unsafe(target))) throw new Error('데이터셋에서 사용하는 검사 ID와 연결할 대상 검사를 확인하세요.');
  const options = getWorkflowRuleOptions(workflow);
  const rows = dataset.rows.map(row => {
    if (!row.expectedRuleId) return structuredClone(row);
    const targetId = own(mappings, row.expectedRuleId) ? mappings[row.expectedRuleId] : row.expectedRuleId;
    const targets = options.filter(option => option.id === targetId);
    if (targets.length !== 1) throw new Error('현재 워크플로우에 없는 예상 검사가 남아 있습니다. 각 항목의 대상 검사를 선택하세요.');
    if (!targets[0].enabled) throw new Error('사용 중지된 검사에는 예상 검사를 연결할 수 없습니다. 다른 검사를 선택하세요.');
    if (!compatibleTarget(targets[0], [row])) throw new Error('예상 종료 단계와 대상 검사 구간이 다릅니다. 데이터셋의 단계를 수정하거나 같은 구간의 검사를 선택하세요.');
    return { ...structuredClone(row), expectedRuleId: targetId };
  });
  return { ...structuredClone(dataset), rows };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, part]) => part !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Suggestions never alter criteria; ambiguous names or historical settings require a manual choice. */
export function suggestDatasetRuleMappings(dataset: Dataset, targetWorkflow: Workflow, state: Pick<AppState, 'workflows' | 'deployments' | 'runs'>): DatasetRuleMappingSuggestion[] {
  const targetOptions = getWorkflowRuleOptions(targetWorkflow), counts = new Map<string, number>();
  targetOptions.forEach(option => counts.set(option.id, (counts.get(option.id) || 0) + 1));
  const sourceIds = [...new Set(dataset.rows.flatMap(row => row.expectedRuleId ? [row.expectedRuleId] : []))], wanted = new Set(sourceIds);
  const sourceWorkflows = [...state.workflows, ...state.deployments.map(item => item.workflow), ...state.runs.flatMap(run => [run.workflowSnapshot, run.baselineWorkflowSnapshot].filter((item): item is Workflow => Boolean(item)))];
  // Historical snapshots can be large. Inspect only the at-most-100 referenced IDs,
  // without copying every guard configuration in every past deployment.
  const known: WorkflowRuleOption[] = [];
  for(const workflow of sourceWorkflows)for(const stage of ['pre','post'] as const)for(const group of workflow[stage])for(const rule of group.rules)if(wanted.has(rule.id))known.push({id:rule.id,name:rule.name,kind:rule.kind,enabled:rule.enabled,stage,groupId:group.id,groupName:group.name,rule});
  // Optional metadata is read defensively because older workflows have no clone lineage.
  const lineage = (targetWorkflow as Workflow & { cloneSource?: { workflowId: string; ruleIds: Record<string, string> } }).cloneSource;
  return sourceIds.map(sourceRuleId => {
    const rows = dataset.rows.filter(row => row.expectedRuleId === sourceRuleId);
    const candidates = targetOptions.filter(option => counts.get(option.id) === 1 && compatibleTarget(option, rows));
    const current = candidates.find(option => option.id === sourceRuleId);
    const sources = known.filter(option => option.id === sourceRuleId);
    const variants = new Map(sources.map(option => [canonical({ name: normalize(option.name), kind: option.kind, stage: option.stage, config: option.rule.config }), option]));
    const unique = variants.size === 1 ? [...variants.values()][0] : undefined;
    const sourceNames = [...new Set(sources.map(option => option.name))];
    const base: DatasetRuleMappingSuggestion = { sourceRuleId, rowIds: rows.map(row => row.id), ...(sourceNames.length === 1 ? { sourceName: sourceNames[0] } : {}), ...(unique ? { sourceKind: unique.kind, sourceStage: unique.stage } : {}), candidates, reason: '', ambiguous: false, requiresMapping: !current };
    if (current) return { ...base, suggestedRuleId: current.id, reason: '현재 워크플로우에서 같은 검사 ID를 사용하고 있습니다.' };
    const mappedId = lineage?.ruleIds && own(lineage.ruleIds, sourceRuleId) ? lineage.ruleIds[sourceRuleId] : undefined;
    const linked = mappedId && candidates.find(option => option.id === mappedId);
    if (linked) return { ...base, suggestedRuleId: linked.id, reason: '복제 연결 정보에 기록된 검사입니다. 현재 설정을 확인한 뒤 저장하세요.' };
    if (!candidates.length) return { ...base, reason: '사용 중인 검사와 예상 종료 단계가 맞는 대상이 없습니다. 먼저 검사 사용 여부나 데이터셋의 단계를 확인하세요.' };
    if (variants.size > 1) return { ...base, ambiguous: true, reason: '원래 검사의 기록마다 이름이나 설정이 다릅니다. 연결할 검사를 직접 선택하세요.' };
    if (!unique) return { ...base, reason: '원래 검사 정보를 찾지 못했습니다. 연결할 검사를 직접 선택하세요.' };
    const matches = candidates.filter(option => normalize(option.name) === normalize(unique.name) && option.kind === unique.kind && option.stage === unique.stage);
    if (matches.length === 1) return { ...base, suggestedRuleId: matches[0].id, reason: '이름과 종류, 검사 구간이 같은 검사를 찾았습니다. 설정을 확인한 뒤 저장하세요.' };
    return { ...base, ambiguous: matches.length > 1, reason: matches.length > 1 ? '같은 이름과 종류의 검사가 여러 개입니다. 연결할 검사를 직접 선택하세요.' : '같은 이름과 종류의 검사를 찾지 못했습니다. 연결할 검사를 직접 선택하세요.' };
  });
}
