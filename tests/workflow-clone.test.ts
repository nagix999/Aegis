import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {initialState} from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {cloneWorkflowContent} from '../lib/workflow-clone.ts';

test('workflow duplication remaps graph references and canvas keys without changing the source',()=>{
  const workflow=structuredClone(initialState().workflows[0]);
  const first=workflow.pre[0];const second=workflow.pre[1];
  workflow.graph={version:1,pre:{nodes:[{id:'condition-1',kind:'condition',name:'분류',condition:{operator:'contains',value:'배송'}},{id:'join-1',kind:'join',name:'합류'}],edges:[
    {id:'e1',from:'start',to:'control:condition-1'},
    {id:'e2',from:'control:condition-1',to:`group:${first.id}`,port:'true'},
    {id:'e3',from:'control:condition-1',to:`group:${second.id}`,port:'false'},
    {id:'e4',from:`group:${first.id}`,to:'control:join-1'},
    {id:'e5',from:`group:${second.id}`,to:'control:join-1'},
    {id:'e6',from:'control:join-1',to:'end'},
  ]},post:{nodes:[],edges:[{id:'post-edge',from:'start',to:'end'}]}};
  workflow.layout={version:1,zones:[{id:'zone-original',name:'검사 영역',color:'blue',nodeKeys:[`group:${first.id}`,'control:condition-1','main'],x:10,y:20,width:400,height:240},{id:'zone-empty',name:'빈 영역',color:'slate',nodeKeys:[],x:600,y:20,width:300,height:200}],positions:{input:{x:1,y:2},main:{x:3,y:4},output:{x:5,y:6},'control:condition-1':{x:123.5,y:21},[`group:${first.id}`]:{x:7,y:8},[`rule:${first.rules[0].id}`]:{x:9,y:10}}};
  const original=structuredClone(workflow);let sequence=0;
  const clone=cloneWorkflowContent(workflow,prefix=>`${prefix}-new-${++sequence}`);
  assert.deepEqual(workflow,original);
  assert.equal(clone.graph!.pre.nodes[0].condition!.value,'배송');
  assert.notEqual(clone.pre[0].id,first.id);
  assert.equal(clone.cloneSource!.workflowId,workflow.id);
  assert.equal(clone.cloneSource!.ruleIds[first.rules[0].id],clone.pre[0].rules[0].id);
  assert.equal(Object.keys(clone.cloneSource!.ruleIds).length,[...workflow.pre,...workflow.post].reduce((count,group)=>count+group.rules.length,0));
  const oldKeys=new Set([`group:${first.id}`,`group:${second.id}`,'control:condition-1','control:join-1']);
  for(const edge of clone.graph!.pre.edges){assert.equal(oldKeys.has(edge.from),false);assert.equal(oldKeys.has(edge.to),false);assert.ok(edge.id.startsWith('edge-new-'));}
  assert.equal(clone.graph!.pre.edges[1].to,`group:${clone.pre[0].id}`);
  assert.deepEqual(clone.layout!.positions[`control:${clone.graph!.pre.nodes[0].id}`],{x:123.5,y:21});
  assert.deepEqual(clone.layout!.positions[`rule:${clone.pre[0].rules[0].id}`],{x:9,y:10});
  assert.deepEqual(clone.layout!.positions.output,workflow.layout.positions.output);
  assert.notEqual(clone.layout!.zones![0].id,'zone-original');
  assert.deepEqual(clone.layout!.zones![0].nodeKeys,[`group:${clone.pre[0].id}`,`control:${clone.graph!.pre.nodes[0].id}`,'main']);
  assert.deepEqual(clone.layout!.zones![1].nodeKeys,[]);
  assert.equal(clone.layout!.zones![0].width,400);
  clone.graph!.pre.nodes[0].condition!.value='다른 조건';assert.equal(workflow.graph.pre.nodes[0].condition!.value,'배송');
});
