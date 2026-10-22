import test from 'node:test';
import assert from 'node:assert/strict';

import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { GameObject } from '../../src/core/gameObject.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { runSetAnimationMicrobench } from '../bench/setAnimationMicrobench.mjs';

// setAnimation is meant to be called every tick (no "last direction" field in
// game code): unchanged, it builds no string. Its index cache is per sheet, and
// two sheets can number the same animation differently.

const N = 4;
SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);
SpriteSheetRegistry.register('pairA', { animations: { n: ['a0'], s: ['a1'] } });
SpriteSheetRegistry.register('pairB', { animations: { s: ['b0'], n: ['b1'] } });

class Walker extends GameObject {
  static components = [SpriteRenderer];
}
GameObject._assignComponentClassMap(Walker);

test('each sheet answers with its own index for the same name', () => {
  const a = new Walker(0, {}, null, { page: true });
  const b = new Walker(1, {}, null, { page: true });
  SpriteRenderer.spritesheetId[0] = SpriteSheetRegistry.getSpritesheetId('pairA');
  SpriteRenderer.spritesheetId[1] = SpriteSheetRegistry.getSpritesheetId('pairB');
  a.setAnimation('s');
  b.setAnimation('s');
  assert.equal(SpriteRenderer.animationState[0], 1);
  assert.equal(SpriteRenderer.animationState[1], 0);
  b.setAnimation('n', false);
  assert.equal(SpriteRenderer.animationState[1], 1);
  assert.equal(SpriteRenderer.loop[1], 0);
});

test('an unknown animation is reported and changes nothing', () => {
  const a = new Walker(2, {}, null, { page: true });
  SpriteRenderer.spritesheetId[2] = SpriteSheetRegistry.getSpritesheetId('pairA');
  a.setAnimation('n');
  const errors = [];
  const error = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    a.setAnimation('jump');
  } finally {
    console.error = error;
  }
  assert.equal(SpriteRenderer.animationState[2], 0);
  assert.match(errors[0], /Animation "jump" not found in "pairA"/);
});

test('the kernel runs (same animation every call, and turning)', async () => {
  const log = console.log;
  console.log = () => {};
  try {
    const r = await runSetAnimationMicrobench({ entities: 64 });
    assert.ok(r.same.callsPerSec > 0 && r.turn.callsPerSec > 0);
  } finally {
    console.log = log;
  }
});
