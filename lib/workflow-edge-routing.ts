/** Geometry only: routing never changes workflow endpoints, ports, or saved positions. */
export type WorkflowEdgePoint = { x: number; y: number };
export type WorkflowEdgeSide = 'left' | 'right' | 'top' | 'bottom';
export type WorkflowEdgeObstacle = WorkflowEdgePoint & { key: string; width: number; height: number };
export type WorkflowEdgeRoute = { d: string; sx: number; sy: number; tx: number; ty: number; points: WorkflowEdgePoint[] };
export type WorkflowEdgeRoutingOptions = {
  start: WorkflowEdgePoint; end: WorkflowEdgePoint;
  sourceKey: string; targetKey: string; obstacles: WorkflowEdgeObstacle[];
  sourceSide?: WorkflowEdgeSide; targetSide?: WorkflowEdgeSide;
  parallelIndex?: number; parallelCount?: number;
  preferredSide?: 'above' | 'below'; minY?: number; forceOutside?: boolean;
};

const CLEARANCE = 8;
const STUB = 16;
const LANE_GAP = 40;
const EPSILON = .001;
const same = (a: WorkflowEdgePoint, b: WorkflowEdgePoint) => Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;
const length = (a: WorkflowEdgePoint, b: WorkflowEdgePoint) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const normal: Record<WorkflowEdgeSide, WorkflowEdgePoint> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };
function stub(point: WorkflowEdgePoint, side: WorkflowEdgeSide, obstacle?: WorkflowEdgeObstacle): WorkflowEdgePoint {
  if (!obstacle) return { x: point.x + normal[side].x * STUB, y: point.y + normal[side].y * STUB };
  return side === 'left' ? { x: Math.min(point.x - STUB, obstacle.x - STUB), y: point.y }
    : side === 'right' ? { x: Math.max(point.x + STUB, obstacle.x + obstacle.width + STUB), y: point.y }
      : side === 'top' ? { x: point.x, y: Math.min(point.y - STUB, obstacle.y - STUB) }
        : { x: point.x, y: Math.max(point.y + STUB, obstacle.y + obstacle.height + STUB) };
}
function segmentClear(a: WorkflowEdgePoint, b: WorkflowEdgePoint, obstacles: WorkflowEdgeObstacle[], ignore?: string): boolean {
  if (a.x !== b.x && a.y !== b.y) return false;
  return obstacles.every(rect => rect.key === ignore || (a.x === b.x
    ? a.x <= rect.x - CLEARANCE || a.x >= rect.x + rect.width + CLEARANCE || Math.max(a.y, b.y) <= rect.y - CLEARANCE || Math.min(a.y, b.y) >= rect.y + rect.height + CLEARANCE
    : a.y <= rect.y - CLEARANCE || a.y >= rect.y + rect.height + CLEARANCE || Math.max(a.x, b.x) <= rect.x - CLEARANCE || Math.min(a.x, b.x) >= rect.x + rect.width + CLEARANCE));
}
/** Drop zero-length/collinear steps, but reject an immediate 180 degree reversal. */
function compact(points: WorkflowEdgePoint[]): WorkflowEdgePoint[] | undefined {
  const result: WorkflowEdgePoint[] = [];
  for (const point of points) {
    if (result.length && same(result[result.length - 1], point)) continue;
    while (result.length > 1) {
      const a = result[result.length - 2], b = result[result.length - 1];
      if ((a.x === b.x && b.x === point.x) || (a.y === b.y && b.y === point.y)) {
        if ((b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y) < 0) return;
        result.pop();
      } else break;
    }
    result.push(point);
  }
  return result;
}
function crossesItself(points: WorkflowEdgePoint[]): boolean {
  for (let i = 1; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
    const a = points[i - 1], b = points[i], c = points[j - 1], d = points[j];
    const vertical = a.x === b.x, otherVertical = c.x === d.x;
    if (vertical === otherVertical) {
      if (vertical && a.x === c.x && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y))) return true;
      if (!vertical && a.y === c.y && Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x))) return true;
    } else {
      const v1 = vertical ? a : c, v2 = vertical ? b : d, h1 = vertical ? c : a, h2 = vertical ? d : b;
      if (v1.x >= Math.min(h1.x, h2.x) && v1.x <= Math.max(h1.x, h2.x) && h1.y >= Math.min(v1.y, v2.y) && h1.y <= Math.max(v1.y, v2.y)) return true;
    }
  }
  return false;
}
function roundedPath(points: WorkflowEdgePoint[]): string {
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1], point = points[index], next = points[index + 1];
    const before = length(previous, point), after = length(point, next), radius = Math.min(8, before / 2, after / 2);
    const enter = { x: point.x + (previous.x - point.x) * radius / before, y: point.y + (previous.y - point.y) * radius / before };
    const exit = { x: point.x + (next.x - point.x) * radius / after, y: point.y + (next.y - point.y) * radius / after };
    d += ` L ${enter.x} ${enter.y} Q ${point.x} ${point.y} ${exit.x} ${exit.y}`;
  }
  const end = points[points.length - 1];
  return `${d} L ${end.x} ${end.y}`;
}
function result(points: WorkflowEdgePoint[]): WorkflowEdgeRoute {
  const start = points[0], end = points[points.length - 1];
  return { d: roundedPath(points), sx: start.x, sy: start.y, tx: end.x, ty: end.y, points };
}

