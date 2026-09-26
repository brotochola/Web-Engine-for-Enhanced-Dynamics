import test from 'node:test';
import assert from 'node:assert/strict';
import { SPRITE_ALPHA_MODE } from '../../src/util/configDefaults.js';
import { writeRowAlphaMode } from '../../src/render/alphaModePack.js';

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
