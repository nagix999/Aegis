'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileCheck2, Loader2, Rocket, ShieldAlert, X } from 'lucide-react';
import type { AppState, EvalRun, Workflow } from '@/lib/aegis-types';
import { configurationFingerprint, datasetFingerprint, referencedConnections, workflowChanges } from '@/lib/workflow-review';
import { validateWorkflow } from '@/lib/aegis-engine';
import { connectionLabel } from '@/lib/product-copy';
import { evaluationPreflight, type EvaluationPreflight } from '@/lib/dataset-compatibility';
import { DatasetPreflightPanel } from './dataset-preflight';
import { Tag, timeLabel, type Act } from './console-ui';
import './deployment-review.css';

type ReviewRun = Pick<EvalRun,'id'|'datasetId'|'datasetName'|'createdAt'|'fingerprint'|'datasetFingerprint'> & {total:number;completedCount:number;matchedCount:number;completeCoverage:boolean;mock:boolean};
export type DeploymentReviewProps = { workflow: Workflow; state: AppState; act: Act; notify: (message: string) => void; onClose: () => void; suspended?:boolean; onVerificationStarted?:(run:EvalRun)=>void };

function matchedCount(run:ReviewRun){return run.matchedCount;}
function completeDatasetCoverage(run:ReviewRun){return run.completeCoverage;}
function passed(run:ReviewRun){return run.completeCoverage&&!run.mock&&run.completedCount>0&&run.completedCount===run.total&&run.matchedCount===run.total;}

