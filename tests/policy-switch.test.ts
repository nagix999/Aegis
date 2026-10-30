import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import { policyGraphErrors, policyNodePorts, policySwitchErrors, policySwitchValueLabel, validPolicySwitchValue } from '../lib/policy-graph.ts';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import { policyGraphSchemaIssues } from '../lib/policy-schema-guidance.ts';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import { addConnectedWorkflowPolicyNode, addWorkflowPolicyGraphNode, connectWorkflowPolicyNode, setWorkflowPolicyEntryNode } from '../lib/workflow-policy-nodes.ts';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import { getPolicyCanvasNodes, getWorkflowCanvasLinks } from '../lib/workflow-policy-canvas.ts';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import { autoLayout } from '../lib/workflow-layout.ts';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import { isRecoverableWorkflow, readWorkflowRecovery, saveWorkflowRecovery } from '../lib/workflow-recovery.ts';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import { policyNodeInputIssues } from '../lib/workflow-input-guidance.ts';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import { searchWorkflowNodes } from '../lib/workflow-search.ts';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import { cloneWorkflowContent } from '../lib/workflow-clone.ts';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import { policyExecutionConfiguration } from '../lib/policy-routing.ts';
// @ts-expect-error Node source tests resolve explicit TypeScript paths.
import { initialState } from '../lib/aegis-seed.ts';
import type { PolicyGraph, PolicyGraphNode, PolicySwitchValue, Workflow } from '../lib/aegis-types';

type SwitchNode=Extract<PolicyGraphNode,{kind:'switch'}>;
function switchNode():SwitchNode { return {id:'switch',name:'위험 등급 선택',kind:'switch',path:'/risk/level',cases:[
  {id:'text',value:' HIGH '},{id:'number',value:1},{id:'boolean',value:true},{id:'empty',value:null},
]}; }
function graph():PolicyGraph { return {version:1,entryNodeId:'switch',nodes:[switchNode(),{id:'finish',name:'응답 생성',kind:'action',action:'main'}],edges:[
  ...switchNode().cases.map(item=>({id:`edge-${item.id}`,from:'switch',to:'finish',port:item.id})),
  {id:'edge-default',from:'switch',to:'finish',port:'default'},
]}; }
function fixture():Workflow {
  const state=initialState(),workflow=structuredClone(state.workflows[0]);
  workflow.policyRouting={policy:{id:'switch-policy',name:'위험 JSON',description:'',prompt:'위험 등급을 추출하세요.',connectionId:state.connections[1].id,connectionSnapshot:state.connections[1],formatVersion:2,outputSchema:{type:'object'},decisions:[],examples:[{id:'example',input:'배송 문의',expectedOutput:{risk:{level:' HIGH '}}}],version:1,updatedAt:'2026-10-30T00:00:00Z'},routes:[],graph:graph()};
  return workflow;
}

