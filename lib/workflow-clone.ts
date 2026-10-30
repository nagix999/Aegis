import type { Workflow } from './aegis-types';

/** Remap every execution reference together with its saved canvas position. */
export function cloneWorkflowContent(original: Workflow, identifier: (prefix: string) => string): Workflow {
  const clone = structuredClone(original);
  const ruleIds = new Map<string, string>();
  const keys = new Map([['input', 'input'], ['main', 'main'], ['output', 'output'], ['start', 'start'], ['end', 'end']]);
  if (clone.policyRouting) {
    keys.set('policy','policy');
    for (const node of clone.policyRouting.graph?.nodes ?? []) keys.set(`policy-node:${node.id}`,`policy-node:${node.id}`);
  }
  for (const stage of ['pre', 'post'] as const) {
    clone[stage] = clone[stage].map(group => {
      const groupId = identifier('group');
      keys.set(`group:${group.id}`, `group:${groupId}`);
      return { ...group, id: groupId, rules: group.rules.map(rule => {
        const ruleId = identifier('rule');
        ruleIds.set(rule.id, ruleId);
        keys.set(`rule:${rule.id}`, `rule:${ruleId}`);
        return { ...rule, id: ruleId };
      }) };
    });
    if (clone.graph) clone.graph[stage].nodes = clone.graph[stage].nodes.map(node => {
      const nodeId = identifier('control');
      keys.set(`control:${node.id}`, `control:${nodeId}`);
      return { ...node, id: nodeId };
    });
  }
  if (clone.graph) for (const stage of ['pre', 'post'] as const) {
    clone.graph[stage].edges = clone.graph[stage].edges.map(edge => ({
      ...edge, id: identifier('edge'), from: keys.get(edge.from) ?? edge.from, to: keys.get(edge.to) ?? edge.to,
    }));
  }
  if (original.layout) clone.layout = { version: 1, ...(original.layout.zones ? {zones:original.layout.zones.map(zone=>({...zone,id:identifier('zone'),nodeKeys:zone.nodeKeys.flatMap(key=>keys.has(key)?[keys.get(key)!]:[])}))}:{}), positions: Object.fromEntries(
    Object.entries(original.layout.positions).flatMap(([key, position]) => {
      const mapped = keys.get(key); return mapped ? [[mapped, { ...position }]] : [];
    }),
  ) };
  clone.cloneSource = { workflowId: original.id, ruleIds: Object.fromEntries(ruleIds) };
  return clone;
}
