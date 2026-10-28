#!/usr/bin/env node
/** Internal-network PoC runtime. Shares the exact gateway handlers with Sites. */
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { startEvaluationRunner } from './evaluation-runner.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(project, '.local-runtime');
if (existsSync(join(project, '.env'))) process.loadEnvFile(join(project, '.env'));

async function compile() {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  await mkdir(runtime, { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(runtime, 'entry.tsx'), `import React from 'react';\nimport {createRoot} from 'react-dom/client';\nimport App from '../app/page.tsx';\nimport '../app/globals.css';\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);\n`);
  const base = { root: project, configFile: false, publicDir: false, resolve: { alias: { '@': project } }, logLevel: 'warn' };
  await build({ ...base, plugins: [react()], build: {
    outDir: join(runtime, 'client'), emptyOutDir: true, target: 'es2022',
    lib: { entry: join(runtime, 'entry.tsx'), formats: ['es'], fileName: 'app', cssFileName: 'app' },
    minify: true,
  }});
  await build({ ...base, build: {
    ssr: join(project, 'lib/aegis-api.ts'), outDir: join(runtime, 'server'), emptyOutDir: true,
    target: 'node22', minify: false, rollupOptions: { output: { entryFileNames: 'api.mjs' } },
  }});
  console.log('Aegis: UI and shared API compiled.');
}

if (!process.argv.includes('--no-build')) await compile();
if (process.argv.includes('--build')) process.exit(0);

const api = await import(pathToFileURL(join(runtime, 'server/api.mjs')).href);
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const adminUser = process.env.ADMIN_USER || '';
const adminPassword = process.env.ADMIN_PASSWORD || '';
if ((!!adminUser) !== (!!adminPassword)) throw new Error('Set both ADMIN_USER and ADMIN_PASSWORD.');
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && (!adminUser || !adminPassword)) {
  throw new Error('Non-loopback hosting requires ADMIN_USER and ADMIN_PASSWORD. Put a TLS reverse proxy in front of this service.');
}

const dataPath = resolve(project, process.env.AEGIS_DATABASE_PATH || 'data/aegis.sqlite');
await mkdir(dirname(dataPath), { recursive: true });
const sqlite = new DatabaseSync(dataPath);
sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
sqlite.exec('CREATE TABLE IF NOT EXISTS _aegis_local_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
for (const name of (await readdir(join(project, 'drizzle'))).filter(v => /^\d+.*\.sql$/.test(v)).sort()) {
  if (sqlite.prepare('SELECT name FROM _aegis_local_migrations WHERE name=?').get(name)) continue;
  const sql = await readFile(join(project, 'drizzle', name), 'utf8');
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    sqlite.exec(sql);
    sqlite.prepare('INSERT INTO _aegis_local_migrations(name,applied_at) VALUES (?,?)').run(name, new Date().toISOString());
    sqlite.exec('COMMIT');
  } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
}

class Statement {
  constructor(query, values = []) { this.query = query; this.values = values; }
  bind(...values) { return new Statement(this.query, values); }
  execute(method) {
    const statement = sqlite.prepare(this.query);
    if (method === 'first') return statement.get(...this.values) || null;
    if (method === 'all') return { success: true, results: statement.all(...this.values), meta: {} };
    const result = statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async first() { return this.execute('first'); }
  async all() { return this.execute('all'); }
  async run() { return this.execute('run'); }
}
const DB = {
  prepare(query) { return new Statement(query); },
  async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(item => item.execute('run')); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  },
};
const env = { ...process.env, DB };
const workerId = randomUUID();
let lastWorkerError = 0;
const evaluationRunner = process.env.AEGIS_EVALUATION_WORKER_ENABLED === 'false' ? undefined : await startEvaluationRunner({
  heartbeat: () => api.heartbeatEvaluationWorker(env, { id: workerId, kind: 'local' }),
  processQueue: () => api.processEvaluationQueue(env),
  disconnect: () => api.releaseEvaluationWorker(env, workerId),
  onError(phase) {
    if (Date.now() - lastWorkerError < 30_000) return;
    lastWorkerError = Date.now();
    console.error(`Aegis evaluation worker: ${phase} failed. Retrying; completed results remain saved.`);
  },
});
const contentTypes = { '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon', '.woff2':'font/woff2' };
const document = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="모델 서버, 요청 검사, 응답 검사, 검증 데이터와 API 배포 관리"><title>Aegis 관리 콘솔</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/_local/app.css"></head><body><div id="root"></div><script type="module" src="/_local/app.js"></script></body></html>`;

