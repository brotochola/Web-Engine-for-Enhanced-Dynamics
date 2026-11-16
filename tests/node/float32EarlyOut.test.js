import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { createCommandRingSab, bindCommandRing, drainCommandRing } from '../../src/box2d/box2dCommandRing.js';

// N-170: the setters' early-outs compared a Float32 column with the double the game passed, so they never fired for a
// value float32 cannot hold exactly (0.3, a walker's speed x 0.00277): setting the same value again re-queued a teleport
// or a velocity, or re-marked renderDirty (which also makes the emit's persist path miss). They compare with
// Math.fround(value) now: a repeat is skipped exactly when the store would leave the column as it is.

const NOT_F32 = 0.3; // Math.fround(0.3) !== 0.3
const ALSO_NOT_F32 = 0.7;

function entity(index, components) {
  const go = Object.create(GameObject.prototype);
  go.index = index;
  go._hasComponents = components;
  return go;
}

function withColumns(fn) {
  const savedT = { x: Transform.x, y: Transform.y, rotation: Transform.rotation, rotC: Transform.rotC, rotS: Transform.rotS };
  const savedRb = { vx: RigidBody.vx, vy: RigidBody.vy, angularVelocity: RigidBody.angularVelocity };
  const spriteKeys = ['alpha', 'renderDirty', 'keyedDirty', 'scaleX', 'scaleY', 'flip', 'animationSpeed'];
  const meshKeys = ['alpha', 'renderDirty', 'visualOutset', 'paintEpoch', 'outsetEpoch'];
  const savedS = Object.fromEntries(spriteKeys.map((k) => [k, SpriteRenderer[k]]));
  const savedM = Object.fromEntries(meshKeys.map((k) => [k, MeshRenderer[k]]));
  const savedUpdateBounds = SpriteRenderer.updateBounds;
  const bounds = { calls: 0 };
  Transform.x = new Float32Array(4);
  Transform.y = new Float32Array(4);
  Transform.rotation = new Float32Array(4);
  Transform.rotC = new Float32Array(4).fill(1);
  Transform.rotS = new Float32Array(4);
  RigidBody.vx = new Float32Array(4);
  RigidBody.vy = new Float32Array(4);
  RigidBody.angularVelocity = new Float32Array(4);
  SpriteRenderer.alpha = new Float32Array(4).fill(1);
  SpriteRenderer.renderDirty = new Uint8Array(4);
  SpriteRenderer.keyedDirty = new Uint8Array(4);
  SpriteRenderer.scaleX = new Float32Array(4).fill(1);
  SpriteRenderer.scaleY = new Float32Array(4).fill(1);
  SpriteRenderer.flip = new Uint8Array(4);
  SpriteRenderer.animationSpeed = new Float32Array(4);
  SpriteRenderer.updateBounds = () => {
    bounds.calls++;
  };
  MeshRenderer.alpha = new Float32Array(4).fill(1);
  MeshRenderer.renderDirty = new Uint8Array(4);
  MeshRenderer.visualOutset = new Float32Array(4);
  MeshRenderer.paintEpoch = new Uint32Array(1);
  MeshRenderer.outsetEpoch = new Uint32Array(1);
  try {
    fn(bounds);
  } finally {
    Object.assign(Transform, savedT);
    Object.assign(RigidBody, savedRb);
    Object.assign(SpriteRenderer, savedS);
    Object.assign(MeshRenderer, savedM);
    SpriteRenderer.updateBounds = savedUpdateBounds;
  }
}

function drained(sab) {
  const sent = { transform: 0, velocity: 0, angular: 0, rotCS: 0 };
  drainCommandRing(new Int32Array(sab), new Float32Array(sab), {
    setTransform: () => sent.transform++,
    setVelocity: () => sent.velocity++,
    setAngularVelocity: () => sent.angular++,
    setRotCS: () => sent.rotCS++,
  });
  return sent;
}

