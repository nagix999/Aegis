import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { workflowExecutionView } from '../lib/workflow-execution-view.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { executeWorkflow } from '../lib/aegis-engine.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { createStageGraph } from '../lib/workflow-graph.ts';
import type { ExecutionResult, PolicyGraph, RuleGroup, Workflow, WorkflowProgressEvent } from '../lib/aegis-types';

function group(id:string,pattern='금지'):RuleGroup { return {id,name:id,mode:'any',rules:[{id:`${id}-rule`,name:id,description:'',kind:'keyword',enabled:true,config:{pattern}}]}; }
function fixture(){ const state=initialState(),workflow=structuredClone(state.workflows[0]);workflow.pre=[group('first'),group('second')];workflow.post=[group('response')];delete workflow.graph;delete workflow.responseRetry;return {state,workflow}; }
const event=(sequence:number,stage:WorkflowProgressEvent['stage'],nodeId:string,status:WorkflowProgressEvent['status'],edgeIds:string[]=[],attempt?:number):WorkflowProgressEvent=>({sequence,stage,nodeId,status,edgeIds,...(attempt?{attempt}:{})});

test('legacy serial traces color completed nodes and both stage-qualified edge sets',async()=>{
  const {state,workflow}=fixture();const execution=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'배송 문의'}]);
  assert.equal(execution.status,'allow');assert.equal(execution.flowTraces,undefined);
  const view=workflowExecutionView(workflow,{execution});
  assert.ok(Object.values(view.nodes).every(status=>status==='completed'));
  assert.ok(Object.values(view.edges).every(status=>status==='completed'));
  assert.equal(view.edges['pre:serial-1'],'completed');assert.equal(view.edges['post:serial-1'],'completed');
});

test('a single blocked rule does not falsely block an ALL group that the engine passed',async()=>{
  const {state,workflow}=fixture();workflow.pre=[group('all','배송')];workflow.pre[0].mode='all';workflow.pre[0].rules.push({...workflow.pre[0].rules[0],id:'all-pass',config:{pattern:'다른 문구'}});
  const execution=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'배송 문의'}]);
  assert.equal(execution.status,'allow');assert.deepEqual(execution.traces.filter(trace=>trace.stage==='pre').map(trace=>trace.status),['block','allow']);
  const view=workflowExecutionView(workflow,{execution});assert.equal(view.nodes['group:all'],'completed');assert.equal(view.edges['pre:serial-2'],'completed');
});

test('a blocked node colors only its incoming taken edge while later paths stay skipped',async()=>{
  const {state,workflow}=fixture();workflow.pre[1].rules[0].config.pattern='배송';
  const execution=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'배송 문의'}]);
  const view=workflowExecutionView(workflow,{execution});
  assert.equal(view.nodes['rule:first-rule'],'completed');assert.equal(view.nodes['rule:second-rule'],'block');assert.equal(view.nodes.main,'skipped');assert.equal(view.nodes.output,'block');
  assert.equal(view.edges['pre:serial-1'],'completed');assert.equal(view.edges['pre:serial-2'],'block');assert.equal(view.edges['pre:serial-3'],'skipped');assert.equal(view.edges['post:serial-1'],'skipped');
});

test('condition and join traces distinguish the selected branch from inactive nodes and edges',async()=>{
  const {state,workflow}=fixture();workflow.graph={version:1,pre:{nodes:[{id:'condition',name:'조건',kind:'condition',condition:{operator:'contains',value:'배송'}},{id:'join',name:'합류',kind:'join'}],edges:[{id:'entry',from:'start',to:'control:condition'},{id:'yes',from:'control:condition',to:'group:first',port:'true'},{id:'no',from:'control:condition',to:'group:second',port:'false'},{id:'join-yes',from:'group:first',to:'control:join'},{id:'join-no',from:'group:second',to:'control:join'},{id:'end',from:'control:join',to:'end'}]},post:createStageGraph(workflow.post)};
  const execution=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'배송 문의'}]);
  const view=workflowExecutionView(workflow,{execution});
  assert.equal(view.nodes['control:condition'],'completed');assert.equal(view.nodes['control:join'],'completed');assert.equal(view.nodes['rule:first-rule'],'completed');assert.equal(view.nodes['rule:second-rule'],'skipped');
  assert.equal(view.edges['pre:yes'],'completed');assert.equal(view.edges['pre:no'],'skipped');assert.equal(view.edges['pre:join-no'],'skipped');
});

