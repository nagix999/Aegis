import type { FlowEdge, RuleGroup, StageGraph, Workflow } from './aegis-types';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { createStageGraph, endpointLabel, getStageGraph, graphNodeKeys, validateWorkflowGraph } from './workflow-graph.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { CANVAS_LIMIT, NODE_HEIGHT, NODE_WIDTH, nodeDefinitions, resolveLayout, visibleLayoutKey } from './workflow-layout.ts';

export type FlowStage = 'pre'|'post';
export type FlowPort = 'next'|'true'|'false';
export type FlowInsertTarget = { stage:FlowStage; edgeId:string; from:string; to:string; port?:FlowPort; workflowId?:string };
export type FlowConnectionProblem = { endpoint:string; kind:'unreachable'|'dead_end'|'incoming'|'outgoing'|'required'; message:string; suggestion:string; introduced:boolean };
export type FlowConnectionImpact = { stage:FlowStage; removedEdges:FlowEdge[]; addedEdges:FlowEdge[]; problems:FlowConnectionProblem[]; affectedEndpoints:string[] };
export type FlowConnectionChanges = { before:FlowEdge|null; after:FlowEdge; warnings:string[]; validationMessages:string[]; impact:FlowConnectionImpact };
export type FlowConnectionPreview = { valid:boolean; reason?:string; existingEdge?:FlowEdge; replace:boolean; changes?:FlowConnectionChanges };

