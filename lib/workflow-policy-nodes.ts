// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { randomUuid } from './client-id.ts';
import type { PolicyGraphNode, PolicyRevision, Workflow } from './aegis-types';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { bindPolicyRevision } from './policy-routing.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { policyNodePorts } from './policy-graph.ts';

const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
function prunePolicyLayout(next:Workflow,remove=false) {
  if(!next.layout)return;
  const nodes=new Set(next.policyRouting?.graph?.nodes.map(node=>`policy-node:${node.id}`)??[]);
  const keep=(key:string)=>key==='policy'?!remove:key.startsWith('policy-node:')?nodes.has(key):true;
  next.layout.positions=Object.fromEntries(Object.entries(next.layout.positions).filter(([key])=>keep(key)));
  if(next.layout.pinnedKeys)next.layout.pinnedKeys=next.layout.pinnedKeys.filter(keep);
  if(next.layout.zones)next.layout.zones=next.layout.zones.map(zone=>({...zone,nodeKeys:zone.nodeKeys.filter(keep)}));
}

/** The selected immutable policy is configured on its visible model node. */
export function bindWorkflowPolicyNode(workflow: Workflow, policy: PolicyRevision, options: {emptyGraph?: boolean} = {}): Workflow {
  const next = structuredClone(workflow), previous = workflow.policyRouting;
  next.policyRouting = bindPolicyRevision(policy, previous?.policy.id === policy.id ? previous.routes : []);
  if (policy.formatVersion === 2 && previous?.policy.formatVersion === 2 && previous.policy.id === policy.id && previous.graph) next.policyRouting.graph = structuredClone(previous.graph);
  else if (policy.formatVersion === 2 && options.emptyGraph) next.policyRouting.graph = {version:1,entryNodeId:'',nodes:[],edges:[]};
  prunePolicyLayout(next);
  return next;
}

export function removeWorkflowPolicy(workflow: Workflow): Workflow {
  const next = structuredClone(workflow);
  delete next.policyRouting;
  prunePolicyLayout(next,true);
  return next;
}

/** Ports are data-driven graph edges; unfinished drafts may remain disconnected. */
export function connectWorkflowPolicyNode(workflow: Workflow, from:string, to:string, port:string, edgeId?:string): Workflow {
  const next = structuredClone(workflow), graph = next.policyRouting?.graph;
  if (!graph || next.policyRouting?.policy.formatVersion !== 2) throw new Error('구조화 출력 정책 노드를 먼저 추가하세요.');
  const source=graph.nodes.find(node=>node.id===from), target=graph.nodes.find(node=>node.id===to);
  if (!source || !target || from===to || !policyNodePorts(source).some(item=>item.port===port)) throw new Error('분기 노드의 출력 경로를 선택하세요.');
  if (!['branch','rule','switch','action'].includes(target.kind)) throw new Error('분기 다음에는 조건 분기, Switch 분기 또는 액션을 연결하세요.');
  const previous = graph.edges.find(edge=>edge.from===from&&edge.port===port);
  if(!previous&&edgeId!==undefined&&(!validId(edgeId)||graph.edges.some(edge=>edge.id===edgeId)))throw new Error('새 정책 연결선의 ID를 확인하세요.');
  graph.edges=graph.edges.filter(edge=>!(edge.from===from&&edge.port===port));
  graph.edges.push({id:previous?.id??edgeId??`policy-edge-${randomUuid()}`,from,to,port});
  if (graph.edges.length>48) throw new Error('정책 연결선은 최대 48개입니다.');
  const active=new Set<string>(), done=new Set<string>();
  const visit=(key:string) => {
    if(active.has(key))throw new Error('정책 노드에 순환 연결을 만들 수 없습니다.');
    if(done.has(key))return;
    active.add(key);
    for(const edge of graph.edges.filter(edge=>edge.from===key))visit(edge.to);
    active.delete(key);done.add(key);
  };
  graph.nodes.forEach(node=>visit(node.id));
  return next;
}

export function addWorkflowPolicyGraphNode(workflow:Workflow,kind:'branch'|'rule'|'switch'|'action',identifier=`policy-${randomUuid()}`):{workflow:Workflow;nodeId:string} {
  const next=structuredClone(workflow),graph=next.policyRouting?.graph;
  if(!graph||next.policyRouting?.policy.formatVersion!==2)throw new Error('구조화 출력 정책 노드를 먼저 추가하세요.');
  if(graph.nodes.length>=24)throw new Error('정책 노드는 최대 24개입니다.');
  if(!['branch','rule','switch','action'].includes(kind))throw new Error('조건 분기, Switch 분기 또는 액션을 선택하세요.');
  if(!validId(identifier)||graph.nodes.some(node=>node.id===identifier))throw new Error('새 정책 노드의 ID를 확인하세요.');
  const node:PolicyGraphNode=kind==='switch'?{id:identifier,name:'새 Switch 분기',kind,path:'',cases:[{id:'case-1',value:''}]}:kind!=='action'?{id:identifier,name:'새 조건 분기',kind,condition:{mode:'all',predicates:[{path:'',operator:'exists'}]}}:{id:identifier,name:'새 정책 액션',kind,action:'error',errorCode:'POLICY_UNCONFIGURED',errorMessage:'정책 액션이 아직 설정되지 않았습니다.'};
  graph.nodes.push(node);
  if(!graph.entryNodeId && kind!=='action')graph.entryNodeId=identifier;
  return {workflow:next,nodeId:identifier};
}

/** An explicit port creation is one edit: a failed connection cannot leave an orphan. */
export function addConnectedWorkflowPolicyNode(workflow:Workflow,from:string,port:string,kind:'branch'|'rule'|'switch'|'action',identifier=`policy-${randomUuid()}`):{workflow:Workflow;nodeId:string} {
  const added=addWorkflowPolicyGraphNode(workflow,kind,identifier);
  return {workflow:connectWorkflowPolicyNode(added.workflow,from,added.nodeId,port),nodeId:added.nodeId};
}

/** The policy model has one output; selecting its first condition is an explicit graph edit. */
export function setWorkflowPolicyEntryNode(workflow:Workflow,nodeId:string):Workflow {
  const next=structuredClone(workflow),graph=next.policyRouting?.graph;
  if(!graph||next.policyRouting?.policy.formatVersion!==2)throw new Error('구조화 출력 정책 노드를 먼저 추가하세요.');
  const node=graph.nodes.find(item=>item.id===nodeId);
  if(!node||!['branch','rule','switch'].includes(node.kind))throw new Error('정책 출력에 연결할 조건 분기 또는 Switch 분기를 선택하세요.');
  graph.entryNodeId=nodeId;
  return next;
}
