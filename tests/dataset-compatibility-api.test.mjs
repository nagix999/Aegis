import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readdir,readFile} from 'node:fs/promises';
import {handleConsole} from '../.local-runtime/server/api.mjs';
import {evaluationPreflight} from '../lib/dataset-compatibility.ts';
import {configurationFingerprint,datasetFingerprint} from '../lib/workflow-review.ts';
import {cloneWorkflowContent} from '../lib/workflow-clone.ts';

const migrations=await Promise.all((await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/.test(name)).sort().map(name=>readFile(new URL(`../drizzle/${name}`,import.meta.url),'utf8')));
function fixture(overrides={}){
  const sqlite=new DatabaseSync(':memory:');for(const migration of migrations)sqlite.exec(migration);
  let beforeMappedInsert;
  class Statement{
    constructor(query,values=[]){this.query=query;this.values=values;}
    bind(...values){return new Statement(this.query,values);}
    async first(){if(beforeMappedInsert&&this.query.includes("SELECT 'dataset'")){const action=beforeMappedInsert;beforeMappedInsert=undefined;action();}return sqlite.prepare(this.query).get(...this.values)||null;}
    async all(){return {results:sqlite.prepare(this.query).all(...this.values)};}
    executeRun(){const result=sqlite.prepare(this.query).run(...this.values);return {meta:{changes:Number(result.changes)}};}
    async run(){return this.executeRun();}
  }
  const DB={prepare:query=>new Statement(query),async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const results=statements.map(statement=>statement.executeRun());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const env={DB,...overrides};
  const call=async(payload,identity)=>{const response=await handleConsole(new Request('https://console.example/api/console',{method:payload?'POST':'GET',headers:{...(payload?{'Content-Type':'application/json'}:{}),...(identity?{'oai-authenticated-user-id':identity}:{})},...(payload?{body:JSON.stringify(payload)}:{})}),env);return {status:response.status,data:await response.json()};};
  const action=async(name,payload={},identity)=>{const response=await call({action:name,...payload},identity);assert.equal(response.status,200,`${name}: ${JSON.stringify(response.data.error)}`);return response.data;};
  return {sqlite,call,action,beforeInsert(action){beforeMappedInsert=action;},close(){sqlite.close();}};
}
const latestDeployment=(state,id)=>state.deployments.filter(item=>item.workflowId===id).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.version-a.version)[0];
async function preflight(state,workflowId,datasetId,target='draft',compare=false){
  const deployed=latestDeployment(state,workflowId),workflow=target==='deployed'?deployed.workflow:state.workflows.find(item=>item.id===workflowId);
  return evaluationPreflight(state.datasets.find(item=>item.id===datasetId),[
    {key:'candidate',label:'검증 대상',workflow,connections:target==='deployed'?deployed.connections:state.connections},
    ...(compare?[{key:'baseline',label:'비교 배포',workflow:deployed.workflow,connections:deployed.connections}]:[]),
  ]);
}
async function criterionDataset(f,ruleId,stage='pre'){
  const state=(await f.call()).data.state,source=structuredClone(state.datasets[0]);
  source.rows=[{id:'private-case',input:'  연락처 user@example.com PRIVATE_CASE_MARKER\n',expected:'block',expectedStage:stage,expectedRuleId:ruleId,category:'개인정보',note:'검사 기준을 검토할 항목'}];
  return (await f.action('save_dataset',{dataset:source})).state;
}
async function copiedWorkflow(f){
  const state=(await f.call()).data.state;let sequence=0;
  const clone=cloneWorkflowContent(state.workflows[0],prefix=>`${prefix}-copy-${++sequence}`);clone.id='workflow-copy';clone.name='복제 정책';clone.alias='policy-copy';
  return (await f.action('save_workflow',{workflow:clone})).state.workflows.find(item=>item.id===clone.id);
}
async function mappedPayload(state,datasetId,workflowId,target='draft',mappings={}){
  const deployed=latestDeployment(state,workflowId),workflow=target==='deployed'?deployed.workflow:state.workflows.find(item=>item.id===workflowId);
  return {sourceDatasetId:datasetId,workflowId,target,name:'복제 정책 검증 데이터셋',mappings,expectedDatasetFingerprint:await datasetFingerprint(state.datasets.find(item=>item.id===datasetId)),expectedWorkflowFingerprint:await configurationFingerprint(workflow,target==='deployed'?deployed.connections:state.connections)};
}

