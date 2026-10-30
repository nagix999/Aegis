import type { ConsoleExecutionInspection, ExecutionResult, RuleGroup, Trace, Workflow, WorkflowProgressEvent } from './aegis-types';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { getStageGraph } from './workflow-graph.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { nodeDefinitions } from './workflow-layout.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { getWorkflowCanvasLinks } from './workflow-policy-canvas.ts';

// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { listWorkflowPolicyChecks, policyScopedId } from './workflow-policy-checks.ts';

export type CanvasExecutionState = 'idle'|'running'|'completed'|'block'|'error'|'skipped'|'stale'|'unconfirmed';
export type WorkflowExecutionView = {nodes:Record<string,CanvasExecutionState>;edges:Record<string,CanvasExecutionState>;retryNodes:Set<string>;hasExecution:boolean;postAttempt:number};
export const canvasExecutionLabels:Record<CanvasExecutionState,string> = {idle:'실행 대기',running:'실행 중',completed:'완료',block:'차단',error:'실행 오류',skipped:'실행 안 함',stale:'설정 변경 전 결과',unconfirmed:'선택 경로 구분 불가'};
export const canvasExecutionColors:Record<CanvasExecutionState,string> = {idle:'#94a5b9',running:'#467eb1',completed:'#4d8969',block:'#b08039',error:'#b3625e',skipped:'#bac4d0',stale:'#aeb9c7',unconfirmed:'#94a5b9'};
type Stage = 'pre'|'post';
type Observation = {status:CanvasExecutionState;edgeIds:string[]};
function groupKey(group:RuleGroup):string { return group.rules.length===1?`rule:${group.rules[0].id}`:`group:${group.id}`; }
function visibleEndpoint(workflow:Workflow,stage:Stage,id:string):string|undefined {
  if(id==='start')return stage==='pre'?'input':undefined;
  if(id==='end')return stage==='post'?'output':undefined;
  const group=workflow[stage].find(item=>`group:${item.id}`===id);
  if(group)return groupKey(group);
  return id.startsWith('control:')?id:undefined;
}
function groupOutcome(group:RuleGroup,traces:Trace[]):CanvasExecutionState {
  const active=traces.filter(trace=>trace.status!=='skipped');
  if(active.some(trace=>trace.status==='error'))return 'error';
  const blocked=active.filter(trace=>trace.status==='block').length;
  return (group.mode==='all'?active.length>0&&blocked===active.length:blocked>0)?'block':'completed';
}

