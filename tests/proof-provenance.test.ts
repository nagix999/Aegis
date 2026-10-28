import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's source runner uses explicit TypeScript paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's source runner uses explicit TypeScript paths.
import { configurationFingerprint, executionConfiguration, workflowChanges } from '../lib/workflow-review.ts';
// @ts-expect-error Node's source runner uses explicit TypeScript paths.
import { ENGINE_VERSION } from '../lib/execution-provenance.ts';
// @ts-expect-error Node's source runner uses explicit TypeScript paths.
import { DEFAULT_EXECUTION_TIMEOUT_MS, DEFAULT_MAX_MODEL_CALLS } from '../lib/execution-plan.ts';
// @ts-expect-error Node's source runner uses explicit TypeScript paths.
import { handleEvaluationAction } from '../lib/evaluation-service.ts';
// @ts-expect-error Node's source runner uses explicit TypeScript paths.
import { verifyDeploymentEvidence, DeploymentVerificationError } from '../lib/deployment-verification.ts';
// @ts-expect-error Node's source runner uses explicit TypeScript paths.
import { executeWorkflow } from '../lib/aegis-engine.ts';
import type { AegisStore } from '../lib/aegis-store';
import type { Deployment, EvalRun } from '../lib/aegis-types';

class MemoryStore {
  records=new Map<string,string>();
  async getRecordWithVersion<T>(namespace:string,id:string){const revision=this.records.get(`${namespace}/${id}`);return revision?{value:JSON.parse(revision) as T,revision}:null;}
  async put(namespace:string,id:string,value:unknown){this.records.set(`${namespace}/${id}`,JSON.stringify(value));}
  async insertEvaluationRun(run:EvalRun){await this.put('run',run.id,run);return true;}
  async compareAndSwap(namespace:string,id:string,revision:string,value:unknown){if(this.records.get(`${namespace}/${id}`)!==revision)return false;await this.put(namespace,id,value);return true;}
  async log(){}
  async getDeployment(id:string){return (await this.getRecordWithVersion<Deployment>('deployment',id))?.value??null;}
}
function fixture(){
  const state=initialState(),memory=new MemoryStore();
  state.workflows[0].pre=[];state.workflows[0].post=[];
  state.datasets[0].rows=[{id:'proof-row',input:'원문은 배포 근거 요약에 남기지 않음',expected:'allow'}];
  const store=memory as unknown as AegisStore;
  const action=async(data:Record<string,unknown>)=>(await handleEvaluationAction(data,state,store,{})) as {run:EvalRun};
  const complete=async()=>{await memory.put('dataset',state.datasets[0].id,state.datasets[0]);return (await action({action:'run_evaluation',workflowId:state.workflows[0].id,datasetId:state.datasets[0].id})).run;};
  return {state,memory,store,action,complete};
}

test('display names, descriptions and API alias preserve execution evidence across every node kind',async()=>{
  const state=initialState(),workflow=state.workflows[0];
  const serial=(stage:'pre'|'post')=>{const keys=['start',...workflow[stage].map(group=>`group:${group.id}`),'end'];return{nodes:[],edges:keys.slice(0,-1).map((from,index)=>({id:`${stage}-${index}`,from,to:keys[index+1]}))};};
  workflow.graph={version:1,pre:serial('pre'),post:serial('post')};
  workflow.graph.pre={nodes:[{id:'route',name:'내용 분기',kind:'condition',condition:{operator:'contains',value:'배송'}},{id:'merge',name:'경로 합류',kind:'join'}],edges:[
    {id:'entry',from:'start',to:'control:route'},
    {id:'yes',from:'control:route',to:`group:${workflow.pre[0].id}`,port:'true'},
    {id:'no',from:'control:route',to:`group:${workflow.pre[1].id}`,port:'false'},
    {id:'yes-merge',from:`group:${workflow.pre[0].id}`,to:'control:merge'},
    {id:'no-merge',from:`group:${workflow.pre[1].id}`,to:'control:merge'},
    {id:'exit',from:'control:merge',to:'end'},
  ]};
  const before=await configurationFingerprint(workflow,state.connections);
  workflow.name='관리 화면 이름 변경';workflow.description='설명 변경';workflow.alias='renamed-alias';
  for(const group of [...workflow.pre,...workflow.post]){group.name+=' 이름';for(const rule of group.rules){rule.name+=' 이름';rule.description+=' 설명';}}
  for(const node of workflow.graph.pre.nodes)node.name+=' 이름';
  const connections=state.connections.map(connection=>({...connection,name:connection.name+' 이름'}));
  assert.equal(await configurationFingerprint(workflow,connections),before);
  assert.equal(Object.hasOwn(executionConfiguration(workflow),'alias'),false);
  workflow.pre[0].rules[0].enabled=false;
  assert.notEqual(await configurationFingerprint(workflow,connections),before);
});

