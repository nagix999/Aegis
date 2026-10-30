import type { CanvasPosition } from './workflow-layout';
// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { NODE_HEIGHT, NODE_WIDTH, NODE_ICON_SIZE, NODE_ICON_CENTER_Y } from './workflow-layout.ts';

export type CanvasPortSide = 'left' | 'right' | 'top' | 'bottom';
export type CanvasPortShape = 'circle' | 'square' | 'diamond' | 'hexagon';
export const portDirection: Record<CanvasPortSide, CanvasPosition> = {
  left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 },
};
export const oppositePortSide: Record<CanvasPortSide, CanvasPortSide> = {
  left: 'right', right: 'left', top: 'bottom', bottom: 'top',
};

/** Face the other card rather than forcing every wire to travel left to right. */
export function facingPortSides(source: CanvasPosition, target: CanvasPosition): { sourceSide: CanvasPortSide; targetSide: CanvasPortSide } {
  const dx = target.x - source.x, dy = target.y - source.y;
  const sourceSide: CanvasPortSide = Math.abs(dx) >= Math.abs(dy)
    ? dx < 0 ? 'left' : 'right'
    : dy < 0 ? 'top' : 'bottom';
  return { sourceSide, targetSide: oppositePortSide[sourceSide] };
}

/** The lower anchor clears the node name, which is part of the card footprint. */
export function canvasPortPoint(position: CanvasPosition, side: CanvasPortSide, shape: CanvasPortShape = 'circle', branch?: 'true' | 'false'): CanvasPosition {
  const radius = NODE_ICON_SIZE / 2;
  const tangent = branch === 'true' ? -12 : branch === 'false' ? 12 : 0;
  const center = { x: position.x + NODE_WIDTH / 2, y: position.y + NODE_ICON_CENTER_Y };
  if (side === 'bottom') return { x: center.x + tangent, y: position.y + NODE_HEIGHT };
  const extent = shape === 'diamond' ? radius - Math.abs(tangent)
    : shape === 'circle' ? Math.sqrt(radius * radius - tangent * tangent)
    : shape === 'hexagon' && (side === 'left' || side === 'right') ? radius - Math.abs(tangent) / 2 : radius;
  if (side === 'top') return { x: center.x + tangent, y: center.y - extent };
  return { x: center.x + (side === 'left' ? -extent : extent), y: center.y + tangent };
}

export function offsetPortPoint(point: CanvasPosition, side: CanvasPortSide, distance: number): CanvasPosition {
  return { x: point.x + portDirection[side].x * distance, y: point.y + portDirection[side].y * distance };
}

/** Keep enlarged touch targets outside the card and distinct for both branch ports. */
export function canvasPortHitArea(point: CanvasPosition, side: CanvasPortSide, size: number, branch?: 'true' | 'false') {
  let left = point.x - size / 2, top = point.y - size / 2;
  if (side === 'left') left = point.x + 7 - size;
  if (side === 'right') left = point.x - 7;
  if (side === 'top') top = point.y + 7 - size;
  if (side === 'bottom') top = point.y - 7;
  if (side === 'left' || side === 'right') {
    if (branch === 'true') top = point.y + 12 - size;
    if (branch === 'false') top = point.y - 12;
  } else {
    if (branch === 'true') left = point.x + 12 - size;
    if (branch === 'false') left = point.x - 12;
  }
  return { left, top, width: size, height: size };
}
