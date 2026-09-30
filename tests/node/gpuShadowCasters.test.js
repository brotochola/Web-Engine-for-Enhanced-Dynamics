import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendStampedCasters,
  compactShadowCasterIndices,
  takeClosest,
  stampLightRange,
  rtPixelSize,
  rtPixelScale,
  copyTypedRange,
  CASTER_LIGHT_FLOAT,
} from '../../src/render/gpuShadowCasters.js';
import { GPU_CASTER_FLOATS, GPU_CASTER_LIGHT_FLOAT } from '../../src/render/gpuQueueLayout.js';

test('compactShadowCasterIndices keeps shadowH>0 and skips glow type 3', () => {
  const shadowH = new Float32Array([0, 2, 1, 0, 3]);
  const typeArr = new Uint8Array([0, 0, 3, 0, 1]);
  const out = new Uint32Array(8);
  const n = compactShadowCasterIndices(shadowH, typeArr, 5, out);
  assert.equal(n, 2);
  assert.equal(out[0], 1);
  assert.equal(out[1], 4);
});

test('takeClosest keeps the N smallest dist entries', () => {
  const tmpIdx = new Uint32Array([10, 11, 12, 13]);
  const tmpDist = new Float32Array([9, 1, 4, 0.5]);
  const order = new Uint32Array(8);
  const out = new Uint32Array(8);
  const n = takeClosest(tmpIdx, tmpDist, order, 4, 2, out);
  assert.equal(n, 2);
  assert.equal(out[0], 13);
  assert.equal(out[1], 11);
});

test('copyTypedRange copies without wrapping a view', () => {
  const src = new Float32Array([9, 8, 7, 6, 5]);
  const dst = new Float32Array(6);
  copyTypedRange(dst, 1, src, 2, 3);
  assert.deepEqual(Array.from(dst), [0, 7, 6, 5, 0, 0]);
});

test('appendStampedCasters copies subsets and stamps one light each', () => {
  const sf = GPU_CASTER_FLOATS;
  const src = new Float32Array(3 * sf);
  src[0] = 10;
  src[sf] = 20;
  src[sf * 2] = 30;
  const dst = new Float32Array(4 * sf);
  const idx = new Uint32Array([2, 0]);
  const light = new Float32Array([1, 2, 3, 4]);
  const wrote = appendStampedCasters(dst, sf, 0, src, sf, idx, 2, light, 4);
  assert.equal(wrote, 2);
  assert.equal(dst[0], 30);
  assert.equal(dst[sf], 10);
  assert.equal(dst[CASTER_LIGHT_FLOAT], 1);
  assert.equal(dst[CASTER_LIGHT_FLOAT + 3], 4);
  assert.equal(dst[sf + CASTER_LIGHT_FLOAT], 1);
  assert.equal(dst[sf + CASTER_LIGHT_FLOAT + 3], 4);
  const wroteCap = appendStampedCasters(dst, sf, 0, src, sf, idx, 2, light, 1);
  assert.equal(wroteCap, 1);
  const packed = new Float32Array([0, 0, 0, 0, 9, 8, 7, 6]);
  const wroteOff = appendStampedCasters(dst, sf, 0, src, sf, idx, 1, packed, 4, 4);
  assert.equal(wroteOff, 1);
  assert.equal(dst[CASTER_LIGHT_FLOAT], 9);
  assert.equal(dst[CASTER_LIGHT_FLOAT + 3], 6);
});

test('appendStampedCasters keeps the light vec4 inside a 22-float row', () => {
  const fp = GPU_CASTER_FLOATS;
  assert.equal(CASTER_LIGHT_FLOAT, GPU_CASTER_LIGHT_FLOAT);
  assert.equal(CASTER_LIGHT_FLOAT + 3, fp - 1);
  const src = new Float32Array(fp);
  src[0] = 10;
  src[1] = 20;
  src[15] = 2.5;
  src[16] = 0.1;
  src[17] = 0.2;
  const dst = new Float32Array(fp + 1);
  dst[fp] = 12345;
  const light = new Float32Array([4, 5, 6, 7]);
  const n = appendStampedCasters(dst, fp, 0, src, fp, new Uint32Array([0]), 1, light, 1);
  assert.equal(n, 1);
  assert.equal(dst[0], 10);
  assert.equal(dst[15], 2.5);
  assert.ok(Math.abs(dst[16] - 0.1) < 1e-6);
  assert.ok(Math.abs(dst[17] - 0.2) < 1e-6);
  assert.equal(dst[18], 4);
  assert.equal(dst[19], 5);
  assert.equal(dst[20], 6);
  assert.equal(dst[21], 7);
  assert.equal(dst[fp], 12345);
});

