import test from 'node:test';
import assert from 'node:assert/strict';

import { Tween, tweenBufferBytes } from '../../src/core/tween.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { bindEntityIdWidth } from '../../src/util/entityIdWidth.js';
import { encodeSaveUncompressed, decodeSaveUncompressed } from '../../src/core/save/entitySaveSnapshot.js';

// With entityIdWidth: 32 an entity index can exceed 65535. The tween pool and the save
// format must keep the whole index, or a tween animates (and a load restores onto)
// index & 0xffff: 70000 becomes 4464.

const BIG = 70000;

function sprites(n) {
  SpriteRenderer.active = new Uint8Array(n).fill(1);
  SpriteRenderer.alpha = new Float32Array(n).fill(1);
  SpriteRenderer.tint = new Uint32Array(n).fill(0xffffff);
  SpriteRenderer.scaleX = new Float32Array(n).fill(1);
  SpriteRenderer.scaleY = new Float32Array(n).fill(1);
  SpriteRenderer.renderDirty = new Uint8Array(n);
}

test('at entity id width 32 a tween animates the entity it was started on', () => {
  try {
    bindEntityIdWidth(32);
    sprites(BIG + 1);
    Tween.bind(new SharedArrayBuffer(tweenBufferBytes(4)), 4);
    assert.equal(Tween.to(BIG, { alpha: 0 }, 100), 0);
    assert.equal(Tween.entity[0], BIG);
    Tween.tick(100);
    assert.equal(SpriteRenderer.alpha[BIG], 0, 'entity 70000 animated');
    assert.equal(SpriteRenderer.alpha[BIG & 0xffff], 1, 'entity 4464 untouched');
    Tween.cancel(BIG);
  } finally {
    Tween.unbind();
    bindEntityIdWidth(16);
  }
});

// Same minimal payload as saveWorldBuffers.test.js's roundtrip().
function roundtrip(partial) {
  return decodeSaveUncompressed(encodeSaveUncompressed({
    sceneName: 'T',
    engineVersion: '0',
    layout: { types: [], totalEntityCount: 0 },
    camera: null,
    sun: null,
    entities: [],
    joints: [],
    ...partial,
  }));
}

test('a saved tween keeps an entity index above 65535', () => {
  const rec = {
    kind: 0, ease: 0, mask: 1, entity: BIG, duration: 100, elapsed: 25,
    from0: 1, to0: 0, from1: 0, to1: 0, from2: 0, to2: 0, from3: 0, to3: 0,
    tintFrom: 0xffffff, tintTo: 0,
  };
  const back = roundtrip({ tweens: [rec] });
  assert.equal(back.tweens.length, 1);
  assert.equal(back.tweens[0].entity, BIG);
  assert.equal(back.tweens[0].elapsed, 25);
});