type Position = {x:number;y:number};
const MAX_GROUPS=36;
const MAX_CONTROLS=12;
const MAX_EDGES=64;
function requireValue(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(message);}
function validStage(value:unknown):value is FlowStage{return value==='pre'||value==='post';}
function validPort(value:unknown):value is FlowPort{return value==='next'||value==='true'||value==='false';}
function effectivePort(edge:Pick<FlowEdge,'port'>):FlowPort{return edge.port??'next';}
function safeId(value:unknown,limit=120):value is string{return typeof value==='string'&&value.length>0&&value.length<=limit&&value===value.trim();}
function stageGraph(workflow:Workflow,stage:FlowStage):StageGraph {
  requireValue(validStage(stage),'요청 검사 또는 응답 검사 단계를 선택하세요.');
  requireValue(workflow&&Array.isArray(workflow.pre)&&Array.isArray(workflow.post),'워크플로우의 검사 목록을 확인하세요.');
  requireValue(!workflow.graph||workflow.graph.version===1,'지원하지 않는 그래프 버전입니다.');
  const graph=getStageGraph(workflow,stage);
  requireValue(graph&&Array.isArray(graph.nodes)&&Array.isArray(graph.edges),'그래프의 노드와 연결선을 확인하세요.');
  requireValue(workflow[stage].length<=MAX_GROUPS,'한 단계에는 검사 노드를 최대 36개까지 추가할 수 있습니다.');
  requireValue(graph.nodes.length<=MAX_CONTROLS,'한 단계에는 제어 노드를 최대 12개까지 추가할 수 있습니다.');
  requireValue(graph.edges.length<=MAX_EDGES,'한 단계에는 연결선을 최대 64개까지 추가할 수 있습니다.');
  const keys=graphNodeKeys(workflow,stage);
  requireValue(new Set(keys).size===keys.length,'노드 ID가 중복되어 연결할 대상을 구분할 수 없습니다.');
  requireValue(graph.nodes.every(node=>node&&['condition','fork','join'].includes(node.kind)),'제어 노드의 종류를 확인하세요.');
  return graph;
}
function sourceKind(graph:StageGraph,from:string):string {
  if(from==='start'||from==='end')return from;
  if(from.startsWith('group:'))return 'group';
  return graph.nodes.find(node=>`control:${node.id}`===from)?.kind??'unknown';
}
function checkEndpoints(workflow:Workflow,stage:FlowStage,graph:StageGraph,from:string,to:string,port:FlowPort|undefined) {
  requireValue(typeof from==='string'&&typeof to==='string','연결할 출발 노드와 도착 노드를 선택하세요.');
  const keys=new Set(graphNodeKeys(workflow,stage));
  requireValue(keys.has(from)&&keys.has(to),'같은 단계에 있는 노드끼리 연결하세요. 없는 노드나 다른 단계의 노드는 연결할 수 없습니다.');
  requireValue(from!==to,'노드를 자기 자신에게 연결할 수 없습니다.');
  requireValue(from!=='end'&&to!=='start','완료 노드에서 나가거나 시작 노드로 들어오는 연결은 만들 수 없습니다.');
  requireValue(port===undefined||validPort(port),'연결 포트는 next, true, false 중에서 선택하세요.');
  const kind=sourceKind(graph,from);
  if(kind==='condition')requireValue(port==='true'||port==='false','조건 노드에서는 true 또는 false 포트를 선택하세요.');
  else requireValue((port??'next')==='next','이 노드에서는 next 포트만 사용할 수 있습니다.');
}
function graphHasCycle(keys:string[],edges:FlowEdge[]):boolean {
  const indegree=new Map(keys.map(key=>[key,0]));
  const outgoing=new Map(keys.map(key=>[key,[] as string[]]));
  for(const edge of edges){
    if(!indegree.has(edge.from)||!indegree.has(edge.to))continue;
    indegree.set(edge.to,indegree.get(edge.to)!+1);outgoing.get(edge.from)!.push(edge.to);
  }
  const ready=keys.filter(key=>indegree.get(key)===0);let visited=0;
  while(ready.length){const current=ready.pop()!;visited++;for(const next of outgoing.get(current)!){indegree.set(next,indegree.get(next)!-1);if(indegree.get(next)===0)ready.push(next);}}
  return visited!==keys.length;
}
function checkStructuralEdges(workflow:Workflow,stage:FlowStage,graph:StageGraph) {
  requireValue(graph.edges.length<=MAX_EDGES,'한 단계에는 연결선을 최대 64개까지 추가할 수 있습니다.');
  const ids=new Set<string>();const pairs=new Set<string>();
  for(const edge of graph.edges){
    requireValue(edge&&safeId(edge.id),'연결선 ID를 확인하세요.');
    requireValue(!ids.has(edge.id),'연결선 ID가 중복되어 있습니다.');ids.add(edge.id);
    checkEndpoints(workflow,stage,graph,edge.from,edge.to,edge.port);
    const pair=JSON.stringify([edge.from,edge.to,effectivePort(edge)]);
    requireValue(!pairs.has(pair),'같은 노드와 포트 사이에 이미 연결선이 있습니다.');pairs.add(pair);
  }
  requireValue(!graphHasCycle(graphNodeKeys(workflow,stage),graph.edges),'이 연결은 순환을 만듭니다. 이전 노드로 돌아가는 연결은 사용할 수 없습니다.');
}
function materialized(workflow:Workflow):Workflow {
  const copy=structuredClone(workflow);
  if(!copy.graph)copy.graph={version:1,pre:structuredClone(createStageGraph(workflow.pre)),post:structuredClone(createStageGraph(workflow.post))};
  return copy;
}
function freeEdgeId(workflow:Workflow):string {
  const used=new Set((['pre','post'] as const).flatMap(stage=>getStageGraph(workflow,stage).edges.map(edge=>edge.id)));
  let number=1;while(used.has(`connection-${number}`))number++;
  return `connection-${number}`;
}
function stageIssues(workflow:Workflow,stage:FlowStage):string[] {
  // Validate the edited stage independently of incomplete wiring in the other
  // stage. Its control IDs remain covered by the full validation shown in UI.
  const copy=structuredClone(workflow);const other=stage==='pre'?'post':'pre';
  copy.graph={version:1,pre:structuredClone(getStageGraph(workflow,'pre')),post:structuredClone(getStageGraph(workflow,'post'))};
  copy.graph[other]=createStageGraph(copy[other]);
  return validateWorkflowGraph(copy);
}

function connectedKeys(start:string,edges:FlowEdge[],reverse=false,excluded?:string):Set<string> {
  const visited=new Set<string>();const ready=[start];
  while(ready.length){const current=ready.pop()!;if(current===excluded||visited.has(current))continue;visited.add(current);for(const edge of edges)if((reverse?edge.to:edge.from)===current)ready.push(reverse?edge.from:edge.to);}
  return visited;
}

