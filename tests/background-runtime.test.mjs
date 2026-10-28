import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startEvaluationRunner } from '../scripts/evaluation-runner.mjs';
import { createWorkerCaller, workerConfiguration } from '../scripts/evaluation-worker.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(done => setTimeout(done, ms));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(check, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(40); }
  assert.fail(message);
}

async function runtimeFixture() {
  await mkdir(join(project, 'work'), { recursive: true });
  const temporary = await mkdtemp(join(project, 'work', 'background-runtime-'));
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((done, reject) => socket.close(error => error ? reject(error) : done()));
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString('hex');
  const workerSecret = randomBytes(32).toString('hex');
  const authorization = `Basic ${Buffer.from(`runtime:${password}`).toString('base64')}`;
  const database = join(temporary, 'aegis.sqlite');
  const env = {
    ...process.env, HOST: '127.0.0.1', PORT: String(port), PUBLIC_BASE_URL: base,
    AEGIS_DATABASE_PATH: database, ADMIN_USER: 'runtime', ADMIN_PASSWORD: password,
    AEGIS_ADMIN_TOKEN: randomBytes(32).toString('hex'), AEGIS_REQUIRE_ADMIN_IDENTITY: 'false',
    AEGIS_EVALUATION_WORKER_TOKEN: workerSecret,
  };
  let child;
  async function start(enabled = true) {
    child = spawn(process.execPath, ['scripts/local-api.mjs', '--no-build'], {
      cwd: project, env: { ...env, AEGIS_EVALUATION_WORKER_ENABLED: String(enabled) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((done, reject) => {
      const timeout = setTimeout(() => reject(new Error('Background test runtime did not start.')), 15_000);
      child.stdout.on('data', chunk => { if (String(chunk).includes('Aegis is listening')) { clearTimeout(timeout); done(); } });
      child.stderr.on('data', () => {});
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Background test runtime exited during startup (${code}).`)); });
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, 'exit'); child.kill('SIGTERM');
    const timeout = setTimeout(() => child?.kill('SIGKILL'), 3000);
    await stopped; clearTimeout(timeout); child = undefined;
  }
  async function request(path = '/api/console', body) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET', headers: { Authorization: authorization, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, data: await response.json() };
  }
  async function action(action, payload = {}) {
    const result = await request('/api/console', { action, ...payload });
    assert.equal(result.status, 200, `${action} should succeed: ${result.data.error?.code || result.status}`);
    return result.data;
  }
  async function prepare() {
    const state = (await request()).data.state;
    const workflow = { ...state.workflows[0], pre: [], post: [] };
    await action('save_workflow', { workflow });
    const dataset = {
      id: 'ds-background-runtime', name: '작업자 실행 검증', description: '',
      rows: Array.from({ length: 6 }, (_, index) => ({ id: `runtime-row-${index}`, input: `배송 문의 ${index}`, expected: 'allow' })),
    };
    await action('save_dataset', { dataset });
    return { workflow, dataset };
  }
  return { start, stop, request, action, prepare, database, base, authorization, workerSecret, close: async () => { await stop(); await rm(temporary, { recursive: true, force: true }); } };
}

test('standalone background jobs complete after the start response using only status reads', async () => {
  const f = await runtimeFixture();
  try {
    await f.start();
    const { workflow, dataset } = await f.prepare();
    assert.equal((await f.request()).data.state.evaluationWorker.available, true);
    const { run } = await f.action('start_evaluation', { workflowId: workflow.id, datasetId: dataset.id });
    assert.equal(run.executionMode, 'background'); assert.equal(run.results.length, 0);
    // The start request has finished. No step or other mutation request is sent.
    const completed = await until(async () => {
      const { status, data } = await f.request(`/api/console?view=evaluations&runId=${encodeURIComponent(run.id)}`);
      assert.equal(status, 200); assert.equal(data.evaluationWorker.available, true);
      assert.ok(data.runs.every(item => !('results' in item) && !('datasetSnapshot' in item)));
      return data.run?.status === 'completed' ? data.run : undefined;
    }, 'The independent server worker should finish the stored job.');
    assert.equal(completed.results.length, dataset.rows.length);
    assert.deepEqual(completed.pendingRowIds, []);
    assert.deepEqual(completed.results.map(item => item.input), dataset.rows.map(item => item.input));
    const finalStatus = (await f.request(`/api/console?view=evaluations&runId=${run.id}`)).data;
    assert.equal(finalStatus.runs.find(item => item.id === run.id).completedCount, dataset.rows.length);
  } finally { await f.close(); }
});

test('disabled workers leave manual jobs pending and restart resumes an expired background lease from snapshots', async () => {
  const f = await runtimeFixture();
  try {
    await f.start(false);
    const { workflow, dataset } = await f.prepare();
    assert.equal((await f.request()).data.state.evaluationWorker.available, false);
    const rejected = await f.request('/api/console', { action: 'start_evaluation', workflowId: workflow.id, datasetId: dataset.id, executionMode: 'background' });
    assert.equal(rejected.status, 409); assert.equal(rejected.data.error.code, 'evaluation_worker_unavailable');
    const { run } = await f.action('start_evaluation', { workflowId: workflow.id, datasetId: dataset.id });
    assert.equal(run.executionMode, 'manual');
    await delay(150);
    assert.equal((await f.request(`/api/console?view=evaluations&runId=${run.id}`)).data.run.results.length, 0);
    // A source edit does not alter the durable execution snapshots.
    await f.action('save_dataset', { dataset: { ...dataset, rows: [{ ...dataset.rows[0], input: '새 데이터셋 내용' }] } });
    await f.stop();
    const sqlite = new DatabaseSync(f.database);
    try {
      const stored = JSON.parse(sqlite.prepare("SELECT payload FROM aegis_records WHERE namespace='run' AND id=?").get(run.id).payload);
      stored.executionMode = 'background';
      // Explicitly expired fixture lease exercises recovery without shortening
      // an actual in-flight production lease or waiting for its budget.
      stored._lease = { token: 'expired-test-lease', until: Date.now() - 1 };
      sqlite.prepare("UPDATE aegis_records SET payload=? WHERE namespace='run' AND id=?").run(JSON.stringify(stored), run.id);
    } finally { sqlite.close(); }
    await f.start();
    const completed = await until(async () => {
      const data = (await f.request(`/api/console?view=evaluations&runId=${run.id}`)).data;
      return data.run?.status === 'completed' ? data.run : undefined;
    }, 'A restarted runtime should recover the expired leased job.');
    assert.equal(completed.results.length, dataset.rows.length);
    assert.equal(completed.fingerprint, run.fingerprint); assert.equal(completed.datasetFingerprint, run.datasetFingerprint);
    assert.deepEqual(completed.results.map(item => item.input), dataset.rows.map(item => item.input));
    assert.ok(!('_lease' in completed));
  } finally { await f.close(); }
});

test('external worker CLI authenticates separately and completes a hosted-style job without browser steps', async () => {
  const f = await runtimeFixture(); let remote;
  async function stopRemote() {
    if (!remote || remote.exitCode !== null || remote.signalCode !== null) return;
    const stopped = once(remote, 'exit'); remote.kill('SIGTERM');
    const timeout = setTimeout(() => remote?.kill('SIGKILL'), 3000);
    await stopped; clearTimeout(timeout); remote = undefined;
  }
  try {
    await f.start(false);
    const { workflow, dataset } = await f.prepare();
    const managementCredential = await fetch(`${f.base}/api/evaluations/worker`, {
      method: 'POST', headers: { Authorization: f.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'heartbeat', workerId: 'unauthorized-admin' }), signal: AbortSignal.timeout(5000),
    });
    assert.equal(managementCredential.status, 401); await managementCredential.body?.cancel();
    remote = spawn(process.execPath, ['scripts/evaluation-worker.mjs'], {
      cwd: project,
      env: { ...process.env, AEGIS_EVALUATION_SERVER_URL: f.base, AEGIS_EVALUATION_WORKER_TOKEN: f.workerSecret, AEGIS_SITE_SERVICE_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    remote.stdout.on('data', () => {}); remote.stderr.on('data', () => {});
    await until(async () => {
      assert.equal(remote.exitCode, null, 'The external worker should remain running.');
      const status = (await f.request()).data.state.evaluationWorker;
      return status.available && status.kind === 'remote';
    }, 'The external worker should register its independent heartbeat.');
    const { run } = await f.action('start_evaluation', { workflowId: workflow.id, datasetId: dataset.id });
    assert.equal(run.executionMode, 'background');
    const completed = await until(async () => {
      const data = (await f.request(`/api/console?view=evaluations&runId=${run.id}`)).data;
      return data.run?.status === 'completed' ? data.run : undefined;
    }, 'The external worker should complete the queued job.');
    assert.equal(completed.results.length, dataset.rows.length);
    await stopRemote();
    assert.equal((await f.request()).data.state.evaluationWorker.available, false);
  } finally { await stopRemote(); await f.close(); }
});

test('runner keeps a separate heartbeat during long work, prevents overlap and drains once on stop', async () => {
  const gate = deferred(); let beats = 0; let work = 0; let active = 0; let peak = 0; let disconnected = 0;
  const runner = await startEvaluationRunner({
    heartbeat: async () => { beats++; },
    processQueue: async () => { work++; active++; peak = Math.max(peak, active); await gate.promise; active--; },
    disconnect: async () => { assert.equal(active, 0); disconnected++; }, intervalMs: 10, heartbeatMs: 10,
  });
  let stopping;
  try {
    await until(() => beats >= 3 && work === 1, 'Heartbeat should continue while a batch is blocked.', 2000);
    assert.equal(peak, 1); assert.equal(work, 1);
    stopping = runner.stop(); assert.equal(stopping, runner.stop());
    const stopBeats = beats; await delay(35);
    assert.equal(beats, stopBeats); assert.equal(disconnected, 0);
    gate.resolve(); await stopping;
    assert.equal(disconnected, 1); assert.equal(active, 0); assert.equal(work, 1);
  } finally { gate.resolve(); await runner.stop(); }
});

test('runner retries failed work without leaking errors or stopping heartbeat', async () => {
  let calls = 0; let beats = 0; const reported = [];
  const runner = await startEvaluationRunner({
    heartbeat: async () => { beats++; }, processQueue: async () => { calls++; if (calls === 1) throw new Error('private upstream detail'); },
    disconnect: async () => {}, onError: phase => reported.push(phase), intervalMs: 10, heartbeatMs: 10,
  });
  try { await until(() => calls >= 2 && beats >= 2, 'A failed pass should be retried.', 2000); assert.deepEqual(reported, ['process']); }
  finally { await runner.stop(); }
});

test('remote worker credentials stay on the selected origin and redirects are rejected', async () => {
  const token = 'worker-secret-'.repeat(4); const serviceToken = 'site-service-secret';
  const config = workerConfiguration({ AEGIS_EVALUATION_SERVER_URL: 'https://console.example', AEGIS_EVALUATION_WORKER_TOKEN: token, AEGIS_SITE_SERVICE_TOKEN: serviceToken });
  const captured = [];
  const caller = createWorkerCaller(config, { workerId: 'qa-worker', fetchImpl: async (url, init) => {
    captured.push({ url, init }); return Response.json({ accepted: true });
  } });
  await caller('heartbeat');
  assert.equal(captured[0].url, 'https://console.example/api/evaluations/worker');
  assert.equal(captured[0].init.redirect, 'error');
  assert.equal(captured[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(captured[0].init.headers['OAI-Sites-Authorization'], `Bearer ${serviceToken}`);
  assert.deepEqual(JSON.parse(captured[0].init.body), { action: 'heartbeat', workerId: 'qa-worker' });
  for (const url of ['http://internal.example', 'https://user:password@console.example', 'https://console.example/path', 'https://console.example?token=private']) {
    assert.throws(() => workerConfiguration({ AEGIS_EVALUATION_SERVER_URL: url, AEGIS_EVALUATION_WORKER_TOKEN: token }));
  }
  assert.equal(workerConfiguration({ AEGIS_EVALUATION_SERVER_URL: 'http://127.0.0.1:9999', AEGIS_EVALUATION_WORKER_TOKEN: token }).url, 'http://127.0.0.1:9999/api/evaluations/worker');
  const failed = createWorkerCaller(config, { fetchImpl: async () => Response.json({ leaked: token }, { status: 403 }) });
  await assert.rejects(failed('process'), error => error.message === 'Worker request failed (403).' && !error.message.includes(token));
});
