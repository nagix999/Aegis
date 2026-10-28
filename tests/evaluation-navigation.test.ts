import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { evaluationContextForRun, navigationRun, restoreEvaluationNavigation } from '../lib/evaluation-navigation.ts';
import type { EvaluationNavigationContext } from '../lib/evaluation-navigation';
import type { AppState, EvalRun, ExecutionResult } from '../lib/aegis-types';

function fixture() {
  const state: AppState = initialState();
  const workflow = state.workflows[0], dataset = state.datasets[0];
  const result: ExecutionResult = { id: 'request-original', status: 'block', stage: 'pre', reason: '검사 조건', output: '', latencyMs: 1, traces: [] };
  const run: EvalRun = { id: 'run-original', workflowId: workflow.id, workflowName: workflow.name, datasetId: dataset.id, datasetName: dataset.name, createdAt: '2026-10-25T01:00:00Z', version: '초안', status: 'completed', results: [{ ...result, rowId: 'row-original', input: '원본 요청', expected: 'allow', category: '분류 A' }], workflowSnapshot: structuredClone(workflow), datasetSnapshot: structuredClone(dataset) };
  state.runs = [run];
  const context: EvaluationNavigationContext = { tab: 'compare', workflowId: workflow.id, datasetId: dataset.id, target: 'draft', input: '아직 실행하지 않은 요청', lastInput: '실행했던 요청', result, singleFingerprint: 'original-fingerprint', runId: run.id, rowId: 'row-original', resultFilter: 'mismatch', categoryFilter: '분류 A', changedOnly: true, showSnapshot: true, scrollTop: 925 };
  return { state, run, context };
}

test('return restores exact record, row, filters and single result without modifying original evidence', () => {
  const { state, context } = fixture();
  const before = structuredClone({ state, context });
  state.workflows[0].description = '수정한 초안';
  const restored = restoreEvaluationNavigation(context, state);
  assert.deepEqual(restored.context, { ...context, localRun: undefined });
  assert.equal(restored.missingRun, false);
  assert.equal(restored.missingRow, false);
  assert.deepEqual(state.runs, before.state.runs);
  assert.deepEqual(context, before.context);
});

test('historical run and selected row survive live workflow and dataset deletion', () => {
  const { state, run, context } = fixture();
  state.workflows = [];
  state.datasets = [];
  const restored = restoreEvaluationNavigation(context, state);
  assert.equal(restored.context.workflowId, '');
  assert.equal(restored.context.datasetId, '');
  assert.equal(restored.context.runId, run.id);
  assert.equal(restored.context.rowId, 'row-original');
  assert.equal(restored.context.resultFilter, 'mismatch');
  assert.equal(restored.missingRun, false);
  assert.equal(restored.missingRow, false);
  assert.equal(state.runs[0].workflowSnapshot?.id, run.workflowId);
});

test('newer local result displayed before parent synchronization is preserved', () => {
  const { state, run, context } = fixture();
  const localRun = structuredClone(run);
  localRun.updatedAt = '2026-10-25T02:00:00Z';
  localRun.results.push({ ...run.results[0], rowId: 'row-local' });
  context.localRun = localRun;
  context.rowId = 'row-local';
  const restored = restoreEvaluationNavigation(context, state);
  assert.equal(restored.context.rowId, 'row-local');
  assert.equal(restored.context.localRun?.results.length, 2);
  assert.equal(state.runs[0].results.length, 1);
  assert.equal(navigationRun(state.runs, run.id, localRun), localRun);
  const newerStored = { ...run, updatedAt: '2026-10-25T03:00:00Z' };
  assert.equal(navigationRun([newerStored], run.id, localRun), newerStored);
});

test('missing original record does not silently select an unrelated latest result', () => {
  const { state, run, context } = fixture();
  state.runs = [{ ...run, id: 'unrelated-run' }];
  const restored = restoreEvaluationNavigation(context, state);
  assert.equal(restored.context.runId, '');
  assert.equal(restored.context.rowId, '');
  assert.equal(restored.missingRun, true);
  assert.equal(restored.missingRow, true);
});

test('preparing a new full run keeps cleared run selection instead of reopening old evidence', () => {
  const { state, context } = fixture();
  const prepared = { ...context, tab: 'batch' as const, target: 'draft' as const, runId: '', rowId: '', localRun: undefined };
  const restored = restoreEvaluationNavigation(prepared, state);
  assert.equal(restored.context.runId, '');
  assert.equal(restored.context.rowId, '');
  assert.equal(restored.context.tab, 'batch');
  assert.equal(state.runs.length, 1);
});

test('a removed deployment cannot label an old single result as current draft', () => {
  const { state, context } = fixture();
  state.deployments = [];
  context.target = 'deployed';
  context.tab = 'single';
  const restored = restoreEvaluationNavigation(context, state);
  assert.equal(restored.context.target, 'draft');
  assert.equal(restored.context.result, undefined);
  assert.equal(restored.context.lastInput, '');
  assert.equal(restored.context.singleFingerprint, '');
  assert.equal(restored.context.input, context.input);
});

test('missing row is cleared while record, filters, snapshot and bounded scroll remain', () => {
  const { state, context } = fixture();
  context.rowId = 'deleted-row';
  context.scrollTop = -1;
  const restored = restoreEvaluationNavigation(context, state);
  assert.equal(restored.missingRun, false);
  assert.equal(restored.missingRow, true);
  assert.equal(restored.context.runId, context.runId);
  assert.equal(restored.context.resultFilter, 'mismatch');
  assert.equal(restored.context.showSnapshot, true);
  assert.equal(restored.context.scrollTop, 0);
});

test('release verification navigation retains the exact historical deployment and returned run',()=>{
  const {state,run}=fixture();run.target='deployed';run.deploymentId='historical-only';
  const context=evaluationContextForRun(run),restored=restoreEvaluationNavigation(context,state);
  assert.equal(context.tab,'batch');assert.equal(context.runId,run.id);assert.equal(context.localRun,run);
  assert.equal(restored.context.target,'deployed');assert.equal(restored.context.deploymentId,'historical-only');
  assert.equal(restored.context.runId,run.id,'Missing historical deployment metadata must not substitute the latest run or target');
});

test('draft release verification opens its own dataset without historical target metadata',()=>{
  const {run}=fixture();run.target='draft';
  const context=evaluationContextForRun(run);
  assert.equal(context.workflowId,run.workflowId);assert.equal(context.datasetId,run.datasetId);
  assert.equal(context.target,'draft');assert.equal('deploymentId' in context,false);assert.equal(context.rowId,'');assert.equal(context.scrollTop,0);
});