/** Structural repair hints for the current draft, without changing its graph. */
export function getConnectionProblems(workflow:Workflow,stage:FlowStage):FlowConnectionProblem[] {
  const graph=getStageGraph(workflow,stage),keys=graphNodeKeys(workflow,stage);
  const reached=connectedKeys('start',graph.edges),finishes=connectedKeys('end',graph.edges,true);
  const problems:FlowConnectionProblem[]=[];
  const add=(endpoint:string,kind:FlowConnectionProblem['kind'],message:string,suggestion:string)=>problems.push({endpoint,kind,message,suggestion,introduced:false});
  for(const endpoint of keys){
    const label=endpoint==='start'?(stage==='pre'?'최초 입력':'응답 생성 모델'):endpoint==='end'?(stage==='pre'?'응답 생성 모델':'최종 출력'):endpointLabel(workflow,stage,endpoint),kind=sourceKind(graph,endpoint);
    const incoming=graph.edges.filter(edge=>edge.to===endpoint),outgoing=graph.edges.filter(edge=>edge.from===endpoint);
    if(endpoint!=='start'&&!reached.has(endpoint))add(endpoint,'unreachable',`${label}에 도달하는 경로가 없습니다.`,'앞선 노드에서 이 노드로 이어지는 연결을 확인하세요.');
    if(endpoint!=='end'&&!finishes.has(endpoint))add(endpoint,'dead_end',`${label}에서 ${stage==='pre'?'응답 생성 모델':'최종 출력'}까지 이어지는 경로가 없습니다.`,'이 노드 뒤의 연결을 완료 지점까지 이어 주세요.');
    const minIn=kind==='start'?0:kind==='join'?2:1,maxIn=kind==='start'?0:kind==='join'?4:1;
    if(incoming.length<minIn||incoming.length>maxIn)add(endpoint,'incoming',`${label}의 들어오는 연결은 ${minIn===maxIn?`${minIn}개`:`${minIn}~${maxIn}개`}여야 합니다.`,incoming.length<minIn?'들어오는 연결을 추가하세요.':'중복 입력을 정리하세요. 여러 경로를 모으려면 결과 합류 노드를 사용하세요.');
    const minOut=kind==='end'?0:kind==='condition'||kind==='fork'?2:1,maxOut=kind==='end'?0:kind==='fork'?4:kind==='condition'?2:1;
    const wrongConditionPorts=kind==='condition'&&(outgoing.filter(edge=>effectivePort(edge)==='true').length!==1||outgoing.filter(edge=>effectivePort(edge)==='false').length!==1);
    if(outgoing.length<minOut||outgoing.length>maxOut||wrongConditionPorts)add(endpoint,'outgoing',kind==='condition'?`${label}의 조건 충족과 그 외 경로는 각각 하나여야 합니다.`:`${label}의 나가는 연결은 ${minOut===maxOut?`${minOut}개`:`${minOut}~${maxOut}개`}여야 합니다.`,kind==='condition'?'조건 충족과 그 외 경로를 각각 연결하세요.':outgoing.length<minOut?'나가는 연결을 추가하세요.':'나가는 연결을 정리하세요. 동시에 실행하려면 병렬 분기 노드를 사용하세요.');
    const group=endpoint.startsWith('group:')?workflow[stage].find(item=>`group:${item.id}`===endpoint):undefined;
    if(group?.required&&connectedKeys('start',graph.edges,false,endpoint).has('end'))add(endpoint,'required',`${label}을 거치지 않는 경로가 있습니다.`,'모든 경로에서 실행할 검사는 분기 전이나 결과 합류 뒤에 배치하세요.');
  }
  return problems;
}

