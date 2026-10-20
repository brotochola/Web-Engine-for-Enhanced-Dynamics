import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

// B20. On a polygon, Collider.radius is the Box2D skin (a rounded border around
// the hull). Nothing cleared it when a shape became a polygon, so a circle's
// radius turned into a skin: collider.radius = 14, then makePolygon(...), gave
// a polygon with a 14 px rounded border, several times RigidBody.mass on a
// small shape.

function init(entityCount = 4, maxFixtures = 16) {
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(entityCount)), entityCount);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(entityCount)), entityCount);
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(entityCount)), entityCount);
  for (let i = 0; i < entityCount; i++) {
    Collider.active[i] = 1;
    RigidBody.active[i] = 1;
    Transform.active[i] = 1;
  }
  const fSize = ColliderFixture.getBufferSize(maxFixtures, entityCount);
  ColliderFixture.initializeArrays(new SharedArrayBuffer(fSize), maxFixtures, entityCount);
  const freeList = new Uint16Array(new SharedArrayBuffer(maxFixtures * 2));
  const freeListTop = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(freeListTop, freeList, maxFixtures, 1);
  ColliderFixture.initialize(maxFixtures);
  ColliderFixture.initializeFreeList(freeList.buffer, freeListTop.buffer);
}

const square = [0, 0, 20, 0, 20, 20, 0, 20];
const col = (i) => {
  const c = Object.create(Collider.prototype);
  c.index = i;
  return c;
};

test('a circle radius does not become a polygon skin', () => {
  init();
  const c = col(0);
  c.radius = 14;
  assert.equal(Collider.shapeType[0], ShapeType.Circle);
  assert.equal(Collider.makePolygon(0, square), true);
  assert.equal(Collider.shapeType[0], ShapeType.Polygon);
  assert.equal(Collider.radius[0], 0, 'no 14 px skin');
});

test('a skin set on a polygon survives a re-shape', () => {
  init();
  assert.equal(Collider.makePolygon(1, square), true);
  col(1).radius = 1; // the documented way to add a skin
  assert.equal(Collider.shapeType[1], ShapeType.Polygon);
  assert.equal(Collider.makePolygon(1, [0, 0, 30, 0, 30, 30, 0, 30]), true);
  assert.equal(Collider.radius[1], 1);
});

test('fixtures replacing a circle do not inherit its radius as a skin', () => {
  init();
  col(2).radius = 9;
  const xy = new Float32Array([0, 0, 10, 0, 10, 10, 0, 0, 10, 10, 0, 10]);
  const counts = new Uint8Array([3, 3]);
  assert.equal(ColliderFixture.replaceForEntityFlat(2, xy, counts, 2), true);
  assert.equal(Collider.shapeType[2], ShapeType.Polygon);
  assert.equal(Collider.radius[2], 0);

  // Fixtures on an entity that was already a skinned polygon keep the skin.
  col(2).radius = 1;
  assert.equal(ColliderFixture.replaceForEntityFlat(2, xy, counts, 2), true);
  assert.equal(Collider.radius[2], 1);
});
