import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node strip-types requires the source extension.
import { createDashboardWidget, DASHBOARD_STORAGE_KEY } from '../lib/dashboard-layout.ts';
// @ts-expect-error Node strip-types requires the source extension.
import { addDashboardTab, DASHBOARD_WORKSPACE_STORAGE_KEY, defaultDashboardFilters, defaultDashboardWorkspace, MAX_DASHBOARD_TABS, parseDashboardWorkspace, readDashboardWorkspace, removeDashboardTab, renameDashboardTab, resolveDashboardDrilldown, saveDashboardWorkspace } from '../lib/dashboard-workspace.ts';
import type { DashboardFilters, DashboardWorkspace } from '../lib/dashboard-types';

function linkedWorkspace(): DashboardWorkspace {
  const workspace = addDashboardTab(defaultDashboardWorkspace(), '차단 상세', 'blocked');
  workspace.tabs[0].layout.widgets[0].interaction = { targetTabId: 'blocked', mode: 'drilldown' };
  workspace.tabs[1].layout.widgets = [{ ...createDashboardWidget('table', 'workflowRequests', 'detail'), interaction: { targetTabId: 'dashboard-overview', mode: 'link' } }];
  return workspace;
}

test('fresh workspaces have one named operational tab and independent mutable settings', () => {
  const workspace = defaultDashboardWorkspace();
  assert.equal(workspace.version, 2);
  assert.equal(workspace.activeTabId, workspace.tabs[0].id);
  assert.equal(workspace.tabs[0].name, '운영 현황');
  assert.equal(workspace.tabs[0].layout.widgets.length, 10);
  assert.deepEqual(workspace.tabs[0].filters, defaultDashboardFilters());
  workspace.tabs[0].layout.widgets[0].columns.push('status');
  workspace.tabs[0].filters.status = 'block';
  assert.equal(defaultDashboardWorkspace().tabs[0].layout.widgets[0].columns.includes('status'), false);
  assert.equal(defaultDashboardWorkspace().tabs[0].filters.status, '');
  assert.deepEqual(parseDashboardWorkspace(null).workspace, defaultDashboardWorkspace());
});

test('a saved legacy layout migrates into the first tab without writing either storage key', () => {
  const layout = { version: 1 as const, widgets: [createDashboardWidget('table', 'evaluations', 'kept-card')] };
  const values = new Map([[DASHBOARD_STORAGE_KEY, JSON.stringify(layout)]]);
  const accesses: string[] = [];
  const result = readDashboardWorkspace({ getItem(key) { accesses.push(key); return values.get(key) ?? null; } });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.workspace.tabs[0].layout, layout);
  assert.deepEqual(accesses, [DASHBOARD_WORKSPACE_STORAGE_KEY, DASHBOARD_STORAGE_KEY]);
  assert.equal(values.size, 1);
  assert.equal(values.get(DASHBOARD_STORAGE_KEY), JSON.stringify(layout));
});

test('the new workspace takes precedence over legacy data even if legacy data is corrupt', () => {
  const workspace = linkedWorkspace();
  const result = readDashboardWorkspace({ getItem(key) { return key === DASHBOARD_WORKSPACE_STORAGE_KEY ? JSON.stringify(workspace) : '{broken'; } });
  assert.deepEqual(result, { workspace });
  const corrupt = readDashboardWorkspace({ getItem(key) { return key === DASHBOARD_WORKSPACE_STORAGE_KEY ? '{broken' : JSON.stringify(workspace.tabs[0].layout); } });
  assert.ok(corrupt.error);
  assert.deepEqual(corrupt.workspace, defaultDashboardWorkspace());
});

test('legacy corruption and denied storage reads report fallback without claiming recovery', () => {
  assert.ok(readDashboardWorkspace({ getItem(key) { return key === DASHBOARD_STORAGE_KEY ? '[]' : null; } }).error);
  const denied = readDashboardWorkspace({ getItem() { throw new Error('denied'); } });
  assert.ok(denied.error);
  assert.deepEqual(denied.workspace, defaultDashboardWorkspace());
});

