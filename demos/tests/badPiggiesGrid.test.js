import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CELL,
  LAYER_BOX,
  LAYER_ROCKET,
  LAYER_WHEEL,
  MASK_ROCKET,
  canPlaceBox,
  canPlaceRocket,
  canPlaceWheel,
  cellKey,
  cellToWorld,
  planJoints,
  heightsToSegments,
  worldToCell,
} from '../../demos/badPiggiesScene/utils/badPiggiesGrid.js';

test('rocket collides with ground only, not boxes or wheels', () => {
  assert.equal(LAYER_ROCKET, 3);
  assert.ok(MASK_ROCKET & (1 << 0));
  assert.equal(MASK_ROCKET & (1 << LAYER_BOX), 0);
  assert.equal(MASK_ROCKET & (1 << LAYER_WHEEL), 0);
});

test('worldToCell / cellToWorld round-trip at cell centers', () => {
  const originX = 100;
  const originY = 200;
  const pos = cellToWorld(3, -2, originX, originY);
  assert.equal(pos.x, originX + 3 * CELL);
  assert.equal(pos.y, originY - 2 * CELL);
  const cell = worldToCell(pos.x + 10, pos.y - 10, originX, originY);
  assert.deepEqual(cell, { gx: 3, gy: -2 });
});

test('canPlaceBox false when cell occupied; canPlaceWheel only on box without wheel', () => {
  const occupancy = new Map();
  assert.equal(canPlaceBox(occupancy, 0, 0), true);
  assert.equal(canPlaceWheel(occupancy, 0, 0), false);

  occupancy.set(cellKey(0, 0), { boxIndex: 10, wheelIndex: -1 });
  assert.equal(canPlaceBox(occupancy, 0, 0), false);
  assert.equal(canPlaceWheel(occupancy, 0, 0), true);

  occupancy.set(cellKey(0, 0), { boxIndex: 10, wheelIndex: 11 });
  assert.equal(canPlaceWheel(occupancy, 0, 0), false);
});

test('canPlaceRocket only on a box without a rocket; wheel does not block it', () => {
  const occupancy = new Map();
  assert.equal(canPlaceRocket(occupancy, 0, 0), false);

  occupancy.set(cellKey(0, 0), { boxIndex: 10, wheelIndex: 11, rocketIndex: -1 });
  assert.equal(canPlaceRocket(occupancy, 0, 0), true);
  assert.equal(canPlaceWheel(occupancy, 0, 0), false);

  occupancy.set(cellKey(0, 0), { boxIndex: 10, wheelIndex: 11, rocketIndex: 20 });
  assert.equal(canPlaceRocket(occupancy, 0, 0), false);
});

test('planJoints welds orthogonal neighbors once, skips diagonals, revolute on wheel', () => {
  const originX = 0;
  const originY = 0;
  const occupancy = new Map([
    [cellKey(0, 0), { boxIndex: 1, wheelIndex: 50 }],
    [cellKey(1, 0), { boxIndex: 2, wheelIndex: -1 }],
    [cellKey(1, 1), { boxIndex: 3, wheelIndex: -1 }],
    [cellKey(3, 3), { boxIndex: 4, wheelIndex: -1 }],
  ]);

  const { welds, revolutes } = planJoints(occupancy, originX, originY);

  const pairs = welds.map((w) => [w.entityA, w.entityB].sort((a, b) => a - b).join('-')).sort();
  assert.deepEqual(pairs, ['1-2', '2-3']);

  const mid01 = cellToWorld(0, 0, originX, originY);
  const mid10 = cellToWorld(1, 0, originX, originY);
  const weld12 = welds.find((w) => w.entityA === 1 && w.entityB === 2);
  assert.equal(weld12.worldAnchorX, (mid01.x + mid10.x) * 0.5);
  assert.equal(weld12.worldAnchorY, (mid01.y + mid10.y) * 0.5);

  assert.equal(revolutes.length, 1);
  assert.deepEqual(revolutes[0], {
    entityA: 1,
    entityB: 50,
    worldAnchorX: mid01.x,
    worldAnchorY: mid01.y,
  });
});

test('planJoints welds rocket to its box', () => {
  const originX = 0;
  const originY = 0;
  const occupancy = new Map([
    [cellKey(0, 0), { boxIndex: 1, wheelIndex: -1, rocketIndex: 70 }],
  ]);
  const { welds, revolutes } = planJoints(occupancy, originX, originY);
  const pos = cellToWorld(0, 0, originX, originY);
  assert.equal(revolutes.length, 0);
  assert.equal(welds.length, 1);
  assert.deepEqual(welds[0], {
    entityA: 1,
    entityB: 70,
    worldAnchorX: pos.x,
    worldAnchorY: pos.y,
  });
});

test('heightsToSegments builds overlapping rotated boxes along the polyline', () => {
  const heights = [100, 100, 140];
  const segs = heightsToSegments(heights, 0, 80, 40, 1.05);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].rotation, 0);
  assert.ok(Math.abs(segs[0].width - 80 * 1.05) < 1e-6);
  assert.ok(segs[0].y > 100);
  assert.ok(segs[1].rotation > 0);
});
