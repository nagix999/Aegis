'use client';

import { useEffect, useRef, useState } from 'react';
import { History, LoaderCircle, Search } from 'lucide-react';
import type { AppState, EvalRun, EvaluationStatus } from '@/lib/aegis-types';
import { emptyEvaluationHistoryFilters, evaluationHistoryParams, type EvaluationHistoryFilters } from '@/lib/evaluation-history';
import { Empty, timeLabel } from './console-ui';

type HistoryReply=EvaluationStatus & {total:number;nextCursor?:string;retention:{days:number};error?:{message:string}};
const statusLabels={running:'실행 중',completed:'완료',cancelled:'취소됨',error:'실행 오류'};
export function EvaluationHistory({state,disabled,onOpen}:{state:AppState;disabled:boolean;onOpen:(run:EvalRun)=>void}) {
  const [open,setOpen]=useState(false),[draft,setDraft]=useState({...emptyEvaluationHistoryFilters}),[filters,setFilters]=useState({...emptyEvaluationHistoryFilters});
  const [cursor,setCursor]=useState(''),[previous,setPrevious]=useState<string[]>([]),[revision,setRevision]=useState(0);
  const [reply,setReply]=useState<HistoryReply>(),[loading,setLoading]=useState(false),[error,setError]=useState(''),[directId,setDirectId]=useState(''),[opening,setOpening]=useState('');
  const ticket=useRef(0),openController=useRef<AbortController|null>(null),onOpenRef=useRef(onOpen);onOpenRef.current=onOpen;
  useEffect(()=>()=>{ticket.current++;openController.current?.abort();},[]);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController(),id=++ticket.current;setLoading(true);setError('');setReply(undefined);
    void(async()=>{try{
      const response=await fetch(`/api/console?${evaluationHistoryParams(filters,cursor)}`,{cache:'no-store',signal:controller.signal}),data=await response.json() as HistoryReply;
      if(!response.ok)throw new Error(data.error?.message||'실행 기록을 가져오지 못했습니다.');
      if(!Array.isArray(data.runs)||!Number.isFinite(data.total)||!data.retention)throw new Error('실행 기록의 응답 형식을 확인하세요.');
      if(!controller.signal.aborted&&id===ticket.current)setReply(data);
    }catch(failure){if(!controller.signal.aborted&&id===ticket.current)setError(failure instanceof Error?failure.message:'실행 기록을 가져오지 못했습니다.');}
    finally{if(!controller.signal.aborted&&id===ticket.current)setLoading(false);}})();
    return()=>controller.abort();
  },[open,filters,cursor,revision]);
  function change(field:keyof EvaluationHistoryFilters,value:string){setDraft(previous=>({...previous,[field]:value}));}
  function apply(){try{evaluationHistoryParams(draft);setFilters({...draft});setCursor('');setPrevious([]);setRevision(value=>value+1);}catch(failure){setError(failure instanceof Error?failure.message:'검색 조건을 확인하세요.');}}
  async function openRun(runId:string){
    if(!runId.trim()||disabled)return;
    openController.current?.abort();const controller=new AbortController();openController.current=controller;setOpening(runId);setError('');
    try{
      const response=await fetch(`/api/console?${evaluationHistoryParams(emptyEvaluationHistoryFilters,'',runId.trim())}`,{cache:'no-store',signal:controller.signal}),data=await response.json() as HistoryReply;
      if(!response.ok)throw new Error(data.error?.message||'실행 기록을 열지 못했습니다.');
      if(!data.run||data.run.id!==runId.trim()||!Array.isArray(data.run.results))throw new Error('이 실행 기록을 찾을 수 없습니다. 실행 ID와 보관 기간을 확인하세요.');
      if(!controller.signal.aborted){onOpenRef.current(data.run);setOpen(false);}
    }catch(failure){if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:'실행 기록을 열지 못했습니다.');}
    finally{if(!controller.signal.aborted)setOpening('');}
  }
  return <section className="card ev-run-history"><button className="ev-run-history-toggle" type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><History size={15}/><strong>전체 실행 기록 검색</strong><span>{open?'접기':'최근 목록에 없는 기록과 실행 ID로 찾기'}</span></button>{open&&<div className="ev-run-history-body">
    <form className="ev-run-history-direct" onSubmit={event=>{event.preventDefault();void openRun(directId);}}><label className="field">실행 ID로 바로 열기<input aria-label="직접 열 검증 실행 ID" maxLength={120} value={directId} onChange={event=>setDirectId(event.target.value)} placeholder="검증 실행 ID"/></label><button className="btn small" disabled={disabled||Boolean(opening)||!directId.trim()} type="submit">기록 열기</button></form>
    <form onSubmit={event=>{event.preventDefault();apply();}}><label className="ev-search"><Search size={15}/><input aria-label="검증 실행 기록 검색" maxLength={160} placeholder="실행 ID, 워크플로우, 데이터셋 이름" value={draft.query} onChange={event=>change('query',event.target.value)}/></label><div className="ev-history-filters">
      <label className="field">워크플로우<select value={draft.workflowId} aria-label="실행 기록 워크플로우" onChange={event=>change('workflowId',event.target.value)}><option value="">전체</option>{state.workflows.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
      <label className="field">데이터셋<select value={draft.datasetId} aria-label="실행 기록 데이터셋" onChange={event=>change('datasetId',event.target.value)}><option value="">전체</option>{state.datasets.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
      <label className="field">실행 상태<select value={draft.status} aria-label="실행 기록 상태" onChange={event=>change('status',event.target.value)}><option value="">전체</option>{Object.entries(statusLabels).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select></label>
      <label className="field">시작일<input aria-label="실행 기록 시작일" type="date" value={draft.from} onChange={event=>change('from',event.target.value)}/></label><label className="field">종료일<input aria-label="실행 기록 종료일" type="date" min={draft.from||undefined} value={draft.to} onChange={event=>change('to',event.target.value)}/></label>
    </div><div className="ev-inline-actions"><button className="btn small" type="button" onClick={()=>{setDraft({...emptyEvaluationHistoryFilters});setFilters({...emptyEvaluationHistoryFilters});setCursor('');setPrevious([]);setRevision(value=>value+1);}}>초기화</button><button className="btn small primary" type="submit"><Search size={13}/> 검색</button></div></form>
    {error&&<p className="ev-preflight-start-error" role="alert">{error}</p>}
    <p className="ev-status-note">한국 시간 기준으로 검색합니다. 완료된 원문 기록은 {reply?.retention.days??state.retention?.evaluationDays??30}일 보관하며, 실행 중인 작업은 별도로 유지합니다.</p>
    {loading?<div className="ev-log-loading" role="status"><LoaderCircle size={16} className="ev-spin"/> 실행 기록 조회 중</div>:reply?.runs.length?<div className="ev-table-scroll"><table className="data-table"><thead><tr><th>실행 시간</th><th>워크플로우 / 데이터셋</th><th>버전</th><th>상태</th><th>완료 항목</th><th/></tr></thead><tbody>{reply.runs.map(run=><tr key={run.id}><td>{timeLabel(run.createdAt)}</td><td><strong>{run.workflowName}</strong><small className="ev-cell-sub">{run.datasetName}</small><code className="ev-cell-sub">{run.id}</code></td><td>{run.baselineVersion?`${run.baselineVersion} → ${run.version}`:run.version}</td><td>{statusLabels[run.status??'completed']}</td><td>{run.completedCount} / {run.total}</td><td><button className="btn small" disabled={disabled||Boolean(opening)} onClick={()=>void openRun(run.id)}>{opening===run.id?'불러오는 중':'기록 보기'}</button></td></tr>)}</tbody></table></div>:!error&&<Empty title="조건에 맞는 실행 기록이 없습니다" description="검색 조건이나 보관 기간을 확인하세요."/>}
    <div className="ev-log-pagination"><button className="btn small" disabled={loading||!previous.length} onClick={()=>{const list=[...previous];setCursor(list.pop()??'');setPrevious(list);}}>이전 페이지</button><span>전체 {reply?.total??0}건 / {previous.length+1}페이지 / 20건씩</span><button className="btn small" disabled={loading||!reply?.nextCursor} onClick={()=>{if(reply?.nextCursor){setPrevious(value=>[...value,cursor]);setCursor(reply.nextCursor);}}}>다음 페이지</button></div>
  </div>}</section>;
}
