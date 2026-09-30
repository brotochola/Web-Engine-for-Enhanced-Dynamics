import test from 'node:test';
import assert from 'node:assert/strict';

import { copyPremultiplyRgba } from '../../src/render/webgpu/pinGpuTexture.js';

// Reference: the per-channel formula (matches WebGL UNPACK_PREMULTIPLY).
function reference(dst, src) {
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    dst[i] = a === 255 ? src[i] : a === 0 ? 0 : (src[i] * a * 257 + 32896) >> 16;
    dst[i + 1] = a === 255 ? src[i + 1] : a === 0 ? 0 : (src[i + 1] * a * 257 + 32896) >> 16;
    dst[i + 2] = a === 255 ? src[i + 2] : a === 0 ? 0 : (src[i + 2] * a * 257 + 32896) >> 16;
    dst[i + 3] = a;
  }
}

test('copyPremultiplyRgba matches the per-channel formula for every channel × alpha', () => {
  const src = new Uint8Array(new SharedArrayBuffer(256 * 256 * 4));
  for (let c = 0; c < 256; c++) {
    for (let a = 0; a < 256; a++) {
      const i = (c * 256 + a) * 4;
      src[i] = c;
      src[i + 1] = 255 - c;
      src[i + 2] = (c * 7) & 255;
      src[i + 3] = a;
    }
  }
  const got = new Uint8ClampedArray(src.length).fill(9);
  const want = new Uint8ClampedArray(src.length);
  copyPremultiplyRgba(got, src);
  reference(want, src);
  assert.deepEqual(got, want);
});

test('copyPremultiplyRgba handles views that are not 4-byte aligned', () => {
  const backing = new Uint8Array(4 * 64 + 1);
  for (let i = 0; i < backing.length; i++) backing[i] = (i * 37) & 255;
  const src = backing.subarray(1);
  const got = new Uint8ClampedArray(new ArrayBuffer(src.length + 2), 2, src.length);
  const want = new Uint8ClampedArray(src.length);
  copyPremultiplyRgba(got, src);
  reference(want, src);
  assert.deepEqual(Array.from(got), Array.from(want));
});
