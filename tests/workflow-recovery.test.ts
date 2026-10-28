import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { clearWorkflowRecovery, isRecoverableWorkflow, MAX_WORKFLOW_RECOVERIES, MAX_WORKFLOW_RECOVERY_BYTES, readWorkflowRecovery, recoveryBaselineChanged, removeWorkflowRecovery, repairWorkflowRecovery, saveWorkflowRecovery, WORKFLOW_RECOVERY_KEY, workflowRecoveryEqual } from '../lib/workflow-recovery.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { initialState } from '../lib/aegis-seed.ts';
import type { Workflow } from '../lib/aegis-types';
import type { RecoveryStorage } from '../lib/workflow-recovery';

const now = '2026-10-25T06:00:00.000Z';
function fixture(): Workflow { return structuredClone(initialState().workflows[0]); }
function memory(): RecoveryStorage & { data: Map<string, string>; denyRead: boolean; denyWrite: boolean; denyRemove: boolean } {
  return { data: new Map(), denyRead: false, denyWrite: false, denyRemove: false,
    getItem(key) { if (this.denyRead) throw Error('blocked'); return this.data.get(key) ?? null; },
    setItem(key, value) { if (this.denyWrite) throw Error('quota'); this.data.set(key, value); },
    removeItem(key) { if (this.denyRemove) throw Error('blocked'); this.data.delete(key); },
  };
}

test('incomplete working graphs and empty text survive save and a new read without mutating source', () => {
  const storage = memory(), base = fixture(), draft = structuredClone(base);
  draft.name = ''; draft.alias = ''; draft.mainConnectionId = '';
  draft.pre[0].name = ''; draft.pre[0].rules[0].name = ''; draft.pre[0].rules[0].config.pattern = '';
  draft.pre[0].rules[0].config.requiredKeys = ['']; draft.pre[0].rules[0].config.maxLength = 0;
  draft.graph = { version: 1, pre: { nodes: [{ id: 'unfinished', kind: 'condition', name: '', condition: { operator: 'contains', value: '' } }], edges: [{ id: 'pending', from: 'start', to: 'group:missing', port: 'next' }] }, post: { nodes: [], edges: [] } };
  const original = structuredClone(draft);
  const saved = saveWorkflowRecovery(storage, draft, base, now);
  assert.equal(saved.ok, true); assert.deepEqual(saved.records[0].draft, original); assert.deepEqual(draft, original);
  draft.description = '후속 입력'; saved.records[0].draft.description = '호출자 변경';
  const reloaded = readWorkflowRecovery(storage);
  assert.equal(reloaded.ok, true); assert.equal(reloaded.records[0].draft.description, original.description);
  assert.deepEqual(reloaded.records[0].base, base); assert.equal(reloaded.records[0].savedAt, now);
});

test('multiple workflows retain independent bases and replace only their own temporary copy', () => {
  const storage = memory(), first = fixture(), second = { ...fixture(), id: 'second' };
  assert.equal(saveWorkflowRecovery(storage, { ...first, description: '첫 초안' }, first, now).ok, true);
  assert.equal(saveWorkflowRecovery(storage, { ...second, description: '둘째 초안' }, second, now).ok, true);
  const result = saveWorkflowRecovery(storage, { ...first, description: '첫 초안 변경' }, first, now);
  assert.equal(result.records.length, 2); assert.equal(result.records[0].workflowId, first.id);
  assert.equal(result.records.find(item => item.workflowId === second.id)!.draft.description, '둘째 초안');
  assert.deepEqual(result.records.find(item => item.workflowId === first.id)!.base, first);
});

test('baseline comparison ignores timestamps and object key order but includes visual layout and execution settings', () => {
  const base = fixture(), storage = memory();
  const record = saveWorkflowRecovery(storage, { ...base, description: '작업 중' }, base, now).records[0];
  const current = { ...base, updatedAt: '2026-10-26T00:00:00Z' };
  assert.equal(recoveryBaselineChanged(record, current), false);
  const reversed = Object.fromEntries(Object.entries(base).reverse()) as Workflow;
  assert.equal(workflowRecoveryEqual(base, reversed), true);
  assert.equal(recoveryBaselineChanged(record, { ...current, alias: 'changed-model' }), true);
  assert.equal(recoveryBaselineChanged(record, { ...current, layout: { version: 1, positions: { input: { x: 500, y: 500 } } } }), true);
  assert.equal(recoveryBaselineChanged(record, { ...current, id: 'other' }), true);
  assert.equal(recoveryBaselineChanged(record, undefined), true);
});

test('malformed and oversized envelopes are not overwritten and can only be discarded explicitly', () => {
  for (const raw of ['{', JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: 'wrong' }), ' '.repeat(MAX_WORKFLOW_RECOVERY_BYTES + 1)]) {
    const storage = memory(); storage.data.set(WORKFLOW_RECOVERY_KEY, raw);
    assert.equal(readWorkflowRecovery(storage).ok, false);
    assert.equal(saveWorkflowRecovery(storage, fixture(), fixture(), now).ok, false);
    assert.equal(removeWorkflowRecovery(storage, fixture().id).ok, false);
    assert.equal(storage.data.get(WORKFLOW_RECOVERY_KEY), raw);
    assert.equal(clearWorkflowRecovery(storage).ok, true); assert.equal(storage.data.has(WORKFLOW_RECOVERY_KEY), false);
  }
});

