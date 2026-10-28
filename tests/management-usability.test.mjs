import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { initialState } from '../lib/aegis-seed.ts';
import { accessDraftDirty, accessDraftPolicy, accessDraftReducer, createAccessDraftState } from '../lib/access-draft.ts';
import { deployedCurl } from '../lib/gateway-integration.ts';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(project, 'work'), { recursive: true });
const temporary = await mkdtemp(join(project, 'work', 'management-ux-'));
after(() => rm(temporary, { recursive: true, force: true }));
const entry = join(temporary, 'entry.tsx');
await writeFile(entry, `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import * as management from ${JSON.stringify(join(project, 'components/management-pages.tsx'))};import {WorkflowList} from ${JSON.stringify(join(project, 'components/workflow-list.tsx'))};const pages={...management,WorkflowList};export const render=(name,props)=>renderToStaticMarkup(React.createElement(pages[name],props));`);
await build({ root: project, configFile: false, publicDir: false, plugins: [react()], resolve: { alias: { '@': project } }, logLevel: 'silent', build: { ssr: entry, outDir: join(temporary, 'build'), emptyOutDir: true, target: 'node22', rollupOptions: { output: { entryFileNames: 'entry.mjs' } } } });
const { render } = await import(pathToFileURL(join(temporary, 'build/entry.mjs')).href);
const props = () => ({ state: { ...initialState(), role: 'admin' }, act: async () => undefined, notify: () => {} });
const ingress = { enabled: false, allowedCidrs: [], allowedOrigins: ['https://saved.example'] };

test('unrelated console refreshes and server changes preserve unsaved access edits', () => {
  let draft = createAccessDraftState(ingress);
  draft = accessDraftReducer(draft, { type: 'edit', patch: { origins: 'https://edited.example\nhttps://another.example' } });
  draft = accessDraftReducer(draft, { type: 'sync', ingress: structuredClone(ingress) });
  assert.equal(accessDraftDirty(draft), true);
  assert.equal(draft.changedOnServer, false);
  const updated = { ...ingress, allowedCidrs: ['192.0.2.1/32'] };
  draft = accessDraftReducer(draft, { type: 'sync', ingress: updated });
  assert.deepEqual(accessDraftPolicy(draft.draft).allowedOrigins, ['https://edited.example', 'https://another.example']);
  assert.equal(draft.changedOnServer, true);
  draft = accessDraftReducer(draft, { type: 'discard' });
  assert.deepEqual(accessDraftPolicy(draft.draft), updated);
  assert.equal(accessDraftDirty(draft), false);
});

test('failed access save retains inputs while a successful save accepts server-normalized settings', () => {
  let draft = accessDraftReducer(createAccessDraftState(ingress), { type: 'edit', patch: { enabled: true, cidrs: ' 192.0.2.1/32,\n192.0.2.2/32 ' } });
  draft = accessDraftReducer(draft, { type: 'error', message: '저장 실패' });
  assert.equal(draft.draft.enabled, true);
  assert.equal(accessDraftDirty(draft), true);
  assert.equal(draft.error, '저장 실패');
  const saved = accessDraftPolicy(draft.draft);
  draft = accessDraftReducer(draft, { type: 'saved', ingress: saved });
  assert.equal(accessDraftDirty(draft), false);
  assert.equal(draft.error, '');
  assert.deepEqual(draft.saved.allowedCidrs, ['192.0.2.1/32', '192.0.2.2/32']);
});

test('unchanged local drafts follow newly saved access settings without a conflict', () => {
  const updated = { ...ingress, enabled: true };
  const draft = accessDraftReducer(createAccessDraftState(ingress), { type: 'sync', ingress: updated });
  assert.equal(draft.draft.enabled, true);
  assert.equal(draft.changedOnServer, false);
  assert.equal(accessDraftDirty(draft), false);
});

