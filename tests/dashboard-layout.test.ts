import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node strip-types requires the source extension.
import { addDashboardWidget, createDashboardWidget, dashboardContainsPoint, DASHBOARD_STORAGE_KEY, defaultDashboardLayout, dragWidget, duplicateDashboardWidget, MAX_DASHBOARD_WIDGETS, normalizeDashboardRect, normalizeDashboardWidgets, parseDashboardLayout, placeWidget, readDashboardLayout, removeDashboardWidget, saveDashboardLayout } from '../lib/dashboard-layout.ts';
import type { DashboardLayout, DashboardWidget } from '../lib/dashboard-types';

const widget = (id: string, x: number, y: number, w = 6, h = 4): DashboardWidget => ({ ...createDashboardWidget('table', 'evaluations', id), x, y, w, h });
const overlapping = (a: DashboardWidget, b: DashboardWidget) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('tab links survive layout storage and duplication without sharing mutable interaction settings', () => {
  const card = { ...widget('linked', 0, 0), interaction: { targetTabId: 'detail-tab', mode: 'drilldown' as const } };
  const layout: DashboardLayout = { version: 1, widgets: [card] };
  assert.deepEqual(parseDashboardLayout(JSON.stringify(layout)), { layout });
  const duplicate = duplicateDashboardWidget(layout, card.id, 'copy').widgets[1];
  assert.deepEqual(duplicate.interaction, card.interaction);
  duplicate.interaction!.targetTabId = 'elsewhere';
  assert.equal(card.interaction.targetTabId, 'detail-tab');
  for (const interaction of [null, { targetTabId: 'https://example.test', mode: 'link' }, { targetTabId: 'detail-tab', mode: 'external' }]) {
    assert.ok(parseDashboardLayout(JSON.stringify({ ...layout, widgets: [{ ...card, interaction }] })).error);
  }
});
function assertNoOverlap(widgets: DashboardWidget[]) {
  for (let i = 0; i < widgets.length; i++) for (let j = i + 1; j < widgets.length; j++) assert.equal(overlapping(widgets[i], widgets[j]), false, `${widgets[i].id} overlaps ${widgets[j].id}`);
}

test('default layout includes operational KPIs, charts and two distinct configurable tables', () => {
  const layout = defaultDashboardLayout();
  assertNoOverlap(layout.widgets);
  assert.equal(layout.widgets.filter(item => item.type === 'kpi').length, 5);
  assert.deepEqual(layout.widgets.filter(item => item.type === 'table').map(item => item.dataset), ['evaluations', 'deployments']);
  assert.equal(new Set(layout.widgets.map(item => item.id)).size, layout.widgets.length);
  assert.deepEqual(parseDashboardLayout(JSON.stringify(layout)), { layout });
  const columnsByDataset: Record<string, string[]> = {
    summary: ['requestCount', 'blockRate', 'errorRate', 'matchRate', 'deploymentCount'],
    requestTrend: ['bucket', 'bucketLabel', 'requests', 'allow', 'block', 'error', 'avgLatencyMs'],
    requestStatus: ['label', 'status', 'count'],
    workflowRequests: ['workflowId', 'workflowName', 'requests', 'allow', 'block', 'error', 'blockRate', 'avgLatencyMs', 'regenerationCount', 'totalTokens'],
    evaluations: ['runId', 'workflowName', 'datasetName', 'createdAt', 'status', 'total', 'completed', 'matched', 'matchRate'],
    deployments: ['deploymentId', 'workflowName', 'alias', 'version', 'createdAt', 'engineVersion'],
  };
  for (const card of layout.widgets) {
    const available = columnsByDataset[card.dataset];
    for (const column of [card.metric, card.dimension, card.sortBy, ...card.columns].filter(Boolean)) assert.ok(available.includes(column), `${card.dataset}.${column}`);
  }
});

test('explicit placement prioritizes the changed card and resolves collisions without moving untouched columns', () => {
  const cards = [widget('first', 0, 0), widget('second', 0, 4), widget('other-column', 6, 0)];
  const moved = placeWidget(cards, 'second', { x: 0, y: 0, w: 6, h: 4 });
  assert.equal(moved[1].y, 0);
  assert.equal(moved[0].y, 4);
  assert.deepEqual(moved[2], cards[2]);
  assertNoOverlap(moved);
  assert.equal(cards[0].y, 0);
  assert.equal(cards[1].y, 4);
});

