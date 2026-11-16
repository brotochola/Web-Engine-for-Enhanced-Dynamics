import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { bindStaticSceneryGen, bindStaticTypes, staticSceneryGen } from '../../src/core/staticScenery.js';
import { bindCommandRing, createCommandRingSab, drainCommandRing } from '../../src/box2d/box2dCommandRing.js';

// N-170. The per-frame setters' early-outs compared a Float32 column with the double they were given, so a value
// not exact in float32 (0.3, a speed × 0.00277) never matched what the column held: writing it again re-marked the
// row dirty, called updateBounds, bumped the static scenery counter or queued another SET_TRANSFORM / SET_VELOCITY.
// Each test writes the same such value twice and counts what the second write did: nothing. A value one float32
// step away still writes.

const N = 4;
const STATIC_TYPE = 1;
const TRANSFORM_KEYS = ['x', 'y', 'rotation', 'rotC', 'rotS', 'entityType'];
const BODY_KEYS = ['vx', 'vy', 'angularVelocity'];
const SPRITE_KEYS = ['alpha', 'scaleX', 'scaleY', 'animationSpeed', 'flip', 'renderDirty', 'keyedDirty', 'updateBounds'];
const MESH_KEYS = ['alpha', 'renderDirty'];
const ADOBE_KEYS = ['alpha', 'scaleX', 'scaleY', 'flip', 'applyClipBounds'];

/** The next float32 above `v` (a value the column holds as a different one). */
function nextFloat32(v) {
  const f = new Float32Array([v]);
  const u = new Uint32Array(f.buffer);
  u[0] += v >= 0 ? 1 : -1;
  return f[0];
}

function save(cls, keys) {
  return keys.map((k) => [cls, k, cls[k]]);
}

/**
 * Fresh columns, a command ring and a static scenery counter, all restored after `fn(world)`. `world.sent()` drains
 * the ring into { transform, velocity, angular, rot } lists; `world.bounds` and `world.clipBounds` count
 * updateBounds and applyClipBounds per call.
 */
function withWorld(fn) {
  const saved = [
    ...save(Transform, TRANSFORM_KEYS),
    ...save(RigidBody, BODY_KEYS),
    ...save(SpriteRenderer, SPRITE_KEYS),
    ...save(MeshRenderer, MESH_KEYS),
    ...save(AdobeAnimComponent, ADOBE_KEYS),
  ];
  const world = { bounds: [], clipBounds: [] };
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotation = new Float32Array(N);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  Transform.entityType = new Uint8Array(N);
  RigidBody.vx = new Float32Array(N);
  RigidBody.vy = new Float32Array(N);
  RigidBody.angularVelocity = new Float32Array(N);
  SpriteRenderer.alpha = new Float32Array(N).fill(1);
  SpriteRenderer.scaleX = new Float32Array(N).fill(1);
  SpriteRenderer.scaleY = new Float32Array(N).fill(1);
  SpriteRenderer.animationSpeed = new Float32Array(N);
  SpriteRenderer.flip = new Uint8Array(N);
  SpriteRenderer.renderDirty = new Uint8Array(N);
  SpriteRenderer.keyedDirty = new Uint8Array(N);
  SpriteRenderer.updateBounds = (i) => world.bounds.push(i);
  MeshRenderer.alpha = new Float32Array(N).fill(1);
  MeshRenderer.renderDirty = new Uint8Array(N);
  AdobeAnimComponent.alpha = new Float32Array(N).fill(1);
  AdobeAnimComponent.scaleX = new Float32Array(N).fill(1);
  AdobeAnimComponent.scaleY = new Float32Array(N).fill(1);
  AdobeAnimComponent.flip = new Uint8Array(N);
  AdobeAnimComponent.applyClipBounds = (i) => world.clipBounds.push(i);

  const ring = createCommandRingSab(64);
  bindCommandRing(ring);
  world.sent = () => {
    const out = { transform: [], velocity: [], angular: [], rot: [] };
    drainCommandRing(new Int32Array(ring), new Float32Array(ring), {
      setTransform: (i, x, y, c, s) => out.transform.push([i, x, y, c, s]),
      setVelocity: (i, vx, vy) => out.velocity.push([i, vx, vy]),
      setAngularVelocity: (i, w) => out.angular.push([i, w]),
      setRotCS: (i, c, s) => out.rot.push([i, c, s]),
    });
    return out;
  };
  bindStaticSceneryGen(new SharedArrayBuffer(4));
  bindStaticTypes([{ entityType: 0, isStatic: false }, { entityType: STATIC_TYPE, isStatic: true }]);
  /** Clear the dirty flags and the bounds calls, so the next write shows what it marked. */
  world.clean = () => {
    SpriteRenderer.renderDirty.fill(0);
    SpriteRenderer.keyedDirty.fill(0);
    MeshRenderer.renderDirty.fill(0);
    world.bounds.length = 0;
    world.clipBounds.length = 0;
  };
  try {
    fn(world);
  } finally {
    bindCommandRing(null);
    bindStaticSceneryGen(null);
    bindStaticTypes(null);
    for (const [cls, k, v] of saved) cls[k] = v;
  }
}

