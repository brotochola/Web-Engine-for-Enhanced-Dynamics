import test from 'node:test';
import assert from 'node:assert/strict';

import { GPU_POSE_FLOATS, GPU_SPACE_SCREEN, GPU_SPACE_WORLD, GPU_SPRITE_FLOATS, GPU_STATIC_FLOATS, makePackContext } from '../../src/render/gpuQueueLayout.js';
import { SCATTER_MIN_ROWS, bindGpuPack, packSplitRowsWasm } from '../../src/render/gpuPackClient.js';
import { packInstancedRows, packSplitRows, splitInterleavedRows } from '../reference/gpuPackJs.mjs';

// E-82b: the split pack (a pose stream and a static stream) holds the 15-float row's terms bit for bit, in JS
// and in gpuPack.wasm, through the gather and the scatter, and the pose alone leaves the statics as they were.

const N = 6000;
// Where each stream's float sits in the 15-float row (gpuQueueLayout.js packInstancedRows).
const POSE_FROM_ROW = [0, 1, 6, 7];
const STATIC_FROM_ROW = [2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    q.type[i] = (rng() * 7) | 0;
  }
  const order = Array.from({ length: N }, (_, i) => i).sort(() => rng() - 0.5);
  const inMemory = alloc(Uint32Array, N);
  inMemory.set(order);
  const pose = alloc(Float32Array, N * GPU_POSE_FLOATS);
  const stat = alloc(Float32Array, N * GPU_STATIC_FLOATS);
  const tableByte = (top = (top + 15) & ~15);
  top += 4 * 18 * 4;
  const indexByte = (top = (top + 15) & ~15);
  top += N * 4;
  const inverseByte = (top = (top + 15) & ~15);
  top += N * 4;
  const particlesByte = top;
  top += 16;
  const b = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte });
  return { q, b, pose, stat, inMemory, order };
}

/** The 15-float rows packInstancedRows writes, split by hand into the two streams. */
function reference(q, opts, capacity) {
  const rows = new Float32Array(N * GPU_SPRITE_FLOATS);
  const rowsU32 = new Uint32Array(rows.buffer);
  const ctx = makePackContext(q, opts, capacity, {});
  const n = packInstancedRows(q, ctx, rows, rowsU32, GPU_SPRITE_FLOATS, capacity, false);
  const pose = new Uint32Array(n * GPU_POSE_FLOATS);
  const stat = new Uint32Array(n * GPU_STATIC_FLOATS);
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < GPU_POSE_FLOATS; j++) pose[k * GPU_POSE_FLOATS + j] = rowsU32[k * GPU_SPRITE_FLOATS + POSE_FROM_ROW[j]];
    for (let j = 0; j < GPU_STATIC_FLOATS; j++) stat[k * GPU_STATIC_FLOATS + j] = rowsU32[k * GPU_SPRITE_FLOATS + STATIC_FROM_ROW[j]];
  }
  return { n, pose, stat, rows, rowsU32, particles: ctx.particleCount };
}

function sameWords(want, got, label) {
  assert.equal(got.length, want.length, `${label}: length`);
  for (let k = 0; k < want.length; k++) {
    if (want[k] !== got[k]) assert.fail(`${label}: word ${k} ${want[k]} vs ${got[k]}`);
  }
}

const words = (f32, n) => new Uint32Array(f32.buffer, f32.byteOffset, n);

const CASES = (s) => [
  ['dense', { space: GPU_SPACE_WORLD, type: s.q.type }, N],
  ['indices in memory', { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: N, type: s.q.type }, N],
  ['indices copied', { space: GPU_SPACE_WORLD, indices: Uint32Array.from(s.order), indexCount: N, type: s.q.type }, N],
  ['short list (the gather)', { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: SCATTER_MIN_ROWS - 1, type: s.q.type }, N],
  ['capacity under count', { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: N, type: s.q.type }, 1234],
  ['depthDenom', { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: 777, type: s.q.type, depthDenom: 5000 }, N],
  ['no type column', { space: GPU_SPACE_WORLD }, N],
];

test('the two streams take the bytes of a row', () => {
  assert.equal(GPU_POSE_FLOATS + GPU_STATIC_FLOATS, GPU_SPRITE_FLOATS);
});

