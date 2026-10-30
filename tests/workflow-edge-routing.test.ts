import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { routeWorkflowEdge, type WorkflowEdgeObstacle, type WorkflowEdgePoint, type WorkflowEdgeRoute, type WorkflowEdgeSide } from '../lib/workflow-edge-routing.ts';

const card = (key: string, x: number, y: number): WorkflowEdgeObstacle => ({ key, x, y, width: 144, height: 112 });
const port = (rect: WorkflowEdgeObstacle, side: WorkflowEdgeSide, arrival = false): WorkflowEdgePoint => side === 'left' ? { x: rect.x + 44 - (arrival ? 8 : 0), y: rect.y + 34 }
  : side === 'right' ? { x: rect.x + 100 + (arrival ? 8 : 0), y: rect.y + 34 }
    : side === 'top' ? { x: rect.x + 72, y: rect.y - (arrival ? 8 : 0) }
      : { x: rect.x + 72, y: rect.y + 112 + (arrival ? 8 : 0) };
function route(source: WorkflowEdgeObstacle, target: WorkflowEdgeObstacle, sourceSide: WorkflowEdgeSide = 'right', targetSide: WorkflowEdgeSide = 'left', others: WorkflowEdgeObstacle[] = [], extra = {}) {
  return routeWorkflowEdge({ start: port(source, sourceSide), end: port(target, targetSide, true), sourceKey: source.key, targetKey: target.key, sourceSide, targetSide, obstacles: [source, target, ...others], minY: -72, ...extra });
}
function assertSimple(line: WorkflowEdgeRoute) {
  assert.ok(line.points.length >= 2);
  assert.ok(line.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.doesNotMatch(line.d, /NaN|Infinity| C /);
  for (let index = 1; index < line.points.length; index++) {
    const a = line.points[index - 1], b = line.points[index];
    assert.ok(a.x === b.x || a.y === b.y, 'Every segment is orthogonal.');
    assert.notDeepEqual(a, b, 'No zero-length segment changes the arrow tangent.');
    if (index > 1) {
      const before = line.points[index - 2];
      assert.ok((a.x - before.x) * (b.x - a.x) + (a.y - before.y) * (b.y - a.y) >= 0, 'No 180 degree reversal.');
    }
  }
  for (let i = 1; i < line.points.length; i++) for (let j = i + 2; j < line.points.length; j++) {
    const [a, b, c, d] = [line.points[i - 1], line.points[i], line.points[j - 1], line.points[j]];
    if (a.x === b.x && c.y === d.y) assert.ok(a.x < Math.min(c.x, d.x) || a.x > Math.max(c.x, d.x) || c.y < Math.min(a.y, b.y) || c.y > Math.max(a.y, b.y), 'No self-intersection.');
    if (a.y === b.y && c.x === d.x) assert.ok(c.x < Math.min(a.x, b.x) || c.x > Math.max(a.x, b.x) || a.y < Math.min(c.y, d.y) || a.y > Math.max(c.y, d.y), 'No self-intersection.');
  }
}
function assertAvoids(line: WorkflowEdgeRoute, obstacles: WorkflowEdgeObstacle[]) {
  for (const rect of obstacles) for (let index = 1; index < line.points.length; index++) {
    const a = line.points[index - 1], b = line.points[index];
    assert.ok(a.x === b.x
      ? a.x <= rect.x - 8 || a.x >= rect.x + rect.width + 8 || Math.max(a.y, b.y) <= rect.y - 8 || Math.min(a.y, b.y) >= rect.y + rect.height + 8
      : a.y <= rect.y - 8 || a.y >= rect.y + rect.height + 8 || Math.max(a.x, b.x) <= rect.x - 8 || Math.min(a.x, b.x) >= rect.x + rect.width + 8, `Connection clears ${rect.key}.`);
  }
}

test('forward and reversed placements use facing anchors without a return loop', () => {
  for (const reversed of [false, true]) {
    const source = card('source', reversed ? 600 : 0, 100), target = card('target', reversed ? 0 : 600, 100);
    const line = route(source, target, reversed ? 'left' : 'right', reversed ? 'right' : 'left');
    assertSimple(line); assert.equal(line.points.length, 2);
    assert.equal(line.sx, port(source, reversed ? 'left' : 'right').x);
    assert.equal(line.tx, port(target, reversed ? 'right' : 'left', true).x);
  }
});

test('vertical placements preserve the arrival tangent without circling the next card', () => {
  for (const reversed of [false, true]) {
    const source = card('source', 100, reversed ? 500 : 0), target = card('target', 100, reversed ? 0 : 500);
    const line = route(source, target, reversed ? 'top' : 'bottom', reversed ? 'bottom' : 'top');
    assertSimple(line); assert.equal(line.points.length, 2);
    assert.equal(line.points[0].x, line.points.at(-1)!.x);
  }
});

test('diagonal movement remains simple in every quadrant with horizontal and vertical anchors', () => {
  const source = card('source', 500, 500);
  for (const [x, y] of [[0, 0], [1000, 0], [0, 1000], [1000, 1000]]) {
    for (const vertical of [false, true]) {
      const sourceSide = vertical ? y > 500 ? 'bottom' : 'top' : x > 500 ? 'right' : 'left';
      const targetSide = vertical ? y > 500 ? 'top' : 'bottom' : x > 500 ? 'left' : 'right';
      assertSimple(route(source, card('target', x, y), sourceSide, targetSide));
    }
  }
});

test('a distant card in the same x column no longer widens the departure corridor', () => {
  const source = card('source', 100, 100), target = card('target', 650, 100), remote = card('remote', 200, 3000);
  const original = route(source, target), distant = route(source, target, 'right', 'left', [remote]);
  assert.deepEqual(distant, original);
  assert.equal(distant.points.length, 2);
});

test('closely spaced facing cards share their free corridor instead of making a 270 degree detour', () => {
  const cases = [
    { source: card('source', 48, 48), target: card('target', 144, 176), start: { x: 120, y: 160 }, end: { x: 216, y: 174 }, sourceSide: 'bottom' as const, targetSide: 'top' as const },
    { source: card('source', 48, 48), target: card('target', 216, 96), start: { x: 148, y: 82 }, end: { x: 252, y: 130 }, sourceSide: 'right' as const, targetSide: 'left' as const },
  ];
  for (const { source, target, ...geometry } of cases) {
    const line = routeWorkflowEdge({ ...geometry, sourceKey: source.key, targetKey: target.key, obstacles: [source, target], minY: -72 });
    assertSimple(line);
    const axis = geometry.sourceSide === 'bottom' ? 'y' : 'x';
    for (let index = 1; index < line.points.length; index++) assert.ok(line.points[index][axis] >= line.points[index - 1][axis], 'A clear narrow gap never needs to travel behind its source.');
    assert.ok(line.points.every(point => point.x >= Math.min(geometry.start.x, geometry.end.x) && point.x <= Math.max(geometry.start.x, geometry.end.x) && point.y >= Math.min(geometry.start.y, geometry.end.y) && point.y <= Math.max(geometry.start.y, geometry.end.y)));
  }
});

test('a card between endpoints is avoided without changing actual node positions', () => {
  const source = card('source', 0, 100), target = card('target', 800, 100), middle = card('middle', 400, 100);
  const snapshot = structuredClone([source, target, middle]), line = route(source, target, 'right', 'left', [middle]);
  assertSimple(line); assertAvoids(line, [middle]);
  assert.deepEqual([source, target, middle], snapshot);
  assert.equal(line.tx, port(target, 'left', true).x);
});

test('fixed right-to-left ports on folded rows use the empty band without reversing any segment', () => {
  const source = card('source', 800, 0), target = card('target', 0, 220), line = route(source, target);
  assertSimple(line);
  const returning = line.points.slice(1).map((point, index) => ({ a: line.points[index], b: point })).filter(({ a, b }) => b.x < a.x);
  assert.ok(returning.length > 0);
  assert.ok(returning.every(({ a }) => a.y > source.y + source.height && a.y < target.y));
});

test('Switch parallel lanes stay distinct by 40 pixels with and without a middle card', () => {
  for (const count of [3, 13]) for (const blocked of [false, true]) {
    const source = card('switch', 0, 100), target = card('action', 700, 100), middle = card('middle', 350, 100);
    const lines = Array.from({ length: count }, (_, index) => route(source, target, 'right', 'left', blocked ? [middle] : [], { parallelIndex: index, parallelCount: count }));
    assert.equal(new Set(lines.map(line => line.d)).size, count);
    const rails = lines.map(line => line.points.length === 2 ? line.sy : line.points[2].y);
    for (let index = 1; index < rails.length; index++) assert.ok(rails[index] - rails[index - 1] >= 40);
    for (const line of lines) { assertSimple(line); if (blocked) assertAvoids(line, [middle]); }
  }
});

test('vertically placed Switch cases receive separate horizontal lanes', () => {
  const source = card('switch', 100, 0), target = card('action', 100, 700);
  const lines = Array.from({ length: 4 }, (_, index) => route(source, target, 'bottom', 'top', [], { parallelIndex: index, parallelCount: 4 }));
  assert.equal(new Set(lines.map(line => line.d)).size, 4);
  const rails = lines.map(line => line.points.length === 2 ? line.sx : line.points[2].x);
  for (let index = 1; index < rails.length; index++) assert.ok(rails[index] - rails[index - 1] >= 40);
  lines.forEach(assertSimple);
});

test('a narrow source corridor can turn beyond adjacent blockers before avoiding the middle card', () => {
  const source = card('source', 0, 400), target = card('target', 1000, 400);
  const obstacles = [card('source-above', 152, 300), card('source-below', 152, 460), card('middle-wall', 470, 350)];
  const line = route(source, target, 'right', 'left', obstacles);
  assertSimple(line); assertAvoids(line, obstacles);
  assert.ok(line.points[1].x > obstacles[0].x + obstacles[0].width, 'The departure turn clears the narrow corridor before changing rows.');
});

test('retry deliberately returns on an outside rail without self-crossing', () => {
  const source = card('response', 700, 300), target = card('main', 100, 300), middle = card('check', 400, 300);
  const line = route(source, target, 'right', 'left', [middle], { forceOutside: true, preferredSide: 'below' });
  assertSimple(line); assertAvoids(line, [middle]);
  assert.ok(line.points.some(point => point.y > source.y + source.height));
});

test('even an overlapping editable draft keeps finite real endpoints instead of a cubic loop', () => {
  const source = card('source', 100, 100), target = card('target', 120, 100), line = route(source, target);
  assert.ok(line.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.equal(line.sx, port(source, 'right').x); assert.equal(line.tx, port(target, 'left', true).x);
  assert.doesNotMatch(line.d, / C |NaN|Infinity/);
});
