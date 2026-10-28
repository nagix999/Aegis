import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { executeWorkflow, testConnection, validateConnection, validateIngress } from '../lib/aegis-engine.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { validateConnection as validateBrowserConnection, validateIngress as validateBrowserIngress } from '../lib/workflow-validation.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { initialState } from '../lib/aegis-seed.ts';
import type { Connection } from '../lib/aegis-types';

const validators = [
  { name: 'browser', connection: validateBrowserConnection, ingress: validateBrowserIngress },
  { name: 'reference engine', connection: validateConnection, ingress: validateIngress },
];

for (const validator of validators) {
  test(`${validator.name} accepts HTTP and HTTPS model endpoints and exact origins`, () => {
    const state = initialState();
    for (const origin of ['http://10.23.45.67:8000', 'http://vllm.example.internal:8000', 'https://vllm.example.com']) {
      assert.deepEqual(validator.ingress({ ...state.ingress, allowedOrigins: [origin] }), [], origin);
      for (const path of ['/v1', '/v1/', '/inference/v1']) {
        assert.deepEqual(validator.connection({ ...state.connections[0], mode: 'vllm', baseUrl: origin + path }), [], origin + path);
      }
    }
  });

  test(`${validator.name} still rejects unsupported schemes and non-origin allowlist entries`, () => {
    const state = initialState();
    for (const origin of [
      'ftp://vllm.example.internal:8000',
      'ws://vllm.example.internal:8000',
      'http://vllm.example.internal:8000/',
      'http://vllm.example.internal:8000/v1',
      'http://vllm.example.internal:8000?key=fixture',
      'http://vllm.example.internal:8000#fragment',
      'http://fixture-user@vllm.example.internal:8000',
      'http://fixture-user:fixture-password@vllm.example.internal:8000',
    ]) {
      assert.ok(validator.ingress({ ...state.ingress, allowedOrigins: [origin] }).length > 0, origin);
    }
    for (const baseUrl of [
      'ftp://vllm.example.internal:8000/v1',
      'ws://vllm.example.internal:8000/v1',
      'http://vllm.example.internal:8000',
      'http://vllm.example.internal:8000/v2',
      'http://vllm.example.internal:8000/v1?key=fixture',
      'http://vllm.example.internal:8000/v1#fragment',
      'http://fixture-user@vllm.example.internal:8000/v1',
      'http://fixture-user:fixture-password@vllm.example.internal:8000/v1',
    ]) {
      assert.ok(validator.connection({ ...state.connections[0], mode: 'vllm', baseUrl }).length > 0, baseUrl);
    }
  });
}

function fixture() {
  const state = initialState();
  const connection: Connection = { ...state.connections[0], mode: 'vllm', baseUrl: 'http://10.23.45.67:8000/v1' };
  const workflow = { ...state.workflows[0], pre: [], post: [] };
  const ingress = { ...state.ingress, allowedOrigins: ['http://10.23.45.67:8000'] };
  return { connection, workflow, ingress };
}

test('explicitly approved internal HTTP supports model discovery and generation without redirects', async () => {
  const { connection, workflow, ingress } = fixture();
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push(String(input));
    assert.equal(init?.redirect, 'error');
    if (String(input).endsWith('/models')) return Response.json({ data: [{ id: connection.model }] });
    return Response.json({ choices: [{ message: { content: '내부 HTTP 모델의 테스트 응답입니다.' } }] });
  };
  try {
    const environment = { AEGIS_ALLOW_PRIVATE_UPSTREAM: 'true' };
    assert.equal((await testConnection(connection, ingress, environment)).ok, true);
    const result = await executeWorkflow(workflow, [connection], ingress, environment, [{ role: 'user', content: '테스트 질문' }]);
    assert.equal(result.status, 'allow');
    assert.equal(result.output, '내부 HTTP 모델의 테스트 응답입니다.');
    assert.deepEqual(requests, ['http://10.23.45.67:8000/v1/models', 'http://10.23.45.67:8000/v1/chat/completions']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HTTP support retains explicit private-network opt-in and exact scheme and port matching', async () => {
  const { connection, workflow, ingress } = fixture();
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('unapproved request'); };
  try {
    const privateDenied = await executeWorkflow(workflow, [connection], ingress, {}, [{ role: 'user', content: '테스트 질문' }]);
    assert.equal(privateDenied.status, 'error');
    assert.equal(privateDenied.output, '');
    assert.match(privateDenied.traces.find(trace => trace.stage === 'main')?.reason || '', /AEGIS_ALLOW_PRIVATE_UPSTREAM/);
    for (const allowedOrigins of [['https://10.23.45.67:8000'], ['http://10.23.45.67:8001'], []]) {
      const result = await executeWorkflow(workflow, [connection], { ...ingress, allowedOrigins }, { AEGIS_ALLOW_PRIVATE_UPSTREAM: 'true' }, [{ role: 'user', content: '테스트 질문' }]);
      assert.equal(result.status, 'error');
      assert.equal(result.output, '');
    }
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