test('clean evaluation starts remain compatible and capture completed preflight without invoking a model',async()=>{
  const f=fixture();try{const state=(await f.call()).data.state;const response=await f.action('start_evaluation',{workflowId:state.workflows[0].id,datasetId:state.datasets[0].id,target:'draft'});
    assert.equal(response.run.status,'running');assert.equal(response.run.preflight.issueCount,0);assert.equal(response.run.preflight.acknowledged,false);assert.equal(response.state.logs.length,0);
  }finally{f.close();}
});

test('missing expected detectors require exact explicit acknowledgement before new or legacy evaluation creates a run',async()=>{
  const f=fixture();try{const state=await criterionDataset(f,'missing-detector'),workflow=state.workflows[0],dataset=state.datasets[0],proof=await preflight(state,workflow.id,dataset.id);assert.equal(proof.requiresAcknowledgement,true);
    for(const action of ['start_evaluation','run_evaluation']){const response=await f.call({action,workflowId:workflow.id,datasetId:dataset.id,target:'draft'});assert.equal(response.status,400);assert.equal(response.data.error.code,'dataset_criteria_review_required');assert.ok(!JSON.stringify(response.data).includes('PRIVATE_CASE_MARKER'));}
    assert.equal((await f.call()).data.state.runs.length,0);assert.equal((await f.call()).data.state.logs.length,0);
    let response=await f.action('start_evaluation',{workflowId:workflow.id,datasetId:dataset.id,target:'draft',acknowledgeCriteria:true,preflightFingerprint:proof.fingerprint});
    assert.equal(response.run.preflight.acknowledged,true);assert.equal(response.run.preflight.issueCount,proof.issues.length);
    response=await f.action('step_evaluation',{runId:response.run.id});assert.equal(response.run.results[0].expectationMatched,false);assert.equal(response.run.results[0].expectedRuleId,'missing-detector');
  }finally{f.close();}
});

test('dataset or workflow execution changes invalidate a reviewed preflight before insertion',async()=>{
  for(const changed of ['dataset','workflow']){const f=fixture();try{let state=await criterionDataset(f,'missing-detector');const workflow=state.workflows[0],dataset=state.datasets[0],proof=await preflight(state,workflow.id,dataset.id);
    if(changed==='dataset'){dataset.rows[0].note='검토 이후 변경';state=(await f.action('save_dataset',{dataset})).state;}
    else{workflow.pre[0].rules[0].enabled=!workflow.pre[0].rules[0].enabled;state=(await f.action('save_workflow',{workflow})).state;}
    const response=await f.call({action:'start_evaluation',workflowId:workflow.id,datasetId:dataset.id,target:'draft',acknowledgeCriteria:true,preflightFingerprint:proof.fingerprint});assert.equal(response.status,409);assert.equal(response.data.error.code,'stale_dataset_preflight');assert.equal((await f.call()).data.state.runs.length,0);
  }finally{f.close();}}
});

test('comparison preflight checks its deployed side and records intentional mismatch without changing snapshots',async()=>{
  const f=fixture();try{let state=(await f.call()).data.state;const workflow=structuredClone(state.workflows[0]);await f.action('publish',{workflowId:workflow.id});workflow.pre[0].rules[0].id='new-draft-detector';await f.action('save_workflow',{workflow});state=await criterionDataset(f,'new-draft-detector');
    const dataset=state.datasets[0],proof=await preflight(state,workflow.id,dataset.id,'draft',true);assert.ok(proof.issues.every(issue=>issue.sideKey==='baseline'));
    const blocked=await f.call({action:'start_evaluation',workflowId:workflow.id,datasetId:dataset.id,target:'draft',compare:true});assert.equal(blocked.status,400);
    const started=await f.action('start_evaluation',{workflowId:workflow.id,datasetId:dataset.id,target:'draft',compare:true,acknowledgeCriteria:true,preflightFingerprint:proof.fingerprint});const completed=await f.action('step_evaluation',{runId:started.run.id});
    assert.equal(completed.run.results[0].expectationMatched,true);assert.equal(completed.run.baselineResults[0].expectationMatched,false);assert.equal(completed.run.baselineWorkflowSnapshot.pre[0].rules[0].id,state.deployments[0].workflow.pre[0].rules[0].id);
    const original=JSON.stringify(completed.run);await f.action('delete_dataset',{id:dataset.id});const replay=await f.action('replay_evaluation',{runId:completed.run.id});assert.equal(replay.run.preflight.fingerprint,proof.fingerprint);assert.equal(replay.run.replayOf,completed.run.id);assert.equal(JSON.stringify((await f.call()).data.state.runs.find(run=>run.id===completed.run.id)),original);
  }finally{f.close();}
});

