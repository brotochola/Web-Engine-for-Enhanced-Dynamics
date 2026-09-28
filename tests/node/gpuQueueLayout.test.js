import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GPU_SPRITE_FLOATS,
  GPU_CASTER_FLOATS,
  GPU_QUEUE_VERSION,
  GPU_HDR_SPRITE,
  GPU_HDR_VERSION,
  gpuQueueCaps,
  computeGpuQueueBufferSize,
  createGpuQueueViews,
  writeGpuQueueHeader,
  packInstancedRows,
  writeGpuSpriteRow,
  gatherInstancedRows,
  makePackContext,
  fillQueueIndices,
  copyPackedRows,
  rewritePackedDepth,
} from '../../src/render/gpuQueueLayout.js';

test('gpuQueue SAB views round-trip header and packed rows', () => {
  const lighting = { enabled: true, shadowsEnabled: true, maxLights: 4, maxShadowCastingLights: 2, maxShadowsPerLight: 3, maxShadowsPerEntity: 1 };
  const caps = gpuQueueCaps(8, lighting);
  assert.equal(caps.maxSprites, 8);
  assert.ok(caps.maxStamp >= 2);
  const sab = new ArrayBuffer(computeGpuQueueBufferSize(caps));
  const views = createGpuQueueViews(sab, caps);
  writeGpuQueueHeader(views.header, { sprite: 2, glow: 1, sun: 1, stamp: 0, cookie: 0, particle: 1 }, 0);
  assert.equal(views.header[GPU_HDR_SPRITE], 2);
  assert.equal(GPU_SPRITE_FLOATS, 15);
  assert.equal(GPU_CASTER_FLOATS, 22);
  assert.equal(views.header[GPU_HDR_VERSION], GPU_QUEUE_VERSION);
  views.sprites[0] = 9;
  copyPackedRows(views.sprites, views.glow, 1, GPU_SPRITE_FLOATS, 0);
  assert.equal(views.glow[0], 9);
  assert.equal(views.byteLength, sab.byteLength);
});

