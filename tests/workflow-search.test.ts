import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { searchWorkflowNodes } from '../lib/workflow-search.ts';
import type { Rule, Workflow } from '../lib/aegis-types';

function sample(): Workflow {
  const workflow = structuredClone(initialState().workflows[0]);
  const rule = (id: string, name: string, kind: Rule['kind'] = 'keyword'): Rule => ({ id, name, kind, description: '', enabled: true, config: {} });
  workflow.pre = [
    { id: 'pre-keyword', name: '요청 키워드', mode: 'any', rules: [rule('request-rule', '공통 검사')] },
    { id: 'compound', name: '보안 검사 조합', mode: 'any', rules: [rule('private-child', '연락처 검사', 'pii'), rule('json-child', '구조 검사', 'json')] },
  ];
  workflow.post = [{ id: 'post-keyword', name: '응답 키워드', mode: 'any', rules: [rule('response-rule', '공통 검사')] }];
  workflow.graph = { version: 1, pre: { nodes: [{ id: 'route', kind: 'condition', name: '요청 유형' }, { id: 'parallel', kind: 'fork', name: '동시 검사' }, { id: 'merge', kind: 'join', name: '결과 모으기' }], edges: [] }, post: { nodes: [], edges: [] } };
  workflow.layout = { version: 1, positions: {}, zones: [{ id: 'zone', name: '고객 상담', color: 'blue', nodeKeys: ['rule:private-child', 'rule:request-rule'], x: 0, y: 0, width: 600, height: 400 }] };
  return workflow;
}

test('empty node search returns every visible card once including terminal and control nodes', () => {
  const workflow = sample(), results = searchWorkflowNodes(workflow, [], '');
  assert.deepEqual(results.map(result => result.key), ['input', 'main', 'output', 'rule:request-rule', 'group:compound', 'control:route', 'control:parallel', 'control:merge', 'rule:response-rule']);
  assert.equal(new Set(results.map(result => result.key)).size, results.length);
  assert.deepEqual(results.find(result => result.key === 'main')?.selection, { kind: 'main' });
  assert.deepEqual(results.find(result => result.key === 'control:route')?.selection, { kind: 'control', id: 'route' });
});

test('duplicate names remain separate and stage terms narrow the intended result', () => {
  const workflow = sample();
  assert.deepEqual(searchWorkflowNodes(workflow, [], '공통 검사').map(result => result.key), ['rule:request-rule', 'rule:response-rule']);
  assert.deepEqual(searchWorkflowNodes(workflow, [], '공통 POST').map(result => result.key), ['rule:response-rule']);
  assert.deepEqual(searchWorkflowNodes(workflow, [], '공통 요청').map(result => result.key), ['rule:request-rule']);
});

test('hidden child matches navigate to the single compound card with a matching rule label', () => {
  const workflow = sample(), [match] = searchWorkflowNodes(workflow, [], '연락처');
  assert.equal(match.key, 'group:compound');
  assert.deepEqual(match.selection, { kind: 'group', id: 'compound' });
  assert.deepEqual(match.matchedRuleNames, ['연락처 검사']);
  assert.deepEqual(searchWorkflowNodes(workflow, [], 'PII 고객').map(result => result.key), ['group:compound']);
  assert.deepEqual(searchWorkflowNodes(workflow, [], 'json').map(result => result.key), ['group:compound']);
});

test('zone memberships resolve legacy hidden keys and search does not return zone objects', () => {
  const workflow = sample(), matches = searchWorkflowNodes(workflow, [], '고객 상담');
  assert.deepEqual(matches.map(result => result.key), ['rule:request-rule', 'group:compound']);
  assert.deepEqual(matches[1].zoneNames, ['고객 상담']);
  assert.ok(matches.every(result => !result.key.startsWith('zone:')));
});

test('Korean and English type aliases find I/O, generation, conditions, forks and joins', () => {
  const workflow = sample();
  assert.deepEqual(searchWorkflowNodes(workflow, [], 'input').map(result => result.key), ['input']);
  assert.deepEqual(searchWorkflowNodes(workflow, [], 'output').map(result => result.key), ['output']);
  assert.deepEqual(searchWorkflowNodes(workflow, [], 'generation').map(result => result.key), ['main']);
  assert.deepEqual(searchWorkflowNodes(workflow, [], 'condition').map(result => result.key), ['control:route']);
  assert.deepEqual(searchWorkflowNodes(workflow, [], 'parallel').map(result => result.key), ['control:parallel']);
  assert.deepEqual(searchWorkflowNodes(workflow, [], '합류').map(result => result.key), ['control:merge']);
});

