import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {initialState} from '../lib/aegis-seed.ts';
import * as recovery from '../lib/workflow-recovery.ts';
import {evaluationContextForRun} from '../lib/evaluation-navigation.ts';
import {validateWorkflowGraph} from '../lib/workflow-graph.ts';

const source=await readFile(new URL('../app/page.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('app/page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='AegisConsole');
const names=['persistWorkingDraft','holdCurrentDraft','edit','save','openEvaluation','backToList','navigate','showWorkingDraft','selectWorkflow','discardRecovery','restoreRecovery','openServerAfterRecovery','openExecution','returnToEvaluation','evaluateCurrentWorkflow','reviewVerificationStarted','resumeDeploymentReview','closeDeploymentReview'];
const chunks=names.map(name=>{const statement=component.body.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>declaration.name.getText(tree)===name));assert.ok(statement,`actual ${name} declaration`);return statement.getText(tree);});
const code=ts.transpileModule(chunks.join('\n')+'\nglobalThis.reviewActions={'+names.join(',')+'};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function memory(){return{data:new Map(),deny:false,getItem(key){return this.data.get(key)??null;},setItem(key,value){if(this.deny)throw Error('quota');this.data.set(key,value);},removeItem(key){if(this.deny)throw Error('quota');this.data.delete(key);}};}
function fixture(){
 const app=structuredClone(initialState()),first=app.workflows[0],second={...structuredClone(first),id:'second',name:'두 번째',alias:'second'};app.workflows=[first,second];app.role='admin';
 const storage=memory(),notices=[];
 const state={...recovery,evaluationContextForRun,workflowSaveErrors:{},reviewWorkflowId:first.id,rollbackDeployment:undefined,reviewSuspended:false,reviewReturnNav:'workflows',reviewResumeBusy:false,reviewResumeError:'',validateWorkflowGraph,structuredClone,Map,Date,initialState,state:app,draft:structuredClone(first),dirty:false,nav:'workflows',workflowMode:'editor',loading:false,connected:true,drafts:{current:new Map([[first.id,{draft:structuredClone(first),base:structuredClone(first),dirty:false}]])},editorSessions:{current:new Map()},activeDraftId:{current:first.id},evaluationContext:{current:undefined},recoveries:[],recoveryError:'',evaluationOrigin:undefined,editorRevision:0,execution:undefined,recoveryStorage(){return storage;},notify(message){notices.push(message);},async act(payload){const saved=structuredClone(payload.workflow);state.state={...state.state,workflows:state.state.workflows.map(w=>w.id===saved.id?saved:w)};return{state:state.state};}};
 const pairs={setRecoveries:'recoveries',setRecoveryError:'recoveryError',setRecoveryNeedsRepair:'recoveryNeedsRepair',setDraft:'draft',setDirty:'dirty',setEvaluationInitialContext:'evaluationInitialContext',setReturnedFromEditor:'returnedFromEditor',setEvaluationVisit:'evaluationVisit',setNav:'nav',setWorkflowMode:'workflowMode',setSelectedRuleId:'selectedRuleId',setPendingRecovery:'pendingRecovery',setEvaluationOrigin:'evaluationOrigin',setExecution:'execution',setEditorRevision:'editorRevision',setSaveConflict:'saveConflict',setBusy:'busy',setState:'state',setWorkflowSaveErrors:'workflowSaveErrors',setReviewWorkflowId:'reviewWorkflowId',setRollbackDeployment:'rollbackDeployment',setReviewSuspended:'reviewSuspended',setReviewResumeBusy:'reviewResumeBusy',setReviewResumeError:'reviewResumeError'};
 for(const [setter,key]of Object.entries(pairs))state[setter]=value=>{state[key]=typeof value==='function'?value(state[key]):value;};
 const context=vm.createContext(state);vm.runInContext(code,context);
 return{state,actions:context.reviewActions,storage,notices,first,second};
}
test('result editing preserves dirty configuration and returning restores exact evaluation context', ()=>{
 const f=fixture();f.actions.edit({...f.state.draft,description:'저장하지 않은 편집'});
 const inputContext={tab:'batch',workflowId:f.first.id,datasetId:f.state.state.datasets[0].id,runId:'run',rowId:'row',resultFilter:'mismatch',categoryFilter:'A'};
 f.actions.openExecution(f.first.id,f.first.pre[0].rules[0].id,'request',{id:'result',traces:[]},'old-fingerprint',inputContext);
 assert.equal(f.state.draft.description,'저장하지 않은 편집');assert.equal(f.state.dirty,true);assert.equal(f.state.selectedRuleId,f.first.pre[0].rules[0].id);
 f.actions.returnToEvaluation();assert.equal(f.state.nav,'evaluation');assert.deepEqual(f.state.evaluationInitialContext,inputContext);
});

test('multiple workflows retain independent working drafts across screen changes', ()=>{
 const f=fixture();f.actions.edit({...f.state.draft,description:'first working'});f.actions.selectWorkflow(f.second.id);f.actions.edit({...f.state.draft,description:'second working'});f.actions.selectWorkflow(f.first.id);
 assert.equal(f.state.draft.description,'first working');assert.equal(f.state.drafts.current.get(f.second.id).draft.description,'second working');
 assert.equal(recovery.readWorkflowRecovery(f.storage).records.length,2);
});

test('storage failures retain working drafts in memory across navigation', ()=>{
 const f=fixture();f.storage.deny=true;f.actions.edit({...f.state.draft,description:'memory only'});f.actions.navigate('connections');
 assert.equal(f.state.drafts.current.get(f.first.id).draft.description,'memory only');assert.equal(f.state.nav,'connections');assert.ok(f.state.recoveryError);
 f.actions.selectWorkflow(f.second.id);f.actions.selectWorkflow(f.first.id);assert.equal(f.state.draft.description,'memory only');
});

test('recovery is explicit and viewer cannot restore editor content', ()=>{
 const f=fixture(),changed={...f.first,description:'local recovery'};f.state.recoveries=recovery.saveWorkflowRecovery(f.storage,changed,f.first).records;f.actions.selectWorkflow(f.first.id);assert.ok(f.state.pendingRecovery);assert.equal(f.state.draft.description,f.first.description);
 f.state.state.role='viewer';f.actions.restoreRecovery(f.state.pendingRecovery.record);assert.equal(f.state.draft.description,f.first.description);
});

test('save acknowledgement preserves edits made while the request was in flight', async ()=>{
 const f=fixture();f.actions.edit({...f.state.draft,description:'saved snapshot'});let complete;
 f.state.act=()=>new Promise(resolve=>{complete=resolve;});const saving=f.actions.save();
 f.actions.edit({...f.state.draft,description:'newer edit'});const server={...f.first,description:'saved snapshot'};complete({state:{...f.state.state,workflows:[server,f.second]}});await saving;
 assert.equal(f.state.draft.description,'newer edit');assert.equal(f.state.dirty,true);assert.equal(f.state.drafts.current.get(f.first.id).base.description,'saved snapshot');
});

test('an incomplete graph can leave the editor and return without a server save', async ()=>{
 const f=fixture();let saves=0;f.state.act=async()=>{saves++;return undefined;};
 const incomplete={...f.state.draft,graph:{version:1,pre:{nodes:[],edges:[]},post:{nodes:[],edges:[]}}};
 assert.ok(validateWorkflowGraph(incomplete).length);
 f.actions.edit(incomplete);await f.actions.backToList();
 assert.equal(saves,0);assert.equal(f.state.workflowMode,'list');
 f.actions.selectWorkflow(f.first.id);
 assert.deepEqual(f.state.draft.graph,incomplete.graph);assert.equal(f.state.dirty,true);
 assert.deepEqual(recovery.readWorkflowRecovery(f.storage).records[0].draft.graph,incomplete.graph);
});

test('full validation saves the edited draft and stages a fresh run without changing its origin', async ()=>{
 const f=fixture();const origin={tab:'compare',workflowId:f.first.id,datasetId:f.state.state.datasets[0].id,target:'deployed',input:'원래 요청',lastInput:'원래 요청',singleFingerprint:'original',runId:'original-run',rowId:'selected-row',resultFilter:'mismatch',categoryFilter:'정책',changedOnly:true,showSnapshot:true,scrollTop:800};
 f.state.evaluationOrigin={workflowId:f.first.id,context:origin,label:'원래 기록'};
 f.actions.edit({...f.state.draft,description:'전체 검증할 수정본'});await f.actions.evaluateCurrentWorkflow();
 assert.equal(f.state.dirty,false);assert.equal(f.state.evaluationInitialContext.tab,'batch');
 assert.equal(f.state.evaluationInitialContext.target,'draft');assert.equal(f.state.evaluationInitialContext.datasetId,origin.datasetId);
 assert.equal(f.state.evaluationInitialContext.runId,'');assert.equal(f.state.evaluationInitialContext.rowId,'');
 assert.equal(f.state.evaluationInitialContext.scrollTop,0);assert.equal(origin.runId,'original-run');assert.equal(origin.rowId,'selected-row');
});


test('direct release policy saves refresh a clean draft baseline before the next edit',async()=>{
 const f=fixture();const server={...structuredClone(f.first),updatedAt:'2099-01-01T00:00:00.000Z',releasePolicy:{requireVerification:true,requiredDatasetIds:[]}};
 const statement=component.body.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>declaration.name.getText(tree)==='act'));
 const actualAct=ts.transpileModule(statement.getText(tree)+';globalThis.realAct=act;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 f.state.fetch=async()=>Response.json({state:{...f.state.state,workflows:[server,f.second]}});
 vm.runInContext(actualAct,vm.createContext(f.state));
 await f.state.realAct({action:'save_workflow',workflow:server,expectedUpdatedAt:f.first.updatedAt});
 assert.deepEqual(f.state.draft.releasePolicy,server.releasePolicy);
 assert.equal(f.state.drafts.current.get(f.first.id).base.updatedAt,server.updatedAt);
 f.actions.edit({...f.state.draft,description:'policy saved then edited'});
 let payload;f.state.fetch=async(_url,options)=>{payload=JSON.parse(options.body);return Response.json({state:{...f.state.state,workflows:[{...server,...payload.workflow},f.second]}});};
 await f.actions.save();assert.equal(payload.expectedUpdatedAt,server.updatedAt);
});

