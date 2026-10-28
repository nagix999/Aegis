'use client';

import { useEffect, useState } from 'react';
import type { PolicyRevision, PolicyRoute, PolicyRouting } from '@/lib/aegis-types';
import { bindPolicyRevision, changePolicyRouteAction, policyOutputSchema, policyRoutingErrors } from '@/lib/policy-routing';
import { policyGraphSchemaIssues, policySchemaChanges } from '@/lib/policy-schema-guidance';
import { PolicyGraphEditor } from './policy-graph-editor';
import './workflow-policy-settings.css';

export function WorkflowPolicySettings({ routing, policies, disabled, onChange, onFocusPolicyNode, onOpenPolicy, nodeMode=false }: { routing?: PolicyRouting; policies: PolicyRevision[]; disabled: boolean; onChange: (routing?: PolicyRouting) => void; onFocusPolicyNode?:(nodeId:string,predicateIndex?:number)=>void; onOpenPolicy?:(policyId:string,version:number)=>void; nodeMode?:boolean }) {
  const selectedKey = routing ? `${routing.policy.id}:${routing.policy.version}` : '';
  const [pendingPolicy,setPendingPolicy]=useState<PolicyRevision>();
  useEffect(()=>setPendingPolicy(undefined),[selectedKey]);
  const options = [...policies];
  if (routing && !options.some(item => `${item.id}:${item.version}` === selectedKey)) options.unshift(routing.policy);
  const latest = routing ? policies.filter(item => item.id === routing.policy.id).sort((a,b) => b.version-a.version)[0] : undefined;
  function updateRoute(decision: string, patch: Partial<PolicyRoute>) {
    if (!routing) return;
    onChange({ ...routing, routes: routing.routes.map(route => route.decision === decision ? { ...(patch.action ? changePolicyRouteAction(route, patch.action) : route), ...patch } : route) });
  }
  const errors = routing ? policyRoutingErrors(routing) : [];
  const changes=routing&&pendingPolicy?policySchemaChanges(policyOutputSchema(routing.policy),policyOutputSchema(pendingPolicy)):[];
  const affected=routing?.graph&&pendingPolicy?policyGraphSchemaIssues(routing.graph,policyOutputSchema(pendingPolicy)):[];
  const resetGraph=Boolean(routing?.graph?.nodes.length&&pendingPolicy&&!(routing.policy.id===pendingPolicy.id&&routing.policy.formatVersion===2&&pendingPolicy.formatVersion===2));
  function applyPolicy(policy:PolicyRevision) {
    const bound = bindPolicyRevision(policy, routing?.policy.id === policy.id ? routing.routes : []);
    if (policy.formatVersion===2 && routing?.policy.formatVersion===2 && routing.policy.id===policy.id && routing.graph) bound.graph=structuredClone(routing.graph);
    if (nodeMode && policy.formatVersion===2 && !(routing?.policy.formatVersion===2 && routing.policy.id===policy.id && routing.graph)) bound.graph={version:1,entryNodeId:'',nodes:[],edges:[]};
    onChange(bound);setPendingPolicy(undefined);
  }
  return <section className="we-policy-settings" aria-label="정책 분기 설정">
    <div className="we-section-title">{nodeMode?'적용할 정책':'정책 분기'}</div>
    <p className="we-fine">{nodeMode?'선택한 정책으로 요청을 분석합니다. 검증한 JSON 출력은 연결된 조건 분기에서 사용합니다.':'요청 검사를 통과한 뒤 정책 출력을 검증하고 조건 분기와 액션을 실행합니다. 기존 판정 정책은 저장한 연결을 유지합니다.'}</p>
    <label className="field">사용할 정책 버전<select aria-label="사용할 정책 버전" value={pendingPolicy?`${pendingPolicy.id}:${pendingPolicy.version}`:selectedKey} disabled={disabled} onChange={event => {
      const policy = options.find(item => `${item.id}:${item.version}` === event.target.value);
      if (!policy) { onChange(undefined); return; }
      if (routing && selectedKey===event.target.value) {setPendingPolicy(undefined);return;}
      if(routing)setPendingPolicy(policy);else applyPolicy(policy);
    }}><option value="" disabled={nodeMode}>정책 선택</option>{options.map(policy => <option key={`${policy.id}:${policy.version}`} value={`${policy.id}:${policy.version}`}>{policy.name} v{policy.version}{policy.formatVersion===2?' (구조화 출력)':' (기존 판정)'}</option>)}</select><small>{routing ? '선택한 버전의 지시문, 출력 형식과 모델 설정을 이 워크플로우에 고정합니다.' : '정책 관리에서 지시문, 출력 스키마와 예제를 먼저 등록하세요.'}</small></label>
    {routing && <>
      {pendingPolicy&&<section className="we-policy-impact" aria-label="정책 버전 변경 영향" data-policy-version-impact="true"><strong>정책 변경의 영향</strong><p>{routing.policy.name} v{routing.policy.version} → {pendingPolicy.name} v{pendingPolicy.version}</p>
        {resetGraph&&<p className="we-inline-error">다른 정책 또는 출력 형식으로 전환하면 현재 조건과 액션 {routing.graph!.nodes.length}개, 연결 {routing.graph!.edges.length}개가 제거됩니다. 아래 적용 버튼을 누르기 전까지 현재 설정을 유지합니다.</p>}
        {changes.length?<ul>{changes.map(change=><li key={change.path}><code>{change.path}</code> {change.kind==='removed'?'필드 삭제':change.kind==='type'?'자료형 변경':'허용값 변경'} <small>{change.before} → {change.after}</small></li>)}</ul>:<p>확인 가능한 필드 삭제와 자료형 변경은 없습니다.</p>}
        {affected.length>0&&<div><strong>확인이 필요한 조건 {affected.length}개</strong>{affected.map(issue=><button type="button" className="we-policy-impact-node" key={`${issue.nodeId}-${issue.predicateIndex}-${issue.code}`} disabled={!onFocusPolicyNode} onClick={()=>onFocusPolicyNode?.(issue.nodeId,issue.predicateIndex)}><span>{issue.nodeName} / 조건 {issue.predicateIndex+1}<code>{issue.path||'(전체 출력)'}</code><small>{issue.message}</small></span></button>)}</div>}
        <p className="we-fine">같은 정책의 구조화 출력 버전끼리는 조건과 연결을 보존합니다. 적용한 뒤 표시된 조건을 수정하세요. 복합 스키마는 서버 검사를 함께 확인해야 합니다.</p><div className="we-row"><button type="button" className={`btn small ${resetGraph?'danger':'primary'}`} disabled={disabled} onClick={()=>applyPolicy(pendingPolicy)}>{resetGraph?`노드 ${routing.graph!.nodes.length}개를 제거하고 정책 변경`:'버전 변경 적용'}</button><button type="button" className="btn small" onClick={()=>setPendingPolicy(undefined)}>현재 버전 유지</button></div>
      </section>}
      {latest && latest.version > routing.policy.version && <p className="we-info">새 버전 v{latest.version}이 있습니다. 현재 설정은 v{routing.policy.version}을 유지합니다. 변경하려면 새 버전을 직접 선택하세요.</p>}
      {onOpenPolicy&&<button type="button" className="btn small" onClick={()=>onOpenPolicy(routing.policy.id,routing.policy.version)}>고정한 정책 버전 열기</button>}
      <details className="we-policy-snapshot"><summary>고정한 정책 내용 보기</summary><dl><dt>정책</dt><dd>{routing.policy.name} v{routing.policy.version}</dd><dt>모델</dt><dd>{routing.policy.connectionSnapshot.name} / {routing.policy.connectionSnapshot.model} ({routing.policy.connectionSnapshot.mode === 'demo' ? '예제 모드' : 'vLLM'})</dd></dl><strong>판정 지시문</strong><pre>{routing.policy.prompt}</pre><strong>출력 스키마</strong><pre>{JSON.stringify(policyOutputSchema(routing.policy), null, 2)}</pre></details>
      {!nodeMode&&routing.graph&&routing.policy.formatVersion===2&&<PolicyGraphEditor key={`${routing.policy.id}:${routing.policy.version}`} graph={routing.graph} schema={policyOutputSchema(routing.policy)} disabled={disabled} onChange={graph=>onChange({...routing,graph})}/>}
      {routing.policy.formatVersion!==2&&routing.policy.decisions.map(decision => {
        const route = routing.routes.find(item => item.decision === decision.code) ?? { decision: decision.code, action: 'main' as const };
        return <fieldset className="we-policy-route" key={decision.code} disabled={disabled}><legend>{decision.label} <code>{decision.code}</code></legend>{decision.description && <p>{decision.description}</p>}
          <label className="field">실행 경로<select aria-label={`${decision.code} 실행 경로`} value={route.action} onChange={event => updateRoute(decision.code, { action: event.target.value as PolicyRoute['action'] })}><option value="main">응답 모델 실행</option><option value="respond">등록 안내 응답</option><option value="error">지정 오류 반환</option></select></label>
          {route.action === 'respond' && <label className="field">안내 응답<textarea aria-label={`${decision.code} 안내 응답`} rows={3} maxLength={4000} value={route.responseText ?? ''} onChange={event => updateRoute(decision.code, { responseText: event.target.value })} /><small>응답 모델 호출을 생략하고 이 문구를 응답 검사에 전달합니다. 차단 시 종료하며 재작성하지 않습니다.</small></label>}
          {route.action === 'error' && <><label className="field">공개 오류 코드<input aria-label={`${decision.code} 공개 오류 코드`} maxLength={64} value={route.errorCode ?? ''} placeholder="예: PII_RESTRICTED" onChange={event => updateRoute(decision.code, { errorCode: event.target.value })} /></label><label className="field">공개 오류 메시지<textarea aria-label={`${decision.code} 공개 오류 메시지`} rows={2} maxLength={500} value={route.errorMessage ?? ''} onChange={event => updateRoute(decision.code, { errorMessage: event.target.value })} /><small>Gateway는 정책 차단과 이 공개 코드를 반환합니다. 모델의 내부 설명은 공개하지 않습니다.</small></label></>}
        </fieldset>;
      })}
      {errors.length > 0 && <div className="we-policy-errors" role="status">{errors.map(error => <p key={error}>{error}</p>)}</div>}
    </>}
  </section>;
}
