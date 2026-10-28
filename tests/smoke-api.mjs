#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('--no-build')) {
  const result = spawnSync(process.execPath, ['scripts/local-api.mjs', '--build'], { cwd: project, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Standalone build must succeed.');
}

await mkdir(join(project, 'work'), { recursive: true });
const temporary = await mkdtemp(join(project, 'work', 'smoke-'));
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise((resolveClose, reject) => reservation.close(error => error ? reject(error) : resolveClose()));
const base = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString('hex');
const basic = `Basic ${Buffer.from(`smoke:${password}`).toString('base64')}`;
const environment = {
  ...process.env, HOST: '127.0.0.1', PORT: String(port), PUBLIC_BASE_URL: base,
  AEGIS_DATABASE_PATH: join(temporary, 'aegis.sqlite'),
  ADMIN_USER: 'smoke', ADMIN_PASSWORD: password,
  AEGIS_ADMIN_TOKEN: randomBytes(32).toString('hex'), AEGIS_REQUIRE_ADMIN_IDENTITY: 'false',
  // This suite verifies the legacy HTTP-driven batch API. Background execution
  // has its own real-process integration suite.
  AEGIS_EVALUATION_WORKER_ENABLED: 'false',
};
let child;
const passed = [];
function check(name, test) { test(); passed.push(name); console.log(`✓ ${name}`); }
async function start() {
  child = spawn(process.execPath, ['scripts/local-api.mjs', '--no-build'], { cwd: project, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolveStart, reject) => {
    const timer = setTimeout(() => reject(new Error('Local runtime did not start within 15 seconds.')), 15_000);
    const ready = chunk => { if (String(chunk).includes('Aegis is listening')) { clearTimeout(timer); resolveStart(); } };
    child.stdout.on('data', ready);
    child.stderr.on('data', () => {}); // Never echo environment-derived diagnostics or keys.
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Local runtime exited during startup (${code}).`)); });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exiting = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child?.kill('SIGKILL'), 3000);
  await exiting;
  clearTimeout(timer);
  child = undefined;
}
async function request(path, { body, authorization, headers = {} } = {}) {
  return fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(authorization ? { Authorization: authorization } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
}
async function action(name, value = {}) {
  const response = await request('/api/console', { body: { action: name, ...value }, authorization: basic });
  assert.equal(response.status, 200, `${name} must succeed.`);
  return response.json();
}
let key;
const completion = (input, options = {}) => request('/v1/chat/completions', {
  authorization: `Bearer ${key}`,
  body: { model: 'support-assistant', messages: [{ role: 'user', content: input }], ...options },
});

try {
  await start();
  let response = await request('/');
  check('Basic authentication protects the administrator console', () => { assert.equal(response.status, 401); assert.ok(response.headers.get('WWW-Authenticate')); });
  response = await request('/', { authorization: basic });
  let content = await response.text();
  check('Standalone UI HTML is served', () => { assert.equal(response.status, 200); assert.ok(content.includes('/_local/app.js')); });
  const assets = await Promise.all(['app.js', 'app.css'].map(async file => {
    const result = await request(`/_local/${file}`, { authorization: basic });
    return { status: result.status, content: await result.text() };
  }));
  check('Standalone JavaScript and compiled CSS include the final UI', () => {
    assert.ok(assets.every(asset => asset.status === 200 && asset.content.length > 100));
    assert.match(assets[1].content, /body\s*\{/);
    assert.match(assets[1].content, /\.app-shell\s*\{/);
    assert.match(assets[1].content, /\.sidebar\s*\{/);
    assert.doesNotMatch(assets[1].content, /@import\s+["']tailwindcss["']/);
  });

  response = await request('/api/console', { authorization: basic });
  let payload = await response.json();
  check('SQLite schema and demo state initialize', () => { assert.equal(response.status, 200); assert.equal(payload.state.workflows.length, 1); });
  const workflow = structuredClone(payload.state.workflows[0]);
  payload = await action('publish', { workflowId: workflow.id });
  check('Publishing stores immutable version 1', () => assert.equal(payload.deployment.version, 1));
  payload = await action('create_key', { name: 'Disposable smoke key' });
  key = payload.key;
  const keyId = payload.state.keys[0].id;
  check('Gateway key is issued once without exposing stored hashes', () => { assert.match(key, /^ag_[a-f0-9]{64}$/); assert.ok(payload.state.keys.every(item => !('hash' in item))); });
  response = await request('/v1/models', { authorization: `Bearer ${key}` });
  payload = await response.json();
  check('OpenAI models endpoint exposes the deployed alias', () => { assert.equal(response.status, 200); assert.equal(payload.object, 'list'); assert.equal(payload.data[0].id, 'support-assistant'); });

  const independent = { id: 'wf-independent', name: '별도 업무 워크플로우', description: '독립 생성 검증', alias: 'independent-assistant', mainConnectionId: workflow.mainConnectionId, pre: [], post: [], updatedAt: new Date().toISOString() };
  payload = await action('save_workflow', { workflow: independent });
  check('Multiple workflow records keep distinct IDs and aliases', () => {
    assert.equal(payload.state.workflows.length, 2);
    assert.equal(new Set(payload.state.workflows.map(item => item.id)).size, 2);
    assert.equal(new Set(payload.state.workflows.map(item => item.alias)).size, 2);
    assert.equal(payload.state.workflows.find(item => item.id === independent.id).pre.length, 0);
    assert.deepEqual(payload.state.workflows.find(item => item.id === workflow.id).pre, workflow.pre);
  });
  const cloned = { ...structuredClone(workflow), id: 'wf-cloned', name: '고객 상담 가드레일 복사본', alias: 'support-copy', updatedAt: new Date().toISOString() };
  for (const stage of ['pre', 'post']) for (const group of cloned[stage]) {
    group.id = `clone-${group.id}`;
    for (const rule of group.rules) rule.id = `clone-${rule.id}`;
  }
  payload = await action('save_workflow', { workflow: cloned });
  check('Cloning retains rule configuration in a separate workflow record', () => {
    assert.equal(payload.state.workflows.length, 3);
    const stored = payload.state.workflows.find(item => item.id === cloned.id);
    assert.equal(stored.mainConnectionId, workflow.mainConnectionId);
    assert.equal(stored.pre[0].rules[0].config.pattern, workflow.pre[0].rules[0].config.pattern);
    assert.notEqual(stored.pre[0].rules[0].id, workflow.pre[0].rules[0].id);
    assert.deepEqual(payload.state.workflows.find(item => item.id === workflow.id).pre, workflow.pre);
  });
  cloned.pre[1].rules[0].config.pattern = '환불';
  await action('save_workflow', { workflow: cloned });
  payload = await action('publish', { workflowId: cloned.id });
  check('Each workflow publishes its own model alias and version', () => {
    assert.equal(payload.deployment.version, 1);
    assert.equal(payload.deployment.alias, cloned.alias);
    assert.equal(payload.state.deployments.length, 2);
    assert.ok(payload.state.deployments.some(item => item.workflowId === workflow.id && item.alias === workflow.alias));
  });
  response = await request('/v1/models', { authorization: `Bearer ${key}` });
  payload = await response.json();
  check('Gateway lists every deployed workflow alias', () => {
    assert.equal(response.status, 200);
    assert.deepEqual(payload.data.map(item => item.id).sort(), ['support-assistant', 'support-copy']);
  });
  const originalRefund = await completion('환불 정책을 알려주세요.');
  const clonedRefund = await completion('환불 정책을 알려주세요.', { model: cloned.alias });
  check('Different workflow aliases execute their own rules independently', () => {
    assert.equal(originalRefund.status, 200);
    assert.equal(clonedRefund.status, 403);
  });
  payload = await action('delete_workflow', { id: independent.id });
  check('Deleting a draft preserves unrelated workflows and deployments', () => {
    assert.equal(payload.state.workflows.length, 2);
    assert.ok(!payload.state.workflows.some(item => item.id === independent.id));
    assert.ok(payload.state.workflows.some(item => item.id === workflow.id));
    assert.ok(payload.state.workflows.some(item => item.id === cloned.id));
    assert.equal(payload.state.deployments.length, 2);
  });
  response = await request('/api/console', { authorization: basic, body: { action: 'delete_workflow', id: workflow.id } });
  payload = await response.json();
  check('Workflows with deployment history cannot be deleted', () => {
    assert.equal(response.status, 400);
    assert.equal(payload.error.code, 'deployed_workflow');
  });
  response = await completion('배송은 보통 얼마나 걸리나요?');
  payload = await response.json();
  check('Allowed requests return a Chat Completions response', () => { assert.equal(response.status, 200); assert.equal(payload.object, 'chat.completion'); assert.ok(payload.choices[0].message.content); assert.equal(response.headers.get('X-Aegis-Workflow-Version'), '1'); });
  response = await completion('제 이메일은 customer@example.com입니다.');
  payload = await response.json();
  check('Pre guardrail blocks without returning generated content', () => { assert.equal(response.status, 403); assert.equal(payload.error.stage, 'pre'); assert.ok(!('choices' in payload)); });
  response = await completion('담당자 연락처 예시를 보여주세요.');
  payload = await response.json();
  check('Post guardrail blocks without leaking the model answer', () => { assert.equal(response.status, 403); assert.equal(payload.error.stage, 'post'); assert.ok(!('choices' in payload)); assert.ok(!JSON.stringify(payload).includes('support@example.com')); });
  response = await completion('배송은?', { stream: true });
  payload = await response.json();
  check('Unsafe streaming mode is explicitly rejected', () => { assert.equal(response.status, 400); assert.equal(payload.error.code, 'streaming_not_supported'); });
  workflow.pre[1].rules[0].config.pattern = '배송';
  await action('save_workflow', { workflow });
  const draft = await action('playground', { workflowId: workflow.id, input: '배송은 보통 얼마나 걸리나요?', target: 'draft' });
  response = await completion('배송은 보통 얼마나 걸리나요?');
  check('Draft edits do not change the published snapshot', () => { assert.equal(draft.result.status, 'block'); assert.equal(response.status, 200); });
  const otherDraft = await action('playground', { workflowId: cloned.id, input: '배송은 보통 얼마나 걸리나요?', target: 'draft' });
  const otherDeployment = await completion('배송은 보통 얼마나 걸리나요?', { model: cloned.alias });
  check('Editing one workflow leaves another draft and deployment unchanged', () => {
    assert.equal(otherDraft.result.status, 'allow');
    assert.equal(otherDeployment.status, 200);
  });
  payload = await action('run_evaluation', { workflowId: workflow.id, datasetId: 'ds-security', target: 'deployed' });
  check('All eight deployed dataset results match their expected decisions', () => { assert.equal(payload.run.results.length, 8); assert.ok(payload.run.results.every(result => result.expected === result.status)); assert.equal(payload.run.version, 'v1'); });
  const componentWorkflow = {
    id: 'wf-component-tests', name: '컴포넌트 노드 검증', description: '여러 노드 구성과 편집 동작 검증',
    alias: 'component-assistant', mainConnectionId: workflow.mainConnectionId, updatedAt: new Date().toISOString(),
    pre: [
      { id: 'component-json', name: 'JSON 입력 구조', mode: 'any', rules: [{ id: 'component-json-rule', name: '필수 JSON 키', description: 'message 키를 확인합니다.', kind: 'json', enabled: true, config: { jsonMode: 'object', requiredKeys: ['message'] } }] },
      { id: 'component-input', name: '입력 병렬 검사', mode: 'any', rules: [
        { id: 'component-pii-rule', name: '이메일 검사', description: '이메일 형태만 확인합니다.', kind: 'pii', enabled: true, config: { piiTypes: ['email'] } },
        { id: 'component-required-rule', name: '입력 필수 문구', description: '안내나 배송을 포함해야 합니다.', kind: 'required', enabled: true, config: { pattern: '안내,배송', matchMode: 'any' } },
      ] },
    ],
    post: [{ id: 'component-output', name: '응답 문구 검사', mode: 'any', rules: [{ id: 'component-output-rule', name: '예제 표시 확인', description: '예제 표시가 필요합니다.', kind: 'required', enabled: true, config: { pattern: '예제 응답', matchMode: 'all' } }] }],
  };
  await action('save_workflow', { workflow: componentWorkflow });
  response = await request('/api/console', { authorization: basic });
  payload = await response.json();
  check('Different component node kinds and settings persist through save and reload', () => {
    const stored = payload.state.workflows.find(item => item.id === componentWorkflow.id);
    assert.deepEqual(stored.pre, componentWorkflow.pre);
    assert.deepEqual(stored.post, componentWorkflow.post);
  });
  const componentInput = JSON.stringify({ message: '안내', contact: 'customer@example.com' });
  let componentResult = await action('playground', { workflowId: componentWorkflow.id, input: componentInput, target: 'draft' });
  check('Added PII nodes run after valid JSON and stop the main model on a match', () => {
    assert.equal(componentResult.result.status, 'block');
    assert.equal(componentResult.result.traces.find(item => item.ruleId === 'component-json-rule').status, 'allow');
    assert.equal(componentResult.result.traces.find(item => item.ruleId === 'component-pii-rule').status, 'block');
    assert.equal(componentResult.result.traces.find(item => item.ruleId === 'main').status, 'skipped');
    assert.ok(!JSON.stringify(componentResult.result).includes('customer@example.com'));
  });
  componentWorkflow.pre[1].rules[0].config.piiTypes = ['phone'];
  await action('save_workflow', { workflow: componentWorkflow });
  componentResult = await action('playground', { workflowId: componentWorkflow.id, input: componentInput, target: 'draft' });
  check('Editing a PII detector changes the actual draft result and Post checks still execute', () => {
    assert.equal(componentResult.result.status, 'allow');
    assert.equal(componentResult.result.traces.find(item => item.ruleId === 'component-pii-rule').status, 'allow');
    assert.equal(componentResult.result.traces.find(item => item.ruleId === 'component-output-rule').status, 'allow');
    assert.match(componentResult.result.output, /예제 응답/);
  });
  componentResult = await action('playground', { workflowId: componentWorkflow.id, input: JSON.stringify({ other: '안내' }), target: 'draft' });
  check('JSON required-key failures block before subsequent serial component groups', () => {
    assert.equal(componentResult.result.status, 'block');
    assert.equal(componentResult.result.traces.find(item => item.ruleId === 'component-json-rule').status, 'block');
    assert.equal(componentResult.result.traces.find(item => item.ruleId === 'component-required-rule').status, 'skipped');
    assert.equal(componentResult.result.output, '');
  });
  componentWorkflow.pre[1].rules[1].config = { pattern: '안내,필수', matchMode: 'all' };
  await action('save_workflow', { workflow: componentWorkflow });
  const allPhraseResult = await action('playground', { workflowId: componentWorkflow.id, input: componentInput, target: 'draft' });
  componentWorkflow.pre[1].rules[1].config.matchMode = 'any';
  await action('save_workflow', { workflow: componentWorkflow });
  const anyPhraseResult = await action('playground', { workflowId: componentWorkflow.id, input: componentInput, target: 'draft' });
  check('Required-phrase node edits enforce the selected ALL or ANY condition', () => {
    assert.equal(allPhraseResult.result.status, 'block');
    assert.equal(anyPhraseResult.result.status, 'allow');
  });
  const clonedComponentGroup = structuredClone(componentWorkflow.pre[1]);
  clonedComponentGroup.id = 'component-input-copy';
  clonedComponentGroup.name = '입력 병렬 검사 복사';
  clonedComponentGroup.rules = clonedComponentGroup.rules.map(item => ({ ...item, id: `${item.id}-copy` }));
  componentWorkflow.pre.push(clonedComponentGroup);
  payload = await action('save_workflow', { workflow: componentWorkflow });
  componentResult = await action('playground', { workflowId: componentWorkflow.id, input: componentInput, target: 'draft' });
  check('Cloned component groups retain independent IDs and execute in serial order', () => {
    const rules = payload.state.workflows.find(item => item.id === componentWorkflow.id).pre.flatMap(group => group.rules);
    assert.equal(new Set(rules.map(item => item.id)).size, rules.length);
    assert.deepEqual(clonedComponentGroup.rules[0].config, componentWorkflow.pre[1].rules[0].config);
    const traces = componentResult.result.traces.filter(item => item.stage === 'pre');
    assert.deepEqual(traces.map(item => item.groupId), ['component-json', 'component-input', 'component-input', 'component-input-copy', 'component-input-copy']);
  });
  componentWorkflow.pre[1].rules[0].config.piiTypes = ['email'];
  await action('save_workflow', { workflow: componentWorkflow });
  await action('publish', { workflowId: componentWorkflow.id });
  componentWorkflow.pre[1].rules = componentWorkflow.pre[1].rules.filter(item => item.id !== 'component-pii-rule');
  await action('save_workflow', { workflow: componentWorkflow });
  componentResult = await action('playground', { workflowId: componentWorkflow.id, input: componentInput, target: 'draft' });
  check('Deleting a component removes its execution trace while other group nodes remain', () => {
    assert.equal(componentResult.result.status, 'allow');
    assert.ok(!componentResult.result.traces.some(item => item.ruleId === 'component-pii-rule'));
    assert.ok(componentResult.result.traces.some(item => item.ruleId === 'component-pii-rule-copy'));
    assert.ok(componentResult.result.traces.some(item => item.ruleId === 'component-required-rule'));
  });
  response = await completion(componentInput, { model: componentWorkflow.alias });
  payload = await response.json();
  check('Component deletion in a draft does not change the published Gateway rules', () => {
    assert.equal(response.status, 403);
    assert.equal(payload.error.stage, 'pre');
    assert.ok(!('choices' in payload));
  });
  componentWorkflow.pre = componentWorkflow.pre.filter(group => group.id !== clonedComponentGroup.id);
  await action('save_workflow', { workflow: componentWorkflow });
  componentResult = await action('playground', { workflowId: componentWorkflow.id, input: componentInput, target: 'draft' });
  check('Deleting a component group removes only that group from execution', () => {
    assert.equal(componentResult.result.status, 'allow');
    assert.ok(!componentResult.result.traces.some(item => item.groupId === clonedComponentGroup.id));
    assert.ok(componentResult.result.traces.some(item => item.groupId === 'component-json'));
    assert.ok(componentResult.result.traces.some(item => item.groupId === 'component-input'));
  });
  const datasetA = { id: 'ds-managed-a', name: '편집할 검증 세트', description: '관리 기능 검증', updatedAt: '2099-01-01T00:00:00.000Z', rows: [
    { id: 'managed-a1', input: '  배송 기간을 알려주세요.\n ', expected: 'allow' },
    { id: 'managed-a2', input: '이메일은 user@example.com입니다.', expected: 'allow' },
  ] };
  const datasetB = { id: 'ds-managed-b', name: '독립 검증 세트', description: '다른 데이터셋과 분리', rows: [{ id: 'managed-b1', input: '제품 보증 기간이 궁금합니다.', expected: 'allow' }] };
  await action('save_dataset', { dataset: datasetA });
  payload = await action('save_dataset', { dataset: datasetB });
  check('Multiple datasets persist independently with server-owned modification timestamps', () => {
    assert.equal(payload.state.datasets.length, 3);
    const stored = payload.state.datasets.find(item => item.id === datasetA.id);
    assert.equal(stored.rows[0].input, datasetA.rows[0].input);
    assert.ok(Number.isFinite(Date.parse(stored.updatedAt)));
    assert.notEqual(stored.updatedAt, datasetA.updatedAt);
    assert.equal(payload.state.datasets.find(item => item.id === datasetB.id).name, datasetB.name);
  });
  const datasetCopy = { ...structuredClone(datasetA), id: 'ds-managed-copy', name: '편집할 검증 세트 복사', rows: datasetA.rows.map(row => ({ ...row, id: `${row.id}-copy` })) };
  payload = await action('save_dataset', { dataset: datasetCopy });
  check('Dataset copies retain input and expectations under separate dataset and row IDs', () => {
    const copy = payload.state.datasets.find(item => item.id === datasetCopy.id);
    assert.equal(payload.state.datasets.length, 4);
    assert.equal(copy.rows[0].input, datasetA.rows[0].input);
    assert.notEqual(copy.rows[0].id, datasetA.rows[0].id);
    assert.equal(copy.rows[1].expected, 'allow');
  });
  datasetA.name = '수정한 검증 세트'; datasetA.description = '입력과 예상 판정을 수정했습니다.';
  datasetA.rows[0].input = '  환불 정책을 알려주세요.\n ';
  datasetA.rows[1].expected = 'block';
  await action('save_dataset', { dataset: datasetA });
  response = await request('/api/console', { authorization: basic }); payload = await response.json();
  check('Dataset metadata and row edits preserve exact whitespace without changing a copy', () => {
    const stored = payload.state.datasets.find(item => item.id === datasetA.id);
    assert.equal(stored.name, datasetA.name); assert.equal(stored.description, datasetA.description);
    assert.equal(stored.rows[0].input, datasetA.rows[0].input); assert.equal(stored.rows[1].expected, 'block');
    assert.equal(payload.state.datasets.find(item => item.id === datasetCopy.id).rows[1].expected, 'allow');
  });
  payload = await action('run_evaluation', { workflowId: workflow.id, datasetId: datasetA.id, target: 'deployed' });
  const managedRun = structuredClone(payload.run);
  check('Evaluations use the selected edited dataset and retain its original row input', () => {
    assert.equal(managedRun.datasetId, datasetA.id); assert.equal(managedRun.datasetName, datasetA.name);
    assert.equal(managedRun.results.length, 2); assert.ok(managedRun.results.every(result => result.status === result.expected));
    assert.equal(managedRun.results[0].input, datasetA.rows[0].input);
  });
  datasetA.name = '실행 후 변경한 이름'; datasetA.rows[0].input = '변경한 입력'; datasetA.rows[0].expected = 'block';
  await action('save_dataset', { dataset: datasetA });
  payload = await action('delete_dataset', { id: datasetA.id });
  check('Deleting an edited source retains the immutable evaluation name, input and expectations', () => {
    assert.ok(!payload.state.datasets.some(item => item.id === datasetA.id));
    assert.deepEqual(payload.state.runs.find(item => item.id === managedRun.id), managedRun);
    assert.ok(payload.state.datasets.some(item => item.id === datasetB.id));
    assert.ok(payload.state.datasets.some(item => item.id === datasetCopy.id));
  });
  payload = await action('delete_dataset', { id: datasetB.id });
  check('Deleting one dataset leaves unrelated dataset records intact', () => {
    assert.deepEqual(payload.state.datasets.map(item => item.id).sort(), ['ds-managed-copy', 'ds-security']);
    assert.ok(payload.state.runs.some(item => item.id === managedRun.id));
  });
  const invalidDatasets = [
    { ...datasetB, id: 'ds-invalid-empty', rows: [] },
    { ...datasetB, id: 'ds-invalid-ids', rows: [{ id: 'duplicate', input: '첫 번째', expected: 'allow' }, { id: 'duplicate', input: '두 번째', expected: 'block' }] },
    { ...datasetB, id: 'ds-invalid-blank', rows: [{ id: 'blank', input: ' \n\t ', expected: 'allow' }] },
  ];
  const invalidStatuses = [];
  for (const dataset of invalidDatasets) {
    response = await request('/api/console', { authorization: basic, body: { action: 'save_dataset', dataset } });
    invalidStatuses.push(response.status);
  }
  check('Empty datasets, duplicate row IDs and whitespace-only inputs are rejected', () => assert.deepEqual(invalidStatuses, [400, 400, 400]));
  response = await request('/api/console', { authorization: basic, body: { action: 'delete_dataset', id: 'ds-does-not-exist' } });
  payload = await response.json();
  check('Deleting a missing dataset returns a clear not-found response', () => { assert.equal(response.status, 404); assert.equal(payload.error.code, 'not_found'); });
  await action('delete_dataset', { id: 'ds-security' });
  await action('delete_dataset', { id: datasetCopy.id });
  response = await request('/api/console', { authorization: basic }); payload = await response.json();
  check('Deleting the final dataset does not resurrect seed data or remove historical results', () => {
    assert.equal(payload.state.datasets.length, 0); assert.equal(payload.state.runs.length, 2);
    assert.deepEqual(payload.state.runs.find(item => item.id === managedRun.id), managedRun);
  });
  response = await request('/api/console', { authorization: basic, body: { action: 'save_ingress', ingress: { enabled: true, allowedCidrs: ['::1/128'], allowedOrigins: [] } } });
  check('Unsupported IPv6 ingress rules are rejected', () => assert.equal(response.status, 400));
  response = await request('/api/console', { authorization: basic, headers: { Origin: 'https://elsewhere.example' }, body: { action: 'create_key', name: 'Forbidden cross-origin key' } });
  check('Cross-origin administrator mutations are rejected', () => assert.equal(response.status, 403));
  await action('save_ingress', { ingress: { enabled: true, allowedCidrs: ['10.0.0.0/8'], allowedOrigins: [] } });
  response = await request('/v1/models', { authorization: `Bearer ${key}`, headers: { 'cf-connecting-ip': '10.1.2.3', 'x-forwarded-for': '10.1.2.3' } });
  check('Caller-supplied forwarding headers cannot spoof the client IP', () => assert.equal(response.status, 403));
  await action('save_ingress', { ingress: { enabled: true, allowedCidrs: ['127.0.0.1/32'], allowedOrigins: [] } });
  response = await request('/v1/models', { authorization: `Bearer ${key}` });
  check('Ingress permits the actual socket IP', () => assert.equal(response.status, 200));
  await stop();
  await start();
  response = await request('/api/console', { authorization: basic });
  payload = await response.json();
  check('SQLite records survive restart without replaying migrations', () => { assert.equal(response.status, 200); assert.equal(payload.state.deployments.length, 3); assert.equal(payload.state.workflows.length, 3); assert.equal(payload.state.keys.length, 1); assert.equal(payload.state.runs.length, 2); assert.equal(payload.state.datasets.length, 0); });
  response = await request('/v1/models', { authorization: `Bearer ${key}` });
  check('Persisted Gateway key remains valid after restart', () => assert.equal(response.status, 200));
  await action('revoke_key', { id: keyId });
  response = await completion('배송은?');
  check('Revoked keys are rejected', () => assert.equal(response.status, 401));
  response = await request('/v1/models');
  check('Requests without a Gateway key are rejected', () => assert.equal(response.status, 401));
  console.log(`\n${passed.length}/${passed.length} integration checks passed. Disposable database removed on exit.`);
} finally {
  await stop();
  await rm(temporary, { recursive: true, force: true });
}
