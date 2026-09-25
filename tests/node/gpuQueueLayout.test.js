import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GPU_SPRITE_FLOATS,
  GPU_CASTER_FLOATS,
  GPU_QUEUE_VERSION,
  GPU_HDR_SPRITE,
  GPU_HDR_VERSION,
  GPU_FLAG_BITONIC,
  gpuQueueCaps,
  computeGpuQueueBufferSize,
  createGpuQueueViews,
  writeGpuQueueHeader,
  packGpuSpriteFlags,
  unpackGpuCutoutCount,
  packInstancedRows,
  makePackContext,
  fillQueueIndices,
  copyPackedRows,
} from '../../src/render/gpuQueueLayout.js';

test('gpuQueue SAB views round-trip header and packed rows', () => {
  const lighting = { enabled: true, shadowsEnabled: true, maxLights: 4, maxShadowCastingLights: 2, maxShadowsPerLight: 3, maxShadowsPerEntity: 1 };
  const caps = gpuQueueCaps(8, lighting);
  assert.equal(caps.maxSprites, 8);
  assert.ok(caps.maxStamp >= 2);
  const caps2 = gpuQueueCaps(8, lighting, 2);
  assert.equal(caps2.maxStamp, caps.maxStamp * 2);
  const sab = new ArrayBuffer(computeGpuQueueBufferSize(caps));
  const views = createGpuQueueViews(sab, caps);
  writeGpuQueueHeader(views.header, { sprite: 2, glow: 1, sun: 1, stamp: 0, cookie: 0, particle: 1 }, 0);
  assert.equal(views.header[GPU_HDR_SPRITE], 2);
  assert.equal(GPU_SPRITE_FLOATS, 16);
  assert.equal(GPU_CASTER_FLOATS, 23);
  assert.equal(views.header[GPU_HDR_VERSION], GPU_QUEUE_VERSION);
  views.sprites[0] = 9;
  copyPackedRows(views.sprites, views.glow, 1, GPU_SPRITE_FLOATS, 0);
  assert.equal(views.glow[0], 9);
  assert.ok(views.spriteKeys.length >= caps.maxSprites);
});

test('packGpuSpriteFlags stores cutout count above bitonic flag', () => {
  const packed = packGpuSpriteFlags(GPU_FLAG_BITONIC, 12345);
  assert.equal(packed & 0xff, GPU_FLAG_BITONIC);
  assert.equal(unpackGpuCutoutCount(packed), 12345);
});

test('packInstancedRows writes 16 floats and packs tint+alpha+cut', () => {
  const q = {
    count: 2,
    x: new Float32Array([10, 20]),
    y: new Float32Array([1, 2]),
    scaleX: new Float32Array([1, 1]),
    scaleY: new Float32Array([1, 2]),
    rotC: new Float32Array([1, 1]),
    rotS: new Float32Array([0, 0]),
    alpha: new Float32Array([1, 0.5]),
    tint: new Uint32Array([0xffffff, 0x00ff00]),
    textureId: new Uint16Array([3, 4]),
    anchorX: new Float32Array([0.5, 0.25]),
    anchorY: new Float32Array([1, 1]),
    type: new Uint8Array([0, 1]),
    sortKey: new Float32Array([0, 10]),
    alphaCutOff: new Uint8Array([1, 200]),
  };
  const dst = new Float32Array(4 * GPU_SPRITE_FLOATS);
  const dstU32 = new Uint32Array(dst.buffer);
  const ctx = makePackContext(q, { space: 0, depthDenom: 8, worldHeight: 100, type: q.type }, 8);
  const n = packInstancedRows(q, ctx, dst, dstU32, GPU_SPRITE_FLOATS, 8, false);
  assert.equal(n, 2);
  assert.equal(dst[0], 10);
  assert.equal(dst[1], 1);
  assert.equal(dst[10], 3);
  assert.ok(Math.abs(dst[15] - 1 / 255) < 1e-6);
  assert.ok(Math.abs(dst[GPU_SPRITE_FLOATS + 15] - 200 / 255) < 1e-6);
  const a8 = (0.5 * 255 + 0.5) | 0;
  assert.equal(dstU32[GPU_SPRITE_FLOATS + 9], (((a8 & 255) << 24) | 0x00ff00) >>> 0);
  assert.equal(ctx.particleCount, 1);
});

test('fillQueueIndices skips glow type 3', () => {
  const type = new Uint8Array([0, 3, 1, 3, 0]);
  const out = new Uint32Array(8);
  const n = fillQueueIndices(type, 5, -1, 3, out);
  assert.equal(n, 3);
  assert.deepEqual(Array.from(out.subarray(0, n)), [0, 2, 4]);
});

test('shadow pack writes caster extras', () => {
  const q = {
    count: 1,
    x: new Float32Array([5]),
    y: new Float32Array([6]),
    scaleX: new Float32Array([1]),
    scaleY: new Float32Array([1]),
    rotC: new Float32Array([1]),
    rotS: new Float32Array([0]),
    alpha: new Float32Array([1]),
    tint: new Uint32Array([0xffffff]),
    textureId: new Uint16Array([1]),
    anchorX: new Float32Array([0.5]),
    anchorY: new Float32Array([1]),
    shadowH: new Float32Array([2.5]),
    shadowOffX: new Float32Array([0.1]),
    shadowOffY: new Float32Array([0.2]),
  };
  const dst = new Float32Array(GPU_CASTER_FLOATS);
  const dstU32 = new Uint32Array(dst.buffer);
  const ctx = makePackContext(q, { space: 0, depthDenom: 1 }, 1);
  const n = packInstancedRows(q, ctx, dst, dstU32, GPU_CASTER_FLOATS, 1, true);
  assert.equal(n, 1);
  assert.equal(dst[15], 0);
  assert.equal(dst[16], 2.5);
  assert.ok(Math.abs(dst[17] - 0.1) < 1e-6);
  assert.ok(Math.abs(dst[18] - 0.2) < 1e-6);
});
