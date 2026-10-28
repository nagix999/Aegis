'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronRight, Database, LoaderCircle, MessageSquare, Play, Square, Braces } from 'lucide-react';
import type { AppState, Connection, ConversationMessage, GenerationSettings, EvalResult, EvalRun, EvaluationStatus, ExecutionResult, Workflow, WorkflowProgressEvent } from '@/lib/aegis-types';
import { configurationFingerprint, executionConfiguration, matchesExpectation, referencedConnections } from '@/lib/workflow-review';
import { evaluationPreflight, inspectDatasetCompatibility } from '@/lib/dataset-compatibility';
import { Tag, type Act } from './console-ui';
import { PolicyExecutionSummary, policyRouteLabels } from './policy-execution-summary';
import './workflow-runner.css';

export type WorkflowRunnerExecution = { input: string; result: ExecutionResult; fingerprint?: string; messages?: ConversationMessage[]; generationOptions?: GenerationSettings; mockResponse?: string };
type WorkflowStreamMessage = { type: 'progress'; event: WorkflowProgressEvent } | { type: 'result'; result: ExecutionResult; fingerprint?: string } | { type: 'error'; error?: { message?: string; code?: string } };
type RunnerProps = { workflow: Workflow; connections: Connection[]; state?: AppState; act?: Act; readOnly?: boolean; disabled?: boolean; initialExecution?: WorkflowRunnerExecution; onPrepareExecution?: () => Promise<boolean>; onExecution?: (execution: WorkflowRunnerExecution) => void;onSelectPolicyNode?:(nodeId:string)=>void };

export function parseRunnerConversation(text: string): { messages: ConversationMessage[]; generationOptions?: GenerationSettings } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('대화 입력은 올바른 JSON으로 작성하세요.'); }
  const request = Array.isArray(value) ? { messages: value } : value as { messages?: unknown; temperature?: unknown; max_tokens?: unknown; top_p?: unknown };
  if (!request || typeof request !== 'object' || !Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 32) throw new Error('messages에 1~32개의 메시지가 필요합니다.');
  const unsupported = Object.keys(request).filter(key => !['model','messages','temperature','max_tokens','top_p','stream'].includes(key));
  if (unsupported.length) throw new Error(`지원하지 않는 요청 필드: ${unsupported.join(', ')}`);
  if ('stream' in request && request.stream !== false && request.stream !== undefined) throw new Error('응답 검사를 위해 stream은 false로 설정하세요.');
  const messages = request.messages.map((message: unknown) => {
    const item = message as ConversationMessage;
    if (!item || !['system','user','assistant'].includes(item.role) || typeof item.content !== 'string' || item.content.length < 1 || item.content.length > 16000) throw new Error('각 메시지의 role과 1~16,000자 텍스트 content를 확인하세요.');
    return { role: item.role, content: item.content };
  });
  if (!messages.some(message => message.role === 'user') || messages.reduce((total,message) => total + message.content.length,0) > 40000) throw new Error('user 메시지가 하나 이상 필요하며 전체 대화는 40,000자 이하여야 합니다.');
  const generationOptions: GenerationSettings = {};
  for (const [key,min,max,integer] of [['temperature',0,2,false],['max_tokens',1,8192,true],['top_p',0,1,false]] as const) {
    const value = request[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw new Error(`${key} 값을 확인하세요 (${min}~${max}).`);
    generationOptions[key] = value;
  }
  return { messages, ...(Object.keys(generationOptions).length ? { generationOptions } : {}) };
}

export type RunnerResultFilter = 'all' | 'mismatch' | 'false_positive' | 'false_negative' | 'error';
export function runnerExpectationMatched(row: EvalResult): boolean { return row.expectationMatched ?? matchesExpectation(row, row); }
export function runnerResultMatchesFilter(row: EvalResult, filter: RunnerResultFilter): boolean {
  if (filter === 'mismatch') return !runnerExpectationMatched(row);
  if (filter === 'false_positive') return row.expected === 'allow' && row.status === 'block';
  if (filter === 'false_negative') return row.expected === 'block' && row.status === 'allow';
  return filter === 'error' ? row.status === 'error' : true;
}

