import type { DashboardColor, DashboardDatasetId, DashboardLayout, DashboardWidget, DashboardWidgetType } from './dashboard-types';

export const DASHBOARD_STORAGE_KEY = 'aegis.dashboard.layout.v1';
export const DASHBOARD_COLUMNS = 12;
export const DASHBOARD_ROW_HEIGHT = 56;
export const DASHBOARD_GAP = 16;
export const MAX_DASHBOARD_WIDGETS = 24;

export type DashboardRect = Pick<DashboardWidget, 'x' | 'y' | 'w' | 'h'>;
export type DashboardPoint = { x: number; y: number };
export type DashboardGridMetrics = { columnStride: number; rowStride: number; gap: number };

const unitGrid: DashboardGridMetrics = { columnStride: 1, rowStride: 1, gap: 0 };

const widgetTypes: DashboardWidgetType[] = ['kpi', 'line', 'bar', 'donut', 'table'];
const datasets: DashboardDatasetId[] = ['summary', 'requestTrend', 'requestStatus', 'workflowRequests', 'evaluations', 'deployments'];
const colors: DashboardColor[] = ['teal', 'blue', 'violet', 'amber'];
const safeKey = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const cloneWidget = (widget: DashboardWidget): DashboardWidget => ({ ...widget, columns: [...widget.columns], ...(widget.interaction ? { interaction: { ...widget.interaction } } : {}) });
const integer = (value: number, minimum: number, maximum: number, fallback: number) => Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.round(value))) : fallback;

/** Geometry is integral and bounded horizontally. Vertical space grows with the cards. */
export function normalizeDashboardRect(rect: DashboardRect): DashboardRect {
  const w = integer(rect.w, 3, DASHBOARD_COLUMNS, 4);
  return { x: integer(rect.x, 0, DASHBOARD_COLUMNS - w, 0), y: integer(rect.y, 0, 10_000, 0), w, h: integer(rect.h, 2, 10, 4) };
}

function overlaps(left: DashboardRect, right: DashboardRect): boolean {
  return left.x < right.x + right.w && right.x < left.x + left.w && left.y < right.y + right.h && right.y < left.y + left.h;
}

/** Keep earlier cards in place and push each following collision down to the next free row. */
export function normalizeDashboardWidgets(widgets: DashboardWidget[]): DashboardWidget[] {
  const placed: DashboardWidget[] = [];
  for (const original of widgets) {
    const widget = { ...cloneWidget(original), ...normalizeDashboardRect(original) };
    let colliding = placed.filter(other => overlaps(widget, other));
    while (colliding.length) {
      widget.y = Math.max(...colliding.map(other => other.y + other.h));
      colliding = placed.filter(other => overlaps(widget, other));
    }
    placed.push(widget);
  }
  return placed;
}

/** Explicit placement and resizing give the changed card priority over collisions. */
export function placeWidget(widgets: DashboardWidget[], id: string, rect: DashboardRect): DashboardWidget[] {
  const target = widgets.find(widget => widget.id === id);
  if (!target) return widgets.map(cloneWidget);
  const normalized = normalizeDashboardWidgets([
    { ...target, ...normalizeDashboardRect(rect) },
    ...widgets.filter(widget => widget.id !== id),
  ]);
  const positions = new Map(normalized.map(widget => [widget.id, widget]));
  return widgets.map(widget => positions.get(widget.id)!);
}

function visibleRect(rect: DashboardRect, metrics: DashboardGridMetrics): DashboardRect {
  return {
    x: rect.x * metrics.columnStride, y: rect.y * metrics.rowStride,
    w: rect.w * metrics.columnStride - metrics.gap, h: rect.h * metrics.rowStride - metrics.gap,
  };
}

