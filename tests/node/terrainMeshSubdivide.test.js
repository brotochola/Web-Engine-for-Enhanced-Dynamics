import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pointInConvex,
  polygonArea,
  splitConvexAtPoint,
  subdivideConvex,
} from '../../demos/destructibleTerrainScene/terrainMesh.js';

const SQUARE = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

test('pointInConvex: inside, outside, vertex', () => {
  assert.equal(pointInConvex(SQUARE, 5, 5), true);
  assert.equal(pointInConvex(SQUARE, 11, 5), false);
  assert.equal(pointInConvex(SQUARE, 0, 0), true);
  assert.equal(pointInConvex([{ x: 0, y: 0 }, { x: 1, y: 0 }], 0.5, 0), false);
});

test('subdivideConvex: splits until minArea, respects maxOut', () => {
  const pieces = subdivideConvex(SQUARE, 30, 24);
  assert.ok(pieces.length > 1);
  assert.ok(pieces.length <= 24);
  let areaSum = 0;
  for (let i = 0; i < pieces.length; i++) {
    const a = polygonArea(pieces[i]);
    assert.ok(a > 0);
    assert.ok(a <= 30 + 1e-6);
    areaSum += a;
  }
  assert.ok(Math.abs(areaSum - 100) < 1e-4);

  const capped = subdivideConvex(SQUARE, 1, 1);
  assert.equal(capped.length, 1);
});

test('splitConvexAtPoint: hit child drops, others stay, area conserved', () => {
  const { keep, drop } = splitConvexAtPoint(SQUARE, 1, 1, 30, 24);
  assert.equal(drop.length, 1);
  assert.ok(keep.length >= 1);
  assert.equal(pointInConvex(drop[0], 1, 1), true);
  let area = polygonArea(drop[0]);
  for (let i = 0; i < keep.length; i++) area += polygonArea(keep[i]);
  assert.ok(Math.abs(area - 100) < 1e-4);
});
