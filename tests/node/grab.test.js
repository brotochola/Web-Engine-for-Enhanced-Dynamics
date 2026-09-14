import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Grab } from '../../src/components/grab.js';
import { GrabSystem } from '../../src/core/grabSystem.js';
import { pointInCollider } from '../../src/util/colliderUtils.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { Mouse } from '../../src/core/mouse.js';
import {
  createCommandRingSab,
  bindCommandRing,
  drainCommandRing,
} from '../../src/box2d/box2dCommandRing.js';

const N = 4;

function initSoA() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotC = new Float32Array(N);
  Transform.rotS = new Float32Array(N);
  Transform.rotC.fill(1);
  Transform.rotS.fill(0);

  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  RigidBody.vx = new Float32Array(N);
  RigidBody.vy = new Float32Array(N);
  RigidBody.angularVelocity = new Float32Array(N);
  RigidBody.sleeping = new Uint8Array(N);

  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);
}

function boxAt(i, x, y, w, h) {
  Transform.active[i] = 1;
  Transform.x[i] = x;
  Transform.y[i] = y;
  Collider.active[i] = 1;
  Collider.shapeType[i] = ShapeType.Box;
  Collider.width[i] = w;
  Collider.height[i] = h;
}

class GrabBox extends GameObject {}
GrabBox.components = [RigidBody, Collider, Grab];

class OtherBox extends GameObject {}
OtherBox.components = [RigidBody, Collider];

class ColOnly extends GameObject {}
ColOnly.components = [Collider];

function bindActive(EntityClass, indices) {
  const list = new Uint16Array(1 + indices.length);
  list[0] = indices.length;
  for (let n = 0; n < indices.length; n++) list[1 + n] = indices[n];
  EntityClass._activeList = list;
}

function makeScene(views) {
  GameObject._assignComponentClassMap(GrabBox);
  GameObject._assignComponentClassMap(OtherBox);
  GameObject._assignComponentClassMap(ColOnly);
  bindActive(GrabBox, [0]);
  bindActive(OtherBox, [1]);
  return {
    _anyGrabType: true,
    grabByType: [1, 0],
    registeredClasses: [
      { class: GrabBox, entityType: 0 },
      { class: OtherBox, entityType: 1 },
    ],
    getEntityView(index) {
      return views[index];
    },
  };
}

function makeView(index, has) {
  const go = Object.create(GameObject.prototype);
  go.index = index;
  go._hasComponents = has;
  return go;
}

afterEach(() => {
  GrabSystem.reset();
  Mouse.isDebugToolActive = false;
  bindCommandRing(null);
});

test('pointInCollider circle / rotated box / miss', () => {
  initSoA();
  Transform.active[0] = 1;
  Transform.x[0] = 0;
  Transform.y[0] = 0;
  Collider.active[0] = 1;
  Collider.shapeType[0] = ShapeType.Circle;
  Collider.radius[0] = 10;
  assert.equal(pointInCollider(0, 0, 0), true);
  assert.equal(pointInCollider(0, 6, 6), true);
  assert.equal(pointInCollider(0, 10, 10), false);

  Collider.shapeType[0] = ShapeType.Box;
  Collider.width[0] = 20;
  Collider.height[0] = 10;
  Transform.rotC[0] = 0;
  Transform.rotS[0] = 1;
  assert.equal(pointInCollider(0, 0, 8), true);
  assert.equal(pointInCollider(0, 8, 0), false);
});

test('pointInCollider convex polygon', () => {
  initSoA();
  Transform.active[0] = 1;
  Collider.active[0] = 1;
  Collider.shapeType[0] = ShapeType.Polygon;
  Collider.polyCount[0] = 3;
  const base = 0;
  Collider.polyVertexX[base] = 0;
  Collider.polyVertexY[base] = 0;
  Collider.polyVertexX[base + 1] = 10;
  Collider.polyVertexY[base + 1] = 0;
  Collider.polyVertexX[base + 2] = 0;
  Collider.polyVertexY[base + 2] = 10;
  assert.equal(pointInCollider(0, 2, 2), true);
  assert.equal(pointInCollider(0, 20, 20), false);
});

