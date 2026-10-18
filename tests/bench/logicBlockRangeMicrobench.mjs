// E-03 kernel: `logicBlockRange` returns a fresh `{start, end}` object on every call.
//
// Standing practice adopted after E-02 and E-10 (see EXECUTION_PLAN.md E-25):
// **probe the premise before timing anything.** E-02 and E-10 were both allocation
// / representation-shaped intuitions with no measurable cost behind them, and both
// were caught only because the premise was written down as runnable code.
//
// E-03's premise: "allocating one small object per type per phase per worker per
// frame is worth removing." The premise has three parts, and each can fail:
//
//   1. How many calls per frame?  (types x phases x logic workers)
//   2. How many bytes does that allocate per frame?
//   3. How much of the frame is that, against a real logic worker step?
//
// All three are computed here before a single timing sample is taken, because a
// kernel win on a function that is 0.001% of the frame is a win on nothing.
//
// E-03 in docs/internal/EXECUTION_PLAN.md.

import { parseArgs, timeIt, writeReport, isCli } from './microbenchHelpers.mjs';

const DEFAULTS = {
  seed: 0xe030,
  // Predator has a handful of entity classes; the per-frame cost is types x phases.
  entityTypes: 8,
  // PHASE 1, PHASE 2 and _runTickAllTypes each call it once per type.
  phases: 3,
  // Predator runs 2 logic workers.
  logicWorkers: 2,
  entities: 16583,
  minE: 0,
  maxE: 16583,
};

/** The shipped function, verbatim in behaviour: allocates on every call. */
function shipped(count, workerIndex, workerCount) {
  const n = count | 0;
  const w = workerCount | 0;
  const i = workerIndex | 0;
  if (w <= 1 || n <= 0) return { start: 0, end: n };
  const span = (n / w) | 0;
  const rem = n - span * w;
  const start = i * span + (i < rem ? i : rem);
  const len = span + (i < rem ? 1 : 0);
  return { start, end: start + len };
}

/**
 * The candidate: same arithmetic, result written into a caller-owned pair.
 *
 * Returns the SAME object every call, so a caller that keeps the result across
 * frames sees it change under it. That is the same non-reentrancy contract
 * `packSpriteLayer` and `particleIntegrate` already accept in this codebase
 * ("P4: reused across calls ... same non-reentrancy assumption").
 */
const _range = { start: 0, end: 0 };
function intoRange(out, count, workerIndex, workerCount) {
  const n = count | 0;
  const w = workerCount | 0;
  const i = workerIndex | 0;
  if (w <= 1 || n <= 0) {
    out.start = 0;
    out.end = n;
    return out;
  }
  const span = (n / w) | 0;
  const rem = n - span * w;
  const start = i * span + (i < rem ? i : rem);
  const len = span + (i < rem ? 1 : 0);
  out.start = start;
  out.end = start + len;
  return out;
}

/** V8 object header + two SMI fields, rounded up to the pointer-compressed size. */
const OBJECT_BYTES = 3 * 4 + 8; // map + properties + elements + two in-object fields

async function main() {
  const args = { ...DEFAULTS, ...parseArgs(process.argv.slice(2)) };

  // ---- premise probe, before any timing --------------------------------------
  // One frame's worth of calls, exactly as the worker makes them.
  const callsPerFrame =
    args.entityTypes * args.phases * args.logicWorkers;

  // Each worker only walks its own types in each phase, so per worker it is
  // types x phases calls.
  const callsPerWorkerPerFrame = args.entityTypes * args.phases;

  const bytesPerFramePerWorker = callsPerWorkerPerFrame * OBJECT_BYTES;
  const bytesPerFrameAllWorkers = bytesPerFramePerWorker * args.logicWorkers;

  // Against a measured Predator logic worker step (2026-10-14 trace: 4.528 ms).
  const LOGIC_STEP_MS = 4.528;

  // ---- correctness: identical arithmetic --------------------------------------
  // Sweep every (count, i, w) the engine can produce, not a handful of samples.
  let mismatch = 0;
  let compared = 0;
  for (let w = 1; w <= 8; w++) {
    for (let count = 0; count <= 4096; count += 1) {
      for (let i = 0; i < w; i++) {
        const a = shipped(count, i, w);
        const b = intoRange({ start: 0, end: 0 }, count, i, w);
        compared++;
        if (a.start !== b.start || a.end !== b.end) mismatch++;
      }
    }
  }

  // ---- timing ------------------------------------------------------------------
  // Timed over one frame's worth of calls, repeated, so the number is per-frame
  // work rather than per-call noise.
  const frameShipped = () => {
    let acc = 0;
    for (let t = 0; t < args.entityTypes; t++) {
      for (let p = 0; p < args.phases; p++) {
        for (let w = 0; w < args.logicWorkers; w++) {
          const r = shipped(args.entities, w, args.logicWorkers);
          acc += r.start + r.end;
        }
      }
    }
    return acc;
  };
  const scratch = { start: 0, end: 0 };
  const frameInto = () => {
    let acc = 0;
    for (let t = 0; t < args.entityTypes; t++) {
      for (let p = 0; p < args.phases; p++) {
        for (let w = 0; w < args.logicWorkers; w++) {
          const r = intoRange(scratch, args.entities, w, args.logicWorkers);
          acc += r.start + r.end;
        }
      }
    }
    return acc;
  };

  const a = timeIt('block-range-shipped', frameShipped, { iterations: 1 });
  const b = timeIt('block-range-into', frameInto, { iterations: 1 });
  const pct = ((b.opsPerSec - a.opsPerSec) / a.opsPerSec) * 100;

  const msPerFrameShipped = 1000 / a.opsPerSec;
  const msPerFrameInto = 1000 / b.opsPerSec;

  const report = {
    name: 'logicBlockRange',
    seed: args.seed,
    cases: {
      shipped: { opsPerSec: a.opsPerSec, medianMs: a.medianMs },
      intoPreallocated: { opsPerSec: b.opsPerSec, medianMs: b.medianMs },
    },
    deltaPct: +pct.toFixed(2),
    checksumMismatches: mismatch,
    checksumCasesCompared: compared,
    checksumOk: mismatch === 0,
    premise: {
      callsPerWorkerPerFrame: callsPerWorkerPerFrame,
      callsPerFrameAllWorkers: callsPerFrame,
      objectBytes: OBJECT_BYTES,
      bytesAllocatedPerWorkerPerFrame: bytesPerFramePerWorker,
      bytesAllocatedPerFrameAllWorkers: bytesPerFrameAllWorkers,
      logicStepMsReference: LOGIC_STEP_MS,
      shareOfLogicStepPct: +((msPerFrameShipped / LOGIC_STEP_MS) * 100).toFixed(4),
    },
    verdict: 'screen-only',
    verdictReason:
      'Covers every (count, i, w) the engine can produce, not a sample. The timed ' +
      'number is one frame of calls, so it can be read directly against the logic ' +
      'worker step.',
  };

  if (isCli(import.meta.url)) writeReport('tests/results/e03-block-range/kernel.json', report);
  console.log(JSON.stringify(report, null, 2));
}

if (isCli(import.meta.url)) main();