test('rtPixelSize rounds and rtPixelScale matches the real RT', () => {
  assert.equal(rtPixelSize(1919, 0.5), 960);
  assert.equal(rtPixelSize(1919, 0.25), 480);
  assert.equal(rtPixelSize(0, 0.5), 1);
  assert.ok(Math.abs(rtPixelScale(1919, 960) - 960 / 1919) < 1e-9);
  assert.equal(rtPixelScale(0, 10), 1);
});


test('stampLightRange stripe concat matches serial pairs when maxPerEntity is 0', () => {
  const fp = GPU_CASTER_FLOATS;
  const sunN = 4;
  const sun = new Float32Array(sunN * fp);
  sun[0] = 0; sun[1] = 0;
  sun[fp] = 10; sun[fp + 1] = 0;
  sun[fp * 2] = 40; sun[fp * 2 + 1] = 0;
  sun[fp * 3] = 80; sun[fp * 3 + 1] = 0;
  const lights = [
    { x: 0, y: 0, intensity: 1, rangeSq: 2500 },
    { x: 10, y: 0, intensity: 1, rangeSq: 2500 },
    { x: 40, y: 0, intensity: 1, rangeSq: 2500 },
    { x: 80, y: 0, intensity: 1, rangeSq: 2500 },
  ];
  function run(begin, stride) {
    const stamp = new Float32Array(32 * fp);
    const lightIdx = new Uint16Array(32);
    const tmpIdx = new Uint32Array(8);
    const dist = new Float32Array(8);
    const order = new Uint32Array(8);
    const keepIdx = new Uint32Array(8);
    const lightVec = new Float32Array(4);
    const n = stampLightRange({
      sun, sunN, sunFloats: fp, lights,
      lightBegin: begin, lightEnd: lights.length, lightStride: stride,
      maxPerLight: 2, maxPerEntity: 0, used: null,
      tmpIdx, dist, order, keepIdx,
      stamp, stampFloats: fp, stampCap: 32, stampBase: 0,
      stampLightIdx: lightIdx, lightVec,
    });
    const pairs = [];
    for (let i = 0; i < n; i++) {
      pairs.push(`${lightIdx[i]}:${stamp[i * fp]}`);
    }
    return pairs.sort();
  }
  const serial = run(0, 1);
  const concat = run(0, 2).concat(run(1, 2)).sort();
  assert.deepEqual(concat, serial);
  assert.ok(serial.length >= 4);
});

test('stamp grid matches the full scan, including a caster on the circle', () => {
  const fp = GPU_CASTER_FLOATS;
  const sunN = 6;
  const sun = new Float32Array(sunN * fp);
  const pts = [[0, 0], [100, 0], [256, 40], [300, 300], [20, 20], [1000, 1000]];
  for (let i = 0; i < pts.length; i++) {
    sun[i * fp] = pts[i][0];
    sun[i * fp + 1] = pts[i][1];
  }
  const lights = [
    { x: 0, y: 0, intensity: 2, rangeSq: 100 * 100 },
    { x: 256, y: 40, intensity: 1, rangeSq: 30 * 30 },
    { x: 1000, y: 1000, intensity: 3, rangeSq: 50 * 50 },
  ];
  const gridCounts = new Int32Array(128 * 128);
  const gridStarts = new Int32Array(128 * 128 + 1);
  const gridItems = new Uint32Array(sunN);
  function run(useGrid) {
    const stamp = new Float32Array(64 * fp);
    const lightIdx = new Uint16Array(64);
    const used = new Uint8Array(sunN);
    const n = stampLightRange({
      sun, sunN, sunFloats: fp, lights,
      lightBegin: 0, lightEnd: lights.length, lightStride: 1,
      maxPerLight: 3, maxPerEntity: 1, used,
      tmpIdx: new Uint32Array(sunN),
      dist: new Float32Array(sunN),
      order: new Uint32Array(sunN),
      keepIdx: new Uint32Array(sunN),
      gridCounts: useGrid ? gridCounts : null,
      gridStarts: useGrid ? gridStarts : null,
      gridItems: useGrid ? gridItems : null,
      stamp, stampFloats: fp, stampCap: 64, stampBase: 0,
      stampLightIdx: lightIdx, lightVec: new Float32Array(4),
    });
    const pairs = [];
    for (let i = 0; i < n; i++) pairs.push(`${lightIdx[i]}:${stamp[i * fp]},${stamp[i * fp + 1]}`);
    return pairs;
  }
  assert.deepEqual(run(true), run(false));
});