test('reviewed mappings create an independent dataset and leave source inputs, criteria and annotations unchanged',async()=>{
  const f=fixture();try{const originalState=(await f.call()).data.state,sourceRule=originalState.workflows[0].pre[0].rules[0].id;await criterionDataset(f,sourceRule);const clone=await copiedWorkflow(f);const state=(await f.call()).data.state,source=state.datasets[0],before=JSON.stringify(source),targetRule=clone.pre[0].rules[0].id;
    const payload=await mappedPayload(state,source.id,clone.id,'draft',{[sourceRule]:targetRule});const created=await f.action('create_mapped_dataset',{...payload,id:source.id,dataset:{id:source.id}});const copy=created.dataset;
    assert.notEqual(copy.id,source.id);assert.equal(copy.name,payload.name);assert.notEqual(copy.rows[0].id,source.rows[0].id);assert.equal(copy.rows[0].expectedRuleId,targetRule);assert.deepEqual({...copy.rows[0],id:source.rows[0].id,expectedRuleId:sourceRule},source.rows[0]);assert.equal(JSON.stringify(created.state.datasets.find(item=>item.id===source.id)),before);
    assert.equal((await preflight(created.state,clone.id,copy.id)).requiresAcknowledgement,false);const evaluated=await f.action('run_evaluation',{workflowId:clone.id,datasetId:copy.id,target:'draft'});assert.equal(evaluated.run.results[0].expectationMatched,true);
  }finally{f.close();}
});

test('a mapped clone restores detector-specific expectations while the original dataset and successful run remain immutable',async()=>{
  const f=fixture();try{
    let state=(await f.call()).data.state;const workflow=structuredClone(state.workflows[0]);
    workflow.pre=[{id:'source-check',name:'금지 문구 검사',mode:'any',rules:[{id:'source-ban',name:'금지 문구',description:'',kind:'keyword',enabled:true,config:{pattern:'BLOCK_MARKER'}}]}];workflow.post=[];
    await f.action('save_workflow',{workflow});
    const dataset={...state.datasets[0],name:'원본 정책 검증',rows:[{id:'source-case',input:'  BLOCK_MARKER를 포함한 요청\n',expected:'block',expectedStage:'pre',expectedRuleId:'source-ban',category:'금지 문구',note:'지정한 검사에서 차단되어야 합니다.'}]};
    state=(await f.action('save_dataset',{dataset})).state;
    const original=await f.action('run_evaluation',{workflowId:workflow.id,datasetId:dataset.id,target:'draft'});
    assert.equal(original.run.status,'completed');assert.equal(original.run.results[0].expectationMatched,true);
    const originalDataset=JSON.stringify(original.state.datasets.find(item=>item.id===dataset.id)),originalRun=JSON.stringify(original.run);
    const clone=await copiedWorkflow(f);state=(await f.call()).data.state;
    const unmapped=await f.call({action:'start_evaluation',workflowId:clone.id,datasetId:dataset.id,target:'draft'});
    assert.equal(unmapped.status,400);assert.equal(unmapped.data.error.code,'dataset_criteria_review_required');
    const targetId=clone.pre[0].rules[0].id;assert.notEqual(targetId,'source-ban');
    const mapped=await f.action('create_mapped_dataset',await mappedPayload(state,dataset.id,clone.id,'draft',{'source-ban':targetId}));
    const verified=await f.action('run_evaluation',{workflowId:clone.id,datasetId:mapped.dataset.id,target:'draft'});
    assert.equal(verified.run.status,'completed');assert.equal(verified.run.results[0].expectationMatched,true);assert.equal(verified.run.results[0].expectedRuleId,targetId);assert.equal(verified.run.preflight.issueCount,0);
    assert.equal(JSON.stringify(verified.state.datasets.find(item=>item.id===dataset.id)),originalDataset);
    assert.equal(JSON.stringify(verified.state.runs.find(item=>item.id===original.run.id)),originalRun);
  }finally{f.close();}
});

test('mapping rejects missing choices, unknown keys, protected keys, disabled rules and stage changes without altering sources',async()=>{
  const f=fixture();try{let state=(await f.call()).data.state;const sourceRule=state.workflows[0].pre[0].rules[0].id;state=await criterionDataset(f,sourceRule);let clone=await copiedWorkflow(f);state=(await f.call()).data.state;const source=state.datasets[0],count=state.datasets.length;
    for(const mappings of [{},{unknown:clone.pre[0].rules[0].id},{[sourceRule]:clone.post[0].rules[0].id},JSON.parse('{"__proto__":"invalid"}')]){const response=await f.call({action:'create_mapped_dataset',...await mappedPayload(state,source.id,clone.id,'draft',mappings)});assert.equal(response.status,400);}
    clone.pre[0].rules[0].enabled=false;state=(await f.action('save_workflow',{workflow:clone})).state;const response=await f.call({action:'create_mapped_dataset',...await mappedPayload(state,source.id,clone.id,'draft',{[sourceRule]:clone.pre[0].rules[0].id})});assert.equal(response.status,400);assert.equal(response.data.error.code,'invalid_dataset_mapping');assert.equal((await f.call()).data.state.datasets.length,count);assert.deepEqual((await f.call()).data.state.datasets.find(item=>item.id===source.id),source);
  }finally{f.close();}
});

