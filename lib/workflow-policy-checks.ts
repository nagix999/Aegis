import type { DatasetRow, ExecutionResult, PolicyGraphNode, PolicyRevision, PolicyRouting, Rule, RuleGroup, Workflow } from './aegis-types';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { randomUuid } from './client-id.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { bindPolicyRevision, policyRoutingErrors } from './policy-routing.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { captureInsertTarget, insertCheckOnEdge, type FlowInsertTarget } from './workflow-connections.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { getStageGraph } from './workflow-graph.ts';

export const MAX_WORKFLOW_POLICY_CHECKS=12;
export type WorkflowPolicyCheckScope={id:string;stage:'pre'|'post';routing:PolicyRouting;rule?:Rule;group?:RuleGroup};
/** IDs stored inside each immutable policy graph remain local to that check. */
export function policyScopedId(ownerId:string,localId:string):string {return ownerId==='policy'?localId:`${ownerId}/${localId}`;}
export function parsePolicyScopedId(encoded:string):{ownerId:string;localId:string} {const slash=encoded.indexOf('/');return slash<0?{ownerId:'policy',localId:encoded}:{ownerId:encoded.slice(0,slash),localId:encoded.slice(slash+1)};}
export function listWorkflowPolicyChecks(workflow:Workflow):WorkflowPolicyCheckScope[] {
  return [...(workflow.policyRouting?[{id:'policy',stage:'pre' as const,routing:workflow.policyRouting}]:[]),...(['pre','post'] as const).flatMap(stage=>(Array.isArray(workflow[stage])?workflow[stage]:[]).flatMap(group=>(Array.isArray(group?.rules)?group.rules:[]).filter(rule=>rule?.kind==='policy'&&rule.config?.policyRouting).map(rule=>({id:rule.id,stage,routing:rule.config.policyRouting!,rule,group}))))];
}
export function workflowPolicyCheck(workflow:Workflow,ownerId='policy'):WorkflowPolicyCheckScope|undefined {return listWorkflowPolicyChecks(workflow).find(scope=>scope.id===ownerId);}
export function workflowPolicyNode(workflow:Workflow,encodedId:string):{scope:WorkflowPolicyCheckScope;node:PolicyGraphNode}|undefined {
  const {ownerId,localId}=parsePolicyScopedId(encodedId),scope=workflowPolicyCheck(workflow,ownerId),node=scope?.routing.graph?.nodes.find(node=>node.id===localId);
  return scope&&node?{scope,node}:undefined;
}
export function updateWorkflowPolicyCheck(workflow:Workflow,ownerId:string,routing:PolicyRouting):Workflow {
  const next=structuredClone(workflow);
  if(ownerId==='policy'){next.policyRouting=structuredClone(routing);return next;}
  const rule=([...next.pre,...next.post].flatMap(group=>group.rules)).find(rule=>rule.id===ownerId&&rule.kind==='policy');
  if(!rule)throw new Error('정책 검사 노드를 찾을 수 없습니다.');
  rule.config.policyRouting=structuredClone(routing);return next;
}
export function policyCheckRoutingErrors(routing:PolicyRouting):string[] {
  const errors=policyRoutingErrors(routing);
  if(routing?.routes?.some(route=>route.action==='respond')||(Array.isArray(routing?.graph?.nodes)&&routing.graph.nodes.some(node=>node.kind==='action'&&node.action==='respond')))errors.push('정책 검사에서는 다음 검사 계속 또는 차단 액션을 선택하세요.');
  return [...new Set(errors)];
}
export function workflowPolicyCheckErrors(workflow:Workflow):string[] {
  const errors:string[]=[];let count=workflow.policyRouting?1:0;
  for(const stage of ['pre','post'] as const)for(const group of Array.isArray(workflow[stage])?workflow[stage]:[])for(const rule of Array.isArray(group?.rules)?group.rules:[]){
    if(!rule||!rule.config||typeof rule.config!=='object')continue;
    if(rule.kind!=='policy'){if(rule.config?.policyRouting)errors.push(`${rule.name}: 정책 설정은 정책 검사에서만 사용할 수 있습니다.`);continue;}
    count++;
    if(rule.id==='policy'||rule.id.includes('/'))errors.push('정책 검사 ID는 policy와 슬래시를 사용할 수 없습니다.');
    if(group.rules.length!==1)errors.push(`${rule.name}: 정책 검사는 단독 검사 노드로 추가하세요.`);
    if(!rule.config.policyRouting)errors.push(`${rule.name}: 적용할 정책 버전을 선택하세요.`);
    else errors.push(...policyCheckRoutingErrors(rule.config.policyRouting).map(message=>`${rule.name}: ${message}`));
  }
  if(count>MAX_WORKFLOW_POLICY_CHECKS)errors.push(`정책 검사는 기존 정책 분기를 포함해 최대 ${MAX_WORKFLOW_POLICY_CHECKS}개입니다.`);
  return [...new Set(errors)];
}
/** A new policy check never introduces a direct response action. */
export function bindPolicyCheckRevision(policy:PolicyRevision,previous?:PolicyRouting,emptyGraph=false):PolicyRouting {
  const bound=bindPolicyRevision(policy,previous?.policy.id===policy.id?previous.routes:[]);
  bound.routes=bound.routes.map(route=>route.action==='respond'?{decision:route.decision,action:'error',errorCode:route.decision,errorMessage:'정책에 따라 요청이 제한되었습니다.'}:route);
  if(policy.formatVersion===2&&previous?.policy.formatVersion===2&&policy.id===previous.policy.id&&previous.graph)bound.graph=structuredClone(previous.graph);
  else if(policy.formatVersion===2&&emptyGraph)bound.graph={version:1,entryNodeId:'',nodes:[],edges:[]};
  return bound;
}
export function addWorkflowPolicyCheck(workflow:Workflow,stage:'pre'|'post',policy:PolicyRevision,options:{target?:FlowInsertTarget;id?:string}={}):{workflow:Workflow;ruleId:string} {
  if(!['pre','post'].includes(stage))throw new Error('요청 검사 또는 응답 검사 구간을 선택하세요.');
  const count=(workflow.policyRouting?1:0)+[...workflow.pre,...workflow.post].flatMap(group=>group.rules).filter(rule=>rule.kind==='policy').length;
  if(count>=MAX_WORKFLOW_POLICY_CHECKS)throw new Error('정책 검사는 기존 정책 분기를 포함해 최대 12개입니다.');
  const ruleId=options.id??`policy-check-${randomUuid()}`;
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(ruleId)||ruleId==='policy')throw new Error('새 정책 검사 ID를 확인하세요.');
  const rule:Rule={id:ruleId,name:policy.name,description:'',kind:'policy',enabled:true,config:{policyRouting:bindPolicyCheckRevision(policy,undefined,true)}};
  const group:RuleGroup={id:`group-${randomUuid()}`,name:policy.name,mode:'any',rules:[rule]};
  const graph=getStageGraph(workflow,stage),last=graph.edges.find(edge=>edge.to==='end');
  const target=options.target??(last?captureInsertTarget(workflow,stage,last.id):undefined);
  if(!target||target.stage!==stage)throw new Error('정책 검사를 추가할 연결선을 선택하세요.');
  return {workflow:insertCheckOnEdge(workflow,target,group),ruleId};
}
/** Removing a singleton reconnects its incoming edge to its former successor. */
export function removeWorkflowPolicyCheck(workflow:Workflow,ownerId:string):Workflow {
  const next=structuredClone(workflow),scope=workflowPolicyCheck(workflow,ownerId);
  if(ownerId==='policy')delete next.policyRouting;
  else if(scope?.group){
    const graph=structuredClone(getStageGraph(workflow,scope.stage)),key=`group:${scope.group.id}`,outgoing=graph.edges.find(edge=>edge.from===key);
    graph.edges=graph.edges.filter(edge=>edge.from!==key).flatMap(edge=>edge.to===key?(outgoing?[{...edge,to:outgoing.to}]:[]):[edge]);
    next.graph??={version:1,pre:structuredClone(getStageGraph(workflow,'pre')),post:structuredClone(getStageGraph(workflow,'post'))};next.graph[scope.stage]=graph;
    next[scope.stage]=next[scope.stage].filter(group=>group.id!==scope.group!.id);
  }
  const prefix=ownerId==='policy'?undefined:`policy-node:${ownerId}/`;
  const keep=(key:string)=>ownerId==='policy'?key!=='policy'&&!(key.startsWith('policy-node:')&&!key.slice(12).includes('/')):key!==`rule:${ownerId}`&&key!==`group:${scope?.group?.id}`&&!key.startsWith(prefix!);
  if(next.layout){next.layout.positions=Object.fromEntries(Object.entries(next.layout.positions).filter(([key])=>keep(key)));if(next.layout.pinnedKeys)next.layout.pinnedKeys=next.layout.pinnedKeys.filter(keep);if(next.layout.zones)next.layout.zones=next.layout.zones.map(zone=>({...zone,nodeKeys:zone.nodeKeys.filter(keep)}));}
  return next;
}
/** Legacy criteria preserve their historical default. Ambiguous checks require an explicit choice. */
export function expectedPolicyCheck(workflow:Workflow,ownerId?:string):WorkflowPolicyCheckScope|undefined {const scopes=listWorkflowPolicyChecks(workflow);return ownerId?scopes.find(scope=>scope.id===ownerId):scopes.find(scope=>scope.id==='policy')??(scopes.length===1?scopes[0]:undefined);}
export function expectedPolicyCheckResult(workflow:Workflow|undefined,row:Pick<DatasetRow,'expectedPolicyNodeId'>,result:ExecutionResult) {
  const scope=workflow?expectedPolicyCheck(workflow,row.expectedPolicyNodeId):undefined;
  if(workflow&&!scope)return undefined;
  const ownerId=row.expectedPolicyNodeId??scope?.id;
  if(ownerId==='policy'||ownerId===undefined&&!result.policyChecks?.length)return {ruleId:'policy',stage:'pre' as const,attempt:undefined,decision:result.policyDecision,route:result.policyRoute,policyCode:result.policyCode,path:result.policyPath,fieldChecks:result.policyFieldChecks};
  if(!ownerId)return undefined;
  const checks=result.policyChecks?.filter(check=>check.ruleId===ownerId)??[],attempt=Math.max(1,...(result.attempts??[]).map(item=>item.number),...result.traces.filter(trace=>trace.stage==='post'||trace.stage==='main').map(trace=>trace.attempt??1));
  return checks.filter(check=>(check.status==='allow'||check.status==='block')&&(check.stage==='pre'||(check.attempt??1)===attempt)).at(-1);
}
