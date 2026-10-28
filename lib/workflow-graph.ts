import type { FlowControlNode, FlowEdge, RuleGroup, StageGraph, Workflow } from './aegis-types';

type Stage = 'pre'|'post';
type Condition = NonNullable<FlowControlNode['condition']>;
const LIMITS = { groups:36, controls:12, edges:64, id:120, endpoint:150, name:100, condition:2000 };

function record(value: unknown): value is Record<string,unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim().length > 0;
}
function groupsFor(workflow: Workflow, stage: Stage): RuleGroup[] {
  return Array.isArray(workflow?.[stage]) ? workflow[stage] : [];
}

export function createStageGraph(groups: RuleGroup[]): StageGraph {
  const usable=Array.isArray(groups)?groups.filter(group=>record(group)&&typeof group.id==='string'):[];
  const keys = ['start',...usable.map(group=>`group:${group.id}`),'end'];
  return {nodes:[],edges:keys.slice(0,-1).map((from,index)=>({id:`serial-${index+1}`,from,to:keys[index+1],port:'next' as const}))};
}

export function getStageGraph(workflow: Workflow, stage: Stage): StageGraph {
  return workflow.graph?.[stage] ?? createStageGraph(groupsFor(workflow,stage));
}

export function graphNodeKeys(workflow: Workflow, stage: Stage): string[] {
  const graph = getStageGraph(workflow,stage);
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes.filter(node=>record(node)&&typeof node.id==='string') : [];
  return ['start',...groupsFor(workflow,stage).map(group=>`group:${group.id}`),...nodes.map(node=>`control:${node.id}`),'end'];
}

export function endpointLabel(workflow: Workflow, stage: Stage, key: string): string {
  if(key==='start')return stage==='pre'?'요청 입력':'모델 응답';
  if(key==='end')return stage==='pre'?'요청 검사 완료':'응답 검사 완료';
  if(typeof key!=='string')return '알 수 없는 노드';
  if(key.startsWith('group:')){const group=groupsFor(workflow,stage).find(group=>record(group)&&group.id===key.slice(6));const name=group&&Array.isArray(group.rules)&&group.rules.length===1?group.rules[0]?.name:group?.name;return typeof name==='string'?name:key;}
  if(key.startsWith('control:')){const nodes=getStageGraph(workflow,stage)?.nodes;const name=Array.isArray(nodes)?nodes.find(node=>record(node)&&node.id===key.slice(8))?.name:undefined;return typeof name==='string'?name:key;}
  return key;
}

function conditionError(condition: unknown): string | null {
  if(!record(condition) || typeof condition.operator!=='string' || !['contains','not_contains','length_gte','length_lte'].includes(condition.operator))return '조건 연산자를 선택하세요.';
  if(typeof condition.value!=='string' || condition.value.length>LIMITS.condition)return '조건 값은 2,000자 이내 문자열로 입력하세요.';
  if(condition.caseSensitive!==undefined && typeof condition.caseSensitive!=='boolean')return '조건의 대소문자 구분 설정을 확인하세요.';
  if(condition.operator==='contains' || condition.operator==='not_contains')return condition.value.length>0 ? null : '포함 여부를 검사할 문구를 입력하세요.';
  if(!/^(?:0|[1-9]\d*)$/.test(condition.value) || Number(condition.value)>40000)return '길이 조건은 0~40,000 사이의 정수를 입력하세요. 앞자리 0이나 소수는 사용할 수 없습니다.';
  return null;
}

export function conditionMatches(condition: Condition, input: string): boolean {
  if(conditionError(condition) || typeof input!=='string')return false;
  if(condition.operator==='length_gte')return input.length>=Number(condition.value);
  if(condition.operator==='length_lte')return input.length<=Number(condition.value);
  const source=condition.caseSensitive ? input : input.toLowerCase();
  const needle=condition.caseSensitive ? condition.value : condition.value.toLowerCase();
  const matches=source.includes(needle);
  return condition.operator==='contains' ? matches : !matches;
}

function reachable(start:string, outgoing:Map<string,string[]>, avoid?:string):Set<string> {
  const visited=new Set<string>();
  const stack=start===avoid?[]:[start];
  while(stack.length){
    const key=stack.pop()!;
    if(visited.has(key) || key===avoid)continue;
    visited.add(key);
    for(const next of outgoing.get(key)??[])if(next!==avoid)stack.push(next);
  }
  return visited;
}

