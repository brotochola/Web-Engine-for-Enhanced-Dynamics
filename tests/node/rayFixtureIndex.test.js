import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { Transform } from '../../src/components/transform.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { Ray } from '../../src/core/ray.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

const N = 4;

function initSoA(maxFixtures = 16) {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotC = new Float32Array(N);
  Transform.rotS = new Float32Array(N);
  Transform.rotC.fill(1);
  Transform.rotS.fill(0);
  Transform.active[0] = 1;

  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  Collider.active[0] = 1;

  const fSize = ColliderFixture.getBufferSize(maxFixtures, N);
  ColliderFixture.initializeArrays(new SharedArrayBuffer(fSize), maxFixtures, N);
  const freeList = new Uint16Array(new SharedArrayBuffer(maxFixtures * 2));
  const freeListTop = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(freeListTop, freeList, maxFixtures, 1);
  ColliderFixture.initialize(maxFixtures);
  ColliderFixture.initializeFreeList(freeList.buffer, freeListTop.buffer);
}

test('compound ray pick stores the closer ColliderFixture index', () => {
  initSoA();
  assert.ok(Collider.replacePolygons(0, [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
    [{ x: 20, y: 0 }, { x: 30, y: 0 }, { x: 20, y: 10 }],
  ]));
  const near = ColliderFixture.headOf(0);
  const far = ColliderFixture.next[near];
  assert.ok(near !== 0xffff && far !== 0xffff);

  const d = Ray._shapeRayDistance(0, -5, 3, 1, 0, 80);
  assert.ok(d >= 0);
  assert.equal(Ray._lastFixtureIndex, near);

  const d2 = Ray._shapeRayDistance(0, 40, 3, -1, 0, 80);
  assert.ok(d2 >= 0);
  assert.equal(Ray._lastFixtureIndex, far);
});

test('castWithInfo scratch includes fixtureIndex -1 on miss', () => {
  const info = Ray._tempHitInfo;
  info.fixtureIndex = 99;
  const out = { hit: false, entityIndex: -1, distance: Infinity, hitX: 0, hitY: 0, fixtureIndex: 99 };
  const r = Ray.castWithInfo(0, 0, 0, 0, 10, 0xffffffff, out);
  assert.equal(r.fixtureIndex, -1);
});
