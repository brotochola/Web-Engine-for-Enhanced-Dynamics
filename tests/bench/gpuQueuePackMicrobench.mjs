#!/usr/bin/env node
/**
 * Kernel: packInstancedRows + makePackContext + fillQueueIndices, the pixi
 * entity pack, on a 16k-row render queue built from the Predator fixture
 * (positions, rotations), painter order = foot-Y order, world space.
 *   - sprites: entity rows through the painter index list (Pixi entitiesBatch).
 *   - casters: caster rows with shadowCast (pre-render _packGpuSun).
 *
 *   node tests/bench/gpuQueuePackMicrobench.mjs
 *   node tests/bench/gpuQueuePackMicrobench.mjs --output out.json
 */
import {
  GPU_CASTER_FLOATS,
  GPU_SPACE_WORLD,
  GPU_SPRITE_FLOATS,
  fillQueueIndices,
  makePackContext,
  packInstancedRows,
} from '../../src/render/gpuQueueLayout.js';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { loadPredatorFixture } from './predatorFixture.mjs';

// Hypotheses: { sprites, casters } pack functions per variant. Sprite rows are
// what InstancedSpriteBatch.upload packs (Pixi), caster rows what pre-render's
// _packGpuSun packs. In the engine the queue was just written by pre-render on
// another core; here it is hot in this core's cache, so a memory-order gain
// shows bigger here than in a scene (X5: +73–138 % here, nothing in Predator).
const PACK = { base: { sprites: packInstancedRows, casters: packInstancedRows } };

/**
 * queueOrder 'entity': queue rows in entity-index order (random against Y).
 * queueOrder 'cells': rows in the order pre-render's cull walks the grid
 * (128 px cells, row by row), which is what Pixi gets in a real scene.
 */
export function buildQueue(fx, rows, queueOrder = 'entity') {
  const { x, y, rotC, rotS, active, shadowH, shadowActive } = fx.arrays;
  const ids = [];
  for (let i = 0; i < fx.meta.n && ids.length < rows; i++) if (active[i]) ids.push(i);
  if (queueOrder === 'cells') {
    const cell = (i) => ((y[i] / 128) | 0) * 100000 + ((x[i] / 128) | 0);
    ids.sort((a, b) => cell(a) - cell(b) || a - b);
  }
  const n = ids.length;
  const rng = mulberry32(0x9ac4);
  const f32 = () => new Float32Array(n);
  const q = {
    count: n,
    x: f32(),
    y: f32(),
    scaleX: f32(),
    scaleY: f32(),
    rotC: f32(),
    rotS: f32(),
    alpha: f32(),
    tint: new Uint32Array(n),
    textureId: new Uint16Array(n),
    anchorX: f32(),
    anchorY: f32(),
    repeatX: f32(),
    repeatY: f32(),
    tileMulX: f32(),
    tileMulY: f32(),
    tileOffsetU: new Uint16Array(n),
    tileOffsetV: new Uint16Array(n),
    shadowH: f32(),
    shadowOffX: f32(),
    shadowOffY: f32(),
    type: new Uint8Array(n),
  };
  for (let r = 0; r < n; r++) {
    const i = ids[r];
    q.x[r] = x[i];
    q.y[r] = y[i];
    q.scaleX[r] = 0.8 + rng() * 0.4;
    q.scaleY[r] = q.scaleX[r];
    q.rotC[r] = rotC[i] || 1;
    q.rotS[r] = rotS[i] || 0;
    q.alpha[r] = rng() < 0.9 ? 1 : rng();
    q.tint[r] = 0xffffff;
    q.textureId[r] = (rng() * 400) | 0;
    q.anchorX[r] = 0.5;
    q.anchorY[r] = 1;
    q.shadowH[r] = shadowActive[i] ? shadowH[i] : 0;
    q.type[r] = 0;
  }
  // Painter order: foot-Y ascending (what radixPainterOrder hands Pixi).
  const order = Array.from({ length: n }, (_, r) => r).sort((a, b) => q.y[a] - q.y[b] || a - b);
  return { q, painter: Uint32Array.from(order) };
}

