import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'vite';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(join(project,'work'),{recursive:true});
const temporary=await mkdtemp(join(project,'work','storage-records-logs-'));
after(()=>rm(temporary,{recursive:true,force:true}));
const entry=join(temporary,'entry.ts');
await writeFile(entry,`export {AegisStore} from ${JSON.stringify(join(project,'lib/aegis-store.ts'))};`);
await build({root:project,configFile:false,publicDir:false,logLevel:'silent',build:{ssr:entry,outDir:join(temporary,'build'),emptyOutDir:true,target:'node22',rollupOptions:{output:{entryFileNames:'entry.mjs'}}}});
const {AegisStore}=await import(pathToFileURL(join(temporary,'build/entry.mjs')).href);
const migrations=await Promise.all((await readdir(join(project,'drizzle'))).filter(name=>/^\d+.*\.sql$/.test(name)).sort().map(name=>readFile(join(project,'drizzle',name),'utf8')));
function fixture(){
  const sqlite=new DatabaseSync(':memory:');for(const migration of migrations)sqlite.exec(migration);
  class Statement{
    constructor(query,values=[]){this.query=query;this.values=values;}
    bind(...values){return new Statement(this.query,values);}
    async first(){return sqlite.prepare(this.query).get(...this.values)||null;}
    async all(){return {results:sqlite.prepare(this.query).all(...this.values)};}
    executeRun(){return sqlite.prepare(this.query).run(...this.values);}
    async run(){return this.executeRun();}
  }
  const DB={prepare:query=>new Statement(query),async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const rows=statements.map(statement=>statement.executeRun());sqlite.exec('COMMIT');return rows;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  return {sqlite,store:new AegisStore({DB}),second:new AegisStore({DB}),close(){sqlite.close();}};
}
function log(id,extra={}){return{id,source:'gateway',workflowId:'workflow-one',workflowName:'고객 지원',version:'v1',createdAt:new Date(Date.now()-60_000).toISOString(),status:'allow',stage:'complete',latencyMs:12,reason:'검사를 통과했습니다.',...extra};}
function insert(f,value){f.sqlite.prepare('INSERT INTO aegis_request_logs (id,payload,created_at) VALUES (?,?,?)').run(value.id,JSON.stringify(value),value.createdAt);}

test('checked saves reject stale revisions, creation conflicts and deleted-record resurrection',async()=>{
  const f=fixture();try{
    assert.equal(await f.store.saveRecordChecked('workflow','one',{name:'initial'},null),true);
    const initial=await f.store.getRecord('workflow','one');
    assert.equal(await f.second.saveRecordChecked('workflow','one',{name:'other'},null),false);
    assert.equal(await f.store.saveRecordChecked('workflow','one',{name:'mine'},initial.updatedAt),true);
    const saved=await f.store.getRecord('workflow','one');assert.equal(saved.name,'mine');assert.ok(saved.updatedAt>initial.updatedAt);
    assert.equal(await f.second.saveRecordChecked('workflow','one',{name:'stale'},initial.updatedAt),false);
    assert.equal((await f.store.getRecord('workflow','one')).name,'mine');
    await f.store.remove('workflow','one');
    assert.equal(await f.second.saveRecordChecked('workflow','one',{name:'resurrected'},saved.updatedAt),false);
    assert.equal(await f.store.getRecord('workflow','one'),null);
  }finally{f.close();}
});

test('checked saves advance a same-millisecond revision and accept explicit legacy empty revision',async()=>{
  const f=fixture();try{
    const revision='2099-01-01T00:00:00.000Z';await f.store.put('dataset','same',{name:'initial',updatedAt:revision});
    assert.equal(await f.store.saveRecordChecked('dataset','same',{name:'first',updatedAt:revision},revision),true);
    assert.equal((await f.store.getRecord('dataset','same')).updatedAt,'2099-01-01T00:00:00.001Z');
    assert.equal(await f.second.saveRecordChecked('dataset','same',{name:'second'},revision),false);
    await f.store.put('dataset','legacy',{name:'old'});
    assert.equal(await f.store.saveRecordChecked('dataset','legacy',{name:'new'},''),true);
    assert.equal(await f.store.saveRecordChecked('dataset','missing',{name:'new'},''),false);
  }finally{f.close();}
});

test('record count limit is enforced inside the write while existing records stay editable',async()=>{
  const f=fixture();try{
    const saved=await Promise.all(Array.from({length:34},(_,index)=>(index%2?f.store:f.second).saveRecordChecked('dataset',`row-${index}`,{name:`dataset ${index}`},null)));
    assert.equal(saved.filter(Boolean).length,30);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS total FROM aegis_records WHERE namespace='dataset'").get().total,30);
    assert.equal(await f.store.saveRecordChecked('dataset','overflow',{name:'overflow'}),false);
    const current=await f.store.getRecord('dataset','row-0');assert.equal(await f.store.saveRecordChecked('dataset','row-0',{name:'edit'},current.updatedAt),true);
    assert.equal(await f.store.saveRecordChecked('workflow','independent',{name:'workflow'},null),true);
    assert.equal(await f.store.saveRecordChecked('dataset','row-0',{name:'legacy overwrite'}),true);
  }finally{f.close();}
});

test('server log search reaches records outside the recent 200 and supports all combined filters',async()=>{
  const f=fixture();try{
    const start=Date.now()-3600_000;
    for(let index=0;index<215;index++)insert(f,log(`request-${String(index).padStart(3,'0')}`,{createdAt:new Date(start+index*1000).toISOString(),...(index===3?{workflowId:'special',keyId:'key-one',source:'playground',status:'block',workflowName:'특별 검색'}:{})}));
    const all=await f.store.searchLogs();assert.equal(all.total,215);assert.equal(all.logs.length,50);assert.ok(all.nextCursor);assert.deepEqual(all.retention,{days:30,maxRecords:1000});
    const old=await f.store.searchLogs({query:'request-003'});assert.equal(old.total,1);assert.equal(old.logs[0].id,'request-003');
    const combined=await f.store.searchLogs({query:'특별',workflowId:'special',keyId:'key-one',source:'playground',status:'block',from:new Date(start+3000).toISOString(),to:new Date(start+4000).toISOString()});
    assert.deepEqual(combined.logs.map(row=>row.id),['request-003']);assert.equal(combined.total,1);
    assert.equal((await f.store.getRequestLog('request-003')).id,'request-003');assert.equal(await f.store.getRequestLog('missing'),null);
  }finally{f.close();}
});

test('log keyset pagination is stable for equal timestamps and new records',async()=>{
  const f=fixture();try{
    const timestamp=new Date(Date.now()-60_000).toISOString();
    for(const id of ['a','b','c','d','한글'])insert(f,log(id,{createdAt:timestamp}));
    const first=await f.store.searchLogs({limit:2});assert.deepEqual(first.logs.map(row=>row.id),['한글','d']);
    insert(f,log('new',{createdAt:new Date().toISOString()}));
    const second=await f.store.searchLogs({limit:2,cursor:first.nextCursor});assert.deepEqual(second.logs.map(row=>row.id),['c','b']);assert.equal(second.total,6);
    const third=await f.store.searchLogs({limit:2,cursor:second.nextCursor});assert.deepEqual(third.logs.map(row=>row.id),['a']);assert.equal(third.nextCursor,undefined);
  }finally{f.close();}
});

test('log search treats query text literally, validates cursors and enforces retention',async()=>{
  const f=fixture();try{
    insert(f,log('literal-%_quote\' OR 1=1'));
    insert(f,log('ordinary'));insert(f,log('expired',{createdAt:new Date(Date.now()-31*86_400_000).toISOString()}));
    const found=await f.store.searchLogs({query:"%_quote' OR 1=1"});assert.equal(found.total,1);assert.equal(found.logs[0].id,"literal-%_quote' OR 1=1");
    assert.equal((await f.store.searchLogs()).total,2);assert.equal(await f.store.getRequestLog('expired'),null);
    for(const cursor of ['garbage','!!!',btoa(JSON.stringify(['not a date','id'])),btoa(JSON.stringify(['2026-01-01T00:00:00.000Z','x'.repeat(121)]))])await assert.rejects(f.store.searchLogs({cursor}));
    for(const options of [{limit:0},{limit:101},{limit:1.5},{status:'unknown'},{source:'unknown'},{query:'x'.repeat(201)},{from:'bad'},{from:'2026-01-02',to:'2026-01-01'}])await assert.rejects(f.store.searchLogs(options));
  }finally{f.close();}
});

test('search returns only sanitized metadata written through the log API',async()=>{
  const f=fixture();try{
    await f.store.log(log('safe-log',{reason:'PRIVATE_MODEL_REASON',input:'PRIVATE_INPUT',output:'PRIVATE_OUTPUT',traces:[{ruleId:'rule',ruleName:'검사',groupId:'group',stage:'post',status:'block',latencyMs:1,reason:'PRIVATE_CLASSIFIER_REASON'}]}));
    const page=await f.store.searchLogs({query:'safe-log'});assert.equal(page.total,1);
    for(const raw of ['PRIVATE_MODEL_REASON','PRIVATE_INPUT','PRIVATE_OUTPUT','PRIVATE_CLASSIFIER_REASON'])assert.equal(JSON.stringify(page).includes(raw),false);
    assert.equal(page.logs[0].traces[0].status,'block');
  }finally{f.close();}
});

function deployment(f,{id,workflowId='workflow-one',alias='assistant',version=1,createdAt=new Date().toISOString(),name='saved'}={}){
  const value={id,workflowId,alias,version,createdAt,workflow:{id:workflowId,name,pre:[],post:[],mainConnectionId:'main',alias,description:'',updatedAt:createdAt},connections:[]};
  f.sqlite.prepare('INSERT INTO aegis_deployments (id,workflow_id,alias,version,payload,created_at) VALUES (?,?,?,?,?,?)').run(id,workflowId,alias,version,JSON.stringify(value),createdAt);
  return value;
}

test('request deployment lookup reaches immutable snapshots beyond the recent history limit',async()=>{
  const f=fixture();try{
    const old=deployment(f,{id:'old',createdAt:'2025-01-01T00:00:00.000Z',name:'original snapshot'});
    for(let index=0;index<105;index++)deployment(f,{id:`newer-${index}`,version:index+2,createdAt:new Date(Date.now()-index*1000).toISOString()});
    assert.equal((await f.store.state()).deployments.some(row=>row.id==='old'),false);
    const found=await f.store.getDeploymentForRequest('workflow-one',1);
    assert.equal(found.id,old.id);assert.equal(found.workflow.name,'original snapshot');
    await f.store.put('workflow','workflow-one',{id:'workflow-one',name:'changed draft'});
    assert.equal((await f.store.getDeployment(old.id)).workflow.name,'original snapshot');
    assert.equal(await f.store.getDeploymentForRequest('workflow-one',999),null);
  }finally{f.close();}
});

test('legacy deployment lookup refuses ambiguity after an alias rename while exact IDs remain valid',async()=>{
  const f=fixture();try{
    deployment(f,{id:'before-rename',alias:'before',version:1,name:'before rename'});
    deployment(f,{id:'after-rename',alias:'after',version:1,name:'after rename'});
    assert.equal(await f.store.getDeploymentForRequest('workflow-one',1),null);
    assert.equal((await f.store.getDeployment('before-rename')).workflow.name,'before rename');
    await f.store.log(log('exact-request',{deploymentId:'before-rename'}));
    assert.equal((await f.store.getRequestLog('exact-request')).deploymentId,'before-rename');
    assert.equal((await f.store.searchLogs({query:'exact-request'})).logs[0].deploymentId,'before-rename');
    for(const [workflowId,version] of [['',1],['workflow-one',0],['workflow-one',1.5],['workflow-one',Infinity]])await assert.rejects(f.store.getDeploymentForRequest(workflowId,version));
  }finally{f.close();}
});

function evidence(id,datasetId,extra={}){
  return {id,workflowId:'workflow-one',datasetId,datasetName:`검증 ${datasetId}`,createdAt:new Date(Date.now()-60_000).toISOString(),status:'completed',fingerprint:'a'.repeat(64),datasetFingerprint:'b'.repeat(64),total:1,
    datasetSnapshot:{rows:[{id:'row-one',input:'PRIVATE_EVIDENCE_INPUT',expected:'allow'}]},
    results:[{rowId:'row-one',expectationMatched:true,input:'PRIVATE_EVIDENCE_INPUT',output:'PRIVATE_EVIDENCE_OUTPUT',status:'allow'}],...extra};
}

test('verification evidence discovers all required datasets beyond the recent ten without returning raw data',async()=>{
  const f=fixture();try{
    for(let index=0;index<13;index++){
      const datasetId=`suite-${index}`;await f.store.put('dataset',datasetId,{id:datasetId,rows:[{id:'row-one',input:'PRIVATE_CURRENT_INPUT',expected:'allow'}]});
      await f.store.put('run',`evidence-${index}`,evidence(`evidence-${index}`,datasetId,{createdAt:new Date(Date.now()-index*1000).toISOString()}));
    }
    assert.equal((await f.store.state()).runs.length,10);
    const all=await f.store.verificationEvidence('workflow-one','a'.repeat(64));assert.equal(all.length,13);
    assert.equal(new Set(all.map(row=>row.datasetId)).size,13);assert.ok(all.every(row=>row.completeCoverage&&row.matchedCount===1&&row.completedCount===1&&row.mock===false));
    for(const row of all)assert.deepEqual(Object.keys(row).sort(),['id','datasetId','datasetName','createdAt','fingerprint','datasetFingerprint','total','completedCount','matchedCount','completeCoverage','mock'].sort());
    assert.equal(JSON.stringify(all).includes('PRIVATE_'),false);
    assert.equal((await f.store.verificationEvidence('other-workflow','a'.repeat(64))).length,0);
    assert.equal((await f.store.verificationEvidence('workflow-one','c'.repeat(64))).length,0);
  }finally{f.close();}
});

test('verification summaries reject incomplete, duplicate, wrong-row, mock and legacy-unknown proof',async()=>{
  const f=fixture();try{
    const cases=[
      ['complete',{},true,1,false],
      ['wrong-row',{results:[{rowId:'other',expectationMatched:true}]},false,1,false],
      ['partial',{datasetSnapshot:{rows:[{id:'row-one'},{id:'row-two'}]},total:2},false,1,false],
      ['duplicate',{datasetSnapshot:{rows:[{id:'row-one'},{id:'row-two'}]},total:2,results:[{rowId:'row-one',expectationMatched:true},{rowId:'row-one',expectationMatched:true}]},false,2,false],
      ['wrong-total',{total:2},false,1,false],
      ['empty',{datasetSnapshot:{rows:[]},total:0,results:[]},false,0,false],
      ['mock',{results:[{rowId:'row-one',expectationMatched:true,executionMode:'mock'}]},true,1,true],
      ['legacy',{results:[{rowId:'row-one'}]},true,0,false],
      ['number-not-boolean',{results:[{rowId:'row-one',expectationMatched:1}]},true,0,false],
    ];
    for(const [id,extra] of cases){await f.store.put('dataset',id,{id});await f.store.put('run',id,evidence(id,id,extra));}
    const all=await f.store.verificationEvidence('workflow-one');
    for(const [id,,coverage,matched,mock] of cases){const summary=all.find(row=>row.id===id);assert.ok(summary,id);assert.equal(summary.completeCoverage,coverage,id);assert.equal(summary.matchedCount,matched,id);assert.equal(summary.mock,mock,id);}
  }finally{f.close();}
});

test('verification summaries retain recent failures and earlier passes per dataset within a fixed metadata bound',async()=>{
  const f=fixture();try{
    const timestamp=Date.now();
    for(let dataset=0;dataset<30;dataset++){
      const datasetId=`bounded-${dataset}`;await f.store.put('dataset',datasetId,{id:datasetId});
      for(let index=0;index<9;index++){
        const id=`bounded-${dataset}-${index}`;
        await f.store.put('run',id,evidence(id,datasetId,{createdAt:new Date(timestamp-index*1000).toISOString(),results:[{rowId:'row-one',expectationMatched:index>=5}]}));
      }
    }
    const rows=await f.store.verificationEvidence('workflow-one','a'.repeat(64));assert.equal(rows.length,180);
    for(let dataset=0;dataset<30;dataset++){
      const selected=rows.filter(row=>row.datasetId===`bounded-${dataset}`);assert.equal(selected.length,6);
      assert.equal(selected.filter(row=>row.matchedCount===1).length,3);assert.equal(selected.filter(row=>row.matchedCount===0).length,3);
    }
  }finally{f.close();}
});

test('verification summaries exclude deleted datasets, non-completed records and expired history',async()=>{
  const f=fixture();try{
    await f.store.put('dataset','exists',{id:'exists'});
    await f.store.put('run','good',evidence('good','exists'));
    await f.store.put('run','deleted',evidence('deleted','gone'));
    await f.store.put('run','running',evidence('running','exists',{status:'running'}));
    await f.store.put('run','cancelled',evidence('cancelled','exists',{status:'cancelled'}));
    await f.store.put('run','expired',evidence('expired','exists',{createdAt:new Date(Date.now()-31*86_400_000).toISOString()}));
    assert.deepEqual((await f.store.verificationEvidence('workflow-one')).map(row=>row.id),['good']);
    await assert.rejects(f.store.verificationEvidence(''));
    await assert.rejects(f.store.verificationEvidence('workflow-one','invalid'));
  }finally{f.close();}
});
