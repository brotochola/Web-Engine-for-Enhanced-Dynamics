import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { PhysicsDebugRenderer } from '../../src/core/debug/rendering/physicsDebugRenderer.js';
import { ShapeType } from '../../src/util/configDefaults.js';
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

  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);

  const fSize = ColliderFixture.getBufferSize(maxFixtures, N);
  ColliderFixture.initializeArrays(new SharedArrayBuffer(fSize), maxFixtures, N);
  const freeList = new Uint16Array(new SharedArrayBuffer(maxFixtures * 2));
  const freeListTop = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(freeListTop, freeList, maxFixtures, 1);
  ColliderFixture.initialize(maxFixtures);
  ColliderFixture.initializeFreeList(freeList.buffer, freeListTop.buffer);

  Transform.active[0] = 1;
  Collider.active[0] = 1;
  RigidBody.active[0] = 1;
}

function mockCtx() {
  let strokes = 0;
  return {
    get strokes() { return strokes; },
    lastRect: null,
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    stroke() { strokes++; },
    strokeRect(x, y, w, h) { this.lastRect = { x, y, w, h }; },
    fillRect() {},
    fillText() {},
    measureText() { return { width: 10 }; },
    fill() {},
    arc() {},
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
  };
}

test('collider debug cull uses fixture AABB when SpriteRenderer.isItOnScreen is 0', () => {
  initSoA();
  const dbg = new PhysicsDebugRenderer();
  Collider.width[0] = 800;
  Collider.height[0] = 800;
  Collider.polyCentroidX[0] = 400;
  Collider.polyCentroidY[0] = 400;
  SpriteRenderer.isItOnScreen[0] = 0;

  // Origin 0,0; camera looks at 400,400 (200×200). Old origin±100 cull misses.
  assert.equal(dbg._colliderDebugInView(0, 0, 0, 300, 700, 300, 700), true);
  Collider.width[0] = 10;
  Collider.height[0] = 10;
  Collider.polyCentroidX[0] = 0;
  Collider.polyCentroidY[0] = 0;
  assert.equal(dbg._colliderDebugInView(0, 0, 0, 300, 700, 300, 700), false);
  SpriteRenderer.isItOnScreen[0] = 1;
  assert.equal(dbg._colliderDebugInView(0, 0, 0, 300, 700, 300, 700), true);
});

test('SHOW_COLLIDERS strokes ColliderFixture polys even if shapeType is Box', () => {
  initSoA();
  const dbg = new PhysicsDebugRenderer();
  assert.ok(Collider.replacePolygons(0, [
    [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 0, y: 800 }],
    [{ x: 800, y: 0 }, { x: 800, y: 800 }, { x: 0, y: 800 }],
  ]));
  Collider.shapeType[0] = ShapeType.Box;
  const ctx = mockCtx();
  const canvas = { width: 200, height: 200 };
  // Origin 0,0; look at the far half of the island (old origin±100 cull drops this).
  const camera = { x: 400, y: 400 };
  dbg.drawColliders(ctx, canvas, camera, 1, null, null);
  assert.equal(ctx.strokes, 2);
});

test('drawSelectedEntity strokes collider AABB, not the 20x20 sprite fallback', () => {
  initSoA();
  const dbg = new PhysicsDebugRenderer();
  assert.ok(Collider.replacePolygons(0, [
    [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 0, y: 800 }],
    [{ x: 800, y: 0 }, { x: 800, y: 800 }, { x: 0, y: 800 }],
  ]));
  const ctx = mockCtx();
  const flags = { getSelectedEntity() { return 0; } };
  dbg.drawSelectedEntity(ctx, { width: 900, height: 900 }, { x: 0, y: 0 }, 1, flags, null);
  assert.ok(ctx.lastRect);
  assert.ok(ctx.lastRect.w > 100, `AABB width should follow fixtures, got ${ctx.lastRect.w}`);
  assert.ok(ctx.lastRect.h > 100, `AABB height should follow fixtures, got ${ctx.lastRect.h}`);
});

test('collider debug uses Transform when pose SAB is still zeros', () => {
  initSoA();
  const dbg = new PhysicsDebugRenderer();
  Transform.x[0] = 400;
  Transform.y[0] = 400;
  const pose = {
    x: new Float32Array(N),
    y: new Float32Array(N),
    rotC: new Float32Array(N),
    rotS: new Float32Array(N),
  };
  const out = { x: 0, y: 0 };
  dbg._worldXY(0, pose, out);
  assert.equal(out.x, 400);
  assert.equal(out.y, 400);
  pose.rotC[0] = 1;
  pose.x[0] = 12;
  pose.y[0] = 34;
  dbg._worldXY(0, pose, out);
  assert.equal(out.x, 12);
  assert.equal(out.y, 34);
});
