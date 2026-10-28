'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, Copy, Loader2, RefreshCw, X } from 'lucide-react';
import type { AppState, Connection, Dataset, Workflow } from '@/lib/aegis-types';
import { applyDatasetRuleMappings, inspectDatasetCompatibility, suggestDatasetRuleMappings, type DatasetRuleMappingSuggestion, type EvaluationPreflight } from '@/lib/dataset-compatibility';
import { configurationFingerprint, datasetFingerprint, executionConfiguration, referencedConnections } from '@/lib/workflow-review';
import type { Act } from './console-ui';
import './dataset-preflight.css';

export type DatasetPreflightPanelProps = {
  dataset: Dataset;
  workflow: Workflow;
  state: AppState;
  act: Act;
  target: 'draft' | 'deployed';
  workflowConnections?: Connection[];
  targetLabel?: string;
  preflight?: EvaluationPreflight;
  checking?: boolean;
  error?: string;
  acknowledged?: boolean;
  onAcknowledgedChange?: (value: boolean) => void;
  showAcknowledgement?: boolean;
  onEditRow?: (rowId: string) => void;
  onMappedDataset?: (datasetId: string) => void;
  onBusyChange?: (busy: boolean) => void;
  readOnly?: boolean;
  busy?: boolean;
  mappingDisabledReason?: string;
  mappingNote?: string;
};

type MappingReview = {
  dataset: Dataset;
  workflow: Workflow;
  connections: Connection[];
  target: 'draft' | 'deployed';
  targetLabel: string;
  contextKey: string;
  suggestions: DatasetRuleMappingSuggestion[];
  datasetFingerprint: string;
  workflowFingerprint: string;
};
const stageLabel = { pre: '요청 검사', post: '응답 검사' };
const copyName = (dataset: Dataset, workflow: Workflow) => `${dataset.name.slice(0, 80)} / ${(workflow.name || '워크플로우').slice(0, 30)}`.slice(0, 120);

