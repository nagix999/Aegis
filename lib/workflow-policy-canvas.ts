/** Canvas projection only. Canonical policy execution stays in each policyRouting snapshot. */
import type { FlowEdge, Workflow } from './aegis-types';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { getStageGraph } from './workflow-graph.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { policyNodePorts } from './policy-graph.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { listWorkflowPolicyChecks, policyScopedId } from './workflow-policy-checks.ts';

export type PolicyCanvasNode={key:string;id:string;kind:'policy'|'policy-node';stage:'pre'|'post';policyKind?:'branch'|'rule'|'switch'|'action';index?:number};
export type WorkflowCanvasLink={id:string;from:string;to:string;stage?:'pre'|'post';graphId?:string;graphFrom?:string;graphTo?:string;port?:string;policyEdgeId?:string;policyOwnerId?:string;label?:string};
export function getPolicyCanvasNodes(workflow:Workflow):PolicyCanvasNode[]{
  return listWorkflowPolicyChecks(workflow).flatMap(scope=>{
    const nodes:PolicyCanvasNode[]=scope.id==='policy'?[{key:'policy',id:'policy',kind:'policy',stage:'pre'}]:[];
    if(scope.routing.policy?.formatVersion!==2)return nodes;
    const seen=new Set<string>();
    for(const [index,node] of (scope.routing.graph?.nodes??[]).slice(0,24).entries()){
      if(!node||typeof node.id!=='string'||!node.id||seen.has(node.id)||!['branch','rule','switch','action'].includes(node.kind))continue;
      seen.add(node.id);const id=policyScopedId(scope.id,node.id);nodes.push({key:`policy-node:${id}`,id,kind:'policy-node',policyKind:node.kind,stage:scope.stage,index});
    }return nodes;
  });
}
function endpoint(workflow:Workflow,stage:'pre'|'post',key:string):string|undefined{
  if(key==='start')return stage==='pre'?'input':'main';
  if(key==='end')return stage==='pre'?(workflow.policyRouting?'policy':'main'):'output';
  const group=workflow[stage].find(group=>key===`group:${group.id}`);
  if(group)return group.rules.length===1?`rule:${group.rules[0].id}`:key;
  return getStageGraph(workflow,stage).nodes?.some(node=>key===`control:${node.id}`)?key:undefined;
}
function responseTargets(workflow:Workflow):{id:string;key:string}[]{return(getStageGraph(workflow,'post').edges??[]).filter(edge=>edge?.from==='start').flatMap(edge=>{const key=endpoint(workflow,'post',edge.to);return key?[{id:edge.id,key}]:[];});}
/** A check's success resumes its own stage edge, including controls and other policy checks. */
export function getWorkflowCanvasLinks(workflow:Workflow):WorkflowCanvasLink[]{
  const links:WorkflowCanvasLink[]=[],scopes=listWorkflowPolicyChecks(workflow),checkGroups=new Set(scopes.filter(scope=>scope.group&&scope.rule?.enabled!==false).map(scope=>`${scope.stage}:group:${scope.group!.id}`));
  for(const stage of ['pre','post'] as const)for(const edge of getStageGraph(workflow,stage).edges??[]){
    if(!edge||typeof edge.from!=='string'||typeof edge.to!=='string'||checkGroups.has(`${stage}:${edge.from}`))continue;
    const from=endpoint(workflow,stage,edge.from),to=endpoint(workflow,stage,edge.to);
    if(from&&to&&from!==to)links.push({id:`${stage}:${edge.id}`,from,to,stage,graphId:edge.id,graphFrom:edge.from,graphTo:edge.to,...(edge.port?{port:edge.port}:{})});
  }
  const after=responseTargets(workflow),known=new Set(getPolicyCanvasNodes(workflow).map(node=>node.key));
  for(const scope of scopes){
    const routing=scope.routing,legacy=scope.id==='policy',model=legacy?'policy':`rule:${scope.id}`,prefix=legacy?'policy':`policy:${scope.id}`;
    const child=(id:string)=>`policy-node:${policyScopedId(scope.id,id)}`;
    const successors=legacy?[{id:'main',key:'main'}]:(getStageGraph(workflow,scope.stage).edges??[]).filter(edge=>edge.from===`group:${scope.group?.id}`).flatMap(edge=>{const key=endpoint(workflow,scope.stage,edge.to);return key?[{id:edge.id,key,edge}]:[];});
    const actionLinks=(from:string,action:string,linkPrefix:string,label?:string)=>{
      const targets:{id:string;key:string;edge?:FlowEdge}[]=action==='main'?successors:action==='error'?[{id:'output',key:'output'}]:action==='respond'&&legacy?after:[];
      for(const target of targets){const edge=target.edge;links.push({id:`${linkPrefix}:${target.id}`,from,to:target.key,stage:scope.stage,port:'next',policyOwnerId:scope.id,...(edge?{graphId:edge.id,graphFrom:edge.from,graphTo:edge.to}:{}),...(label?{label}:{})});}
    };
    if(routing.policy?.formatVersion!==2){for(const[index,route]of(routing.routes??[]).entries())if(route)actionLinks(model,route.action,`${prefix}:route:${index}`,route.decision);continue;}
    const entry=child(routing.graph?.entryNodeId??'');if(known.has(entry))links.push({id:`${prefix}:entry`,from:model,to:entry,stage:scope.stage,port:'next',policyOwnerId:scope.id});
    for(const edge of(routing.graph?.edges??[]).slice(0,48)){
      if(!edge||typeof edge.from!=='string'||typeof edge.to!=='string')continue;const from=child(edge.from),to=child(edge.to);if(!known.has(from)||!known.has(to)||from===to)continue;
      const source=routing.graph?.nodes.find(node=>node.id===edge.from);
      links.push({id:`${prefix}:edge:${edge.id}`,from,to,stage:scope.stage,policyEdgeId:policyScopedId(scope.id,edge.id),policyOwnerId:scope.id,port:edge.port,label:source?policyNodePorts(source).find(item=>item.port===edge.port)?.label:undefined});
    }
    for(const node of(routing.graph?.nodes??[]).slice(0,24))if(node?.kind==='action'&&known.has(child(node.id)))actionLinks(child(node.id),node.action,`${prefix}:action:${node.id}`);
  }return links;
}
