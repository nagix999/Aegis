import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {initialState} from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {cloneWorkflowContent} from '../lib/workflow-clone.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {configurationFingerprint,executionConfiguration,workflowChanges} from '../lib/workflow-review.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import {isRecoverableWorkflow,readWorkflowRecovery,saveWorkflowRecovery} from '../lib/workflow-recovery.ts';

function identifier(){let next=0;return(prefix:string)=>`${prefix}-lineage-${++next}`;}
function storage(){const records=new Map<string,string>();return{getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{records.set(key,value);},removeItem:(key:string)=>{records.delete(key);}};}

test('cloning records every immediate source rule and replaces an ancestor mapping without mutating its source',()=>{
  const source=structuredClone(initialState().workflows[0]);
  source.cloneSource={workflowId:'ancestor',ruleIds:{'ancestor-rule':source.pre[0].rules[0].id}};
  const original=structuredClone(source),ids=identifier();
  const clone=cloneWorkflowContent(source,ids);clone.id='first-clone';
  const oldRules=[...source.pre,...source.post].flatMap(group=>group.rules);
  const newRules=[...clone.pre,...clone.post].flatMap(group=>group.rules);
  assert.deepEqual(source,original);
  assert.equal(clone.cloneSource!.workflowId,source.id);
  assert.deepEqual(clone.cloneSource!.ruleIds,Object.fromEntries(oldRules.map((rule,index)=>[rule.id,newRules[index].id])));
  assert.equal(Object.hasOwn(clone.cloneSource!.ruleIds,'ancestor-rule'),false);
  const second=cloneWorkflowContent(clone,ids);second.id='second-clone';
  assert.equal(second.cloneSource!.workflowId,'first-clone');
  assert.deepEqual(Object.keys(second.cloneSource!.ruleIds),newRules.map(rule=>rule.id));
  assert.equal(second.cloneSource!.ruleIds[newRules[0].id],second.pre[0].rules[0].id);
  assert.deepEqual(clone.cloneSource!.ruleIds,Object.fromEntries(oldRules.map((rule,index)=>[rule.id,newRules[index].id])));
});

test('lineage alone has no execution fingerprint or release behavior difference',async()=>{
  const state=initialState(),workflow=structuredClone(state.workflows[0]);
  const next={...structuredClone(workflow),cloneSource:{workflowId:'source-workflow',ruleIds:{'source-rule':workflow.pre[0].rules[0].id}}};
  assert.equal(Object.hasOwn(executionConfiguration(next),'cloneSource'),false);
  assert.deepEqual(executionConfiguration(next),executionConfiguration(workflow));
  assert.equal(await configurationFingerprint(next,state.connections),await configurationFingerprint(workflow,state.connections));
  assert.deepEqual(workflowChanges(next,workflow,state.connections,state.connections),[]);
  next.pre[0].rules[0].enabled=false;
  assert.notEqual(await configurationFingerprint(next,state.connections),await configurationFingerprint(workflow,state.connections));
});

test('a cloned working draft retains lineage through local recovery including metadata for a removed rule',()=>{
  const source=initialState().workflows[0],clone=cloneWorkflowContent(source,identifier());clone.id='recoverable-clone';
  const base=structuredClone(clone),removed=clone.pre[0].rules.pop()!;
  assert.ok(Object.values(clone.cloneSource!.ruleIds).includes(removed.id));
  assert.equal(isRecoverableWorkflow(clone),true);
  const local=storage();const saved=saveWorkflowRecovery(local,clone,base);
  assert.equal(saved.ok,true);
  const recovered=readWorkflowRecovery(local);
  assert.equal(recovered.ok,true);
  assert.deepEqual(recovered.records[0].draft.cloneSource,clone.cloneSource);
  assert.deepEqual(recovered.records[0].base.cloneSource,base.cloneSource);
});

test('recovery bounds lineage IDs and rejects malformed, duplicate target or unrecognized metadata',()=>{
  const workflow=initialState().workflows[0];
  const withSource=(cloneSource:unknown)=>({...structuredClone(workflow),cloneSource});
  assert.equal(isRecoverableWorkflow(withSource({workflowId:'source',ruleIds:{}})),true);
  const capacity=Object.fromEntries(Array.from({length:864},(_,index)=>[`source-${index}`,`target-${index}`]));
  assert.equal(isRecoverableWorkflow(withSource({workflowId:'source',ruleIds:capacity})),true);
  assert.equal(isRecoverableWorkflow(withSource({workflowId:'source',ruleIds:{...capacity,extra:'target-extra'}})),false);
  for(const cloneSource of [
    {workflowId:'',ruleIds:{}},
    {workflowId:'source',ruleIds:{old:3}},
    {workflowId:'source',ruleIds:{old:'same',other:'same'}},
    {workflowId:'source',ruleIds:JSON.parse('{"__proto__":"new-rule"}')},
    {workflowId:'source',ruleIds:{'bad\nkey':'new-rule'}},
    {workflowId:'source',ruleIds:{old:'x'.repeat(121)}},
    {workflowId:'source',ruleIds:[],extra:'not-metadata'},
  ])assert.equal(isRecoverableWorkflow(withSource(cloneSource)),false);
});
