import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {inspectionForNode,inspectionPortLabel,inspectionValueText,inspectionValueJson} from '../lib/node-inspection-view.ts';
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
test('administrator raw values preserve JSON types and rejected generations without changing legacy reference visibility',()=>{
  for(const value of [null,false,0,'',[],{}, {nested:[null,false,'😀']}]) {
    const detail={availability:'available',type:'json',summary:'실제 값',value} as const;
    assert.deepEqual(JSON.parse(inspectionValueJson(detail,inspection,{...result,status:'block',output:''})!),value);
  }
  const rejected={availability:'available',type:'text',summary:'생성 원문',value:'차단된 생성 답변'} as const;
  assert.equal(inspectionValueText(rejected,inspection,{...result,status:'block',output:''}),'차단된 생성 답변');
  assert.equal(inspectionValueJson(rejected,inspection,{...result,status:'block',output:''}),'"차단된 생성 답변"');
  assert.equal(inspectionValueJson({...rejected,availability:'withheld'},inspection,result),undefined);
});
test('truncated values never recover an unbounded full value from legacy source references',()=>{
  const detail={...shown,truncated:true,preview:'"짧은 일부',originalBytes:500_000};
  assert.equal(inspectionValueText(detail,inspection,result),'"짧은 일부');
  assert.equal(inspectionValueJson(detail,inspection,result),'"짧은 일부');
  assert.equal(inspectionValueJson({...detail,preview:undefined},inspection,result),undefined);
});
test('nested policy case labels use the owning rule even when local node IDs repeat',()=>{
  const workflow={pre:[{rules:[{id:'owner-a',kind:'policy',config:{policyRouting:{graph:{nodes:[{id:'switch',kind:'switch',cases:[{id:'one',value:'FIRST'}]}]}}}}]}],post:[{rules:[{id:'owner-b',kind:'policy',config:{policyRouting:{graph:{nodes:[{id:'switch',kind:'switch',cases:[{id:'one',value:'SECOND'}]}]}}}}]}]} as unknown as Workflow;
  assert.equal(inspectionPortLabel(workflow,'policy-node:owner-a/switch','one'),'"FIRST"');
  assert.equal(inspectionPortLabel(workflow,'policy-node:owner-b/switch','one'),'"SECOND"');
  assert.equal(inspectionPortLabel(workflow,'policy-node:owner-b/switch','one',true),'one');
});