test('actual running events replace old result colors without coloring the generation boundary prematurely',async()=>{
  const {state,workflow}=fixture();const execution=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'배송 문의'}]);
  const progress=[event(1,'pre','start','completed',['serial-1']),event(2,'pre','group:first','running')];
  const view=workflowExecutionView(workflow,{execution,progress,running:true});
  assert.equal(view.nodes.input,'completed');assert.equal(view.nodes['rule:first-rule'],'running');assert.equal(view.nodes['rule:second-rule'],'idle');assert.equal(view.nodes.main,'idle');assert.equal(view.nodes.output,'idle');assert.equal(view.edges['pre:serial-1'],'running');assert.equal(view.edges['post:serial-1'],'idle');
  const boundary=workflowExecutionView(workflow,{running:true,progress:[...progress,event(3,'pre','group:first','completed',['serial-2']),event(4,'pre','group:second','completed',['serial-3']),event(5,'pre','end','completed')]});
  assert.equal(boundary.nodes.main,'idle');assert.equal(boundary.edges['pre:serial-3'],'completed');
});

test('a new generation attempt clears previous POST states and shows only actual retry sources',()=>{
  const {workflow}=fixture();workflow.responseRetry={enabled:true,maxRetries:2};
  const progress=[event(1,'pre','start','completed',['serial-1']),event(2,'main','main','completed',[],1),event(3,'post','start','completed',['serial-1'],1),event(4,'post','group:response','block',[],1),event(5,'main','main','running',[],2)];
  const view=workflowExecutionView(workflow,{progress,running:true});
  assert.equal(view.postAttempt,2);assert.equal(view.nodes.main,'running');assert.equal(view.nodes['rule:response-rule'],'idle');assert.equal(view.edges['post:serial-1'],'idle');assert.deepEqual([...view.retryNodes],['rule:response-rule']);
});

test('POST stages with reused edge IDs never change PRE edge state',()=>{
  const {workflow}=fixture();const progress=[event(1,'pre','start','completed',['serial-1']),event(2,'pre','group:first','completed',['serial-2']),event(3,'pre','group:second','completed',['serial-3']),event(4,'pre','end','completed'),event(5,'post','start','completed',['serial-1']),event(6,'post','group:response','error')];
  const view=workflowExecutionView(workflow,{progress,running:true});
  assert.equal(view.edges['pre:serial-1'],'completed');assert.equal(view.edges['post:serial-1'],'error');assert.equal(view.edges['post:serial-2'],'skipped');
});

test('a stale result is visibly muted without active or successful paths',async()=>{
  const {state,workflow}=fixture();const execution=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'배송 문의'}]);
  const view=workflowExecutionView(workflow,{execution,stale:true});assert.ok(Object.values(view.nodes).every(status=>status==='stale'));assert.ok(Object.values(view.edges).every(status=>status==='stale'));assert.equal(view.retryNodes.size,0);
  const idle=workflowExecutionView(workflow);assert.equal(idle.hasExecution,false);assert.ok(Object.values(idle.nodes).every(status=>status==='idle'));
});

test('streamed events and completed serial results derive matching final paths',async()=>{
  const {state,workflow}=fixture();const progress:WorkflowProgressEvent[]=[];const execution=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'배송 문의'}],{onProgress:event=>progress.push(event)});
  assert.ok(progress.length>0);const final=workflowExecutionView(workflow,{execution}),streamed=workflowExecutionView(workflow,{execution,progress});assert.deepEqual(streamed.nodes,final.nodes);assert.deepEqual(streamed.edges,final.edges);
});