/** Compare exact edge edits with the original draft, including fork retargets. */
export function connectionImpact(workflow:Workflow,stage:FlowStage,removedEdges:FlowEdge[],addedEdges:FlowEdge[]):FlowConnectionImpact {
  const copy=materialized(workflow),removed=new Set(removedEdges.map(edge=>edge.id));
  copy.graph![stage].edges=[...copy.graph![stage].edges.filter(edge=>!removed.has(edge.id)),...structuredClone(addedEdges)];
  const before=new Set(getConnectionProblems(workflow,stage).map(problem=>`${problem.endpoint}|${problem.kind}`));
  const problems=getConnectionProblems(copy,stage).map(problem=>({...problem,introduced:!before.has(`${problem.endpoint}|${problem.kind}`)}));
  return {stage,removedEdges:structuredClone(removedEdges),addedEdges:structuredClone(addedEdges),problems,affectedEndpoints:[...new Set([...removedEdges,...addedEdges].flatMap(edge=>[edge.from,edge.to]).concat(problems.filter(problem=>problem.introduced).map(problem=>problem.endpoint)))]};
}
function insertionPosition(workflow:Workflow,stage:FlowStage,edge:FlowEdge,preferred?:Position):{positions:Record<string,Position>;position:Position} {
  const resolved=resolveLayout(workflow);
  const visible=nodeDefinitions(workflow);
  // Anchor the cards as they are currently displayed before graph ranks change.
  // Saved hidden legacy coordinates remain byte-for-byte equivalent in value.
  const positions=structuredClone(workflow.layout?.positions??{});
  for(const node of visible)if(!positions[node.key])positions[node.key]={...resolved[node.key]};
  const endpoint=(key:string):Position|undefined=>{
    const layoutKey=key==='start'?(stage==='pre'?'input':'main'):key==='end'?(stage==='pre'?'main':'output'):visibleLayoutKey(workflow,key);
    return layoutKey?resolved[layoutKey]:undefined;
  };
  const from=endpoint(edge.from),to=endpoint(edge.to);
  const initial=preferred??(from&&to?{x:(from.x+to.x)/2,y:(from.y+to.y)/2}:from?{x:from.x+NODE_WIDTH+32,y:from.y}:{x:64,y:64});
  const clamp=(value:number)=>Math.max(0,Math.min(CANVAS_LIMIT,value));
  const origin={x:clamp(initial.x),y:clamp(initial.y)};
  const cards=visible.map(node=>positions[node.key]);const gap=16;
  const intersects=(candidate:Position)=>cards.some(card=>candidate.x<card.x+NODE_WIDTH+gap&&candidate.x+NODE_WIDTH+gap>card.x&&candidate.y<card.y+NODE_HEIGHT+gap&&candidate.y+NODE_HEIGHT+gap>card.y);
  const ordered=(values:number[],originValue:number)=>[...new Set(values.map(clamp))].sort((a,b)=>Math.abs(a-originValue)-Math.abs(b-originValue)||(a>=originValue?-1:1)-(b>=originValue?-1:1));
  const xs=ordered([origin.x,...cards.flatMap(card=>[card.x+NODE_WIDTH+gap,card.x-NODE_WIDTH-gap]),0,CANVAS_LIMIT],origin.x);
  const ys=ordered([origin.y,...cards.flatMap(card=>[card.y+NODE_HEIGHT+gap,card.y-NODE_HEIGHT-gap]),0,CANVAS_LIMIT],origin.y);
  let best:Position|undefined;let distance=Infinity;
  for(const x of xs){
    if(Math.abs(x-origin.x)>distance)break;
    for(const y of ys){
      const cost=Math.abs(x-origin.x)+Math.abs(y-origin.y);
      if(cost>distance)break;
      if(!intersects({x,y})&&cost<distance){best={x,y};distance=cost;}
    }
  }
  requireValue(best,'기존 노드와 겹치지 않는 위치를 찾지 못했습니다. 캔버스에 공간을 만든 뒤 다시 삽입하세요.');
  return {positions,position:best};
}

export function captureInsertTarget(workflow:Workflow,stage:FlowStage,edgeId:string):FlowInsertTarget {
  const graph=stageGraph(workflow,stage);
  requireValue(safeId(edgeId),'삽입할 연결선을 선택하세요.');
  const candidates=graph.edges.filter(edge=>edge.id===edgeId);
  requireValue(candidates.length===1,'삽입할 연결선을 찾을 수 없거나 같은 ID의 연결선이 여러 개 있습니다.');
  const edge=candidates[0];checkEndpoints(workflow,stage,graph,edge.from,edge.to,edge.port);
  return {stage,edgeId:edge.id,from:edge.from,to:edge.to,...(edge.port!==undefined?{port:edge.port}:{}),workflowId:workflow.id};
}

