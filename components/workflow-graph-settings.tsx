'use client';

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { ArrowRight, GitBranch, GitMerge, Plus, Split, Trash2 } from 'lucide-react';
import type { FlowCondition, FlowControlNode, FlowEdge, Workflow } from '@/lib/aegis-types';
import { createStageGraph, endpointLabel, getStageGraph, graphNodeKeys, validateWorkflowGraph } from '@/lib/workflow-graph';
import { applyConnection, connectionImpact, getConnectionProblems, previewConnection, type FlowConnectionImpact, type FlowConnectionProblem } from '@/lib/workflow-connections';
import { buildBranchSelection, previewBranchSelection } from '@/lib/workflow-branching';
import './workflow-graph-settings.css';

type Stage = 'pre' | 'post';
type EdgeReview = { stage: Stage; signature: string; selectedEdge?: FlowEdge; before: FlowEdge[]; after?: FlowEdge; warnings: string[]; validationMessages: string[]; impact:FlowConnectionImpact };

export type WorkflowGraphSettingsProps = {
  workflow: Workflow; stage: Stage; disabled: boolean;
  selectedControlId?: string; selectedEdgeId?: string;
  initialPreset?: { kind: 'parallel' | 'condition'; firstGroupId: string; secondGroupId: string; groupIds?: string[]; requestId: string };
  onStageChange: (stage: Stage) => void;
  onChange: (workflow: Workflow) => void;
  onSelectControl: (id?: string) => void;
  onSelectEdge: (id?: string) => void;
  onImpactChange?: (impact?:FlowConnectionImpact) => void;
  onFocusEndpoint?: (stage:Stage,endpoint:string) => void;
  onAddNode?: () => void;
  nodeActionsRef?: Ref<{deleteNode:()=>void}>;
  notify: (message: string) => void;
};
const key = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
const names = { condition: '조건 분기', fork: '병렬 분기', join: '결과 합류' };
const conditionOptions = [['contains', '문구 포함'], ['not_contains', '문구 미포함'], ['length_gte', '글자 수 이상'], ['length_lte', '글자 수 이하']] as const;
const portLabel = (port?: string) => port === 'true' ? '조건 충족' : port === 'false' ? '그 외' : '다음';

