import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { initialState } from '../lib/aegis-seed.ts';
import { validateWorkflow } from '../lib/aegis-engine.ts';
import { executionConfiguration } from '../lib/workflow-review.ts';

const source = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('app/page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'AegisConsole');
const action = component.body.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === 'prepareWorkflowExecution'));
assert.ok(action);
const code = ts.transpileModule(action.getText(tree) + '\nglobalThis.prepare = prepareWorkflowExecution;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture() {
  const state = initialState(), draft = structuredClone(state.workflows[0]), saved = [], notices = [];
  const context = { state, draft, dirty: false, busy: false, loading: false, connected: true, structuredClone, validateWorkflow, executionConfiguration,
    activeDraftId: { current: draft.id }, drafts: { current: new Map([[draft.id, { draft }]]) },
    notify: message => notices.push(message),
    async save(candidate) { saved.push(candidate); context.drafts.current.set(candidate.id, { draft: structuredClone(candidate) }); return true; },
  };
  vm.runInContext(code, vm.createContext(context));
  return { context, saved, notices, prepare: context.prepare };
}

test('local execution prepares a dirty valid draft without navigating out of the editor', async () => {
  const f = fixture(); f.context.dirty = true;
  assert.equal(await f.prepare(), true); assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].id, f.context.draft.id); assert.equal(f.context.activeDraftId.current, f.context.draft.id);
});
test('readonly, disconnected, busy and invalid graph cannot prepare an execution', async () => {
  for (const option of ['viewer', 'disconnected', 'busy', 'invalid']) {
    const f = fixture(); f.context.dirty = true;
    if (option === 'viewer') f.context.state.role = 'viewer';
    if (option === 'disconnected') f.context.connected = false;
    if (option === 'busy') f.context.busy = true;
    if (option === 'invalid') f.context.draft.graph = { version: 1, pre: { nodes: [], edges: [] }, post: { nodes: [], edges: [] } };
    assert.equal(await f.prepare(), false); assert.equal(f.saved.length, 0);
  }
});
test('failed saving or a newer execution configuration prevents a stale launch', async () => {
  const failed = fixture(); failed.context.dirty = true; failed.context.save = async () => false;
  assert.equal(await failed.prepare(), false);
  const changed = fixture(); changed.context.dirty = true;
  changed.context.save = async candidate => { changed.context.drafts.current.set(candidate.id, { draft: { ...candidate, mainConnectionId: 'newer-model' } }); return true; };
  assert.equal(await changed.prepare(), false); assert.equal(changed.notices.length, 1);
  const switched = fixture(); switched.context.dirty = true;
  switched.context.save = async () => { switched.context.activeDraftId.current = 'another-workflow'; return true; };
  assert.equal(await switched.prepare(), false);
});
test('moving nodes and changing display zones cannot invalidate execution preparation', async () => {
  const f = fixture(); f.context.dirty = true;
  f.context.save = async candidate => { f.context.drafts.current.set(candidate.id, { draft: { ...candidate, updatedAt: 'newer', layout: { version: 1, positions: { main: { x: 1000, y: 400 } }, zones: [] } } }); return true; };
  assert.equal(await f.prepare(), true);
});
