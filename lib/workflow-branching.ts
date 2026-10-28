// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { randomUuid } from './client-id.ts';
import type { FlowCondition, FlowControlNode, FlowEdge, Workflow } from './aegis-types';
// @ts-expect-error Node's source test runner uses explicit TypeScript imports.
import { createStageGraph, getStageGraph, validateWorkflowGraph } from './workflow-graph.ts';

export type BranchStage = 'pre' | 'post';
export type BranchKind = 'parallel' | 'condition';
export type BranchSelectionPreview = {
  valid: boolean;
  reason?: string;
  stage: BranchStage;
  kind: BranchKind;
  /** Execution order, independent from click order and persistence array order. */
  groupIds: string[];
  signature: string;
  incoming?: FlowEdge;
  outgoing?: FlowEdge;
  replacedEdgeIds: string[];
};
export type BranchBuildOptions = { condition?: FlowCondition; identifier?: (prefix: string) => string };

const stagePrefix = (stage: BranchStage) => stage === 'pre' ? '요청 검사:' : '응답 검사:';
function signature(workflow: Workflow): string {
  return JSON.stringify({ workflowId: workflow.id, pre: getStageGraph(workflow, 'pre'), post: getStageGraph(workflow, 'post'), groups: (['pre', 'post'] as const).map(stage => workflow[stage].map(group => ({ id: group.id, name: group.name, required: group.required === true, rules: group.rules.map(rule => ({ id: rule.id, name: rule.name })) }))) });
}
function selectedStageIssues(workflow: Workflow, stage: BranchStage): string[] {
  return validateWorkflowGraph(workflow).filter(message => message.startsWith(stagePrefix(stage)) || !message.includes(':'));
}
function label(workflow: Workflow, stage: BranchStage, id: string): string {
  const group = workflow[stage].find(item => item.id === id);
  return group?.rules.length === 1 ? group.rules[0].name : group?.name || '선택한 검사';
}

/** Eligibility is also used by the canvas so limitations are visible before a click. */
export function previewBranchSelection(workflow: Workflow, stage: BranchStage, groupIds: string[], kind: BranchKind = 'parallel'): BranchSelectionPreview {
  const result: BranchSelectionPreview = { valid: false, stage, kind, groupIds: [], signature: '', replacedEdgeIds: [] };
  const reject = (reason: string): BranchSelectionPreview => ({ ...result, reason });
  try {
    if (!workflow || typeof workflow.id !== 'string' || !['pre', 'post'].includes(stage) || !['parallel', 'condition'].includes(kind) || !Array.isArray(workflow.pre) || !Array.isArray(workflow.post)) return reject('현재 워크플로우와 검사 구간을 확인하세요.');
    if (!Array.isArray(groupIds) || groupIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(groupIds).size !== groupIds.length) return reject('서로 다른 검사 노드를 선택하세요.');
    if (kind === 'parallel' && (groupIds.length < 2 || groupIds.length > 4)) return reject('동시에 실행할 검사 노드를 2~4개 선택하세요.');
    if (kind === 'condition' && groupIds.length !== 2) return reject('조건별로 실행할 검사 노드를 두 개 선택하세요.');
    const groups = workflow[stage];
    const globalIds = [...workflow.pre, ...workflow.post].map(group => group?.id);
    if (globalIds.some(id => typeof id !== 'string') || new Set(globalIds).size !== globalIds.length) return reject('검사 노드 ID가 중복되거나 올바르지 않습니다. 설정 점검에서 확인하세요.');
    if (groupIds.some(id => !groups.some(group => group.id === id))) return reject('같은 요청 검사 또는 응답 검사 구간의 노드만 선택하세요.');
    if (groupIds.some(id => groups.find(group => group.id === id)?.required === true)) return reject('필수 실행인 검사는 분기 전이나 합류 후에 두세요. 선택한 검사에서 필수 실행을 해제하면 구성할 수 있습니다.');
    const graph = getStageGraph(workflow, stage);
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return reject('현재 구간의 연결 설정을 먼저 확인하세요.');
    if (graph.nodes.some(node => !node || typeof node.id !== 'string' || typeof node.name !== 'string' || !['condition', 'fork', 'join'].includes(node.kind)) || new Set(graph.nodes.map(node => node.id)).size !== graph.nodes.length
      || graph.edges.some(edge => !edge || typeof edge.id !== 'string' || !edge.id.trim() || typeof edge.from !== 'string' || typeof edge.to !== 'string' || (edge.port !== undefined && !['next', 'true', 'false'].includes(edge.port))) || new Set(graph.edges.map(edge => edge.id)).size !== graph.edges.length) return reject('현재 구간의 노드와 연결선 ID 또는 형식을 먼저 확인하세요.');
    const globalIssues = validateWorkflowGraph(workflow).filter(message => !message.includes(':'));
    if (globalIssues.length) return reject(globalIssues[0]);
    if (graph.nodes.length + 2 > 12) return reject('분기와 결과 합류를 추가할 제어 노드 공간이 필요합니다. 제어 노드는 구간마다 최대 12개입니다.');
    if (graph.edges.length + groupIds.length + 1 > 64) return reject(`이 구성에는 연결선 ${groupIds.length + 1}개가 더 필요합니다. 구간별 연결선 한도 64개를 넘습니다.`);
    const selected = new Set(groupIds.map(id => `group:${id}`));
    const incoming = new Map<string, FlowEdge>(), outgoing = new Map<string, FlowEdge>();
    for (const id of groupIds) {
      const endpoint = `group:${id}`;
      const ins = graph.edges.filter(edge => edge.to === endpoint), outs = graph.edges.filter(edge => edge.from === endpoint);
      if (ins.length !== 1 || outs.length !== 1 || (outs[0].port || 'next') !== 'next') return reject(`${label(workflow, stage, id)}의 들어오는 연결과 나가는 연결이 각각 하나여야 합니다.`);
      incoming.set(endpoint, ins[0]); outgoing.set(endpoint, outs[0]);
    }
    const heads = [...selected].filter(endpoint => !selected.has(incoming.get(endpoint)!.from));
    if (heads.length !== 1) return reject('현재 실행 순서에서 바로 이어진 검사 노드를 선택하세요. 떨어진 검사나 서로 다른 분기 안의 검사는 함께 구성할 수 없습니다.');
    const ordered: string[] = [], visited = new Set<string>();
    let endpoint = heads[0];
    while (selected.has(endpoint) && !visited.has(endpoint)) {
      visited.add(endpoint); ordered.push(endpoint.slice(6)); endpoint = outgoing.get(endpoint)!.to;
    }
    if (ordered.length !== groupIds.length || selected.has(endpoint)) return reject('현재 실행 순서에서 빠진 노드 없이 바로 이어진 검사 노드를 선택하세요.');
    const first = `group:${ordered[0]}`, last = `group:${ordered.at(-1)}`;
    const entry = incoming.get(first)!, exit = outgoing.get(last)!;
    if (selected.has(entry.from) || selected.has(exit.to)) return reject('선택한 검사 앞뒤의 연결을 확인하세요.');
    result.signature = signature(workflow);
    return { ...result, valid: true, groupIds: ordered, incoming: structuredClone(entry), outgoing: structuredClone(exit), replacedEdgeIds: [entry.id, ...ordered.map(id => outgoing.get(`group:${id}`)!.id)] };
  } catch {
    return reject('선택한 검사와 연결 설정을 확인하세요. 현재 구성으로는 경로를 만들 수 없습니다.');
  }
}

