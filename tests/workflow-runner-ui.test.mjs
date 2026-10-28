import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { matchesExpectation } from '../lib/workflow-review.ts';

const source = await readFile(new URL('../components/workflow-runner.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('workflow-runner.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const hook = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useWorkflowRunner');
const topNames = ['parseRunnerConversation','runnerExpectationMatched','runnerResultMatchesFilter','runnerWorkerAvailable', 'readWorkflowEvents', 'runnerDelay'];
const actionNames = ['showExecution', 'showRow', 'applyRun', 'stillCurrent', 'prepare', 'executeQuestion', 'driveDataset', 'executeDataset', 'cancelDataset','stopQuestion'];
const declarations = [...topNames.map(name => tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)), ...actionNames.map(name => hook.body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name))];
assert.ok(declarations.every(Boolean), 'Production helpers and handlers exist');
const externalEffect = hook.body.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'useEffect').map(node => node.expression.arguments[0]).find(node => node.getText(tree).includes('incomingExecutionId.current'));
assert.ok(externalEffect, 'External retest synchronization effect exists');
const code = ts.transpileModule(declarations.map(node => node.getText(tree).replace(/^export /, '')).join('\n') + '\nglobalThis.actions={' + [...topNames, ...actionNames].join(',') + '};globalThis.syncExternalExecution=' + externalEffect.getText(tree) + ';', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const result = { id: 'result', status: 'allow', output: '실제 응답', reason: '완료', stage: 'complete', latencyMs: 12, traces: [] };
const event = { sequence: 1, stage: 'main', nodeId: 'main', status: 'running', edgeIds: [] };
const fingerprint = 'a'.repeat(64);
function lines(...messages) { return messages.map(message => JSON.stringify(message)).join('\n') + '\n'; }
function streamed(text, split = Math.floor(text.length / 2)) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close(); } }), { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
}
function fixture(overrides = {}) {
  const requests = [], shown = [], posts = [];
  const proof = { fingerprint, requiresAcknowledgement: false, issues: [] };
  const state = {
    Date, Response, ReadableStream, TextDecoder, matchesExpectation, AbortController, AbortSignal, setTimeout, clearTimeout, URLSearchParams,
    locked: false, readOnly: false, acknowledged: false, inputFormat:'question', conversationJson:'', generationOptions:{}, mockEnabled:false, mockResponse:'', question: '배송 문의', workflow: { id: 'workflow' }, connections: [], state: { evaluationWorker: { available: false } }, workerStatus: { available: false },
    dataset: { id: 'dataset', rows: [{ id: 'row', input: '일반 문의', expected: 'allow' }] }, compatibility: { requiresAcknowledgement: false },
    contextKey: 'current-context', latestContext: { current: 'current-context' }, mounted: { current: true }, epoch: { current: 0 }, controller: { current: undefined }, selectedRow: { current: '' },
    phase: 'idle', active: false, progress: [], execution: undefined, initialExecution: undefined, incomingExecutionId: { current: undefined }, run: undefined, selectedRowId: '', hasStarted: false, error: '', notice: '',
    async configurationFingerprint() { return fingerprint; }, async evaluationPreflight() { return proof; },
    async fetch(url, init) { requests.push({ url, init }); return streamed(lines({ type: 'progress', event }, { type: 'result', result, fingerprint })); },
    callbacks: { current: { async onPrepareExecution() { return true; }, onExecution(value) { shown.push(value); }, async act(payload) { posts.push(payload); return { run: { id: 'run', status: 'completed', results: [], executionMode: 'manual' } }; } } },
    ...overrides,
  };
  for (const name of ['Phase','Error','Notice','HasStarted','Execution','Progress','Run','SelectedRowId','WorkerStatus','StartedAt','ElapsedMs','ResultFilter']) {
    const key = name[0].toLowerCase() + name.slice(1);
    state[`set${name}`] = value => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  }
  const context = vm.createContext(state); vm.runInContext(code, context);
  return { state, actions: context.actions, syncExternalExecution: context.syncExternalExecution, requests, posts, shown, proof };
}

test('stream parser joins split UTF-8 bytes and delivers real progress before final result', async () => {
  const f = fixture(), received = [];
  const text = lines({ type: 'progress', event }, { type: 'result', result, fingerprint });
  const bytes = new TextEncoder().encode(text); const split = bytes.indexOf(0xec) + 1;
  await f.actions.readWorkflowEvents(streamed(text, split), value => received.push(value));
  assert.equal(received.length, 2); assert.equal(received[0].type, 'progress'); assert.equal(received[1].result.output, '실제 응답');
});

test('stream parser rejects lost connections, malformed events and pre-stream API errors', async () => {
  const f = fixture();
  for (const response of [streamed(lines({ type: 'progress', event })), streamed(lines({ type: 'progress' })), streamed(lines({ type: 'result', result: {} })), new Response('not a stream')]) await assert.rejects(f.actions.readWorkflowEvents(response, () => {}));
  await assert.rejects(f.actions.readWorkflowEvents(Response.json({ error: { message: '설정이 변경되었습니다.' } }, { status: 409 }), () => {}), error => error.message === '설정이 변경되었습니다.');
});

