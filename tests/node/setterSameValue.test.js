import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { staticSceneryGen } from '../../src/core/staticScenery.js';
import { STATIC_TYPE, entity, nextFloat32, withWorld } from '../helpers/setterWorld.mjs';

// N-170. The per-frame setters' early-outs compared a Float32 column with the double they were given, so a value
// not exact in float32 (0.3, a speed × 0.00277) never matched what the column held: writing it again re-marked the
// row dirty, called updateBounds, bumped the static scenery counter or queued another SET_TRANSFORM / SET_VELOCITY.
// Each test writes the same such value twice and counts what the second write did: nothing. A value one float32
// step away still writes.

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