/**
 * One case on a JIT that has only seen that case, like the engine: Pixi packs
 * sprite rows, pre-render packs caster rows (_packGpuSun). Warming the same
 * function with sprites first made the caster pack 1.6–1.8× faster than it
 * is when casters are all the function ever sees.
 */
function runCase(name, variant, rows, queueOrder) {
  const pack = PACK[variant];
  if (!pack) throw new Error(`unknown variant ${variant}`);
  const fx = loadPredatorFixture();
  if (!fx) throw new Error('missing tests/fixtures/predator-frame.bin (run capturePredatorFixture.mjs)');
  const { q, painter } = buildQueue(fx, rows, queueOrder);
  const n = q.count;
  if (name === 'sprites') {
    const dst = new Float32Array(n * GPU_SPRITE_FLOATS);
    const u32 = new Uint32Array(dst.buffer);
    const opts = { indices: painter, indexCount: n, space: GPU_SPACE_WORLD, zoom: 0.4, cameraX: 0, cameraY: 0, type: q.type };
    const ctxOut = {};
    const run = () => pack.sprites(q, makePackContext(q, opts, n, ctxOut), dst, u32, GPU_SPRITE_FLOATS, n, false);
    const out = run();
    const checksum = checksumFloats(dst, out * GPU_SPRITE_FLOATS);
    return { rows: out, checksum, result: timeIt(`packInstancedRows ${variant} sprites (${out} rows)`, run, { iterations: 50, warmup: 50 }) };
  }
  if (name === 'casters') {
    const idx = new Uint32Array(n);
    const dst = new Float32Array(n * GPU_CASTER_FLOATS);
    const u32 = new Uint32Array(dst.buffer);
    const ctxOut = {};
    const run = () => {
      let m = 0;
      for (let r = 0; r < n; r++) if (q.shadowH[r] > 0) idx[m++] = r;
      const ctx = makePackContext(q, { indices: idx, indexCount: m, space: GPU_SPACE_WORLD, type: q.type }, n, ctxOut);
      return pack.casters(q, ctx, dst, u32, GPU_CASTER_FLOATS, n, true);
    };
    const out = run();
    const checksum = checksumFloats(dst, out * GPU_CASTER_FLOATS);
    return { rows: out, checksum, result: timeIt(`packInstancedRows ${variant} casters (${out} rows)`, run, { iterations: 50, warmup: 50 }) };
  }
  const fillIdx = new Uint32Array(n);
  const count = fillQueueIndices(q.type, n, -1, 3, fillIdx);
  return {
    rows: count,
    checksum: count,
    result: timeIt('fillQueueIndices exclude glow', () => fillQueueIndices(q.type, n, -1, 3, fillIdx), { iterations: 200, warmup: 50 }),
  };
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  if (!PACK[variant]) throw new Error(`unknown variant ${variant}`);
  const rows = Number(args.rows ?? 16384);
  const queueOrder = String(args['queue-order'] || 'entity');
  const { Worker } = await import('node:worker_threads');
  const cases = {};
  const counts = {};
  let checksum = 2166136261;
  for (const name of ['sprites', 'casters', 'fillQueueIndices']) {
    const res = await new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { role: 'case', name, variant, rows, queueOrder } });
      w.once('message', resolve);
      w.once('error', reject);
    });
    cases[name] = res.result;
    counts[name] = res.rows;
    checksum = Math.imul(checksum ^ res.checksum, 16777619) >>> 0;
  }
  const report = {
    feature: 'gpu-queue-pack',
    functions: ['packInstancedRows', 'makePackContext', 'fillQueueIndices'],
    variant,
    n: rows,
    seed: 0x9ac4,
    rows: counts,
    note: 'each case runs in its own worker thread (fresh JIT feedback)',
    checksum,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(JSON.stringify(report.rows), checksum);
}

const { isMainThread, workerData, parentPort } = await import('node:worker_threads');
if (!isMainThread && workerData?.role === 'case') {
  parentPort.postMessage(runCase(workerData.name, workerData.variant, workerData.rows, workerData.queueOrder));
} else if (isCli(import.meta.url)) await main();
