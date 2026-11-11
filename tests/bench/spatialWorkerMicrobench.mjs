#!/usr/bin/env node
/**
 * Kernel: the shipped SpatialWorker frame (rebuildOwnedRows + the neighbour search: the gather and publish
 * kernels on the publish memory) on a real worker instance, Predator layout. setupSpatialKernel's `js` option
 * puts the JS search the kernels replaced (tests/reference/spatialGather.mjs) on the workers instead.
 *
 * Three spatial workers share one Grid and one neighbor SAB, like the scene:
 * each owns interleaved rows. One "frame" is all three updates in sequence.
 * Entities drift each frame so the neighbor-reuse skin and the tick stagger
 * both run the way they do in Predator (skin 0.01, 30 frames, interval 15).
 * `--still` (setupSpatialKernel's `still`) leaves every entity where it spawned: the stationary regime of
 * E-136, with the reuse settings from `--skin`, `--max-frames` and `--tick` (the engine's defaults, which
 * stationarySpatialWideScene runs on, are 0.04, 15 and 1).
 * `--types boids|predator` (setupSpatialKernel's `types`, E-200) gives the slots classes whose logic ticks every
 * few frames, with `logic.staggeredUpdates` on and logic 0's frame number in frameRateData, which each kernel frame
 * advances: `boids` is one class ticking every 30 frames (the Boids scene's), `predator` civilians every 4,
 * soldiers every 6, boids every 30 and the rest every frame, in contiguous pools as a scene lays them out. A tree
 * that does not read these inputs runs as without them. The report adds the lists rebuilt (gathered) and published
 * a frame.
 *
 *   node tests/bench/spatialWorkerMicrobench.mjs
 *   node tests/bench/spatialWorkerMicrobench.mjs --n 16500 --output tests/results/spatial-worker.json
 *   node tests/bench/spatialWorkerMicrobench.mjs --still --skin 0.04 --max-frames 15 --tick 1
 *   node tests/bench/spatialWorkerMicrobench.mjs --types boids
 */
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Grid } from '../../src/core/grid.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { bindEntityIdWidth, EntityIdArray, packSpatialPairStamp, SPATIAL_STAMP_FRAME_MASK } from '../../src/util/entityIdWidth.js';
import { getColliderBounds, getCellRange, _boundsResult, _cellRangeResult, SHAPE_CIRCLE } from '../../src/util/colliderUtils.js';
import { createSpatialPublishMemory } from '../../src/util/spatialPublishMemory.js';
import { spatialJsClass } from '../reference/spatialGather.mjs';
import { checksumInts, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import {
  bindPoseColumns,
  bindPublishMemory,
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

/**
 * E-200: the kernel's classes, as fractions of the slots in pool order, with their logic tickInterval. A class
 * whose interval is 1 ticks every frame. Every class has a tick.
 */
const TYPE_PRESETS = {
  boids: [{ name: 'Boid', share: 1, tickInterval: 30 }],
  predator: [
    { name: 'Civilian', share: 0.45, tickInterval: 4 },
    { name: 'Soldier', share: 0.3, tickInterval: 6 },
    { name: 'Boid', share: 0.05, tickInterval: 30 },
    { name: 'Prop', share: 0.2, tickInterval: 1 },
  ],
};

/** registeredClasses entries (sceneWorkerBootstrap's shape) for preset `name` over `n` slots. */
export function kernelClasses(name, n) {
  const preset = TYPE_PRESETS[name];
  if (!preset) throw new Error(`unknown --types ${name} (${Object.keys(TYPE_PRESETS).join(', ')})`);
  const out = [];
  let start = 0;
  for (let t = 0; t < preset.length; t++) {
    const end = t === preset.length - 1 ? n : Math.min(n, start + Math.round(preset[t].share * n));
    out.push({
      name: preset[t].name,
      poolSize: end - start,
      startIndex: start,
      endIndex: end,
      entityType: t,
      tickInterval: preset[t].tickInterval,
      ticks: true,
      // The worker asks its global for each class by name; a spatial worker reads only these fields.
      engineProvided: true,
      components: ['Transform', 'RigidBody', 'Collider', 'SpriteRenderer'],
    });
    start = end;
  }
  return out;
}

/** Module identifiers the SpatialWorker methods use (for methodVariant patches). */
export const SCOPE = {
  Transform,
  RigidBody,
  Collider,
  SpriteRenderer,
  LightEmitter,
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
  // opts.idWidth 32: the scene's 32-bit entity ids (the workers bind the width from config.entityIdWidth).
  const idWidth = opts.idWidth === 32 ? 32 : 16;
  bindEntityIdWidth(idWidth);
  const { buffers, gridMetadata } = spatialBuffers(cfg, n);
  buffers.componentData = coreComponentData(n);
  // Poses, rows, candidates and (E-78) the grid in the publish memory, as sceneSharedBuffers builds it; a
  // function in `opts.publishMemory` is a factory, so a kernel can lay out more regions. `opts.wasm` is the
  // scene's wasm switches (T7); `opts.js` ({ publish: 'js' | 'kernel' }) runs the JS search on the workers.
  const mem = typeof opts.publishMemory === 'function'
    ? opts.publishMemory(n, cfg.maxNeighbors, workersCount, gridMetadata)
    : createSpatialPublishMemory(n, cfg.maxNeighbors, workersCount, {
        totalCells: gridMetadata.totalCells,
        cellByteSize: 4 + cfg.maxEntitiesPerCell * gridMetadata.entityIdBytes,
      });
  if (!mem) throw new Error('no publish memory');
  bindPublishMemory(buffers, gridMetadata, mem);

  const jsMake = opts.js ? (Base) => spatialJsClass(Base, opts.js) : null;
  const make = jsMake && opts.make ? (Base) => opts.make(jsMake(Base)) : jsMake || opts.make;
  const workers = await loadSpatialWorkers(workersCount, opts.variant || 'base', make);
  // E-200: classes with logic tick intervals, and logic 0's frame number where the scene publishes it (slot 1 of
  // its frameRateData row, after the spatial workers' rows).
  const classes = opts.types ? kernelClasses(opts.types, n) : [];
  const FRAME_RATE_STRIDE = 16;
  const logicRow = workersCount;
  let logicFrames = null;
  if (opts.types) {
    buffers.frameRateData = new SharedArrayBuffer((workersCount + 1) * FRAME_RATE_STRIDE * 4);
    logicFrames = new Float32Array(buffers.frameRateData);
  }
  for (let w = 0; w < workers.length; w++) {
    await initWorker(workers[w], {
      config: {
        worldWidth: cfg.worldWidth,
        worldHeight: cfg.worldHeight,
        spatial: cfg,
        entityIdWidth: idWidth,
        ...(opts.types ? { logic: { staggeredUpdates: true } } : {}),
        ...(opts.wasm ? { wasm: opts.wasm } : {}),
      },
      globalEntityCount: n,
      buffers,
      gridMetadata,
      extra: {
        workerIndex: w,
        totalSpatialWorkers: workers.length,
        frameRateIndex: w,
        frameRateStride: FRAME_RATE_STRIDE,
        spatialPublishMemory: mem.memory,
        ...(opts.types ? { registeredClasses: classes, logicFrameRateIndex: logicRow } : {}),
      },
    });
  }
  let logicFrame = 0;

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
    for (const c of classes) if (i >= c.startIndex && i < c.endIndex) Transform.entityType[i] = c.entityType;
    vx[i] = kind < 0.8 && !opts.still ? (rng() - 0.5) * 2 : 0;
    vy[i] = kind < 0.8 && !opts.still ? (rng() - 0.5) * 2 : 0;
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
    // Logic's frame for this vsync (a logic worker publishes it as its frame starts).
    if (logicFrames !== null) logicFrames[logicRow * FRAME_RATE_STRIDE + 1] = ++logicFrame;
    // update() is the shipped per-frame entry: resets the counters, then
    // rebuildOwnedRows + the neighbour search.
    for (let w = 0; w < workers.length; w++) workers[w].update(16.67, 1, false);
  }

  /** Lists gathered and published a frame, averaged over `frames` kernel frames (the frames run). */
  function listRates(frames) {
    let rebuilt = 0;
    let published = 0;
    for (let f = 0; f < frames; f++) {
      frame();
      for (const w of workers) {
        rebuilt += w.neighborsRebuiltThisFrame;
        published += w.neighborsPublishedThisFrame;
      }
    }
    return { rebuiltPerFrame: rebuilt / frames, publishedPerFrame: published / frames };
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

  return { n, workers, frame, checksum, listRates, cfg, mem, gridMetadata, classes };
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const still = Boolean(args.still);
  const spatial = {};
  if (args.skin !== undefined) spatial.neighborReuseSkin = Number(args.skin);
  if (args['max-frames'] !== undefined) spatial.neighborReuseMaxFrames = Number(args['max-frames']);
  if (args.tick !== undefined) spatial.neighborTickInterval = Number(args.tick);
  const types = args.types !== undefined ? String(args.types) : null;
  const k = await setupSpatialKernel({ n: Number(args.n ?? 16500), seed: Number(args.seed ?? 0x5a71a1), variant, still, spatial, types });
  // 45 frames: every entity passes a full rebuild and the stagger at least twice.
  for (let f = 0; f < 45; f++) k.frame();
  const checksum = k.checksum();
  let pairs = 0;
  for (let i = 0; i < k.n; i++) pairs += Grid.neighborData[i * Grid._stride];
  assert.ok(pairs > 0, 'no neighbors published');
  // 60 frames: a whole number of every preset's periods (4, 6, 15, 30, and their multiples up to 30).
  const rates = k.listRates(60);

  const label = `spatial frame ${variant}${still ? ' still' : ''}${types ? ` types=${types}` : ''}`;
  const cases = {
    frame: timeIt(`${label} (${k.workers.length} workers, n=${k.n})`, () => k.frame(), { iterations: 20, warmup: 30 }),
  };
  const report = {
    feature: 'spatial-worker-frame',
    variant,
    still,
    types,
    rates,
    spatial: k.cfg,
    functions: ['SpatialWorker.rebuildOwnedRows', 'SpatialWorker._findNeighbors (spatialGather, spatialPublish)'],
    n: k.n,
    seed: Number(args.seed ?? 0x5a71a1),
    workers: k.workers.length,
    checksum,
    publishedPairs: pairs,
    note: 'Real SpatialWorker instances, synthetic init payload (spatial fields only).',
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} pairs ${pairs} rebuilt/frame ${rates.rebuiltPerFrame.toFixed(1)} published/frame ${rates.publishedPerFrame.toFixed(1)} ${cases.frame.opsPerSec?.toFixed?.(1) ?? ""} frames/s`);
}

if (isCli(import.meta.url)) await main();
