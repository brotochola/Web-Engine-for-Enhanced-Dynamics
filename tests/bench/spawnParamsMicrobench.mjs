#!/usr/bin/env node
/**
 * Kernel (VISUAL_EDITOR_PLAN.md ED-40, for ED-41 and ED-42): the shipped GameObject.spawn / _spawnAt and despawn on a
 * real logic worker (the shipped logicWorker.js in Node, tests/helpers/logicWorkerEntities.mjs), in batches: spawn
 * 256, despawn them, merge the list updates. One case per catalog row:
 *
 *   a  a class without spawnParams, the ring's way: one shared config whose x and y are written per spawn
 *   b  the same class, spawn() with no config (a fresh {} per spawn: its onSpawned may write into it)
 *   c  a class declaring 4 params, spawn() with none passed (ED-42: one shared frozen config, the defaults filled)
 *   d  the same class, 2 of them passed (one config object, reused)
 *   e  a class whose onSpawned spawns one more of it (the params stack at depth 2)
 *
 * Each reports spawns per second (each spawn with its despawn and its share of the list merge), a checksum, and the
 * minor GCs over --gc-spawns spawns (1e6) once warm, from PerformanceObserver gc entries after a full gc. Cases c to
 * e need spawnParams (ED-41): on a tree without it they are null, and runKernelsVsRev reports them as NEW.
 *
 *   node tests/bench/spawnParamsMicrobench.mjs [--output path] [--gc-spawns 1000000]
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { PerformanceObserver, constants } from 'node:perf_hooks';

import { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

globalThis.self = globalThis.self || { postMessage() {}, onmessage: null, close() {} };
globalThis.WorkerGlobalScope = globalThis.WorkerGlobalScope || function () {};
globalThis.postMessage = globalThis.postMessage || globalThis.self.postMessage;

const ARGS = parseArgs();
const BATCH = 256;
const POOL = 1024;
const GC_SPAWNS = Number(ARGS['gc-spawns'] ?? 1e6);

v8.setFlagsFromString('--expose-gc');
const fullGc = vm.runInNewContext('gc');

/** Minor GCs while `fn` runs (the gc entries arrive after it, on the event loop). */
async function minorGcsDuring(fn) {
  let minor = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (entry.detail?.kind === constants.NODE_PERFORMANCE_GC_MINOR) minor++;
  });
  fullGc();
  await new Promise((resolve) => setTimeout(resolve, 10));
  observer.observe({ entryTypes: ['gc'] });
  fn();
  await new Promise((resolve) => setTimeout(resolve, 10));
  observer.disconnect();
  return minor;
}