test('renaming display metadata cannot alter model input during response regeneration',async()=>{
  const state=initialState(),workflow=state.workflows[0];workflow.pre=[];
  workflow.post=[{id:'response-check',name:'응답 검사',mode:'any',rules:[{id:'response-rule',name:'제한 문구',description:'표시 설명',kind:'keyword',enabled:true,config:{pattern:'PRIVATE_MARKER'}}]}];
  workflow.responseRetry={enabled:true,maxRetries:1};
  state.connections[0]={...state.connections[0],mode:'vllm',baseUrl:'https://provenance-model.example/v1'};
  state.ingress.allowedOrigins=['https://provenance-model.example'];
  const originalFetch=globalThis.fetch,calls:unknown[]=[];
  globalThis.fetch=async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return Response.json({choices:[{message:{content:calls.length%2?'PRIVATE_MARKER':'승인된 답변'},finish_reason:'stop'}]});};
  try{
    const messages=[{role:'user' as const,content:'배송을 안내해 주세요.'}];
    assert.equal((await executeWorkflow(workflow,state.connections,state.ingress,{},messages)).status,'allow');
    const fingerprint=await configurationFingerprint(workflow,state.connections);
    workflow.name='새 이름';workflow.post[0].name='새 조합 이름';workflow.post[0].rules[0].name='새 검사 이름';workflow.post[0].rules[0].description='다른 설명';state.connections[0].name='새 서버 이름';
    assert.equal((await executeWorkflow(workflow,state.connections,state.ingress,{},messages)).status,'allow');
    assert.equal(await configurationFingerprint(workflow,state.connections),fingerprint);
    assert.equal(calls.length,4);assert.deepEqual(calls.slice(0,2),calls.slice(2));
  }finally{globalThis.fetch=originalFetch;}
});

test('omitted execution defaults and explicit defaults share evidence while scope and budget changes invalidate it',async()=>{
  const {workflows,connections}=initialState(),workflow=workflows[0];
  const before=await configurationFingerprint(workflow,connections);
  workflow.inputScope='conversation';workflow.executionLimits={timeoutMs:DEFAULT_EXECUTION_TIMEOUT_MS,maxModelCalls:DEFAULT_MAX_MODEL_CALLS};
  assert.equal(await configurationFingerprint(workflow,connections),before);
  workflow.inputScope='last_user';assert.notEqual(await configurationFingerprint(workflow,connections),before);
  workflow.inputScope='conversation';workflow.executionLimits.maxModelCalls=DEFAULT_MAX_MODEL_CALLS+1;
  assert.notEqual(await configurationFingerprint(workflow,connections),before);
});

test('deployment review names changed inspection targets and whole-run limits',()=>{
  const {workflows,connections}=initialState(),before=workflows[0],after=structuredClone(before);
  after.inputScope='last_user';after.executionLimits={timeoutMs:30_000,maxModelCalls:8};
  const changes=workflowChanges(after,before,connections,connections);
  assert.ok(changes.some(change=>change.label==='요청 검사 대상 변경'&&change.detail.includes('마지막 사용자 질문')));
  assert.ok(changes.some(change=>change.label==='전체 실행 제한 변경'&&change.detail.includes('30초')&&change.detail.includes('8회')));
});