test('packInstancedRows writes 15 floats and packs tint+alpha', () => {
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
  assert.equal(dst.length >= GPU_SPRITE_FLOATS, true);
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

test('indexed world pack matches sequential pack', () => {
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
    tileMulX: new Float32Array([0, 0]),
    tileMulY: new Float32Array([0, 0]),
  };
  const sequential = new Float32Array(2 * GPU_SPRITE_FLOATS);
  const sequentialU32 = new Uint32Array(sequential.buffer);
  const ctx = makePackContext(q, { space: 0, depthDenom: 8, worldHeight: 100, type: q.type }, 8);
  packInstancedRows(q, ctx, sequential, sequentialU32, GPU_SPRITE_FLOATS, 8, false);
  const indexed = new Float32Array(2 * GPU_SPRITE_FLOATS);
  const indexedU32 = new Uint32Array(indexed.buffer);
  const idx = new Uint32Array([0, 1]);
  const ctxI = makePackContext(q, {
    space: 0, depthDenom: 8, worldHeight: 100, type: q.type, indices: idx, indexCount: 2,
  }, 8);
  packInstancedRows(q, ctxI, indexed, indexedU32, GPU_SPRITE_FLOATS, 8, false);
  assert.deepEqual(Array.from(indexed), Array.from(sequential));
  assert.equal(ctxI.particleCount, 1);
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
  assert.equal(dst[15], 2.5);
  assert.ok(Math.abs(dst[16] - 0.1) < 1e-6);
  assert.ok(Math.abs(dst[17] - 0.2) < 1e-6);
});

test('writeGpuSpriteRow matches packInstancedRows for one SoA row', () => {
  const q = {
    count: 1,
    x: new Float32Array([12]),
    y: new Float32Array([34]),
    scaleX: new Float32Array([2]),
    scaleY: new Float32Array([3]),
    rotC: new Float32Array([0.8]),
    rotS: new Float32Array([0.6]),
    alpha: new Float32Array([0.25]),
    tint: new Uint32Array([0x112233]),
    textureId: new Uint16Array([7]),
    anchorX: new Float32Array([0.5]),
    anchorY: new Float32Array([1]),
    sortKey: new Float32Array([99]),
    alphaCutOff: new Uint8Array([40]),
    tileMulX: new Float32Array([0.5]),
    tileMulY: new Float32Array([0.25]),
    tileOffsetU: new Uint16Array([32768]),
    tileOffsetV: new Uint16Array([0]),
  };
  const packed = new Float32Array(GPU_SPRITE_FLOATS);
  const packedU32 = new Uint32Array(packed.buffer);
  const ctx = makePackContext(q, { sortKey: q.sortKey, worldHeight: 10000, depthDenom: 2 }, 1);
  packInstancedRows(q, ctx, packed, packedU32, GPU_SPRITE_FLOATS, 1, false);
  const direct = new Float32Array(GPU_SPRITE_FLOATS);
  const directU32 = new Uint32Array(direct.buffer);
  writeGpuSpriteRow(direct, directU32, 0, {
    x: 12, y: 34, sx: 2, sy: 3, ax: 0.5, ay: 1, rc: 0.8, rs: 0.6,
    a: 0.25, tint: 0x112233, tex: 7, invX: 0.5, invY: 0.25,
    u: 32768 * (1 / 65535), v: 0, cut: 40, sk: 99,
  }, { worldHeight: 10000, depthDenom: 2 });
  assert.deepEqual(Array.from(direct), Array.from(packed));
});

test('gatherInstancedRows permutes emit rows and copies shadow extras', () => {
  const src = new Float32Array(3 * GPU_SPRITE_FLOATS);
  src[0] = 10;
  src[GPU_SPRITE_FLOATS] = 20;
  src[2 * GPU_SPRITE_FLOATS] = 30;
  const dst = new Float32Array(2 * GPU_CASTER_FLOATS);
  const shadowQ = {
    shadowH: new Float32Array([1, 2, 3]),
    shadowOffX: new Float32Array([0.1, 0.2, 0.3]),
    shadowOffY: new Float32Array([4, 5, 6]),
  };
  const n = gatherInstancedRows(src, dst, [2, 0], 2, GPU_SPRITE_FLOATS, GPU_CASTER_FLOATS, shadowQ);
  assert.equal(n, 2);
  assert.equal(dst[0], 30);
  assert.equal(dst[GPU_CASTER_FLOATS], 10);
  assert.equal(dst[16], 3);
  assert.ok(Math.abs(dst[17] - 0.3) < 1e-6);
  assert.equal(dst[18], 6);
  assert.equal(dst[GPU_CASTER_FLOATS + 16], 1);
});

test('makePackContext reuses the out object', () => {
  const q = {
    count: 1,
    x: new Float32Array([1]),
    y: new Float32Array([2]),
    scaleX: new Float32Array([1]),
    scaleY: new Float32Array([1]),
    rotC: new Float32Array([1]),
    rotS: new Float32Array([0]),
    alpha: new Float32Array([1]),
    tint: new Uint32Array([0xffffff]),
    textureId: new Uint16Array([1]),
    anchorX: new Float32Array([0.5]),
    anchorY: new Float32Array([1]),
    type: new Uint8Array([0]),
  };
  const out = { stale: true, particleCount: 99 };
  const ctx = makePackContext(q, { space: 0, depthDenom: 4, type: q.type }, 4, out);
  assert.equal(ctx, out);
  assert.equal(ctx.particleCount, 0);
  assert.equal(ctx.stale, true);
  const again = makePackContext(q, { space: 0, depthDenom: 8, type: q.type }, 8, out);
  assert.equal(again, out);
});

test('rewritePackedDepth writes painter-order clip Z', () => {
  const dst = new Float32Array(2 * GPU_SPRITE_FLOATS);
  dst[8] = 99;
  dst[GPU_SPRITE_FLOATS + 8] = 99;
  rewritePackedDepth(dst, 2, 3);
  assert.ok(Math.abs(dst[8] - (1 - 1 / 3)) < 1e-6);
  assert.ok(Math.abs(dst[GPU_SPRITE_FLOATS + 8] - (1 - 2 / 3)) < 1e-6);
});
