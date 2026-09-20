#!/usr/bin/env node
// Kernel: SAB spawn ring push+drain+merge vs create spawnBatch payload build.
//
//   node tests/bench/spawnCommandRingMicrobench.mjs
//   pnpm bench:micro:spawn-ring

import assert from 'node:assert/strict';

import {
  createCreateSpawnQueue,
  pushCreateSpawn,
  buildSpawnBatchPayloads,
  clearCreateSpawnQueue,
} from '../../src/util/createSpawnBatch.js';
import { mergeSortedIntoActiveList } from '../../src/util/gameObjectActiveState.js';
import {
  createSpawnCommandRingSab,
  bindSpawnCommandRing,
  tryPushSpawn,
  drainSpawnCommands,
} from '../../src/util/spawnCommandRing.js';
import { parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const OUTPUT = args.output ? String(args.output) : null;
const N = Number(args.n ?? 2048);

const sab = createSpawnCommandRingSab(N);
bindSpawnCommandRing(sab);
const incoming = new Uint16Array(N);
const list = new Uint16Array(1 + N);
const mergeScratch = new Uint16Array(1 + N);
const queue = createCreateSpawnQueue(N);

let checksum = 0;

function ringPushDrainMerge(iters) {
  for (let r = 0; r < iters; r++) {
    let k = 0;
    let xor = 0;
    for (let i = 0; i < N; i++) {
      if (!tryPushSpawn(1, i, i, i)) throw new Error('ring overflow');
    }
    drainSpawnCommands((_kind, _typeId, entityIndex) => {
      incoming[k++] = entityIndex;
      xor ^= entityIndex;
    });
    mergeSortedIntoActiveList(list, incoming, k, mergeScratch);
    checksum += xor + (list[0] | 0);
  }
}

function jsQueuePayloads(iters) {
  for (let r = 0; r < iters; r++) {
    clearCreateSpawnQueue(queue);
    for (let i = 0; i < N; i++) {
      pushCreateSpawn(queue, i, 'Bunny', { x: i, y: i }, 0);
    }
    const payloads = buildSpawnBatchPayloads(queue);
    let xor = 0;
    for (let p = 0; p < payloads.length; p++) {
      const groups = payloads[p].groups;
      for (let g = 0; g < groups.length; g++) {
        const idx = groups[g].entityIndex;
        for (let i = 0; i < idx.length; i++) xor ^= idx[i];
      }
    }
    checksum += xor + payloads.length;
  }
}

ringPushDrainMerge(1);
jsQueuePayloads(1);
assert.ok(checksum !== 0);

const cases = {
  ringPushDrainMerge: timeIt('ring_push_drain_merge', ringPushDrainMerge, {
    iterations: Number(args.iters ?? 40),
  }),
  jsQueuePayloads: timeIt('js_queue_spawnBatch_payloads', jsQueuePayloads, {
    iterations: Number(args.jsIters ?? 40),
  }),
};

const ringOps = cases.ringPushDrainMerge.opsPerSec;
const jsOps = cases.jsQueuePayloads.opsPerSec;
const deltaPct = ((ringOps - jsOps) / jsOps) * 100;

const report = {
  feature: 'spawn-command-ring',
  n: N,
  checksum,
  cases,
  deltaPct,
};
if (OUTPUT) writeReport(OUTPUT, report);
console.log(
  `ring vs spawnBatch payloads: ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}% ops/s (checksum ${checksum})`,
);

bindSpawnCommandRing(null);
