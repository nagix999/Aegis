'use client';

import { randomUuid } from '@/lib/client-id';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlignLeft, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, BrainCircuit, Braces, Check, ChevronDown, ChevronUp, ChevronRight, ClipboardCheck, Copy, FileJson, GitBranch, Layers3, ListChecks, LogIn, LogOut, Maximize2, Minimize2, PanelRight, Pin, PinOff, Play, Plus, Redo2, RefreshCw, Regex, Rocket, Save, Search, Server, Settings2, ShieldCheck, Split, Trash2, Undo2, X } from 'lucide-react';
import type { AppState, CanvasZone, Connection, ExecutionResult, FlowEdge, PiiType, Rule, RuleGroup, RuleKind, Trace, Workflow } from '@/lib/aegis-types';
import { validateConnection, validateWorkflow } from '@/lib/aegis-engine';
import { configurationFingerprint, executionConfiguration, referencedConnections } from '@/lib/workflow-review';
import { makeRule, nodeCatalog, ruleKindLabels, type NodeTemplate } from '@/lib/node-catalog';
import { Empty, Tag, type Act } from './console-ui';
import { useWorkflowRunner, type WorkflowRunnerExecution } from './workflow-runner';
import { connectionLabel } from '@/lib/product-copy';
import { autoLayout, clampPosition, createZoneForNodes, executionEndpointKey, knownLayoutKeys, NODE_HEIGHT, NODE_WIDTH, nodeDefinitions, normalizedPinnedKeys, resolveLayout, visibleLayoutKey, type WorkflowSelection } from '@/lib/workflow-layout';
import { NodeExecutionInspector } from './node-execution-inspector';
import { WorkflowCanvas, type CanvasViewport } from './workflow-canvas';
import { endpointLabel, getStageGraph, graphNodeKeys, validateWorkflowGraph } from '@/lib/workflow-graph';
import { WorkflowGraphSettings } from './workflow-graph-settings';
import { WorkflowPolicySettings } from './workflow-policy-settings';
import { PolicyGraphEditor } from './policy-graph-editor';
import { policyOutputSchema, policyRoutingErrors } from '@/lib/policy-routing';
import { policyNodePorts } from '@/lib/policy-graph';
import { addWorkflowPolicyCheck, listWorkflowPolicyChecks, workflowPolicyCheck, workflowPolicyNode, updateWorkflowPolicyCheck, removeWorkflowPolicyCheck, policyScopedId, parsePolicyScopedId, workflowPolicyCheckErrors } from '@/lib/workflow-policy-checks';
import { addConnectedWorkflowPolicyNode, addWorkflowPolicyGraphNode, connectWorkflowPolicyNode, removeWorkflowPolicy, setWorkflowPolicyEntryNode } from '@/lib/workflow-policy-nodes';
import { addWorkflowControlNode, addWorkflowCheckGroup } from '@/lib/workflow-node-library';
import { applyConnection, captureInsertTarget, insertCheckOnEdge, previewConnection, type FlowConnectionImpact, type FlowInsertTarget } from '@/lib/workflow-connections';
import { policyGraphSchemaIssues } from '@/lib/policy-schema-guidance';
import { policyNodeInputIssues, ruleIssueField } from '@/lib/workflow-input-guidance';
import { searchWorkflowNodes } from '@/lib/workflow-search';
import { emptyWorkflowHistory, rememberWorkflowChange, restoreWorkflowHistory, type WorkflowHistory } from '@/lib/workflow-history';
import { previewBranchSelection } from '@/lib/workflow-branching';
import { captureCreationTargets, previewParallelCheckOnEdge, addParallelCheckOnEdge } from '@/lib/workflow-node-creation';
import { completeZoneSelection, normalizedZoneNodeKeys, zoneMembershipIssue, workflowZoneIssues, reconcileContiguousZoneResult } from '@/lib/workflow-zones';
import './workflow-canvas.css';

type Stage = 'pre' | 'post';
type Selection = WorkflowSelection;
type InsertContext = { target: FlowInsertTarget; position?: { x: number; y: number }; mode?: 'insert'|'branch' };
type CreationContext = {targets:FlowInsertTarget[];position?:{x:number;y:number};edgeId:string};
type NextSource = { stage: Stage; from: string; port: 'next' | 'true' | 'false' };
type ConnectionReview = NextSource & { to: string; baseline: string };
type InitialPreset = { kind: 'parallel' | 'condition'; firstGroupId: string; secondGroupId: string; groupIds?: string[]; requestId: string };
export type WorkflowEditorSession = {
  workflowId: string;
  history: WorkflowHistory;
  selection: Selection;
  inspectorOpen: boolean;
  panelMode: 'workflow' | 'node' | 'graph' | 'zone';
  graphStage: Stage;
  graphControlId?: string;
  graphEdgeId?: string;
  view: 'builder' | 'json';
  checksOpen: boolean;
  canvas?: CanvasViewport;
  inspectorScrollTop?: number;
};
export type WorkflowEditorProps = {
  workflow: Workflow;
  connections: Connection[];
  dirty: boolean;
  busy: boolean;
  status: 'draft' | 'deployed' | 'changed';
  version?: number;
  readOnly?: boolean;
  canDeploy?: boolean;
  execution?: WorkflowRunnerExecution;
  state?: AppState;
  act?: Act;
  onPrepareExecution?: () => Promise<boolean>;
  onExecution?: (execution: WorkflowRunnerExecution) => void;
  initialRuleId?: string;
  onRetest?: () => Promise<unknown>;
  session?: WorkflowEditorSession;
  onSessionChange?: (session: WorkflowEditorSession) => void;
  onTemporarySave?: () => void;
  temporarySaveStatus?: string;
  onReturnToEvaluation?: () => void;
  onEvaluateCurrentWorkflow?: () => void;
  evaluationOriginLabel?: string;
  onChange: (workflow: Workflow) => void;
  onSave: () => Promise<unknown>;
  onTest: () => Promise<unknown>;
  onDeploy: () => Promise<unknown>;
  onSettings: () => void;
  onConnections: () => void;
  onOpenPolicy?: (policyId:string,version:number)=>void;
  onCreateSwitchDataset?:(workflow:Workflow,nodeId:string)=>void;
  notify: (message: string) => void;
};
const icons: Record<RuleKind, LucideIcon> = { keyword: Braces, regex: Regex, length: AlignLeft, llm: BrainCircuit, policy: BrainCircuit, pii: ShieldCheck, json: FileJson, required: ListChecks };
const stageName = { pre: '요청 검사', post: '응답 검사' };
const id = (prefix: string) => `${prefix}-${randomUuid().slice(0, 8)}`;
function selectedBranchPreview(workflow:Workflow,keys:string[],kind:'parallel'|'condition'):ReturnType<typeof previewBranchSelection> {
  const definitions=nodeDefinitions(workflow),visible=new Set(definitions.map(node=>node.key));
  const selected=[...new Set(keys.map(key=>visibleLayoutKey(workflow,key)).filter((key):key is string=>Boolean(key&&visible.has(key))))];
  const invalid=(reason:string):ReturnType<typeof previewBranchSelection>=>({valid:false,reason,stage:'pre',kind,groupIds:[],signature:'',replacedEdgeIds:[]});
  if(kind==='condition'&&selected.length!==2)return invalid('조건 분기는 검사 노드 2개를 선택하세요.');
  if(kind==='parallel'&&(selected.length<2||selected.length>4))return invalid('동시에 실행할 검사 노드 2~4개를 선택하세요.');
  const chosen=selected.map(key=>definitions.find(node=>node.key===key));
  if(chosen.some(node=>!node?.groupId||!node.stage))return invalid('검사 노드만 선택하세요. 입력과 출력, 응답 모델과 제어 노드는 함께 구성할 수 없습니다.');
  const stage=chosen[0]!.stage!;
  if(chosen.some(node=>node!.stage!==stage))return invalid('요청 검사와 응답 검사는 각각 구성하세요. 같은 검사 구간의 노드를 선택하세요.');
  return previewBranchSelection(workflow,stage,chosen.map(node=>node!.groupId!),kind);
}
function findRule(workflow: Workflow, ruleId: string) {
  for (const stage of ['pre', 'post'] as const) for (const group of workflow[stage]) {
    const index = group.rules.findIndex(rule => rule.id === ruleId);
    if (index >= 0) return { stage, group, index, rule: group.rules[index] };
  }
  return undefined;
}
function findGroup(workflow: Workflow, groupId: string) {
  for (const stage of ['pre', 'post'] as const) {
    const index = workflow[stage].findIndex(group => group.id === groupId);
    if (index >= 0) return { stage, index, group: workflow[stage][index] };
  }
  return undefined;
}
function findControl(workflow: Workflow, controlId: string) {
  for (const stage of ['pre', 'post'] as const) {
    const control = getStageGraph(workflow, stage).nodes.find(node => node.id === controlId);
    if (control) return { stage, control };
  }
  return undefined;
}
// A group with multiple incident paths must be rewired explicitly before it is
// removed. A simple serial step can be removed without changing its neighbours.
function detachGraphGroup(next: Workflow, stage: Stage, groupId: string): boolean {
  if (!next.graph) return true;
  const graph = next.graph[stage], endpoint = `group:${groupId}`;
  const incoming = graph.edges.filter(edge => edge.to === endpoint), outgoing = graph.edges.filter(edge => edge.from === endpoint);
  if (!incoming.length && !outgoing.length) return true;
  if (incoming.length !== 1 || outgoing.length !== 1 || incoming[0].from === outgoing[0].to || graph.edges.some(edge => edge.from !== endpoint && edge.to !== endpoint && edge.from === incoming[0].from && edge.to === outgoing[0].to && (edge.port || 'next') === (incoming[0].port || 'next'))) return false;
  graph.edges = graph.edges.filter(edge => edge.from !== endpoint && edge.to !== endpoint);
  graph.edges.push({ ...incoming[0], to: outgoing[0].to }); return true;
}
function appendGraphGroup(next: Workflow, stage: Stage, groupId: string, afterId?: string): boolean {
  if (!next.graph) return true;
  const graph = next.graph[stage], endpoint = `group:${groupId}`;
  if (graph.edges.some(edge => edge.from === endpoint || edge.to === endpoint)) return true;
  const candidates = graph.edges.filter(edge => afterId ? edge.from === `group:${afterId}` : edge.to === 'end');
  if (candidates.length !== 1) return false;
  const previous = candidates[0];
  graph.edges = graph.edges.map(edge => edge.id === previous.id ? { ...edge, to: endpoint } : edge);
  graph.edges.push({ id: id('edge'), from: endpoint, to: previous.to, port: 'next' }); return true;
}
type IssueTarget = Selection | { kind: 'settings' } | { kind: 'graph'; stage?: Stage };
type WorkflowIssue = { message: string; target: IssueTarget; label: string; field?: string; predicateIndex?: number };
type PolicyCreation = {from:string;port:string;baseline:string;position?:{x:number;y:number}};
const policyCreationBaseline=(workflow:Workflow)=>JSON.stringify(listWorkflowPolicyChecks(workflow).map(scope=>({id:scope.id,routing:scope.routing})));
function connectionBaseline(workflow: Workflow) { return JSON.stringify({ workflowId: workflow.id, pre: getStageGraph(workflow, 'pre'), post: getStageGraph(workflow, 'post'), groups: [...workflow.pre, ...workflow.post].map(group => ({ id: group.id, name: group.name, required: group.required === true, ruleIds: group.rules.map(rule => rule.id) })) }); }

// Validate small scopes with the same engine used at execution time. This keeps
// node links accurate without maintaining a second set of validation rules.
function workflowIssues(workflow: Workflow, connections: Connection[]): WorkflowIssue[] {
  const subject = { ...workflow, graph: undefined };
  const errors = validateWorkflow(subject, connections);
  if (!errors.length) return [];
  const base = { ...subject, pre: [], post: [] };
  const baseErrors = new Set(validateWorkflow(base, connections));
  const policyErrors = new Set(workflow.policyRouting ? policyRoutingErrors(workflow.policyRouting) : []);
  const scopes: { target: Selection; label: string; errors: Set<string> }[] = [];
  for (const stage of ['pre', 'post'] as const) for (const group of workflow[stage]) {
    const groupErrors = new Set(validateWorkflow({ ...base, [stage]: [{ ...group, rules: [] }] }, connections).filter(error => !baseErrors.has(error) && (!group.rules.length || error !== '검사 조합에 검사를 하나 이상 추가하세요.')));
    scopes.push({ target: { kind: 'group', id: group.id }, label: `${stageName[stage]} / ${group.rules.length === 1 ? group.rules[0].name : group.name || '이름 없는 검사 조합'}`, errors: groupErrors });
    for (const rule of group.rules) {
      const ruleErrors = validateWorkflow({ ...base, [stage]: [{ ...group, rules: [rule] }] }, connections).filter(error => !baseErrors.has(error) && !groupErrors.has(error));
      const connection = rule.enabled && rule.kind === 'llm' ? connections.find(item => item.id === rule.config.connectionId) : undefined;
      if (connection) ruleErrors.push(...validateConnection(connection));
      scopes.push({ target: { kind: 'rule', id: rule.id }, label: `${stageName[stage]} / ${rule.name || '이름 없는 검사'}`, errors: new Set(ruleErrors) });
    }
  }
  return errors.flatMap(message => {
    const matches = scopes.filter(scope => scope.errors.has(message));
    const entries: WorkflowIssue[] = matches.map(scope => ({ message, target: scope.target, label: scope.label }));
    if (baseErrors.has(message)) {
      const settings = message.startsWith('워크플로우 ID') || message.startsWith('API 모델 이름');
      entries.unshift({ message, target: policyErrors.has(message) ? { kind: 'policy' } : settings ? { kind: 'settings' } : { kind: 'main' }, label: policyErrors.has(message) ? '정책 검사 노드' : settings ? '기본 설정' : '응답 생성 모델' });
    }
    return entries.length ? entries : [{ message, target: { kind: 'settings' }, label: '워크플로우 설정' } satisfies WorkflowIssue];
  });
}

function attemptName(attempt: number) { return attempt <= 1 ? '최초 생성' : `재작성 ${attempt - 1}회`; }
function NodeExecution({ traces, stale, main = false }: { traces: Trace[]; stale: boolean; main?: boolean }) {
  const trace = traces[traces.length - 1];
  const label = !trace ? '실행 기록 없음' : trace.status === 'allow' ? (main ? '생성 완료' : '통과') : trace.status === 'block' ? '위반' : trace.status === 'error' ? '오류' : '실행 안 함';
  return <span className={`we-node-execution ${trace?.status || 'missing'} ${stale ? 'stale' : ''}`}>
    <span className="we-node-execution-status"><strong>{label}</strong>{trace && <span>{trace.latencyMs.toLocaleString()}ms</span>}</span>
    {(traces.length > 1 || (trace?.attempt ?? 1) > 1) && <span className="we-node-execution-attempt"><span>{attemptName(trace.attempt ?? traces.length)} 결과</span><span>{main ? '생성 시도' : '검사 내역'} {traces.length}회</span></span>}
    <span className="we-node-execution-reason">{trace?.reason || '이 결과에는 해당 노드의 실행 내역이 없습니다. 다시 검증하면 현재 설정의 결과를 확인할 수 있습니다.'}</span>
  </span>;
}
function TraceAttempts({ traces, main = false }: { traces: Trace[]; main?: boolean }) {
  if (traces.length < 2) return null;
  return <details className="we-trace-attempts"><summary>회차별 실행 내역 ({traces.length}회)</summary><ol>{traces.map((trace, index) => <li key={`${trace.attempt ?? index}-${index}`}><div><strong>{attemptName(trace.attempt ?? index + 1)}</strong><Tag tone={trace.status === 'allow' ? 'success' : trace.status === 'block' ? 'warning' : trace.status === 'error' ? 'error' : 'neutral'}>{trace.status === 'allow' ? main ? '생성 완료' : '통과' : trace.status === 'block' ? '위반' : trace.status === 'error' ? '오류' : '실행 안 함'}</Tag><span>{trace.latencyMs.toLocaleString()}ms</span></div><p>{trace.reason}</p></li>)}</ol></details>;
}
function KeyListField({ value, onChange, disabled }: { value: string[]; onChange: (keys: string[]) => void; disabled?: boolean }) {
  const [text, setText] = useState(value.join('\n'));
  const focused = useRef(false);
  const signature = JSON.stringify(value);
  useEffect(() => { if (!focused.current) setText(value.join('\n')); }, [signature]);
  return <textarea rows={3} disabled={disabled} value={text} onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; setText(value.join('\n')); }} onChange={event => { setText(event.target.value); onChange(event.target.value.split(/\n|,/).map(key => key.trim()).filter(Boolean)); }} placeholder={'answer\nsource'} />;
}

