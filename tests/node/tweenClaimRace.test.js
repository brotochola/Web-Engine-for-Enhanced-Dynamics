import test from 'node:test';
import assert from 'node:assert/strict';

import { Tween, tweenBufferBytes } from '../../src/core/tween.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { packTweens } from '../../src/core/save/worldBufferSave.js';

// A tween slot is claimed by one worker and ticked by every logic worker (and saved by
// main). The claim must not make the slot live before its fields are written, or a tick
// that lands in between replays the slot's previous tween and frees the new one.

function setup() {
  const n = 2;
  SpriteRenderer.active = new Uint8Array(n).fill(1);
  SpriteRenderer.alpha = new Float32Array(n).fill(1);
  SpriteRenderer.tint = new Uint32Array(n).fill(0xffffff);
  SpriteRenderer.scaleX = new Float32Array(n).fill(1);
  SpriteRenderer.scaleY = new Float32Array(n).fill(1);
  SpriteRenderer.renderDirty = new Uint8Array(n);
  Tween.bind(new SharedArrayBuffer(tweenBufferBytes(1)), 1);
}

test('a tick between the claim and the field writes neither replays nor frees the slot', () => {
  setup();
  // Slot 0 once ran "entity 0 alpha -> 0" and finished; its fields are still there.
  assert.equal(Tween.to(0, { alpha: 0 }, 100), 0);
  Tween.tick(100);
  assert.equal(SpriteRenderer.alpha[0], 0);
  SpriteRenderer.alpha[0] = 1;

  // Worker A claims slot 0 for a new tween; before it writes the fields, worker B ticks.
  const slot = Tween._claim();
  assert.equal(slot, 0);
  Tween.tick(16);
  assert.equal(SpriteRenderer.alpha[0], 1, 'the finished tween was replayed onto entity 0');
  assert.ok(Tween.active[0] !== 0, 'the claimed slot was freed by the tick');
  assert.equal(packTweens(), null, 'a save must not record a half-written slot');
});

test('a started tween is live and saved', () => {
  setup();
  const slot = Tween.to(1, { alpha: 0.5 }, 200);
  assert.equal(slot, 0);
  assert.equal(Tween.active[0], 1);
  const saved = packTweens();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].entity, 1);
  Tween.tick(100);
  assert.ok(Math.abs(SpriteRenderer.alpha[1] - 0.75) < 1e-6);
});
