import test from 'node:test';
import assert from 'node:assert/strict';

import { Tween, tweenBufferBytes, resetTweenFullWarn } from '../../src/core/tween.js';
import { PARTICLE_EASE, TWEEN_DEFAULTS } from '../../src/util/configDefaults.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Camera } from '../../src/core/camera.js';

function bind(count) {
  Tween.bind(new SharedArrayBuffer(tweenBufferBytes(count)), count);
}

function sprite(n = 1) {
  SpriteRenderer.active = new Uint8Array(n);
  SpriteRenderer.active.fill(1);
  SpriteRenderer.alpha = new Float32Array(n);
  SpriteRenderer.alpha.fill(1);
  SpriteRenderer.tint = new Uint32Array(n);
  SpriteRenderer.tint.fill(0xffffff);
  SpriteRenderer.scaleX = new Float32Array(n);
  SpriteRenderer.scaleX.fill(1);
  SpriteRenderer.scaleY = new Float32Array(n);
  SpriteRenderer.scaleY.fill(1);
  SpriteRenderer.renderDirty = new Uint8Array(n);
}

test('TWEEN_DEFAULTS.maxTweens is the pool size', () => {
  assert.equal(TWEEN_DEFAULTS.maxTweens, 128);
});

test('tween writes sprite alpha and refuses a dynamic body', { concurrency: false }, () => {
  const prev = {
    active: SpriteRenderer.active,
    alpha: SpriteRenderer.alpha,
    tint: SpriteRenderer.tint,
    scaleX: SpriteRenderer.scaleX,
    scaleY: SpriteRenderer.scaleY,
    renderDirty: SpriteRenderer.renderDirty,
    tx: Transform.x,
    ty: Transform.y,
    rbA: RigidBody.active,
    rbS: RigidBody.static,
    cam: Camera._data,
  };
  try {
    sprite();
    bind(4);
    const slot = Tween.to(0, { alpha: 0 }, 100, PARTICLE_EASE.QUAD_OUT);
    assert.equal(slot, 0);
    Tween.tick(100);
    assert.equal(SpriteRenderer.alpha[0], 0);
    assert.equal(SpriteRenderer.renderDirty[0], 1);

    Transform.x = new Float32Array([5]);
    Transform.y = new Float32Array([6]);
    RigidBody.active = new Uint8Array([1]);
    RigidBody.static = new Uint8Array([0]);
    assert.equal(Tween.to(0, { x: 9, y: 1 }, 100, 0), -1);
    assert.equal(Transform.x[0], 5);

    RigidBody.static[0] = 1;
    const kin = Tween.to(0, { x: 9 }, 100, 0);
    assert.ok(kin >= 0);
    Tween.tick(100);
    assert.equal(Transform.x[0], 9);

    const data = new Float32Array(Camera.FLOAT_COUNT);
    data[0] = 1;
    data[5] = 1;
    Camera.initialize(data, 800, 600);
    const zoom = Tween.toZoom(2, 100, 0);
    assert.ok(zoom >= 0);
    Tween.tick(100);
    assert.equal(Camera.targetZoom, 2);
  } finally {
    Tween.unbind();
    SpriteRenderer.active = prev.active;
    SpriteRenderer.alpha = prev.alpha;
    SpriteRenderer.tint = prev.tint;
    SpriteRenderer.scaleX = prev.scaleX;
    SpriteRenderer.scaleY = prev.scaleY;
    SpriteRenderer.renderDirty = prev.renderDirty;
    Transform.x = prev.tx;
    Transform.y = prev.ty;
    RigidBody.active = prev.rbA;
    RigidBody.static = prev.rbS;
    Camera._data = prev.cam;
  }
});

test('two logic workers tick disjoint halves and match one full tick', { concurrency: false }, () => {
  sprite(4);
  bind(4);
  Tween.to(0, { alpha: 0 }, 100, 0);
  Tween.to(1, { alpha: 0 }, 100, 0);
  Tween.to(2, { alpha: 0 }, 100, 0);
  Tween.to(3, { alpha: 0 }, 100, 0);
  Tween.tick(50, 0, 2);
  Tween.tick(50, 1, 2);
  assert.ok(Math.abs(SpriteRenderer.alpha[0] - 0.5) < 1e-5);
  assert.ok(Math.abs(SpriteRenderer.alpha[3] - 0.5) < 1e-5);
  Tween.unbind();
});

test('tween pool warns once when every slot is live', { concurrency: false }, () => {
  resetTweenFullWarn();
  const warnings = [];
  const prev = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    bind(2);
    assert.equal(Tween.to(0, { alpha: 0 }, 1000, 0), 0);
    assert.equal(Tween.to(0, { alpha: 0 }, 1000, 0), 1);
    assert.equal(Tween.to(0, { alpha: 0 }, 1000, 0), -1);
    assert.equal(Tween.to(0, { alpha: 0 }, 1000, 0), -1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /full \(2\)/);
  } finally {
    console.warn = prev;
    Tween.unbind();
    resetTweenFullWarn();
  }
});

