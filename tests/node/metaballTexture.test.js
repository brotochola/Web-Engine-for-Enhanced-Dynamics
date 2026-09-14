import test from 'node:test';
import assert from 'node:assert/strict';

import {
  METABALL_TEXTURE_RADIUS,
  fillMetaballRgba,
  createMetaballCanvas,
} from '../../src/util/utils.js';

function alphaAt(data, size, x, y) {
  return data[(y * size + x) * 4 + 3];
}

test('fillMetaballRgba: 64x64, center ~1, corner 0, mid matches 1-d²', () => {
  const radius = 32;
  const size = radius * 2;
  const data = new Uint8ClampedArray(size * size * 4);
  fillMetaballRgba(data, size, radius, 0xffffff);

  assert.equal(size, 64);
  assert.equal(METABALL_TEXTURE_RADIUS, 32);

  const cx = radius;
  const cy = radius;
  assert.ok(alphaAt(data, size, cx, cy) >= 250, `center alpha=${alphaAt(data, size, cx, cy)}`);
  assert.equal(alphaAt(data, size, 0, 0), 0);
  assert.equal(alphaAt(data, size, size - 1, size - 1), 0);

  // Mid-radius along +x from pixel-center convention (cx = radius - 0.5)
  const x = (radius - 0.5 + radius * 0.5) | 0;
  const dx = (x - (radius - 0.5)) / radius;
  const expected = Math.max(0, 1 - dx * dx);
  const got = alphaAt(data, size, x, cy) / 255;
  assert.ok(Math.abs(got - expected) < 0.02, `mid alpha got=${got} expected=${expected}`);
});

test('createMetaballCanvas: size 64 and readable pixels when canvas API exists', () => {
  let canvas;
  try {
    canvas = createMetaballCanvas(32);
  } catch (err) {
    if (String(err.message).includes('No canvas API')) {
      // Node without OffscreenCanvas / DOM — RGBA fill path already covered.
      return;
    }
    throw err;
  }
  assert.equal(canvas.width, 64);
  assert.equal(canvas.height, 64);
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, 64, 64);
  assert.ok(alphaAt(img.data, 64, 32, 32) >= 250);
  assert.equal(alphaAt(img.data, 64, 0, 0), 0);
});
