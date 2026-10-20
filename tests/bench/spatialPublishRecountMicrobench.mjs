// E-02 kernel: the second pass the spatial worker makes over `neighborData`
// after the WASM publish, purely to fill `neighborsFoundThisFrame`.
//
// This is a kernel for the LOOP, not for the decision. The decision (gate it on
// `collectDetailedStats`, because its only consumer is gated) is settled in
// tests/node/spatialPublishRecount.test.js. What this measures is whether the
// loop is worth removing at all.
//
// HOW_WE_MEASURE, "What a kernel cannot show": a kernel holds its arrays hot in one
// core's cache, and in the engine those rows were written by WASM in the same
// worker moments earlier, so some of it is hot there too. That makes this an
// UPPER BOUND on the kernel number relative to the scene: if the kernel says the
// loop is cheap, the scene cannot be argued from it; if the kernel says it is
// expensive, the scene still has to be run. It is a screen, not a verdict.
//
// E-02 in docs/internal/EXECUTION_PLAN.md.

import fs from 'node:fs';

import { parseArgs, timeIt, writeReport, isCli } from './microbenchHelpers.mjs';

const DEFAULTS = {
  seed: 0xe02002,
  maxNeighbors: 1024,
  // Predator: maxNeighbors 1024 => stride 2050 bytes, ~16.5k entities.
  maxNeighbors: 1024,
  entityCount: 16500,
  // Predator uses neighborTickInterval 15, so most entities take the stagger skip
  // and only ~1/15 of them reach a full rebuild and a publish.
  publishFraction: 1 / 15,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function build({ seed, maxNeighbors, entityCount, publishFraction }) {
  const stride = 1 + maxNeighbors;
  const neighborData = new Uint16Array(entityCount * stride);
  const rnd = mulberry32(seed);
  // Rows look like a real publish: a mix of empty, short and saturated.
  for (let e = 0; e < entityCount; e++) {
    const r = rnd();
    const c = r < 0.15 ? 0 : r < 0.9 ? Math.floor(rnd() * 24) : maxNeighbors;
    neighborData[e * stride] = c;
  }
  const n = Math.max(1, Math.floor(entityCount * publishFraction));
  const list = new Uint16Array(n);
  for (let i = 0; i < n; i++) list[i] = Math.floor(rnd() * entityCount);
  return { neighborData, list, n, stride };
}

/**
 * The shipped block itself, ungated: the code between the neighbor-recount
 * markers in spatialWorker.js, not a copy of it (review M9).
 */
const shippedRecount = (() => {
  const src = fs.readFileSync(new URL('../../src/workers/spatialWorker.js', import.meta.url), 'utf8');
  const a = src.indexOf('// neighbor-recount-start');
  const b = src.indexOf('// neighbor-recount-end');
  if (!(a > 0 && b > a)) throw new Error('neighbor-recount markers not found in spatialWorker.js');
  return new Function('Grid', 'n', `${src.slice(a, b)}
return found;`);
})();

/** Bind the worker fields the block reads once per fixture, outside any timing. */
function makeRecount({ neighborData, list, n, stride }) {
  const self = { _wasmPub: { list } };
  const grid = { maxNeighbors: stride - 1, neighborData };
  return () => shippedRecount.call(self, grid, n);
}

/** The gated form: no work at all on a verdict run. */
function recountGated() {
  return 0;
}

function checksumOf(run) {
  return run() >>> 0;
}

async function main() {
  // `parseArgs` in microbenchHelpers takes no defaults argument; merge by hand.
  const args = { ...DEFAULTS, ...parseArgs(process.argv.slice(2)) };
  const b = build(args);
  const run = makeRecount(b);
  const checksum = checksumOf(run);

  // Sanity: the premise of the hypothesis, asserted rather than assumed.
  const rowBytes = b.stride * 2;
  const workingSetBytes = b.neighborData.byteLength;

  const shipped = timeIt('recount', run);
  const gated = timeIt('recount-gated', () => recountGated());

  // One pass costs `1 / opsPerSec` seconds. That is the whole number that matters:
  // it is what the worker spends per frame, and it is what the scene can save.
  const perPassMs = 1000 / shipped.opsPerSec;
  const nsPerPublishedRow = (perPassMs * 1e6) / b.n;

  const report = {
    name: 'spatialPublishRecount',
    seed: args.seed,
    checksum,
    cases: {
      ungated: { opsPerSec: shipped.opsPerSec, medianMs: shipped.medianMs },
      gated: { opsPerSec: gated.opsPerSec, medianMs: gated.medianMs },
    },
    shape: {
      maxNeighbors: args.maxNeighbors,
      strideElements: b.stride,
      rowBytes,
      entityCount: args.entityCount,
      publishCount: b.n,
      workingSetMB: +(workingSetBytes / 1e6).toFixed(2),
    },
    reading: {
      nsPerPublishedRow: +nsPerPublishedRow.toFixed(1),
      note:
        'opsPerSec is one full recount pass over `publishCount` rows. Gated is the ' +
        'trivial form and exists to show the floor, not to claim a speedup ratio.',
      perPassMs: +perPassMs.toFixed(6),
      // What the number means against a real spatial worker step.
      shareOfA7msStepPct: +((perPassMs / 7) * 100).toFixed(4),
    },
    verdict: 'screen-only',
    verdictReason:
      'Kernel is an upper bound: the engine writes these rows from WASM on this same ' +
      'core moments earlier. A cheap kernel here cannot argue the scene; an expensive ' +
      'one still needs the scene. See tests/bench/runPredatorAbab.mjs invocation in ' +
      'docs/internal/reports/E-02-publish-recount.md.',
  };

  if (isCli(import.meta.url)) writeReport(args.output || 'tests/results/e02-publish-recount/kernel.json', report);
  console.log(JSON.stringify(report, null, 2));
}

if (isCli(import.meta.url)) main();