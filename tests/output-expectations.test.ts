import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node source runner.
import {assertionDraftErrors,fieldAssertionErrors,policyExpectationErrors} from '../lib/output-expectations.ts';
// @ts-expect-error Node source runner.
import {datasetToCsv,datasetToJson,parseDatasetFile} from '../lib/dataset-io.ts';
// @ts-expect-error Node source runner.
import {policyEditorBuffers,preparePolicyDraft,policyEditorSignature,createStructuredPolicy} from '../components/policy-editor-model.ts';
// @ts-expect-error Node source runner.
import {initialState} from '../lib/aegis-seed.ts';
// @ts-expect-error Node source runner.
import {isRecoverableWorkflow} from '../lib/workflow-recovery.ts';

test('typed assertions reject missing values, numeric booleans, invalid pointers and overflow',()=>{
  assert.deepEqual(fieldAssertionErrors([{path:'/score',operator:'gte',value:80}]),[]);
  for(const field of [{path:'/score',operator:'gte',value:true},{path:'/x~2',operator:'eq',value:0},{path:'/score',operator:'eq'},{path:'/score',operator:'eq',value:Infinity}])assert.ok(fieldAssertionErrors([field]).length);
  assert.ok(policyExpectationErrors({id:'one',input:'test',expectation:{mode:'fields',fields:[]}}).length);
});
test('unfinished assertion JSON participates in dirty state and blocks prepared policy rather than using a previous value',()=>{
  let n=0;const policy=createStructuredPolicy('guard',(prefix:string)=>`${prefix}-${++n}`),buffers=policyEditorBuffers(policy);
  policy.examples[0].expectation={mode:'fields',fields:[{path:'/risk/score',operator:'gte',value:80}]};
  const before=policyEditorSignature(policy,buffers);buffers.fieldValues={[policy.examples[0].id]:{'0':'-'}};
  assert.notEqual(policyEditorSignature(policy,buffers),before);
  assert.ok(preparePolicyDraft(policy,buffers).errors.some(error=>error.includes('비교값')));
  assert.ok(assertionDraftErrors(policy.examples[0].expectation.fields!,{'0':'1e400'}).length);
});
test('dataset JSON and CSV round trips preserve arbitrary field criteria and their types',()=>{
  const dataset={name:'필드 검증',description:'',rows:[{id:'one',input:'request',expected:'block' as const,expectedPolicyFields:[{path:'/risk/score',operator:'gte' as const,value:80},{path:'/nullable',operator:'eq' as const,value:null}]}]};
  for(const [format,source]of [['json',datasetToJson(dataset)],['csv',datasetToCsv(dataset)]]){
    const parsed=parseDatasetFile(source,`test.${format}`);
    assert.deepEqual(parsed.rows[0].expectedPolicyFields,dataset.rows[0].expectedPolicyFields);
  }
});
test('workflow draft recovery accepts registered policies with new comparison modes',()=>{
  const state=initialState();let n=0;const policy=createStructuredPolicy(state.connections[1].id,(prefix:string)=>`${prefix}-${++n}`);
  policy.examples[0].expectation={mode:'fields',fields:[{path:'/risk/score',operator:'gte',value:80}]};
  const workflow={...state.workflows[0],policyRouting:{policy:{...policy,connectionSnapshot:state.connections[1],version:1,updatedAt:'2026-10-28T00:00:00Z'},routes:[],graph:{version:1,entryNodeId:'',nodes:[],edges:[]}}};
  assert.equal(isRecoverableWorkflow(workflow),true);
});
