export type DashboardSource = 'gateway' | 'evaluation' | 'playground' | 'all';
export type DashboardRequestStatus = '' | 'allow' | 'block' | 'error';
export type DashboardFilters = {
  period: '24h' | '7d' | '30d' | 'custom';
  workflowId: string; source: DashboardSource; status: DashboardRequestStatus;
  customFrom: string; customTo: string;
};
export type DashboardInteraction = { targetTabId: string; targetPage?: 'logs'|'evaluation'|'gateway'; mode: 'link' | 'drilldown' };
export type DashboardDatasetId = 'summary' | 'requestTrend' | 'requestStatus' | 'workflowRequests' | 'evaluations' | 'deployments';
export type DashboardColumn = { key: string; label: string; type: 'string' | 'number' | 'datetime'; unit?: 'count' | 'percent' | 'ms' | 'tokens' };
export type DashboardRow = Record<string, string | number | null>;
export type DashboardDataset = { label: string; columns: DashboardColumn[]; rows: DashboardRow[]; totalRows: number; truncated: boolean; description: string };
export type DashboardResponse = {
  generatedAt: string;
  filters: { from: string; to: string; workflowId: string | null; source: DashboardSource; status?: DashboardRequestStatus | null; timezone: 'Asia/Seoul' };
  coverage: {
    logDays: number; logLimit: number; storedLogCount: number; matchedLogCount: number;
    oldestLogAt: string | null; newestLogAt: string | null; capacityReached: boolean;
    missingUsageCount: number; notes: string[];
  };
  datasets: Record<DashboardDatasetId, DashboardDataset>;
};

export type DashboardWidgetType = 'kpi' | 'line' | 'bar' | 'donut' | 'table';
export type DashboardColor = 'teal' | 'blue' | 'violet' | 'amber';
export type DashboardWidget = {
  id: string; title: string; type: DashboardWidgetType; dataset: DashboardDatasetId;
  metric: string; dimension: string; columns: string[]; color: DashboardColor;
  x: number; y: number; w: number; h: number;
  sortBy: string; sortDirection: 'asc' | 'desc'; rowLimit: number;
  interaction?: DashboardInteraction;
};
export type DashboardLayout = { version: 1; widgets: DashboardWidget[] };
export type DashboardTab = { id: string; name: string; layout: DashboardLayout; filters: DashboardFilters };
export type DashboardWorkspace = { version: 2; activeTabId: string; tabs: DashboardTab[] };
