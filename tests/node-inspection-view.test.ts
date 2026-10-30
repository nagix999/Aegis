import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {inspectionForNode,inspectionPortLabel,inspectionValueText} from '../lib/node-inspection-view.ts';
import type {ConsoleExecutionInspection,ConsoleNodeInspection,ExecutionResult,Workflow} from '../lib/aegis-types';

const hidden={availability:'withheld',type:'text',summary:'비공개'} as const;
const shown={availability:'available',type:'text',source:'final_response',summary:'허용 응답'} as const;
const node=(nodeId:string,stage:ConsoleNodeInspection['stage'],attempt?:number):ConsoleNodeInspection=>({nodeId,kind:'rule',stage,attempt,status:'completed',input:hidden,output:shown});
const result:ExecutionResult={id:'synthetic',status:'allow',stage:'complete',reason:'완료',output:'최종 허용 답변',latencyMs:1,traces:[{ruleId:'main',ruleName:'Main',groupId:'main',stage:'main',status:'allow',reason:'완료',latencyMs:1,attempt:2}]};
const inspection:ConsoleExecutionInspection={request:{messages:[{role:'user',content:'제출한 질문'}],inputScope:'last_user',inspectionText:'제출한 질문'},nodes:[node('rule:pre','pre'),node('main','main',1),node('main','main',2),node('rule:post','post',1),node('rule:post','post',2)]};

test('selecting a retry retains PRE observations and only the selected POST generation',()=>{
  assert.equal(inspectionForNode(inspection,'rule:pre',2).length,1);
  assert.deepEqual(inspectionForNode(inspection,'main',1).map(item=>item.attempt),[1]);
  assert.deepEqual(inspectionForNode(inspection,'rule:post',2).map(item=>item.attempt),[2]);
  assert.equal(inspectionForNode(undefined,'main').length,0);
});
test('withheld values are never resolved even if they carry a final-response source',()=>{
  assert.equal(inspectionValueText({...shown,availability:'withheld'},inspection,result),undefined);
  assert.equal(inspectionValueText({...shown,availability:'not_applicable'},inspection,result),undefined);
});
test('generated text is visible only for the allowed final generation',()=>{
  assert.equal(inspectionValueText(shown,inspection,result,node('main','main',2)),'최종 허용 답변');
  assert.equal(inspectionValueText(shown,inspection,result,node('main','main',1)),undefined);
  for(const status of ['block','error'] as const)assert.equal(inspectionValueText(shown,inspection,{...result,status,output:'노출 금지'}),undefined);
});
test('submitted conversation and inspection text are resolved without unrelated metadata',()=>{
  const conversation=inspectionValueText({...shown,source:'request_messages'},inspection,result);
  assert.deepEqual(JSON.parse(conversation!),inspection.request.messages);
  assert.equal(inspectionValueText({...shown,source:'request_inspection'},inspection,result),'제출한 질문');
  assert.equal(inspectionValueText({...shown,source:undefined},inspection,result),undefined);
});
test('older execution ports are not relabeled with a changed draft case value',()=>{
  const workflow={policyRouting:{graph:{nodes:[{id:'switch',kind:'switch',cases:[{id:'stable-case',value:'CHANGED_VALUE'},{id:'true',value:null}]}]}}} as unknown as Workflow;
  assert.equal(inspectionPortLabel(workflow,'policy-node:switch','stable-case'),'"CHANGED_VALUE"');
  assert.equal(inspectionPortLabel(workflow,'policy-node:switch','stable-case',true),'stable-case');
  assert.equal(inspectionPortLabel(workflow,'policy-node:switch','true',true),'true');
  assert.equal(inspectionPortLabel(workflow,'policy-node:switch','default',true),'기본 경로 (default)');
});
