import type { AppState, EvalRun, ExecutionResult } from './aegis-types';

export type EvaluationTab = 'single' | 'batch' | 'compare';
export type EvaluationResultFilter = 'all' | 'mismatch' | 'false_positive' | 'false_negative' | 'allow' | 'block' | 'error';

/** Kept by the console for the current visit only. Request text never enters browser storage. */
export type EvaluationNavigationContext = {
  tab: EvaluationTab;
  workflowId: string;
  datasetId: string;
  target: 'draft' | 'deployed';
  deploymentId?: string;
  input: string;
  lastInput: string;
  result?: ExecutionResult;
  singleFingerprint: string;
  runId: string;
  localRun?: EvalRun;
  rowId: string;
  resultFilter: EvaluationResultFilter;
  categoryFilter: string;
  changedOnly: boolean;
  showSnapshot: boolean;
  scrollTop: number;
};

type NavigationDefaults = { workflowId?: string; datasetId?: string; tab?: EvaluationTab; input?: string };

const runTime = (run: EvalRun) => Date.parse(run.updatedAt || run.createdAt) || 0;

/** A release review resumes the exact run, including an explicitly selected historical deployment. */
export function evaluationContextForRun(run: EvalRun): EvaluationNavigationContext {
  return { tab:'batch', workflowId:run.workflowId, datasetId:run.datasetId, target:run.target??(run.deploymentId?'deployed':'draft'),
    ...(run.deploymentId?{deploymentId:run.deploymentId}:{}), input:'', lastInput:'', singleFingerprint:'', runId:run.id,
    localRun:run, rowId:'', resultFilter:'all', categoryFilter:'all', changedOnly:false, showSnapshot:false, scrollTop:0 };
}

/** Prefer the response already displayed by this screen when the parent state is still catching up. */
export function navigationRun(runs: EvalRun[], runId: string, localRun?: EvalRun): EvalRun | undefined {
  const stored = runs.find(run => run.id === runId);
  if (!localRun || localRun.id !== runId) return stored;
  if (!stored || runTime(localRun) > runTime(stored) || (runTime(localRun) === runTime(stored) && localRun.results.length > stored.results.length)) return localRun;
  return stored;
}

export function restoreEvaluationNavigation(
  context: EvaluationNavigationContext | undefined,
  state: Pick<AppState, 'workflows' | 'datasets' | 'deployments' | 'runs'>,
  defaults: NavigationDefaults = {},
): { context: EvaluationNavigationContext; missingRun: boolean; missingRow: boolean } {
  const preferredWorkflow = context?.workflowId ?? defaults.workflowId;
  const preferredDataset = context?.datasetId ?? defaults.datasetId;
  const workflowId = state.workflows.some(workflow => workflow.id === preferredWorkflow) ? preferredWorkflow! : state.workflows[0]?.id || '';
  const datasetId = state.datasets.some(dataset => dataset.id === preferredDataset) ? preferredDataset! : state.datasets[0]?.id || '';
  // A historical run remains available through its own snapshots after its live sources are deleted.
  const runId = context ? context.runId : state.runs.find(run => run.workflowId === workflowId && run.datasetId === datasetId)?.id || '';
  const run = navigationRun(state.runs, runId, context?.localRun);
  const rowId = context?.rowId && run?.results.some(row => row.rowId === context.rowId) ? context.rowId : '';
  const sameWorkflow = !context || context.workflowId === workflowId;
  const target = context?.deploymentId || context?.target === 'deployed' && state.deployments.some(deployment => deployment.workflowId === workflowId) ? 'deployed' : 'draft';
  const sameExecution = sameWorkflow && (!context || context.target === target);
  return {
    context: {
      tab: context?.tab || defaults.tab || 'single',
      workflowId,
      datasetId,
      target,
      ...(context?.deploymentId?{deploymentId:context.deploymentId}:{}),
      input: context?.input ?? defaults.input ?? '',
      lastInput: sameExecution ? context?.lastInput || '' : '',
      result: sameExecution ? context?.result : undefined,
      singleFingerprint: sameExecution ? context?.singleFingerprint || '' : '',
      runId: run?.id || '',
      localRun: context?.localRun,
      rowId,
      resultFilter: context?.resultFilter || 'all',
      categoryFilter: context?.categoryFilter || 'all',
      changedOnly: context?.changedOnly === true,
      showSnapshot: context?.showSnapshot === true,
      scrollTop: Number.isFinite(context?.scrollTop) ? Math.max(0, Math.min(10_000_000, context!.scrollTop)) : 0,
    },
    missingRun: Boolean(runId && !run),
    missingRow: Boolean(context?.rowId && !rowId),
  };
}
