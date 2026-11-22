// DX-SHADOW3D, F7 option C: a lamp's shadow map in the floor's terms (lampShadowMap.js), on its formulas. DX-LAMPPANO: the
// panorama's two halves (the ceiling's the world mirrored in the lamp's height) and the landing compressed to the horizon.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LAMP_MAP_MAX_STRETCH, LAMP_MAP_MAX_TEXELS, LAMP_PANO_INNER, autoLampTileSize, lampColumnGrid, lampColumnIndex,
  lampTileLayout, writeLampTile, writeLampTileOwner,
} from '../../src/render/lampShadowMap.js';
import {
  VOLUME_LAMP_CACHE_FRAGMENT, VOLUME_LAMP_FRAGMENT, volumeLampVertex, volumeLampWgsl, writeVolumeLampTerms,
} from '../../src/render/volumeShadowMap.js';
import { lampLanding, lampPanoLanding, lampPanoTexel, lampPanoUv, lampRayDepth, lampVolumeRayT } from '../reference/lightMapsJs.mjs';
import { readEngineShader } from './engineShaderSources.mjs';

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

test('N-276: a place in a half tile gives its landing back, within the reach and in the ring', () => {
  const uv = new Float64Array(2);
  const back = new Float64Array(2);
  for (const [dx, dy] of [[30, -40], [0, 0], [-250, 10], [600, 900], [-5000, 20]]) {
    lampPanoUv(dx, dy, 260, uv);
    lampPanoLanding(uv[0], uv[1], 260, back);
    close(back[0], dx, 1e-7 * Math.max(1, Math.abs(dx)));
    close(back[1], dy, 1e-7 * Math.max(1, Math.abs(dy)));
  }
});