/** Hit tests use the visible card rather than the grid cell, which includes its trailing gap. */
export function dashboardContainsPoint(rect: DashboardRect, point: DashboardPoint, metrics: DashboardGridMetrics = unitGrid, pad = 0): boolean {
  const card = visibleRect(rect, metrics);
  return point.x >= card.x - pad && point.x <= card.x + card.w + pad
    && point.y >= card.y - pad && point.y <= card.y + card.h + pad;
}

function center(rect: DashboardRect): DashboardPoint {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function swapOrientation(origin: DashboardRect, target: DashboardRect, metrics: DashboardGridMetrics): 'horizontal' | 'vertical' {
  const a = visibleRect(origin, metrics), b = visibleRect(target, metrics);
  const ac = center(a), bc = center(b);
  const verticalOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return verticalOverlap > 0 && Math.abs(ac.x - bc.x) > Math.abs(ac.y - bc.y) ? 'horizontal' : 'vertical';
}

function hoverWidget(widgets: DashboardWidget[], id: string, point: DashboardPoint, origin: DashboardRect, metrics: DashboardGridMetrics) {
  const target = widgets.find(widget => widget.id !== id && dashboardContainsPoint(widget, point, metrics));
  if (!target) return { target: null, ready: false };
  const a = center(visibleRect(origin, metrics)), b = visibleRect(target, metrics), bc = center(b);
  const inside = point.x >= b.x + b.w * .18 && point.x <= b.x + b.w * .82
    && point.y >= b.y + b.h * .18 && point.y <= b.y + b.h * .82;
  const crossed = swapOrientation(origin, target, metrics) === 'horizontal'
    ? bc.x < a.x ? point.x <= bc.x + b.w * .06 : point.x >= bc.x - b.w * .06
    : bc.y < a.y ? point.y <= bc.y + b.h * .06 : point.y >= bc.y - b.h * .06;
  return { target, ready: inside && crossed };
}

/** Only a deliberate swap can settle other cards; its two participants retain priority. */
function settleSwap(widgets: DashboardWidget[], priority: string[]): DashboardWidget[] {
  const copies = widgets.map(widget => ({ ...cloneWidget(widget), ...normalizeDashboardRect(widget) }));
  const index = new Map(copies.map((widget, i) => [widget.id, i]));
  const rank = new Map(priority.map((id, i) => [id, i]));
  const order = [...copies].sort((a, b) => (rank.get(a.id) ?? priority.length) - (rank.get(b.id) ?? priority.length)
    || a.y - b.y || a.x - b.x || index.get(a.id)! - index.get(b.id)!);
  const placed: DashboardWidget[] = [];
  for (const widget of order) {
    let blocking = placed.filter(other => overlaps(widget, other));
    while (blocking.length) {
      widget.y = Math.max(...blocking.map(other => other.y + other.h));
      blocking = placed.filter(other => overlaps(widget, other));
    }
    placed.push(widget);
  }
  const byId = new Map(placed.map(widget => [widget.id, widget]));
  return widgets.map(widget => byId.get(widget.id)!);
}

function swapWidgets(widgets: DashboardWidget[], id: string, targetId: string, origin: DashboardRect, metrics: DashboardGridMetrics): DashboardWidget[] {
  const current = widgets.find(widget => widget.id === id)!, other = widgets.find(widget => widget.id === targetId)!;
  const a = cloneWidget(current), b = cloneWidget(other), oldA = origin, oldB = other;
  const ac = center(visibleRect(oldA, metrics)), bc = center(visibleRect(oldB, metrics));
  if (swapOrientation(oldA, oldB, metrics) === 'horizontal') {
    const baseY = Math.min(oldA.y, oldB.y), left = Math.min(oldA.x, oldB.x);
    a.y = baseY; b.y = baseY;
    if (bc.x < ac.x) {
      a.x = Math.min(left, DASHBOARD_COLUMNS - a.w); b.x = a.x + a.w;
      if (b.x + b.w > DASHBOARD_COLUMNS) { b.x = Math.min(oldA.x, DASHBOARD_COLUMNS - b.w); b.y = a.y + a.h; }
    } else {
      b.x = Math.min(left, DASHBOARD_COLUMNS - b.w); a.x = b.x + b.w;
      if (a.x + a.w > DASHBOARD_COLUMNS) { a.x = Math.min(oldB.x, DASHBOARD_COLUMNS - a.w); a.y = b.y + b.h; }
    }
  } else if (bc.y < ac.y) {
    a.x = Math.min(oldB.x, DASHBOARD_COLUMNS - a.w); a.y = oldB.y;
    b.x = Math.min(oldA.x, DASHBOARD_COLUMNS - b.w); b.y = oldA.y;
    if (a.x < b.x + b.w && a.x + a.w > b.x) b.y = Math.max(oldA.y + a.h - b.h, a.y + a.h);
  } else {
    b.x = Math.min(oldA.x, DASHBOARD_COLUMNS - b.w); b.y = oldA.y;
    a.x = Math.min(oldB.x, DASHBOARD_COLUMNS - a.w); a.y = oldB.y;
    if (a.x < b.x + b.w && a.x + a.w > b.x) a.y = Math.max(oldB.y + b.h - a.h, b.y + b.h);
  }
  return settleSwap(widgets.map(widget => widget.id === id ? a : widget.id === targetId ? b : widget), [id, targetId]);
}

/** Match the reference canvas: empty space moves freely, edges block, and crossing a card's center swaps slots. */
export function dragWidget(widgets: DashboardWidget[], id: string, desired: DashboardRect, point: DashboardPoint, anchor?: DashboardRect, metrics: DashboardGridMetrics = unitGrid, locked = false): {
  widgets: DashboardWidget[]; blocked: boolean; swapped: string | null; target: DashboardWidget | null; probe: DashboardRect;
} {
  const active = widgets.find(widget => widget.id === id), probe = normalizeDashboardRect(desired);
  if (!active) return { widgets, blocked: false, swapped: null, target: null, probe };
  const origin = anchor ?? active, hover = hoverWidget(widgets, id, point, origin, metrics);
  if (hover.ready && !locked) return {
    widgets: swapWidgets(widgets, id, hover.target!.id, origin, metrics), blocked: false,
    swapped: hover.target!.id, target: hover.target, probe,
  };
  if (widgets.some(widget => widget.id !== id && overlaps(probe, widget))) {
    return { widgets, blocked: true, swapped: null, target: hover.target, probe };
  }
  return { widgets: widgets.map(widget => widget.id === id ? { ...widget, ...probe } : widget), blocked: false, swapped: null, target: hover.target, probe };
}

const datasetDefaults: Record<DashboardDatasetId, { title: string; metric: string; dimension: string; columns: string[]; sortBy: string }> = {
  summary: { title: '처리 요청 수', metric: 'requestCount', dimension: '', columns: ['requestCount', 'blockRate', 'errorRate'], sortBy: '' },
  requestTrend: { title: '시간대별 요청 추이', metric: 'requests', dimension: 'bucketLabel', columns: ['bucket', 'requests', 'block', 'error'], sortBy: 'bucket' },
  requestStatus: { title: '요청 판정 비중', metric: 'count', dimension: 'label', columns: ['label', 'count'], sortBy: 'count' },
  workflowRequests: { title: '워크플로우별 요청', metric: 'requests', dimension: 'workflowName', columns: ['workflowName', 'requests', 'block', 'error'], sortBy: 'requests' },
  evaluations: { title: '검증 결과', metric: 'matchRate', dimension: 'workflowName', columns: ['workflowName', 'datasetName', 'status', 'matchRate', 'createdAt'], sortBy: 'createdAt' },
  deployments: { title: '현재 배포 현황', metric: 'version', dimension: 'workflowName', columns: ['workflowName', 'alias', 'version', 'createdAt'], sortBy: 'createdAt' },
};

function newWidgetId(existing: Iterable<string> = []): string {
  const used = new Set(existing);
  let id: string;
  do {
    id = `widget-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
  } while (used.has(id));
  return id;
}

export function createDashboardWidget(type: DashboardWidgetType, dataset?: DashboardDatasetId, id?: string): DashboardWidget {
  const selected = dataset ?? ({ kpi: 'summary', line: 'requestTrend', bar: 'workflowRequests', donut: 'requestStatus', table: 'evaluations' } as const)[type];
  const defaults = datasetDefaults[selected];
  return {
    id: id ?? newWidgetId(), type, dataset: selected, title: defaults.title,
    metric: defaults.metric, dimension: defaults.dimension, columns: [...defaults.columns], color: 'teal',
    x: 0, y: 0, w: type === 'kpi' ? 3 : type === 'table' ? 6 : 6, h: type === 'kpi' ? 2 : type === 'table' ? 5 : 4,
    sortBy: defaults.sortBy, sortDirection: selected === 'requestTrend' ? 'asc' : 'desc', rowLimit: selected === 'requestTrend' ? 100 : 10,
  };
}

export function defaultDashboardLayout(): DashboardLayout {
  const kpis = [
    ['requests', '처리 요청 수', 'requestCount'], ['blocked', '차단률', 'blockRate'],
    ['errors', '실행 오류율', 'errorRate'], ['matches', '검증 기대 결과 일치율', 'matchRate'],
  ].map(([id, title, metric], index) => ({ ...createDashboardWidget('kpi', 'summary', `default-${id}`), title, metric, x: index * 3 }));
  return { version: 1, widgets: [
    ...kpis,
    { ...createDashboardWidget('kpi', 'summary', 'default-deployment-count'), title: '현재 배포 수', metric: 'deploymentCount', x: 0, y: 2 },
    { ...createDashboardWidget('line', 'requestTrend', 'default-trend'), x: 3, y: 2, w: 9 },
    { ...createDashboardWidget('donut', 'requestStatus', 'default-status'), x: 0, y: 4, w: 3 },
    { ...createDashboardWidget('bar', 'workflowRequests', 'default-workflows'), x: 3, y: 6, w: 9 },
    { ...createDashboardWidget('table', 'evaluations', 'default-evaluations'), x: 0, y: 10, w: 7 },
    { ...createDashboardWidget('table', 'deployments', 'default-deployments'), x: 7, y: 10, w: 5 },
  ] };
}

export function addDashboardWidget(layout: DashboardLayout, widget: DashboardWidget): DashboardLayout {
  if (layout.widgets.length >= MAX_DASHBOARD_WIDGETS) return layout;
  const ids = layout.widgets.map(item => item.id);
  const created = { ...cloneWidget(widget), id: ids.includes(widget.id) ? newWidgetId(ids) : widget.id };
  return { version: 1, widgets: normalizeDashboardWidgets([...layout.widgets, created]) };
}

export function duplicateDashboardWidget(layout: DashboardLayout, id: string, newId?: string): DashboardLayout {
  const original = layout.widgets.find(widget => widget.id === id);
  if (!original || layout.widgets.length >= MAX_DASHBOARD_WIDGETS) return layout;
  const ids = layout.widgets.map(widget => widget.id);
  return addDashboardWidget(layout, {
    ...cloneWidget(original), id: newId && !ids.includes(newId) ? newId : newWidgetId(ids),
    title: `${original.title} 복사`.slice(0, 80), y: original.y + original.h,
  });
}

export function removeDashboardWidget(layout: DashboardLayout, id: string): DashboardLayout {
  return { version: 1, widgets: layout.widgets.filter(widget => widget.id !== id).map(cloneWidget) };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validWidget(value: unknown): value is DashboardWidget {
  if (!record(value)) return false;
  return typeof value.id === 'string' && safeId.test(value.id)
    && typeof value.title === 'string' && value.title.length <= 80
    && widgetTypes.includes(value.type as DashboardWidgetType) && datasets.includes(value.dataset as DashboardDatasetId)
    && colors.includes(value.color as DashboardColor)
    && ['metric', 'dimension', 'sortBy'].every(key => typeof value[key] === 'string' && (value[key] === '' || safeKey.test(value[key] as string)))
    && Array.isArray(value.columns) && value.columns.length <= 20 && value.columns.every(column => typeof column === 'string' && safeKey.test(column))
    && new Set(value.columns).size === value.columns.length
    && (value.sortDirection === 'asc' || value.sortDirection === 'desc')
    && (value.interaction === undefined || record(value.interaction)
      && (value.interaction.targetPage === undefined
        ? typeof value.interaction.targetTabId === 'string' && safeId.test(value.interaction.targetTabId)
        : typeof value.interaction.targetPage === 'string' && ['logs','evaluation','gateway'].includes(value.interaction.targetPage))
      && (value.interaction.mode === 'link' || value.interaction.mode === 'drilldown'))
    && typeof value.rowLimit === 'number' && Number.isInteger(value.rowLimit) && value.rowLimit >= 1 && value.rowLimit <= 100
    && ['x', 'y', 'w', 'h'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

export function parseDashboardLayout(raw: string | null): { layout: DashboardLayout; error?: string } {
  if (raw === null) return { layout: defaultDashboardLayout() };
  try {
    if (raw.length > 200_000) throw new Error('size');
    const data: unknown = JSON.parse(raw);
    if (!record(data) || data.version !== 1 || !Array.isArray(data.widgets) || data.widgets.length > MAX_DASHBOARD_WIDGETS
      || !data.widgets.every(validWidget) || new Set(data.widgets.map(widget => widget.id)).size !== data.widgets.length) throw new Error('format');
    // Copy only declared properties. Persisted browser data is not trusted application state.
    const widgets: DashboardWidget[] = data.widgets.map(widget => ({
      id: widget.id, title: widget.title, type: widget.type, dataset: widget.dataset, metric: widget.metric,
      dimension: widget.dimension, columns: [...widget.columns], color: widget.color,
      x: widget.x, y: widget.y, w: widget.w, h: widget.h,
      sortBy: widget.sortBy, sortDirection: widget.sortDirection, rowLimit: widget.rowLimit,
      ...(widget.interaction ? { interaction: { targetTabId: widget.interaction.targetTabId, mode: widget.interaction.mode, ...(widget.interaction.targetPage?{targetPage:widget.interaction.targetPage}:{}) } } : {}),
    }));
    return { layout: { version: 1, widgets: normalizeDashboardWidgets(widgets) } };
  } catch {
    return { layout: defaultDashboardLayout(), error: '저장된 대시보드 설정을 읽을 수 없어 기본 화면을 표시합니다. 원래 설정은 덮어쓰지 않았습니다.' };
  }
}

export function readDashboardLayout(storage: Pick<Storage, 'getItem'>): { layout: DashboardLayout; error?: string } {
  try {
    return parseDashboardLayout(storage.getItem(DASHBOARD_STORAGE_KEY));
  } catch {
    return { layout: defaultDashboardLayout(), error: '브라우저 저장소를 읽을 수 없어 기본 대시보드를 표시합니다.' };
  }
}

export function saveDashboardLayout(storage: Pick<Storage, 'setItem'>, layout: DashboardLayout): { ok: boolean; error?: string } {
  try {
    const parsed = parseDashboardLayout(JSON.stringify(layout));
    if (parsed.error) return { ok: false, error: '대시보드 설정 형식이 올바르지 않아 저장하지 않았습니다.' };
    storage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(parsed.layout));
    return { ok: true };
  } catch {
    return { ok: false, error: '대시보드를 저장하지 못했습니다. 브라우저 저장 공간과 권한을 확인하세요.' };
  }
}
