// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { randomUuid } from './client-id.ts';
import type { CanvasZone, Workflow } from './aegis-types';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { getPolicyCanvasNodes, getWorkflowCanvasLinks } from './workflow-policy-canvas.ts';

export type CanvasPosition = { x: number; y: number };
export type CanvasPositions = Record<string, CanvasPosition>;
export type WorkflowSelection = { kind: 'input' | 'output' | 'main' | 'policy' } | { kind: 'group' | 'rule' | 'control' | 'zone' | 'policy-node'; id: string };
export type CanvasNode = { key: string; id: string; kind: 'input' | 'output' | 'main' | 'group' | 'rule' | 'control' | 'policy' | 'policy-node'; stage?: 'pre' | 'post'; groupId?: string; index?: number; controlKind?: 'condition' | 'fork' | 'join'; policyKind?:'branch'|'rule'|'action' };
export type CanvasGroupFrame = { key: string; id: string; stage: 'pre' | 'post'; index: number; x: number; y: number; width: number; height: number };
export type CanvasZoneFrame = CanvasZone & { key: string };
export const NODE_WIDTH = 144;
export const NODE_HEIGHT = 112;
export const NODE_ICON_SIZE = 56;
export const NODE_ICON_CENTER_Y = 34;
export const CANVAS_LIMIT = 40000;
export const GROUP_PADDING = 32;
export const GROUP_HEADER_HEIGHT = 48;
export const GROUP_PARALLEL_TOP = 16;
export const GROUP_FOOTER_HEIGHT = 40;
export const GROUP_ROW_GAP = 40;
export const ZONE_HEADER_HEIGHT = 48;
export const ZONE_PADDING = 24;
export const ZONE_MIN_WIDTH = 240;
export const ZONE_MIN_HEIGHT = 160;
export const ZONE_SIZE_LIMIT = 50000;
const FLOW_GAP = 64;
type LayoutControl = { id: string; kind: 'condition' | 'fork' | 'join' };
type LayoutEdge = { from: string; to: string };
type LayoutGraph = { nodes?: LayoutControl[]; edges?: LayoutEdge[] };
function stageGraph(workflow: Workflow, stage: 'pre' | 'post'): LayoutGraph | undefined {
  // Keep layout independent from the execution graph module. Invalid or
  // incomplete drafts still need a usable canvas while they are being edited.
  return (workflow as Workflow & { graph?: { pre?: LayoutGraph; post?: LayoutGraph } }).graph?.[stage];
}
function controls(workflow: Workflow, stage: 'pre' | 'post'): LayoutControl[] {
  const candidates = stageGraph(workflow, stage)?.nodes;
  if (!Array.isArray(candidates)) return [];
  const ids = new Set<string>();
  return candidates.filter(node => {
    if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id) || !['condition', 'fork', 'join'].includes(node.kind)) return false;
    ids.add(node.id); return true;
  }).slice(0, 12);
}
export function nodePort(position: CanvasPosition, side: 'left' | 'right'): CanvasPosition {
  return { x: position.x + NODE_WIDTH / 2 + (side === 'left' ? -1 : 1) * NODE_ICON_SIZE / 2, y: position.y + NODE_ICON_CENTER_Y };
}
export function groupPort(frame: CanvasGroupFrame, side: 'left' | 'right'): CanvasPosition {
  // The icon axis is slightly above the whole region's center because names
  // sit beneath the icons. Keep the external line centered on the actual flow.
  return { x: side === 'left' ? frame.x : frame.x + frame.width, y: frame.y + frame.height / 2 + (GROUP_HEADER_HEIGHT + GROUP_PARALLEL_TOP - GROUP_FOOTER_HEIGHT - NODE_HEIGHT) / 2 + NODE_ICON_CENTER_Y };
}
export function nodeDefinitions(workflow: Workflow): CanvasNode[] {
  return [{ key: 'input', id: 'input', kind: 'input' }, { key: 'main', id: 'main', kind: 'main' }, { key: 'output', id: 'output', kind: 'output' }, ...(['pre', 'post'] as const).flatMap(stage => [...workflow[stage].map((group, index) => group.rules.length === 1
    ? { key: `rule:${group.rules[0].id}`, id: group.rules[0].id, kind: 'rule' as const, stage, groupId: group.id, index }
    : { key: `group:${group.id}`, id: group.id, kind: 'group' as const, stage, groupId: group.id, index }),
    ...controls(workflow, stage).map((control, index) => ({ key: `control:${control.id}`, id: control.id, kind: 'control' as const, controlKind: control.kind, stage, index }))]),...getPolicyCanvasNodes(workflow)];
}
export function knownLayoutKeys(workflow: Workflow): string[] {
  return [...new Set(['input', 'main', 'output', ...(['pre', 'post'] as const).flatMap(stage => [...workflow[stage].flatMap(group => [`group:${group.id}`, ...group.rules.map(rule => `rule:${rule.id}`)]), ...controls(workflow, stage).map(control => `control:${control.id}`)]),...getPolicyCanvasNodes(workflow).map(node=>node.key)])];
}
/** Resolve a persisted or execution key to its single visible functional card. */
export function visibleLayoutKey(workflow: Workflow, key: string): string | undefined {
  if (['input', 'main', 'output'].includes(key)) return key;
  if (getPolicyCanvasNodes(workflow).some(node=>node.key===key)) return key;
  for (const stage of ['pre', 'post'] as const) {
    for (const group of workflow[stage]) if (key === `group:${group.id}` || group.rules.some(rule => key === `rule:${rule.id}`)) return group.rules.length === 1 ? `rule:${group.rules[0].id}` : `group:${group.id}`;
    if (controls(workflow, stage).some(control => key === `control:${control.id}`)) return key;
  }
  return undefined;
}
export function executionEndpointKey(workflow: Workflow, stage: 'pre' | 'post', endpoint: string): string | undefined {
  if (endpoint === 'start' || endpoint === 'end') return endpoint;
  const group = workflow[stage].find(item => endpoint === `group:${item.id}`);
  if (group) return group.rules.length === 1 ? `rule:${group.rules[0].id}` : endpoint;
  return controls(workflow, stage).some(control => endpoint === `control:${control.id}`) ? endpoint : undefined;
}
export function clampPosition(position: CanvasPosition): CanvasPosition {
  return { x: Math.max(0, Math.min(CANVAS_LIMIT, Math.round(position.x))), y: Math.max(0, Math.min(CANVAS_LIMIT, Math.round(position.y))) };
}
type StagePlacement = { key: string; rank: number; axis: number; before: number; after: number; width: number };
function stagePlacements(workflow: Workflow, stage: 'pre' | 'post'): StagePlacement[] {
  const items: StagePlacement[] = workflow[stage].map((group, index) => ({ key: `group:${group.id}`, rank: index, axis: 0, before: NODE_ICON_CENTER_Y, after: NODE_HEIGHT - NODE_ICON_CENTER_Y, width: NODE_WIDTH }));
  const graph = stageGraph(workflow, stage);
  if (!graph) return items;
  items.push(...controls(workflow, stage).map(control => ({ key: `control:${control.id}`, rank: 0, axis: 0, before: NODE_ICON_CENTER_Y, after: NODE_HEIGHT - NODE_ICON_CENTER_Y, width: NODE_WIDTH })));
  const keys = ['start', ...items.map(item => item.key), 'end'];
  const known = new Set(keys);
  const incoming = new Map(keys.map(key => [key, [] as string[]]));
  const outgoing = new Map(keys.map(key => [key, [] as string[]]));
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  for (const edge of edges) if (edge && known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to) {
    if (outgoing.get(edge.from)!.includes(edge.to)) continue;
    outgoing.get(edge.from)!.push(edge.to); incoming.get(edge.to)!.push(edge.from);
  }
  const indegrees = new Map(keys.map(key => [key, incoming.get(key)!.length]));
  const ranks = new Map(keys.map(key => [key, 0]));
  const queue = keys.filter(key => !indegrees.get(key));
  const ordered: string[] = [];
  while (queue.length) {
    const key = queue.shift()!; ordered.push(key);
    for (const next of outgoing.get(key)!) {
      ranks.set(next, Math.max(ranks.get(next)!, ranks.get(key)! + 1));
      indegrees.set(next, indegrees.get(next)! - 1);
      if (!indegrees.get(next)) queue.push(next);
    }
  }
  // Cycles and disconnected controls are editable drafts. Give unresolved
  // vertices bounded fallback columns instead of failing or recursing forever.
  let fallbackRank = Math.max(0, ...ranks.values()) + 1;
  for (const key of keys) if (!ordered.includes(key)) ranks.set(key, fallbackRank++);
  for (const item of items) item.rank = ranks.get(item.key) || 0;
  const axes = new Map<string, number>([['start', 0], ['end', 0]]);
  for (const rank of [...new Set(items.map(item => item.rank))].sort((a, b) => a - b)) {
    const layer = items.filter(item => item.rank === rank).map((item, index) => {
      const parents = incoming.get(item.key)!.filter(key => axes.has(key));
      const desired = parents.length ? parents.reduce((sum, key) => sum + axes.get(key)!, 0) / parents.length : 0;
      return { item, index, desired };
    }).sort((a, b) => a.desired - b.desired || a.index - b.index);
    let previous: StagePlacement | undefined;
    for (const entry of layer) {
      entry.item.axis = Math.max(entry.desired, previous ? previous.axis + previous.after + FLOW_GAP + entry.item.before : -Infinity);
      previous = entry.item;
    }
    const shift = layer.reduce((sum, entry) => sum + entry.desired - entry.item.axis, 0) / Math.max(1, layer.length);
    for (const entry of layer) { entry.item.axis += shift; axes.set(entry.item.key, entry.item.axis); }
  }
  return items;
}
export type AutoLayoutOptions = { width?: number; height?: number };
type LayoutColumn = { items: StagePlacement[] };
type FoldedPlan = { rows: LayoutColumn[][]; width: number; height: number; zoneCuts: number };
type FoldContext = { zoneSpans:{start:number;end:number}[]; crossings:number[] };
const COMPACT_COLUMN_GAP = 48;
const COMPACT_ROW_GAP = 96;

