import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {initialState} from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {configurationFingerprint,executionConfiguration,workflowChanges} from '../lib/workflow-review.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {executeWorkflow,validateWorkflow} from '../lib/aegis-engine.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {createStageGraph,validateWorkflowGraph} from '../lib/workflow-graph.ts';

test('visual zone creation, membership, styling, movement and deletion keep execution and evidence unchanged',async()=>{
  const state=initialState();const before=structuredClone(state.workflows[0]);
  before.graph={version:1,pre:createStageGraph(before.pre),post:createStageGraph(before.post)};
  const edited=structuredClone(before);const fingerprint=await configurationFingerprint(before,state.connections);
  const baseline=await executeWorkflow(before,state.connections,state.ingress,{},[{role:'user',content:'배송 문의'}]);
  edited.layout={version:1,positions:{main:{x:700,y:200}},zones:[{id:'z1',name:'비어 있는 영역',color:'slate',nodeKeys:[],x:200,y:100,width:400,height:240}]};
  const content=structuredClone(edited.layout.zones![0]);
  for(const zone of [content,{...content,name:'고객 안내',color:'blue' as const,nodeKeys:['input','main']},{...content,x:800,y:600,width:900,height:500,nodeKeys:[`group:${edited.pre[0].id}`,'output']}]){
    edited.layout.zones=[zone];
    assert.deepEqual(executionConfiguration(edited),executionConfiguration(before));
    assert.equal(await configurationFingerprint(edited,state.connections),fingerprint);
    assert.deepEqual(workflowChanges(edited,before,state.connections,state.connections),[]);
    const result=await executeWorkflow(edited,state.connections,state.ingress,{},[{role:'user',content:'배송 문의'}]);
    assert.deepEqual({status:result.status,output:result.output,stage:result.stage,traces:result.traces.map(t=>[t.ruleId,t.status])},{status:baseline.status,output:baseline.output,stage:baseline.stage,traces:baseline.traces.map(t=>[t.ruleId,t.status])});
  }
  edited.layout.zones=[];
  assert.equal(await configurationFingerprint(edited,state.connections),fingerprint);
  assert.deepEqual(edited.graph,before.graph);
});

test('independent check nodes support 36 per inspection stage and reject overflow',()=>{
  const state=initialState();const workflow=structuredClone(state.workflows[0]);
  for(const stage of ['pre','post'] as const)workflow[stage]=Array.from({length:36},(_,i)=>({id:`${stage}-${i}`,name:'독립 검사',mode:'any',rules:[{id:`${stage}-rule-${i}`,name:'길이 검사',description:'',kind:'length',enabled:true,config:{maxLength:4000}}]}));
  workflow.graph={version:1,pre:createStageGraph(workflow.pre),post:createStageGraph(workflow.post)};
  assert.deepEqual(validateWorkflow(workflow,state.connections),[]);
  workflow.pre.push({...structuredClone(workflow.pre[0]),id:'overflow',rules:[{...workflow.pre[0].rules[0],id:'overflow-rule'}]});
  assert.ok(validateWorkflow(workflow,state.connections).some(message=>message.includes('36')));
  assert.ok(validateWorkflowGraph(workflow).some(message=>message.includes('36')));
});