test('pointer dragging through free space changes only the active card and keeps the original immutable', () => {
  const cards = [widget('active', 0, 0), widget('beside', 6, 0), widget('far', 0, 12)];
  const snapshot = JSON.stringify(cards);
  const dragged = dragWidget(cards, 'active', { x: 0, y: 6, w: 6, h: 4 }, { x: 2, y: 8 }, cards[0]);
  assert.equal(dragged.blocked, false); assert.equal(dragged.swapped, null);
  assert.deepEqual(dragged.widgets.map(card => [card.id, card.x, card.y]), [['active', 0, 6], ['beside', 6, 0], ['far', 0, 12]]);
  assert.equal(dragged.widgets[1], cards[1]); assert.equal(dragged.widgets[2], cards[2]);
  assert.equal(JSON.stringify(cards), snapshot);
});

test('touching another card at its edge blocks a drag without pushing any cards', () => {
  const cards = [widget('active', 0, 0), widget('target', 6, 0), widget('below', 6, 4)];
  const blocked = dragWidget(cards, 'active', { x: 3, y: 0, w: 6, h: 4 }, { x: 6.2, y: 2 }, cards[0]);
  assert.equal(blocked.blocked, true); assert.equal(blocked.swapped, null);
  assert.equal(blocked.widgets, cards); assert.equal(blocked.target, cards[1]);
  assert.deepEqual(blocked.probe, { x: 3, y: 0, w: 6, h: 4 });
});

test('the pointer must enter the central region rather than just the dragged rectangle overlapping', () => {
  const cards = [widget('active', 0, 0), widget('target', 6, 0)];
  for (const point of [{ x: 6.5, y: 2 }, { x: 9, y: .5 }, { x: 11.5, y: 2 }]) {
    const result = dragWidget(cards, 'active', { x: 6, y: 0, w: 6, h: 4 }, point, cards[0]);
    assert.equal(result.blocked, true); assert.equal(result.widgets, cards);
  }
  const swapped = dragWidget(cards, 'active', { x: 6, y: 0, w: 6, h: 4 }, { x: 9, y: 2 }, cards[0]);
  assert.equal(swapped.swapped, 'target'); assert.equal(swapped.target, cards[1]);
  assert.deepEqual(swapped.widgets.map(card => [card.x, card.y]), [[6, 0], [0, 0]]);
  assertNoOverlap(swapped.widgets);
});

test('horizontal swaps require crossing the target center toward the drag direction with a six percent tolerance', () => {
  const leftToRight = [widget('active', 0, 0), widget('target', 6, 0)];
  const beforeRight = dragWidget(leftToRight, 'active', leftToRight[1], { x: 8.63, y: 2 }, leftToRight[0]);
  assert.equal(beforeRight.blocked, true);
  assert.equal(dragWidget(leftToRight, 'active', leftToRight[1], { x: 8.65, y: 2 }, leftToRight[0]).swapped, 'target');
  const rightToLeft = [widget('active', 6, 0), widget('target', 0, 0)];
  assert.equal(dragWidget(rightToLeft, 'active', rightToLeft[1], { x: 3.37, y: 2 }, rightToLeft[0]).blocked, true);
  assert.equal(dragWidget(rightToLeft, 'active', rightToLeft[1], { x: 3.35, y: 2 }, rightToLeft[0]).swapped, 'target');
});

test('vertical swaps use the same directional center crossing in both directions', () => {
  const down = [widget('active', 0, 0), widget('target', 0, 4)];
  assert.equal(dragWidget(down, 'active', down[1], { x: 3, y: 5.75 }, down[0]).blocked, true);
  const swapped = dragWidget(down, 'active', down[1], { x: 3, y: 5.77 }, down[0]);
  assert.equal(swapped.swapped, 'target');
  assert.deepEqual(swapped.widgets.map(card => [card.x, card.y]), [[0, 4], [0, 0]]);
  const up = [widget('active', 0, 4), widget('target', 0, 0)];
  assert.equal(dragWidget(up, 'active', up[1], { x: 3, y: 2.25 }, up[0]).blocked, true);
  assert.equal(dragWidget(up, 'active', up[1], { x: 3, y: 2.23 }, up[0]).swapped, 'target');
});

test('visible card hits exclude the trailing grid gap and lock padding is measured in physical pixels', () => {
  const metrics = { columnStride: 100, rowStride: 72, gap: 16 };
  const card = widget('card', 6, 4);
  assert.equal(dashboardContainsPoint(card, { x: 600, y: 288 }, metrics), true);
  assert.equal(dashboardContainsPoint(card, { x: 1184, y: 560 }, metrics), true);
  assert.equal(dashboardContainsPoint(card, { x: 1185, y: 400 }, metrics), false);
  assert.equal(dashboardContainsPoint(card, { x: 800, y: 561 }, metrics), false);
  assert.equal(dashboardContainsPoint(card, { x: 1192, y: 400 }, metrics, 8), true);
  assert.equal(dashboardContainsPoint(card, { x: 1193, y: 400 }, metrics, 8), false);
});

