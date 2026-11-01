import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_INDEXED_SLOT_FLOATS, GPU_INDEXED_STATIC_FLOATS, GPU_POSE_FLOATS, GPU_SPACE_SCREEN, GPU_SPACE_WORLD,
  GPU_STATIC_FLOATS, makePackContext,
} from '../../src/render/gpuQueueLayout.js';
import { SCATTER_MIN_ROWS, bindGpuPack, packIndexedRowsWasm, packSplitRowsWasm } from '../../src/render/gpuPackClient.js';

// E-162: the indexed scatter writes, for each draw slot, the pose the split scatter writes there and the slot pair
// (the row it came from, and the depth the split pack writes at that slot), and every queue row's statics at its row
// (the queue's order), their depth term 0. Expanded (pose[k], statics[row(k)], depth(k)), a frame is the split pack's.

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
  const fullPose = alloc(Float32Array, N * GPU_POSE_FLOATS);
  const fullStat = alloc(Float32Array, N * GPU_STATIC_FLOATS);
  const pose = alloc(Float32Array, N * GPU_POSE_FLOATS);
  const slots = alloc(Float32Array, N * GPU_INDEXED_SLOT_FLOATS);
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
  // Every row's statics, through the split scatter over the whole queue: row order[k]'s at slot k.
  const fullCtx = makePackContext(q, { space: GPU_SPACE_WORLD, indices: inMemory, indexCount: N, type: q.type }, N, {});
  assert.equal(packSplitRowsWasm(b, q, fullCtx, fullPose, fullStat, N), N, 'the full split pack');
  const rowStatics = new Uint32Array(N * GPU_STATIC_FLOATS);
  const full = new Uint32Array(fullStat.buffer, fullStat.byteOffset, N * GPU_STATIC_FLOATS);
  for (let k = 0; k < N; k++) {
    rowStatics.set(full.subarray(k * GPU_STATIC_FLOATS, (k + 1) * GPU_STATIC_FLOATS), order[k] * GPU_STATIC_FLOATS);
  }
  return { q, b, order, inMemory, splitPose, splitStat, pose, slots, stat, rowStatics };
}

const words = (f32, n) => new Uint32Array(f32.buffer, f32.byteOffset, n);

const SORTED_CASES = (s) => [
  ['indices in memory', { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: N, type: s.q.type }, N],
  ['indices copied', { space: GPU_SPACE_WORLD, indices: Uint32Array.from(s.order), indexCount: N, type: s.q.type }, N],
  ['capacity under count', { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: N, type: s.q.type }, 4321],
  ['a list over most of the queue', { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: 5000, type: s.q.type, depthDenom: 9000 }, N],
  ['no type column', { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: N }, N],
];

test('the indexed scatter is the split scatter: the pose and depth at each slot, every row\'s statics at its row', async () => {
  for (const seed of [6, 7]) {
    const s = await setup(seed);
    for (const [label, opts, cap] of SORTED_CASES(s)) {
      const splitCtx = makePackContext(s.q, opts, cap, {});
      const n = packSplitRowsWasm(s.b, s.q, splitCtx, s.splitPose, s.splitStat, cap);
      assert.ok(n > 0, `${label}: the split pack ran`);
      s.pose.fill(-7);
      s.slots.fill(-7);
      s.stat.fill(-7);
      const ctx = makePackContext(s.q, opts, cap, {});
      assert.equal(packIndexedRowsWasm(s.b, s.q, ctx, s.pose, s.slots, s.stat, cap), n, `${label}: rows`);
      assert.equal(ctx.particleCount, splitCtx.particleCount, `${label}: particles`);
      const list = opts.indices;
      const sp = words(s.splitPose, n * GPU_POSE_FLOATS);
      const ss = words(s.splitStat, n * GPU_STATIC_FLOATS);
      const ip = words(s.pose, n * GPU_POSE_FLOATS);
      const iSlot = words(s.slots, n * GPU_INDEXED_SLOT_FLOATS);
      for (let k = 0; k < n; k++) {
        const row = s.slots[k * GPU_INDEXED_SLOT_FLOATS];
        if (row !== list[k]) assert.fail(`${label}: slot ${k} holds row ${row}, the list says ${list[k]}`);
        if (iSlot[k * GPU_INDEXED_SLOT_FLOATS + 1] !== ss[k * GPU_STATIC_FLOATS + DEPTH]) assert.fail(`${label}: slot ${k}'s depth`);
        for (let j = 0; j < GPU_POSE_FLOATS; j++) {
          if (ip[k * GPU_POSE_FLOATS + j] !== sp[k * GPU_POSE_FLOATS + j]) assert.fail(`${label}: slot ${k} pose ${j}`);
        }
      }
      // Every queue row's statics, drawn this frame or not, its depth word 0 and its pad 0.
      const is = words(s.stat, N * GPU_INDEXED_STATIC_FLOATS);
      for (let row = 0; row < N; row++) {
        for (let j = 0; j < GPU_STATIC_FLOATS; j++) {
          const want = j === DEPTH ? 0 : s.rowStatics[row * GPU_STATIC_FLOATS + j];
          if (is[row * GPU_INDEXED_STATIC_FLOATS + j] !== want) assert.fail(`${label}: row ${row} static ${j}`);
        }
        if (is[row * GPU_INDEXED_STATIC_FLOATS + GPU_STATIC_FLOATS] !== 0) assert.fail(`${label}: row ${row}'s pad word`);
      }
    }
  }
});

