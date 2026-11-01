#!/usr/bin/env node
/**
 * E-192: pre-render's keyed sun rows on Predator's shape at ?crowd=1.5 (23 400 queue rows, 98.8 % of them casters with an
 * entity key of 42 633, 280 glow rows that cast nothing), through gpuPack.wasm on one shared memory, as pre-render packs
 * them (E-191 step 2):
 *   - compactKeyed: today's, compactShadowCasterIndices (JavaScript) lists the casters, packKeyedCastersWasm copies the
 *                   list into the memory and pack_casters_keyed writes a keyed row for each (7 floats);
 *   - scan:         E-192's, one kernel scans the shadow and type columns and writes the same rows (on a tree that has
 *                   packKeyedCastersScanWasm).
 * Each frame moves a tenth of the rows outside the timed call. The compaction warms through short calls first, so the
 * timed code is a normal compile, not OSR.
 *
 *   node tests/bench/gpuPackCastersKeyedMicrobench.mjs [--rows 23400] [--entities 42633] [--frames 61] [--output path]
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/gpuPackCastersKeyedMicrobench.mjs
 *
 * Reports the median ms of a frame's pack, the rows written and a checksum of them (the same on both cases).
 * Browser-safe (chromeKernel.mjs runs `run`); the Node helpers load only from the command line.
 */
import { GPU_KEYED_CASTER_FLOATS } from '../../src/render/gpuQueueLayout.js';
import { compactShadowCasterIndices } from '../../src/render/gpuShadowCasters.js';
import * as client from '../../src/render/gpuPackClient.js';

const GLOW = 3;
const GLOWS = 280;
const CASTER_SHARE = 0.988;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function setup(rows, entities) {
  const bytes = rows * 120 + rows * GPU_KEYED_CASTER_FLOATS * 4 + (2 << 20);
  const memory = new WebAssembly.Memory({ initial: Math.ceil(bytes / 65536) + 16, maximum: 32768, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const alloc = (Ctor, n) => {
    top = (top + 63) & ~63;
    const v = new Ctor(buf, top, n);
    top += n * Ctor.BYTES_PER_ELEMENT;
    return v;
  };
  const rng = mulberry32(192);
  const f32 = () => alloc(Float32Array, rows);
  const q = {
    count: rows, x: f32(), y: f32(), scaleX: f32(), scaleY: f32(), rotC: f32(), rotS: f32(), alpha: f32(),
    tint: alloc(Uint32Array, rows), textureId: alloc(Uint16Array, rows), anchorX: f32(), anchorY: f32(),
    repeatX: alloc(Uint16Array, rows), repeatY: alloc(Uint16Array, rows), tileMulX: f32(), tileMulY: f32(),
    tileOffsetU: alloc(Uint16Array, rows), tileOffsetV: alloc(Uint16Array, rows),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, rows), key: alloc(Uint32Array, rows),
  };
  // The rows' keys: distinct entities, ascending in the queue's order, as the emit writes them; the changed bit on some.
  const picked = new Uint8Array(entities);
  for (let left = Math.min(rows, entities); left > 0;) {
    const e = (rng() * entities) | 0;
    if (picked[e] === 0) {
      picked[e] = 1;
      left--;
    }
  }
  let e = 0;
  for (let i = 0; i < rows; i++) {
    while (e < entities && picked[e] === 0) e++;
    q.key[i] = (e < entities ? e++ : 0) | (rng() < 0.05 ? 0x80000000 : 0);
    q.x[i] = rng() * 4000;
    q.y[i] = rng() * 3000;
    q.scaleX[i] = q.scaleY[i] = 0.5 + rng();
    q.rotC[i] = 1;
    q.alpha[i] = 1;
    q.anchorX[i] = q.anchorY[i] = 0.5;
    q.shadowH[i] = rng() < CASTER_SHARE ? 0.5 + rng() : 0;
    q.shadowOffX[i] = rng() - 0.5;
    q.shadowOffY[i] = rng() - 0.5;
  }
  for (let m = 0; m < GLOWS; m++) {
    const i = (rng() * rows) | 0;
    q.type[i] = GLOW;
  }
  const dst = alloc(Float32Array, rows * GPU_KEYED_CASTER_FLOATS);
  const idx = new Uint32Array(rows);
  const tableByte = (top = (top + 63) & ~63);
  top += 4 * 32 * 4;
  const indexByte = (top = (top + 63) & ~63);
  top += rows * 4;
  const particlesByte = (top = (top + 63) & ~63);
  top += 16 + 16 * 8;
  if (top > buf.byteLength) throw new Error('gpuPackCastersKeyedMicrobench: the memory is too small');
  // Pre-render's binding (its index region holds a row a queue row).
  const b = await client.bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: rows, particlesByte, inverseByte: 0 });
  return { q, b, dst, idx, rng };
}