export function DatasetPreflightPanel({ dataset, workflow, state, act, target, workflowConnections, targetLabel, preflight, checking = false, error, acknowledged = false, onAcknowledgedChange, showAcknowledgement = Boolean(onAcknowledgedChange), onEditRow, onMappedDataset, onBusyChange, readOnly = false, busy = false, mappingDisabledReason, mappingNote }: DatasetPreflightPanelProps) {
  const connections = workflowConnections || state.connections;
  const actualTargetLabel = targetLabel || (target === 'deployed' ? '최근 배포 버전' : '현재 초안');
  const compatibility = useMemo(() => inspectDatasetCompatibility(dataset, workflow), [dataset, workflow]);
  const issues = !checking && preflight ? preflight.issues : compatibility.issues.map(issue => ({ ...issue, sideLabel: actualTargetLabel, sideKey: 'candidate' as const }));
  const affectedRows = new Set(issues.map(issue => issue.rowId)).size;
  const hasRuleIssues = compatibility.issues.some(issue => Boolean(issue.ruleId) && ['missing_rule', 'disabled_rule', 'ambiguous_rule', 'rule_stage_mismatch'].includes(issue.code));
  const [expanded, setExpanded] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [review, setReview] = useState<MappingReview>();
  const [name, setName] = useState('');
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mappingError, setMappingError] = useState('');
  const [created, setCreated] = useState<Dataset>();
  const dialog = useRef<HTMLElement>(null);
  const mappingTrigger = useRef<HTMLButtonElement>(null);
  const openRef = useRef(false);
  const savingRef = useRef(false);
  const request = useRef(0);
  const mounted = useRef(true);
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  const mappedCallback = useRef(onMappedDataset); mappedCallback.current = onMappedDataset;
  const { updatedAt: _datasetUpdatedAt, ...datasetContents } = dataset;
  const cloneSource = (workflow as Workflow & { cloneSource?: unknown }).cloneSource;
  const contextKey = JSON.stringify({ dataset: datasetContents, workflow: executionConfiguration(workflow), cloneSource, connections: referencedConnections(workflow, connections), target });
  const latestContext = useRef(contextKey); latestContext.current = contextKey;
  const writable = !readOnly && state.role !== 'viewer';
  const latestWritable = useRef(writable); latestWritable.current = writable;
  const staleReview = Boolean(review && review.contextKey !== contextKey);
  const atLimit = state.datasets.length >= 30;
  const remaining = review?.suggestions.filter(suggestion => !mappings[suggestion.sourceRuleId]).length || 0;
  const changedCriteria = review?.dataset.rows.filter(row => row.expectedRuleId && mappings[row.expectedRuleId] && mappings[row.expectedRuleId] !== row.expectedRuleId).length || 0;
  const validationError = useMemo(() => {
    if (!review || remaining) return '';
    try { applyDatasetRuleMappings(review.dataset, review.workflow, mappings); return ''; }
    catch (failure) { return failure instanceof Error ? failure.message : '선택한 예상 검사를 확인하세요.'; }
  }, [review, mappings, remaining]);
  const canCreate = Boolean(review && !reviewing && !saving && !busy && writable && !staleReview && !atLimit && !remaining && !validationError && !created && name.trim() && !mappingDisabledReason);

  useEffect(() => { setExpanded(false); }, [contextKey]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; openRef.current = false; request.current++; busyCallback.current?.(false); };
  }, []);
  useEffect(() => {
    if (writable || !mappingOpen || savingRef.current || created) return;
    openRef.current = false; request.current++; setMappingOpen(false); setReview(undefined);
  }, [writable, mappingOpen, saving, created]);
  useEffect(() => {
    if (!mappingOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const frame = requestAnimationFrame(() => (dialog.current?.querySelector<HTMLElement>('input:not(:disabled)') || dialog.current)?.focus());
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!savingRef.current) closeMapping(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') || [])];
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); dialog.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keys);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', keys); if (previous?.isConnected) previous.focus(); else mappingTrigger.current?.focus(); };
  }, [mappingOpen]);

  function setSavingState(value: boolean) {
    savingRef.current = value;
    if (mounted.current) setSaving(value);
    busyCallback.current?.(value);
  }
  function closeMapping() {
    if (savingRef.current) return;
    openRef.current = false; request.current++; setMappingOpen(false); setReview(undefined); setMappingError(''); setCreated(undefined);
  }
  async function prepareMapping() {
    if (!writable || busy || savingRef.current || mappingDisabledReason) return;
    const ticket = ++request.current;
    openRef.current = true; setMappingOpen(true); setReviewing(true); setMappingError(''); setCreated(undefined); setReview(undefined);
    const datasetSnapshot = structuredClone(dataset), workflowSnapshot = structuredClone(workflow), connectionSnapshot = structuredClone(connections), selectedContext = contextKey;
    try {
      const suggestions = suggestDatasetRuleMappings(datasetSnapshot, workflowSnapshot, state);
      const [dataHash, workflowHash] = await Promise.all([datasetFingerprint(datasetSnapshot), configurationFingerprint(workflowSnapshot, connectionSnapshot)]);
      if (!mounted.current || !openRef.current || ticket !== request.current) return;
      setReview({ dataset: datasetSnapshot, workflow: workflowSnapshot, connections: connectionSnapshot, target, targetLabel: actualTargetLabel, contextKey: selectedContext, suggestions, datasetFingerprint: dataHash, workflowFingerprint: workflowHash });
      setName(copyName(datasetSnapshot, workflowSnapshot));
      setMappings(Object.fromEntries(suggestions.flatMap(suggestion => suggestion.suggestedRuleId ? [[suggestion.sourceRuleId, suggestion.suggestedRuleId]] : [])));
    } catch (failure) { if (mounted.current && ticket === request.current) setMappingError(failure instanceof Error ? failure.message : '예상 검사 연결을 확인하지 못했습니다. 다시 확인하세요.'); }
    finally { if (mounted.current && ticket === request.current) setReviewing(false); }
  }
  async function createMappedCopy() {
    if (!canCreate || !review || savingRef.current || latestContext.current !== review.contextKey || !latestWritable.current) return;
    const submitted = review;
    setSavingState(true); setMappingError('');
    try {
      applyDatasetRuleMappings(submitted.dataset, submitted.workflow, mappings);
      const response = await act({ action: 'create_mapped_dataset', sourceDatasetId: submitted.dataset.id, workflowId: submitted.workflow.id, target: submitted.target, name: name.trim(), mappings: { ...mappings }, expectedDatasetFingerprint: submitted.datasetFingerprint, expectedWorkflowFingerprint: submitted.workflowFingerprint });
      if (!mounted.current) return;
      const copied = response?.dataset;
      if (!copied) { setMappingError('새 데이터셋을 저장하지 못했습니다. 원본 데이터셋이나 워크플로우가 변경되었을 수 있습니다. 현재 설정으로 다시 확인한 뒤 저장하세요.'); return; }
      if (latestContext.current !== submitted.contextKey || !latestWritable.current) { setCreated(copied); setMappingError('복사본은 저장했습니다. 현재 선택이 바뀌어 자동으로 열지 않았습니다. 아래 버튼이나 데이터셋 목록에서 확인하세요.'); return; }
      setSavingState(false); closeMapping(); mappedCallback.current?.(copied.id);
    } catch (failure) { if (mounted.current) setMappingError(failure instanceof Error ? failure.message : '새 데이터셋을 저장하지 못했습니다. 선택한 검사를 확인하세요.'); }
    finally { setSavingState(false); }
  }

  return <section className={`dp-panel ${issues.length ? 'needs-review' : ''}`} aria-label="데이터셋 시작 전 점검">
    <div className="dp-heading"><span className="dp-status-icon">{checking ? <Loader2 size={17} className="spin" /> : issues.length || error ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}</span><div><strong>시작 전 점검</strong><p>{checking ? '선택한 데이터셋과 실행 버전의 검사 기준을 확인하고 있습니다.' : error ? '점검 결과를 확인하지 못했습니다.' : issues.length ? `${affectedRows}개 항목의 예상 검사 기준을 확인하세요. 점검 내용 ${issues.length}개가 있습니다.` : '지정한 검사와 예상 종료 단계에 맞지 않는 항목이 없습니다.'}</p></div>{hasRuleIssues && <button className="btn small" ref={mappingTrigger} disabled={!writable || busy || saving || checking || Boolean(mappingDisabledReason)} onClick={() => void prepareMapping()}><Copy size={13} />이 워크플로우용으로 복사</button>}</div>
    {error && <p className="dp-error" role="alert">{error}</p>}
    {hasRuleIssues && mappingDisabledReason && <p className="dp-note">{mappingDisabledReason}</p>}
    {issues.length > 0 && <><ul className="dp-issues">{(expanded ? issues : issues.slice(0, 8)).map((issue, index) => <li key={`${issue.sideKey}-${issue.rowId}-${issue.code}-${index}`}><div className="dp-issue-label"><span>{issue.sideLabel}</span>{onEditRow ? <button type="button" disabled={busy || saving} onClick={() => onEditRow(issue.rowId)}>{issue.rowNumber}번 항목 확인<ArrowRight size={12} /></button> : <strong>{issue.rowNumber}번 항목</strong>}</div><p>{issue.message}</p>{issue.ruleId && <code>{issue.ruleId}</code>}</li>)}</ul>{issues.length > 8 && <button type="button" className="dp-expand" onClick={() => setExpanded(value => !value)}>{expanded ? '간단히 보기' : `점검 내용 ${issues.length}개 모두 보기`}</button>}</>}
    {showAcknowledgement && issues.length > 0 && <label className="dp-acknowledgement"><input type="checkbox" checked={acknowledged} disabled={!writable || busy || saving || checking || Boolean(error)} onChange={event => onAcknowledgedChange?.(event.target.checked)} /><span>위 기준으로 실행하면 예상 결과와 불일치할 수 있음을 확인했습니다.</span></label>}
    <p className="dp-note">검사 기준의 연결을 확인하는 점검입니다. 실제 허용과 차단 결과는 검증 실행에서 확인합니다.</p>
    {mappingNote && <p className="dp-note">{mappingNote}</p>}
    {mappingOpen && <div className="dp-backdrop" onClick={closeMapping}><section className="dp-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="dataset-mapping-title" onClick={event => event.stopPropagation()}><header><div><h2 id="dataset-mapping-title">예상 검사를 연결해 복사</h2><p>선택한 검사 연결로 새 데이터셋을 만듭니다.</p></div><button type="button" className="icon-button" aria-label="예상 검사 연결 닫기" disabled={saving} onClick={closeMapping}><X size={18} /></button></header><div className="dp-dialog-body">
      {reviewing ? <p className="dp-loading" role="status"><Loader2 size={17} className="spin" />원본과 대상 워크플로우를 확인하고 있습니다.</p> : review && <><dl className="dp-review-summary"><dt>원본 데이터셋</dt><dd>{review.dataset.name}</dd><dt>대상 워크플로우</dt><dd>{review.workflow.name} / {review.targetLabel}</dd><dt>저장할 항목</dt><dd>{review.dataset.rows.length}개, 검사 ID 변경 {changedCriteria}개 항목</dd></dl><p className="dp-preserve">원본 데이터셋을 유지합니다. 요청 내용과 예상 결과, 종료 단계는 바꾸지 않고 검사 ID만 연결합니다.</p><label className="field">새 데이터셋 이름<input maxLength={120} value={name} disabled={!writable || saving || staleReview || Boolean(created)} onChange={event => setName(event.target.value)} /><small>{name.length} / 120자</small></label><div className="dp-mapping-list">{review.suggestions.map((suggestion, index) => {
        const selected = suggestion.candidates.find(candidate => candidate.id === mappings[suggestion.sourceRuleId]);
        const rowNumbers = review.dataset.rows.flatMap((row, rowIndex) => suggestion.rowIds.includes(row.id) ? [rowIndex + 1] : []);
        return <section className="dp-mapping-row" key={suggestion.sourceRuleId}><div className="dp-mapping-origin"><strong>{suggestion.sourceName || '기존 예상 검사'}</strong><code>{suggestion.sourceRuleId}</code><small>{rowNumbers.join(', ')}번 항목에서 사용</small></div><ArrowRight size={16} className="dp-mapping-arrow" /><div className="dp-mapping-target"><label htmlFor={`dataset-rule-mapping-${index}`}>연결할 검사<select id={`dataset-rule-mapping-${index}`} value={mappings[suggestion.sourceRuleId] || ''} disabled={!writable || saving || staleReview || !suggestion.candidates.length || Boolean(created)} onChange={event => { const value = event.target.value; setMappings(current => ({ ...current, [suggestion.sourceRuleId]: value })); setMappingError(''); }}><option value="">검사를 선택하세요</option>{suggestion.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{stageLabel[candidate.stage]} / {candidate.groupName} / {candidate.name} ({candidate.id})</option>)}</select></label><p>{suggestion.reason}</p>{suggestion.suggestedRuleId && selected?.id === suggestion.suggestedRuleId && suggestion.requiresMapping && <small className="dp-proposed">제안된 연결입니다. 검사 설정을 확인한 뒤 저장하세요.</small>}{selected && <code>{selected.id}</code>}{!suggestion.candidates.length && onEditRow && <button type="button" className="dp-row-link" disabled={saving || staleReview} onClick={() => { closeMapping(); onEditRow(suggestion.rowIds[0]); }}>예상 종료 단계와 검사 기준 수정<ArrowRight size={12} /></button>}</div></section>;
      })}</div>{remaining > 0 && <p className="dp-incomplete" role="status">아직 연결하지 않은 예상 검사가 {remaining}개 있습니다. 각 항목의 대상 검사를 선택하세요.</p>}{validationError && <p className="dp-error" role="alert">{validationError}</p>}</>}
      {staleReview && <div className="dp-stale" role="alert"><AlertCircle size={16} /><p>데이터셋이나 워크플로우, 실행 버전이 변경되었습니다. 현재 설정으로 다시 확인하세요.</p></div>}
      {atLimit && <p className="dp-error" role="alert">데이터셋은 최대 30개까지 등록할 수 있습니다. 사용하지 않는 데이터셋을 정리한 뒤 복사하세요.</p>}
      {mappingError && <p className="dp-error" role="alert">{mappingError}</p>}
      {created && <div className="dp-created"><strong>{created.name}</strong><p>새 데이터셋을 저장했습니다.</p><button type="button" className="btn small" onClick={() => { const id = created.id; closeMapping(); mappedCallback.current?.(id); }}>저장한 데이터셋 열기<ArrowRight size={12} /></button></div>}
    </div><footer><button type="button" className="btn" disabled={saving} onClick={closeMapping}>닫기</button>{!created && <button type="button" className="btn" disabled={saving || reviewing || !writable || busy || Boolean(mappingDisabledReason)} onClick={() => void prepareMapping()}><RefreshCw size={13} />현재 설정으로 다시 확인</button>}{!created && <button type="button" className="btn primary" disabled={!canCreate} onClick={() => void createMappedCopy()}>{saving ? <Loader2 size={14} className="spin" /> : <Copy size={14} />}새 데이터셋 저장</button>}</footer></section></div>}
  </section>;
}
