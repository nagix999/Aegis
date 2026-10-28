import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { handleEvaluationAction, EvaluationError } from '../lib/evaluation-service.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { configurationFingerprint, datasetFingerprint } from '../lib/workflow-review.ts';
import type { AegisStore } from '../lib/aegis-store';
import type { AppState, DatasetRow, EvalRun, RequestLog } from '../lib/aegis-types';

class MemoryStore {
  records=new Map<string,string>();
  logs:RequestLog[]=[];
  async put(namespace:string,id:string,value:unknown){this.records.set(`${namespace}/${id}`,JSON.stringify(value));}
  async insertEvaluationRun(run:EvalRun,maxRunning=4){
    const running=[...this.records.entries()].filter(([key,payload])=>key.startsWith('run/')&&JSON.parse(payload).status==='running').length;
    if(running>=maxRunning)return false;
    this.records.set(`run/${run.id}`,JSON.stringify(run));return true;
  }
  async getRecordWithVersion<T>(namespace:string,id:string):Promise<{value:T;revision:string}|null>{const payload=this.records.get(`${namespace}/${id}`);return payload?{value:JSON.parse(payload) as T,revision:payload}:null;}
  async compareAndSwap(namespace:string,id:string,revision:string,value:unknown){const key=`${namespace}/${id}`;if(this.records.get(key)!==revision)return false;this.records.set(key,JSON.stringify(value));return true;}
  async log(log:RequestLog){this.logs.push(structuredClone(log));}
}
type Reply={run:EvalRun;leaseActive?:boolean};
function fixture(rows?:DatasetRow[]){
  const state=initialState() as AppState;const memory=new MemoryStore();
  state.datasets[0].rows=rows??[
    {id:'r1',input:'  배송은 보통 얼마나 걸리나요?\n',expected:'allow',category:'정상',note:'기본 응답',expectedStage:'complete'},
    {id:'r2',input:'연락처 user@example.com',expected:'block',category:'개인정보',expectedStage:'pre',expectedRuleId:'rule-pii'},
    {id:'r3',input:'담당자 연락처 예시를 보여주세요.',expected:'block',category:'응답 유출',expectedStage:'post',expectedRuleId:'rule-output-pii'},
  ];
  const store=memory as unknown as AegisStore;
  const action=async(data:Record<string,unknown>)=>await handleEvaluationAction(data,state,store,{}) as Reply;
  const start=(extra:Record<string,unknown>={})=>action({action:'start_evaluation',workflowId:'wf-support',datasetId:'ds-security',target:'draft',...extra});
  return {state,memory,store,action,start};
}
function deferred(){let resolve=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

test('starting a durable job captures immutable settings and does not execute rows',async()=>{
  const f=fixture();const workflow=structuredClone(f.state.workflows[0]);const dataset=structuredClone(f.state.datasets[0]);const connections=structuredClone(f.state.connections);
  const {run}=await f.start();
  assert.equal(run.status,'running');assert.equal(run.total,3);assert.deepEqual(run.results,[]);assert.equal(f.memory.logs.length,0);
  assert.equal(run.fingerprint,await configurationFingerprint(workflow,connections));assert.equal(run.datasetFingerprint,await datasetFingerprint(dataset));
  f.state.workflows[0].pre[0].rules[0].config.pattern='배송';f.state.datasets[0].rows[0].input='source changed';f.state.connections[0].model='changed-model';
  const stepped=await f.action({action:'step_evaluation',runId:run.id});
  assert.equal(stepped.run.results.length,2);assert.equal(stepped.run.status,'running');assert.equal(stepped.run.pendingRowIds?.length,1);
  assert.equal(stepped.run.results[0].input,dataset.rows[0].input);assert.equal(stepped.run.results[0].status,'allow');assert.equal(stepped.run.connectionsSnapshot?.find(connection=>connection.id==='conn-main')?.model,connections.find(connection=>connection.id==='conn-main')?.model);
  const completed=await f.action({action:'step_evaluation',runId:run.id});assert.equal(completed.run.status,'completed');assert.equal(completed.run.results.length,3);
  assert.ok(completed.run.results.every(row=>row.expectationMatched));
});

test('comparison executes the same saved rows against draft and deployed snapshots',async()=>{
  const f=fixture([{id:'compare',input:'연락처 user@example.com',expected:'allow',expectedStage:'complete'}]);
  const original=structuredClone(f.state.workflows[0]);
  f.state.deployments=[{id:'deployment',workflowId:original.id,alias:original.alias,version:1,createdAt:new Date().toISOString(),workflow:original,connections:structuredClone(f.state.connections)}];
  f.state.workflows[0].pre=[];f.state.workflows[0].post=[];
  const {run}=await f.start({compare:true});f.state.deployments[0].workflow.pre=[];
  const {run:completed}=await f.action({action:'step_evaluation',runId:run.id});
  assert.equal(completed.status,'completed');assert.equal(completed.results[0].status,'allow');assert.equal(completed.results[0].expectationMatched,true);
  assert.equal(completed.baselineResults?.[0].status,'block');assert.equal(completed.baselineResults?.[0].expectationMatched,false);
  assert.equal(completed.results[0].rowId,completed.baselineResults?.[0].rowId);assert.equal(completed.results[0].input,completed.baselineResults?.[0].input);assert.equal(completed.baselineVersion,'v1');
});

test('expectation matching checks verdict, stage and rule while preserving dataset annotations',async()=>{
  const f=fixture([
    {id:'match',input:'email user@example.com',expected:'block',expectedStage:'pre',expectedRuleId:'rule-pii',category:'PII',note:'이메일 차단'},
    {id:'wrong-stage',input:'email user@example.com',expected:'block',expectedStage:'post'},
    {id:'wrong-rule',input:'email user@example.com',expected:'block',expectedRuleId:'rule-safety'},
  ]);
  const {run}=await f.action({action:'run_evaluation',workflowId:'wf-support',datasetId:'ds-security',target:'draft'});
  assert.equal(run.status,'completed');assert.deepEqual(run.results.map(row=>row.expectationMatched),[true,false,false]);
  assert.equal(run.results[0].category,'PII');assert.equal(run.results[0].note,'이메일 차단');assert.equal(run.results[0].expectedRuleId,'rule-pii');
  assert.equal(f.memory.logs.length,3);assert.deepEqual(f.memory.logs.map(log=>log.id),run.results.map(row=>row.id));
  assert.ok(f.memory.logs.every(log=>log.workflowId==='wf-support'&&log.traces?.length));
  assert.ok(!JSON.stringify(f.memory.logs).includes('user@example.com'));assert.ok(!JSON.stringify(f.memory.logs).includes('email user'));
});

test('cancellation retains completed batches and prevents further execution',async()=>{
  const f=fixture();const {run}=await f.start();const first=await f.action({action:'step_evaluation',runId:run.id});
  assert.equal(first.run.results.length,2);const logCount=f.memory.logs.length;
  const cancelled=await f.action({action:'cancel_evaluation',runId:run.id});assert.equal(cancelled.run.status,'cancelled');assert.equal(cancelled.run.pendingRowIds?.length,1);
  const after=await f.action({action:'step_evaluation',runId:run.id});assert.equal(after.run.status,'cancelled');assert.equal(after.run.results.length,2);assert.equal(f.memory.logs.length,logCount);
});

test('concurrent HTTP steps share a CAS lease and cannot execute a batch twice',async()=>{
  const f=fixture([{id:'only',input:'일반 문의',expected:'allow'}]);f.state.workflows[0].pre=[];f.state.workflows[0].post=[];
  f.state.connections[0]={...f.state.connections[0],mode:'vllm',baseUrl:'https://model.example.com/v1'};f.state.ingress.allowedOrigins=['https://model.example.com'];
  const gate=deferred();const started=deferred();let calls=0;const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{calls++;started.resolve();await gate.promise;return Response.json({choices:[{message:{content:'확인했습니다.'}}]});};
  try{
    const {run}=await f.start();const first=f.action({action:'step_evaluation',runId:run.id});await started.promise;
    const second=await f.action({action:'step_evaluation',runId:run.id});assert.equal(second.leaseActive,true);assert.equal(second.run.results.length,0);assert.equal(calls,1);
    gate.resolve();const completed=await first;assert.equal(completed.run.status,'completed');assert.equal(completed.run.results.length,1);assert.equal(f.memory.logs.length,1);assert.equal(calls,1);
    const repeated=await f.action({action:'step_evaluation',runId:run.id});assert.equal(repeated.run.results.length,1);assert.equal(calls,1);
  }finally{gate.resolve();globalThis.fetch=originalFetch;}
});

test('an in-flight batch cannot resurrect a cancelled job',async()=>{
  const f=fixture([{id:'only',input:'일반 문의',expected:'allow'}]);f.state.workflows[0].pre=[];f.state.workflows[0].post=[];
  f.state.connections[0]={...f.state.connections[0],mode:'vllm',baseUrl:'https://model.example.com/v1'};f.state.ingress.allowedOrigins=['https://model.example.com'];
  const gate=deferred();const started=deferred();const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{started.resolve();await gate.promise;return Response.json({choices:[{message:{content:'완료'}}]});};
  try{
    const {run}=await f.start();const first=f.action({action:'step_evaluation',runId:run.id});await started.promise;
    await f.action({action:'cancel_evaluation',runId:run.id});gate.resolve();const after=await first;
    assert.equal(after.run.status,'cancelled');assert.equal(after.run.results.length,0);assert.deepEqual(after.run.pendingRowIds,['only']);
    const saved=await f.memory.getRecordWithVersion<EvalRun>('run',run.id);assert.equal(saved?.value.status,'cancelled');
  }finally{gate.resolve();globalThis.fetch=originalFetch;}
});

test('retry creates an independent error-only run and leaves the original untouched',async()=>{
  const f=fixture([{id:'good',input:'정상 문의',expected:'allow'},{id:'error',input:'오류 문의',expected:'allow'}]);f.state.workflows[0].pre=[];f.state.workflows[0].post=[];
  f.state.connections[0]={...f.state.connections[0],mode:'vllm',baseUrl:'https://model.example.com/v1'};f.state.ingress.allowedOrigins=['https://model.example.com'];
  const originalFetch=globalThis.fetch;let fail=true;
  globalThis.fetch=async(_input,init)=>{const body=JSON.parse(String(init?.body));if(fail&&body.messages[0].content==='오류 문의')throw new Error('private model details');return Response.json({choices:[{message:{content:'안전한 답변'}}]});};
  try{
    const {run}=await f.action({action:'run_evaluation',workflowId:'wf-support',datasetId:'ds-security',target:'draft'});assert.deepEqual(run.results.map(row=>row.status),['allow','error']);
    const original=JSON.stringify(run);f.state.workflows[0].name='현재 설정 변경';f.state.datasets[0].rows=[];
    const {run:retry}=await f.action({action:'retry_evaluation',runId:run.id});assert.notEqual(retry.id,run.id);assert.equal(retry.retryOf,run.id);assert.equal(retry.total,1);assert.deepEqual(retry.pendingRowIds,['error']);assert.equal(retry.workflowName,run.workflowName);
    fail=false;const completed=await f.action({action:'step_evaluation',runId:retry.id});assert.equal(completed.run.results.length,1);assert.equal(completed.run.results[0].rowId,'error');assert.equal(completed.run.results[0].status,'allow');
    assert.equal(JSON.stringify((await f.memory.getRecordWithVersion<EvalRun>('run',run.id))?.value),original);
    await assert.rejects(f.action({action:'retry_evaluation',runId:retry.id}),(error:unknown)=>error instanceof EvaluationError&&error.code==='evaluation_no_errors');
  }finally{globalThis.fetch=originalFetch;}
});

test('replay reuses every saved row and both comparison snapshots after source deletion',async()=>{
  const f=fixture();const workflow=structuredClone(f.state.workflows[0]);f.state.deployments=[{id:'d',workflowId:workflow.id,alias:workflow.alias,version:1,createdAt:new Date().toISOString(),workflow,connections:structuredClone(f.state.connections)}];
  const {run}=await f.action({action:'run_evaluation',workflowId:workflow.id,datasetId:'ds-security',target:'draft',compare:true});
  f.state.workflows=[];f.state.connections=[];f.state.datasets=[];f.state.deployments=[];
  const {run:replay}=await f.action({action:'replay_evaluation',runId:run.id});assert.equal(replay.replayOf,run.id);assert.equal(replay.total,3);assert.equal(replay.fingerprint,run.fingerprint);assert.equal(replay.datasetFingerprint,run.datasetFingerprint);assert.equal(replay.baselineVersion,'v1');
  const first=await f.action({action:'step_evaluation',runId:replay.id});const completed=await f.action({action:'step_evaluation',runId:first.run.id});
  assert.equal(completed.run.status,'completed');assert.equal(completed.run.results.length,3);assert.equal(completed.run.baselineResults?.length,3);assert.deepEqual(completed.run.results.map(row=>row.status),run.results.map(row=>row.status));
});

test('an error on the comparison baseline also makes a row eligible for retry',async()=>{
  const f=fixture([{id:'baseline-error',input:'일반 문의',expected:'allow'}]);f.state.workflows[0].pre=[];f.state.workflows[0].post=[];
  const workflow=structuredClone(f.state.workflows[0]);const connections=structuredClone(f.state.connections);
  connections[0]={...connections[0],mode:'vllm',baseUrl:'https://baseline.example.com/v1'};f.state.ingress.allowedOrigins=['https://baseline.example.com'];
  f.state.deployments=[{id:'d',workflowId:workflow.id,alias:workflow.alias,version:1,createdAt:new Date().toISOString(),workflow,connections}];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('baseline unavailable');};
  try{
    const {run}=await f.action({action:'run_evaluation',workflowId:workflow.id,datasetId:'ds-security',target:'draft',compare:true});
    assert.equal(run.results[0].status,'allow');assert.equal(run.baselineResults?.[0].status,'error');
    const {run:retry}=await f.action({action:'retry_evaluation',runId:run.id});assert.deepEqual(retry.pendingRowIds,['baseline-error']);assert.ok(retry.baselineWorkflowSnapshot);assert.equal(retry.baselineResults?.length,0);
  }finally{globalThis.fetch=originalFetch;}
});