function rowsSum(dst, n) {
  let s = 0;
  for (let k = 0; k < n * GPU_KEYED_CASTER_FLOATS; k++) s += dst[k] * ((k % 13) + 1);
  return s;
}

/** The median ms of `pack` over `frames` frames after `warm` more, each frame's change made before its timed call. */
function framesMs(change, pack, frames, warm = 20) {
  for (let f = 0; f < warm; f++) {
    change();
    pack();
  }
  const times = [];
  for (let f = 0; f < frames; f++) {
    change();
    const t0 = performance.now();
    pack();
    times.push(performance.now() - t0);
  }
  times.sort((a, c) => a - c);
  return times[(times.length / 2) | 0];
}

export async function run({ rows = 23400, entities = 42633, frames = 61 } = {}) {
  const s = await setup(rows | 0, entities | 0);
  const { q, b, dst, idx } = s;
  const cap = rows;
  const moves = Math.round(rows / 10);
  const change = () => {
    for (let m = 0; m < moves; m++) {
      const i = (s.rng() * rows) | 0;
      q.x[i] += s.rng() - 0.5;
      q.y[i] += s.rng() - 0.5;
    }
  };
  // The compaction's normal compile, from short calls.
  const { warmNormalCompile } = await import('./microbenchHelpers.mjs').catch(() => ({ warmNormalCompile: (f, n = 3000) => { for (let i = 0; i < n; i++) f(); } }));
  warmNormalCompile(() => compactShadowCasterIndices(q.shadowH, q.type, 64, idx));
  let written = 0;
  const compactKeyed = () => {
    const n = compactShadowCasterIndices(q.shadowH, q.type, rows, idx);
    written = client.packKeyedCastersWasm(b, q, idx, n, dst, entities, cap);
    return written;
  };
  const cases = {};
  if (compactKeyed() <= 0) throw new Error('the keyed caster pack did not take the frame');
  cases.compactKeyed = { ms: framesMs(change, compactKeyed, frames) };
  const scan = typeof client.packKeyedCastersScanWasm === 'function'
    ? () => {
      written = client.packKeyedCastersScanWasm(b, q, rows, dst, entities, cap);
      return written;
    }
    : null;
  if (scan !== null) cases.scan = { ms: framesMs(change, scan, frames) };
  // The checks, each case on the frame the timing ended on.
  compactKeyed();
  Object.assign(cases.compactKeyed, { rows: written, check: rowsSum(dst, written) });
  if (scan !== null) {
    scan();
    Object.assign(cases.scan, { rows: written, check: rowsSum(dst, written) });
    if (cases.scan.rows !== cases.compactKeyed.rows || cases.scan.check !== cases.compactKeyed.check) {
      throw new Error('the scan\'s rows are not the compaction\'s');
    }
  }
  return { feature: 'gpu-pack-casters-keyed', rows, entities, frames, cases };
}

const fromCli =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (fromCli) {
  const { parseArgs, writeReport } = await import('./microbenchHelpers.mjs');
  const args = parseArgs();
  const report = await run({
    rows: Number(args.rows ?? 23400),
    entities: Number(args.entities ?? 42633),
    frames: Number(args.frames ?? 61),
  });
  for (const [name, c] of Object.entries(report.cases)) {
    console.log(`${name.padEnd(13)} ${c.ms.toFixed(3)} ms a frame, ${c.rows} rows, check ${c.check}`);
  }
  if (args.output) writeReport(String(args.output), report);
}
