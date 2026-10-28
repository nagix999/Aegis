import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readdir,readFile} from 'node:fs/promises';
import {handleConsole,handleEvaluationWorker,heartbeatEvaluationWorker,releaseEvaluationWorker,processEvaluationQueue} from '../.local-runtime/server/api.mjs';

const migrations=await Promise.all((await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/.test(name)).sort().map(name=>readFile(new URL(`../drizzle/${name}`,import.meta.url),'utf8')));
function fixture(overrides={}){
  const sqlite=new DatabaseSync(':memory:');for(const migration of migrations)sqlite.exec(migration);
  class Statement{
    constructor(query,values=[]){this.query=query;this.values=values;}
    bind(...values){return new Statement(this.query,values);}
    async first(){return sqlite.prepare(this.query).get(...this.values)||null;}
    async all(){return {results:sqlite.prepare(this.query).all(...this.values)};}
    executeRun(){const result=sqlite.prepare(this.query).run(...this.values);return {meta:{changes:Number(result.changes)}};}
    async run(){return this.executeRun();}
  }
  const DB={prepare:query=>new Statement(query),async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const results=statements.map(statement=>statement.executeRun());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const queries=[];const prepare=DB.prepare;DB.prepare=query=>{queries.push(query);return prepare(query);};
  const env={DB,...overrides};
  const call=async(payload,identity,path='/api/console')=>{const response=await handleConsole(new Request(`https://console.example${path}`,{method:payload?'POST':'GET',headers:{...(payload?{'Content-Type':'application/json'}:{}),...(identity?{'oai-authenticated-user-id':identity}:{})},...(payload?{body:JSON.stringify(payload)}:{})}),env);return {status:response.status,data:await response.json()};};
  const action=async(name,payload={},identity)=>{const response=await call({action:name,...payload},identity);assert.equal(response.status,200,`${name}: ${JSON.stringify(response.data.error)}`);return response.data;};
  const start=(options={})=>action('start_evaluation',{workflowId:'wf-support',datasetId:'ds-security',...options});
  const record=id=>JSON.parse(sqlite.prepare("SELECT payload FROM aegis_records WHERE namespace='run' AND id=?").get(id).payload);
  const change=(id,fn)=>{const run=record(id);fn(run);sqlite.prepare("UPDATE aegis_records SET payload=? WHERE namespace='run' AND id=?").run(JSON.stringify(run),id);};
  return {sqlite,env,call,action,start,record,change,queries,close(){sqlite.close();}};
}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function remoteCall(f,payload,token='worker-secret-'.repeat(3),method='POST'){
  const response=await handleEvaluationWorker(new Request('https://console.example/api/evaluations/worker',{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(method==='POST'?{body:typeof payload==='string'?payload:JSON.stringify(payload)}:{})}),f.env);
  return {status:response.status,data:await response.json()};
}

test('worker heartbeat status expires and disconnect removes only its own registration',async()=>{
  const f=fixture();try{
    assert.deepEqual((await f.call()).data.state.evaluationWorker,{available:false});
    await heartbeatEvaluationWorker(f.env,{id:'worker-one',kind:'local'});
    const status=(await f.call()).data.state.evaluationWorker;assert.equal(status.available,true);assert.equal(status.kind,'local');assert.ok(status.lastSeenAt);assert.equal(JSON.stringify(status).includes('worker-one'),false);
    f.sqlite.prepare("UPDATE aegis_records SET payload=json_set(payload,'$.expiresAt',?) WHERE namespace='evaluation_worker'").run(Date.now()-1);
    assert.equal((await f.call()).data.state.evaluationWorker.available,false);
    await heartbeatEvaluationWorker(f.env,{id:'worker-two',kind:'remote'});await releaseEvaluationWorker(f.env,'worker-one');
    assert.equal((await f.call()).data.state.evaluationWorker.available,true);await releaseEvaluationWorker(f.env,'worker-two');assert.equal((await f.call()).data.state.evaluationWorker.available,false);
  }finally{f.close();}
});

test('background creation needs a live worker while unavailable default remains manual',async()=>{
  const f=fixture();try{
    const unavailable=await f.call({action:'start_evaluation',workflowId:'wf-support',datasetId:'ds-security',executionMode:'background'});assert.equal(unavailable.status,409);assert.equal(unavailable.data.error.code,'evaluation_worker_unavailable');
    const manual=(await f.start()).run;assert.equal(manual.executionMode,'manual');
    await heartbeatEvaluationWorker(f.env,{id:'worker',kind:'local'});assert.equal((await f.start()).run.executionMode,'background');assert.equal((await f.start({executionMode:'manual'})).run.executionMode,'manual');
    const invalid=await f.call({action:'start_evaluation',workflowId:'wf-support',datasetId:'ds-security',executionMode:'fake'});assert.equal(invalid.status,400);
  }finally{f.close();}
});

test('queue progresses saved background snapshots without screen steps and ignores manual jobs',async()=>{
  const f=fixture();try{
    const manual=(await f.start()).run;await heartbeatEvaluationWorker(f.env,{id:'worker',kind:'local'});const run=(await f.start()).run;
    assert.equal(run.results.length,0);assert.equal(f.record(run.id).status,'running');
    const blocked=await f.call({action:'step_evaluation',runId:run.id});assert.equal(blocked.status,409);assert.equal(blocked.data.error.code,'evaluation_background_managed');
    const state=(await f.call()).data.state;const workflow=structuredClone(state.workflows[0]);workflow.pre=[];workflow.post=[];await f.action('save_workflow',{workflow});
    const dataset=structuredClone(state.datasets[0]);dataset.rows=[{id:'changed',input:'CHANGED_PRIVATE_INPUT',expected:'allow'}];await f.action('save_dataset',{dataset});
    assert.deepEqual(await processEvaluationQueue({...f.env}),{checked:1,processed:1,busy:0,failed:0});assert.equal(f.record(run.id).results.length,2);
    while(f.record(run.id).status==='running')await processEvaluationQueue({...f.env});const complete=f.record(run.id);assert.equal(complete.status,'completed');assert.equal(complete.results.length,run.total);assert.equal(complete.datasetSnapshot.rows[0].input,run.datasetSnapshot.rows[0].input);assert.deepEqual(complete.results.map(row=>row.status),['allow','block','block','allow','block','block','allow','block']);
    assert.equal(f.record(manual.id).results.length,0);assert.equal(f.record(manual.id).executionMode,'manual');
  }finally{f.close();}
});

test('legacy synchronous evaluation remains synchronous when a worker is connected',async()=>{
  const f=fixture();try{
    await heartbeatEvaluationWorker(f.env,{id:'worker',kind:'local'});const {run}=await f.action('run_evaluation',{workflowId:'wf-support',datasetId:'ds-security'});assert.equal(run.executionMode,'manual');assert.equal(run.status,'completed');assert.equal(run.results.length,run.total);
    const replay=(await f.action('replay_evaluation',{runId:run.id})).run;assert.equal(replay.executionMode,'background');assert.equal(replay.replayOf,run.id);assert.equal(replay.results.length,0);
    await releaseEvaluationWorker(f.env,'worker');const manualReplay=(await f.action('replay_evaluation',{runId:run.id})).run;assert.equal(manualReplay.executionMode,'manual');
  }finally{f.close();}
});

async function vllmRun(f){
  const state=(await f.call()).data.state;const workflow=structuredClone(state.workflows[0]);workflow.pre=[];workflow.post=[];await f.action('save_workflow',{workflow});
  const connection=structuredClone(state.connections.find(item=>item.id===workflow.mainConnectionId));connection.mode='vllm';connection.baseUrl='https://background.example.com/v1';connection.secretEnv='';await f.action('save_connection',{connection});
  await f.action('save_ingress',{ingress:{...state.ingress,allowedOrigins:['https://background.example.com']}});
  const dataset=structuredClone(state.datasets[0]);dataset.rows=[{id:'single',input:'PRIVATE_QUEUED_INPUT',expected:'allow'}];await f.action('save_dataset',{dataset});await heartbeatEvaluationWorker(f.env,{id:'worker',kind:'local'});return (await f.start()).run;
}

test('two queue workers share leases and a cancelled in-flight batch cannot return results',async()=>{
  const f=fixture(),originalFetch=globalThis.fetch,started=deferred(),gate=deferred();let calls=0;
  globalThis.fetch=async()=>{calls++;started.resolve();await gate.promise;return Response.json({choices:[{message:{content:'PRIVATE_QUEUED_OUTPUT'}}]});};
  try{
    const run=await vllmRun(f);const first=processEvaluationQueue(f.env);await started.promise;
    assert.deepEqual(await processEvaluationQueue(f.env),{checked:1,processed:0,busy:1,failed:0});assert.equal(calls,1);
    const cancelled=(await f.action('cancel_evaluation',{runId:run.id})).run;assert.equal(cancelled.status,'cancelled');gate.resolve();await first;
    assert.equal(f.record(run.id).status,'cancelled');assert.equal(f.record(run.id).results.length,0);assert.equal(f.record(run.id)._lease,undefined);assert.equal(calls,1);
  }finally{gate.resolve();globalThis.fetch=originalFetch;f.close();}
});

test('a restarted queue skips an active lease and resumes only after expiration',async()=>{
  const f=fixture();try{
    await heartbeatEvaluationWorker(f.env,{id:'before-restart',kind:'local'});const run=(await f.start()).run;
    f.change(run.id,value=>{value._lease={token:'old-private-lease',until:Date.now()+120_000};});
    assert.deepEqual(await processEvaluationQueue({...f.env}),{checked:1,processed:0,busy:1,failed:0});assert.equal(f.record(run.id).results.length,0);
    f.change(run.id,value=>{value._lease.until=Date.now()-1;});await processEvaluationQueue({...f.env});assert.equal(f.record(run.id).results.length,2);assert.equal(f.record(run.id)._lease,undefined);
  }finally{f.close();}
});

test('targeted polling returns summary metadata and selected sanitized run to viewers',async()=>{
  const f=fixture({AEGIS_REQUIRE_ADMIN_IDENTITY:'true',AEGIS_ROLE_MAP:{admin:'admin',reader:'viewer'}});try{
    await heartbeatEvaluationWorker(f.env,{id:'private-worker-id',kind:'local'});
    const start=await f.action('start_evaluation',{workflowId:'wf-support',datasetId:'ds-security'},'admin');const run=start.run;
    f.change(run.id,value=>{value._lease={token:'private-lease-token',until:Date.now()+120_000};});
    const summary=await f.call(undefined,'reader','/api/console?view=evaluations');assert.equal(summary.status,200);assert.equal(summary.data.runs[0].completedCount,0);assert.equal(summary.data.runs[0].total,run.total);assert.equal(summary.data.runs[0].executionMode,'background');
    assert.equal(summary.data.state,undefined);assert.equal(summary.data.run,undefined);assert.equal(summary.data.evaluationWorker.available,true);assert.ok(!JSON.stringify(summary.data).includes('private-lease-token'));assert.ok(!JSON.stringify(summary.data).includes('datasetSnapshot'));assert.ok(!JSON.stringify(summary.data).includes(run.datasetSnapshot.rows[0].input));
    const selected=await f.call(undefined,'reader',`/api/console?view=evaluations&runId=${run.id}`);assert.equal(selected.data.run.id,run.id);assert.equal(selected.data.run._lease,undefined);
    assert.equal((await f.call(undefined,undefined,'/api/console?view=evaluations')).status,401);assert.equal((await f.call(undefined,'reader','/api/console?view=evaluations&runId=')).status,400);
    assert.equal((await f.call({action:'cancel_evaluation',runId:run.id},'reader')).status,403);
  }finally{f.close();}
});

test('worker endpoint requires a separate secret and validates a bounded strict body',async()=>{
  const f=fixture({AEGIS_EVALUATION_WORKER_TOKEN:'worker-secret-'.repeat(3),AEGIS_ADMIN_TOKEN:'admin-secret'});try{
    assert.equal((await remoteCall(f,{action:'heartbeat',workerId:'remote'},'admin-secret')).status,401);
    assert.equal((await remoteCall(f,{action:'heartbeat',workerId:'remote'},'wrong')).status,401);
    assert.equal((await remoteCall(f,{action:'heartbeat',workerId:'remote'},undefined,'GET')).status,405);
    for(const payload of [{action:['heartbeat'],workerId:'remote'},{action:['process'],workerId:'remote'},{action:{toString:'heartbeat'},workerId:'remote'},{action:1,workerId:'remote'},{action:'save_workflow',workerId:'remote'},{action:'heartbeat',workerId:'../remote'},{action:'heartbeat',workerId:'remote',extra:true},[],null,'invalid'])assert.equal((await remoteCall(f,payload)).status,400);
    assert.equal((await remoteCall(f,' '.repeat(2049))).status,413);
    assert.equal((await remoteCall(f,{action:'heartbeat',workerId:'remote'})).data.evaluationWorker.kind,'remote');
    assert.equal((await remoteCall(f,{action:'disconnect',workerId:'remote'})).data.disconnected,true);
    f.env.AEGIS_EVALUATION_WORKER_TOKEN='short';assert.equal((await remoteCall(f,{action:'process',workerId:'remote'})).status,503);
  }finally{f.close();}
});

test('authenticated remote processing returns counts without requests or model output',async()=>{
  const f=fixture({AEGIS_EVALUATION_WORKER_TOKEN:'worker-secret-'.repeat(3)});try{
    await remoteCall(f,{action:'heartbeat',workerId:'remote'});const run=(await f.start()).run;
    const response=await remoteCall(f,{action:'process',workerId:'remote'});assert.equal(response.status,200);assert.deepEqual(response.data,{progress:{checked:1,processed:1,busy:0,failed:0}});assert.equal(f.record(run.id).results.length,2);
    assert.ok(!JSON.stringify(response.data).includes(run.datasetSnapshot.rows[0].input));
  }finally{f.close();}
});


test('queue reads only live ingress and its saved run without loading unrelated console state',async()=>{
  const f=fixture();try{
    await heartbeatEvaluationWorker(f.env,{id:'worker',kind:'local'});const run=(await f.start()).run;
    f.queries.length=0;await processEvaluationQueue(f.env);assert.equal(f.record(run.id).results.length,2);
    assert.ok(f.queries.some(query=>query.includes('SELECT payload FROM aegis_records WHERE namespace=? AND id=?')));
    assert.ok(f.queries.every(query=>!query.includes('SELECT namespace,id,payload')&&!query.includes('aegis_deployments')&&!query.includes('aegis_gateway_keys')&&!query.includes('diagnostic')));
  }finally{f.close();}
});
