// DX-SHADOW3D, F7 option C: a lamp's shadow map in the floor's terms (lampShadowMap.js), on its formulas.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LAMP_MAP_MAX_STRETCH, lampLanding, lampTileLayout, lampTileUv } from '../../src/render/lampShadowMap.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('a point lands along the lamp\'s ray: on the floor it stays, higher it goes farther, at half the height twice as far', () => {
  const out = new Float64Array(2);
  lampLanding(130, 100, 0, 100, 100, 150, out);
  assert.deepEqual(Array.from(out), [130, 100], 'a floor point is its own landing');
  lampLanding(130, 100, 75, 100, 100, 150, out);
  close(out[0], 160);
  close(out[1], 100);
  // A car under a lamp at 150 px casts a short shadow, under one at 40 px a long one (plan F7's check).
  const tall = lampLanding(110, 100, 20, 100, 100, 150, new Float64Array(2))[0] - 110;
  const low = lampLanding(110, 100, 20, 100, 100, 40, new Float64Array(2))[0] - 110;
  assert.ok(low > 5 * tall, `${low} against ${tall}`);
});

test('every point of one ray from the lamp lands on the same floor point, so the map keeps the nearest one', () => {
  // The ray from a lamp at (0, 0, 100) through (10, 0, 50) goes on to (20, 0, 0): all land at x = 20.
  const a = lampLanding(10, 0, 50, 0, 0, 100, new Float64Array(2));
  const b = lampLanding(20, 0, 0, 0, 0, 100, new Float64Array(2));
  const c = lampLanding(15, 0, 25, 0, 0, 100, new Float64Array(2));
  close(a[0], 20);
  close(b[0], 20);
  close(c[0], 20);
});

test('a point at or above the lamp\'s height is stretched no more than the cap', () => {
  const out = lampLanding(110, 100, 150, 100, 100, 150, new Float64Array(2));
  close(out[0], 100 + 10 * LAMP_MAP_MAX_STRETCH);
});

test('the tiles: as many a row as fit, a floor point in its lamp\'s tile or out of it', () => {
  assert.deepEqual(lampTileLayout(48, 256), { perRow: 16, width: 4096, height: 768, size: 256 });
  assert.deepEqual(lampTileLayout(1, 256), { perRow: 1, width: 256, height: 256, size: 256 });
  assert.deepEqual(lampTileUv(100, 100, 100, 100, 300), [0.5, 0.5]);
  assert.equal(lampTileUv(401, 100, 100, 100, 300), null);
  assert.deepEqual(lampTileUv(-199, 100, 100, 100, 300).map((v) => Math.round(v * 1000) / 1000), [0.002, 0.5]);
});
