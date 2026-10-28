import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
// @ts-expect-error Node tests resolve TypeScript paths.
import {initialState} from '../lib/aegis-seed.ts';
// @ts-expect-error Node tests resolve TypeScript paths.
import {executeWorkflow} from '../lib/aegis-engine.ts';
// @ts-expect-error Node tests resolve TypeScript paths.
import {acquireModelCapacity,modelConcurrencyLimit} from '../lib/model-capacity.ts';
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(value=>{resolve=value;});return {promise,resolve};}
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE aegis_records(namespace TEXT,id TEXT,payload TEXT,updated_at TEXT,PRIMARY KEY(namespace,id))');
 class Statement{query:string;values:unknown[];constructor(query:string,values:unknown[]=[]){this.query=query;this.values=values;}bind(...values:unknown[]){return new Statement(this.query,values);}async first(){return sqlite.prepare(this.query).get(...this.values as never[])??null;}async all(){return {results:sqlite.prepare(this.query).all(...this.values as never[])};}async run(){return sqlite.prepare(this.query).run(...this.values as never[]);}}
 const DB={prepare:(query:string)=>new Statement(query),async batch(){return [];}};
 const state=initialState(),workflow=state.workflows[0];workflow.pre=[];workflow.post=[];const connection=state.connections[0];connection.mode='vllm';connection.role='both';connection.baseUrl='https://shared-model.example/v1';state.ingress.allowedOrigins=['https://shared-model.example'];
 const env={DB,AEGIS_MODEL_MAX_CONCURRENT:'1'};
 const active=()=>{const row=sqlite.prepare("SELECT payload FROM aegis_records WHERE namespace='model_capacity' AND id=?").get(connection.id) as {payload:string}|undefined;return Object.values(JSON.parse(row?.payload??'{"leases":{}}').leases).filter(value=>Number(value)>Date.now()).length;};
 return {sqlite,state,workflow,connection,env,active};
}
const reply=(content:string)=>Response.json({choices:[{message:{content},finish_reason:'stop'}]});

test('main and guard calls across separate executions share an atomic connection pool',async()=>{
 const f=fixture(),original=globalThis.fetch,started=deferred<void>(),guardDone=deferred<Response>();let calls=0;
 const guarded=structuredClone(f.workflow);guarded.pre=[{id:'pre',name:'검사',mode:'any',rules:[{id:'rule',name:'모델 검사',description:'',kind:'llm',enabled:true,config:{connectionId:f.connection.id,prompt:'분류'}}]}];
 globalThis.fetch=async(_url,options)=>{calls++;const body=JSON.parse(String(options?.body));if(body.messages[0]?.content.startsWith('You are a security policy classifier')){started.resolve();return guardDone.promise;}return reply('정상 응답');};
 try{const first=executeWorkflow(guarded,f.state.connections,f.state.ingress,f.env,[{role:'user',content:'질문'}]);await started.promise;assert.equal(f.active(),1);const second=await executeWorkflow(f.workflow,f.state.connections,f.state.ingress,f.env,[{role:'user',content:'다른 질문'}]);assert.equal(second.status,'error');assert.equal(second.stage,'main');assert.match(second.reason,/동시 호출 한도/);assert.equal(second.output,'');assert.equal(calls,1);guardDone.resolve(reply('{"verdict":"allow","reason":"통과"}'));assert.equal((await first).status,'allow');assert.equal(calls,2);assert.equal(f.active(),0);}finally{globalThis.fetch=original;f.sqlite.close();}
});

test('cancellation releases a shared lease before another execution starts',async()=>{
 const f=fixture(),original=globalThis.fetch,started=deferred<void>(),controller=new AbortController();let calls=0;
 globalThis.fetch=async()=>{calls++;if(calls===1){started.resolve();return await new Promise<Response>(()=>{});}return reply('정상 응답');};
 try{const first=executeWorkflow(f.workflow,f.state.connections,f.state.ingress,f.env,[{role:'user',content:'질문'}],{signal:controller.signal});await started.promise;assert.equal(f.active(),1);controller.abort();assert.equal((await first).status,'error');assert.equal(f.active(),0);assert.equal((await executeWorkflow(f.workflow,f.state.connections,f.state.ingress,f.env,[{role:'user',content:'재실행'}])).status,'allow');assert.equal(calls,2);assert.equal(f.active(),0);}finally{globalThis.fetch=original;f.sqlite.close();}
});

test('expired crash leases recover and failed storage never starts inference',async()=>{
 const f=fixture(),original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return reply('정상 응답');};
 try{f.sqlite.prepare("INSERT INTO aegis_records VALUES ('model_capacity',?,?,?)").run(f.connection.id,JSON.stringify({leases:{crashed:Date.now()-1}}),new Date().toISOString());const lease=await acquireModelCapacity(f.connection,f.env);assert.equal(f.active(),1);await lease.release();await lease.release();assert.equal(f.active(),0);const failing={...f.env,DB:{prepare(){throw new Error('sensitive database path');}}};const result=await executeWorkflow(f.workflow,f.state.connections,f.state.ingress,failing,[{role:'user',content:'질문'}]);assert.equal(result.status,'error');assert.equal(result.output,'');assert.equal(calls,0);assert.match(result.reason,/저장소 상태/);assert.ok(!result.reason.includes('sensitive'));}finally{globalThis.fetch=original;f.sqlite.close();}
});

test('server connection concurrency is explicit and does not affect demo execution',async()=>{
 assert.equal(modelConcurrencyLimit({}),8);assert.equal(modelConcurrencyLimit({AEGIS_MODEL_MAX_CONCURRENT:'12'}),12);for(const value of ['0','1.5','oops',1001,-1])assert.throws(()=>modelConcurrencyLimit({AEGIS_MODEL_MAX_CONCURRENT:value}));
 const state=initialState();state.workflows[0].pre=[];state.workflows[0].post=[];assert.equal((await executeWorkflow(state.workflows[0],state.connections,state.ingress,{AEGIS_MODEL_MAX_CONCURRENT:'invalid'},[{role:'user',content:'질문'}])).status,'allow');
});
