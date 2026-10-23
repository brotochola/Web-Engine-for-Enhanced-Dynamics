#!/usr/bin/env node
/**
 * Kernel: the spatial neighbour publish, shipped JS against the shipped WASM module (E-76 T4).
 *
 * JS: `SpatialWorker._publishFilteredNeighbors` on a real worker in JS mode, the path the engine
 * takes without a publish memory (32-bit ids, or the module failed to load), called per entity as
 * `findNeighborsForOwnedEntities` calls it. It keeps that path's storage: poses in the
 * `entityPosData` SAB, candidates in the worker's own array, rows in `Grid.neighborData`.
 * WASM: `publish_batch` on the product memory (`createSpatialPublishMemory`), one call for the
 * batch, as the worker makes it at the end of a frame. Both sides read the same bytes; the rows
 * they write are compared before anything is timed.
 *
 * Cases (one per process, `--case`):
 *   uniform   4 096 entities over 10 000 × 5 000, 48 random candidates each, a batch of 2 048
 *             (the distribution of the 2026-10-06 rows; almost every candidate fails the range)
 *   predator  the candidate rows the real gather builds for one worker's owned entities, on
 *             spatialWorkerMicrobench's Predator mix (16 500 entities, 3 workers, 45 frames)
 *
 *   node tests/bench/spatialPublishWasmMicrobench.mjs [--case uniform|predator] [--rounds 9] [--output path]
 *   node --allow-natives-syntax tests/bench/spatialPublishWasmMicrobench.mjs   (also checks the WASM tier)
 */
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { Grid } from '../../src/core/grid.js';
import { createSpatialPublishMemory } from '../../src/util/spatialPublishMemory.js';
import { isCli, parseArgs, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { setupSpatialKernel } from './spatialWorkerMicrobench.mjs';
import { abab, instantiateKernel, machineState, warmWasm } from './wasmKernelHelpers.mjs';
import { initWorker, loadWorker, spatialBuffers } from './workerHarness.mjs';

const UNIFORM = { count: 4096, maxNeighbors: 1024, candidates: 48, batch: 2048, seed: 0x1234567 };

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Views of the product memory, by the offsets createSpatialPublishMemory chose. */
function memoryViews(mem, count, maxN) {
  const b = mem.buffer;
  const stride = 1 + maxN;
  return {
    pos: new Float32Array(b, mem.posByte, count * 4),
    range: new Float32Array(b, mem.rangeByte, count),
    rows: new Uint16Array(b, mem.neighborByte, count * stride),
    cand: new Uint16Array(b, mem.candByte, count * stride),
    list: new Uint16Array(b, mem.listByte, count),
  };
}

/** The 2026-10-06 distribution, same generator and order as the bench of that day. */
async function uniformCase() {
  const { count, maxNeighbors: maxN, candidates, batch, seed } = UNIFORM;
  const stride = 1 + maxN;
  const mem = createSpatialPublishMemory(count, maxN, 1);
  assert.ok(mem, 'publish memory (16-bit ids)');
  const m = memoryViews(mem, count, maxN);
  const rnd = lcg(seed);
  for (let e = 0; e < count; e++) {
    m.pos[e * 4] = rnd() * 10000;
    m.pos[e * 4 + 1] = rnd() * 5000;
    m.pos[e * 4 + 2] = 4 + rnd() * 12;
    m.range[e] = 80 + rnd() * 120;
  }
  for (let k = 0; k < batch; k++) m.list[k] = (rnd() * count) | 0;
  for (let k = 0; k < batch; k++) {
    const a = m.list[k];
    const base = a * stride;
    m.cand[base] = candidates;
    for (let i = 0; i < candidates; i++) {
      let b = (rnd() * count) | 0;
      if (b === a) b = (b + 1) % count;
      m.cand[base + 1 + i] = b;
    }
  }

  const cfg = { worldWidth: 10000, worldHeight: 5000, cellSize: 128, maxEntitiesPerCell: 128, maxNeighbors: maxN };
  const worker = await loadWorker('spatialWorker.js', 'spatialWorker');
  const { buffers, gridMetadata } = spatialBuffers(cfg, count);
  await initWorker(worker, {
    config: { worldWidth: cfg.worldWidth, worldHeight: cfg.worldHeight, spatial: cfg },
    globalEntityCount: count,
    buffers,
    gridMetadata,
    extra: { workerIndex: 0, totalSpatialWorkers: 1 },
  });
  assert.equal(worker._wasmPub, null, 'the worker runs the JS path');
  worker.entityPosData.set(m.pos);
  worker._neighborCandidateData.set(m.cand);
  const range = Float32Array.from(m.range);
  return { mem, m, worker, range, list: Uint16Array.from(m.list.subarray(0, batch)), n: batch, count, maxN };
}

/** Candidate rows from the real gather (JS mode), copied into the product memory for the WASM. */
async function predatorCase() {
  const k = await setupSpatialKernel({ n: 16500, workers: 3 });
  for (let f = 0; f < 45; f++) k.frame();
  const worker = k.workers[0];
  const maxN = Grid.maxNeighbors;
  const stride = 1 + maxN;
  const count = k.n;
  const visualRange = Collider.visualRange;
  const ids = [];
  for (let i = 0; i < worker._ownedEntityCount; i++) {
    const a = worker._ownedEntityList[i];
    if (visualRange[a] > 0) ids.push(a);
  }
  const mem = createSpatialPublishMemory(count, maxN, 1);
  assert.ok(mem, 'publish memory (16-bit ids)');
  const m = memoryViews(mem, count, maxN);
  m.pos.set(worker.entityPosData.subarray(0, count * 4));
  m.range.set(visualRange.subarray(0, count));
  for (let i = 0; i < ids.length; i++) {
    const base = ids[i] * stride;
    m.list[i] = ids[i];
    m.cand.set(worker._neighborCandidateData.subarray(base, base + 1 + worker._neighborCandidateData[base]), base);
  }
  const range = Float32Array.from(visualRange.subarray(0, count));
  return { mem, m, worker, range, list: Uint16Array.from(ids), n: ids.length, count, maxN };
}

/** FNV-1a over each batch entity's row (count, then ids), in batch order. */
function checksumRows(rows, list, n, stride) {
  let h = 2166136261;
  for (let k = 0; k < n; k++) {
    const base = list[k] * stride;
    const c = rows[base];
    for (let i = 0; i <= c; i++) h = Math.imul(h ^ rows[base + i], 16777619) >>> 0;
  }
  return h >>> 0;
}

async function main() {
  const args = parseArgs();
  const caseName = String(args.case || 'uniform');
  const rounds = Number(args.rounds ?? 9);
  const setup = caseName === 'uniform' ? await uniformCase() : caseName === 'predator' ? await predatorCase() : null;
  if (!setup) throw new Error(`unknown case ${caseName}`);
  const { mem, m, worker, range, list, n, maxN } = setup;
  const stride = 1 + maxN;
  const posJs = worker.entityPosData;
  const rowsJs = Grid.neighborData;
  const publish = instantiateKernel('spatialPublish', mem.memory).publish_batch;

  const js = (count) => {
    for (let k = 0; k < count; k++) {
      const a = list[k];
      const p = a * 4;
      worker._publishFilteredNeighbors(a, posJs[p], posJs[p + 1], range[a], a * stride, maxN, posJs, rowsJs);
    }
  };
  const wasm = (count) => publish(count, maxN, mem.posByte, mem.rangeByte, mem.candByte, mem.neighborByte, mem.listByte);

  // Parity on the full batch, before any timing.
  rowsJs.fill(0xbeef);
  m.rows.fill(0xbeef);
  js(n);
  wasm(n);
  const jsSum = checksumRows(rowsJs, list, n, stride);
  const wasmSum = checksumRows(m.rows, list, n, stride);
  assert.equal(wasmSum, jsSum, 'WASM rows equal the shipped JS rows');
  let pairs = 0;
  for (let k = 0; k < n; k++) pairs += rowsJs[list[k] * stride];
  console.log(`${caseName}: ${n} entities in the batch, ${pairs} neighbours published, checksum ${jsSum}`);

  // Warm both on a slice, then time the whole batch.
  const slice = Math.min(n, 64);
  warmNormalCompile(() => js(slice));
  const tier = await warmWasm(publish, () => wasm(slice));
  const result = abab({ js: () => js(n), wasm: () => wasm(n) }, { rounds, label: `publish ${caseName}` });

  const report = {
    feature: 'spatial-publish-wasm',
    case: caseName,
    functions: ['SpatialWorker._publishFilteredNeighbors', 'spatialPublish.publish_batch'],
    n,
    seed: caseName === 'uniform' ? UNIFORM.seed : 0x5a71a1,
    checksum: jsSum,
    publishedPairs: pairs,
    wasmTier: tier,
    machine: machineState(),
    rounds,
    cases: result.cases,
    comparisons: result.comparisons,
  };
  if (args.output) writeReport(String(args.output), report);
  return report;
}

if (isCli(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
