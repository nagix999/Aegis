import type { Workflow } from '@/lib/aegis-types';
import { expectedPolicyCheck, listWorkflowPolicyChecks } from '@/lib/workflow-policy-checks';

export function PolicyCheckSelect({workflow,value,onChange,disabled,label='검증할 정책 검사'}:{workflow?:Workflow;value?:string;onChange:(id:string|undefined)=>void;disabled?:boolean;label?:string}) {
  const scopes=workflow?listWorkflowPolicyChecks(workflow):[],automatic=workflow?expectedPolicyCheck(workflow):undefined;
  return <label className="field">{label}<select aria-label={label} value={value??''} disabled={disabled} onChange={event=>onChange(event.target.value||undefined)}><option value="">{automatic?`자동: ${automatic.rule?.name??automatic.routing.policy.name}`:scopes.length>1?'정책 검사 선택 필요':'자동 선택'}</option>{value&&!scopes.some(scope=>scope.id===value)&&<option value={value}>현재 워크플로우에 없는 검사 ({value})</option>}{scopes.map(scope=><option key={scope.id} value={scope.id}>{scope.stage==='pre'?'PRE':'POST'} / {scope.rule?.name??'기존 정책 검사'} / {scope.routing.policy.name} v{scope.routing.policy.version}</option>)}</select>{scopes.length>1&&!value&&!automatic&&<small>여러 정책 중 출력 조건을 검증할 검사 하나를 선택하세요.</small>}</label>;
}
