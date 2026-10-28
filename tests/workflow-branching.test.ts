import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { buildBranchSelection, previewBranchSelection } from '../lib/workflow-branching.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { createStageGraph, getStageGraph, validateWorkflowGraph } from '../lib/workflow-graph.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { initialState } from '../lib/aegis-seed.ts';
import type { RuleGroup, Workflow } from '../lib/aegis-types';

function group(id: string): RuleGroup { return { id, name: id, mode: 'any', rules: [{ id: `${id}-rule`, name: `${id} 검사`, description: '', kind: 'length', enabled: true, config: { maxLength: 4000 } }] }; }
function fixture(): Workflow {
  const workflow = structuredClone(initialState().workflows[0]);
  workflow.pre = ['alpha', 'beta', 'gamma', 'delta', 'after'].map(group); workflow.post = [group('post-only')]; delete workflow.graph;
  workflow.layout = { version: 1, positions: { input: { x: 0, y: 0 }, 'rule:alpha-rule': { x: 250.5, y: 300.25 }, main: { x: 900, y: 300 } }, zones: [{ id: 'zone', name: '표시 영역', color: 'blue', nodeKeys: ['rule:alpha-rule', 'rule:gamma-rule'], x: 200, y: 200, width: 600, height: 400 }] };
  return workflow;
}
function identifiers() { let index = 0; return (prefix: string) => `${prefix}-new-${++index}`; }
function branchFixture(): Workflow {
  const workflow = fixture(); workflow.pre.push(group('other-branch'));
  workflow.graph = { version: 1, pre: { nodes: [{ id: 'choice', kind: 'condition', name: '기존 조건', condition: { operator: 'contains', value: '조건' } }, { id: 'merge', kind: 'join', name: '기존 합류' }], edges: [
    { id: 'entry', from: 'start', to: 'control:choice' }, { id: 'yes', from: 'control:choice', to: 'group:other-branch', port: 'true' }, { id: 'no', from: 'control:choice', to: 'group:alpha', port: 'false' },
    ...['alpha', 'beta', 'gamma', 'delta'].map((id, index, ids) => ({ id: `${id}-next`, from: `group:${id}`, to: `group:${ids[index + 1] || 'after'}` })),
    { id: 'after-merge', from: 'group:after', to: 'control:merge' }, { id: 'other-merge', from: 'group:other-branch', to: 'control:merge' }, { id: 'exit', from: 'control:merge', to: 'end' },
  ] }, post: createStageGraph(workflow.post) };
  return workflow;
}

test('two to four consecutive checks become independent parallel paths in one immutable build', () => {
  for (const count of [2, 3, 4]) {
    const workflow = fixture(), before = structuredClone(workflow), ids = workflow.pre.slice(0, count).map(group => group.id);
    const preview = previewBranchSelection(workflow, 'pre', [...ids].reverse());
    assert.equal(preview.valid, true); assert.deepEqual(preview.groupIds, ids);
    const built = buildBranchSelection(workflow, preview, { identifier: identifiers() });
    const graph = built.workflow.graph!.pre;
    assert.equal(graph.nodes.find(node => node.id === built.splitId)?.kind, 'fork');
    assert.equal(graph.nodes.find(node => node.id === built.joinId)?.kind, 'join');
    assert.deepEqual(graph.edges.filter(edge => edge.from === `control:${built.splitId}`).map(edge => edge.to), ids.map(id => `group:${id}`));
    assert.equal(graph.edges.filter(edge => edge.to === `control:${built.joinId}`).length, count);
    assert.equal(graph.edges.length, getStageGraph(workflow, 'pre').edges.length + count + 1);
    assert.deepEqual(built.workflow.graph!.post, createStageGraph(workflow.post));
    assert.deepEqual(built.workflow.layout, workflow.layout); assert.deepEqual(built.workflow.pre, workflow.pre);
    assert.deepEqual(validateWorkflowGraph(built.workflow), []); assert.deepEqual(workflow, before);
  }
});

test('selection is ordered by actual graph edges rather than click or persisted group order', () => {
  const workflow = fixture(); workflow.graph = { version: 1, pre: createStageGraph(workflow.pre), post: createStageGraph(workflow.post) }; workflow.pre.reverse();
  const preview = previewBranchSelection(workflow, 'pre', ['delta', 'beta', 'alpha', 'gamma']);
  assert.equal(preview.valid, true); assert.deepEqual(preview.groupIds, ['alpha', 'beta', 'gamma', 'delta']);
  const built = buildBranchSelection(workflow, preview, { identifier: identifiers() }); assert.deepEqual(validateWorkflowGraph(built.workflow), []);
});

test('building inside a condition branch preserves its false port and every unrelated branch edge', () => {
  const workflow = branchFixture(), before = structuredClone(workflow);
  const preview = previewBranchSelection(workflow, 'pre', ['gamma', 'alpha', 'beta']); assert.equal(preview.valid, true);
  const built = buildBranchSelection(workflow, preview, { identifier: identifiers() });
  assert.deepEqual(built.workflow.graph!.pre.edges.find(edge => edge.id === 'no'), { ...before.graph!.pre.edges.find(edge => edge.id === 'no')!, to: `control:${built.splitId}` });
  for (const edge of before.graph!.pre.edges.filter(edge => !preview.replacedEdgeIds.includes(edge.id))) assert.deepEqual(built.workflow.graph!.pre.edges.find(item => item.id === edge.id), edge);
  assert.deepEqual(built.workflow.graph!.post, before.graph!.post); assert.deepEqual(built.workflow.layout, before.layout); assert.deepEqual(workflow, before); assert.deepEqual(validateWorkflowGraph(built.workflow), []);
});

