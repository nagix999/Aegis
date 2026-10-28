import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { initialState } from '../lib/aegis-seed.ts';
import { applyDatasetRuleMappings, suggestDatasetRuleMappings } from '../lib/dataset-compatibility.ts';
import { configurationFingerprint, datasetFingerprint } from '../lib/workflow-review.ts';

const source = await readFile(new URL('../components/dataset-preflight.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('dataset-preflight.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'DatasetPreflightPanel');
const names = ['setSavingState', 'closeMapping', 'prepareMapping', 'createMappedCopy'];
const chunks = names.map(name => {
  const node = component.body.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `Production handler ${name} exists`);
  return node.getText(tree);
});
const copyName = tree.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === 'copyName'));
chunks.unshift(copyName.getText(tree));
const readonlyEffect = component.body.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'useEffect'
  && node.expression.arguments[1]?.getText(tree).includes('writable, mappingOpen'));
assert.ok(readonlyEffect, 'Production permission-change effect exists');
chunks.push('const runReadonlyEffect=' + readonlyEffect.expression.arguments[0].getText(tree) + ';');
const expression = name => {
  const statement = component.body.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === name));
  assert.ok(statement, `Production value ${name} exists`);
  return statement.declarationList.declarations.find(declaration => declaration.name.getText(tree) === name).initializer.getText(tree);
};
const code = ts.transpileModule(chunks.join('\n') + '\nglobalThis.actions={' + [...names, 'runReadonlyEffect'].join(',') + '};', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const app = initialState();
  const oldRule = { id: 'source-rule', name: '개인정보 검사', description: '', kind: 'keyword', enabled: true, config: { pattern: 'private' } };
  const original = { ...structuredClone(app.workflows[0]), id: 'source-workflow', pre: [{ id: 'source-group', name: '개인정보 검사', mode: 'any', rules: [oldRule] }], post: [], graph: undefined };
  const workflow = { ...structuredClone(original), id: 'target-workflow', name: '복제 워크플로우', alias: 'target', pre: [{ id: 'target-group', name: '개인정보 검사', mode: 'any', rules: [{ ...structuredClone(oldRule), id: 'target-rule' }] }] };
  const dataset = { id: 'source-dataset', name: '원본 검증 데이터', description: '원본 보존 확인', rows: [{ id: 'source-row', input: '  PRIVATE_REQUEST_DO_NOT_SEND_IN_MAPPING  ', expected: 'block', expectedStage: 'pre', expectedRuleId: oldRule.id, category: '개인정보', note: '원래 판단 근거' }] };
  app.workflows = [original, workflow]; app.datasets = [dataset]; app.role = 'admin';
  const calls = [], mapped = [], busyChanges = [];
  const values = {
    applyDatasetRuleMappings, suggestDatasetRuleMappings, configurationFingerprint, datasetFingerprint,
    structuredClone, Object, Boolean, Error, Promise,
    useMemo: callback => callback(), state: app, dataset, workflow, connections: app.connections,
    target: 'draft', actualTargetLabel: '현재 초안', contextKey: 'source-target-context',
    latestContext: { current: 'source-target-context' }, latestWritable: { current: true },
    readOnly: false, busy: false, mappingDisabledReason: undefined,
    review: undefined, name: '', mappings: {}, reviewing: false, saving: false, mappingOpen: false, mappingError: '', created: undefined,
    request: { current: 0 }, mounted: { current: true }, openRef: { current: false }, savingRef: { current: false },
    busyCallback: { current: value => busyChanges.push(value) }, mappedCallback: { current: id => mapped.push(id) },
    async act(payload) {
      const received = plain(payload); calls.push(received);
      const copied = { ...applyDatasetRuleMappings(dataset, workflow, received.mappings), id: 'new-dataset', name: received.name, rows: dataset.rows.map(row => ({ ...row, id: 'new-row', expectedRuleId: 'target-rule' })) };
      return { dataset: copied, state: { ...app, datasets: [...app.datasets, copied] } };
    },
  };
  const setters = { setReview: 'review', setName: 'name', setMappings: 'mappings', setReviewing: 'reviewing', setSaving: 'saving', setMappingOpen: 'mappingOpen', setMappingError: 'mappingError', setCreated: 'created' };
  for (const [setter, key] of Object.entries(setters)) values[setter] = value => { values[key] = typeof value === 'function' ? value(values[key]) : value; };
  let context;
  for (const name of ['writable', 'staleReview', 'atLimit', 'remaining', 'validationError', 'canCreate']) {
    const code = ts.transpileModule('globalThis.result=(' + expression(name) + ');', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    Object.defineProperty(values, name, { get() { vm.runInContext(code, context); return values.result; } });
  }
  context = vm.createContext(values); vm.runInContext(code, context);
  return { values, actions: context.actions, calls, mapped, busyChanges };
}

test('opening a mapping review captures independent source and target snapshots without writing data', async () => {
  const f = fixture(), original = structuredClone(f.values.dataset);
  const opening = f.actions.prepareMapping();
  assert.equal(f.calls.length, 0); assert.equal(f.values.reviewing, true);
  await opening;
  assert.equal(f.values.reviewing, false); assert.equal(f.values.mappingOpen, true);
  assert.equal(f.values.review.dataset.id, original.id); assert.equal(f.values.review.targetLabel, '현재 초안');
  assert.equal(f.values.mappings['source-rule'], 'target-rule'); assert.ok(f.values.review.datasetFingerprint);
  f.values.dataset.rows[0].input = 'changed afterward'; f.values.workflow.pre[0].rules[0].name = 'changed afterward';
  assert.equal(f.values.review.dataset.rows[0].input, original.rows[0].input);
  assert.equal(f.values.review.workflow.pre[0].rules[0].name, '개인정보 검사'); assert.equal(f.calls.length, 0);
});

test('explicit creation sends reviewed fingerprints and mapping IDs while preserving the original dataset', async () => {
  const f = fixture(), original = structuredClone(f.values.dataset);
  await f.actions.prepareMapping(); const reviewed = f.values.review;
  await f.actions.createMappedCopy();
  assert.equal(f.calls.length, 1); const payload = f.calls[0];
  assert.equal(payload.action, 'create_mapped_dataset'); assert.equal(payload.sourceDatasetId, original.id);
  assert.equal(payload.workflowId, f.values.workflow.id); assert.equal(payload.target, 'draft');
  assert.equal(payload.expectedDatasetFingerprint, reviewed.datasetFingerprint);
  assert.equal(payload.expectedWorkflowFingerprint, reviewed.workflowFingerprint);
  assert.deepEqual(payload.mappings, { 'source-rule': 'target-rule' });
  assert.ok(!JSON.stringify(payload).includes('PRIVATE_REQUEST_DO_NOT_SEND_IN_MAPPING'));
  assert.deepEqual(f.values.dataset, original); assert.deepEqual(f.mapped, ['new-dataset']);
  assert.equal(f.values.mappingOpen, false); assert.equal(f.values.saving, false);
  assert.equal(f.busyChanges[0], true); assert.equal(f.busyChanges.at(-1), false);
});

test('stale context, read-only access and unresolved choices prevent creation before any API call', async () => {
  for (const reason of ['stale', 'readonly', 'unresolved', 'unsaved']) {
    const f = fixture(); await f.actions.prepareMapping();
    if (reason === 'stale') { f.values.contextKey = 'another-target'; f.values.latestContext.current = 'another-target'; }
    if (reason === 'readonly') { f.values.state.role = 'viewer'; f.values.latestWritable.current = false; }
    if (reason === 'unresolved') f.values.mappings = {};
    if (reason === 'unsaved') f.values.mappingDisabledReason = '먼저 원본 변경 내용을 저장하세요.';
    await f.actions.createMappedCopy(); assert.equal(f.calls.length, 0, reason);
  }
});

test('a server failure remains inline and does not fabricate a copy or trigger selection', async () => {
  const f = fixture(); await f.actions.prepareMapping();
  f.values.act = async payload => { f.calls.push(payload); return undefined; };
  await f.actions.createMappedCopy();
  assert.equal(f.calls.length, 1); assert.match(f.values.mappingError, /저장하지 못했습니다/);
  assert.equal(f.values.created, undefined); assert.equal(f.values.mappingOpen, true);
  assert.deepEqual(f.mapped, []); assert.equal(f.values.saving, false); assert.equal(f.busyChanges.at(-1), false);
});

test('a completed copy is retained without changing selection when context changes during the request', async () => {
  const f = fixture(); await f.actions.prepareMapping();
  const response = deferred(); f.values.act = async payload => { f.calls.push(payload); return response.promise; };
  const saving = f.actions.createMappedCopy(); assert.equal(f.values.saving, true);
  f.values.contextKey = 'another-workflow'; f.values.latestContext.current = 'another-workflow';
  const copied = { ...structuredClone(f.values.dataset), id: 'saved-after-change' };
  response.resolve({ dataset: copied, state: f.values.state }); await saving;
  assert.equal(f.values.created.id, copied.id); assert.match(f.values.mappingError, /자동으로 열지 않았습니다/);
  assert.deepEqual(f.mapped, []); assert.equal(f.values.mappingOpen, true); assert.equal(f.values.saving, false);
  await f.actions.createMappedCopy(); assert.equal(f.calls.length, 1, 'A retained created copy cannot be submitted twice.');
});

test('a read-only role change during the request never auto-opens the returned copy', async () => {
  const f = fixture(); await f.actions.prepareMapping();
  const response = deferred(); f.values.act = async () => response.promise;
  const saving = f.actions.createMappedCopy(); f.values.state.role = 'viewer'; f.values.latestWritable.current = false;
  response.resolve({ dataset: { ...f.values.dataset, id: 'created-before-role-update' }, state: f.values.state }); await saving;
  f.actions.runReadonlyEffect();
  assert.deepEqual(f.mapped, []); assert.equal(f.values.created.id, 'created-before-role-update'); assert.equal(f.values.saving, false);
  assert.equal(f.values.mappingOpen, true, 'The saved copy remains visible after the permission-change effect.');
});

test('a permission change closes an unfinished review when no copy has been saved', async () => {
  const f = fixture(); await f.actions.prepareMapping();
  f.values.state.role = 'viewer'; f.values.latestWritable.current = false;
  f.actions.runReadonlyEffect();
  assert.equal(f.values.mappingOpen, false); assert.equal(f.values.review, undefined); assert.equal(f.values.openRef.current, false);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.mapped, []);
});

