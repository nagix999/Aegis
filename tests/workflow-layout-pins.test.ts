import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Node's source test runner resolves explicit TypeScript paths.
import { initialState } from '../lib/aegis-seed.ts';
// @ts-expect-error Node's source test runner resolves explicit TypeScript paths.
import { autoLayout, normalizedPinnedKeys, nodeDefinitions, NODE_WIDTH, NODE_HEIGHT, CANVAS_LIMIT } from '../lib/workflow-layout.ts';
import type { CanvasPositions } from '../lib/workflow-layout';
import type { Workflow } from '../lib/aegis-types';

function sample(): Workflow {
  const workflow = initialState().workflows[0];
  workflow.post = [];
  return workflow;
}
function noOverlap(workflow: Workflow, positions: CanvasPositions) {
  const keys = nodeDefinitions(workflow).map(node => node.key);
  for (let a = 0; a < keys.length; a++) for (let b = a + 1; b < keys.length; b++) {
    const x = positions[keys[a]], y = positions[keys[b]];
    assert.ok(!(x.x < y.x + NODE_WIDTH && x.x + NODE_WIDTH > y.x && x.y < y.y + NODE_HEIGHT && x.y + NODE_HEIGHT > y.y), `${keys[a]} overlaps ${keys[b]}`);
  }
}

test('automatic layout preserves pinned positions and moves conflicting unpinned cards', () => {
  const workflow = sample();
  workflow.layout = {version: 1, positions: {main: {x: 48, y: 48}}, pinnedKeys: ['main']};
  const before = structuredClone(workflow), positions = autoLayout(workflow);
  assert.deepEqual(positions.main, before.layout!.positions.main);
  assert.notDeepEqual(positions.input, positions.main);
  noOverlap(workflow, positions);
  assert.deepEqual(autoLayout(workflow), positions);
  assert.deepEqual(workflow, before);
});

test('pins survive new nodes and viewport-driven folding while aliases stay synchronized', () => {
  const workflow = sample(), first = workflow.pre[0];
  workflow.layout = {version: 1, positions: {[`group:${first.id}`]: {x: 730.25, y: 540.5}}, pinnedKeys: [`group:${first.id}`]};
  for (let index = 0; index < 14; index++) workflow.pre.push({id: `new-group-${index}`, name: '새 검사', mode: 'any', rules: [{...structuredClone(first.rules[0]), id: `new-rule-${index}`}]});
  const positions = autoLayout(workflow, {width: 600, height: 800});
  assert.deepEqual(positions[`group:${first.id}`], {x: 730.25, y: 540.5});
  for (const rule of first.rules) assert.deepEqual(positions[`rule:${rule.id}`], positions[`group:${first.id}`]);
  noOverlap(workflow, positions);
});

test('legacy hidden keys normalize to one pin and provide the saved anchor', () => {
  const workflow = sample(), group = workflow.pre[0], hidden = `rule:${group.rules[1].id}`, visible = `group:${group.id}`;
  workflow.layout = {version: 1, positions: {[hidden]: {x: 1120, y: 300}}, pinnedKeys: [hidden, visible, 'rule:deleted']};
  assert.deepEqual(normalizedPinnedKeys(workflow), [visible]);
  const positions = autoLayout(workflow);
  assert.deepEqual(positions[visible], {x: 1120, y: 300});
  for (const rule of group.rules) assert.deepEqual(positions[`rule:${rule.id}`], positions[visible]);
  noOverlap(workflow, positions);
});

test('invalid or missing saved pins leave the compact default layout unchanged', () => {
  const workflow = sample(), defaults = autoLayout(workflow);
  workflow.layout = {version: 1, positions: {main: {x: Number.NaN, y: 0}, output: {x: CANVAS_LIMIT + 1, y: 0}}, pinnedKeys: ['main', 'output', 'input', 'rule:deleted']};
  assert.deepEqual(autoLayout(workflow), defaults);
  workflow.layout.pinnedKeys = [];
  assert.deepEqual(autoLayout(workflow), defaults);
});

test('boundary pins remain fixed and automatic cards stay in the canvas bounds', () => {
  const workflow = sample();
  workflow.layout = {version: 1, positions: {input: {x: 0, y: 0}, main: {x: CANVAS_LIMIT, y: CANVAS_LIMIT}}, pinnedKeys: ['input', 'main']};
  const positions = autoLayout(workflow);
  assert.deepEqual(positions.input, {x: 0, y: 0});
  assert.deepEqual(positions.main, {x: CANVAS_LIMIT, y: CANVAS_LIMIT});
  for (const node of nodeDefinitions(workflow)) {
    const position = positions[node.key];
    assert.ok(position.x >= 0 && position.x <= CANVAS_LIMIT && position.y >= 0 && position.y <= CANVAS_LIMIT);
  }
  noOverlap(workflow, positions);
});
