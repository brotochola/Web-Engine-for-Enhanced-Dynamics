#!/usr/bin/env node
/**
 * Kernel (E-126, grid movers only): the shipped spatial grid step (SpatialWorker._rebuildGrid) on a
 * real worker, in a world where most bodies sleep: movedBodiesStillScene's lattice (60 000 circles
 * of radius 8, 40 px apart, one spatial worker, cells of 128 px holding 32), with 0, 5, 35, 50 and
 * 100 % of the bodies drifting up to 2 px a frame (crossing a cell now and then). Each frame moves
 * them, publishes them as physics does (box2dMovedBodies), and times the grid step only.
 *
 *   base    _gridMoversMode 1: the full rebuild every frame (rebuildOwnedRows)
 *   movers  _gridMoversMode 2: the grid rewritten for the bodies that moved whenever the state allows
 *   auto    _gridMoversMode 0: the shipped choice, by the moved fraction (MOVERS_MAX_FRACTION)
 *
 * The three write the same bytes (tests/node/spatialGridMovers.test.js); the checksum covers the
 * cells, poses, owned list and cell counts of 12 frames per case, so runKernelVariants rejects a
 * variant that does not. Each case runs in its own worker_thread (its own JIT and Grid), after
 * short calls on a 512-entity slice of the same world so the timed code is a normal TurboFan
 * compile, not OSR. `moversShare` is the share of timed frames that took the movers path.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/spatialGridMoversMicrobench.mjs --variants base,movers
 *   node tests/bench/spatialGridMoversMicrobench.mjs [--variant movers] [--cases 5,100] [--n 60000] [--output path]
 */
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Grid } from '../../src/core/grid.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { bindMovedBodies, createMovedBodiesSab, publishMovedBodies } from '../../src/box2d/box2dMovedBodies.js';
import { STEP_MS_FLOOR } from './benchmarkDefaults.mjs';
import { isCli, mulberry32, parseArgs, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { setupSpatialKernel } from './spatialWorkerMicrobench.mjs';

const VARIANTS = { auto: 0, base: 1, movers: 2 };
const CASES = [0, 5, 35, 50, 100];
// movedBodiesStillScene.js
const COLS = 220;
const SPACING = 40;
const START = 200;
const SHORT = 512;
const CHECK_FRAMES = 12;

function fnv(h, v) {
  return Math.imul(h ^ (v >>> 0), 16777619) >>> 0;
}

async function runCase({ pct, variant, n, seed }) {
  const rows = Math.ceil(n / COLS);
  const spatial = {
    worldWidth: COLS * SPACING + 400,
    worldHeight: rows * SPACING + 400,
    cellSize: 128,
    maxNeighbors: 32,
    maxEntitiesPerCell: 32,
    rowsPerBlock: 2,
  };
  const k = await setupSpatialKernel({ n, workers: 1, spatial, publishMemory: 'product', wasm: {} });
  const worker = k.workers[0];
  // A tree from before E-126 has the full rebuild only: `base` times it there (runKernelsVsRev).
  const hasMovers = typeof worker._rebuildGrid === 'function';
  if (!hasMovers && variant !== 'base') throw new Error(`variant ${variant} needs SpatialWorker._rebuildGrid (E-126)`);
  const step = hasMovers ? () => worker._rebuildGrid() : () => worker.rebuildOwnedRows();
  worker._gridMoversMode = VARIANTS[variant];
  const queryVersion = new Int32Array(new SharedArrayBuffer(4));
  worker.queryVersionData = queryVersion;
  bindMovedBodies(createMovedBodiesSab(n));

  for (let i = 0; i < n; i++) {
    Transform.active[i] = 1;
    Transform.x[i] = START + (i % COLS) * SPACING;
    Transform.y[i] = START + ((i / COLS) | 0) * SPACING;
    Transform.rotC[i] = 1;
    Transform.rotS[i] = 0;
    Collider.active[i] = 1;
    Collider.shapeType[i] = ShapeType.Circle;
    Collider.radius[i] = 8;
    Collider.offsetX[i] = 0;
    Collider.offsetY[i] = 0;
    Collider.visualRange[i] = 0;
    SpriteRenderer.active[i] = 1;
    RigidBody.active[i] = 1;
  }
  const active = worker.activeEntitiesData;
  function setActive(count) {
    for (let i = 0; i < count; i++) active[1 + i] = i;
    active[0] = count;
    Atomics.add(queryVersion, 0, 1);
  }

  // The movers: pct % of the bodies, in physics' (unsorted) order, each drifting within 48 px of
  // its place. `shortMovers` are the ones in the warm-up slice.
  const rng = mulberry32(seed + pct);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const moverCount = Math.round((n * pct) / 100);
  const movers = order.subarray(0, moverCount);
  const shortMovers = Int32Array.from(movers.filter((e) => e < SHORT));
  const homeX = new Float32Array(n);
  const homeY = new Float32Array(n);
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    homeX[i] = Transform.x[i];
    homeY[i] = Transform.y[i];
    vx[i] = (rng() - 0.5) * 4;
    vy[i] = (rng() - 0.5) * 4;
  }

  function move(list) {
    const x = Transform.x;
    const y = Transform.y;
    for (let k2 = 0; k2 < list.length; k2++) {
      const i = list[k2];
      let px = x[i] + vx[i];
      let py = y[i] + vy[i];
      if (px > homeX[i] + 48 || px < homeX[i] - 48) {
        vx[i] = -vx[i];
        px = x[i] + vx[i];
      }
      if (py > homeY[i] + 48 || py < homeY[i] - 48) {
        vy[i] = -vy[i];
        py = y[i] + vy[i];
      }
      x[i] = px;
      y[i] = py;
    }
    publishMovedBodies(list, null, list.length, null, 0, null);
  }

  // Normal compiles of every function the step runs, from short calls.
  setActive(SHORT);
  warmNormalCompile(() => {
    move(shortMovers);
    step();
  });
  setActive(n);
  for (let f = 0; f < 3; f++) {
    move(movers);
    step();
  }

  const meta = k.gridMetadata;
  const gridWords = new Int32Array(k.mem.buffer, meta.gridByte, (meta.totalCells * Grid.cellByteSize) >> 2);
  const posWords = new Int32Array(k.mem.buffer, meta.posByte, n * 4);
  let checksum = 2166136261;
  for (let f = 0; f < CHECK_FRAMES; f++) {
    move(movers);
    step();
    for (let i = 0; i < gridWords.length; i++) checksum = fnv(checksum, gridWords[i]);
    for (let i = 0; i < posWords.length; i++) checksum = fnv(checksum, posWords[i]);
    checksum = fnv(checksum, worker._ownedEntityCount);
    for (let i = 0; i < worker._ownedEntityCount; i++) checksum = fnv(checksum, worker._ownedEntityList[i]);
    const counts = worker._localCellCounts;
    for (let i = 0; i < counts.length; i++) checksum = fnv(checksum, counts[i]);
  }

  // Each rep: `iterations` frames, timing the grid step only (the moves and the publish are
  // physics' work). Iterations grow until a rep lasts STEP_MS_FLOOR, as in timeIt.
  let moversFrames = 0;
  let frames = 0;
  function rep(iterations) {
    let ms = 0;
    for (let it = 0; it < iterations; it++) {
      move(movers);
      const t0 = performance.now();
      step();
      ms += performance.now() - t0;
      moversFrames += worker._gridMoversThisFrame | 0;
      frames++;
    }
    return ms;
  }
  const reps = 5;
  let iterations = 4;
  let ms = 0;
  for (;;) {
    rep(iterations);
    const times = [];
    for (let r = 0; r < reps; r++) times.push(rep(iterations));
    times.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    ms = times[reps >> 1];
    if (ms >= STEP_MS_FLOOR || iterations >= 1 << 20) break;
    iterations = Math.max(iterations + 1, Math.ceil(((iterations * STEP_MS_FLOOR) / Math.max(ms, 1e-6)) * 1.15));
  }
  const label = `grid step ${variant}, ${pct} % movers (n=${n})`;
  const opsPerSec = (iterations / ms) * 1000;
  return {
    case: { label, ms, opsPerSec, iterations, reps, moversShare: moversFrames / frames, movers: moverCount },
    checksum,
  };
}

