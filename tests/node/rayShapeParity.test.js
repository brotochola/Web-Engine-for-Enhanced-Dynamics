import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { Transform } from '../../src/components/transform.js';
import { Grid } from '../../src/core/grid.js';
import { Ray } from '../../src/core/ray.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { rayBoxIntersect, rayCircleIntersect } from '../../src/util/utils.js';

// Ray tests circles and boxes with its own copies of rayCircleIntersect and rayBoxIntersect, which
// read the traced ray from a typed array (E-85: no call on the ray path takes a double). The copies
// must give the reference functions' distances exactly, axis-aligned rays included.

const WORLD = 1024;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One cell covering the world, holding entity 0. */
function setupOneEntity() {
  Grid.cellSize = WORLD;
  Grid.invCellSize = 1 / WORLD;
  Grid.gridWidth = 1;
  Grid.gridHeight = 1;
  Grid.totalCells = 1;
  Grid.maxEntitiesPerCell = 8;
  Grid.cellByteSize = 4 + 8 * 2;
  Grid._cellIdStride = Grid.cellByteSize / 2;
  Grid._headerIds = 2;
  const buf = new ArrayBuffer(Grid.cellByteSize);
  Grid._gridCounts = new Uint8Array(buf);
  Grid._gridEntities = new Uint16Array(buf);
  Grid.addEntityToCell(0, 0);

  Transform.active = new Uint8Array([1]);
  Transform.x = new Float32Array(1);
  Transform.y = new Float32Array(1);
  Collider.active = new Uint8Array([1]);
  Collider.shapeType = new Uint8Array(1);
  Collider.collisionLayer = new Uint8Array(1);
  Collider.offsetX = new Float32Array(1);
  Collider.offsetY = new Float32Array(1);
  Collider.radius = new Float32Array(1);
  Collider.width = new Float32Array(1);
  Collider.height = new Float32Array(1);
}

/** Two rays in three end near the shape, so about half the cases hit. */
function randomRay(rng, k) {
  const x1 = 16 + rng() * (WORLD - 32);
  const y1 = 16 + rng() * (WORLD - 32);
  const aim = k % 3 !== 0;
  let x2 = aim ? Transform.x[0] + (rng() - 0.5) * 160 : 16 + rng() * (WORLD - 32);
  let y2 = aim ? Transform.y[0] + (rng() - 0.5) * 160 : 16 + rng() * (WORLD - 32);
  if (k % 7 === 0) x2 = x1; // vertical: dirX is 0
  if (k % 11 === 0) y2 = y1; // horizontal: dirY is 0
  return { x1, y1, x2, y2 };
}

function check(shape, reference) {
  setupOneEntity();
  const rng = mulberry32(shape === ShapeType.Circle ? 0x51ced : 0xb0c5);
  let hits = 0;
  for (let k = 0; k < 4000; k++) {
    Transform.x[0] = 64 + rng() * (WORLD - 128);
    Transform.y[0] = 64 + rng() * (WORLD - 128);
    Collider.shapeType[0] = shape;
    Collider.offsetX[0] = (rng() - 0.5) * 8;
    Collider.offsetY[0] = (rng() - 0.5) * 8;
    Collider.radius[0] = 4 + rng() * 120;
    Collider.width[0] = 8 + rng() * 240;
    Collider.height[0] = 8 + rng() * 240;
    const { x1, y1, x2, y2 } = randomRay(rng, k);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) continue;
    const want = reference(x1, y1, dx / len, dy / len, len);
    const info = Ray.castWithInfo(x1, y1, x2, y2);
    if (want >= 0) {
      hits++;
      assert.equal(info.hit, true, `case ${k}: the reference hit at ${want}`);
      assert.equal(info.distance, want, `case ${k}`);
    } else {
      assert.equal(info.hit, false, `case ${k}: the reference missed`);
    }
  }
  assert.ok(hits > 1000, `only ${hits} hits: the cases do not test much`);
}

test('circle hits match rayCircleIntersect exactly', () => {
  check(ShapeType.Circle, (x, y, dirX, dirY, len) => rayCircleIntersect(
    x, y, dirX, dirY,
    Transform.x[0] + Collider.offsetX[0], Transform.y[0] + Collider.offsetY[0], Collider.radius[0], len
  ));
});

test('box hits match rayBoxIntersect exactly', () => {
  check(ShapeType.Box, (x, y, dirX, dirY, len) => rayBoxIntersect(
    x, y, dirX, dirY,
    Transform.x[0] + Collider.offsetX[0], Transform.y[0] + Collider.offsetY[0],
    Collider.width[0], Collider.height[0], len
  ));
});
