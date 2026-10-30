import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { canvasPortPoint, canvasPortHitArea, facingPortSides, offsetPortPoint, type CanvasPortSide } from '../lib/workflow-port-geometry.ts';

test('anchors follow forward, reversed, upward and downward card placement', () => {
  const source={x:400,y:400};
  for(const [target,sourceSide,targetSide] of [
    [{x:700,y:420},'right','left'],[{x:0,y:420},'left','right'],
    [{x:420,y:0},'top','bottom'],[{x:420,y:800},'bottom','top'],
  ] as const)assert.deepEqual(facingPortSides(source,target),{sourceSide,targetSide});
  assert.deepEqual(source,{x:400,y:400},'Geometry does not change saved placement.');
});

test('diamond branch ports stay on the actual shape and lower anchors clear the title', () => {
  const position={x:100,y:200};
  assert.deepEqual(canvasPortPoint(position,'right','diamond','true'),{x:188,y:222});
  assert.deepEqual(canvasPortPoint(position,'left','diamond','false'),{x:156,y:246});
  assert.deepEqual(canvasPortPoint(position,'top','diamond','true'),{x:160,y:218});
  assert.deepEqual(canvasPortPoint(position,'bottom','diamond','false'),{x:184,y:312});
  for(const shape of ['circle','square','diamond','hexagon'] as const){
    assert.equal(canvasPortPoint(position,'bottom',shape).y,312);
    assert.equal(canvasPortPoint(position,'top',shape).y,206);
  }
});

test('touch targets grow outward and branch targets remain separate at low zoom', () => {
  const position={x:100,y:200};
  for(const side of ['left','right','top','bottom'] as CanvasPortSide[]){
    const upper=canvasPortPoint(position,side,'diamond','true'),lower=canvasPortPoint(position,side,'diamond','false');
    const a=canvasPortHitArea(upper,side,140,'true'),b=canvasPortHitArea(lower,side,140,'false');
    if(side==='left'||side==='right')assert.equal(a.top+a.height,b.top);
    else assert.equal(a.left+a.width,b.left);
    for(const [point,area] of [[upper,a],[lower,b]] as const){
      assert.ok(point.x>=area.left&&point.x<=area.left+area.width);
      assert.ok(point.y>=area.top&&point.y<=area.top+area.height);
    }
  }
});

test('arrow clearance points away from each input side without reversing the edge', () => {
  const point={x:100,y:100};
  assert.deepEqual(offsetPortPoint(point,'left',8),{x:92,y:100});
  assert.deepEqual(offsetPortPoint(point,'right',8),{x:108,y:100});
  assert.deepEqual(offsetPortPoint(point,'top',8),{x:100,y:92});
  assert.deepEqual(offsetPortPoint(point,'bottom',8),{x:100,y:108});
});
