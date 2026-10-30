import type { ExecutionResult, PolicyRoute, Workflow } from '@/lib/aegis-types';
import { policyScopedId, workflowPolicyCheck } from '@/lib/workflow-policy-checks';

export const policyRouteLabels:Record<PolicyRoute['action'],string>={main:'응답 모델 실행',respond:'등록 안내 응답',error:'지정 오류'};
export function PolicyExecutionSummary({result,workflow,onSelectNode}:{result:Pick<ExecutionResult,'policyDecision'|'policyRoute'|'policyCode'|'policyPath'|'policyChecks'>;workflow?:Workflow;onSelectNode?:(nodeId:string)=>void}){
  const legacy=Boolean(result.policyDecision||result.policyRoute||result.policyCode),checks=result.policyChecks??[];
  if(!legacy&&!checks.length)return null;
  function nodePath(ownerId:string,path:string[]){
    const routing=workflow?workflowPolicyCheck(workflow,ownerId)?.routing:undefined;
    return <span className="policy-node-path">정책 노드 경로: {path.map((id,index)=>{const node=routing?.graph?.nodes.find(item=>item.id===id),label=node?.name||`정책 노드 ${index+1}`;return <span key={`${index}-${id}`}>{index>0&&' → '}{node&&onSelectNode?<button type="button" onClick={()=>onSelectNode(policyScopedId(ownerId,id))} aria-label={`${label} 노드 보기`}>{label}</button>:label}</span>;})}<details><summary>내부 ID</summary><code>{path.map(id=>policyScopedId(ownerId,id)).join(' → ')}</code></details></span>;
  }
  return <div className="policy-execution-summary" aria-label="정책 실행 결과" style={{display:'flex',flexDirection:'column',gap:8,margin:'10px 0',fontSize:12,lineHeight:1.6}}>
    {legacy&&<div style={{display:'flex',flexWrap:'wrap',gap:'6px 12px'}}>
      {result.policyDecision&&<span>정책 판정: <code>{result.policyDecision}</code></span>}
      {result.policyRoute&&<span>선택 경로: {policyRouteLabels[result.policyRoute]}</span>}
      {result.policyCode&&<span>공개 오류 코드: <code>{result.policyCode}</code></span>}
      {!!result.policyPath?.length&&nodePath('policy',result.policyPath)}
    </div>}
    {checks.length>0&&<div aria-label="정책 검사별 결과" className="policy-check-results">{checks.map((check,index)=>{const scope=workflow?workflowPolicyCheck(workflow,check.ruleId):undefined;return <div key={`${check.ruleId}-${check.attempt??1}-${index}`} data-policy-check-id={check.ruleId} style={{border:'1px solid var(--border)',borderRadius:6,padding:'8px 10px',marginBottom:6}}>
      <strong>{scope?.rule?.name||scope?.routing.policy.name||'정책 검사'} v{check.policyVersion}</strong>{' / '}{check.stage==='pre'?'요청 검사':'응답 검사'}{check.stage==='post'&&check.attempt?` / ${check.attempt}차`:''}{' / '}{({allow:'통과',block:'차단',error:'실행 오류',skipped:'실행 안 함'}as const)[check.status]}
      {check.route&&<span>{' / '}선택 경로: {check.route==='main'?'다음 검사 계속':check.route==='error'?'차단':policyRouteLabels[check.route]}</span>}
      {check.decision&&<span>{' / '}판정: <code>{check.decision}</code></span>}
      {check.policyCode&&<span>{' / '}공개 오류 코드: <code>{check.policyCode}</code></span>}
      {!!check.path?.length&&<div>{nodePath(check.ruleId,check.path)}</div>}
    </div>;})}</div>}
  </div>;
}
