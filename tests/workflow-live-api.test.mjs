import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {handleConsole} from '../.local-runtime/server/api.mjs';

const migrations=await Promise.all((await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/.test(name)).sort().map(name=>readFile(new URL(`../drizzle/${name}`,import.meta.url),'utf8')));
function fixture(overrides={}){
 const sqlite=new DatabaseSync(':memory:');for(const migration of migrations)sqlite.exec(migration);
 class Statement{constructor(query,values=[]){this.query=query;this.values=values;}bind(...values){return new Statement(this.query,values);}async first(){return sqlite.prepare(this.query).get(...this.values)||null;}async all(){return {results:sqlite.prepare(this.query).all(...this.values)};}executeRun(){const r=sqlite.prepare(this.query).run(...this.values);return {meta:{changes:Number(r.changes)}};}async run(){return this.executeRun();}}
 const DB={prepare:q=>new Statement(q),async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const values=statements.map(statement=>statement.executeRun());sqlite.exec('COMMIT');return values;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};const env={DB,...overrides};
 const request=(payload,identity)=>new Request('https://console.example/api/console',{method:payload?'POST':'GET',headers:{...(payload?{'Content-Type':'application/json'}:{}),...(identity?{'oai-authenticated-user-id':identity}:{})},...(payload?{body:JSON.stringify(payload)}:{})});
 const call=(payload,identity)=>handleConsole(request(payload,identity),env);
 const action=async(action,payload={})=>{const response=await call({action,...payload});assert.equal(response.status,200);return response.json();};
 return {sqlite,env,call,action,close:()=>sqlite.close()};
}
const payload={action:'playground',workflowId:'wf-support',target:'draft',input:'배송 문의',progress:true};
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function records(response){assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/ndjson/);return (await response.text()).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
async function prepareMain(f){const state=(await (await f.call()).json()).state;const workflow={...state.workflows[0],pre:[],post:[]};await f.action('save_workflow',{workflow});const connection={...state.connections.find(connection=>connection.id===workflow.mainConnectionId),mode:'vllm',baseUrl:'https://main.example.com/v1'};await f.action('save_connection',{connection});await f.action('save_ingress',{ingress:{...state.ingress,allowedOrigins:['https://main.example.com']}});}

test('management progress stream delivers actual progress before a deferred model completes',{timeout:5000},async()=>{
 const f=fixture(),original=globalThis.fetch,gate=deferred(),started=deferred();let finished=false;
 globalThis.fetch=async()=>{started.resolve();await gate.promise;return Response.json({choices:[{message:{content:'안전한 답변'}}]});};
 try{await prepareMain(f);const response=await f.call(payload);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/ndjson/);await started.promise;const reader=response.body.getReader();const decoder=new TextDecoder();let text='';while(!text.includes('\n')){const item=await reader.read();assert.equal(item.done,false);text+=decoder.decode(item.value,{stream:true});}const first=JSON.parse(text.split('\n')[0]);assert.equal(first.type,'progress');assert.equal(finished,false);assert.ok(!text.includes('"type":"result"'));gate.resolve();while(true){const next=await reader.read();if(next.done)break;text+=decoder.decode(next.value,{stream:true});}finished=true;const items=text.trim().split('\n').map(line=>JSON.parse(line));assert.ok(items.some(item=>item.type==='progress'&&item.event.stage==='main'&&item.event.status==='running'));const final=items.find(item=>item.type==='result');assert.equal(final.result.output,'안전한 답변');assert.match(final.fingerprint,/^[a-f0-9]{64}$/);assert.ok(!items.some(item=>item.type==='error'));}
 finally{gate.resolve();globalThis.fetch=original;f.close();}
});

test('streaming output inspection never exposes rejected model text and persists masked logs',async()=>{
 const f=fixture(),original=globalThis.fetch;globalThis.fetch=async()=>Response.json({choices:[{message:{content:'REJECTED_PRIVATE_OUTPUT'}}]});
 try{await prepareMain(f);const state=(await (await f.call()).json()).state;const workflow=state.workflows[0];workflow.post=[{id:'post-deny',name:'응답 검사',mode:'any',rules:[{id:'deny-rule',name:'응답 검사',description:'',kind:'keyword',enabled:true,config:{pattern:'REJECTED_PRIVATE_OUTPUT'}}]}];await f.action('save_workflow',{workflow});const items=await records(await f.call(payload));const result=items.find(item=>item.type==='result').result;assert.equal(result.status,'block');assert.equal(result.output,'');assert.ok(!JSON.stringify(items).includes('REJECTED_PRIVATE_OUTPUT'));assert.ok(items.some(item=>item.type==='progress'&&item.event.stage==='post'&&item.event.status==='block'));const logs=f.sqlite.prepare('SELECT payload FROM aegis_request_logs').all();assert.ok(logs.length>0);assert.ok(!JSON.stringify(logs).includes('REJECTED_PRIVATE_OUTPUT'));}
 finally{globalThis.fetch=original;f.close();}
});

test('streaming still enforces authentication, viewer permissions and reviewed fingerprint before execution',async()=>{
 const f=fixture({AEGIS_REQUIRE_ADMIN_IDENTITY:'true',AEGIS_ROLE_MAP:{writer:'editor',reader:'viewer'}}),original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Must not execute');};
 try{assert.equal((await f.call(payload)).status,401);assert.equal((await f.call(payload,'reader')).status,403);const stale=await f.call({...payload,expectedFingerprint:'f'.repeat(64)},'writer');assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'stale_workflow_execution');for(const invalid of [{progress:'true'},{expectedFingerprint:'bad'}])assert.equal((await f.call({...payload,...invalid},'writer')).status,400);assert.equal(calls,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM aegis_request_logs').get().count,0);}
 finally{globalThis.fetch=original;f.close();}
});

test('ordinary playground requests preserve their JSON response contract',async()=>{
 const f=fixture();try{const response=await f.call({...payload,progress:false});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/json/);const result=await response.json();assert.equal(result.result.status,'allow');assert.ok(result.state.workflows.length);assert.match(result.fingerprint,/^[a-f0-9]{64}$/);}
 finally{f.close();}
});

test('closing a progress reader cannot interrupt policy execution or corrupt its saved result',{timeout:5000},async()=>{
 const f=fixture(),original=globalThis.fetch,gate=deferred(),started=deferred();
 globalThis.fetch=async()=>{started.resolve();await gate.promise;return Response.json({choices:[{message:{content:'허용 응답'}}]});};
 try{
  await prepareMain(f);const response=await f.call(payload);await started.promise;
  const reader=response.body.getReader();const first=await reader.read();assert.equal(first.done,false);
  await reader.cancel();gate.resolve();
  const deadline=Date.now()+1500;let logs=[];
  while(Date.now()<deadline){logs=f.sqlite.prepare('SELECT payload FROM aegis_request_logs').all();if(logs.length)break;await new Promise(done=>setTimeout(done,10));}
  assert.equal(logs.length,1);assert.equal(JSON.parse(logs[0].payload).status,'allow');
  const audits=f.sqlite.prepare("SELECT payload FROM aegis_records WHERE namespace='audit' AND json_extract(payload,'$.action')='playground'").all();
  assert.equal(audits.length,1);assert.ok(!JSON.stringify(logs).includes('허용 응답'));
 }finally{gate.resolve();globalThis.fetch=original;f.close();}
});
