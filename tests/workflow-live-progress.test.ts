import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { executeWorkflow } from '../lib/aegis-engine.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { getStageGraph } from '../lib/workflow-graph.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { previewBranchSelection, buildBranchSelection } from '../lib/workflow-branching.ts';
import type { RuleGroup, WorkflowProgressEvent } from '../lib/aegis-types';

function fixture() { const state=initialState();const workflow=state.workflows[0];workflow.pre=[];workflow.post=[];return {state,workflow}; }
function keyword(id:string,pattern:string):RuleGroup{return {id,name:id,mode:'any',rules:[{id:`${id}-rule`,name:id,description:'',kind:'keyword',enabled:true,config:{pattern}}]};}
const generated=(content:string)=>Response.json({choices:[{message:{content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function within<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_done,reject)=>{timer=setTimeout(()=>reject(new Error('Progress readiness timeout.')),1500);})]);}finally{if(timer)clearTimeout(timer);}}

test('serial progress follows materialized edges and observer exceptions cannot change execution',async()=>{
  const {state,workflow}=fixture();workflow.pre=[keyword('first','never-match')];workflow.post=[keyword('last','never-match')];
  const events:WorkflowProgressEvent[]=[];
  const result=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'PRIVATE_REQUEST'}],{onProgress:(event:WorkflowProgressEvent)=>{events.push(structuredClone(event));}});
  assert.equal(result.status,'allow');assert.ok(events.length>0);
  assert.deepEqual(events.map(event=>event.sequence),events.map((_,index)=>index+1));
  assert.ok(events.some(event=>event.stage==='pre'&&event.nodeId==='group:first'&&event.status==='running'));
  assert.ok(events.some(event=>event.stage==='main'&&event.status==='running'));
  assert.equal(events.at(-1)?.stage,'complete');assert.equal(events.at(-1)?.status,'completed');
  for(const stage of ['pre','post'] as const){const ids=new Set(getStageGraph(workflow,stage).edges.map(edge=>edge.id));const reported=events.filter(event=>event.stage===stage).flatMap(event=>event.edgeIds);assert.ok(reported.length>0);assert.ok(reported.every(edge=>ids.has(edge)));}
  assert.ok(!JSON.stringify(events).includes('PRIVATE_REQUEST'));assert.ok(!JSON.stringify(events).includes(result.output));
  const observerFailure=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'PRIVATE_REQUEST'}],{onProgress:()=>{throw new Error('observer only');}});
  assert.equal(observerFailure.status,result.status);assert.equal(observerFailure.output,result.output);assert.deepEqual(observerFailure.traces.map(trace=>trace.status),result.traces.map(trace=>trace.status));
});

test('request blocking reports skips and never reports a running generation',async()=>{
  const {state,workflow}=fixture();workflow.pre=[keyword('deny','BLOCK_ME'),keyword('later','never')];workflow.post=[keyword('output','never')];
  const events:WorkflowProgressEvent[]=[];
  const result=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'BLOCK_ME'}],{onProgress:(event:WorkflowProgressEvent)=>events.push(event)});
  assert.equal(result.status,'block');assert.equal(result.output,'');
  assert.ok(events.some(event=>event.stage==='pre'&&event.nodeId==='group:deny'&&event.status==='block'));
  assert.ok(events.some(event=>event.stage==='pre'&&event.nodeId==='group:later'&&event.status==='skipped'));
  assert.ok(!events.some(event=>event.stage==='main'&&event.status==='running'));
  assert.ok(events.some(event=>event.stage==='main'&&event.status==='skipped'));
  assert.equal(events.at(-1)?.stage,'complete');assert.equal(events.at(-1)?.status,'block');
});

