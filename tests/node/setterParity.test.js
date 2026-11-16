import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { staticSceneryGen } from '../../src/core/staticScenery.js';
import { bindCommandRing } from '../../src/box2d/box2dCommandRing.js';
import { STATIC_TYPE, entity, withWorld } from '../helpers/setterWorld.mjs';

// N-215 moved the per-frame setters' work into functions that take no double (the setter stores its value in a
// Float32 scratch first). What they write, queue and mark must be what they did before: these pass on the setters as
// they were and as they are.

const f = Math.fround;

test('a body moved by set x, set y and setPosition queues what its columns now hold, its rotation too', () => {
  withWorld((w) => {
    Transform.rotC[1] = 0.6;
    Transform.rotS[1] = 0.8;
    const body = entity(1, { RigidBody: true, Collider: true });
    body.x = 10.1;
    body.y = -3.3;
    body.setPosition(5.5, 6.6);
    assert.deepEqual(w.sent().transform, [
      [1, f(10.1), 0, f(0.6), f(0.8)],
      [1, f(10.1), f(-3.3), f(0.6), f(0.8)],
      [1, f(5.5), f(6.6), f(0.6), f(0.8)],
    ]);
    assert.equal(Transform.x[1], f(5.5));
    assert.equal(Transform.y[1], f(6.6));

    // A Collider alone is an implicit static body: it is told too. Without rotation columns: cos 1, sin 0.
    Transform.rotC = null;
    Transform.rotS = null;
    const wall = entity(2, { Collider: true });
    wall.x = 1.5;
    assert.deepEqual(w.sent().transform, [[2, 1.5, 0, 1, 0]]);
  });
});

test('an entity without a body queues nothing; with no ring bound a body queues nothing either', () => {
  withWorld((w) => {
    const walker = entity(2, { SpriteRenderer: true });
    walker.x = 3.25;
    walker.y = 4.5;
    assert.equal(walker.setPosition(7, 8), walker);
    assert.deepEqual(w.sent().transform, []);
    assert.equal(Transform.x[2], 7);
    assert.equal(Transform.y[2], 8);

    bindCommandRing(null);
    const body = entity(1, { RigidBody: true });
    body.x = 9;
    body.vx = 2;
    assert.equal(Transform.x[1], 9);
    assert.equal(RigidBody.vx[1], 2);
  });
});

test('set x and set y move the static scenery counter for a static entity only', () => {
  withWorld(() => {
    Transform.entityType[2] = STATIC_TYPE;
    const prop = entity(2, { SpriteRenderer: true });
    const walker = entity(1, { SpriteRenderer: true });
    const g0 = staticSceneryGen();
    walker.x = 1;
    walker.y = 2;
    assert.equal(staticSceneryGen(), g0, 'a moving type does not move it');
    prop.x = 1;
    prop.y = 2;
    assert.equal(staticSceneryGen(), g0 + 2);
  });
});

test('the velocity setters do nothing without a RigidBody', () => {
  withWorld((w) => {
    const sprite = entity(1, { SpriteRenderer: true });
    sprite.vx = 3;
    sprite.vy = 4;
    sprite.angularVelocity = 5;
    assert.equal(sprite.setVelocity(6, 7), sprite);
    assert.equal(RigidBody.vx[1], 0);
    assert.equal(RigidBody.vy[1], 0);
    assert.equal(RigidBody.angularVelocity[1], 0);
    const sent = w.sent();
    assert.equal(sent.velocity.length + sent.angular.length, 0);

    const body = entity(2, { RigidBody: true });
    body.angularVelocity = -1.25;
    assert.deepEqual(w.sent().angular, [[2, -1.25]]);
  });
});

test('setAnimationSpeed without a SpriteRenderer does nothing and still chains', () => {
  withWorld(() => {
    const clip = entity(1, { adobeAnimComponent: true });
    assert.equal(clip.setAnimationSpeed(0.5), clip);
    assert.equal(SpriteRenderer.animationSpeed[1], 0);
    assert.equal(SpriteRenderer.renderDirty[1], 0);
  });
});

test('alpha: an Adobe clip takes it, a mesh row that follows takes it and its flag, a sprite row its keyed flag', () => {
  withWorld((w) => {
    const clip = entity(1, { adobeAnimComponent: true });
    clip.alpha = 0.25;
    assert.equal(AdobeAnimComponent.alpha[1], 0.25);
    assert.equal(SpriteRenderer.renderDirty[1], 0);
    assert.equal(MeshRenderer.renderDirty[1], 0);

    const mesh = entity(2, { MeshRenderer: true });
    assert.equal(mesh.setAlpha(0.5), mesh);
    assert.equal(MeshRenderer.alpha[2], 0.5);
    assert.equal(MeshRenderer.renderDirty[2], 1);
    assert.equal(SpriteRenderer.keyedDirty[2], 0);

    w.clean();
    const sprite = entity(3, { SpriteRenderer: true });
    sprite.alpha = 0.75;
    assert.equal(SpriteRenderer.alpha[3], 0.75);
    assert.equal(SpriteRenderer.renderDirty[3], 1);
    assert.equal(SpriteRenderer.keyedDirty[3], 1);
    assert.equal(MeshRenderer.renderDirty[3], 0, 'no mesh row');
  });
});

test('setScale(x) is uniform; an Adobe clip takes the scale and its clip bounds each time', () => {
  withWorld((w) => {
    const both = entity(1, { SpriteRenderer: true, adobeAnimComponent: true });
    assert.equal(both.setScale(2), both);
    assert.equal(SpriteRenderer.scaleX[1], 2);
    assert.equal(SpriteRenderer.scaleY[1], 2);
    assert.equal(AdobeAnimComponent.scaleY[1], 2);
    assert.deepEqual(w.bounds, [1]);
    assert.deepEqual(w.clipBounds, [1]);
    w.clean();
    both.setScale(2);
    assert.deepEqual(w.bounds, [], 'the sprite saw no change');
    assert.deepEqual(w.clipBounds, [1], 'the clip is told each time, as before');

    // A flipped Adobe clip keeps its flip in the sign of the scale it is given.
    AdobeAnimComponent.flip[1] = 2;
    both.setScale(1.5, 3);
    assert.equal(AdobeAnimComponent.scaleX[1], 1.5);
    assert.equal(AdobeAnimComponent.scaleY[1], -3);
  });
});

test('a value whose conversion sets another entity still lands on its own entity', () => {
  withWorld(() => {
    const a = entity(1, { SpriteRenderer: true });
    const b = entity(2, { SpriteRenderer: true });
    a.x = {
      valueOf() {
        b.x = 5;
        return 7;
      },
    };
    assert.equal(Transform.x[1], 7);
    assert.equal(Transform.x[2], 5);
  });
});
