import type { Connection, Dataset, DatasetRow, ExecutionResult, Workflow } from './aegis-types';
// @ts-expect-error Node's source test runner uses explicit TypeScript imports.
import { ENGINE_VERSION } from './execution-provenance.ts';
// @ts-expect-error Node's source test runner uses explicit TypeScript imports.
import { effectiveExecutionLimits } from './execution-plan.ts';
// @ts-expect-error Node's source test runner uses explicit TypeScript imports.
import { policyExecutionConfiguration } from './policy-routing.ts';

const compareKeys=(a:string,b:string)=>a<b?-1:a>b?1:0;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>compareKeys(a,b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
async function digest(value: unknown): Promise<string> {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
}
export function referencedConnections(workflow: Workflow, connections: Connection[]): Connection[] {
  const ids=new Set([workflow.mainConnectionId,...[...workflow.pre,...workflow.post].flatMap(g=>g.rules.filter(r=>r.enabled&&r.kind==='llm').map(r=>r.config.connectionId))]);
  return connections.filter(c=>ids.has(c.id)).sort((a,b)=>compareKeys(a.id,b.id));
}
export function executionConfiguration(workflow: Workflow) {
  const {updatedAt: _updatedAt,layout: _layout,cloneSource: _cloneSource,releasePolicy: _releasePolicy,name: _name,description: _description,alias: _alias,...configuration}=workflow;
  const groups=(stage:Workflow['pre'])=>stage.map(({name:_groupName,...group})=>({
    ...group,rules:group.rules.map(({name:_ruleName,description:_ruleDescription,...rule})=>rule),
  }));
  const stageGraph=(stage:NonNullable<Workflow['graph']>['pre'])=>({...stage,nodes:stage.nodes.map(({name:_controlName,...node})=>node)});
  return {...configuration,inputScope:workflow.inputScope??'conversation',executionLimits:effectiveExecutionLimits(workflow),pre:groups(workflow.pre),post:groups(workflow.post),
    ...(workflow.policyRouting?{policyRouting:policyExecutionConfiguration(workflow.policyRouting)}:{}),
    ...(workflow.graph?{graph:{...workflow.graph,pre:stageGraph(workflow.graph.pre),post:stageGraph(workflow.graph.post)}}:{}),
  };
}
export function configurationFingerprint(workflow: Workflow, connections: Connection[]): Promise<string> {
  return digest({engineVersion:ENGINE_VERSION,workflow:executionConfiguration(workflow),connections:referencedConnections(workflow,connections).map(({name:_name,...connection})=>connection)});
}
export function datasetFingerprint(dataset: Dataset): Promise<string> {
  const {updatedAt: _updatedAt,...content}=dataset;
  return digest(content);
}
export function matchesExpectation(row: Pick<DatasetRow,'expected'|'expectedStage'|'expectedRuleId'|'expectedDecision'|'expectedRoute'|'expectedPolicyCode'|'expectedPolicyFields'>, result: ExecutionResult): boolean {
  if(result.status!==row.expected)return false;
  if(row.expectedStage&&result.stage!==row.expectedStage)return false;
  if(row.expectedDecision&&result.policyDecision!==row.expectedDecision)return false;
  if(row.expectedRoute&&result.policyRoute!==row.expectedRoute)return false;
  if(row.expectedPolicyCode&&result.policyCode!==row.expectedPolicyCode)return false;
  if(row.expectedPolicyFields && (result.policyFieldChecks?.length!==row.expectedPolicyFields.length || row.expectedPolicyFields.some((field,index)=>result.policyFieldChecks?.[index].path!==field.path||result.policyFieldChecks?.[index].matched!==true)))return false;
  if(result.policyFieldChecks?.some(check=>!check.matched))return false;
  const finalAttempt=result.attempts?.at(-1)?.number??Math.max(0,...result.traces.map(t=>t.attempt??0));
  if(row.expectedRuleId&&!result.traces.some(t=>t.traceType!=='policy'&&t.ruleId===row.expectedRuleId&&t.status===row.expected&&(t.stage==='pre'||!finalAttempt||t.attempt===finalAttempt)))return false;
  return true;
}
export type WorkflowChange = { label: string; detail: string; ruleId?: string };
export function workflowChanges(workflow: Workflow, previous?: Workflow, connections: Connection[]=[], previousConnections: Connection[]=[]): WorkflowChange[] {
  if(!previous)return [{label:'최초 배포',detail:'현재 초안을 첫 버전으로 배포합니다.'}];
  const changes:WorkflowChange[]=[];
  if(workflow.name!==previous.name)changes.push({label:'워크플로우 이름',detail:`${previous.name} → ${workflow.name}`});
  if(workflow.alias!==previous.alias)changes.push({label:'API 모델 이름',detail:`${previous.alias} → ${workflow.alias}`});
  if(workflow.description!==previous.description)changes.push({label:'설명 변경',detail:workflow.description||'설명 없음'});
  if(canonical(workflow.releasePolicy)!==canonical(previous.releasePolicy))changes.push({label:'배포 기준 변경',detail:workflow.releasePolicy?.requireVerification?`검증 근거 필수 / 필수 데이터셋 ${workflow.releasePolicy.requiredDatasetIds.length}개`:'검증 근거 없는 배포 허용'});
  if(workflow.mainConnectionId!==previous.mainConnectionId)changes.push({label:'응답 모델 변경',detail:`${previous.mainConnectionId} → ${workflow.mainConnectionId}`});
  if(canonical(workflow.policyRouting?policyExecutionConfiguration(workflow.policyRouting):undefined)!==canonical(previous.policyRouting?policyExecutionConfiguration(previous.policyRouting):undefined))changes.push({label:'정책 분기 변경',detail:workflow.policyRouting?`${workflow.policyRouting.policy.name} v${workflow.policyRouting.policy.version}: 판정 지시문, 출력 형식, 고정 모델 또는 실행 경로가 변경되었습니다.`:'정책 분기 사용을 해제했습니다.'});
  if(canonical(workflow.responseRetry)!==canonical(previous.responseRetry))changes.push({label:'응답 재작성 설정 변경',detail:workflow.responseRetry?.enabled?`응답 검사에서 차단되면 최대 ${workflow.responseRetry.maxRetries}회 재작성합니다.`:'응답 재작성을 사용하지 않습니다.'});
  if((workflow.inputScope??'conversation')!==(previous.inputScope??'conversation'))changes.push({label:'요청 검사 대상 변경',detail:workflow.inputScope==='last_user'?'마지막 사용자 질문만 검사합니다.':workflow.inputScope==='user_messages'?'사용자 메시지 전체를 검사합니다.':'전체 대화를 검사합니다.'});
  if(canonical(effectiveExecutionLimits(workflow))!==canonical(effectiveExecutionLimits(previous))){const limits=effectiveExecutionLimits(workflow);changes.push({label:'전체 실행 제한 변경',detail:`전체 제한 시간 ${limits.timeoutMs/1000}초 / 모델 호출 최대 ${limits.maxModelCalls}회`});}
  if(canonical(executionConfiguration(workflow).graph)!==canonical(executionConfiguration(previous).graph))changes.push({label:'실행 연결 변경',detail:workflow.graph?'조건 분기, 병렬 경로 또는 연결 설정이 변경되었습니다. 현재 흐름으로 다시 검증하세요.':'단계를 순서대로 실행하는 방식으로 변경되었습니다.'});
  else if(canonical(workflow.graph)!==canonical(previous.graph))changes.push({label:'흐름 노드 이름 변경',detail:'조건 분기나 합류의 표시 이름을 변경했습니다.'});
  for(const stage of ['pre','post'] as const){
    const label=stage==='pre'?'요청 검사':'응답 검사';
    const before=previous[stage];const after=workflow[stage];
    const beforeRules=before.flatMap(g=>g.rules.map(r=>({rule:r,group:g.id})));
    const afterRules=after.flatMap(g=>g.rules.map(r=>({rule:r,group:g.id})));
    for(const g of before)if(!after.some(a=>a.id===g.id))changes.push({label:`${label} 단계 삭제`,detail:g.name});
    for(const [index,g] of after.entries()){
      const old=before.find(a=>a.id===g.id);
      if(!old)changes.push({label:`${label} 단계 추가`,detail:g.name});
      else if(old.name!==g.name||old.mode!==g.mode||old.required!==g.required||before[index]?.id!==g.id)changes.push({label:`${label} 단계 변경`,detail:`${g.name}: ${g.mode==='any'?'하나라도 위반하면 차단':'모두 위반하면 차단'}${g.required?' / 모든 경로에서 실행':''}`});
    }
    for(const {rule} of beforeRules)if(!afterRules.some(a=>a.rule.id===rule.id))changes.push({label:'검사 삭제',detail:`${label}: ${rule.name}`,ruleId:rule.id});
    for(const item of afterRules){
      const old=beforeRules.find(a=>a.rule.id===item.rule.id);
      if(!old)changes.push({label:'검사 추가',detail:`${label}: ${item.rule.name}`,ruleId:item.rule.id});
      else if(canonical(old)!==canonical(item))changes.push({label:'검사 설정 변경',detail:`${label}: ${item.rule.name}`,ruleId:item.rule.id});
    }
  }
  for(const c of referencedConnections(workflow,connections)){
    const old=previousConnections.find(p=>p.id===c.id);
    if(old&&canonical(old)!==canonical(c)){const{name:_oldName,...oldConfiguration}=old,{name:_name,...configuration}=c;changes.push({label:canonical(oldConfiguration)===canonical(configuration)?'모델 서버 이름 변경':'모델 서버 설정 변경',detail:c.name});}
  }
  return changes;
}