test('question handler saves first and sends only its exact configuration proof with progress enabled', async () => {
  const f = fixture(); await f.actions.executeQuestion();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(JSON.parse(f.requests[0].init.body), { action: 'playground', workflowId: 'workflow', target: 'draft', input: '배송 문의', progress: true, expectedFingerprint: fingerprint });
  assert.equal(f.shown[0].result.id, result.id); assert.equal(f.state.phase, 'idle'); assert.equal(f.state.hasStarted, true); assert.equal(f.state.error, '');
});

test('readonly or busy questions cannot start and stale preparation makes no server request', async () => {
  const blocked = fixture({ locked: true }); await blocked.actions.executeQuestion(); assert.equal(blocked.requests.length, 0);
  const stale = fixture(); stale.state.callbacks.current.onPrepareExecution = async () => { stale.state.latestContext.current = 'changed'; return true; };
  await stale.actions.executeQuestion(); assert.equal(stale.requests.length, 0); assert.ok(stale.state.error); assert.equal(stale.state.phase, 'idle');
});

test('question completion received after leaving the editor cannot replace displayed results', async () => {
  const f = fixture(); f.state.fetch = async () => { f.state.mounted.current = false; return streamed(lines({ type: 'result', result, fingerprint })); };
  await f.actions.executeQuestion(); assert.equal(f.shown.length, 0);
});

test('a failed question preserves the last completed result with an explicit previous-result notice', async () => {
  const previous = { input: '이전 질문', result: { ...result, id: 'previous' }, fingerprint };
  const f = fixture({ execution: previous }); f.state.fetch = async () => { throw new Error('connection lost'); };
  await f.actions.executeQuestion(); assert.equal(f.state.execution.result.id, 'previous'); assert.match(f.state.notice, /이전/); assert.ok(f.state.error); assert.equal(f.shown.length, 0);
});

test('dataset warnings require acknowledgement and the created job carries exact reviewed proof', async () => {
  const blocked = fixture({ compatibility: { requiresAcknowledgement: true } }); await blocked.actions.executeDataset(); assert.equal(blocked.posts.length, 0);
  const f = fixture(); await f.actions.executeDataset();
  assert.equal(f.posts.length, 1);
  assert.deepEqual(structuredClone(f.posts[0]), { action: 'start_evaluation', workflowId: 'workflow', datasetId: 'dataset', target: 'draft', executionMode: 'manual', preflightFingerprint: fingerprint, acknowledgeCriteria: false });
});

test('completed dataset results do not replace the row the user selected', () => {
  const f = fixture();
  const first = { id: 'run', results: [{ ...result, rowId: 'first', input: '첫 질문' }, { ...result, id: 'second-result', rowId: 'second', input: '둘째 질문' }], fingerprint };
  f.actions.applyRun(first); assert.equal(f.state.selectedRowId, 'first');
  f.actions.showRow(first, 'second'); assert.equal(f.state.selectedRowId, 'second');
  f.actions.applyRun({ ...first, results: [...first.results, { ...result, rowId: 'third', input: '셋째 질문' }] });
  assert.equal(f.state.execution.input, '둘째 질문'); assert.equal(f.state.selectedRowId, 'second'); assert.equal(f.state.progress.length, 0);
});

test('cancel invalidates an in-flight dataset poll before applying its server confirmation', async () => {
  const f = fixture({ run: { id: 'run', status: 'running', results: [] }, phase: 'dataset' });
  f.state.controller.current = new AbortController();
  f.state.callbacks.current.act = async payload => { f.posts.push(payload); return { run: { id: 'run', status: 'cancelled', results: [] } }; };
  await f.actions.cancelDataset();
  assert.equal(f.state.epoch.current, 1); assert.equal(f.state.run.status, 'cancelled'); assert.equal(f.state.phase, 'idle'); assert.equal(f.posts[0].action, 'cancel_evaluation');
});

test('cancel reports completion honestly when the server finished before the cancellation arrived', async () => {
  const f = fixture({ run: { id: 'run', status: 'running', results: [] }, phase: 'dataset' });
  await f.actions.cancelDataset();
  assert.equal(f.state.run.status, 'completed'); assert.match(f.state.notice, /완료/); assert.doesNotMatch(f.state.notice, /취소했습니다/);
});

test('an external retest replaces an owned result and clears its previous progress', () => {
  const f = fixture({ hasStarted: true, execution: { input: '질문', result: { ...result, id: 'old-result' } }, initialExecution: { input: '다시 질문', result: { ...result, id: 'new-result' } }, incomingExecutionId: { current: 'old-result' }, progress: [event] });
  f.syncExternalExecution();
  assert.equal(f.state.execution.result.id, 'new-result'); assert.equal(f.state.execution.input, '다시 질문'); assert.equal(f.state.progress.length, 0);
});

test('an unchanged external result cannot replace a newer local result after streaming finishes', () => {
  const f = fixture({ hasStarted: true, execution: { input: '새 질문', result: { ...result, id: 'new-result' } }, initialExecution: { input: '이전 질문', result: { ...result, id: 'old-result' } }, incomingExecutionId: { current: 'old-result' } });
  f.syncExternalExecution();
  assert.equal(f.state.execution.result.id, 'new-result');
});