/**
 * Prefer the shortest clear orthogonal path. Full card footprints are obstacles;
 * only the real source's departure and target's arrival may enter those cards.
 * Facing anchors supplied by the canvas avoid hairpins after reverse placement.
 */
export function routeWorkflowEdge(options: WorkflowEdgeRoutingOptions): WorkflowEdgeRoute {
  const { start, end, sourceKey, targetKey, obstacles } = options;
  const sourceSide = options.sourceSide ?? 'right', targetSide = options.targetSide ?? 'left';
  const source = obstacles.find(item => item.key === sourceKey), target = obstacles.find(item => item.key === targetKey);
  let exit = stub(start, sourceSide, source), entry = stub(end, targetSide, target);
  // A small but valid gap can hold both eight-pixel clearances. Fixed 16px
  // stubs would cross each other here and force an almost complete return loop.
  if (source && target && normal[sourceSide].x === -normal[targetSide].x && normal[sourceSide].y === -normal[targetSide].y) {
    const horizontal = normal[sourceSide].x !== 0, direction = horizontal ? normal[sourceSide].x : normal[sourceSide].y;
    const sourceEdge = horizontal ? source.x + (direction > 0 ? source.width : 0) : source.y + (direction > 0 ? source.height : 0);
    const targetEdge = horizontal ? target.x + (direction < 0 ? target.width : 0) : target.y + (direction < 0 ? target.height : 0);
    const gap = (targetEdge - sourceEdge) * direction;
    if (gap >= CLEARANCE * 2 && gap < STUB * 2) {
      const middle = (sourceEdge + targetEdge) / 2;
      exit = horizontal ? { ...exit, x: middle } : { ...exit, y: middle };
      entry = horizontal ? { ...entry, x: middle } : { ...entry, y: middle };
    }
  }
  const coreClear = (points: WorkflowEdgePoint[]) => points.slice(1).every((point, index) => segmentClear(points[index], point, obstacles));
  const candidate = (core: WorkflowEdgePoint[]): WorkflowEdgePoint[] | undefined => {
    if (!segmentClear(start, exit, obstacles, sourceKey) || !segmentClear(entry, end, obstacles, targetKey) || !coreClear(core)) return;
    const points = compact([start, ...core, end]);
    return points && !crossesItself(points) ? points : undefined;
  };
  const horizontal = sourceSide === 'left' || sourceSide === 'right';
  const nearby = obstacles.filter(item => item.key !== sourceKey && item.key !== targetKey
    && item.x - CLEARANCE <= Math.max(exit.x, entry.x) && item.x + item.width + CLEARANCE >= Math.min(exit.x, entry.x)
    && item.y - CLEARANCE <= Math.max(exit.y, entry.y) && item.y + item.height + CLEARANCE >= Math.min(exit.y, entry.y));
  const minY = options.minY ?? -Infinity;
  const below = Math.max(exit.y, entry.y, source ? source.y + source.height : start.y, target ? target.y + target.height : end.y, ...nearby.map(item => item.y + item.height)) + 24;
  const above = Math.min(exit.y, entry.y, source?.y ?? start.y, target?.y ?? end.y, ...nearby.map(item => item.y)) - 24;
  const left = Math.min(exit.x, entry.x, source?.x ?? start.x, target?.x ?? end.x, ...nearby.map(item => item.x)) - 24;
  const right = Math.max(exit.x, entry.x, source ? source.x + source.width : start.x, target ? target.x + target.width : end.x, ...nearby.map(item => item.x + item.width)) + 24;
  const yRail = (y: number) => [exit, { x: exit.x, y }, { x: entry.x, y }, entry];
  const xRail = (x: number) => [exit, { x, y: exit.y }, { x, y: entry.y }, entry];

  // Stable, separately selectable Switch lanes retain their 40 world-pixel gap.
  if ((options.parallelCount ?? 1) > 1) {
    const index = Math.max(0, options.parallelIndex ?? 0);
    const first = horizontal ? (nearby.length || options.forceOutside ? below : (exit.y + entry.y) / 2) : (nearby.length ? right : (exit.x + entry.x) / 2);
    let found = -1;
    for (let offset = 0; offset < 256; offset++) {
      const rail = first + offset * LANE_GAP;
      if (horizontal && rail < minY) continue;
      const points = candidate(horizontal ? yRail(rail) : xRail(rail));
      if (points && ++found === index) return result(points);
    }
  }

  const candidates: WorkflowEdgePoint[][] = [];
  const add = (core: WorkflowEdgePoint[]) => { const points = candidate(core); if (points) candidates.push(points); };
  if (!options.forceOutside) {
    if (exit.x === entry.x || exit.y === entry.y) add([exit, entry]);
    add([exit, { x: entry.x, y: exit.y }, entry]);
    add([exit, { x: exit.x, y: entry.y }, entry]);
    add(xRail((exit.x + entry.x) / 2));
    add(yRail((exit.y + entry.y) / 2));
    // Most drag frames have a clear straight/L/S path. Once a candidate reaches
    // both the Manhattan distance and the minimum possible turn count, distant
    // obstacle rails cannot improve it and need not be enumerated.
    const departure = normal[sourceSide], arrival = { x: -normal[targetSide].x, y: -normal[targetSide].y };
    const sameHeading = departure.x === arrival.x && departure.y === arrival.y;
    const aligned = (start.x === end.x && departure.x === 0) || (start.y === end.y && departure.y === 0);
    const turnMinimum = sameHeading ? aligned ? 0 : 2 : departure.x * arrival.x + departure.y * arrival.y === 0 ? 1 : 2;
    const optimal = candidates.find(points => points.length - 2 <= turnMinimum && Math.abs(points.slice(1).reduce((sum, point, index) => sum + length(points[index], point), 0) - length(start, end)) < EPSILON);
    if (optimal) return result(optimal);
  }
  const yRails = [below, above, ...nearby.flatMap(item => [item.y - 16, item.y + item.height + 16])];
  const xRails = [left, right, ...nearby.flatMap(item => [item.x - 16, item.x + item.width + 16])];
  for (const y of [...new Set(yRails)]) if (y >= minY && (!options.forceOutside || y >= below)) add(yRail(y));
  if (!options.forceOutside) for (const x of [...new Set(xRails)]) add(xRail(x));
  const score = (points: WorkflowEdgePoint[]) => points.slice(1).reduce((sum, point, index) => sum + length(points[index], point), 0) + Math.max(0, points.length - 2) * 12
    + (options.preferredSide === 'below' && points.some(point => point.y < Math.min(start.y, end.y)) ? 24 : options.preferredSide === 'above' && points.some(point => point.y > Math.max(start.y, end.y)) ? 24 : 0);
  if (candidates.length) return result(candidates.sort((a, b) => score(a) - score(b))[0]);

  // A bounded visibility grid handles narrow manual corridors that cannot be
  // reached with one rail. All cards still participate in collision checks.
  const maze = gridRoute(exit, entry, obstacles, sourceSide, targetSide, minY);
  if (maze) { const points = candidate(maze); if (points) return result(points); }
  // Physically overlapping cards may cover a real port. Keep its true endpoints
  // in that editable draft; no fabricated loop or endpoint mutation is added.
  const fallback = compact([start, exit, { x: exit.x, y: below }, { x: entry.x, y: below }, entry, end]);
  return result(fallback ?? compact([start, { x: end.x, y: start.y }, end]) ?? [start, end]);
}

