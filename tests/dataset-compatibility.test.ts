import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { applyDatasetRuleMappings, evaluationPreflight, getWorkflowRuleOptions, inspectDatasetCompatibility, suggestDatasetRuleMappings } from '../lib/dataset-compatibility.ts';
import type { AppState, Dataset, Rule, Workflow } from '../lib/aegis-types';

const detector = (id: string, name: string): Rule => ({ id, name, description: '', kind: 'keyword', enabled: true, config: { pattern: '금지' } });
function fixture() {
  const state = initialState();
  const source: Workflow = { ...structuredClone(state.workflows[0]), id: 'source', name: '원본', pre: [{ id: 'source-pre', name: '요청', mode: 'all', rules: [detector('old-pre', '금지 요청')] }], post: [{ id: 'source-post', name: '응답', mode: 'any', rules: [detector('old-post', '금지 응답')] }], graph: undefined, layout: undefined };
  const target: Workflow = { ...structuredClone(source), id: 'target', name: '복제본', pre: [{ id: 'target-pre', name: '요청', mode: 'all', rules: [detector('new-pre', '금지 요청')] }], post: [{ id: 'target-post', name: '응답', mode: 'any', rules: [detector('new-post', '금지 응답')] }] };
  const dataset: Dataset = { id: 'dataset', name: '검증', description: '보존할 설명', rows: [
    { id: 'allowed', input: '  정상 요청\n', expected: 'allow', expectedStage: 'complete', expectedRuleId: 'old-pre', category: '정상', note: '원문 보존' },
    { id: 'blocked-pre', input: '금지 요청', expected: 'block', expectedStage: 'pre', expectedRuleId: 'old-pre', category: '요청' },
    { id: 'blocked-post', input: '응답 확인', expected: 'block', expectedStage: 'post', expectedRuleId: 'old-post' },
    { id: 'unconstrained', input: '일반 요청', expected: 'allow' },
  ] };
  const history: Pick<AppState, 'workflows' | 'deployments' | 'runs'> = { workflows: [source, target], deployments: [], runs: [] };
  return { state, source, target, dataset, history };
}

test('preflight identifies missing detectors without exposing requests or predicting conditional outcomes', () => {
  const f = fixture();
  const missing = inspectDatasetCompatibility(f.dataset, f.target);
  assert.equal(missing.requiresAcknowledgement, true);
  assert.deepEqual(missing.affectedRowIds, ['allowed', 'blocked-pre', 'blocked-post']);
  assert.ok(missing.issues.every(issue => issue.code === 'missing_rule' && issue.severity === 'warning'));
  assert.equal(JSON.stringify(missing).includes(f.dataset.rows[0].input), false);
  assert.deepEqual(inspectDatasetCompatibility(f.dataset, f.source).issues, []);
  f.source.graph = { version: 1, pre: { nodes: [{ id: 'condition', name: '조건', kind: 'condition', condition: { operator: 'contains', value: '특정 문구' } }], edges: [] }, post: { nodes: [], edges: [] } };
  assert.deepEqual(inspectDatasetCompatibility(f.dataset, f.source).issues, [], 'The criteria check does not guess which route will execute.');
});

test('disabled rules, duplicate IDs and impossible final stages are separate reviewable warnings', () => {
  const f = fixture();
  f.source.pre[0].rules[0].enabled = false;
  f.dataset.rows.push({ id: 'allow-pre', input: 'secret input', expected: 'allow', expectedStage: 'pre' }, { id: 'block-main', input: 'secret input', expected: 'block', expectedStage: 'main' }, { id: 'wrong-stage', input: 'secret input', expected: 'block', expectedStage: 'post', expectedRuleId: 'old-pre' });
  let issues = inspectDatasetCompatibility(f.dataset, f.source).issues;
  assert.equal(issues.filter(issue => issue.code === 'disabled_rule').length, 3);
  assert.equal(issues.filter(issue => issue.code === 'impossible_stage').length, 2);
  assert.equal(issues.filter(issue => issue.code === 'rule_stage_mismatch').length, 1);
  assert.equal(JSON.stringify(issues).includes('secret input'), false);
  f.source.post[0].rules.push({ ...detector('old-pre', '중복'), enabled: false });
  issues = inspectDatasetCompatibility(f.dataset, f.source).issues;
  assert.ok(issues.some(issue => issue.code === 'ambiguous_rule'));
});