test('invalid comparison and oversized snapshots fail before a job is created',async()=>{
  const f=fixture();await assert.rejects(f.start({compare:true}),(error:unknown)=>error instanceof EvaluationError&&error.code==='not_deployed');
  f.state.datasets[0].rows=Array.from({length:100},(_,index)=>({id:`large-${index}`,input:'한'.repeat(16000),expected:'allow'}));
  await assert.rejects(f.start(),(error:unknown)=>error instanceof EvaluationError&&error.code==='evaluation_result_too_large');assert.equal(f.memory.records.size,0);
  assert.equal(await handleEvaluationAction({action:'unknown'},f.state,f.store,{}),undefined);
});

test('concurrent starts enforce capacity atomically despite a shared stale state',async()=>{
  const f=fixture();
  const results=await Promise.allSettled(Array.from({length:20},()=>f.start()));
  const created=results.filter(result=>result.status==='fulfilled');
  const rejected=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
  assert.equal(created.length,4);assert.equal(rejected.length,16);
  assert.ok(rejected.every(result=>result.reason instanceof EvaluationError&&result.reason.status===409&&result.reason.code==='evaluation_job_limit'));
  assert.equal([...f.memory.records.values()].filter(payload=>JSON.parse(payload).status==='running').length,4);
  const active=(created[0] as PromiseFulfilledResult<Reply>).value.run;
  await f.action({action:'cancel_evaluation',runId:active.id});
  const replay=await f.action({action:'replay_evaluation',runId:active.id});assert.equal(replay.run.status,'running');
  await assert.rejects(f.action({action:'replay_evaluation',runId:active.id}),(error:unknown)=>error instanceof EvaluationError&&error.code==='evaluation_job_limit');
});
