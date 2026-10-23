import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_CASTER_FLOATS,
  GPU_SPACE_SCREEN,
  GPU_SPACE_WORLD,
  GPU_SPRITE_FLOATS,
  makePackContext,
  packInstancedRows,
} from '../../src/render/gpuQueueLayout.js';
import { bindGpuPack, packInstancedRowsWasm } from '../../src/render/gpuPackClient.js';

// E-76 W9: the WASM pack writes the bits packInstancedRows writes, on the paths it takes, and
// declines (-1) the rest so the caller packs in JS.

const N = 3000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A queue whose columns are views on `memory`, plus the scratch the client needs. */
async function setup(seed) {
  const memory = new WebAssembly.Memory({ initial: 64, maximum: 8192, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const alloc = (Ctor, n) => {
    top = (top + 15) & ~15;
    const v = new Ctor(buf, top, n);
    top += n * Ctor.BYTES_PER_ELEMENT;
    return v;
  };
  const rng = mulberry32(seed);
  const f32 = () => alloc(Float32Array, N);
  const q = {
    count: N, x: f32(), y: f32(), scaleX: f32(), scaleY: f32(), rotC: f32(), rotS: f32(), alpha: f32(),
    tint: alloc(Uint32Array, N), textureId: alloc(Uint16Array, N), anchorX: f32(), anchorY: f32(),
    repeatX: alloc(Uint16Array, N), repeatY: alloc(Uint16Array, N), tileMulX: f32(), tileMulY: f32(),
    tileOffsetU: alloc(Uint16Array, N), tileOffsetV: alloc(Uint16Array, N),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, N),
  };
  for (let i = 0; i < N; i++) {
    q.x[i] = (rng() - 0.5) * 9000;
    q.y[i] = (rng() - 0.5) * 9000;
    q.scaleX[i] = rng() * 3;
    q.scaleY[i] = rng() * 3;
    q.rotC[i] = rng() * 2 - 1;
    q.rotS[i] = rng() * 2 - 1;
    const a = rng();
    q.alpha[i] = a < 0.05 ? NaN : a < 0.1 ? -0.5 : a < 0.15 ? 1.7 : rng();
    q.tint[i] = (rng() * 0xffffffff) >>> 0;
    q.textureId[i] = (rng() * 65535) | 0;
    q.anchorX[i] = rng();
    q.anchorY[i] = rng();
    q.tileMulX[i] = rng() < 0.5 ? 0 : rng() * 4;
    q.tileMulY[i] = rng() < 0.5 ? 0 : rng() * 4;
    q.tileOffsetU[i] = (rng() * 65535) | 0;
    q.tileOffsetV[i] = (rng() * 65535) | 0;
    q.shadowH[i] = rng() < 0.3 ? 0 : rng() * 2;
    q.shadowOffX[i] = rng() * 10;
    q.shadowOffY[i] = rng() * 10;
    q.type[i] = (rng() * 7) | 0;
  }
  const order = Array.from({ length: N }, (_, i) => i).sort(() => rng() - 0.5);
  const inMemory = alloc(Uint32Array, N);
  inMemory.set(order);
  const outside = Uint32Array.from(order);
  const dst = alloc(Float32Array, N * GPU_CASTER_FLOATS);
  const tableByte = (top = (top + 15) & ~15);
  top += 4 * 18 * 4;
  const indexByte = (top = (top + 15) & ~15);
  top += N * 4;
  const particlesByte = top;
  top += 16;
  const b = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte });
  return { q, b, dst, inMemory, outside, rng };
}

function compare(s, opts, capacity, shadowCast, label) {
  const { q, b, dst } = s;
  const fp = shadowCast ? GPU_CASTER_FLOATS : GPU_SPRITE_FLOATS;
  const ref = new Float32Array(N * GPU_CASTER_FLOATS);
  const refCtx = makePackContext(q, opts, capacity, {});
  const want = packInstancedRows(q, refCtx, ref, new Uint32Array(ref.buffer), fp, capacity, shadowCast);
  dst.fill(-7);
  const ctx = makePackContext(q, opts, capacity, {});
  const got = packInstancedRowsWasm(b, q, ctx, dst, fp, capacity, shadowCast);
  assert.equal(got, want, `${label}: rows`);
  assert.equal(ctx.particleCount, refCtx.particleCount, `${label}: particles`);
  const a = new Uint32Array(ref.buffer, 0, want * fp);
  const w = new Uint32Array(dst.buffer, dst.byteOffset, want * fp);
  for (let k = 0; k < a.length; k++) {
    if (a[k] !== w[k]) assert.fail(`${label}: word ${k} (row ${(k / fp) | 0}, float ${k % fp}) ${a[k]} vs ${w[k]}`);
  }
  return got;
}

test('the WASM pack writes what packInstancedRows writes', async () => {
  for (const seed of [1, 2]) {
    const s = await setup(seed);
    const world = { space: GPU_SPACE_WORLD, zoom: 0.5 };
    for (const shadowCast of [false, true]) {
      const kind = shadowCast ? 'casters' : 'sprites';
      compare(s, { ...world, indices: s.inMemory, indexCount: N, type: s.q.type }, N, shadowCast, `${kind} indices in memory`);
      compare(s, { ...world, indices: s.outside, indexCount: N, type: s.q.type }, N, shadowCast, `${kind} indices copied`);
      compare(s, { ...world, type: s.q.type }, N, shadowCast, `${kind} dense`);
      compare(s, { ...world, indices: s.inMemory, indexCount: N }, N, shadowCast, `${kind} no type column`);
      compare(s, { ...world, indices: s.inMemory, indexCount: N, type: s.q.type }, 1234, shadowCast, `${kind} capacity under count`);
      compare(s, { ...world, indices: s.inMemory, indexCount: 777, type: s.q.type, depthDenom: 5000 }, N, shadowCast, `${kind} depthDenom`);
    }
  }
});

test('the WASM pack declines what it does not pack', async () => {
  const s = await setup(3);
  const { q, b, dst } = s;
  const decline = (opts, d = dst, fp = GPU_SPRITE_FLOATS, shadowCast = false) => {
    const ctx = makePackContext(q, opts, N, {});
    return packInstancedRowsWasm(b, q, ctx, d, fp, N, shadowCast);
  };
  assert.equal(decline({ space: GPU_SPACE_SCREEN, zoom: 1, indices: s.inMemory, indexCount: N }), -1, 'screen space');
  assert.equal(decline({ space: GPU_SPACE_WORLD, pixelSnap: true, indices: s.inMemory, indexCount: N }), -1, 'pixel snap');
  assert.equal(decline({ space: GPU_SPACE_WORLD, type: q.type, includeType: 3 }), -1, 'type filter');
  assert.equal(decline({ space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: N }, new Float32Array(N * 22)), -1, 'dst outside');
  assert.equal(decline({ space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: N }, dst, GPU_CASTER_FLOATS, false), -1, 'row size');
  const plainQ = { ...q, x: new Float32Array(N) };
  const ctx = makePackContext(plainQ, { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: N }, N, {});
  assert.equal(packInstancedRowsWasm(b, plainQ, ctx, dst, GPU_SPRITE_FLOATS, N, false), -1, 'a column outside');
});
