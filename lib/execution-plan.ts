import type { ConversationMessage, ExecutionLimits, FlowControlNode, FlowEdge, RuleGroup, StageGraph, Workflow } from './aegis-types';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { getStageGraph, graphNodeKeys, validateWorkflowGraph } from './workflow-graph.ts';

export const DEFAULT_EXECUTION_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_MODEL_CALLS = 64;
export const MAX_EXECUTION_TIMEOUT_MS = 600_000;
export const MAX_MODEL_CALLS = 1_000;

export function effectiveExecutionLimits(workflow: Pick<Workflow,'executionLimits'>): ExecutionLimits {
  return workflow.executionLimits ?? {timeoutMs:DEFAULT_EXECUTION_TIMEOUT_MS,maxModelCalls:DEFAULT_MAX_MODEL_CALLS};
}
export function executionLimitIssues(workflow: Pick<Workflow,'executionLimits'|'inputScope'>): string[] {
  const issues:string[]=[];
  if(workflow.inputScope!==undefined&&!['conversation','user_messages','last_user'].includes(workflow.inputScope))issues.push('요청 검사 대상을 다시 선택하세요.');
  if(workflow.executionLimits!==undefined){
    const limits=workflow.executionLimits;
    if(!limits||typeof limits!=='object'||Array.isArray(limits))return [...issues,'전체 실행 제한을 확인하세요.'];
    if(!Number.isInteger(limits.timeoutMs)||limits.timeoutMs<1_000||limits.timeoutMs>MAX_EXECUTION_TIMEOUT_MS)issues.push('전체 실행 제한 시간은 1~600초로 설정하세요.');
    if(!Number.isInteger(limits.maxModelCalls)||limits.maxModelCalls<1||limits.maxModelCalls>MAX_MODEL_CALLS)issues.push('모델 호출 한도는 1~1,000회로 설정하세요.');
  }
  return issues;
}
export function requestInspectionText(workflow: Pick<Workflow,'inputScope'>,messages:ConversationMessage[]):string {
  const users=messages.filter(message=>message.role==='user');
  const selected=workflow.inputScope==='last_user'?users.slice(-1):workflow.inputScope==='user_messages'?users:messages;
  // Omitted scope preserves existing workflows exactly. The original messages
  // with roles are always retained for generation; this selects inspection only.
  return selected.map(message=>message.content).join('\n');
}

export type ExecutionStagePlan = {
  graph:StageGraph; keys:string[]; groups:RuleGroup[];
  groupsByKey:Map<string,RuleGroup>; controlsByKey:Map<string,FlowControlNode>;
  incoming:Map<string,FlowEdge[]>; outgoing:Map<string,FlowEdge[]>;
};
export type ExecutionPlan = {workflow:Workflow;pre:ExecutionStagePlan;post:ExecutionStagePlan;limits:ExecutionLimits};
/** Snapshot and normalize the validated graph once per run, including legacy
 * serial workflows. Layout and areas never enter scheduling decisions. */
export function createExecutionPlan(definition:Workflow):ExecutionPlan {
  const issues=[...executionLimitIssues(definition),...validateWorkflowGraph(definition)];
  if(issues.length)throw new Error(issues[0]);
  const workflow=structuredClone(definition);
  const prepare=(stage:'pre'|'post'):ExecutionStagePlan=>{
    const graph=getStageGraph(workflow,stage),keys=graphNodeKeys(workflow,stage);
    return {graph,keys,groups:workflow[stage],groupsByKey:new Map(workflow[stage].map(group=>[`group:${group.id}`,group])),controlsByKey:new Map(graph.nodes.map(node=>[`control:${node.id}`,node])),
      incoming:new Map(keys.map(key=>[key,graph.edges.filter(edge=>edge.to===key)])),outgoing:new Map(keys.map(key=>[key,graph.edges.filter(edge=>edge.from===key)]))};
  };
  return {workflow,pre:prepare('pre'),post:prepare('post'),limits:effectiveExecutionLimits(workflow)};
}
