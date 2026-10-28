import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {handleConsole,handleCompletions} from '../.local-runtime/server/api.mjs';

const migrations=await Promise.all((await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/.test(name)).sort().map(name=>readFile(new URL(`../drizzle/${name}`,import.meta.url),'utf8')));
function fixture(overrides={}){
 const sqlite=new DatabaseSync(':memory:');for(const migration of migrations)sqlite.exec(migration);
 class Statement{constructor(query,values=[]){this.query=query;this.values=values;}bind(...values){return new Statement(this.query,values);}async first(){return sqlite.prepare(this.query).get(...this.values)||null;}async all(){return {results:sqlite.prepare(this.query).all(...this.values)};}executeRun(){const r=sqlite.prepare(this.query).run(...this.values);return {meta:{changes:Number(r.changes)}};}async run(){return this.executeRun();}}
 const DB={prepare:q=>new Statement(q),async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const values=statements.map(statement=>statement.executeRun());sqlite.exec('COMMIT');return values;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};const env={DB,...overrides};
 const call=async(payload,identity)=>{const response=await handleConsole(new Request('https://console.example/api/console',{method:payload?'POST':'GET',headers:{...(payload?{'Content-Type':'application/json'}:{}),...(identity?{'oai-authenticated-user-id':identity}:{})},...(payload?{body:JSON.stringify(payload)}:{})}),env);return {status:response.status,data:await response.json()};};
 const action=async(action,payload={},identity)=>{const result=await call({action,...payload},identity);assert.equal(result.status,200,JSON.stringify(result.data.error));return result.data;};
 const get=async(query,identity)=>{const response=await handleConsole(new Request(`https://console.example/api/console?${query}`,{headers:identity?{'oai-authenticated-user-id':identity}:{}}),env);return {status:response.status,data:await response.json()};};
 return {sqlite,env,call,action,get,close:()=>sqlite.close()};
}
async function prepareMain(f){const state=(await f.call()).data.state;const workflow={...state.workflows[0],pre:[],post:[]};await f.action('save_workflow',{workflow});const connection={...state.connections.find(c=>c.id===workflow.mainConnectionId),mode:'vllm',baseUrl:'https://main.example.com/v1'};await f.action('save_connection',{connection});await f.action('save_ingress',{ingress:{...state.ingress,allowedOrigins:['https://main.example.com']}});return workflow;}
const messages=[{role:'system',content:'간단히 답하세요.'},{role:'user',content:'이전 질문'},{role:'assistant',content:'이전 답변'},{role:'user',content:'다음 질문'}];
const generated=(content='응답',finish_reason='length')=>Response.json({choices:[{message:{content},finish_reason}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}});

test('playground sends the exact conversation and generation settings and retains truncation reason',async()=>{
 const f=fixture(),original=globalThis.fetch;let actual;globalThis.fetch=async(_url,init)=>{actual=JSON.parse(init.body);return generated();};
 try{const workflow=await prepareMain(f);const result=await f.action('playground',{workflowId:workflow.id,messages,generationOptions:{temperature:0.7,max_tokens:25,top_p:0.8}});assert.deepEqual(actual.messages,messages);assert.equal(actual.temperature,0.7);assert.equal(actual.max_tokens,25);assert.equal(actual.top_p,0.8);assert.equal(result.result.finishReason,'length');assert.equal(result.result.output,'응답');assert.equal(result.result.executionMode,undefined);}
 finally{globalThis.fetch=original;f.close();}
});