export function WorkflowEditor({ workflow, connections, dirty, busy, status, version, readOnly = false, canDeploy = true, execution: initialExecution, state, act, onPrepareExecution, onExecution, initialRuleId, onRetest, session, onSessionChange, onTemporarySave, temporarySaveStatus, onReturnToEvaluation, onEvaluateCurrentWorkflow, evaluationOriginLabel, onChange, onSave, onTest, onDeploy, onConnections, onOpenPolicy, onCreateSwitchDataset, notify }: WorkflowEditorProps) {
  const restoredSession = session?.workflowId === workflow.id ? session : undefined;
  const [selection, setSelection] = useState<Selection>(restoredSession?.selection || { kind: 'main' });
  const [inspectorOpen, setInspectorOpen] = useState(restoredSession?.inspectorOpen || false);
  const [panelMode, setPanelMode] = useState<'workflow' | 'node' | 'library' | 'graph' | 'zone' | 'next' | 'connection' | 'create' | 'policy-create'>(restoredSession?.panelMode || 'workflow');
  const [libraryReturnMode, setLibraryReturnMode] = useState<'workflow' | 'node' | 'graph' | 'zone' | 'next' | 'connection' | 'create' | 'policy-create'>('workflow');
  const [graphStage, setGraphStage] = useState<Stage>(restoredSession?.graphStage || 'pre');
  const [graphControlId, setGraphControlId] = useState<string | undefined>(restoredSession?.graphControlId);
  const [graphEdgeId, setGraphEdgeId] = useState<string | undefined>(restoredSession?.graphEdgeId);
  const [policyEdgeFocus,setPolicyEdgeFocus]=useState<{edgeId:string;request:number}>();
  const policyEdgeSequence=useRef(0);
  const [narrowPanel, setNarrowPanel] = useState(false);
  const [view, setView] = useState<'builder' | 'json'>(restoredSession?.view || 'builder');
  const [library, setLibrary] = useState<{ stage: Stage; groupId: string; parallel: boolean; zoneId?: string; insert?: InsertContext }>();
  const [pendingInsert, setPendingInsert] = useState<InsertContext>();
  const [policyCreation,setPolicyCreation]=useState<PolicyCreation>();
  const [inspectorNodeSearch,setInspectorNodeSearch]=useState(false);
  const [inspectorNodeQuery,setInspectorNodeQuery]=useState('');
  const [creation,setCreation]=useState<CreationContext>();
  const [autoFitRequest,setAutoFitRequest]=useState(0);
  const [insertError, setInsertError] = useState('');
  const [nextSource, setNextSource] = useState<NextSource>();
  const [targetQuery, setTargetQuery] = useState('');
  const [connectionReview, setConnectionReview] = useState<ConnectionReview>();
  const [initialPreset, setInitialPreset] = useState<InitialPreset>();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [zoneQuery, setZoneQuery] = useState('');
  const [selectedTemplates, setSelectedTemplates] = useState<string[]>([]);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [policyChooser,setPolicyChooser]=useState(false);
  const [newPolicyKey,setNewPolicyKey]=useState('');
  const [libraryPolicyOwner,setLibraryPolicyOwner]=useState('');
  const [deletePolicyConfirm,setDeletePolicyConfirm]=useState(false);
  const [category, setCategory] = useState<'all' | 'rule' | 'llm' | 'flow' | 'action' | 'builtin'>('all');
  const [conditionChooser,setConditionChooser]=useState(false);
  const [conditionTarget,setConditionTarget]=useState<'policy'|'text'>('text');
  const [history, setHistory] = useState<WorkflowHistory>(restoredSession ? { past: restoredSession.history.past, future: restoredSession.history.future } : emptyWorkflowHistory);
  const [moveStage, setMoveStage] = useState<Stage>('pre');
  const [moveGroupId, setMoveGroupId] = useState('');
  const [deletingGroup, setDeletingGroup] = useState<string>();
  const [checksOpen, setChecksOpen] = useState(restoredSession?.checksOpen || false);
  const [retesting, setRetesting] = useState(false);
  const [runnerOpen, setRunnerOpen] = useState(Boolean(initialExecution) || initialRuleId === 'input' || restoredSession?.selection.kind === 'input');
  const [inspectorTab,setInspectorTab]=useState<'settings'|'execution'>('settings');
  const [runnerExpanded,setRunnerExpanded]=useState(false);
  const [newSwitchId,setNewSwitchId]=useState<string>();
  const [expanded,setExpanded]=useState(false);
  const [executionAttempt, setExecutionAttempt] = useState<number>();
  const editorRef = useRef<HTMLElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const nodeActionsRef = useRef<{deleteNode:()=>void}>(null);
  const fieldSequence = useRef(0);
  const activeTextField = useRef<{ element: Element; key: string; changedWorkflow: boolean } | undefined>(undefined);
  const pendingTextChange = useRef<string | undefined>(undefined);
  const sessionCallback = useRef(onSessionChange);
  sessionCallback.current = onSessionChange;
  const canvasViewport = useRef<CanvasViewport | undefined>(restoredSession?.canvas);
  const inspectorScroll = useRef(restoredSession?.inspectorScrollTop || 0);
  const [graphImpact, setGraphImpact] = useState<FlowConnectionImpact>();
  const [focusRequest, setFocusRequest] = useState<{ stage: Stage; endpoint: string; requestId: string }>();
  const runner = useWorkflowRunner({ workflow, connections, state, act, readOnly, disabled: busy, initialExecution, onPrepareExecution, onExecution, onSelectPolicyNode:nodeId=>selectNode({kind:'policy-node',id:nodeId}) });
  const execution = runner.hasStarted ? runner.execution : initialExecution;
  useEffect(() => { setExecutionAttempt(undefined); }, [execution?.result.id]);
  const editingDisabled = busy || readOnly || runner.busy;
  const graphErrors = useMemo(() => validateWorkflowGraph(workflow), [workflow]);
  const policyErrors = useMemo(() => [...(workflow.policyRouting ? policyRoutingErrors(workflow.policyRouting) : []),...workflowPolicyCheckErrors(workflow)], [workflow]);
  const zoneIssues=useMemo(()=>workflowZoneIssues(workflow),[workflow]);
  const actionDisabled = editingDisabled || graphErrors.length > 0 || zoneIssues.length>0 || policyErrors.length>0 || [...workflow.pre,...workflow.post].some(group=>!group.rules.length);
  const issues = useMemo(() => {
    const graphIssues: WorkflowIssue[] = graphErrors.flatMap(message => {
      const matches: WorkflowIssue[] = [];
      for (const stage of ['pre', 'post'] as const) {
        if (!message.startsWith(stage === 'pre' ? '요청 검사:' : '응답 검사:')) continue;
        for (const node of getStageGraph(workflow, stage).nodes) if (message.includes(`${node.name}:`)) matches.push({ message, target: { kind: 'control', id: node.id }, label: `${stageName[stage]} / ${node.name}`,field:node.kind==='condition'?'condition.value':undefined });
        for (const group of workflow[stage]) if (group.required === true && message.includes(`${group.name}: 필수`)) matches.push({ message, target: { kind: 'group', id: group.id }, label: `${stageName[stage]} / ${group.name}` });
      }
      return matches.length ? matches : [{ message, target: { kind: 'graph', stage: message.startsWith('응답 검사:') ? 'post' : 'pre' }, label: '연결 설정' } satisfies WorkflowIssue];
    });
    const policyIssues:WorkflowIssue[]=listWorkflowPolicyChecks(workflow).flatMap(scope=>policyNodeInputIssues(scope.routing).map(issue=>({...issue,target:issue.nodeId?{kind:'policy-node' as const,id:policyScopedId(scope.id,issue.nodeId)}:scope.id==='policy'?{kind:'policy' as const}:{kind:'rule' as const,id:scope.id},label:issue.nodeId?scope.routing.graph?.nodes.find(node=>node.id===issue.nodeId)?.name||'정책 노드':'정책 검사'})));
    const schemaIssues:WorkflowIssue[]=listWorkflowPolicyChecks(workflow).flatMap(scope=>scope.routing.graph?policyGraphSchemaIssues(scope.routing.graph,policyOutputSchema(scope.routing.policy)).map(issue=>({target:{kind:'policy-node' as const,id:policyScopedId(scope.id,issue.nodeId)},label:issue.nodeName,message:issue.message,predicateIndex:issue.predicateIndex,field:issue.code==='operator'?'operator':issue.code==='path'?'path':'value'})):[]);
    return [...schemaIssues,...policyIssues,...workflowIssues(workflow, connections).map(issue=>{const rule=issue.target.kind==='rule'?findRule(workflow,issue.target.id)?.rule:undefined;return rule?{...issue,field:ruleIssueField(rule,issue.message)}:issue.target.kind==='group'&&issue.message.includes('검사를 하나 이상')?{...issue,field:'rules'}:issue;}), ...graphIssues];
  }, [workflow, connections, graphErrors]);
  const configuration = useMemo(() => {
    return JSON.stringify({ workflow: executionConfiguration(workflow), connections: referencedConnections(workflow, connections) });
  }, [workflow, connections]);
  const [executionBaseline, setExecutionBaseline] = useState<{ id: string; configuration: string }>();
  const [currentFingerprint, setCurrentFingerprint] = useState<{ configuration: string; value?: string }>();
  const changedSinceDisplay = Boolean(execution && executionBaseline?.id === execution.result.id && executionBaseline.configuration !== configuration);
  const comparison = currentFingerprint?.configuration === configuration ? currentFingerprint : undefined;
  const executionRecency = !execution ? 'unknown' : execution.fingerprint
    ? comparison ? comparison.value ? (comparison.value === execution.fingerprint ? 'current' : 'stale') : 'unknown' : changedSinceDisplay ? 'stale' : 'checking'
    : changedSinceDisplay ? 'stale' : 'unknown';
  const executionStale = executionRecency === 'stale';
  const mainTraces = execution?.result.traces.filter(trace => trace.stage === 'main') || [];
  const generationCount = execution?.result.policyRoute === 'respond' || execution?.result.policyRoute === 'error' ? 0 : execution?.result.attempts?.length ?? mainTraces.filter(trace => trace.status !== 'skipped').length;
  const regenerationCount = execution?.result.regenerationCount ?? Math.max(0, generationCount - 1);
  const firstBlockedTrace = execution?.result.traces.find(trace => trace.status === 'block' && findRule(workflow, trace.ruleId));
  const retryEnabled = workflow.responseRetry?.enabled === true;
  const maxRetries = workflow.responseRetry?.maxRetries ?? 1;
  const retrySettingsRef = useRef<HTMLDivElement>(null);
  const hasPostChecks = workflow.post.some(group => group.rules.some(rule => rule.enabled));
  const selectedRule = selection.kind === 'rule' ? findRule(workflow, selection.id) : undefined;
  const selectedGroup = selection.kind === 'group' ? findGroup(workflow, selection.id) : undefined;
  const selectedControl = selection.kind === 'control' ? findControl(workflow, selection.id) : undefined;
  const selectedPolicyContext = selection.kind==='policy-node'?workflowPolicyNode(workflow,selection.id):undefined;
  const selectedPolicyScope = selectedPolicyContext?.scope ?? (selection.kind==='policy'?workflowPolicyCheck(workflow):selectedRule?.rule.kind==='policy'?workflowPolicyCheck(workflow,selectedRule.rule.id):undefined);
  const selectedPolicyNode = selectedPolicyContext?.node;
  const zones = workflow.layout?.zones || [];
  const selectedZone = selection.kind === 'zone' ? zones.find(zone => zone.id === selection.id) : undefined;
  const nodeDeleteLabel = panelMode==='zone'&&selectedZone?'영역만 삭제':panelMode==='graph'&&graphControlId&&selectedControl?'제어 노드 삭제':panelMode!=='node'?undefined:selection.kind==='rule'&&selectedRule?'검사 삭제':selection.kind==='group'&&selectedGroup?'조합과 포함된 검사 삭제':selection.kind==='policy'&&workflow.policyRouting?'정책 검사 삭제':selection.kind==='policy-node'&&selectedPolicyNode?'노드 삭제':undefined;
  const visibleNodes = nodeDefinitions(workflow);
  const selectedCanvasKey = selection.kind === 'zone' ? undefined : visibleLayoutKey(workflow, 'id' in selection ? `${selection.kind}:${selection.id}` : selection.kind);
  const selectedPolicyEdge = inspectorOpen&&panelMode==='node'&&selection.kind==='policy-node'
    ? selectedPolicyScope?.routing.graph?.edges.find(edge=>policyScopedId(selectedPolicyScope.id,edge.id)===policyEdgeFocus?.edgeId&&edge.from===selectedPolicyNode?.id)
    : undefined;
  const showPositionPin=Boolean(selectedCanvasKey&&(panelMode==='node'||panelMode==='graph'&&graphControlId&&selectedControl));
  const canvasSelection: Selection | undefined = selectedCanvasKey ? selectedCanvasKey.startsWith('group:') ? { kind: 'group', id: selectedCanvasKey.slice(6) } : selectedCanvasKey.startsWith('rule:') ? { kind: 'rule', id: selectedCanvasKey.slice(5) } : selection : undefined;
  const main = connections.find(connection => connection.id === workflow.mainConnectionId);
  const guardConnections = connections.filter(connection => connection.role !== 'main');
  const mainConnections = connections.filter(connection => connection.role !== 'guard');
  const counts = [...workflow.pre, ...workflow.post].reduce((result, group) => ({ groups: result.groups + 1, nodes: result.nodes + group.rules.length }), { groups: 0, nodes: 0 });
  const activeStage = panelMode === 'graph' ? graphStage : selectedPolicyScope?.stage || selectedRule?.stage || selectedGroup?.stage || selectedControl?.stage || (selection.kind === 'output' ? 'post' : 'pre');
  const libraryTarget = library ? workflow[library.stage].find(group => group.id === library.groupId) : undefined;
  const libraryCapacity = libraryTarget ? 12 - libraryTarget.rules.length : library ? Math.min(library.insert?.mode==='branch'?4:36,36 - workflow[library.stage].length) : 0;
  const libraryMinimum = library?.insert?.mode==='branch'?previewParallelCheckOnEdge(workflow,library.insert.target).minimumNodes:1;
  const selectionZoneIssue=zoneTransferIssue(selectedKeys);
  const zoneCompletion=completeZoneSelection(workflow,selectedKeys);
  const completionIssue=zoneCompletion.issue||zoneTransferIssue(zoneCompletion.nodeKeys);
  const pinnedKeys=normalizedPinnedKeys(workflow);
  const pinnedSelection=selectedCanvasKey ? pinnedKeys.includes(selectedCanvasKey) : false;
  const inactiveRequired=[...workflow.pre,...workflow.post].filter(group=>group.required&&!group.rules.some(rule=>rule.enabled));
  const creationTarget=creation?.targets.find(target=>target.edgeId===creation.edgeId);
  const creationBranch=creationTarget?previewParallelCheckOnEdge(workflow,creationTarget):undefined;
  const visibleTemplates = nodeCatalog.filter(template => (category === 'all' || template.category === category) && `${template.name} ${template.description}`.toLowerCase().includes(libraryQuery.trim().toLowerCase()));
  const branchEligibility = useMemo(()=>({parallel:selectedBranchPreview(workflow,selectedKeys,'parallel'),condition:selectedBranchPreview(workflow,selectedKeys,'condition')}),[workflow,selectedKeys]);
  const panelTitle = panelMode === 'policy-create' ? '정책 경로에 노드 추가' : panelMode === 'create' ? '노드 추가 방법' : panelMode === 'connection' ? '연결 변경 확인' : panelMode === 'next' ? '다음 노드' : panelMode === 'graph' ? '연결 편집' : panelMode === 'zone' ? '영역 설정' : panelMode === 'workflow' ? '워크플로우 설정' : panelMode === 'library' ? libraryTarget ? '조합에 검사 추가' : '노드 추가' : selection.kind === 'input' ? '입력과 실행' : selection.kind === 'output' ? '출력 결과' : selection.kind === 'group' ? '검사 조합 설정' : selection.kind === 'main' ? '응답 모델 설정' : selection.kind === 'policy'||selectedRule?.rule.kind==='policy' ? '정책 검사 설정' : selection.kind === 'policy-node' ? selectedPolicyNode?.kind === 'action' ? '정책 액션 설정' : selectedPolicyNode?.kind === 'switch' ? 'Switch 분기 설정' : '조건 분기 설정' : '검사 설정';
  const sessionSnapshot = useRef<WorkflowEditorSession | undefined>(undefined);
  sessionSnapshot.current = { workflowId: workflow.id, history: { past: history.past, future: history.future }, selection, inspectorOpen, panelMode: panelMode === 'library' || panelMode === 'next' || panelMode === 'connection' || panelMode === 'create' || panelMode === 'policy-create' ? 'workflow' : panelMode, graphStage, graphControlId, graphEdgeId, view, checksOpen, canvas: canvasViewport.current, inspectorScrollTop: inspectorScroll.current };
  const publishSession = useCallback(() => { if (sessionSnapshot.current) sessionCallback.current?.(sessionSnapshot.current); }, []);
  const recordViewport = useCallback((viewport: CanvasViewport) => {
    canvasViewport.current = viewport;
    if (sessionSnapshot.current) sessionSnapshot.current = { ...sessionSnapshot.current, canvas: viewport };
    publishSession();
  }, [publishSession]);
  const reviewImpact = connectionReview && connectionBaseline(workflow) === connectionReview.baseline
    ? previewConnection(workflow, connectionReview.stage, connectionReview.from, connectionReview.to, connectionReview.port).changes?.impact
    : undefined;
  const connectionImpact = panelMode === 'connection' ? reviewImpact : panelMode === 'graph' ? graphImpact : undefined;

  useEffect(() => {
    const saved = session?.workflowId === workflow.id ? session : undefined;
    setHistory(saved ? { past: saved.history.past, future: saved.history.future } : emptyWorkflowHistory());
    setSelection(saved?.selection || { kind: 'main' });
    setInspectorOpen(saved?.inspectorOpen || false);
    setPanelMode(saved?.panelMode || 'workflow');
    setExpanded(false);
    setView(saved?.view || 'builder'); setChecksOpen(saved?.checksOpen || false);
    canvasViewport.current = saved?.canvas; inspectorScroll.current = saved?.inspectorScrollTop || 0;
    activeTextField.current = undefined; pendingTextChange.current = undefined;
    setLibrary(undefined); setCreation(undefined); setPolicyCreation(undefined); setInspectorNodeSearch(false); setInspectorNodeQuery(''); setSelectedKeys([]); setPendingInsert(undefined); setInsertError(''); setNextSource(undefined); setConnectionReview(undefined); setInitialPreset(undefined);
    setGraphControlId(saved?.graphControlId); setGraphEdgeId(saved?.graphEdgeId); setGraphStage(saved?.graphStage || 'pre');
    setGraphImpact(undefined); setFocusRequest(undefined); setPolicyEdgeFocus(undefined);
    requestAnimationFrame(() => { const scroll = inspectorRef.current?.querySelector<HTMLElement>('.we-inspector-scroll'); if (scroll && saved?.inspectorScrollTop) scroll.scrollTop = saved.inspectorScrollTop; });
  }, [workflow.id]);
  useEffect(()=>{
    if(!expanded)return;
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    return()=>{document.body.style.overflow=previousOverflow;};
  },[expanded]);
  useEffect(publishSession, [history, selection, inspectorOpen, panelMode, graphStage, graphControlId, graphEdgeId, view, checksOpen, publishSession]);
  useEffect(() => () => publishSession(), [publishSession]);
  useEffect(() => { if (readOnly) { setPendingInsert(undefined); setCreation(undefined); setConnectionReview(undefined); setLibrary(undefined); if (panelMode === 'library' || panelMode === 'connection' || panelMode==='create') setPanelMode('workflow'); } }, [readOnly]);
  useEffect(()=>{
    if(panelMode!=='node'||selection.kind!=='policy')setDeletePolicyConfirm(false);
  },[panelMode,selection.kind]);
  useEffect(()=>{
    if(deletePolicyConfirm)inspectorRef.current?.querySelector<HTMLButtonElement>('[data-policy-delete-confirm]')?.focus({preventScroll:true});
  },[deletePolicyConfirm]);
  useEffect(()=>{
    if(panelMode!=='library'||!inspectorOpen||!policyChooser&&!conditionChooser)return;
    const frame=requestAnimationFrame(()=>{
      const container=inspectorRef.current?.querySelector<HTMLElement>('.we-library-scroll');
      const chooser=container?.querySelector<HTMLElement>('[data-library-chooser]');
      if(!container||!chooser)return;
      container.scrollTop+=chooser.getBoundingClientRect().top-container.getBoundingClientRect().top-12;
      chooser.querySelector<HTMLElement>('select')?.focus({preventScroll:true});
    });
    return()=>cancelAnimationFrame(frame);
  },[panelMode,inspectorOpen,policyChooser,conditionChooser]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1050px)');
    const update = () => setNarrowPanel(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (execution) setExecutionBaseline({ id: execution.result.id, configuration });
    else setExecutionBaseline(undefined);
  }, [execution?.result.id]);
  useEffect(() => {
    let active = true;
    void configurationFingerprint(workflow, connections).then(value => {
      if (active) setCurrentFingerprint({ configuration, value });
    }).catch(() => { if (active) setCurrentFingerprint({ configuration }); });
    return () => { active = false; };
  }, [configuration, workflow, connections]);
  useEffect(() => {
    if (!initialRuleId) return;
    if (initialRuleId === 'main') revealSelection({ kind: 'main' });
    else if (initialRuleId === 'policy') revealSelection({ kind: 'policy' });
    else if (initialRuleId.startsWith('policy:') && workflowPolicyNode(workflow,initialRuleId.slice(7))) revealSelection({ kind: 'policy-node', id: initialRuleId.slice(7) });
    else if (initialRuleId.startsWith('policy:')&&workflow.policyRouting){revealSelection({kind:'policy'});notify('이전 실행의 조건 노드가 현재 초안에 없습니다. 현재 정책 설정을 표시합니다.');}
    else if (findRule(workflow, initialRuleId)) revealSelection({ kind: 'rule', id: initialRuleId });
    else if (findControl(workflow, initialRuleId)) revealSelection({ kind: 'control', id: initialRuleId });
    else if (initialRuleId === 'input' || initialRuleId === 'output') revealSelection({ kind: initialRuleId });
  }, [initialRuleId, workflow.id]);
  useEffect(() => {
    if (selectedRule) { setMoveStage(selectedRule.stage); setMoveGroupId(selectedRule.group.id); }
    else if (selectedGroup) { setMoveStage(selectedGroup.stage); setMoveGroupId(''); }
  }, [selection.kind, 'id' in selection ? selection.id : selection.kind]);

  function resetInspectorForNode(target: Selection) {
    if(target.kind===selection.kind&&(!('id' in target)||'id' in selection&&target.id===selection.id))return;
    inspectorScroll.current=0;
    const reset=()=>{const scroll=inspectorRef.current?.querySelector<HTMLElement>('.we-inspector-scroll');if(scroll)scroll.scrollTop=0;};
    reset();requestAnimationFrame(reset);
  }
  function revealSelection(target: IssueTarget) {
    setInspectorTab('settings');
    if (target.kind === 'settings') { openWorkflowSettings(); return; }
    if (target.kind === 'graph') { openGraph(target.stage); return; }
    if (target.kind === 'control') { selectControl(target.id); return; }
    if (target.kind === 'zone') { selectZone(target.id); return; }
    if (target.kind === 'group') { const group = findGroup(workflow, target.id)?.group; if (group?.rules.length === 1) { revealSelection({ kind: 'rule', id: group.rules[0].id }); return; } }
    resetInspectorForNode(target);setSelectedKeys([]);
    setView('builder'); setSelection(target); setPanelMode('node'); setLibrary(undefined); setInspectorOpen(true);
    requestAnimationFrame(() => {
      const nodeKey = visibleLayoutKey(workflow, 'id' in target ? `${target.kind}:${target.id}` : target.kind);
      const node = [...(editorRef.current?.querySelectorAll<HTMLElement>('[data-layout-key]') || [])].find(element => element.dataset.layoutKey === nodeKey);
      node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      inspectorRef.current?.focus({ preventScroll: true });
    });
  }
  function focusIssue(issue:WorkflowIssue) {
    revealSelection(issue.target);
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const root=inspectorRef.current;if(!root)return;
      let scope:HTMLElement|null=root;
      if(issue.predicateIndex!==undefined)scope=root.querySelector<HTMLElement>(`[data-policy-predicate-index="${issue.predicateIndex}"]`)||root;
      const field=issue.field;
      const fieldNode=field?.startsWith('edge.')?root.querySelector<HTMLElement>(`[data-policy-edge-port="${field.slice(5)}"]`):field?scope.querySelector<HTMLElement>(`[data-field-key="${field}"], [data-policy-field-path="${field}"]`):null;
      const target=fieldNode?.matches('input,select,textarea,button')?fieldNode:fieldNode?.querySelector<HTMLElement>('input,select,textarea,button')||scope.querySelector<HTMLElement>('[aria-invalid="true"],input,select,textarea');
      if(target){let ancestor=target.parentElement;while(ancestor&&ancestor!==root){if(ancestor.tagName==='DETAILS')ancestor.setAttribute('open','');ancestor=ancestor.parentElement;}target.scrollIntoView({block:'nearest'});target.focus({preventScroll:true});}
    }));
  }
  function openPolicyCreation(source:{from:string;port:string;position?:{x:number;y:number}}) {
    if(editingDisabled)return;
    const context=workflowPolicyNode(workflow,source.from);
    if(!context||!policyNodePorts(context.node).some(item=>item.port===source.port))return;
    setPolicyCreation({...source,baseline:policyCreationBaseline(workflow)});setInsertError('');setPanelMode('policy-create');setLibrary(undefined);setInspectorOpen(true);setView('builder');
  }
  function createPolicyFromPort(kind:'branch'|'switch'|'action') {
    if(editingDisabled||!policyCreation)return;
    if(policyCreation.baseline!==policyCreationBaseline(workflow)){setInsertError('구성 중 정책이나 연결이 바뀌었습니다. 출발 포트를 다시 선택하세요.');return;}
    try{
      const {ownerId,localId}=parsePolicyScopedId(policyCreation.from);
      const added=addConnectedWorkflowPolicyNode(workflow,localId,policyCreation.port,kind,undefined,ownerId);
      const scopedId=policyScopedId(ownerId,added.nodeId);
      if(policyCreation.position){const positions=resolveLayout(added.workflow);positions[`policy-node:${scopedId}`]=clampPosition(policyCreation.position);added.workflow.layout={...added.workflow.layout,version:1,positions};}
      if(kind==='switch')setNewSwitchId(scopedId);
      commit(added.workflow);setPolicyCreation(undefined);setInsertError('');selectNode({kind:'policy-node',id:scopedId});
    }catch(error){setInsertError(error instanceof Error?error.message:'정책 노드를 추가하지 못했습니다.');}
  }
  function selectNode(target: Selection, revealCanvas = true) {
    setPolicyEdgeFocus(undefined);
    setInspectorTab('settings');
    if (target.kind === 'control') { selectControl(target.id, false); return; }
    if (target.kind === 'zone') { selectZone(target.id); return; }
    if (target.kind === 'group') { const group = findGroup(workflow, target.id)?.group; if (group?.rules.length === 1) { selectNode({ kind: 'rule', id: group.rules[0].id }); return; } }
    resetInspectorForNode(target);setSelectedKeys([]);
    setSelection(target); setPanelMode('node'); setLibrary(undefined); setInspectorOpen(true);
    if(revealCanvas)requestAnimationFrame(() => {
      const key = visibleLayoutKey(workflow, 'id' in target ? `${target.kind}:${target.id}` : target.kind);
      [...(editorRef.current?.querySelectorAll<HTMLElement>('[data-layout-key]') || [])].find(element => element.dataset.layoutKey === key)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  function searchSelectNode(target: Selection) {
    setPolicyEdgeFocus(undefined);
    setInspectorTab('settings');
    if(target.kind==='group'){
      const found=findGroup(workflow,target.id);if(!found)return;
      if(found.group.rules.length===1){searchSelectNode({kind:'rule',id:found.group.rules[0].id});return;}
    }
    if(target.kind==='rule'&&!findRule(workflow,target.id))return;
    if(target.kind==='control'){
      const found=findControl(workflow,target.id);if(!found)return;
      setInitialPreset(undefined);setGraphStage(found.stage);setGraphControlId(target.id);setGraphEdgeId(undefined);setPanelMode('graph');
    }else if(target.kind==='zone'){
      if(!zones.some(zone=>zone.id===target.id))return;setPanelMode('zone');
    }else {resetInspectorForNode(target);setPanelMode('node');}
    setSelection(target);setLibrary(undefined);setInspectorOpen(true);setView('builder');
    if(narrowPanel)requestAnimationFrame(()=>inspectorRef.current?.focus({preventScroll:true}));
  }
  function openWorkflowSettings() {
    setView('builder'); setPanelMode('workflow'); setLibrary(undefined); setInspectorOpen(true);
    requestAnimationFrame(() => inspectorRef.current?.focus({ preventScroll: true }));
  }
  function selectPolicyEdge(edgeId:string) {
    const {ownerId,localId}=parsePolicyScopedId(edgeId);
    const edge=workflowPolicyCheck(workflow,ownerId)?.routing.graph?.edges.find(item=>item.id===localId);
    if(!edge)return;
    selectNode({kind:'policy-node',id:policyScopedId(ownerId,edge.from)},false);
    setPolicyEdgeFocus({edgeId,request:++policyEdgeSequence.current});
  }
  function reopenInspector() {
    setView('builder'); setInspectorOpen(true);
    requestAnimationFrame(() => inspectorRef.current?.focus({ preventScroll: true }));
  }
  function openGraph(stage: Stage = activeStage, preset?: InitialPreset) {
    setInitialPreset(preset); setGraphStage(stage); setPanelMode('graph'); setLibrary(undefined); setInspectorOpen(true); setView('builder');
    requestAnimationFrame(() => inspectorRef.current?.focus({ preventScroll: true }));
  }
  function selectControl(controlId?: string, focus = true, context:Workflow = workflow) {
    setInspectorTab('settings');
    setSelectedKeys([]);
    setInitialPreset(undefined);
    const found = controlId ? findControl(context, controlId) : undefined;
    if (found) { setGraphStage(found.stage); setSelection({ kind: 'control', id: controlId! }); }
    setGraphControlId(controlId); setGraphEdgeId(undefined); setPanelMode('graph'); setInspectorOpen(true); setView('builder'); setLibrary(undefined);
    requestAnimationFrame(() => {
      if (controlId) {
        [...(editorRef.current?.querySelectorAll<HTMLElement>('[data-layout-key]') || [])].find(element => element.dataset.layoutKey === `control:${controlId}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        inspectorRef.current?.querySelector<HTMLElement>('.wg-control-fields')?.scrollIntoView({ block: 'nearest' });
      } else {
        const scroll = inspectorRef.current?.querySelector<HTMLElement>('.we-inspector-scroll'); if (scroll) scroll.scrollTop = 0;
      }
      if (focus) inspectorRef.current?.focus({ preventScroll: true });
    });
  }
  function selectEdge(stage: Stage, edgeId?: string) {
    setInitialPreset(undefined);
    setGraphStage(stage); setGraphEdgeId(edgeId); setGraphControlId(undefined); setPanelMode('graph'); setInspectorOpen(true); setView('builder'); setLibrary(undefined);
    if (edgeId) requestAnimationFrame(() => inspectorRef.current?.querySelector<HTMLElement>('.wg-edge-form')?.scrollIntoView({ block: 'nearest' }));
  }
  function connect(stage: Stage, from: string, to: string, port: FlowEdge['port'] = 'next') {
    if (editingDisabled) return;
    const preview = previewConnection(workflow, stage, from, to, port);
    if (!preview.valid) { notify(preview.reason || '이 두 노드를 연결할 수 없습니다.'); return; }
    if (preview.replace || preview.changes?.warnings.length) {
      setConnectionReview({ stage, from, to, port, baseline: connectionBaseline(workflow) }); setNextSource({ stage, from, port });
      setPanelMode('connection'); setLibrary(undefined); setInspectorOpen(true); setView('builder');
      requestAnimationFrame(() => { const scroll = inspectorRef.current?.querySelector<HTMLElement>('.we-inspector-scroll'); if (scroll) scroll.scrollTop = 0; inspectorRef.current?.focus({ preventScroll: true }); });
      return;
    }
    try { const next = applyConnection(workflow, stage, from, to, port); commit(next); const edge = getStageGraph(next, stage).edges.find(item => item.from === from && item.to === to && (item.port || 'next') === port); if (edge) selectEdge(stage, edge.id); }
    catch (error) { notify(error instanceof Error ? error.message : '연결을 변경하지 못했습니다.'); }
  }
  function applyReviewedConnection() {
    if (!connectionReview || editingDisabled) return;
    if (connectionBaseline(workflow) !== connectionReview.baseline) { notify('검토 중 연결이 바뀌었습니다. 현재 연결을 다시 선택하세요.'); setConnectionReview(undefined); openGraph(connectionReview.stage); return; }
    const { stage, from, to, port } = connectionReview;
    try { const next = applyConnection(workflow, stage, from, to, port); commit(next); setConnectionReview(undefined); const edge = getStageGraph(next, stage).edges.find(item => item.from === from && item.to === to && (item.port || 'next') === port); selectEdge(stage, edge?.id); }
    catch (error) { notify(error instanceof Error ? error.message : '연결을 변경하지 못했습니다.'); }
  }
  function openInsert(target: FlowInsertTarget, position?: { x: number; y: number }) {
    if (editingDisabled) return;
    const context = {target,position};
    setPendingInsert(context);setInsertError('');setCreation({targets:[target],edgeId:target.edgeId,position});
    setLibrary(undefined);setPanelMode('create');setInspectorOpen(true);setView('builder');
  }
  function openFromPort(source:NextSource&{position:{x:number;y:number}}){
    if(editingDisabled)return;
    let targets:FlowInsertTarget[];try{targets=captureCreationTargets(workflow,source.stage,source.from,source.port);}catch(error){notify(error instanceof Error?error.message:'이 연결점에서 노드를 추가할 수 없습니다.');return;}
    if(!targets.length){notify('이 연결점의 다음 경로를 먼저 완성하세요. 연결 편집에서 누락된 연결을 확인할 수 있습니다.');return;}
    setCreation({targets,edgeId:targets[0].edgeId,position:source.position});setPendingInsert({target:targets[0],position:source.position});setInsertError('');
    setLibrary(undefined);setPanelMode('create');setInspectorOpen(true);setView('builder');
  }
  function chooseCreation(mode:'insert'|'branch'){
    if(!creationTarget||editingDisabled)return;
    const branch=previewParallelCheckOnEdge(workflow,creationTarget);
    if(mode==='branch'&&!branch.valid){notify(branch.reason||'이 위치에는 분기를 추가할 수 없습니다.');return;}
    const context:InsertContext={target:creationTarget,position:creation?.position,mode};
    setPendingInsert(context);setInsertError('');setLibraryReturnMode('create');
    setLibrary({stage:creationTarget.stage,groupId:'',parallel:mode==='branch'&&branch.minimumNodes>1,insert:context});
    setPolicyChooser(false);setNewPolicyKey('');setConditionChooser(false);setConditionTarget(listWorkflowPolicyChecks(workflow).some(scope=>scope.stage===creationTarget.stage&&scope.routing.policy.formatVersion===2)?'policy':'text');setSelectedTemplates([]);setLibraryQuery('');setCategory('all');setPanelMode('library');setInspectorOpen(true);
  }
  function resumeInsert(){if(pendingInsert)openInsert(pendingInsert.target,pendingInsert.position);}
  function buildBranch(kind: 'parallel' | 'condition', keys: string[] = selectedKeys) {
    if (editingDisabled) return;
    const preview=selectedBranchPreview(workflow,keys,kind);
    if(!preview.valid){notify(preview.reason||'선택한 검사 노드의 연결을 확인하세요.');return;}
    setGraphControlId(undefined);setGraphEdgeId(undefined);openGraph(preview.stage,{kind,firstGroupId:preview.groupIds[0],secondGroupId:preview.groupIds[1],groupIds:preview.groupIds,requestId:id('preset')});
  }
  function sourceForSelection(): NextSource | undefined {
    if (selectedRule) return { stage: selectedRule.stage, from: `group:${selectedRule.group.id}`, port: 'next' };
    if (selectedGroup) return { stage: selectedGroup.stage, from: `group:${selectedGroup.group.id}`, port: 'next' };
    if (selectedControl) return { stage: selectedControl.stage, from: `control:${selectedControl.control.id}`, port: selectedControl.control.kind === 'condition' ? 'true' : 'next' };
    if (selection.kind === 'input') return { stage: 'pre', from: 'start', port: 'next' };
    if (selection.kind === 'main') return { stage: 'post', from: 'start', port: 'next' };
    return undefined;
  }
  function openNextNode(source = sourceForSelection()) {
    if (!source) return;
    setNextSource(source); setTargetQuery(''); setPanelMode('next'); setLibrary(undefined); setInspectorOpen(true); setView('builder');
    requestAnimationFrame(() => { const scroll = inspectorRef.current?.querySelector<HTMLElement>('.we-inspector-scroll'); if (scroll) scroll.scrollTop = 0; inspectorRef.current?.focus({ preventScroll: true }); });
  }
  function flowLabel(stage: Stage, endpoint: string) { return endpoint === 'start' ? stage === 'pre' ? '최초 입력' : '응답 생성 모델' : endpoint === 'end' ? stage === 'pre' ? workflow.policyRouting ? '정책 검사' : '응답 생성 모델' : '최종 출력' : endpointLabel(workflow, stage, endpoint); }
  function exitLibrary() {
    setLibrary(undefined); setSelectedTemplates([]); setPanelMode(libraryReturnMode);
    requestAnimationFrame(() => inspectorRef.current?.focus({ preventScroll: true }));
  }
  function closeInspector() {
    setInspectorOpen(false);
    requestAnimationFrame(() => {
      const nodeKey = selection.kind === 'zone' ? undefined : visibleLayoutKey(workflow, 'id' in selection ? `${selection.kind}:${selection.id}` : selection.kind);
      const node = panelMode === 'node' || panelMode === 'graph' ? [...(editorRef.current?.querySelectorAll<HTMLButtonElement>('button[data-layout-key]') || [])].find(element => element.dataset.layoutKey === nodeKey) : undefined;
      (node || editorRef.current?.querySelector<HTMLButtonElement>('.we-panel-toggle'))?.focus({ preventScroll: true });
    });
  }
  function inspectorKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeInspector(); return; }
    if (!narrowPanel || event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex="0"]')].filter(element => element.getClientRects().length > 0);
    if (!controls.length) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === event.currentTarget)) { event.preventDefault(); controls[controls.length - 1].focus(); }
    else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
  }
  async function retest() {
    if (!onRetest || actionDisabled || retesting) return;
    setRetesting(true);
    try { await onRetest(); }
    catch { notify('같은 요청을 다시 검증하지 못했습니다.'); }
    finally { setRetesting(false); }
  }

  function textField(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
    return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'color'].includes(target.type);
  }
  function beginTextField(target: EventTarget | null) {
    if (!textField(target)) return;
    if (activeTextField.current?.element !== target) activeTextField.current = { element: target, key: `field-session-${++fieldSequence.current}`, changedWorkflow: false };
  }
  function markTextChange(event: FormEvent<HTMLElement>) {
    if (!textField(event.target)) return;
    beginTextField(event.target);
    const key = activeTextField.current!.key;
    pendingTextChange.current = key;
    queueMicrotask(() => { if (pendingTextChange.current === key) pendingTextChange.current = undefined; });
  }
  function endTextField(target: EventTarget | null) {
    if (activeTextField.current?.element !== target) return;
    activeTextField.current = undefined; pendingTextChange.current = undefined;
    setHistory(current => current.batchKey ? { past: current.past, future: current.future } : current);
  }
  function editorKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || editingDisabled || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    // Searches and unsubmitted forms keep their normal local text undo.
    if (textField(event.target) && (activeTextField.current?.element !== event.target || !activeTextField.current.changedWorkflow)) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && !(key === 'y' && !event.metaKey)) return;
    event.preventDefault(); event.stopPropagation();
    if (key === 'y' || event.shiftKey) redo(); else undo();
  }
  function recordInspectorScroll(target: EventTarget | null) {
    if (!(target instanceof HTMLElement) || !target.classList.contains('we-inspector-scroll')) return;
    inspectorScroll.current = target.scrollTop;
    if (sessionSnapshot.current) sessionSnapshot.current = { ...sessionSnapshot.current, inspectorScrollTop: target.scrollTop };
    publishSession();
  }
  function focusConnectionEndpoint(stage: Stage, endpoint: string) {
    setFocusRequest({ stage, endpoint, requestId: id('focus') });
  }

  function commit(next: Workflow) {
    if (editingDisabled) return;
    if (workflow.graph && next.graph) {
      for (const stage of ['pre', 'post'] as const) for (const group of workflow[stage]) if (!next[stage].some(item => item.id === group.id) && !detachGraphGroup(next, stage, group.id)) {
        notify('이 검사 노드의 연결을 먼저 정리하세요. 단순한 직렬 연결만 자동으로 이어 삭제하거나 이동할 수 있습니다.'); openGraph(stage); return;
      }
      for (const stage of ['pre', 'post'] as const) for (const group of next[stage]) if (!workflow[stage].some(item => item.id === group.id) && !appendGraphGroup(next, stage, group.id)) notify('새 검사 노드를 추가했습니다. 연결 편집에서 입력과 출력을 연결하세요.');
    }
    for (const stage of ['pre', 'post'] as const) for (const previous of workflow[stage]) {
      const current = next[stage].find(group => group.id === previous.id);
      if (!current || (previous.rules.length === 1) === (current.rules.length === 1)) continue;
      const oldKey = previous.rules.length === 1 ? `rule:${previous.rules[0].id}` : `group:${previous.id}`;
      const newKey = current.rules.length === 1 ? `rule:${current.rules[0].id}` : `group:${current.id}`;
      const position = resolveLayout(workflow)[oldKey];
      if (position) next.layout = { ...next.layout, version: 1, positions: { ...(next.layout?.positions || {}), [newKey]: position }, ...(next.layout?.pinnedKeys?{pinnedKeys:next.layout.pinnedKeys.map(key=>key===oldKey?newKey:key)}:{}) };
    }
    if (next.layout) {
      const knownKeys = new Set(knownLayoutKeys(next));
      const assigned = new Set<string>();
      next.layout = { ...next.layout, version: 1, positions: Object.fromEntries(Object.entries(next.layout.positions).filter(([key]) => knownKeys.has(key))), ...(next.layout.zones ? { zones: next.layout.zones.map(zone => ({ ...zone, nodeKeys: [...new Set(zone.nodeKeys.map(key => visibleLayoutKey(next, visibleLayoutKey(workflow, key) || key)).filter((key): key is string => Boolean(key)))].filter(key => { if (assigned.has(key)) return false; assigned.add(key); return true; }) })) } : {}) };
    }
    const addedNodes=nodeDefinitions(next).filter(node=>!nodeDefinitions(workflow).some(previous=>previous.key===node.key));
    const topologyChanged=JSON.stringify([getStageGraph(workflow,'pre'),getStageGraph(workflow,'post'),listWorkflowPolicyChecks(workflow).map(scope=>scope.routing)])!==JSON.stringify([getStageGraph(next,'pre'),getStageGraph(next,'post'),listWorkflowPolicyChecks(next).map(scope=>scope.routing)]);
    if(addedNodes.length&&next.layout?.zones){
      const assigned=new Set(next.layout.zones.flatMap(zone=>zone.nodeKeys));
      for(const stage of ['pre','post'] as const){
        const following=getStageGraph(next,stage);
        for(const edge of getStageGraph(workflow,stage).edges){
          if(following.edges.some(item=>item.from===edge.from&&item.to===edge.to&&(item.port||'next')===(edge.port||'next')))continue;
          const from=executionEndpointKey(workflow,stage,edge.from),to=executionEndpointKey(workflow,stage,edge.to);
          const owner=from&&to?workflow.layout?.zones?.find(zone=>zone.nodeKeys.includes(from)&&zone.nodeKeys.includes(to)):undefined;
          if(!owner)continue;
          const fresh=addedNodes.filter(node=>node.stage===stage&&!assigned.has(node.key)).map(node=>node.key);
          if(fresh.length){next.layout.zones=next.layout.zones.map(zone=>zone.id===owner.id?{...zone,nodeKeys:[...zone.nodeKeys,...fresh]}:zone);fresh.forEach(key=>assigned.add(key));}
        }
      }
    }

    if(next.layout?.pinnedKeys)next.layout.pinnedKeys=normalizedPinnedKeys(next);
    if(topologyChanged||addedNodes.length){const repaired=reconcileContiguousZoneResult(next);next=repaired.workflow;if(repaired.changed)notify(repaired.ungroupedKeys.length?'영역은 이어진 노드끼리 정리했습니다. 영역 수 제한으로 일부 노드는 영역 밖에 두었습니다.':'연결이 바뀌어 영역을 이어진 노드끼리 정리했습니다.');}
    if(addedNodes.length){
      const viewport=editorRef.current?.querySelector<HTMLElement>('.wc-viewport');
      const positions=autoLayout(next,{width:viewport?.clientWidth,height:viewport?.clientHeight});
      next.layout={...next.layout,version:1,positions};
      next.layout.zones=next.layout.zones?.map(zone=>zone.nodeKeys.length?{...zone,...zoneBounds(next,zone)}:zone);
      setAutoFitRequest(value=>value+1);
    }
    if (JSON.stringify(next) === JSON.stringify(workflow)) return;
    const batchKey = pendingTextChange.current;
    if (batchKey && activeTextField.current?.key === batchKey) activeTextField.current.changedWorkflow = true;
    setHistory(current => rememberWorkflowChange(current, workflow, batchKey));
    onChange(next);
  }
  function modify(action: (next: Workflow) => void) {
    const next = structuredClone(workflow);
    action(next);
    commit(next);
  }
  function nodeLabel(nodeKey: string) {
    if (nodeKey === 'input') return '최초 입력';
    if (nodeKey === 'main') return '응답 생성 모델';
    if (nodeKey === 'output') return '최종 출력';
    if (nodeKey === 'policy') return workflow.policyRouting?.policy.name || '정책 검사';
    if (nodeKey.startsWith('policy-node:')) return workflowPolicyNode(workflow,nodeKey.slice(12))?.node.name || '정책 노드';
    if (nodeKey.startsWith('rule:')) return findRule(workflow, nodeKey.slice(5))?.rule.name || '검사';
    if (nodeKey.startsWith('group:')) return `${findGroup(workflow, nodeKey.slice(6))?.group.name || '이름 없음'} (검사 조합)`;
    return findControl(workflow, nodeKey.slice(8))?.control.name || '제어 노드';
  }
  function selectZone(zoneId: string) {
    setSelection({ kind: 'zone', id: zoneId }); setPanelMode('zone'); setLibrary(undefined); setInspectorOpen(true); setView('builder'); setZoneQuery('');
    requestAnimationFrame(() => {
      [...(editorRef.current?.querySelectorAll<HTMLElement>('[data-layout-key]') || [])].find(element => element.dataset.layoutKey === `zone:${zoneId}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      inspectorRef.current?.focus({ preventScroll: true });
    });
  }
  function zoneBounds(next:Workflow,zone:CanvasZone){const frame=createZoneForNodes(next,zone.nodeKeys,{id:zone.id,name:zone.name,color:zone.color});return{x:frame.x,y:frame.y,width:frame.width,height:frame.height};}
  function zoneTransferIssue(nodeKeys:string[],recipientId?:string){
    const keys=normalizedZoneNodeKeys(workflow,nodeKeys),issue=zoneMembershipIssue(workflow,keys);if(issue)return issue;
    for(const zone of zones){if(zone.id===recipientId)continue;const remaining=zone.nodeKeys.filter(key=>!keys.includes(key));if(remaining.length!==zone.nodeKeys.length){const donorIssue=zoneMembershipIssue(workflow,remaining);if(donorIssue)return `${zone.name}: 중간 노드를 옮기면 영역이 끊깁니다. 끝의 노드부터 옮기거나 영역을 나누세요.`;}}
    return undefined;
  }
  function repairZones(){if(editingDisabled)return;const result=reconcileContiguousZoneResult(workflow);if(!result.changed)return;commit(result.workflow);notify(result.ungroupedKeys.length?'이어진 노드끼리 영역을 나눴습니다. 영역 수 제한으로 일부 노드는 영역 밖에 두었습니다.':'이어진 노드끼리 영역을 나눴습니다.');}
  function addZone(nodeKeys: string[] = []) {
    if (editingDisabled || zones.length >= 32) return;
    const keys = [...new Set(nodeKeys.map(key => visibleLayoutKey(workflow, key)).filter((key): key is string => Boolean(key)))];
    const issue=zoneTransferIssue(keys);if(issue){notify(issue);return;}
    const zone = createZoneForNodes(workflow, keys, { id: id('zone'), name: `영역 ${zones.length + 1}`, color: 'slate' });
    modify(next => { next.layout = { ...next.layout, version: 1, positions: resolveLayout(next), zones: [...(next.layout?.zones || []).map(item => ({ ...item, nodeKeys: item.nodeKeys.filter(key => !keys.includes(key)) })), zone] }; });
    setSelectedKeys([]); selectZone(zone.id);
  }
  function updateZone(patch: Partial<CanvasZone>) {
    if (!selectedZone) return;
    modify(next => { const zone = next.layout?.zones?.find(item => item.id === selectedZone.id); if (zone) Object.assign(zone, patch); });
  }
  function setZoneMember(nodeKey: string, included: boolean) {
    if (!selectedZone || editingDisabled) return;
    const members=included?[...new Set([...selectedZone.nodeKeys,nodeKey])]:selectedZone.nodeKeys.filter(key=>key!==nodeKey);
    const issue=included?zoneTransferIssue(members,selectedZone.id):zoneMembershipIssue(workflow,members);if(issue){notify(issue);return;}
    modify(next => {
      const positions = resolveLayout(next), point = positions[nodeKey];
      next.layout = { ...next.layout, version: 1, positions, zones: (next.layout?.zones || []).map(zone => {
        if (zone.id !== selectedZone.id) return included ? { ...zone, nodeKeys: zone.nodeKeys.filter(key => key !== nodeKey) } : zone;
        const nodeKeys = included ? [...new Set([...zone.nodeKeys, nodeKey])] : zone.nodeKeys.filter(key => key !== nodeKey);
        if (!included || !point) return { ...zone, nodeKeys };
        const x = Math.min(zone.x, Math.max(0, point.x - 24)), y = Math.min(zone.y, Math.max(0, point.y - 60));
        return { ...zone, nodeKeys, x, y, width: Math.min(50000, Math.max(zone.x + zone.width, point.x + NODE_WIDTH + 24) - x), height: Math.min(50000, Math.max(zone.y + zone.height, point.y + NODE_HEIGHT + 24) - y) };
      }) };
    });
  }
  function completeSelectedZone(nodeKey:string) {
    if(!selectedZone||editingDisabled)return;
    const completion=completeZoneSelection(workflow,[...selectedZone.nodeKeys,nodeKey]);
    const issue=completion.issue||zoneTransferIssue(completion.nodeKeys,selectedZone.id);
    if(issue){notify(issue);return;}
    modify(next=>{next.layout={...next.layout,version:1,positions:resolveLayout(next),zones:(next.layout?.zones??[]).map(zone=>zone.id===selectedZone.id?{...zone,nodeKeys:completion.nodeKeys,...zoneBounds(next,{...zone,nodeKeys:completion.nodeKeys})}:{...zone,nodeKeys:zone.nodeKeys.filter(key=>!completion.nodeKeys.includes(key))})};});
  }
  function togglePositionPin() {
    if(editingDisabled||!selectedCanvasKey)return;
    modify(next=>{next.layout={...next.layout,version:1,positions:resolveLayout(next),pinnedKeys:pinnedSelection?pinnedKeys.filter(key=>key!==selectedCanvasKey):[...pinnedKeys,selectedCanvasKey]};});
  }
  function deleteZone() {
    if (!selectedZone || editingDisabled) return;
    modify(next => { if (next.layout?.zones) next.layout.zones = next.layout.zones.filter(zone => zone.id !== selectedZone.id); });
    setPanelMode('workflow'); setSelection({ kind: 'main' }); setSelectedKeys([]);
  }
  function deleteSelectedNode() {
    if(editingDisabled||!nodeDeleteLabel)return;
    if(panelMode==='zone'){deleteZone();return;}
    if(panelMode==='graph'||selection.kind==='policy-node'){nodeActionsRef.current?.deleteNode();return;}
    if(selection.kind==='rule')deleteRule(selection.id);
    else if(selection.kind==='group')setDeletingGroup(selection.id);
    else if(selection.kind==='policy')setDeletePolicyConfirm(true);
  }
  function updateResponseRetry(patch: Partial<NonNullable<Workflow['responseRetry']>>) {
    modify(next => { next.responseRetry = { enabled: false, maxRetries: 1, ...next.responseRetry, ...patch }; });
  }
  function revealRetrySettings() {
    revealSelection({ kind: 'main' });
    requestAnimationFrame(() => {
      retrySettingsRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      retrySettingsRef.current?.focus({ preventScroll: true });
    });
  }
  function undo() {
    if (editingDisabled) return;
    pendingTextChange.current = undefined;
    const restored = restoreWorkflowHistory(history, workflow, 'undo');
    if (!restored.workflow) return;
    setHistory(restored.history); onChange(restored.workflow);
  }
  function redo() {
    if (editingDisabled) return;
    pendingTextChange.current = undefined;
    const restored = restoreWorkflowHistory(history, workflow, 'redo');
    if (!restored.workflow) return;
    setHistory(restored.history); onChange(restored.workflow);
  }
  function inheritInsertedZone(next:Workflow,target:FlowInsertTarget,newKeys:string[],zoneId?:string){
    const from=executionEndpointKey(workflow,target.stage,target.from),to=executionEndpointKey(workflow,target.stage,target.to);
    const owner=zoneId?zones.find(zone=>zone.id===zoneId):zones.find(zone=>Boolean(from&&to&&zone.nodeKeys.includes(from)&&zone.nodeKeys.includes(to)));
    if(!owner||!next.layout?.zones)return;
    const created=nodeDefinitions(next).filter(node=>!visibleNodes.some(previous=>previous.key===node.key)).map(node=>node.key);
    next.layout.zones=next.layout.zones.map(zone=>zone.id===owner.id?{...zone,nodeKeys:[...new Set([...zone.nodeKeys,...newKeys,...created])]}:zone);
  }
  function zoneInsertionTarget(zoneId:string,stage:Stage){
    const zone=zones.find(item=>item.id===zoneId);if(!zone?.nodeKeys.length)return undefined;
    const candidates:FlowInsertTarget[]=[];
    for(const section of [stage,stage==='pre'?'post':'pre'] as Stage[]){for(const edge of getStageGraph(workflow,section).edges){const from=executionEndpointKey(workflow,section,edge.from),to=executionEndpointKey(workflow,section,edge.to);if(from&&to&&zone.nodeKeys.includes(from)&&!zone.nodeKeys.includes(to))candidates.push(captureInsertTarget(workflow,section,edge.id));}}
    if(candidates.length===1)return candidates[0];
    const incoming:FlowInsertTarget[]=[];
    for(const section of ['post','pre'] as Stage[]){for(const edge of getStageGraph(workflow,section).edges){const to=executionEndpointKey(workflow,section,edge.to);if(to&&zone.nodeKeys.includes(to))incoming.push(captureInsertTarget(workflow,section,edge.id));}}
    return candidates[0]??incoming.at(-1);
  }
  function openLibrary(stage: Stage = 'pre', groupId = '', parallel = false, zoneId?: string) {
    if (editingDisabled) return;
    setLibraryPolicyOwner(selectedPolicyScope?.id??'');
    setPolicyChooser(false); setNewPolicyKey(''); setConditionChooser(false);setConditionTarget(listWorkflowPolicyChecks(workflow).some(scope=>scope.stage===stage&&scope.routing.policy.formatVersion===2)?'policy':'text');
    if(zoneId){const insertion=zoneInsertionTarget(zoneId,stage);if(insertion){const context:InsertContext={target:insertion,mode:'insert'};setPendingInsert(context);setInsertError('');setLibraryReturnMode('zone');setLibrary({stage:insertion.stage,groupId:'',parallel:false,zoneId,insert:context});setPanelMode('library');setInspectorOpen(true);setView('builder');setSelectedTemplates([]);setLibraryQuery('');setCategory('all');return;}}
    if (panelMode !== 'library') setLibraryReturnMode(panelMode);
    setPanelMode('library'); setInspectorOpen(true); setView('builder');
    setLibrary({ stage, groupId, parallel, zoneId }); setSelectedTemplates([]); setLibraryQuery(''); setCategory('all');
  }
  function addComponent(template: NodeTemplate) {
    if (!library || editingDisabled) return;
    if (library.parallel) {
      setSelectedTemplates(current => current.includes(template.id) ? current.filter(key => key !== template.id) : current.length < libraryCapacity ? [...current, template.id] : current);
      return;
    }
    addComponents([template]);
  }
  function addComponents(templates: NodeTemplate[]) {
    if (!library || editingDisabled || !templates.length) return;
    const groups = workflow[library.stage];
    const target = groups.find(group => group.id === library.groupId);
    if (target && target.rules.length + templates.length > 12) { notify('검사 조합에는 검사를 최대 12개까지 추가할 수 있습니다.'); return; }
    if (!target && groups.length + templates.length > 36) { notify('요청 검사와 응답 검사에 각각 검사 노드를 최대 36개까지 추가할 수 있습니다.'); return; }
    const rules = templates.map(template => makeRule(template.id, connections));
    if (library.insert) {
      if(library.insert.mode==='branch'){const preview=previewParallelCheckOnEdge(workflow,library.insert.target);if(!preview.valid){const message=preview.reason||'추가할 연결이 변경되었습니다. 연결선에서 다시 선택하세요.';setInsertError(message);notify(message);return;}}
      if (library.insert.mode!=='branch'&&rules.length!==1||library.insert.mode==='branch'&&rules.length<libraryMinimum)return;
      try {
        const groups=rules.map(rule=>({id:id('group'),name:rule.name,mode:'any' as const,rules:[rule]}));
        const next=library.insert.mode==='branch'?addParallelCheckOnEdge(workflow,library.insert.target,groups.length===1?groups[0]:groups).workflow:insertCheckOnEdge(workflow,library.insert.target,groups[0],library.insert.position);
        inheritInsertedZone(next,library.insert.target,rules.map(rule=>`rule:${rule.id}`),library.zoneId);
        commit(next); setPendingInsert(undefined); setInsertError(''); revealSelection({ kind: 'rule', id: rules[0].id }); setLibrary(undefined); setSelectedTemplates([]);
      } catch (error) { const message = error instanceof Error ? error.message : '삽입 위치를 확인하지 못했습니다. 연결선에서 다시 추가하세요.'; setInsertError(message); notify(message); }
      return;
    }
    modify(next => {
      if (target) next[library.stage].find(group => group.id === target.id)!.rules.push(...rules);
      else next[library.stage].push(...rules.map(rule => ({ id: id('group'), name: rule.name, mode: 'any' as const, rules: [rule] })));
      if (library.zoneId && !target) {
        const positions = resolveLayout(next), zone = next.layout?.zones?.find(item => item.id === library.zoneId);
        if (zone) {
          const columns = Math.max(1, Math.floor((zone.width - 48) / (NODE_WIDTH + 24)));
          rules.forEach((rule, index) => { const slot = zone.nodeKeys.length + index; const rawX = zone.x + 24 + (slot % columns) * (NODE_WIDTH + 24), rawY = zone.y + 60 + Math.floor(slot / columns) * (NODE_HEIGHT + 24); positions[`rule:${rule.id}`] = clampPosition({ x: rawX <= 40000 ? rawX : 40000 - (slot % columns) * (NODE_WIDTH + 24), y: rawY <= 40000 ? rawY : 40000 - Math.floor(slot / columns) * (NODE_HEIGHT + 24) }); });
          next.layout = { ...next.layout, version: 1, positions, zones: (next.layout?.zones || []).map(item => item.id === zone.id ? { ...item, nodeKeys: [...item.nodeKeys, ...rules.map(rule => `rule:${rule.id}`)], height: Math.max(item.height, 84 + Math.ceil((item.nodeKeys.length + rules.length) / columns) * (NODE_HEIGHT + 24)) } : item) };
        }
      }
    });
    revealSelection({ kind: 'rule', id: rules[0].id }); setLibrary(undefined); setSelectedTemplates([]);
  }
  function updateRule(patch: Partial<Rule>) {
    if (!selectedRule) return;
    modify(next => { const location = findRule(next, selectedRule.rule.id)!; location.group.rules[location.index] = { ...location.rule, ...patch }; if (patch.name !== undefined && location.group.rules.length === 1) location.group.name = patch.name; });
  }
  function updateConfig(patch: Partial<Rule['config']>) { if (selectedRule) updateRule({ config: { ...selectedRule.rule.config, ...patch } }); }
  function updateGroup(patch: Partial<RuleGroup>) {
    if (!selectedGroup) return;
    modify(next => { const location = findGroup(next, selectedGroup.group.id)!; next[location.stage][location.index] = { ...location.group, ...patch }; });
  }
  function duplicateRule(ruleId: string) {
    const location = findRule(workflow, ruleId);
    if (!location) return;
    if(location.rule.kind==='policy'&&listWorkflowPolicyChecks(workflow).length>=12){notify('정책 검사는 최대 12개입니다.');return;}
    const compound = location.group.rules.length > 1;
    if (compound && location.group.rules.length >= 12) { notify('검사 조합에는 검사를 최대 12개까지 추가할 수 있습니다.'); return; }
    if (!compound && workflow[location.stage].length >= 36) { notify('검사 구간마다 노드를 최대 36개까지 추가할 수 있습니다.'); return; }
    const copy = structuredClone(location.rule); copy.id = id('rule'); copy.name = `${copy.name.slice(0, 94)} 복사`;
    modify(next => {
      if (compound) findGroup(next, location.group.id)!.group.rules.splice(location.index + 1, 0, copy);
      else {
        const groupId = id('group'), source = findGroup(next, location.group.id)!;
        next[location.stage].splice(source.index + 1, 0, { ...structuredClone(location.group), id: groupId, name: copy.name, rules: [copy] });
        appendGraphGroup(next, location.stage, groupId, location.group.id);
      }
    });
    revealSelection({ kind: 'rule', id: copy.id });
  }
  function deleteRule(ruleId: string) {
    if(findRule(workflow,ruleId)?.rule.kind==='policy'){commit(removeWorkflowPolicyCheck(workflow,ruleId));setSelection({kind:'main'});return;}
    modify(next => {
      for (const stage of ['pre', 'post'] as const) next[stage] = next[stage].map(group => ({ ...group, rules: group.rules.filter(rule => rule.id !== ruleId) })).filter(group => group.rules.length > 0);
    });
    setSelection({ kind: 'main' });
  }
  function shiftRule(ruleId: string, direction: -1 | 1) {
    const location = findRule(workflow, ruleId);
    if (!location || location.index + direction < 0 || location.index + direction >= location.group.rules.length) return;
    modify(next => {
      const rules = findGroup(next, location.group.id)!.group.rules;
      [rules[location.index], rules[location.index + direction]] = [rules[location.index + direction], rules[location.index]];
    });
  }
  function moveRule(ruleId: string, destinationStage: Stage, destinationGroupId: string, beforeRuleId?: string) {
    const location = findRule(workflow, ruleId);
    if (!location || beforeRuleId === ruleId) return;
    if (location.group.rules.length === 1 && !destinationGroupId) { if (location.stage !== destinationStage) moveWholeGroup(location.group.id, destinationStage); return; }
    const destination = workflow[destinationStage].find(group => group.id === destinationGroupId);
    if(destination&&destination.id!==location.group.id&&(location.rule.kind==='policy'||destination.rules.some(rule=>rule.kind==='policy'))){notify('정책 검사는 단독 노드로 배치하세요.');return;}
    if (destination && destination.id !== location.group.id && destination.rules.length >= 12) { notify('검사 조합에는 검사를 최대 12개까지 추가할 수 있습니다.'); return; }
    const next = structuredClone(workflow);
    const source = findRule(next, ruleId)!;
    const [moving] = source.group.rules.splice(source.index, 1);
    if (destination) {
      const target = findGroup(next, destination.id)!.group;
      const index = beforeRuleId ? target.rules.findIndex(rule => rule.id === beforeRuleId) : -1;
      target.rules.splice(index >= 0 ? index : target.rules.length, 0, moving);
    }
    for (const stage of ['pre', 'post'] as const) next[stage] = next[stage].filter(group => group.rules.length > 0);
    if (!destination) {
      if (next[destinationStage].length >= 36) { notify('선택한 구간에 검사 노드가 이미 36개 있습니다.'); return; }
      next[destinationStage].push({ id: id('group'), name: moving.name, mode: 'any', rules: [moving] });
    }
    commit(next); setSelection({ kind: 'rule', id: ruleId }); setMoveStage(destinationStage);
    setMoveGroupId(destination?.id || next[destinationStage][next[destinationStage].length - 1].id);
  }
  function duplicateGroup(groupId: string) {
    const location = findGroup(workflow, groupId);
    if(location?.group.rules.some(rule=>rule.kind==='policy')&&listWorkflowPolicyChecks(workflow).length>=12){notify('정책 검사는 최대 12개입니다.');return;}
    if (!location) return;
    if (workflow[location.stage].length >= 36) { notify('검사 구간마다 검사 노드를 최대 36개까지 추가할 수 있습니다.'); return; }
    const copy = structuredClone(location.group); copy.id = id('group'); copy.name = `${copy.name.slice(0, 94)} 복사`; copy.rules = copy.rules.map(rule => ({ ...rule, id: id('rule') }));
    modify(next => { next[location.stage].splice(location.index + 1, 0, copy); appendGraphGroup(next, location.stage, copy.id, location.group.id); });
    revealSelection({ kind: 'group', id: copy.id });
  }
  function deleteGroup(groupId: string) {
    modify(next => { for (const stage of ['pre', 'post'] as const) next[stage] = next[stage].filter(group => group.id !== groupId); });
    setSelection({ kind: 'main' }); setDeletingGroup(undefined);
  }
  function shiftGroup(groupId: string, direction: -1 | 1) {
    const location = findGroup(workflow, groupId);
    if (!location || location.index + direction < 0 || location.index + direction >= workflow[location.stage].length) return;
    modify(next => {
      const groups = next[location.stage];
      [groups[location.index], groups[location.index + direction]] = [groups[location.index + direction], groups[location.index]];
    });
  }
  function moveWholeGroup(groupId: string, destinationStage: Stage) {
    const location = findGroup(workflow, groupId);
    if (!location || location.stage === destinationStage) return;
    if (workflow[destinationStage].length >= 36) { notify('선택한 구간에 검사 노드가 이미 36개 있습니다.'); return; }
    modify(next => { const [group] = next[location.stage].splice(location.index, 1); next[destinationStage].push(group); });
    setMoveStage(destinationStage);
  }
  async function copyJson() {
    try { await navigator.clipboard.writeText(JSON.stringify(workflow, null, 2)); notify('워크플로우 설정을 JSON으로 복사했습니다.'); }
    catch { notify('클립보드에 접근하지 못했습니다.'); }
  }

  const renderRuleInspector = () => {
    if (!selectedRule) return null;
    const { rule, group, stage, index } = selectedRule;
    const Icon = icons[rule.kind];
    const fieldIssues=(field:string)=>issues.filter(issue=>issue.target.kind==='rule'&&issue.target.id===rule.id&&issue.field===field);
    const fieldError=(field:string)=>fieldIssues(field).length>0;
    const renderFieldError=(field:string)=>fieldError(field)&&<span className="we-field-error" id={`${rule.id}-${field}-issue`}>{fieldIssues(field).map(issue=>issue.message).join(' ')}</span>;
    return <><div className="we-inspector-node" data-kind={rule.kind}><span className="we-node-icon"><Icon size={20} /></span><div><strong>{rule.name}</strong><small>{stageName[stage]}{group.rules.length > 1 ? ` / ${group.name} (검사 조합)` : ''}</small></div></div><div className="we-inspector-body" key={rule.id}>{group.rules.length > 1 && <button className="btn small we-composite-back" onClick={() => revealSelection({ kind: 'group', id: group.id })}><ArrowLeft size={13} /> 검사 조합 설정으로 돌아가기</button>}
      <label className="we-inline-check"><input type="checkbox" checked={rule.enabled} onChange={event => updateRule({ enabled: event.target.checked })} disabled={editingDisabled} />검사 사용</label>
      {(rule.kind === 'keyword' || rule.kind === 'regex' || rule.kind === 'required') && <label className="field">{rule.kind === 'regex' ? '차단할 정규식' : rule.kind === 'required' ? '필수 문구' : '금지 키워드'}<textarea data-field-key="pattern" aria-label={rule.kind==='regex'?'차단할 정규식':rule.kind==='required'?'필수 문구':'금지 키워드'} aria-invalid={fieldError('pattern')} aria-describedby={fieldError('pattern')?`${rule.id}-pattern-issue`:undefined} rows={3} maxLength={rule.kind === 'regex' ? 1000 : 2000} value={rule.config.pattern || ''} onChange={event => updateConfig({ pattern: event.target.value })} disabled={editingDisabled} />{renderFieldError('pattern')}<small>{rule.kind === 'regex' ? '대소문자를 구분하지 않습니다. 역참조, lookaround, 반복 그룹은 지원하지 않습니다.' : '쉼표 또는 줄바꿈으로 구분합니다. 대소문자를 구분하지 않습니다.'}</small></label>}
      {rule.kind === 'required' && <label className="field">필수 문구 조건<select data-field-key="matchMode" value={rule.config.matchMode || 'any'} onChange={event => updateConfig({ matchMode: event.target.value as 'any' | 'all' })} disabled={editingDisabled}><option value="any">한 문구 이상 포함</option><option value="all">모든 문구 포함</option></select></label>}
      {rule.kind === 'length' && <label className="field">최대 글자 수<input data-field-key="maxLength" aria-label="최대 글자 수" aria-invalid={fieldError('maxLength')} type="number" min={1} max={40000} value={rule.config.maxLength ?? ''} onChange={event => updateConfig({ maxLength: Number(event.target.value) })} disabled={editingDisabled} />{renderFieldError('maxLength')}<small>1~40,000자 범위입니다.</small></label>}
      {rule.kind === 'pii' && <fieldset data-field-key="piiTypes" className="we-check-group" disabled={editingDisabled}><legend>검사할 개인정보 형식</legend>{([['email', '이메일 주소'], ['phone', '휴대전화 번호'], ['resident', '주민등록번호 형식']] as [PiiType, string][]).map(([key, label]) => <label className="we-inline-check" key={key}><input type="checkbox" checked={(rule.config.piiTypes || []).includes(key)} onChange={event => updateConfig({ piiTypes: event.target.checked ? [...new Set([...(rule.config.piiTypes || []), key])] : rule.config.piiTypes?.filter(type => type !== key) })} />{label}</label>)}{renderFieldError('piiTypes')}<small>검사할 항목을 하나 이상 선택하세요. 개인정보의 형식만 확인하며 진위는 확인하지 않습니다.</small></fieldset>}
      {rule.kind === 'json' && <><label className="field">허용할 JSON 값<select data-field-key="jsonMode" value={rule.config.jsonMode || 'object'} onChange={event => updateConfig({ jsonMode: event.target.value as 'object' | 'any' })} disabled={editingDisabled}><option value="object">JSON 객체만 허용</option><option value="any">모든 유효한 JSON 허용</option></select><small>JSON 본문만 허용합니다. 코드 블록 표시는 허용하지 않습니다.</small></label><label className="field" data-field-key="requiredKeys">최상위 필수 키 (선택)<KeyListField disabled={editingDisabled} value={rule.config.requiredKeys || []} onChange={keys => { if (keys.length <= 32 && keys.every(key => key.length <= 100)) updateConfig({ requiredKeys: keys }); else notify('필수 키는 최대 32개, 키마다 100자 이내입니다.'); }} /><small>한 줄에 하나씩 입력하세요. 키가 지정되면 JSON 객체가 필요합니다.</small></label></>}
      {rule.kind === 'llm' && <><label className="field">검사 모델<select data-field-key="connectionId" aria-label="검사 모델" aria-invalid={fieldError('connectionId')} value={rule.config.connectionId || ''} onChange={event => updateConfig({ connectionId: event.target.value || undefined })} disabled={editingDisabled}><option value="">모델 선택</option>{guardConnections.map(connection => <option key={connection.id} value={connection.id}>{connectionLabel(connection.name)} / {connection.model} ({connection.mode==='demo'?'예제':'vLLM'})</option>)}</select>{renderFieldError('connectionId')}</label><label className="field">검사 기준 예제<select value={rule.config.guardProfile || 'custom'} onChange={event => { const profile = event.target.value as 'custom' | 'injection' | 'safety'; const template = nodeCatalog.find(node => node.config.guardProfile === profile)!; updateConfig({ guardProfile: profile, prompt: template.config.prompt }); }} disabled={editingDisabled}><option value="custom">직접 작성</option><option value="injection">지시 우회 검사</option><option value="safety">유해 내용 검사</option></select></label><label className="field">검사 지시문<textarea data-field-key="prompt" aria-label="검사 지시문" aria-invalid={fieldError('prompt')} rows={5} maxLength={4000} value={rule.config.prompt || ''} onChange={event => updateConfig({ prompt: event.target.value })} disabled={editingDisabled} />{renderFieldError('prompt')}<small>검사 결과에는 verdict (allow 또는 block)와 reason이 필요합니다.</small></label><div className="we-info">예제 연결은 정해진 표현만 검사합니다. 작성한 지시문으로 검사하려면 vLLM 모델을 연결하세요.</div></>}
      {group.required&&!group.rules.some(rule=>rule.enabled)&&<div className="we-info" role="status">모든 경로에 배치되지만 검사가 꺼져 있어 실제 검사는 수행하지 않습니다.</div>}
      {workflow.graph && group.rules.length === 1 && <><label className="we-inline-check"><input type="checkbox" checked={group.required === true} disabled={editingDisabled} onChange={event => modify(next => { findGroup(next, group.id)!.group.required = event.target.checked; })} />모든 경로에서 이 검사 실행</label><p className="we-fine">분기 전이나 합류 후에 배치해야 모든 경로에 포함됩니다. 검사 사용 여부는 별도로 설정합니다.</p></>}
      <details className="we-node-advanced"><summary>고급 설정</summary><div className="we-advanced-body">
      <label className="field">검사 이름<input data-field-key="name" aria-label="검사 이름" aria-invalid={fieldError('name')} maxLength={100} value={rule.name} onChange={event => updateRule({ name: event.target.value })} disabled={editingDisabled} />{renderFieldError('name')}</label>
      <label className="field">검사 종류<select value={rule.kind} onChange={event => { const kind = event.target.value as RuleKind; const template = nodeCatalog.find(node => node.kind === kind)!; updateRule({ kind, config: makeRule(template.id, connections).config }); }} disabled={editingDisabled}>{Object.entries(ruleKindLabels).filter(([kind])=>kind!=='policy').map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
      <label className="field">설명<textarea rows={2} maxLength={500} value={rule.description} onChange={event => updateRule({ description: event.target.value })} disabled={editingDisabled} /></label>
      <div className="we-section-title">검사 관리</div><div className="we-row"><button className="btn small" onClick={() => duplicateRule(rule.id)} disabled={editingDisabled || (group.rules.length > 1 ? group.rules.length >= 12 : workflow[stage].length >= 36)}><Copy size={13} /> 복제</button>{group.rules.length > 1 && <><button className="btn small" onClick={() => shiftRule(rule.id, -1)} disabled={editingDisabled || index === 0} aria-label="조합 안에서 검사 위로 이동"><ArrowUp size={13} /></button><button className="btn small" onClick={() => shiftRule(rule.id, 1)} disabled={editingDisabled || index === group.rules.length - 1} aria-label="조합 안에서 검사 아래로 이동"><ArrowDown size={13} /></button></>}</div>{group.rules.length > 1 && <small className="we-fine">검사 조합 안의 검사는 표시 순서와 관계없이 동시에 실행합니다.</small>}
      <details className="we-execution-move"><summary>검사 실행 위치 변경</summary><p className="we-fine">이 설정은 실행 구간과 검사 조합을 변경합니다. 표시 영역은 영역 설정에서 변경하세요.</p><div className="we-move-fields"><label className="field">검사 구간<select value={moveStage} onChange={event => { setMoveStage(event.target.value as Stage); setMoveGroupId(''); }} disabled={editingDisabled}><option value="pre">요청 검사</option><option value="post">응답 검사</option></select></label><label className="field">검사 조합<select value={moveGroupId} onChange={event => setMoveGroupId(event.target.value)} disabled={editingDisabled}><option value="">독립 검사 노드로 이동</option>{workflow[moveStage].filter(item => item.rules.length > 1 || item.id === group.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="btn small" onClick={() => moveRule(rule.id, moveStage, moveGroupId)} disabled={editingDisabled || (moveStage === stage && (moveGroupId === group.id || (group.rules.length === 1 && !moveGroupId)))}><ArrowRight size={13} /> 선택한 위치로 이동</button></div></details>
    </div></details></div></>;
  };

  const renderGroupInspector = () => {
    if (!selectedGroup) return null;
    const { group, stage, index } = selectedGroup;
    return <><div className="we-inspector-node" data-kind="group"><span className="we-node-icon"><Layers3 size={20} /></span><div><strong>{group.name}</strong><small>{stageName[stage]} / 검사 조합</small></div></div><div className="we-inspector-body">
      <p className="we-fine">여러 검사를 동시에 실행하고 하나의 차단 조건으로 판단하는 실행 노드입니다. 캔버스의 표시 영역과는 별개입니다.</p>
      <label className="field">조합 이름<input maxLength={100} value={group.name} onChange={event => updateGroup({ name: event.target.value })} disabled={editingDisabled} /></label><label className="field">조합 차단 조건<select value={group.mode} onChange={event => updateGroup({ mode: event.target.value as 'any' | 'all' })} disabled={editingDisabled}><option value="any">하나라도 위반하면 차단</option><option value="all">모두 위반하면 차단</option></select><small>검사 중 오류가 나면 차단 조건과 관계없이 실행을 중단합니다.</small></label>
      <div className="we-section-title">포함된 검사 ({group.rules.length}/12)</div><div className="we-composite-rules">{group.rules.map(rule => <button key={rule.id} onClick={() => revealSelection({ kind: 'rule', id: rule.id })}><span><strong>{rule.name}</strong><small>{ruleKindLabels[rule.kind]} / {rule.enabled ? '사용' : '사용 안 함'}</small></span><ChevronRight size={14} /></button>)}</div><button data-field-key="rules" className="btn small" onClick={() => openLibrary(stage, group.id, true)} disabled={editingDisabled || group.rules.length >= 12}><Plus size={13} /> 조합에 검사 추가</button>
      {workflow.graph && <><label className="we-inline-check we-required-node"><input type="checkbox" checked={group.required === true} disabled={editingDisabled} onChange={event => updateGroup({ required: event.target.checked })} />모든 경로에서 이 조합 실행</label><p className="we-fine">분기 전이나 합류 후에 배치하세요. 조합 안의 개별 검사 사용 여부는 별도로 설정합니다.</p></>}
      {group.required&&!group.rules.some(rule=>rule.enabled)&&<div className="we-info" role="status">모든 경로에 배치되지만 사용 중인 검사가 없어 실제 검사는 수행하지 않습니다.</div>}
      <details className="we-node-advanced"><summary>고급 설정</summary><div className="we-advanced-body"><div className="we-section-title">조합 관리</div><div className="we-row"><button className="btn small" onClick={() => duplicateGroup(group.id)} disabled={editingDisabled || workflow[stage].length >= 36}><Copy size={13} /> 복제</button><button className="btn small" onClick={() => shiftGroup(group.id, -1)} disabled={editingDisabled || Boolean(workflow.graph) || index === 0} aria-label="실행 순서 앞으로"><ArrowUp size={13} /></button><button className="btn small" onClick={() => shiftGroup(group.id, 1)} disabled={editingDisabled || Boolean(workflow.graph) || index === workflow[stage].length - 1} aria-label="실행 순서 뒤로"><ArrowDown size={13} /></button></div>{workflow.graph && <p className="we-fine">실행 순서는 연결 편집에서 변경하세요.</p>}
      <label className="field">검사 구간 이동<select value={moveStage} onChange={event => setMoveStage(event.target.value as Stage)} disabled={editingDisabled}><option value="pre">요청 검사</option><option value="post">응답 검사</option></select></label><button className="btn small" disabled={editingDisabled || moveStage === stage} onClick={() => moveWholeGroup(group.id, moveStage)}><ArrowRight size={13} /> 선택한 구간으로 이동</button>
    </div></details></div></>;
  };

  const renderZoneInspector = () => {
    if (!selectedZone) return <Empty title="선택한 영역이 없습니다" description="다른 영역을 선택하거나 실행 취소로 복원하세요." />;
    const matches = visibleNodes.filter(node => nodeLabel(node.key).toLowerCase().includes(zoneQuery.trim().toLowerCase()));
    return <><div className="we-inspector-node"><span className={`we-zone-swatch color-${selectedZone.color}`} /><div><strong>{selectedZone.name}</strong><small>표시 영역 / 노드 {selectedZone.nodeKeys.length}개</small></div></div><div className="we-inspector-body">
      <div className="we-info">영역은 노드를 화면에서 묶어 정리합니다. 포함하거나 꺼내도 실행 순서와 차단 조건은 바뀌지 않습니다.</div>
      <label className="field">영역 이름<input maxLength={100} value={selectedZone.name} onChange={event => updateZone({ name: event.target.value })} disabled={editingDisabled} /></label>
      <label className="field">색상<select value={selectedZone.color} disabled={editingDisabled} onChange={event => updateZone({ color: event.target.value as CanvasZone['color'] })}><option value="slate">회색</option><option value="blue">파랑</option><option value="green">초록</option><option value="amber">노랑</option><option value="violet">보라</option></select></label>
      <button className="btn small" disabled={editingDisabled} onClick={() => openLibrary(activeStage, '', false, selectedZone.id)}><Plus size={13} /> 이 영역에 노드 추가</button>
      <div className="we-section-title">포함할 노드</div><label className="field">기존 노드 검색<input value={zoneQuery} onChange={event => setZoneQuery(event.target.value)} placeholder="노드 이름 검색" /></label><p className="we-fine">연결된 이웃 노드만 포함할 수 있습니다. 중간 노드를 빼서 영역이 끊기는 변경은 할 수 없습니다.</p>
      <div className="we-zone-members">{matches.map(node => { const owner = zones.find(zone => zone.id !== selectedZone.id && zone.nodeKeys.includes(node.key));const included=selectedZone.nodeKeys.includes(node.key);const members=included?selectedZone.nodeKeys.filter(key=>key!==node.key):[...selectedZone.nodeKeys,node.key];const issue=included?zoneMembershipIssue(workflow,members):zoneTransferIssue(members,selectedZone.id); const completion=issue&&!included?completeZoneSelection(workflow,members):undefined;const repairIssue=completion?.issue||(completion?zoneTransferIssue(completion.nodeKeys,selectedZone.id):undefined);return <div className="we-zone-member-row" key={node.key}><label className="we-zone-member" title={issue}><input type="checkbox" checked={included} disabled={editingDisabled||Boolean(issue)} onChange={event => setZoneMember(node.key, event.target.checked)} /><span><strong>{nodeLabel(node.key)}</strong><small>{issue|| (owner ? `${owner.name}에서 이동` : node.stage ? stageName[node.stage] : '공통 노드')}</small></span></label>{completion&&completion.missingKeys.length>0&&<button type="button" className="btn small we-zone-complete" disabled={editingDisabled||Boolean(repairIssue)} title={repairIssue||completion.missingKeys.map(nodeLabel).join(', ')} onClick={()=>completeSelectedZone(node.key)}>빠진 노드 {completion.missingKeys.length}개 함께 넣기</button>}</div>; })}{matches.length === 0 && <p className="we-fine">검색 결과가 없습니다.</p>}</div>
      <p className="we-fine">영역을 삭제해도 노드와 연결은 그대로 유지됩니다.</p>
    </div></>;
  };

  const renderTerminalInspector = () => {
    const input = selection.kind === 'input';
    const Icon = input ? LogIn : LogOut;
    return <><div className="we-inspector-node" data-kind={input ? 'input' : 'output'}><span className="we-node-icon"><Icon size={21} /></span><div><strong>{input ? '최초 입력' : '최종 출력'}</strong><small>{input ? '요청을 받는 시작점' : '검사를 마친 응답의 반환 지점'}</small></div><Tag>필수</Tag></div><div className="we-inspector-body">
      {input && <button className="btn small" onClick={() => setRunnerOpen(true)}><Play size={13}/> 입력 설정과 실행 결과 열기</button>}
      <p className="we-terminal-description">{input ? '외부 시스템에서 받은 요청을 요청 검사와 응답 생성 모델에 전달합니다.' : '검사를 통과한 답변을 요청한 시스템에 반환합니다. 차단되거나 오류가 발생하면 모델 답변을 반환하지 않습니다.'}</p>
      <dl className="we-terminal-format"><dt>{input ? '입력 형식' : '출력 형식'}</dt><dd>OpenAI Chat Completions</dd>{input ? <><dt>요청 모델</dt><dd><code>{workflow.alias}</code></dd><dt>메시지</dt><dd><code>messages[]</code>의 <code>role</code>과 텍스트 <code>content</code></dd><dt>메시지 역할</dt><dd><code>system</code>, <code>user</code>, <code>assistant</code></dd></> : <><dt>응답 내용</dt><dd><code>choices[0].message.content</code></dd><dt>반환 조건</dt><dd>요청 검사와 응답 검사 통과</dd></>}</dl>
      {input && renderInputScope()}
      <div className="we-section-title">{input ? '마지막 검증 요청' : '마지막 검증 출력'}</div>
      {!execution ? <p className="we-terminal-empty">검증을 실행하면 {input ? '실제 요청 내용' : '실제 반환 결과'}을 확인할 수 있습니다.</p> : input ? <pre className="we-terminal-content">{execution.input || '(빈 요청)'}</pre> : execution.result.status === 'allow' ? <><Tag tone="success">반환 완료</Tag><pre className="we-terminal-content">{execution.result.output || '(빈 응답)'}</pre></> : <div className="we-terminal-stopped"><Tag tone={execution.result.status === 'block' ? 'warning' : 'error'}>{execution.result.status === 'block' ? '차단' : '실행 오류'}</Tag><p>{execution.result.status === 'block' ? '응답이 차단되어 모델 답변을 반환하지 않았습니다.' : '오류로 모델 답변을 반환하지 않았습니다.'}</p><p>{execution.result.reason}</p></div>}
      <p className="we-fine we-terminal-fixed">시작과 종료 노드는 항상 유지됩니다. 캔버스에서 위치를 옮길 수 있습니다.</p>
    </div></>;
  };

  const renderResponseRetry = () => <div className="we-retry-settings" ref={retrySettingsRef} tabIndex={-1} aria-label="응답 재작성 설정">
    <div className="we-section-title">응답 재작성</div>
    <label className="we-inline-check"><input type="checkbox" checked={retryEnabled} onChange={event => updateResponseRetry({ enabled: event.target.checked })} disabled={editingDisabled} />응답 검사에서 차단되면 재작성</label>
    {retryEnabled&&<><p className="we-fine">응답 검사의 차단 조건에 해당하면 같은 모델로 다시 생성하고 모든 응답 검사를 반복합니다.</p>
    <label className="field">추가 재작성 횟수<select value={maxRetries} onChange={event => updateResponseRetry({ maxRetries: Number(event.target.value) })} disabled={editingDisabled || !retryEnabled}>{[1, 2, 3].map(count => <option key={count} value={count}>최대 {count}회 추가</option>)}</select><small>최초 생성은 포함하지 않습니다. {retryEnabled ? `최초 생성을 포함해 최대 ${maxRetries + 1}회 생성합니다.` : '재작성을 켜면 추가 횟수를 설정할 수 있습니다.'}</small></label>
    <details className="we-node-advanced"><summary>재작성 상세 설정</summary><label className="field">추가 지시 (선택)<textarea rows={3} maxLength={2000} value={workflow.responseRetry?.instruction || ''} onChange={event => updateResponseRetry({ instruction: event.target.value })} disabled={editingDisabled || !retryEnabled} placeholder="예: 검사에서 지적한 내용을 제외하고 답변을 다시 작성하세요." /><small>재작성할 때 응답 모델에 전달할 지시입니다. 최대 2,000자까지 입력할 수 있습니다.</small></label>
    <div className="we-retry-policy"><p>요청 검사는 처음 한 번만 실행합니다. 오류나 시간 초과가 발생하면 재작성하지 않습니다.</p><p>설정한 횟수 안에 응답 검사를 통과하지 못하면 응답을 차단합니다.</p></div>
    </details>{!hasPostChecks && <div className="we-info">사용 중인 응답 검사가 없습니다. 재작성을 사용하려면 응답 검사를 추가하세요.</div>}</>}
  </div>;

  const renderInputScope = () => <><label className="field">요청 검사 대상<select value={workflow.inputScope??'conversation'} disabled={editingDisabled} onChange={event=>modify(next=>{next.inputScope=event.target.value as Workflow['inputScope'];})}><option value="conversation">전체 대화</option><option value="user_messages">사용자 대화</option><option value="last_user">마지막 사용자 질문</option></select><small>{workflow.inputScope==='last_user'?'마지막 user 메시지만 요청 검사에 전달합니다.':workflow.inputScope==='user_messages'?'user 메시지의 텍스트를 합쳐 요청 검사에 전달합니다.':'system, user, assistant 메시지의 텍스트를 합쳐 요청 검사에 전달합니다.'} 응답 생성 모델에는 원래 대화와 역할을 그대로 전달합니다.</small></label></>;
  const renderPositionPin = () => showPositionPin&&<button type="button" className="we-tool-button we-position-pin" disabled={editingDisabled} aria-label={pinnedSelection?'자동 정렬 위치 고정 해제':'자동 정렬에서 위치 고정'} title={pinnedSelection?'자동 정렬 위치 고정 해제. 직접 끌어 옮길 수 있습니다.':'자동 정렬에서 위치 고정. 직접 끌어 옮길 수 있습니다.'} aria-pressed={pinnedSelection} onClick={togglePositionPin}>{pinnedSelection?<PinOff size={15}/>:<Pin size={15}/>}</button>;
  const renderWorkflowInspector = () => <><div className="we-inspector-node"><span className="we-node-icon"><Settings2 size={21} /></span><div><strong>워크플로우</strong><small>검사 노드 {counts.groups}개, 검사 {counts.nodes}개</small></div></div><div className="we-inspector-body we-workflow-settings">
    <label className="field">워크플로우 이름<input maxLength={100} value={workflow.name} onChange={event => modify(next => { next.name = event.target.value; })} disabled={editingDisabled} /><small>관리 화면에서 구분할 이름입니다.</small></label>
    <label className="field">설명<textarea rows={4} maxLength={1000} value={workflow.description} onChange={event => modify(next => { next.description = event.target.value; })} disabled={editingDisabled} placeholder="이 워크플로우의 용도와 적용할 검사 기준" /></label>
    <label className="field">API 모델 이름<input className="mono" maxLength={80} value={workflow.alias} onChange={event => modify(next => { next.alias = event.target.value; })} disabled={editingDisabled} placeholder="예: support-assistant" /><small>외부 시스템의 model 필드에 전달할 이름입니다. 영문, 숫자, 점, 밑줄, 하이픈을 사용할 수 있습니다.</small></label>
    {renderInputScope()}
    <div className="we-section-title">전체 실행 한도</div>
    <label className="field">전체 제한 시간 (초)<input type="number" min={1} max={600} step={1} value={(workflow.executionLimits?.timeoutMs??120000)/1000} disabled={editingDisabled} onChange={event=>{const value=Number(event.target.value);if(Number.isInteger(value)&&value>=1&&value<=600)modify(next=>{next.executionLimits={timeoutMs:value*1000,maxModelCalls:next.executionLimits?.maxModelCalls??64};});}}/><small>요청 검사부터 마지막 응답 검사까지 적용합니다. 기본 120초, 최대 600초입니다.</small></label>
    <label className="field">최대 모델 호출 횟수<input type="number" min={1} max={1000} step={1} value={workflow.executionLimits?.maxModelCalls??64} disabled={editingDisabled} onChange={event=>{const value=Number(event.target.value);if(Number.isInteger(value)&&value>=1&&value<=1000)modify(next=>{next.executionLimits={timeoutMs:next.executionLimits?.timeoutMs??120000,maxModelCalls:value};});}}/><small>응답 생성, 재작성과 검사 모델 호출을 모두 합산합니다. 기본 64회입니다.</small></label>
    {inactiveRequired.length>0&&<div className="we-info" role="status">모든 경로에 배치한 조합 중 {inactiveRequired.length}개에 사용 중인 검사가 없습니다. {inactiveRequired.map(group=>group.name).join(', ')}</div>}
    <div className="we-info">설정을 저장한 뒤 배포하면 API 요청에 적용됩니다.</div>
  </div></>;

  const renderPolicyInspector = () => {
    const scope=selectedPolicyScope,routing=scope?.routing;
    if(!routing||!scope)return <Empty title="정책 검사가 없습니다" description="노드 추가에서 적용할 정책을 선택하세요." />;
    const scoped=(nodeId:string)=>policyScopedId(scope.id,nodeId);
    const selectModel=()=>selectNode(scope.id==='policy'?{kind:'policy'}:{kind:'rule',id:scope.id});
    const changeRouting=(nextRouting:typeof routing)=>commit(updateWorkflowPolicyCheck(workflow,scope.id,nextRouting));
    if(selection.kind==='policy-node')return selectedPolicyNode&&routing.graph?<>
      <div className="we-inspector-node" data-kind="policy-node"><span className="we-node-icon">{selectedPolicyNode.kind==='switch'?<Split size={21}/>:<GitBranch size={21}/>}</span><div><input className="we-node-name-input" aria-label="정책 노드 이름" data-field-key="name" maxLength={100} value={selectedPolicyNode.name} disabled={editingDisabled} onChange={event=>{const graph=structuredClone(routing.graph!);graph.nodes.find(node=>node.id===selectedPolicyNode.id)!.name=event.target.value;changeRouting({...routing,graph});}}/><small>{stageName[scope.stage]} / {scope.rule?.name??routing.policy.name} v{routing.policy.version}</small></div></div>
      <div className="we-inspector-body"><PolicyGraphEditor key={scope.id} actionMode={scope.id==='policy'?'routing':'check'} nodeActionsRef={nodeActionsRef} graph={routing.graph} schema={policyOutputSchema(routing.policy)} policyExamples={routing.policy.examples} policyLabel={`${routing.policy.name} v${routing.policy.version}`} autoFillNewSwitch={scoped(selectedPolicyNode.id)===newSwitchId} showName={false} disabled={editingDisabled} nodeOnly onConnect={(from,to,port)=>commit(connectWorkflowPolicyNode(workflow,from,to,port,undefined,scope.id))} onAddFromPort={(from,port)=>openPolicyCreation({from:scoped(from),port})} selectedNodeId={selectedPolicyNode.id} selectedEdgeId={selectedPolicyEdge?.id} edgeFocusRequest={policyEdgeFocus?.request} onAddNode={()=>openLibrary(scope.stage)} onSelectNode={nodeId=>nodeId?selectNode({kind:'policy-node',id:scoped(nodeId)}):selectModel()} onChange={graph=>changeRouting({...routing,graph})}/>{selectedPolicyNode.kind==='switch'&&onCreateSwitchDataset&&<button type="button" className="btn small" disabled={editingDisabled} onClick={()=>onCreateSwitchDataset(workflow,scoped(selectedPolicyNode.id))}>검증 사례 만들기</button>}</div>
    </>:<Empty title="선택한 정책 노드가 없습니다" description="실행 취소로 복원하거나 다른 정책 노드를 선택하세요."/>;
    return <><div className="we-inspector-node" data-kind="policy"><span className="we-node-icon"><BrainCircuit size={21}/></span><div>{scope.rule?<input className="we-node-name-input" aria-label="검사 이름" maxLength={100} value={scope.rule.name} disabled={editingDisabled} onChange={event=>updateRule({name:event.target.value})}/>:<strong>정책 검사</strong>}<small>{stageName[scope.stage]} / {routing.policy.name} v{routing.policy.version}</small></div></div><div className="we-inspector-body">
      {scope.rule&&<label className="we-switch"><input type="checkbox" checked={scope.rule.enabled} disabled={editingDisabled} onChange={event=>updateRule({enabled:event.target.checked})}/>이 정책 검사 사용</label>}
      <WorkflowPolicySettings key={scope.id} routing={routing} actionMode={scope.id==='policy'?'routing':'check'} policies={state?.policies??[]} disabled={editingDisabled} nodeMode onOpenPolicy={onOpenPolicy} onFocusPolicyNode={(nodeId,predicateIndex)=>focusIssue({target:{kind:'policy-node',id:scoped(nodeId)},label:'정책 조건',message:'',predicateIndex,field:'path'})} onChange={nextRouting=>{if(nextRouting)changeRouting(nextRouting);}}/>
      {routing.policy.formatVersion===2&&<><label className="field">출력에 연결할 첫 조건 분기<select data-field-key="entry" aria-label="정책 시작 조건 분기" value={routing.graph?.entryNodeId??''} disabled={editingDisabled} onChange={event=>{try{commit(setWorkflowPolicyEntryNode(workflow,event.target.value,scope.id));}catch(error){notify(error instanceof Error?error.message:'시작 조건을 연결할 수 없습니다.');}}}><option value="">조건 분기 선택</option>{routing.graph?.nodes.filter(node=>node.kind!=='action').map(node=><option key={node.id} value={node.id}>{node.name}</option>)}</select></label>{!routing.graph?.nodes.length&&<p className="we-info">노드 추가에서 조건 분기와 액션을 각각 추가하세요. 처음 추가한 조건 분기를 정책 출력에 연결합니다.</p>}<button type="button" className="btn small" disabled={editingDisabled} onClick={()=>openLibrary(scope.stage)}><Plus size={13}/>노드 추가</button></>}
      <p className="we-fine">{scope.id==='policy'?'요청 검사를 모두 통과한 뒤 실행합니다.':'연결된 순서대로 실행합니다. 통과하면 다음 검사로 계속하고 차단하면 응답을 반환하지 않습니다.'}</p>
      {scope.rule&&<button className="btn small" disabled={editingDisabled||listWorkflowPolicyChecks(workflow).length>=12} onClick={()=>duplicateRule(scope.id)}><Copy size={13}/>정책 검사 복제</button>}
    </div></>;
  };

  const renderSelectedInspector = () => <>{selection.kind === 'input' || selection.kind === 'output' ? renderTerminalInspector() : selection.kind==='policy'||selection.kind==='policy-node'||selectedRule?.rule.kind==='policy'?renderPolicyInspector(): selection.kind === 'main' ? <><div className="we-inspector-node" data-kind="main"><span className="we-node-icon"><BrainCircuit size={21} /></span><div><strong>응답 생성 모델</strong><small>응답 생성</small></div></div><div className="we-inspector-body"><label className="field">모델 서버<select value={workflow.mainConnectionId} onChange={event => modify(next => { next.mainConnectionId = event.target.value; })} disabled={editingDisabled}><option value="" disabled>모델 선택</option>{mainConnections.map(connection => <option key={connection.id} value={connection.id}>{connectionLabel(connection.name)} / {connection.model} ({connection.mode==='demo'?'예제':'vLLM'})</option>)}</select></label>{renderResponseRetry()}<details className="we-node-advanced"><summary>모델 연결과 응답 처리 상세</summary><button className="btn small" onClick={onConnections}><Server size={14} /> 모델 서버 관리</button><div className="we-section-title">응답 처리</div><dl className="we-policy"><dt>응답 반환</dt><dd>응답 검사 완료 후</dd><dt>오류 처리</dt><dd>요청 차단</dd><dt>제한 시간</dt><dd>{main ? `${main.timeoutMs / 1000}초` : '연결 필요'}</dd></dl></details><button className="btn small" disabled={editingDisabled} onClick={() => openLibrary('pre')}><Plus size={13} /> 노드 추가</button></div></> : selection.kind === 'rule' ? (selectedRule ? renderRuleInspector() : <Empty title="선택한 검사가 없습니다" description="실행 취소로 복원하거나 다른 검사를 선택하세요." />) : (selectedGroup ? renderGroupInspector() : <Empty title="검사 조합이 없습니다" description="실행 취소로 복원하거나 다른 노드를 선택하세요." />)}</>;

  const renderNodeConnections = () => {
    const source = sourceForSelection();
    if (!source) return null;
    const edges = getStageGraph(workflow, source.stage).edges.filter(edge => edge.from === source.from);
    return <div className="we-node-connections"><div><strong>다음 노드</strong><small>{edges.length ? edges.map(edge => flowLabel(source.stage, edge.to)).join(', ') : '연결 없음'}</small></div><button className="btn small" onClick={() => openNextNode(source)}><ArrowRight size={13} /> 다음 노드 선택</button></div>;
  };

  const renderNextNodePicker = () => {
    if (!nextSource) return <Empty title="연결할 노드를 선택하세요" description="캔버스에서 출발 노드를 선택한 뒤 다음 노드를 설정하세요." />;
    const { stage, from, port } = nextSource, graph = getStageGraph(workflow, stage);
    const control = graph.nodes.find(node => `control:${node.id}` === from), condition = control?.kind === 'condition';
    const current = graph.edges.filter(edge => edge.from === from && (edge.port || 'next') === port);
    const targets = graphNodeKeys(workflow, stage).filter(to => to !== 'start' && to !== from && !current.some(edge => edge.to === to) && flowLabel(stage, to).toLowerCase().includes(targetQuery.trim().toLowerCase())).map(to => ({ to, preview: previewConnection(workflow, stage, from, to, port) })).filter(item => item.preview.valid);
    return <div className="we-inspector-body we-next-picker"><div className="we-next-source"><small>{stageName[stage]} / 출발 노드</small><strong>{flowLabel(stage, from)}</strong></div>{condition && <label className="field">연결할 경로<select value={port} disabled={editingDisabled} onChange={event => setNextSource({ ...nextSource, port: event.target.value as 'true' | 'false' })}><option value="true">조건 충족</option><option value="false">그 외</option></select></label>}
      <div className="we-section-title">현재 연결</div>{current.length ? <div className="we-next-current">{current.map(edge => <div key={edge.id}><span>{flowLabel(stage, edge.to)}</span><button className="btn small" disabled={editingDisabled} onClick={() => openInsert(captureInsertTarget(workflow, stage, edge.id))}><Plus size={12} /> 사이에 노드 추가</button></div>)}</div> : <p className="we-fine">아직 연결된 다음 노드가 없습니다.</p>}
      <div className="we-section-title">연결할 대상</div><p className="we-fine">같은 실행 구간의 노드만 선택할 수 있습니다. 기존 연결을 바꾸는 경우 적용 전에 변경 내용을 확인합니다.</p><label className="field">노드 검색<input value={targetQuery} onChange={event => setTargetQuery(event.target.value)} placeholder="노드 이름 검색" /></label>
      <div className="we-next-targets">{targets.map(({ to, preview }) => <button key={to} disabled={editingDisabled} onClick={() => connect(stage, from, to, port)}><span><strong>{flowLabel(stage, to)}</strong><small>{preview.replace ? '기존 연결 변경' : '새 연결'}</small></span><ArrowRight size={14} /></button>)}</div>{targets.length === 0 && <p className="we-fine">선택할 수 있는 다른 노드가 없습니다. 연결 편집에서 노드를 추가하거나 현재 경로를 확인하세요.</p>}
      <button className="btn small we-next-back" onClick={() => { if (selection.kind === 'control') selectControl(selection.id); else selectNode(selection); }}><ArrowLeft size={13} /> 노드 설정으로 돌아가기</button>
    </div>;
  };

  const renderConnectionReview = () => {
    if (!connectionReview) return <Empty title="변경할 연결이 없습니다" description="출발 노드에서 연결할 대상을 선택하세요." />;
    const { stage, from, to, port } = connectionReview;
    const preview = previewConnection(workflow, stage, from, to, port), changes = preview.changes;
    const stale = connectionBaseline(workflow) !== connectionReview.baseline;
    const edgeText = (edge: FlowEdge) => <><span>{flowLabel(stage, edge.from)}</span><ArrowRight size={13} /><span>{flowLabel(stage, edge.to)}</span><small>{edge.port === 'true' ? '조건 충족' : edge.port === 'false' ? '그 외' : '다음'}</small></>;
    return <div className="we-inspector-body we-connection-review"><p className="we-fine">{preview.replace ? '기존 다음 노드를 아래 대상으로 바꿉니다. 병렬 경로는 검사 노드 2~4개를 선택한 뒤 동시에 실행으로 구성하세요.' : '아래 경로를 연결합니다. 다른 경로에 미치는 영향을 확인하세요.'}</p><div className="we-connection-diff"><div><strong>기존 연결</strong><div>{changes?.before ? edgeText(changes.before) : <span>연결 없음</span>}</div></div><div className="after"><strong>변경 후 연결</strong><div>{changes?.after ? edgeText(changes.after) : <span>{flowLabel(stage, from)} → {flowLabel(stage, to)}</span>}</div></div></div>
      {Boolean(changes?.impact.problems.length) && <div className="we-connection-impact"><strong>영향을 받는 노드 {new Set(changes!.impact.problems.map(problem => problem.endpoint)).size}개</strong><p>추가할 선은 초록색, 제거할 선은 붉은 점선으로 표시합니다.</p>{changes!.impact.problems.map((problem, index) => <button key={`${problem.endpoint}-${problem.kind}-${index}`} onClick={() => focusConnectionEndpoint(stage, problem.endpoint)}><span><strong>{flowLabel(stage, problem.endpoint)}{problem.introduced ? ' (변경 후 확인 필요)' : ' (기존 연결 확인)'}</strong><span>{problem.message}</span><small>{problem.suggestion}</small></span><ChevronRight size={14} /></button>)}</div>}{stale && <div className="we-inline-error" role="alert">검토 중 연결이 바뀌었습니다. 현재 연결을 다시 선택하세요.</div>}{!preview.valid && <div className="we-inline-error" role="alert">{preview.reason}</div>}{Boolean(changes?.warnings.length) && <div className="we-connection-warnings"><strong>적용 전 확인</strong><ul>{changes!.warnings.map(message => <li key={message}>{message}</li>)}</ul></div>}{Boolean(changes?.validationMessages.length) && <details className="we-connection-checks"><summary>적용 후 연결 점검 ({changes!.validationMessages.length})</summary><ul>{changes!.validationMessages.map(message => <li key={message}>{message}</li>)}</ul><p>미완성 연결은 임시 보관할 수 있습니다. 연결을 완성하면 서버 저장과 검증과 배포를 할 수 있습니다.</p></details>}
      <div className="we-row"><button className="btn small" onClick={() => { setConnectionReview(undefined); if (nextSource) { setPanelMode('next'); setInspectorOpen(true); } else openGraph(stage); }}>돌아가기</button><button className="btn small primary" disabled={editingDisabled || stale || !preview.valid} onClick={applyReviewedConnection}><Check size={13} /> 연결 적용</button></div>
    </div>;
  };

  const inspectorNodes=searchWorkflowNodes(workflow,connections,inspectorNodeQuery);
  const allInspectorNodes=searchWorkflowNodes(workflow,connections,'');
  const inspectorIndex=allInspectorNodes.findIndex(item=>item.selection.kind===selection.kind&&(!('id' in item.selection)||'id' in selection&&item.selection.id===selection.id));
  const jumpInspector=(target:Selection)=>{searchSelectNode(target);setInspectorNodeSearch(false);setInspectorNodeQuery('');};
  const renderInspectorNavigator=()=> <div className="we-node-navigator"><div><button type="button" className="btn small" aria-expanded={inspectorNodeSearch} onClick={()=>setInspectorNodeSearch(value=>!value)}><Search size={13}/>다른 노드 찾기</button><button type="button" className="we-tool-button" aria-label="이전 노드 설정" disabled={inspectorIndex<=0} onClick={()=>jumpInspector(allInspectorNodes[inspectorIndex-1].selection)}><ArrowLeft size={14}/></button><button type="button" className="we-tool-button" aria-label="다음 노드 설정" disabled={inspectorIndex<0||inspectorIndex>=allInspectorNodes.length-1} onClick={()=>jumpInspector(allInspectorNodes[inspectorIndex+1].selection)}><ArrowRight size={14}/></button></div>{inspectorNodeSearch&&<div role="search" aria-label="설정 패널에서 노드 찾기"><input type="search" autoFocus aria-label="설정할 노드 검색" placeholder="이름, 유형 또는 구간" value={inspectorNodeQuery} onChange={event=>setInspectorNodeQuery(event.target.value)}/><div className="we-inspector-node-results">{inspectorNodes.map(item=><button type="button" key={item.key} onClick={()=>jumpInspector(item.selection)}><strong>{item.name}</strong><small>{item.stageLabel} / {item.typeLabel}</small></button>)}{!inspectorNodes.length&&<p>일치하는 노드가 없습니다.</p>}</div></div>}</div>;
  const renderPolicyCreation=()=>{
    const context=policyCreation?workflowPolicyNode(workflow,policyCreation.from):undefined,source=context?.node,routing=context?.scope.routing,previous=routing?.graph?.edges.find(edge=>edge.from===source?.id&&edge.port===policyCreation?.port),previousNode=routing?.graph?.nodes.find(node=>node.id===previous?.to);
    const unavailable=editingDisabled||!source||policyCreation?.baseline!==policyCreationBaseline(workflow)||(routing?.graph?.nodes.length??0)>=24;
    return <div className="we-inspector-body we-policy-creation"><strong>{source?.name} / {source?policyNodePorts(source).find(item=>item.port===policyCreation?.port)?.label??'선택': '선택'} 경로에 노드 추가</strong><p>선택한 노드 하나를 만들고 이 포트에 연결합니다. 새 노드의 설정과 후속 연결을 완성하세요.</p>{previousNode&&<p className="we-info">현재 {previousNode.name}으로 이어지는 이 포트의 연결을 새 노드로 바꿉니다. 기존 노드는 유지됩니다.</p>}{insertError&&<p className="we-inline-error" role="alert">{insertError}</p>}<button type="button" className="we-creation-choice" disabled={unavailable} onClick={()=>createPolicyFromPort('branch')}><GitBranch size={18}/><span><strong>조건 분기 추가하고 연결</strong><small>출력 필드를 검사하고 참과 거짓으로 나눕니다.</small></span></button><button type="button" className="we-creation-choice" disabled={unavailable} onClick={()=>createPolicyFromPort('switch')}><Split size={18}/><span><strong>Switch 분기 추가하고 연결</strong><small>JSON 필드의 정확한 값 하나에 따라 경로를 선택합니다.</small></span></button><button type="button" className="we-creation-choice" disabled={unavailable} onClick={()=>createPolicyFromPort('action')}><Rocket size={18}/><span><strong>액션 추가하고 연결</strong><small>다음 검사 계속 또는 차단 액션을 설정합니다.</small></span></button>{(routing?.graph?.nodes.length??0)>=24&&<p role="status">정책 노드는 최대 24개입니다.</p>}</div>;
  };
  const renderCreationChooser=()=> <div className="we-inspector-body we-creation-chooser"><p>새 검사를 기존 흐름 사이에 넣거나 동시에 실행할 분기로 추가합니다.</p>{creation&&creation.targets.length>1&&<label className="field">추가할 경로<select value={creation.edgeId} disabled={editingDisabled} onChange={event=>setCreation({...creation,edgeId:event.target.value})}>{creation.targets.map(target=><option key={target.edgeId} value={target.edgeId}>{flowLabel(target.stage,target.from)} → {flowLabel(target.stage,target.to)}</option>)}</select></label>}{creationTarget?<><div className="we-creation-context">{flowLabel(creationTarget.stage,creationTarget.from)}<ArrowRight size={13}/>{flowLabel(creationTarget.stage,creationTarget.to)}</div><button className="we-creation-choice" disabled={editingDisabled} onClick={()=>chooseCreation('insert')}><Plus size={19}/><span><strong>사이에 삽입</strong><small>선택한 경로의 앞뒤 연결을 이어 새 검사 하나를 추가합니다.</small></span><ChevronRight size={15}/></button><button className="we-creation-choice" disabled={editingDisabled||!creationBranch?.valid} onClick={()=>chooseCreation('branch')}><Split size={19}/><span><strong>병렬 분기 추가</strong><small>{creationBranch?.valid?creationBranch.minimumNodes===1?'기존 다음 검사와 새 검사를 동시에 실행한 뒤 합류합니다.':'새 검사 2~4개를 동시에 실행한 뒤 기존 흐름으로 합류합니다.':creationBranch?.reason||'이 위치에는 분기를 추가할 수 없습니다.'}</small></span><ChevronRight size={15}/></button></>:<p role="alert">추가할 연결이 없습니다. 연결선에서 다시 선택하세요.</p>}</div>;
  const renderLibrary = () => {
    if (!library) return null;
    const zone = zones.find(item => item.id === library.zoneId);
    const contextReason=libraryTarget?'검사 조합에는 검사 노드를 추가하세요.':library.parallel||library.insert?.mode==='branch'?'이 경로에는 함께 실행할 검사 노드를 선택하세요.':'';
    const scopes=listWorkflowPolicyChecks(workflow).filter(scope=>scope.stage===library.stage&&scope.routing.policy.formatVersion===2);
    const owner=scopes.find(scope=>scope.id===libraryPolicyOwner)??(scopes.length===1?scopes[0]:undefined);
    const policyReason=contextReason||(listWorkflowPolicyChecks(workflow).length>=12?'정책 검사는 최대 12개입니다.':'');
    const graphReason=contextReason||(library.insert||library.zoneId?'정책 출력의 노드는 상단 노드 추가에서 선택하세요.':'')||(!owner?(scopes.length?'분기를 연결할 정책 검사를 선택하세요.':'구조화 출력 정책 검사 노드를 먼저 추가하세요.'):'')||((owner?.routing.graph?.nodes.length??0)>=24?'정책 노드는 최대 24개입니다.':'');
    const controlReason=contextReason||(getStageGraph(workflow,library.stage).nodes.length>=12?'한 구간의 제어 노드는 최대 12개입니다.':'');
    const fail=(error:unknown)=>{const message=error instanceof Error?error.message:'노드를 추가할 수 없습니다.';setInsertError(message);notify(message);};
    const finish=(next:Workflow,target:Selection)=>{commit(next);setPendingInsert(undefined);setCreation(undefined);setConditionChooser(false);if(target.kind==='control')selectControl(target.id,true,next);else selectNode(target);};
    const addPolicy=()=>{
      const policy=state?.policies?.find(item=>`${item.id}:${item.version}`===newPolicyKey);
      if(!policy||policyReason||editingDisabled)return;
      try{const added=addWorkflowPolicyCheck(workflow,library.stage,policy,{target:library.insert?.target});if(library.insert)inheritInsertedZone(added.workflow,library.insert.target,[`rule:${added.ruleId}`],library.zoneId);finish(added.workflow,{kind:'rule',id:added.ruleId});setPolicyChooser(false);setDeletePolicyConfirm(false);}catch(error){fail(error);}
    };
    const addPolicyGraphNode=(kind:'branch'|'switch'|'action')=>{if(graphReason||editingDisabled)return;try{const added=addWorkflowPolicyGraphNode(workflow,kind,undefined,owner!.id);const scopedId=policyScopedId(owner!.id,added.nodeId);if(kind==='switch')setNewSwitchId(scopedId);finish(added.workflow,{kind:'policy-node',id:scopedId});}catch(error){fail(error);}};
    const addControl=(kind:'condition'|'fork'|'join')=>{if(controlReason||editingDisabled)return;try{const added=addWorkflowControlNode(workflow,library.stage,kind,{target:library.insert?.target});if(library.insert)inheritInsertedZone(added.workflow,library.insert.target,[`control:${added.nodeId}`],library.zoneId);finish(added.workflow,{kind:'control',id:added.nodeId});notify('새 노드의 설정과 연결을 완성한 뒤 저장하세요.');}catch(error){fail(error);}};
    const addGroup=()=>{if(contextReason||editingDisabled)return;try{const added=addWorkflowCheckGroup(workflow,library.stage,{target:library.insert?.target});if(library.insert)inheritInsertedZone(added.workflow,library.insert.target,[`group:${added.groupId}`],library.zoneId);finish(added.workflow,{kind:'group',id:added.groupId});notify('검사 조합에 검사를 추가하고 연결을 완성하세요.');}catch(error){fail(error);}};
    type LibraryCard={key:string;name:string;description:string;category:'llm'|'flow'|'action'|'builtin';Icon:LucideIcon;reason?:string;existing?:boolean;onClick:()=>void};
    const cards:LibraryCard[]=[
      {key:'policy',name:'정책 검사 (구조화 출력)',description:'저장한 정책 버전으로 요청이나 응답을 검사하고 JSON 출력을 조건 분기에 전달합니다.',category:'llm',Icon:BrainCircuit,reason:policyReason,onClick:()=>{setPolicyChooser(true);setConditionChooser(false);}},
      {key:'condition',name:'조건 분기',description:'정책 JSON 출력 또는 요청과 응답 텍스트를 조건으로 검사해 참과 거짓 경로를 선택합니다.',category:'flow',Icon:GitBranch,reason:contextReason,onClick:()=>{setConditionChooser(true);setPolicyChooser(false);}},
      {key:'switch',name:'Switch 분기',description:'스키마 검증을 통과한 정책 JSON의 필드 값을 정확히 비교해 여러 경로 중 하나를 선택합니다.',category:'flow',Icon:Split,reason:graphReason,onClick:()=>addPolicyGraphNode('switch')},
      {key:'action',name:'정책 액션',description:'조건 분기에서 이어 받아 다음 검사 계속 또는 차단을 결정합니다. 기존 정책은 등록 응답도 지원합니다.',category:'action',Icon:Rocket,reason:graphReason,onClick:()=>addPolicyGraphNode('action')},
      {key:'fork',name:'병렬 분기',description:'연결한 2~4개 검사 경로를 동시에 실행합니다. 결과 합류 노드로 경로를 이어 주세요.',category:'flow',Icon:Split,reason:controlReason,onClick:()=>addControl('fork')},
      {key:'join',name:'결과 합류',description:'실행 대상 경로가 모두 끝나면 다음 노드로 이어갑니다. 병렬 분기와 연결을 완성하세요.',category:'flow',Icon:GitBranch,reason:controlReason,onClick:()=>addControl('join')},
      {key:'group',name:'검사 조합',description:'여러 검사를 한 노드에 묶고 하나라도 위반 또는 모두 위반 조건을 설정합니다.',category:'flow',Icon:Layers3,reason:contextReason||(workflow[library.stage].length>=36?'한 구간의 검사 노드는 최대 36개입니다.':''),onClick:addGroup},
      {key:'input',name:'최초 입력',description:'요청 메시지와 검사 대상을 설정합니다. 워크플로우에 하나 있는 필수 노드입니다.',category:'builtin',Icon:LogIn,existing:true,onClick:()=>selectNode({kind:'input'})},
      {key:'main',name:'응답 생성 모델',description:'답변을 생성할 모델과 재작성 설정을 선택합니다. 필수 노드의 설정을 엽니다.',category:'builtin',Icon:BrainCircuit,existing:true,onClick:()=>selectNode({kind:'main'})},
      {key:'output',name:'최종 출력',description:'검사를 통과한 답변을 반환하는 필수 노드의 설정을 엽니다.',category:'builtin',Icon:LogOut,existing:true,onClick:()=>selectNode({kind:'output'})},
    ];
    const query=libraryQuery.trim().toLowerCase();
    const visibleCards=cards.filter(card=>(category==='all'||category===card.category)&&`${card.name} ${card.description}`.toLowerCase().includes(query));
    const conditionReason=conditionTarget==='policy'?graphReason:controlReason;
    return <section className="we-library" aria-label="노드 목록"><div className="we-library-scroll">
      <p className="we-library-intro">{libraryTarget?`검사를 선택해 ${libraryTarget.name} 조합에 추가합니다.`:library.insert?'선택한 연결에 노드를 추가합니다. 설정과 연결을 완성한 뒤 저장하세요.':'필요한 노드를 하나씩 선택해 추가하세요. 입력, 응답 모델과 출력은 기존 필수 노드의 설정을 엽니다.'}</p>
      {library.insert&&<div className="we-insert-context"><strong>{library.insert.mode==='branch'?'이 위치에 병렬 분기 추가':'이 연결 사이에 추가'}</strong><span>{flowLabel(library.stage,library.insert.target.from)}<ArrowRight size={12}/>{flowLabel(library.stage,library.insert.target.to)}</span></div>}
      {insertError&&<div className="we-inline-error" role="alert">{insertError}</div>}
      {zone&&<div className="we-library-zone-context"><Layers3 size={14}/><span><strong>{zone.name}</strong> 영역에 배치합니다.</span></div>}
      <div className="we-library-target single"><label className="field">실행 구간<select aria-label="실행 구간" disabled={editingDisabled||Boolean(library.insert)} value={library.stage} onChange={event=>{setLibrary({...library,stage:event.target.value as Stage,groupId:''});setConditionTarget(listWorkflowPolicyChecks(workflow).some(scope=>scope.stage===event.target.value&&scope.routing.policy.formatVersion===2)?'policy':'text');setSelectedTemplates([]);}}><option value="pre">요청 검사 (응답 생성 전)</option><option value="post">응답 검사 (응답 생성 후)</option></select></label></div>
      {scopes.length>1&&<label className="field">분기를 연결할 정책 검사<select aria-label="분기를 연결할 정책 검사" value={owner?.id??''} onChange={event=>setLibraryPolicyOwner(event.target.value)}><option value="">정책 검사 선택</option>{scopes.map(scope=><option key={scope.id} value={scope.id}>{scope.rule?.name??scope.routing.policy.name} / {scope.routing.policy.name} v{scope.routing.policy.version}</option>)}</select></label>}
      <div className="we-library-search"><Search size={16}/><input aria-label="검사 검색" placeholder="노드 이름이나 기능 검색" value={libraryQuery} onChange={event=>setLibraryQuery(event.target.value)} autoFocus/>{libraryQuery&&<button className="we-tool-button" aria-label="검사 검색 지우기" onClick={()=>setLibraryQuery('')}><X size={13}/></button>}</div>
      <div className="we-library-tabs">{([['all','전체'],['rule','규칙 검사'],['llm','모델 검사'],['flow','흐름 제어'],['action','액션'],['builtin','기본 노드']] as const).map(([key,label])=><button type="button" className={category===key?'active':''} key={key} onClick={()=>setCategory(key)}>{label}</button>)}</div>
      <div className="we-library-grid">{visibleCards.map(card=><button type="button" key={card.key} className={`we-library-card ${card.key==='policy'&&policyChooser||card.key==='condition'&&conditionChooser?'selected':''}`} aria-expanded={card.key==='policy'&&!card.existing?policyChooser:card.key==='condition'?conditionChooser:undefined} data-library-kind={card.key} aria-label={`${card.name} 노드 ${card.existing?'설정':'추가'}`} disabled={editingDisabled||Boolean(card.reason)} onClick={card.onClick}><span className="we-node-icon"><card.Icon size={19}/></span><span><strong>{card.name}</strong><span className="we-library-card-description">{card.description}</span><span className="we-library-card-meta">{card.reason||(card.existing?'기존 노드 설정 열기':'노드 추가')}</span></span>{card.existing?<ArrowRight size={15}/>:<Plus size={15}/>}</button>)}</div>
      {policyChooser&&!policyReason&&<div className="we-info" data-library-chooser="policy"><label className="field">적용할 정책 버전<select aria-label="추가할 정책 버전" value={newPolicyKey} disabled={editingDisabled} onChange={event=>setNewPolicyKey(event.target.value)}><option value="">정책 선택</option>{(state?.policies??[]).map(policy=><option key={`${policy.id}:${policy.version}`} value={`${policy.id}:${policy.version}`}>{policy.name} v{policy.version}{policy.formatVersion===2?' (구조화 출력)':' (기존 판정)'}</option>)}</select></label>{!state?.policies?.length&&<p>정책 관리에서 지시문과 출력 스키마를 먼저 등록하세요.</p>}<button type="button" className="btn small primary" disabled={editingDisabled||!newPolicyKey} onClick={addPolicy}><Plus size={13}/>선택한 정책 노드 추가</button></div>}
      {conditionChooser&&visibleCards.some(card=>card.key==='condition')&&<div className="we-info" data-library-chooser="condition"><label className="field">검사 대상<select aria-label="조건 분기 검사 대상" value={conditionTarget} disabled={editingDisabled} onChange={event=>setConditionTarget(event.target.value as 'policy'|'text')}><option value="policy">정책 JSON 출력</option><option value="text">{stageName[library.stage]} 텍스트</option></select><small>검사 대상에 맞는 필드와 비교 조건을 노드에서 설정합니다.</small></label>{conditionReason&&<p>{conditionReason}</p>}<button type="button" className="btn small primary" disabled={editingDisabled||Boolean(conditionReason)} onClick={()=>conditionTarget==='policy'?addPolicyGraphNode('branch'):addControl('condition')}><Plus size={13}/>조건 분기 추가</button></div>}
      {library.parallel&&<div className="we-library-selection" aria-live="polite"><strong>검사 {selectedTemplates.length}개 선택</strong><span>{libraryTarget?'검사 조합에 함께 추가합니다.':'선택한 검사를 병렬 경로로 추가합니다.'}</span>{selectedTemplates.length>0&&<button onClick={()=>setSelectedTemplates([])} disabled={editingDisabled}>선택 해제</button>}</div>}
      <div className="we-library-grid">{visibleTemplates.map(template=>{const Icon=icons[template.kind],selected=library.parallel&&selectedTemplates.includes(template.id);return <button className={`we-library-card ${selected?'selected':''}`} data-kind={template.kind} key={template.id} aria-pressed={library.parallel?selected:undefined} onClick={()=>addComponent(template)} disabled={editingDisabled||!selected&&libraryCapacity<=(library.parallel?selectedTemplates.length:0)}><span className="we-node-icon"><Icon size={19}/></span><span><strong>{template.name}</strong><span className="we-library-card-description">{template.description}</span><span className="we-library-card-meta">{template.category==='llm'?'모델 검사':'규칙 검사'} (권장: {template.defaultStage==='pre'?'요청 검사':'응답 검사'})</span></span>{library.parallel?<span className={`we-library-checkbox ${selected?'checked':''}`} aria-hidden="true">{selected&&<Check size={12}/>}</span>:<Plus size={15}/>}</button>;})}</div>
      {!visibleTemplates.length&&!visibleCards.length&&<div className="we-library-empty">검색 결과가 없습니다.</div>}
      </div><div className="we-dialog-actions"><span>{libraryTarget?`이 조합에 검사 ${libraryCapacity}개를 더 추가할 수 있습니다.`:'미완성 노드는 임시 보관할 수 있습니다.'}</span><button className="btn small" onClick={exitLibrary}>돌아가기</button>{library.parallel&&<button className="btn small primary" disabled={editingDisabled||selectedTemplates.length<libraryMinimum||selectedTemplates.length>libraryCapacity} onClick={()=>addComponents(selectedTemplates.map(key=>nodeCatalog.find(template=>template.id===key)!))}><Plus size={13}/>{selectedTemplates.length}개 추가</button>}</div>
    </section>;
  };

  return <section className={`we-editor ${expanded?'is-expanded':''}`} aria-label="워크플로우 편집기" ref={editorRef} onKeyDown={event=>{if(expanded&&event.key==='Escape'&&!event.defaultPrevented&&!event.nativeEvent.isComposing){event.preventDefault();setExpanded(false);}}} onFocusCapture={event => beginTextField(event.target)} onBlurCapture={event => endTextField(event.target)} onChangeCapture={markTextChange} onKeyDownCapture={editorKeys} onScrollCapture={event => recordInspectorScroll(event.target)}>
    <div className="we-topbar"><div className="we-top-status">{expanded&&<strong className="we-focus-title" title={workflow.name}>{workflow.name}</strong>}<Tag tone={status === 'deployed' ? 'success' : status === 'changed' ? 'warning' : 'neutral'}>{status === 'draft' ? '초안' : status === 'changed' ? `v${version} 변경 사항 있음` : `v${version} 배포됨`}</Tag><span className="we-counts">검사 노드 {counts.groups}개, 검사 {counts.nodes}개</span>{dirty && <span className="we-dirty">저장되지 않음</span>}</div><div className="we-top-actions">{onTemporarySave && <button className="btn small" disabled={readOnly} onClick={onTemporarySave}><Save size={14} /> 임시 보관</button>}<button className="btn small" disabled={actionDisabled} onClick={() => void onSave()}><Save size={14} /> 저장</button><button className="btn small" aria-expanded={runnerOpen} aria-controls="workflow-run-dock-body" onClick={() => { setView('builder'); setRunnerOpen(true); }}><Play size={14} /> 실행</button><button className="btn small" disabled={actionDisabled} onClick={() => void onTest()}><ChevronRight size={14} /> 검증 화면</button><button className="btn small primary" disabled={actionDisabled || !canDeploy} onClick={() => void onDeploy()}><Rocket size={14} /> 배포</button></div></div>
    {issues.length>0&&<section className="we-readiness" role="status" aria-label="설정 준비 상태"><div><strong>{actionDisabled?'저장 전에 완성할 설정':'실행 전에 확인할 설정'} {issues.length}건</strong><span>{issues[0].label}: {issues[0].message}</span><small>{actionDisabled?'미완성 초안은 임시 보관할 수 있습니다.':'초안 저장과 별개로 실행 전에 설정을 확인하세요.'}</small></div><button type="button" className="btn small" onClick={()=>focusIssue(issues[0])}>수정 위치로 이동<ChevronRight size={13}/></button><button type="button" className="btn small" aria-expanded={checksOpen} onClick={()=>setChecksOpen(value=>!value)}>전체 점검</button></section>}
    {temporarySaveStatus && <div className="we-temporary-status" role="status">{temporarySaveStatus}<span>이 브라우저에 보관하며 서버 저장과 배포는 별도로 진행합니다.</span></div>}
    {onReturnToEvaluation && <div className="we-evaluation-return"><div><strong>{evaluationOriginLabel || '검증 결과에서 설정을 수정하고 있습니다.'}</strong><span>같은 요청의 재검증은 원래 검증 기록을 변경하지 않습니다.</span></div><div><button className="btn small" onClick={onReturnToEvaluation}><ArrowLeft size={13} /> 검증 결과로 돌아가기</button>{onEvaluateCurrentWorkflow && <button className="btn small" disabled={actionDisabled} onClick={onEvaluateCurrentWorkflow}>현재 초안으로 전체 검증<ArrowRight size={13} /></button>}</div></div>}
    <div className="we-commandbar"><div className="we-command-left"><div className="we-tabs" aria-label="편집 보기"><button className={view === 'builder' ? 'active' : ''} aria-pressed={view === 'builder'} onClick={() => setView('builder')}>편집</button><button className={view === 'json' ? 'active' : ''} aria-pressed={view === 'json'} onClick={() => { setAutoFitRequest(0); setView('json'); setInspectorOpen(false); }}>JSON</button></div><span className="we-command-divider" /><button className={`btn small we-workflow-settings-toggle ${inspectorOpen && panelMode === 'workflow' ? 'active' : ''}`} aria-expanded={inspectorOpen && panelMode === 'workflow'} aria-controls="workflow-node-inspector" onClick={openWorkflowSettings}><Settings2 size={14} /> 워크플로우 설정</button><button title="연결 편집" className={`we-command-button ${inspectorOpen && panelMode === 'graph' ? 'active' : ''}`} disabled={busy} onClick={() => openGraph(activeStage)}><GitBranch size={14} /> 연결 편집</button><button title="설정 점검" className={`we-command-button we-check-toggle ${checksOpen ? 'active' : ''}`} onClick={() => setChecksOpen(current => !current)} aria-expanded={checksOpen} aria-controls="workflow-settings-check"><ClipboardCheck size={14} /> 설정 점검{issues.length > 0 && <span className="we-check-count">{issues.length}</span>}</button></div><div className="we-command-actions"><button type="button" className="btn small we-expand-toggle" aria-label={expanded?'워크플로우 화면 복원':'워크플로우 화면 넓게'} title={expanded?'화면 복원 (Esc)':'메뉴를 가리고 작업 화면을 넓게 사용합니다'} aria-pressed={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?<Minimize2 size={15}/>:<Maximize2 size={15}/>}<span>{expanded?'화면 복원':'화면 넓게'}</span></button><button className="we-tool-button" aria-label="실행 취소" title="실행 취소" onClick={undo} disabled={editingDisabled || history.past.length === 0}><Undo2 size={16} /></button><button className="we-tool-button" aria-label="다시 실행" title="다시 실행" onClick={redo} disabled={editingDisabled || history.future.length === 0}><Redo2 size={16} /></button><button className={`we-tool-button we-panel-toggle ${inspectorOpen ? 'active' : ''}`} aria-label={inspectorOpen ? '설정 패널 닫기' : `${panelTitle} 열기`} title={inspectorOpen ? '설정 패널 닫기' : `${panelTitle} 열기`} aria-expanded={inspectorOpen} aria-controls="workflow-node-inspector" onClick={() => inspectorOpen ? closeInspector() : reopenInspector()}><PanelRight size={16} /></button><span className="we-command-divider" /><button className="btn small" title="영역 추가" onClick={() => addZone()} disabled={editingDisabled || zones.length >= 32}><Layers3 size={14} /> 영역 추가</button><button title="노드 추가" className="btn small we-add-command" onClick={() => openLibrary(activeStage)} disabled={editingDisabled}><Plus size={14} /> 노드 추가</button></div></div>
    {checksOpen && <section className="we-checks" id="workflow-settings-check" aria-label="설정 점검 결과"><div className="we-checks-heading"><div><strong>{issues.length ? `확인이 필요한 설정 ${issues.length}개` : '확인이 필요한 설정이 없습니다.'}</strong><p>입력값과 모델 연결 설정을 점검합니다. 실제 연결과 차단 결과는 검증 화면에서 확인하세요.</p></div><button className="we-tool-button" aria-label="설정 점검 닫기" onClick={() => setChecksOpen(false)}><X size={15} /></button></div>{issues.length > 0 ? <div className="we-check-list">{issues.map((issue, index) => <button key={`${issue.target.kind}-${'id' in issue.target ? issue.target.id : ''}-${index}`} className="we-check-item" onClick={() => focusIssue(issue)}><span><strong>{issue.label}</strong><span>{issue.message}</span></span><ChevronRight size={15} /></button>)}</div> : <div className="we-check-clear"><Check size={16} /> 현재 설정으로 검증을 실행할 수 있습니다.</div>}</section>}
    {zoneIssues.length>0&&<div className="we-graph-warning" role="status"><span>영역 {zoneIssues.length}개에 이어지지 않은 노드가 있습니다. 영역은 연결된 노드끼리만 구성할 수 있습니다.</span><button className="btn small" disabled={editingDisabled} onClick={repairZones}>이어진 영역으로 나누기</button></div>}
    {graphErrors.length > 0 && <div className="we-graph-warning" role="status"><span>연결 설정 {graphErrors.length}개를 확인하세요. 미완성 상태도 임시 보관할 수 있습니다. 서버 저장과 검증과 배포는 연결을 완성한 뒤 진행하세요.</span><button className="btn small" onClick={() => openGraph(graphErrors[0].startsWith('응답 검사:') ? 'post' : 'pre')}>연결 수정</button></div>}

    {view === 'json' ? <div className="we-json"><div><span>현재 초안</span><button className="btn small" onClick={() => void copyJson()}><Copy size={13} /> 복사</button></div><pre>{JSON.stringify(workflow, null, 2)}</pre></div> : <>
    <div className={`we-layout ${inspectorOpen ? 'with-inspector' : ''} ${runnerOpen ? 'with-runner' : ''}`}><div className="we-canvas-workspace"><WorkflowCanvas workflow={workflow} connections={connections} selection={panelMode === 'graph' && graphControlId ? { kind: 'control', id: graphControlId } : panelMode === 'zone' ? selection : canvasSelection} disabled={editingDisabled} execution={execution?.result} inspection={execution?.inspection} executionAttempt={executionAttempt} progress={runner.progress} running={runner.running} stale={Boolean(execution) && executionRecency !== 'current'} onSelect={selectNode} onInspect={target=>{selectNode(target);setInspectorTab('execution');}} onSearchSelect={searchSelectNode} branchEligibility={branchEligibility} onBackgroundSelect={closeInspector} graphEditing={!editingDisabled} connectionImpact={connectionImpact} focusRequest={focusRequest} initialViewport={canvasViewport.current} onViewportChange={recordViewport} onConnect={connect} onCreatePolicyFromPort={openPolicyCreation} onPolicyConnect={(from,to,port)=>{if(editingDisabled)return;const source=parsePolicyScopedId(from),target=parsePolicyScopedId(to);if(source.ownerId!==target.ownerId){notify('같은 정책 검사의 노드끼리 연결하세요.');return;}commit(connectWorkflowPolicyNode(workflow,source.localId,target.localId,port,undefined,source.ownerId));selectNode({kind:'policy-node',id:from});}} selectedPolicyEdgeId={selectedPolicyEdge?policyEdgeFocus?.edgeId:undefined} onSelectPolicyEdge={selectPolicyEdge} onSelectEdge={selectEdge} onInsertNode={openInsert} onCreateFromPort={openFromPort} autoFitRequest={autoFitRequest} onAutoFitConsumed={request=>setAutoFitRequest(current=>current===request?0:current)} zoneSelectionIssue={selectionZoneIssue} zoneCompletionKeys={zoneCompletion.missingKeys} zoneCompletionIssue={completionIssue} onCompleteZoneSelection={()=>{if(editingDisabled)return;if(completionIssue){notify(completionIssue);return;}setSelectedKeys(zoneCompletion.nodeKeys);}} onBuildBranch={buildBranch} readOnly={readOnly} notify={notify} selectedKeys={selectedKeys} onSelectedKeys={setSelectedKeys} onGroupSelection={() => addZone(selectedKeys)} onAddZone={() => addZone()} onAddNode={zoneId => openLibrary(activeStage, '', false, zoneId)} onLayout={(positions, nextZones) => modify(next => { next.layout = { ...next.layout, version: 1, positions, ...(nextZones ? { zones: nextZones } : {}) }; })} onAdd={openLibrary} onRetry={revealRetrySettings} />
      <section className={`we-run-dock ${runnerOpen ? 'open' : ''} ${runnerExpanded?'expanded':''}`} aria-label="워크플로우 실행과 결과"><div className="we-run-dock-head"><button type="button" className="we-run-dock-toggle" aria-expanded={runnerOpen} aria-controls="workflow-run-dock-body" onClick={() => setRunnerOpen(open => !open)}><Play size={13}/><strong>실행과 결과</strong>{runner.busy ? <span>{runner.currentLabel} / {Math.floor(runner.elapsedMs / 1000)}초</span> : execution ? <span>{execution.result.status === 'allow' ? '응답 반환' : execution.result.status === 'block' ? '차단' : '실행 오류'}</span> : <span>질문 또는 데이터셋으로 확인</span>}{runnerOpen ? <ChevronDown size={14}/> : <ChevronUp size={14}/>}</button>{firstBlockedTrace && <button type="button" className="we-run-jump" onClick={() => { setExecutionAttempt(firstBlockedTrace.attempt); revealSelection({kind:'rule',id:firstBlockedTrace.ruleId}); }}>첫 차단 검사<ChevronRight size={12}/></button>}{runnerOpen&&<button type="button" className="btn small we-run-expand" aria-pressed={runnerExpanded} onClick={()=>setRunnerExpanded(value=>!value)}>{runnerExpanded?'작게 보기':'크게 보기'}</button>}{generationCount > 0 && <label className="we-attempt-select">실행 회차<select aria-label="캔버스 실행 회차" disabled={runner.running} value={executionAttempt ?? ''} onChange={event => setExecutionAttempt(event.target.value ? Number(event.target.value) : undefined)}><option value="">마지막 회차</option>{Array.from({length:generationCount},(_,index) => <option key={index + 1} value={index + 1}>{index === 0 ? '최초 생성' : `재작성 ${index}회`}</option>)}</select></label>}</div>{runnerOpen && <div className="we-run-dock-body" id="workflow-run-dock-body">{execution && <section className={`we-execution-context ${executionStale ? 'stale' : ''}`} aria-label="마지막 검증 결과"><div className="we-execution-heading"><div><strong>마지막 검증</strong>{execution.result.executionMode === 'mock' && <Tag tone="warning">모의 응답</Tag>}<Tag tone={execution.result.status === 'allow' ? 'success' : execution.result.status === 'block' ? 'warning' : 'error'}>{execution.result.status === 'allow' ? '응답 반환' : execution.result.status === 'block' ? '차단' : '실행 오류'}</Tag><span>{execution.result.latencyMs.toLocaleString()}ms</span>{generationCount > 1 && <span>응답 생성 총 {generationCount}회 (재작성 {regenerationCount}회)</span>}<Tag tone={executionStale ? 'warning' : 'neutral'}>{executionStale ? '설정 변경 전 결과' : executionRecency === 'current' ? '현재 설정과 일치' : executionRecency === 'checking' ? '실행 당시 설정과 비교 중' : '실행 당시 설정 확인 불가'}</Tag></div>{onRetest && <button className="btn small" disabled={actionDisabled || retesting} onClick={() => void retest()}><RefreshCw size={13} />{retesting ? '검증 중' : '같은 요청 다시 검증'}</button>}</div><button type="button" className="we-execution-details-link" onClick={()=>setRunnerOpen(true)}>요청과 실행 결과 보기<ChevronRight size={13}/></button></section>}{runner.panel}</div>}</section></div>
    {inspectorOpen && <><button className="we-panel-backdrop" aria-label="설정 패널 닫기" tabIndex={-1} onClick={closeInspector} /><aside className={`we-inspector mode-${panelMode}`} id="workflow-node-inspector" ref={inspectorRef} tabIndex={-1} role={narrowPanel ? 'dialog' : undefined} aria-modal={narrowPanel ? true : undefined} aria-label={panelMode === 'policy-create' ? '정책 경로에 노드 추가' : panelMode === 'create' ? '노드 추가 방법' : panelMode === 'connection' ? '연결 변경 확인' : panelMode === 'next' ? '다음 노드' : panelMode === 'zone' ? '영역 설정' : panelMode === 'graph' ? '연결 편집' : panelMode === 'workflow' ? '워크플로우 설정' : panelMode === 'library' ? '노드 추가' : '선택한 노드 설정'} onKeyDown={inspectorKeys}><div className="we-inspector-head">{panelMode === 'library' ? <button className="we-tool-button" aria-label="이전 설정으로 돌아가기" title="이전 설정으로 돌아가기" onClick={exitLibrary}><ArrowLeft size={16} /></button> : <Settings2 size={15} />}<strong>{panelTitle}</strong>{renderPositionPin()}{nodeDeleteLabel&&<button type="button" className="btn small danger we-delete-node" aria-label={nodeDeleteLabel} title={nodeDeleteLabel} disabled={editingDisabled} onClick={deleteSelectedNode}><Trash2 size={13}/><span>삭제</span></button>}<button className="we-tool-button" aria-label="설정 패널 닫기" title="설정 패널 닫기" onClick={closeInspector}><X size={17} /></button></div>{panelMode!=='library'&&renderInspectorNavigator()}{(panelMode==='node'||panelMode==='graph'&&Boolean(graphControlId))&&<div className="we-inspector-tabs" role="tablist" aria-label="노드 상세 보기"><button type="button" role="tab" aria-selected={inspectorTab==='settings'} aria-controls="workflow-node-settings" onClick={()=>setInspectorTab('settings')}>설정</button><button type="button" role="tab" aria-selected={inspectorTab==='execution'} aria-controls="workflow-node-execution" onClick={()=>setInspectorTab('execution')}>실행 내역{execution&&<span>{executionStale?'이전 설정':'결과 있음'}</span>}</button></div>}{deletePolicyConfirm&&panelMode==='node'&&selection.kind==='policy'&&<section className="we-inspector-confirm" role="group" aria-label="정책 삭제 확인"><strong>정책 검사 전체를 삭제할까요?</strong><p>연결된 조건 분기와 액션도 함께 삭제합니다. 저장된 정책 버전은 유지되며 실행 취소로 복원할 수 있습니다.</p><div><button type="button" className="btn small" onClick={()=>setDeletePolicyConfirm(false)}>취소</button><button type="button" className="btn small danger" data-policy-delete-confirm disabled={editingDisabled} onClick={()=>{commit(removeWorkflowPolicy(workflow));setDeletePolicyConfirm(false);selectNode({kind:'main'});}}>정책 노드 전체 삭제</button></div></section>}{panelMode === 'library' ? renderLibrary() : <div className="we-inspector-scroll">{pendingInsert && panelMode!=='create' && <div className="we-insert-resume"><span>선택한 연결에 추가할 노드를 고르고 있습니다.</span><button onClick={resumeInsert} disabled={editingDisabled}>계속 선택</button><button aria-label="삽입 취소" onClick={() => { setPendingInsert(undefined); setInsertError(''); }}><X size={13} /></button></div>}{(panelMode==='node'||panelMode==='graph'&&Boolean(graphControlId))&&<div id="workflow-node-execution" role="tabpanel" hidden={inspectorTab!=='execution'}><NodeExecutionInspector nodeId={selectedCanvasKey??'input'} label={allInspectorNodes.find(node=>node.key===selectedCanvasKey)?.name??panelTitle} workflow={workflow} result={execution?.result} inspection={execution?.inspection} attempt={executionAttempt} onAttempt={setExecutionAttempt} stale={Boolean(execution)&&executionRecency!=='current'}/></div>}<div id="workflow-node-settings" role="tabpanel" hidden={inspectorTab==='execution'&&(panelMode==='node'||panelMode==='graph'&&Boolean(graphControlId))}>{panelMode === 'policy-create' ? renderPolicyCreation() : panelMode === 'create' ? renderCreationChooser() : panelMode === 'connection' ? renderConnectionReview() : panelMode === 'next' ? renderNextNodePicker() : panelMode === 'graph' ? <>{graphControlId && <>{renderNodeConnections()}{selectedControl?.control.kind==='fork'||selectedControl?.control.kind==='join'?<div className="we-info we-parallel-explanation">병렬 경로 중 하나라도 차단되면 전체 실행을 중단합니다. 이미 시작한 검사는 결과를 모으며, 합류에서는 실행 대상 경로가 모두 끝날 때까지 기다립니다.</div>:null}</>}<WorkflowGraphSettings nodeActionsRef={nodeActionsRef} workflow={workflow} stage={graphStage} disabled={editingDisabled} selectedControlId={graphControlId} selectedEdgeId={graphEdgeId} initialPreset={initialPreset} onImpactChange={setGraphImpact} onFocusEndpoint={focusConnectionEndpoint} onStageChange={stage => { setInitialPreset(undefined); setGraphStage(stage); setGraphControlId(undefined); setGraphEdgeId(undefined); }} onChange={commit} onAddNode={()=>{openLibrary(graphStage);setCategory('flow');}} onSelectControl={selectControl} onSelectEdge={edgeId => selectEdge(graphStage, edgeId)} notify={notify} /></> : panelMode === 'zone' ? renderZoneInspector() : panelMode === 'workflow' ? renderWorkflowInspector() : <>{renderSelectedInspector()}{renderNodeConnections()}</>}</div></div>}{panelMode === 'workflow' && <div className="we-panel-footer"><span>{readOnly ? '설정을 조회하고 있습니다.' : dirty ? '변경한 설정을 저장하세요.' : '저장된 설정입니다.'}</span><button className="btn small primary" disabled={actionDisabled || !dirty} onClick={() => void onSave()}><Save size={14} /> 저장</button></div>}</aside></>}</div></>}
    <div className="we-footer"><span>{workflow.graph ? '연결선에 따라 실행합니다. 분기 경로는 결과 합류로 연결하세요.' : '검사 노드는 연결된 순서대로 실행합니다.'} 영역과 배치는 실행 경로에 영향을 주지 않습니다.</span><span>검사 설정 변경은 저장 후 배포하면 API 요청에 적용됩니다.</span></div>

    {deletingGroup && <div className="we-dialog-backdrop" onClick={() => setDeletingGroup(undefined)}><section className="we-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="group-delete-title" onClick={event => event.stopPropagation()}><div className="we-library-head"><h2 id="group-delete-title">검사 조합을 삭제할까요?</h2><button className="we-tool-button" aria-label="조합 삭제 창 닫기" onClick={() => setDeletingGroup(undefined)}><X size={17} /></button></div><p>이 조합과 포함된 {findGroup(workflow, deletingGroup)?.group.rules.length || 0}개 검사를 삭제합니다. 편집기의 실행 취소로 복원할 수 있습니다.</p><div className="we-dialog-actions"><button className="btn small" onClick={() => setDeletingGroup(undefined)}>취소</button><button className="btn small danger" onClick={() => deleteGroup(deletingGroup)} disabled={editingDisabled}><Trash2 size={13} /> 조합 삭제</button></div></section></div>}
  </section>;
}