test('swap readiness uses physical distances and visible dimensions on a non-square grid', () => {
  const metrics = { columnStride: 100, rowStride: 72, gap: 16 };
  const cards = [widget('active', 0, 0), widget('target', 6, 0)];
  assert.equal(dragWidget(cards, 'active', cards[1], { x: 856, y: 136 }, cards[0], metrics).blocked, true);
  assert.equal(dragWidget(cards, 'active', cards[1], { x: 858, y: 136 }, cards[0], metrics).swapped, 'target');
  // Their grid centers differ more horizontally, but their pixel centers differ more vertically.
  const tallRows = { columnStride: 30, rowStride: 100, gap: 16 };
  const diagonal = [widget('active', 0, 0), widget('target', 6, 3)];
  const towardRightOnly = dragWidget(diagonal, 'active', diagonal[1], { x: 280, y: 460 }, diagonal[0], tallRows);
  assert.equal(towardRightOnly.blocked, true);
  const towardBottom = dragWidget(diagonal, 'active', diagonal[1], { x: 280, y: 480 }, diagonal[0], tallRows);
  assert.equal(towardBottom.swapped, 'target');
  assert.deepEqual(towardBottom.widgets.map(card => [card.x, card.y]), [[6, 3], [0, 0]]);
});

test('the drag anchor controls swap direction even after the card has already moved', () => {
  const anchor = widget('active', 0, 0);
  const cards = [widget('active', 0, 8), widget('target', 6, 0)];
  const swapped = dragWidget(cards, 'active', cards[1], { x: 8.7, y: 1.5 }, anchor);
  assert.equal(swapped.swapped, 'target');
  assert.deepEqual(swapped.widgets.map(card => [card.x, card.y]), [[6, 0], [0, 0]]);
});

test('unequal horizontal slots keep card sizes and only settle a third card when necessary', () => {
  const cards = [widget('active', 0, 0, 3, 4), widget('target', 3, 0, 6, 2), widget('below-target', 3, 2, 6, 4), widget('untouched', 9, 6, 3, 2)];
  const swapped = dragWidget(cards, 'active', { x: 3, y: 0, w: 3, h: 4 }, { x: 6, y: 1 }, cards[0]);
  assert.equal(swapped.swapped, 'target');
  assert.deepEqual(swapped.widgets.map(card => [card.id, card.x, card.y, card.w, card.h]), [
    ['active', 6, 0, 3, 4], ['target', 0, 0, 6, 2], ['below-target', 3, 4, 6, 4], ['untouched', 9, 6, 3, 2],
  ]);
  assertNoOverlap(swapped.widgets);
  assert.deepEqual(parseDashboardLayout(JSON.stringify({ version: 1, widgets: swapped.widgets })).layout.widgets, swapped.widgets);
});

test('unequal vertical swaps preserve sizes, bounds and non-overlap in either direction', () => {
  const down = [widget('active', 6, 0, 6, 2), widget('target', 0, 2, 9, 5), widget('below', 0, 7, 12, 2)];
  const movedDown = dragWidget(down, 'active', { x: 0, y: 2, w: 6, h: 2 }, { x: 4.5, y: 4.5 }, down[0]);
  assert.equal(movedDown.swapped, 'target');
  assert.deepEqual(movedDown.widgets.map(card => [card.id, card.x, card.y, card.w, card.h]), [
    ['active', 0, 5, 6, 2], ['target', 3, 0, 9, 5], ['below', 0, 7, 12, 2],
  ]);
  const up = [widget('active', 0, 5, 6, 2), widget('target', 3, 0, 9, 5)];
  const movedUp = dragWidget(up, 'active', { x: 3, y: 0, w: 6, h: 2 }, { x: 7.5, y: 2.5 }, up[0]);
  assert.deepEqual(movedUp.widgets.map(card => [card.x, card.y, card.w, card.h]), [[3, 0, 6, 2], [0, 2, 9, 5]]);
  for (const cards of [movedDown.widgets, movedUp.widgets]) {
    assertNoOverlap(cards);
    assert.ok(cards.every(card => card.x >= 0 && card.x + card.w <= 12 && card.y >= 0));
  }
});