function policyColumns(workflow:Workflow):LayoutColumn[]{
  const nodes=getPolicyCanvasNodes(workflow);if(!nodes.length)return [];
  const keys=nodes.map(node=>node.key),known=new Set(keys);
  const incoming=new Map(keys.map(key=>[key,[] as string[]])),outgoing=new Map(keys.map(key=>[key,[] as string[]]));
  for(const edge of getWorkflowCanvasLinks(workflow))if(known.has(edge.from)&&known.has(edge.to)&&!outgoing.get(edge.from)!.includes(edge.to)){
    outgoing.get(edge.from)!.push(edge.to);incoming.get(edge.to)!.push(edge.from);
  }
  const ranks=new Map(keys.map(key=>[key,key==='policy'?0:1])),degrees=new Map(keys.map(key=>[key,incoming.get(key)!.length]));
  const pending=keys.filter(key=>degrees.get(key)===0),ordered:string[]=[];
  while(pending.length){const key=pending.shift()!;ordered.push(key);for(const next of outgoing.get(key)!){ranks.set(next,Math.max(ranks.get(next)!,ranks.get(key)!+1));degrees.set(next,degrees.get(next)!-1);if(!degrees.get(next))pending.push(next);}}
  let fallback=Math.max(...ranks.values())+1;
  for(const key of keys)if(!ordered.includes(key))ranks.set(key,fallback++);
  return [...new Set(ranks.values())].sort((a,b)=>a-b).map(rank=>{
    const layer=nodes.filter(node=>ranks.get(node.key)===rank);
    return {items:layer.map((node,index)=>({key:node.key,rank,axis:(index-(layer.length-1)/2)*(NODE_HEIGHT+FLOW_GAP),before:NODE_ICON_CENTER_Y,after:NODE_HEIGHT-NODE_ICON_CENTER_Y,width:NODE_WIDTH}))};
  });
}