test('copied Python Gateway curl has only the intended URL, headers and JSON body', () => {
  const alias = "customer's-$literal";
  const curl = deployedCurl('https://gateway.example/v1/', { alias });
  assert.doesNotMatch(curl, /OAI-Sites|SITES_SERVICE_TOKEN|\n\+/);
  // A shell function captures arguments without making a network request.
  const script = `curl() { printf '%s\\0' "$@"; };\n${curl}`;
  const result = spawnSync('/bin/sh', ['-c', script], { env: { AEGIS_API_KEY: 'example-gateway-key' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const args = result.stdout.split('\0').slice(0, -1);
  assert.deepEqual(args.slice(0, 6), ['https://gateway.example/v1/chat/completions', '-H', 'Authorization: Bearer example-gateway-key', '-H', 'Content-Type: application/json', '-d']);
  assert.equal(args.length, 7);
  assert.equal(JSON.parse(args[6]).model, alias);
  assert.equal(JSON.parse(args[6]).stream, false);
});

test('failed live diagnostics provide access settings and retry without duplicated request summaries', () => {
  const p = props();
  const connection = { ...p.state.connections[0], mode: 'vllm', baseUrl: 'https://model.example/v1' };
  p.state.connections = [connection];
  p.state.diagnostics = { [connection.id]: { connectionId: connection.id, ok: false, checkedAt: '2026-10-28T00:00:00Z', latencyMs: 2, steps: [{ id: 'allowlist', label: '접근 허용', status: 'fail', message: '허용된 서버가 아닙니다.', latencyMs: 2 }] } };
  const html = render('ConnectionsPage', { ...p, initialDiagnosticId: connection.id, onOpenAccess: () => {}, onOpenDashboard: () => {} });
  assert.match(html, /접근 설정 확인/);
  assert.match(html, /다시 진단/);
  assert.match(html, /대시보드 보기/);
  assert.match(html, /서버 지표/);
  assert.doesNotMatch(html, /최근 요청 지표|P95 응답 시간/);
});

test('returning after access settings invalidate old diagnostics still provides explicit retry', () => {
  const p = props();
  const html = render('ConnectionsPage', { ...p, initialDiagnosticId: p.state.connections[0].id });
  assert.match(html, /진단 결과가 없습니다/);
  assert.match(html, /다시 진단/);
});

test('operations keep role explanations collapsed and label administrator authentication events', () => {
  const p = props();
  p.state.audit = ['admin_login', 'admin_login_failed', 'admin_login_throttled', 'admin_logout'].map((action, index) => ({ id: `audit-${index}`, actor: '관리자', action, target: '관리 콘솔', createdAt: '2026-10-28T00:00:00Z' }));
  const html = render('OperationsPage', p);
  assert.match(html, /<details class="mg-role-details"><summary>역할별 권한 안내/);
  assert.doesNotMatch(html, /<details class="mg-role-details" open/);
  for (const label of ['관리자 로그인', '관리자 로그인 실패', '관리자 로그인 재시도 제한', '관리자 로그아웃']) assert.ok(html.includes(label));
  assert.doesNotMatch(html, /<td>admin_login/);
});

test('access settings show saved state and disable writes for viewers', () => {
  const p = props();
  p.state.role = 'viewer';
  const html = render('AccessPage', p);
  assert.match(html, /서버에 저장됨/);
  assert.match(html, /접근 설정은 관리자만 변경/);
  assert.match(html, /<button class="btn primary" disabled=""/);
  assert.match(html, /변경 취소/);
});

test('paused deployments remain manageable but have no misleading callable example', () => {
  const p = props();
  const workflow = p.state.workflows[0];
  p.state.deployments = [{ id: 'paused-deployment', workflowId: workflow.id, alias: workflow.alias, version: 1, workflow, connections: p.state.connections, createdAt: '2026-10-28T00:00:00Z' }];
  p.state.lifecycle = { workflows: {}, policies: {}, deployments: { [workflow.alias]: { paused: true, actor: '관리자', updatedAt: '2026-10-28T00:00:00Z' } } };
  const html = render('GatewayPage', p);
  assert.match(html, /호출 가능 0 \/ 전체 1/);
  assert.match(html, /호출 재개/);
  assert.match(html, /새 배포와 이전 설정 복원은 호출 중지를 해제하지 않습니다/);
  assert.doesNotMatch(html, /<pre class="mg-code">/);
});

test('selected deployment details use the historical snapshot and unknown links show a clear fallback', () => {
  const p = props();
  const workflow = p.state.workflows[0];
  p.state.deployments = [{ id: 'historical-deployment', workflowId: workflow.id, alias: workflow.alias, version: 1, workflow: { ...workflow, name: '과거 설정 이름' }, connections: p.state.connections, createdAt: '2026-10-27T00:00:00Z' }, { id: 'current-deployment', workflowId: workflow.id, alias: workflow.alias, version: 2, workflow: { ...workflow, name: '현재 배포 이름' }, connections: p.state.connections, createdAt: '2026-10-28T00:00:00Z' }];
  const html = render('GatewayPage', { ...p, initialDeploymentId: 'historical-deployment' });
  const focus = html.match(/<section class="card mg-deployment-focus"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(focus, /과거 설정 이름/);
  assert.match(focus, /과거 배포/);
  assert.match(focus, /이 설정 복원 검토/);
  assert.doesNotMatch(focus, /현재 배포 이름/);
  assert.match(render('GatewayPage', { ...p, initialDeploymentId: 'missing' }), /선택한 배포를 찾을 수 없습니다/);
});

test('workflow list defaults to active objects with a reversible archive filter', () => {
  const p = props();
  const archived = p.state.workflows[0];
  p.state.workflows = [{ ...archived, name: '보관한 워크플로우' }, { ...archived, id: 'active-workflow', name: '사용 중 워크플로우' }];
  p.state.lifecycle = { workflows: { [archived.id]: { archived: true, actor: '관리자', updatedAt: '2026-10-28T00:00:00Z' } }, policies: {}, deployments: {} };
  const html = render('WorkflowList', { ...p, loading: false, busy: false, onCreate: () => {}, onOpen: () => {}, onDuplicate: async () => {}, onDelete: async () => {}, onTest: async () => {}, onDeploy: async () => {}, onArchive: async () => true });
  assert.match(html, /워크플로우 보관 필터/);
  assert.match(html, /사용 중 워크플로우/);
  assert.doesNotMatch(html, /보관한 워크플로우/);
  assert.match(html, /보관은 설정과 이력을 유지합니다/);
  assert.match(html, /사용 중 워크플로우 보관/);
});
