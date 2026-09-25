import test from 'node:test';
import assert from 'node:assert/strict';
import { SPRITE_ALPHA_MODE } from '../../src/util/configDefaults.js';
import {
  queueRowIsBlend,
  partitionCutoutBlend,
  writeRowAlphaMode,
} from '../../src/render/alphaModePack.js';

test('queueRowIsBlend: particles and faded alpha', () => {
  assert.equal(queueRowIsBlend(1, 1, SPRITE_ALPHA_MODE.CUTOUT, 1), false);
  assert.equal(queueRowIsBlend(1, 1, SPRITE_ALPHA_MODE.BLEND, 1), true);
  assert.equal(queueRowIsBlend(1, 0.5, SPRITE_ALPHA_MODE.CUTOUT, 1), true);
  assert.equal(queueRowIsBlend(7, 1, SPRITE_ALPHA_MODE.CUTOUT, 1), true);
  assert.equal(queueRowIsBlend(0, 0.5, SPRITE_ALPHA_MODE.CUTOUT, 1), true);
  assert.equal(queueRowIsBlend(0, 1, SPRITE_ALPHA_MODE.CUTOUT, 1), false);
  assert.equal(queueRowIsBlend(0, 1, SPRITE_ALPHA_MODE.BLEND, 1), true);
  assert.equal(queueRowIsBlend(2, 1, SPRITE_ALPHA_MODE.CUTOUT, 1), false);
  assert.equal(queueRowIsBlend(2, 1, SPRITE_ALPHA_MODE.CUTOUT, 0.4), true);
});

test('partitionCutoutBlend skips glow and splits', () => {
  const type = new Uint8Array([0, 1, 3, 0, 2]);
  const alpha = new Float32Array([1, 1, 1, 1, 1]);
  const mode = new Uint8Array([
    SPRITE_ALPHA_MODE.CUTOUT,
    SPRITE_ALPHA_MODE.CUTOUT,
    SPRITE_ALPHA_MODE.CUTOUT,
    SPRITE_ALPHA_MODE.BLEND,
    SPRITE_ALPHA_MODE.CUTOUT,
  ]);
  const cut = new Uint32Array(8);
  const blend = new Uint32Array(8);
  const r = partitionCutoutBlend(type, alpha, mode, 5, 3, 1, cut, blend);
  assert.equal(r.cutout, 3);
  assert.equal(r.blend, 1);
  assert.equal(cut[0], 0);
  assert.equal(cut[1], 1);
  assert.equal(cut[2], 4);
  assert.equal(blend[0], 3);
});

test('writeRowAlphaMode', () => {
  const dst = new Uint8Array(4);
  const sr = new Uint8Array([SPRITE_ALPHA_MODE.BLEND]);
  const part = new Uint8Array([SPRITE_ALPHA_MODE.CUTOUT]);
  writeRowAlphaMode(dst, 0, 1, 0, sr);
  writeRowAlphaMode(dst, 1, 0, 0, sr);
  writeRowAlphaMode(dst, 2, 4, 0, sr);
  writeRowAlphaMode(dst, 3, 1, 0, sr, part);
  assert.equal(dst[0], SPRITE_ALPHA_MODE.BLEND);
  assert.equal(dst[1], SPRITE_ALPHA_MODE.BLEND);
  assert.equal(dst[2], SPRITE_ALPHA_MODE.CUTOUT);
  assert.equal(dst[3], SPRITE_ALPHA_MODE.CUTOUT);
});
