'use client';

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Activity, ArrowDown, ArrowLeft, ArrowUp, ArrowUpRight, BarChart3, Check, ChevronDown, Copy, Grip, LayoutDashboard, LineChart, Pencil, PieChart, Plus, RefreshCw, RotateCcw, RotateCw, Settings2, Table2, Trash2, TriangleAlert, X, Download, Upload } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart as RechartsLineChart, Pie, PieChart as RechartsPieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AppState } from '@/lib/aegis-types';
import type { DashboardColor, DashboardColumn, DashboardDataset, DashboardDatasetId, DashboardFilters, DashboardLayout, DashboardResponse, DashboardRow, DashboardSource, DashboardWidget, DashboardWidgetType, DashboardWorkspace } from '@/lib/dashboard-types';
import { addDashboardWidget, createDashboardWidget, DASHBOARD_COLUMNS, DASHBOARD_GAP, DASHBOARD_ROW_HEIGHT, dragWidget, duplicateDashboardWidget, MAX_DASHBOARD_WIDGETS, placeWidget, removeDashboardWidget, type DashboardGridMetrics, type DashboardPoint, type DashboardRect } from '@/lib/dashboard-layout';
import { addDashboardTab, duplicateDashboardTab, addDashboardTemplate, dashboardPageTarget, parseDashboardWorkspace, dashboardFilterChips, defaultDashboardFilters, defaultDashboardWorkspace, MAX_DASHBOARD_TABS, previewDashboardNavigation, readDashboardWorkspace, removeDashboardTab, renameDashboardTab, resolveDashboardDrilldown, saveDashboardWorkspace } from '@/lib/dashboard-workspace';
import { PageHeading } from '@/components/console-ui';
import './dashboard.css';
import {useDialogVisibility} from './use-dialog-visibility';

const DAY = 86_400_000;
const widgetTypes = [
  { id: 'kpi', label: '지표', icon: Activity }, { id: 'line', label: '선 차트', icon: LineChart },
  { id: 'bar', label: '막대 차트', icon: BarChart3 }, { id: 'donut', label: '도넛 차트', icon: PieChart },
  { id: 'table', label: '표', icon: Table2 },
] as const;
const datasetLabels: Record<DashboardDatasetId, string> = {
  summary: '핵심 지표', requestTrend: '시간대별 요청', requestStatus: '요청 판정',
  workflowRequests: '워크플로우별 요청', evaluations: '검증 결과', deployments: '현재 배포',
};
const palettes: Record<DashboardColor, string[]> = {
  teal: ['#188f89', '#79bdb5', '#bad9d3', '#437a79', '#d4e6df'],
  blue: ['#4c82c4', '#8ab0de', '#c3d5eb', '#486f9b', '#dce6f4'],
  violet: ['#9076b4', '#b6a1d0', '#d8cbe5', '#755f95', '#e9e1f2'],
  amber: ['#bd8a40', '#d9b479', '#ead5b2', '#9b763c', '#f2e7d5'],
};
const colorLabels: Record<DashboardColor, string> = { teal: '청록', blue: '파랑', violet: '보라', amber: '황갈색' };
const statusLabels: Record<string, string> = { allow: '허용', block: '차단', error: '오류', running: '진행 중', completed: '완료', cancelled: '취소', manual: '수동', background: '백그라운드' };
const kstDate = (time = Date.now()) => new Date(time + 9 * 3_600_000).toISOString().slice(0, 10);

export function formatDashboardValue(value: unknown, column?: DashboardColumn): string {
  if (value === null || value === undefined || typeof value === 'number' && !Number.isFinite(value)) return '—';
  if (column?.type === 'datetime') {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  if (typeof value !== 'number') return column?.key === 'status' ? statusLabels[String(value)] ?? String(value) : String(value);
  const number = value.toLocaleString('ko-KR', { maximumFractionDigits: column?.unit === 'percent' || column?.unit === 'ms' ? 1 : 0 });
  return column?.unit === 'percent' ? `${number}%` : column?.unit === 'ms' ? `${number} ms` : number;
}

function orderedRows(dataset: DashboardDataset, key: string, direction: 'asc' | 'desc', limit: number): DashboardRow[] {
  const rows = [...dataset.rows];
  if (key && dataset.columns.some(column => column.key === key)) rows.sort((a, b) => {
    const left = a[key], right = b[key];
    if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
    if (right === null || right === undefined) return -1;
    const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), 'ko');
    return direction === 'asc' ? order : -order;
  });
  return rows.slice(0, limit);
}

type ValueNavigation = { onActivate?: (row: DashboardRow, key: string) => void; linkLabel?: string };

function DashboardTable({ widget, dataset, onActivate, linkLabel }: { widget: DashboardWidget; dataset: DashboardDataset } & ValueNavigation) {
  const [sort, setSort] = useState({ key: widget.sortBy, direction: widget.sortDirection });
  useEffect(() => setSort({ key: widget.sortBy, direction: widget.sortDirection }), [widget.sortBy, widget.sortDirection]);
  const columns = widget.columns.map(key => dataset.columns.find(column => column.key === key)).filter((column): column is DashboardColumn => Boolean(column));
  const rows = orderedRows(dataset, sort.key, sort.direction, widget.rowLimit);
  if (!columns.length) return <div className="dashboard-card-empty">설정에서 표시할 열을 선택하세요.</div>;
  return <div className="dashboard-table-wrap"><div className="dashboard-table-scroll"><table>
    <caption className="sr-only">{widget.title}</caption><thead><tr>{columns.map(column => <th key={column.key} scope="col" aria-sort={sort.key === column.key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
      <button onClick={() => setSort({ key: column.key, direction: sort.key === column.key && sort.direction === 'asc' ? 'desc' : 'asc' })} aria-label={`${column.label} 정렬`}>
        {column.label}{sort.key === column.key && (sort.direction === 'asc' ? <ArrowUp size={11}/> : <ArrowDown size={11}/>)}</button>
    </th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.runId ?? row.deploymentId ?? row.workflowId ?? row.bucket ?? index)}>{columns.map(column => <td key={column.key} className={column.type === 'number' ? 'numeric' : ''} title={formatDashboardValue(row[column.key], column)}>{onActivate && row[column.key] != null ? <button className="dashboard-value-link" aria-label={`${formatDashboardValue(row[column.key], column)} → ${linkLabel}`} title={linkLabel} onClick={() => onActivate(row, column.key)}>{formatDashboardValue(row[column.key], column)}<ArrowUpRight size={11}/></button> : formatDashboardValue(row[column.key], column)}</td>)}</tr>)}</tbody>
  </table>{!rows.length && <div className="dashboard-card-empty">선택한 조건의 기록이 없습니다.</div>}</div><div className="dashboard-table-count">{rows.length.toLocaleString()}행 표시 / 집계 결과 {dataset.totalRows.toLocaleString()}행{dataset.truncated ? ' (조회 한도 적용)' : ''}</div></div>;
}