/** Inserts a singleton check on one captured edge without editing other paths. */
export function insertCheckOnEdge(workflow:Workflow,target:FlowInsertTarget,newGroup:RuleGroup,position?:Position):Workflow {
  requireValue(target&&validStage(target.stage),'삽입할 단계를 확인하세요.');
  requireValue(target.workflowId===undefined||target.workflowId===workflow.id,'삽입할 워크플로우가 변경되었습니다. 현재 연결선을 다시 선택하세요.');
  const graph=stageGraph(workflow,target.stage);
  const current=captureInsertTarget(workflow,target.stage,target.edgeId);
  requireValue(target.port===undefined||validPort(target.port),'삽입 위치의 연결 포트를 확인하세요.');
  requireValue(current.from===target.from&&current.to===target.to&&effectivePort(current)===effectivePort(target),'삽입할 연결이 변경되었습니다. 현재 연결선을 다시 선택하세요.');
  requireValue(workflow[target.stage].length<MAX_GROUPS,'한 단계에는 검사 노드를 최대 36개까지 추가할 수 있습니다.');
  requireValue(graph.edges.length<MAX_EDGES,'검사를 삽입하면 연결선 한도 64개를 초과합니다.');
  requireValue(newGroup&&safeId(newGroup.id,100)&&typeof newGroup.name==='string'&&newGroup.name.trim().length>0&&newGroup.name.length<=100&&['any','all'].includes(newGroup.mode)&&Array.isArray(newGroup.rules)&&newGroup.rules.length===1,'새 검사는 고유한 ID와 이름, 규칙 하나를 가진 검사 노드여야 합니다.');
  requireValue(safeId(newGroup.rules[0]?.id,100),'새 규칙의 ID를 확인하세요.');
  const usedIds=new Set((['pre','post'] as const).flatMap(stage=>[...workflow[stage].flatMap(group=>[group.id,...group.rules.map(rule=>rule.id)]),...getStageGraph(workflow,stage).nodes.map(node=>node.id)]));
  requireValue(newGroup.id!==newGroup.rules[0].id&&!usedIds.has(newGroup.id)&&!usedIds.has(newGroup.rules[0].id),'새 검사와 규칙의 ID는 기존 노드 ID와 달라야 합니다.');
  if(position)requireValue(Number.isFinite(position.x)&&Number.isFinite(position.y)&&position.x>=0&&position.x<=40000&&position.y>=0&&position.y<=40000,'노드 위치는 0~40,000 사이의 좌표로 지정하세요.');
  const wasValid=stageIssues(workflow,target.stage).length===0;
  const copy=materialized(workflow);const edited=copy.graph![target.stage];
  const edgeIndex=edited.edges.findIndex(edge=>edge.id===target.edgeId);const old=edited.edges[edgeIndex];
  const incoming={...old,to:`group:${newGroup.id}`};
  const outgoing:FlowEdge={id:freeEdgeId(workflow),from:`group:${newGroup.id}`,to:old.to,port:'next'};
  edited.edges.splice(edgeIndex,1,incoming,outgoing);
  let index=copy[target.stage].findIndex(group=>`group:${group.id}`===old.from);
  if(index>=0)index++;
  else {
    // Choose a nearby preceding group for stable persistence ordering. The
    // graph edges, rather than array order, remain authoritative at execution.
    const visited=new Set<string>();let frontier=[old.from];let preceding=-1;
    while(frontier.length&&preceding<0){const layer=frontier;frontier=[];for(const key of layer){if(visited.has(key))continue;visited.add(key);const found=copy[target.stage].findIndex(group=>`group:${group.id}`===key);if(found>=0){preceding=found;break;}frontier.push(...graph.edges.filter(edge=>edge.to===key).map(edge=>edge.from));}}
    index=preceding>=0?preceding+1:copy[target.stage].findIndex(group=>`group:${group.id}`===old.to);
    if(index<0)index=old.from==='start'?0:copy[target.stage].length;
  }
  copy[target.stage].splice(index,0,structuredClone(newGroup));
  const placement=insertionPosition(workflow,target.stage,old,position);
  copy.layout??={version:1,positions:{}};copy.layout.positions=placement.positions;
  copy.layout.positions[`rule:${newGroup.rules[0].id}`]={...placement.position};
  checkStructuralEdges(copy,target.stage,edited);
  if(wasValid){const issues=stageIssues(copy,target.stage);requireValue(!issues.length,issues[0]??'검사를 삽입한 그래프를 확인하세요.');}
  return copy;
}