function gridRoute(start: WorkflowEdgePoint, end: WorkflowEdgePoint, obstacles: WorkflowEdgeObstacle[], sourceSide: WorkflowEdgeSide, targetSide: WorkflowEdgeSide, minY: number): WorkflowEdgePoint[] | undefined {
  const distance = (rect: WorkflowEdgeObstacle) => Math.max(0, Math.min(start.x, end.x) - rect.x - rect.width, rect.x - Math.max(start.x, end.x)) + Math.max(0, Math.min(start.y, end.y) - rect.y - rect.height, rect.y - Math.max(start.y, end.y));
  const local = [...obstacles].sort((a, b) => distance(a) - distance(b)).slice(0, 32);
  const xs = [...new Set([start.x, end.x, ...local.flatMap(item => [item.x - 16, item.x + item.width + 16]), Math.min(start.x, end.x, ...obstacles.map(item => item.x)) - 24, Math.max(start.x, end.x, ...obstacles.map(item => item.x + item.width)) + 24])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, ...local.flatMap(item => [item.y - 16, item.y + item.height + 16]), Math.min(start.y, end.y, ...obstacles.map(item => item.y)) - 24, Math.max(start.y, end.y, ...obstacles.map(item => item.y + item.height)) + 24])].filter(y => y >= minY).sort((a, b) => a - b);
  const startX = xs.indexOf(start.x), startY = ys.indexOf(start.y), endX = xs.indexOf(end.x), endY = ys.indexOf(end.y);
  if (startY < 0 || endY < 0) return;
  const directions = ['right', 'bottom', 'left', 'top'] as const;
  const initialDirection = directions.indexOf(sourceSide), blockedArrival = directions.indexOf(targetSide);
  type Search = { x: number; y: number; direction: number; cost: number; estimate: number; key: number };
  const key = (x: number, y: number, direction: number) => (y * xs.length + x) * 4 + direction;
  const initialKey = key(startX, startY, initialDirection), costs = new Map([[initialKey, 0]]), parents = new Map<number, number>(), states = new Map<number, Search>();
  const queue: Search[] = [];
  const push = (item: Search) => { queue.push(item); let index = queue.length - 1; while (index > 0) { const parent = (index - 1) >> 1; if (queue[parent].estimate <= item.estimate) break; queue[index] = queue[parent]; index = parent; } queue[index] = item; };
  const pop = () => { const first = queue[0], tail = queue.pop()!; if (queue.length) { let index = 0; while (index * 2 + 1 < queue.length) { const left = index * 2 + 1, right = left + 1, child = right < queue.length && queue[right].estimate < queue[left].estimate ? right : left; if (queue[child].estimate >= tail.estimate) break; queue[index] = queue[child]; index = child; } queue[index] = tail; } return first; };
  const initial = { x: startX, y: startY, direction: initialDirection, cost: 0, estimate: length(start, end), key: initialKey }; push(initial); states.set(initialKey, initial);
  const clearCache = new Map<string, boolean>();
  for (let visited = 0; queue.length && visited < 20000; visited++) {
    const current = pop(); if (current.cost !== costs.get(current.key)) continue;
    if (current.x === endX && current.y === endY && current.direction !== blockedArrival) {
      const points: WorkflowEdgePoint[] = []; let cursor: number | undefined = current.key;
      while (cursor !== undefined) { const item = states.get(cursor)!; points.push({ x: xs[item.x], y: ys[item.y] }); cursor = parents.get(cursor); }
      return points.reverse();
    }
    for (let direction = 0; direction < 4; direction++) {
      if (direction === (current.direction + 2) % 4) continue;
      const x = current.x + (direction === 0 ? 1 : direction === 2 ? -1 : 0), y = current.y + (direction === 1 ? 1 : direction === 3 ? -1 : 0);
      if (x < 0 || y < 0 || x >= xs.length || y >= ys.length) continue;
      const from = { x: xs[current.x], y: ys[current.y] }, to = { x: xs[x], y: ys[y] }, cacheKey = `${Math.min(current.x, x)},${Math.min(current.y, y)}:${Math.max(current.x, x)},${Math.max(current.y, y)}`;
      let clear = clearCache.get(cacheKey); if (clear === undefined) { clear = segmentClear(from, to, obstacles); clearCache.set(cacheKey, clear); } if (!clear) continue;
      const cost = current.cost + length(from, to) + (direction === current.direction ? 0 : 12), nextKey = key(x, y, direction);
      if (cost >= (costs.get(nextKey) ?? Infinity)) continue;
      const next = { x, y, direction, cost, estimate: cost + length(to, end), key: nextKey }; costs.set(nextKey, cost); parents.set(nextKey, current.key); states.set(nextKey, next); push(next);
    }
  }
}
