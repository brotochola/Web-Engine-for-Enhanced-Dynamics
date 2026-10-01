#!/usr/bin/env node
/**
 * Kernel: the shipped SpatialWorker frame (rebuildOwnedRows +
 * findNeighborsForOwnedEntities) on a real worker instance, Predator layout.
 *
 * Three spatial workers share one Grid and one neighbor SAB, like the scene:
 * each owns interleaved rows. One "frame" is all three updates in sequence.
 * Entities drift each frame so the neighbor-reuse skin and the tick stagger
 * both run the way they do in Predator (skin 0.01, 30 frames, interval 15).
 *
 *   node tests/bench/spatialWorkerMicrobench.mjs
 *   node tests/bench/spatialWorkerMicrobench.mjs --n 16500 --output tests/results/spatial-worker.json
 */
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Grid } from '../../src/core/grid.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { EntityIdArray, packSpatialPairStamp, SPATIAL_STAMP_FRAME_MASK } from '../../src/util/entityIdWidth.js';
import { getColliderBounds, getCellRange, _boundsResult, _cellRangeResult, SHAPE_CIRCLE } from '../../src/util/colliderUtils.js';
import { checksumInts, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import {
  bindPoseColumns,
  coreComponentData,
  initWorker,
  loadWorker,
  quietly,
  setActiveList,
  spatialBuffers,
} from './workerHarness.mjs';

const PREDATOR_SPATIAL = {
  worldWidth: 10000,
  worldHeight: 5000,
  cellSize: 128,
  maxNeighbors: 1024,
  maxEntitiesPerCell: 128,
  rowsPerBlock: 1,
  neighborReuseSkin: 0.01,
  neighborReuseMaxFrames: 30,
  neighborTickInterval: 15,
};

/** Module identifiers the SpatialWorker methods use (for methodVariant patches). */
export const SCOPE = {
  Transform,
  RigidBody,
  Collider,
  SpriteRenderer,
  Grid,
  EntityIdArray,
  packSpatialPairStamp,
  SPATIAL_STAMP_FRAME_MASK,
  getColliderBounds,
  getCellRange,
  _boundsResult,
  _cellRangeResult,
  SHAPE_CIRCLE,
};

// Hypotheses: variantClass(Base, edits, SCOPE) from methodVariant.mjs.
const SPATIAL_VARIANTS = { base: (Base) => Base };

/**
 * The module instantiates one worker; SpatialWorker is not exported, so take
 * the class from that instance. All kernel workers are built from it (or from
 * a variant subclass) and share one Grid and one neighbor SAB like the scene.
 */
async function loadSpatialWorkers(count, variant, makeOverride) {
  const first = await loadWorker('spatialWorker.js', 'spatialWorker');
  const make = makeOverride || SPATIAL_VARIANTS[variant];
  if (!make) throw new Error(`unknown variant ${variant}`);
  const Ctor = make(first.constructor);
  const workers = [];
  for (let i = 0; i < count; i++) workers.push(await quietly(() => new Ctor(globalThis.self)));
  return workers;
}

export async function setupSpatialKernel(opts = {}) {
  const n = opts.n ?? 16500;
  const workersCount = opts.workers ?? 3;
  const seed = opts.seed ?? 0x5a71a1;
  const cfg = { ...PREDATOR_SPATIAL, ...(opts.spatial || {}) };
  const { buffers, gridMetadata } = spatialBuffers(cfg, n);
  buffers.componentData = coreComponentData(n);

  const workers = await loadSpatialWorkers(workersCount, opts.variant || 'base', opts.make);
  for (let w = 0; w < workers.length; w++) {
    await initWorker(workers[w], {
      config: { worldWidth: cfg.worldWidth, worldHeight: cfg.worldHeight, spatial: cfg },
      globalEntityCount: n,
      buffers,
      gridMetadata,
      extra: { workerIndex: w, totalSpatialWorkers: workers.length, frameRateIndex: w },
    });
  }

  bindPoseColumns(n);
  const rng = mulberry32(seed);
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  const ids = [];
  // Predator mix: people clustered in squads (vr 150), soldiers (vr 250),
  // static props (vr 0 / 50), a few lights (vr 400).
  const clusters = 60;
  const cx = new Float32Array(clusters);
  const cy = new Float32Array(clusters);
  for (let c = 0; c < clusters; c++) {
    cx[c] = 300 + rng() * (cfg.worldWidth - 600);
    cy[c] = 300 + rng() * (cfg.worldHeight - 600);
  }
  for (let i = 0; i < n; i++) {
    const kind = rng();
    let x;
    let y;
    if (kind < 0.8) {
      const c = (rng() * clusters) | 0;
      x = cx[c] + (rng() - 0.5) * 900;
      y = cy[c] + (rng() - 0.5) * 900;
    } else {
      x = rng() * cfg.worldWidth;
      y = rng() * cfg.worldHeight;
    }
    Transform.active[i] = 1;
    Transform.x[i] = Math.min(cfg.worldWidth - 1, Math.max(1, x));
    Transform.y[i] = Math.min(cfg.worldHeight - 1, Math.max(1, y));
    Transform.rotC[i] = 1;
    Transform.rotS[i] = 0;
    Collider.active[i] = 1;
    Collider.shapeType[i] = ShapeType.Circle;
    Collider.radius[i] = kind < 0.9 ? 8 : 16;
    Collider.visualRange[i] = kind < 0.7 ? 150 : kind < 0.8 ? 250 : kind < 0.97 ? 0 : 400;
    SpriteRenderer.active[i] = 1;
    RigidBody.active[i] = kind < 0.8 ? 1 : 0;
    vx[i] = kind < 0.8 ? (rng() - 0.5) * 2 : 0;
    vy[i] = kind < 0.8 ? (rng() - 0.5) * 2 : 0;
    ids.push(i);
  }
  setActiveList(buffers.activeEntitiesData, ids);

  function drift() {
    const tx = Transform.x;
    const ty = Transform.y;
    const maxX = cfg.worldWidth - 1;
    const maxY = cfg.worldHeight - 1;
    for (let i = 0; i < n; i++) {
      let x = tx[i] + vx[i];
      let y = ty[i] + vy[i];
      if (x < 1 || x > maxX) {
        vx[i] = -vx[i];
        x = tx[i];
      }
      if (y < 1 || y > maxY) {
        vy[i] = -vy[i];
        y = ty[i];
      }
      tx[i] = x;
      ty[i] = y;
    }
  }

  function frame() {
    drift();
    // update() is the shipped per-frame entry: resets the counters, then
    // rebuildOwnedRows + findNeighborsForOwnedEntities.
    for (let w = 0; w < workers.length; w++) workers[w].update(16.67, 1, false);
  }

  function checksum() {
    const nd = Grid.neighborData;
    const stride = Grid._stride;
    let h = 2166136261;
    for (const w of workers) {
      for (const c of [w.entitiesProcessedThisFrame, w.neighborsFoundThisFrame, w.neighborsReusedThisFrame, w.cellsCheckedThisFrame]) {
        h = Math.imul(h ^ (c >>> 0), 16777619) >>> 0;
      }
    }
    for (let i = 0; i < n; i++) {
      const base = i * stride;
      const count = nd[base];
      h = Math.imul(h ^ count, 16777619) >>> 0;
      // Order inside a list follows cell walk order; hash the set, not the order.
      let s = 0;
      for (let k = 0; k < count; k++) s = (s + Math.imul(nd[base + 1 + k] + 1, 2654435761)) >>> 0;
      h = Math.imul(h ^ s, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  return { n, workers, frame, checksum, cfg };
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const k = await setupSpatialKernel({ n: Number(args.n ?? 16500), seed: Number(args.seed ?? 0x5a71a1), variant });
  // 45 frames: every entity passes a full rebuild and the stagger at least twice.
  for (let f = 0; f < 45; f++) k.frame();
  const checksum = k.checksum();
  let pairs = 0;
  for (let i = 0; i < k.n; i++) pairs += Grid.neighborData[i * Grid._stride];
  assert.ok(pairs > 0, 'no neighbors published');

  const cases = {
    frame: timeIt(`spatial frame ${variant} (${k.workers.length} workers, n=${k.n})`, () => k.frame(), { iterations: 20, warmup: 30 }),
  };
  const report = {
    feature: 'spatial-worker-frame',
    variant,
    functions: ['SpatialWorker.rebuildOwnedRows', 'SpatialWorker.findNeighborsForOwnedEntities'],
    n: k.n,
    seed: Number(args.seed ?? 0x5a71a1),
    workers: k.workers.length,
    checksum,
    publishedPairs: pairs,
    note: 'Real SpatialWorker instances, synthetic init payload (spatial fields only).',
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} pairs ${pairs}`);
}

if (isCli(import.meta.url)) await main();
