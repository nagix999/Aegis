import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node source runner resolves TypeScript paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node source runner resolves TypeScript paths.
import { changePolicyRouteAction, policyRoutingErrors } from '../lib/policy-routing.ts';
// @ts-expect-error Node source runner resolves TypeScript paths.
import { configurationFingerprint } from '../lib/workflow-review.ts';
// @ts-expect-error Node source runner resolves TypeScript paths.
import { getWorkflowCanvasLinks } from '../lib/workflow-policy-canvas.ts';
// @ts-expect-error Node source runner resolves TypeScript paths.
import { isRecoverableWorkflow, saveWorkflowRecovery, readWorkflowRecovery } from '../lib/workflow-recovery.ts';
// @ts-expect-error Node source runner resolves TypeScript paths.
import { workflowExecutionView } from '../lib/workflow-execution-view.ts';
import type { ExecutionResult, PolicyGraphNode, Workflow } from '../lib/aegis-types';
function fixture():Workflow {
  const state=initialState(),workflow=structuredClone(state.workflows[0]);delete workflow.graph;delete workflow.layout;
  workflow.pre=[];workflow.post=[{id:'post',name:'POST',mode:'any',rules:[{id:'post-rule',name:'검사',kind:'keyword',enabled:true,description:'',config:{pattern:'registered'}}]}];
  workflow.policyRouting={policy:{id:'mode-policy',name:'정책',description:'',prompt:'분류하세요.',connectionId:state.connections[1].id,connectionSnapshot:state.connections[1],version:1,updatedAt:'2026-10-30T00:00:00Z',formatVersion:2,decisions:[],examples:[{id:'e',input:'request',expectedOutput:{ok:true}}],outputSchema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok']}},routes:[],graph:{version:1,entryNodeId:'condition',nodes:[{id:'condition',name:'분기',kind:'branch',condition:{mode:'all',predicates:[{path:'/ok',operator:'exists'}]}},{id:'response',name:'안내',kind:'action',action:'respond',responseText:'registered'}],edges:[{id:'yes',from:'condition',to:'response',port:'true'},{id:'no',from:'condition',to:'response',port:'false'}]}};
  return workflow;
}
const action=(workflow:Workflow)=>workflow.policyRouting!.graph!.nodes[1] as Extract<PolicyGraphNode,{kind:'action'}>;
test('registered-response projection defaults to POST and immediate connects only to final output',()=>{
  const workflow=fixture(),before=structuredClone(workflow);
  const outgoing=()=>getWorkflowCanvasLinks(workflow).filter(edge=>edge.from==='policy-node:response');
  assert.deepEqual(outgoing().map(edge=>edge.to),['rule:post-rule']);
  action(workflow).responseMode='immediate';assert.deepEqual(outgoing().map(edge=>edge.to),['output']);
  action(workflow).responseMode='post';assert.deepEqual(outgoing().map(edge=>edge.to),['rule:post-rule']);
  assert.equal(action(before).responseMode,undefined);
});
test('explicit POST and omitted mode have identical execution evidence while immediate invalidates it',async()=>{
  const workflow=fixture(),connections=initialState().connections,base=await configurationFingerprint(workflow,connections);
  action(workflow).responseMode='post';assert.equal(await configurationFingerprint(workflow,connections),base);
  action(workflow).responseMode='immediate';assert.notEqual(await configurationFingerprint(workflow,connections),base);
});
test('response modes survive browser recovery and unsupported modes fail validation',()=>{
  const workflow=fixture();action(workflow).responseMode='immediate';
  const data=new Map<string,string>(),storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};
  assert.equal(isRecoverableWorkflow(workflow),true);assert.equal(saveWorkflowRecovery(storage,workflow,workflow).ok,true);
  assert.equal(action(readWorkflowRecovery(storage).records[0].draft).responseMode,'immediate');
  (action(workflow) as unknown as {responseMode:string}).responseMode='unknown';
  assert.ok(policyRoutingErrors(workflow.policyRouting!).length);assert.equal(isRecoverableWorkflow(workflow),false);
});
test('changing away from registered response removes mode and response text',()=>{
  for(const next of ['main','error'] as const){const route=changePolicyRouteAction({decision:'SAFE',action:'respond',responseText:'registered',responseMode:'immediate'},next);assert.equal(Object.hasOwn(route,'responseMode'),false);assert.equal(Object.hasOwn(route,'responseText'),false);}
});
test('immediate execution colors final output and leaves POST and Main skipped',()=>{
  const workflow=fixture();action(workflow).responseMode='immediate';
  const execution:ExecutionResult={id:'result',status:'allow',stage:'complete',output:'registered',reason:'등록 응답',latencyMs:1,policyRoute:'respond',policyResponseMode:'immediate',policyPath:['condition','response'],traces:[{traceType:'policy',ruleId:'policy',ruleName:'정책',groupId:'policy',stage:'pre',status:'allow',reason:'통과',latencyMs:1},{ruleId:'main',ruleName:'Main',groupId:'main',stage:'main',status:'skipped',reason:'생략',latencyMs:0},{ruleId:'post-rule',ruleName:'검사',groupId:'post',stage:'post',status:'skipped',reason:'생략',latencyMs:0}]};
  const view=workflowExecutionView(workflow,{execution});assert.equal(view.nodes.output,'completed');assert.equal(view.nodes.main,'skipped');assert.equal(view.nodes['rule:post-rule'],'skipped');assert.equal(view.edges['policy:action:response:output'],'completed');
});