function runCaseThread(data) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { role: 'case', ...data } });
    w.once('message', (m) => {
      w.terminate();
      resolve(m);
    });
    w.once('error', reject);
  });
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  if (!(variant in VARIANTS)) throw new Error(`unknown variant ${variant} (${Object.keys(VARIANTS).join(', ')})`);
  const n = Number(args.n ?? 60000);
  const seed = Number(args.seed ?? 0xe126);
  const pcts = args.cases === undefined ? CASES : String(args.cases).split(',').map(Number);
  const cases = {};
  let checksum = 2166136261;
  // One case at a time: each thread is the only one running.
  for (const pct of pcts) {
    const r = await runCaseThread({ pct, variant, n, seed });
    cases[`movers${pct}`] = r.case;
    checksum = fnv(checksum, r.checksum);
    console.log(
      `${r.case.label}: median ${r.case.ms.toFixed(2)} ms for ${r.case.iterations} -> ${r.case.opsPerSec.toFixed(1)} ops/s` +
        ` (movers path ${(r.case.moversShare * 100).toFixed(0)} % of frames, checksum ${r.checksum})`,
    );
  }
  const report = {
    feature: 'spatial-grid-movers',
    variant,
    functions: ['SpatialWorker._rebuildGrid', 'SpatialWorker.rebuildOwnedRows', 'SpatialWorker._rebuildMovedRows'],
    n,
    seed,
    workers: 1,
    checksum,
    tier: 'TurboFan normal compile (warmNormalCompile on a 512-entity slice)',
    note: 'Real SpatialWorker, synthetic init payload; the grid step timed alone, the moves and the publish not.',
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum}`);
}

if (!isMainThread && workerData?.role === 'case') {
  parentPort.postMessage(await runCase(workerData));
} else if (isCli(import.meta.url)) {
  await main();
}