test('condition construction remains exactly two checks and previews its real true and false assignments', () => {
  const workflow = fixture();
  assert.equal(previewBranchSelection(workflow, 'pre', ['alpha', 'beta', 'gamma'], 'condition').valid, false);
  const preview = previewBranchSelection(workflow, 'pre', ['beta', 'alpha'], 'condition'); assert.deepEqual(preview.groupIds, ['alpha', 'beta']);
  const built = buildBranchSelection(workflow, preview, { condition: { operator: 'contains', value: '배송' }, identifier: identifiers() });
  const outgoing = built.workflow.graph!.pre.edges.filter(edge => edge.from === `control:${built.splitId}`);
  assert.deepEqual(outgoing.map(edge => [edge.port, edge.to]), [['true', 'group:alpha'], ['false', 'group:beta']]); assert.deepEqual(validateWorkflowGraph(built.workflow), []);
  assert.throws(() => buildBranchSelection(workflow, preview, { condition: { operator: 'contains', value: '' }, identifier: identifiers() }), /문구/);
});

test('eligibility rejects wrong counts, nonconsecutive, cross-stage, duplicate, required and noncheck selections', () => {
  const workflow = fixture();
  for (const ids of [[], ['alpha'], ['alpha', 'beta', 'gamma', 'delta', 'after'], ['alpha', 'gamma'], ['alpha', 'post-only'], ['alpha', 'alpha'], ['alpha', 'missing'], ['alpha', 'control:choice']]) assert.equal(previewBranchSelection(workflow, 'pre', ids).valid, false, JSON.stringify(ids));
  workflow.pre[1].required = true; const before = structuredClone(workflow);
  assert.match(previewBranchSelection(workflow, 'pre', ['alpha', 'beta']).reason || '', /필수/); assert.deepEqual(workflow, before);
  const branched = branchFixture(); assert.equal(previewBranchSelection(branched, 'pre', ['alpha', 'other-branch']).valid, false);
});

test('dynamic capacity counts two controls and count plus one additional edges', () => {
  const workflow = fixture(); workflow.graph = { version: 1, pre: createStageGraph(workflow.pre), post: createStageGraph(workflow.post) };
  workflow.graph.pre.nodes = Array.from({ length: 11 }, (_, index) => ({ id: `control-${index}`, name: `기존 제어 ${index}`, kind: 'join' }));
  assert.match(previewBranchSelection(workflow, 'pre', ['alpha', 'beta']).reason || '', /12/);
  workflow.graph.pre.nodes = [];
  while (workflow.graph.pre.edges.length < 60) workflow.graph.pre.edges.push({ id: `unrelated-${workflow.graph.pre.edges.length}`, from: 'unknown', to: 'end' });
  assert.match(previewBranchSelection(workflow, 'pre', ['alpha', 'beta', 'gamma', 'delta']).reason || '', /5개.*64/);
  const allowed = previewBranchSelection(workflow, 'pre', ['alpha', 'beta', 'gamma']); assert.equal(allowed.valid, true);
  const built = buildBranchSelection(workflow, allowed, { identifier: identifiers() }); assert.equal(built.workflow.graph!.pre.edges.length, 64);
});

test('stale execution structure and required-setting changes are rejected but layout-only changes are allowed', () => {
  const workflow = fixture(), preview = previewBranchSelection(workflow, 'pre', ['alpha', 'beta']);
  const moved = structuredClone(workflow); moved.layout!.positions.input.x = 250;
  assert.equal(buildBranchSelection(moved, preview, { identifier: identifiers() }).workflow.layout!.positions.input.x, 250);
  for (const changed of [{ ...structuredClone(workflow), id: 'other' }, { ...structuredClone(workflow), post: [] }]) assert.throws(() => buildBranchSelection(changed, preview, { identifier: identifiers() }), /변경/);
  const required = structuredClone(workflow); required.pre[0].required = true;
  assert.throws(() => buildBranchSelection(required, preview, { identifier: identifiers() }), /필수/);
});

test('unrelated incomplete draft issues survive a valid selected segment transformation', () => {
  const workflow = fixture(); workflow.graph = { version: 1, pre: createStageGraph(workflow.pre), post: { nodes: [], edges: [] } };
  workflow.graph.pre.edges = workflow.graph.pre.edges.filter(edge => edge.from !== 'group:after');
  const before = structuredClone(workflow), preview = previewBranchSelection(workflow, 'pre', ['alpha', 'beta', 'gamma']); assert.equal(preview.valid, true);
  const built = buildBranchSelection(workflow, preview, { identifier: identifiers() });
  assert.deepEqual(validateWorkflowGraph(built.workflow).sort(), validateWorkflowGraph(workflow).sort()); assert.deepEqual(built.workflow.graph!.post, workflow.graph.post); assert.deepEqual(workflow, before);
});

test('malformed duplicate edge IDs and exhausted generated identifiers cannot partially mutate a draft', () => {
  const workflow = fixture(), preview = previewBranchSelection(workflow, 'pre', ['alpha', 'beta']), before = structuredClone(workflow);
  assert.throws(() => buildBranchSelection(workflow, preview, { identifier: () => 'alpha' }), /ID/); assert.deepEqual(workflow, before);
  workflow.graph = { version: 1, pre: createStageGraph(workflow.pre), post: createStageGraph(workflow.post) };
  workflow.graph.pre.edges[2].id = workflow.graph.pre.edges[1].id;
  assert.match(previewBranchSelection(workflow, 'pre', ['alpha', 'beta']).reason || '', /ID/);
});
