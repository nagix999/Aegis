import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node source tests require explicit TypeScript extensions.
import {initialState} from '../lib/aegis-seed.ts';
// @ts-expect-error Node source tests require explicit TypeScript extensions.
import {bindWorkflowPolicyNode,addWorkflowPolicyGraphNode,addConnectedWorkflowPolicyNode} from '../lib/workflow-policy-nodes.ts';
// @ts-expect-error Node source tests require explicit TypeScript extensions.
import {policyNodeInputIssues,ruleIssueField} from '../lib/workflow-input-guidance.ts';

function draft(){
 const state=initialState(),connection=state.connections.find(item=>item.role==='guard')!;
 return bindWorkflowPolicyNode(state.workflows[0],{id:'ux',version:1,name:'임의 출력',description:'',prompt:'입력을 분석하세요.',connectionId:connection.id,connectionSnapshot:connection,updatedAt:'2026-10-27T00:00:00Z',formatVersion:2,outputSchema:{type:'object',properties:{risk:{type:'number'}},additionalProperties:false},maxOutputTokens:1000,decisions:[],examples:[{id:'one',input:'예제',expectedOutput:{risk:1}}]},{emptyGraph:true});
}
test('empty policy draft gives setup guidance without mutating or inventing a decision field',()=>{
 const wf=draft(),before=structuredClone(wf),issues=policyNodeInputIssues(wf.policyRouting!);
 assert.equal(issues.length,1);assert.equal(issues[0].field,'entry');assert.deepEqual(wf,before);
});
test('guidance identifies each missing port and individual invalid predicate',()=>{
 let wf=addWorkflowPolicyGraphNode(draft(),'branch','risk').workflow;
 wf.policyRouting!.graph!.nodes[0]={id:'risk',kind:'branch',name:'위험 확인',condition:{mode:'all',predicates:[{path:'/risk',operator:'gte',value:undefined},{path:'bad',operator:'exists'}]}};
 const issues=policyNodeInputIssues(wf.policyRouting!);
 assert.ok(issues.some(i=>i.nodeId==='risk'&&i.field==='edge.true'));
 assert.ok(issues.some(i=>i.nodeId==='risk'&&i.field==='edge.false'));
 assert.ok(issues.some(i=>i.predicateIndex===0&&i.field==='value'));
 assert.ok(issues.some(i=>i.predicateIndex===1&&i.field==='path'));
});
test('action guidance locates message and code fields while accepting deliberately configured errors',()=>{
 let wf=addWorkflowPolicyGraphNode(draft(),'branch','condition').workflow;
 wf=addConnectedWorkflowPolicyNode(wf,'condition','true','action','error').workflow;
 const action=wf.policyRouting!.graph!.nodes.find(n=>n.id==='error')!;
 assert.equal(policyNodeInputIssues(wf.policyRouting!).some(i=>i.nodeId==='error'),false);
 if(action.kind==='action'){action.errorCode='bad';action.errorMessage='';}
 const issues=policyNodeInputIssues(wf.policyRouting!);
 assert.ok(issues.some(i=>i.nodeId==='error'&&i.field==='errorCode'));
 assert.ok(issues.some(i=>i.nodeId==='error'&&i.field==='errorMessage'));
});
test('explicit port creation replaces only that port and retains the former destination',()=>{
 let wf=addWorkflowPolicyGraphNode(draft(),'branch','condition').workflow;
 wf=addConnectedWorkflowPolicyNode(wf,'condition','true','action','old').workflow;
 const oldEdge=structuredClone(wf.policyRouting!.graph!.edges[0]),before=structuredClone(wf);
 const added=addConnectedWorkflowPolicyNode(wf,'condition','true','action','new');
 assert.deepEqual(wf,before);assert.equal(added.nodeId,'new');
 assert.deepEqual(added.workflow.policyRouting!.graph!.edges[0],{...oldEdge,to:'new'});
 assert.ok(added.workflow.policyRouting!.graph!.nodes.some(n=>n.id==='old'));
 assert.equal(added.workflow.policyRouting!.graph!.nodes.length,before.policyRouting!.graph!.nodes.length+1);
});
for(const name of ['missing-source','action-source','duplicate-id','capacity'] as const)test(`invalid atomic creation ${name} leaves no orphan`,()=>{
 let wf=addWorkflowPolicyGraphNode(draft(),'branch','condition').workflow;
 wf=addWorkflowPolicyGraphNode(wf,'action','action').workflow;
 if(name==='capacity')for(let i=2;i<24;i++)wf=addWorkflowPolicyGraphNode(wf,'action',`action-${i}`).workflow;
 const before=structuredClone(wf);
 assert.throws(()=>addConnectedWorkflowPolicyNode(wf,name==='missing-source'?'missing':name==='action-source'?'action':'condition','false','action',name==='duplicate-id'?'condition':'new'));
 assert.deepEqual(wf,before);
});
test('rule issue fields distinguish model, prompt, regular expression and JSON keys',()=>{
 const rule=initialState().workflows[0].pre[0].rules[0];
 assert.equal(ruleIssueField({...rule,kind:'regex'},'정규식 문법을 확인하세요.'),'pattern');
 assert.equal(ruleIssueField({...rule,kind:'llm'},'검사 모델로 사용할 모델 서버를 선택하세요.'),'connectionId');
 assert.equal(ruleIssueField({...rule,kind:'llm'},'검사 지시문을 입력하세요.'),'prompt');
 assert.equal(ruleIssueField({...rule,kind:'json'},'JSON 필수 키를 확인하세요.'),'requiredKeys');
});