export function runnerWorkerAvailable(status: AppState['evaluationWorker'], now = Date.now()): boolean {
  return Boolean(status?.available && status.lastSeenAt && Number.isFinite(Date.parse(status.lastSeenAt)) && now - Date.parse(status.lastSeenAt) < 45_000);
}

/** Decode actual server events, including a UTF-8 character split across chunks. */
export async function readWorkflowEvents(response: Response, onMessage: (message: WorkflowStreamMessage) => void): Promise<void> {
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
    throw new Error(body?.error?.message || '워크플로우를 실행하지 못했습니다. 서버 연결과 설정을 확인하세요.');
  }
  if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('실행 내역을 받지 못했습니다. 서버 연결을 확인하세요.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', finished = false, messages = 0;
  const deliver = (line: string) => {
    if (!line.trim()) return;
    if (++messages > 4000) throw new Error('실행 내역의 수신 한도를 초과했습니다.');
    const message = JSON.parse(line) as WorkflowStreamMessage;
    if (!message || !['progress', 'result', 'error'].includes(message.type)) throw new Error('실행 내역의 형식을 확인하지 못했습니다.');
    if (message.type === 'progress' && (!message.event || !Number.isInteger(message.event.sequence) || !['pre','main','post','complete'].includes(message.event.stage) || typeof message.event.nodeId !== 'string' || !['running','completed','block','error','skipped'].includes(message.event.status) || !Array.isArray(message.event.edgeIds))) throw new Error('실행 단계의 형식을 확인하지 못했습니다.');
    if (message.type === 'result' && (!message.result || typeof message.result.id !== 'string' || !['allow','block','error'].includes(message.result.status) || typeof message.result.output !== 'string' || !Array.isArray(message.result.traces))) throw new Error('실행 결과의 형식을 확인하지 못했습니다.');
    if (message.type === 'error') throw new Error(message.error?.message || '워크플로우 실행 중 오류가 발생했습니다.');
    if (finished) throw new Error('완료된 실행 뒤에 추가 내역이 도착했습니다.');
    if (message.type === 'result') finished = true;
    onMessage(message);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000) throw new Error('실행 결과의 수신 한도를 초과했습니다.');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) { deliver(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      if (done) break;
    }
    if (buffer.trim()) deliver(buffer);
    if (!finished) throw new Error('실행 내역의 연결이 끊겼습니다. 서버의 처리 여부를 확인한 뒤 다시 실행하세요.');
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

export function runnerDelay(signal: AbortSignal | undefined, milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    if (signal?.aborted) finish(); else signal?.addEventListener('abort', finish, { once: true });
  });
}

