#!/usr/bin/env node
/** Optional unattended caller for a hosted Aegis console. No browser session needed. */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { startEvaluationRunner } from './evaluation-runner.mjs';

export function workerConfiguration(env) {
  let origin;
  try { origin = new URL(env.AEGIS_EVALUATION_SERVER_URL); } catch { throw new Error('Set AEGIS_EVALUATION_SERVER_URL to the console origin.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (!['https:', ...(loopback ? ['http:'] : [])].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('The console URL must be an HTTPS origin. HTTP is allowed only on loopback.');
  }
  const token = env.AEGIS_EVALUATION_WORKER_TOKEN;
  if (typeof token !== 'string' || token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) throw new Error('Set AEGIS_EVALUATION_WORKER_TOKEN to a secret of 32 to 512 characters.');
  const serviceToken = env.AEGIS_SITE_SERVICE_TOKEN;
  if (serviceToken && /[\r\n]/.test(serviceToken)) throw new Error('The Site service credential is invalid.');
  return { url: new URL('/api/evaluations/worker', origin).href, token, serviceToken };
}

function attachedRequest(url, options) {
  // Native HTTP avoids fetch's default response-header timeout for a batch
  // whose bounded graph can legitimately take longer than five minutes.
  return new Promise((resolveResponse, reject) => {
    const request = (new URL(url).protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: options.method, headers: options.headers, signal: options.signal,
    }, response => {
      response.resume();
      response.once('error', reject);
      response.once('end', () => resolveResponse({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode }));
    });
    request.once('error', reject);
    request.end(options.body);
  });
}

export function createWorkerCaller(configuration, { workerId = randomUUID(), fetchImpl = attachedRequest } = {}) {
  return async action => {
    // Never follow a redirect with either credential, including a sign-in redirect.
    const response = await fetchImpl(configuration.url, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${configuration.token}`, ...(configuration.serviceToken ? { 'OAI-Sites-Authorization': `Bearer ${configuration.serviceToken}` } : {}) },
      body: JSON.stringify({ action, workerId }),
      // A process request stays connected through the model batch. It is not
      // detached Worker work subject to the post-response waitUntil deadline.
      signal: AbortSignal.timeout(action === 'process' ? 4 * 60 * 60_000 : 15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Worker request failed (${response.status}).`);
    }
    // Metadata only; discard even an unexpected response body without logging it.
    await response.body?.cancel();
  };
}

export async function runRemoteEvaluationWorker(env = process.env) {
  const call = createWorkerCaller(workerConfiguration(env));
  let lastReport = 0;
  const runner = await startEvaluationRunner({
    heartbeat: () => call('heartbeat'), processQueue: () => call('process'), disconnect: () => call('disconnect'),
    intervalMs: 3000,
    onError(phase) {
      if (Date.now() - lastReport < 30_000) return;
      lastReport = Date.now();
      console.error(`Aegis evaluation worker: ${phase} request failed. Retrying; check connectivity and worker authorization.`);
    },
  });
  console.log('Aegis evaluation worker started. Pending jobs are processed independently of the browser.');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await runner.stop(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return runner;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) {
    console.log('Run with AEGIS_EVALUATION_SERVER_URL, AEGIS_EVALUATION_WORKER_TOKEN and, for a private Site, AEGIS_SITE_SERVICE_TOKEN. Credentials are read only from the environment.');
  } else {
    try { await runRemoteEvaluationWorker(); }
    catch { console.error('Aegis evaluation worker could not start. Check the server origin and worker environment settings.'); process.exitCode = 1; }
  }
}
