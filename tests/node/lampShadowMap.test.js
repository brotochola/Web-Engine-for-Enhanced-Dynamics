// DX-SHADOW3D, F7 option C: a lamp's shadow map in the floor's terms (lampShadowMap.js), on its formulas. DX-LAMPPANO: the
// panorama's two halves (the ceiling's the world mirrored in the lamp's height) and the landing compressed to the horizon.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LAMP_MAP_MAX_STRETCH, LAMP_MAP_MAX_TEXELS, LAMP_PANO_INNER, autoLampTileSize, lampColumnGrid, lampColumnIndex,
  lampLanding, lampPanoTexel, lampPanoUv, lampTileLayout,
} from '../../src/render/lampShadowMap.js';

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

test('DX-LAMPPANO: a point above the lamp lands as its mirror, and one at the lamp\'s height at the most stretch', () => {
  const up = lampLanding(110, 100, 175, 100, 100, 150, new Float64Array(2));
  const mirror = lampLanding(110, 100, 125, 100, 100, 150, new Float64Array(2));
  close(up[0], mirror[0]);
  close(lampLanding(110, 100, 150, 100, 100, 150, new Float64Array(2))[0], 100 + 10 * LAMP_MAP_MAX_STRETCH);
});

test('DX-LAMPPANO: a landing goes linearly into its half within the reach, the rest of the world into the ring', () => {
  const out = new Float64Array(2);
  assert.deepEqual(Array.from(lampPanoUv(0, 0, 300, out)), [0.5, 0.5], 'the lamp at the centre');
  lampPanoUv(300, 0, 300, out);
  close(out[0], 0.5 + 0.5 * LAMP_PANO_INNER, 1e-12);
  lampPanoUv(150, 0, 300, out);
  close(out[0], 0.5 + 0.25 * LAMP_PANO_INNER, 1e-12);
  // Continuous across the reach, rising towards the edge (the horizon) and never past it.
  const at = (r) => lampPanoUv(r, 0, 300, new Float64Array(2))[0];
  assert.ok(Math.abs(at(300.001) - at(299.999)) < 1e-5);
  assert.ok(at(600) > at(300) && at(6000) > at(600) && at(1e9) < 1);
  close(at(600), 0.5 + 0.5 * (LAMP_PANO_INNER + (1 - LAMP_PANO_INNER) * 0.5), 1e-12);
});

test('DX-LAMPPANO: a point higher than the lamp reads the ceiling, where a taller caster nearer the lamp lands with it', () => {
  // A lamp at (0, 0, 20), reach 600. A wall point at x 200, 60 px up; a fence post at x 50, 35 px up, on the same ray
  // (20 + (60 - 20) x 50 / 200 = 30 under the post's top): the post's point on that ray (30 px) lands where the wall's does.
  const wall = lampPanoTexel(200, 0, 60, 0, 0, 20, 600);
  const post = lampPanoTexel(50, 0, 30, 0, 0, 20, 600);
  assert.equal(wall.half, 1);
  assert.equal(post.half, 1);
  close(wall.u, post.u, 1e-12);
  close(wall.v, post.v, 1e-12);
  assert.equal(lampPanoTexel(200, 0, 10, 0, 0, 20, 600).half, 0, 'a point under the lamp reads the floor');
});

test('the tiles: two halves each, as many a row as fit', () => {
  assert.deepEqual(lampTileLayout(48, 256), { perRow: 8, width: 4096, height: 1536, size: 256 });
  assert.deepEqual(lampTileLayout(1, 256), { perRow: 1, width: 512, height: 256, size: 256 });
});

test('DX-LAMPPANO: the columns\' grid has three rows a cell side, each band two triangles', () => {
  const grid = lampColumnGrid(2);
  assert.equal(grid.length, 2 * 2 * 6 * 4);
  assert.deepEqual(Array.from(grid.slice(0, 24)).filter((_, i) => i % 4 === 2), [0, 0.5, 1, 1, 0.5, 0]);
  const index = lampColumnIndex(2);
  assert.equal(index.length, 2 * 2 * 12);
  assert.ok(Math.max(...index) === 2 * 2 * 6 - 1);
});

test('N-196: lampShadowTile auto makes a tile as fine as the widest lamp and the shadow resolution ask, within the budget', () => {
  // The reach's diameter on 0.8 of a half at most 2 floor px a texel at resolution 1: 660 px want 412 texels, 512;
  // 1800 want 1125, 1024.
  assert.equal(autoLampTileSize(330, 1, 1), 512);
  assert.equal(autoLampTileSize(900, 1, 1), 1024);
  assert.equal(autoLampTileSize(330, 0.5, 1), 256, 'half the resolution, half the texels');
  assert.equal(autoLampTileSize(0, 1, 1), 64, 'no casting lamp: the smallest tile');
  // 32 tiles of 2 x 1024 would be 4096 x 16384: the tile halves until the map fits its budget.
  const size = autoLampTileSize(900, 1, 32);
  const layout = lampTileLayout(32, size);
  assert.equal(size, 256);
  assert.ok(layout.height <= 4096 && layout.width * layout.height <= LAMP_MAP_MAX_TEXELS);
});