function WidgetContent({ widget, dataset, onActivate, linkLabel }: { widget: DashboardWidget; dataset?: DashboardDataset } & ValueNavigation) {
  if (!dataset) return <div className="dashboard-card-empty">집계 데이터를 기다리고 있습니다.</div>;
  if (widget.type === 'table') return <DashboardTable widget={widget} dataset={dataset} onActivate={onActivate} linkLabel={linkLabel}/>;
  const metric = dataset.columns.find(column => column.key === widget.metric && column.type === 'number');
  if (widget.type === 'kpi') return <div className="dashboard-kpi"><strong>{onActivate && dataset.rows.length ? <button className="dashboard-value-link" title={linkLabel} aria-label={`${formatDashboardValue(dataset.rows[0][widget.metric], metric)} → ${linkLabel}`} onClick={() => onActivate(dataset.rows[0], widget.metric)}>{formatDashboardValue(dataset.rows[0][widget.metric], metric)}<ArrowUpRight size={16}/></button> : formatDashboardValue(dataset.rows[0]?.[widget.metric], metric)}</strong><span>{metric?.label ?? '지표 선택 필요'}</span></div>;
  const dimension = dataset.columns.find(column => column.key === widget.dimension);
  if (!metric || !dimension) return <div className="dashboard-card-empty">설정에서 분류와 지표를 선택하세요.</div>;
  const rows = orderedRows(dataset, widget.sortBy, widget.sortDirection, widget.rowLimit);
  if (!rows.length) return <div className="dashboard-card-empty">선택한 조건의 기록이 없습니다.</div>;
  const palette = palettes[widget.color];
  const valueFormatter = (value: unknown) => formatDashboardValue(value, metric);
  if (widget.type === 'donut') {
    const nonzero = rows.filter(row => typeof row[widget.metric] === 'number' && Number(row[widget.metric]) > 0);
    if (!nonzero.length) return <div className="dashboard-card-empty">표시할 집계 값이 없습니다.</div>;
    return <div className="dashboard-donut"><div className="dashboard-donut-chart"><ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}><RechartsPieChart><Pie data={nonzero} dataKey={widget.metric} nameKey={widget.dimension} innerRadius="55%" outerRadius="84%" paddingAngle={3} stroke="none" isAnimationActive={false} onClick={(_, index) => onActivate?.(nonzero[index], widget.metric)} style={{ cursor: onActivate ? 'pointer' : undefined }}>{nonzero.map((_, index) => <Cell key={index} fill={palette[index % palette.length]}/>)}</Pie><Tooltip formatter={valueFormatter}/></RechartsPieChart></ResponsiveContainer></div><div className="dashboard-legend">{nonzero.map((row, index) => <div key={index}><i style={{ background: palette[index % palette.length] }}/>{onActivate ? <button className="dashboard-value-link" aria-label={`${formatDashboardValue(row[widget.dimension], dimension)} ${valueFormatter(row[widget.metric])} → ${linkLabel}`} onClick={() => onActivate(row, widget.metric)}><span>{formatDashboardValue(row[widget.dimension], dimension)}</span><strong>{valueFormatter(row[widget.metric])}</strong><ArrowUpRight size={11}/></button> : <><span>{formatDashboardValue(row[widget.dimension], dimension)}</span><strong>{valueFormatter(row[widget.metric])}</strong></>}</div>)}</div></div>;
  }
  const Chart = widget.type === 'line' ? RechartsLineChart : BarChart;
  return <div className="dashboard-cartesian"><ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}><Chart data={rows} margin={{ top: 12, right: 16, left: 2, bottom: 0 }} accessibilityLayer onClick={chartState => {
    if (!onActivate) return;
    const index = Number((chartState as unknown as { activeTooltipIndex?: string | number }).activeTooltipIndex ?? -1);
    if (Number.isInteger(index) && rows[index]) onActivate(rows[index], widget.metric);
  }} style={{ cursor: onActivate ? 'pointer' : undefined }}>
    <CartesianGrid vertical={false} stroke="#eaf0f1" strokeDasharray="3 4"/><XAxis dataKey={widget.dimension} tick={{ fontSize: 10, fill: '#788b94' }} tickLine={false} axisLine={false} minTickGap={20} tickFormatter={value => formatDashboardValue(value, dimension)}/><YAxis width={44} tick={{ fontSize: 10, fill: '#788b94' }} tickLine={false} axisLine={false} allowDecimals={metric.unit !== 'count' && metric.unit !== 'tokens'}/><Tooltip formatter={valueFormatter} labelFormatter={value => formatDashboardValue(value, dimension)} contentStyle={{ borderRadius: 8, borderColor: '#e3e9eb', fontSize: 12 }}/>
    {widget.type === 'line' ? <Line type="monotone" dataKey={widget.metric} name={metric.label} stroke={palette[0]} strokeWidth={2.5} dot={rows.length < 12} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls={false}/> : <Bar dataKey={widget.metric} name={metric.label} fill={palette[0]} radius={[4, 4, 0, 0]} maxBarSize={38} isAnimationActive={false}/>}
  </Chart></ResponsiveContainer>{onActivate && <details className="dashboard-chart-links"><summary><ArrowUpRight size={12}/> 차트 값으로 이동</summary><div>{rows.map((row, index) => <button className="dashboard-value-link" key={index} aria-label={`${formatDashboardValue(row[widget.dimension], dimension)} ${valueFormatter(row[widget.metric])} → ${linkLabel}`} onClick={() => onActivate(row, widget.metric)}><span>{formatDashboardValue(row[widget.dimension], dimension)}</span><strong>{valueFormatter(row[widget.metric])}</strong><ArrowUpRight size={11}/></button>)}</div></details>}</div>;
}

export function DashboardInteractionPreview({widget,dataset,origin,destination,workflows}: {widget:DashboardWidget;dataset?:DashboardDataset;origin:DashboardFilters;destination?:{name:string;filters:DashboardFilters};workflows:AppState['workflows']}) {
  const [rowIndex,setRowIndex]=useState(0);
  const [cellKey,setCellKey]=useState(widget.metric);
  if(!destination||!widget.interaction)return null;
  const rows=dataset?orderedRows(dataset,widget.sortBy,widget.sortDirection,widget.rowLimit):[];
  const row=rows[Math.min(rowIndex,Math.max(0,rows.length-1))];
  const columns=dataset?.columns.filter(column=>(widget.type==='table'?widget.columns.includes(column.key):column.key===widget.metric)&&row?.[column.key]!=null)??[];
  const key=columns.some(column=>column.key===cellKey)?cellKey:columns[0]?.key??widget.metric;
  const filters=previewDashboardNavigation(origin,destination.filters,widget,row??{},key);
  const drilldown=widget.interaction.mode==='drilldown';
  return <section className="dashboard-link-preview" aria-label="탭 이동 조건 미리보기"><strong>{destination.name} 탭의 조회 조건</strong>
    {drilldown&&rows.length>0&&<><label className="field">미리 볼 행<select aria-label="드릴다운 미리 볼 행" value={Math.min(rowIndex,rows.length-1)} onChange={event=>setRowIndex(Number(event.target.value))}>{rows.map((item,index)=><option key={index} value={index}>{index+1}행: {formatDashboardValue(item.workflowName??item.label??item[widget.dimension]??index+1)}</option>)}</select></label>{widget.type==='table'&&<label className="field">클릭할 열<select aria-label="드릴다운 미리 볼 열" value={key} onChange={event=>setCellKey(event.target.value)}>{columns.map(column=><option key={column.key} value={column.key}>{column.label}: {formatDashboardValue(row?.[column.key],column)}</option>)}</select></label>}</>}
    <dl>{dashboardFilterChips(filters,workflows).map(chip=><div key={chip.key}><dt>{chip.label}</dt><dd>{chip.value}</dd></div>)}</dl>
    <p>{drilldown?rows.length?'선택한 행과 열을 누를 때의 조건입니다. 다른 값을 누르면 워크플로우와 판정이 달라질 수 있습니다.':'조회된 행이 없어 공통 조건만 표시합니다. 실제 행을 선택하면 전달 조건이 달라질 수 있습니다.':'대상 탭의 기존 조건을 사용합니다. 현재 탭의 조건은 전달하지 않습니다.'}</p>
    {drilldown&&<p>이동하면 대상 탭의 조회 조건이 바뀝니다. 편집 권한이 있으면 현재 브라우저에 저장됩니다.</p>}
  </section>;
}

