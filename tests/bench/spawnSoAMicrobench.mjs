#!/usr/bin/env node
/**
 * Kernel (E-125): the shipped LogicWorker._processSpawnSoA on a real logic worker, the whole method: the spawn
 * batch sorted by entity index, the duplicates dropped, then merged into the active list and each class's list.
 * spawnSortMicrobench timed the sort strategies apart from the worker; this times what the scene runs, so a
 * change to the method is read old against new (two trees, alternating processes).
 *
 *   storm   1 024 spawns a frame into 8 000 live entities of 4 classes (spawnStormScene's shape)
 *   batch   256 spawns into 20 000 live entities
 *   trickle 16 spawns into 20 000 live entities
 * Each batch draws indices from the free part of a 65 536-slot space, 2 % repeated (a slot reused at once); each
 * class owns a quarter of the space, as an entity type owns its pool's range.
 *
 *   node tests/bench/spawnSoAMicrobench.mjs [--output path]
 */
import { isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

globalThis.self = globalThis.self || { postMessage() {}, onmessage: null, close() {} };
globalThis.WorkerGlobalScope = globalThis.WorkerGlobalScope || function () {};
globalThis.postMessage = globalThis.postMessage || globalThis.self.postMessage;

const ARGS = parseArgs();
const SPACE = 65536;
const CLASSES = 4;
const CASES = {
  storm: { spawns: 1024, live: 8000 },
  batch: { spawns: 256, live: 20000 },
  trickle: { spawns: 16, live: 20000 },
};

export async function setupSpawnKernel(caseName, seed = 0x125) {
  await import('../../src/workers/logicWorker.js');
  const worker = globalThis.self.logicWorker;
  const { Transform } = await import('../../src/components/transform.js');
  const { GameObject } = await import('../../src/core/gameObject.js');
  const c = CASES[caseName];
  const rng = mulberry32(seed);
  const classes = Array.from({ length: CLASSES }, (_, k) => ({ name: `C${k}`, _activeList: new Int32Array(SPACE + 1) }));
  // Each class owns a range of the space, as each entity type owns its pool's indices; the live entities are a
  // random subset, and the batch spawns into the rest.
  const classOf = (e) => ((e * CLASSES) / SPACE) | 0;
  const live = new Uint8Array(SPACE);
  const liveClass = new Int32Array(SPACE).fill(-1);
  let placed = 0;
  while (placed < c.live) {
    const e = (rng() * SPACE) | 0;
    if (live[e]) continue;
    live[e] = 1;
    liveClass[e] = classOf(e);
    placed++;
  }
  const baseAll = new Int32Array(SPACE + 1);
  const baseLists = classes.map(() => new Int32Array(SPACE + 1));
  for (let e = 0; e < SPACE; e++) {
    if (!live[e]) continue;
    baseAll[++baseAll[0]] = e;
    const list = baseLists[liveClass[e]];
    list[++list[0]] = e;
  }
  // Only the used part is restored each call: the lists' counts sit at [0].
  const baseAllUsed = baseAll.subarray(0, baseAll[0] + 1);
  const baseListsUsed = baseLists.map((list) => list.subarray(0, list[0] + 1));
  const n = c.spawns;
  const idx = new Int32Array(n);
  const cls = new Array(n);
  for (let i = 0; i < n; i++) {
    let e;
    if (i > 0 && rng() < 0.02) {
      const j = (rng() * i) | 0;
      e = idx[j];
      cls[i] = cls[j];
    } else {
      do e = (rng() * SPACE) | 0; while (live[e]);
      cls[i] = classes[classOf(e)];
    }
    idx[i] = e;
  }
  // The worker's own buffers, grown as a batch this size grows them.
  while (worker._spawnCap <= n) worker._growPending('spawn');
  // The merge scratch the worker's init sizes to the entity count (null in a bare worker: the merge would allocate).
  worker._listMergeScratch = new Int32Array(1 + SPACE);
  const transformActive = new Uint8Array(SPACE).fill(1);
  const activeAll = new Int32Array(SPACE * 2);

  /** One call on the starting lists: the active list and each class's list restored first. */
  const op = (spawns = n) => {
    Transform.active = transformActive;
    GameObject.activeEntitiesData = activeAll;
    activeAll.set(baseAllUsed);
    for (let k = 0; k < CLASSES; k++) classes[k]._activeList.set(baseListsUsed[k]);
    const wi = worker._spawnIdx;
    const wc = worker._spawnClass;
    for (let i = 0; i < spawns; i++) {
      wi[i] = idx[i];
      wc[i] = cls[i];
    }
    worker._processSpawnSoA(wi, wc, spawns);
    return activeAll[0];
  };
  const hash = () => {
    let x = 2166136261;
    const lists = [activeAll, ...classes.map((k) => k._activeList)];
    for (const list of lists) {
      for (let i = 0; i <= list[0]; i++) x = Math.imul(x ^ list[i], 16777619) >>> 0;
    }
    return x;
  };
  return { worker, op, hash, n };
}

async function main() {
  const cases = {};
  let checksum = 2166136261;
  for (const name of Object.keys(CASES)) {
    const s = await setupSpawnKernel(name);
    if ((s.worker._spawnIdx?.length | 0) < s.n) throw new Error(`the worker's spawn buffers hold ${s.worker._spawnIdx?.length}, the case needs ${s.n}`);
    const live = s.op();
    checksum = Math.imul(checksum ^ s.hash(), 16777619) >>> 0;
    // Normal compiles, not OSR: short calls of 8 spawns.
    warmNormalCompile(() => s.op(8));
    cases[name] = timeIt(`spawnSoA ${name} (${s.n} spawns, ${live} live after)`, () => s.op(), { iterations: 200, warmup: 20 });
  }
  const report = {
    feature: 'spawn-soa',
    functions: ['LogicWorker._processSpawnSoA'],
    checksum,
    cases,
  };
  if (ARGS.output) writeReport(String(ARGS.output), report);
  else {
    console.log(`checksum ${checksum}`);
    for (const [name, c] of Object.entries(cases)) console.log(`  ${name}: ${c.opsPerSec.toFixed(1)} ops/s`);
  }
}

if (isCli(import.meta.url)) await main();