test('swap lock prevents immediate swap-back while an edge collision still leaves the layout intact', () => {
  const cards = [widget('active', 0, 0), widget('target', 6, 0)];
  const locked = dragWidget(cards, 'active', cards[1], { x: 9, y: 2 }, cards[0], undefined, true);
  assert.equal(locked.widgets, cards); assert.equal(locked.blocked, true); assert.equal(locked.swapped, null);
  const free = dragWidget(cards, 'active', { x: 0, y: 6, w: 6, h: 4 }, { x: 2, y: 8 }, cards[0], undefined, true);
  assert.equal(free.blocked, false); assert.equal(free.widgets[0].y, 6);
});

test('missing pointer drag targets are immutable no-ops', () => {
  const cards = [widget('active', 0, 0)];
  const result = dragWidget(cards, 'missing', cards[0], { x: 1, y: 1 }, cards[0]);
  assert.equal(result.widgets, cards); assert.equal(result.blocked, false);
  assert.equal(result.target, null); assert.equal(result.swapped, null);
});

test('resizing a card across columns resolves all collisions deterministically', () => {
  const cards = [widget('wide', 0, 0), widget('beside', 6, 0), widget('below', 0, 4)];
  const resized = placeWidget(cards, 'wide', { x: 0, y: 0, w: 12, h: 6 });
  assertNoOverlap(resized);
  assert.equal(resized[0].w, 12);
  assert.equal(resized[1].y, 6);
  assert.equal(resized[2].y, 6);
  assert.deepEqual(placeWidget(cards, 'wide', { x: 0, y: 0, w: 12, h: 6 }), resized);
  assert.deepEqual(normalizeDashboardWidgets(resized), resized);
});

test('geometry clamps widths, heights, negatives, fractions and non-finite pointer calculations', () => {
  assert.deepEqual(normalizeDashboardRect({ x: -5, y: -2, w: 1, h: 99 }), { x: 0, y: 0, w: 3, h: 10 });
  assert.deepEqual(normalizeDashboardRect({ x: 10, y: 2.6, w: 99, h: 0 }), { x: 0, y: 3, w: 12, h: 2 });
  assert.deepEqual(normalizeDashboardRect({ x: Infinity, y: NaN, w: NaN, h: Infinity }), { x: 0, y: 0, w: 4, h: 4 });
});

test('normalization handles chained collisions and dense full-width cards without overlap', () => {
  const cards = Array.from({ length: MAX_DASHBOARD_WIDGETS }, (_, i) => widget(`dense-${i}`, 0, 0, 12, 10));
  const placed = normalizeDashboardWidgets(cards);
  assertNoOverlap(placed);
  assert.equal(placed.at(-1)!.y, 230);
  assert.deepEqual(normalizeDashboardWidgets(placed), placed);
  assert.deepEqual(parseDashboardLayout(JSON.stringify({ version: 1, widgets: placed })).layout.widgets, placed);
});

test('duplication preserves table settings while isolating identity and mutable columns', () => {
  const source = widget('original', 0, 0);
  source.title = '검증 표'; source.columns = ['workflowName', 'matchRate']; source.sortBy = 'matchRate'; source.sortDirection = 'asc'; source.rowLimit = 37;
  const before: DashboardLayout = { version: 1, widgets: [source] };
  const after = duplicateDashboardWidget(before, source.id, 'duplicate');
  const copy = after.widgets[1];
  assert.equal(copy.id, 'duplicate'); assert.equal(copy.title, '검증 표 복사');
  assert.equal(copy.rowLimit, 37); assert.equal(copy.sortBy, 'matchRate'); assert.equal(copy.sortDirection, 'asc');
  copy.columns.push('status');
  assert.deepEqual(source.columns, ['workflowName', 'matchRate']);
  assert.deepEqual(after.widgets[0].columns, ['workflowName', 'matchRate']);
  assert.notEqual(duplicateDashboardWidget(after, source.id, 'duplicate').widgets[2].id, 'duplicate');
  assertNoOverlap(after.widgets);
});

test('adding and duplicating enforce 24 cards; removal preserves the other cards', () => {
  let layout: DashboardLayout = { version: 1, widgets: [] };
  for (let i = 0; i < MAX_DASHBOARD_WIDGETS; i++) layout = addDashboardWidget(layout, widget(`card-${i}`, 0, 0));
  assertNoOverlap(layout.widgets);
  assert.equal(addDashboardWidget(layout, widget('overflow', 0, 0)), layout);
  assert.equal(duplicateDashboardWidget(layout, 'card-0'), layout);
  const removed = removeDashboardWidget(layout, 'card-0');
  assert.equal(removed.widgets.length, MAX_DASHBOARD_WIDGETS - 1);
  assert.equal(layout.widgets.length, MAX_DASHBOARD_WIDGETS);
  assert.deepEqual(removed.widgets[0], layout.widgets[1]);
  assert.equal(addDashboardWidget(removed, widget('card-1', 0, 0)).widgets.filter(item => item.id === 'card-1').length, 1);
});