test('comparison preflight covers candidate and baseline with a stable snapshot-bound acknowledgement', async () => {
  const f = fixture(), original = structuredClone(f);
  const sides = [{ key: 'candidate' as const, label: '현재 초안', workflow: f.target, connections: f.state.connections }, { key: 'baseline' as const, label: '배포 v1', workflow: f.source, connections: f.state.connections }];
  const reviewed = await evaluationPreflight(f.dataset, sides);
  assert.equal(reviewed.requiresAcknowledgement, true);
  assert.ok(reviewed.issues.every(issue => issue.sideKey === 'candidate'));
  assert.equal(reviewed.sideFingerprints.length, 2);
  assert.equal(reviewed.fingerprint.length, 64);
  const relabelled = await evaluationPreflight(f.dataset, [...sides].reverse().map(side => ({ ...side, label: '화면 표시 변경' })));
  assert.equal(relabelled.fingerprint, reviewed.fingerprint);
  f.target.layout = { version: 1, positions: { main: { x: 200, y: 300 } } }; f.target.updatedAt = 'later';
  assert.equal((await evaluationPreflight(f.dataset, sides)).fingerprint, reviewed.fingerprint);
  f.target.pre[0].rules[0].config.pattern = '수정';
  assert.notEqual((await evaluationPreflight(f.dataset, sides)).fingerprint, reviewed.fingerprint);
  f.target = original.target;
  f.dataset.rows[0].input += ' ';
  assert.notEqual((await evaluationPreflight(f.dataset, [{ ...sides[0], workflow: f.target }, sides[1]])).fingerprint, reviewed.fingerprint);
  const both = await evaluationPreflight(f.dataset, [{ ...sides[0], workflow: f.target }, { ...sides[1], workflow: f.target }]);
  assert.ok(both.issues.some(issue => issue.sideKey === 'baseline'));
});

test('preflight bindings ignore unrelated servers but detect referenced server and baseline changes', async () => {
  const f = fixture(), sides = [{ key: 'candidate' as const, label: '현재 초안', workflow: f.source, connections: f.state.connections }];
  const first = await evaluationPreflight(f.dataset, sides);
  f.state.connections.push({ ...f.state.connections[0], id: 'unrelated', model: 'other' });
  assert.equal((await evaluationPreflight(f.dataset, sides)).fingerprint, first.fingerprint);
  f.state.connections.find(connection => connection.id === f.source.mainConnectionId)!.model += '-changed';
  assert.notEqual((await evaluationPreflight(f.dataset, sides)).fingerprint, first.fingerprint);
  await assert.rejects(() => evaluationPreflight(f.dataset, []), /대상/);
  await assert.rejects(() => evaluationPreflight(f.dataset, [sides[0], sides[0]]), /대상/);
});

test('explicit mappings change only rule references and preserve source, exact inputs and expectation strength', () => {
  const f = fixture(), original = structuredClone(f.dataset), workflow = structuredClone(f.target);
  const mapped = applyDatasetRuleMappings(f.dataset, f.target, { 'old-pre': 'new-pre', 'old-post': 'new-post' });
  assert.deepEqual(f.dataset, original); assert.deepEqual(f.target, workflow);
  assert.deepEqual(mapped.rows.map(row => row.expectedRuleId), ['new-pre', 'new-pre', 'new-post', undefined]);
  assert.deepEqual(mapped.rows.map(({ expectedRuleId: _id, ...row }) => row), original.rows.map(({ expectedRuleId: _id, ...row }) => row));
  assert.equal(mapped.id, original.id); assert.equal(mapped.name, original.name);
  assert.deepEqual(inspectDatasetCompatibility(mapped, f.target).issues, []);
  mapped.rows[0].note = '수정'; assert.equal(f.dataset.rows[0].note, original.rows[0].note);
});

test('mapping rejects incomplete, unknown, disabled, ambiguous and cross-stage targets without partial changes', () => {
  const f = fixture(), original = structuredClone(f.dataset);
  assert.throws(() => applyDatasetRuleMappings(f.dataset, f.target, {}), /없는 예상 검사/);
  assert.throws(() => applyDatasetRuleMappings(f.dataset, f.target, { extra: 'new-pre' }), /사용하는 검사/);
  assert.throws(() => applyDatasetRuleMappings(f.dataset, f.target, { 'old-pre': '', 'old-post': 'new-post' }), /사용하는 검사/);
  assert.throws(() => applyDatasetRuleMappings(f.dataset, f.target, JSON.parse('{"__proto__":"new-pre"}')), /사용하는 검사/);
  assert.throws(() => applyDatasetRuleMappings(f.dataset, f.target, { 'old-pre': 'new-post', 'old-post': 'new-post' }), /종료 단계/);
  f.target.pre[0].rules[0].enabled = false;
  assert.throws(() => applyDatasetRuleMappings(f.dataset, f.target, { 'old-pre': 'new-pre', 'old-post': 'new-post' }), /사용 중지/);
  f.target.pre[0].rules[0].enabled = true; f.target.pre[0].rules.push(detector('new-pre', '중복'));
  assert.throws(() => applyDatasetRuleMappings(f.dataset, f.target, { 'old-pre': 'new-pre', 'old-post': 'new-post' }), /없는 예상 검사/);
  assert.deepEqual(f.dataset, original);
});