test('Switch supports scalar values and exact typed distinct cases, keeping whitespace and case',()=>{
  const value=switchNode();value.cases.push({id:'lowercase',value:' high '},{id:'no-space',value:'HIGH'},{id:'string-one',value:'1'},{id:'string-true',value:'true'});
  assert.deepEqual(policySwitchErrors(value),[]);
  assert.deepEqual(policyNodePorts(value).slice(0,4),[{port:'text',label:'" HIGH "'},{port:'number',label:'1'},{port:'boolean',label:'true'},{port:'empty',label:'null'}]);
  assert.equal(policyNodePorts(value).at(-1)?.port,'default');
  for(const scalar of [' decision ',0,-1,1.25,true,false,null])assert.equal(validPolicySwitchValue(scalar),true);
});
test('Switch value safety rejects objects, arrays, missing, nonfinite, unsafe numbers and oversized UTF-8',()=>{
  for(const invalid of [{},[],undefined,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'한'.repeat(1365)])assert.equal(validPolicySwitchValue(invalid),false);
  assert.equal(validPolicySwitchValue('한'.repeat(1364)),true);
  assert.equal(policySwitchValueLabel(' x '),'" x "');
  assert.equal(policySwitchValueLabel(undefined as unknown as PolicySwitchValue),'미완성 값');
});
test('Switch rejects duplicate values of the same type and duplicate, unsafe or reserved case ids',()=>{
  for(const item of [{id:'other',value:' HIGH '},{id:'text',value:'other'},{id:'default',value:'other'},{id:'bad id',value:'other'},{id:'x'.repeat(81),value:'other'}]){
    const value=switchNode();value.cases.push(item);assert.ok(policySwitchErrors(value).length);
  }
  const value=switchNode();value.cases.push({id:'minus-zero',value:-0},{id:'zero',value:0});assert.ok(policySwitchErrors(value).some(message=>message.includes('중복')));
});
test('Switch requires one to twelve cases and a valid bounded JSON Pointer',()=>{
  for(const path of ['/decision','/risk/level','/a~1b/~0','/items/0',''])assert.deepEqual(policySwitchErrors({...switchNode(),path}),[]);
  for(const path of ['risk.level','/~2','/'+Array(13).fill('x').join('/'),'x'.repeat(513)])assert.ok(policySwitchErrors({...switchNode(),path}).length);
  for(const size of [0,13])assert.ok(policySwitchErrors({...switchNode(),cases:Array.from({length:size},(_,i)=>({id:`case-${i}`,value:i}))}).length);
});
test('Switch can start a graph and needs exactly one edge for every case and default',()=>{
  assert.deepEqual(policyGraphErrors(graph()),[]);
  for(const port of ['text','number','boolean','empty','default']){
    const value=graph();value.edges=value.edges.filter(edge=>edge.port!==port);assert.ok(policyGraphErrors(value).some(message=>message.includes('기본 경로')));
  }
  const duplicate=graph();duplicate.edges.push({...duplicate.edges[0],id:'duplicate'});assert.ok(policyGraphErrors(duplicate).length);
  const unknown=graph();unknown.edges[0].port='unregistered';assert.ok(policyGraphErrors(unknown).length);
  const cycle=graph();cycle.edges[0].to='switch';assert.ok(policyGraphErrors(cycle).some(message=>message.includes('순환')));
});
test('Switch schema guidance checks nested paths and strict case value types without leaking compared values',()=>{
  const schema={type:'object',additionalProperties:false,properties:{risk:{type:'object',additionalProperties:false,properties:{level:{type:['string','number','boolean','null']}}}}};
  assert.deepEqual(policyGraphSchemaIssues(graph(),schema),[]);
  const incompatible={...schema,properties:{risk:{...schema.properties.risk,properties:{level:{type:'number'}}}}};
  const issues=policyGraphSchemaIssues(graph(),incompatible);assert.equal(issues.length,3);assert.ok(issues.every(issue=>issue.code==='value'));assert.ok(!JSON.stringify(issues).includes(' HIGH '));
  const missing=graph();(missing.nodes[0] as SwitchNode).path='/risk/missing';assert.equal(policyGraphSchemaIssues(missing,schema)[0].code,'path');
});
test('workflow creation and connection helpers accept Switch and string ports without changing the source',()=>{
  const workflow=fixture(),original=structuredClone(workflow);
  const added=addWorkflowPolicyGraphNode(workflow,'switch','second-switch');
  assert.equal(added.workflow.policyRouting!.graph!.nodes.at(-1)?.kind,'switch');
  const entry=setWorkflowPolicyEntryNode(added.workflow,'second-switch');assert.equal(entry.policyRouting!.graph!.entryNodeId,'second-switch');
  const connected=connectWorkflowPolicyNode(entry,'switch','second-switch','text');assert.equal(connected.policyRouting!.graph!.edges.find(edge=>edge.port==='text')?.to,'second-switch');
  const rule=addConnectedWorkflowPolicyNode(workflow,'switch','default','rule','fallback-rule');assert.equal(rule.workflow.policyRouting!.graph!.nodes.at(-1)?.kind,'rule');
  assert.throws(()=>connectWorkflowPolicyNode(workflow,'switch','finish','true'));
  assert.throws(()=>connectWorkflowPolicyNode(connected,'second-switch','switch','case-1'),/순환/);
  assert.deepEqual(workflow,original);
});
test('Switch projection retains case ports, typed labels and default in bounded automatic layout',()=>{
  const workflow=fixture();assert.equal(getPolicyCanvasNodes(workflow).find(node=>node.id==='switch')?.policyKind,'switch');
  const links=getWorkflowCanvasLinks(workflow).filter(link=>link.policyEdgeId);
  assert.deepEqual(links.map(link=>[link.port,link.label]),[['text','" HIGH "'],['number','1'],['boolean','true'],['empty','null'],['default','기본 경로']]);
  const positions=autoLayout(workflow);assert.ok(Number.isFinite(positions['policy-node:switch'].x));assert.ok(positions['policy-node:finish'].x>positions['policy-node:switch'].x);
  assert.equal(policyNodeInputIssues(workflow.policyRouting!).length,0);
});
test('Switch incomplete drafts, explicit null values and all output ports survive browser recovery',()=>{
  const workflow=fixture(),draft=structuredClone(workflow),memory=new Map<string,string>();
  const storage={getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>void memory.set(key,value),removeItem:(key:string)=>void memory.delete(key)};
  draft.policyRouting!.graph!.edges=[];(draft.policyRouting!.graph!.nodes[0] as SwitchNode).path='unfinished.pointer';
  assert.equal(isRecoverableWorkflow(draft),true);assert.equal(saveWorkflowRecovery(storage,draft,workflow).ok,true);
  const recovered=readWorkflowRecovery(storage);assert.equal(recovered.ok,true);assert.deepEqual(recovered.records[0].draft,draft);
  const missing=fixture();delete ((missing.policyRouting!.graph!.nodes[0] as SwitchNode).cases[0] as Partial<{value:PolicySwitchValue}>).value;assert.equal(isRecoverableWorkflow(missing),false);
});
test('Switch search and clone preserve field selection, case values and policy canvas metadata',()=>{
  const workflow=fixture();workflow.layout={version:1,positions:{policy:{x:10,y:20},'policy-node:switch':{x:200,y:20}},zones:[{id:'policy-zone',name:'정책 영역',color:'blue',nodeKeys:['policy','policy-node:switch'],x:0,y:0,width:600,height:240}]};
  assert.equal(searchWorkflowNodes(workflow,initialState().connections,'switch /risk/level')[0].name,'위험 등급 선택');
  let index=0;const cloned=cloneWorkflowContent(workflow,(prefix:string)=>`${prefix}-${++index}`);
  assert.deepEqual(cloned.policyRouting,workflow.policyRouting);assert.deepEqual(cloned.layout?.positions,workflow.layout.positions);assert.deepEqual(cloned.layout?.zones?.[0].nodeKeys,['policy','policy-node:switch']);
  const previous=policyExecutionConfiguration(workflow.policyRouting!);(cloned.policyRouting!.graph!.nodes[0] as SwitchNode).cases[0].value='changed';assert.notDeepEqual(policyExecutionConfiguration(cloned.policyRouting!),previous);assert.equal((workflow.policyRouting!.graph!.nodes[0] as SwitchNode).cases[0].value,' HIGH ');
});