test('public Chat Completions preserves upstream finish_reason instead of declaring stop',async()=>{
 const f=fixture(),original=globalThis.fetch;globalThis.fetch=async()=>generated();
 try{const workflow=await prepareMain(f);await f.action('publish',{workflowId:workflow.id});const key=(await f.action('create_key',{name:'테스트 키'})).key;const response=await handleCompletions(new Request('https://console.example/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model:workflow.alias,messages,max_tokens:25})}),f.env);assert.equal(response.status,200);const data=await response.json();assert.equal(data.choices[0].finish_reason,'length');assert.equal(data.choices[0].message.content,'응답');}
 finally{globalThis.fetch=original;f.close();}
});

test('gateway logs identify the exact deployment and historical lookup refuses ambiguous alias versions',async()=>{
 const f=fixture(),original=globalThis.fetch;globalThis.fetch=async()=>generated('답변','stop');
 try{const workflow=await prepareMain(f),first=(await f.action('publish',{workflowId:workflow.id})).deployment,key=(await f.action('create_key',{name:'조회 키'})).key;
 const response=await handleCompletions(new Request('https://console.example/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model:workflow.alias,messages})}),f.env);assert.equal(response.status,200);
 const logs=(await f.get('view=logs&source=gateway')).data.logs;assert.equal(logs[0].deploymentId,first.id);assert.equal((await f.get(`view=deployment&deploymentId=${first.id}`)).data.deployment.id,first.id);
 workflow.alias='new-history-alias';await f.action('save_workflow',{workflow});const second=(await f.action('publish',{workflowId:workflow.id})).deployment;assert.equal(second.version,first.version);assert.equal((await f.get(`view=deployment&workflowId=${workflow.id}&version=${first.version}`)).data.deployment,null);assert.equal((await f.get(`view=deployment&deploymentId=${first.id}`)).data.deployment.alias,first.alias);
 const unsupported=await handleCompletions(new Request('https://console.example/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model:workflow.alias,messages,mockResponse:'forbidden'})}),f.env);assert.equal(unsupported.status,400);
 }finally{globalThis.fetch=original;f.close();}
});

test('invalid structured requests are rejected before any model call or execution record',async()=>{
 const f=fixture(),original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return generated();};
 try{await prepareMain(f);for(const invalid of [{messages:[]},{messages:[{role:'system',content:'no user'}]},{messages:[{role:'tool',content:'unsupported'}]},{messages:Array.from({length:33},()=>({role:'user',content:'a'}))},{messages:[{role:'user',content:'a'.repeat(16001)}]},{messages:Array.from({length:3},()=>({role:'user',content:'a'.repeat(16000)}))},{messages,generationOptions:{max_tokens:0}},{messages,generationOptions:{onProgress:'bad'}},{messages,mockResponse:42}]){const response=await f.call({action:'playground',workflowId:'wf-support',...invalid});assert.equal(response.status,400,JSON.stringify(invalid).slice(0,100));}assert.equal(calls,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM aegis_request_logs').get().n,0);}
 finally{globalThis.fetch=original;f.close();}
});

test('designated mock output bypasses main inference but still follows response checks and output masking',async()=>{
 const f=fixture(),original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('must not invoke main');};
 try{let workflow=await prepareMain(f);workflow.post=[{id:'post',name:'출력 검사',mode:'any',rules:[{id:'rule',name:'비공개 검사',description:'',kind:'keyword',enabled:true,config:{pattern:'PRIVATE_REJECTED'}}]}];await f.action('save_workflow',{workflow});const response=await f.action('playground',{workflowId:workflow.id,messages,mockResponse:'PRIVATE_REJECTED'});assert.equal(response.result.status,'block');assert.equal(response.result.output,'');assert.equal(response.result.executionMode,'mock');assert.equal(calls,0);assert.ok(!JSON.stringify(response.state.logs).includes('PRIVATE_REJECTED'));const allowed=await f.action('playground',{workflowId:workflow.id,messages,mockResponse:'검사할 모의 응답'});assert.equal(allowed.result.output,'검사할 모의 응답');assert.equal(allowed.result.executionMode,'mock');assert.equal(allowed.result.usage,undefined);}
 finally{globalThis.fetch=original;f.close();}
});

test('dataset evaluation uses stored conversation and options and keeps immutable replay inputs',async()=>{
 const f=fixture(),original=globalThis.fetch;const actual=[];globalThis.fetch=async(_url,init)=>{actual.push(JSON.parse(init.body));return generated('업무 답변','stop');};
 try{const workflow=await prepareMain(f),state=(await f.call()).data.state,dataset={...state.datasets[0],rows:[{id:'row',input:'대화 사례',messages,generationOptions:{temperature:0.3,max_tokens:15},expected:'allow'}]};await f.action('save_dataset',{dataset});const started=await f.action('start_evaluation',{workflowId:workflow.id,datasetId:dataset.id,target:'draft',executionMode:'manual'});const completed=(await f.action('step_evaluation',{runId:started.run.id})).run;assert.equal(completed.status,'completed');assert.deepEqual(actual[0].messages,messages);assert.equal(actual[0].max_tokens,15);assert.deepEqual(completed.datasetSnapshot.rows[0].messages,messages);assert.deepEqual(completed.results[0].generationOptions,dataset.rows[0].generationOptions);dataset.rows[0].messages=[{role:'user',content:'변경한 대화'}];await f.action('save_dataset',{dataset});const replay=await f.action('replay_evaluation',{runId:completed.id,executionMode:'manual'});await f.action('step_evaluation',{runId:replay.run.id});assert.deepEqual(actual[1].messages,messages);}
 finally{globalThis.fetch=original;f.close();}
});

test('checked workflow and dataset saves reject stale revisions without losing current records',async()=>{
 const f=fixture();try{const state=(await f.call()).data.state;for(const [kind,record] of [['workflow',state.workflows[0]],['dataset',state.datasets[0]]]){const revision=record.updatedAt??'';const first=await f.action(`save_${kind}`,{[kind]:{...record,name:'첫 번째 수정'},expectedUpdatedAt:revision});const current=first.state[kind==='workflow'?'workflows':'datasets'].find(item=>item.id===record.id);assert.notEqual(current.updatedAt,revision);const stale=await f.call({action:`save_${kind}`,[kind]:{...record,name:'오래된 수정'},expectedUpdatedAt:revision});assert.equal(stale.status,409);assert.equal(stale.data.error.code,`stale_${kind}_save`);const latest=(await f.call()).data.state[kind==='workflow'?'workflows':'datasets'].find(item=>item.id===record.id);assert.equal(latest.name,'첫 번째 수정');}}
 finally{f.close();}
});

test('request search queries records beyond the recent-state window and validates cursors and permissions',async()=>{
 const f=fixture({AEGIS_REQUIRE_ADMIN_IDENTITY:'true',AEGIS_ROLE_MAP:{reader:'viewer'}});try{assert.equal((await f.get('view=logs')).status,401);await f.call(undefined,'reader');for(let i=0;i<205;i++){const log={id:`req-${i}`,source:'gateway',workflowName:'이전 워크플로우',workflowId:'wf-support',version:'v1',createdAt:new Date(Date.now()-i*1000).toISOString(),status:'allow',stage:'complete',latencyMs:1,reason:'검사를 통과했습니다.'};f.sqlite.prepare('INSERT INTO aegis_request_logs(id,payload,created_at) VALUES(?,?,?)').run(log.id,JSON.stringify(log),log.createdAt);}const response=await f.get('view=logs&query=req-204&source=gateway','reader');assert.equal(response.status,200);assert.equal(response.data.total,1);assert.equal(response.data.logs[0].id,'req-204');assert.equal(response.data.retention.maxRecords,1000);for(const query of ['cursor=bad','limit=101','status=wrong','from=bad','from=2026-01-02&to=2026-01-01'])assert.equal((await f.get(`view=logs&${query}`,'reader')).status,400);}
 finally{f.close();}
});

test('editors can preserve but cannot change admin deployment verification policy',async()=>{
 const f=fixture({AEGIS_REQUIRE_ADMIN_IDENTITY:'true',AEGIS_ROLE_MAP:{admin:'admin',writer:'editor'}});try{const state=(await f.call(undefined,'admin')).data.state;const workflow={...state.workflows[0],releasePolicy:{requireVerification:true,requiredDatasetIds:[state.datasets[0].id]}};let saved=await f.action('save_workflow',{workflow},'admin');const current=saved.state.workflows.find(item=>item.id===workflow.id);assert.equal((await f.call({action:'save_workflow',workflow:{...current,releasePolicy:{requireVerification:false,requiredDatasetIds:[]}},expectedUpdatedAt:current.updatedAt},'writer')).status,403);assert.equal((await f.call({action:'save_workflow',workflow:{...current,releasePolicy:undefined},expectedUpdatedAt:current.updatedAt},'writer')).status,403);saved=await f.action('save_workflow',{workflow:{...current,name:'정책 작성자 수정'},expectedUpdatedAt:current.updatedAt},'writer');assert.equal(saved.state.workflows.find(item=>item.id===workflow.id).releasePolicy.requireVerification,true);const publish=await f.call({action:'publish',workflowId:workflow.id},'admin');assert.equal(publish.status,400);assert.equal(publish.data.error.code,'required_verification_missing');}
 finally{f.close();}
});

async function prepareVerification(f,{rows=1}={}){
 const state=(await f.call()).data.state,workflow={...state.workflows[0],pre:[],post:[]};await f.action('save_workflow',{workflow});
 const first={...state.datasets[0],name:'정상 요청 검증',rows:Array.from({length:rows},(_,index)=>({id:`suite-row-${index}`,input:`배송 문의 ${index}`,expected:'allow'}))};
 const second={...first,id:'required-dataset-second',name:'추가 정상 요청 검증',rows:[{id:'second-row',input:'반품 문의',expected:'allow'}]};
 await f.action('save_dataset',{dataset:first});await f.action('save_dataset',{dataset:second,expectedUpdatedAt:null});
 const run=async datasetId=>(await f.action('run_evaluation',{workflowId:workflow.id,datasetId,target:'draft'})).run;
 return {workflow,first,second,run};
}

test('deployment can require multiple complete datasets and keeps every chosen evidence record',async()=>{
 const f=fixture();try{const {workflow,first,second,run}=await prepareVerification(f);const a=await run(first.id),b=await run(second.id);assert.equal(a.status,'completed');assert.ok(a.results.every(row=>row.expectationMatched));assert.ok(b.results.every(row=>row.expectationMatched));
 // A governance policy change does not require re-running the same inference configuration.
 workflow.releasePolicy={requireVerification:true,requiredDatasetIds:[first.id,second.id]};await f.action('save_workflow',{workflow});
 const deployment=(await f.action('publish',{workflowId:workflow.id,verificationRunIds:[a.id,b.id]})).deployment;assert.deepEqual(deployment.verificationRunIds,[a.id,b.id]);assert.equal(deployment.verificationRunId,a.id);assert.deepEqual(deployment.workflow.releasePolicy.requiredDatasetIds,[first.id,second.id]);
 }finally{f.close();}
});

test('mandatory evidence cannot be bypassed by legacy publication, partial selection or an unverified acknowledgement',async()=>{
 const f=fixture();try{const {workflow,first,second,run}=await prepareVerification(f),a=await run(first.id);workflow.releasePolicy={requireVerification:true,requiredDatasetIds:[first.id,second.id]};await f.action('save_workflow',{workflow});
 for(const extra of [{},{verificationRunId:a.id},{verificationRunIds:[a.id]},{acknowledgeUnverified:true,unverifiedReason:'PoC 예외 사유'}]){const response=await f.call({action:'publish',workflowId:workflow.id,...extra});assert.equal(response.status,400);assert.equal(response.data.error.code,'required_verification_missing');}
 assert.equal((await f.call()).data.state.deployments.length,0);
 }finally{f.close();}
});

test('updating one required dataset invalidates its evidence while preserving the original run',async()=>{
 const f=fixture();try{const {workflow,first,second,run}=await prepareVerification(f),a=await run(first.id),b=await run(second.id);workflow.releasePolicy={requireVerification:true,requiredDatasetIds:[first.id,second.id]};await f.action('save_workflow',{workflow});await f.action('save_dataset',{dataset:{...second,rows:[{...second.rows[0],note:'검증 이후 데이터셋을 수정함'}]}});
 const response=await f.call({action:'publish',workflowId:workflow.id,verificationRunIds:[a.id,b.id]});assert.equal(response.status,409);assert.equal(response.data.error.code,'verification_stale');const saved=JSON.parse(f.sqlite.prepare("SELECT payload FROM aegis_records WHERE namespace='run' AND id=?").get(b.id).payload);assert.equal(saved.datasetSnapshot.rows[0].note,undefined);assert.equal((await f.call()).data.state.deployments.length,0);
 }finally{f.close();}
});

test('successful retry of only error rows does not count as full-dataset deployment evidence',async()=>{
 const f=fixture(),original=globalThis.fetch;let repaired=false;
 globalThis.fetch=async(_url,init)=>{const request=JSON.parse(init.body);if(request.messages.some(message=>message.content==='재시도 대상')&&!repaired)throw new Error('temporary failure');return generated('정상 답변','stop');};
 try{const workflow=await prepareMain(f),state=(await f.call()).data.state,dataset={...state.datasets[0],rows:[{id:'always-allow',input:'정상 사례',expected:'allow'},{id:'retry-only',input:'재시도 대상',expected:'allow'}]};await f.action('save_dataset',{dataset});const initial=(await f.action('run_evaluation',{workflowId:workflow.id,datasetId:dataset.id,target:'draft'})).run;assert.equal(initial.results.length,2);assert.equal(initial.results.filter(row=>row.status==='error').length,1);
 repaired=true;const retried=(await f.action('retry_evaluation',{runId:initial.id,executionMode:'manual'})).run;const complete=(await f.action('step_evaluation',{runId:retried.id})).run;assert.equal(complete.status,'completed');assert.equal(complete.results.length,1);assert.equal(complete.results[0].status,'allow');const response=await f.call({action:'publish',workflowId:workflow.id,verificationRunIds:[complete.id]});assert.equal(response.status,400);assert.equal(response.data.error.code,'verification_failed');assert.equal((await f.call()).data.state.deployments.length,0);
 }finally{globalThis.fetch=original;f.close();}
});

test('completed mock result cannot become deployment evidence even with matching configuration and expectations',async()=>{
 const f=fixture();try{const {workflow,first,run}=await prepareVerification(f),completed=await run(first.id);const stored=JSON.parse(f.sqlite.prepare("SELECT payload FROM aegis_records WHERE namespace='run' AND id=?").get(completed.id).payload);stored.results[0].executionMode='mock';f.sqlite.prepare("UPDATE aegis_records SET payload=? WHERE namespace='run' AND id=?").run(JSON.stringify(stored),completed.id);
 const response=await f.call({action:'publish',workflowId:workflow.id,verificationRunIds:[completed.id]});assert.equal(response.status,400);assert.equal(response.data.error.code,'verification_failed');assert.match(response.data.error.message,/모의 응답/);assert.equal((await f.call()).data.state.deployments.length,0);
 }finally{f.close();}
});

test('deployment verification policy is excluded from inference fingerprints while actual policy nodes still change them',async()=>{
 const {configurationFingerprint}=await import('../lib/workflow-review.ts');const f=fixture();try{const state=(await f.call()).data.state,workflow=state.workflows[0],before=await configurationFingerprint(workflow,state.connections),governed={...workflow,releasePolicy:{requireVerification:true,requiredDatasetIds:state.datasets.map(dataset=>dataset.id)}};assert.equal(await configurationFingerprint(governed,state.connections),before);const changed=structuredClone(governed);changed.pre[0].rules[0].enabled=!changed.pre[0].rules[0].enabled;assert.notEqual(await configurationFingerprint(changed,state.connections),before);
 }finally{f.close();}
});
