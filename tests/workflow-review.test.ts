import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { configurationFingerprint, datasetFingerprint, matchesExpectation, workflowChanges } from '../lib/workflow-review.ts';
import type { ExecutionResult } from '../lib/aegis-types';

test('configuration evidence ignores save timestamps and unrelated model edits', async()=>{
  const state=initialState(); const before=await configurationFingerprint(state.workflows[0],state.connections);
  const workflow=structuredClone(state.workflows[0]);workflow.updatedAt='2099-01-01';
  const unrelated={...state.connections[0],id:'unrelated',model:'other-model'};
  assert.equal(await configurationFingerprint(workflow,[...state.connections,unrelated]),before);
  workflow.pre[0].rules[0].enabled=false;
  assert.notEqual(await configurationFingerprint(workflow,state.connections),before);
});
test('canvas layout keeps execution evidence and release review unchanged',async()=>{
  const state=initialState();const original=structuredClone(state.workflows[0]);const workflow=structuredClone(original);
  const fingerprint=await configurationFingerprint(workflow,state.connections);
  workflow.layout={version:1,positions:{main:{x:400,y:240},[`rule:${workflow.pre[0].rules[0].id}`]:{x:24,y:80}}};
  assert.equal(await configurationFingerprint(workflow,state.connections),fingerprint);
  assert.deepEqual(workflowChanges(workflow,original,state.connections,state.connections),[]);
  workflow.layout.positions.main={x:800,y:12};
  assert.equal(await configurationFingerprint(workflow,state.connections),fingerprint);
  workflow.responseRetry={enabled:true,maxRetries:1};
  assert.notEqual(await configurationFingerprint(workflow,state.connections),fingerprint);
});
test('evidence changes when a referenced model endpoint or guard prompt changes',async()=>{
  const state=initialState();const workflow=state.workflows[0];const fingerprint=await configurationFingerprint(workflow,state.connections);
  const connections=structuredClone(state.connections);connections[0].model='different-checkpoint';
  assert.notEqual(await configurationFingerprint(workflow,connections),fingerprint);
  workflow.pre[0].rules[1].config.prompt='다른 정책';
  assert.notEqual(await configurationFingerprint(workflow,state.connections),fingerprint);
});
test('dataset evidence captures exact input and expectations independent of save time',async()=>{
  const dataset=initialState().datasets[0];const before=await datasetFingerprint(dataset);
  dataset.updatedAt='2099-01-01';assert.equal(await datasetFingerprint(dataset),before);
  dataset.rows[0].input+=' ';assert.notEqual(await datasetFingerprint(dataset),before);
  dataset.rows[0].input=dataset.rows[0].input.slice(0,-1);dataset.rows[0].expectedStage='post';
  assert.notEqual(await datasetFingerprint(dataset),before);
});
test('an unrelated blocking rule cannot satisfy a specifically expected detector',()=>{
  const result:ExecutionResult={id:'r',status:'block',stage:'pre',reason:'blocked',output:'',latencyMs:1,traces:[{ruleId:'keyword',ruleName:'금지 문구',stage:'pre',groupId:'g',status:'block',reason:'matched',latencyMs:1},{ruleId:'pii',ruleName:'개인정보',stage:'pre',groupId:'g',status:'allow',reason:'no match',latencyMs:1}]};
  assert.equal(matchesExpectation({expected:'block'},result),true);
  assert.equal(matchesExpectation({expected:'block',expectedRuleId:'pii'},result),false);
  assert.equal(matchesExpectation({expected:'block',expectedStage:'post'},result),false);
  assert.equal(matchesExpectation({expected:'block',expectedStage:'pre',expectedRuleId:'keyword'},result),true);
  assert.equal(matchesExpectation({expected:'block'},{...result,status:'error'}),false);
});
test('release review identifies detector configuration, group policy and model changes',()=>{
  const state=initialState();const original=structuredClone(state.workflows[0]);const edited=structuredClone(original);
  edited.pre[0].mode='all';edited.pre[0].rules[0].config.pattern='changed';
  const connections=structuredClone(state.connections);connections[0].timeoutMs=40000;
  const changes=workflowChanges(edited,original,connections,state.connections);
  assert.ok(changes.some(c=>c.ruleId==='rule-pii'));
  assert.ok(changes.some(c=>c.label.includes('단계 변경')));
  assert.ok(changes.some(c=>c.label.includes('모델 서버')));
  assert.deepEqual(workflowChanges(original,structuredClone(original),state.connections,state.connections),[]);
});

