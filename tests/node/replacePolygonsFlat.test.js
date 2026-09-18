import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

function initPool(entityCount = 4, maxFixtures = 32) {
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(entityCount)), entityCount);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(entityCount)), entityCount);
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(entityCount)), entityCount);
  Transform.x = new Float32Array(entityCount);
  Transform.y = new Float32Array(entityCount);
  Transform.rotC = new Float32Array(entityCount);
  Transform.rotS = new Float32Array(entityCount);
  for (let i = 0; i < entityCount; i++) {
    Collider.active[i] = 1;
    RigidBody.active[i] = 1;
    RigidBody.static[i] = 0;
    Transform.active[i] = 1;
    Transform.rotC[i] = 1;
    Transform.rotS[i] = 0;
  }
  const fSize = ColliderFixture.getBufferSize(maxFixtures, entityCount);
  ColliderFixture.initializeArrays(new SharedArrayBuffer(fSize), maxFixtures, entityCount);
  const freeList = new Uint16Array(new SharedArrayBuffer(maxFixtures * 2));
  const freeListTop = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(freeListTop, freeList, maxFixtures, 1);
  ColliderFixture.initialize(maxFixtures);
  ColliderFixture.initializeFreeList(freeList.buffer, freeListTop.buffer);
}

function pack(polys) {
  const counts = new Uint8Array(polys.length);
  let n = 0;
  for (let i = 0; i < polys.length; i++) {
    counts[i] = polys[i].length;
    n += polys[i].length * 2;
  }
  const xy = new Float32Array(n);
  let o = 0;
  for (let i = 0; i < polys.length; i++) {
    for (let v = 0; v < polys[i].length; v++) {
      xy[o++] = polys[i][v].x;
      xy[o++] = polys[i][v].y;
    }
  }
  return { xy, counts, polygonCount: polys.length };
}

const TRI_A = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 0, y: 10 },
];
const TRI_B = [
  { x: 10, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 10 },
];

test('replacePolygonsFlat writes the same fixtures and mass as replacePolygons', () => {
  initPool();
  const flat = pack([TRI_A, TRI_B]);
  assert.ok(Collider.replacePolygonsFlat(0, flat.xy, flat.counts, flat.polygonCount));
  assert.equal(Collider.fixtureCount[0], 2);
  assert.equal(Collider.polyCount[0], 0);
  assert.equal(Collider.shapeType[0], ShapeType.Polygon);
  assert.ok(Math.abs(RigidBody.mass[0] - 100) < 1e-3);
  const head = ColliderFixture.headOf(0);
  assert.notEqual(head, ColliderFixture.INVALID_INDEX);
  assert.equal(ColliderFixture.vertexX[ColliderFixture.vertBase(head)], 0);
});

test('replacePolygonsFlat rejects CW and keeps the old list', () => {
  initPool();
  const ok = pack([TRI_A]);
  assert.ok(Collider.replacePolygonsFlat(0, ok.xy, ok.counts, ok.polygonCount));
  const deg = pack([[{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }]]);
  assert.equal(Collider.replacePolygonsFlat(0, deg.xy, deg.counts, deg.polygonCount), false);
  assert.equal(Collider.fixtureCount[0], 1);
  assert.equal(ColliderFixture.lastReplaceError.code, 'cw-or-degenerate');
});

test('replacePolygonsFlat rejects vert-count and pool-exhausted', () => {
  initPool();
  const short = pack([[{ x: 0, y: 0 }]]);
  short.counts[0] = 1;
  assert.equal(Collider.replacePolygonsFlat(0, short.xy, short.counts, 1), false);
  assert.equal(ColliderFixture.lastReplaceError.code, 'vert-count');

  initPool(4, 1);
  const one = pack([TRI_A]);
  assert.ok(Collider.replacePolygonsFlat(0, one.xy, one.counts, one.polygonCount));
  const two = pack([TRI_A, TRI_B]);
  assert.equal(Collider.replacePolygonsFlat(1, two.xy, two.counts, two.polygonCount), false);
  assert.equal(ColliderFixture.lastReplaceError.code, 'pool-exhausted');
  assert.equal(Collider.fixtureCount[0], 1);
});

test('replacePolygonsFlat(0) clears extras like an empty replacePolygons', () => {
  initPool();
  const flat = pack([TRI_A, TRI_B]);
  assert.ok(Collider.replacePolygonsFlat(0, flat.xy, flat.counts, flat.polygonCount));
  assert.ok(Collider.replacePolygonsFlat(0, flat.xy, flat.counts, 0));
  assert.equal(Collider.fixtureCount[0], 0);
  assert.equal(ColliderFixture.headOf(0), ColliderFixture.INVALID_INDEX);
});

test('instance replacePolygonsFlat writes the caller buffers', () => {
  initPool();
  const flat = pack([TRI_A]);
  const c = new Collider();
  c.index = 0;
  assert.ok(c.replacePolygonsFlat(flat.xy, flat.counts, flat.polygonCount));
  assert.equal(Collider.fixtureCount[0], 1);
});
