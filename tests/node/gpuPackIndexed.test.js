import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_INDEXED_STATIC_FLOATS, GPU_POSE_FLOATS, GPU_SPACE_SCREEN, GPU_SPACE_WORLD, GPU_STATIC_FLOATS, makePackContext,
} from '../../src/render/gpuQueueLayout.js';
import { SCATTER_MIN_ROWS, bindGpuPack, packIndexedRowsWasm, packSplitRowsWasm } from '../../src/render/gpuPackClient.js';

// E-162: the indexed scatter writes, for each draw slot, the pose the split scatter writes there and the row it came
// from, and each drawn row's statics at that row (the queue's order) with the depth term 0: the vertex shader takes
// the depth from the draw slot. Expanded (pose[k], statics[rows[k]], the slot's depth), a frame is the split pack's.

const N = 6000;
const DEPTH = 4; // the depth's float in the statics (gpuPack.c sprite_static)

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
  const splitPose = alloc(Float32Array, N * GPU_POSE_FLOATS);
  const splitStat = alloc(Float32Array, N * GPU_STATIC_FLOATS);
  const pose = alloc(Float32Array, N * GPU_POSE_FLOATS);
  const rows = alloc(Uint32Array, N);
  const stat = alloc(Float32Array, N * GPU_INDEXED_STATIC_FLOATS);
  const tableByte = (top = (top + 15) & ~15);
  top += 4 * 18 * 4;
  const indexByte = (top = (top + 15) & ~15);
  top += N * 4;
  const inverseByte = (top = (top + 15) & ~15);
  top += N * 4;
  const particlesByte = top;
  top += 16;
  const b = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte });
  return { q, b, order, inMemory, splitPose, splitStat, pose, rows, stat };
}

const words = (f32, n) => new Uint32Array(f32.buffer, f32.byteOffset, n);

const SORTED_CASES = (s) => [
  ['indices in memory', { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: N, type: s.q.type }, N],
  ['indices copied', { space: GPU_SPACE_WORLD, indices: Uint32Array.from(s.order), indexCount: N, type: s.q.type }, N],
  ['capacity under count', { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: N, type: s.q.type }, 4321],
  ['a list over most of the queue', { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: 5000, type: s.q.type, depthDenom: 9000 }, N],
  ['no type column', { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: N }, N],
];

test('the indexed scatter is the split scatter with the statics at their rows and the depth left to the draw slot', async () => {
  for (const seed of [6, 7]) {
    const s = await setup(seed);
    for (const [label, opts, cap] of SORTED_CASES(s)) {
      const splitCtx = makePackContext(s.q, opts, cap, {});
      const n = packSplitRowsWasm(s.b, s.q, splitCtx, s.splitPose, s.splitStat, cap);
      assert.ok(n > 0, `${label}: the split pack ran`);
      s.pose.fill(-7);
      s.rows.fill(0xdeadbeef);
      s.stat.fill(-7);
      const ctx = makePackContext(s.q, opts, cap, {});
      assert.equal(packIndexedRowsWasm(s.b, s.q, ctx, s.pose, s.rows, s.stat, cap), n, `${label}: rows`);
      assert.equal(ctx.particleCount, splitCtx.particleCount, `${label}: particles`);
      const list = opts.indices;
      const invDepth = 1 / (splitCtx.depthDenom || 1);
      const sp = words(s.splitPose, n * GPU_POSE_FLOATS);
      const ss = words(s.splitStat, n * GPU_STATIC_FLOATS);
      const ip = words(s.pose, n * GPU_POSE_FLOATS);
      const is = words(s.stat, N * GPU_INDEXED_STATIC_FLOATS);
      for (let k = 0; k < n; k++) {
        const row = s.rows[k];
        if (row !== list[k]) assert.fail(`${label}: slot ${k} holds row ${row}, the list says ${list[k]}`);
        for (let j = 0; j < GPU_POSE_FLOATS; j++) {
          if (ip[k * GPU_POSE_FLOATS + j] !== sp[k * GPU_POSE_FLOATS + j]) assert.fail(`${label}: slot ${k} pose ${j}`);
        }
        for (let j = 0; j < GPU_STATIC_FLOATS; j++) {
          const want = j === DEPTH ? 0 : ss[k * GPU_STATIC_FLOATS + j];
          if (is[row * GPU_INDEXED_STATIC_FLOATS + j] !== want) assert.fail(`${label}: row ${row} static ${j}`);
        }
        if (is[row * GPU_INDEXED_STATIC_FLOATS + GPU_STATIC_FLOATS] !== 0) assert.fail(`${label}: row ${row}'s pad word`);
        // The split pack's depth is the draw slot's, which the shader computes.
        if (s.splitStat[k * GPU_STATIC_FLOATS + DEPTH] !== Math.fround(1 - (k + 1) * invDepth)) {
          assert.fail(`${label}: slot ${k}'s depth is not 1 - (k + 1) / depthDenom`);
        }
      }
    }
  }
});

test('without the statics the indexed scatter writes the pose and the rows and leaves the statics', async () => {
  const s = await setup(8);
  const opts = { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: N, type: s.q.type };
  const splitCtx = makePackContext(s.q, opts, N, {});
  const n = packSplitRowsWasm(s.b, s.q, splitCtx, s.splitPose, null, N);
  s.stat.fill(-7);
  const before = Uint32Array.from(words(s.stat, N * GPU_INDEXED_STATIC_FLOATS));
  const ctx = makePackContext(s.q, opts, N, {});
  assert.equal(packIndexedRowsWasm(s.b, s.q, ctx, s.pose, s.rows, null, N), n);
  assert.deepEqual(words(s.pose, n * GPU_POSE_FLOATS), words(s.splitPose, n * GPU_POSE_FLOATS));
  assert.deepEqual(Array.from(s.rows.subarray(0, n)), s.order.slice(0, n));
  assert.deepEqual(words(s.stat, N * GPU_INDEXED_STATIC_FLOATS), before, 'the statics as they were');
  assert.equal(ctx.particleCount, splitCtx.particleCount);
});

test('the indexed pack declines what it does not take, and the kernel a list that is not distinct rows', async () => {
  const s = await setup(9);
  const { q, b, pose, rows, stat, inMemory } = s;
  const run = (opts) => packIndexedRowsWasm(b, q, makePackContext(q, opts, N, {}), pose, rows, stat, N);
  assert.equal(run({ space: GPU_SPACE_WORLD }), -1, 'a frame without a list (not painter-sorted)');
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: inMemory, indexCount: SCATTER_MIN_ROWS - 1 }), -1, 'a short list');
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: inMemory, indexCount: N / 2 - 1 }), -1, 'under half the queue');
  assert.equal(run({ space: GPU_SPACE_SCREEN, zoom: 1, indices: inMemory, indexCount: N }), -1, 'screen space');
  assert.equal(run({ space: GPU_SPACE_WORLD, pixelSnap: true, indices: inMemory, indexCount: N }), -1, 'pixel snap');
  const ctx = makePackContext(q, { space: GPU_SPACE_WORLD, indices: inMemory, indexCount: N }, N, {});
  assert.equal(packIndexedRowsWasm(b, q, ctx, pose, new Uint32Array(N), stat, N), -1, 'rows outside the memory');
  const repeated = Uint32Array.from(s.order);
  repeated[10] = repeated[11];
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: repeated, indexCount: N }), -1, 'a repeated row');
});