test('closing or reopening a review discards late fingerprint responses from the earlier review', async () => {
  const f = fixture(), oldHash = deferred(), currentHash = deferred();
  let calls = 0; f.values.datasetFingerprint = () => (++calls === 1 ? oldHash.promise : currentHash.promise);
  const first = f.actions.prepareMapping(); f.actions.closeMapping();
  f.values.dataset = { ...f.values.dataset, id: 'current-source', name: '현재 데이터셋' };
  f.values.contextKey = 'current-context'; f.values.latestContext.current = 'current-context';
  const second = f.actions.prepareMapping(); currentHash.resolve('current-data-hash'); await second;
  oldHash.resolve('old-data-hash'); await first;
  assert.equal(f.values.review.dataset.id, 'current-source'); assert.equal(f.values.review.datasetFingerprint, 'current-data-hash');
  assert.equal(f.values.review.contextKey, 'current-context'); assert.equal(f.values.reviewing, false); assert.equal(f.calls.length, 0);
});

test('closing a review cannot interrupt a save or erase the captured result before it finishes', async () => {
  const f = fixture(); await f.actions.prepareMapping();
  const response = deferred(); f.values.act = async () => response.promise;
  const saving = f.actions.createMappedCopy(); f.actions.closeMapping();
  assert.equal(f.values.mappingOpen, true); assert.ok(f.values.review);
  response.resolve(undefined); await saving;
  assert.equal(f.values.mappingOpen, true); f.actions.closeMapping(); assert.equal(f.values.mappingOpen, false);
  assert.equal(f.values.review, undefined); assert.equal(f.values.savingRef.current, false);
});
