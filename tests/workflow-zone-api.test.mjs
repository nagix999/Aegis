import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {handleConsole} from '../.local-runtime/server/api.mjs';

const migrations=await Promise.all((await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/.test(name)).sort().map(name=>readFile(new URL(`../drizzle/${name}`,import.meta.url),'utf8')));
function fixture(){
 const sqlite=new DatabaseSync(':memory:');for(const migration of migrations)sqlite.exec(migration);
 class Statement{constructor(query,values=[]){this.query=query;this.values=values;}bind(...values){return new Statement(this.query,values);}async first(){return sqlite.prepare(this.query).get(...this.values)||null;}async all(){return {results:sqlite.prepare(this.query).all(...this.values)};}executeRun(){const result=sqlite.prepare(this.query).run(...this.values);return {meta:{changes:Number(result.changes)}};}async run(){return this.executeRun();}}
 const DB={prepare:query=>new Statement(query),async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const values=statements.map(statement=>statement.executeRun());sqlite.exec('COMMIT');return values;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 const call=async payload=>{const response=await handleConsole(new Request('https://console.example/api/console',{method:payload?'POST':'GET',headers:payload?{'Content-Type':'application/json'}:{},...(payload?{body:JSON.stringify(payload)}:{})}),{DB});return {status:response.status,data:await response.json()};};
 return {call,close:()=>sqlite.close()};
}
function zone(nodeKeys){return {id:'test-zone',name:'테스트 영역',color:'blue',nodeKeys,x:10,y:10,width:300,height:200};}

test('server rejects skipped node grouping and leaves saved graph and draft unchanged',async()=>{
 const f=fixture();try{const state=(await f.call()).data.state,workflow=structuredClone(state.workflows[0]);workflow.layout={version:1,positions:{},zones:[zone(['input','output'])]};
  const rejected=await f.call({action:'save_workflow',workflow});assert.equal(rejected.status,400);assert.equal(rejected.data.error.code,'noncontiguous_zone');
  const unchanged=(await f.call()).data.state.workflows.find(item=>item.id===workflow.id);assert.deepEqual(unchanged,state.workflows[0]);
 }finally{f.close();}
});
test('server accepts contiguous terminal groups and empty area placeholders without altering execution',async()=>{
 const f=fixture();try{const state=(await f.call()).data.state,workflow=structuredClone(state.workflows[0]);workflow.pre=[];workflow.post=[];delete workflow.graph;
  for(const nodeKeys of [[],['input'],['main','output'],['input','main','output']]){workflow.layout={version:1,positions:{},zones:[zone(nodeKeys)]};const response=await f.call({action:'save_workflow',workflow});assert.equal(response.status,200,JSON.stringify(response.data.error));const saved=response.data.state.workflows.find(item=>item.id===workflow.id);assert.deepEqual(saved.pre,[]);assert.deepEqual(saved.post,[]);assert.equal(saved.graph,undefined);assert.deepEqual(saved.layout.zones[0].nodeKeys,nodeKeys);}
 }finally{f.close();}
});