test('invalid input marks its failure without claiming the model or checks ran',()=>{
  const {workflow}=fixture();const execution:ExecutionResult={id:'invalid',status:'error',stage:'pre',output:'',reason:'입력 오류',latencyMs:0,traces:[]};
  const view=workflowExecutionView(workflow,{execution});assert.equal(view.nodes.input,'error');assert.equal(view.nodes.main,'skipped');assert.equal(view.nodes['rule:first-rule'],'skipped');assert.equal(view.nodes.output,'error');assert.ok(Object.values(view.edges).every(status=>status==='skipped'));
});

test('a disabled singleton remains visibly skipped while its completed pass-through path is retained',async()=>{
  const {state,workflow}=fixture();workflow.pre[0].rules[0].enabled=false;
  const execution=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'배송 문의'}]);
  const view=workflowExecutionView(workflow,{execution});assert.equal(view.nodes['rule:first-rule'],'skipped');assert.equal(view.edges['pre:serial-1'],'completed');assert.equal(view.edges['pre:serial-2'],'completed');
});

test('historical generation attempts retain their own blocked path and outcome after final success',()=>{
  const {workflow}=fixture();workflow.responseRetry={enabled:true,maxRetries:1};
  const execution:ExecutionResult={id:'history',status:'allow',stage:'complete',output:'승인된 최종 답변',reason:'통과',latencyMs:20,regenerationCount:1,
    attempts:[{number:1,status:'block',stage:'post',latencyMs:10,reason:'첫 응답 차단'},{number:2,status:'allow',stage:'post',latencyMs:10,reason:'통과'}],
    traces:[...workflow.pre.map(group=>({stage:'pre' as const,ruleId:group.rules[0].id,ruleName:group.name,groupId:group.id,status:'allow' as const,latencyMs:1,reason:'통과'})),
      {stage:'main',ruleId:'main',ruleName:'생성',groupId:'main',status:'allow',latencyMs:2,reason:'첫 생성',attempt:1},
      {stage:'post',ruleId:'response-rule',ruleName:'응답 검사',groupId:'response',status:'block',latencyMs:2,reason:'첫 차단',attempt:1},
      {stage:'main',ruleId:'main',ruleName:'생성',groupId:'main',status:'allow',latencyMs:2,reason:'재작성',attempt:2},
      {stage:'post',ruleId:'response-rule',ruleName:'응답 검사',groupId:'response',status:'allow',latencyMs:2,reason:'통과',attempt:2}]};
  const first=workflowExecutionView(workflow,{execution,executionAttempt:1});
  assert.equal(first.postAttempt,1);assert.equal(first.nodes.main,'completed');assert.equal(first.nodes.output,'block');
  assert.equal(first.nodes['rule:response-rule'],'block');assert.equal(first.edges['post:serial-1'],'block');assert.equal(first.edges['post:serial-2'],'skipped');
  assert.equal(first.nodes['rule:first-rule'],'completed');assert.equal(first.retryNodes.size,0);
  const latest=workflowExecutionView(workflow,{execution});assert.equal(latest.postAttempt,2);assert.equal(latest.nodes.output,'completed');assert.equal(latest.nodes['rule:response-rule'],'completed');
  const invalid=workflowExecutionView(workflow,{execution,executionAttempt:99});assert.equal(invalid.postAttempt,2);
  assert.equal(execution.output,'승인된 최종 답변');
});

