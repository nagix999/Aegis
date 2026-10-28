import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error Node source tests use explicit TypeScript paths.
import {executeWorkflow,validateWorkflow} from '../lib/aegis-engine.ts';
// @ts-expect-error Node source tests use explicit TypeScript paths.
import {createExecutionPlan,effectiveExecutionLimits} from '../lib/execution-plan.ts';
// @ts-expect-error Node source tests use explicit TypeScript paths.
import {initialState} from '../lib/aegis-seed.ts';
import type {RuleGroup,Workflow} from '../lib/aegis-types';
function fixture(){const state=initialState();state.workflows[0].pre=[];state.workflows[0].post=[];return state;}
const guard=(id:string):RuleGroup=>({id,name:id,mode:'any',rules:[{id:`rule-${id}`,name:id,description:'',kind:'llm',enabled:true,config:{connectionId:'conn-guard',prompt:'분류'}}]});
const reply=(text:string)=>Response.json({choices:[{message:{content:text},finish_reason:'stop'}]});
function live(state:ReturnType<typeof initialState>){for(const c of state.connections){c.mode='vllm';c.baseUrl=`https://${c.id}.example/v1`;c.timeoutMs=60_000;}state.ingress.allowedOrigins=state.connections.map(c=>new URL(c.baseUrl).origin);}

test('inspection scopes select user text without changing generation messages',async()=>{
 const state=fixture(),workflow=state.workflows[0],messages=[{role:'system' as const,content:'금지 문구'},{role:'user' as const,content:'예전 금지 문구'},{role:'assistant' as const,content:'금지 문구'},{role:'user' as const,content:'배송 문의'}];
 workflow.pre=[{id:'check',name:'검사',mode:'any',rules:[{id:'keyword',name:'금지',description:'',enabled:true,kind:'keyword',config:{pattern:'금지 문구'}}]}];
 const run=()=>executeWorkflow(workflow,state.connections,state.ingress,{},messages);
 assert.equal((await run()).status,'block');workflow.inputScope='user_messages';assert.equal((await run()).status,'block');workflow.inputScope='last_user';assert.equal((await run()).status,'allow');
 live(state);const original=globalThis.fetch;let sent:unknown;
 globalThis.fetch=async(_url,options)=>{sent=JSON.parse(String(options?.body)).messages;return reply('응답');};
 try{assert.equal((await run()).status,'allow');assert.deepEqual(sent,messages);}finally{globalThis.fetch=original;}
});

test('model call budget includes guards, main calls and regeneration and never releases rejected output',async()=>{
 const state=fixture();live(state);const workflow=state.workflows[0];workflow.pre=[guard('pre')];workflow.post=[{id:'post',name:'응답',mode:'any',rules:[{id:'deny',name:'차단',description:'',enabled:true,kind:'keyword',config:{pattern:'차단 내용'}}]}];workflow.responseRetry={enabled:true,maxRetries:3};workflow.executionLimits={timeoutMs:120000,maxModelCalls:2};
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async url=>{calls++;return reply(String(url).includes('conn-guard')?'{"verdict":"allow","reason":"통과"}':'차단 내용');};
 try{const result=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'질문'}]);assert.equal(calls,2);assert.equal(result.status,'error');assert.equal(result.stage,'main');assert.match(result.reason,/호출 한도/);assert.equal(result.output,'');}finally{globalThis.fetch=original;}
});

test('parallel guards share a single synchronous model call budget',async()=>{
 const state=fixture();live(state);const workflow=state.workflows[0];workflow.pre=[{...guard('first'),rules:[...guard('first').rules,...guard('second').rules]}];workflow.executionLimits={timeoutMs:120000,maxModelCalls:1};
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return reply('{"verdict":"allow","reason":"통과"}');};
 try{const result=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'질문'}]);assert.equal(calls,1);assert.equal(result.status,'error');assert.equal(result.output,'');assert.ok(result.traces.some(trace=>trace.ruleId==='main'&&trace.status==='skipped'));}finally{globalThis.fetch=original;}
});

test('whole execution deadline terminates a stalled guard even if fetch ignores abort',async context=>{
 context.mock.timers.enable({apis:['setTimeout','Date']});
 const state=fixture();live(state);const workflow=state.workflows[0];workflow.pre=[guard('pre')];workflow.executionLimits={timeoutMs:1000,maxModelCalls:64};
 const original=globalThis.fetch;let calls=0,signal:AbortSignal|undefined;
 globalThis.fetch=async(_url,options)=>{calls++;signal=options?.signal??undefined;return await new Promise<Response>(()=>{});};
 try{const pending=executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'질문'}]);context.mock.timers.tick(1001);const result=await pending;assert.equal(calls,1);assert.equal(signal?.aborted,true);assert.equal(result.status,'error');assert.equal(result.stage,'pre');assert.match(result.reason,/전체 실행 제한/);assert.equal(result.output,'');}finally{globalThis.fetch=original;context.mock.timers.reset();}
});

test('caller cancellation stops subsequent work and sends an upstream abort signal',async()=>{
 const state=fixture();live(state);const workflow=state.workflows[0];workflow.pre=[guard('pre')];
 const original=globalThis.fetch;let calls=0,signal:AbortSignal|undefined;const controller=new AbortController();
 globalThis.fetch=async(_url,options)=>{calls++;signal=options?.signal??undefined;return await new Promise<Response>(()=>{});};
 try{const pending=executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'질문'}],{signal:controller.signal});controller.abort();const result=await pending;assert.equal(calls,1);assert.equal(signal?.aborted,true);assert.equal(result.status,'error');assert.equal(result.output,'');assert.match(result.reason,/취소/);assert.ok(result.traces.some(trace=>trace.ruleId==='main'&&trace.status==='skipped'));}finally{globalThis.fetch=original;}
});

test('execution plan snapshots graph and rule definitions and rejects invalid limits',()=>{
 const state=fixture(),workflow=state.workflows[0];workflow.pre=[guard('pre')];const plan=createExecutionPlan(workflow);workflow.pre[0].rules[0].config.prompt='변경';assert.equal(plan.pre.groups[0].rules[0].config.prompt,'분류');assert.deepEqual(plan.pre.outgoing.get('start')?.map(edge=>edge.to),['group:pre']);assert.deepEqual(effectiveExecutionLimits(workflow),{timeoutMs:120000,maxModelCalls:64});
 for(const settings of [{timeoutMs:999,maxModelCalls:1},{timeoutMs:600001,maxModelCalls:1},{timeoutMs:120000,maxModelCalls:0},{timeoutMs:120000,maxModelCalls:1001}]){const invalid={...workflow,executionLimits:settings};assert.ok(validateWorkflow(invalid,state.connections).length);assert.throws(()=>createExecutionPlan(invalid));}
 assert.ok(validateWorkflow({...workflow,inputScope:'invalid'} as unknown as Workflow,state.connections).length);
});
