import test from 'node:test';
import assert from 'node:assert/strict';

import { Tween, tweenBufferBytes } from '../../src/core/tween.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { bindEntityIdWidth } from '../../src/util/entityIdWidth.js';
import { encodeSaveUncompressed, decodeSaveUncompressed } from '../../src/core/save/entitySaveSnapshot.js';
import { SECTION, encodeBinarySaveBody, decodeBinarySaveBody } from '../../src/core/save/binarySaveCodec.js';

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

// Saves written between 67a93c49 and B12 carry tag 14: no layout byte, u16 entity.
// Body framing: u16 section count, then per section u16 tag, u32 length, bytes (LE).
test('a save written with the legacy TWEENS section still loads', () => {
  const base = new Uint8Array(encodeBinarySaveBody({
    sceneName: 'T',
    engineVersion: '0',
    layout: { types: [], totalEntityCount: 0 },
    camera: null,
    sun: null,
    entities: [],
    joints: [],
  }));
  const rec = new DataView(new ArrayBuffer(4 + 3 + 2 + 40 + 8));
  let o = 0;
  rec.setUint32(o, 1, true); o += 4;
  rec.setUint8(o++, 0); // kind
  rec.setUint8(o++, 0); // ease
  rec.setUint8(o++, 1); // mask
  rec.setUint16(o, 4464, true); o += 2;
  const floats = [100, 25, 1, 0, 0, 0, 0, 0, 0, 0];
  for (const f of floats) { rec.setFloat32(o, f, true); o += 4; }
  rec.setUint32(o, 0xffffff, true); o += 4;
  rec.setUint32(o, 0, true); o += 4;

  const head = new DataView(new ArrayBuffer(2 + 4));
  const out = new Uint8Array(base.byteLength + head.byteLength + rec.byteLength);
  out.set(base, 0);
  new DataView(out.buffer).setUint16(0, new DataView(base.buffer).getUint16(0, true) + 1, true);
  head.setUint16(0, SECTION.TWEENS, true);
  head.setUint32(2, rec.byteLength, true);
  out.set(new Uint8Array(head.buffer), base.byteLength);
  out.set(new Uint8Array(rec.buffer), base.byteLength + head.byteLength);

  const back = decodeBinarySaveBody(out);
  assert.equal(back.tweens.length, 1);
  assert.equal(back.tweens[0].entity, 4464);
  assert.equal(back.tweens[0].elapsed, 25);
  assert.equal(back.tweens[0].tintFrom, 0xffffff);
});