function validateStage(workflow:Workflow,stage:Stage,graph:unknown):string[]{
  const prefix=stage==='pre'?'요청 검사':'응답 검사';
  const errors:string[]=[];
  const issue=(message:string)=>errors.push(`${prefix}: ${message}`);
  const rawGroups=workflow[stage] as unknown;
  if(!Array.isArray(rawGroups) || rawGroups.length>LIMITS.groups){issue('검사 노드는 최대 36개까지 구성할 수 있습니다.');return errors;}
  const groups=rawGroups.filter((group):group is RuleGroup=>record(group)&&text(group.id,LIMITS.id));
  if(groups.length!==rawGroups.length)issue('검사 노드 ID를 확인하세요.');
  for(const group of groups)if(group.required!==undefined && typeof group.required!=='boolean')issue('필수 검사 여부는 true 또는 false여야 합니다.');
  if(!record(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)){issue('그래프에는 nodes와 edges 배열이 필요합니다.');return errors;}
  if(graph.nodes.length>LIMITS.controls || graph.edges.length>LIMITS.edges){issue('제어 노드는 최대 12개, 연결선은 최대 64개까지 구성할 수 있습니다.');return errors;}
  const nodes:FlowControlNode[]=[];
  for(const candidate of graph.nodes){
    if(!record(candidate) || !text(candidate.id,LIMITS.id) || !text(candidate.name,LIMITS.name) || typeof candidate.kind!=='string' || !['condition','fork','join'].includes(candidate.kind)){issue('제어 노드 ID, 이름과 종류를 확인하세요.');continue;}
    if(candidate.kind==='condition'){
      const error=conditionError(candidate.condition);if(error)issue(`${candidate.name}: ${error}`);
    }else if(candidate.condition!==undefined)issue(`${candidate.name}: 조건 설정은 조건 노드에서만 사용할 수 있습니다.`);
    nodes.push(candidate as unknown as FlowControlNode);
  }
  const keys=['start',...groups.map(group=>`group:${group.id}`),...nodes.map(node=>`control:${node.id}`),'end'];
  const known=new Set(keys);
  if(known.size!==keys.length)issue('같은 단계에 중복된 노드 ID가 있습니다.');
  const outgoing=new Map<string,FlowEdge[]>();
  const incoming=new Map<string,FlowEdge[]>();
  const forward=new Map<string,string[]>();
  const reverse=new Map<string,string[]>();
  for(const key of known){outgoing.set(key,[]);incoming.set(key,[]);forward.set(key,[]);reverse.set(key,[]);}
  const edgeIds=new Set<string>();
  const edgeSignatures=new Set<string>();
  for(const candidate of graph.edges){
    if(!record(candidate) || !text(candidate.id,LIMITS.id) || !text(candidate.from,LIMITS.endpoint) || !text(candidate.to,LIMITS.endpoint)){
      issue('연결선의 ID와 출발 및 도착 노드를 확인하세요.');continue;
    }
    if(edgeIds.has(candidate.id))issue('연결선 ID는 같은 단계에서 중복될 수 없습니다.');
    edgeIds.add(candidate.id);
    if(candidate.port!==undefined && (typeof candidate.port!=='string' || !['next','true','false'].includes(candidate.port))){issue('연결선 포트는 next, true, false만 사용할 수 있습니다.');continue;}
    if(!known.has(candidate.from) || !known.has(candidate.to)){issue('연결선이 없는 노드나 다른 단계의 노드를 가리킵니다.');continue;}
    const port=candidate.port??'next';
    const signature=JSON.stringify([candidate.from,candidate.to,port]);
    if(edgeSignatures.has(signature))issue('같은 노드와 포트를 잇는 연결선이 중복되어 있습니다.');
    edgeSignatures.add(signature);
    const edge=candidate as unknown as FlowEdge;
    outgoing.get(edge.from)!.push(edge);incoming.get(edge.to)!.push(edge);
    forward.get(edge.from)!.push(edge.to);reverse.get(edge.to)!.push(edge.from);
  }
  for(const key of known){
    const ins=incoming.get(key)!;const outs=outgoing.get(key)!;
    const node=key.startsWith('control:')?nodes.find(item=>`control:${item.id}`===key):undefined;
    if(key==='start'){
      if(ins.length!==0 || outs.length!==1 || (outs[0]?.port??'next')!=='next')issue('시작 노드는 들어오는 선 없이 next 연결선 하나가 필요합니다.');
    }else if(key==='end'){
      if(ins.length!==1 || outs.length!==0)issue('종료 노드에는 들어오는 연결선 하나가 필요하며, 나가는 연결선은 추가할 수 없습니다.');
    }else if(node?.kind==='condition'){
      if(ins.length!==1 || outs.length!==2 || outs.filter(edge=>edge.port==='true').length!==1 || outs.filter(edge=>edge.port==='false').length!==1)issue(`${node.name}: 들어오는 연결선 하나와 true 및 false 연결선이 각각 하나 필요합니다.`);
    }else if(node?.kind==='fork'){
      if(ins.length!==1 || outs.length<2 || outs.length>4 || outs.some(edge=>(edge.port??'next')!=='next') || new Set(outs.map(edge=>edge.to)).size!==outs.length)issue(`${node.name}: 들어오는 선 하나와 서로 다른 노드로 가는 next 연결선 2~4개가 필요합니다.`);
    }else if(node?.kind==='join'){
      if(ins.length<2 || ins.length>4 || outs.length!==1 || (outs[0]?.port??'next')!=='next')issue(`${node.name}: 들어오는 연결선 2~4개와 next 연결선 하나가 필요합니다.`);
    }else if(key.startsWith('group:')){
      if(ins.length!==1 || outs.length!==1 || (outs[0]?.port??'next')!=='next')issue(`${endpointLabel(workflow,stage,key)}: 검사 노드에는 들어오는 연결선 하나와 next 연결선 하나가 필요합니다.`);
    }
  }
  const indegree=new Map([...known].map(key=>[key,incoming.get(key)!.length]));
  const ready=[...known].filter(key=>indegree.get(key)===0);
  let processed=0;
  while(ready.length){
    const key=ready.pop()!;processed++;
    for(const next of forward.get(key)??[]){const degree=indegree.get(next)!-1;indegree.set(next,degree);if(degree===0)ready.push(next);}
  }
  if(processed!==known.size)issue('순환 연결은 사용할 수 없습니다. 모든 연결은 한 방향으로 끝나야 합니다.');
  const fromStart=reachable('start',forward);const toEnd=reachable('end',reverse);
  if([...known].some(key=>!fromStart.has(key)))issue('모든 노드는 시작 노드에서 도달할 수 있어야 합니다.');
  if([...known].some(key=>!toEnd.has(key)))issue('모든 노드에서 종료 노드로 도달할 수 있어야 합니다.');
  for(const group of groups){
    if(group.required===true && reachable('start',forward,`group:${group.id}`).has('end'))issue(`${group.name}: 필수 검사를 우회하는 시작→종료 경로가 있습니다.`);
  }
  return errors;
}