test('simultaneous XY and paint tween animates both properties', { concurrency: false }, () => {
  sprite(2);
  Transform.x = new Float32Array([0, 0]);
  Transform.y = new Float32Array([0, 0]);
  bind(4);
  const slot = Tween.to(0, { x: 50, alpha: 0.2 }, 100, 0);
  assert.ok(slot >= 0);
  // Both slots are active (one XY, one Paint)
  assert.equal(Tween.active[0], 1);
  assert.equal(Tween.active[1], 1);

  Tween.tick(50);
  assert.ok(Math.abs(Transform.x[0] - 25) < 1e-4);
  assert.ok(Math.abs(SpriteRenderer.alpha[0] - 0.6) < 1e-4);

  Tween.tick(50);
  assert.ok(Math.abs(Transform.x[0] - 50) < 1e-4);
  assert.ok(Math.abs(SpriteRenderer.alpha[0] - 0.2) < 1e-4);
  // Both completed
  assert.equal(Tween.active[0], 0);
  assert.equal(Tween.active[1], 0);
  Tween.unbind();
});

test('zero duration tween applies immediately without claiming SAB slot', { concurrency: false }, () => {
  sprite(1);
  Transform.x = new Float32Array([10]);
  Transform.y = new Float32Array([20]);
  const camData = new Float32Array(Camera.FLOAT_COUNT);
  camData[0] = 1;
  camData[5] = 1;
  Camera.initialize(camData, 800, 600);
  bind(4);
  const slot = Tween.to(0, { x: 99, alpha: 0.1 }, 0);
  assert.equal(slot, -1);
  assert.equal(Transform.x[0], 99);
  assert.ok(Math.abs(SpriteRenderer.alpha[0] - 0.1) < 1e-5);
  assert.equal(SpriteRenderer.renderDirty[0], 1);
  // No slots claimed in SAB pool
  assert.equal(Tween.active[0], 0);
  assert.equal(Tween.active[1], 0);

  const zoomSlot = Tween.toZoom(3.5, 0);
  assert.equal(zoomSlot, -1);
  assert.equal(Camera.targetZoom, 3.5);
  Tween.unbind();
  Camera._data = null;
});

test('Tween.cancel frees active slots for the target entity', { concurrency: false }, () => {
  sprite(2);
  bind(4);
  Tween.to(0, { alpha: 0 }, 1000, 0);
  Tween.to(1, { alpha: 0 }, 1000, 0);
  assert.equal(Tween.active[0], 1);
  assert.equal(Tween.active[1], 1);

  Tween.cancel(0);
  assert.equal(Tween.active[0], 0);
  assert.equal(Tween.active[1], 1);

  Tween.cancel(1);
  assert.equal(Tween.active[1], 0);
  Tween.unbind();
});

test('an ease that is not a PARTICLE_EASE value throws on every path and claims no slot', { concurrency: false }, () => {
  sprite(2);
  bind(2);
  for (const ease of ['quad.out', 1.5, PARTICLE_EASE.BOUNCE_OUT + 1]) {
    assert.throws(() => Tween.to(0, { alpha: 0 }, 100, ease), TypeError);
    assert.throws(() => Tween.to(0, { alpha: 0 }, 100, ease, { delay: 10, onComplete: 'nope' }), TypeError);
    assert.throws(() => Tween.to(0, { alpha: 0 }, 0, ease), TypeError, 'the immediate path too');
    assert.throws(() => Tween.toZoom(2, 100, ease), TypeError);
    assert.throws(() => Tween.toZoom(2, 0, ease), TypeError);
  }
  assert.equal(SpriteRenderer.alpha[0], 1, 'nothing was applied');
  assert.equal(Tween.active[0] | Tween.active[1], 0, 'no slot was left claimed');
  assert.equal(Tween.to(0, { alpha: 0 }, 100, PARTICLE_EASE.BOUNCE_OUT), 0);
  assert.equal(Tween.to(1, { alpha: 0 }, 100), 1, 'both slots are still there');
  assert.equal(Tween.ease[0], PARTICLE_EASE.BOUNCE_OUT);
  assert.equal(Tween.ease[1], PARTICLE_EASE.LERP, 'no ease is lerp');
  Tween.unbind();
});

// The contract is one writer per slot (each worker ticks its block of the pool), not
// "the worker that ticks the entity": entityIndex % W never was that worker (B11).
test('multi-worker tick advances every live slot exactly once, uneven blocks too', { concurrency: false }, () => {
  for (const [workers, slots] of [[2, 4], [3, 5], [4, 3]]) {
    sprite(slots);
    bind(slots);
    for (let e = 0; e < slots; e++) Tween.to(e, { alpha: 0 }, 100, 0);
    let advanced = 0;
    for (let w = 0; w < workers; w++) advanced += Tween.tick(50, w, workers);
    assert.equal(advanced, slots, `${workers} workers, ${slots} slots`);
    for (let e = 0; e < slots; e++) {
      assert.ok(Math.abs(SpriteRenderer.alpha[e] - 0.5) < 1e-5, `entity ${e} advanced once`);
    }
    Tween.unbind();
  }
});