/** Keep a whole rank together: parallel checks are never scattered across rows. */
function layoutColumns(workflow: Workflow): LayoutColumn[] {
  const terminal = (key: string): LayoutColumn => ({ items: [{ key, rank: 0, axis: 0, before: NODE_ICON_CENTER_Y, after: NODE_HEIGHT - NODE_ICON_CENTER_Y, width: NODE_WIDTH }] });
  const stage = (name: 'pre' | 'post') => {
    const plan = stagePlacements(workflow, name);
    return [...new Set(plan.map(item => item.rank))].sort((a,b) => a-b).map(rank => ({ items: plan.filter(item => item.rank === rank) }));
  };
  return [terminal('input'), ...stage('pre'), ...policyColumns(workflow), terminal('main'), ...stage('post'), terminal('output')];
}
function columnExtents(columns: LayoutColumn[]) {
  const items = columns.flatMap(column => column.items);
  return { top: Math.min(0, ...items.map(item => item.axis-item.before)), bottom: Math.max(0, ...items.map(item => item.axis+item.after)) };
}
function foldContext(workflow: Workflow, columns: LayoutColumn[]): FoldContext {
  const aliases=new Map<string,string>([['input','input'],['main','main'],['output','output']]);
  for(const stage of ['pre','post'] as const){for(const group of workflow[stage]){const key=group.rules.length===1?`rule:${group.rules[0].id}`:`group:${group.id}`;aliases.set(`group:${group.id}`,key);for(const rule of group.rules)aliases.set(`rule:${rule.id}`,key);}for(const control of controls(workflow,stage))aliases.set(`control:${control.id}`,`control:${control.id}`);}
  const indices = new Map(columns.flatMap((column,index) => column.items.map(item => [aliases.get(item.key) ?? item.key,index] as const)));
  const zoneSpans = (workflow.layout?.zones ?? []).flatMap(zone => {
    const members = zone.nodeKeys.map(key => indices.get(aliases.get(key) ?? key)).filter((index):index is number => index !== undefined);
    return members.length ? [{start:Math.min(...members),end:Math.max(...members)}] : [];
  });
  const crossings = new Array<number>(columns.length).fill(0);
  for (const edge of getWorkflowCanvasLinks(workflow)) {
      const from = indices.get(edge.from), to = indices.get(edge.to);
      if (from === undefined || to === undefined || from >= to) continue;
      for (let cut = from+1; cut <= to; cut++) crossings[cut]++;
  }
  return {zoneSpans,crossings};
}
function foldPlan(columns:LayoutColumn[],capacity:number,{zoneSpans,crossings}:FoldContext):FoldedPlan {
  const rows:LayoutColumn[][] = [];
  let zoneCuts = 0;
  for (let start = 0; start < columns.length;) {
    let end = Math.min(columns.length,start+capacity);
    if (end < columns.length) {
      // Prefer a nearby serial boundary over cutting through a parallel block
      // or visual area. This is a display preference, never an execution rule.
      let best = Infinity;const limit=end;let preferredEnd=end;
      for (let candidate = Math.max(start+3,limit-2); candidate <= limit; candidate++) {
        const zones = zoneSpans.filter(zone => zone.start < candidate && zone.end >= candidate).length;
        const cost = zones*8 + Math.max(0,crossings[candidate]-1)*2 + (limit-candidate)*.6;
        if (cost < best) { best = cost; preferredEnd = candidate; }
      }
      end=preferredEnd;
      zoneCuts += zoneSpans.filter(zone => zone.start < end && zone.end >= end).length;
    }
    rows.push(columns.slice(start,end)); start=end;
  }
  const width = 48 + Math.max(...rows.map(row => row.length*NODE_WIDTH+Math.max(0,row.length-1)*COMPACT_COLUMN_GAP)) + 104;
  const height = 48 + rows.reduce((sum,row) => {const extent=columnExtents(row);return sum+extent.bottom-extent.top;},0) + Math.max(0,rows.length-1)*COMPACT_ROW_GAP + 200;
  return {rows,width,height,zoneCuts};
}
/** Compact rows read left to right, then continue on the next row. The graph
 * remains unchanged and edge arrows still represent the actual direction. */