test('one old detector shared by different expected block stages has no implicit stage rewrite', () => {
  const f = fixture(); f.dataset.rows = [
    { id: 'a', input: '요청', expected: 'block', expectedStage: 'pre', expectedRuleId: 'old-pre' },
    { id: 'b', input: '응답', expected: 'block', expectedStage: 'post', expectedRuleId: 'old-pre' },
  ];
  const suggestion = suggestDatasetRuleMappings(f.dataset, f.target, f.history)[0];
  assert.deepEqual(suggestion.candidates, []); assert.equal(suggestion.suggestedRuleId, undefined);
  assert.throws(() => applyDatasetRuleMappings(f.dataset, f.target, { 'old-pre': 'new-pre' }), /종료 단계/);
});

test('current IDs and valid direct clone links are proposed without changing any dataset automatically', () => {
  const f = fixture(), original = structuredClone(f.dataset);
  f.target.cloneSource = { workflowId: f.source.id, ruleIds: { 'old-pre': 'new-pre', 'old-post': 'new-post' } };
  const suggestions = suggestDatasetRuleMappings(f.dataset, f.target, { workflows: [], deployments: [], runs: [] });
  assert.deepEqual(suggestions.map(item => item.suggestedRuleId), ['new-pre', 'new-post']);
  assert.ok(suggestions.every(item => item.requiresMapping && !item.ambiguous && item.reason.includes('복제')));
  assert.deepEqual(f.dataset, original);
  const current = suggestDatasetRuleMappings(f.dataset, f.source, f.history);
  assert.ok(current.every(item => !item.requiresMapping && item.suggestedRuleId === item.sourceRuleId));
  f.target.cloneSource.ruleIds['old-pre'] = 'removed';
  const stale = suggestDatasetRuleMappings(f.dataset, f.target, { workflows: [], deployments: [], runs: [] })[0];
  assert.equal(stale.suggestedRuleId, undefined);
});

test('unique historical name, kind and stage suggestions remain proposals and unknown IDs require a manual choice', () => {
  const f = fixture();
  const unique = suggestDatasetRuleMappings(f.dataset, f.target, f.history);
  assert.deepEqual(unique.map(item => item.suggestedRuleId), ['new-pre', 'new-post']);
  assert.ok(unique[0].candidates.every(option => option.enabled && option.stage === 'pre'));
  const unknown = suggestDatasetRuleMappings(f.dataset, f.target, { workflows: [], deployments: [], runs: [] });
  assert.ok(unknown.every(item => item.suggestedRuleId === undefined && !item.ambiguous));
  const deployment = { id: 'past', workflowId: f.source.id, alias: f.source.alias, version: 1, createdAt: '2026-01-01', workflow: f.source, connections: f.state.connections };
  assert.equal(suggestDatasetRuleMappings(f.dataset, f.target, { workflows: [], deployments: [deployment], runs: [] })[0].suggestedRuleId, 'new-pre');
});

test('duplicate target names and conflicting historical settings are never guessed', () => {
  const f = fixture();
  f.target.pre[0].rules.push(detector('another', '금지 요청'));
  let suggestion = suggestDatasetRuleMappings(f.dataset, f.target, f.history)[0];
  assert.equal(suggestion.suggestedRuleId, undefined); assert.equal(suggestion.ambiguous, true);
  f.target.pre[0].rules.pop(); const changed = structuredClone(f.source); changed.pre[0].rules[0].config.pattern = '다른 정책';
  suggestion = suggestDatasetRuleMappings(f.dataset, f.target, { ...f.history, deployments: [{ id: 'past', workflowId: f.source.id, alias: f.source.alias, version: 1, createdAt: '2026-01-01', workflow: changed, connections: f.state.connections }] })[0];
  assert.equal(suggestion.suggestedRuleId, undefined); assert.equal(suggestion.ambiguous, true);
  f.target.cloneSource = { workflowId: f.source.id, ruleIds: { 'old-pre': 'new-pre' } };
  assert.equal(suggestDatasetRuleMappings(f.dataset, f.target, { ...f.history, workflows: [...f.history.workflows, changed] })[0].suggestedRuleId, 'new-pre');
});

test('returned rule options and suggestions do not expose mutable workflow references', () => {
  const f = fixture(), original = structuredClone(f.target);
  getWorkflowRuleOptions(f.target)[0].rule.config.pattern = '외부 수정';
  suggestDatasetRuleMappings(f.dataset, f.target, f.history)[0].candidates[0].rule.config.pattern = '외부 수정';
  assert.deepEqual(f.target, original);
});
