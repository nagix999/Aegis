'use client';

import { useMemo, useState } from 'react';
import { Archive, ArchiveRestore, ArrowDownUp, ArrowRight, Loader2, Plus, Search, Trash2, Workflow as WorkflowIcon, X } from 'lucide-react';
import type { AppState, Connection, Deployment, Workflow } from '@/lib/aegis-types';
import { Empty, PageHeading, Tag, timeLabel } from './console-ui';
import { connectionLabel, workflowDescription } from '@/lib/product-copy';
import { executionConfiguration } from '@/lib/workflow-review';

export type WorkflowStatus = 'draft' | 'deployed' | 'changed';
export type WorkflowListProps = {
  state: AppState;
  loading: boolean;
  busy: boolean;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onDuplicate: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onTest: (id: string) => Promise<void>;
  onDeploy: (id: string) => Promise<void>;
  onArchive?: (id: string, archived: boolean) => Promise<boolean>;
  onManageDeployment?: (id: string) => void;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Canvas positions and save timestamps do not change the deployed execution settings. */
export function workflowSignature(workflow: Workflow, connections: Connection[]): string {
  const configuration = executionConfiguration(workflow);
  const referenced = [...new Set([workflow.mainConnectionId, ...[...workflow.pre, ...workflow.post].flatMap(group => group.rules.filter(rule => rule.enabled && rule.kind === 'llm').map(rule => rule.config.connectionId).filter((id): id is string => Boolean(id)))])].sort();
  const models = referenced.map(id => connections.find(connection => connection.id === id) || { id, missing: true });
  return JSON.stringify(canonical({ workflow: configuration, connections: models }));
}

export function latestWorkflowDeployment(workflowId: string, deployments: Deployment[]): Deployment | undefined {
  return deployments.filter(deployment => deployment.workflowId === workflowId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.version - a.version)[0];
}

export function getWorkflowStatus(workflow: Workflow, state: Pick<AppState, 'deployments' | 'connections'>): { status: WorkflowStatus; deployment?: Deployment } {
  const deployment = latestWorkflowDeployment(workflow.id, state.deployments);
  if (!deployment) return { status: 'draft' };
  return { status: workflowSignature(workflow, state.connections) === workflowSignature(deployment.workflow, deployment.connections) ? 'deployed' : 'changed', deployment };
}

const statusLabel: Record<WorkflowStatus, string> = { draft: '초안', deployed: '배포됨', changed: '변경 사항 있음' };

export function WorkflowList({ state, loading, busy, onCreate, onOpen, onDuplicate, onDelete, onTest, onDeploy, onArchive, onManageDeployment }: WorkflowListProps) {
  const readOnly = state.role === 'viewer';
  const canDeploy = !state.role || state.role === 'admin';
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | WorkflowStatus>('all');
  const [archiveFilter, setArchiveFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [sort, setSort] = useState('updated');
  const [deleting, setDeleting] = useState<Workflow>();
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [archiving, setArchiving] = useState<{ workflow: Workflow; archived: boolean }>();
  const [archivingBusy, setArchivingBusy] = useState(false);
  const isArchived = (id: string) => Boolean(state.lifecycle?.workflows[id]?.archived);
  const runningAliases = (id: string) => [...new Set(state.deployments.filter(deployment => deployment.workflowId === id && !state.lifecycle?.deployments[deployment.alias]?.paused).map(deployment => deployment.alias))];
  const items = useMemo(() => state.workflows.map(workflow => ({ workflow, ...getWorkflowStatus(workflow, state) })).filter(item => {
    const search = query.trim().toLocaleLowerCase();
    const matches = !search || [item.workflow.name, item.workflow.alias, item.workflow.description].some(value => value.toLocaleLowerCase().includes(search));
    return matches && (filter === 'all' || item.status === filter) && (archiveFilter === 'all' || isArchived(item.workflow.id) === (archiveFilter === 'archived'));
  }).sort((a, b) => sort === 'name' ? a.workflow.name.localeCompare(b.workflow.name, 'ko') : Date.parse(b.workflow.updatedAt) - Date.parse(a.workflow.updatedAt)), [state.workflows, state.deployments, state.connections, state.lifecycle, query, filter, archiveFilter, sort]);
  const activeRuleCount = (workflow: Workflow, stage: 'pre' | 'post') => workflow[stage].reduce((count, group) => count + group.rules.filter(rule => rule.enabled).length, 0);
  const reset = () => { setQuery(''); setFilter('all'); setArchiveFilter('active'); };

  async function deleteConfirmed() {
    if (!deleting) return;
    setDeletingBusy(true);
    try { await onDelete(deleting.id); setDeleting(undefined); }
    finally { setDeletingBusy(false); }
  }
  async function archiveConfirmed() {
    if (!archiving || !onArchive) return;
    setArchivingBusy(true);
    try { if (await onArchive(archiving.workflow.id, archiving.archived)) setArchiving(undefined); }
    finally { setArchivingBusy(false); }
  }

  return <div className="wf-list-page">
    <PageHeading eyebrow="워크플로우 관리" title="워크플로우" description="서비스별 요청 검사와 응답 검사 순서를 설정하고 배포 상태를 확인합니다.">
      <button className="btn primary" onClick={onCreate} disabled={busy || loading || readOnly}><Plus size={15} /> 새 워크플로우</button>
    </PageHeading>
    <section className="wf-list-panel" aria-label="워크플로우 목록">
      <div className="wf-list-toolbar">
        <label className="wf-list-search"><Search size={16} /><input aria-label="워크플로우 검색" placeholder="이름, API 모델 이름으로 검색" value={query} onChange={event => setQuery(event.target.value)} disabled={loading} />{query && <button type="button" aria-label="검색 지우기" onClick={() => setQuery('')}><X size={13} /></button>}</label>
        <div className="wf-list-filters"><label>보관<select aria-label="워크플로우 보관 필터" value={archiveFilter} onChange={event => setArchiveFilter(event.target.value as 'active' | 'archived' | 'all')} disabled={loading}><option value="active">사용 중</option><option value="archived">보관됨</option><option value="all">보관 포함 전체</option></select></label><label>상태<select aria-label="워크플로우 상태 필터" value={filter} onChange={event => setFilter(event.target.value as 'all' | WorkflowStatus)} disabled={loading}><option value="all">전체 상태</option><option value="draft">초안</option><option value="deployed">배포됨</option><option value="changed">변경 사항 있음</option></select></label><label className="wf-list-sort"><ArrowDownUp size={13} /><select aria-label="워크플로우 정렬" value={sort} onChange={event => setSort(event.target.value)} disabled={loading}><option value="updated">최근 수정순</option><option value="name">이름순</option></select></label></div>
      </div>
      <div className="wf-list-summary">{loading ? '목록을 불러오는 중입니다.' : <><strong>{items.length}</strong>개 워크플로우{(query || filter !== 'all' || archiveFilter !== 'all') && <span> (보관 포함 전체 {state.workflows.length}개)</span>}</>}</div>
      {loading ? <div className="wf-list-loading" role="status"><Loader2 size={20} className="spin" /><span>워크플로우를 불러오는 중입니다.</span></div> : state.workflows.length === 0 ? <div className="wf-list-empty"><Empty icon={<WorkflowIcon size={24} />} title="등록된 워크플로우가 없습니다" description="새 워크플로우에서 요청 검사, 응답 생성 모델, 응답 검사를 설정할 수 있습니다." /><button className="btn primary" onClick={onCreate} disabled={busy || readOnly}><Plus size={15} /> 새 워크플로우</button></div> : items.length === 0 ? <div className="wf-list-empty"><Empty title="검색 결과가 없습니다" description="검색어나 상태 조건을 변경하세요." /><button className="btn" onClick={reset}>검색 조건 초기화</button></div> : <div className="wf-list-table-wrap"><table className="wf-list-table"><thead><tr><th scope="col">워크플로우</th><th scope="col">상태</th><th scope="col">API 모델 이름</th><th scope="col">응답 모델</th><th scope="col">검사 수</th><th scope="col">수정 일시</th><th scope="col" className="wf-list-actions-heading">관리</th></tr></thead><tbody>{items.map(({ workflow, status, deployment }) => {
        const connection = state.connections.find(item => item.id === workflow.mainConnectionId);
        const archived = isArchived(workflow.id);
        const paused = Boolean(deployment && state.lifecycle?.deployments[deployment.alias]?.paused);
        return <tr key={workflow.id}>
          <td><button className="wf-list-name" onClick={() => onOpen(workflow.id)} disabled={busy}>{workflow.name}</button><p className="wf-list-description" title={workflowDescription(workflow.description)}>{workflowDescription(workflow.description) || '설명 없음'}</p></td>
          <td><div className="wf-list-status"><Tag tone={status === 'deployed' ? 'success' : status === 'changed' ? 'warning' : 'neutral'}>{statusLabel[status]}</Tag>{archived && <Tag>보관됨</Tag>}{paused && <Tag tone="warning">호출 중지</Tag>}{deployment && <span>v{deployment.version}</span>}</div></td>
          <td><code className="wf-list-alias">{workflow.alias}</code></td>
          <td><span className="wf-list-model" title={connection ? connectionLabel(connection.name) : undefined}>{connection ? connectionLabel(connection.name) : '연결 없음'}</span>{connection?.mode === 'demo' && <small className="wf-list-model-mode">예제 응답</small>}</td>
          <td><span className="wf-list-rule-count">요청 {activeRuleCount(workflow, 'pre')}<span> / </span>응답 {activeRuleCount(workflow, 'post')}</span></td>
          <td><time dateTime={workflow.updatedAt} title={new Date(workflow.updatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}>{timeLabel(workflow.updatedAt)}</time></td>
          <td><div className="wf-list-actions"><button onClick={() => onOpen(workflow.id)} disabled={busy} aria-label={`${workflow.name} ${readOnly || archived?'보기':'편집'}`}>{readOnly || archived?'보기':'편집'}</button><button onClick={() => void onTest(workflow.id)} disabled={busy || readOnly || archived} aria-label={`${workflow.name} 검증`}>검증</button><button onClick={() => void onDuplicate(workflow.id)} disabled={busy || readOnly} aria-label={`${workflow.name} 복제`}>복제</button><button className="wf-list-deploy" onClick={() => void onDeploy(workflow.id)} disabled={busy || !canDeploy || archived} aria-label={`${workflow.name} 배포`}>배포</button>{onArchive && <button onClick={() => setArchiving({ workflow, archived: !archived })} disabled={busy || !canDeploy} aria-label={`${workflow.name} ${archived ? '보관 해제' : '보관'}`}>{archived ? <ArchiveRestore size={14}/> : <Archive size={14}/>} {archived ? '복원' : '보관'}</button>}<button className="wf-list-delete" title={deployment ? '배포 이력이 있는 워크플로우는 삭제할 수 없습니다.' : '초안 삭제'} onClick={() => setDeleting(workflow)} disabled={busy || !canDeploy || Boolean(deployment)} aria-label={`${workflow.name} 삭제`}><Trash2 size={14} /></button></div></td>
        </tr>;
      })}</tbody></table></div>}
      <div className="wf-list-footer"><span>변경한 내용은 다시 배포한 뒤 API 요청에 적용됩니다.</span><span>보관은 설정과 이력을 유지합니다. 호출 중인 API는 먼저 중지하세요.</span></div>
    </section>
    {archiving && <div className="wf-list-dialog-backdrop" onClick={() => !archivingBusy && setArchiving(undefined)}><section className="wf-list-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-archive-title" onClick={event => event.stopPropagation()}><div><h2 id="workflow-archive-title">{archiving.archived ? '워크플로우 보관' : '워크플로우 보관 해제'}</h2><button className="icon-button" aria-label="보관 창 닫기" onClick={() => setArchiving(undefined)} disabled={archivingBusy}><X size={17}/></button></div><p><strong>{archiving.workflow.name}</strong>{archiving.archived ? '의 설정과 배포 이력을 유지하고 기본 목록에서 숨깁니다. 보관 필터에서 다시 복원할 수 있습니다.' : '을 사용 중 목록으로 되돌립니다. API 호출은 자동으로 재개되지 않습니다.'}</p>{archiving.archived && runningAliases(archiving.workflow.id).length > 0 && <div className="mg-draft-warning"><p>호출 중인 API 모델이 있습니다: {runningAliases(archiving.workflow.id).join(', ')}. API 배포에서 모두 중지한 뒤 보관하세요.</p>{onManageDeployment && <button className="btn" onClick={() => { const id = archiving.workflow.id; setArchiving(undefined); onManageDeployment(id); }}>API 배포에서 호출 중지 <ArrowRight size={14}/></button>}</div>}<footer><button className="btn" onClick={() => setArchiving(undefined)} disabled={archivingBusy}>취소</button><button className="btn primary" onClick={() => void archiveConfirmed()} disabled={archivingBusy || busy || archiving.archived && runningAliases(archiving.workflow.id).length > 0}>{archivingBusy ? '처리 중' : archiving.archived ? '보관' : '보관 해제'}</button></footer></section></div>}
    {deleting && <div className="wf-list-dialog-backdrop" onClick={() => !deletingBusy && setDeleting(undefined)}><section className="wf-list-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-delete-title" onClick={event => event.stopPropagation()}><div><h2 id="workflow-delete-title">워크플로우를 삭제할까요?</h2><button className="icon-button" aria-label="삭제 창 닫기" onClick={() => setDeleting(undefined)} disabled={deletingBusy}><X size={17} /></button></div><p><strong>{deleting.name}</strong> 초안과 설정을 삭제합니다. 삭제한 초안은 복구할 수 없습니다.</p><footer><button className="btn" onClick={() => setDeleting(undefined)} disabled={deletingBusy}>취소</button><button className="btn danger" onClick={() => void deleteConfirmed()} disabled={deletingBusy || busy}>{deletingBusy ? '삭제 중…' : '초안 삭제'}</button></footer></section></div>}
  </div>;
}
