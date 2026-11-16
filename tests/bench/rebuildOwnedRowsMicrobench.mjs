#!/usr/bin/env node
/**
 * Kernel (R-1201, E-267): SpatialWorker.rebuildOwnedRows, the spatial worker's JS grid pass, on boidsScene's grid:
 * a 4000 x 4000 world, 20 px cells holding 20 entities, two spatial workers (rows in blocks of 2), a pool of 65 000
 * slots with 40 000 boids alive (ids 0..39 999, spawned at uniform random places, so id order is random in space).
 * A Boid's collider is off (boid.js: collider.active = false) and it has a sprite, so every boid takes the rebuild's
 * sprite-only branch: a point at its position, one cell. `--shape box` turns their colliders on as 10 x 10 boxes at
 * their own angle (E-245's inline box branch), `--shape circle` as circles of radius 5. Each frame the boids drift by
 * their velocity (up to 6.7 px, boidsScene's 800 px/s spread at 60 fps), bouncing at the edges, untimed; then each
 * worker's rebuildOwnedRows is timed, as the worker runs it every frame where physics moved most bodies (E-126's full
 * rebuild). One op is a frame: both workers' rebuilds.
 *
 * Real SpatialWorker instances (setupSpatialKernel, workerHarness), warmed through short frames (256 boids alive) so
 * the timed code is a normal TurboFan compile. The checksum covers the grid's cells, the poses and each worker's owned
 * list after CHECK_FRAMES frames.
 *
 * `--case` (one a process: a case that re-binds the component columns would make the next case's code lose their
 * folding): `shipped` the worker's method; `copy` rebuildOwnedRowsVariants.mjs' verbatim copy (the control, checked
 * against the method's text); `checked` the copy with the per-entity map and Smi checks moved before the loops and the
 * cell range in locals; `pointSkip` checked, and a point whose one cell row another worker owns skips its cell range
 * (see that file). All write the same bytes: compare their checksums. In d8, keep src/ and rebuildOwnedRowsVariants.mjs
 * native modules (not bundled): a bundler makes those module consts top-level `var`s, which TurboFan does not fold, and
 * the copies then check the component columns' maps at every entity.
 *
 *   node tests/bench/rebuildOwnedRowsMicrobench.mjs [--case shipped|copy|checked|pointSkip] [--shape point|box|circle]
 *     [--alive 40000] [--sample-ms 3] [--output path]
 */
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Grid } from '../../src/core/grid.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { KERNEL_SAMPLE_MS } from './benchmarkDefaults.mjs';
import { isCli, mulberry32, parseArgs, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { setupSpatialKernel } from './spatialWorkerMicrobench.mjs';
import { rebuildChecked, rebuildCopy, rebuildPointSkip } from './rebuildOwnedRowsVariants.mjs';

// boidsScene.js's spatial config (rowsPerBlock: the engine's default, 2).
const BOIDS_SPATIAL = {
  worldWidth: 4000,
  worldHeight: 4000,
  cellSize: 20,
  maxNeighbors: 128,
  maxEntitiesPerCell: 20,
  rowsPerBlock: 2,
  neighborReuseSkin: 0.01,
  neighborReuseMaxFrames: 30,
  neighborTickInterval: 15,
};
const POOL = 65000;
const SHORT = 256;
const CHECK_FRAMES = 8;

function fnv(h, v) {
  return Math.imul(h ^ (v >>> 0), 16777619) >>> 0;
}

const CASES = { shipped: null, copy: rebuildCopy, checked: rebuildChecked, pointSkip: rebuildPointSkip };

/** The copy's body against the worker's method text, whitespace aside: the control is the shipped code. */
function sameBody(method, fn) {
  const body = (f) => {
    const t = f.toString();
    return t.slice(t.indexOf('{')).replace(/\s+/g, ' ');
  };
  return body(method) === body(fn);
}

export async function setupRebuild({ alive = 40000, shape = 'point', seed = 0xb01d5, workers = 2, variant = 'shipped' } = {}) {
  const k = await setupSpatialKernel({ n: POOL, workers, spatial: BOIDS_SPATIAL, seed });
  const W = BOIDS_SPATIAL.worldWidth;
  const H = BOIDS_SPATIAL.worldHeight;
  const rng = mulberry32(seed);
  const vx = new Float32Array(POOL);
  const vy = new Float32Array(POOL);
  for (let i = 0; i < POOL; i++) {
    const live = i < alive;
    Transform.active[i] = live ? 1 : 0;
    Transform.x[i] = live ? rng() * W : 0;
    Transform.y[i] = live ? rng() * H : 0;
    const a = rng() * 2 * Math.PI;
    Transform.rotC[i] = shape === 'box' ? Math.cos(a) : 1;
    Transform.rotS[i] = shape === 'box' ? Math.sin(a) : 0;
    Collider.active[i] = live && shape !== 'point' ? 1 : 0;
    Collider.shapeType[i] = shape === 'circle' ? ShapeType.Circle : ShapeType.Box;
    Collider.width[i] = 10;
    Collider.height[i] = 10;
    Collider.radius[i] = shape === 'circle' ? 5 : 0;
    Collider.offsetX[i] = 0;
    Collider.offsetY[i] = 0;
    Collider.visualRange[i] = 100;
    SpriteRenderer.active[i] = live ? 1 : 0;
    RigidBody.active[i] = live ? 1 : 0;
    vx[i] = ((rng() - 0.5) * 800) / 60;
    vy[i] = ((rng() - 0.5) * 800) / 60;
  }
  const list = k.workers[0].activeEntitiesData;
  for (let i = 0; i < alive; i++) list[1 + i] = i;
  const setAlive = (count) => {
    list[0] = count;
  };
  setAlive(alive);

  function drift(count) {
    const tx = Transform.x;
    const ty = Transform.y;
    for (let i = 0; i < count; i++) {
      let x = tx[i] + vx[i];
      let y = ty[i] + vy[i];
      if (x < 0 || x >= W) {
        vx[i] = -vx[i];
        x = tx[i];
      }
      if (y < 0 || y >= H) {
        vy[i] = -vy[i];
        y = ty[i];
      }
      tx[i] = x;
      ty[i] = y;
    }
  }
  if (!(variant in CASES)) throw new Error(`unknown --case ${variant} (${Object.keys(CASES).join(', ')})`);
  const fn = CASES[variant];
  if (variant === 'copy' && !sameBody(k.workers[0].rebuildOwnedRows, rebuildCopy)) {
    throw new Error('rebuildOwnedRowsVariants.mjs: rebuildCopy is not the shipped rebuildOwnedRows any more: run node tests/bench/rebuildOwnedRowsVariantsGen.mjs');
  }
  const rebuild = fn === null
    ? () => {
        for (let w = 0; w < k.workers.length; w++) k.workers[w].rebuildOwnedRows();
      }
    : () => {
        for (let w = 0; w < k.workers.length; w++) fn.call(k.workers[w]);
      };
  return { k, alive, drift, rebuild, setAlive, workers: k.workers };
}

function checksum(s) {
  const meta = s.k.gridMetadata;
  const gridWords = new Int32Array(s.k.mem.buffer, meta.gridByte, (meta.totalCells * Grid.cellByteSize) >> 2);
  const posWords = new Int32Array(s.k.mem.buffer, meta.posByte, s.alive * 4);
  let h = 2166136261;
  for (let i = 0; i < gridWords.length; i++) h = fnv(h, gridWords[i]);
  for (let i = 0; i < posWords.length; i++) h = fnv(h, posWords[i]);
  for (const w of s.workers) {
    h = fnv(h, w._ownedEntityCount);
    for (let i = 0; i < w._ownedEntityCount; i++) h = fnv(h, w._ownedEntityList[i]);
  }
  return h;
}

async function main() {
  const args = parseArgs();
  const shape = String(args.shape || 'point');
  // A rep's floor: a frame here is about 2 ms and varies with where the boids drifted, so a longer rep (--sample-ms 30)
  // steadies the median.
  const sampleMs = Number(args['sample-ms'] ?? KERNEL_SAMPLE_MS);
  if (!['point', 'box', 'circle'].includes(shape)) throw new Error(`unknown --shape ${shape} (point, box, circle)`);
  const alive = Number(args.alive ?? 40000);
  const variant = String(args.case || 'shipped');
  const s = await setupRebuild({ alive, shape, variant });

  // Normal compiles from short frames, then the whole flock. Every fourth short frame nobody moves, so the pose
  // compares past the first (y, the half extent) have run before the long frames, where a worker's first boid now and
  // then has not moved (a bounce): without it the long frames deopted there once and recompiled.
  s.setAlive(SHORT);
  let warm = 0;
  warmNormalCompile(() => {
    if ((warm++ & 3) !== 3) s.drift(SHORT);
    s.rebuild();
  });
  s.setAlive(alive);
  for (let f = 0; f < 3; f++) {
    s.drift(alive);
    s.rebuild();
  }
  let sum = 2166136261;
  for (let f = 0; f < CHECK_FRAMES; f++) {
    s.drift(alive);
    s.rebuild();
    sum = fnv(sum, checksum(s));
  }

  // Each rep: `iterations` frames, the rebuilds timed (the drift is logic's and physics' work). Iterations grow until a
  // rep lasts KERNEL_SAMPLE_MS, as in timeIt.
  function rep(iterations) {
    let ms = 0;
    for (let it = 0; it < iterations; it++) {
      s.drift(alive);
      const t0 = performance.now();
      s.rebuild();
      ms += performance.now() - t0;
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
    if (ms >= sampleMs || iterations >= 1 << 20) break;
    iterations = Math.max(iterations + 1, Math.ceil(((iterations * sampleMs) / Math.max(ms, 1e-6)) * 1.15));
  }
  const owned = s.workers.map((w) => w._ownedEntityCount);
  const label = `rebuildOwnedRows ${variant} x${s.workers.length} (boids grid, ${alive} alive, ${shape})`;
  const result = { label, ms, opsPerSec: (iterations / ms) * 1000, iterations, reps, msPerFrame: ms / iterations, nsPerEntityPerWorker: (ms * 1e6) / iterations / alive / s.workers.length };
  const report = {
    feature: 'spatial-rebuild-owned-rows',
    functions: ['SpatialWorker.rebuildOwnedRows'],
    variant,
    shape,
    alive,
    pool: POOL,
    spatial: BOIDS_SPATIAL,
    owned,
    checksum: sum,
    tier: 'TurboFan normal compile (warmNormalCompile on 256-boid frames)',
    note: 'Real SpatialWorker instances (setupSpatialKernel); the drift untimed, both workers\' rebuilds timed.',
    cases: { rebuild: result },
  };
  if (args.output) writeReport(String(args.output), report);
  else {
    console.log(`${label}: ${result.msPerFrame.toFixed(3)} ms a frame, ${result.nsPerEntityPerWorker.toFixed(2)} ns an entity a worker (owned ${owned.join(' + ')})`);
    console.log(`checksum ${sum}`);
  }
}

if (isCli(import.meta.url)) await main();