/** Derives display state from actual events or completed engine traces only. */
export function workflowExecutionView(workflow:Workflow,{execution,inspection,progress=[],running=false,stale=false,executionAttempt}:{execution?:ExecutionResult;inspection?:ConsoleExecutionInspection;progress?:WorkflowProgressEvent[];running?:boolean;stale?:boolean;executionAttempt?:number}={}):WorkflowExecutionView {
  const hasExecution=Boolean(execution||progress.length||running);
  const nodes:Record<string,CanvasExecutionState>=Object.fromEntries(nodeDefinitions(workflow).map(node=>[node.key,'idle']));
  const edges:Record<string,CanvasExecutionState>={};
  for(const edge of getWorkflowCanvasLinks(workflow))edges[edge.id]='idle';
  const retryNodes=new Set<string>();
  const eventAttempt=Math.max(1,...progress.filter(event=>event.stage==='post'||event.stage==='main').map(event=>event.attempt??1));
  const resultAttempt=Math.max(1,...(execution?.attempts??[]).map(attempt=>attempt.number),...(execution?.traces??[]).filter(trace=>trace.stage==='post'||trace.stage==='main').map(trace=>trace.attempt??1),...(execution?.flowTraces??[]).filter(trace=>trace.stage==='post').map(trace=>trace.attempt??1));
  const latestAttempt=running||progress.length?eventAttempt:resultAttempt;
  const availableAttempts=new Set([
    1,...progress.filter(event=>event.stage==='main'||event.stage==='post').map(event=>event.attempt??1),
    ...(!running?(execution?.attempts??[]).map(attempt=>attempt.number):[]),
    ...(!running?(execution?.traces??[]).filter(trace=>trace.stage==='main'||trace.stage==='post').map(trace=>trace.attempt??1):[]),
    ...(!running?(execution?.flowTraces??[]).filter(trace=>trace.stage==='post').map(trace=>trace.attempt??1):[]),
  ]);
  const postAttempt=executionAttempt!==undefined&&Number.isInteger(executionAttempt)&&availableAttempts.has(executionAttempt)?executionAttempt:latestAttempt;
  const historical=postAttempt<latestAttempt;
  const viewRunning=running&&!historical;
  if(!hasExecution)return {nodes,edges,retryNodes,hasExecution,postAttempt};
  if(stale){for(const key of Object.keys(nodes))nodes[key]='stale';for(const key of Object.keys(edges))edges[key]='stale';return {nodes,edges,retryNodes,hasExecution,postAttempt};}
  const observations:Record<string,Observation>={};
  const observe=(stage:Stage,nodeId:string,status:CanvasExecutionState,edgeIds:string[]=[])=>{
    observations[`${stage}:${nodeId}`]={status,edgeIds};
    const visible=visibleEndpoint(workflow,stage,nodeId);
    const group=workflow[stage].find(group=>`group:${group.id}`===nodeId);
    if(visible&&visible in nodes)nodes[visible]=group?.rules.length===1&&!group.rules[0].enabled&&status==='completed'?'skipped':status;
  };
  const final=execution&&!running;
  if(final){
    const currentMain=execution.traces.filter(trace=>trace.stage==='main'&&(trace.attempt??1)===postAttempt).at(-1);
    const attempt=execution.attempts?.find(attempt=>attempt.number===postAttempt);
    const outcome=historical?attempt?.status:execution.status;
    nodes.input=execution.traces.length?'completed':execution.status==='error'?'error':'completed';
    nodes.main=currentMain?(currentMain.status==='allow'?'completed':currentMain.status):'skipped';
    nodes.output=outcome==='allow'?'completed':outcome??'skipped';
    for(const stage of ['pre','post'] as const){
      const flow=(execution.flowTraces??[]).filter(trace=>trace.stage===stage&&(stage==='pre'||(trace.attempt??1)===postAttempt));
      if(flow.length){
        for(const trace of flow)observe(stage,trace.nodeId,trace.status,trace.edgeIds);
      }else{
        // Legacy serial runs do not store flow traces. Their group decision is
        // derived with the same ANY/ALL rule as the engine, not a single rule.
        let reached=stage==='pre'?execution.traces.length>0:currentMain?.status==='allow'||execution.policyRoute==='respond';
        observe(stage,'start',reached?'completed':'skipped',reached?getStageGraph(workflow,stage).edges.filter(edge=>edge.from==='start').map(edge=>edge.id):[]);
        for(const group of workflow[stage]){
          const traces=execution.traces.filter(trace=>trace.traceType!=='policy'&&trace.stage===stage&&trace.groupId===group.id&&(stage==='pre'||(trace.attempt??1)===postAttempt));
          const state=reached?groupOutcome(group,traces):'skipped';
          observe(stage,`group:${group.id}`,state,state==='completed'?getStageGraph(workflow,stage).edges.filter(edge=>edge.from===`group:${group.id}`).map(edge=>edge.id):[]);
          if(state==='block'||state==='error')reached=false;
        }
        observe(stage,'end',reached?'completed':'skipped');
      }
    }
    // Boundary nodes describe the request, including input validation failure.
    nodes.input=execution.traces.length?'completed':execution.status==='error'?'error':'completed';
    // Output describes the final request outcome even when POST was skipped.
    nodes.output=outcome==='allow'?'completed':outcome??'skipped';
    if((execution.regenerationCount??Math.max(0,resultAttempt-1))>0)for(const group of workflow.post){
      for(let attempt=1;attempt<postAttempt;attempt++){
        const flow=(execution.flowTraces??[]).find(trace=>trace.stage==='post'&&trace.nodeId===`group:${group.id}`&&(trace.attempt??1)===attempt);
        if(flow?.status==='block'||!flow&&groupOutcome(group,execution.traces.filter(trace=>trace.stage==='post'&&trace.groupId===group.id&&(trace.attempt??1)===attempt))==='block')retryNodes.add(groupKey(group));
      }
    }
  }
  // During a fresh run, old completed results never supply live green paths.
  for(const event of progress){
    if(event.stage==='post'&&(event.attempt??1)!==postAttempt){
      if(event.status==='block'&&(event.attempt??1)<postAttempt){const key=visibleEndpoint(workflow,'post',event.nodeId);if(key)retryNodes.add(key);}
      continue;
    }
    if(event.stage==='main'){
      if((event.attempt??1)===postAttempt)nodes.main=event.status;
    }else if(event.stage==='complete'){
      if(!historical)nodes.output=event.status;
    }
    else if(!(event.stage==='pre'&&(event.nodeId==='policy'||event.nodeId.startsWith('policy:'))))observe(event.stage,event.nodeId,event.status,event.edgeIds);
  }
  if(historical){
    // A previous attempt can be inspected during regeneration. Its own
    // observations describe the outcome; a later request completion cannot.
    const postStates=Object.entries(observations).filter(([key])=>key.startsWith('post:')).map(([,value])=>value.status);
    const outcome=final?execution.attempts?.find(attempt=>attempt.number===postAttempt)?.status:undefined;
    nodes.output=outcome==='allow'?'completed':outcome??(nodes.main==='error'||postStates.includes('error')?'error':postStates.includes('block')?'block':observations['post:end']?.status==='completed'?'completed':'skipped');
  }
  for(const stage of ['pre','post'] as const)for(const edge of getStageGraph(workflow,stage).edges){
    const from=observations[`${stage}:${edge.from}`],to=observations[`${stage}:${edge.to}`];
    let state:CanvasExecutionState=viewRunning?'idle':'skipped';
    if(from?.edgeIds.includes(edge.id))state=to?.status==='block'||to?.status==='error'||to?.status==='running'||to?.status==='skipped'?to.status:to?.status==='completed'?'completed':viewRunning?'running':'completed';
    else if(from?.status==='completed'||from?.status==='skipped'||from?.status==='block'||from?.status==='error')state='skipped';
    edges[`${stage}:${edge.id}`]=state;
  }
  if(workflow.policyRouting){
    const routing=workflow.policyRouting,graph=routing.graph;
    const policyTraces=final?execution.traces.filter(trace=>trace.traceType==='policy'):[];
    const policyEvents=progress.filter(event=>event.stage==='pre'&&(event.nodeId==='policy'||event.nodeId.startsWith('policy:')));
    const path=final?(execution.policyPath??[]):[...new Set(policyEvents.filter(event=>event.nodeId.startsWith('policy:')).map(event=>event.nodeId.slice('policy:'.length)))];
    const graphNodes=graph?.nodes??[];
    const known=new Set(graphNodes.map(node=>node.id));
    const visited=path.filter(id=>known.has(id));
    const classifierTrace=policyTraces.find(trace=>trace.ruleId==='policy');
    if(classifierTrace)nodes.policy=classifierTrace.status==='allow'?'completed':classifierTrace.status;
    for(const trace of policyTraces){
      if(!trace.ruleId.startsWith('policy:'))continue;
      const key=`policy-node:${trace.ruleId.slice('policy:'.length)}`;
      if(key in nodes)nodes[key]=trace.status==='allow'?'completed':trace.status;
    }
    for(const event of policyEvents){
      const key=event.nodeId==='policy'?'policy':`policy-node:${event.nodeId.slice('policy:'.length)}`;
      if(key in nodes)nodes[key]=event.status;
    }
    // A visited graph proves that classification succeeded. A selected error
    // action is a block at that action, rather than a model parsing failure.
    if(visited.length)nodes.policy='completed';
    for(const id of visited)if(nodes[`policy-node:${id}`]==='idle')nodes[`policy-node:${id}`]='completed';
    const lastAction=[...visited].reverse().map(id=>graphNodes.find(node=>node.id===id)).find(node=>node?.kind==='action');
    const route=final?execution.policyRoute:lastAction?.kind==='action'?lastAction.action:undefined;
    if(route==='respond'||route==='error')nodes.main='skipped';
    const links=getWorkflowCanvasLinks(workflow);
    const targetState=(key:string):CanvasExecutionState=>{
      const state=nodes[key];
      return state==='running'||state==='block'||state==='error'||state==='completed'?state:viewRunning?'idle':'skipped';
    };
    for(const link of links.filter(link=>link.id.startsWith('policy:'))){
      let state:CanvasExecutionState=viewRunning?'idle':'skipped';
      if(link.id==='policy:entry'&&visited[0]===graph?.entryNodeId)state=targetState(link.to);
      else if(link.policyEdgeId){
        const edge=graph?.edges.find(edge=>edge.id===link.policyEdgeId);
        const index=edge?visited.indexOf(edge.from):-1;
        if(edge&&index>=0&&visited[index+1]===edge.to){
          // Node paths cannot distinguish true/false ports that share the same
          // target. Keep those links neutral instead of claiming both ran.
          const candidates=graph?.edges.filter(other=>other.from===edge.from&&other.to===edge.to)??[];
          const observed=inspection?.nodes.find(node=>node.nodeId===`policy-node:${edge.from}`)?.selectedEdgeIds;
          state=observed?observed.includes(edge.id)?targetState(link.to):'skipped':candidates.length===1?targetState(link.to):'unconfirmed';
        }
      }else{
        const selectedV1=routing.policy.formatVersion!==2&&final&&routing.routes?.some((item,index)=>item.decision===execution.policyDecision&&link.id.startsWith(`policy:route:${index}:`));
        const selectedAction=lastAction?.kind==='action'&&link.from===`policy-node:${lastAction.id}`;
        if(selectedV1||selectedAction){
          if(route==='error')state='block';
          else if(route==='main')state=targetState('main');
          else if(route==='respond'){
            const postEdge=getStageGraph(workflow,'post').edges.find(edge=>edge.from==='start'&&link.id.endsWith(`:${edge.id}`));
            state=postEdge?edges[`post:${postEdge.id}`]??state:targetState(link.to);
          }
        }
      }
      edges[link.id]=state;
    }
    for(const link of links){
      if(link.to==='policy'&&(edges[link.id]==='completed'||edges[link.id]==='running')&&['running','block','error'].includes(nodes.policy))edges[link.id]=nodes.policy;
      // Direct responses enter POST from their action node. The separate Main
      // boundary is unvisited even though the POST start event is completed.
      if(link.stage==='post'&&link.graphFrom==='start'&&(route==='respond'||route==='error'))edges[link.id]=viewRunning?'idle':'skipped';
    }
  }
  for(const scope of listWorkflowPolicyChecks(workflow).filter(scope=>scope.id!=='policy')){
    const graph=scope.routing.graph,modelKey=`rule:${scope.id}`,prefix=`policy:${scope.id}:`,child=(id:string)=>`policy-node:${policyScopedId(scope.id,id)}`;
    const checks=final?execution.policyChecks?.filter(check=>check.ruleId===scope.id&&(scope.stage==='pre'||(check.attempt??1)===postAttempt))??[]:[];
    const check=checks.at(-1),events=progress.filter(event=>event.stage===scope.stage&&event.nodeId.startsWith(`policy:${scope.id}/`)&&(scope.stage==='pre'||(event.attempt??1)===postAttempt));
    const visited=(check?.path??events.filter(event=>event.status!=='running').map(event=>event.nodeId.slice(`policy:${scope.id}/`.length))).filter(id=>graph?.nodes.some(node=>node.id===id));
    if(final)for(const trace of execution.traces.filter(trace=>trace.traceType==='policy'&&trace.ruleId.startsWith(`policy:${scope.id}/`)&&(scope.stage==='pre'||(trace.attempt??1)===postAttempt))){const key=child(trace.ruleId.slice(`policy:${scope.id}/`.length));if(key in nodes)nodes[key]=trace.status==='allow'?'completed':trace.status;}
    for(const event of events){const key=child(event.nodeId.slice(`policy:${scope.id}/`.length));if(key in nodes)nodes[key]=event.status;}
    if(visited.length){nodes[modelKey]='completed';for(const id of visited)if(nodes[child(id)]==='idle')nodes[child(id)]='completed';}
    const lastAction=[...visited].reverse().map(id=>graph?.nodes.find(node=>node.id===id)).find(node=>node?.kind==='action'),route=check?.route??(lastAction?.kind==='action'?lastAction.action:undefined);
    const targetState=(key:string):CanvasExecutionState=>['running','completed','block','error'].includes(nodes[key])?nodes[key]:viewRunning?'idle':'skipped';
    for(const link of getWorkflowCanvasLinks(workflow).filter(link=>link.policyOwnerId===scope.id)){
      let state:CanvasExecutionState=viewRunning?'idle':'skipped';
      if(link.id===`${prefix}entry`&&visited[0]===graph?.entryNodeId)state=targetState(link.to);
      else if(link.policyEdgeId){const edge=graph?.edges.find(edge=>policyScopedId(scope.id,edge.id)===link.policyEdgeId),index=edge?visited.indexOf(edge.from):-1;if(edge&&index>=0&&visited[index+1]===edge.to){const candidates=graph?.edges.filter(other=>other.from===edge.from&&other.to===edge.to)??[],observed=inspection?.nodes.find(node=>node.nodeId===child(edge.from)&&(scope.stage==='pre'||(node.attempt??1)===postAttempt))?.selectedEdgeIds;state=observed?observed.some(id=>id===edge.id||id===policyScopedId(scope.id,edge.id))?targetState(link.to):'skipped':candidates.length===1?targetState(link.to):'unconfirmed';}}
      else {const selectedV1=scope.routing.policy.formatVersion!==2&&scope.routing.routes.some((item,index)=>item.decision===check?.decision&&link.id.startsWith(`${prefix}route:${index}:`)),selectedAction=lastAction?.kind==='action'&&link.from===child(lastAction.id);if(selectedV1||selectedAction)state=route==='error'?'block':route==='main'?targetState(link.to):state;}
      edges[link.id]=state;
    }
  }
  if(!viewRunning)for(const key of Object.keys(nodes))if(nodes[key]==='idle')nodes[key]='skipped';
  return {nodes,edges,retryNodes,hasExecution,postAttempt};
}
