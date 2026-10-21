import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';

// DX 3.3. A flip was a negative scale, so setScale(2) after flipping undid it.
// flipX / flipY are a flag beside the sign: setScale keeps the flip, scaleX
// reads the scale you set, and code that never flips behaves as before.

const N = 4;

function setup() {
  for (const C of [SpriteRenderer, AdobeAnimComponent]) {
    C.initializeArrays(new SharedArrayBuffer(C.getBufferSize(N)), N);
  }
  for (let i = 0; i < N; i++) {
    SpriteRenderer.scaleX[i] = 1;
    SpriteRenderer.scaleY[i] = 1;
    AdobeAnimComponent.scaleX[i] = 1;
    AdobeAnimComponent.scaleY[i] = 1;
  }
}

function entity(index, has) {
  const go = Object.create(GameObject.prototype);
  go.index = index;
  go._hasComponents = has;
  return go;
}

function withFrame(fn) {
  const real = SpriteSheetRegistry.frameSizeOf;
  SpriteSheetRegistry.frameSizeOf = () => ({ w: 10, h: 20 });
  try {
    fn();
  } finally {
    SpriteSheetRegistry.frameSizeOf = real;
  }
}

test('flipX mirrors through the sign; setScale and scaleX keep the scale you meant', () => {
  setup();
  const go = entity(0, { SpriteRenderer: true });
  go.flipX = true;
  assert.equal(SpriteRenderer.scaleX[0], -1, 'what the renderer reads');
  assert.equal(go.flipX, true);
  go.setScale(2, 3);
  assert.deepEqual([SpriteRenderer.scaleX[0], SpriteRenderer.scaleY[0]], [-2, 3], 'the flip survives setScale');
  assert.deepEqual([go.scaleX, go.scaleY], [2, 3]);
  go.scaleX = 4;
  assert.equal(SpriteRenderer.scaleX[0], -4);
  assert.equal(go.setFlip(false, true), go);
  assert.deepEqual([SpriteRenderer.scaleX[0], SpriteRenderer.scaleY[0]], [4, -3]);
  assert.deepEqual([go.flipX, go.flipY], [false, true]);
  go.flipY = true; // already on: no double negation
  assert.equal(SpriteRenderer.scaleY[0], -3);
});

test('without a flip nothing changes: a negative setScale still mirrors and reads back negative', () => {
  setup();
  const go = entity(1, { SpriteRenderer: true });
  go.setScale(-2, 2);
  assert.equal(SpriteRenderer.scaleX[1], -2);
  assert.equal(go.scaleX, -2);
  assert.equal(go.flipX, false);
});

test('bounds use the size, not the sign, so a flipped wide sprite is not culled early', () => {
  setup();
  withFrame(() => {
    const go = entity(2, { SpriteRenderer: true });
    go.setScale(4, 1).setFlip(true);
    assert.equal(SpriteRenderer.boundsHalfW[2], 20, '10 × 4 / 2, positive');
    assert.equal(SpriteRenderer.boundsHalfH[2], 10);
  });
});

test('an Adobe clip flips the same way', () => {
  setup();
  const go = entity(3, { adobeAnimComponent: true });
  go.setScale(0.5).setFlip(true);
  assert.equal(AdobeAnimComponent.scaleX[3], -0.5);
  go.setScale(0.25);
  assert.equal(AdobeAnimComponent.scaleX[3], -0.25);
  assert.equal(go.scaleX, 0.25);
  assert.equal(go.flipX, true);
});