test('expected detector outcome is checked against the final generated answer',()=>{
  const result:ExecutionResult={id:'r',status:'block',stage:'post',reason:'blocked',output:'',latencyMs:5,attempts:[{number:1,status:'block',stage:'post',latencyMs:2,reason:'first'},{number:2,status:'block',stage:'post',latencyMs:3,reason:'last'}],regenerationCount:1,traces:[{ruleId:'pre',ruleName:'요청',stage:'pre',groupId:'p',status:'allow',reason:'passed',latencyMs:0},{ruleId:'pii',ruleName:'개인정보',stage:'post',groupId:'g',status:'block',reason:'first match',latencyMs:1,attempt:1},{ruleId:'pii',ruleName:'개인정보',stage:'post',groupId:'g',status:'allow',reason:'last passed',latencyMs:1,attempt:2},{ruleId:'json',ruleName:'JSON',stage:'post',groupId:'g',status:'block',reason:'last match',latencyMs:1,attempt:2}]};
  assert.equal(matchesExpectation({expected:'block',expectedRuleId:'pii'},result),false);
  assert.equal(matchesExpectation({expected:'block',expectedRuleId:'json'},result),true);
  const success={...result,status:'allow' as const,stage:'complete' as const};
  assert.equal(matchesExpectation({expected:'allow',expectedRuleId:'pii'},success),true);
  assert.equal(matchesExpectation({expected:'allow',expectedRuleId:'pre'},success),true);
});
test('regeneration configuration changes invalidate evidence and appear in release review',async()=>{
  const state=initialState();const before=structuredClone(state.workflows[0]);const workflow=structuredClone(before);
  const fingerprint=await configurationFingerprint(before,state.connections);
  workflow.responseRetry={enabled:true,maxRetries:2,instruction:'조건을 충족해 다시 작성하세요.'};
  assert.notEqual(await configurationFingerprint(workflow,state.connections),fingerprint);
  assert.ok(workflowChanges(workflow,before,state.connections,state.connections).some(change=>change.label==='응답 재작성 설정 변경'));
});

test('execution connections and required checks invalidate evidence and appear in release review',async()=>{
  const state=initialState();const before=structuredClone(state.workflows[0]);const workflow=structuredClone(before);
  const fingerprint=await configurationFingerprint(workflow,state.connections);
  const serial=(stage:'pre'|'post')=>{const keys=['start',...workflow[stage].map(group=>`group:${group.id}`),'end'];return {nodes:[],edges:keys.slice(0,-1).map((from,index)=>({id:`${stage}-${index}`,from,to:keys[index+1],port:'next' as const}))};};
  workflow.graph={version:1,pre:serial('pre'),post:serial('post')};
  assert.notEqual(await configurationFingerprint(workflow,state.connections),fingerprint);
  assert.ok(workflowChanges(workflow,before,state.connections,state.connections).some(change=>change.label==='실행 연결 변경'));
  const graphBefore=structuredClone(workflow);workflow.graph.pre.edges[0].id='changed-edge';
  assert.ok(workflowChanges(workflow,graphBefore,state.connections,state.connections).some(change=>change.label==='실행 연결 변경'));
  const requiredBefore=structuredClone(workflow);workflow.pre[0].required=true;
  assert.ok(workflowChanges(workflow,requiredBefore,state.connections,state.connections).some(change=>change.label==='요청 검사 단계 변경'));
  assert.notEqual(await configurationFingerprint(workflow,state.connections),await configurationFingerprint(requiredBefore,state.connections));
});
