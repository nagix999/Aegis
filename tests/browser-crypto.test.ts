import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { randomUuid } from '../lib/client-id.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { sha256Hex } from '../lib/sha256.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { configurationFingerprint, datasetFingerprint } from '../lib/workflow-review.ts';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { evaluationPreflight } from '../lib/dataset-compatibility.ts';

const nativeCrypto = globalThis.crypto;
const httpCrypto = { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto) } as Crypto;

async function withoutSubtle(run: () => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: httpCrypto });
  try { await run(); } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
}

test('native UUID is called with its Crypto receiver', () => {
  const source = { randomUUID() { assert.equal(this, source); return 'native-uuid'; } } as unknown as Crypto;
  assert.equal(randomUuid(source), 'native-uuid');
});

test('HTTP fallback uses random bytes and sets the UUID version and variant', () => {
  const source = { getRandomValues(bytes: Uint8Array) { bytes.set(Array.from({ length: 16 }, (_, index) => index)); return bytes; } } as Crypto;
  assert.equal(randomUuid(source), '00010203-0405-4607-8809-0a0b0c0d0e0f');
});

test('HTTP identifiers are independent UUID v4 values', () => {
  const ids = Array.from({ length: 1000 }, () => randomUuid(httpCrypto));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('missing random bytes fail explicitly without a weak random fallback', () => {
  assert.throws(() => randomUuid({} as Crypto), /안전한 식별자/);
});

test('native and HTTP SHA-256 match standard vectors and UTF-8 boundary inputs', async () => {
  const values = ['', 'abc', '한글 😀', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(100000)];
  for (const value of values) {
    const expected = createHash('sha256').update(value).digest('hex');
    assert.equal(await sha256Hex(value), expected);
    await withoutSubtle(async () => assert.equal(await sha256Hex(value), expected));
  }
});

test('HTTP workflow, dataset and preflight evidence matches the native hashes', async () => {
  const state = initialState();
  const workflow = state.workflows[0];
  const dataset = state.datasets[0];
  const sides = [{ key: 'candidate' as const, label: '현재 초안', workflow, connections: state.connections }];
  const expected = await Promise.all([
    configurationFingerprint(workflow, state.connections), datasetFingerprint(dataset), evaluationPreflight(dataset, sides),
  ]);
  await withoutSubtle(async () => {
    assert.deepEqual(await Promise.all([
      configurationFingerprint(workflow, state.connections), datasetFingerprint(dataset), evaluationPreflight(dataset, sides),
    ]), expected);
  });
});
