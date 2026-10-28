import type { Workflow } from './aegis-types';

export type WorkflowHistory = { past: Workflow[]; future: Workflow[]; batchKey?: string };
export const emptyWorkflowHistory = (): WorkflowHistory => ({ past: [], future: [] });

/** A field stays one action until focus leaves it or another action is made. */
export function rememberWorkflowChange(history: WorkflowHistory, before: Workflow, batchKey?: string): WorkflowHistory {
  const merging = Boolean(batchKey && history.batchKey === batchKey && history.future.length === 0);
  return { past: merging ? history.past : [...history.past, structuredClone(before)].slice(-30), future: [], ...(batchKey ? { batchKey } : {}) };
}

export function restoreWorkflowHistory(history: WorkflowHistory, current: Workflow, direction: 'undo' | 'redo'): { history: WorkflowHistory; workflow?: Workflow } {
  const next = direction === 'undo' ? history.past.at(-1) : history.future[0];
  if (!next) return { history: { past: history.past, future: history.future } };
  return direction === 'undo'
    ? { history: { past: history.past.slice(0, -1), future: [structuredClone(current), ...history.future].slice(0, 30) }, workflow: structuredClone(next) }
    : { history: { past: [...history.past, structuredClone(current)].slice(-30), future: history.future.slice(1) }, workflow: structuredClone(next) };
}
