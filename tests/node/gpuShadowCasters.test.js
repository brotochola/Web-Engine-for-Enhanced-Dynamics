import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendStampedCasters,
  compactShadowCasterIndices,
  compactStampByLightLimit,
  takeClosest,
  selectClosestCasters,
  linkCastersToClosestLights,
  collectLightCasters,
  rtPixelSize,
  rtPixelScale,
  writeCasterPose,
  copyTypedRange,
  CASTER_LIGHT_FLOAT,
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
  const sf = 23;
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

test('rtPixelSize rounds and rtPixelScale matches the real RT', () => {
  assert.equal(rtPixelSize(1919, 0.5), 960);
  assert.equal(rtPixelSize(1919, 0.25), 480);
  assert.equal(rtPixelSize(0, 0.5), 1);
  assert.ok(Math.abs(rtPixelScale(1919, 960) - 960 / 1919) < 1e-9);
  assert.equal(rtPixelScale(0, 10), 1);
});

test('writeCasterPose writes shadow extras after alphaCut', () => {
  const data = new Float32Array(23);
  writeCasterPose(data, 0, 10, 20, 1, 0, 2.5, 3, 4);
  assert.equal(data[0], 10);
  assert.equal(data[1], 20);
  assert.equal(data[6], 1);
  assert.equal(data[7], 0);
  assert.equal(data[16], 2.5);
  assert.equal(data[17], 3);
  assert.equal(data[18], 4);
});

test('compactStampByLightLimit keeps the closest casters per light', () => {
  const fp = 23;
  const stamp = new Float32Array(4 * fp);
  const lightIdx = new Uint16Array([0, 0, 0, 1]);
  for (let i = 0; i < 4; i++) {
    stamp[i * fp] = i * 10;
    stamp[i * fp + 1] = 0;
    stamp[i * fp + CASTER_LIGHT_FLOAT] = 0;
    stamp[i * fp + CASTER_LIGHT_FLOAT + 1] = 0;
  }
  stamp[3 * fp + CASTER_LIGHT_FLOAT] = 100;
  const tmpIdx = new Uint32Array(8);
  const tmpDist = new Float32Array(8);
  const order = new Uint32Array(8);
  const keepIdx = new Uint32Array(8);
  const keepAll = new Uint32Array(8);
  const scratch = new Float32Array(stamp.length);
  const scratchLight = new Uint16Array(8);
  const n = compactStampByLightLimit(
    stamp, lightIdx, 4, fp, 1,
    tmpIdx, tmpDist, order, keepIdx, keepAll, scratch, scratchLight
  );
  assert.equal(n, 2);
  assert.equal(lightIdx[0], 0);
  assert.equal(lightIdx[1], 1);
  assert.equal(stamp[0], 0);
  assert.equal(stamp[fp], 30);
});
