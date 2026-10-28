import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { initialState } from '../lib/aegis-seed.ts';
import { executionConfiguration, referencedConnections } from '../lib/workflow-review.ts';

// Exercise the production handlers without a browser or a duplicated implementation.
const source=await readFile(new URL('../components/evaluation-page.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('evaluation-page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='EvaluationPage');
const names=['start','keepRun','captureContext','latestRun','selectDataset','editDatasetCriteria','selectMappedDataset'];
const functions=names.map(name=>{
  const node=component.body.statements.find(item=>ts.isFunctionDeclaration(item)&&item.name?.text===name);
  assert.ok(node,`Production ${name} exists`);return node.getText(tree);
});
const derivedNames=['preflight','preflightError','preflightChecking','criteriaAcknowledged','criteriaReady'];
const derived=derivedNames.map(name=>{
  const node=component.body.statements.find(item=>ts.isVariableStatement(item)&&item.declarationList.declarations.some(declaration=>declaration.name.getText(tree)===name));
  assert.ok(node,`Production ${name} exists`);return node.getText(tree);
});
const keyExpression=component.body.statements.filter(ts.isVariableStatement).flatMap(node=>node.declarationList.declarations).find(node=>node.name.getText(tree)==='preflightKey').initializer.getText(tree);
const effect=component.body.statements.filter(node=>ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&node.expression.expression.getText(tree)==='useEffect').map(node=>node.expression.arguments[0]).find(node=>node.getText(tree).includes('setCriteriaAcknowledgement(undefined);setStartError'));
assert.ok(effect,'Production asynchronous preflight effect exists');
const workerAvailability=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='evaluationWorkerAvailable').getText(tree);
const compiled=ts.transpileModule(workerAvailability+'\n'+functions.join('\n')+'\nfunction readiness(){'+derived.join('\n')+';return{'+derivedNames.join(',')+'};}\nglobalThis.actions={'+names.join(',')+'};globalThis.readiness=readiness;globalThis.contextKey=()=>'+keyExpression+';globalThis.preflightEffect='+effect.getText(tree)+';',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const fingerprint='a'.repeat(64),newFingerprint='b'.repeat(64);
function fixture(options={}){
  const proof={fingerprint,requiresAcknowledgement:true,issues:[{rowId:'row',rowNumber:1,sideKey:'candidate',sideLabel:'현재 초안',code:'missing_rule',severity:'warning',message:'예상 검사를 확인하세요.'}],sideFingerprints:[],datasetFingerprint:'c'.repeat(64)};
  const previousRun={id:'previous-run',status:'completed',results:[{rowId:'previous-row',status:'block'}]};
  const requests=[],driven=[],edits=[],reported=[];
  const state={
    executionConfiguration,referencedConnections,
    workflow:{id:'workflow'},candidateWorkflow:{id:'workflow'},dataset:{id:'dataset',rows:[]},workflowId:'workflow',datasetId:'dataset',workerStatus:{available:false},tab:'batch',target:'draft',exactDeploymentId:'',deployment:{id:'latest-deployment'},deployed:true,readOnly:false,busy:false,
    preflightKey:'current-key',preflightState:{key:'current-key',result:proof},criteriaAcknowledgement:undefined,preflightSides:[{key:'candidate'}],
    mounted:{current:true},runId:previousRun.id,localRun:previousRun,rowId:'previous-row',resultFilter:'mismatch',categoryFilter:'정책',startError:'',controlBusy:'',returnNotice:true,
    availableRuns:[previousRun],navigationContext:{tab:'batch',runId:previousRun.id,rowId:'previous-row',resultFilter:'mismatch',categoryFilter:'정책'},navigationScroll:{current:0},latestContext:{current:undefined},contextCallback:{current(value){reported.push(value);}},window:{scrollY:540},
    async evaluationPreflight(){return proof;},async act(payload){requests.push(structuredClone(payload));return{run:{id:'new-run',status:'running',results:[]}};},async drive(run){driven.push(run);},onManageDatasets(request){edits.push(request);},
    ...options,
  };
  const setters={setControlBusy:'controlBusy',setStartError:'startError',setPreflightState:'preflightState',setCriteriaAcknowledgement:'criteriaAcknowledgement',setRowId:'rowId',setResultFilter:'resultFilter',setCategoryFilter:'categoryFilter',setLocalRun:'localRun',setRunId:'runId',setReturnNotice:'returnNotice',setDatasetId:'datasetId'};
  for(const [setter,key] of Object.entries(setters))state[setter]=value=>{state[key]=typeof value==='function'?value(state[key]):value;};
  const context=vm.createContext(state);vm.runInContext(compiled,context);
  const refresh=()=>Object.assign(state,context.readiness());refresh();
  return{state,actions:context.actions,context,proof,previousRun,requests,driven,edits,reported,refresh};
}

test('missing or unacknowledged preflight cannot start a job',async()=>{
  for(const patch of [{preflightState:undefined},{preflightState:{key:'old-key',result:{fingerprint,requiresAcknowledgement:false}}},{}]){
    const f=fixture(patch);assert.equal(f.state.criteriaReady,false);await f.actions.start();assert.equal(f.requests.length,0);assert.equal(f.state.runId,'previous-run');
  }
});

test('an acknowledgement must match both the visible context key and fingerprint',async()=>{
  const f=fixture();
  for(const acknowledgement of [{key:'old-key',fingerprint,checked:true},{key:'current-key',fingerprint:newFingerprint,checked:true},{key:'current-key',fingerprint,checked:false}]){
    f.state.criteriaAcknowledgement=acknowledgement;f.refresh();assert.equal(f.state.criteriaReady,false);await f.actions.start();
  }
  assert.equal(f.requests.length,0);
  f.state.criteriaAcknowledgement={key:'current-key',fingerprint,checked:true};f.refresh();assert.equal(f.state.criteriaReady,true);
});

test('starting a reviewed comparison sends the exact proof and starts only its returned job',async()=>{
  const f=fixture({tab:'compare',target:'deployed'});f.state.criteriaAcknowledgement={key:'current-key',fingerprint,checked:true};f.refresh();
  await f.actions.start();assert.equal(f.requests.length,1);
  assert.deepEqual(f.requests[0],{action:'start_evaluation',workflowId:'workflow',datasetId:'dataset',target:'draft',compare:true,executionMode:'manual',preflightFingerprint:fingerprint,acknowledgeCriteria:true});
  assert.equal(f.driven.length,1);assert.equal(f.driven[0].id,'new-run');assert.equal(f.state.runId,'new-run');assert.equal(f.state.rowId,'');assert.equal(f.state.resultFilter,'all');assert.equal(f.state.controlBusy,'');
});

test('a clean dataset needs no warning acknowledgement but still sends its fresh proof',async()=>{
  const f=fixture();f.proof.requiresAcknowledgement=false;f.proof.issues=[];f.refresh();assert.equal(f.state.criteriaReady,true);
  await f.actions.start();assert.equal(f.requests[0].preflightFingerprint,fingerprint);assert.equal(f.requests[0].acknowledgeCriteria,false);
});

test('historical review verification repeats the exact selected deployment and refuses a missing target',async()=>{
  const f=fixture({target:'deployed',exactDeploymentId:'historic-deployment',deployment:{id:'historic-deployment'}});
  f.proof.requiresAcknowledgement=false;f.refresh();await f.actions.start();
  assert.equal(f.requests[0].deploymentId,'historic-deployment');assert.equal(f.requests[0].target,'deployed');
  const missing=fixture({target:'deployed',exactDeploymentId:'deleted-deployment',deployment:undefined});
  missing.proof.requiresAcknowledgement=false;missing.refresh();await missing.actions.start();assert.equal(missing.requests.length,0);
});

test('changed proof during the final check clears acknowledgement without creating a job',async()=>{
  const f=fixture();f.state.criteriaAcknowledgement={key:'current-key',fingerprint,checked:true};f.refresh();
  f.state.evaluationPreflight=async()=>({...f.proof,fingerprint:newFingerprint});await f.actions.start();
  assert.equal(f.requests.length,0);assert.equal(f.state.criteriaAcknowledgement,undefined);assert.equal(f.state.preflightState.result.fingerprint,newFingerprint);assert.ok(f.state.startError);assert.equal(f.state.runId,'previous-run');assert.equal(f.state.resultFilter,'mismatch');
});

test('failed job creation preserves the original run, selected row and filters',async()=>{
  const f=fixture();f.state.criteriaAcknowledgement={key:'current-key',fingerprint,checked:true};f.refresh();const previous=JSON.stringify(f.previousRun);
  f.state.act=async payload=>{f.requests.push(payload);return undefined;};await f.actions.start();
  assert.equal(f.requests.length,1);assert.equal(f.driven.length,0);assert.equal(f.state.runId,'previous-run');assert.equal(f.state.rowId,'previous-row');assert.equal(f.state.resultFilter,'mismatch');assert.equal(f.state.categoryFilter,'정책');assert.equal(JSON.stringify(f.previousRun),previous);assert.ok(f.state.startError);assert.equal(f.state.controlBusy,'');
});

test('readonly, an active operation and a missing comparison deployment block starting',async()=>{
  for(const patch of [{readOnly:true},{busy:true},{tab:'compare',deployed:false}]){
    const f=fixture(patch);f.state.criteriaAcknowledgement={key:'current-key',fingerprint,checked:true};f.refresh();await f.actions.start();assert.equal(f.requests.length,0);
  }
  const f=fixture();f.state.criteriaAcknowledgement={key:'current-key',fingerprint,checked:true};f.refresh();f.state.evaluationPreflight=async()=>{f.state.mounted.current=false;return f.proof;};await f.actions.start();assert.equal(f.requests.length,0);
});

test('editing a comparison criterion preserves its return context and opens the draft row',()=>{
  const f=fixture({tab:'compare',target:'deployed'});f.actions.editDatasetCriteria('criterion-row');
  assert.deepEqual(JSON.parse(JSON.stringify(f.edits[0])),{datasetId:'dataset',rowId:'criterion-row',workflowId:'workflow',target:'draft'});
  assert.equal(f.reported.length,1);assert.equal(f.reported[0].runId,'previous-run');assert.equal(f.reported[0].rowId,'previous-row');assert.equal(f.reported[0].scrollTop,540);assert.equal(f.requests.length,0);
});

test('selecting a mapped dataset resets review without starting or rewriting the original run',()=>{
  const f=fixture();const previous=JSON.stringify(f.previousRun);f.state.criteriaAcknowledgement={key:'current-key',fingerprint,checked:true};f.actions.selectMappedDataset('mapped-dataset');
  assert.equal(f.state.datasetId,'mapped-dataset');assert.equal(f.state.criteriaAcknowledgement,undefined);assert.equal(f.state.rowId,'');assert.equal(f.state.resultFilter,'all');assert.equal(f.state.categoryFilter,'all');assert.equal(f.requests.length,0);assert.equal(f.driven.length,0);assert.equal(JSON.stringify(f.previousRun),previous);
});

test('superseded asynchronous checks cannot replace a newer preflight result',async()=>{
  const f=fixture();const resolvers=[];f.state.evaluationPreflight=()=>new Promise(resolve=>resolvers.push(resolve));
  const stopOld=f.context.preflightEffect();assert.equal(f.state.criteriaAcknowledgement,undefined);stopOld();f.state.preflightKey='new-key';const stopNew=f.context.preflightEffect();
  resolvers[0]({...f.proof,fingerprint});resolvers[1]({...f.proof,fingerprint:newFingerprint});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state.preflightState.key,'new-key');assert.equal(f.state.preflightState.result.fingerprint,newFingerprint);assert.equal(f.requests.length,0);stopNew();
});

test('visual layout, clone hints and save timestamps do not reset a reviewed execution context',()=>{
  const app=initialState(),f=fixture();f.state.dataset=structuredClone(app.datasets[0]);f.state.preflightSides=[{key:'candidate',label:'현재 초안',workflow:structuredClone(app.workflows[0]),connections:structuredClone(app.connections)}];
  const before=f.context.contextKey();f.state.dataset.updatedAt='2099-01-01T00:00:00.000Z';
  const workflow=f.state.preflightSides[0].workflow;workflow.updatedAt='2099-01-01T00:00:00.000Z';workflow.layout={version:1,positions:{input:{x:200,y:400}},zones:[]};workflow.cloneSource={workflowId:'old-source',ruleIds:{'old-rule':workflow.pre[0].rules[0].id}};
  f.state.preflightSides[0].connections.push({...app.connections[0],id:'unrelated-connection',model:'unrelated'});assert.equal(f.context.contextKey(),before);
  workflow.pre[0].rules[0].config.pattern='검증 기준에 영향을 주는 변경';assert.notEqual(f.context.contextKey(),before);
});
