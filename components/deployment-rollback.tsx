'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, RotateCcw, X } from 'lucide-react';
import type { AppState, Deployment, EvalRun, Workflow } from '@/lib/aegis-types';
import { datasetFingerprint, workflowChanges } from '@/lib/workflow-review';
import { evaluationPreflight, type EvaluationPreflight } from '@/lib/dataset-compatibility';
import { DatasetPreflightPanel } from './dataset-preflight';
import { currentDeployments } from '@/lib/gateway-integration';
import { timeLabel, type Act } from './console-ui';

type Evidence = {id:string;datasetId:string;datasetName:string;datasetFingerprint:string;createdAt:string;total:number;completedCount:number;matchedCount:number;completeCoverage:boolean;mock:boolean};
type Review = {fingerprint:string;policy:Workflow['releasePolicy'];currentWorkflowUpdatedAt?:string;evidence:Evidence[]};
const passed=(run:Evidence)=>run.completeCoverage&&!run.mock&&run.total>0&&run.completedCount===run.total&&run.matchedCount===run.total;

export function DeploymentRollback({deployment,state,act,notify,onClose,onViewEvaluation,onVerificationStarted,suspended=false}:{deployment:Deployment;state:AppState;act:Act;notify:(message:string)=>void;onClose:()=>void;onViewEvaluation?:(runId:string)=>void;onVerificationStarted?:(run:EvalRun)=>void;suspended?:boolean}) {
  const [review,setReview]=useState<Review>();
  const [selected,setSelected]=useState<string[]>([]);
  const [checking,setChecking]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [note,setNote]=useState(''),[accepted,setAccepted]=useState(false);
  const [datasetId,setDatasetId]=useState(''),[preflight,setPreflight]=useState<EvaluationPreflight>(),[criteriaAccepted,setCriteriaAccepted]=useState(false),[preflightError,setPreflightError]=useState('');
  const dataset=state.datasets.find(item=>item.id===datasetId);
  const dialog=useRef<HTMLElement>(null),command=useRef<{payload:string;key:string}|undefined>(undefined);
  const current=currentDeployments(state.deployments).find(item=>item.alias===deployment.alias);
  const changes=workflowChanges(deployment.workflow,current?.workflow,deployment.connections,current?.connections);
  const required=review?.policy?.requiredDatasetIds??[];
  const coverage=new Set((review?.evidence??[]).filter(item=>selected.includes(item.id)&&passed(item)).map(item=>item.datasetId));
  const missing=required.filter(id=>!coverage.has(id));
  const requiresProof=Boolean(review?.policy?.requireVerification||required.length);
  const invalid=checking||Boolean(error)||!review||missing.length>0||(requiresProof&&!selected.length);

  useEffect(()=>{
    if(suspended)return;
    let active=true;const controller=new AbortController();
    setChecking(true);setError('');setAccepted(false);
    (async()=>{
      const response=await fetch(`/api/console?view=verification&deploymentId=${encodeURIComponent(deployment.id)}`,{cache:'no-store',signal:controller.signal});
      const data=await response.json() as Review&{error?:{message?:string}};
      if(!response.ok)throw new Error(data.error?.message||'복원할 설정과 검증 근거를 확인하지 못했습니다.');
      const evidence:Evidence[]=[];
      for(const candidate of data.evidence){
        const dataset=state.datasets.find(item=>item.id===candidate.datasetId);
        if(dataset&&candidate.datasetFingerprint===await datasetFingerprint(dataset))evidence.push(candidate);
      }
      evidence.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
      if(!active)return;
      setReview({...data,evidence});
      setSelected([...new Map(evidence.filter(passed).reverse().map(item=>[item.datasetId,item])).values()].map(item=>item.id));
    })().catch(reason=>{if(active)setError(reason instanceof Error?reason.message:'복원 기준을 확인하지 못했습니다.');}).finally(()=>{if(active)setChecking(false);});
    return()=>{active=false;controller.abort();};
  },[deployment.id,JSON.stringify(state.datasets),JSON.stringify(state.workflows.find(item=>item.id===deployment.workflowId)?.releasePolicy),suspended]);

  useEffect(()=>{
    let active=true;setPreflight(undefined);setCriteriaAccepted(false);setPreflightError('');
    if(dataset)evaluationPreflight(dataset,[{key:'candidate',label:`복원 v${deployment.version}`,workflow:deployment.workflow,connections:deployment.connections}]).then(value=>{if(active)setPreflight(value);}).catch(()=>{if(active)setPreflightError('검증 기준을 확인하지 못했습니다.');});
    return()=>{active=false;};
  },[dataset, deployment]);

  async function startVerification(){
    if(suspended||!dataset||!preflight||busy||state.role!=='admin'||!(onVerificationStarted||onViewEvaluation)||(preflight.requiresAcknowledgement&&!criteriaAccepted))return;
    setBusy(true);
    try{
      const checked=await evaluationPreflight(dataset,[{key:'candidate',label:`복원 v${deployment.version}`,workflow:deployment.workflow,connections:deployment.connections}]);
      if(checked.fingerprint!==preflight.fingerprint){setPreflight(checked);setCriteriaAccepted(false);setPreflightError('검증 기준이 변경되었습니다. 다시 확인하세요.');return;}
      const result=await act({action:'start_evaluation',workflowId:deployment.workflowId,deploymentId:deployment.id,datasetId:dataset.id,target:'deployed',preflightFingerprint:checked.fingerprint,acknowledgeCriteria:checked.requiresAcknowledgement&&criteriaAccepted});
      if(result?.run){notify(result.run.executionMode==='background'?'복원할 설정의 검증을 시작했습니다.':'복원할 설정의 검증을 준비했습니다. 검증 화면에서 이어서 실행하세요.');if(onVerificationStarted)onVerificationStarted(result.run);else{onClose();onViewEvaluation?.(result.run.id);}}
      else setPreflightError('검증을 시작하지 못했습니다. 복원 검토와 메모는 유지됩니다.');
    }finally{setBusy(false);}
  }

  useEffect(()=>{
    if(suspended)return;
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:undefined;dialog.current?.focus();
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==='Escape'&&!busy)onClose();
      if(event.key==='Tab'){
        const nodes=[...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')??[])];
        const first=nodes[0],last=nodes.at(-1);
        if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };document.addEventListener('keydown',onKey);return()=>{document.removeEventListener('keydown',onKey);previous?.focus();};
  },[busy,onClose,suspended]);

  async function restore(){
    if(suspended||invalid||busy||!accepted||state.role!=='admin'||!review)return;
    setBusy(true);
    try{
      const payload={action:'rollback_deployment',deploymentId:deployment.id,note:note.trim(),expectedFingerprint:review.fingerprint,...(selected.length?{verificationRunIds:selected}:{}),...(review.currentWorkflowUpdatedAt?{expectedUpdatedAt:review.currentWorkflowUpdatedAt}:{})};
      const serialized=JSON.stringify(payload);
      if(command.current?.payload!==serialized)command.current={payload:serialized,key:globalThis.crypto?.randomUUID?.()??`retry-${Date.now()}-${Math.random().toString(36).slice(2)}`};
      const result=await act({...payload,idempotencyKey:command.current!.key});
      if(result?.deployment){notify(`선택한 설정을 v${result.deployment.version}으로 배포했습니다.`);onClose();}
    }finally{setBusy(false);}
  }

  return <div className="mg-modal-backdrop" style={suspended?{display:'none'}:undefined} aria-hidden={suspended||undefined} onClick={()=>!busy&&onClose()}><section className="mg-modal" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="rollback-title" onClick={event=>event.stopPropagation()}>
    <header><RotateCcw size={22}/><div><h2 id="rollback-title">이전 배포 설정 복원</h2><p>{deployment.workflow.name} v{deployment.version} 설정을 새 버전으로 배포합니다.</p></div><button className="mg-icon-btn" aria-label="복원 창 닫기" onClick={onClose} disabled={busy}><X size={18}/></button></header>
    <div className="mg-rollback-body"><dl><dt>API 모델 이름</dt><dd>{deployment.alias}</dd><dt>현재 버전</dt><dd>{current?`v${current.version}`:'없음'}</dd><dt>복원할 설정</dt><dd>v{deployment.version} ({timeLabel(deployment.createdAt)})</dd></dl>
      <h3>현재 배포와 달라지는 내용</h3>{changes.length?<ul>{changes.map((change,index)=><li key={index}><strong>{change.label}</strong> {change.detail}</li>)}</ul>:<p>현재 배포와 같은 설정입니다.</p>}
      <h3>현재 배포 기준과 검증 근거</h3><p>복원할 설정에도 현재 워크플로우의 검증 기준을 적용합니다. 해당 설정으로 검증한 현재 데이터셋의 결과를 선택하세요.</p>
      {checking?<p><Loader2 size={14} className="spin"/> 검증 근거 확인 중</p>:error?<p role="alert" className="mg-permission-note">{error}</p>:<>
        <p>{requiresProof?'검증 근거 필수':'검증 근거가 없는 이전 설정도 복원 가능'}{required.length?` / 필수 데이터셋 ${required.length}개`:''}</p>
        <div className="dr-evidence-list">{review?.evidence.map(run=><label key={run.id}><input type="checkbox" checked={selected.includes(run.id)} disabled={busy||!passed(run)} onChange={event=>{setSelected(value=>event.target.checked?[...value.filter(id=>!review.evidence.some(item=>item.id===id&&item.datasetId===run.datasetId)),run.id]:value.filter(id=>id!==run.id));setAccepted(false);}}/><span><strong>{run.datasetName}</strong><small>{timeLabel(run.createdAt)} / {run.matchedCount}/{run.total} 일치{passed(run)?'':' / 전체 검증 필요'}</small></span></label>)}</div>
        {!review?.evidence.length&&<p>복원할 설정에 맞는 검증 기록이 없습니다.</p>}
        {missing.length>0&&<p className="mg-permission-note">필수 데이터셋 {missing.length}개의 검증이 필요합니다: {missing.map(id=>state.datasets.find(item=>item.id===id)?.name??id).join(', ')}</p>}
        {requiresProof&&!selected.length&&<p>해당 배포본을 대상으로 데이터셋을 검증한 뒤 다시 복원하세요.</p>}
      </>}
      {(onVerificationStarted||onViewEvaluation)&&<details><summary>복원할 설정으로 데이터셋 검증</summary><label className="field">검증 데이터셋<select value={datasetId} onChange={event=>setDatasetId(event.target.value)} disabled={busy}><option value="">데이터셋 선택</option>{state.datasets.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{dataset&&<DatasetPreflightPanel dataset={dataset} workflow={deployment.workflow} workflowConnections={deployment.connections} state={state} act={act} target="deployed" targetLabel={`복원 v${deployment.version}`} preflight={preflight} checking={!preflight&&!preflightError} error={preflightError} acknowledged={criteriaAccepted} onAcknowledgedChange={setCriteriaAccepted} busy={busy} mappingDisabledReason="복원 설정의 검증은 현재 데이터셋을 사용합니다. 예상 검사 연결은 데이터셋 화면에서 수정하세요."/>}<button className="btn small" disabled={busy||!preflight||Boolean(preflightError)||Boolean(preflight.requiresAcknowledgement&&!criteriaAccepted)} onClick={()=>void startVerification()}>복원 설정 검증 시작</button></details>}
      <label className="field">복원 메모<textarea maxLength={1000} rows={3} value={note} onChange={event=>setNote(event.target.value)} disabled={busy}/></label>
      <label className="mg-confirm"><input type="checkbox" checked={accepted} onChange={event=>setAccepted(event.target.checked)} disabled={busy||invalid}/> 선택한 과거 설정을 새 버전으로 API 호출에 적용하겠습니다.</label>
      <p className="mg-policy-footnote">현재 접근 허용 목록과 인증 설정을 다시 확인합니다. 검증 요약은 새 배포본에 보관합니다.</p>
      <footer><button className="btn" onClick={onClose} disabled={busy}>취소</button><button className="btn primary" onClick={()=>void restore()} disabled={!accepted||busy||invalid||state.role!=='admin'}>{busy?'복원 중':'확인한 설정 복원'}</button></footer>
    </div>
  </section></div>;
}
