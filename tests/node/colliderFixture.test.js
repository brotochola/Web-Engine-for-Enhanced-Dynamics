import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { pointInCollider, getColliderBounds, _boundsResult } from '../../src/util/colliderUtils.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

function initPool(entityCount = 4, maxFixtures = 32) {
  const cSize = Collider.getBufferSize(entityCount);
  const rSize = RigidBody.getBufferSize(entityCount);
  const tSize = Transform.getBufferSize(entityCount);
  Collider.initializeArrays(new SharedArrayBuffer(cSize), entityCount);
  RigidBody.initializeArrays(new SharedArrayBuffer(rSize), entityCount);
  Transform.initializeArrays(new SharedArrayBuffer(tSize), entityCount);
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

test('replacePolygons writes two fixtures and mass is the sum', () => {
  initPool();
  assert.ok(Collider.replacePolygons(0, [TRI_A, TRI_B]));
  assert.equal(Collider.fixtureCount[0], 2);
  assert.equal(Collider.polyCount[0], 0);
  assert.equal(Collider.shapeType[0], ShapeType.Polygon);
  const areaA = 50;
  const areaB = 50;
  assert.ok(Math.abs(RigidBody.mass[0] - (areaA + areaB)) < 1e-3);
});

test('clearFixtures drops the pool list', () => {
  initPool();
  assert.ok(Collider.replacePolygons(0, [TRI_A, TRI_B]));
  Collider.clearFixtures(0);
  assert.equal(Collider.fixtureCount[0], 0);
  assert.equal(ColliderFixture.headOf(0), ColliderFixture.INVALID_INDEX);
});

test('getColliderBounds / pointInCollider see the second fixture', () => {
  initPool();
  Transform.x[0] = 0;
  Transform.y[0] = 0;
  assert.ok(Collider.replacePolygons(0, [TRI_A, TRI_B]));
  const b = getColliderBounds(0, _boundsResult);
  assert.ok(b.halfW >= 9);
  assert.ok(pointInCollider(0, 18, 2));
  assert.equal(pointInCollider(0, 50, 50), false);
});

test('replacePolygons rejects a CW / degenerate poly and keeps the old list', () => {
  initPool();
  assert.ok(Collider.replacePolygons(0, [TRI_A]));
  assert.equal(Collider.replacePolygons(0, [[{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }]]), false);
  assert.equal(Collider.fixtureCount[0], 1);
});
