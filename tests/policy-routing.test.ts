import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { bindPolicyRevision, changePolicyRouteAction, policyDefinitionErrors, policyOutputSchema, policyRoutingErrors } from '../lib/policy-routing.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { configurationFingerprint, datasetFingerprint, matchesExpectation, workflowChanges } from '../lib/workflow-review.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { isRecoverableWorkflow, readWorkflowRecovery, saveWorkflowRecovery } from '../lib/workflow-recovery.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { datasetErrors, datasetToCsv, datasetToJson, parseDatasetFile } from '../lib/dataset-io.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { inspectDatasetCompatibility } from '../lib/dataset-compatibility.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { executeWorkflow } from '../lib/aegis-engine.ts';
import type { ExecutionResult, PolicyRevision } from '../lib/aegis-types';

function policy(): PolicyRevision {
  return { id:'policy-support',name:'문의 분류',description:'설명',prompt:'판정 기준에 따라 분류하세요.',connectionId:'conn-guard',version:1,updatedAt:'2026-10-26T00:00:00Z',connectionSnapshot:{...initialState().connections.find(item=>item.role!=='main')!,id:'conn-guard'},
    decisions:[{code:'IN_SCOPE',label:'일반 문의',description:'안내 범위의 질문'},{code:'OUT_OF_SCOPE',label:'범위 밖',description:'서비스와 관련 없는 질문'},{code:'PII_RESTRICTED',label:'개인정보 제한',description:'제한된 개인정보 요청'}],
    examples:[{id:'example-1',input:'배송 기간은?',expectedDecision:'IN_SCOPE'}] };
}

test('policy schema derives an exact enum and rejects extra output fields',()=>{
  assert.deepEqual(policyOutputSchema(policy()),{type:'object',properties:{decision:{type:'string',enum:['IN_SCOPE','OUT_OF_SCOPE','PII_RESTRICTED']}},required:['decision'],additionalProperties:false});
});
test('bound revisions are independent snapshots with explicit main, respond and error defaults',()=>{
  const original=policy(), bound=bindPolicyRevision(original);
  assert.deepEqual(bound.routes.map(item=>item.action),['main','respond','error']);
  assert.equal(bound.routes[2].errorCode,'PII_RESTRICTED');
  assert.deepEqual(policyRoutingErrors(bound),[]);
  original.prompt='changed';original.connectionSnapshot.model='changed';
  assert.notEqual(bound.policy.prompt,original.prompt);assert.notEqual(bound.policy.connectionSnapshot.model,original.connectionSnapshot.model);
  const next=policy();next.version=2;next.decisions[1].code='OTHER';
  assert.equal(bindPolicyRevision(next,bound.routes).routes[1].action,'error');
});
test('changing route actions removes fields from the previous action',()=>{
  const route=bindPolicyRevision(policy()).routes[1];
  assert.deepEqual(changePolicyRouteAction(route,'main'),{decision:'OUT_OF_SCOPE',action:'main'});
  const error=changePolicyRouteAction(route,'error');assert.equal(Object.hasOwn(error,'responseText'),false);assert.equal(error.errorCode,'OUT_OF_SCOPE');
  const response=changePolicyRouteAction(error,'respond');assert.equal(Object.hasOwn(response,'errorCode'),false);assert.equal(Object.hasOwn(response,'errorMessage'),false);assert.equal(response.responseText,'');
});
test('policy editor detects code, example, route and public message errors',()=>{
  const original=policy();original.decisions[1].code='IN_SCOPE';original.examples[0].expectedDecision='UNKNOWN';
  assert.ok(policyDefinitionErrors(original).some(item=>item.includes('중복')));assert.ok(policyDefinitionErrors(original).some(item=>item.includes('예상 판정')));
  const bound=bindPolicyRevision(policy());bound.routes.pop();
  assert.ok(policyRoutingErrors(bound).some(item=>item.includes('실행 경로')));
  const missing=bindPolicyRevision(policy());missing.routes[1].responseText='';missing.routes[2].errorMessage='';
  assert.ok(policyRoutingErrors(missing).some(item=>item.includes('안내 응답')));assert.ok(policyRoutingErrors(missing).some(item=>item.includes('공개 오류 메시지')));
});
test('policy evidence pins semantics while ignoring policy revision metadata and unused route fields',async()=>{
  const state=initialState(),workflow=structuredClone(state.workflows[0]);workflow.pre=[];workflow.post=[];workflow.policyRouting=bindPolicyRevision(policy());
  const before=structuredClone(workflow), fingerprint=await configurationFingerprint(workflow,state.connections);
  workflow.policyRouting.policy.name='새 이름';workflow.policyRouting.policy.description='새 설명';workflow.policyRouting.policy.version=8;workflow.policyRouting.policy.updatedAt='2099-01-01';workflow.policyRouting.policy.connectionSnapshot.name='서버 표시 이름';workflow.policyRouting.routes[0].errorMessage='사용하지 않는 설정';
  assert.equal(await configurationFingerprint(workflow,state.connections),fingerprint);assert.deepEqual(workflowChanges(workflow,before,state.connections,state.connections),[]);
  workflow.policyRouting.policy.examples[0].input='다른 예제';assert.notEqual(await configurationFingerprint(workflow,state.connections),fingerprint);
  const changed=structuredClone(before);changed.policyRouting!.routes[1].responseText='다른 안내문';
  assert.notEqual(await configurationFingerprint(changed,state.connections),fingerprint);assert.ok(workflowChanges(changed,before).some(item=>item.label==='정책 분기 변경'));
  const liveConnections=structuredClone(state.connections);liveConnections.push({...policy().connectionSnapshot,model:'edited-live-model'});
  assert.equal(await configurationFingerprint(before,liveConnections),fingerprint);
});
test('policy-bound drafts survive browser recovery and reject unknown snapshot payloads',()=>{
  const workflow=structuredClone(initialState().workflows[0]);workflow.policyRouting=bindPolicyRevision(policy());
  const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
  assert.equal(isRecoverableWorkflow(workflow),true);assert.equal(saveWorkflowRecovery(storage,workflow,workflow,'2026-10-26T00:00:00Z').ok,true);
  assert.deepEqual(readWorkflowRecovery(storage).records[0].draft.policyRouting,workflow.policyRouting);
  assert.equal(isRecoverableWorkflow({...workflow,policyRouting:{...workflow.policyRouting,rawOutput:'untrusted'}}),false);
});
test('dataset criteria check actual decision, selected route and public error code',async()=>{
  const row={id:'row',input:'example',expected:'block' as const,expectedDecision:'PII_RESTRICTED',expectedRoute:'error' as const,expectedPolicyCode:'PII_RESTRICTED'};
  const result:ExecutionResult={id:'result',status:'block',stage:'pre',output:'',reason:'limited',latencyMs:1,traces:[],policyDecision:'PII_RESTRICTED',policyRoute:'error',policyCode:'PII_RESTRICTED'};
  assert.equal(matchesExpectation(row,result),true);assert.equal(matchesExpectation(row,{...result,policyDecision:'OUT_OF_SCOPE'}),false);assert.equal(matchesExpectation(row,{...result,policyRoute:'main'}),false);assert.equal(matchesExpectation(row,{...result,policyCode:'OTHER'}),false);
  const dataset={id:'d',name:'cases',description:'',rows:[row]},fingerprint=await datasetFingerprint(dataset);
  assert.notEqual(await datasetFingerprint({...dataset,rows:[{...row,expectedDecision:'IN_SCOPE'}]}),fingerprint);
  for (const [source,file] of [[datasetToJson(dataset),'policy.json'],[datasetToCsv(dataset),'policy.csv']]) {
    const actual=parseDatasetFile(source,file).rows[0];assert.equal(actual.expectedDecision,row.expectedDecision);assert.equal(actual.expectedRoute,row.expectedRoute);assert.equal(actual.expectedPolicyCode,row.expectedPolicyCode);
  }
  assert.ok(datasetErrors({...dataset,rows:[{...row,expectedDecision:'not valid'}]}).length>0);
});
test('legacy Sites engine refuses policy-bound execution rather than skipping the policy',async()=>{
  const state=initialState(),workflow=structuredClone(state.workflows[0]);workflow.policyRouting=bindPolicyRevision(policy());
  const result=await executeWorkflow(workflow,state.connections,state.ingress,{},[{role:'user',content:'배송 기간은?'}]);
  assert.equal(result.status,'error');assert.equal(result.output,'');assert.match(result.reason,/Python/);assert.deepEqual(result.traces,[]);
});