test('table settings, safe future column names and intentionally empty layouts survive storage roundtrip', () => {
  const table = widget('table', 6, 8);
  table.columns = ['futureColumn_1', 'workflowName']; table.sortBy = 'futureColumn_1'; table.sortDirection = 'asc'; table.rowLimit = 100;
  const layout: DashboardLayout = { version: 1, widgets: [table] };
  let stored: string | null = null;
  assert.deepEqual(saveDashboardLayout({ setItem(key, value) { assert.equal(key, DASHBOARD_STORAGE_KEY); stored = value; } }, layout), { ok: true });
  assert.deepEqual(readDashboardLayout({ getItem(key) { assert.equal(key, DASHBOARD_STORAGE_KEY); return stored; } }), { layout });
  assert.deepEqual(parseDashboardLayout('{"version":1,"widgets":[]}'), { layout: { version: 1, widgets: [] } });
});

test('missing storage uses fresh defaults and corrupt saved data is reported without writing', () => {
  assert.deepEqual(parseDashboardLayout(null), { layout: defaultDashboardLayout() });
  const first = parseDashboardLayout(null).layout;
  first.widgets[0].columns.push('outside');
  assert.equal(parseDashboardLayout(null).layout.widgets[0].columns.includes('outside'), false);
  let reads = 0;
  const result = readDashboardLayout({ getItem() { reads++; return '{invalid'; } });
  assert.equal(reads, 1); assert.ok(result.error); assert.deepEqual(result.layout, defaultDashboardLayout());
});

test('unsupported versions and malformed settings fail closed instead of partially restoring data', () => {
  const valid = widget('card', 0, 0);
  const invalid: unknown[] = [
    { version: 2, widgets: [valid] }, { version: 1, widgets: [valid, valid] },
    { version: 1, widgets: Array.from({ length: 25 }, (_, i) => ({ ...valid, id: `id-${i}` })) },
    ...[
      { type: 'html' }, { dataset: 'externalSql' }, { color: 'red' }, { id: '<script>' }, { title: 'x'.repeat(81) },
      { columns: ['requestCount; DROP TABLE logs'] }, { columns: ['status', 'status'] }, { metric: 'count(*)' },
      { rowLimit: 0 }, { rowLimit: 101 }, { sortDirection: 'random' }, { w: '12' }, { columns: {} },
    ].map(change => ({ version: 1, widgets: [{ ...valid, ...change }] })),
    null, [], {}, { version: 1, widgets: [null] },
  ];
  for (const input of invalid) {
    const parsed = parseDashboardLayout(JSON.stringify(input));
    assert.ok(parsed.error, JSON.stringify(input));
    assert.deepEqual(parsed.layout, defaultDashboardLayout());
  }
  assert.ok(parseDashboardLayout(' '.repeat(200_001)).error);
});

test('saved geometry is normalized and unknown persisted fields are discarded', () => {
  const card = { ...widget('card', -3, -4), w: 30, h: 0, untrusted: '<script>' };
  const parsed = parseDashboardLayout(JSON.stringify({ version: 1, widgets: [card] }));
  assert.equal(parsed.error, undefined);
  assert.deepEqual({ x: parsed.layout.widgets[0].x, y: parsed.layout.widgets[0].y, w: parsed.layout.widgets[0].w, h: parsed.layout.widgets[0].h }, { x: 0, y: 0, w: 12, h: 2 });
  assert.equal('untrusted' in parsed.layout.widgets[0], false);
});

test('storage permission and quota errors return useful errors without claiming success', () => {
  assert.ok(readDashboardLayout({ getItem() { throw new Error('permission denied'); } }).error);
  const quota = saveDashboardLayout({ setItem() { throw new Error('quota exceeded'); } }, defaultDashboardLayout());
  assert.equal(quota.ok, false); assert.ok(quota.error);
  let writes = 0;
  const invalid = { ...defaultDashboardLayout(), version: 9 } as unknown as DashboardLayout;
  assert.equal(saveDashboardLayout({ setItem() { writes++; } }, invalid).ok, false);
  assert.equal(writes, 0);
});