test('worker selection needs a fresh actual heartbeat and waiting delays clean up abort listeners', async () => {
  const f = fixture(), now = Date.now();
  assert.equal(f.actions.runnerWorkerAvailable({ available: true }, now), false);
  assert.equal(f.actions.runnerWorkerAvailable({ available: true, lastSeenAt: new Date(now - 46000).toISOString() }, now), false);
  assert.equal(f.actions.runnerWorkerAvailable({ available: true, lastSeenAt: new Date(now - 1000).toISOString() }, now), true);
  const abort = new AbortController(); const waiting = f.actions.runnerDelay(abort.signal, 60000); abort.abort(); await waiting;
});

test('conversation JSON preserves roles and options while rejecting invalid gateway-shaped inputs', () => {
  const f = fixture();
  const parsed = f.actions.parseRunnerConversation(JSON.stringify({model:'ignored-alias',messages:[{role:'system',content:'정책'},{role:'user',content:'문의'}],temperature:0.4,max_tokens:128,top_p:0.8}));
  assert.deepEqual(structuredClone(parsed),{messages:[{role:'system',content:'정책'},{role:'user',content:'문의'}],generationOptions:{temperature:0.4,max_tokens:128,top_p:0.8}});
  for (const invalid of ['{}','null','[]','not-json',JSON.stringify({messages:[{role:'system',content:'no user'}]}),JSON.stringify({messages:[{role:'tool',content:'wrong role'}]}),JSON.stringify({messages:[{role:'user',content:'ok'}],max_tokens:1.5}),JSON.stringify({messages:[{role:'user',content:'ok'}],stream:true}),JSON.stringify({messages:[{role:'user',content:'ok'}],tools:[]})]) assert.throws(() => f.actions.parseRunnerConversation(invalid));
});

test('conversation execution sends the actual messages and explicit mock response and keeps them for retesting', async () => {
  const f = fixture({inputFormat:'conversation',conversationJson:JSON.stringify({messages:[{role:'system',content:'지시'},{role:'user',content:'문의'}],temperature:0.2}),generationOptions:{max_tokens:64},mockEnabled:true,mockResponse:'고정 응답'});
  await f.actions.executeQuestion();
  const request = JSON.parse(f.requests[0].init.body);
  assert.deepEqual(request.messages,[{role:'system',content:'지시'},{role:'user',content:'문의'}]);
  assert.deepEqual(request.generationOptions,{temperature:0.2,max_tokens:64});
  assert.equal(request.mockResponse,'고정 응답'); assert.equal(request.input,undefined);
  assert.deepEqual(structuredClone(f.shown[0].messages),request.messages); assert.equal(f.shown[0].mockResponse,'고정 응답');
});

test('malformed conversation never saves a draft or starts model execution', async () => {
  const f = fixture({inputFormat:'conversation',conversationJson:'not-json'}); let prepared=0;
  f.state.callbacks.current.onPrepareExecution=async()=>{prepared++;return true;};
  await f.actions.executeQuestion(); assert.equal(prepared,0); assert.equal(f.requests.length,0); assert.match(f.state.error,/JSON/);
});

test('inline results distinguish expected blocks, false blocks, missed violations and rule mismatches', () => {
  const f = fixture();
  const blocked={...result,status:'block',stage:'pre',output:'',expected:'block'};
  assert.equal(f.actions.runnerExpectationMatched(blocked),true);
  const falseBlock={...blocked,expected:'allow'};
  assert.equal(f.actions.runnerResultMatchesFilter(falseBlock,'false_positive'),true);
  const missed={...result,expected:'block'};
  assert.equal(f.actions.runnerResultMatchesFilter(missed,'false_negative'),true);
  const stageMismatch={...blocked,expectedStage:'post'};
  assert.equal(f.actions.runnerResultMatchesFilter(stageMismatch,'mismatch'),true);
  assert.equal(f.actions.runnerResultMatchesFilter({...blocked,status:'error'},'error'),true);
});

test('receive stop aborts only the reader and invalidates late events without claiming server cancellation', () => {
  const f=fixture({phase:'question',progress:[event]}); f.state.controller.current=new AbortController(); const abort=f.state.controller.current;
  f.actions.stopQuestion(); assert.equal(abort.signal.aborted,true); assert.equal(f.state.phase,'idle'); assert.equal(f.state.epoch.current,1); assert.equal(f.state.progress.length,0); assert.match(f.state.notice,/모델 호출은.*계속/);
});

test('dataset row selection retains conversation content and generation settings for a faithful retest', () => {
  const f=fixture();
  f.actions.showRow({results:[{...result,rowId:'row',input:'사례 이름',messages:[{role:'user',content:'실제 질문'}],generationOptions:{max_tokens:64}}]},'row');
  assert.match(f.state.execution.input,/실제 질문/); assert.equal(f.state.execution.messages[0].content,'실제 질문'); assert.equal(f.state.execution.generationOptions.max_tokens,64);
});