function validBasic(header) {
  if (!adminUser) return true;
  const candidate = Buffer.from(header || '');
  const expected = Buffer.from(`Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString('base64')}`);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options':'nosniff', ...headers });
  res.end(body);
}
async function sendProgressStream(res, response, headers) {
  res.writeHead(response.status, { 'X-Content-Type-Options': 'nosniff', ...headers });
  res.flushHeaders();
  const reader = response.body.getReader();
  const disconnected = () => { void reader.cancel().catch(() => {}); };
  res.once('close', disconnected);
  try {
    while (!res.destroyed) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      if (!res.write(value)) await new Promise(resolveDrained => {
        const finished = () => { res.off('drain', finished); res.off('close', finished); res.off('error', finished); resolveDrained(); };
        res.once('drain', finished); res.once('close', finished); res.once('error', finished);
        if (res.destroyed || !res.writableNeedDrain) finished();
      });
    }
  } finally {
    res.off('close', disconnected);
    reader.releaseLock();
    if (!res.destroyed) res.end();
  }
}
async function staticFile(res, base, relative) {
  const path = resolve(base, relative);
  if (!path.startsWith(resolve(base) + sep)) return send(res, 403, 'Forbidden');
  try {
    if (!(await stat(path)).isFile()) return send(res, 404, 'Not found');
    send(res, 200, await readFile(path), { 'Content-Type':contentTypes[extname(path)] || 'application/octet-stream', 'Cache-Control':'no-cache' });
  } catch { send(res, 404, 'Not found'); }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', process.env.PUBLIC_BASE_URL || `http://${req.headers.host || `localhost:${port}`}`);
    const isGateway = url.pathname === '/v1/models' || url.pathname === '/v1/chat/completions';
    const isEvaluationWorker = url.pathname === '/api/evaluations/worker';
    // The worker endpoint has a separate narrow credential; Basic credentials
    // and Gateway keys never authorize it.
    if (!isGateway && !isEvaluationWorker && !validBasic(req.headers.authorization)) {
      return send(res, 401, 'Administrator authentication required.', { 'WWW-Authenticate':'Basic realm="Aegis administrator", charset="UTF-8"', 'Cache-Control':'no-store' });
    }
    if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type':'text/plain' });
    if (url.pathname === '/api/console' || isGateway || isEvaluationWorker) {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2_000_000) return send(res, 413, JSON.stringify({error:{message:'Request body exceeds 2 MB.',code:'request_too_large'}}), { 'Content-Type':'application/json' });
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      // Never trust forwarding headers supplied by a direct caller.
      for (const name of ['cf-connecting-ip','x-forwarded-for','x-real-ip','oai-authenticated-user-id','oai-authenticated-user-email','x-aegis-admin-token']) headers.delete(name);
      headers.set('cf-connecting-ip', (req.socket.remoteAddress || '').replace(/^::ffff:/, ''));
      if (!isGateway && !isEvaluationWorker && process.env.AEGIS_ADMIN_TOKEN) headers.set('x-aegis-admin-token', process.env.AEGIS_ADMIN_TOKEN);
      const request = new Request(url, { method:req.method, headers, ...(!['GET','HEAD'].includes(req.method || 'GET') ? {body:Buffer.concat(chunks)} : {}) });
      const handler = isEvaluationWorker ? api.handleEvaluationWorker : url.pathname === '/api/console' ? api.handleConsole : url.pathname === '/v1/models' ? api.handleModels : api.handleCompletions;
      const response = await handler(request, env);
      const responseHeaders = Object.fromEntries(response.headers.entries());
      responseHeaders['Cache-Control'] = 'no-store';
      if (response.body && response.headers.get('content-type')?.includes('application/x-ndjson')) return await sendProgressStream(res, response, responseHeaders);
      return send(res, response.status, Buffer.from(await response.arrayBuffer()), responseHeaders);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (url.pathname.startsWith('/_local/')) return staticFile(res, join(runtime, 'client'), decodeURIComponent(url.pathname.slice('/_local/'.length)));
    if (url.pathname === '/favicon.svg') return staticFile(res, join(project, 'public'), 'favicon.svg');
    if (url.pathname === '/') return send(res, 200, document, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
    send(res, 404, 'Not found');
  } catch (error) {
    console.error('Aegis request failed:', error instanceof Error ? error.message : 'Unknown error');
    if (!res.headersSent) send(res, 500, JSON.stringify({error:{message:'Internal server error.',code:'internal_error'}}), { 'Content-Type':'application/json' });
    else res.end();
  }
});
server.listen(port, host, () => console.log(`Aegis is listening on http://${host}:${port}. SQLite: ${dataPath}`));
let shuttingDown = false;
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void Promise.all([new Promise(resolveClosed => server.close(resolveClosed)), evaluationRunner?.stop()]).then(() => { sqlite.close(); process.exit(0); });
});
