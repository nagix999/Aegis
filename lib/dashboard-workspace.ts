import type { DashboardFilters, DashboardInteraction, DashboardRow, DashboardTab, DashboardWidget, DashboardWorkspace } from './dashboard-types';
// @ts-expect-error Node strip-types requires the source extension.
import { DASHBOARD_STORAGE_KEY, defaultDashboardLayout, parseDashboardLayout } from './dashboard-layout.ts';

export const DASHBOARD_WORKSPACE_STORAGE_KEY = 'aegis.dashboard.workspace.v2';
export const MAX_DASHBOARD_TABS = 12;
const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const statuses = ['', 'allow', 'block', 'error'];

export function defaultDashboardFilters(): DashboardFilters {
  return { period: '7d', workflowId: '', source: 'gateway', status: '', customFrom: '', customTo: '' };
}

export function dashboardFilterChips(filters: DashboardFilters, workflows: readonly {id:string;name:string}[] = []) {
  const defaults = defaultDashboardFilters();
  return [
    {key:'period' as const,label:'기간',value:filters.period==='custom'?`${filters.customFrom || '시작일 미설정'} ~ ${filters.customTo || '종료일 미설정'}`:({'24h':'24시간','7d':'7일','30d':'30일'}[filters.period]),changed:filters.period!==defaults.period},
    {key:'workflowId' as const,label:'워크플로우',value:filters.workflowId?workflows.find(workflow=>workflow.id===filters.workflowId)?.name??'보관된 워크플로우':'전체',changed:Boolean(filters.workflowId)},
    {key:'source' as const,label:'출처',value:({gateway:'Gateway',evaluation:'데이터셋 검증',playground:'시험 실행',all:'전체'}[filters.source]),changed:filters.source!==defaults.source},
    {key:'status' as const,label:'판정',value:({'':'전체',allow:'허용',block:'차단',error:'오류'}[filters.status]),changed:Boolean(filters.status)},
  ];
}

/** The preview uses the same allowlisted metadata projection as real navigation. */
export function previewDashboardNavigation(origin:DashboardFilters,destination:DashboardFilters,widget:DashboardWidget,row:DashboardRow={},clickedKey?:string):DashboardFilters {
  return widget.interaction?.mode==='drilldown'?resolveDashboardDrilldown(origin,widget,row,clickedKey):{...destination};
}