test('grabber picks only grabByType indices', () => {
  initSoA();
  Mouse.initialize(new Float32Array(13));
  boxAt(0, 0, 0, 40, 40);
  boxAt(1, 0, 0, 40, 40);
  RigidBody.active[0] = 1;
  RigidBody.active[1] = 1;
  Mouse.x = 0;
  Mouse.y = 0;
  Mouse.isButton0Down = true;

  const views = {
    0: makeView(0, { RigidBody: true, Collider: true }),
    1: makeView(1, { RigidBody: true, Collider: true }),
  };
  GrabSystem.update(makeScene(views));
  assert.equal(GrabSystem._dragIdx, 0);
});

test('RigidBody.static skipped', () => {
  initSoA();
  Mouse.initialize(new Float32Array(13));
  boxAt(0, 0, 0, 40, 40);
  RigidBody.active[0] = 1;
  RigidBody.static[0] = 1;
  Mouse.x = 0;
  Mouse.y = 0;
  Mouse.isButton0Down = true;
  GrabSystem.update(makeScene({ 0: makeView(0, { RigidBody: true, Collider: true }) }));
  assert.equal(GrabSystem._dragIdx, null);
});

test('collider-only: Transform moves; no toss', () => {
  initSoA();
  Mouse.initialize(new Float32Array(13));
  boxAt(0, 0, 0, 40, 40);
  RigidBody.active[0] = 0;
  Mouse.x = 0;
  Mouse.y = 0;
  Mouse.isButton0Down = true;
  const view = makeView(0, { Collider: true });
  const scene = makeScene({ 0: view });
  GrabSystem.update(scene);
  assert.equal(GrabSystem._dragIdx, 0);

  Mouse.x = 50;
  Mouse.y = 10;
  GrabSystem.update(scene);
  assert.equal(Transform.x[0], 50);
  assert.equal(Transform.y[0], 10);

  Mouse.isButton0Down = false;
  GrabSystem.update(scene);
  assert.equal(GrabSystem._dragIdx, null);
  assert.equal(RigidBody.vx[0], 0);
  assert.equal(RigidBody.vy[0], 0);
});

test('dynamic RB+Collider: release writes vx/vy', () => {
  initSoA();
  Mouse.initialize(new Float32Array(13));
  boxAt(0, 0, 0, 40, 40);
  RigidBody.active[0] = 1;
  RigidBody.static[0] = 0;
  Mouse.x = 0;
  Mouse.y = 0;
  Mouse.isButton0Down = true;
  const view = makeView(0, { RigidBody: true, Collider: true });
  const scene = makeScene({ 0: view });
  GrabSystem.update(scene);
  assert.equal(GrabSystem._dragIdx, 0);

  Mouse.x = 30;
  Mouse.y = 0;
  GrabSystem.update(scene);
  Mouse.isButton0Down = false;
  GrabSystem.update(scene);
  assert.equal(GrabSystem._dragIdx, null);
  assert.equal(RigidBody.vx[0], 1800);
  assert.equal(RigidBody.vy[0], 0);
});

test('collider-only setPosition enqueues SET_TRANSFORM', () => {
  initSoA();
  const sab = createCommandRingSab(64);
  bindCommandRing(sab);
  GameObject._assignComponentClassMap(ColOnly);
  const go = new ColOnly(0, {}, null, { view: true });
  Transform.x[0] = 0;
  Transform.y[0] = 0;
  go.setPosition(12, 34);
  assert.equal(Transform.x[0], 12);
  assert.equal(Transform.y[0], 34);

  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  let seen = 0;
  drainCommandRing(i32, f32, {
    setTransform(entity, x, y) {
      seen++;
      assert.equal(entity, 0);
      assert.equal(x, 12);
      assert.equal(y, 34);
    },
  });
  assert.equal(seen, 1);
});