export async function setupSpawnParamsKernel() {
  const { GameObject } = await import('../../src/core/gameObject.js');
  const { registerOnLogicWorker } = await import('../helpers/logicWorkerEntities.mjs');
  let hasSpawnParams = true;
  try {
    await import('../../src/core/spawnParams.js');
  } catch {
    hasSpawnParams = false;
  }

  let sink = 0;
  class Plain extends GameObject {
    onSpawned(config) {
      sink += config.x === undefined ? 1 : config.x;
    }
  }
  class WithParams extends GameObject {
    static spawnParams = {
      width: { value: 220, min: 8, max: 4000, step: 1 },
      height: { value: 36, min: 8, max: 1000, step: 1 },
      tint: { value: 0x495870, type: 'color' },
      alpha: { value: 1, min: 0, max: 1, step: 0.05 },
    };
    onSpawned(params) {
      sink += params.width + params.height + params.alpha + (params.tint & 0xff) + params.x;
    }
  }
  const childConfig = { depth: 1 };
  class Nester extends GameObject {
    static spawnParams = { depth: { value: 0, min: 0, max: 8, step: 1 } };
    onSpawned(params) {
      sink += params.depth;
      if (params.depth === 0) Nester.spawn(childConfig);
    }
  }
  const worker = await registerOnLogicWorker([
    [Plain, POOL],
    [WithParams, POOL],
    [Nester, POOL],
  ]);

  // The spawned instances of a batch, despawned after it; made once.
  const spawned = new Array(POOL).fill(null);
  let count = 0;
  const despawnBatch = () => {
    for (let k = 0; k < count; k++) {
      spawned[k].despawn();
      spawned[k] = null;
    }
    count = 0;
    worker.processListUpdates();
  };

  const scratch = { x: 0, y: 0 };
  const twoPassed = { width: 400, tint: 0xff8800 };
  const cases = {
    a: () => {
      for (let k = 0; k < BATCH; k++) {
        scratch.x = k;
        scratch.y = -k;
        spawned[count++] = GameObject._spawnAt(Plain, scratch, -1);
      }
      despawnBatch();
    },
    b: () => {
      for (let k = 0; k < BATCH; k++) spawned[count++] = Plain.spawn();
      despawnBatch();
    },
    c: () => {
      for (let k = 0; k < BATCH; k++) spawned[count++] = WithParams.spawn();
      despawnBatch();
    },
    d: () => {
      for (let k = 0; k < BATCH; k++) spawned[count++] = WithParams.spawn(twoPassed);
      despawnBatch();
    },
    e: () => {
      // Each parent spawns its child from its onSpawned: two spawns, the child at depth 2 of the params stack.
      for (let k = 0; k < BATCH; k++) spawned[count++] = Nester.spawn();
      for (const i of worker.activeEntitiesData.subarray(1, worker.activeEntitiesData[0] + 1)) void i;
      despawnNesters();
    },
  };
  // The children are not in `spawned`: despawn every active Nester.
  const despawnNesters = () => {
    for (let k = 0; k < Nester.poolSize; k++) {
      const instance = Nester.instances[k];
      if (instance.active) instance.despawn();
    }
    for (let k = 0; k < count; k++) spawned[k] = null;
    count = 0;
    worker.processListUpdates();
  };
  const spawnsPerOp = { a: BATCH, b: BATCH, c: BATCH, d: BATCH, e: 2 * BATCH };

  /** The indices one batch takes, before any timing: the same on every run of the same tree. */
  const checksumOf = (name) => {
    let x = 2166136261;
    if (name === 'e') {
      for (let k = 0; k < BATCH; k++) {
        const parent = Nester.spawn();
        x = Math.imul(x ^ parent.index, 16777619) >>> 0;
      }
      despawnNesters();
      return x;
    }
    const make = { a: () => GameObject._spawnAt(Plain, scratch, -1), b: () => Plain.spawn(), c: () => WithParams.spawn(), d: () => WithParams.spawn(twoPassed) }[name];
    for (let k = 0; k < BATCH; k++) {
      const entity = make();
      spawned[count++] = entity;
      x = Math.imul(x ^ entity.index, 16777619) >>> 0;
    }
    despawnBatch();
    return x;
  };
  return { cases, spawnsPerOp, checksumOf, hasSpawnParams, sink: () => sink };
}

async function main() {
  const kernel = await setupSpawnParamsKernel();
  const report = {
    feature: 'spawn-params',
    functions: ['GameObject.spawn', 'GameObject._spawnAt', 'GameObject.prototype.despawn', 'fillSpawnParams'],
    hasSpawnParams: kernel.hasSpawnParams,
    batch: BATCH,
    gcSpawns: GC_SPAWNS,
    checksum: 2166136261,
    cases: {},
  };
  for (const [name, op] of Object.entries(kernel.cases)) {
    if (!kernel.hasSpawnParams && (name === 'c' || name === 'd' || name === 'e')) {
      report.cases[name] = { opsPerSec: null, spawnsPerSec: null, minorGcs: null, why: 'no spawnParams in this tree' };
      continue;
    }
    const checksum = kernel.checksumOf(name);
    // The top-level checksum runKernelsVsRev compares old against new: the cases every tree runs.
    if (name === 'a' || name === 'b') report.checksum = Math.imul(report.checksum ^ checksum, 16777619) >>> 0;
    // Normal compiles, not OSR: many short calls first.
    warmNormalCompile(op, 300);
    const timed = timeIt(`spawn-params ${name} (${kernel.spawnsPerOp[name]} spawns a call)`, op, { iterations: 50, warmup: 20 });
    const ops = Math.ceil(GC_SPAWNS / kernel.spawnsPerOp[name]);
    const minorGcs = await minorGcsDuring(() => {
      for (let i = 0; i < ops; i++) op();
    });
    report.cases[name] = {
      ...timed,
      spawnsPerSec: timed.opsPerSec * kernel.spawnsPerOp[name],
      minorGcs,
      gcWindowSpawns: ops * kernel.spawnsPerOp[name],
      checksum,
    };
  }
  report.sink = Number.isFinite(kernel.sink()) ? Math.round(kernel.sink()) % 1e9 : String(kernel.sink());
  if (ARGS.output) writeReport(String(ARGS.output), report);
  else {
    console.log(`checksum ${report.checksum} (spawnParams: ${kernel.hasSpawnParams})`);
    for (const [name, c] of Object.entries(report.cases)) {
      console.log(
        c.spawnsPerSec == null
          ? `  ${name}: ${c.why}`
          : `  ${name}: ${(c.spawnsPerSec / 1e6).toFixed(2)} M spawns/s, ${c.minorGcs} minor GCs over ${c.gcWindowSpawns} spawns`,
      );
    }
  }
}

if (isCli(import.meta.url)) await main();