function entity(index, components) {
  const go = Object.create(GameObject.prototype);
  go.index = index;
  go._hasComponents = components;
  return go;
}

test('set x and set y: the same value again sends no second SET_TRANSFORM', () => {
  withWorld((w) => {
    const body = entity(1, { RigidBody: true, Collider: true });
    body.x = 0.3;
    body.y = 0.7;
    let sent = w.sent();
    assert.deepEqual(
      sent.transform.map((t) => t.slice(0, 3)),
      [
        [1, Math.fround(0.3), 0],
        [1, Math.fround(0.3), Math.fround(0.7)],
      ],
    );
    body.x = 0.3;
    body.y = 0.7;
    assert.equal(w.sent().transform.length, 0, 'nothing changed');
    assert.equal(Transform.x[1], Math.fround(0.3));
    assert.equal(Transform.y[1], Math.fround(0.7));

    body.x = nextFloat32(0.3);
    sent = w.sent();
    assert.equal(sent.transform.length, 1, 'one float32 step is a move');
    assert.equal(sent.transform[0][1], nextFloat32(0.3));
  });
});

test('set x and set y: the same value again leaves the static scenery counter alone', () => {
  withWorld(() => {
    Transform.entityType[2] = STATIC_TYPE;
    const prop = entity(2, { SpriteRenderer: true });
    const g0 = staticSceneryGen();
    prop.x = 10.1;
    prop.y = 20.2;
    assert.equal(staticSceneryGen(), g0 + 2);
    prop.x = 10.1;
    prop.y = 20.2;
    assert.equal(staticSceneryGen(), g0 + 2, 'the same place is not a move');
    prop.y = nextFloat32(20.2);
    assert.equal(staticSceneryGen(), g0 + 3);
  });
});

test('setPosition: the same pair again sends no second SET_TRANSFORM', () => {
  withWorld((w) => {
    const body = entity(1, { Collider: true });
    assert.equal(body.setPosition(100.3, -40.7), body);
    assert.deepEqual(w.sent().transform, [[1, Math.fround(100.3), Math.fround(-40.7), 1, 0]]);
    assert.equal(body.setPosition(100.3, -40.7), body);
    assert.equal(w.sent().transform.length, 0);
    body.setPosition(100.3, nextFloat32(-40.7));
    assert.equal(w.sent().transform.length, 1);
  });
});

test('velocity setters: the same value again sends no second SET_VELOCITY or SET_ANGULAR_VELOCITY', () => {
  withWorld((w) => {
    const body = entity(1, { RigidBody: true });
    body.vx = 1.1;
    body.vy = -2.2;
    body.angularVelocity = 0.3;
    let sent = w.sent();
    assert.deepEqual(sent.velocity, [
      [1, Math.fround(1.1), 0],
      [1, Math.fround(1.1), Math.fround(-2.2)],
    ]);
    assert.deepEqual(sent.angular, [[1, Math.fround(0.3)]]);

    body.vx = 1.1;
    body.vy = -2.2;
    body.angularVelocity = 0.3;
    assert.equal(body.setVelocity(1.1, -2.2), body);
    sent = w.sent();
    assert.equal(sent.velocity.length, 0, 'the same velocity is not sent again');
    assert.equal(sent.angular.length, 0);

    body.setVelocity(nextFloat32(1.1), -2.2);
    body.angularVelocity = nextFloat32(0.3);
    sent = w.sent();
    assert.deepEqual(sent.velocity, [[1, nextFloat32(1.1), Math.fround(-2.2)]]);
    assert.equal(sent.angular.length, 1);
  });
});

