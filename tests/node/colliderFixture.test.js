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

test('cheap OBB contains every rotated fixture vertex', () => {
  initPool();
  const ang = 0.7;
  Transform.x[0] = 40;
  Transform.y[0] = 30;
  Transform.rotC[0] = Math.cos(ang);
  Transform.rotS[0] = Math.sin(ang);
  assert.ok(Collider.replacePolygons(0, [TRI_A, TRI_B]));
  const b = getColliderBounds(0, _boundsResult);
  const c = Transform.rotC[0];
  const s = Transform.rotS[0];
  const ox = Transform.x[0];
  const oy = Transform.y[0];
  ColliderFixture.forEach(0, (fi) => {
    const count = ColliderFixture.vertCount[fi] | 0;
    const base = ColliderFixture.vertBase(fi);
    for (let i = 0; i < count; i++) {
      const wx = ox + c * ColliderFixture.vertexX[base + i] - s * ColliderFixture.vertexY[base + i];
      const wy = oy + s * ColliderFixture.vertexX[base + i] + c * ColliderFixture.vertexY[base + i];
      assert.ok(wx >= b.posX - b.halfW - 1e-4, `x ${wx} left of ${b.posX - b.halfW}`);
      assert.ok(wx <= b.posX + b.halfW + 1e-4, `x ${wx} right of ${b.posX + b.halfW}`);
      assert.ok(wy >= b.posY - b.halfH - 1e-4, `y ${wy} above ${b.posY - b.halfH}`);
      assert.ok(wy <= b.posY + b.halfH + 1e-4, `y ${wy} below ${b.posY + b.halfH}`);
    }
  });
  const localHitX = 18;
  const localHitY = 2;
  const hitX = ox + c * localHitX - s * localHitY;
  const hitY = oy + s * localHitX + c * localHitY;
  assert.equal(pointInCollider(0, hitX, hitY), true);
  assert.equal(pointInCollider(0, 50, 50), false);
});

test('replacePolygons rejects a CW / degenerate poly and keeps the old list', () => {
  initPool();
  assert.ok(Collider.replacePolygons(0, [TRI_A]));
  assert.equal(Collider.replacePolygons(0, [[{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }]]), false);
  assert.equal(Collider.fixtureCount[0], 1);
});

test('replacePolygons swaps new fixtures then frees old', () => {
  initPool();
  assert.ok(Collider.replacePolygons(0, [TRI_A]));
  const oldHead = ColliderFixture.headOf(0);
  assert.ok(Collider.replacePolygons(0, [TRI_A, TRI_B]));
  assert.equal(Collider.fixtureCount[0], 2);
  assert.notEqual(ColliderFixture.headOf(0), oldHead);
  assert.equal(ColliderFixture.active[oldHead], 0);
});

test('replacePolygons acquire miss keeps old fixtures', () => {
  initPool(4, 2);
  assert.ok(Collider.replacePolygons(0, [TRI_A, TRI_B]));
  assert.equal(Collider.replacePolygons(0, [TRI_A, TRI_B, TRI_A]), false);
  assert.equal(Collider.fixtureCount[0], 2);
});

test('replacePolygons writes lastReplaceError without allocating on success', () => {
  initPool();
  assert.ok(Collider.replacePolygons(0, [TRI_A]));
  const err = ColliderFixture.lastReplaceError;
  assert.equal(Collider.replacePolygons(0, [[{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }]]), false);
  assert.equal(err.code, 'cw-or-degenerate');
  assert.equal(err.entityIndex, 0);
  assert.equal(err.polyIndex, 0);
  assert.equal(Collider.replacePolygons(0, [[{ x: 0, y: 0 }]]), false);
  assert.equal(err.code, 'vert-count');
  initPool(4, 1);
  assert.ok(Collider.replacePolygons(0, [TRI_A]));
  assert.equal(Collider.replacePolygons(1, [TRI_A, TRI_B]), false);
  assert.equal(err.code, 'pool-exhausted');
});

test('clearFixtures leaves leftover AABB; mass is not invented from width×height', () => {
  initPool();
  assert.ok(Collider.replacePolygons(0, [TRI_A, TRI_B]));
  const leftoverW = Collider.width[0];
  const leftoverH = Collider.height[0];
  assert.ok(leftoverW > 0 && leftoverH > 0);
  Collider.clearFixtures(0);
  assert.equal(Collider.fixtureCount[0], 0);
  assert.equal(Collider.polyCount[0], 0);
  assert.equal(Collider.shapeType[0], ShapeType.Polygon);
  assert.equal(Collider.width[0], leftoverW);
  assert.equal(Collider.height[0], leftoverH);
  assert.ok(Math.abs(RigidBody.mass[0] - leftoverW * leftoverH) > 1);
});

test('forEach stops when the visitor returns false', () => {
  initPool();
  assert.ok(Collider.replacePolygons(0, [TRI_A, TRI_B]));
  const seen = [];
  ColliderFixture.forEach(0, (idx) => {
    seen.push(idx);
    return false;
  });
  assert.equal(seen.length, 1);
});

test('inertiaAboutOrigin is one walk about body origin', () => {
  initPool();
  assert.ok(Collider.replacePolygons(0, [TRI_A, TRI_B]));
  const mass = RigidBody.mass[0];
  const I = ColliderFixture.inertiaAboutOrigin(0, mass);
  let areaTwice = 0;
  let rawI = 0;
  for (const tri of [TRI_A, TRI_B]) {
    for (let i = 0; i < 3; i++) {
      const j = i + 1 < 3 ? i + 1 : 0;
      const ax = tri[i].x;
      const ay = tri[i].y;
      const bx = tri[j].x;
      const by = tri[j].y;
      const cross = ax * by - ay * bx;
      areaTwice += cross;
      rawI += cross * (ax * ax + ay * ay + ax * bx + ay * by + bx * bx + by * by);
    }
  }
  const expected = (mass / (areaTwice * 0.5)) * (rawI / 12);
  assert.ok(Math.abs(I - expected) < 1e-6);
  assert.ok(I > 0);
});
