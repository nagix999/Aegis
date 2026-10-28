'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ArrowRight, Braces, ChevronDown, FileCheck2, FlaskConical, GitBranch, Loader2, Plus, Save, Search, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import type { PolicyDefinition, PolicyRevision } from '@/lib/aegis-types';
import { policyDefinitionErrors, policyOutputSchema } from '@/lib/policy-routing';
import { checkPolicyServerCompatibility } from '@/lib/policy-server-compatibility';
import { policyExampleIssues } from '@/lib/policy-schema-guidance';
import { convertLegacyPolicy, createStructuredPolicy, editablePolicy, policyEditorBuffers, policyEditorSignature, policySchemaOutline, preparePolicyDraft, readPolicySchemaBuffer, type PolicyEditorBuffers } from './policy-editor-model';
import { PolicySchemaBuilder } from './policy-schema-builder';
import { scaffoldPolicyExample } from './policy-example-scaffold';
import { PolicyFieldAssertions } from './policy-field-assertions';
import { Empty, PageHeading, Tag, timeLabel, type PageProps, type PolicyTest } from './console-ui';
import './policies.css';

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export function PoliciesPage({ state, act, notify, loading, busy, onOpenWorkflowPolicy, initialPolicyId, initialPolicyVersion, requestId, onSelectionChange }: PageProps & { loading: boolean; busy: boolean; onOpenWorkflowPolicy?:(workflowId:string)=>void; initialPolicyId?:string; initialPolicyVersion?:number; requestId?:string; onSelectionChange?:(policyId:string,version:number)=>void }) {
  const revisions = state.policies ?? [];
  const latest = [...new Map([...revisions].sort((a, b) => a.version - b.version).map(policy => [policy.id, policy])).values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const [query, setQuery] = useState('');
  const [archiveFilter, setArchiveFilter] = useState('active');
  const [draft, setDraft] = useState<PolicyDefinition>();
  const [baseline, setBaseline] = useState('');
  const [buffers, setBuffers] = useState<PolicyEditorBuffers>({schema:'', examples:{}});
  const [schemaMode, setSchemaMode] = useState<'builder'|'json'>('builder');
  const [scaffoldOpen, setScaffoldOpen] = useState(false);
  const [scaffoldReviewed, setScaffoldReviewed] = useState(false);
  const editorRef = useRef<HTMLElement>(null);
  const schemaTabsId = useId();
  const schemaBuffer = useMemo(() => readPolicySchemaBuffer(buffers.schema), [buffers.schema]);
  const [baseVersion, setBaseVersion] = useState(0);
  const [viewVersion, setViewVersion] = useState(0);
  const [forking, setForking] = useState(false);
  const [historicalView, setHistoricalView] = useState(false);
  const [pending, setPending] = useState<{ kind: 'new' } | { kind: 'open'; revision: PolicyRevision }>();
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const archiveDialog = useRef<HTMLDialogElement>(null);
  const [localAction, setLocalAction] = useState('');
  const [error, setError] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [test, setTest] = useState<PolicyTest>();
  const [testedSignature, setTestedSignature] = useState('');
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const handledOpenRequest=useRef<string|undefined>(undefined);
  const selectedLatest = latest.find(policy => policy.id === draft?.id);
  const archived = Boolean(draft && state.lifecycle?.policies?.[draft.id]?.archived);
  const capacity = state.policyCapacity;
  const boundWorkflows = draft ? state.workflows.filter(workflow => workflow.policyRouting?.policy.id === draft.id) : [];
  const boundDeployments = draft ? state.deployments.filter(deployment => deployment.workflow.policyRouting?.policy.id === draft.id) : [];
  const historical = historicalView && !forking;
  const available = state.policies !== undefined;
  const writable = state.role === 'admin' || state.role === 'editor';
  const locked = loading || busy || Boolean(localAction);
  const canEdit = writable && available && !locked && !historical && !archived;
  const draftSignature = draft ? policyEditorSignature(draft, buffers) : '';
  const dirty = Boolean(draft && draftSignature !== baseline);
  const structured = draft?.formatVersion === 2;
  const prepared = useMemo(() => draft ? preparePolicyDraft(draft, buffers) : undefined, [draft, buffers]);
  const exampleIssues=useMemo(()=>prepared?.value.formatVersion===2?policyExampleIssues(prepared.value.outputSchema??{},prepared.value.examples):[],[prepared]);
  const outline = useMemo(() => prepared && !prepared.errors.length && structured ? policySchemaOutline(prepared.value.outputSchema ?? {}) : [], [prepared, structured]);
  const conflict = Boolean(draft && selectedLatest && baseVersion !== selectedLatest.version && !historical);
  const selectedConnection = state.connections.find(connection => connection.id === draft?.connectionId);
  const errors = prepared ? [...prepared.errors,...exampleIssues.map(issue=>`예제 ${issue.exampleIndex+1} ${issue.path||'(전체 출력)'}: ${issue.message}`), ...(prepared.errors.length ? [] : policyDefinitionErrors(prepared.value)), ...(!historical && !selectedConnection ? ['정책 검사 모델을 현재 모델 목록에서 선택하세요.'] : [])] : [];
  const viewingRevision = revisions.find(policy => policy.id === draft?.id && policy.version === viewVersion);
  const modelChanged = Boolean(viewingRevision && selectedConnection && JSON.stringify({ ...viewingRevision.connectionSnapshot, name: '' }) !== JSON.stringify({ ...selectedConnection, name: '' }));
  const testSignature = draft ? `${draftSignature}:${JSON.stringify(selectedConnection)}` : '';
  const testStale = Boolean(test && testedSignature !== testSignature);
  const scaffoldSignature = JSON.stringify([buffers.schema, buffers.examples]);
  useEffect(() => { setScaffoldReviewed(false); }, [scaffoldSignature]);
  const scaffolds = useMemo(() => scaffoldOpen && schemaBuffer.schema && draft?.formatVersion === 2 ? draft.examples.map((example, index) => ({id:example.id, index, ...scaffoldPolicyExample(schemaBuffer.schema!, buffers.examples[example.id] ?? '')})) : [], [scaffoldOpen, schemaBuffer.schema, draft, buffers.examples]);
  const scaffoldChanges = scaffolds.filter(item => item.added.length && !item.error);
  const jumpSection = (section: string) => { const element = editorRef.current?.querySelector<HTMLElement>(`[data-policy-section="${section}"]`); element?.scrollIntoView({block:'start',behavior:'auto'}); element?.focus({preventScroll:true}); };
  const filtered = latest.filter(policy => (archiveFilter === 'all' || Boolean(state.lifecycle?.policies?.[policy.id]?.archived) === (archiveFilter === 'archived')) && `${policy.name} ${policy.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (pending) confirmDialog.current?.showModal();
    else confirmDialog.current?.close();
  }, [pending]);
  useEffect(() => { if (archiveConfirm) archiveDialog.current?.showModal(); else archiveDialog.current?.close(); }, [archiveConfirm]);

  const reset = () => { setArchiveConfirm(false); setScaffoldOpen(false); setScaffoldReviewed(false); setError(''); setShowErrors(false); setTest(undefined); setTestedSignature(''); setForking(false); };
  const install = (value: PolicyDefinition) => { const nextBuffers = policyEditorBuffers(value); setDraft(value); setBuffers(nextBuffers); setBaseline(policyEditorSignature(value, nextBuffers)); };
  const open = (revision: PolicyRevision) => {
    setSchemaMode('builder');
    setArchiveFilter(current => current === 'all' ? current : state.lifecycle?.policies?.[revision.id]?.archived ? 'archived' : 'active');
    const value = editablePolicy(revision);
    install(value); setViewVersion(revision.version);
    setHistoricalView(revision.version < (latest.find(policy => policy.id === revision.id)?.version ?? revision.version));
    setBaseVersion(latest.find(policy => policy.id === revision.id)?.version ?? revision.version); reset(); onSelectionChange?.(revision.id,revision.version);
  };
  const create = () => {
    setSchemaMode('builder');
    setArchiveFilter('active');
    const value = createStructuredPolicy(state.connections.find(connection => connection.role !== 'main')?.id ?? '', newId);
    install(value); setBaseVersion(0); setViewVersion(0); setHistoricalView(false); reset();
  };
  const request = (next: NonNullable<typeof pending>) => {
    if (locked) return;
    if (dirty) setPending(next);
    else if (next.kind === 'new') create(); else open(next.revision);
  };
  useEffect(()=>{
    if(!requestId||!initialPolicyId||locked||handledOpenRequest.current===requestId)return;
    const revision=initialPolicyVersion?revisions.find(policy=>policy.id===initialPolicyId&&policy.version===initialPolicyVersion):latest.find(policy=>policy.id===initialPolicyId);
    if(!revision)return;
    handledOpenRequest.current=requestId;request({kind:'open',revision});
  },[requestId,initialPolicyId,initialPolicyVersion,revisions,locked]);
  const patch = (next: Partial<PolicyDefinition>) => { if (draft && canEdit) setDraft({ ...draft, ...next }); };
  const save = async () => {
    if (!draft || !prepared || !canEdit) return;
    setShowErrors(true); setError('');
    if (errors.length) return;
    setLocalAction('save');
    try {
      if (prepared.value.formatVersion === 2) {
        const server = await checkPolicyServerCompatibility();
        if (!server.compatible) { setError(server.message); return; }
      }
      const reply = await act({ action: 'save_policy', policy: prepared.value, expectedVersion: baseVersion });
      if (!reply) { setError('정책을 저장하지 못했습니다. 알림과 현재 서버 버전을 확인하세요.'); return; }
      const saved = reply.policy ?? reply.state.policies?.filter(policy => policy.id === draft.id).sort((a, b) => b.version - a.version)[0];
      if (!saved) { setError('저장 응답에서 정책 버전을 확인하지 못했습니다. Python 서버를 다시 실행하세요.'); return; }
      const value = editablePolicy(saved);
      install(value); setViewVersion(saved.version); setBaseVersion(saved.version); setForking(false); setHistoricalView(false); onSelectionChange?.(saved.id,saved.version);
      notify(`${saved.name} v${saved.version}을 저장했습니다. 기존 워크플로우의 정책 버전은 유지됩니다.`);
    } finally { setLocalAction(''); }
  };
  const runTest = async () => {
    if (!draft || !prepared || !canEdit || !selectedConnection) return;
    setShowErrors(true); setError('');
    if (errors.length) return;
    const tested = testSignature;
    setLocalAction('test');
    try {
      if (prepared.value.formatVersion === 2) {
        const server = await checkPolicyServerCompatibility();
        if (!server.compatible) { setError(server.message); return; }
      }
      setTest(undefined);
      const reply = await act({ action: 'test_policy', policy: prepared.value });
      if (reply?.policyTest) { setTest(reply.policyTest); setTestedSignature(tested); }
      else setError('정책 예제 테스트를 완료하지 못했습니다. 모델 설정과 알림을 확인하세요.');
    } finally { setLocalAction(''); }
  };
  const archivePolicy = async () => {
    if (!draft || state.role !== 'admin' || locked || dirty) return;
    setLocalAction('archive'); setError('');
    try {
      const response = await act({action:'set_policy_archived',policyId:draft.id,archived:!archived,expectedUpdatedAt:state.lifecycle?.policies?.[draft.id]?.updatedAt ?? null});
      if (!response) { setError('정책 상태를 변경하지 못했습니다. 현재 입력과 기존 버전은 유지됩니다.'); return; }
      setArchiveConfirm(false); setArchiveFilter(archived ? 'active' : 'archived');
      notify(archived ? '정책을 복원했습니다.' : '정책을 보관했습니다. 연결된 워크플로우와 기존 배포는 그대로 실행됩니다.');
    } finally { setLocalAction(''); }
  };

  return <div className="policies-page">
    <PageHeading title="정책 관리" description="프롬프트, 출력 스키마와 예제를 정책 버전 하나로 관리합니다.">
      {writable && <button className="btn small primary" disabled={locked || !available || latest.length >= (capacity?.maxFamilies ?? 30) || Boolean(capacity && capacity.versions >= capacity.maxVersions)} onClick={() => request({ kind: 'new' })}><Plus size={14}/> 정책 추가</button>}
    </PageHeading>
    {!loading && !available && <div className="policy-alert" role="alert"><TriangleAlert size={16}/> 정책 관리 API를 사용할 수 없습니다. Python 서버를 다시 실행하세요.</div>}
    <div className="policy-workspace">
      <aside className="policy-list" aria-label="저장된 정책 목록"><label className="policy-search"><Search size={14}/><input aria-label="정책 검색" placeholder="정책 검색" value={query} onChange={event => setQuery(event.target.value)}/></label><label className="policy-status-filter">상태<select aria-label="정책 보관 상태 필터" value={archiveFilter} onChange={event => setArchiveFilter(event.target.value)}><option value="active">사용 중</option><option value="archived">보관됨</option><option value="all">전체</option></select></label><div className="policy-list-count">정책 {capacity?.families ?? latest.length}/{capacity?.maxFamilies ?? 30}{capacity && <> / 전체 버전 {capacity.versions}/{capacity.maxVersions}</>}</div>{capacity && capacity.versions >= capacity.maxVersions && <p className="policy-capacity-warning" role="status">정책 버전 저장 한도에 도달했습니다. 보관은 버전을 삭제하지 않습니다. 서버의 정책 버전 한도를 확인하세요.</p>}
        {filtered.map(policy => <button key={policy.id} className={`policy-list-item ${policy.id === draft?.id ? 'active' : ''}`} aria-label={`${policy.name} 정책 열기`} aria-pressed={policy.id === draft?.id} disabled={locked} onClick={() => request({ kind: 'open', revision: policy })}><ShieldCheck size={16}/><span><strong>{policy.name}</strong><small>{state.lifecycle?.policies?.[policy.id]?.archived ? '보관됨 / ' : ''}{policy.formatVersion === 2 ? '자유 출력 스키마' : `${policy.decisions.length}개 판정`} / 최신 v{policy.version}</small></span><ArrowRight size={13}/></button>)}
        {!filtered.length && <p className="policy-muted">{loading ? '정책을 불러오고 있습니다.' : query ? '검색 결과가 없습니다.' : '저장된 정책이 없습니다.'}</p>}
      </aside>
      {draft ? <section className="policy-editor" aria-label="정책 편집" ref={editorRef}><header className="policy-editor-heading"><div><ShieldCheck size={19}/><h2>{draft.name || '새 정책'}</h2><Tag>{viewVersion ? `v${viewVersion}` : '새 초안'}</Tag><Tag>{structured ? '자유 출력 형식' : '기존 판정 형식'}</Tag>{dirty && <Tag tone="warning">저장 전 변경</Tag>}</div>
        {viewVersion > 0 && <label>저장 버전<select aria-label="정책 버전" disabled={locked} value={viewVersion} onChange={event => { const revision = revisions.find(policy => policy.id === draft.id && policy.version === Number(event.target.value)); if (revision) request({ kind: 'open', revision }); }}>{revisions.filter(policy => policy.id === draft.id).sort((a, b) => b.version - a.version).map(policy => <option key={policy.version} value={policy.version}>v{policy.version}{policy.version === selectedLatest?.version ? ' (최신)' : ''}</option>)}</select></label>}
      </header>
      <div className="policy-actionbar" aria-label="정책 편집 작업">
        <div className="policy-actionbar-status" aria-live="polite"><strong>{archived ? '보관된 정책 조회' : historical ? '과거 버전 조회' : localAction === 'save' ? '저장 중…' : localAction === 'test' ? '예제 테스트 중…' : dirty ? '저장 전 변경 있음' : viewVersion ? '저장됨' : '새 초안'}</strong>{(error || errors.length > 0) && <button type="button" onClick={() => { setShowErrors(true); jumpSection('errors'); }}>{error ? '처리 오류 확인' : `입력 확인 ${errors.length}건`}</button>}{test && <button type="button" onClick={() => jumpSection('results')}>{testStale ? '설정 변경 전 테스트 결과' : '테스트 결과 보기'}</button>}</div>
        <div className="policy-actionbar-buttons">{state.role === 'admin' && viewVersion > 0 && <button className="btn small" disabled={locked || dirty} title={dirty ? '변경한 내용을 저장하거나 버린 뒤 상태를 변경하세요.' : archived ? '정책을 편집 가능한 사용 중 목록으로 복원합니다.' : '기존 버전과 실행을 유지하고 보관 목록으로 옮깁니다.'} onClick={() => setArchiveConfirm(true)}>{archived ? <ArchiveRestore size={14}/> : <Archive size={14}/>} {archived ? '복원' : '보관'}</button>}<button className="btn small" disabled={!canEdit || !selectedConnection || Boolean(prepared?.errors.length) || exampleIssues.length > 0} onClick={() => void runTest()}>{localAction === 'test' ? <Loader2 className="spin" size={14}/> : <FlaskConical size={14}/>} 예제 테스트</button>{writable && !historical && <button className="btn small primary" disabled={!canEdit || conflict || Boolean(prepared?.errors.length) || exampleIssues.length > 0 || Boolean(viewVersion && !dirty && !forking && !modelChanged)} onClick={() => void save()}>{localAction === 'save' ? <Loader2 className="spin" size={14}/> : <Save size={14}/>} {viewVersion ? '새 버전 저장' : '정책 저장'}</button>}</div>
        <nav aria-label="정책 편집 섹션">{[{id:'settings',label:'기본 설정'},{id:'prompt',label:'지시문'},{id:'schema',label:'출력 스키마'},{id:'examples',label:`예제 ${draft.examples.length}개`}].map(section => <button type="button" key={section.id} onClick={() => jumpSection(section.id)}>{section.label}</button>)}</nav>
      </div>
      <p className="policy-muted">{viewingRevision ? `${timeLabel(viewingRevision.updatedAt)} 저장 / ${viewingRevision.connectionSnapshot.name} / ${viewingRevision.connectionSnapshot.model}` : '새 정책을 저장한 뒤 워크플로우 설정에서 연결할 수 있습니다.'}</p>
      <details className="policy-dependencies"><summary>연결된 워크플로우 {boundWorkflows.length}개 / 조회한 배포 {boundDeployments.length}개</summary>{boundWorkflows.length ? <ul>{boundWorkflows.map(workflow => <li key={workflow.id}>{onOpenWorkflowPolicy?<button type="button" className="btn small" onClick={()=>onOpenWorkflowPolicy(workflow.id)}>{workflow.name}<ArrowRight size={12}/></button>:<span>{workflow.name}</span>}<code>정책 v{workflow.policyRouting!.policy.version}</code></li>)}</ul> : <p>현재 연결된 워크플로우가 없습니다.</p>}{boundDeployments.length > 0 && <p>조회한 배포의 정책 버전: {[...new Set(boundDeployments.map(deployment => deployment.workflow.policyRouting!.policy.version))].sort((a,b) => a-b).map(version => `v${version}`).join(', ')}</p>}<p>정책을 수정해도 기존 워크플로우와 배포의 버전은 자동으로 바뀌지 않습니다.</p></details>
      {!structured && <div className="policy-info policy-legacy-notice"><GitBranch size={16}/><span>기존 정책의 판정 코드와 실행 방식은 유지됩니다. 복합 출력을 사용하려면 새 형식의 초안을 직접 만드세요.</span>{writable && <button className="btn small" disabled={locked || archived} onClick={() => { const converted = convertLegacyPolicy(draft, policyOutputSchema(draft)); setDraft(converted); setBuffers(policyEditorBuffers(converted)); setForking(true); setHistoricalView(false); setBaseVersion(selectedLatest?.version ?? viewVersion); setTest(undefined); setError(''); setShowErrors(false); }}>자유 스키마로 새 초안</button>}</div>}
      {structured && <p className="policy-format-help"><Braces size={15}/><span>필드 이름과 구조를 자유롭게 정의합니다. decision 필드는 필수가 아닙니다. 출력 값을 읽는 분기 조건, 검사와 실행 동작은 워크플로우에서 연결하세요.</span></p>}
      {archived && <div className="policy-info"><Archive size={16}/><span>보관된 정책입니다. 기존 워크플로우와 배포는 저장된 버전으로 계속 실행됩니다. 편집하려면 먼저 복원하세요.</span></div>}
      {historical && <div className="policy-info"><GitBranch size={16}/><span>저장된 과거 버전을 보고 있습니다.</span>{writable && <button className="btn small" disabled={locked || archived} onClick={() => { setForking(true); setBaseVersion(selectedLatest!.version); setTest(undefined); }}>이 버전으로 새 초안</button>}</div>}
      {conflict && <div className="policy-alert" role="alert"><TriangleAlert size={16}/><span>다른 화면에서 새 버전을 저장했습니다. 현재 입력은 유지됩니다.</span><button className="btn small" disabled={locked} onClick={() => request({ kind: 'open', revision: selectedLatest! })}>최신 버전 확인</button></div>}
      {modelChanged && !historical && <div className="policy-info"><TriangleAlert size={15}/> 현재 모델 설정이 저장 당시와 다릅니다. 새 버전 저장과 예제 테스트에는 현재 모델 설정을 사용합니다. 기존 배포는 저장된 설정을 사용합니다.</div>}
      <div data-policy-section="errors" tabIndex={-1} className="policy-error-anchor">{error && <div className="policy-alert" role="alert"><TriangleAlert size={16}/>{error}</div>}
      {showErrors && !!errors.length && <div className="policy-alert" role="alert"><TriangleAlert size={16}/><ul>{errors.slice(0, 6).map(message => <li key={message}>{message}</li>)}</ul></div>}</div>
      <fieldset disabled={!canEdit} className="policy-form" data-policy-section="settings" tabIndex={-1}><div className="policy-form-row"><label className="field">정책 이름<input aria-label="정책 이름" maxLength={100} value={draft.name} onChange={event => patch({ name: event.target.value })}/></label><label className="field">검사 모델<select aria-label="정책 검사 모델" value={draft.connectionId} onChange={event => patch({ connectionId: event.target.value })}><option value="">모델 선택</option>{draft.connectionId && !state.connections.some(connection => connection.id === draft.connectionId) && <option value={draft.connectionId}>현재 목록에 없는 모델</option>}{state.connections.filter(connection => connection.role !== 'main').map(connection => <option key={connection.id} value={connection.id}>{connection.name} / {connection.mode === 'demo' ? '예제' : connection.model}</option>)}</select></label></div>
        <label className="field">설명<input aria-label="정책 설명" maxLength={1000} value={draft.description} onChange={event => patch({ description: event.target.value })}/></label>
        <label className="field" data-policy-section="prompt" tabIndex={-1}>판정 지시문<textarea aria-label="정책 판정 지시문" rows={5} maxLength={4000} value={draft.prompt} onChange={event => patch({ prompt: event.target.value })}/><small>업무 기준과 예외를 작성하세요. {structured ? '아래 JSON Schema가 출력 형식으로 함께 전달됩니다.' : '판정 코드와 JSON 출력 형식은 아래 정의에서 자동으로 추가합니다.'}</small></label>
        {!structured && <section className="policy-decisions" aria-label="판정값 정의"><div className="policy-section-heading"><h3>판정값 정의</h3><button type="button" className="btn small" disabled={!canEdit || draft.decisions.length >= 12} onClick={() => patch({ decisions: [...draft.decisions, { code: '', label: '', description: '' }] })}><Plus size={13}/> 판정 추가</button></div>
          {draft.decisions.map((decision, index) => <div className="policy-decision" key={index}><div className="policy-form-row"><label className="field">판정 코드<input aria-label={`판정 코드 ${index + 1}`} className="mono" value={decision.code} maxLength={64} onChange={event => patch({ decisions: draft.decisions.map((item, i) => i === index ? { ...item, code: event.target.value } : item) })}/></label><label className="field">판정 이름<input aria-label={`판정 이름 ${index + 1}`} maxLength={80} value={decision.label} onChange={event => patch({ decisions: draft.decisions.map((item, i) => i === index ? { ...item, label: event.target.value } : item) })}/></label><button type="button" className="icon-button" aria-label={`판정 ${index + 1} 삭제`} disabled={!canEdit || draft.decisions.length <= 2} onClick={() => patch({ decisions: draft.decisions.filter((_, i) => i !== index) })}><Trash2 size={14}/></button></div><label className="field">판정 기준 설명<textarea aria-label={`판정 설명 ${index + 1}`} rows={2} maxLength={1000} value={decision.description} onChange={event => patch({ decisions: draft.decisions.map((item, i) => i === index ? { ...item, description: event.target.value } : item) })}/></label></div>)}
        </section>}
        {structured && <label className="field policy-token-budget">최대 출력 토큰<input aria-label="정책 최대 출력 토큰" type="number" min={256} max={4096} step={1} placeholder="기본 1,024" value={draft.maxOutputTokens ?? ''} onChange={event => patch({maxOutputTokens:event.target.value === '' ? undefined : Number(event.target.value)})}/><small>256~4,096 토큰. 복합 출력이 길면 예제 테스트로 잘림 여부를 확인하세요.</small></label>}
      </fieldset>
      {structured ? <section className="policy-schema-editor" aria-label="출력 스키마 편집" data-policy-section="schema" tabIndex={-1}>
        <div className="policy-section-heading"><h3><Braces size={15}/> 출력 스키마</h3></div>
        <p className="policy-schema-guidance">필드를 선택해 자료형과 조건을 설정하세요. 필수 필드나 자료형을 바꾸면 아래 예제의 예상 JSON도 맞춰 주세요.</p>
        <div className="policy-schema-tabs" role="tablist" aria-label="스키마 편집 방식">
          {([{id:'builder',label:'필드로 만들기'},{id:'json',label:'JSON 직접 편집'}] as const).map(mode=><button key={mode.id} type="button" role="tab" id={`${schemaTabsId}-${mode.id}`} aria-selected={schemaMode===mode.id} aria-controls={`${schemaTabsId}-panel`} tabIndex={schemaMode===mode.id?0:-1} onClick={()=>setSchemaMode(mode.id)} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const target=event.key==='Home'?'builder':event.key==='End'?'json':schemaMode==='builder'?'json':'builder';setSchemaMode(target);document.getElementById(`${schemaTabsId}-${target}`)?.focus();}}}>{mode.label}</button>)}
        </div>
        <div role="tabpanel" id={`${schemaTabsId}-panel`} aria-labelledby={`${schemaTabsId}-${schemaMode}`}>
          {schemaMode==='builder' ? schemaBuffer.schema ? <PolicySchemaBuilder key={`${draft.id}:${viewVersion}`} schema={schemaBuffer.schema} disabled={!canEdit} onChange={schema=>setBuffers(current=>({...current,schema:JSON.stringify(schema,null,2)}))} onEditJson={()=>setSchemaMode('json')}/> : <div className="policy-schema-unavailable" role="status"><p>{schemaBuffer.error}</p><p>JSON 입력을 유지하고 있습니다. 문법을 수정하면 필드 편집기를 다시 사용할 수 있습니다.</p><button type="button" className="btn small" onClick={()=>setSchemaMode('json')}>JSON에서 수정</button></div> : <>
            <div className="policy-schema-json-actions"><p>복합 조건과 참조는 JSON으로 편집할 수 있습니다. 두 편집기는 같은 스키마를 사용합니다.</p><button type="button" className="btn small" disabled={!canEdit || Boolean(schemaBuffer.error)} onClick={()=>{if(schemaBuffer.schema)setBuffers(current=>({...current,schema:JSON.stringify(schemaBuffer.schema,null,2)}));}}>JSON 정렬</button></div>
            <label className="field">JSON Schema<textarea aria-label="정책 출력 스키마 JSON" className="policy-json-editor" rows={16} maxLength={131072} spellCheck={false} disabled={!canEdit} value={buffers.schema} aria-invalid={Boolean(schemaBuffer.error)} onChange={event=>setBuffers({...buffers,schema:event.target.value})}/><small>스키마는 32KiB까지 저장합니다. 서버가 지원하는 JSON Schema 문법을 검사합니다.</small></label>
            {schemaBuffer.error&&<p className="policy-json-error" role="alert">{schemaBuffer.error}</p>}
            {!!outline.length&&<details className="policy-schema-outline"><summary>필드 구조 미리보기</summary><table><thead><tr><th>필드 경로</th><th>자료형</th><th>필수</th></tr></thead><tbody>{outline.map((field,index)=><tr key={`${field.path}-${index}`}><td><code>{field.path}</code>{field.detail&&<small>{field.detail}</small>}</td><td>{field.type}</td><td>{field.required?'필수':'선택'}</td></tr>)}</tbody></table><p>미리보기는 8단계, 최대 100개 항목까지 표시합니다.</p></details>}
          </>}
        </div>
      </section> : <details className="policy-schema" data-policy-section="schema" tabIndex={-1}><summary><Braces size={15}/> 생성된 출력 스키마 <ChevronDown size={13}/></summary><p>출력은 decision 필드 하나이며 등록된 판정 코드만 허용합니다. 형식 검증과 업무 판정의 정확성은 별도로 확인합니다.</p><pre>{JSON.stringify(policyOutputSchema(draft), null, 2)}</pre></details>}
      <section className="policy-examples" aria-label="정책 검증 예제" data-policy-section="examples" tabIndex={-1}><div className="policy-section-heading"><h3><FlaskConical size={15}/> 검증 예제</h3><button className="btn small" disabled={!canEdit || draft.examples.length >= 30} onClick={() => { const exampleId=newId('example'); patch({examples:[...draft.examples,{id:exampleId,input:'',...(structured?{expectedOutput:{}}:{expectedDecision:draft.decisions[0]?.code ?? ''})}]}); if(structured)setBuffers({...buffers,examples:{...buffers.examples,[exampleId]:'{}'}}); }}><Plus size={13}/> 예제 추가</button></div>
        <p className="policy-muted">{selectedConnection?.mode === 'demo' ? structured ? '예제 모드는 등록한 입력과 예상 JSON을 그대로 연결합니다. 모델을 호출하거나 지시문의 정확성을 평가하지 않습니다.' : '예제 모드는 등록한 입력과 예상 판정을 그대로 연결합니다. 모델을 호출하거나 판정 지시문의 정확성을 평가하지 않습니다.' : '검사 모델의 실제 판정을 예상값과 비교합니다. 이 결과는 워크플로우 배포에 필요한 데이터셋 검증을 대신하지 않습니다.'}</p>
        {structured && <div className="policy-scaffold"><button type="button" className="btn small" disabled={!canEdit || Boolean(schemaBuffer.error)} aria-expanded={scaffoldOpen} onClick={() => { setScaffoldOpen(value => !value); setScaffoldReviewed(false); }}>필수 필드 보완안</button>{scaffoldOpen && <div><p>기존 값은 유지하고 누락된 필수 필드만 빈 문자열, 0, false 등의 임시 값으로 제안합니다. 임시 값은 정답이 아닙니다. 허용값과 참조, 복합 조건은 직접 입력하세요.</p>{scaffolds.map(item => <details key={item.id}><summary>예제 {item.index + 1}: {item.error ? item.error : item.added.length ? `${item.added.length}개 필드 보완안` : '보완할 필드 없음'}{item.skipped.length > 0 ? ` / 직접 입력 ${item.skipped.length}개 경로` : ''}</summary>{item.added.length > 0 && <><p>추가할 경로: {item.added.join(', ')}</p><pre>{item.source}</pre></>}{item.skipped.length > 0 && <p>직접 확인할 경로: {item.skipped.join(', ')}</p>}</details>)}<label className="policy-scaffold-review"><input type="checkbox" checked={scaffoldReviewed} onChange={event => setScaffoldReviewed(event.target.checked)} disabled={!canEdit || !scaffoldChanges.length}/> 보완안을 검토했습니다. 적용 후 업무에 맞는 예상값으로 수정하겠습니다.</label><button type="button" className="btn small" disabled={!canEdit || !scaffoldReviewed || !scaffoldChanges.length} onClick={() => { setBuffers(current => ({...current,examples:{...current.examples,...Object.fromEntries(scaffoldChanges.map(item => [item.id,item.source]))}})); setScaffoldReviewed(false); setScaffoldOpen(false); }}>보완안 {scaffoldChanges.length}개 예제에 적용</button></div>}</div>}
        {draft.examples.map((example, index) => <div className={`policy-example ${structured ? 'is-structured' : ''}`} data-policy-example-id={example.id} data-policy-example-index={index} key={example.id}><label className="field">예제 요청 {index + 1}<textarea aria-label={`정책 예제 요청 ${index + 1}`} rows={2} maxLength={16000} disabled={!canEdit} value={example.input} onChange={event => patch({ examples: draft.examples.map(item => item.id === example.id ? { ...item, input: event.target.value } : item) })}/></label>{structured ? <label className="field policy-example-output">예상 JSON<textarea aria-label={`정책 예제 예상 JSON ${index + 1}`} className="policy-json-editor" rows={7} maxLength={131072} spellCheck={false} disabled={!canEdit} value={buffers.examples[example.id] ?? ''} aria-invalid={Boolean(prepared?.errors.some(message => message.startsWith(`${index + 1}번 예제`)))||exampleIssues.some(issue=>issue.exampleId===example.id)} onChange={event => setBuffers({...buffers,examples:{...buffers.examples,[example.id]:event.target.value}})}/><small>스키마에 맞는 JSON을 입력하세요. 전체 일치, 스키마 또는 선택 필드 비교를 아래에서 고를 수 있습니다. 예제 모델은 이 값을 출력합니다.</small>{prepared?.errors.filter(message=>message.startsWith(`${index+1}번 예제`)).map(message=><span className="policy-json-error" role="alert" key={message}>{message}</span>)}{exampleIssues.filter(issue=>issue.exampleId===example.id).slice(0,10).map((issue,issueIndex)=><span className="policy-json-error" data-policy-field-path={issue.path} role="alert" key={`${issue.path}-${issueIndex}`}>예제 {index+1} <code>{issue.path||'(전체 출력)'}</code>: {issue.message}</span>)}</label> : <label className="field">예상 판정<select aria-label={`정책 예제 예상 판정 ${index + 1}`} disabled={!canEdit} value={example.expectedDecision} onChange={event => patch({ examples: draft.examples.map(item => item.id === example.id ? { ...item, expectedDecision: event.target.value } : item) })}>{!draft.decisions.some(decision => decision.code === example.expectedDecision) && <option value={example.expectedDecision}>삭제되거나 변경된 판정</option>}{draft.decisions.map((decision, i) => <option key={i} value={decision.code}>{decision.label || decision.code}</option>)}</select></label>}<button className="icon-button" aria-label={`정책 예제 ${index + 1} 삭제`} disabled={!canEdit || draft.examples.length <= 1} onClick={() => patch({ examples: draft.examples.filter(item => item.id !== example.id) })}><Trash2 size={14}/></button>{structured && <div className="policy-example-comparison"><label className="field">출력 비교 방식<select aria-label={`정책 예제 ${index+1} 출력 비교 방식`} disabled={!canEdit} value={example.expectation?.mode ?? 'exact'} onChange={event=>{const mode=event.target.value as 'exact'|'schema'|'fields';patch({examples:draft.examples.map(item=>item.id===example.id?{...item,expectation:mode==='fields'?{mode,fields:[{path:'',operator:'eq',value:''}]}:{mode}}:item)});setBuffers(current=>({...current,fieldValues:{...current.fieldValues,[example.id]:{}}}));}}><option value="exact">전체 JSON 일치</option><option value="schema">스키마 통과만 확인</option><option value="fields">선택 필드 조건 비교</option></select></label>{example.expectation?.mode==='fields' && <PolicyFieldAssertions label={`정책 예제 ${index+1}`} values={example.expectation.fields??[]} drafts={buffers.fieldValues?.[example.id]??{}} schema={schemaBuffer.schema} disabled={!canEdit} onChange={fields=>patch({examples:draft.examples.map(item=>item.id===example.id?{...item,expectation:{mode:'fields',fields}}:item)})} onDraftsChange={values=>setBuffers(current=>({...current,fieldValues:{...current.fieldValues,[example.id]:values}}))}/>}<p>{example.expectation?.mode==='schema'?'모델 출력이 등록한 스키마를 통과하면 일치입니다. 위 JSON은 예제 모델의 출력으로만 사용합니다.':example.expectation?.mode==='fields'?'위 JSON은 예제 모델의 출력입니다. 실제 모델 테스트는 선택한 필드 조건만 비교하며 다른 값은 달라도 됩니다.':'객체의 키 순서를 제외한 전체 값을 비교합니다. 자유로운 설명 문구도 동일해야 합니다.'}</p></div>}</div>)}

        {test && <div data-policy-section="results" tabIndex={-1} className={`policy-test-results ${testStale ? 'is-stale' : ''}`} role="status"><strong><FileCheck2 size={15}/> {test.mode === 'demo' ? '예제 연결 확인' : structured ? '출력 형식과 예제 비교 결과' : '판정 비교 결과'}{testStale ? ' / 설정 변경 전 결과' : ''}</strong>{test.results.map(result => <div key={result.exampleId}><Tag tone={result.status === 'pass' ? 'success' : result.status === 'error' ? 'error' : 'warning'}>{result.status === 'pass' ? '일치' : result.status === 'error' ? '오류' : '불일치'}</Tag><span>예제 {draft.examples.findIndex(example => example.id === result.exampleId) + 1}</span>{structured ? <><small>스키마 {result.schemaValid === undefined ? '확인 불가' : result.schemaValid ? '통과' : '실패'}</small>{result.expectationMatched !== undefined && <small>비교 기준 {result.expectationMatched ? '일치' : '불일치'}</small>}</> : <><code>{result.decision ?? '—'}</code><small>예상 {result.expectedDecision}</small></>}{result.checks?.map((check,checkIndex)=><small key={`${check.path}-${checkIndex}`}><code>{check.path||'(전체 출력)'}</code> {check.matched?'일치':'불일치'}</small>)}{result.message && <small>{result.message}</small>}</div>)}</div>}
      </section>
      <footer className="policy-editor-footer"><span>프롬프트와 출력 형식, 모델 설정을 함께 저장합니다. 저장과 테스트는 상단 고정 작업막대에서 실행하세요.</span></footer>
      </section> : <Empty title="판정 정책을 구성하세요" description="프롬프트와 자유로운 JSON 출력 형식을 함께 저장하고 워크플로우에서 분기, 검사와 동작을 연결합니다." icon={<ShieldCheck size={30}/>}/>}
    </div>
    <dialog ref={archiveDialog} className="policy-confirm-dialog" aria-labelledby="policy-archive-title" onCancel={event => {event.preventDefault(); if(!locked)setArchiveConfirm(false);}}><h2 id="policy-archive-title">정책을 {archived ? '복원' : '보관'}할까요?</h2><p>{archived ? '사용 중 목록으로 옮기고 새 초안을 편집할 수 있게 합니다.' : '사용 중 목록에서 숨깁니다. 저장된 버전과 참조는 삭제하지 않으며 연결된 워크플로우와 기존 API 배포는 계속 실행됩니다.'}</p><p>보관해도 정책 수와 버전 사용량은 줄어들지 않습니다.</p><footer><button className="btn small" disabled={locked} onClick={() => setArchiveConfirm(false)}>취소</button><button className="btn small primary" disabled={locked || dirty} onClick={() => void archivePolicy()}>{archived ? '정책 복원' : '정책 보관'}</button></footer></dialog>
    <dialog ref={confirmDialog} className="policy-confirm-dialog" aria-labelledby="policy-discard-title" onCancel={event => { event.preventDefault(); setPending(undefined); }}><h2 id="policy-discard-title">변경 내용을 버릴까요?</h2><p>아직 저장하지 않은 정책 편집 내용이 있습니다.</p><footer><button className="btn small" onClick={() => setPending(undefined)}>계속 편집</button><button className="btn small" onClick={() => { const next = pending; setPending(undefined); if (next?.kind === 'new') create(); else if (next) open(next.revision); }}>변경 버리고 이동</button></footer></dialog>
  </div>;
}