export function validateWorkflowGraph(workflow:Workflow):string[]{
  if(!record(workflow))return ['워크플로우 그래프 설정을 확인하세요.'];
  const errors:string[]=[];
  const graph=workflow.graph as unknown;
  if(graph!==undefined && (!record(graph) || graph.version!==1))return ['워크플로우 그래프 버전은 1이어야 합니다.'];
  const usedIds=new Set<string>();
  for(const stage of ['pre','post'] as const){
    const groups=workflow[stage] as unknown;
    if(Array.isArray(groups))for(const group of groups){
      if(!record(group))continue;
      if(typeof group.id==='string')usedIds.add(group.id);
      if(Array.isArray(group.rules))for(const rule of group.rules)if(record(rule)&&typeof rule.id==='string')usedIds.add(rule.id);
    }
  }
  for(const stage of ['pre','post'] as const){
    const stageGraph=graph===undefined?createStageGraph(groupsFor(workflow,stage)):record(graph)?graph[stage]:undefined;
    if(record(stageGraph)&&Array.isArray(stageGraph.nodes))for(const node of stageGraph.nodes){
      if(!record(node)||typeof node.id!=='string')continue;
      if(usedIds.has(node.id))errors.push('제어 노드 ID는 검사 노드, 규칙 및 다른 제어 노드 ID와 달라야 합니다.');
      usedIds.add(node.id);
    }
    errors.push(...validateStage(workflow,stage,stageGraph));
  }
  return [...new Set(errors)];
}