test('main model name and identifier are searchable with Unicode and whitespace normalization', () => {
  const workflow = sample(), connection = { ...initialState().connections[0], id: workflow.mainConnectionId, name: '상담 모델', model: 'Qwen-Customer-32B' };
  assert.deepEqual(searchWorkflowNodes(workflow, [connection], '  ＱＷＥＮ   생성 ').map(result => result.key), ['main']);
  assert.equal(searchWorkflowNodes(workflow, [connection], '상담 모델')[0].name, '상담 모델');
  assert.deepEqual(searchWorkflowNodes(workflow, [connection], 'not-present'), []);
});

test('all supported cards remain available at maximum capacity and searching does not mutate source', () => {
  const workflow = sample(), template = workflow.pre[0].rules[0];
  for (const stage of ['pre', 'post'] as const) {
    workflow[stage] = Array.from({ length: 36 }, (_, index) => ({ id: `${stage}-group-${index}`, name: '검사 조합', mode: 'any', rules: Array.from({ length: 12 }, (_, child) => ({ ...structuredClone(template), id: `${stage}-rule-${index}-${child}`, name: `검사 ${index}-${child}` })) }));
    workflow.graph![stage].nodes = Array.from({ length: 12 }, (_, index) => ({ id: `${stage}-control-${index}`, kind: 'join', name: '결과 합류' }));
  }
  const original = structuredClone(workflow), results = searchWorkflowNodes(workflow, [], '');
  assert.equal(results.length, 99);
  assert.equal(searchWorkflowNodes(workflow, [], '검사 35-11').length, 2);
  assert.deepEqual(workflow, original);
});

test('policy models and graph nodes are searchable as actual inspector destinations',()=>{
  const workflow=sample(),state=initialState();
  workflow.policyRouting={policy:{id:'policy',name:'서비스 정책',description:'문의 범위를 분류합니다.',prompt:'JSON',connectionId:state.connections[1].id,connectionSnapshot:{...state.connections[1],model:'Qwen-Policy-14B'},formatVersion:2,outputSchema:{type:'object'},decisions:[],examples:[{id:'example',input:'배송',expectedOutput:{}}],version:7,updatedAt:'2026-10-27T00:00:00Z'},routes:[],graph:{version:1,entryNodeId:'branch',nodes:[{id:'branch',name:'서비스 분기',kind:'branch',condition:{mode:'all',predicates:[{path:'/context/topic',operator:'eq',value:'service'}]}},{id:'risk',name:'위험 점수',kind:'rule',condition:{mode:'all',predicates:[{path:'/risk/score',operator:'gte',value:80}]}},{id:'reject',name:'오류 응답',kind:'action',action:'error',errorCode:'POLICY_RESTRICTED',errorMessage:'제한'}],edges:[]}};
  const original=structuredClone(workflow);
  assert.deepEqual(searchWorkflowNodes(workflow,[],'Qwen-Policy v7').map(result=>result.key),['policy']);
  assert.deepEqual(searchWorkflowNodes(workflow,[],'정책 분기')[0].selection,{kind:'policy-node',id:'branch'});
  const conditions=searchWorkflowNodes(workflow,[],'정책 조건 분기');
  assert.deepEqual(conditions.map(result=>result.key),['policy-node:branch','policy-node:risk']);
  assert.ok(conditions.every(result=>result.typeLabel==='조건 분기'));
  assert.deepEqual(searchWorkflowNodes(workflow,[],'경로 룰').map(result=>result.key),['policy-node:branch','policy-node:risk']);
  assert.deepEqual(searchWorkflowNodes(workflow,[],'/risk/score').map(result=>result.key),['policy-node:risk']);
  assert.deepEqual(searchWorkflowNodes(workflow,[],'POLICY_RESTRICTED')[0].selection,{kind:'policy-node',id:'reject'});
  assert.equal(searchWorkflowNodes(workflow,[],'서비스 정책')[0].typeLabel,'정책 모델');
  assert.deepEqual(workflow,original);
});