export function WorkflowGraphSettings({ workflow, stage, disabled, selectedControlId, selectedEdgeId, initialPreset, onStageChange, onChange, onSelectControl, onSelectEdge, notify, onImpactChange, onFocusEndpoint, onAddNode, nodeActionsRef }: WorkflowGraphSettingsProps) {
  const graph = getStageGraph(workflow, stage);
  const control = graph.nodes.find(node => node.id === selectedControlId);
  const edge = graph.edges.find(item => item.id === selectedEdgeId);
  const [from, setFrom] = useState(edge?.from || 'start');
  const [to, setTo] = useState(edge?.to || 'end');
  const [port, setPort] = useState<'next' | 'true' | 'false'>(edge?.port || 'next');
  const [presetKind, setPresetKind] = useState<'parallel' | 'condition'>(initialPreset?.kind || 'parallel');
  const [firstGroup, setFirstGroup] = useState(initialPreset?.firstGroupId || '');
  const [secondGroup, setSecondGroup] = useState(initialPreset?.secondGroupId || '');
  const [additionalGroups, setAdditionalGroups] = useState<string[]>(initialPreset?.groupIds?.slice(2) || []);
  const [edgeReview, setEdgeReview] = useState<EdgeReview>();
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(initialPreset));
  const [editingConnection, setEditingConnection] = useState(false);
  const impactCallback=useRef(onImpactChange);impactCallback.current=onImpactChange;
  const reviewFields = useRef<HTMLElement>(null);
  const [condition, setCondition] = useState<FlowCondition>({ operator: 'contains', value: '', caseSensitive: false });
  const controlFields = useRef<HTMLElement>(null);
  const edgeFields = useRef<HTMLDivElement>(null);
  const presetFields = useRef<HTMLDivElement>(null);
  const appliedPresetRequest = useRef<string | undefined>(undefined);
  const presetContext = useRef({ workflowId: workflow.id, stage });
  useEffect(() => { setEdgeReview(undefined); }, [stage, selectedEdgeId, from, to, port, workflow.id]);
  useEffect(() => { setFrom(edge?.from || 'start'); setTo(edge?.to || 'end'); setPort(edge?.port || 'next'); }, [stage, selectedEdgeId, edge?.from, edge?.to, edge?.port]);
  useEffect(() => {
    if (presetContext.current.workflowId !== workflow.id || presetContext.current.stage !== stage) {
      presetContext.current = { workflowId: workflow.id, stage };
      setFirstGroup(''); setSecondGroup(''); setAdditionalGroups([]);
    }
    if (!initialPreset || appliedPresetRequest.current === initialPreset.requestId) return;
    appliedPresetRequest.current = initialPreset.requestId;
    setAdvancedOpen(true);
    const selected = initialPreset.groupIds || [initialPreset.firstGroupId, initialPreset.secondGroupId];
    setPresetKind(initialPreset.kind); setFirstGroup(selected[0] || ''); setSecondGroup(selected[1] || ''); setAdditionalGroups(selected.slice(2));
    requestAnimationFrame(() => presetFields.current?.scrollIntoView({ block: 'nearest' }));
  }, [initialPreset?.requestId, stage, workflow.id]);
  useEffect(() => { setEditingConnection(false); }, [stage, selectedControlId, selectedEdgeId, workflow.id]);
  useEffect(() => { if (control) controlFields.current?.scrollIntoView({ block: 'nearest' }); }, [control?.id]);
  useEffect(() => { if (edge) edgeFields.current?.scrollIntoView({ block: 'nearest' }); }, [edge?.id]);
  const errors = validateWorkflowGraph(workflow).filter(message => message.startsWith(stage === 'pre' ? '요청 검사:' : '응답 검사:') || !message.includes(':'));
  const locked = disabled;
  const reviewSignature = JSON.stringify({ workflowId: workflow.id, pre: getStageGraph(workflow, 'pre'), post: getStageGraph(workflow, 'post'), groups: (['pre', 'post'] as const).map(item => workflow[item].map(group => ({ id: group.id, name: group.name, required: group.required === true }))) });
  useEffect(()=>{impactCallback.current?.(edgeReview?.signature===reviewSignature?edgeReview.impact:undefined);return()=>impactCallback.current?.(undefined);},[edgeReview,reviewSignature]);
  const repairProblems=getConnectionProblems(workflow,stage);
  const endpoints = graphNodeKeys(workflow, stage);
  const groupLabel = (group: Workflow['pre'][number]) => group.rules.length === 1 ? group.rules[0].name : `${group.name} (검사 조합)`;
  const label = (endpoint: string) => endpoint.startsWith('group:') ? (() => { const group = workflow[stage].find(item => `group:${item.id}` === endpoint); return group ? groupLabel(group) : endpointLabel(workflow, stage, endpoint); })() : endpoint === 'start' ? stage === 'pre' ? '최초 입력' : '응답 생성 모델' : endpoint === 'end' ? stage === 'pre' ? '응답 생성 모델' : '최종 출력' : endpointLabel(workflow, stage, endpoint);
  const sourceControl = graph.nodes.find(node => `control:${node.id}` === from);
  const conditionSource = sourceControl?.kind === 'condition';
  const chosenIds = [firstGroup, secondGroup, ...(presetKind === 'parallel' ? additionalGroups : [])].filter(Boolean);
  const branchPreview = previewBranchSelection(workflow, stage, chosenIds, presetKind);
  const selectedGroups = workflow[stage].filter(group => chosenIds.includes(group.id));
  const numericCondition = condition.operator === 'length_gte' || condition.operator === 'length_lte';
  const validCondition = numericCondition ? /^(?:0|[1-9]\d*)$/.test(condition.value) && Number(condition.value) <= 40000 : condition.value.length > 0 && condition.value.length <= 2000;

  function change(action: (next: Workflow) => void) {
    if (locked) return;
    const next = structuredClone(workflow);
    next.graph ||= { version: 1, pre: createStageGraph(next.pre), post: createStageGraph(next.post) };
    action(next); onChange(next);
  }
  function updateControl(patch: Partial<FlowControlNode>) {
    if (!control) return;
    change(next => { const found = next.graph![stage].nodes.find(node => node.id === control.id)!; Object.assign(found, patch); });
  }
  function deleteControl() {
    if (!control || locked) return;
    const endpoint = `control:${control.id}`;
    const incoming = graph.edges.filter(item => item.to === endpoint);
    const outgoing = graph.edges.filter(item => item.from === endpoint);
    if (incoming.length || outgoing.length) {
      if (incoming.length !== 1 || outgoing.length !== 1 || incoming[0].from === outgoing[0].to || graph.edges.some(item => item.from !== endpoint && item.to !== endpoint && item.from === incoming[0].from && item.to === outgoing[0].to && (item.port || 'next') === (incoming[0].port || 'next'))) {
        notify('이 노드의 연결을 먼저 정리하세요. 들어오는 선과 나가는 선이 각각 하나일 때만 자동으로 이어 삭제할 수 있습니다.'); return;
      }
    }
    change(next => {
      const target = next.graph![stage]; target.nodes = target.nodes.filter(node => node.id !== control.id); target.edges = target.edges.filter(item => item.from !== endpoint && item.to !== endpoint);
      if (incoming.length) target.edges.push({ ...incoming[0], to: outgoing[0].to });
    });
    onSelectControl(undefined); onSelectEdge(undefined);
  }
  useImperativeHandle(nodeActionsRef,()=>({deleteNode:deleteControl}));
  function connectionSubject(selected?: FlowEdge) {
    if (!selected || !graph.nodes.some(node => node.kind === 'fork' && `control:${node.id}` === selected.from)) return workflow;
    const next = structuredClone(workflow);
    next.graph ||= { version: 1, pre: createStageGraph(next.pre), post: createStageGraph(next.post) };
    next.graph[stage].edges = next.graph[stage].edges.filter(item => item.id !== selected.id);
    return next;
  }
  function applyReviewedConnection(review: EdgeReview) {
    if (locked) return;
    if (review.stage !== stage || review.signature !== reviewSignature) { notify('연결 설정이 변경되었습니다. 현재 연결을 다시 확인하세요.'); return; }
    if(!review.after){
      if(!review.selectedEdge)return;
      const edgeId=review.selectedEdge.id;
      change(next=>{next.graph![stage].edges=next.graph![stage].edges.filter(item=>item.id!==edgeId);});
      setEdgeReview(undefined);onSelectEdge(undefined);return;
    }
    const after=review.after;
    const subject = connectionSubject(review.selectedEdge);
    const preview = previewConnection(subject, stage, after.from, after.to, after.port);
    if (!preview.valid) { notify(preview.reason || '이 노드에 연결할 수 없습니다.'); return; }
    try {
      const next = applyConnection(subject, stage, after.from, after.to, after.port);
      const saved = getStageGraph(next, stage).edges.find(item => item.from === after.from && item.to === after.to && (item.port || 'next') === (after.port || 'next'));
      onChange(next); setEdgeReview(undefined); if (saved) onSelectEdge(saved.id);
    } catch (error) { notify(error instanceof Error ? error.message : '연결을 변경하지 못했습니다.'); }
  }
  function reviewEdgeDeletion() {
    if(locked||!edge)return;
    const next=structuredClone(workflow);
    next.graph||={version:1,pre:createStageGraph(next.pre),post:createStageGraph(next.post)};
    next.graph[stage].edges=next.graph[stage].edges.filter(item=>item.id!==edge.id);
    setEdgeReview({stage,signature:reviewSignature,selectedEdge:{...edge},before:[{...edge}],warnings:[],validationMessages:validateWorkflowGraph(next),impact:connectionImpact(workflow,stage,[edge],[])});
    requestAnimationFrame(()=>reviewFields.current?.scrollIntoView({block:'nearest'}));
  }
  function saveEdge() {
    if (locked) return;
    const selectedPort = conditionSource ? port === 'next' ? 'true' : port : 'next';
    if (edge && (from !== edge.from || selectedPort !== (edge.port || 'next'))) { notify('현재 연결선의 출발과 경로를 확인하세요.'); return; }
    if (edge?.to === to) { notify('현재 연결과 같습니다. 다른 도착 노드를 선택하세요.'); return; }
    const preview = previewConnection(connectionSubject(edge), stage, from, to, selectedPort);
    if (!preview.valid || !preview.changes) { notify(preview.reason || '이 노드에 연결할 수 없습니다.'); return; }
    const before = edge ? [edge] : [];
    if (preview.changes.before && !before.some(item => item.id === preview.changes!.before!.id)) before.push(preview.changes.before);
    const review: EdgeReview = { stage, signature: reviewSignature, selectedEdge: edge ? { ...edge } : undefined, before, after: preview.changes.after, warnings: preview.changes.warnings, validationMessages: preview.changes.validationMessages, impact:connectionImpact(workflow,stage,before,[preview.changes.after]) };
    if (edge || preview.replace || preview.changes.warnings.length > 0) {
      setEdgeReview(review); requestAnimationFrame(() => reviewFields.current?.scrollIntoView({ block: 'nearest' }));
    } else applyReviewedConnection(review);
  }
  function preset() {
    if (locked || !branchPreview.valid || (presetKind === 'condition' && !validCondition)) return;
    try {
      const built = buildBranchSelection(workflow, branchPreview, { ...(presetKind === 'condition' ? { condition } : {}), identifier: key });
      onChange(built.workflow); onSelectControl(built.splitId);
    } catch (error) { notify(error instanceof Error ? error.message : '경로를 구성하지 못했습니다. 현재 연결을 확인하세요.'); }
  }
  function togglePresetGroup(groupId: string) {
    if (locked) return;
    const selected = chosenIds.includes(groupId) ? chosenIds.filter(id => id !== groupId) : chosenIds.length < 4 ? [...chosenIds, groupId] : chosenIds;
    setFirstGroup(selected[0] || ''); setSecondGroup(selected[1] || ''); setAdditionalGroups(selected.slice(2));
  }
  function conditionFields(value: FlowCondition, update: (patch: Partial<FlowCondition>) => void, selected = false) {
    const numeric = value.operator === 'length_gte' || value.operator === 'length_lte';
    const invalid = numeric ? !/^(?:0|[1-9]\d*)$/.test(value.value) || Number(value.value) > 40000 : value.value.length === 0;
    return <><label className="field">조건<select disabled={locked} value={value.operator} onChange={event => update({ operator: event.target.value as FlowCondition['operator'], value: '' })}>{conditionOptions.map(([operator, title]) => <option key={operator} value={operator}>{title}</option>)}</select></label><label className="field">{numeric ? '기준 글자 수' : '검사할 문구'}<input disabled={locked} data-field-key={selected ? 'condition.value' : undefined} aria-invalid={invalid || undefined} inputMode={numeric ? 'numeric' : 'text'} maxLength={numeric ? 5 : 2000} value={value.value} onChange={event => update({ value: event.target.value })} placeholder={numeric ? '0~40000' : '포함 여부를 확인할 문구'} />{invalid && <small className="wg-field-error">{numeric ? '0~40,000의 정수를 입력하세요. 앞자리 0이나 소수는 사용할 수 없습니다.' : '포함 여부를 검사할 문구를 입력하세요.'}</small>}</label>{!numeric && <label className="we-inline-check"><input type="checkbox" disabled={locked} checked={value.caseSensitive === true} onChange={event => update({ caseSensitive: event.target.checked })} />대소문자 구분</label>}</>;
  }
  function problemCards(problems:FlowConnectionProblem[]) {
    return <ul className="wg-repair-list">{[...new Set(problems.map(problem=>problem.endpoint))].map(endpoint=>{
      const items=problems.filter(problem=>problem.endpoint===endpoint);
      return <li key={endpoint}><button type="button" className="wg-repair-jump" disabled={!onFocusEndpoint} onClick={()=>onFocusEndpoint?.(stage,endpoint)}>{label(endpoint)}<span>노드 위치 보기</span></button><p>{items.map(problem=>problem.message).join(' ')}</p><small>{[...new Set(items.map(problem=>problem.suggestion))].join(' ')}</small>{items.some(problem=>problem.introduced)&&<em>이번 변경으로 확인 필요</em>}</li>;
    })}</ul>;
  }
  function renderEdgeForm() { return (<div className="wg-edge-form" ref={edgeFields}><strong>{edge ? '선택한 연결선 수정' : '연결선 추가'}</strong>{edge && <p className="we-fine">도착 노드를 선택하면 변경 내용을 확인한 뒤 적용합니다.</p>}<label className="field">출발<select disabled={locked || Boolean(edge)} value={from} onChange={event => { setFrom(event.target.value); setPort(graph.nodes.find(node => `control:${node.id}` === event.target.value)?.kind === 'condition' ? 'true' : 'next'); }}>{endpoints.filter(item => item !== 'end').map(item => <option key={item} value={item}>{label(item)}</option>)}</select></label><label className="field">경로<select disabled={locked || Boolean(edge) || !conditionSource} value={conditionSource ? port === 'next' ? 'true' : port : 'next'} onChange={event => setPort(event.target.value as 'next' | 'true' | 'false')}>{conditionSource ? <><option value="true">조건 충족</option><option value="false">그 외</option></> : <option value="next">다음</option>}</select></label><label className="field">도착<select disabled={locked} value={to} onChange={event => setTo(event.target.value)}>{endpoints.filter(item => item !== 'start' && item !== from).map(item => <option key={item} value={item}>{label(item)}</option>)}</select></label><div className="we-row"><button className="btn small primary" disabled={locked} onClick={saveEdge}>{edge ? '변경 내용 확인' : '연결선 추가'}</button>{edge && <button className="btn small danger" disabled={locked} onClick={reviewEdgeDeletion}><Trash2 size={13} />삭제</button>}<button className="btn small" onClick={() => { setAdvancedOpen(true); onSelectEdge(undefined); setFrom('start'); setTo('end'); setPort('next'); }}>새 연결</button></div></div>); }
  return <div className="wg-settings"><div className="wg-stage-tabs">{(['pre', 'post'] as const).map(item => <button key={item} className={stage === item ? 'active' : ''} onClick={() => onStageChange(item)}>{item === 'pre' ? '요청 검사' : '응답 검사'}</button>)}</div>
    {control && <section className="wg-control-fields" data-control-id={control?.id} ref={controlFields}><p className="we-fine">{control.kind === 'condition' ? `조건은 ${stage === 'pre' ? '모든 메시지의 내용을 합친 요청 텍스트' : '이번에 생성한 모델 응답'}를 검사합니다. 충족하는 경로 하나만 실행합니다.` : control.kind === 'fork' ? '연결된 2~4개 경로를 동시에 실행합니다. 각 경로를 결과 합류로 이어 주세요.' : '선택된 경로의 실행이 모두 끝나면 다음 단계로 이어갑니다. 조건에서 선택되지 않은 경로는 실행을 기다리지 않습니다.'}</p><label className="field">제어 노드 이름<input maxLength={100} disabled={locked} value={control.name} onChange={event => updateControl({ name: event.target.value })} /></label><label className="field">종류<select disabled={locked} value={control.kind} onChange={event => { const kind = event.target.value as FlowControlNode['kind']; updateControl({ kind, condition: kind === 'condition' ? { operator: 'contains', value: '', caseSensitive: false } : undefined }); }}>{Object.entries(names).map(([kind,name]) => <option key={kind} value={kind}>{name}</option>)}</select></label>{control.kind === 'condition' && conditionFields(control.condition || { operator:'contains',value:'' }, patch => updateControl({ condition: { ...(control.condition || { operator:'contains',value:'' }), ...patch } }), true)}{!nodeActionsRef&&<button className="btn small danger" disabled={locked} onClick={deleteControl}><Trash2 size={13} />제어 노드 삭제</button>}</section>}
    {control && <section className="wg-selected-connections" aria-label="선택한 제어 노드 연결"><strong>다음 연결</strong>{(control.kind==='condition'?['true','false'] as const:['next'] as const).map(selectedPort=>{const outgoing=graph.edges.filter(item=>item.from===`control:${control.id}`&&(item.port||'next')===selectedPort);return <div key={selectedPort}><small>{portLabel(selectedPort)}</small>{outgoing.length?outgoing.map(item=><button type="button" className="wg-selected-edge" key={item.id} onClick={()=>onSelectEdge(item.id)}><span>{label(item.to)}</span><ArrowRight size={12}/><span>연결 수정</span></button>):<span className="wg-missing-connection">연결이 없습니다.</span>}<button type="button" className="btn small" disabled={locked} onClick={()=>{setFrom(`control:${control.id}`);setPort(selectedPort);setTo('end');setEditingConnection(true);requestAnimationFrame(()=>edgeFields.current?.scrollIntoView({block:'nearest'}));}}><Plus size={12}/>{outgoing.length?'다른 노드 연결':'연결 추가'}</button></div>;})}</section>}
    {(edge||editingConnection)&&renderEdgeForm()}
    {edgeReview && <section className="wg-connection-review" ref={reviewFields} aria-label="연결 변경 확인" aria-live="polite"><strong>연결 변경 확인</strong><p>다음 연결을 바꾸면 실행 경로가 달라집니다.</p><div className="wg-review-path"><span>변경 전</span>{edgeReview.before.length === 0 && <div>연결 없음</div>}{edgeReview.before.map(item => <div key={item.id}>{label(item.from)} <small>{portLabel(item.port)}</small><ArrowRight size={12} />{label(item.to)}</div>)}</div><div className="wg-review-path"><span>변경 후</span>{edgeReview.after?<div>{label(edgeReview.after.from)} <small>{portLabel(edgeReview.after.port)}</small><ArrowRight size={12} />{label(edgeReview.after.to)}</div>:<div>선택한 연결을 제거합니다.</div>}</div>{edgeReview.impact.problems.length>0&&<section className="wg-impact-problems"><strong>연결을 확인할 노드</strong>{problemCards(edgeReview.impact.problems)}</section>}{edgeReview.warnings.length > 0 && <ul>{edgeReview.warnings.map(message => <li key={message}>{message}</li>)}</ul>}{edgeReview.validationMessages.length > 0 && <div className="wg-review-issues"><strong>적용 후 확인할 설정</strong><ul>{edgeReview.validationMessages.map(message => <li key={message}>{message}</li>)}</ul></div>}{edgeReview.signature !== reviewSignature && <p className="wg-review-stale">연결 설정이 변경되었습니다. 변경 내용을 다시 확인하세요.</p>}<div className="we-row"><button className="btn small" onClick={() => setEdgeReview(undefined)}>취소</button><button className="btn small primary" disabled={locked || edgeReview.signature !== reviewSignature} onClick={() => applyReviewedConnection(edgeReview)}>{!edgeReview.after?'연결 제거 적용':edgeReview.before.length ? '연결 변경 적용' : '연결 적용'}</button></div></section>}
    {errors.length > 0 && <div className="wg-errors" role="status"><strong>연결 설정 {errors.length}개 확인 필요</strong><ul>{errors.map(message => <li key={message}>{message}</li>)}</ul><p>검증과 배포를 하려면 연결을 완성하세요. 아래 노드를 선택하면 해당 위치로 이동합니다.</p>{problemCards(repairProblems)}</div>}
    <details className="wg-advanced" open={advancedOpen} onToggle={event=>setAdvancedOpen(event.currentTarget.open)}><summary>전체 경로와 연결 설정</summary><div>
    <p className="we-fine">{stage === 'pre' ? '최초 입력에서 응답 생성 모델까지' : '응답 생성 모델에서 최종 출력까지'}의 연결을 설정합니다. 각 분기는 결과 합류 노드에서 다시 연결합니다.</p>
    <div className="we-section-title" ref={presetFields}>경로 구성</div><p className="we-fine">바로 이어진 검사 2~4개를 동시에 실행하거나, 두 검사를 조건별 경로로 나눕니다. 분기와 결과 합류를 함께 만듭니다.</p>
    <label className="field">구성 방식<select disabled={locked} value={presetKind} onChange={event => { setPresetKind(event.target.value as 'parallel' | 'condition'); if (event.target.value === 'condition') setAdditionalGroups([]); }}><option value="parallel">검사 2~4개를 동시에 실행</option><option value="condition">조건에 따라 한 검사 실행</option></select></label>
    {presetKind === 'parallel' ? <fieldset className="wg-preset-groups"><legend>검사 노드 선택 ({chosenIds.length}/4)</legend><div>{workflow[stage].map(group => <label key={group.id} className={chosenIds.includes(group.id) ? 'checked' : ''}><input type="checkbox" checked={chosenIds.includes(group.id)} disabled={locked || (!chosenIds.includes(group.id) && (chosenIds.length >= 4 || group.required === true))} onChange={() => togglePresetGroup(group.id)} /><span>{groupLabel(group)}{group.required && <small>필수 실행</small>}</span></label>)}</div><p>같은 구간에서 바로 이어진 검사를 선택하세요. 선택 순서는 실행 경로에 맞춰 정리합니다.</p></fieldset> : <><label className="field">검사 노드 하나<select disabled={locked} value={firstGroup} onChange={event => setFirstGroup(event.target.value)}><option value="">검사 노드 선택</option>{workflow[stage].map(group => <option key={group.id} value={group.id}>{groupLabel(group)}{group.required ? ' (필수 실행)' : ''}</option>)}</select></label><label className="field">다른 검사 노드<select disabled={locked} value={secondGroup} onChange={event => setSecondGroup(event.target.value)}><option value="">검사 노드 선택</option>{workflow[stage].filter(group => group.id !== firstGroup).map(group => <option key={group.id} value={group.id}>{groupLabel(group)}{group.required ? ' (필수 실행)' : ''}</option>)}</select></label></>}
    {branchPreview.valid ? <div className="wg-preset-preview" role="status"><strong>{presetKind === 'parallel' ? `검사 ${branchPreview.groupIds.length}개를 동시에 실행합니다` : '조건별 실행 경로'}</strong>{presetKind === 'parallel' ? <ol>{branchPreview.groupIds.map(id => <li key={id}>{label(`group:${id}`)}</li>)}</ol> : <dl><dt>조건 충족</dt><dd>{label(`group:${branchPreview.groupIds[0]}`)}</dd><dt>그 외</dt><dd>{label(`group:${branchPreview.groupIds[1]}`)}</dd></dl>}<p>앞뒤 연결은 유지하고 결과 합류 후 다음 노드로 이어집니다.</p></div> : <p className="wg-preset-reason" role="status">{branchPreview.reason}</p>}
    {presetKind === 'condition' && <><p className="we-fine">현재 실행 순서에서 앞선 검사를 조건 충족 경로에, 다음 검사를 그 외 경로에 둡니다. {stage === 'pre' ? '모든 메시지의 내용을 합친 요청 텍스트' : '현재 모델 응답'}를 검사합니다.</p>{conditionFields(condition, patch => setCondition(current => ({ ...current, ...patch })))}</>}
    <button className="btn small wg-wide" disabled={locked || !branchPreview.valid || (presetKind === 'condition' && !validCondition)} onClick={preset}><Split size={14} />{presetKind === 'condition' ? '조건 분기 구성' : `검사 ${chosenIds.length}개 병렬 구성`}</button>
    {presetKind === 'condition' && branchPreview.valid && !validCondition && <p className="wg-preset-reason" role="status">조건 값을 입력하면 경로를 구성할 수 있습니다.</p>}
    <div className="we-section-title">제어 노드 ({graph.nodes.length}/12)</div>{onAddNode&&<button type="button" className="btn small" disabled={locked} onClick={onAddNode}><Plus size={12}/>노드 추가</button>}<p className="we-fine">모든 종류의 노드는 노드 추가에서 선택합니다. 추가한 노드의 입력과 출력을 연결하세요.</p>
    <div className="wg-controls">{graph.nodes.map(node => <button key={node.id} className={node.id === selectedControlId ? 'selected' : ''} onClick={() => onSelectControl(node.id)}>{node.kind === 'condition' ? <GitBranch size={14} /> : node.kind === 'fork' ? <Split size={14} /> : <GitMerge size={14} />}<span>{node.name}</span></button>)}</div>
    <div className="we-section-title">연결선 ({graph.edges.length}/64)</div><div className="wg-edges">{graph.edges.map(item => <button key={item.id} className={item.id === selectedEdgeId ? 'selected' : ''} onClick={() => onSelectEdge(item.id)}><span>{label(item.from)}<small>{portLabel(item.port)}</small><ArrowRight size={12} />{label(item.to)}</span></button>)}</div>
    {!edge&&!editingConnection&&renderEdgeForm()}
    </div></details>
  </div>;
}
