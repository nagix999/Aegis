import type { ExecutionResult, PolicyRoute, Workflow } from '@/lib/aegis-types';

export const policyRouteLabels: Record<PolicyRoute['action'], string> = { main: '응답 모델 실행', respond: '등록 안내 응답', error: '지정 오류' };
export function PolicyExecutionSummary({ result,workflow,onSelectNode }: { result: Pick<ExecutionResult, 'policyDecision'|'policyRoute'|'policyCode'|'policyPath'>;workflow?:Workflow;onSelectNode?:(nodeId:string)=>void }) {
  if (!result.policyDecision && !result.policyRoute && !result.policyCode) return null;
  return <div className="policy-execution-summary" aria-label="정책 실행 결과" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', margin: '10px 0', fontSize: 12, lineHeight: 1.6 }}>
    {result.policyDecision && <span>정책 판정: <code>{result.policyDecision}</code></span>}
    {result.policyRoute && <span>선택 경로: {policyRouteLabels[result.policyRoute]}</span>}
    {result.policyCode && <span>공개 오류 코드: <code>{result.policyCode}</code></span>}
    {!!result.policyPath?.length && <span className="policy-node-path">정책 노드 경로: {result.policyPath.map((id,index)=>{const node=workflow?.policyRouting?.graph?.nodes.find(item=>item.id===id),label=node?.name||`정책 노드 ${index+1}`;return <span key={`${index}-${id}`}>{index>0&&' → '}{node&&onSelectNode?<button type="button" onClick={()=>onSelectNode(id)} aria-label={`${label} 노드 보기`}>{label}</button>:label}</span>;})}<details><summary>내부 ID</summary><code>{result.policyPath.join(' → ')}</code></details></span>}
  </div>;
}