test('historical attempts remain inspectable during a new main call and ignore later completion events',()=>{
  const {workflow}=fixture();
  const progress=[event(1,'pre','start','completed',['serial-1']),event(2,'main','main','completed',[],1),event(3,'post','start','completed',['serial-1'],1),event(4,'post','group:response','block',[],1),event(5,'post','end','skipped',[],1),event(6,'main','main','running',[],2)];
  const first=workflowExecutionView(workflow,{progress,running:true,executionAttempt:1});
  assert.equal(first.nodes.main,'completed');assert.equal(first.nodes['rule:response-rule'],'block');assert.equal(first.nodes.output,'block');assert.equal(first.edges['post:serial-1'],'block');assert.equal(first.edges['post:serial-2'],'skipped');
  const finalProgress=[...progress,event(7,'main','main','completed',[],2),event(8,'post','start','completed',['serial-1'],2),event(9,'post','group:response','completed',['serial-2'],2),event(10,'post','end','completed',[],2),event(11,'complete','end','completed')];
  const inspected=workflowExecutionView(workflow,{progress:finalProgress,executionAttempt:1});
  assert.equal(inspected.nodes.output,'block');assert.equal(inspected.nodes['rule:response-rule'],'block');
});

function policyFixture():Workflow {
  const {workflow,state}=fixture();
  const condition={mode:'all' as const,predicates:[{path:'/risk/score',operator:'gte' as const,value:80}]};
  const graph:PolicyGraph={version:1,entryNodeId:'branch',nodes:[
    {id:'branch',kind:'branch',name:'서비스 분기',condition},
    {id:'risk',kind:'rule',name:'위험 검사',condition},{id:'scope',kind:'rule',name:'범위 검사',condition},
    {id:'generate',kind:'action',name:'생성',action:'main'},
    {id:'answer',kind:'action',name:'안내',action:'respond',responseText:'안내 응답'},
    {id:'reject',kind:'action',name:'차단',action:'error',errorCode:'RESTRICTED',errorMessage:'제한된 요청입니다.'},
  ],edges:[{id:'service',from:'branch',to:'risk',port:'true'},{id:'other',from:'branch',to:'scope',port:'false'},{id:'high',from:'risk',to:'reject',port:'true'},{id:'low',from:'risk',to:'generate',port:'false'},{id:'guide',from:'scope',to:'answer',port:'true'},{id:'fallback',from:'scope',to:'generate',port:'false'}]};
  workflow.policyRouting={policy:{id:'policy',name:'정책',description:'',prompt:'JSON 출력',connectionId:state.connections[1].id,connectionSnapshot:state.connections[1],formatVersion:2,outputSchema:{type:'object'},decisions:[],examples:[{id:'example',input:'배송',expectedOutput:{}}],version:3,updatedAt:'2026-10-27T00:00:00Z'},routes:[],graph};
  return workflow;
}
function policyResult(workflow:Workflow,route:'main'|'respond'|'error'='main'):ExecutionResult {
  const path=route==='main'?['branch','risk','generate']:route==='respond'?['branch','scope','answer']:['branch','risk','reject'];
  return {id:'policy-result',status:route==='error'?'block':'allow',stage:route==='error'?'pre':'complete',output:route==='error'?'':'공개 응답',reason:'검사 결과',latencyMs:10,policyRoute:route,policyPath:path,
    traces:[...workflow.pre.flatMap(group=>group.rules.map(rule=>({stage:'pre' as const,ruleId:rule.id,ruleName:rule.name,groupId:group.id,status:'allow' as const,reason:'통과',latencyMs:1}))),
      ...path.map(id=>({traceType:'policy' as const,stage:'pre' as const,ruleId:`policy:${id}`,ruleName:id,groupId:'policy',status:id==='reject'?'block' as const:'allow' as const,reason:'경로 실행',latencyMs:0})),
      {stage:'main',ruleId:'main',ruleName:'생성',groupId:'main',status:route==='main'?'allow':'skipped',reason:'생성 경로',latencyMs:1},
      ...workflow.post.flatMap(group=>group.rules.map(rule=>({stage:'post' as const,ruleId:rule.id,ruleName:rule.name,groupId:group.id,status:route==='error'?'skipped' as const:'allow' as const,reason:'응답 검사',latencyMs:1}))),
    ]};
}

