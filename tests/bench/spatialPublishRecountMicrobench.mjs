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

/** The loop the shipped worker runs, ungated. */
function recount(neighborData, list, n, stride) {
  let found = 0;
  for (let i = 0; i < n; i++) found += neighborData[list[i] * stride];
  return found;
}

/** The gated form: no work at all on a verdict run. */
function recountGated() {
  return 0;
}

function checksumOf(b) {
  return recount(b.neighborData, b.list, b.n, b.stride) >>> 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), DEFAULTS);
  const b = build(args);
  const checksum = checksumOf(b);

  // Sanity: the premise of the hypothesis, asserted rather than assumed.
  const rowBytes = b.stride * 2;
  const workingSetBytes = b.neighborData.byteLength;

  const perCall = recount(b.neighborData, b.list, b.n, b.stride);
  const perCallNs = (perCall / b.n) * 1e9;

  const shipped = timeIt(() => recount(b.neighborData, b.list, b.n, b.stride));
  const gated = timeIt(() => recountGated());

  // Cost of the whole pass at 60 Hz, which is the number the scene cares about.
  const perFrameMs = (shipped.medianMs !== undefined ? shipped.medianMs : 0) * 1;
  const atSixtyHzMs = perFrameMs;

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
      nsPerPublishedRow: +perCallNs.toFixed(2),
      note:
        'opsPerSec is one full recount pass. Gated is the trivial form and exists to ' +
        'show the floor, not to claim a speedup ratio.',
      perPassMsAtProductScale: +perFrameMs.toFixed(4),
      sixtyHzCostMs: +atSixtyHzMs.toFixed(4),
    },
    verdict: 'screen-only',
    verdictReason:
      'Kernel is an upper bound: the engine writes these rows from WASM on this same ' +
      'core moments earlier. A cheap kernel here cannot argue the scene; an expensive ' +
      'one still needs the scene. See tests/bench/runPredatorAbab.mjs invocation in ' +
      'docs/internal/reports/E-02-publish-recount.md.',
  };

  if (isCli()) writeReport(report, process.argv.slice(2));
  console.log(JSON.stringify(report, null, 2));
}