test('workspace round trips preserve per-tab layouts, filters and declared link settings only', () => {
  const workspace = linkedWorkspace();
  workspace.tabs[1].filters = { ...defaultDashboardFilters(), source: 'all', period: 'custom', workflowId: 'workflow-a', status: 'block', customFrom: '2026-10-01', customTo: '2026-10-26' };
  const untrusted = JSON.parse(JSON.stringify(workspace));
  untrusted.secret = 'discard'; untrusted.tabs[0].filters.prompt = 'discard';
  untrusted.tabs[0].layout.widgets[0].interaction.query = 'discard';
  const parsed = parseDashboardWorkspace(JSON.stringify(untrusted));
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.workspace, workspace);
  let writtenKey = '', writtenValue = '';
  assert.deepEqual(saveDashboardWorkspace({ setItem(key, value) { writtenKey = key; writtenValue = value; } }, workspace), { ok: true });
  assert.equal(writtenKey, DASHBOARD_WORKSPACE_STORAGE_KEY);
  assert.deepEqual(JSON.parse(writtenValue), workspace);
});

test('workspace parsing rejects malformed tabs and filters as a whole', () => {
  const workspace = linkedWorkspace();
  const first = workspace.tabs[0];
  const invalid: unknown[] = [
    null, [], {}, { ...workspace, version: 1 }, { ...workspace, activeTabId: 'missing' },
    { ...workspace, tabs: [] }, { ...workspace, tabs: [first, first] },
    { ...workspace, tabs: Array.from({ length: MAX_DASHBOARD_TABS + 1 }, (_, i) => ({ ...first, id: `tab-${i}` })) },
    ...[{ id: '<script>' }, { name: ' ' }, { name: 'x'.repeat(41) }, { layout: null }, { layout: { version: 1, widgets: [null] } },
      ...[{ period: 'forever' }, { workflowId: 'bad\nvalue' }, { workflowId: 123 }, { source: 'external' }, { status: 'passed' },
        { customFrom: '2026-02-30' }, { customTo: '2026-2-1' }, { customTo: null }].map(filter => ({ filters: { ...first.filters, ...filter } })),
    ].map(tab => ({ ...workspace, tabs: [{ ...first, ...tab }, workspace.tabs[1]] })),
  ];
  for (const value of invalid) {
    const result = parseDashboardWorkspace(JSON.stringify(value));
    assert.ok(result.error, JSON.stringify(value));
    assert.deepEqual(result.workspace, defaultDashboardWorkspace());
  }
  assert.ok(parseDashboardWorkspace(' '.repeat(2_500_001)).error);
});

test('malformed interactions cannot smuggle arbitrary navigation targets', () => {
  for (const interaction of [null, { targetTabId: 'https://example.test', mode: 'link' }, { targetTabId: 'blocked', mode: 'javascript' }, { targetTabId: 2, mode: 'link' }]) {
    const workspace = linkedWorkspace();
    (workspace.tabs[0].layout.widgets[0] as unknown as Record<string, unknown>).interaction = interaction;
    assert.ok(parseDashboardWorkspace(JSON.stringify(workspace)).error);
  }
});

test('links to removed or missing tabs are cleaned while valid self links remain valid', () => {
  const workspace = linkedWorkspace();
  workspace.tabs[0].layout.widgets[1].interaction = { targetTabId: 'missing', mode: 'link' };
  workspace.tabs[0].layout.widgets[2].interaction = { targetTabId: workspace.tabs[0].id, mode: 'drilldown' };
  const result = parseDashboardWorkspace(JSON.stringify(workspace));
  assert.equal(result.error, undefined);
  assert.equal(result.workspace.tabs[0].layout.widgets[1].interaction, undefined);
  assert.deepEqual(result.workspace.tabs[0].layout.widgets[2].interaction, { targetTabId: workspace.tabs[0].id, mode: 'drilldown' });
});