/** Builds only after a fresh eligibility check; callers apply its workflow as one undo action. */
export function buildBranchSelection(workflow: Workflow, preview: BranchSelectionPreview, options: BranchBuildOptions = {}): { workflow: Workflow; splitId: string; joinId: string } {
  if (!preview?.valid) throw new Error(preview?.reason || '구성할 검사 노드를 선택하세요.');
  const current = previewBranchSelection(workflow, preview.stage, preview.groupIds, preview.kind);
  if (!current.valid) throw new Error(current.reason || '현재 검사 노드로 구성할 수 없습니다.');
  if (!preview.signature || current.signature !== preview.signature) throw new Error('연결 설정이 변경되었습니다. 검사 노드를 다시 선택하고 구성을 확인하세요.');
  const next = structuredClone(workflow);
  next.graph ||= { version: 1, pre: createStageGraph(next.pre), post: createStageGraph(next.post) };
  const graph = next.graph[preview.stage];
  const used = new Set((['pre', 'post'] as const).flatMap(stage => [...next[stage].flatMap(group => [group.id, ...group.rules.map(rule => rule.id)]), ...next.graph![stage].nodes.map(node => node.id), ...next.graph![stage].edges.map(edge => edge.id)]));
  const generate = options.identifier || ((prefix: string) => `${prefix}-${randomUuid().slice(0, 12)}`);
  function fresh(prefix: string): string {
    for (let attempt = 0; attempt < 64; attempt++) {
      const id = generate(prefix);
      if (typeof id === 'string' && id.trim() && id.length <= 120 && !used.has(id)) { used.add(id); return id; }
    }
    throw new Error('새 노드의 ID를 만들지 못했습니다. 다시 시도하세요.');
  }
  const split: FlowControlNode = { id: fresh('control'), kind: preview.kind === 'condition' ? 'condition' : 'fork', name: preview.kind === 'condition' ? '조건 분기' : '병렬 분기', ...(preview.kind === 'condition' ? { condition: structuredClone(options.condition) } : {}) };
  const join: FlowControlNode = { id: fresh('control'), kind: 'join', name: '결과 합류' };
  const removed = new Set(current.replacedEdgeIds);
  graph.nodes.push(split, join);
  graph.edges = graph.edges.filter(edge => !removed.has(edge.id));
  graph.edges.push({ ...current.incoming!, to: `control:${split.id}` });
  current.groupIds.forEach((id, index) => {
    graph.edges.push({ id: fresh('edge'), from: `control:${split.id}`, to: `group:${id}`, port: preview.kind === 'condition' ? index === 0 ? 'true' : 'false' : 'next' });
    graph.edges.push({ id: fresh('edge'), from: `group:${id}`, to: `control:${join.id}`, port: 'next' });
  });
  graph.edges.push({ ...current.outgoing!, from: `control:${join.id}` });
  const previousIssues = new Set(selectedStageIssues(workflow, preview.stage));
  const issues = selectedStageIssues(next, preview.stage).filter(message => !previousIssues.has(message));
  if (issues.length) throw new Error(issues[0]);
  return { workflow: next, splitId: split.id, joinId: join.id };
}
