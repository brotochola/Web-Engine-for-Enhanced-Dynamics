#!/usr/bin/env node
/**
 * E-162 step 1: a painter-sorted frame's pack on painterMoveStressScene's shape (300 000 queue rows, every one in the
 * painter's order), through gpuPack.wasm on one shared memory:
 *   - split:          today's frame whose order moved: pack_sprites_split_scatter, the pose and the statics in draw
 *                     order (60 bytes a sprite);
 *   - indexed:        E-162's frame whose order moved and statics held: the pose and the slot pair (the row and the
 *                     depth) in draw order (24 bytes);
 *   - indexedStatics: E-162's frame whose statics moved too: also every row's statics, in row order.
 * `order` is `random` (the painter's order unrelated to the queue's) or `near` (the queue's order with a tenth of the
 * rows moved, painterMove's drift).
 *
 *   node tests/bench/gpuPackIndexedMicrobench.mjs [--rows 300000] [--order random|near] [--output path]
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/gpuPackIndexedMicrobench.mjs --args '{"order":"near"}'
 *
 * Reports the median ms of a pack, and a checksum of the pose stream (the same on every case).
 * Browser-safe (chromeKernel.mjs runs `run`); the Node helpers load only from the command line.
 */
import {
  GPU_INDEXED_SLOT_FLOATS, GPU_INDEXED_STATIC_FLOATS, GPU_POSE_FLOATS, GPU_SPACE_WORLD, GPU_STATIC_FLOATS, makePackContext,
} from '../../src/render/gpuQueueLayout.js';
import { bindGpuPack, packIndexedRowsWasm, packSplitRowsWasm } from '../../src/render/gpuPackClient.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function setup(rows, orderKind) {
  const bytes = rows * 256 + (2 << 20); // about 207 bytes a row over every array below
  const memory = new WebAssembly.Memory({ initial: Math.ceil(bytes / 65536) + 16, maximum: 32768, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const alloc = (Ctor, n) => {
    top = (top + 15) & ~15;
    const v = new Ctor(buf, top, n);
    top += n * Ctor.BYTES_PER_ELEMENT;
    return v;
  };
  const rng = mulberry32(162);
  const f32 = () => alloc(Float32Array, rows);
  const q = {
    count: rows, x: f32(), y: f32(), scaleX: f32(), scaleY: f32(), rotC: f32(), rotS: f32(), alpha: f32(),
    tint: alloc(Uint32Array, rows), textureId: alloc(Uint16Array, rows), anchorX: f32(), anchorY: f32(),
    repeatX: alloc(Uint16Array, rows), repeatY: alloc(Uint16Array, rows), tileMulX: f32(), tileMulY: f32(),
    tileOffsetU: alloc(Uint16Array, rows), tileOffsetV: alloc(Uint16Array, rows),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, rows),
  };
  for (let i = 0; i < rows; i++) {
    q.x[i] = rng() * 4000;
    q.y[i] = rng() * 3000;
    q.scaleX[i] = q.scaleY[i] = 0.5 + rng();
    q.rotC[i] = 1;
    q.rotS[i] = 0;
    q.alpha[i] = 1;
    q.tint[i] = 0xffffffff;
    q.textureId[i] = (rng() * 64) | 0;
    q.anchorX[i] = q.anchorY[i] = 0.5;
  }
  const order = alloc(Uint32Array, rows);
  for (let i = 0; i < rows; i++) order[i] = i;
  if (orderKind === 'random') {
    for (let i = rows - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
  } else {
    // A tenth of the rows moved a little: each of them swapped with a row up to 64 slots away.
    for (let m = 0; m < rows / 10; m++) {
      const i = (rng() * rows) | 0;
      const j = Math.min(rows - 1, i + 1 + ((rng() * 64) | 0));
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
  }
  const splitPose = alloc(Float32Array, rows * GPU_POSE_FLOATS);
  const splitStat = alloc(Float32Array, rows * GPU_STATIC_FLOATS);
  const pose = alloc(Float32Array, rows * GPU_POSE_FLOATS);
  const slots = alloc(Float32Array, rows * GPU_INDEXED_SLOT_FLOATS);
  const stat = alloc(Float32Array, rows * GPU_INDEXED_STATIC_FLOATS);
  const tableByte = (top = (top + 15) & ~15);
  top += 4 * 18 * 4;
  const indexByte = (top = (top + 15) & ~15);
  top += rows * 4;
  const inverseByte = (top = (top + 15) & ~15);
  top += rows * 4;
  const particlesByte = top;
  top += 16 + 16 * 8;
  if (top > buf.byteLength) throw new Error('gpuPackIndexedMicrobench: the memory is too small');
  const b = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: rows, particlesByte, inverseByte });
  return { q, b, order, splitPose, splitStat, pose, slots, stat };
}

function medianMs(fn, reps = 15) {
  for (let i = 0; i < 3; i++) fn();
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[(times.length / 2) | 0];
}

function poseSum(pose, n) {
  let s = 0;
  for (let k = 0; k < n * GPU_POSE_FLOATS; k += 97) s += pose[k];
  return s;
}

export async function run({ rows = 300000, order = 'near' } = {}) {
  const s = await setup(rows | 0, order);
  const opts = { space: GPU_SPACE_WORLD, indices: s.order, indexCount: rows, type: s.q.type };
  const ctx = () => makePackContext(s.q, opts, rows, {});
  const split = () => packSplitRowsWasm(s.b, s.q, ctx(), s.splitPose, s.splitStat, rows);
  const indexed = () => packIndexedRowsWasm(s.b, s.q, ctx(), s.pose, s.slots, null, rows);
  const indexedStatics = () => packIndexedRowsWasm(s.b, s.q, ctx(), s.pose, s.slots, s.stat, rows);
  const cases = {};
  if (split() !== rows) throw new Error('the split pack did not take the frame');
  cases.split = { ms: medianMs(split), check: poseSum(s.splitPose, rows) };
  if (s.b.spritesIndexedScatter) {
    if (indexed() !== rows) throw new Error('the indexed pack did not take the frame');
    cases.indexed = { ms: medianMs(indexed), check: poseSum(s.pose, rows) };
    cases.indexedStatics = { ms: medianMs(indexedStatics), check: poseSum(s.pose, rows) };
    if (cases.indexed.check !== cases.split.check) throw new Error('the indexed pose stream is not the split one');
  }
  return { feature: 'gpu-pack-indexed', rows, order, cases };
}

const fromCli =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (fromCli) {
  const { parseArgs, writeReport } = await import('./microbenchHelpers.mjs');
  const args = parseArgs();
  const report = await run({ rows: Number(args.rows ?? 300000), order: String(args.order ?? 'near') });
  for (const [name, c] of Object.entries(report.cases)) console.log(`${name.padEnd(15)} ${c.ms.toFixed(3)} ms a pack (check ${c.check.toFixed(1)})`);
  if (args.output) writeReport(String(args.output), report);
}
