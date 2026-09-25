import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendStampedCasters,
  dropTinyFloorShadows,
  compactShadowCasterIndices,
  takeClosest,
  selectClosestCasters,
  linkCastersToClosestLights,
  collectLightCasters,
  resolveGpuShadowPath,
  resolveGpuShadowCookies,
  resolveShadowUpdateInterval,
  rtPixelSize,
  rtPixelScale,
  samePackedIndices,
  writeCasterPose,
  copyTypedRange,
} from '../../src/render/gpuShadowCasters.js';

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

test('selectClosestCasters and per-entity light links honor knobs', () => {
  const casterIdx = new Uint32Array([0, 1, 2]);
  const qx = new Float32Array([0, 10, 100]);
  const qy = new Float32Array([0, 0, 0]);
  const tmpDist = new Float32Array(8);
  const order = new Uint32Array(8);
  const out = new Uint32Array(8);
  const n = selectClosestCasters(casterIdx, 3, qx, qy, 0, 0, 1, tmpDist, order, out);
  assert.equal(n, 1);
  assert.equal(out[0], 0);

  const lightData = new Float32Array(8);
  lightData[0] = 0;
  lightData[1] = 0;
  lightData[4] = 100;
  lightData[5] = 0;
  const head = new Int32Array(2);
  const nodeNext = new Int32Array(16);
  const nodeCaster = new Int32Array(16);
  const slots = new Uint32Array(4);
  const sdist = new Float32Array(4);
  linkCastersToClosestLights({
    casterIdx,
    casterCount: 3,
    qx,
    qy,
    lightData,
    nLights: 2,
    maxPerEntity: 1,
    head,
    nodeNext,
    nodeCaster,
    scratchSlots: slots,
    scratchDist: sdist,
  });
  const collected = new Uint32Array(8);
  const n0 = collectLightCasters(
    head, nodeNext, nodeCaster, 0, qx, qy, 0, 0, 0, out, tmpDist, order, collected
  );
  const n1 = collectLightCasters(
    head, nodeNext, nodeCaster, 1, qx, qy, 100, 0, 0, out, tmpDist, order, collected
  );
  assert.ok(n0 >= 1);
  assert.ok(n1 >= 1);
});

test('copyTypedRange copies without wrapping a view', () => {
  const src = new Float32Array([9, 8, 7, 6, 5]);
  const dst = new Float32Array(6);
  copyTypedRange(dst, 1, src, 2, 3);
  assert.deepEqual(Array.from(dst), [0, 7, 6, 5, 0, 0]);
});

test('appendStampedCasters copies subsets and stamps one light each', () => {
  const sf = 22;
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
  assert.equal(dst[18], 1);
  assert.equal(dst[21], 4);
  assert.equal(dst[sf + 18], 1);
  assert.equal(dst[sf + 21], 4);
  const wroteCap = appendStampedCasters(dst, sf, 0, src, sf, idx, 2, light, 1);
  assert.equal(wroteCap, 1);
  const packed = new Float32Array([0, 0, 0, 0, 9, 8, 7, 6]);
  const wroteOff = appendStampedCasters(dst, sf, 0, src, sf, idx, 1, packed, 4, 4);
  assert.equal(wroteOff, 1);
  assert.equal(dst[18], 9);
  assert.equal(dst[21], 6);
});

test('dropTinyFloorShadows keeps shadows at least minPx tall', () => {
  const idx = new Uint32Array([0, 1, 2]);
  const scaleY = new Float32Array([1, 1, 10]);
  const shadowH = new Float32Array([1, 0.5, 1]);
  const n = dropTinyFloorShadows(idx, 3, scaleY, shadowH, 1, 2);
  assert.equal(n, 1);
  assert.equal(idx[0], 2);
});

test('resolveGpuShadowPath and cookies default to copy / always', () => {
  assert.equal(resolveGpuShadowPath('reuse'), 'reuse');
  assert.equal(resolveGpuShadowPath('queue'), 'queue');
  assert.equal(resolveGpuShadowPath('resident'), 'resident');
  assert.equal(resolveGpuShadowPath('batch'), 'batch');
  assert.equal(resolveGpuShadowPath('nope'), 'copy');
  assert.equal(resolveGpuShadowCookies('night'), 'night');
  assert.equal(resolveGpuShadowCookies('always'), 'always');
  assert.equal(resolveGpuShadowCookies(''), 'always');
});

test('rtPixelSize rounds and rtPixelScale matches the real RT', () => {
  assert.equal(rtPixelSize(1919, 0.5), 960);
  assert.equal(rtPixelSize(1919, 0.25), 480);
  assert.equal(rtPixelSize(0, 0.5), 1);
  assert.ok(Math.abs(rtPixelScale(1919, 960) - 960 / 1919) < 1e-9);
  assert.equal(rtPixelScale(0, 10), 1);
});

test('resolveShadowUpdateInterval is 1 unless N>1', () => {
  assert.equal(resolveShadowUpdateInterval(undefined), 1);
  assert.equal(resolveShadowUpdateInterval(1), 1);
  assert.equal(resolveShadowUpdateInterval(0), 1);
  assert.equal(resolveShadowUpdateInterval(2), 2);
  assert.equal(resolveShadowUpdateInterval(3), 3);
});

test('samePackedIndices and writeCasterPose keep the 18-float pose slice', () => {
  const prev = new Uint32Array([1, 4, 9]);
  const next = new Uint32Array([1, 4, 9]);
  assert.equal(samePackedIndices(prev, 3, next, 3), true);
  next[2] = 8;
  assert.equal(samePackedIndices(prev, 3, next, 3), false);
  const data = new Float32Array(18);
  writeCasterPose(data, 0, 10, 20, 1, 0, 2.5, 3, 4);
  assert.equal(data[0], 10);
  assert.equal(data[1], 20);
  assert.equal(data[6], 1);
  assert.equal(data[7], 0);
  assert.equal(data[15], 2.5);
  assert.equal(data[16], 3);
  assert.equal(data[17], 4);
});
