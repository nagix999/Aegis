import type { EvalResult, EvalRun, Workflow } from './aegis-types';

/** Compare only pairs that actually completed on both sides. */
export function evaluationChanges(results: EvalResult[], baseline: EvalResult[]) {
  const previous = new Map(baseline.map(row => [row.rowId, row]));
  const paired = results.filter(row => previous.has(row.rowId));
  const falseBlock = (row: EvalResult) => row.expected === 'allow' && row.status === 'block';
  const missed = (row: EvalResult) => row.expected === 'block' && row.status === 'allow';
  const retries = (row: EvalResult) => row.regenerationCount ?? Math.max(0, (row.attempts?.length ?? row.traces.filter(trace => trace.stage === 'main' && trace.status !== 'skipped').length) - 1);
  return {
    paired: paired.length,
    newMissed: paired.filter(row => missed(row) && !missed(previous.get(row.rowId)!)).length,
    resolvedFalseBlocks: paired.filter(row => falseBlock(previous.get(row.rowId)!) && row.status === 'allow').length,
    newFalseBlocks: paired.filter(row => falseBlock(row) && !falseBlock(previous.get(row.rowId)!)).length,
    newErrors: paired.filter(row => row.status === 'error' && previous.get(row.rowId)!.status !== 'error').length,
    retryDelta: paired.reduce((sum, row) => sum + retries(row) - retries(previous.get(row.rowId)!), 0),
    latencyDelta: paired.length ? Math.round(paired.reduce((sum, row) => sum + row.latencyMs - previous.get(row.rowId)!.latencyMs, 0) / paired.length) : 0,
  };
}

/** Coverage is observed outgoing graph edges, never inferred from layout or skipped nodes. */
export function evaluationPathCoverage(workflow: Workflow | undefined, results: EvalResult[]) {
  if (!workflow?.graph) return undefined;
  const all = new Set<string>();
  const branches = new Map<string, string>();
  for (const stage of ['pre', 'post'] as const) {
    const graph = workflow.graph[stage];
    for (const edge of graph.edges) {
      const key = `${stage}:${edge.id}`;
      all.add(key);
      const condition = graph.nodes.find(node => node.kind === 'condition' && `control:${node.id}` === edge.from);
      if (condition && (edge.port === 'true' || edge.port === 'false')) branches.set(key, `${stage === 'pre' ? '요청' : '응답'} / ${condition.name} / ${edge.port === 'true' ? '참' : '거짓'}`);
    }
  }
  const covered = new Set<string>();
  const attempts = new Set<number>();
  let tracedRows = 0;
  for (const row of results) {
    if (row.flowTraces?.length) tracedRows++;
    for (const trace of row.flowTraces ?? []) {
      if (trace.status === 'skipped') continue;
      if (trace.stage === 'post') attempts.add(trace.attempt ?? 1);
      for (const edgeId of trace.edgeIds) {
        const key = `${trace.stage}:${edgeId}`;
        if (all.has(key)) covered.add(key);
      }
    }
  }
  return { edges: covered.size, totalEdges: all.size, branches: [...branches.keys()].filter(key => covered.has(key)).length, totalBranches: branches.size, tracedRows, totalRows: results.length, attempts: [...attempts].sort((a, b) => a - b), uncoveredBranches: [...branches].filter(([key]) => !covered.has(key)).map(([, label]) => label) };
}

export function runPathCoverage(run: EvalRun) { return evaluationPathCoverage(run.workflowSnapshot, run.results); }