/**
 * Previews one source-port edit. Occupied target inputs are warnings because
 * rewiring can temporarily leave a draft incomplete; validation still blocks
 * saving or running until cardinalities and reachability are repaired.
 */
export function previewConnection(workflow:Workflow,stage:FlowStage,from:string,to:string,port?:FlowPort):FlowConnectionPreview {
  let existing:FlowEdge|undefined;let replace=false;
  try {
    const graph=stageGraph(workflow,stage);checkEndpoints(workflow,stage,graph,from,to,port);
    const kind=sourceKind(graph,from);const sourceEdges=graph.edges.filter(edge=>edge.from===from);
    const slot=sourceEdges.filter(edge=>effectivePort(edge)===(port??'next'));
    if(kind==='fork') {
      requireValue(!sourceEdges.some(edge=>edge.to===to),'이 병렬 분기에는 이미 같은 노드로 가는 연결선이 있습니다.');
      requireValue(sourceEdges.length<4,'병렬 분기는 서로 다른 노드로 최대 4개까지 연결할 수 있습니다.');
    } else {
      requireValue(slot.length<=1,'같은 출발 포트의 연결선이 여러 개입니다. 중복 연결을 먼저 정리하세요.');
      existing=slot[0];replace=!!existing;
      requireValue(!existing||existing.to!==to,'이 포트는 이미 선택한 노드와 연결되어 있습니다.');
    }
    const after:FlowEdge=existing?{...existing,to,...(port!==undefined?{port}:{})}:{id:freeEdgeId(workflow),from,to,port:port??'next'};
    const copy=materialized(workflow);const next=copy.graph![stage];
    next.edges=existing?next.edges.map(edge=>edge.id===existing!.id?{...after}:edge):[...next.edges,after];
    checkStructuralEdges(copy,stage,next);
    const warnings:string[]=[];
    const occupied=graph.edges.filter(edge=>edge.to===to&&edge.id!==existing?.id);
    const targetKind=sourceKind(graph,to);
    if((targetKind!=='join'&&occupied.length>0)||(targetKind==='join'&&occupied.length>=4))warnings.push(`${endpointLabel(workflow,stage,to)}에는 이미 들어오는 연결이 있습니다. 재배선을 마친 뒤 연결 수를 확인하세요.`);
    const validationMessages=validateWorkflowGraph(copy);
    const impact=connectionImpact(workflow,stage,existing?[existing]:[],[after]);
    return {valid:true,...(existing?{existingEdge:{...existing}}:{}),replace,changes:{before:existing?{...existing}:null,after:{...after},warnings,validationMessages,impact}};
  } catch(error) {
    return {valid:false,reason:error instanceof Error?error.message:'연결할 수 없는 노드입니다.',...(existing?{existingEdge:{...existing}}:{}),replace};
  }
}

export function applyConnection(workflow:Workflow,stage:FlowStage,from:string,to:string,port?:FlowPort):Workflow {
  const preview=previewConnection(workflow,stage,from,to,port);
  requireValue(preview.valid&&preview.changes,preview.reason??'연결 설정을 확인하세요.');
  const copy=materialized(workflow);const graph=copy.graph![stage];
  graph.edges=preview.existingEdge?graph.edges.map(edge=>edge.id===preview.existingEdge!.id?{...preview.changes!.after}:edge):[...graph.edges,{...preview.changes.after}];
  return copy;
}
