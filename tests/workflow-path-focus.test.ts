import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { workflowPathFocus } from '../lib/workflow-path-focus.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { createStageGraph } from '../lib/workflow-graph.ts';

test('path focus follows directed ancestors and descendants without crossing into parallel siblings',()=>{
  const workflow=structuredClone(initialState().workflows[0]);
  workflow.pre=['a','b'].map(id=>({id,name:id,mode:'any',rules:[{id:`rule-${id}`,name:id,kind:'keyword',enabled:true,description:'',config:{pattern:'금지'}}]}));workflow.post=[];
  workflow.graph={version:1,pre:{nodes:[{id:'fork',kind:'fork',name:'분기'},{id:'join',kind:'join',name:'합류'}],edges:[{id:'in',from:'start',to:'control:fork'},{id:'a',from:'control:fork',to:'group:a'},{id:'b',from:'control:fork',to:'group:b'},{id:'aj',from:'group:a',to:'control:join'},{id:'bj',from:'group:b',to:'control:join'},{id:'end',from:'control:join',to:'end'}]},post:createStageGraph([])};
  const unchanged=structuredClone(workflow),focus=workflowPathFocus(workflow,'rule:rule-a')!;
  assert.deepEqual([...focus.nodes].sort(),['input','control:fork','rule:rule-a','control:join','main','output'].sort());
  assert.ok(focus.edges.has('pre:in'));assert.ok(focus.edges.has('pre:a'));assert.ok(focus.edges.has('pre:aj'));assert.ok(focus.edges.has('post:serial-1'));
  assert.ok(!focus.nodes.has('rule:rule-b'));assert.ok(!focus.edges.has('pre:b'));assert.ok(!focus.edges.has('pre:bj'));
  assert.deepEqual(workflow,unchanged,'visual focus does not alter the execution graph or layout');
  assert.equal(workflowPathFocus(workflow,'missing-node'),undefined);
});

test('legacy serial flows use visible singleton/compound keys and keep PRE and POST edges distinct',()=>{
  const workflow=structuredClone(initialState().workflows[0]);delete workflow.graph;
  const first=workflow.pre[0],key=first.rules.length===1?`rule:${first.rules[0].id}`:`group:${first.id}`;
  const focus=workflowPathFocus(workflow,key)!;
  assert.ok(focus.nodes.has('input'));assert.ok(focus.nodes.has('main'));assert.ok(focus.nodes.has('output'));
  assert.ok(focus.edges.has('pre:serial-1'));assert.ok(focus.edges.has('post:serial-1'));
});
