import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { executeWorkflow } from '../lib/aegis-engine.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { previewBranchSelection, buildBranchSelection } from '../lib/workflow-branching.ts';
// @ts-expect-error Node's strip-types runner resolves explicit .ts paths.
import { validateWorkflowGraph } from '../lib/workflow-graph.ts';
import type { Connection, RuleGroup } from '../lib/aegis-types';

const generated = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }));
const verdict = (allow: boolean) => generated(JSON.stringify({ verdict: allow ? 'allow' : 'block', reason: allow ? '정상' : '정책 위반' }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function ready<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`readiness timeout: ${label}`)), 1500);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function fixture(stage: 'pre' | 'post' = 'pre') {
  const state = initialState(), workflow = structuredClone(state.workflows[0]);
  const main: Connection = { ...state.connections[0], id: 'qa-main', mode: 'vllm', model: 'qa-main', baseUrl: 'https://qa-main.example.com/v1' };
  const guards: Connection[] = Array.from({ length: 4 }, (_, index) => ({ ...state.connections[1], id: `qa-guard-${index}`, mode: 'vllm', model: `qa-guard-${index}`, baseUrl: `https://qa-guard-${index}.example.com/v1` }));
  const groups: RuleGroup[] = guards.map((guard, index) => ({ id: `qa-group-${index}`, name: `검사 ${index}`, mode: 'any', rules: [{ id: `qa-rule-${index}`, name: `검사 ${index}`, description: '', kind: 'llm', enabled: true, config: { connectionId: guard.id, prompt: '민감한 내용은 차단하고 정상 안내는 허용하세요.' } }] }));
  workflow.mainConnectionId = main.id;
  workflow.pre = []; workflow.post = []; workflow[stage] = groups;
  delete workflow.graph; delete workflow.responseRetry;
  const preview = previewBranchSelection(workflow, stage, groups.map(group => group.id).reverse(), 'parallel');
  assert.equal(preview.valid, true, preview.reason);
  const built = buildBranchSelection(workflow, preview).workflow;
  assert.deepEqual(validateWorkflowGraph(built), []);
  return { workflow: built, connections: [main, ...guards], ingress: { ...state.ingress, allowedOrigins: [main, ...guards].map(connection => new URL(connection.baseUrl).origin) } };
}

test('four selected checks start concurrently and the model waits for every branch to join', async () => {
  const f = fixture(), gates = Array.from({ length: 4 }, () => deferred<Response>()), allStarted = deferred<void>();
  const originalFetch = globalThis.fetch, started = new Set<number>();
  let mainCalls = 0;
  globalThis.fetch = async input => {
    const match = String(input).match(/qa-guard-(\d)\./);
    if (match) {
      const index = Number(match[1]); started.add(index);
      if (started.size === 4) allStarted.resolve();
      return gates[index].promise;
    }
    mainCalls++; return generated('안전한 최종 안내');
  };
  const execution = executeWorkflow(f.workflow, f.connections, f.ingress, {}, [{ role: 'user', content: '배송 문의' }]);
  try {
    await ready(allStarted.promise, 'four guards start before any response resolves');
    assert.equal(mainCalls, 0);
    for (let index = 0; index < 3; index++) gates[index].resolve(verdict(true));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(mainCalls, 0, 'three completed checks cannot release the model');
    gates[3].resolve(verdict(true));
    const result = await ready(execution, 'four branches join');
    assert.equal(result.status, 'allow'); assert.equal(mainCalls, 1);
    assert.equal(result.traces.filter(trace => trace.stage === 'pre').length, 4);
    assert.equal(result.flowTraces?.find(trace => trace.stage === 'pre' && trace.nodeId.startsWith('control:') && trace.edgeIds.length === 4)?.status, 'completed');
  } finally {
    gates.forEach(gate => gate.resolve(verdict(true)));
    await ready(execution, 'guard cleanup').catch(() => undefined);
    globalThis.fetch = originalFetch;
  }
});

test('one blocking check in a four-branch selection prevents model generation', async () => {
  const f = fixture(), originalFetch = globalThis.fetch, started = new Set<number>();
  let mainCalls = 0;
  globalThis.fetch = async input => {
    const match = String(input).match(/qa-guard-(\d)\./);
    if (match) { const index = Number(match[1]); started.add(index); return verdict(index !== 3); }
    mainCalls++; return generated('이 응답은 생성되면 안 됩니다.');
  };
  try {
    const result = await executeWorkflow(f.workflow, f.connections, f.ingress, {}, [{ role: 'user', content: '배송 문의' }]);
    assert.equal(started.size, 4); assert.equal(result.status, 'block'); assert.equal(result.stage, 'pre');
    assert.equal(result.output, ''); assert.equal(mainCalls, 0);
    assert.equal(result.traces.find(trace => trace.stage === 'main')?.status, 'skipped');
  } finally { globalThis.fetch = originalFetch; }
});

test('all four output checks rerun on bounded regeneration while request checks run once', async () => {
  const f = fixture('post'), originalFetch = globalThis.fetch;
  f.workflow.pre = [{ id: 'pre-once', name: '요청 검사', mode: 'any', rules: [{ id: 'pre-once-rule', name: '요청 검사', description: '', kind: 'length', enabled: true, config: { maxLength: 4000 } }] }];
  f.workflow.graph!.pre = { nodes: [], edges: [{ id: 'p0', from: 'start', to: 'group:pre-once', port: 'next' }, { id: 'p1', from: 'group:pre-once', to: 'end', port: 'next' }] };
  f.workflow.responseRetry = { enabled: true, maxRetries: 1 };
  let generation = 0;
  const calls = new Map<string, number>(), mainInputs: string[] = [];
  globalThis.fetch = async (input, init) => {
    const match = String(input).match(/qa-guard-(\d)\./);
    if (match) {
      const index = Number(match[1]), key = `${generation}:${index}`;
      calls.set(key, (calls.get(key) || 0) + 1);
      return verdict(generation > 1 || index !== 3);
    }
    assert.equal(typeof init?.body, 'string');
    mainInputs.push(JSON.stringify(JSON.parse(String(init?.body)).messages));
    generation++; return generated(generation === 1 ? 'PRIVATE_CANDIDATE_MARKER' : '안전한 최종 안내');
  };
  try {
    const result = await executeWorkflow(f.workflow, f.connections, f.ingress, {}, [{ role: 'user', content: '배송 문의' }]);
    assert.equal(result.status, 'allow'); assert.equal(generation, 2); assert.equal(calls.size, 8);
    assert.ok([...calls.values()].every(count => count === 1));
    assert.equal(result.traces.filter(trace => trace.ruleId === 'pre-once-rule').length, 1);
    assert.deepEqual(result.attempts?.map(attempt => attempt.status), ['block', 'allow']);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_CANDIDATE_MARKER'));
    assert.ok(!mainInputs[1].includes('PRIVATE_CANDIDATE_MARKER'));
  } finally { globalThis.fetch = originalFetch; }
});