test('new tabs are named, empty and active without disturbing previous layouts or filters', () => {
  const before = defaultDashboardWorkspace();
  const snapshot = JSON.stringify(before);
  const after = addDashboardTab(before, '  검증 상세  ', 'evaluation-detail');
  assert.equal(after.activeTabId, 'evaluation-detail');
  assert.deepEqual(after.tabs[1], { id: 'evaluation-detail', name: '검증 상세', layout: { version: 1, widgets: [] }, filters: defaultDashboardFilters() });
  assert.equal(JSON.stringify(before), snapshot);
  assert.deepEqual(after.tabs[0], before.tabs[0]);
  assert.equal(addDashboardTab(after, ''), after);
  assert.equal(addDashboardTab(after, 'x'.repeat(41)), after);
  const colliding = addDashboardTab(after, '중복 이름 허용', 'evaluation-detail');
  assert.notEqual(colliding.activeTabId, 'evaluation-detail');
  assert.equal(new Set(colliding.tabs.map(tab => tab.id)).size, colliding.tabs.length);
});

test('adding tabs enforces the 12-tab bound', () => {
  let workspace = defaultDashboardWorkspace();
  for (let i = 1; i < MAX_DASHBOARD_TABS; i++) workspace = addDashboardTab(workspace, `상세 ${i}`, `detail-${i}`);
  assert.equal(workspace.tabs.length, MAX_DASHBOARD_TABS);
  assert.equal(addDashboardTab(workspace, '초과'), workspace);
});

test('renaming is immutable and rejects invalid names or unknown tabs', () => {
  const workspace = linkedWorkspace();
  const renamed = renameDashboardTab(workspace, 'blocked', ' 차단 현황 ');
  assert.equal(renamed.tabs[1].name, '차단 현황');
  assert.equal(workspace.tabs[1].name, '차단 상세');
  assert.equal(renamed.tabs[1].id, workspace.tabs[1].id);
  for (const name of ['', ' ', 'x'.repeat(41)]) assert.equal(renameDashboardTab(workspace, 'blocked', name), workspace);
  assert.equal(renameDashboardTab(workspace, 'missing', '이름'), workspace);
  assert.equal(renameDashboardTab(workspace, 'blocked', '차단 상세'), workspace);
});

test('deleting a tab cleans incoming links and chooses a neighboring active tab', () => {
  const workspace = addDashboardTab(linkedWorkspace(), '검증', 'verification');
  const snapshot = JSON.stringify(workspace);
  const removed = removeDashboardTab({ ...workspace, activeTabId: 'blocked' }, 'blocked');
  assert.equal(removed.activeTabId, 'verification');
  assert.deepEqual(removed.tabs.map(tab => tab.id), ['dashboard-overview', 'verification']);
  assert.equal(removed.tabs[0].layout.widgets[0].interaction, undefined);
  assert.equal(JSON.stringify(workspace), snapshot);
  const nonactive = removeDashboardTab(workspace, 'blocked');
  assert.equal(nonactive.activeTabId, 'verification');
  const last = removeDashboardTab(nonactive, 'verification');
  assert.equal(last.activeTabId, 'dashboard-overview');
  assert.equal(removeDashboardTab(last, 'dashboard-overview'), last);
  assert.equal(removeDashboardTab(workspace, 'missing'), workspace);
});

test('quota and validation failures leave storage untouched and report failure', () => {
  let writes = 0;
  const invalid = { ...defaultDashboardWorkspace(), activeTabId: 'missing' };
  assert.equal(saveDashboardWorkspace({ setItem() { writes++; } }, invalid).ok, false);
  assert.equal(writes, 0);
  const denied = saveDashboardWorkspace({ setItem() { throw new Error('quota'); } }, defaultDashboardWorkspace());
  assert.equal(denied.ok, false);
  assert.ok(denied.error);
});

