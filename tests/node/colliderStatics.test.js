// E-533: every Collider setter with a side effect is a static by entity index (Collider.setRadius(i, r)), and the
// instance setter (this.collider.radius = r) calls it. Each static's effects: the columns it writes, the body marks
// it publishes (markBodyDirty), the mass it syncs (RigidBody.syncMassFromCollider) and the bodies it makes again
// (remakeBody); and the facade and the static leave twin entities the same.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { BODY_DIRTY, bindBodySyncBuffers } from '../../src/box2d/box2dBodySync.js';

const N = 4;
/** The twins: FACADE is written through a Collider instance, STATIC through Collider's statics. */
const FACADE = 0;
const STATIC = 1;
const SHEET = 2;
const ANIM = 5;

const COLLIDER_COLUMNS = [
  'active', 'shapeType', 'offsetX', 'offsetY', 'radius', 'width', 'height', 'isTrigger', 'collisionLayer',
  'collisionMask', 'collisionGroupIndex', 'friction', 'restitution', 'enableHitEvents',
];
const BODY_COLUMNS = ['mass', 'invMass', 'inertia', 'invInertia', 'static'];

/** N live dynamic bodies with circle colliders of radius 0 and sprites; the body-sync buffers bound, all clean. */
function world() {
  for (const C of [Transform, RigidBody, Collider, SpriteRenderer]) {
    C.initializeArrays(new SharedArrayBuffer(C.getBufferSize(N)), N);
  }
  const sync = bindBodySyncBuffers({
    bodyDirtyFlags: new SharedArrayBuffer(N * 4),
    bodyDirtyWords: new SharedArrayBuffer(4),
    bodyGeneration: new SharedArrayBuffer(N * 4),
  });
  for (let i = 0; i < N; i++) {
    Transform.active[i] = 1;
    RigidBody.active[i] = 1;
    Collider.active[i] = 1;
    Collider.shapeType[i] = ShapeType.Box;
    SpriteRenderer.active[i] = 1;
    SpriteRenderer.spritesheetId[i] = SHEET;
    SpriteRenderer.animationState[i] = ANIM;
    SpriteRenderer.scaleX[i] = 1;
    SpriteRenderer.scaleY[i] = 1;
    SpriteRenderer.anchorX[i] = 0.5;
    SpriteRenderer.anchorY[i] = 0.5;
  }
  const w = {
    flags: sync.dirtyFlags,
    words: sync.dirtyWords,
    generation: sync.generation,
    clean() {
      w.flags.fill(0);
      w.words.fill(0);
    },
  };
  return w;
}

const facade = (i) => new Collider(i);

/** Every column a collider setter can reach, for entity i. */
function stateOf(w, i) {
  const out = {};
  for (const k of COLLIDER_COLUMNS) out[`Collider.${k}`] = Collider[k][i];
  for (const k of BODY_COLUMNS) if (RigidBody[k]) out[`RigidBody.${k}`] = RigidBody[k][i];
  out.dirtyFlags = w.flags[i];
  out.dirtyBit = (w.words[0] >>> i) & 1;
  out.generation = w.generation[i];
  return out;
}

/** The twins agree after `write(viaFacade, index)` on each. */
function assertTwins(w, label, write) {
  write(true, FACADE);
  write(false, STATIC);
  assert.deepEqual(stateOf(w, STATIC), stateOf(w, FACADE), label);
}

function withFrame(fw, fh, fn) {
  const real = SpriteSheetRegistry.getFrameDimensionsById;
  SpriteSheetRegistry._frameSizeCache.clear();
  SpriteSheetRegistry.getFrameDimensionsById = (sheet, anim) => (sheet === SHEET && anim === ANIM ? { w: fw, h: fh } : null);
  try {
    fn();
  } finally {
    SpriteSheetRegistry.getFrameDimensionsById = real;
    SpriteSheetRegistry._frameSizeCache.clear();
  }
}