test('mapping source or target edits invalidate the saved review and deployed targeting uses the published snapshot',async()=>{
  const f=fixture();try{let state=(await f.call()).data.state;const workflow=structuredClone(state.workflows[0]),sourceRule=workflow.pre[0].rules[0].id;state=await criterionDataset(f,sourceRule);await f.action('publish',{workflowId:workflow.id});state=(await f.call()).data.state;const source=state.datasets[0],review=await mappedPayload(state,source.id,workflow.id);
    source.rows[0].note='새 기준';state=(await f.action('save_dataset',{dataset:source})).state;let response=await f.call({action:'create_mapped_dataset',...review});assert.equal(response.status,409);assert.equal(response.data.error.code,'stale_dataset_mapping');
    const changedReview=await mappedPayload(state,source.id,workflow.id);workflow.pre[0].rules[0].id='current-draft-rule';state=(await f.action('save_workflow',{workflow})).state;response=await f.call({action:'create_mapped_dataset',...changedReview});assert.equal(response.status,409);
    const deployed=await f.action('create_mapped_dataset',await mappedPayload(state,source.id,workflow.id,'deployed'));assert.equal(deployed.dataset.rows[0].expectedRuleId,sourceRule);
  }finally{f.close();}
});

test('mapping is available to editors, forbidden to viewers and bounded atomically under concurrent creates',async()=>{
  const f=fixture({AEGIS_REQUIRE_ADMIN_IDENTITY:'true',AEGIS_ROLE_MAP:JSON.stringify({editor:'editor',viewer:'viewer'})});try{let state=(await f.call(undefined,'editor')).data.state;const dataset=state.datasets[0],workflow=state.workflows[0],payload=await mappedPayload(state,dataset.id,workflow.id);
    const viewer=await f.call({action:'create_mapped_dataset',...payload},'viewer');assert.equal(viewer.status,403);await f.action('create_mapped_dataset',payload,'editor');
    state=(await f.call(undefined,'editor')).data.state;for(let index=state.datasets.length;index<29;index++)await f.action('save_dataset',{dataset:{...dataset,id:`capacity-${index}`,name:`용량 검사 ${index}`}},'editor');
    const responses=await Promise.all(Array.from({length:10},()=>f.call({action:'create_mapped_dataset',...payload},'editor')));assert.equal(responses.filter(response=>response.status===200).length,1);assert.ok(responses.filter(response=>response.status!==200).every(response=>response.status===409&&response.data.error.code==='dataset_limit'));assert.equal((await f.call(undefined,'editor')).data.state.datasets.length,30);
  }finally{f.close();}
});

test('atomic mapping commit rejects source, draft and latest deployment changes occurring after fingerprint checks',async()=>{
  for(const race of ['source','workflow','deployment']){const f=fixture();try{let state=(await f.call()).data.state;const workflow=state.workflows[0],dataset=state.datasets[0];if(race==='deployment'){await f.action('publish',{workflowId:workflow.id});state=(await f.call()).data.state;}
    const payload=await mappedPayload(state,dataset.id,workflow.id,race==='deployment'?'deployed':'draft');const beforeCount=state.datasets.length;
    f.beforeInsert(()=>{if(race==='deployment'){const old=state.deployments[0],next={...old,id:'racing-deployment',version:old.version+1,createdAt:'2099-01-01T00:00:00.000Z'};f.sqlite.prepare('INSERT INTO aegis_deployments (id,workflow_id,alias,version,payload,created_at) VALUES (?,?,?,?,?,?)').run(next.id,next.workflowId,next.alias,next.version,JSON.stringify(next),next.createdAt);}else{const namespace=race==='source'?'dataset':'workflow',record=race==='source'?dataset:workflow;f.sqlite.prepare('UPDATE aegis_records SET payload=? WHERE namespace=? AND id=?').run(JSON.stringify({...record,description:'경합 중 변경'}),namespace,record.id);}});
    const response=await f.call({action:'create_mapped_dataset',...payload});assert.equal(response.status,409);assert.equal(response.data.error.code,'stale_dataset_mapping');assert.equal((await f.call()).data.state.datasets.length,beforeCount);
  }finally{f.close();}}
});