test('completed evidence records engine identity and returns a compact independent release manifest',async()=>{
  const f=fixture(),run=await f.complete();assert.equal(run.engineVersion,ENGINE_VERSION);
  const fingerprint=await configurationFingerprint(f.state.workflows[0],f.state.connections);
  const evidence=await verifyDeploymentEvidence(f.store,f.state.workflows[0],fingerprint,{verificationRunIds:[run.id]});
  assert.equal(evidence.engineVersion,ENGINE_VERSION);assert.equal(evidence.verificationSummaries?.length,1);
  const summary=evidence.verificationSummaries![0];
  assert.deepEqual(summary,{runId:run.id,datasetId:run.datasetId,datasetName:run.datasetName,datasetFingerprint:run.datasetFingerprint,fingerprint,
    total:1,matchedCount:1,completedAt:run.updatedAt,engineVersion:ENGINE_VERSION});
  assert.equal(JSON.stringify(summary).includes(f.state.datasets[0].rows[0].input),false);
  const retained=JSON.stringify(summary);
  f.memory.records.delete(`run/${run.id}`);f.memory.records.delete(`dataset/${run.datasetId}`);
  assert.equal(JSON.stringify(summary),retained);assert.equal(summary.total,1);
});

test('a proof from an earlier engine cannot authorize deployment even if its settings hash is supplied',async()=>{
  const f=fixture(),run=await f.complete();
  await f.memory.put('run',run.id,{...run,engineVersion:'previous-engine'});
  await assert.rejects(verifyDeploymentEvidence(f.store,f.state.workflows[0],run.fingerprint!,{verificationRunIds:[run.id]}),
    (error:unknown)=>error instanceof DeploymentVerificationError&&error.code==='verification_engine_stale'&&error.status===409);
});

test('a persisted job from a previous engine stops safely and explicit replay uses the current engine',async()=>{
  const f=fixture();
  const {run}=await f.action({action:'start_evaluation',workflowId:f.state.workflows[0].id,datasetId:f.state.datasets[0].id});
  await f.memory.put('run',run.id,{...run,engineVersion:'previous-engine',fingerprint:'a'.repeat(64)});
  const stopped=(await f.action({action:'step_evaluation',runId:run.id})).run;
  assert.equal(stopped.status,'error');assert.deepEqual(stopped.results,[]);assert.match(stopped.error??'',/실행 엔진/);
  const replay=(await f.action({action:'replay_evaluation',runId:run.id})).run;
  assert.equal(replay.engineVersion,ENGINE_VERSION);
  assert.equal(replay.fingerprint,await configurationFingerprint(run.workflowSnapshot!,run.connectionsSnapshot!));
  assert.notEqual(replay.fingerprint,'a'.repeat(64));
  const completed=(await f.action({action:'step_evaluation',runId:replay.id})).run;
  assert.equal(completed.status,'completed');assert.equal(completed.results.length,1);
  assert.equal((await f.memory.getRecordWithVersion<EvalRun>('run',run.id))?.value.status,'error');
});

test('historical deployment verification selects the exact snapshot even outside the recent deployment window',async()=>{
  const f=fixture(),workflow=structuredClone(f.state.workflows[0]);
  const deployment:Deployment={id:'historic-release',workflowId:workflow.id,alias:workflow.alias,version:1,createdAt:'2025-01-01T00:00:00.000Z',workflow,connections:structuredClone(f.state.connections)};
  await f.memory.put('deployment',deployment.id,deployment);
  f.state.workflows[0].pre=[{id:'new-check',name:'새 검사',mode:'any',rules:[{id:'new-rule',name:'새 규칙',description:'',kind:'length',enabled:true,config:{maxLength:1}}]}];
  f.state.deployments=[];
  const {run}=await f.action({action:'run_evaluation',workflowId:workflow.id,datasetId:f.state.datasets[0].id,target:'deployed',deploymentId:deployment.id});
  assert.equal(run.deploymentId,deployment.id);assert.equal(run.status,'completed');assert.equal(run.results[0].status,'allow');
  assert.deepEqual(run.workflowSnapshot!.pre,[]);assert.equal(run.engineVersion,ENGINE_VERSION);
  for(const invalid of [{target:'draft'},{target:'deployed',compare:true},{target:'deployed',workflowId:'other-workflow'},{target:'deployed',deploymentId:'missing-release'}]){
    await assert.rejects(f.action(Object.assign({action:'start_evaluation',workflowId:workflow.id,datasetId:f.state.datasets[0].id,target:'deployed',deploymentId:deployment.id},invalid)));
  }
});