function DashboardTabDialog({ action, name, onClose, onSubmit }: { action: 'add' | 'rename' | 'delete'; name: string; onClose: () => void; onSubmit: (name: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useDialogVisibility(dialog,onClose);
  const [value, setValue] = useState(action === 'add' ? '' : name);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const title = action === 'add' ? '대시보드 탭 추가' : action === 'rename' ? '탭 이름 변경' : '대시보드 탭 삭제';
  return <dialog ref={dialog} className="dashboard-tab-dialog" aria-labelledby="dashboard-tab-dialog-title" onCancel={onClose}>
    <form onSubmit={event => { event.preventDefault(); onSubmit(value.trim()); }}>
      <header><h2 id="dashboard-tab-dialog-title">{title}</h2><button type="button" className="icon-button" aria-label="탭 설정 닫기" onClick={onClose}><X size={17}/></button></header>
      {action === 'delete' ? <p><strong>{name}</strong> 탭과 카드 구성을 삭제합니다. 이 탭으로 연결된 카드의 링크도 해제됩니다.</p> : <label className="field">탭 이름<input aria-label="탭 이름" autoFocus maxLength={40} value={value} onChange={event => setValue(event.target.value)} placeholder="예: 차단 요청 분석"/></label>}
      <footer><button type="button" className="btn small" onClick={onClose}>취소</button><button type="submit" className={`btn small ${action === 'delete' ? 'danger' : 'primary'}`} disabled={action !== 'delete' && !value.trim()}>{action === 'add' ? '추가' : action === 'rename' ? '이름 변경' : '삭제'}</button></footer>
    </form>
  </dialog>;
}

type Gesture = {
  id: string; pointerId: number; kind: 'move' | 'resize'; startPoint: DashboardPoint;
  metrics: DashboardGridMetrics; original: DashboardWidget; before: DashboardLayout;
  proposed: DashboardLayout; swapped: boolean; moved: boolean;
  element: HTMLElement;
};
type DragPreview = { widgets: DashboardWidget[]; probe: DashboardRect; metrics: DashboardGridMetrics; blocked: boolean; targetId: string | null; activeId: string; message: string };

export type DashboardPageNavigation={page:'logs'|'evaluation'|'gateway';filters:DashboardFilters;from?:string;to?:string;runId?:string;deploymentId?:string;workflowId?:string};
export function DashboardPage({ state,onNavigate,active=true }: { state: AppState;onNavigate?:(destination:DashboardPageNavigation)=>void;active?:boolean }) {
  const [importing,setImporting]=useState<DashboardWorkspace>();
  const importDialog=useRef<HTMLDialogElement>(null);
  const importInput=useRef<HTMLInputElement>(null);
  useDialogVisibility(importDialog,()=>setImporting(undefined));
  const [workspace, setWorkspace] = useState<DashboardWorkspace>(defaultDashboardWorkspace);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const activeTab = workspace.tabs.find(tab => tab.id === workspace.activeTabId) ?? workspace.tabs[0];
  const layout = activeTab.layout;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [selectedId, setSelectedId] = useState('default-trend');
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [compact, setCompact] = useState(false);
  const [storageProblem, setStorageProblem] = useState('');
  const storageBlocked = useRef(false);
  const [history, setHistory] = useState({ past: 0, future: 0 });
  const past = useRef<DashboardLayout[]>([]), future = useRef<DashboardLayout[]>([]);
  const { period, workflowId, source, status } = activeTab.filters;
  const customFrom = activeTab.filters.customFrom || kstDate(Date.now() - 6 * DAY);
  const customTo = activeTab.filters.customTo || kstDate();
  const [tabDialog, setTabDialog] = useState<'add' | 'rename' | 'delete'>();
  useEffect(()=>{if(!active){finishGesture(true);setAdding(false);setTabDialog(undefined);setImporting(undefined);}},[active]);
  useEffect(()=>{if(importing)importDialog.current?.showModal();},[importing]);
  const [trail, setTrail] = useState<{ tabId: string; filters: DashboardFilters }[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<DashboardResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dragPreview, setDragPreview] = useState<DragPreview>();
  const grid = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const canCustomize = state.role === 'admin' || state.role === 'editor';
  const selected = layout.widgets.find(widget => widget.id === selectedId);

  useEffect(() => {
    try {
      const restored = readDashboardWorkspace(window.localStorage);
      workspaceRef.current = restored.workspace; setWorkspace(restored.workspace);
      layoutRef.current = restored.workspace.tabs.find(tab => tab.id === restored.workspace.activeTabId)!.layout;
      if (restored.error) { storageBlocked.current = true; setStorageProblem(restored.error); }
    } catch { storageBlocked.current = true; setStorageProblem('브라우저 저장소를 읽을 수 없습니다. 현재 화면에서 편집할 수 있습니다.'); }
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => setCompact(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    let active = true, timedOut = false;
    const controller = new AbortController();
    setData(undefined); setError(''); setLoading(true);
    const now = Date.now();
    const from = period === 'custom' ? Date.parse(`${customFrom}T00:00:00+09:00`) : now - (period === '24h' ? DAY : period === '30d' ? 30 * DAY : 7 * DAY);
    const to = period === 'custom' ? Date.parse(`${customTo}T00:00:00+09:00`) + DAY : now;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > 90 * DAY) {
      setError('조회 기간은 시작일 이후, 최대 90일로 설정하세요.'); setLoading(false); return () => controller.abort();
    }
    const query = new URLSearchParams({ view: 'dashboard', from: new Date(from).toISOString(), to: new Date(to).toISOString(), source });
    if (workflowId) query.set('workflowId', workflowId);
    if (status) query.set('status', status);
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    void fetch(`/api/console?${query}`, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const result = await response.json().catch(() => { throw new Error('관리 서버의 집계 응답을 읽지 못했습니다. 다시 조회하세요.'); }) as DashboardResponse & { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message || '대시보드 집계를 불러오지 못했습니다.');
      if (typeof result.coverage?.matchedLogCount !== 'number' || typeof result.coverage?.storedLogCount !== 'number'
        || !Array.isArray(result.coverage?.notes) || !Number.isFinite(Date.parse(result.generatedAt))
        || Boolean(status && result.filters?.status !== status)
        || !(Object.keys(datasetLabels) as DashboardDatasetId[]).every(key => Array.isArray(result.datasets?.[key]?.columns) && Array.isArray(result.datasets?.[key]?.rows))) {
        throw new Error('대시보드 집계 API를 확인할 수 없습니다. Python 서버를 다시 실행한 뒤 조회하세요.');
      }
      if (active) setData(result);
    }).catch(cause => { if (active) setError(timedOut ? '집계 조회 시간이 초과됐습니다. 다시 조회하세요.' : cause instanceof TypeError ? '집계 서버에 연결하지 못했습니다. 연결 상태를 확인한 뒤 다시 조회하세요.' : cause instanceof Error ? cause.message : '집계 서버에 연결하지 못했습니다.'); }).finally(() => { window.clearTimeout(timeout); if (active) setLoading(false); });
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [activeTab.id, period, workflowId, source, status, customFrom, customTo, refresh]);

  const persist = (next: DashboardWorkspace, explicit = false) => {
    if (storageBlocked.current && !explicit) return;
    try {
      const result = saveDashboardWorkspace(window.localStorage, next);
      setStorageProblem(result.error || '');
      if (result.ok) storageBlocked.current = false;
    } catch { setStorageProblem('브라우저 저장소에 접근하지 못했습니다. 변경 내용은 현재 화면에 유지됩니다.'); }
  };
  const applyWorkspace = (next: DashboardWorkspace) => {
    workspaceRef.current = next;
    layoutRef.current = next.tabs.find(tab => tab.id === next.activeTabId)!.layout;
    setWorkspace(next);
    if (canCustomize) persist(next);
  };
  const setFilters = (patch: Partial<DashboardFilters>) => {
    const current = workspaceRef.current;
    applyWorkspace({ ...current, tabs: current.tabs.map(tab => {
      if (tab.id !== current.activeTabId) return tab;
      const filters = { ...tab.filters, ...patch };
      if (filters.period === 'custom') {
        filters.customFrom ||= customFrom; filters.customTo ||= customTo;
      }
      return { ...tab, filters };
    }) });
  };
  const resetTabContext = () => {
    finishGesture(true); past.current = []; future.current = [];
    setHistory({ past: 0, future: 0 }); setSelectedId(''); setAdding(false);
    setData(undefined); setLoading(true); setError(''); setNotice('');
  };
  const switchTab = (id: string, filters?: DashboardFilters) => {
    const current = workspaceRef.current;
    if (!current.tabs.some(tab => tab.id === id)) return;
    if (id === current.activeTabId && (!filters || JSON.stringify(filters) === JSON.stringify(current.tabs.find(tab => tab.id === id)!.filters))) return;
    resetTabContext();
    applyWorkspace({ ...current, activeTabId: id, tabs: filters ? current.tabs.map(tab => tab.id === id ? { ...tab, filters } : tab) : current.tabs });
  };
  const submitTab = (name: string) => {
    if (!canCustomize) return;
    const current = workspaceRef.current;
    const next = tabDialog === 'add' ? addDashboardTab(current, name) : tabDialog === 'rename' ? renameDashboardTab(current, current.activeTabId, name) : removeDashboardTab(current, current.activeTabId);
    if (next !== current) {
      if (next.activeTabId !== current.activeTabId) resetTabContext();
      applyWorkspace(next); setTrail([]);
    }
    setTabDialog(undefined);
  };
  const exportWorkspace=()=>{const blob=new Blob([JSON.stringify(workspaceRef.current,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='aegis-dashboard.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const importWorkspace=async(file:File)=>{if(file.size>2500000){setNotice('대시보드 설정은 2.5MB 이하 JSON 파일을 선택하세요.');return;}try{const parsed=parseDashboardWorkspace(await file.text());if(parsed.error){setNotice('대시보드 설정 형식을 확인하세요. 현재 구성은 유지됩니다.');return;}setImporting(parsed.workspace);}catch{setNotice('설정 파일을 읽지 못했습니다. 현재 구성은 유지됩니다.');}};
  const pageLabels={logs:'요청 기록',evaluation:'검증 실행',gateway:'API 배포'};
  const linkLabel=(widget:DashboardWidget)=>widget.interaction&&!widget.interaction.targetPage?workspace.tabs.find(tab=>tab.id===widget.interaction!.targetTabId)?.name:pageLabels[dashboardPageTarget(widget)];
  const activateValue = (widget: DashboardWidget, row: DashboardRow, key: string) => {
    if (editing) return;
    const current = workspaceRef.current;
    const origin = current.tabs.find(tab => tab.id === current.activeTabId)!;
    if(!widget.interaction||widget.interaction.targetPage){
      if(!onNavigate)return;
      const filters=resolveDashboardDrilldown(origin.filters,widget,row,key);
      const metadata=(value:unknown)=>typeof value==='string'&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value)?value:undefined;
      onNavigate({page:dashboardPageTarget(widget),filters,from:data?.filters.from,to:data?.filters.to,workflowId:metadata(row.workflowId)??filters.workflowId,runId:metadata(row.runId),deploymentId:metadata(row.deploymentId)});return;
    }
    const destination = current.tabs.find(tab => tab.id === widget.interaction!.targetTabId);
    if (!destination) { setNotice('연결된 대시보드 탭이 없습니다. 카드 설정을 확인하세요.'); return; }
    setTrail(items => [...items, { tabId: origin.id, filters: structuredClone(origin.filters) }].slice(-20));
    const filters = widget.interaction.mode === 'drilldown' ? resolveDashboardDrilldown(origin.filters, widget, row, key) : undefined;
    switchTab(destination.id, filters);
    setNotice(widget.interaction.mode === 'drilldown' ? '선택한 값의 조회 조건을 전달했습니다. 상단 필터에서 확인할 수 있습니다.' : `${destination.name} 탭으로 이동했습니다.`);
  };
  const commit = (next: DashboardLayout) => {
    if (!canCustomize || gesture.current || JSON.stringify(next) === JSON.stringify(layoutRef.current)) return;
    past.current.push(structuredClone(layoutRef.current)); if (past.current.length > 50) past.current.shift();
    future.current = []; setHistory({ past: past.current.length, future: 0 });
    const updated = { ...workspaceRef.current, tabs: workspaceRef.current.tabs.map(tab => tab.id === workspaceRef.current.activeTabId ? { ...tab, layout: next } : tab) };
    applyWorkspace(updated);
  };
  const undo = (redo = false) => {
    if (!canCustomize || gesture.current) return;
    const origin = redo ? future.current : past.current, target = redo ? past.current : future.current;
    const next = origin.pop(); if (!next) return;
    target.push(structuredClone(layoutRef.current));
    applyWorkspace({ ...workspaceRef.current, tabs: workspaceRef.current.tabs.map(tab => tab.id === workspaceRef.current.activeTabId ? { ...tab, layout: next } : tab) });
    setHistory({ past: past.current.length, future: future.current.length });
  };
  const updateWidget = (patch: Partial<DashboardWidget>) => {
    if (!selected) return;
    commit({ version: 1, widgets: layoutRef.current.widgets.map(widget => widget.id === selected.id ? { ...widget, ...patch } : widget) });
  };
  const changeDataset = (dataset: DashboardDatasetId, type = selected?.type) => {
    if (!selected || !type) return;
    const defaults = createDashboardWidget(type, dataset);
    updateWidget({ dataset, type, metric: defaults.metric, dimension: defaults.dimension, columns: defaults.columns, sortBy: defaults.sortBy, sortDirection: defaults.sortDirection, rowLimit: defaults.rowLimit });
  };
  const addWidget = (type: DashboardWidgetType) => {
    if (!canCustomize || layout.widgets.length >= MAX_DASHBOARD_WIDGETS) return;
    const widget = createDashboardWidget(type);
    widget.y = Math.max(0, ...layout.widgets.map(item => item.y + item.h));
    commit(addDashboardWidget(layoutRef.current, widget)); setSelectedId(widget.id); setAdding(false); setEditing(true);
    setNotice(type === 'table' ? '표 카드를 추가했습니다.' : '카드를 추가했습니다.');
    window.requestAnimationFrame(() => document.getElementById(`dashboard-${widget.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };
  const duplicate = (widget: DashboardWidget) => {
    const next = duplicateDashboardWidget(layoutRef.current, widget.id);
    if (next.widgets.length === layout.widgets.length) return;
    commit(next); setSelectedId(next.widgets.at(-1)!.id); setNotice('카드를 복제했습니다.');
  };
  const remove = (widget: DashboardWidget) => {
    const next = removeDashboardWidget(layoutRef.current, widget.id);
    commit(next); if (selectedId === widget.id) setSelectedId(next.widgets[0]?.id || ''); setNotice('카드를 삭제했습니다. 실행 취소로 복원할 수 있습니다.');
  };
  const beginGesture = (event: PointerEvent<HTMLElement>, widget: DashboardWidget, kind: Gesture['kind']) => {
    if (gesture.current || !editing || !canCustomize || compact || event.button !== 0 || event.isPrimary === false || !grid.current) return;
    event.preventDefault(); event.stopPropagation();
    setSelectedId(widget.id);
    const bounds = grid.current.getBoundingClientRect();
    gesture.current = {
      id: widget.id, pointerId: event.pointerId, kind,
      startPoint: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      metrics: { columnStride: (grid.current.clientWidth + DASHBOARD_GAP) / DASHBOARD_COLUMNS, rowStride: DASHBOARD_ROW_HEIGHT + DASHBOARD_GAP, gap: DASHBOARD_GAP },
      original: structuredClone(widget), before: structuredClone(layoutRef.current), proposed: structuredClone(layoutRef.current),
      swapped: false, moved: false, element: event.currentTarget,
    };
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveGesture = (event: PointerEvent<HTMLElement>) => {
    const active = gesture.current; if (!active || active.pointerId !== event.pointerId || !grid.current) return;
    event.stopPropagation();
    const bounds = grid.current.getBoundingClientRect();
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const deltaX = point.x - active.startPoint.x, deltaY = point.y - active.startPoint.y;
    if (!active.moved && Math.abs(deltaX) + Math.abs(deltaY) < 3) return;
    active.moved = true;
    const dx = Math.round(deltaX / active.metrics.columnStride), dy = Math.round(deltaY / active.metrics.rowStride);
    let next: DashboardLayout;
    if (active.kind === 'move') {
      const desired = { ...active.original, x: active.original.x + dx, y: active.original.y + dy };
      const result = dragWidget(active.before.widgets, active.id, desired, point, active.original, active.metrics);
      next = { version: 1, widgets: result.widgets };
      active.swapped = Boolean(result.swapped);
      setDragPreview({
        widgets: next.widgets, probe: result.swapped ? next.widgets.find(widget => widget.id === active.id)! : result.probe, metrics: active.metrics, blocked: result.blocked,
        targetId: result.target?.id ?? null, activeId: active.id,
        message: result.swapped ? '놓으면 미리보기대로 자리 교체' : result.blocked ? '다른 카드 중앙으로 이동하면 자리 교체' : '놓으면 이 위치에 배치',
      });
    } else {
      const desired = { ...active.original, w: Math.min(DASHBOARD_COLUMNS - active.original.x, active.original.w + dx), h: active.original.h + dy };
      next = { version: 1, widgets: placeWidget(active.before.widgets, active.id, desired) };
      const resized = next.widgets.find(widget => widget.id === active.id)!;
      setDragPreview({ widgets: next.widgets, probe: resized, metrics: active.metrics, blocked: false, targetId: null, activeId: active.id, message: '놓으면 미리보기 크기와 배치 적용' });
    }
    active.proposed = next;
  };
  const finishGesture = (cancel = false) => {
    const active = gesture.current; if (!active) return;
    gesture.current = undefined;
    setDragPreview(undefined);
    try { active.element.releasePointerCapture(active.pointerId); } catch { /* Pointer capture may already be released. */ }
    if (!cancel) commit(active.proposed);
    if (!cancel && active.swapped) setNotice('카드 자리를 바꿨습니다. 실행 취소로 되돌릴 수 있습니다.');
  };
  const endGesture = (event: PointerEvent<HTMLElement>, cancel = false) => {
    if (gesture.current?.pointerId === event.pointerId) { event.stopPropagation(); finishGesture(cancel); }
  };
  const geometryKeys = (event: KeyboardEvent<HTMLButtonElement>, widget: DashboardWidget, resizing = false) => {
    if (!editing || !canCustomize || compact || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 2 : 1, dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    const rect = resizing ? { ...widget, w: widget.w + dx, h: widget.h + dy } : { ...widget, x: widget.x + dx, y: widget.y + dy };
    commit({ version: 1, widgets: placeWidget(layoutRef.current.widgets, widget.id, rect) });
  };
  const selectWidgetType = (type: DashboardWidgetType) => {
    if (!selected) return;
    if (type === 'kpi') changeDataset('summary', type);
    else if (selected.dataset === 'summary' && type !== 'table') changeDataset(type === 'donut' ? 'requestStatus' : 'requestTrend', type);
    else updateWidget({ type });
  };
  const currentDataset = selected && data?.datasets[selected.dataset];
  const storageLabel = storageProblem ? '저장 확인 필요' : '이 브라우저에 자동 저장';

  return <div className="dashboard-page" onKeyDown={event => {
    if (event.key === 'Escape' && gesture.current) { event.preventDefault(); finishGesture(true); return; }
    if (!editing || !(event.ctrlKey || event.metaKey) || (event.target as HTMLElement).closest('input,select,textarea')) return;
    if (event.key.toLowerCase() === 'z') { event.preventDefault(); undo(event.shiftKey); }
    else if (event.key.toLowerCase() === 'y') { event.preventDefault(); undo(true); }
  }}>
    <PageHeading title="대시보드" description="요청과 검사 결과, 검증과 배포 현황을 한눈에 확인합니다.">
      <button className="btn small" onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''}/> 새로고침</button>
      {canCustomize && <button className={`btn small ${editing ? 'primary' : ''}`} aria-pressed={editing} onClick={() => { finishGesture(true); setEditing(value => !value); setAdding(false); }}>{editing ? <Check size={14}/> : <Pencil size={14}/>} {editing ? '편집 완료' : '대시보드 편집'}</button>}
    </PageHeading>

    <div className="dashboard-tab-toolbar">
      <div className="dashboard-tabs" role="tablist" aria-label="대시보드 탭">{workspace.tabs.map((tab, index) => <button key={tab.id} id={`dashboard-tab-${tab.id}`} role="tab" aria-selected={tab.id === activeTab.id} aria-controls="dashboard-tab-panel" tabIndex={tab.id === activeTab.id ? 0 : -1} title={tab.name} onClick={() => { setTrail([]); switchTab(tab.id); }} onKeyDown={event => {
        const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        if (!offset && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const next = workspace.tabs[event.key === 'Home' ? 0 : event.key === 'End' ? workspace.tabs.length - 1 : (index + offset + workspace.tabs.length) % workspace.tabs.length];
        setTrail([]); switchTab(next.id); document.getElementById(`dashboard-tab-${next.id}`)?.focus();
      }}><LayoutDashboard size={13}/><span>{tab.name}</span></button>)}</div>
      {canCustomize && <div className="dashboard-tab-actions"><button className="icon-button" aria-label="대시보드 탭 복제" title="현재 탭 복제" disabled={workspace.tabs.length>=MAX_DASHBOARD_TABS} onClick={()=>{resetTabContext();applyWorkspace(duplicateDashboardTab(workspaceRef.current,activeTab.id));setTrail([]);}}><Copy size={14}/></button><button className="icon-button" aria-label="대시보드 탭 추가" title={`탭 추가 (${workspace.tabs.length}/${MAX_DASHBOARD_TABS})`} disabled={workspace.tabs.length >= MAX_DASHBOARD_TABS} onClick={() => setTabDialog('add')}><Plus size={16}/></button><button className="icon-button" aria-label="탭 이름 변경" title="탭 이름 변경" onClick={() => setTabDialog('rename')}><Pencil size={14}/></button><button className="icon-button" aria-label="대시보드 탭 삭제" title={workspace.tabs.length === 1 ? '마지막 탭은 삭제할 수 없습니다' : '현재 탭 삭제'} disabled={workspace.tabs.length === 1} onClick={() => setTabDialog('delete')}><Trash2 size={14}/></button></div>}
    </div>
    {canCustomize&&<div className="dashboard-config-tools"><label>시작 틀<select aria-label="대시보드 시작 틀" defaultValue="" disabled={workspace.tabs.length>=MAX_DASHBOARD_TABS} onChange={event=>{if(event.target.value){resetTabContext();applyWorkspace(addDashboardTemplate(workspaceRef.current,event.target.value as 'overview'|'blocks'|'validation'));setTrail([]);event.target.value='';}}}><option value="">새 탭에 적용</option><option value="overview">운영 요약</option><option value="blocks">차단 분석</option><option value="validation">검증과 배포</option></select></label><button className="btn small" onClick={exportWorkspace}><Download size={13}/> 구성 내보내기</button><button className="btn small" onClick={()=>importInput.current?.click()}><Upload size={13}/> 구성 가져오기</button><input type="file" hidden ref={importInput} accept=".json,application/json" aria-label="대시보드 구성 파일" onChange={event=>{const file=event.target.files?.[0];if(file)void importWorkspace(file);event.target.value='';}}/></div>}
    {!!trail.length && <div className="dashboard-navigation"><button className="btn small" onClick={() => {
      const previous = trail.at(-1)!; setTrail(items => items.slice(0, -1)); switchTab(previous.tabId, previous.filters);
    }}><ArrowLeft size={13}/> 이전 대시보드로</button><span>{activeTab.name}</span></div>}
    <section id="dashboard-tab-panel" role="tabpanel" aria-labelledby={`dashboard-tab-${activeTab.id}`}>

    <section className="dashboard-filters" aria-label="대시보드 조회 조건"><div className="dashboard-periods" role="group" aria-label="조회 기간">{[['24h', '24시간'], ['7d', '7일'], ['30d', '30일'], ['custom', '직접 선택']].map(([value, label]) => <button key={value} className={period === value ? 'active' : ''} aria-pressed={period === value} onClick={() => setFilters({ period: value as DashboardFilters['period'] })}>{label}</button>)}</div>
      <label>워크플로우<select aria-label="대시보드 워크플로우" value={workflowId} onChange={event => setFilters({ workflowId: event.target.value })}><option value="">전체 워크플로우</option>{workflowId && !state.workflows.some(workflow => workflow.id === workflowId) && <option value={workflowId}>보관된 워크플로우</option>}{state.workflows.map(workflow => <option value={workflow.id} key={workflow.id}>{workflow.name}</option>)}</select></label>
      <label>요청 출처<select aria-label="대시보드 요청 출처" value={source} onChange={event => setFilters({ source: event.target.value as DashboardSource })}><option value="gateway">Gateway</option><option value="evaluation">데이터셋 검증</option><option value="playground">시험 실행</option><option value="all">전체 출처</option></select></label>
      <label>요청 판정<select aria-label="대시보드 요청 판정" value={status} onChange={event => setFilters({ status: event.target.value as DashboardFilters['status'] })}><option value="">전체 판정</option><option value="allow">허용</option><option value="block">차단</option><option value="error">오류</option></select></label>
      {period === 'custom' && <div className="dashboard-date-range"><label>시작일<input aria-label="조회 시작일" type="date" value={customFrom} max={customTo} onChange={event => setFilters({ customFrom: event.target.value })}/></label><span>~</span><label>종료일<input aria-label="조회 종료일" type="date" value={customTo} min={customFrom} onChange={event => setFilters({ customTo: event.target.value })}/></label><small>한국 시간, 최대 90일</small></div>}
    </section>

    <div className="dashboard-filter-chips" aria-label="적용 중인 대시보드 조회 조건">{dashboardFilterChips(activeTab.filters,state.workflows).map(chip=><span className={chip.changed?'is-filtered':''} key={chip.key}><small>{chip.label}</small><strong>{chip.value}</strong>{chip.changed&&<button type="button" aria-label={`${chip.label} 조건 해제`} title={`${chip.label} 기본값으로`} onClick={()=>setFilters(chip.key==='period'?{period:'7d',customFrom:'',customTo:''}:{[chip.key]:defaultDashboardFilters()[chip.key]})}><X size={12}/></button>}</span>)}<button type="button" className="btn small" onClick={()=>{setFilters(defaultDashboardFilters());setNotice('이 탭의 조회 조건을 기본값으로 초기화했습니다.');}} disabled={Object.entries(defaultDashboardFilters()).every(([key,value])=>activeTab.filters[key as keyof DashboardFilters]===value)}><RotateCcw size={12}/>조회 조건 초기화</button></div>

    <div className="dashboard-coverage"><span className={`dashboard-coverage-dot ${loading ? 'loading' : error ? 'error' : ''}`}/>{loading ? <span>보관된 기록을 집계하고 있습니다.</span> : data ? <><strong>조회 범위 내 보관 요청 {data.coverage.matchedLogCount.toLocaleString()}건</strong><span>한국 시간 기준</span><time dateTime={data.generatedAt}>{new Date(data.generatedAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' })} 조회</time></> : <span>집계 데이터가 없습니다.</span>}
      <span className="dashboard-storage"><Check size={12}/> {storageLabel}</span></div>
    {data&&(data.coverage.capacityReached||data.coverage.missingUsageCount>0)&&<div className="dashboard-coverage-warning" role="status">{data.coverage.capacityReached&&<span>보관 건수 한도에 도달했습니다. 선택 기간의 이전 요청이 집계에서 빠질 수 있습니다. </span>}{data.coverage.missingUsageCount>0&&<span>토큰 사용량이 없는 요청 {data.coverage.missingUsageCount}건입니다. 토큰 지표는 응답 생성 모델 기준입니다.</span>}</div>}
    {data && <details className="dashboard-coverage-details"><summary><TriangleAlert size={13}/> 집계 범위와 데이터 기준 <ChevronDown size={13}/></summary><div><p>요청 기록은 최대 {data.coverage.logDays}일, 최근 {data.coverage.logLimit.toLocaleString()}건을 보관합니다. 현재 보관된 요청은 {data.coverage.storedLogCount.toLocaleString()}건입니다.{data.coverage.capacityReached && ' 건수 한도에 도달해 선택 기간의 이전 기록이 누락될 수 있습니다.'}</p><p>요청 필터는 요청 관련 카드에 적용합니다. 검증은 기간과 워크플로우 기준이며, 현재 배포는 워크플로우 기준입니다.</p>{data.coverage.notes.map((note, index) => <p key={index}>{note}</p>)}</div></details>}
    {storageProblem && <div className="dashboard-alert" role="alert"><TriangleAlert size={16}/><span>{storageProblem}</span>{canCustomize && <button className="btn small" onClick={() => persist(workspaceRef.current, true)}>현재 구성으로 저장</button>}</div>}
    {error && <div className="dashboard-alert" role="alert"><TriangleAlert size={17}/><span>{error}</span><button className="btn small" onClick={() => setRefresh(value => value + 1)}>다시 조회</button></div>}
    {notice && <div className="dashboard-notice" role="status"><Check size={14}/>{notice}<button aria-label="대시보드 안내 닫기" onClick={() => setNotice('')}><X size={13}/></button></div>}

    {editing && <div className="dashboard-edit-bar"><span><Grip size={15}/> {compact ? '좁은 화면에서는 세로로 표시합니다.' : '원본은 고정됩니다. 반투명 배치를 확인한 뒤 놓으세요.'}</span><div><button className="icon-button" aria-label="대시보드 실행 취소" title="실행 취소" disabled={!history.past} onClick={() => undo()}><RotateCcw size={16}/></button><button className="icon-button" aria-label="대시보드 다시 실행" title="다시 실행" disabled={!history.future} onClick={() => undo(true)}><RotateCw size={16}/></button><span className="dashboard-card-limit">{layout.widgets.length}/{MAX_DASHBOARD_WIDGETS}</span><div className="dashboard-add-control"><button className="btn small primary" aria-expanded={adding} disabled={layout.widgets.length >= MAX_DASHBOARD_WIDGETS} onClick={() => setAdding(value => !value)}><Plus size={14}/> 카드 추가</button>{adding && <div className="dashboard-add-menu" aria-label="추가할 카드 종류">{widgetTypes.map(type => <button key={type.id} onClick={() => addWidget(type.id)}><type.icon size={17}/>{type.label}</button>)}</div>}</div></div></div>}

    <div className={`dashboard-workspace ${editing ? 'is-editing' : ''}`}>
      <div className="dashboard-board"><div className={`dashboard-grid ${editing ? 'is-editing' : ''}`} ref={grid} style={dragPreview ? { minHeight: Math.max(0, ...layout.widgets.map(widget => widget.y + widget.h), ...dragPreview.widgets.map(widget => widget.y + widget.h)) * dragPreview.metrics.rowStride - DASHBOARD_GAP } : undefined}>
        {layout.widgets.map(widget => <article key={widget.id} id={`dashboard-${widget.id}`} className={`dashboard-widget ${editing && selectedId === widget.id ? 'is-selected' : ''} ${dragPreview?.activeId === widget.id ? 'is-dragging' : ''} ${dragPreview?.widgets.some(candidate => candidate.id === widget.id && ['x', 'y', 'w', 'h'].some(key => candidate[key as keyof DashboardRect] !== widget[key as keyof DashboardRect])) ? 'is-preview-affected' : ''} ${dragPreview?.targetId === widget.id ? 'is-swap-target' : ''}`} data-kind={widget.type} data-widget-id={widget.id} style={{ gridColumn: `${widget.x + 1} / span ${widget.w}`, gridRow: `${widget.y + 1} / span ${widget.h}`, order: widget.y * DASHBOARD_COLUMNS + widget.x, '--widget-color': palettes[widget.color][0] } as CSSProperties} aria-label={`${widget.title} 카드`} onClick={() => { if (editing) setSelectedId(widget.id); }}>
          <header tabIndex={-1} onPointerDown={event => { if (!(event.target as HTMLElement).closest('button')) beginGesture(event, widget, 'move'); }} onPointerMove={moveGesture} onPointerUp={event => endGesture(event)} onPointerCancel={event => endGesture(event, true)} onLostPointerCapture={event => endGesture(event, true)}>{editing && <button className="dashboard-grip" aria-label={`${widget.title} 이동`} title="다른 카드 중앙으로 끌면 자리 교체. 방향키로도 이동할 수 있습니다" disabled={compact} onPointerDown={event => beginGesture(event, widget, 'move')} onPointerMove={moveGesture} onPointerUp={event => endGesture(event)} onPointerCancel={event => endGesture(event, true)} onLostPointerCapture={event => endGesture(event, true)} onKeyDown={event => geometryKeys(event, widget)}><Grip size={14}/></button>}<h2>{widget.title || '이름 없는 카드'}</h2>{widget.type === 'table' && <Table2 size={13} className="dashboard-kind-icon"/>}{editing && <div className="dashboard-widget-actions"><button aria-label={`${widget.title} 복제`} disabled={layout.widgets.length >= MAX_DASHBOARD_WIDGETS} onClick={event => { event.stopPropagation(); duplicate(widget); }}><Copy size={13}/></button><button aria-label={`${widget.title} 삭제`} onClick={event => { event.stopPropagation(); remove(widget); }}><Trash2 size={13}/></button></div>}</header>
          <div className="dashboard-widget-content">{loading ? <div className="dashboard-card-skeleton" aria-label="카드 집계 중"/> : error ? <div className="dashboard-card-empty">집계를 다시 조회하세요.</div> : <WidgetContent widget={widget} dataset={data?.datasets[widget.dataset]} onActivate={!editing && (widget.interaction?.targetPage ? onNavigate : widget.interaction ? workspace.tabs.some(tab => tab.id === widget.interaction!.targetTabId) : onNavigate) ? (row, key) => activateValue(widget, row, key) : undefined} linkLabel={linkLabel(widget)}/>}</div>
          {widget.interaction && <div className="dashboard-card-link-hint"><ArrowUpRight size={11}/>{linkLabel(widget)}{widget.interaction.mode === 'drilldown' ? ' / 조건 전달' : ''}{editing ? ' (조회 화면에서 사용)' : ''}</div>}
          {widget.type !== 'kpi' && <footer title={data?.datasets[widget.dataset].description}>{datasetLabels[widget.dataset]}{widget.type !== 'table' && data && widget.rowLimit < data.datasets[widget.dataset].totalRows ? ` / ${widget.rowLimit}개 항목 표시 (전체 ${data.datasets[widget.dataset].totalRows}개)` : ''}{widget.type !== 'table' && data?.datasets[widget.dataset].truncated ? ' / 조회 한도 적용' : ''}</footer>}
          {editing && !compact && <button className="dashboard-resize" aria-label={`${widget.title} 크기 조절`} title="방향키로도 크기를 조절할 수 있습니다" onPointerDown={event => beginGesture(event, widget, 'resize')} onPointerMove={moveGesture} onPointerUp={event => endGesture(event)} onPointerCancel={event => endGesture(event, true)} onLostPointerCapture={event => endGesture(event, true)} onKeyDown={event => geometryKeys(event, widget, true)}><span/></button>}
        </article>)}
        {dragPreview && dragPreview.widgets.filter(candidate => {
          const original = layout.widgets.find(widget => widget.id === candidate.id)!;
          return (['x', 'y', 'w', 'h'] as const).some(key => original[key] !== candidate[key]);
        }).map(candidate => <div key={candidate.id} className={`dashboard-ghost-preview ${candidate.id === dragPreview.activeId ? 'is-active' : ''}`} data-preview-widget-id={candidate.id} style={{ left: candidate.x * dragPreview.metrics.columnStride, top: candidate.y * dragPreview.metrics.rowStride, width: candidate.w * dragPreview.metrics.columnStride - dragPreview.metrics.gap, height: candidate.h * dragPreview.metrics.rowStride - dragPreview.metrics.gap, '--widget-color': palettes[candidate.color][0] } as CSSProperties} aria-hidden="true"><strong>{candidate.title || '이름 없는 카드'}</strong><div><LayoutDashboard size={24}/><span>{widgetTypes.find(type => type.id === candidate.type)?.label} 배치 미리보기</span></div></div>)}
        {dragPreview && <div className={`dashboard-drop-preview ${dragPreview.blocked ? 'is-blocked' : ''}`} data-blocked={dragPreview.blocked} style={{ left: dragPreview.probe.x * dragPreview.metrics.columnStride, top: dragPreview.probe.y * dragPreview.metrics.rowStride, width: dragPreview.probe.w * dragPreview.metrics.columnStride - dragPreview.metrics.gap, height: dragPreview.probe.h * dragPreview.metrics.rowStride - dragPreview.metrics.gap }} aria-hidden="true"><span>{dragPreview.message}</span></div>}
      </div>{!layout.widgets.length && <div className="dashboard-empty"><LayoutDashboard size={32}/><h2>나만의 대시보드를 구성하세요</h2><p>지표, 차트와 표를 원하는 위치에 배치할 수 있습니다.</p>{canCustomize && <button className="btn primary" onClick={() => { setEditing(true); setAdding(true); }}><Plus size={15}/> 첫 카드 추가</button>}</div>}</div>

      {editing && <aside className="dashboard-inspector" aria-label="대시보드 카드 설정"><div className="dashboard-inspector-heading"><Settings2 size={16}/><h2>카드 설정</h2></div>{selected ? <>
        <div className="dashboard-inspector-fields"><label className="field">카드 제목<input aria-label="카드 제목" maxLength={80} value={selected.title} onChange={event => updateWidget({ title: event.target.value })}/></label>
          <fieldset><legend>표시 방식</legend><div className="dashboard-type-picker">{widgetTypes.map(type => <button key={type.id} className={selected.type === type.id ? 'active' : ''} aria-pressed={selected.type === type.id} aria-label={`카드 표시 ${type.label}`} onClick={() => selectWidgetType(type.id)}><type.icon size={17}/><span>{type.label}</span></button>)}</div></fieldset>
          <label className="field">데이터<select aria-label="카드 데이터" value={selected.dataset} onChange={event => changeDataset(event.target.value as DashboardDatasetId)}>{Object.entries(datasetLabels).filter(([key]) => selected.type === 'kpi' ? key === 'summary' : selected.type === 'table' || key !== 'summary').map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
          <p className="dashboard-field-hint">{currentDataset?.description || '집계 데이터를 조회한 뒤 표시할 항목을 선택할 수 있습니다.'}</p>
          {selected.type === 'table' ? <fieldset className="dashboard-column-picker"><legend>표시할 열</legend>{currentDataset?.columns.map(column => <label key={column.key}><input type="checkbox" aria-label={`표 열 ${column.label}`} checked={selected.columns.includes(column.key)} onChange={event => updateWidget({ columns: event.target.checked ? [...selected.columns, column.key] : selected.columns.filter(key => key !== column.key) })}/><span>{column.label}</span><small>{column.type === 'number' ? '숫자' : column.type === 'datetime' ? '시간' : '분류'}</small></label>)}</fieldset> : <>
            {selected.type !== 'kpi' && <label className="field">분류<select aria-label="카드 분류" value={selected.dimension} onChange={event => updateWidget({ dimension: event.target.value })}>{currentDataset?.columns.map(column => <option value={column.key} key={column.key}>{column.label}</option>)}</select></label>}
            <label className="field">지표<select aria-label="카드 지표" value={selected.metric} onChange={event => updateWidget({ metric: event.target.value })}>{currentDataset?.columns.filter(column => column.type === 'number').map(column => <option value={column.key} key={column.key}>{column.label}</option>)}</select></label>
          </>}
          <fieldset className="dashboard-interaction-settings"><legend><ArrowUpRight size={13}/> 탭 연결</legend>
            <label className="field">이동 대상<select aria-label="이동할 대시보드" value={selected.interaction?.targetPage?`page:${selected.interaction.targetPage}`:selected.interaction?.targetTabId??''} onChange={event=>{const value=event.target.value;updateWidget({interaction:!value?undefined:value.startsWith('page:')?{targetTabId:'',targetPage:value.slice(5) as 'logs'|'evaluation'|'gateway',mode:'drilldown'}:{targetTabId:value,mode:selected.interaction?.mode??'link'}});}}><option value="">관련 기록으로 이동 (기본)</option><optgroup label="관리 페이지"><option value="page:logs">요청 기록</option><option value="page:evaluation">검증 실행</option><option value="page:gateway">API 배포</option></optgroup><optgroup label="대시보드 탭">{workspace.tabs.filter(tab=>tab.id!==activeTab.id).map(tab=><option key={tab.id} value={tab.id}>{tab.name}</option>)}</optgroup></select></label>
            {selected.interaction && !selected.interaction.targetPage && <label className="field">이동 방식<select aria-label="이동 방식" value={selected.interaction.mode} onChange={event => updateWidget({ interaction: { ...selected.interaction!, mode: event.target.value as 'link' | 'drilldown' } })}><option value="link">탭으로 이동</option><option value="drilldown">선택한 조건으로 드릴다운</option></select></label>}
            <p className="dashboard-field-hint">{selected.interaction?.targetPage||!selected.interaction?'선택한 값의 워크플로우와 판정, 현재 기간을 관련 관리 페이지로 전달합니다.': selected.interaction?.mode === 'drilldown' ? '현재 기간과 출처를 넘깁니다. 워크플로우 행은 해당 워크플로우로, 판정 값은 허용, 차단 또는 오류로 좁힙니다. 시간대별 차트는 현재 기간을 유지합니다.' : '차트나 표의 값을 누르면 연결한 탭의 조회 조건으로 이동합니다.'} 편집을 완료한 뒤 사용할 수 있습니다.</p>
            <DashboardInteractionPreview key={`${selected.id}:${selected.dataset}`} widget={selected} dataset={currentDataset} origin={activeTab.filters} destination={workspace.tabs.find(tab=>tab.id===selected.interaction?.targetTabId)} workflows={state.workflows}/>
          </fieldset>
          <details className="dashboard-advanced-settings"><summary>정렬, 색상과 배치</summary>
          {selected.type !== 'kpi' && <><div className="dashboard-field-row"><label className="field">정렬 기준<select aria-label="카드 정렬 기준" value={selected.sortBy} onChange={event => updateWidget({ sortBy: event.target.value })}><option value="">기본 순서</option>{currentDataset?.columns.map(column => <option value={column.key} key={column.key}>{column.label}</option>)}</select></label><label className="field">방향<select aria-label="카드 정렬 방향" value={selected.sortDirection} onChange={event => updateWidget({ sortDirection: event.target.value as 'asc' | 'desc' })}><option value="asc">오름차순</option><option value="desc">내림차순</option></select></label></div><label className="field">{selected.type === 'table' ? '표시 행 수' : '표시 항목 수'}<input aria-label="카드 표시 행 수" type="number" min={1} max={100} value={selected.rowLimit} onChange={event => updateWidget({ rowLimit: Math.min(100, Math.max(1, Math.round(Number(event.target.value)) || 1)) })}/></label></>}
          <fieldset><legend>강조 색상</legend><div className="dashboard-colors">{(Object.keys(palettes) as DashboardColor[]).map(color => <button key={color} className={selected.color === color ? 'active' : ''} aria-label={`${colorLabels[color]} 색상`} aria-pressed={selected.color === color} onClick={() => updateWidget({ color })} style={{ background: palettes[color][0] }}>{selected.color === color && <Check size={15}/>}</button>)}</div></fieldset>
          {!compact && <fieldset><legend>배치</legend><div className="dashboard-geometry">{(['x', 'y', 'w', 'h'] as const).map(key => <label key={key}>{({ x: '가로 위치', y: '세로 위치', w: '너비', h: '높이' })[key]}<input aria-label={`카드 ${({ x: '가로 위치', y: '세로 위치', w: '너비', h: '높이' })[key]}`} type="number" min={key === 'w' ? 3 : key === 'h' ? 2 : 0} max={key === 'w' ? 12 : key === 'x' ? 9 : key === 'h' ? 10 : 1000} value={selected[key]} onChange={event => commit({ version: 1, widgets: placeWidget(layoutRef.current.widgets, selected.id, { ...selected, [key]: Number(event.target.value) }) })}/></label>)}</div></fieldset>}
          </details>
        </div><div className="dashboard-inspector-footer"><button className="btn small" disabled={layout.widgets.length >= MAX_DASHBOARD_WIDGETS} onClick={() => duplicate(selected)}><Copy size={14}/> 복제</button><button className="btn small" onClick={() => remove(selected)}><Trash2 size={14}/> 삭제</button></div>
      </> : <div className="dashboard-inspector-empty"><LayoutDashboard size={26}/><p>카드를 선택하거나 새로 추가하세요.</p></div>}<p className="dashboard-local-note">배치와 카드 설정은 현재 브라우저에만 저장됩니다. 요청 원문과 응답은 저장하지 않습니다.</p></aside>}
    </div>
    <p className="dashboard-bottom-note">보관된 실행 기록 기준입니다. 인증 실패 등 실행 전 거부된 요청은 포함되지 않습니다.</p>
    </section>
    {importing&&<dialog ref={importDialog} className="dashboard-tab-dialog" aria-label="대시보드 구성 가져오기 확인" onCancel={()=>setImporting(undefined)}><header><h2>대시보드 구성 가져오기</h2></header><p>현재 {workspace.tabs.length}개 탭을 파일의 {importing.tabs.length}개 탭, {importing.tabs.reduce((count,tab)=>count+tab.layout.widgets.length,0)}개 카드로 교체합니다. 실행 기록과 서버 설정은 바뀌지 않습니다.</p><p>필요하면 먼저 현재 구성을 내보내 보관하세요.</p><footer><button className="btn small" onClick={exportWorkspace}>현재 구성 내보내기</button><button autoFocus className="btn small" onClick={()=>setImporting(undefined)}>취소</button><button className="btn small primary" onClick={()=>{resetTabContext();applyWorkspace(importing);setImporting(undefined);setTrail([]);setNotice('검사한 대시보드 구성을 가져왔습니다.');}}>구성 교체</button></footer></dialog>}
    {tabDialog && <DashboardTabDialog key={`${activeTab.id}-${tabDialog}`} action={tabDialog} name={activeTab.name} onClose={() => setTabDialog(undefined)} onSubmit={submitTab}/>}
  </div>;
}