test('N-276: a volume\'s texel is where its own ray meets the face, whatever point of the face the fragment stood for', () => {
  // A house's front (the plane y = 400) under a lamp at (410, 460), 50 px up, its reach 260; the house is taller than the
  // lamp, so its top vertices are drawn at the stretch's cap and its front's inside was interpolated far nearer the lamp
  // than the front is. Each texel's ray meets the front where lampLanding lands the front's point there, inside the reach
  // and in the ring past it, from any point of the face (one above the lamp too) and its normal.
  const uv = new Float64Array(2);
  const land = new Float64Array(2);
  for (const z of [0, 5, 25, 45, 49]) {
    lampLanding(330, 400, z, 410, 460, 50, land);
    lampPanoUv(land[0] - 410, land[1] - 460, 260, uv);
    const t = lampVolumeRayT(500, 400, 70, 0, 1, 0, uv[0], uv[1], 410, 460, 50, 260);
    close(50 * (1 - t), z, 1e-6);
  }
  // A roof above the lamp meets every ray behind the lamp: nothing for the floor's half. One under it: where the ray
  // comes down to its height.
  lampPanoUv(-30, -100, 260, uv);
  assert.ok(lampVolumeRayT(400, 380, 80, 0, 0, 1, uv[0], uv[1], 410, 460, 50, 260) <= 0);
  close(lampVolumeRayT(400, 380, 20, 0, 0, 1, uv[0], uv[1], 410, 460, 50, 260), 0.6, 1e-9);
  // Edge-on (the ray in the face's plane: a wall along the ray), the point's own place.
  close(lampVolumeRayT(410, 300, 30, 1, 0, 0, 0.5, 0.25, 410, 460, 50, 260), 0.4, 1e-12);
  // The shaders write that depth and that place, not the vertices': WebGL and WebGPU, the map and its cache (E-508).
  for (const glsl of [VOLUME_LAMP_FRAGMENT, VOLUME_LAMP_CACHE_FRAGMENT]) {
    assert.ok(glsl.includes('float t = lampVolumeT(vLampP, dqx, dqy, tuv, vLamp);') && glsl.includes('gl_FragDepth = depth;'));
    assert.ok(glsl.indexOf('dFdx(vLampP)') < glsl.indexOf('discard'), 'the derivatives before any discard');
  }
  assert.ok(VOLUME_LAMP_CACHE_FRAGMENT.includes('floatBitsToUint(depth)'), 'the cache keeps the depth written');
  const wgsl = volumeLampWgsl(readEngineShader('meshUvFill.wgsl'));
  assert.equal(wgsl.split('@builtin(frag_depth) depth: f32,').length, 3, 'both lamp entries write their depth');
  assert.ok(wgsl.includes('let b = bitcast<u32>(texel.y);'));
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

test('N-211: a texel keeps the place along the ray, finest around the lamp\'s height, nearer the lamp more', async () => {
  close(lampRayDepth(20, 20), 1);
  close(lampRayDepth(0, 20), 0.5, 1e-12);
  // Nearer the lamp's height on both halves: more (a caster between a point and its lamp holds more than the point).
  assert.ok(lampRayDepth(15, 20) > lampRayDepth(10, 20) && lampRayDepth(25, 20) > lampRayDepth(30, 20));
  // The bench's person against the barn's wall under a 20 px lamp: wall 26 px up, the person's point on that ray 24.2 px:
  // in heights under a 2 px step apart, here 14 of the texel's 255 steps.
  assert.ok((lampRayDepth(24.2, 20) - lampRayDepth(26, 20)) * 255 > 10);
});

test('E-389, E-453: the volumes go into every lamp tile in one draw, an instance a tile, a mesh left out whole by its reach', () => {
  // The batch draws each mesh's vertices once through its index buffer (E-453); the lamps' map draws that with an
  // instance a tile in use, so each triangle reaches each tile with the same vertices, tile after tile.
  const glsl = volumeLampVertex(readEngineShader('meshUvFill.vert.glsl'));
  const wgsl = volumeLampWgsl(readEngineShader('meshUvFill.wgsl'));
  // The tile from the instance's entry in its draw's list (E-508: the tiles' texture's row 2, from uLampVolume.x), the
  // half tile it draws into beside it; no vertex number, no corner.
  assert.ok(glsl.includes('ivec2(int(uLampVolume.x + 0.5) + gl_InstanceID, 2)') && glsl.includes('int lampTile = int(lampEntry.x + 0.5);'));
  assert.ok(glsl.includes('vec2 lampPx = (lampEntry.yz + lampUv) * uLampVolume.z;'));
  assert.ok(!/aLampVertex|lampCorner|gl_VertexID|aTri\b/.test(glsl));
  assert.ok(wgsl.includes('@builtin(instance_index) lampInstance: u32,') && wgsl.includes('i32(lampInstance), 2)'));
  assert.ok(wgsl.includes('let lampTile = i32(lampEntry.x + 0.5);') && wgsl.includes('let lampPx = (lampEntry.yz + lampUv)'));
  assert.ok(!/aLampVertex|lampCorner|vertex_index|aTri\b/.test(wgsl));
  // The cull reads the mesh's reach, the same in each of its vertices, so a triangle is kept or left out whole.
  assert.ok(glsl.includes('float lampPad = aInstReach * ') && wgsl.includes('let lampPad = aInstReach * '));
  assert.ok(!/length\(aV[012]\)/.test(glsl) && !/length\(aV[012]\)/.test(wgsl));
  // The height is the vertex's own.
  assert.ok(glsl.includes('float lampZ = max(height, 0.0) * uSunShadow.w;'));
  assert.ok(wgsl.includes('let lampZ = max(height, 0.0) * sunShadow.uSunShadow.w;'));
  // Its lamp and its owner from the tiles' texture; no uniform names a tile or an owner any more.
  assert.ok(glsl.includes('ivec2(lampTile, 1)') && !glsl.includes('uLampOwner'));
  assert.ok(wgsl.includes('vec2<i32>(lampTile, 1)') && !wgsl.includes('uLampOwner'));
  // The tiles' texture: each tile's lamp in row 0 and, under it in row 1, the entity whose own volume casts nothing for it.
  const width = 3;
  const data = new Float32Array(width * 8);
  writeLampTile(data, 1, 10, 20, 30, 40);
  writeLampTileOwner(data, width, 1, 4242);
  assert.deepEqual(Array.from(data.subarray(4, 8)), [10, 20, 30, 40]);
  assert.deepEqual(Array.from(data.subarray((width + 1) * 4, (width + 2) * 4)), [4242, 0, 0, 0]);
  // The draw's terms: its list's first entry (no tile of its own any more), written only when they change.
  const sun = new Float32Array(4);
  const lamp = new Float32Array(4);
  const scales = new Float64Array([0.5, 2]);
  assert.equal(writeVolumeLampTerms(sun, lamp, 47, 8, 256, scales), true);
  assert.deepEqual(Array.from(sun), [0, 0, 1, 0.5]);
  assert.deepEqual(Array.from(lamp), [47, 8, 256, 2]);
  assert.equal(writeVolumeLampTerms(sun, lamp, 47, 8, 256, scales), false, 'unchanged: the group is not updated');
});
