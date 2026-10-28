import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'vite';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(join(project,'work'),{recursive:true});
const temporary=await mkdtemp(join(project,'work','deployment-integrity-'));
after(()=>rm(temporary,{recursive:true,force:true}));
const entry=join(temporary,'entry.ts');
await writeFile(entry,`export {handleConsole,handleCompletions,handleModels} from ${JSON.stringify(join(project,'lib/aegis-api.ts'))};`);
await build({root:project,configFile:false,publicDir:false,logLevel:'silent',build:{ssr:entry,outDir:join(temporary,'build'),emptyOutDir:true,target:'node22',rollupOptions:{output:{entryFileNames:'entry.mjs'}}}});
const {handleConsole,handleCompletions,handleModels}=await import(pathToFileURL(join(temporary,'build/entry.mjs')).href);
const migrations=await Promise.all((await readdir(join(project,'drizzle'))).filter(name=>/^\d+.*\.sql$/.test(name)).sort().map(name=>readFile(join(project,'drizzle',name),'utf8')));
function fixture(){
 const sqlite=new DatabaseSync(':memory:');for(const migration of migrations)sqlite.exec(migration);
 const controls={failAudit:false,forbidAdminReads:false,beforeDeploy:undefined,maxBindings:0};
 class Statement{
  constructor(query,values=[]){this.query=query;this.values=values;}
  bind(...values){assert.ok(values.length<=100,'D1 query exceeds 100 parameters');for(const value of values)if(typeof value==='string')assert.ok(Buffer.byteLength(value)<=2_000_000,'D1 value exceeds 2 MB');controls.maxBindings=Math.max(controls.maxBindings,values.length);return new Statement(this.query,values);}
  check(){if(controls.failAudit&&this.query.includes("SELECT 'audit'"))throw new Error('Injected audit failure');if(controls.forbidAdminReads&&/diagnostic|model_metric|namespace IN \('workflow'/.test(this.query))throw new Error('Gateway loaded management state');}
  async first(){this.check();return sqlite.prepare(this.query).get(...this.values)||null;}
  async all(){this.check();return {results:sqlite.prepare(this.query).all(...this.values)};}
  executeRun(){this.check();return sqlite.prepare(this.query).run(...this.values);}
  async run(){return this.executeRun();}
 }
 const DB={prepare:query=>new Statement(query),async batch(statements){if(statements.some(s=>s.query.startsWith('INSERT INTO aegis_deployments'))&&controls.beforeDeploy){const callback=controls.beforeDeploy;controls.beforeDeploy=undefined;callback();}sqlite.exec('BEGIN IMMEDIATE');try{const rows=statements.map(s=>s.executeRun());sqlite.exec('COMMIT');return rows;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 const env={DB};
 const call=async payload=>{const r=await handleConsole(new Request('https://console.example/api/console',payload?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{}),env);return {status:r.status,data:await r.json()};};
 const action=async(action,data={})=>{const r=await call({action,...data});assert.equal(r.status,200,JSON.stringify(r.data.error));return r.data;};
 const get=async query=>{const r=await handleConsole(new Request(`https://console.example/api/console?${query}`),env);return {status:r.status,data:await r.json()};};
 return {sqlite,controls,env,call,action,get,close:()=>sqlite.close()};
}
async function prepare(f){const state=(await f.call()).data.state,workflow={...state.workflows[0],pre:[],post:[]};await f.action('save_workflow',{workflow});return workflow;}
const count=(f,table)=>f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

test('audit failure rolls back deployment and request identity in the same transaction',async()=>{
 const f=fixture();try{const workflow=await prepare(f);f.controls.failAudit=true;const result=await f.call({action:'publish',workflowId:workflow.id,idempotencyKey:'audit-failure-001'});assert.equal(result.status,500);assert.equal(count(f,'aegis_deployments'),0);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM aegis_records WHERE namespace='deployment_request'").get().n,0);f.controls.failAudit=false;const retried=await f.action('publish',{workflowId:workflow.id,idempotencyKey:'audit-failure-001'});assert.equal(retried.deployment.version,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM aegis_records WHERE namespace='audit' AND json_extract(payload,'$.action')='publish'").get().n,1);}finally{f.close();}
});

test('exact and concurrent retries reuse a deployment while changed payloads conflict',async()=>{
 const f=fixture();try{const workflow=await prepare(f),command={action:'publish',workflowId:workflow.id,idempotencyKey:'concurrent-retry-001',note:'검토한 배포'};const [one,two]=await Promise.all([f.call(command),f.call(command)]);assert.equal(one.status,200);assert.equal(two.status,200);assert.equal(one.data.deployment.id,two.data.deployment.id);assert.equal(count(f,'aegis_deployments'),1);const refreshed={...workflow,name:'재시도 전에 표시 이름을 변경'};await f.action('save_workflow',{workflow:refreshed});const replay=await f.call(command);assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);assert.equal(replay.data.deployment.id,one.data.deployment.id);const conflict=await f.call({...command,note:'다른 내용'});assert.equal(conflict.status,409);assert.equal(conflict.data.error.code,'idempotency_conflict');assert.equal(count(f,'aegis_deployments'),1);}finally{f.close();}
});

test('all 30 datasets can be deployed within D1 parameter and value limits',async()=>{
 const f=fixture();try{let workflow=await prepare(f);f.sqlite.prepare("DELETE FROM aegis_records WHERE namespace='dataset'").run();const runIds=[],datasetIds=[];for(let i=0;i<30;i++){const dataset={id:`suite-${i}`,name:`검증 ${i}`,description:'',rows:[{id:`case-${i}`,input:'배송 문의',expected:'allow'}]};await f.action('save_dataset',{dataset});datasetIds.push(dataset.id);runIds.push((await f.action('run_evaluation',{workflowId:workflow.id,datasetId:dataset.id})).run.id);}workflow={...(await f.call()).data.state.workflows[0],releasePolicy:{requireVerification:true,requiredDatasetIds:datasetIds}};await f.action('save_workflow',{workflow});const published=await f.action('publish',{workflowId:workflow.id,verificationRunIds:runIds,idempotencyKey:'thirty-suites-001'});assert.equal(published.deployment.verificationRunIds.length,30);assert.ok(f.controls.maxBindings<=100);assert.equal(published.deployment.verificationSummaries.length,30);}finally{f.close();}
});

test('compact revisions reject a record changed immediately before deployment transaction',async()=>{
 const f=fixture();try{const workflow=await prepare(f);f.controls.beforeDeploy=()=>{const row=f.sqlite.prepare("SELECT payload FROM aegis_records WHERE namespace='workflow' AND id=?").get(workflow.id);f.sqlite.prepare("UPDATE aegis_records SET payload=? WHERE namespace='workflow' AND id=?").run(JSON.stringify({...JSON.parse(row.payload),description:'동시 수정'}),workflow.id);};const r=await f.call({action:'publish',workflowId:workflow.id});assert.equal(r.status,409);assert.equal(count(f,'aegis_deployments'),0);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM aegis_records WHERE namespace='audit' AND json_extract(payload,'$.action')='publish'").get().n,0);}finally{f.close();}
});

test('rollback uses current required policy and fresh evidence for the target configuration',async()=>{
 const f=fixture();try{let workflow=await prepare(f);const previous=(await f.action('publish',{workflowId:workflow.id})).deployment;const dataset={id:'rollback-suite',name:'복원 검증',description:'',rows:[{id:'case',input:'배송 문의',expected:'allow'}]};await f.action('save_dataset',{dataset});workflow={...(await f.call()).data.state.workflows[0],releasePolicy:{requireVerification:true,requiredDatasetIds:[dataset.id]}};await f.action('save_workflow',{workflow});const rejected=await f.call({action:'rollback_deployment',deploymentId:previous.id});assert.equal(rejected.status,400);assert.equal(rejected.data.error.code,'required_verification_missing');const run=(await f.action('run_evaluation',{workflowId:workflow.id,datasetId:dataset.id,target:'deployed'})).run;const discovered=await f.get(`view=verification&deploymentId=${previous.id}`);assert.equal(discovered.status,200);assert.equal(discovered.data.policy.requireVerification,true);assert.ok(discovered.data.evidence.some(e=>e.id===run.id));const restored=await f.action('rollback_deployment',{deploymentId:previous.id,verificationRunIds:[run.id],expectedFingerprint:discovered.data.fingerprint,expectedUpdatedAt:discovered.data.currentWorkflowUpdatedAt,idempotencyKey:'rollback-required-001'});assert.equal(restored.deployment.version,2);assert.equal(restored.deployment.workflow.releasePolicy.requireVerification,true);assert.deepEqual(restored.deployment.verificationRunIds,[run.id]);}finally{f.close();}
});

test('rollback audit failure leaves the active version and provenance unchanged',async()=>{
 const f=fixture();try{const workflow=await prepare(f),first=(await f.action('publish',{workflowId:workflow.id})).deployment;f.controls.failAudit=true;const r=await f.call({action:'rollback_deployment',deploymentId:first.id,idempotencyKey:'rollback-failure-001'});assert.equal(r.status,500);assert.equal(count(f,'aegis_deployments'),1);}finally{f.close();}
});

test('Gateway models and completion use narrow runtime lookups without management state',async()=>{
 const f=fixture();try{const workflow=await prepare(f);await f.action('publish',{workflowId:workflow.id});const key=(await f.action('create_key',{name:'검증 키'})).key;f.controls.forbidAdminReads=true;const models=await handleModels(new Request('https://console.example/v1/models',{headers:{Authorization:`Bearer ${key}`}}),f.env);assert.equal(models.status,200);assert.deepEqual((await models.json()).data.map(m=>m.id),[workflow.alias]);const completion=await handleCompletions(new Request('https://console.example/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:workflow.alias,messages:[{role:'user',content:'배송 문의'}]})}),f.env);assert.equal(completion.status,200);const deniedKey=f.sqlite.prepare("SELECT id FROM aegis_gateway_keys LIMIT 1").get().id;const policy={allowedModels:[]};f.sqlite.prepare("INSERT INTO aegis_records(namespace,id,payload,updated_at) VALUES('key_policy',?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET payload=excluded.payload").run(deniedKey,JSON.stringify(policy),new Date().toISOString());const denied=await handleModels(new Request('https://console.example/v1/models',{headers:{Authorization:`Bearer ${key}`}}),f.env);assert.deepEqual((await denied.json()).data,[]);}finally{f.close();}
});

test('legacy rollback runs on the current engine while copied verification remains explicitly historical',async()=>{
 const f=fixture();try{
  const workflow=await prepare(f),dataset={id:'legacy-suite',name:'이전 검증',description:'',rows:[{id:'case',input:'배송 문의',expected:'allow'}]};
  await f.action('save_dataset',{dataset});
  const run=(await f.action('run_evaluation',{workflowId:workflow.id,datasetId:dataset.id})).run;
  const first=(await f.action('publish',{workflowId:workflow.id,verificationRunIds:[run.id]})).deployment;
  const legacy={...first,engineVersion:'1',verificationSummaries:first.verificationSummaries.map(summary=>({...summary,engineVersion:'1'}))};
  f.sqlite.prepare('UPDATE aegis_deployments SET payload=? WHERE id=?').run(JSON.stringify(legacy),first.id);
  const restored=(await f.action('rollback_deployment',{deploymentId:first.id})).deployment;
  assert.equal(restored.engineVersion,'2');
  assert.equal(restored.verificationProvenance,'historical');
  assert.equal(restored.verificationSummaries[0].engineVersion,'1');
  assert.deepEqual(restored.verificationRunIds,[run.id]);
 }finally{f.close();}
});

test('rollback rejects an invalid historic configuration before creating a new version',async()=>{
 const f=fixture();try{
  const workflow=await prepare(f),first=(await f.action('publish',{workflowId:workflow.id})).deployment;
  const invalid={...first,workflow:{...first.workflow,mainConnectionId:'removed-model'}};
  f.sqlite.prepare('UPDATE aegis_deployments SET payload=? WHERE id=?').run(JSON.stringify(invalid),first.id);
  const result=await f.call({action:'rollback_deployment',deploymentId:first.id});
  assert.equal(result.status,400);
  assert.equal(result.data.error.code,'invalid_rollback_configuration');
  assert.equal(count(f,'aegis_deployments'),1);
 }finally{f.close();}
});
