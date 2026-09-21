#!/usr/bin/env node
// L1: Treiber free-list pop/push (Wave I).
//
//   node tests/bench/treiberMicrobench.mjs

import assert from 'node:assert/strict';

import {
  resetFreeList,
  popFreeIndex,
  popFreeIndices,
  pushFreeIndex,
  getFreeListCount,
} from '../../src/util/atomicFreeList.js';
import { parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const OUTPUT = args.output ? String(args.output) : null;
const CAP = Number(args.capacity ?? 4096);

function makeList(count) {
  const top = new Int32Array(new SharedArrayBuffer(8));
  const links = new Uint16Array(new SharedArrayBuffer(count * 2));
  resetFreeList(top, links, count, 1);
  return { top, links };
}

const { top, links } = makeList(CAP);
const a = popFreeIndex(top, links);
const b = popFreeIndex(top, links);
pushFreeIndex(top, links, b);
pushFreeIndex(top, links, a);
assert.equal(popFreeIndex(top, links), a);
assert.equal(getFreeListCount(top), CAP - 1);
pushFreeIndex(top, links, popFreeIndex(top, links));

resetFreeList(top, links, CAP, 1);
const batch = new Int32Array(32);
assert.equal(popFreeIndices(top, links, 32, batch), 32);
for (let i = 0; i < 32; i++) pushFreeIndex(top, links, batch[i]);

const cases = {
  popPush: timeIt('pop_push', (iters) => {
    for (let i = 0; i < iters; i++) {
      const idx = popFreeIndex(top, links);
      pushFreeIndex(top, links, idx);
    }
  }, { iterations: Number(args.iters ?? 200000) }),
  batchPop: timeIt('popFreeIndices_32', (iters) => {
    for (let i = 0; i < iters; i++) {
      const n = popFreeIndices(top, links, 32, batch);
      for (let k = 0; k < n; k++) pushFreeIndex(top, links, batch[k]);
    }
  }, { iterations: Number(args.batchIters ?? 20000) }),
};

const report = { feature: 'treiber-free-list', capacity: CAP, cases };
if (OUTPUT) writeReport(OUTPUT, report);

if (args.campaign) {
  const { runFlKernel } = await import('./entityIdWidthKernels.mjs');
  await runFlKernel({
    output: args.campaignOut || 'tests/results/entity-id-width/kernel-fl.json',
  });
}