export function useWorkflowRunner({ workflow, connections, state, act, readOnly = false, disabled = false, initialExecution, onPrepareExecution, onExecution, onSelectPolicyNode }: RunnerProps) {
  const initialMessages = initialExecution?.messages || (initialExecution?.result as EvalResult | undefined)?.messages;
  const initialOptions = initialExecution?.generationOptions || (initialExecution?.result as EvalResult | undefined)?.generationOptions;
  const [mode, setMode] = useState<'question' | 'dataset'>('question');
  const [question, setQuestion] = useState(initialExecution?.input || '');
  const [inputFormat, setInputFormat] = useState<'question' | 'conversation'>(initialMessages?.length ? 'conversation' : 'question');
  const [conversationJson, setConversationJson] = useState(initialMessages?.length ? JSON.stringify({messages: initialMessages, ...initialOptions},null,2) : '{\n  "messages": [\n    { "role": "system", "content": "질문에 간단히 답하세요." },\n    { "role": "user", "content": "배송은 얼마나 걸리나요?" }\n  ]\n}');
  const [generationOptions, setGenerationOptions] = useState<GenerationSettings>(initialOptions || {});
  const [mockEnabled, setMockEnabled] = useState(initialExecution?.mockResponse !== undefined);
  const [mockResponse, setMockResponse] = useState(initialExecution?.mockResponse || '');
  const [resultFilter, setResultFilter] = useState<RunnerResultFilter>('all');
  const [startedAt, setStartedAt] = useState<number>();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [datasetId, setDatasetId] = useState(state?.datasets[0]?.id || '');
  const [acknowledged, setAcknowledged] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'question' | 'dataset'>('idle');
  const [progress, setProgress] = useState<WorkflowProgressEvent[]>([]);
  const [execution, setExecution] = useState<WorkflowRunnerExecution>();
  const [hasStarted, setHasStarted] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [run, setRun] = useState<EvalRun>();
  const [selectedRowId, setSelectedRowId] = useState('');
  const [workerStatus, setWorkerStatus] = useState(state?.evaluationWorker);
  const mounted = useRef(true), epoch = useRef(0), controller = useRef<AbortController | undefined>(undefined);
  const selectedRow = useRef('');
  const incomingExecutionId = useRef(initialExecution?.result.id);
  const callbacks = useRef({ onPrepareExecution, onExecution, act });
  callbacks.current = { onPrepareExecution, onExecution, act };
  const dataset = state?.datasets.find(item => item.id === datasetId);
  const semanticConfiguration = useMemo(() => JSON.stringify({ workflow: executionConfiguration(workflow), connections: referencedConnections(workflow, connections) }), [workflow, connections]);
  const datasetContext = dataset ? JSON.stringify({ ...dataset, updatedAt: undefined }) : '';
  const contextKey = `${workflow.id}:${semanticConfiguration}:${mode === 'dataset' ? datasetContext : ''}`;
  const latestContext = useRef(contextKey);
  latestContext.current = contextKey;
  const compatibility = useMemo(() => dataset ? inspectDatasetCompatibility(dataset, workflow) : undefined, [dataset, workflow]);
  const active = phase !== 'idle';
  const available = Boolean(state && act && onPrepareExecution);
  const locked = disabled || active || readOnly || !available;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; controller.current?.abort(); };
  }, [workflow.id]);
  useEffect(() => { setAcknowledged(false); }, [contextKey]);
  useEffect(() => {
    if (!active || !startedAt) return;
    const update = () => setElapsedMs(Date.now() - startedAt);
    update(); const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [active, startedAt]);
  useEffect(() => { if (state?.evaluationWorker) setWorkerStatus(state.evaluationWorker); }, [state?.evaluationWorker]);
  useEffect(() => { const changed = incomingExecutionId.current !== initialExecution?.result.id; incomingExecutionId.current = initialExecution?.result.id; if (!active && changed && hasStarted && initialExecution && initialExecution.result.id !== execution?.result.id) { setExecution(initialExecution); setProgress([]); } }, [initialExecution?.result.id, active]);
  useEffect(() => { if (state && !state.datasets.some(item => item.id === datasetId)) setDatasetId(state.datasets[0]?.id || ''); }, [state?.datasets, datasetId]);

  function showExecution(next: WorkflowRunnerExecution) { setExecution(next); callbacks.current.onExecution?.(next); }
  function showRow(current: EvalRun, rowId: string) {
    const row = current.results.find(item => item.rowId === rowId);
    if (!row) return;
    selectedRow.current = rowId; setSelectedRowId(rowId); setProgress([]);
    showExecution({ input: row.messages?.length ? JSON.stringify({ messages: row.messages, ...row.generationOptions },null,2) : row.input, result: row, fingerprint: current.fingerprint, ...(row.messages ? { messages: row.messages } : {}), ...(row.generationOptions ? { generationOptions: row.generationOptions } : {}) });
  }
  function applyRun(current: EvalRun) {
    setRun(current);
    // New results never replace an item the user has already selected.
    if (!selectedRow.current && current.results[0]) showRow(current, current.results[0].rowId);
  }
  function stillCurrent(ticket: number) { return mounted.current && ticket === epoch.current; }
  async function prepare(key: string): Promise<boolean> {
    const prepared = await callbacks.current.onPrepareExecution?.();
    if (!mounted.current) return false;
    if (!prepared) { setError('실행 전에 설정을 확인하고 초안을 저장하세요.'); return false; }
    if (latestContext.current !== key) { setError('실행을 준비하는 동안 설정이나 데이터셋이 바뀌었습니다. 내용을 확인한 뒤 다시 실행하세요.'); return false; }
    return true;
  }

  async function executeQuestion() {
    if (locked || (inputFormat !== 'conversation' && !question.trim())) return;
    const ticket = ++epoch.current, key = contextKey, previous = execution || initialExecution;
    let input = question;
    let requestInput: { input?: string; messages?: ConversationMessage[]; generationOptions?: GenerationSettings; mockResponse?: string } = { input: question };
    try {
      if (inputFormat === 'conversation') {
        const parsed = parseRunnerConversation(conversationJson);
        input = parsed.messages.map(message => `${message.role}: ${message.content}`).join('\n\n');
        requestInput = parsed;
      }
      if (generationOptions && Object.keys(generationOptions).length) requestInput.generationOptions = { ...requestInput.generationOptions, ...generationOptions };
      if (mockEnabled) requestInput.mockResponse = mockResponse;
    } catch (failure) { setError(failure instanceof Error ? failure.message : '입력 형식을 확인하세요.'); return; }
    let completed = false;
    setStartedAt(Date.now()); setElapsedMs(0); setPhase('preparing'); setError(''); setNotice('');
    try {
      const fingerprint = await configurationFingerprint(workflow, connections);
      if (!stillCurrent(ticket) || !await prepare(key) || !stillCurrent(ticket)) return;
      setHasStarted(true); setExecution(undefined); setProgress([]); setRun(undefined); setResultFilter('all'); setSelectedRowId(''); selectedRow.current = '';
      setPhase('question');
      const abort = new AbortController(); controller.current = abort;
      const response = await fetch('/api/console', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ action: 'playground', workflowId: workflow.id, target: 'draft', ...requestInput, progress: true, expectedFingerprint: fingerprint }), signal: abort.signal });
      await readWorkflowEvents(response, message => {
        if (!stillCurrent(ticket)) return;
        if (message.type === 'progress') setProgress(previous => [...previous, message.event]);
        if (message.type === 'result') { completed = true; showExecution({ input, result: message.result, fingerprint: message.fingerprint || fingerprint, ...requestInput }); setNotice('실행을 마쳤습니다. 노드를 선택하면 검사 결과를 확인할 수 있습니다.'); }
      });
    } catch (failure) {
      if (stillCurrent(ticket)) { setError(failure instanceof Error ? failure.message : '워크플로우를 실행하지 못했습니다.'); setProgress([]); if (!completed && previous) { setExecution(previous); setNotice('아래에는 이전에 완료한 실행 결과를 표시합니다.'); } }
    } finally { if (stillCurrent(ticket)) { setPhase('idle'); controller.current = undefined; } }
  }

  async function driveDataset(initial: EvalRun, ticket: number) {
    let current = initial;
    while (stillCurrent(ticket) && current.status === 'running') {
      if (current.executionMode === 'background') {
        await runnerDelay(controller.current?.signal, 1800);
        if (!stillCurrent(ticket)) return;
        const response = await fetch(`/api/console?view=evaluations&runId=${encodeURIComponent(current.id)}`, { cache: 'no-store', signal: controller.current ? AbortSignal.any([controller.current.signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error('진행 상태를 가져오지 못했습니다. 서버 검증은 계속되며 검증 화면에서 확인할 수 있습니다.');
        const status = await response.json() as EvaluationStatus;
        if (!stillCurrent(ticket)) return;
        if (!status.run) throw new Error('실행 기록을 찾지 못했습니다. 검증 화면에서 확인하세요.');
        setWorkerStatus(status.evaluationWorker);
        current = status.run;
        if (!status.evaluationWorker.available) setNotice('작업자의 연결을 기다리고 있습니다. 완료된 결과는 유지됩니다.');
        else setNotice('서버가 검증을 처리하고 있습니다. 화면을 떠나도 계속 실행합니다.');
      } else {
        const response = await callbacks.current.act?.({ action: 'step_evaluation', runId: current.id });
        if (!stillCurrent(ticket)) return;
        if (!response?.run) throw new Error('검증 처리를 이어가지 못했습니다. 완료된 결과는 검증 화면에 보관됩니다.');
        current = response.run;
        if (response.leaseActive) { applyRun(current); setNotice('다른 요청에서 현재 묶음을 처리하고 있습니다. 검증 화면에서 이어서 실행하세요.'); return; }
      }
      if (stillCurrent(ticket)) applyRun(current);
    }
    if (stillCurrent(ticket)) setNotice(current.status === 'completed' ? `${current.results.length}개 항목의 검증을 마쳤습니다. 완료된 항목을 선택해 흐름을 확인하세요.` : current.status === 'cancelled' ? '검증을 취소했습니다. 완료된 결과는 유지합니다.' : current.error || '검증 실행 중 오류가 발생했습니다.');
  }

  async function executeDataset() {
    if (locked || !dataset || compatibility?.requiresAcknowledgement && !acknowledged) return;
    const ticket = ++epoch.current, key = contextKey;
    setStartedAt(Date.now()); setElapsedMs(0); setPhase('preparing'); setError(''); setNotice('');
    try {
      const proof = await evaluationPreflight(dataset, [{ key: 'candidate', label: '현재 초안', workflow, connections }]);
      if (!stillCurrent(ticket) || !await prepare(key) || !stillCurrent(ticket)) return;
      const checked = await evaluationPreflight(dataset, [{ key: 'candidate', label: '현재 초안', workflow, connections }]);
      if (!stillCurrent(ticket)) return;
      if (proof.fingerprint !== checked.fingerprint || latestContext.current !== key) throw new Error('검증 대상이 변경되었습니다. 기준을 다시 확인하세요.');
      const response = await callbacks.current.act?.({ action: 'start_evaluation', workflowId: workflow.id, datasetId: dataset.id, target: 'draft', executionMode: runnerWorkerAvailable(workerStatus) ? 'background' : 'manual', preflightFingerprint: checked.fingerprint, acknowledgeCriteria: checked.requiresAcknowledgement && acknowledged });
      if (!stillCurrent(ticket)) return;
      if (!response?.run) throw new Error('검증 작업을 만들지 못했습니다. 오류 안내를 확인한 뒤 다시 실행하세요.');
      setHasStarted(true); setExecution(undefined); setProgress([]); setSelectedRowId(''); setResultFilter('all'); selectedRow.current = '';
      applyRun(response.run); setPhase('dataset');
      controller.current = new AbortController();
      setNotice(response.run.executionMode === 'background' ? '서버가 검증을 처리합니다. 화면을 떠나도 계속 실행합니다.' : '현재 화면에서 검증합니다. 화면을 떠나면 현재 묶음까지만 처리합니다.');
      await driveDataset(response.run, ticket);
    } catch (failure) { if (stillCurrent(ticket)) setError(failure instanceof Error ? failure.message : '데이터셋을 실행하지 못했습니다.'); }
    finally { if (stillCurrent(ticket)) { setPhase('idle'); controller.current = undefined; } }
  }

  async function cancelDataset() {
    if (!run || readOnly || !callbacks.current.act) return;
    const previousTicket = epoch.current;
    epoch.current++; controller.current?.abort(); setPhase('preparing');
    try {
      const response = await callbacks.current.act({ action: 'cancel_evaluation', runId: run.id });
      if (!mounted.current) return;
      if (response?.run) {
        applyRun(response.run);
        setNotice(response.run.status === 'cancelled' ? '검증을 취소했습니다. 완료된 항목은 계속 확인할 수 있습니다.' : response.run.status === 'completed' ? '이미 검증을 완료했습니다. 완료된 항목을 선택해 결과를 확인하세요.' : response.run.error || '서버에 저장된 검증 상태를 확인했습니다.');
      }
      else { setError('취소 여부를 확인하지 못했습니다. 검증 화면에서 현재 상태를 확인하세요.'); epoch.current = Math.max(epoch.current, previousTicket + 1); }
    } finally { if (mounted.current) { setPhase('idle'); controller.current = undefined; } }
  }

  function stopQuestion() {
    if (phase !== 'question') return;
    epoch.current++; controller.current?.abort(); controller.current = undefined;
    setPhase('idle'); setProgress([]);
    setNotice('결과 수신을 중지했습니다. 서버의 모델 호출은 제한 시간까지 계속될 수 있습니다. 요청 기록에서 처리 여부를 확인하세요.');
  }

  const current = [...progress].reverse().find(event => event.status === 'running' && !progress.some(next => next.sequence > event.sequence && next.nodeId === event.nodeId && next.stage === event.stage && next.attempt === event.attempt && next.status !== 'running'));
  const currentLabel = current?.stage === 'pre' ? '요청 검사 중' : current?.stage === 'main' ? '응답 생성 중' : current?.stage === 'post' ? '응답 검사 중' : phase === 'preparing' ? '실행 준비 중' : phase === 'question' ? '실행 내역 확인 중' : phase === 'dataset' ? '데이터셋 검증 중' : '';
  const visibleExecution = execution || (!hasStarted ? initialExecution : undefined);
  const selectedResult = run?.results.find(row => row.rowId === selectedRowId);
  const rowSummary = {
    matched: run?.results.filter(runnerExpectationMatched).length || 0,
    falsePositive: run?.results.filter(row => runnerResultMatchesFilter(row,'false_positive')).length || 0,
    falseNegative: run?.results.filter(row => runnerResultMatchesFilter(row,'false_negative')).length || 0,
    errors: run?.results.filter(row => row.status === 'error').length || 0,
  };
  const panel = <div className="wr-panel">
    <div className="wr-input-column">
    <div className="wr-mode" aria-label="실행 입력 종류"><button type="button" className={mode === 'question' ? 'active' : ''} aria-pressed={mode === 'question'} disabled={active} onClick={() => setMode('question')}><MessageSquare size={13} /> 질문과 대화</button><button type="button" className={mode === 'dataset' ? 'active' : ''} aria-pressed={mode === 'dataset'} disabled={active} onClick={() => setMode('dataset')}><Database size={13} /> 데이터셋</button></div>
    {mode === 'question' ? <>
      <div className="wr-input-tabs" aria-label="요청 입력 방식"><button type="button" aria-pressed={inputFormat === 'question'} onClick={() => setInputFormat('question')} disabled={active}>질문</button><button type="button" aria-pressed={inputFormat === 'conversation'} onClick={() => setInputFormat('conversation')} disabled={active}><Braces size={12}/> 대화와 API 요청</button></div>
      {inputFormat === 'question' ? <><label className="field">질문<textarea aria-label="워크플로우 실행 질문" value={question} maxLength={16000} rows={4} disabled={locked} onChange={event => setQuestion(event.target.value)} placeholder="검사할 질문을 입력하세요." /></label><div className="wr-input-count">{question.length.toLocaleString()} / 16,000자</div></> : <><label className="field">대화 JSON<textarea className="wr-json" aria-label="워크플로우 대화 요청 JSON" value={conversationJson} maxLength={100000} rows={6} disabled={locked} onChange={event => setConversationJson(event.target.value)} spellCheck={false} /></label><p className="wr-description">messages 배열 또는 API 요청 객체를 붙여 넣으세요. system, user, assistant 메시지와 temperature, max_tokens, top_p를 읽습니다. 모델은 현재 초안의 설정을 사용합니다.</p></>}
      <details className="wr-advanced"><summary>생성 옵션과 모의 응답</summary><p className="wr-description">여기서 지정한 생성 옵션을 대화 JSON의 값보다 우선 적용합니다.</p><div className="wr-generation-options">{([['temperature','다양성',0,2,0.1],['max_tokens','최대 출력 토큰',1,8192,1],['top_p','top_p',0,1,0.05]] as const).map(([key,label,min,max,step]) => <label className="field" key={key}>{label}<input type="number" aria-label={label} min={min} max={max} step={step} value={generationOptions[key] ?? ''} placeholder="기본값" disabled={locked} onChange={event => { const value = event.target.value; setGenerationOptions(previous => { const next = {...previous}; if (value === '') delete next[key]; else next[key] = Number(value); return next; }); }}/></label>)}</div><label className="wr-mock-toggle"><input type="checkbox" checked={mockEnabled} disabled={locked} onChange={event => setMockEnabled(event.target.checked)}/> 응답 생성을 모의 응답으로 대체</label>{mockEnabled && <><label className="field">응답 검사에 보낼 내용<textarea aria-label="응답 검사 모의 응답" value={mockResponse} maxLength={40000} rows={3} disabled={locked} onChange={event => setMockResponse(event.target.value)} /></label><p className="wr-mock-note">모델 응답 생성을 호출하지 않고 입력한 응답을 검사합니다. LLM 기반 검사는 설정된 연결을 사용합니다. 실제 모델 검증이나 배포 근거로 사용하지 않습니다.</p></>}</details>
    </> : <><label className="field">검증 데이터셋<select aria-label="워크플로우 검증 데이터셋" value={datasetId} disabled={locked} onChange={event => setDatasetId(event.target.value)}>{!state?.datasets.length && <option value="">등록된 데이터셋 없음</option>}{state?.datasets.map(item => <option key={item.id} value={item.id}>{item.name} ({item.rows.length}개)</option>)}</select></label>{dataset && <p className="wr-description">{dataset.description || `${dataset.rows.length}개 항목의 예상 결과와 실제 결과를 비교합니다.`}</p>}{compatibility && compatibility.issues.length > 0 && <div className="wr-criteria"><strong>검증 기준 {compatibility.issues.length}건을 확인하세요</strong><ul>{compatibility.issues.slice(0,4).map((issue,index) => <li key={`${issue.rowId}-${issue.code}-${index}`}>{issue.rowNumber}번: {issue.message}</li>)}</ul>{compatibility.issues.length > 4 && <p>나머지 {compatibility.issues.length - 4}건은 데이터셋 관리에서 확인할 수 있습니다.</p>}<label><input type="checkbox" checked={acknowledged} disabled={locked} onChange={event => setAcknowledged(event.target.checked)} />현재 기준으로 실행합니다</label></div>}</>}
    {readOnly && <p className="wr-description">조회 권한으로 접속했습니다. 저장된 결과만 확인할 수 있습니다.</p>}
    {!available && !readOnly && <p className="wr-description">이 화면에서는 실행 연결을 사용할 수 없습니다. 검증 화면을 이용하세요.</p>}
    <div className="wr-actions"><button type="button" className="btn small primary" disabled={locked || (mode === 'question' ? inputFormat === 'conversation' ? !conversationJson.trim() : !question.trim() : !dataset || Boolean(compatibility?.requiresAcknowledgement && !acknowledged))} onClick={() => void (mode === 'question' ? executeQuestion() : executeDataset())}>{active ? <LoaderCircle className="wr-spin" size={13} /> : <Play size={13} />}{active ? '실행 중' : mode === 'question' ? inputFormat === 'conversation' ? '대화 실행' : '질문 실행' : '데이터셋 실행'}</button>{phase === 'question' && <button type="button" className="btn small" onClick={stopQuestion}><Square size={11}/> 결과 수신 중지</button>}{run?.status === 'running' && <button type="button" className="btn small" disabled={readOnly || phase === 'preparing'} onClick={() => void cancelDataset()}><Square size={11} />검증 취소</button>}</div>
    {currentLabel && <p className="wr-live" role="status"><LoaderCircle size={13} className="wr-spin" />{currentLabel} / {Math.floor(elapsedMs / 1000)}초 경과</p>}
    <p className="wr-description">실행 전 현재 초안을 저장합니다. 입력과 결과는 브라우저 임시 초안에 저장하지 않습니다.</p>
    {notice && <p className="wr-notice" role="status">{notice}</p>}{error && <p className="wr-error" role="alert">{error}</p>}
    </div><div className="wr-output-column">
    {run && <section className="wr-results" aria-label="데이터셋 실행 결과"><div><strong>데이터셋 결과</strong><span>{run.results.length} / {run.total ?? run.datasetSnapshot?.rows.length ?? run.results.length}개 완료</span></div><progress aria-label="워크플로우 데이터셋 검증 완료" max={Math.max(run.total || 1,1)} value={run.results.length} /><div className="wr-result-summary"><span>예상과 일치 <strong>{rowSummary.matched}</strong></span><span>정상 요청 차단 <strong>{rowSummary.falsePositive}</strong></span><span>위반 요청 허용 <strong>{rowSummary.falseNegative}</strong></span><span>오류 <strong>{rowSummary.errors}</strong></span></div><label className="wr-result-filter">결과 보기<select aria-label="워크플로우 실행 결과 필터" value={resultFilter} onChange={event => setResultFilter(event.target.value as RunnerResultFilter)}><option value="all">전체</option><option value="mismatch">예상과 불일치</option><option value="false_positive">정상 요청 차단</option><option value="false_negative">위반 요청 허용</option><option value="error">실행 오류</option></select></label><ol>{run.results.filter(row => runnerResultMatchesFilter(row,resultFilter)).map(row => <li key={row.rowId}><button type="button" className={selectedRowId === row.rowId ? 'selected' : ''} aria-pressed={selectedRowId === row.rowId} onClick={() => showRow(run,row.rowId)}><span className="wr-row-number">{run.results.indexOf(row) + 1}</span><span className="wr-row-input">{row.input}</span><span className="wr-row-expected">예상 {row.expected === 'allow' ? '허용' : '차단'}</span><Tag tone={row.status === 'allow' ? 'success' : row.status === 'block' ? 'warning' : 'error'}>{row.status === 'allow' ? '허용' : row.status === 'block' ? '차단' : '오류'}</Tag><Tag tone={runnerExpectationMatched(row) ? 'success' : 'error'}>{runnerExpectationMatched(row) ? '일치' : '불일치'}</Tag><ChevronRight size={12} /></button></li>)}</ol>{run.results.length > 0 && !run.results.some(row => runnerResultMatchesFilter(row,resultFilter)) && <p>선택한 조건에 해당하는 완료 항목이 없습니다.</p>}{run.status === 'completed' && <p className="wr-completed"><CheckCircle2 size={13} />실행 완료 / 예상과 일치 {rowSummary.matched}개, 불일치 {run.results.length - rowSummary.matched}개</p>}</section>}
    {visibleExecution ? <div className="wr-last-result"><strong>선택한 실행 결과</strong>{visibleExecution.result.executionMode === 'mock' && <Tag tone="warning">모의 응답</Tag>}<Tag tone={visibleExecution.result.status === 'allow' ? 'success' : visibleExecution.result.status === 'block' ? 'warning' : 'error'}>{visibleExecution.result.status === 'allow' ? '응답 반환' : visibleExecution.result.status === 'block' ? '차단' : '실행 오류'}</Tag>{selectedResult && <div className="wr-selected-expectation"><span>예상: {selectedResult.expected === 'allow' ? '허용' : '차단'}</span><span>실제: {selectedResult.status === 'allow' ? '허용' : selectedResult.status === 'block' ? '차단' : '오류'}</span><strong>{runnerExpectationMatched(selectedResult) ? '예상과 일치' : '예상과 불일치'}</strong>{selectedResult.expectedDecision && <small>기대 정책 판정: {selectedResult.expectedDecision}</small>}{selectedResult.expectedRoute && <small>기대 정책 경로: {policyRouteLabels[selectedResult.expectedRoute]}</small>}{selectedResult.expectedPolicyCode && <small>기대 오류 코드: {selectedResult.expectedPolicyCode}</small>}{selectedResult.expectedStage && <small>기대 종료 단계: {{pre:'요청 검사',main:'응답 생성',post:'응답 검사',complete:'응답 반환'}[selectedResult.expectedStage]}</small>}{selectedResult.expectedRuleId && <small>기대한 검사: {[...(run?.workflowSnapshot?.pre || workflow.pre),...(run?.workflowSnapshot?.post || workflow.post)].flatMap(group => group.rules).find(rule => rule.id === selectedResult.expectedRuleId)?.name || selectedResult.expectedRuleId}</small>}</div>}<PolicyExecutionSummary result={visibleExecution.result} workflow={run?.workflowSnapshot??workflow} onSelectNode={onSelectPolicyNode} /><p>{visibleExecution.result.reason}</p><details className="wr-request"><summary>실행 요청 확인</summary><pre>{visibleExecution.input}</pre></details>{visibleExecution.result.status === 'allow' && <pre>{visibleExecution.result.output || '(빈 응답)'}</pre>}{visibleExecution.result.finishReason === 'length' && <p className="wr-mock-note">출력 토큰 한도에 도달해 응답이 잘렸습니다.</p>}</div> : <div className="wr-empty"><Play size={18}/><strong>실행 결과를 이곳에서 확인합니다.</strong><p>완료된 항목과 노드를 선택하면 해당 요청의 경로와 검사 근거를 함께 볼 수 있습니다.</p></div>}
    </div>
  </div>;
  return { panel, progress, running: phase === 'question', busy: active, execution, hasStarted, currentLabel, elapsedMs };
}
