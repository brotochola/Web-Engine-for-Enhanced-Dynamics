import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { Transform } from '../../src/components/transform.js';
import { Grid } from '../../src/core/grid.js';
import { Ray } from '../../src/core/ray.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { rayBoxIntersect, rayCircleIntersect } from '../../src/util/utils.js';

// castAll returns the closest maxHits entities along the ray, nearest first, and reuses its
// borrowed result objects from one call to the next (E-85: they were made again every call).

const WORLD = 1024;
const CELL = 128;
const N = 300;

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

/** N circles and boxes, each in every cell its bounds overlap, as the spatial worker inserts them. */
function setupWorld(rng) {
  const cols = WORLD / CELL;
  Grid.cellSize = CELL;
  Grid.invCellSize = 1 / CELL;
  Grid.gridWidth = cols;
  Grid.gridHeight = cols;
  Grid.totalCells = cols * cols;
  Grid.maxEntitiesPerCell = 64;
  Grid.cellByteSize = 4 + 64 * 2;
  Grid._cellIdStride = Grid.cellByteSize / 2;
  Grid._headerIds = 2;
  const buf = new ArrayBuffer(Grid.totalCells * Grid.cellByteSize);
  Grid._gridCounts = new Uint8Array(buf);
  Grid._gridEntities = new Uint16Array(buf);

  Transform.active = new Uint8Array(N).fill(1);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Collider.active = new Uint8Array(N).fill(1);
  Collider.shapeType = new Uint8Array(N);
  Collider.collisionLayer = new Uint8Array(N);
  Collider.offsetX = new Float32Array(N);
  Collider.offsetY = new Float32Array(N);
  Collider.radius = new Float32Array(N);
  Collider.width = new Float32Array(N);
  Collider.height = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    Transform.x[i] = 40 + rng() * (WORLD - 80);
    Transform.y[i] = 40 + rng() * (WORLD - 80);
    const circle = rng() < 0.6;
    Collider.shapeType[i] = circle ? ShapeType.Circle : ShapeType.Box;
    Collider.radius[i] = 4 + rng() * 20;
    Collider.width[i] = 8 + rng() * 40;
    Collider.height[i] = 8 + rng() * 40;
    const hw = circle ? Collider.radius[i] : Collider.width[i] * 0.5;
    const hh = circle ? Collider.radius[i] : Collider.height[i] * 0.5;
    for (let r = Math.max(0, Math.floor((Transform.y[i] - hh) / CELL)); r <= Math.min(cols - 1, Math.floor((Transform.y[i] + hh) / CELL)); r++) {
      for (let c = Math.max(0, Math.floor((Transform.x[i] - hw) / CELL)); c <= Math.min(cols - 1, Math.floor((Transform.x[i] + hw) / CELL)); c++) {
        assert.ok(Grid.addEntityToCell(r * cols + c, i));
      }
    }
  }
}

/** Every entity the ray hits within its length, nearest first: [entity, distance]. */
function bruteForce(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  const dirX = dx / len;
  const dirY = dy / len;
  const hits = [];
  for (let i = 0; i < N; i++) {
    const ex = Transform.x[i] + Collider.offsetX[i];
    const ey = Transform.y[i] + Collider.offsetY[i];
    const d = Collider.shapeType[i] === ShapeType.Circle
      ? rayCircleIntersect(x1, y1, dirX, dirY, ex, ey, Collider.radius[i], len)
      : rayBoxIntersect(x1, y1, dirX, dirY, ex, ey, Collider.width[i], Collider.height[i], len);
    if (d >= 0) hits.push([i, d]);
  }
  return hits.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

test('castAll keeps the closest maxHits hits, nearest first, with their points', () => {
  const rng = mulberry32(0xca57a11);
  setupWorld(rng);
  let multi = 0;
  for (let k = 0; k < 400; k++) {
    const x1 = rng() * WORLD;
    const y1 = rng() * WORLD;
    const x2 = rng() * WORLD;
    const y2 = rng() * WORLD;
    const maxHits = 1 + (k % 6);
    const want = bruteForce(x1, y1, x2, y2).slice(0, maxHits);
    const got = Ray.castAll(x1, y1, x2, y2, Infinity, maxHits);
    assert.equal(got.length, want.length, `ray ${k}`);
    if (want.length > 1) multi++;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    for (let h = 0; h < want.length; h++) {
      assert.equal(got[h].distance, want[h][1], `ray ${k} hit ${h}`);
      // Two entities at the same distance may come in either order; a distinct one is fixed.
      const tied = (h > 0 && want[h - 1][1] === want[h][1]) || (h + 1 < want.length && want[h + 1][1] === want[h][1]);
      if (!tied) assert.equal(got[h].entityIndex, want[h][0], `ray ${k} hit ${h}`);
      assert.equal(got[h].hitX, x1 + (dx / len) * want[h][1]);
      assert.equal(got[h].hitY, y1 + (dy / len) * want[h][1]);
    }
  }
  assert.ok(multi > 50, `only ${multi} rays hit more than one entity`);
});

test('castAll reuses its borrowed result objects', () => {
  setupWorld(mulberry32(7));
  const ray = [0, 512, WORLD, 512];
  const first = Ray.castAll(...ray, Infinity, 8);
  assert.ok(first.length >= 2, 'the ray should cross several entities');
  const objects = first.slice();
  const second = Ray.castAll(...ray, Infinity, 8);
  assert.equal(second, first);
  for (let h = 0; h < objects.length; h++) assert.equal(second[h], objects[h], `hit ${h} is a new object`);

  // A shorter result and then a longer one still hand back the same objects.
  Ray.castAll(0, 512, 1, 512, Infinity, 8);
  const third = Ray.castAll(...ray, Infinity, 8);
  for (let h = 0; h < objects.length; h++) assert.equal(third[h], objects[h]);
});

test('castAll fills a caller array in place', () => {
  setupWorld(mulberry32(9));
  const out = [];
  Ray.castAll(0, 300, WORLD, 300, Infinity, 6, 0xffffffff, out);
  assert.ok(out.length >= 1);
  const kept = out[0];
  Ray.castAll(0, 300, WORLD, 300, Infinity, 6, 0xffffffff, out);
  assert.equal(out[0], kept);
});
