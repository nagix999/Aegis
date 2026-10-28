import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {initialState} from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {isRecoverableWorkflow,readWorkflowRecovery,saveWorkflowRecovery} from '../lib/workflow-recovery.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {configurationFingerprint,workflowChanges} from '../lib/workflow-review.ts';

test('release criteria survive draft recovery without changing inference proof',async()=>{
  const state=initialState(),base=structuredClone(state.workflows[0]),workflow=structuredClone(base);
  workflow.releasePolicy={requireVerification:true,requiredDatasetIds:state.datasets.map(dataset=>dataset.id)};
  assert.equal(isRecoverableWorkflow(workflow),true);
  const records=new Map<string,string>(),storage={getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{records.set(key,value);},removeItem:(key:string)=>{records.delete(key);}};
  assert.equal(saveWorkflowRecovery(storage,workflow,base).ok,true);
  assert.deepEqual(readWorkflowRecovery(storage).records[0].draft.releasePolicy,workflow.releasePolicy);
  assert.equal(await configurationFingerprint(base,state.connections),await configurationFingerprint(workflow,state.connections));
  assert.ok(workflowChanges(workflow,base).some(change=>change.label==='배포 기준 변경'));
});
test('draft recovery rejects malformed release criteria instead of dropping protection',()=>{
  const workflow=initialState().workflows[0];
  for(const releasePolicy of [{requireVerification:'true',requiredDatasetIds:[]},{requireVerification:true,requiredDatasetIds:['same','same']},{requireVerification:true,requiredDatasetIds:['']},{requireVerification:true,requiredDatasetIds:[],extra:true},{requireVerification:true,requiredDatasetIds:Array.from({length:31},(_,index)=>`dataset-${index}`)}])assert.equal(isRecoverableWorkflow({...workflow,releasePolicy}),false);
});
