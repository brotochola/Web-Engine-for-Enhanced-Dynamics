#!/usr/bin/env node
/**
 * Kernel: logic0's despawn pass over the shared active lists (LogicWorker._processDespawnSoA on a real
 * LogicWorker, workerHarness). Does not patch src/.
 *
 *   node tests/bench/despawnBatchMicrobench.mjs
 *   node tests/bench/despawnBatchMicrobench.mjs --output tests/results/despawn-batch/kernel.json
 *
 * activeEntitiesData holds 57344 entities (16-bit ids: 115 KB, Predator crowd 2.5's list) of four types, each
 * type a contiguous index range with its own _activeList. A batch despawns D distinct listed entities picked by a
 * seeded RNG, queues them as processListUpdates does (queueDespawnListUpdate, so the queue grows to the batch) and
 * runs the pass on the queue; the lists and Transform.active are then restored from a snapshot (a memcpy, the same on
 * both sides). Cases d8, d64 and d512 are batches of 8, 64 and 512 despawns;
 * ops/s is batches per second. The checksum hashes every list after each batch of the cycle (E-344).
 */
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { loadWorker } from './workerHarness.mjs';
import { checksumInts, isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const SEED = 0xde5ba7c;
const N = 57344;
const TYPES = 4;
const PER_TYPE = N / TYPES;
const CYCLE = 32;

class DespawnKernelA extends GameObject {}
class DespawnKernelB extends GameObject {}
class DespawnKernelC extends GameObject {}
class DespawnKernelD extends GameObject {}
const CLASSES = [DespawnKernelA, DespawnKernelB, DespawnKernelC, DespawnKernelD];

function setupLists() {
  const active = new Uint16Array(1 + N);
  active[0] = N;
  for (let i = 0; i < N; i++) active[1 + i] = i;
  const typeLists = [];
  for (let t = 0; t < TYPES; t++) {
    const list = new Uint16Array(1 + PER_TYPE);
    list[0] = PER_TYPE;
    for (let i = 0; i < PER_TYPE; i++) list[1 + i] = t * PER_TYPE + i;
    typeLists.push(list);
    CLASSES[t].entityType = t;
    CLASSES[t]._activeList = list;
  }
  GameObject.activeEntitiesData = active;
  GameObject.typeListVersions = new Int32Array(new SharedArrayBuffer(4 * 8));
  Transform.active = new Uint8Array(N).fill(1);
  return {
    active,
    typeLists,
    activeSnap: active.slice(),
    typeSnaps: typeLists.map((l) => l.slice()),
  };
}

/** CYCLE batches of d distinct entities each, in the order a frame queues them. */
function makeBatches(d) {
  const rng = mulberry32(SEED + d);
  const batches = [];
  for (let b = 0; b < CYCLE; b++) {
    const idx = new Int32Array(d);
    const classes = new Array(d);
    const seen = new Set();
    let k = 0;
    while (k < d) {
      const e = (rng() * N) | 0;
      if (seen.has(e)) continue;
      seen.add(e);
      idx[k] = e;
      classes[k] = CLASSES[(e / PER_TYPE) | 0];
      k++;
    }
    batches.push({ idx, classes, n: d });
  }
  return batches;
}

function runBatch(worker, lists, batch) {
  const { idx, classes, n } = batch;
  const transformActive = Transform.active;
  for (let i = 0; i < n; i++) {
    transformActive[idx[i]] = 0;
    worker.queueDespawnListUpdate(idx[i], classes[i].entityType, classes[i]);
  }
  worker._processDespawnSoA(worker._despawnIdx, worker._despawnClass, worker._despawnN);
  worker._despawnN = 0;
  const listed = lists.active[0];
  for (let i = 0; i < n; i++) transformActive[idx[i]] = 1;
  return listed;
}

function restore(lists) {
  lists.active.set(lists.activeSnap);
  for (let t = 0; t < TYPES; t++) lists.typeLists[t].set(lists.typeSnaps[t]);
}

function checksum(worker, lists, batches) {
  let h = 0;
  for (const batch of batches) {
    runBatch(worker, lists, batch);
    h = (Math.imul(h, 31) + checksumInts(lists.active, 1 + lists.active[0])) >>> 0;
    for (let t = 0; t < TYPES; t++) {
      const list = lists.typeLists[t];
      h = (Math.imul(h, 31) + checksumInts(list, 1 + list[0])) >>> 0;
    }
    restore(lists);
  }
  return h;
}

async function main() {
  const args = parseArgs();
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  const lists = setupLists();
  const cases = {};
  let all = 0;
  for (const d of [8, 64, 512]) {
    const batches = makeBatches(d);
    // Short calls first, so the timed pass is a normal TurboFan compile, not OSR (N-28).
    const warm = makeBatches(2);
    let w = 0;
    warmNormalCompile(() => {
      runBatch(worker, lists, warm[w++ % CYCLE]);
      restore(lists);
    }, 2000);
    const sum = checksum(worker, lists, batches);
    all = (Math.imul(all, 31) + sum) >>> 0;
    let b = 0;
    const timed = timeIt(`despawn batch d${d} (${N} listed)`, () => {
      runBatch(worker, lists, batches[b]);
      restore(lists);
      b = b + 1 === CYCLE ? 0 : b + 1;
    }, { iterations: args.iters || 64 });
    cases[`d${d}`] = { opsPerSec: timed.opsPerSec, n: timed.iterations, seed: SEED, checksum: sum, sampleMs: timed.ms };
  }
  const report = {
    feature: 'logic-despawn-lists',
    functions: ['LogicWorker.queueDespawnListUpdate', 'LogicWorker._processDespawnSoA'],
    seed: SEED,
    n: N,
    checksum: all,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(JSON.stringify({ checksum: all, cases: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, v.checksum])) }));
  return report;
}

if (isCli(import.meta.url)) await main();

export { main };
