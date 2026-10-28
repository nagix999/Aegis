import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { initialState } from '../lib/aegis-seed.ts';
import { nodeDefinitions, visibleLayoutKey } from '../lib/workflow-layout.ts';
import { createStageGraph, getStageGraph } from '../lib/workflow-graph.ts';
import { previewBranchSelection } from '../lib/workflow-branching.ts';
import { configurationFingerprint } from '../lib/workflow-review.ts';

// Exercise the event handlers shipped by the editor, without duplicating their logic.
const source = await readFile(new URL('../components/workflow-editor.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('workflow-editor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'WorkflowEditor');
assert.ok(component);
const helperNames = ['selectedBranchPreview', 'findRule', 'findGroup', 'findControl'];
const actionNames = ['openGraph', 'buildBranch', 'resetInspectorForNode', 'searchSelectNode'];
const declaration = (statements, name) => {
  const node = statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `Actual editor function ${name} exists`);
  return node.getText(tree);
};
const code = ts.transpileModule([
  ...helperNames.map(name => declaration(tree.statements, name)),
  ...actionNames.map(name => declaration(component.body.statements, name)),
  `globalThis.reviewActions = { selectedBranchPreview, ${actionNames.join(', ')} };`,
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function check(id) {
  return { id: `g${id}`, name: `검사 ${id}`, mode: 'any', rules: [{ id: `r${id}`, name: `검사 ${id}`, kind: 'length', description: '', enabled: true, config: { maxLength: 4000 } }] };
}
function fixture() {
  const app = initialState();
  const workflow = structuredClone(app.workflows[0]);
  workflow.pre = [1, 2, 3, 4, 5].map(check);
  workflow.post = [check('post1'), check('post2')];
  // Persistence order and click order intentionally differ from execution order.
  const endpoints = ['start', 'group:g3', 'group:g1', 'group:g4', 'group:g2', 'group:g5', 'end'];
  workflow.graph = { version: 1, pre: { nodes: [], edges: endpoints.slice(0, -1).map((from, index) => ({ id: `pre-${index}`, from, to: endpoints[index + 1], port: 'next' })) }, post: createStageGraph(workflow.post) };
  workflow.layout = { version: 1, positions: { 'rule:r1': { x: 400, y: 80 }, 'rule:r3': { x: 120, y: 80 } }, zones: [{ id: 'visual', name: '요청 확인', color: 'blue', nodeKeys: ['rule:r1', 'rule:r3'], x: 80, y: 20, width: 520, height: 240 }] };
  const notices = [];
  const inspectorScrollElement = { scrollTop: 0 };
  let sequence = 0;
  const state = {
    workflow, nodeDefinitions, visibleLayoutKey, getStageGraph, previewBranchSelection,
    editingDisabled: false, narrowPanel: false, selectedKeys: ['rule:r2', 'rule:r4', 'rule:r1', 'rule:r3'],
    selection: { kind: 'main' }, panelMode: 'workflow', graphStage: 'pre',
    graphControlId: 'old-control', graphEdgeId: 'old-edge', initialPreset: undefined,
    inspectorOpen: false, library: undefined, view: 'builder', activeStage: 'pre',
    inspectorScroll: { current: 0 }, inspectorScrollElement,
    inspectorRef: { current: { querySelector(selector) { return selector === '.we-inspector-scroll' ? inspectorScrollElement : null; }, focus() {} } }, zones: workflow.layout.zones,
    id(prefix) { return `${prefix}-${++sequence}`; },
    requestAnimationFrame(callback) { callback(); },
    notify(message) { notices.push(message); },
  };
  const setters = { setInitialPreset: 'initialPreset', setGraphStage: 'graphStage', setPanelMode: 'panelMode', setLibrary: 'library', setInspectorOpen: 'inspectorOpen', setView: 'view', setGraphControlId: 'graphControlId', setGraphEdgeId: 'graphEdgeId', setSelection: 'selection', setSelectedKeys: 'selectedKeys' };
  for (const [setter, property] of Object.entries(setters)) state[setter] = value => { state[property] = typeof value === 'function' ? value(state[property]) : value; };
  const context = vm.createContext(state);
  vm.runInContext(code, context);
  return { state, actions: context.reviewActions, notices, connections: app.connections };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('four selected checks use execution order and open a prefilled panel without changing the graph', () => {
  const f = fixture(), before = structuredClone(f.state.workflow);
  const preview = f.actions.selectedBranchPreview(f.state.workflow, f.state.selectedKeys, 'parallel');
  assert.equal(preview.valid, true);
  assert.deepEqual(plain(preview.groupIds), ['g3', 'g1', 'g4', 'g2']);
  f.actions.buildBranch('parallel');
  assert.equal(f.state.panelMode, 'graph');
  assert.equal(f.state.graphStage, 'pre');
  assert.equal(f.state.inspectorOpen, true);
  assert.deepEqual(plain(f.state.initialPreset.groupIds), ['g3', 'g1', 'g4', 'g2']);
  assert.equal(f.state.initialPreset.firstGroupId, 'g3');
  assert.equal(f.state.initialPreset.secondGroupId, 'g1');
  assert.deepEqual(f.state.workflow, before, 'Confirming the panel is a separate action');
  assert.deepEqual(f.notices, []);
});

test('invalid node counts, node kinds, stages and disconnected selections explain why before opening a branch panel', () => {
  const cases = [
    ['one check', ['rule:r1'], /2~4/],
    ['five checks', ['rule:r1', 'rule:r2', 'rule:r3', 'rule:r4', 'rule:r5'], /2~4/],
    ['input boundary', ['input', 'rule:r1'], /검사 노드만/],
    ['main model', ['main', 'rule:r1'], /검사 노드만/],
    ['cross stage', ['rule:r1', 'rule:rpost1'], /같은 검사 구간/],
    ['nonconsecutive', ['rule:r3', 'rule:r4'], /바로 이어진/],
    ['deleted node', ['rule:r1', 'rule:deleted'], /2~4/],
  ];
  for (const [label, keys, reason] of cases) {
    const f = fixture(), before = structuredClone(f.state.workflow);
    const preview = f.actions.selectedBranchPreview(f.state.workflow, keys, 'parallel');
    assert.equal(preview.valid, false, label); assert.match(preview.reason, reason, label);
    f.actions.buildBranch('parallel', keys);
    assert.equal(f.state.initialPreset, undefined, label); assert.equal(f.state.panelMode, 'workflow', label);
    assert.match(f.notices.at(-1), reason, label); assert.deepEqual(f.state.workflow, before, label);
  }
});

test('required checks and exhausted control capacity block the editor branch action with its eligibility reason', () => {
  for (const kind of ['required', 'capacity']) {
    const f = fixture();
    if (kind === 'required') f.state.workflow.pre.find(group => group.id === 'g1').required = true;
    else f.state.workflow.graph.pre.nodes = Array.from({ length: 11 }, (_, index) => ({ id: `control-${index}`, name: `합류 ${index}`, kind: 'join' }));
    const before = structuredClone(f.state.workflow);
    const preview = f.actions.selectedBranchPreview(f.state.workflow, ['rule:r3', 'rule:r1'], 'parallel');
    assert.equal(preview.valid, false); assert.match(preview.reason, kind === 'required' ? /필수 실행/ : /12개/);
    f.actions.buildBranch('parallel', ['rule:r3', 'rule:r1']);
    assert.equal(f.state.initialPreset, undefined); assert.equal(f.notices.at(-1), preview.reason); assert.deepEqual(f.state.workflow, before);
  }
});

test('a deleted key left in multi-selection does not disable the remaining valid consecutive checks', () => {
  const f = fixture();
  const keys = ['rule:r1', 'rule:deleted', 'rule:r3'];
  const before = structuredClone(f.state.workflow);
  const preview = f.actions.selectedBranchPreview(f.state.workflow, keys, 'parallel');
  assert.equal(preview.valid, true);
  assert.deepEqual(plain(preview.groupIds), ['g3', 'g1']);
  f.actions.buildBranch('parallel', keys);
  assert.deepEqual(plain(f.state.initialPreset.groupIds), ['g3', 'g1']);
  assert.deepEqual(f.notices, []); assert.deepEqual(f.state.workflow, before);
  assert.equal(previewBranchSelection(f.state.workflow, 'pre', ['g1', 'deleted'], 'parallel').valid, false, 'The graph helper still rejects an unknown execution group');
});

test('condition selection remains exactly two checks and aliases cannot count the same node twice', () => {
  const f = fixture();
  assert.equal(f.actions.selectedBranchPreview(f.state.workflow, f.state.selectedKeys, 'condition').valid, false);
  f.actions.buildBranch('condition', ['rule:r1', 'rule:r3']);
  assert.equal(f.state.initialPreset.kind, 'condition');
  assert.deepEqual(plain(f.state.initialPreset.groupIds), ['g3', 'g1']);
  const repeated = f.actions.selectedBranchPreview(f.state.workflow, ['group:g1', 'rule:r1'], 'parallel');
  assert.equal(repeated.valid, false); assert.match(repeated.reason, /2~4/);
});

test('readonly branch actions do nothing while search still opens inspector settings', () => {
  const f = fixture(), before = structuredClone(f.state.workflow);
  f.state.editingDisabled = true;
  f.actions.buildBranch('parallel');
  assert.equal(f.state.initialPreset, undefined); assert.deepEqual(f.notices, []);
  f.actions.searchSelectNode({ kind: 'rule', id: 'r1' });
  assert.deepEqual(plain(f.state.selection), { kind: 'rule', id: 'r1' });
  assert.equal(f.state.panelMode, 'node'); assert.equal(f.state.inspectorOpen, true);
  assert.deepEqual(f.state.workflow, before);
});

test('searching singleton and compound checks preserves picked nodes, layout and execution evidence', async () => {
  const f = fixture();
  f.state.workflow.pre.find(group => group.id === 'g2').rules.push({ id: 'r2b', name: '조합 내부 검사', kind: 'keyword', description: '', enabled: true, config: { pattern: '금지' } });
  const before = structuredClone(f.state.workflow), picked = [...f.state.selectedKeys];
  const fingerprint = await configurationFingerprint(f.state.workflow, f.connections);
  f.actions.searchSelectNode({ kind: 'group', id: 'g1' });
  assert.deepEqual(plain(f.state.selection), { kind: 'rule', id: 'r1' });
  f.actions.searchSelectNode({ kind: 'group', id: 'g2' });
  assert.deepEqual(plain(f.state.selection), { kind: 'group', id: 'g2' });
  assert.equal(f.state.panelMode, 'node'); assert.deepEqual(f.state.selectedKeys, picked);
  assert.deepEqual(f.state.workflow, before);
  assert.equal(await configurationFingerprint(f.state.workflow, f.connections), fingerprint);
});

test('search result navigation opens control and boundary inspectors without losing multi-selection', () => {
  const f = fixture(), picked = [...f.state.selectedKeys];
  f.state.workflow.graph.post.nodes.push({ id: 'response-route', kind: 'condition', name: '응답 분기', condition: { operator: 'contains', value: '확인' } });
  const before = structuredClone(f.state.workflow);
  f.actions.searchSelectNode({ kind: 'control', id: 'response-route' });
  assert.equal(f.state.graphStage, 'post'); assert.equal(f.state.graphControlId, 'response-route');
  assert.equal(f.state.graphEdgeId, undefined); assert.equal(f.state.panelMode, 'graph');
  for (const kind of ['input', 'main', 'output']) {
    f.actions.searchSelectNode({ kind });
    assert.deepEqual(plain(f.state.selection), { kind }); assert.equal(f.state.panelMode, 'node');
  }
  assert.deepEqual(f.state.selectedKeys, picked); assert.deepEqual(f.state.workflow, before);
});

test('search results for deleted groups, rules, controls and areas are ignored', () => {
  const f = fixture(), before = { selection: structuredClone(f.state.selection), panel: f.state.panelMode, picked: [...f.state.selectedKeys], workflow: structuredClone(f.state.workflow) };
  for (const kind of ['group', 'rule', 'control', 'zone']) f.actions.searchSelectNode({ kind, id: 'deleted' });
  assert.deepEqual(f.state.selection, before.selection); assert.equal(f.state.panelMode, before.panel);
  assert.equal(f.state.inspectorOpen, false); assert.deepEqual(f.state.selectedKeys, before.picked);
  assert.deepEqual(f.state.workflow, before.workflow);
});

test('searching a different node resets the visible and remembered inspector scroll', () => {
  const f = fixture(), before = structuredClone(f.state.workflow), picked = [...f.state.selectedKeys];
  for (const target of [{ kind: 'rule', id: 'r1' }, { kind: 'rule', id: 'r2' }, { kind: 'output' }]) {
    f.state.inspectorScroll.current = 480;
    f.state.inspectorScrollElement.scrollTop = 480;
    f.actions.searchSelectNode(target);
    assert.deepEqual(plain(f.state.selection), target);
    assert.equal(f.state.inspectorScroll.current, 0, 'Session scroll starts at the new node header');
    assert.equal(f.state.inspectorScrollElement.scrollTop, 0, 'Visible settings start at the new node header');
  }
  assert.deepEqual(f.state.selectedKeys, picked);
  assert.deepEqual(f.state.workflow, before);
});

test('searching the same node or its singleton group alias preserves the current inspector scroll', () => {
  const f = fixture(), before = structuredClone(f.state.workflow);
  for (const [current, target] of [
    [{ kind: 'main' }, { kind: 'main' }],
    [{ kind: 'rule', id: 'r1' }, { kind: 'rule', id: 'r1' }],
    [{ kind: 'rule', id: 'r1' }, { kind: 'group', id: 'g1' }],
  ]) {
    f.state.selection = current;
    f.state.inspectorScroll.current = 320;
    f.state.inspectorScrollElement.scrollTop = 320;
    f.actions.searchSelectNode(target);
    assert.deepEqual(plain(f.state.selection), current);
    assert.equal(f.state.inspectorScroll.current, 320, 'Remembered scroll survives selecting the same node');
    assert.equal(f.state.inspectorScrollElement.scrollTop, 320, 'Visible settings keep their position');
  }
  assert.deepEqual(f.state.workflow, before);
});