export function defaultDashboardWorkspace(): DashboardWorkspace {
  return { version: 2, activeTabId: 'dashboard-overview', tabs: [{ id: 'dashboard-overview', name: '운영 현황', layout: defaultDashboardLayout(), filters: defaultDashboardFilters() }] };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  if (value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

// Existing workflow IDs are application metadata, not URLs or arbitrary query fields.
function validWorkflowId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseFilters(value: unknown): DashboardFilters | null {
  if (!record(value) || !['24h', '7d', '30d', 'custom'].includes(value.period as string)
    || !['gateway', 'evaluation', 'playground', 'all'].includes(value.source as string)
    || !statuses.includes(value.status as string) || !validWorkflowId(value.workflowId)
    || !validDate(value.customFrom) || !validDate(value.customTo)) return null;
  return { period: value.period as DashboardFilters['period'], source: value.source as DashboardFilters['source'],
    workflowId: value.workflowId, status: value.status as DashboardFilters['status'], customFrom: value.customFrom, customTo: value.customTo };
}

function parseInteraction(value: unknown): DashboardInteraction | undefined {
  if (value === undefined) return undefined;
  if(record(value)&&typeof value.targetPage==='string'&&['logs','evaluation','gateway'].includes(value.targetPage)&&['link','drilldown'].includes(value.mode as string))return {targetTabId:'',targetPage:value.targetPage as DashboardInteraction['targetPage'],mode:value.mode as DashboardInteraction['mode']};
  if (!record(value) || typeof value.targetTabId !== 'string' || !safeId.test(value.targetTabId)
    || (value.mode !== 'link' && value.mode !== 'drilldown')) throw new Error('interaction');
  return { targetTabId: value.targetTabId, mode: value.mode };
}

function cleanLinks(workspace: DashboardWorkspace): DashboardWorkspace {
  const ids = new Set(workspace.tabs.map(tab => tab.id));
  return { ...workspace, tabs: workspace.tabs.map(tab => ({ ...tab, layout: { version: 1, widgets: tab.layout.widgets.map(widget => {
    if (!widget.interaction || widget.interaction.targetPage || ids.has(widget.interaction.targetTabId)) return widget;
    const { interaction: _removed, ...rest } = widget;
    return rest;
  }) } })) };
}

export function parseDashboardWorkspace(raw: string | null): { workspace: DashboardWorkspace; error?: string } {
  if (raw === null) return { workspace: defaultDashboardWorkspace() };
  try {
    if (raw.length > 2_500_000) throw new Error('size');
    const data: unknown = JSON.parse(raw);
    if (!record(data) || data.version !== 2 || !Array.isArray(data.tabs) || !data.tabs.length || data.tabs.length > MAX_DASHBOARD_TABS
      || typeof data.activeTabId !== 'string' || !safeId.test(data.activeTabId)) throw new Error('workspace');
    const ids = new Set<string>();
    const tabs: DashboardTab[] = data.tabs.map(value => {
      if (!record(value) || typeof value.id !== 'string' || !safeId.test(value.id) || ids.has(value.id)
        || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 40) throw new Error('tab');
      ids.add(value.id);
      const filters = parseFilters(value.filters);
      if (!filters || !record(value.layout) || !Array.isArray(value.layout.widgets)) throw new Error('filters');
      const parsed = parseDashboardLayout(JSON.stringify(value.layout));
      if (parsed.error) throw new Error('layout');
      const interactions = value.layout.widgets.map(widget => {
        if (!record(widget)) throw new Error('widget');
        return parseInteraction(widget.interaction);
      });
      const widgets = parsed.layout.widgets.map((widget, index) => {
        const interaction = interactions[index];
        return interaction ? { ...widget, interaction } : widget;
      });
      return { id: value.id, name: value.name.trim(), filters, layout: { version: 1, widgets } };
    });
    if (!ids.has(data.activeTabId)) throw new Error('active');
    return { workspace: cleanLinks({ version: 2, activeTabId: data.activeTabId, tabs }) };
  } catch {
    return { workspace: defaultDashboardWorkspace(), error: '저장된 대시보드 탭 설정을 읽을 수 없어 기본 화면을 표시합니다. 원래 설정은 덮어쓰지 않았습니다.' };
  }
}

/** Migrate a single saved layout in memory only. Its original storage key is retained. */
export function readDashboardWorkspace(storage: Pick<Storage, 'getItem'>): { workspace: DashboardWorkspace; error?: string } {
  try {
    const workspace = storage.getItem(DASHBOARD_WORKSPACE_STORAGE_KEY);
    if (workspace !== null) return parseDashboardWorkspace(workspace);
    const legacy = storage.getItem(DASHBOARD_STORAGE_KEY);
    if (legacy === null) return { workspace: defaultDashboardWorkspace() };
    const parsed = parseDashboardLayout(legacy);
    const migrated = defaultDashboardWorkspace();
    migrated.tabs[0].layout = parsed.layout;
    return { workspace: migrated, ...(parsed.error ? { error: parsed.error } : {}) };
  } catch {
    return { workspace: defaultDashboardWorkspace(), error: '브라우저 저장소를 읽을 수 없어 기본 대시보드를 표시합니다.' };
  }
}

export function saveDashboardWorkspace(storage: Pick<Storage, 'setItem'>, workspace: DashboardWorkspace): { ok: boolean; error?: string } {
  try {
    const parsed = parseDashboardWorkspace(JSON.stringify(workspace));
    if (parsed.error) return { ok: false, error: '대시보드 탭 설정 형식이 올바르지 않아 저장하지 않았습니다.' };
    storage.setItem(DASHBOARD_WORKSPACE_STORAGE_KEY, JSON.stringify(parsed.workspace));
    return { ok: true };
  } catch {
    return { ok: false, error: '대시보드를 저장하지 못했습니다. 브라우저 저장 공간과 권한을 확인하세요.' };
  }
}

function newTabId(workspace: DashboardWorkspace): string {
  let id: string;
  do {
    id = `dashboard-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
  } while (workspace.tabs.some(tab => tab.id === id));
  return id;
}

export function addDashboardTab(workspace: DashboardWorkspace, name: string, id?: string): DashboardWorkspace {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 40 || workspace.tabs.length >= MAX_DASHBOARD_TABS) return workspace;
  const tabId = id && safeId.test(id) && !workspace.tabs.some(tab => tab.id === id) ? id : newTabId(workspace);
  return { ...workspace, activeTabId: tabId, tabs: [...workspace.tabs, { id: tabId, name: trimmed, layout: { version: 1, widgets: [] }, filters: defaultDashboardFilters() }] };
}

export function renameDashboardTab(workspace: DashboardWorkspace, id: string, name: string): DashboardWorkspace {
  const trimmed = name.trim();
  const tab = workspace.tabs.find(item => item.id === id);
  if (!tab || !trimmed || trimmed.length > 40 || trimmed === tab.name) return workspace;
  return { ...workspace, tabs: workspace.tabs.map(item => item.id === id ? { ...item, name: trimmed } : item) };
}

export function duplicateDashboardTab(workspace:DashboardWorkspace,id:string):DashboardWorkspace {
  const source=workspace.tabs.find(tab=>tab.id===id);
  if(!source||workspace.tabs.length>=MAX_DASHBOARD_TABS)return workspace;
  const next=addDashboardTab(workspace,`${source.name.slice(0,36)} 복사`),copy=next.tabs.at(-1)!;
  copy.filters=structuredClone(source.filters);copy.layout=structuredClone(source.layout);
  copy.layout.widgets=copy.layout.widgets.map((widget,index)=>({...widget,id:`copy-${copy.id.slice(-36)}-${index}`,...(widget.interaction?.targetTabId===id?{interaction:{...widget.interaction,targetTabId:copy.id}}:{})}));
  return next;
}

export function addDashboardTemplate(workspace:DashboardWorkspace,template:'overview'|'blocks'|'validation'):DashboardWorkspace {
  const names={overview:'운영 요약',blocks:'차단 분석',validation:'검증과 배포'};
  const next=addDashboardTab(workspace,names[template]);if(next===workspace)return workspace;
  const tab=next.tabs.at(-1)!;
  tab.layout=defaultDashboardLayout();
  if(template!=='overview')tab.layout.widgets=tab.layout.widgets.filter(widget=>template==='blocks'?['requestTrend','requestStatus','workflowRequests'].includes(widget.dataset)||['blockRate','errorRate'].includes(widget.metric):['evaluations','deployments'].includes(widget.dataset)||['matchRate','deploymentCount'].includes(widget.metric));
  let x=0,y=0,height=0;
  tab.layout.widgets=tab.layout.widgets.map(widget=>{if(x+widget.w>12){x=0;y+=height;height=0;}const placed={...widget,x,y};x+=widget.w;height=Math.max(height,widget.h);return placed;});
  if(template==='blocks')tab.filters.status='block';
  return next;
}

export function dashboardPageTarget(widget:DashboardWidget):'logs'|'evaluation'|'gateway' {
  return widget.interaction?.targetPage??(widget.dataset==='evaluations'||widget.dataset==='summary'&&widget.metric==='matchRate'?'evaluation':widget.dataset==='deployments'||widget.dataset==='summary'&&widget.metric==='deploymentCount'?'gateway':'logs');
}

export function removeDashboardTab(workspace: DashboardWorkspace, id: string): DashboardWorkspace {
  const index = workspace.tabs.findIndex(tab => tab.id === id);
  if (workspace.tabs.length <= 1 || index < 0) return workspace;
  const tabs = workspace.tabs.filter(tab => tab.id !== id);
  const activeTabId = workspace.activeTabId === id ? tabs[Math.min(index, tabs.length - 1)].id : workspace.activeTabId;
  return cleanLinks({ ...workspace, activeTabId, tabs });
}

/** Forward only known metadata filters; raw cell values never become stored drilldown context. */
export function resolveDashboardDrilldown(filters: DashboardFilters, widget: DashboardWidget, row: DashboardRow, clickedKey?: string): DashboardFilters {
  const next = { ...filters };
  if (['workflowRequests', 'evaluations', 'deployments'].includes(widget.dataset)
    && validWorkflowId(row.workflowId) && row.workflowId) next.workflowId = row.workflowId;
  if (widget.dataset === 'requestStatus' && typeof row.status === 'string' && ['allow', 'block', 'error'].includes(row.status)) {
    next.status = row.status as DashboardFilters['status'];
  } else if (widget.dataset === 'workflowRequests' || widget.dataset === 'requestTrend') {
    const metric = clickedKey ?? widget.metric;
    if (widget.dataset === 'workflowRequests' && metric === 'blockRate') next.status = 'block';
    else if (['allow', 'block', 'error'].includes(metric)) next.status = metric as DashboardFilters['status'];
  } else if (widget.dataset === 'summary') {
    const metricStatuses: Record<string, DashboardFilters['status']> = { allowCount: 'allow', blockCount: 'block', blockRate: 'block', errorCount: 'error', errorRate: 'error' };
    const status = metricStatuses[clickedKey ?? widget.metric];
    if (status) next.status = status;
  }
  return next;
}