test('release review navigation uses the returned historical run and refreshes state before resuming',async()=>{
 const f=fixture(),run={id:'exact-review-run',workflowId:f.first.id,datasetId:f.state.state.datasets[0].id,target:'deployed',deploymentId:'historic-deployment',results:[]};
 f.state.reviewReturnNav='gateway';f.actions.reviewVerificationStarted(run);
 assert.equal(f.state.reviewSuspended,true);assert.equal(f.state.nav,'evaluation');assert.equal(f.state.evaluationInitialContext.runId,run.id);assert.equal(f.state.evaluationInitialContext.deploymentId,'historic-deployment');
 let refreshes=0;f.state.fetch=async(url,options)=>{refreshes++;assert.equal(url,'/api/console');assert.equal(options.cache,'no-store');return{ok:true,json:async()=>({state:{...f.state.state,runs:[{...run,status:'completed'}]}})};};
 await f.actions.resumeDeploymentReview();assert.equal(refreshes,1);assert.equal(f.state.reviewSuspended,false);assert.equal(f.state.nav,'gateway');assert.equal(f.state.reviewWorkflowId,f.first.id);assert.equal(f.state.state.runs[0].status,'completed');
});

test('failed review refresh keeps the suspended review and provides a persistent retry reason',async()=>{
 const f=fixture();f.state.reviewSuspended=true;f.state.nav='evaluation';f.state.fetch=async()=>({ok:false});
 await f.actions.resumeDeploymentReview();assert.equal(f.state.reviewSuspended,true);assert.equal(f.state.nav,'evaluation');assert.match(f.state.reviewResumeError,/다시 읽지 못했습니다/);assert.equal(f.state.reviewResumeBusy,false);
});

test('workflow save failures persist by workflow while edits remain intact and a later success clears the reason',async()=>{
 const f=fixture();f.actions.edit({...f.state.draft,description:'보호할 입력'});
 const statement=component.body.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>declaration.name.getText(tree)==='act'));
 const actualAct=ts.transpileModule(statement.getText(tree)+';globalThis.realAct=act;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 f.state.fetch=async()=>({ok:false,json:async()=>({error:{code:'invalid_request',message:'정책 조건을 다시 확인하세요.'}})});
 vm.runInContext(actualAct,vm.createContext(f.state));
 await f.state.realAct({action:'save_workflow',workflow:f.state.draft});assert.equal(f.state.workflowSaveErrors[f.first.id],'정책 조건을 다시 확인하세요.');assert.equal(f.state.draft.description,'보호할 입력');assert.equal(f.state.dirty,true);
 f.state.fetch=async()=>({ok:true,json:async()=>({state:f.state.state})});await f.state.realAct({action:'save_workflow',workflow:f.state.draft});assert.equal(f.state.workflowSaveErrors[f.first.id],'');
});