test('policy preflight warns about missing binding or decision and inconsistent routes or codes',()=>{
  const workflow=structuredClone(initialState().workflows[0]);workflow.policyRouting=bindPolicyRevision(policy());
  const dataset={id:'d',name:'policy criteria',description:'',rows:[{id:'row',input:'test',expected:'allow' as const,expectedDecision:'IN_SCOPE',expectedRoute:'main' as const}]};
  assert.deepEqual(inspectDatasetCompatibility(dataset,workflow).issues,[]);
  const absent=structuredClone(workflow);delete absent.policyRouting;
  assert.deepEqual(inspectDatasetCompatibility(dataset,absent).issues.map(item=>item.code),['missing_policy']);
  const unknown={...dataset,rows:[{...dataset.rows[0],expectedDecision:'UNKNOWN'}]};
  assert.deepEqual(inspectDatasetCompatibility(unknown,workflow).issues.map(item=>item.code),['missing_policy_decision']);
  const mismatched={...dataset,rows:[{...dataset.rows[0],expectedDecision:'OUT_OF_SCOPE'}]};
  assert.deepEqual(inspectDatasetCompatibility(mismatched,workflow).issues.map(item=>item.code),['policy_route_mismatch']);
  const wrongCode={...dataset,rows:[{...dataset.rows[0],expectedDecision:'PII_RESTRICTED',expectedRoute:'error' as const,expectedPolicyCode:'OTHER'}]};
  const result=inspectDatasetCompatibility(wrongCode,workflow);
  assert.deepEqual(result.issues.map(item=>item.code),['policy_code_mismatch']);assert.equal(result.requiresAcknowledgement,true);assert.deepEqual(result.affectedRowIds,['row']);
});

test('policy traces cannot satisfy an identically named detector expectation',()=>{
  const result:ExecutionResult={id:'collision',status:'block',stage:'pre',output:'',reason:'',latencyMs:1,traces:[
    {ruleId:'policy',ruleName:'실제 검사',groupId:'real',stage:'pre',status:'allow',reason:'',latencyMs:0},
    {ruleId:'policy',ruleName:'정책 판정',groupId:'policy',stage:'pre',status:'block',reason:'',latencyMs:0,traceType:'policy'},
  ],policyDecision:'PII_RESTRICTED',policyRoute:'error',policyCode:'PII_RESTRICTED'};
  assert.equal(matchesExpectation({expected:'block',expectedRuleId:'policy'},result),false);
  assert.equal(matchesExpectation({expected:'block',expectedDecision:'PII_RESTRICTED',expectedRoute:'error'},result),true);
  result.traces[0].status='block';
  assert.equal(matchesExpectation({expected:'block',expectedRuleId:'policy'},result),true);
});