function warningsOf(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (m) => lines.push(String(m));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

test.afterEach(() => bindBodySyncBuffers(null));

test('setActive: the column, LIFECYCLE | GEOMETRY | MASS; the same value marks nothing', () => {
  const w = world();
  w.clean();
  Collider.setActive(2, false);
  assert.equal(Collider.active[2], 0);
  assert.equal(w.flags[2], BODY_DIRTY.LIFECYCLE | BODY_DIRTY.GEOMETRY | BODY_DIRTY.MASS);
  assert.equal((w.words[0] >>> 2) & 1, 1, 'published');
  w.clean();
  Collider.setActive(2, 0);
  assert.equal(w.flags[2], 0, 'already off');
  Collider.setActive(2, 'yes');
  assert.equal(Collider.active[2], 1);
});

test('setShapeType: the column as an integer, the mass synced from the new shape, GEOMETRY', () => {
  const w = world();
  Collider.radius[2] = 10;
  w.clean();
  Collider.setShapeType(2, ShapeType.Circle + 0.7);
  assert.equal(Collider.shapeType[2], ShapeType.Circle);
  assert.ok(Math.abs(RigidBody.mass[2] - Math.PI * 100) < 1e-3, 'π r²');
  assert.equal(w.flags[2], BODY_DIRTY.GEOMETRY);
});

test('setOffsetX, setOffsetY, setOffset: numbers (NaN and junk are 0), GEOMETRY', () => {
  const w = world();
  w.clean();
  Collider.setOffsetX(2, '3');
  Collider.setOffsetY(2, -4.5);
  assert.deepEqual([Collider.offsetX[2], Collider.offsetY[2]], [3, -4.5]);
  assert.equal(w.flags[2], BODY_DIRTY.GEOMETRY);
  w.clean();
  Collider.setOffset(3, 7, NaN);
  assert.deepEqual([Collider.offsetX[3], Collider.offsetY[3]], [7, 0]);
  assert.equal(w.flags[3], BODY_DIRTY.GEOMETRY);
  Collider.setOffset(3, undefined, 2);
  assert.deepEqual([Collider.offsetX[3], Collider.offsetY[3]], [0, 2]);
});

test('setRadius: a box becomes a circle, a polygon and a chain keep their shape, 0 switches nothing; mass, GEOMETRY', () => {
  const w = world();
  w.clean();
  Collider.setRadius(2, 10);
  assert.equal(Collider.radius[2], 10);
  assert.equal(Collider.shapeType[2], ShapeType.Circle);
  assert.ok(Math.abs(RigidBody.mass[2] - Math.PI * 100) < 1e-3);
  assert.ok(Math.abs(RigidBody.invMass[2] - 1 / (Math.PI * 100)) < 1e-9);
  assert.equal(w.flags[2], BODY_DIRTY.GEOMETRY);

  Collider.shapeType[3] = ShapeType.Box;
  Collider.setRadius(3, 0);
  assert.equal(Collider.shapeType[3], ShapeType.Box, 'a zero radius is no circle');
  for (const kept of [ShapeType.Polygon, ShapeType.Chain]) {
    Collider.shapeType[3] = kept;
    Collider.setRadius(3, 2);
    assert.equal(Collider.shapeType[3], kept);
    assert.equal(Collider.radius[3], 2, 'a polygon skin');
  }
});

test('setWidth, setHeight: a circle becomes a box, polygons and chains stay; the mass once both sides are set', () => {
  const w = world();
  Collider.shapeType[2] = ShapeType.Circle;
  RigidBody.mass[2] = 5;
  w.clean();
  Collider.setWidth(2, 8);
  assert.equal(Collider.shapeType[2], ShapeType.Box);
  assert.equal(RigidBody.mass[2], 5, 'no height yet: the mass it had');
  assert.equal(w.flags[2], BODY_DIRTY.GEOMETRY);
  Collider.setHeight(2, 4);
  assert.equal(Collider.height[2], 4);
  assert.equal(RigidBody.mass[2], 32);
  assert.equal(RigidBody.invMass[2], 1 / 32);
  for (const kept of [ShapeType.Polygon, ShapeType.Chain]) {
    Collider.shapeType[3] = kept;
    Collider.setWidth(3, 5);
    Collider.setHeight(3, 5);
    assert.equal(Collider.shapeType[3], kept);
  }
  Collider.shapeType[3] = ShapeType.Circle;
  Collider.setHeight(3, 0);
  assert.equal(Collider.shapeType[3], ShapeType.Circle, 'a zero side is no box');
});

test('setSize: both sides, one box, the mass from the final box, GEOMETRY; the same end as setWidth + setHeight', () => {
  const w = world();
  for (const i of [2, 3]) Collider.shapeType[i] = ShapeType.Circle;
  w.clean();
  Collider.setSize(2, 6, 3);
  Collider.setWidth(3, 6);
  Collider.setHeight(3, 3);
  assert.deepEqual(stateOf(w, 2), stateOf(w, 3));
  assert.equal(Collider.shapeType[2], ShapeType.Box);
  assert.equal(RigidBody.mass[2], 18);
  assert.equal(w.flags[2], BODY_DIRTY.GEOMETRY);
  Collider.shapeType[2] = ShapeType.Circle;
  Collider.setSize(2, 0, 2);
  assert.equal(Collider.shapeType[2], ShapeType.Box, 'one positive side makes a box, as setHeight does');
  Collider.shapeType[2] = ShapeType.Polygon;
  Collider.setSize(2, 4, 4);
  assert.equal(Collider.shapeType[2], ShapeType.Polygon);
});

test('collision filter statics: layer & 31, mask, group | 0, add/remove a layer, the query; FILTER', () => {
  const w = world();
  w.clean();
  Collider.setCollisionLayer(2, 33);
  assert.equal(Collider.collisionLayer[2], 1);
  assert.equal(w.flags[2], BODY_DIRTY.FILTER);
  w.clean();
  Collider.setCollisionMask(2, 0b1010);
  assert.equal(Collider.collisionMask[2], 0b1010);
  assert.equal(w.flags[2], BODY_DIRTY.FILTER);
  w.clean();
  Collider.setCollisionGroupIndex(2, -3.9);
  assert.equal(Collider.collisionGroupIndex[2], -3);
  assert.equal(w.flags[2], BODY_DIRTY.FILTER);
  w.clean();
  Collider.addLayerToMask(2, 0);
  assert.equal(Collider.collisionMask[2], 0b1011);
  assert.equal(w.flags[2], BODY_DIRTY.FILTER);
  w.clean();
  Collider.removeLayerFromMask(2, 33); // layer 1
  assert.equal(Collider.collisionMask[2], 0b1001);
  assert.equal(w.flags[2], BODY_DIRTY.FILTER);
  Collider.addLayerToMask(2, 31);
  assert.equal(Collider.collisionMask[2], (0b1001 | (1 << 31)) >>> 0);
  assert.equal(Collider.collidesWithLayer(2, 31), true);
  assert.equal(Collider.collidesWithLayer(2, 3), true);
  assert.equal(Collider.collidesWithLayer(2, 1), false);
  w.clean();
  Collider.collidesWithLayer(2, 3);
  assert.equal(w.flags[2], 0, 'a query marks nothing');
});

test('setFriction, setRestitution: 0 or more (junk is 0), FRICTION', () => {
  const w = world();
  w.clean();
  Collider.setFriction(2, 0.25);
  Collider.setRestitution(3, '0.5');
  assert.equal(Collider.friction[2], 0.25);
  assert.equal(Collider.restitution[3], 0.5);
  assert.equal(w.flags[2], BODY_DIRTY.FRICTION);
  assert.equal(w.flags[3], BODY_DIRTY.FRICTION);
  Collider.setFriction(2, -1);
  Collider.setRestitution(3, 'no');
  assert.equal(Collider.friction[2], 0);
  assert.equal(Collider.restitution[3], 0);
});

test('setIsTrigger, setEnableHitEvents: a live body is made again, one not live is marked; the same value does nothing', () => {
  const w = world();
  Transform.active[3] = 0; // not live yet: its creation reads the flags
  for (const set of [Collider.setIsTrigger, Collider.setEnableHitEvents]) {
    const column = set === Collider.setIsTrigger ? Collider.isTrigger : Collider.enableHitEvents;
    w.clean();
    const gen2 = w.generation[2];
    set(2, true);
    assert.equal(column[2], 1);
    assert.equal(w.generation[2], gen2 + 1, 'a new generation');
    assert.equal(w.flags[2] & BODY_DIRTY.LIFECYCLE, BODY_DIRTY.LIFECYCLE);
    w.clean();
    set(2, 1);
    assert.equal(w.flags[2], 0, 'the same value');
    assert.equal(w.generation[2], gen2 + 1);

    const gen3 = w.generation[3];
    set(3, 'on');
    assert.equal(column[3], 1);
    assert.equal(w.generation[3], gen3, 'not live: no new generation');
    assert.equal(w.flags[3], BODY_DIRTY.LIFECYCLE, 'marked for its creation');
  }
});

test('fitToSprite(i, factor): a box takes the drawn size and the anchor offset; a circle half the smaller side', () => {
  const w = world();
  withFrame(8, 4, () => {
    SpriteRenderer.scaleX[2] = -4; // flipped, 32 px wide
    SpriteRenderer.scaleY[2] = 2;
    SpriteRenderer.anchorX[2] = 0;
    SpriteRenderer.anchorY[2] = 1;
    w.clean();
    assert.equal(Collider.fitToSprite(2), true);
    assert.deepEqual([Collider.width[2], Collider.height[2]], [32, 8]);
    assert.deepEqual([Collider.offsetX[2], Collider.offsetY[2]], [-16, -4]);
    assert.equal(RigidBody.mass[2], 256);
    assert.equal(w.flags[2], BODY_DIRTY.GEOMETRY);

    Collider.shapeType[3] = ShapeType.Circle;
    SpriteRenderer.scaleX[3] = 4;
    SpriteRenderer.scaleY[3] = 4; // 32 × 16
    assert.equal(Collider.fitToSprite(3, 0.5), true);
    assert.equal(Collider.radius[3], 4);
    assert.equal(Collider.shapeType[3], ShapeType.Circle);
  });
});

test('fitToSprite(i): no sprite, an unknown frame, a polygon or a chain fit nothing', () => {
  const w = world();
  withFrame(8, 4, () => {
    SpriteRenderer.active[2] = 0;
    w.clean();
    assert.equal(Collider.fitToSprite(2), false);
    SpriteRenderer.active[2] = 1;
    SpriteRenderer.animationState[2] = ANIM + 1;
    assert.equal(Collider.fitToSprite(2), false);
    assert.equal(w.flags[2], 0);
    assert.equal(Collider.width[2], 0);
    for (const kept of [ShapeType.Polygon, ShapeType.Chain]) {
      Collider.shapeType[3] = kept;
      const lines = warningsOf(() => assert.equal(Collider.fitToSprite(3), false));
      assert.deepEqual(lines, ['Collider.fitToSprite: polygon and chain colliders keep their shape']);
    }
  });
});

test('the facade and the static leave twin entities the same, setter by setter', () => {
  const w = world();
  const ops = [
    ['active off', (f, i) => (f ? (facade(i).active = false) : Collider.setActive(i, false))],
    ['active on', (f, i) => (f ? (facade(i).active = 1) : Collider.setActive(i, 1))],
    ['shapeType', (f, i) => (f ? (facade(i).shapeType = ShapeType.Circle) : Collider.setShapeType(i, ShapeType.Circle))],
    ['radius', (f, i) => (f ? (facade(i).radius = 12.5) : Collider.setRadius(i, 12.5))],
    ['width', (f, i) => (f ? (facade(i).width = 10) : Collider.setWidth(i, 10))],
    ['height', (f, i) => (f ? (facade(i).height = 6) : Collider.setHeight(i, 6))],
    ['radius on a box', (f, i) => (f ? (facade(i).radius = 3) : Collider.setRadius(i, 3))],
    ['offsetX', (f, i) => (f ? (facade(i).offsetX = '2.5') : Collider.setOffsetX(i, '2.5'))],
    ['offsetY', (f, i) => (f ? (facade(i).offsetY = NaN) : Collider.setOffsetY(i, NaN))],
    ['collisionLayer', (f, i) => (f ? (facade(i).collisionLayer = 37) : Collider.setCollisionLayer(i, 37))],
    ['collisionMask', (f, i) => (f ? (facade(i).collisionMask = 0xf0) : Collider.setCollisionMask(i, 0xf0))],
    ['collisionGroupIndex', (f, i) => (f ? (facade(i).collisionGroupIndex = -2) : Collider.setCollisionGroupIndex(i, -2))],
    ['addLayerToMask', (f, i) => (f ? facade(i).addLayerToMask(1) : Collider.addLayerToMask(i, 1))],
    ['removeLayerFromMask', (f, i) => (f ? facade(i).removeLayerFromMask(4) : Collider.removeLayerFromMask(i, 4))],
    ['friction', (f, i) => (f ? (facade(i).friction = -0.5) : Collider.setFriction(i, -0.5))],
    ['restitution', (f, i) => (f ? (facade(i).restitution = 0.75) : Collider.setRestitution(i, 0.75))],
    ['isTrigger', (f, i) => (f ? (facade(i).isTrigger = true) : Collider.setIsTrigger(i, true))],
    ['isTrigger again', (f, i) => (f ? (facade(i).isTrigger = 1) : Collider.setIsTrigger(i, 1))],
    ['enableHitEvents', (f, i) => (f ? (facade(i).enableHitEvents = 1) : Collider.setEnableHitEvents(i, 1))],
  ];
  for (const [label, write] of ops) {
    w.clean();
    assertTwins(w, label, write);
  }
  for (const layer of [0, 1, 4, 5, 7, 31]) {
    assert.equal(facade(FACADE).collidesWithLayer(layer), Collider.collidesWithLayer(STATIC, layer), `layer ${layer}`);
  }
});

test('the facade and the static agree on fitToSprite, box and circle', () => {
  const w = world();
  withFrame(10, 6, () => {
    for (const i of [FACADE, STATIC]) {
      SpriteRenderer.scaleX[i] = 2;
      SpriteRenderer.scaleY[i] = -3;
      SpriteRenderer.anchorX[i] = 0.25;
      SpriteRenderer.anchorY[i] = 0.9;
    }
    w.clean();
    assertTwins(w, 'box', (f, i) => assert.equal(f ? facade(i).fitToSprite(0.8) : Collider.fitToSprite(i, 0.8), true));
    for (const i of [FACADE, STATIC]) Collider.shapeType[i] = ShapeType.Circle;
    w.clean();
    assertTwins(w, 'circle, default factor', (f, i) => assert.equal(f ? facade(i).fitToSprite() : Collider.fitToSprite(i), true));
    assert.equal(Collider.radius[FACADE], 9, 'half of the 20 × 18 sprite\'s smaller side');
    assert.ok(Math.abs(Collider.offsetX[FACADE] - 5) < 1e-6 && Math.abs(Collider.offsetY[FACADE] - 7.2) < 1e-5);
  });
});