test('a bad record does not hide good records or silently rewrite the original envelope', () => {
  const storage = memory(), base = fixture();
  const good = { workflowId: base.id, draft: base, base, savedAt: now };
  const raw = JSON.stringify({ version: 1, records: [good, { workflowId: 'bad', draft: {} }] }); storage.data.set(WORKFLOW_RECOVERY_KEY, raw);
  const result = readWorkflowRecovery(storage);
  assert.equal(result.ok, false); assert.deepEqual(result.records, [good]);
  assert.equal(saveWorkflowRecovery(storage, base, base, now).ok, false); assert.equal(storage.data.get(WORKFLOW_RECOVERY_KEY), raw);
});

test('unsafe field types, identifiers, unknown payloads and coordinate values are rejected', () => {
  const base = fixture();
  const malformed: unknown[] = [null, [], { ...base, id: '' }, { ...base, id: 'bad\nidentifier' }, { ...base, id: {} }, { ...base, pre: {} }, { ...base, rawEvaluationInput: 'must not store' }, { ...base, layout: { version: 1, positions: { input: { x: Infinity, y: 1 } } } }, { ...base, graph: { version: 1, pre: { nodes: [], edges: [{ id: 'edge', from: {}, to: 'end' }] }, post: { nodes: [], edges: [] } } }];
  for (const item of malformed) assert.equal(isRecoverableWorkflow(item), false);
  const badPosition = JSON.parse('{"version":1,"positions":{"__proto__":{"x":1,"y":1}}}');
  assert.equal(isRecoverableWorkflow({ ...base, layout: badPosition }), false);
  const storage = memory(); assert.equal(saveWorkflowRecovery(storage, base, base, now).ok, true);
  const before = storage.data.get(WORKFLOW_RECOVERY_KEY);
  for (const item of malformed) {
    const result = saveWorkflowRecovery(storage, item as Workflow, base, now);
    assert.equal(result.ok, false); assert.equal(result.records.length, 1); assert.equal(storage.data.get(WORKFLOW_RECOVERY_KEY), before);
  }
});

test('quota and storage permission errors retain the last good copy and return actionable failures', () => {
  const storage = memory(), base = fixture(); saveWorkflowRecovery(storage, base, base, now);
  const original = storage.data.get(WORKFLOW_RECOVERY_KEY); storage.denyWrite = true;
  const result = saveWorkflowRecovery(storage, { ...base, description: '저장되지 않은 변경' }, base, now);
  assert.equal(result.ok, false); assert.match(result.error!, /저장 공간|저장 권한/); assert.equal(result.records[0].draft.description, base.description);
  assert.equal(storage.data.get(WORKFLOW_RECOVERY_KEY), original);
  storage.denyRemove = true;
  assert.equal(removeWorkflowRecovery(storage, base.id).ok, false); assert.equal(clearWorkflowRecovery(storage).ok, false);
  assert.equal(storage.data.get(WORKFLOW_RECOVERY_KEY), original);
  storage.denyRead = true;
  assert.equal(readWorkflowRecovery(storage).ok, false); assert.equal(saveWorkflowRecovery(storage, base, base, now).ok, false);
  assert.equal(storage.data.get(WORKFLOW_RECOVERY_KEY), original);
  assert.equal(readWorkflowRecovery(null).ok, false); assert.equal(removeWorkflowRecovery(undefined, base.id).ok, false);
});

test('deleting one recovery retains other workflows and deleting the final one removes the key', () => {
  const storage = memory(), base = fixture(), other = { ...base, id: 'other' };
  saveWorkflowRecovery(storage, base, base, now); saveWorkflowRecovery(storage, other, other, now);
  assert.equal(removeWorkflowRecovery(storage, 'missing').records.length, 2);
  const one = removeWorkflowRecovery(storage, base.id);
  assert.equal(one.ok, true); assert.equal(one.records.length, 1); assert.equal(one.records[0].workflowId, other.id);
  assert.equal(removeWorkflowRecovery(storage, other.id).ok, true); assert.equal(storage.data.has(WORKFLOW_RECOVERY_KEY), false);
});

test('recovery capacity is bounded without evicting another user draft', () => {
  const storage = memory(), base = fixture(); base.pre = []; base.post = [];
  for (let index = 0; index < MAX_WORKFLOW_RECOVERIES; index++) {
    const item = { ...base, id: `workflow-${index}` }; assert.equal(saveWorkflowRecovery(storage, item, item, now).ok, true);
  }
  const before = storage.data.get(WORKFLOW_RECOVERY_KEY), extra = { ...base, id: 'extra' };
  const result = saveWorkflowRecovery(storage, extra, extra, now);
  assert.equal(result.ok, false); assert.equal(result.records.length, 30); assert.equal(storage.data.get(WORKFLOW_RECOVERY_KEY), before);
  const replacement = { ...base, id: 'workflow-0', description: 'same workflow at capacity' };
  assert.equal(saveWorkflowRecovery(storage, replacement, { ...base, id: replacement.id }, now).ok, true);
});