test('condition progress reports the chosen edge and skipped inactive nodes',async()=>{
  const {state,workflow}=fixture();workflow.pre=[keyword('left','never'),keyword('right','never')];
  const choice=previewBranchSelection(workflow,'pre',['left','right'],'condition');assert.equal(choice.valid,true,choice.reason);
  const branched=buildBranchSelection(workflow,choice,{condition:{operator:'contains',value:'choose-left'}}).workflow;
  const events:WorkflowProgressEvent[]=[];
  const result=await executeWorkflow(branched,state.connections,state.ingress,{},[{role:'user',content:'choose-left'}],{onProgress:(event:WorkflowProgressEvent)=>events.push(event)});
  assert.equal(result.status,'allow');
  const conditional=branched.graph!.pre.nodes.find(node=>node.kind==='condition')!;
  const outgoing=branched.graph!.pre.edges.filter(edge=>edge.from===`control:${conditional.id}`);
  const completed=events.find(event=>event.stage==='pre'&&event.nodeId===`control:${conditional.id}`&&event.status==='completed');
  assert.deepEqual(completed?.edgeIds,[outgoing.find(edge=>edge.port==='true')!.id]);
  assert.ok(events.some(event=>event.nodeId==='group:right'&&event.status==='skipped'));
  assert.ok(!events.some(event=>event.nodeId==='group:right'&&event.status==='running'));
});

test('parallel groups emit running progress before either guarded model returns',async()=>{
  const {state,workflow}=fixture();const connections=state.connections;connections[1].mode='vllm';connections[1].baseUrl='https://guard.example.com/v1';state.ingress.allowedOrigins=['https://guard.example.com'];
  workflow.pre=['a','b'].map(id=>({id,name:id,mode:'any' as const,rules:[{id:`${id}-rule`,name:id,description:'',kind:'llm' as const,enabled:true,config:{connectionId:connections[1].id,prompt:'검사 기준'}}]}));
  const choice=previewBranchSelection(workflow,'pre',['a','b'],'parallel');const branched=buildBranchSelection(workflow,choice).workflow;
  const original=globalThis.fetch,gate=deferred<Response>(),started=deferred<void>();let calls=0;const events:WorkflowProgressEvent[]=[];
  globalThis.fetch=async()=>{calls++;if(calls===2)started.resolve();return (await gate.promise).clone();};
  const execution=executeWorkflow(branched,connections,state.ingress,{},[{role:'user',content:'요청'}],{onProgress:(event:WorkflowProgressEvent)=>events.push(event)});
  try{await within(started.promise);assert.ok(['a','b'].every(id=>events.some(event=>event.nodeId===`group:${id}`&&event.status==='running')));assert.ok(!events.some(event=>event.stage==='main'&&event.status==='running'));gate.resolve(generated('{"verdict":"allow","reason":"ok"}'));assert.equal((await within(execution)).status,'allow');}
  finally{gate.resolve(generated('{"verdict":"allow","reason":"ok"}'));await execution;globalThis.fetch=original;}
});

test('regeneration progress distinguishes output attempts and never repeats request checks',async()=>{
  const {state,workflow}=fixture();workflow.pre=[keyword('once','never')];workflow.post=[keyword('output','REJECTED_SECRET')];workflow.responseRetry={enabled:true,maxRetries:1};
  state.connections[0].mode='vllm';state.connections[0].baseUrl='https://main.example.com/v1';state.ingress.allowedOrigins=['https://main.example.com'];
  const original=globalThis.fetch;let calls=0;const events:WorkflowProgressEvent[]=[];
  globalThis.fetch=async()=>generated(++calls===1?'REJECTED_SECRET':'안전한 결과');
  try{const result=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'요청'}],{onProgress:(event:WorkflowProgressEvent)=>events.push(event)});assert.equal(result.status,'allow');assert.equal(calls,2);assert.equal(events.filter(event=>event.stage==='pre'&&event.nodeId==='group:once'&&event.status==='running').length,1);assert.deepEqual(events.filter(event=>event.stage==='main'&&event.status==='running').map(event=>event.attempt),[1,2]);assert.deepEqual(events.filter(event=>event.stage==='post'&&event.nodeId==='group:output'&&event.status==='running').map(event=>event.attempt),[1,2]);assert.ok(events.some(event=>event.stage==='post'&&event.status==='block'&&event.attempt===1));assert.ok(!JSON.stringify(events).includes('REJECTED_SECRET'));assert.equal(result.output,'안전한 결과');}
  finally{globalThis.fetch=original;}
});
