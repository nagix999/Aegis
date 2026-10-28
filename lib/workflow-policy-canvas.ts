/** Canvas projection only. Canonical policy execution stays in policyRouting. */
import type { Workflow } from './aegis-types';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { getStageGraph } from './workflow-graph.ts';

export type PolicyCanvasNode = { key:string; id:string; kind:'policy'|'policy-node'; stage:'pre'; policyKind?:'branch'|'rule'|'action'; index?:number };
export type WorkflowCanvasLink = { id:string; from:string; to:string; stage?:'pre'|'post'; graphId?:string; graphFrom?:string; graphTo?:string; port?:'next'|'true'|'false'; policyEdgeId?:string; label?:string };

export function getPolicyCanvasNodes(workflow:Workflow):PolicyCanvasNode[] {
  const routing=workflow.policyRouting;
  if(!routing)return [];
  const nodes:PolicyCanvasNode[]=[{key:'policy',id:'policy',kind:'policy',stage:'pre'}];
  if(routing.policy?.formatVersion!==2)return nodes;
  const seen=new Set<string>();
  for(const [index,node] of (routing.graph?.nodes??[]).slice(0,24).entries()){
    if(!node||typeof node.id!=='string'||!node.id||seen.has(node.id)||!['branch','rule','action'].includes(node.kind))continue;
    seen.add(node.id);nodes.push({key:`policy-node:${node.id}`,id:node.id,kind:'policy-node',policyKind:node.kind,stage:'pre',index});
  }
  return nodes;
}

function endpoint(workflow:Workflow,stage:'pre'|'post',key:string):string|undefined {
  if(key==='start')return stage==='pre'?'input':'main';
  if(key==='end')return stage==='pre'?(workflow.policyRouting?'policy':'main'):'output';
  const group=workflow[stage].find(group=>key===`group:${group.id}`);
  if(group)return group.rules.length===1?`rule:${group.rules[0].id}`:key;
  return getStageGraph(workflow,stage).nodes?.some(node=>key===`control:${node.id}`)?key:undefined;
}
function responseTargets(workflow:Workflow):{id:string;key:string}[]{
  return (getStageGraph(workflow,'post').edges??[]).filter(edge=>edge?.from==='start').flatMap(edge=>{
    const key=endpoint(workflow,'post',edge.to);return key?[{id:edge.id,key}]:[];
  });
}

/** Actual visible boundaries, without inventing an unconditional Main route. */
export function getWorkflowCanvasLinks(workflow:Workflow):WorkflowCanvasLink[] {
  const links:WorkflowCanvasLink[]=[];
  for(const stage of ['pre','post'] as const)for(const edge of getStageGraph(workflow,stage).edges??[]){
    if(!edge||typeof edge.from!=='string'||typeof edge.to!=='string')continue;
    const from=endpoint(workflow,stage,edge.from),to=endpoint(workflow,stage,edge.to);
    if(from&&to&&from!==to)links.push({id:`${stage}:${edge.id}`,from,to,stage,graphId:edge.id,graphFrom:edge.from,graphTo:edge.to,...(edge.port?{port:edge.port}:{})});
  }
  const routing=workflow.policyRouting;if(!routing)return links;
  const after=responseTargets(workflow);
  const actionLinks=(from:string,action:string,prefix:string,label?:string)=>{
    const targets=action==='main'?[{id:'main',key:'main'}]:action==='error'?[{id:'output',key:'output'}]:action==='respond'?after:[];
    for(const target of targets)links.push({id:`${prefix}:${target.id}`,from,to:target.key,stage:'pre',port:'next',...(label?{label}:{})});
  };
  if(routing.policy?.formatVersion!==2){
    for(const [index,route] of (routing.routes??[]).entries())if(route)actionLinks('policy',route.action,`policy:route:${index}`,route.decision);
    return links;
  }
  const nodes=getPolicyCanvasNodes(workflow),known=new Set(nodes.map(node=>node.key));
  const entry=`policy-node:${routing.graph?.entryNodeId}`;
  if(known.has(entry))links.push({id:'policy:entry',from:'policy',to:entry,stage:'pre',port:'next'});
  for(const edge of (routing.graph?.edges??[]).slice(0,48)){
    if(!edge||typeof edge.from!=='string'||typeof edge.to!=='string')continue;
    const from=`policy-node:${edge.from}`,to=`policy-node:${edge.to}`;
    if(!known.has(from)||!known.has(to)||from===to)continue;
    links.push({id:`policy:edge:${edge.id}`,from,to,stage:'pre',policyEdgeId:edge.id,port:edge.port,label:edge.port==='true'?'참':'거짓'});
  }
  for(const node of (routing.graph?.nodes??[]).slice(0,24))if(node?.kind==='action'&&known.has(`policy-node:${node.id}`))actionLinks(`policy-node:${node.id}`,node.action,`policy:action:${node.id}`);
  return links;
}
