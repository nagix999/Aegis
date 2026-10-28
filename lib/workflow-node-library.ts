import type { FlowControlNode, RuleGroup, Workflow } from './aegis-types';
// @ts-expect-error Node's source test runner resolves explicit TypeScript paths.
import { captureInsertTarget, type FlowInsertTarget, type FlowStage } from './workflow-connections.ts';
// @ts-expect-error Node's source test runner resolves explicit TypeScript paths.
import { getStageGraph } from './workflow-graph.ts';

type ControlOptions = {target?:FlowInsertTarget;id?:string};
const names:Record<FlowControlNode['kind'],string>={condition:'조건 분기',fork:'병렬 분기',join:'결과 합류'};
function requireThat(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
function validateStage(workflow:Workflow,stage:FlowStage){
  requireThat(stage==='pre'||stage==='post','요청 검사 또는 응답 검사 구간을 선택하세요.');
  requireThat(!workflow.graph||workflow.graph.version===1,'지원하지 않는 워크플로우 그래프 버전입니다.');
}
function uniqueNodeId(workflow:Workflow,nodeId:unknown):asserts nodeId is string {
  requireThat(typeof nodeId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(nodeId)&&!['__proto__','constructor','prototype'].includes(nodeId),'새 노드의 ID를 확인하세요.');
  const usedIds=new Set((['pre','post'] as const).flatMap(item=>[...workflow[item].flatMap(group=>[group.id,...group.rules.map(rule=>rule.id)]),...getStageGraph(workflow,item).nodes.map(node=>node.id)]));
  requireThat(!usedIds.has(nodeId),'새 노드의 ID는 기존 노드 및 규칙 ID와 달라야 합니다.');
}
function capturedTarget(workflow:Workflow,stage:FlowStage,original?:FlowInsertTarget):FlowInsertTarget|undefined {
  if(!original)return undefined;
  requireThat(original.stage===stage,'선택한 연결선과 같은 검사 구간에 노드를 추가하세요.');
  requireThat(original.workflowId===undefined||original.workflowId===workflow.id,'노드를 추가할 워크플로우가 변경되었습니다. 현재 연결선을 다시 선택하세요.');
  requireThat(original.port===undefined||['next','true','false'].includes(original.port),'선택한 연결선의 포트를 확인하세요.');
  const target=captureInsertTarget(workflow,stage,original.edgeId);
  requireThat(target.from===original.from&&target.to===original.to&&(target.port??'next')===(original.port??'next'),'노드를 추가할 연결이 변경되었습니다. 현재 연결선을 다시 선택하세요.');
  return target;
}
function materialize(workflow:Workflow):Workflow {
  const next=structuredClone(workflow);
  next.graph={version:1,pre:structuredClone(getStageGraph(workflow,'pre')),post:structuredClone(getStageGraph(workflow,'post'))};
  return next;
}
function insertOnTarget(next:Workflow,stage:FlowStage,target:FlowInsertTarget,endpoint:string,condition=false){
  const edited=next.graph![stage],index=edited.edges.findIndex(edge=>edge.id===target.edgeId),old=edited.edges[index];
  const edgeIds=new Set((['pre','post'] as const).flatMap(item=>next.graph![item].edges.map(edge=>edge.id)));
  let counter=0;
  const edgeId=()=>{let candidate:string;do{candidate=`library-edge-${++counter}`;}while(edgeIds.has(candidate));edgeIds.add(candidate);return candidate;};
  edited.edges[index]={...old,to:endpoint};
  if(condition)edited.edges.push({id:edgeId(),from:endpoint,to:old.to,port:'true'},{id:edgeId(),from:endpoint,to:old.to,port:'false'});
  else edited.edges.push({id:edgeId(),from:endpoint,to:old.to,port:'next'});
}

/**
 * Every control can be created from the node library as an unfinished draft.
 * Inserting on an edge preserves its destination, source port and other paths.
 * The usual workflow validator still requires complete branches before save/run.
 */
export function addWorkflowControlNode(workflow:Workflow,stage:FlowStage,kind:FlowControlNode['kind'],options:ControlOptions={}):{workflow:Workflow;nodeId:string} {
  validateStage(workflow,stage);
  requireThat(['condition','fork','join'].includes(kind),'조건 분기, 병렬 분기 또는 결과 합류를 선택하세요.');
  const graph=getStageGraph(workflow,stage);
  requireThat(graph.nodes.length<12,'한 구간의 제어 노드는 최대 12개입니다.');
  const nodeId=options.id===undefined?`control-${crypto.randomUUID()}`:options.id;
  uniqueNodeId(workflow,nodeId);
  const target=capturedTarget(workflow,stage,options.target);
  const extraEdges=target?(kind==='condition'?2:1):0;
  requireThat(graph.edges.length+extraEdges<=64,'제어 노드를 추가하면 연결선 한도 64개를 초과합니다.');
  const next=materialize(workflow);
  const node:FlowControlNode={id:nodeId,name:names[kind],kind,...(kind==='condition'?{condition:{operator:'contains' as const,value:'',caseSensitive:false}}:{})};
  next.graph![stage].nodes.push(node);
  if(target)insertOnTarget(next,stage,target,`control:${nodeId}`,kind==='condition');
  return {workflow:next,nodeId};
}

/** An empty check combination is editable, but cannot silently become an active check. */
export function addWorkflowCheckGroup(workflow:Workflow,stage:FlowStage,options:ControlOptions={}):{workflow:Workflow;groupId:string} {
  validateStage(workflow,stage);
  requireThat(workflow[stage].length<36,'한 구간의 검사 노드는 최대 36개입니다.');
  const groupId=options.id===undefined?`group-${crypto.randomUUID()}`:options.id;uniqueNodeId(workflow,groupId);
  const target=capturedTarget(workflow,stage,options.target);
  requireThat(getStageGraph(workflow,stage).edges.length+(target?1:0)<=64,'검사 조합을 추가하면 연결선 한도 64개를 초과합니다.');
  const next=materialize(workflow),group:RuleGroup={id:groupId,name:'새 검사 조합',mode:'any',rules:[]};
  next[stage].push(group);
  if(target)insertOnTarget(next,stage,target,`group:${groupId}`);
  return {workflow:next,groupId};
}
