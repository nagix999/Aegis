import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's source test runner uses explicit TypeScript imports.
import {initialState} from '../lib/aegis-seed.ts';
// @ts-expect-error Node's source test runner uses explicit TypeScript imports.
import {normalizedZoneNodeKeys,reconcileContiguousZoneResult,workflowZoneIssues,zoneMembershipIssue} from '../lib/workflow-zones.ts';
import type {RuleGroup,Workflow} from '../lib/aegis-types';

function group(id:string):RuleGroup{return {id,name:id,mode:'any',rules:[{id:`${id}-rule`,name:id,description:'',enabled:true,kind:'length',config:{maxLength:100}}]};}
function serial():Workflow{const workflow=structuredClone(initialState().workflows[0]);workflow.pre=[group('one'),group('two')];workflow.post=[];delete workflow.graph;delete workflow.layout;return workflow;}
function branch():Workflow{const workflow=serial();workflow.graph={version:1,pre:{nodes:[{id:'fork',kind:'fork',name:'병렬'},{id:'join',kind:'join',name:'합류'}],edges:[{id:'a',from:'start',to:'control:fork'},{id:'b',from:'control:fork',to:'group:one'},{id:'c',from:'control:fork',to:'group:two'},{id:'d',from:'group:one',to:'control:join'},{id:'e',from:'group:two',to:'control:join'},{id:'f',from:'control:join',to:'end'}]},post:{nodes:[],edges:[{id:'post',from:'start',to:'end'}]}};return workflow;}
function zone(id:string,nodeKeys:string[]){return {id,name:`영역 ${id}`,color:'blue' as const,nodeKeys,x:20,y:30,width:500,height:240};}

test('linear areas require an uninterrupted real path including terminal cards',()=>{
  const workflow=serial();
  for(const keys of [[],['input'],['rule:one-rule','rule:two-rule'],['rule:two-rule','main','output'],['input','rule:one-rule'],['input','rule:one-rule','rule:two-rule','main','output']])assert.equal(zoneMembershipIssue(workflow,keys),undefined,keys.join(','));
  for(const keys of [['input','rule:two-rule','output'],['rule:one-rule','main'],['input','output'],['rule:one-rule','output']])assert.ok(zoneMembershipIssue(workflow,keys),keys.join(','));
});
test('node positions never determine zone adjacency',()=>{
  const workflow=serial();workflow.layout={version:1,positions:{input:{x:0,y:0},'rule:one-rule':{x:40000,y:40000},'rule:two-rule':{x:1,y:1},main:{x:2,y:2},output:{x:3,y:3}}};
  assert.ok(zoneMembershipIssue(workflow,['input','rule:two-rule']));
  assert.equal(zoneMembershipIssue(workflow,['rule:one-rule','rule:two-rule']),undefined);
});
test('parallel siblings need their actual connector and cannot omit an alternate branch between selected ends',()=>{
  const workflow=branch();
  assert.ok(zoneMembershipIssue(workflow,['rule:one-rule','rule:two-rule']));
  assert.ok(zoneMembershipIssue(workflow,['control:fork','rule:one-rule','control:join']));
  assert.equal(zoneMembershipIssue(workflow,['control:fork','rule:one-rule','rule:two-rule']),undefined);
  assert.equal(zoneMembershipIssue(workflow,['control:fork','rule:one-rule','rule:two-rule','control:join']),undefined);
  assert.equal(zoneMembershipIssue(workflow,['rule:one-rule','control:join','main']),undefined);
});
test('a direct shortcut cannot make omitted middle nodes contiguous',()=>{
  const workflow=serial();workflow.graph={version:1,pre:{nodes:[{id:'condition',kind:'condition',name:'조건',condition:{operator:'contains',value:'a'}}],edges:[{id:'a',from:'start',to:'control:condition'},{id:'b',from:'control:condition',to:'group:one',port:'true'},{id:'c',from:'control:condition',to:'group:two',port:'false'},{id:'d',from:'group:one',to:'group:two'},{id:'e',from:'group:two',to:'end'}]},post:{nodes:[],edges:[{id:'f',from:'start',to:'end'}]}};
  assert.ok(zoneMembershipIssue(workflow,['control:condition','rule:two-rule']));
});
test('hidden compound children normalize to one visible card and main bridges request and response',()=>{
  const workflow=serial();workflow.pre[0].rules.push({...workflow.pre[0].rules[0],id:'other-rule'});workflow.post=[group('post')];
  assert.deepEqual(normalizedZoneNodeKeys(workflow,['rule:one-rule','rule:other-rule','group:one']),['group:one']);
  assert.equal(zoneMembershipIssue(workflow,['group:one','rule:two-rule']),undefined);
  assert.ok(zoneMembershipIssue(workflow,['rule:two-rule','rule:post-rule']));
  assert.equal(zoneMembershipIssue(workflow,['rule:two-rule','main','rule:post-rule','output']),undefined);
  assert.ok(zoneMembershipIssue(workflow,['missing']));
});
test('repair splits invalid display areas without changing execution, positions, or source',()=>{
  const workflow=serial();workflow.layout={version:1,positions:{input:{x:22,y:33}},zones:[zone('old',['input','rule:two-rule','output'])]};const original=structuredClone(workflow);
  const result=reconcileContiguousZoneResult(workflow);
  assert.equal(result.changed,true);assert.equal(result.splitCount,2);assert.deepEqual(result.ungroupedKeys,[]);
  assert.equal(result.workflow.layout!.zones!.length,3);assert.equal(result.workflow.layout!.zones![0].id,'old');
  assert.deepEqual(result.workflow.pre,original.pre);assert.deepEqual(result.workflow.post,original.post);assert.deepEqual(result.workflow.graph,original.graph);assert.deepEqual(result.workflow.layout!.positions,original.layout!.positions);
  assert.deepEqual(new Set(result.workflow.layout!.zones!.flatMap(zone=>zone.nodeKeys)),new Set(original.layout!.zones![0].nodeKeys));
  assert.deepEqual(workflowZoneIssues(result.workflow),[]);assert.deepEqual(workflow,original);
  assert.equal(reconcileContiguousZoneResult(result.workflow).changed,false);
});
test('repair keeps valid and empty areas and reports nodes that cannot receive another area under the limit',()=>{
  const workflow=serial();workflow.layout={version:1,positions:{},zones:[zone('broken',['input','rule:two-rule','output']),...Array.from({length:31},(_,index)=>zone(`empty-${index}`,[]))]};
  const result=reconcileContiguousZoneResult(workflow);
  assert.equal(result.workflow.layout!.zones!.length,32);assert.equal(result.ungroupedKeys.length,2);
  assert.deepEqual(workflowZoneIssues(result.workflow),[]);
  assert.equal(result.workflow.pre.length,2);assert.equal(result.workflow.post.length,0);
});
test('incomplete cyclic drafts are handled without recursion or invented adjacency',()=>{
  const workflow=branch();workflow.graph!.pre.edges=[{id:'a',from:'group:one',to:'group:two'},{id:'b',from:'group:two',to:'group:one'}];
  assert.equal(typeof zoneMembershipIssue(workflow,['input','rule:one-rule']),'string');
  assert.equal(zoneMembershipIssue(workflow,['rule:one-rule']),undefined);
});