test('policy Main execution colors only visited policy nodes and selected graph edges',()=>{
  const workflow=policyFixture(),execution=policyResult(workflow),view=workflowExecutionView(workflow,{execution});
  for(const key of ['policy','policy-node:branch','policy-node:risk','policy-node:generate','main'])assert.equal(view.nodes[key],'completed',key);
  for(const key of ['policy-node:scope','policy-node:answer','policy-node:reject'])assert.equal(view.nodes[key],'skipped',key);
  for(const key of ['pre:serial-3','policy:entry','policy:edge:service','policy:edge:low','policy:action:generate:main','post:serial-1'])assert.equal(view.edges[key],'completed',key);
  for(const key of ['policy:edge:other','policy:edge:high','policy:action:reject:output'])assert.equal(view.edges[key],'skipped',key);
  execution.traces=execution.traces.filter(trace=>trace.stage!=='main');
  const noGeneration=workflowExecutionView(workflow,{execution});assert.equal(noGeneration.nodes.main,'skipped');assert.equal(noGeneration.edges['policy:action:generate:main'],'skipped');
});
test('direct policy responses enter real POST checks and never color the Main boundary',()=>{
  const workflow=policyFixture(),execution=policyResult(workflow,'respond'),view=workflowExecutionView(workflow,{execution});
  assert.equal(view.nodes.main,'skipped');assert.equal(view.nodes['rule:response-rule'],'completed');
  assert.equal(view.edges['post:serial-1'],'skipped');assert.equal(view.edges['policy:action:answer:serial-1'],'completed');assert.equal(view.edges['post:serial-2'],'completed');
  execution.status='block';execution.stage='post';execution.output='';execution.traces.find(trace=>trace.stage==='post')!.status='block';
  const blocked=workflowExecutionView(workflow,{execution});assert.equal(blocked.edges['policy:action:answer:serial-1'],'block');assert.equal(blocked.nodes['policy-node:answer'],'completed');assert.equal(blocked.nodes.output,'block');
});
test('policy error actions mark the action and output path while generation and POST stay skipped',()=>{
  const workflow=policyFixture(),view=workflowExecutionView(workflow,{execution:policyResult(workflow,'error')});
  assert.equal(view.nodes.policy,'completed');assert.equal(view.nodes['policy-node:reject'],'block');assert.equal(view.nodes.main,'skipped');
  assert.equal(view.edges['policy:edge:high'],'block');assert.equal(view.edges['policy:action:reject:output'],'block');assert.equal(view.edges['post:serial-1'],'skipped');
});
test('policy model failures and PRE blocks do not claim graph traversal',()=>{
  const workflow=policyFixture(),execution=policyResult(workflow);
  execution.status='error';execution.stage='pre';delete execution.policyRoute;delete execution.policyPath;
  execution.traces=execution.traces.filter(trace=>trace.stage==='pre'&&trace.traceType!=='policy');
  execution.traces.push({traceType:'policy',stage:'pre',ruleId:'policy',ruleName:'정책',groupId:'policy',status:'error',reason:'스키마 검증 실패',latencyMs:1});
  const failed=workflowExecutionView(workflow,{execution});assert.equal(failed.nodes.policy,'error');assert.equal(failed.edges['pre:serial-3'],'error');assert.equal(failed.edges['policy:entry'],'skipped');assert.equal(failed.nodes['policy-node:branch'],'skipped');
  execution.status='block';execution.traces=execution.traces.filter(trace=>trace.traceType!=='policy');execution.traces[0].status='block';
  const blocked=workflowExecutionView(workflow,{execution});assert.equal(blocked.nodes.policy,'skipped');assert.equal(blocked.edges['policy:entry'],'skipped');
});
test('live policy progress maps synthetic policy identifiers without borrowing old completed results',()=>{
  const workflow=policyFixture(),old=policyResult(workflow,'main');
  const start=workflowExecutionView(workflow,{execution:old,running:true,progress:[event(1,'pre','policy','running')]});
  assert.equal(start.nodes.policy,'running');assert.equal(start.nodes['policy-node:risk'],'idle');assert.equal(start.edges['policy:edge:service'],'idle');
  const progress=[event(1,'pre','policy','running'),event(2,'pre','policy:branch','completed'),event(3,'pre','policy:scope','completed'),event(4,'pre','policy:answer','completed'),event(5,'pre','policy','completed'),event(6,'main','main','skipped'),event(7,'post','start','completed',['serial-1']),event(8,'post','group:response','running')];
  const live=workflowExecutionView(workflow,{execution:old,progress,running:true});
  assert.equal(live.nodes['policy-node:scope'],'completed');assert.equal(live.nodes['policy-node:risk'],'idle');assert.equal(live.nodes.main,'skipped');assert.equal(live.edges['policy:edge:other'],'completed');assert.equal(live.edges['policy:action:answer:serial-1'],'running');assert.equal(live.edges['post:serial-1'],'idle');
});
test('ambiguous true and false links to one target stay neutral while actual visited nodes are shown',()=>{
  const workflow=policyFixture(),graph=workflow.policyRouting!.graph!;
  graph.edges.find(edge=>edge.id==='other')!.to='risk';
  const view=workflowExecutionView(workflow,{execution:policyResult(workflow)});
  assert.equal(view.nodes['policy-node:risk'],'completed');assert.equal(view.edges['policy:edge:service'],'unconfirmed');assert.equal(view.edges['policy:edge:other'],'unconfirmed');
});
test('console inspection identifies the exact selected port when both ports share a target',()=>{
  const workflow=policyFixture(),graph=workflow.policyRouting!.graph!;
  graph.edges.find(edge=>edge.id==='other')!.to='risk';
  const value={availability:'withheld',type:'json',summary:'비공개'} as const;
  const inspection={request:{messages:[],inputScope:'conversation' as const,inspectionText:''},nodes:[{nodeId:'policy-node:branch',kind:'policy-node' as const,stage:'pre' as const,status:'completed' as const,input:value,output:value,selectedPort:'true',selectedEdgeIds:['service']}]};
  const view=workflowExecutionView(workflow,{execution:policyResult(workflow),inspection});
  assert.equal(view.edges['policy:edge:service'],'completed');
  assert.equal(view.edges['policy:edge:other'],'skipped');
});
test('legacy policy decision routes and stale policy graphs retain truthful boundary states',()=>{
  const workflow=policyFixture(),routing=workflow.policyRouting!,execution=policyResult(workflow,'respond');
  const stale=workflowExecutionView(workflow,{execution,stale:true});assert.ok(Object.values(stale.nodes).every(value=>value==='stale'));assert.ok(Object.values(stale.edges).every(value=>value==='stale'));
  delete routing.policy.formatVersion;delete routing.graph;delete execution.policyPath;
  routing.routes=[{decision:'IN_SCOPE',action:'main'},{decision:'OUT_OF_SCOPE',action:'respond',responseText:'안내'}];execution.policyDecision='OUT_OF_SCOPE';
  execution.traces=execution.traces.filter(trace=>trace.traceType!=='policy');execution.traces.push({traceType:'policy',stage:'pre',ruleId:'policy',ruleName:'정책',groupId:'policy',status:'allow',reason:'판정 완료',latencyMs:1});
  const view=workflowExecutionView(workflow,{execution});assert.equal(view.nodes.policy,'completed');assert.equal(view.edges['policy:route:0:main'],'skipped');assert.equal(view.edges['policy:route:1:serial-1'],'completed');assert.equal(view.edges['post:serial-1'],'skipped');
});
