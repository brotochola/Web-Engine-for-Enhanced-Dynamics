#!/usr/bin/env node
/**
 * Kernel (E-479): the opaque pass's rows of a by-row keyed frame, which Pixi builds every frame the pass draws: 250 000
 * draw slots (bunnyMarkScene's), the queue's columns, the packed rows and slots in the render-queue memory.
 *
 *   wasm  opaqueKeyedRowsWasm (gpuPack.c opaque_keyed_rows) into the memory, then the copy of its rows into the array the
 *         upload reads (E-123), as the batch does
 *   wasm-cover  the same with the rows' cover worked out (one frame in OPAQUE_RECHECK_FRAMES)
 *   js    the loop it replaced (tests/reference/opaqueKeyedRowsJs.mjs), from the batch's own copies into that array
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/opaqueKeyedRowsMicrobench.mjs --variants js,wasm --rounds 5
 *   node tests/bench/opaqueKeyedRowsMicrobench.mjs [--variant wasm] [--n 250000] [--case bunny|mixed|none] [--output path]
 *
 * bunny: every row opaque, in queue order, 8 frames. mixed: the rows in a painter's order (near sorted), a third of them
 * with an alpha under 1 or a frame with soft texels (Predator's crowd). none: no row opaque.
 */
import { bindGpuPack, opaqueKeyedRowsWasm } from '../../src/render/gpuPackClient.js';
import { OPAQUE_FRAME_MASK } from '../../src/render/opaquePass.js';
import { buildOpaqueKeyedRows } from '../reference/opaqueKeyedRowsJs.mjs';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { warmWasm } from './wasmKernelHelpers.mjs';

const FRAMES = 64;
const F32_COLUMNS = ['x', 'y', 'scaleX', 'scaleY', 'rotC', 'rotS', 'alpha', 'anchorX', 'anchorY', 'tileMulX', 'tileMulY', 'shadowH',
  'shadowOffX', 'shadowOffY'];

/** A queue, its packed rows and slots and the kernel on one memory, and the batch's own arrays. */
export async function setupOpaqueRows({ n = 250000, kind = 'bunny', frames = FRAMES, seed = 0x0479 } = {}) {
  const rng = mulberry32(seed);
  const bytes = n * (F32_COLUMNS.length * 4 + 4 + 2 * 3 + 2 + 8) + n * 4 * 5 + frames * 8 + (1 << 18);
  const pages = Math.ceil(bytes / 65536) + 2;
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  let top = 64;
  const alloc = (Ctor, length) => {
    top = (top + 63) & ~63;
    const view = new Ctor(memory.buffer, top, length);
    top += length * Ctor.BYTES_PER_ELEMENT;
    return view;
  };
  const q = { count: n };
  for (const name of F32_COLUMNS) q[name] = alloc(Float32Array, n);
  Object.assign(q, {
    tint: alloc(Uint32Array, n), textureId: alloc(Uint16Array, n), repeatX: alloc(Uint16Array, n), repeatY: alloc(Uint16Array, n),
    tileMode: alloc(Uint8Array, n), tileOffsetU: alloc(Uint32Array, n), tileOffsetV: alloc(Uint32Array, n), type: alloc(Uint8Array, n),
  });
  for (let i = 0; i < n; i++) {
    q.alpha[i] = kind === 'none' ? 0.5 : kind === 'mixed' && rng() < 0.2 ? rng() : 1;
    q.textureId[i] = (rng() * (kind === 'bunny' ? 8 : frames)) | 0;
    q.scaleX[i] = rng() < 0.5 ? 1 : -1;
    q.scaleY[i] = 1 + rng();
  }
  const texels = new Uint8Array(frames);
  const area = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    texels[t] = kind === 'mixed' && t % 6 === 0 ? 1 : 0;
    area[t] = 100 + t * 1.37;
  }
  const order = Float32Array.from({ length: n }, (_, k) => k);
  if (kind !== 'bunny') {
    for (let k = 0; k < n; k++) {
      const j = Math.min(n - 1, k + ((rng() * 64) | 0));
      const t = order[k];
      order[k] = order[j];
      order[j] = t;
    }
  }
  // As the batch lays them: the rows, then room for the opaque rows; the slots, then room for the frames' tables.
  const pose = alloc(Float32Array, n * 4);
  const slots = alloc(Float32Array, n);
  const tables = alloc(Float32Array, frames * 2 + 4);
  pose.set(order);
  for (let k = 0; k < n; k++) slots[k] = (order[k] * 7) % n;
  const tableByte = (top = (top + 63) & ~63);
  top += 4 * 32 * 4;
  const indexByte = top;
  top += 64;
  const particlesByte = (top = (top + 63) & ~63);
  const pack = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: 4, particlesByte, inverseByte: 0 });
  return {
    n, q, pack, texels, area, rows: pose.subarray(0, n), slots, outShared: pose.subarray(n, n * 4), tables,
    ownRows: pose.slice(0, n), ownSlots: slots.slice(), out: new Float32Array(n * 3), cover: new Float64Array(1),
  };
}

export function runOpaqueRowsJs(s, n = s.n) {
  const q = s.q;
  return buildOpaqueKeyedRows(s.ownRows, s.ownSlots, n, q.alpha, q.textureId, q.scaleX, q.scaleY, s.texels, s.area, s.out, s.cover);
}

export function runOpaqueRowsWasm(s, n = s.n, cover = null) {
  const m = opaqueKeyedRowsWasm(s.pack, s.q, s.rows, s.slots, n, s.texels, s.area, OPAQUE_FRAME_MASK, s.tables, s.outShared, cover);
  if (m > 0) s.out.set(s.outShared.subarray(0, m * 3));
  return m;
}

async function main() {
  const args = parseArgs();
  const n = Number(args.n ?? 250000);
  const variant = String(args.variant ?? 'wasm');
  if (!['js', 'wasm', 'wasm-cover'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const run = variant === 'js' ? runOpaqueRowsJs : variant === 'wasm' ? runOpaqueRowsWasm : (s, n) => runOpaqueRowsWasm(s, n, s.cover);
  const cases = {};
  let checksum = 2166136261;
  let tier = null;
  for (const name of args.case ? [String(args.case)] : ['bunny', 'mixed', 'none']) {
    const s = await setupOpaqueRows({ n, kind: name });
    const m = run(s);
    checksum = Math.imul(checksum ^ checksumFloats(s.out, m * 3) ^ m, 16777619) >>> 0;
    if (variant === 'js') warmNormalCompile(() => run(s, 2000));
    else tier = await warmWasm(s.pack.opaqueKeyedRows, () => run(s, 2000));
    const t = timeIt(`opaque rows ${variant} ${name} (${m} of ${n})`, () => run(s), { iterations: 10, warmup: 5 });
    cases[name] = { ...t, rows: m, nsPerSlot: 1e9 / t.opsPerSec / n };
    console.log(`  ${variant} ${name}: ${cases[name].nsPerSlot.toFixed(2)} ns a draw slot, ${(1e3 / t.opsPerSec).toFixed(3)} ms a frame`);
  }
  const report = { feature: 'opaque-keyed-rows', variant, functions: ['opaque_keyed_rows'], n, checksum, wasmTier: tier, cases };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum}`);
}

if (isCli(import.meta.url)) await main();
