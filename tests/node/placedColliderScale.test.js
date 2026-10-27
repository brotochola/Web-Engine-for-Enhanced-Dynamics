// A scene file's scale on a placed entity's collider (VISUAL_EDITOR_PLAN.md ED-77, scalePlacedCollider in
// gameObject.js): the shape grows as the sprite does, so a scaled platform collides as wide as it draws. A box's size,
// a circle's radius by the larger factor (it stays round), a polygon's points (its normals made again, a mirror keeping
// the winding Box2D needs), the offset and the visual range; the mass follows the area. A compound body's extra pieces
// keep their size.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { scalePlacedCollider } from '../../src/core/gameObject.js';

function initPool(entityCount = 4, maxFixtures = 16) {
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(entityCount)), entityCount);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(entityCount)), entityCount);
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(entityCount)), entityCount);
  for (let i = 0; i < entityCount; i++) {
    Collider.active[i] = 1;
    RigidBody.active[i] = 1;
    Transform.active[i] = 1;
  }
  ColliderFixture.initializeArrays(new SharedArrayBuffer(ColliderFixture.getBufferSize(maxFixtures, entityCount)), maxFixtures, entityCount);
  const freeList = new Uint16Array(new SharedArrayBuffer(maxFixtures * 2));
  const freeListTop = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(freeListTop, freeList, maxFixtures, 1);
  ColliderFixture.initialize(maxFixtures);
  ColliderFixture.initializeFreeList(freeList.buffer, freeListTop.buffer);
}

const close = (a, b) => Math.abs(a - b) < 1e-4;

test('a box: its size and offset by each factor, its visual range by the larger; the mass follows its area', () => {
  initPool();
  const collider = new Collider(0);
  collider.width = 280;
  collider.height = 44;
  collider.offsetX = 10;
  collider.offsetY = -6;
  Collider.visualRange[0] = 512;
  const mass = RigidBody.mass[0];
  scalePlacedCollider(collider, 1.5, 2);
  assert.deepEqual(
    [Collider.shapeType[0], collider.width, collider.height, collider.offsetX, collider.offsetY, Collider.visualRange[0]],
    [ShapeType.Box, 420, 88, 15, -12, 1024],
  );
  assert.ok(mass > 0 && close(RigidBody.mass[0] / mass, 3), `mass ${mass} → ${RigidBody.mass[0]}`);
});

test('a circle stays round: its radius by the larger factor; a mirror turns the offset over', () => {
  initPool();
  const collider = new Collider(1);
  collider.radius = 18;
  collider.offsetX = 4;
  collider.offsetY = 2;
  scalePlacedCollider(collider, 1.5, -2);
  assert.deepEqual([Collider.shapeType[1], collider.radius, collider.offsetX, collider.offsetY], [ShapeType.Circle, 36, 6, -4]);
});

test('a polygon: its points scaled, its normals and centroid made again; mirrored, its winding kept', () => {
  initPool();
  const at = (i) => {
    const base = Collider.polyBase(i);
    const n = Collider.polyCount[i];
    return {
      x: Array.from(Collider.polyVertexX.subarray(base, base + n)),
      y: Array.from(Collider.polyVertexY.subarray(base, base + n)),
      nx: Array.from(Collider.polyNormalX.subarray(base, base + n)),
      ny: Array.from(Collider.polyNormalY.subarray(base, base + n)),
    };
  };
  assert.ok(Collider.makePolygon(2, [0, 0, 10, 0, 0, 10]));
  scalePlacedCollider(new Collider(2), 2, 3);
  const scaled = at(2);
  assert.deepEqual([scaled.x, scaled.y], [[0, 20, 0], [0, 0, 30]]);
  // The hypotenuse (20, 0) → (0, 30): its outward normal is (30, 20) made unit.
  const len = Math.sqrt(30 * 30 + 20 * 20);
  assert.ok(close(scaled.nx[1], 30 / len) && close(scaled.ny[1], 20 / len), `normal ${scaled.nx[1]}, ${scaled.ny[1]}`);
  assert.ok(close(Collider.polyCentroidX[2], 20 / 3) && close(Collider.polyCentroidY[2], 10));
  assert.deepEqual([Collider.width[2], Collider.height[2]], [20, 30]);

  assert.ok(Collider.makePolygon(3, [0, 0, 10, 0, 0, 10]));
  scalePlacedCollider(new Collider(3), -1, 1);
  const mirrored = at(3);
  assert.deepEqual([mirrored.x, mirrored.y], [[-0, -10, -0], [10, 0, 0]], 'the points in reverse: counter-clockwise still');
  assert.equal(Collider.polyCount[3], 3, 'accepted: not left as it was');
});

test('a compound body keeps its pieces; its offset still scales', () => {
  initPool();
  const pieces = [
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ],
    [
      { x: 20, y: 0 },
      { x: 30, y: 0 },
      { x: 20, y: 10 },
    ],
  ];
  assert.ok(Collider.replacePolygons(0, pieces));
  const collider = new Collider(0);
  const before = collider.fixtureCount;
  collider.offsetX = 5;
  scalePlacedCollider(collider, 2, 2);
  assert.deepEqual([collider.fixtureCount, collider.offsetX], [before, 10]);
  assert.ok(before > 0);
});
