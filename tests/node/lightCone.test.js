// DX-SPOT: cone lights. The setters store what the frame reads (cos/sin, the cosine of the half aperture, 1 / the soft
// edge's width); on a real Pixi worker a cone light takes the first slot with a third row (its direction on the floor)
// and uConeCount; the lighting shader's cone term (emulated here as written) is 1 inside, 0 outside, smooth between;
// followFlip mirrors a light's offsetX and direction when its entity's flipX changes, and only then.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { LightEmitter, NO_CONE } from '../../src/components/lightEmitter.js';
import { GameObject } from '../../src/core/gameObject.js';

const N = 4;

function lights() {
  LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(N)), N);
  for (let i = 0; i < N; i++) {
    LightEmitter.brightness[i] = 1;
    LightEmitter.resetCone(i);
  }
}

test('the setters store cos/sin and the cone\'s cosines; 2π is no cone', () => {
  lights();
  const L = new LightEmitter(1);
  assert.equal(LightEmitter.coneCos[1], NO_CONE, 'no cone by default');
  L.coneAngle = Math.PI / 2;
  assert.ok(Math.abs(LightEmitter.coneCos[1] - Math.cos(Math.PI / 4)) < 1e-7);
  assert.ok(LightEmitter.coneInvSpan[1] >= 1 / 0.002 - 1, 'a hard edge: the narrowest span');
  L.coneSoftness = 0.5;
  const inner = Math.cos((Math.PI / 4) * 0.5);
  assert.ok(Math.abs(LightEmitter.coneInvSpan[1] - 1 / (inner - Math.cos(Math.PI / 4))) < 1e-3);
  assert.ok(Math.abs(L.coneAngle - Math.PI / 2) < 1e-6);
  L.direction = Math.PI / 2;
  assert.ok(Math.abs(LightEmitter.dirC[1]) < 1e-7 && Math.abs(LightEmitter.dirS[1] - 1) < 1e-7);
  assert.ok(Math.abs(L.direction - Math.PI / 2) < 1e-6);
  L.coneAngle = Math.PI * 2;
  assert.equal(LightEmitter.coneCos[1], NO_CONE, 'a full turn is a point light');
  L.coneSoftness = 4;
  assert.equal(L.coneSoftness, 1, 'softness is clamped to 0..1');
});

test('followFlip: offsetX and direction are stored mirrored while the entity is flipped, and read back as written', () => {
  lights();
  const L = new LightEmitter(2);
  let flipped = false;
  const saved = LightEmitter.isFlippedX;
  LightEmitter.isFlippedX = () => flipped;
  try {
    L.offsetX = 10;
    L.direction = 0.3;
    flipped = true;
    assert.equal(LightEmitter.offsetX[2], 10, 'without followFlip a flip changes nothing');
    L.followFlip = 1; // turned on while flipped: the stored side flips with it
    assert.equal(LightEmitter.offsetX[2], -10);
    assert.ok(Math.abs(LightEmitter.dirC[2] + Math.cos(0.3)) < 1e-6);
    assert.equal(L.offsetX, 10, 'read back as written');
    assert.ok(Math.abs(L.direction - 0.3) < 1e-6);
    L.offsetX = 4; // written while flipped
    assert.equal(LightEmitter.offsetX[2], -4);
  } finally {
    LightEmitter.isFlippedX = saved;
  }
});

test('GameObject flipX mirrors a followFlip light once per change, and leaves other lights', () => {
  lights();
  SpriteRenderer.flip = new Uint8Array(N);
  SpriteRenderer.scaleX = new Float32Array(N).fill(1);
  SpriteRenderer.scaleY = new Float32Array(N).fill(1);
  SpriteRenderer.renderDirty = new Uint8Array(N);
  SpriteRenderer.keyedDirty = new Uint8Array(N);
  const savedBounds = SpriteRenderer.updateBounds;
  SpriteRenderer.updateBounds = () => {};
  try {
    const go = Object.create(GameObject.prototype);
    Object.defineProperty(go, 'index', { value: 1 });
    Object.defineProperty(go, '_hasComponents', { value: { SpriteRenderer: true, LightEmitter: true } });
    LightEmitter.offsetX[1] = 12;
    LightEmitter.followFlip[1] = 1;
    go.flipX = true;
    assert.equal(LightEmitter.offsetX[1], -12);
    assert.equal(LightEmitter.dirC[1], -1);
    go.flipX = true; // no change, no mirror
    assert.equal(LightEmitter.offsetX[1], -12);
    go.flipX = false;
    assert.equal(LightEmitter.offsetX[1], 12);
    assert.equal(LightEmitter.dirC[1], 1);
    LightEmitter.followFlip[1] = 0;
    go.flipX = true;
    assert.equal(LightEmitter.offsetX[1], 12, 'a light that does not follow the flip stays (a car whose flip is art)');
  } finally {
    SpriteRenderer.updateBounds = savedBounds;
  }
});
