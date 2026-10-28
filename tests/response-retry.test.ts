import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { executionLeaseDuration, responseAttemptLimit, responseTokenReservation } from '../lib/response-retry.ts';

test('retry token reservations cover every planned call and the bounded repair guidance',()=>{
  const workflow=initialState().workflows[0];const messages=[{content:'hello'}];
  const original=responseTokenReservation(workflow,messages,64);
  assert.equal(responseAttemptLimit(workflow),1);
  workflow.responseRetry={enabled:true,maxRetries:2};
  assert.equal(responseAttemptLimit(workflow),3);
  assert.ok(responseTokenReservation(workflow,messages,64)>original*3);
  workflow.responseRetry.enabled=false;assert.equal(responseTokenReservation(workflow,messages,64),original);
});
test('execution lease outlives the enforced deadline independently of serial graph size',()=>{
  const state=initialState();const workflow=state.workflows[0];
  for(const connection of state.connections)connection.timeoutMs=60_000;
  workflow.pre=[];workflow.post=Array.from({length:12},(_,i)=>({id:`post-${i}`,name:'순서 검사',mode:'any' as const,rules:[{id:`rule-${i}`,name:'모델 검사',description:'',kind:'llm' as const,enabled:true,config:{connectionId:'conn-guard',prompt:'검사 기준'}}]}));
  workflow.responseRetry={enabled:true,maxRetries:3};
  const lease=executionLeaseDuration(workflow,state.connections);
  assert.equal(lease,180_000);
  workflow.executionLimits={timeoutMs:600_000,maxModelCalls:1000};
  assert.equal(executionLeaseDuration(workflow,state.connections),660_000);
});