test('set rotation: the same angle again sends no second SET_ROT_CS', () => {
  withWorld((w) => {
    const body = entity(1, { RigidBody: true });
    body.rotation = 0.3;
    assert.equal(w.sent().rot.length, 1);
    body.rotation = 0.3;
    assert.equal(w.sent().rot.length, 0);
    assert.ok(Math.abs(Transform.rotC[1] - Math.cos(0.3)) < 1e-6);
  });
});

test('alpha and setAlpha: the same value again marks nothing dirty', () => {
  withWorld((w) => {
    const sprite = entity(1, { SpriteRenderer: true, MeshRenderer: true });
    sprite.alpha = 0.3;
    assert.equal(SpriteRenderer.renderDirty[1], 1);
    assert.equal(SpriteRenderer.keyedDirty[1], 1);
    assert.equal(MeshRenderer.renderDirty[1], 1);
    w.clean();
    sprite.alpha = 0.3;
    assert.equal(sprite.setAlpha(0.3), sprite);
    assert.equal(SpriteRenderer.renderDirty[1], 0, 'renderDirty not marked again');
    assert.equal(SpriteRenderer.keyedDirty[1], 0, 'keyedDirty not marked again');
    assert.equal(MeshRenderer.renderDirty[1], 0, 'the mesh row neither');
    sprite.setAlpha(nextFloat32(0.3));
    assert.equal(SpriteRenderer.renderDirty[1], 1);
    assert.equal(MeshRenderer.alpha[1], nextFloat32(0.3));
  });
});

test('setScale, scaleX and scaleY: the same scale again calls no updateBounds and marks nothing', () => {
  withWorld((w) => {
    const sprite = entity(1, { SpriteRenderer: true });
    assert.equal(sprite.setScale(0.3, 0.7), sprite);
    assert.deepEqual(w.bounds, [1]);
    w.clean();
    sprite.setScale(0.3, 0.7);
    sprite.scaleX = 0.3;
    sprite.scaleY = 0.7;
    assert.deepEqual(w.bounds, [], 'no bounds again');
    assert.equal(SpriteRenderer.renderDirty[1], 0);
    assert.equal(SpriteRenderer.keyedDirty[1], 0);

    // A flip is the sign of the stored scale: the same scale under a flip is still the same.
    sprite.flipX = true;
    w.clean();
    sprite.setScale(0.3, 0.7);
    sprite.scaleX = 0.3;
    assert.deepEqual(w.bounds, []);
    assert.equal(SpriteRenderer.scaleX[1], -Math.fround(0.3));

    sprite.setScale(0.3, nextFloat32(0.7));
    assert.deepEqual(w.bounds, [1]);
  });
});

test('Adobe scaleX and scaleY: the same scale again calls no applyClipBounds', () => {
  withWorld((w) => {
    const clip = entity(1, { adobeAnimComponent: true });
    clip.scaleX = 0.3;
    clip.scaleY = 0.7;
    assert.deepEqual(w.clipBounds, [1, 1]);
    w.clean();
    clip.scaleX = 0.3;
    clip.scaleY = 0.7;
    assert.deepEqual(w.clipBounds, []);
  });
});

test('setAnimationSpeed: a walker setting its speed every tick marks renderDirty once', () => {
  withWorld(() => {
    const walker = entity(1, { SpriteRenderer: true });
    const speed = 37.3 * 0.00277;
    assert.equal(walker.setAnimationSpeed(speed), walker);
    assert.equal(SpriteRenderer.renderDirty[1], 1);
    SpriteRenderer.renderDirty[1] = 0;
    for (let t = 0; t < 3; t++) walker.setAnimationSpeed(speed);
    assert.equal(SpriteRenderer.renderDirty[1], 0, 'the same speed is not a change');
    assert.equal(SpriteRenderer.animationSpeed[1], Math.fround(speed));
    walker.setAnimationSpeed(nextFloat32(speed));
    assert.equal(SpriteRenderer.renderDirty[1], 1);
  });
});

test('NaN is never the value already there: each write still goes through, as before', () => {
  withWorld((w) => {
    const body = entity(1, { RigidBody: true });
    body.x = NaN;
    body.x = NaN;
    assert.equal(w.sent().transform.length, 2);
    assert.ok(Number.isNaN(Transform.x[1]));
  });
});