export function autoLayout(workflow: Workflow, options: AutoLayoutOptions = {}): CanvasPositions {
  const columns = layoutColumns(workflow);
  const context=foldContext(workflow,columns);
  let plan = foldPlan(columns,columns.length,context);
  if (columns.length > 7) {
    const width = Number.isFinite(options.width) && options.width! > 0 ? Math.max(320,options.width!) : 1000;
    const height = Number.isFinite(options.height) && options.height! > 0 ? Math.max(240,options.height!) : 640;
    let best = -Infinity;
    for (let capacity = 3; capacity <= columns.length; capacity++) {
      const candidate = foldPlan(columns,capacity,context);
      const scale = Math.min(width/candidate.width,height/candidate.height);
      const score = scale/(1+candidate.zoneCuts*.035);
      if (score > best + .000001 || Math.abs(score-best) < .000001 && candidate.rows.length < plan.rows.length) {best=score;plan=candidate;}
    }
  }
  const positions:CanvasPositions = {};
  const groups = new Map([...workflow.pre,...workflow.post].map(group => [`group:${group.id}`,group]));
  let top = 48;
  for (const row of plan.rows) {
    const extent = columnExtents(row);
    for (let column = 0; column < row.length; column++) for (const item of row[column].items) {
      const position = {x:48+column*(NODE_WIDTH+COMPACT_COLUMN_GAP),y:top+item.axis-item.before-extent.top};
      positions[item.key] = {...position};
      const group = groups.get(item.key);
      // Hidden legacy children remain serializable aliases of one visible card.
      if (group) for (const rule of group.rules) positions[`rule:${rule.id}`] = {...position};
    }
    top += extent.bottom-extent.top+COMPACT_ROW_GAP;
  }
  return preservePinnedLayout(workflow, positions);
}