test('record workflow mismatch, duplicate records, invalid dates and unsupported field payloads fail closed', () => {
  const storage = memory(), base = fixture();
  assert.equal(saveWorkflowRecovery(storage, { ...base, id: 'another' }, base, now).ok, false);
  assert.equal(saveWorkflowRecovery(storage, base, base, 'not-a-date').ok, false);
  const item = { workflowId: base.id, draft: base, base, savedAt: now };
  for (const records of [[item, item], [{ ...item, evaluation: { input: 'raw' } }], [{ ...item, workflowId: 'wrong' }]]) {
    storage.data.set(WORKFLOW_RECOVERY_KEY, JSON.stringify({ version: 1, records })); assert.equal(readWorkflowRecovery(storage).ok, false);
  }
});

test('an oversized but typed draft does not replace the last good recovery', () => {
  const storage = memory(), base = fixture();
  saveWorkflowRecovery(storage, { ...base, description: '마지막 보관본' }, base, now);
  const before = storage.data.get(WORKFLOW_RECOVERY_KEY), large = structuredClone(base), template = base.pre[0].rules[0];
  large.pre = Array.from({ length: 36 }, (_, groupIndex) => ({ id: `group-${groupIndex}`, name: '', mode: 'any', rules: Array.from({ length: 12 }, (_, ruleIndex) => ({ ...template, id: `rule-${groupIndex}-${ruleIndex}`, config: { prompt: '가'.repeat(4000) } })) }));
  large.post = structuredClone(large.pre);
  assert.equal(isRecoverableWorkflow(large), true);
  const result = saveWorkflowRecovery(storage, large, base, now);
  assert.equal(result.ok, false); assert.match(result.error!, /가득/); assert.equal(result.records[0].draft.description, '마지막 보관본');
  assert.equal(storage.data.get(WORKFLOW_RECOVERY_KEY), before);
});

test('explicit repair preserves readable drafts, removes only invalid entries and permits subsequent editing', () => {
  const storage = memory(), base = fixture(), other = { ...base, id: 'other' };
  const good = { workflowId: base.id, draft: { ...base, description: '복구 가능한 초안' }, base, savedAt: now };
  storage.data.set(WORKFLOW_RECOVERY_KEY, JSON.stringify({ version: 1, records: [good, { workflowId: 'broken', draft: {} }] }));
  const repaired = repairWorkflowRecovery(storage);
  assert.equal(repaired.ok, true); assert.deepEqual(repaired.records, [good]); assert.deepEqual(readWorkflowRecovery(storage), repaired);
  repaired.records[0].draft.description = '반환 객체 변경';
  assert.equal(readWorkflowRecovery(storage).records[0].draft.description, '복구 가능한 초안');
  const next = saveWorkflowRecovery(storage, { ...other, description: '새로운 편집' }, other, now);
  assert.equal(next.ok, true); assert.equal(next.records.length, 2); assert.equal(next.records[1].draft.description, '복구 가능한 초안');
});

test('repair read or write failures leave the exact corrupt store untouched', () => {
  const storage = memory(), base = fixture(), good = { workflowId: base.id, draft: base, base, savedAt: now };
  const raw = JSON.stringify({ version: 1, records: [good, { workflowId: 'broken' }] });
  storage.data.set(WORKFLOW_RECOVERY_KEY, raw); storage.denyRead = true;
  assert.equal(repairWorkflowRecovery(storage).ok, false); assert.equal(storage.data.get(WORKFLOW_RECOVERY_KEY), raw);
  storage.denyRead = false; storage.denyWrite = true;
  const failed = repairWorkflowRecovery(storage);
  assert.equal(failed.ok, false); assert.deepEqual(failed.records, [good]); assert.equal(storage.data.get(WORKFLOW_RECOVERY_KEY), raw);
  assert.equal(repairWorkflowRecovery(null).ok, false);
});

test('explicit repair of wholly unreadable content writes an empty valid envelope without clearing first', () => {
  const storage = memory(); storage.data.set(WORKFLOW_RECOVERY_KEY, '{broken'); storage.denyRemove = true;
  const repaired = repairWorkflowRecovery(storage);
  assert.equal(repaired.ok, true); assert.deepEqual(repaired.records, []);
  assert.equal(storage.data.get(WORKFLOW_RECOVERY_KEY), JSON.stringify({ version: 1, records: [] }));
  const base = fixture(); assert.equal(saveWorkflowRecovery(storage, base, base, now).ok, true);
  const before = storage.data.get(WORKFLOW_RECOVERY_KEY); storage.denyWrite = true;
  assert.equal(repairWorkflowRecovery(storage).ok, true, 'an already valid envelope requires no write');
  assert.equal(storage.data.get(WORKFLOW_RECOVERY_KEY), before);
});