test('a repeated x, y, setPosition or rotation that float32 cannot hold exactly queues no second command', () => {
  withColumns(() => {
    const sab = createCommandRingSab(64);
    bindCommandRing(sab);
    const go = entity(1, { RigidBody: true });

    go.x = NOT_F32;
    go.x = NOT_F32;
    go.y = ALSO_NOT_F32;
    go.y = ALSO_NOT_F32;
    assert.equal(drained(sab).transform, 2, 'one SET_TRANSFORM per axis, none for the repeats');

    go.setPosition(NOT_F32 * 3, ALSO_NOT_F32 * 3);
    go.setPosition(NOT_F32 * 3, ALSO_NOT_F32 * 3);
    assert.equal(drained(sab).transform, 1);

    go.rotation = NOT_F32;
    go.rotation = NOT_F32;
    assert.equal(drained(sab).rotCS, 1);

    // A value whose float32 differs still goes through.
    go.x = NOT_F32 * 3 + 0.001;
    assert.equal(drained(sab).transform, 1);
    assert.equal(Transform.x[1], Math.fround(NOT_F32 * 3 + 0.001));
  });
});

test('a repeated velocity or angular velocity that float32 cannot hold exactly queues no second command', () => {
  withColumns(() => {
    const sab = createCommandRingSab(64);
    bindCommandRing(sab);
    const go = entity(2, { RigidBody: true });

    go.vx = NOT_F32;
    go.vx = NOT_F32;
    go.vy = ALSO_NOT_F32;
    go.vy = ALSO_NOT_F32;
    assert.equal(drained(sab).velocity, 2);

    go.setVelocity(NOT_F32 * 5, ALSO_NOT_F32 * 5);
    go.setVelocity(NOT_F32 * 5, ALSO_NOT_F32 * 5);
    assert.equal(drained(sab).velocity, 1);

    go.angularVelocity = NOT_F32;
    go.angularVelocity = NOT_F32;
    assert.equal(drained(sab).angular, 1);
  });
});

test('a repeated alpha, scale or animation speed marks the sprite dirty once', (t) => {
  withColumns((bounds) => {
    const go = entity(3, { SpriteRenderer: true });
    const clear = () => {
      SpriteRenderer.renderDirty[3] = 0;
      SpriteRenderer.keyedDirty[3] = 0;
    };

    go.alpha = NOT_F32;
    assert.equal(SpriteRenderer.renderDirty[3], 1);
    clear();
    go.alpha = NOT_F32;
    go.setAlpha(NOT_F32);
    assert.equal(SpriteRenderer.renderDirty[3], 0, 'the same alpha again is not a change');
    assert.equal(SpriteRenderer.keyedDirty[3], 0);

    go.scaleX = NOT_F32;
    go.scaleY = ALSO_NOT_F32;
    assert.equal(bounds.calls, 2);
    clear();
    go.scaleX = NOT_F32;
    go.scaleY = ALSO_NOT_F32;
    go.setScale(NOT_F32, ALSO_NOT_F32);
    assert.equal(bounds.calls, 2, 'no bounds update for the repeats');
    assert.equal(SpriteRenderer.renderDirty[3], 0);

    // A walker sets its animation speed from its speed every tick (Predator).
    const speed = 37.5 * 0.00277;
    go.setAnimationSpeed(speed);
    assert.equal(SpriteRenderer.renderDirty[3], 1);
    clear();
    go.setAnimationSpeed(speed);
    assert.equal(SpriteRenderer.renderDirty[3], 0);
    go.setAnimationSpeed(speed * 2);
    assert.equal(SpriteRenderer.renderDirty[3], 1, 'a new speed still marks the row');
  });
});

test("a mesh's repeated alpha or visual outset marks nothing again", () => {
  withColumns(() => {
    const mesh = Object.create(MeshRenderer.prototype);
    mesh.index = 0;
    mesh.alpha = NOT_F32;
    assert.equal(MeshRenderer.renderDirty[0], 1);
    const paint = MeshRenderer.paintEpoch[0];
    MeshRenderer.renderDirty[0] = 0;
    mesh.alpha = NOT_F32;
    assert.equal(MeshRenderer.renderDirty[0], 0);
    assert.equal(MeshRenderer.paintEpoch[0], paint);

    mesh.visualOutset = NOT_F32;
    const outset = MeshRenderer.outsetEpoch[0];
    mesh.visualOutset = NOT_F32;
    assert.equal(MeshRenderer.outsetEpoch[0], outset, 'the outset epoch moves only for a new outset');

    const go = entity(1, { MeshRenderer: true });
    MeshRenderer.renderDirty[1] = 0;
    go.alpha = ALSO_NOT_F32;
    assert.equal(MeshRenderer.renderDirty[1], 1);
    MeshRenderer.renderDirty[1] = 0;
    go.alpha = ALSO_NOT_F32;
    go.setAlpha(ALSO_NOT_F32);
    assert.equal(MeshRenderer.renderDirty[1], 0);
  });
});