/** Frames follow their members. Group positions are retained as legacy metadata
 * and as an empty-group fallback, never as an invisible drag constraint. */
export function groupFrames(workflow: Workflow, positions: CanvasPositions): CanvasGroupFrame[] {
  return (['pre', 'post'] as const).flatMap(stage => workflow[stage].map((group, index) => {
    const members = group.rules.map(rule => positions[`rule:${rule.id}`]).filter((position): position is CanvasPosition => Boolean(position));
    const anchor = positions[`group:${group.id}`] || { x: 48, y: 156 };
    const x = members.length ? Math.min(...members.map(position => position.x)) - GROUP_PADDING : anchor.x;
    const y = members.length ? Math.min(...members.map(position => position.y)) - GROUP_HEADER_HEIGHT - GROUP_PARALLEL_TOP : anchor.y;
    const right = members.length ? Math.max(...members.map(position => position.x + NODE_WIDTH)) + GROUP_PADDING : x + NODE_WIDTH + GROUP_PADDING * 2;
    const bottom = members.length ? Math.max(...members.map(position => position.y + NODE_HEIGHT)) + GROUP_FOOTER_HEIGHT : y + GROUP_HEADER_HEIGHT + GROUP_PARALLEL_TOP + GROUP_FOOTER_HEIGHT;
    return { key: `group:${group.id}`, id: group.id, stage, index, x, y, width: right - x, height: bottom - y };
  }));
}
type Rect = CanvasPosition & { width: number; height: number };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width + 16 && a.x + a.width + 16 > b.x && a.y < b.y + b.height + 16 && a.y + a.height + 16 > b.y;
/** Pins refer to visible cards even when an older saved key names a hidden rule. */
export function normalizedPinnedKeys(workflow: Workflow): string[] {
  return [...new Set((workflow.layout?.pinnedKeys ?? []).map(key => visibleLayoutKey(workflow, key)).filter((key): key is string => Boolean(key)))];
}
function preservePinnedLayout(workflow: Workflow, defaults: CanvasPositions): CanvasPositions {
  const saved = workflow.layout?.positions;
  const pins = normalizedPinnedKeys(workflow);
  if (!saved || !pins.length) return defaults;
  const nodes = nodeDefinitions(workflow), positions: CanvasPositions = {};
  const valid = (point: CanvasPosition | undefined): point is CanvasPosition => Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= CANVAS_LIMIT && point.y >= 0 && point.y <= CANVAS_LIMIT);
  for (const key of pins) {
    const aliases = [key, ...(workflow.layout?.pinnedKeys ?? []).filter(alias => visibleLayoutKey(workflow, alias) === key), ...knownLayoutKeys(workflow).filter(alias => visibleLayoutKey(workflow, alias) === key)];
    const at = aliases.map(alias => saved[alias]).find(valid);
    if (at) positions[key] = { ...at };
  }
  if (!Object.keys(positions).length) return defaults;
  const obstacles: Rect[] = Object.values(positions).map(point => ({ ...point, width: NODE_WIDTH, height: NODE_HEIGHT }));
  for (const node of nodes) {
    if (positions[node.key]) continue;
    const origin = defaults[node.key];
    let candidate = { ...origin };
    // A collision always advances below one obstacle. If that reaches the
    // canvas boundary, use the next column. At most 124 visible cards exist.
    // Pinned cards can retain an intentional user overlap; automatic placement
    // never introduces an overlap with those cards or other unpinned cards.
    for (let attempts = 0; attempts < 4000; attempts++) {
      const hit = obstacles.find(rect => overlaps({ ...candidate, width: NODE_WIDTH, height: NODE_HEIGHT }, rect));
      if (!hit) break;
      candidate.y = hit.y + NODE_HEIGHT + 16;
      if (candidate.y > CANVAS_LIMIT) {
        candidate.y = 48;
        candidate.x += NODE_WIDTH + 16;
        if (candidate.x > CANVAS_LIMIT) candidate.x = 48;
      }
    }
    positions[node.key] = candidate;
    obstacles.push({ ...candidate, width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  const result = { ...defaults, ...positions };
  // Keep hidden keys synchronized so later changes between a single rule and
  // a rule combination inherit the pinned functional card's real position.
  for (const stage of ['pre', 'post'] as const) for (const group of workflow[stage]) {
    const key = visibleLayoutKey(workflow, `group:${group.id}`)!;
    result[`group:${group.id}`] = { ...result[key] };
    for (const rule of group.rules) result[`rule:${rule.id}`] = { ...result[key] };
  }
  return result;
}
export function resolveLayout(workflow: Workflow): CanvasPositions {
  const nodes = nodeDefinitions(workflow);
  const defaults = autoLayout(workflow);
  if (!workflow.layout || !Object.keys(workflow.layout.positions).length) return defaults;
  const positions: CanvasPositions = {};
  for (const key of knownLayoutKeys(workflow)) {
    const saved = workflow.layout.positions[key];
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) positions[key] = { x: Math.max(0, Math.min(CANVAS_LIMIT, saved.x)), y: Math.max(0, Math.min(CANVAS_LIMIT, saved.y)) };
  }
  for (const node of nodes) {
    if (positions[node.key]) continue;
    let candidate = { ...defaults[node.key] };
    if (node.groupId && node.stage) {
      const group = workflow[node.stage].find(item => item.id === node.groupId)!;
      const anchor = positions[`group:${group.id}`];
      const children = group.rules.map(rule => positions[`rule:${rule.id}`]).filter(Boolean);
      if (anchor) candidate = { ...anchor };
      else if (children.length) candidate = { x: children.reduce((sum, child) => sum + child.x, 0) / children.length, y: children.reduce((sum, child) => sum + child.y, 0) / children.length };
    } else if (node.kind === 'input' || node.kind === 'output') {
      const stageNodes = nodes.filter(item => item.stage === (node.kind === 'input' ? 'pre' : 'post'));
      const target = node.kind === 'input' ? stageNodes[0] : stageNodes.at(-1);
      const neighbor = target ? positions[target.key] || defaults[target.key] : positions.main || defaults.main;
      candidate = { x: node.kind === 'input' ? neighbor.x - NODE_WIDTH - FLOW_GAP : neighbor.x + NODE_WIDTH + FLOW_GAP, y: neighbor.y };
      if (candidate.x < 0) candidate = { x: Math.max(0, neighbor.x), y: neighbor.y >= NODE_HEIGHT + FLOW_GAP ? neighbor.y - NODE_HEIGHT - FLOW_GAP : neighbor.y + NODE_HEIGHT + FLOW_GAP };
    }
    const cards: Rect[] = nodes.filter(item => item.key !== node.key && positions[item.key]).map(item => ({ ...positions[item.key], width: NODE_WIDTH, height: NODE_HEIGHT }));
    // Hidden legacy rule positions and visual zones are not physical obstacles.
    for (let attempts = 0; attempts < 4000; attempts++) {
      if (candidate.y > CANVAS_LIMIT) { candidate.y = 48; candidate.x += NODE_WIDTH + 64; }
      if (candidate.x > CANVAS_LIMIT) candidate = { x: 48, y: 48 };
      candidate.x = Math.max(0, candidate.x); candidate.y = Math.max(0, candidate.y);
      const hit = cards.find(rect => overlaps({ ...candidate, width: NODE_WIDTH, height: NODE_HEIGHT }, rect));
      if (!hit) break;
      candidate.y = hit.y + hit.height + 16;
    }
    positions[node.key] = { x: Math.max(0, Math.min(CANVAS_LIMIT, candidate.x)), y: Math.max(0, Math.min(CANVAS_LIMIT, candidate.y)) };
  }
  for (const stage of ['pre', 'post'] as const) for (const group of workflow[stage]) {
    const key = visibleLayoutKey(workflow, `group:${group.id}`)!;
    const visible = positions[key];
    if (!positions[`group:${group.id}`]) positions[`group:${group.id}`] = { ...visible };
    for (const rule of group.rules) if (!positions[`rule:${rule.id}`]) positions[`rule:${rule.id}`] = { ...visible };
  }
  return positions;
}
export function zoneFrames(workflow: Workflow, positions: CanvasPositions): CanvasZoneFrame[] {
  return (workflow.layout?.zones || []).map(zone => {
    const nodeKeys = [...new Set(zone.nodeKeys.map(key => visibleLayoutKey(workflow, key)).filter((key): key is string => Boolean(key)))];
    const members = nodeKeys.map(key => positions[key]).filter(Boolean);
    if (!members.length) return { ...zone, key: `zone:${zone.id}`, nodeKeys };
    const x = Math.min(zone.x, ...members.map(member => member.x - ZONE_PADDING));
    const y = Math.min(zone.y, ...members.map(member => member.y - ZONE_HEADER_HEIGHT - ZONE_PADDING));
    const right = Math.max(zone.x + zone.width, ...members.map(member => member.x + NODE_WIDTH + ZONE_PADDING));
    const bottom = Math.max(zone.y + zone.height, ...members.map(member => member.y + NODE_HEIGHT + ZONE_PADDING));
    return { ...zone, key: `zone:${zone.id}`, nodeKeys, x, y, width: right - x, height: bottom - y };
  });
}
export function layoutBounds(nodes: CanvasNode[], positions: CanvasPositions, frames: Rect[] = []) {
  // Fixed offsets keep a header and padding visible when a saved child sits at
  // x/y zero. They must not change during drag or the viewport would jump.
  const offsetX = GROUP_PADDING + 8;
  const offsetY = Math.max(GROUP_HEADER_HEIGHT + GROUP_PARALLEL_TOP, ZONE_HEADER_HEIGHT + ZONE_PADDING) + 8;
  return { offsetX, offsetY, width: Math.max(896, ...nodes.map(node => (positions[node.key]?.x ?? 0) + NODE_WIDTH + offsetX + 64), ...frames.map(frame => frame.x + frame.width + offsetX + 64)), height: Math.max(480, ...nodes.map(node => (positions[node.key]?.y ?? 0) + NODE_HEIGHT + offsetY + 120), ...frames.map(frame => frame.y + frame.height + offsetY + 120)) };
}
export function moveNodes(positions: CanvasPositions, keys: string[], delta: CanvasPosition): CanvasPositions {
  const selected = keys.filter(key => positions[key]);
  if (!selected.length) return positions;
  const dx = Math.max(-Math.min(...selected.map(key => positions[key].x)), Math.min(delta.x, CANVAS_LIMIT - Math.max(...selected.map(key => positions[key].x))));
  const dy = Math.max(-Math.min(...selected.map(key => positions[key].y)), Math.min(delta.y, CANVAS_LIMIT - Math.max(...selected.map(key => positions[key].y))));
  return Object.fromEntries(Object.entries(positions).map(([key, position]) => [key, selected.includes(key) ? clampPosition({ x: position.x + dx, y: position.y + dy }) : position]));
}
export function moveZoneLayout(positions: CanvasPositions, zones: CanvasZone[], zoneId: string, delta: CanvasPosition): { positions: CanvasPositions; zones: CanvasZone[] } {
  const zone = zones.find(item => item.id === zoneId);
  if (!zone) return { positions, zones };
  const keys = [...new Set(zone.nodeKeys)].filter(key => positions[key]);
  const origins = [{ x: zone.x, y: zone.y }, ...keys.map(key => positions[key])];
  const dx = Math.max(-Math.min(...origins.map(position => position.x)), Math.min(Number.isFinite(delta.x) ? delta.x : 0, CANVAS_LIMIT - Math.max(...origins.map(position => position.x))));
  const dy = Math.max(-Math.min(...origins.map(position => position.y)), Math.min(Number.isFinite(delta.y) ? delta.y : 0, CANVAS_LIMIT - Math.max(...origins.map(position => position.y))));
  const members = new Set(keys);
  return {
    positions: Object.fromEntries(Object.entries(positions).map(([key, position]) => [key, members.has(key) ? { x: position.x + dx, y: position.y + dy } : position])),
    zones: zones.map(item => item.id === zoneId ? { ...item, x: item.x + dx, y: item.y + dy } : item),
  };
}
export function moveZone(workflow: Workflow, zoneId: string, delta: CanvasPosition): Workflow {
  const next = structuredClone(workflow);
  const zones = (next.layout?.zones || []).map(zone => ({ ...zone, nodeKeys: [...new Set(zone.nodeKeys.map(key => visibleLayoutKey(next, key)).filter((key): key is string => Boolean(key)))] }));
  const moved = moveZoneLayout(resolveLayout(next), zones, zoneId, delta);
  next.layout = { version: 1, positions: moved.positions, zones: moved.zones };
  return next;
}
export function createZoneForNodes(workflow: Workflow, keys: string[], options: Partial<Pick<CanvasZone, 'id' | 'name' | 'color'>> = {}): CanvasZone {
  const nodeKeys = [...new Set(keys.map(key => visibleLayoutKey(workflow, key)).filter((key): key is string => Boolean(key)))];
  const positions = resolveLayout(workflow);
  const members = nodeKeys.map(key => positions[key]).filter(Boolean);
  let x = members.length ? Math.max(0, Math.min(...members.map(member => member.x)) - ZONE_PADDING) : 64;
  let y = members.length ? Math.max(0, Math.min(...members.map(member => member.y)) - ZONE_HEADER_HEIGHT - ZONE_PADDING) : 64;
  const width = members.length ? Math.max(ZONE_MIN_WIDTH, Math.max(...members.map(member => member.x + NODE_WIDTH)) + ZONE_PADDING - x) : 360;
  const height = members.length ? Math.max(ZONE_MIN_HEIGHT, Math.max(...members.map(member => member.y + NODE_HEIGHT)) + ZONE_PADDING - y) : 240;
  if (!members.length) {
    const occupied: Rect[] = [...nodeDefinitions(workflow).map(node => ({ ...positions[node.key], width: NODE_WIDTH, height: NODE_HEIGHT })), ...zoneFrames(workflow, positions)];
    y = Math.max(64, ...occupied.map(rect => rect.y + rect.height + FLOW_GAP));
    for (let attempt = 0; attempt < 2000; attempt++) {
      if (y > CANVAS_LIMIT) { y = 64; x += width + FLOW_GAP; }
      if (x > CANVAS_LIMIT) { x = 64; y = 64; break; }
      const hit = occupied.find(rect => overlaps({ x, y, width, height }, rect));
      if (!hit) break;
      y = hit.y + hit.height + FLOW_GAP;
    }
  }
  return { id: options.id || `zone-${randomUuid().slice(0, 8)}`, name: options.name?.trim() || '새 그룹', color: options.color || 'slate', nodeKeys, x, y, width: Math.min(ZONE_SIZE_LIMIT, width), height: Math.min(ZONE_SIZE_LIMIT, height) };
}
