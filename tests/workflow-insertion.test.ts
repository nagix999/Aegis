import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {initialState} from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {captureInsertTarget,insertCheckOnEdge} from '../lib/workflow-connections.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {executeWorkflow,validateWorkflow} from '../lib/aegis-engine.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {createStageGraph} from '../lib/workflow-graph.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {configurationFingerprint} from '../lib/workflow-review.ts';
import type {RuleGroup} from '../lib/aegis-types';

const keyword = ():RuleGroup=>({id:'inserted-check',name:'배송 검사',mode:'any',rules:[{id:'inserted-rule',name:'배송 검사',kind:'keyword',description:'',enabled:true,config:{pattern:'배송'}}]});

test('inserting into an implicit serial edge executes the new check before its former successor and main',async()=>{
  const state=initialState();const workflow=state.workflows[0];const original=structuredClone(workflow);
  const target=captureInsertTarget(workflow,'pre','serial-2');
  const inserted=insertCheckOnEdge(workflow,target,keyword(),{x:480,y:240});
  assert.deepEqual(workflow,original);assert.deepEqual(validateWorkflow(inserted,state.connections),[]);
  assert.notEqual(await configurationFingerprint(inserted,state.connections),await configurationFingerprint(workflow,state.connections));
  const result=await executeWorkflow(inserted,state.connections,state.ingress,{},[{role:'user',content:'배송 문의'}]);
  assert.equal(result.status,'block');assert.equal(result.stage,'pre');assert.equal(result.output,'');
  assert.ok(result.traces.filter(t=>t.groupId===workflow.pre[0].id).every(t=>t.status==='allow'));
  assert.equal(result.traces.find(t=>t.ruleId==='inserted-rule')?.status,'block');
  assert.ok(result.traces.filter(t=>t.groupId===workflow.pre[1].id||t.stage==='main'||t.stage==='post').every(t=>t.status==='skipped'));
});

test('inserting on a conditional output preserves the other branch and its actual execution',async()=>{
  const state=initialState();const workflow=structuredClone(state.workflows[0]);
  const a=`group:${workflow.pre[0].id}`,b=`group:${workflow.pre[1].id}`;
  workflow.graph={version:1,pre:{nodes:[{id:'choose',name:'문의 분류',kind:'condition',condition:{operator:'contains',value:'환불'}},{id:'join',name:'합류',kind:'join'}],edges:[
    {id:'entry',from:'start',to:'control:choose'},
    {id:'yes',from:'control:choose',to:a,port:'true'},
    {id:'no',from:'control:choose',to:b,port:'false'},
    {id:'a-join',from:a,to:'control:join'},
    {id:'b-join',from:b,to:'control:join'},
    {id:'exit',from:'control:join',to:'end'},
  ]},post:createStageGraph(workflow.post)};
  const original=structuredClone(workflow);
  const inserted=insertCheckOnEdge(workflow,captureInsertTarget(workflow,'pre','no'),keyword());
  assert.deepEqual(workflow,original);assert.deepEqual(validateWorkflow(inserted,state.connections),[]);
  assert.deepEqual(inserted.graph!.pre.edges.find(e=>e.id==='yes'),workflow.graph.pre.edges.find(e=>e.id==='yes'));
  assert.equal(inserted.graph!.pre.edges.find(e=>e.id==='no')?.port,'false');
  const yes=await executeWorkflow(inserted,state.connections,state.ingress,{},[{role:'user',content:'환불 문의'}]);
  assert.equal(yes.status,'allow');assert.equal(yes.traces.find(t=>t.ruleId==='inserted-rule')?.status,'skipped');
  const no=await executeWorkflow(inserted,state.connections,state.ingress,{},[{role:'user',content:'배송 문의'}]);
  assert.equal(no.status,'block');assert.equal(no.traces.find(t=>t.ruleId==='inserted-rule')?.status,'block');
});

test('an inserted response check participates in every bounded regeneration and withholds rejected outputs',async()=>{
  const state=initialState();const workflow=structuredClone(state.workflows[0]);
  workflow.responseRetry={enabled:true,maxRetries:1};
  const check:RuleGroup={id:'inserted-post',name:'응답 길이',mode:'any',rules:[{id:'inserted-post-rule',name:'응답 길이',kind:'length',description:'',enabled:true,config:{maxLength:1}}]};
  const inserted=insertCheckOnEdge(workflow,captureInsertTarget(workflow,'post','serial-1'),check);
  const result=await executeWorkflow(inserted,state.connections,state.ingress,{},[{role:'user',content:'배송 문의'}]);
  assert.equal(result.status,'block');assert.equal(result.stage,'post');assert.equal(result.output,'');
  assert.equal(result.regenerationCount,1);assert.equal(result.attempts?.length,2);
  assert.deepEqual(result.traces.filter(t=>t.ruleId==='inserted-post-rule').map(t=>[t.attempt,t.status]),[[1,'block'],[2,'block']]);
  for(const rule of workflow.pre.flatMap(g=>g.rules))assert.equal(result.traces.filter(t=>t.ruleId===rule.id).length,1);
  assert.ok(result.traces.filter(t=>t.groupId===workflow.post[0].id).every(t=>t.status==='skipped'));
});