export function DeploymentReview({ workflow, state, act, notify, onClose, suspended=false, onVerificationStarted }: DeploymentReviewProps) {
  const [checking, setChecking] = useState(true);
  const [fingerprint, setFingerprint] = useState('');
  const [savedMatches, setSavedMatches] = useState(false);
  const [matchingRuns, setMatchingRuns] = useState<ReviewRun[]>([]);
  const [verificationRunIds, setVerificationRunIds] = useState<string[]>([]);
  const [policy,setPolicy]=useState(workflow.releasePolicy??{requireVerification:false,requiredDatasetIds:[] as string[]});
  const [unverifiedReason,setUnverifiedReason]=useState('');
  const dialog=useRef<HTMLElement>(null);
  const command=useRef<{payload:string;key:string}|undefined>(undefined);
  const policyChanged=JSON.stringify(policy)!==JSON.stringify(workflow.releasePolicy??{requireVerification:false,requiredDatasetIds:[]});
  const [confirmed, setConfirmed] = useState(false);
  const [unverifiedAccepted, setUnverifiedAccepted] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [datasetId,setDatasetId]=useState(''),[preflight,setPreflight]=useState<EvaluationPreflight>(),[criteriaAccepted,setCriteriaAccepted]=useState(false),[preflightError,setPreflightError]=useState('');
  const dataset=state.datasets.find(item=>item.id===datasetId);
  const previous = useMemo(() => state.deployments.filter(deployment => deployment.workflowId === workflow.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.version - a.version)[0], [state.deployments, workflow.id]);
  const changes = workflowChanges(workflow, previous?.workflow, state.connections, previous?.connections);
  const connections = referencedConnections(workflow, state.connections);
  const issues = validateWorkflow(workflow, state.connections);
  if (state.deployments.some(deployment => deployment.alias === workflow.alias && deployment.workflowId !== workflow.id)) issues.push('다른 워크플로우가 같은 API 모델 이름을 사용하고 있습니다.');
  for (const connection of connections.filter(item => item.mode === 'vllm')) {
    try { if (!state.ingress.allowedOrigins.includes(new URL(connection.baseUrl).origin)) issues.push(`${connectionLabel(connection.name)}: 접근 설정에 모델 서버 주소를 등록하세요.`); }
    catch { /* validateWorkflow reports malformed URLs. */ }
  }
  if (!checking && !savedMatches) issues.push('저장된 초안과 현재 설정이 다릅니다. 편집 내용을 저장한 뒤 배포를 다시 확인하세요.');
  const selectedRuns=matchingRuns.filter(run=>verificationRunIds.includes(run.id));
  const coveredDatasets=new Set(selectedRuns.filter(passed).map(run=>run.datasetId));
  const missingRequired=(workflow.releasePolicy?.requiredDatasetIds??[]).filter(id=>!coveredDatasets.has(id));
  const verified=selectedRuns.length>0&&selectedRuns.every(passed)&&!missingRequired.length;
  const verificationRequired=Boolean(workflow.releasePolicy?.requireVerification||workflow.releasePolicy?.requiredDatasetIds.length);
  if(policyChanged)issues.push('변경한 배포 기준을 먼저 저장하세요.');
  const verificationIssues=[...issues];
  if(missingRequired.length)issues.push(`필수 데이터셋 ${missingRequired.length}개의 현재 검증 결과를 선택하세요.`);
  const reviewInputKey = JSON.stringify({
    workflow, connections, saved: state.workflows.find(item => item.id === workflow.id),
    runs: state.runs.filter(run=>run.workflowId===workflow.id).map(run=>({id:run.id,status:run.status,completedCount:run.results.length,fingerprint:run.fingerprint})),
    datasets:state.datasets,
  });


  useEffect(() => {
    if(suspended)return;
    let active = true;const abort=new AbortController();
    setChecking(true); setError(''); setConfirmed(false); setUnverifiedAccepted(false);
    (async () => {
      const current = await configurationFingerprint(workflow, state.connections);
      const saved = state.workflows.find(item => item.id === workflow.id);
      const savedFingerprint = saved ? await configurationFingerprint(saved, state.connections) : '';
      const response=await fetch(`/api/console?view=verification&workflowId=${encodeURIComponent(workflow.id)}`,{cache:'no-store',signal:abort.signal});
      if(!response.ok)throw new Error('배포 근거를 불러오지 못했습니다.');
      const summary=await response.json() as {evidence:ReviewRun[];fingerprint:string};
      if(summary.fingerprint!==current)throw new Error('검토 중 초안이 변경되었습니다.');
      const candidates=summary.evidence;
      const sameData:ReviewRun[]=[];
      for (const run of candidates) {
        const dataset = state.datasets.find(item => item.id === run.datasetId);
        if (dataset && run.datasetFingerprint && run.datasetFingerprint === await datasetFingerprint(dataset)) sameData.push(run);
      }
      sameData.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      if (!active) return;
      setFingerprint(current); setSavedMatches(current === savedFingerprint); setMatchingRuns(sameData);
      setVerificationRunIds([...new Map(sameData.filter(passed).reverse().map(run=>[run.datasetId,run])).values()].map(run=>run.id));
    })().catch(() => { if (active) setError('설정과 검증 결과를 비교하지 못했습니다. 창을 닫고 다시 확인하세요.'); }).finally(() => { if (active) setChecking(false); });
    return () => { active = false;abort.abort(); };
  }, [reviewInputKey,suspended]);

  useEffect(()=>{setPolicy(workflow.releasePolicy??{requireVerification:false,requiredDatasetIds:[]});},[JSON.stringify(workflow.releasePolicy)]);
  useEffect(()=>{
    let active=true;setPreflight(undefined);setCriteriaAccepted(false);setPreflightError('');
    if(dataset&&onVerificationStarted)evaluationPreflight(dataset,[{key:'candidate',label:'배포할 서버 초안',workflow,connections:state.connections}]).then(value=>{if(active)setPreflight(value);}).catch(()=>{if(active)setPreflightError('검증 기준을 확인하지 못했습니다.');});
    return()=>{active=false;};
  },[dataset,workflow,state.connections,Boolean(onVerificationStarted)]);
  useEffect(()=>{if(suspended)return;const previous=document.activeElement instanceof HTMLElement?document.activeElement:undefined;dialog.current?.focus();const keys=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!busy)onClose();if(event.key==='Tab'){const nodes=[...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex=\"0\"]')??[])];const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===dialog.current)){event.preventDefault();first?.focus();}}};document.addEventListener('keydown',keys);return()=>{document.removeEventListener('keydown',keys);previous?.focus();};},[busy,suspended]);
  async function startVerification(){
    if(suspended||!onVerificationStarted||!dataset||!preflight||busy||checking||!savedMatches||verificationIssues.length||state.role!=='admin'||(preflight.requiresAcknowledgement&&!criteriaAccepted))return;
    setBusy(true);setPreflightError('');
    try{
      const checked=await evaluationPreflight(dataset,[{key:'candidate',label:'배포할 서버 초안',workflow,connections:state.connections}]);
      if(checked.fingerprint!==preflight.fingerprint){setPreflight(checked);setCriteriaAccepted(false);setPreflightError('검증 기준이 변경되었습니다. 다시 확인하세요.');return;}
      const response=await act({action:'start_evaluation',workflowId:workflow.id,datasetId:dataset.id,target:'draft',preflightFingerprint:checked.fingerprint,acknowledgeCriteria:checked.requiresAcknowledgement&&criteriaAccepted});
      if(response?.run){notify('배포할 초안의 검증을 시작했습니다. 검증 후 배포 검토로 돌아올 수 있습니다.');onVerificationStarted(response.run);}
      else setPreflightError('검증을 시작하지 못했습니다. 입력과 검토 내용은 유지됩니다.');
    }finally{setBusy(false);}
  }
  async function savePolicy(){if(state.role!=='admin'||busy)return;setBusy(true);try{const result=await act({action:'save_workflow',workflow:{...workflow,releasePolicy:policy},expectedUpdatedAt:workflow.updatedAt??''});if(result)notify('배포 기준을 저장했습니다. 검증 결과를 다시 확인하세요.');}finally{setBusy(false);}}
  async function publish() {
    if (suspended || busy || checking || issues.length || !confirmed || (!verified && (verificationRequired || !unverifiedAccepted || !unverifiedReason.trim())) || state.role !== 'admin') return;
    setBusy(true);
    try {
      const payload = { action: 'publish', workflowId: workflow.id, expectedFingerprint: fingerprint, note: note.trim(), ...(verified ? { verificationRunIds } : {acknowledgeUnverified:true,unverifiedReason:unverifiedReason.trim()}) };
      const serialized=JSON.stringify(payload);
      if(command.current?.payload!==serialized)command.current={payload:serialized,key:globalThis.crypto?.randomUUID?.()??`retry-${Date.now()}-${Math.random().toString(36).slice(2)}`};
      const response = await act({ ...payload, idempotencyKey:command.current!.key });
      if (response?.deployment) { notify(`v${response.deployment.version} 배포를 완료했습니다.`); onClose(); }
    } finally { setBusy(false); }
  }

  return <div className="dr-backdrop" style={suspended?{display:'none'}:undefined} aria-hidden={suspended||undefined} onClick={() => !busy && onClose()}><section className="dr-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="deployment-review-title" onClick={event => event.stopPropagation()}>
    <header><div><h2 id="deployment-review-title">배포 내용 확인</h2><p>{workflow.name} 설정을 새 버전으로 배포합니다.</p></div><button className="icon-button" aria-label="배포 확인 닫기" onClick={onClose} disabled={busy}><X size={18}/></button></header>
    <div className="dr-body"><dl className="dr-summary"><dt>API 모델 이름</dt><dd><code>{workflow.alias}</code></dd><dt>현재 배포</dt><dd>{previous ? `v${previous.version}` : '배포 이력 없음'}</dd><dt>설정 확인값</dt><dd><code title={fingerprint}>{checking ? '확인 중' : fingerprint.slice(0, 16) || '확인 실패'}</code></dd></dl>
      <section className="dr-section"><h3>변경 내용</h3>{changes.length ? <ul className="dr-changes">{changes.map((change, index) => <li key={`${change.label}-${index}`}><strong>{change.label}</strong><span>{change.detail}</span></li>)}</ul> : <p>현재 배포와 같은 설정입니다. 배포하면 새 버전이 추가됩니다.</p>}<details><summary>배포할 설정 보기</summary><pre>{JSON.stringify({ workflow, connections }, null, 2)}</pre></details></section>
      <section className="dr-section"><h3>설정 확인</h3>{checking ? <p className="dr-inline"><Loader2 size={14} className="spin"/> 저장된 설정을 비교하고 있습니다.</p> : issues.length ? <ul className="dr-issues">{issues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}</ul> : <p className="dr-inline dr-ok"><CheckCircle2 size={15}/> 필수 설정과 서버 허용 목록을 확인했습니다.</p>}<div className="dr-connections">{connections.map(connection => { const diagnostic = state.diagnostics?.[connection.id]; return <div key={connection.id}><span>{connectionLabel(connection.name)}</span><Tag tone={connection.mode === 'demo' ? 'warning' : 'neutral'}>{connection.mode === 'demo' ? '예제 모드' : 'vLLM'}</Tag><small>{diagnostic ? `마지막 진단 ${timeLabel(diagnostic.checkedAt)} (${diagnostic.ok ? '통과' : '실패'})` : '진단 기록 없음'}</small></div>; })}</div><p className="dr-help">실제 서버의 인증과 응답 형식은 모델 서버 화면의 상세 진단에서 확인할 수 있습니다. 배포 시 서버에서 설정을 다시 검사합니다.</p></section>
      <section className="dr-section"><h3>배포 기준</h3><p>이 워크플로우에 필요한 검증 데이터셋을 지정합니다. 서버에서도 같은 기준을 확인합니다.</p><label className="dr-policy-choice"><input type="checkbox" checked={policy.requireVerification} disabled={busy||state.role!=='admin'} onChange={event=>{setPolicy(value=>({...value,requireVerification:event.target.checked}));setConfirmed(false);}}/> 검증 근거가 있어야 배포</label><details><summary>필수 데이터셋 {policy.requiredDatasetIds.length}개</summary><div className="dr-evidence-list">{[...new Set([...state.datasets.map(dataset=>dataset.id),...policy.requiredDatasetIds])].map(id=><label key={id}><input type="checkbox" checked={policy.requiredDatasetIds.includes(id)} disabled={busy||state.role!=='admin'} onChange={event=>setPolicy(value=>({...value,requiredDatasetIds:event.target.checked?[...value.requiredDatasetIds,id]:value.requiredDatasetIds.filter(item=>item!==id)}))}/><span>{state.datasets.find(dataset=>dataset.id===id)?.name??`삭제된 데이터셋 (${id})`}</span></label>)}</div></details>{policyChanged&&<button className="btn small" disabled={busy||state.role!=='admin'} onClick={()=>void savePolicy()}>배포 기준 저장</button>}</section>
      <section className="dr-section"><h3>배포 근거로 남길 검증</h3><p>여러 데이터셋의 결과를 함께 선택할 수 있습니다. 현재 설정과 데이터셋으로 전체 항목을 통과한 기록만 사용합니다.</p><div className="dr-evidence-list">{matchingRuns.map(run=><label key={run.id}><input type="checkbox" checked={verificationRunIds.includes(run.id)} disabled={checking||busy||!passed(run)} onChange={event=>{setVerificationRunIds(value=>event.target.checked?[...value.filter(id=>!matchingRuns.some(item=>item.id===id&&item.datasetId===run.datasetId)),run.id]:value.filter(id=>id!==run.id));setConfirmed(false);setUnverifiedAccepted(false);}}/><span><strong>{run.datasetName}</strong><small>{timeLabel(run.createdAt)} / {matchedCount(run)}/{run.completedCount} 일치{passed(run)?'':completeDatasetCoverage(run)?' / 확인 필요':' / 전체 검증 필요'}</small></span></label>)}</div>{!matchingRuns.length&&<p>현재 설정에 맞는 검증 기록이 없습니다. 필수 데이터셋을 검증한 뒤 다시 확인하세요.</p>}{verified&&<p className="dr-inline dr-ok"><FileCheck2 size={16}/>{coveredDatasets.size}개 데이터셋의 검증 결과를 배포 근거로 남깁니다.</p>}{!verified&&!verificationRequired&&<div className="dr-warning"><ShieldAlert size={17}/><div><p>검증 결과를 연결하지 않은 배포입니다.</p><label><input type="checkbox" checked={unverifiedAccepted} onChange={event=>setUnverifiedAccepted(event.target.checked)} disabled={checking||busy}/> 일치하는 검증 결과 없이 배포한다는 점을 확인했습니다.</label><label className="field">배포 이유<textarea value={unverifiedReason} maxLength={1000} rows={2} onChange={event=>setUnverifiedReason(event.target.value)} placeholder="검증 근거 없이 배포하는 이유를 남기세요." disabled={busy}/></label></div></div>}<p className="dr-help">설정이나 원본 데이터셋을 바꾸면 이전 검증 결과를 이번 배포의 근거로 사용할 수 없습니다. 예제 모드의 검증은 실제 모델의 품질을 보장하지 않습니다.</p></section>
      {onVerificationStarted&&<section className="dr-section"><h3>이 초안으로 데이터셋 검증</h3><p>검토 내용과 메모를 유지한 채 검증합니다. 완료 후 이 배포 검토로 돌아와 근거를 다시 확인하세요.</p><label className="field">검증 데이터셋<select aria-label="배포 전 검증 데이터셋" value={datasetId} onChange={event=>setDatasetId(event.target.value)} disabled={busy}><option value="">데이터셋 선택</option>{state.datasets.map(item=><option key={item.id} value={item.id}>{item.name}{policy.requiredDatasetIds.includes(item.id)?' (필수)':''}</option>)}</select></label>{dataset&&<DatasetPreflightPanel dataset={dataset} workflow={workflow} workflowConnections={state.connections} state={state} act={act} target="draft" targetLabel="배포할 서버 초안" preflight={preflight} checking={!preflight&&!preflightError} error={preflightError} acknowledged={criteriaAccepted} onAcknowledgedChange={setCriteriaAccepted} busy={busy} mappingDisabledReason="배포 검토에서는 저장된 데이터셋을 사용합니다. 검사 연결은 데이터셋 화면에서 수정하세요."/>}{!state.datasets.length&&<p>검증 데이터셋을 먼저 등록하세요.</p>}{preflightError&&<p role="alert" className="dr-error">{preflightError}</p>}<button className="btn small" disabled={busy||checking||!savedMatches||verificationIssues.length>0||state.role!=='admin'||!preflight||Boolean(preflightError)||Boolean(preflight.requiresAcknowledgement&&!criteriaAccepted)} onClick={()=>void startVerification()}>배포 전 검증 시작</button></section>}
      <label className="field">배포 메모<textarea value={note} onChange={event => setNote(event.target.value)} maxLength={1000} rows={3} placeholder="변경한 내용과 배포 이유를 남기세요." disabled={busy}/></label>
      <label className="dr-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy || checking}/> 위 설정을 새 버전으로 배포해 API 호출에 적용하겠습니다.</label>
      {state.role !== 'admin' && <p className="dr-error">관리자만 배포할 수 있습니다.</p>}{error && <p className="dr-error" role="alert">{error}</p>}
    </div><footer><button className="btn" onClick={onClose} disabled={busy}>취소</button><button className="btn primary" onClick={() => void publish()} disabled={busy || checking || Boolean(error) || issues.length > 0 || !confirmed || (!verified && (verificationRequired || !unverifiedAccepted || !unverifiedReason.trim())) || state.role !== 'admin'}>{busy ? <Loader2 size={15} className="spin"/> : <Rocket size={15}/>} {busy ? '배포 중' : '확인한 설정 배포'}</button></footer>
  </section></div>;
}