test('packSplitRows and splitInterleavedRows hold the 15-float row\'s terms', async () => {
  const s = await setup(1);
  for (const [label, opts, cap] of CASES(s)) {
    const ref = reference(s.q, opts, cap);
    const pose = new Float32Array(N * GPU_POSE_FLOATS);
    const stat = new Float32Array(N * GPU_STATIC_FLOATS);
    const ctx = makePackContext(s.q, opts, cap, {});
    const n = packSplitRows(s.q, ctx, pose, stat, new Uint32Array(stat.buffer), cap);
    assert.equal(n, ref.n, `${label}: rows`);
    assert.equal(ctx.particleCount, ref.particles, `${label}: particles`);
    sameWords(ref.pose, words(pose, n * GPU_POSE_FLOATS), `${label}: pose`);
    sameWords(ref.stat, words(stat, n * GPU_STATIC_FLOATS), `${label}: statics`);

    const p2 = new Float32Array(N * GPU_POSE_FLOATS);
    const s2 = new Float32Array(N * GPU_STATIC_FLOATS);
    splitInterleavedRows(ref.rows, ref.rowsU32, ref.n, p2, s2, new Uint32Array(s2.buffer));
    sameWords(ref.pose, words(p2, ref.n * GPU_POSE_FLOATS), `${label}: split rows, pose`);
    sameWords(ref.stat, words(s2, ref.n * GPU_STATIC_FLOATS), `${label}: split rows, statics`);
  }
});

test('gpuPack.wasm\'s split writes what packSplitRows writes, through the gather and the scatter', async () => {
  let scatters = 0;
  for (const seed of [2, 3]) {
    const s = await setup(seed);
    const scatter = s.b.spritesSplitScatter;
    s.b.spritesSplitScatter = (...args) => {
      scatters++;
      return scatter(...args);
    };
    for (const [label, opts, cap] of CASES(s)) {
      const ref = reference(s.q, opts, cap);
      s.pose.fill(-7);
      s.stat.fill(-7);
      const ctx = makePackContext(s.q, opts, cap, {});
      const n = packSplitRowsWasm(s.b, s.q, ctx, s.pose, s.stat, cap);
      assert.equal(n, ref.n, `${label}: rows`);
      assert.equal(ctx.particleCount, ref.particles, `${label}: particles`);
      sameWords(ref.pose, words(s.pose, n * GPU_POSE_FLOATS), `${label}: pose`);
      sameWords(ref.stat, words(s.stat, n * GPU_STATIC_FLOATS), `${label}: statics`);
    }
  }
  assert.ok(scatters >= 6, `the long lists went through the scatter (${scatters} calls)`);
});

test('the pose alone leaves the statics as they were', async () => {
  const s = await setup(4);
  const opts = { space: GPU_SPACE_WORLD, type: s.q.type };
  const ref = reference(s.q, opts, N);
  s.stat.fill(-7);
  const before = Uint32Array.from(words(s.stat, N * GPU_STATIC_FLOATS));
  const ctx = makePackContext(s.q, opts, N, {});
  assert.equal(packSplitRowsWasm(s.b, s.q, ctx, s.pose, null, N), ref.n);
  sameWords(ref.pose, words(s.pose, ref.n * GPU_POSE_FLOATS), 'wasm pose');
  sameWords(before, words(s.stat, N * GPU_STATIC_FLOATS), 'wasm statics untouched');
  assert.equal(ctx.particleCount, ref.particles, 'wasm particles');

  const pose = new Float32Array(N * GPU_POSE_FLOATS);
  const jsCtx = makePackContext(s.q, opts, N, {});
  assert.equal(packSplitRows(s.q, jsCtx, pose, null, null, N), ref.n);
  sameWords(ref.pose, words(pose, ref.n * GPU_POSE_FLOATS), 'js pose');
  assert.equal(jsCtx.particleCount, ref.particles, 'js particles');
});

test('both decline what the fast path does not take', async () => {
  const s = await setup(5);
  const { q, b, pose, stat } = s;
  const both = (opts, p = pose, st = stat) => {
    const js = packSplitRows(q, makePackContext(q, opts, N, {}), new Float32Array(N * 4), null, null, N);
    const wasm = packSplitRowsWasm(b, q, makePackContext(q, opts, N, {}), p, st, N);
    return [js, wasm];
  };
  assert.deepEqual(both({ space: GPU_SPACE_SCREEN, zoom: 1 }), [-1, -1], 'screen space');
  assert.deepEqual(both({ space: GPU_SPACE_WORLD, pixelSnap: true }), [-1, -1], 'pixel snap');
  assert.deepEqual(both({ space: GPU_SPACE_WORLD, type: q.type, includeType: 3 }), [-1, -1], 'type filter');
  const ctx = makePackContext(q, { space: GPU_SPACE_WORLD }, N, {});
  assert.equal(packSplitRowsWasm(b, q, ctx, new Float32Array(N * 4), stat, N), -1, 'pose outside the memory');
  assert.equal(packSplitRowsWasm(b, q, ctx, pose, new Float32Array(N * 11), N), -1, 'statics outside the memory');
});
