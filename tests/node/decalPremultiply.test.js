import test from 'node:test';
import assert from 'node:assert/strict';
import { copyPremultiplyRgba } from '../../src/render/webgpu/pinGpuTexture.js';

test('copyPremultiplyRgba matches /255 on straight alpha', () => {
  const src = new Uint8ClampedArray([
    200, 10, 0, 255,
    200, 10, 0, 0,
    200, 100, 50, 128,
  ]);
  const dst = new Uint8ClampedArray(src.length);
  copyPremultiplyRgba(dst, src);
  assert.deepEqual([...dst.subarray(0, 4)], [200, 10, 0, 255]);
  assert.deepEqual([...dst.subarray(4, 8)], [0, 0, 0, 0]);
  const a = 128;
  const expect = (c) => (c * a * 257 + 32896) >> 16;
  assert.equal(expect(200), Math.round((200 * a) / 255));
  assert.deepEqual([...dst.subarray(8, 12)], [expect(200), expect(100), expect(50), 128]);
});