test('drilldown carries time and source filters and applies only known row metadata', () => {
  const filters: DashboardFilters = { ...defaultDashboardFilters(), source: 'all', period: 'custom', customFrom: '2026-10-01', customTo: '2026-10-26' };
  for (const dataset of ['workflowRequests', 'evaluations', 'deployments'] as const) {
    const widget = createDashboardWidget('table', dataset);
    const result = resolveDashboardDrilldown(filters, widget, { workflowId: 'workflow-a', workflowName: '비공개 이름', prompt: '원문', answer: '차단 응답' });
    assert.deepEqual(result, { ...filters, workflowId: 'workflow-a' });
    assert.notEqual(result, filters);
    assert.equal('answer' in result, false);
  }
  assert.equal(filters.workflowId, '');
  const widget = createDashboardWidget('table', 'evaluations');
  assert.deepEqual(resolveDashboardDrilldown(filters, widget, { workflowId: 'bad\nvalue' }), filters);
  assert.deepEqual(resolveDashboardDrilldown(filters, widget, { workflowId: null, workflowName: 'workflow-guess' }), filters);
});

test('status chart and request table values select request statuses without confusing evaluation statuses', () => {
  const filters = defaultDashboardFilters();
  const status = createDashboardWidget('donut', 'requestStatus');
  assert.deepEqual(resolveDashboardDrilldown(filters, status, { status: 'block', label: '차단', count: 4 }), { ...filters, status: 'block' });
  assert.deepEqual(resolveDashboardDrilldown(filters, status, { status: 'completed', count: 4 }), filters);
  const request = createDashboardWidget('table', 'workflowRequests');
  assert.deepEqual(resolveDashboardDrilldown(filters, request, { workflowId: 'workflow-b', block: 4 }, 'block'), { ...filters, workflowId: 'workflow-b', status: 'block' });
  assert.deepEqual(resolveDashboardDrilldown(filters, request, { workflowId: 'workflow-b', blockRate: 25 }, 'blockRate'), { ...filters, workflowId: 'workflow-b', status: 'block' });
  assert.deepEqual(resolveDashboardDrilldown(filters, { ...request, type: 'bar', metric: 'blockRate' }, { workflowId: 'workflow-b', blockRate: 25 }), { ...filters, workflowId: 'workflow-b', status: 'block' });
  assert.deepEqual(resolveDashboardDrilldown(filters, request, { workflowId: 'workflow-b', requests: 4 }, 'requests'), { ...filters, workflowId: 'workflow-b' });
  const evaluation = createDashboardWidget('table', 'evaluations');
  assert.deepEqual(resolveDashboardDrilldown(filters, evaluation, { workflowId: 'workflow-c', status: 'error' }, 'status'), { ...filters, workflowId: 'workflow-c' });
});

test('KPI and trend drilldown uses declared request metrics without accepting arbitrary row keys', () => {
  const filters = defaultDashboardFilters();
  for (const [metric, status] of [['blockRate', 'block'], ['blockCount', 'block'], ['errorRate', 'error'], ['errorCount', 'error'], ['allowCount', 'allow']] as const) {
    const widget = { ...createDashboardWidget('kpi', 'summary'), metric };
    assert.deepEqual(resolveDashboardDrilldown(filters, widget, { workflowId: 'wrong', status: 'wrong', [metric]: 5 }), { ...filters, status });
  }
  const trend = createDashboardWidget('line', 'requestTrend');
  assert.deepEqual(resolveDashboardDrilldown(filters, trend, { bucket: '2026-10-26', block: 3 }, 'block'), { ...filters, status: 'block' });
  assert.deepEqual(resolveDashboardDrilldown(filters, trend, { from: 'malicious', to: 'malicious', source: 'malicious' }, 'requests'), filters);
});
