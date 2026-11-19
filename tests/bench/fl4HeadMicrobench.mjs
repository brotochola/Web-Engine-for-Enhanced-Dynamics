// Kernel: FL4, the wide free list (atomicFreeList.js popFl4 / pushFl4 / popIndicesFl4), on a pool of
// MAX_POOL_SLOTS (1 048 575) slots, the size a million decorations or entities take. Imports the shipped functions;
// does not patch src/.
//
//   node tests/bench/fl4HeadMicrobench.mjs
//   node tests/bench/fl4HeadMicrobench.mjs --output tests/results/fl4-head/kernel.json [--iters N]
//
// cycle: pop 64 slots one at a time, push them back (128 Treiber operations an iteration, ns per operation).
// batch: popIndicesFl4 of 64, then the 64 pushed back (65 operations an iteration).
// Each operation moves the ABA tag by one, so a run walks the tag through all its values; `outsideSmi` is the share of
// the heads it saw outside Chrome's 31-bit Smi range (E-263: there an Atomics.load or compareExchange returns a heap
// number, ~14 ns an operation in a Chrome worker, E-87). Node's V8 has 32-bit Smis and inlines Atomics, so this
// kernel times the head's arithmetic, not that boxing: Chrome decides E-263.

import { popFl4, popIndicesFl4, pushFl4, resetFl4 } from '../../src/util/atomicFreeList.js';
import { MAX_POOL_SLOTS } from '../../src/util/poolSlotWidth.js';
import { checksumInts, isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const N = MAX_POOL_SLOTS;
const K = 64;

function makeList(n) {
  const top = new Int32Array(new SharedArrayBuffer(16));
  const links = new Uint32Array(new SharedArrayBuffer(n * 4));
  resetFl4(top, links, n, 8);
  return { top, links };
}

/** Pop K one by one, push them back in reverse: the stack is as it was, the tag 2K further. */
function cycle(list, held, iterations) {
  const { top, links } = list;
  let acc = 0;
  for (let it = 0; it < iterations; it++) {
    for (let k = 0; k < K; k++) held[k] = popFl4(top, links, 0);
    for (let k = K - 1; k >= 0; k--) pushFl4(top, links, held[k], 0);
    acc = (acc + held[it & (K - 1)]) | 0;
  }
  return acc;
}

/** One batch pop of K, the K pushed back in reverse. */
function batch(list, held, iterations) {
  const { top, links } = list;
  let acc = 0;
  for (let it = 0; it < iterations; it++) {
    const got = popIndicesFl4(top, links, K, held, 0, 0);
    for (let k = got - 1; k >= 0; k--) pushFl4(top, links, held[k], 0);
    acc = (acc + held[it & (K - 1)]) | 0;
  }
  return acc;
}

/** The slots a fixed run hands out, and the share of the heads it passes through that are not 31-bit Smis. */
function probe(fn) {
  const list = makeList(N);
  const held = new Uint32Array(K);
  const seen = new Uint32Array(4096 * 4);
  let outside = 0;
  let heads = 0;
  for (let it = 0; it < seen.length / K; it++) {
    fn(list, held, 1);
    seen.set(held, it * K);
    const head = Atomics.load(list.top, 0);
    heads++;
    if (head >= 1 << 30 || head < -(1 << 30)) outside++;
  }
  // Every head over a whole tag cycle, one operation at a time.
  const one = makeList(N);
  let cycleOutside = 0;
  const steps = 8192;
  for (let s = 0; s < steps; s++) {
    const i = popFl4(one.top, one.links, 0);
    pushFl4(one.top, one.links, i, 0);
    const head = Atomics.load(one.top, 0);
    if (head >= 1 << 30 || head < -(1 << 30)) cycleOutside++;
  }
  return { checksum: checksumInts(seen), sampledOutside: outside / heads, outsideSmi: cycleOutside / steps };
}

function timeCase(label, fn, opsPerIteration, iterations) {
  const list = makeList(N);
  const held = new Uint32Array(K);
  // Normal TurboFan code for the driver, not OSR (N-28): short calls first.
  warmNormalCompile(() => fn(list, held, 4));
  const p = probe(fn);
  const timed = timeIt(label, (iters) => {
    fn(list, held, iters);
  }, { iterations });
  const ops = timed.iterations * opsPerIteration;
  const nsPerOp = (timed.ms * 1e6) / ops;
  return { nsPerOp, opsPerSec: (ops / timed.ms) * 1000, iterations: timed.iterations, sampleMs: timed.ms, ...p };
}

function main() {
  const args = parseArgs();
  const iterations = args.iters || 20000;
  const cases = {
    cycle: timeCase('fl4Cycle', cycle, 2 * K, iterations),
    batch: timeCase('fl4Batch', batch, K + 1, iterations),
  };
  for (const [name, c] of Object.entries(cases)) {
    console.log(`${name}: ${c.nsPerOp.toFixed(2)} ns/op, heads outside the Smi range ${(100 * c.outsideSmi).toFixed(1)} %, checksum ${c.checksum}`);
  }
  const payload = { n: N, k: K, tier: 'TurboFan (normal compile, warmed by short calls)', cases };
  if (args.output) writeReport(args.output, payload);
  return payload;
}

if (isCli(import.meta.url)) main();