test('without the statics the indexed scatter writes the pose and the slots and leaves the statics', async () => {
  const s = await setup(8);
  const opts = { space: GPU_SPACE_WORLD, indices: s.inMemory, indexCount: N, type: s.q.type };
  const splitCtx = makePackContext(s.q, opts, N, {});
  const n = packSplitRowsWasm(s.b, s.q, splitCtx, s.splitPose, null, N);
  s.stat.fill(-7);
  const before = Uint32Array.from(words(s.stat, N * GPU_INDEXED_STATIC_FLOATS));
  const ctx = makePackContext(s.q, opts, N, {});
  assert.equal(packIndexedRowsWasm(s.b, s.q, ctx, s.pose, s.slots, null, N), n);
  assert.deepEqual(words(s.pose, n * GPU_POSE_FLOATS), words(s.splitPose, n * GPU_POSE_FLOATS));
  for (let k = 0; k < n; k++) assert.equal(s.slots[k * GPU_INDEXED_SLOT_FLOATS], s.order[k]);
  assert.deepEqual(words(s.stat, N * GPU_INDEXED_STATIC_FLOATS), before, 'the statics as they were');
  assert.equal(ctx.particleCount, splitCtx.particleCount);
});

test('the indexed pack declines what it does not take, and the kernel a list that is not distinct rows', async () => {
  const s = await setup(9);
  const { q, b, pose, slots, stat, inMemory } = s;
  const run = (opts, st = stat) => packIndexedRowsWasm(b, q, makePackContext(q, opts, N, {}), pose, slots, st, N);
  assert.equal(run({ space: GPU_SPACE_WORLD }), -1, 'a frame without a list (not painter-sorted)');
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: inMemory, indexCount: SCATTER_MIN_ROWS - 1 }), -1, 'a short list');
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: inMemory, indexCount: N / 2 - 1 }), -1, 'under half the queue');
  assert.equal(run({ space: GPU_SPACE_SCREEN, zoom: 1, indices: inMemory, indexCount: N }), -1, 'screen space');
  assert.equal(run({ space: GPU_SPACE_WORLD, pixelSnap: true, indices: inMemory, indexCount: N }), -1, 'pixel snap');
  const short = stat.subarray(0, (N - 1) * GPU_INDEXED_STATIC_FLOATS);
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: inMemory, indexCount: N }, short), -1, 'a statics region short of the queue');
  const ctx = makePackContext(q, { space: GPU_SPACE_WORLD, indices: inMemory, indexCount: N }, N, {});
  assert.equal(packIndexedRowsWasm(b, q, ctx, pose, new Float32Array(N * 2), stat, N), -1, 'slots outside the memory');
  const repeated = Uint32Array.from(s.order);
  repeated[10] = repeated[11];
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: repeated, indexCount: N }), -1, 'a repeated row');
});
