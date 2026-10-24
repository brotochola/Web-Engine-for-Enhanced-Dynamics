#!/usr/bin/env node
/**
 * Kernel (E-78, E-76 W5): the spatial neighbour search with its candidate gather in WASM, against
 * the JS gather, on real workers in WASM mode (the publish memory the scene builds at 16-bit ids,
 * with the grid in it). Both sides are shipped code, chosen by the scene switch:
 *
 *   base  wasm.spatialGather false: findNeighborsForOwnedEntities, the JS gather, the WASM publish
 *   wasm  wasm.spatialGather true (the default): _findNeighborsWasmGather, one gather_batch call
 *         per worker (wasm/spatialGather.c) for every list that rebuilds, the same WASM publish
 *   ordered  wasm with spatial.gatherCellOrder: order_batch_by_cell puts each batch in home-cell
 *         order before the gather (the publish then runs in that order too)
 *   wasm-f32, ordered-f32      wasm (ordered) with gather_batch_f32 (tests/fixtures/wasm/spatialGatherF32.wasm,
 *         from wasm/test/spatialGatherF32.c) in place of gather_batch: the range test in float32
 *   wasm-f32x4, ordered-f32x4  the same with gather_batch_f32x4: that test four ids of a cell a step
 *
 * One variant per process: run it through runKernelVariants.mjs, which alternates processes and
 * rejects a variant whose checksum differs. The checksum covers every warm-up frame's rows and
 * counters (45 frames), not only the last.
 *
 * A float32 gather may keep or drop a candidate on its range edge (tests/bench/spatialGatherTolerance.mjs
 * states the tolerance), and the frames after a flip may differ. So during the 45 checksum frames a float32
 * variant runs in lock step with the shipped gather: each call runs both on the same input, compares the
 * rows, and leaves the shipped rows, so the frames and the checksum are the shipped kernel's when every
 * call was within the tolerance (the comparison's tally is under `tolerance`); when one was not, the
 * checksum has 0x0f32bad xored in and cannot match. Nothing is quantised: a row holds entity ids, so a
 * candidate can only be in or out. The timed frames run the float32 gather alone. Its call site in
 * _findNeighborsWasmGather has seen the lock-step wrapper, the wasm variants' has not (one JS call per
 * worker per frame).
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/spatialGatherWasmMicrobench.mjs --variants base,wasm,ordered --rounds 5
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/spatialGatherWasmMicrobench.mjs --variants wasm,wasm-f32,wasm-f32x4 --rounds 5
 *   node tests/bench/spatialGatherWasmMicrobench.mjs --variant wasm [--config predator|rebuild] [--check] [--output path]
 *
 * predator: Predator's spatial settings (skin 0.01, 30 frames, stagger 15) and drift, 3 workers.
 * rebuild: every list rebuilt every frame (skin 0, stagger 1): the gather's own cost.
 * --check: the checksum frames only, no timing.
 */
import { Grid } from '../../src/core/grid.js';
import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { lockstepGather, loadGatherF32, newGatherStats } from './spatialGatherTolerance.mjs';
import { setupSpatialKernel } from './spatialWorkerMicrobench.mjs';
import { machineState, wasmTier } from './wasmKernelHelpers.mjs';

/** The variants: the gather in WASM or not, the cell order, and the float32 export that replaces gather_batch. */
export const GATHER_VARIANTS = {
  base: { gather: false, ordered: false },
  wasm: { gather: true, ordered: false },
  ordered: { gather: true, ordered: true },
  'wasm-f32': { gather: true, ordered: false, fn: 'gather_batch_f32' },
  'wasm-f32x4': { gather: true, ordered: false, fn: 'gather_batch_f32x4' },
  'ordered-f32': { gather: true, ordered: true, fn: 'gather_batch_f32' },
  'ordered-f32x4': { gather: true, ordered: true, fn: 'gather_batch_f32x4' },
};
/** Xored into a float32 variant's checksum when a call was out of the tolerance. */
const OUT_OF_TOLERANCE = 0x0f32bad;

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const config = String(args.config || 'predator');
  const v = GATHER_VARIANTS[variant];
  if (!v) throw new Error(`unknown variant ${variant} (${Object.keys(GATHER_VARIANTS).join(', ')})`);
  const spatial = config === 'rebuild' ? { neighborReuseSkin: 0, neighborTickInterval: 1 } : config === 'predator' ? {} : null;
  if (!spatial) throw new Error(`unknown config ${config}`);
  const k = await setupSpatialKernel({
    n: Number(args.n ?? 16500),
    workers: 3,
    spatial: { ...spatial, gatherCellOrder: v.ordered },
    publishMemory: 'product',
    wasm: { spatialGather: v.gather },
  });
  if (!k.workers.every((w) => w._wasmPub)) throw new Error('the workers did not bind the WASM publish');
  const gather = k.workers[0]._wasmGather;
  if (Boolean(gather) !== v.gather) throw new Error(`variant ${variant}: the gather is ${gather ? 'bound' : 'not bound'}`);

  // A float32 variant: in lock step with the shipped gather for the checksum frames.
  let fn = null;
  let tolerance = null;
  let restores = [];
  if (v.fn) {
    fn = (await loadGatherF32(k.mem.memory))[v.fn];
    tolerance = newGatherStats();
    restores = k.workers.map((w) => lockstepGather(w, { variant: fn, keep: 'reference', stats: tolerance }));
  }

  // 45 frames, as spatialWorkerMicrobench: every entity passes a full rebuild and the stagger twice.
  let checksum = 2166136261;
  for (let f = 0; f < 45; f++) {
    k.frame();
    checksum = Math.imul(checksum ^ k.checksum(), 16777619) >>> 0;
  }
  if (v.fn) {
    for (const restore of restores) restore();
    for (const w of k.workers) w._wasmGather.gather = fn;
    if (tolerance.unexplained) checksum = (checksum ^ OUT_OF_TOLERANCE) >>> 0;
  }
  let pairs = 0;
  for (let i = 0; i < k.n; i++) pairs += Grid.neighborData[i * Grid._stride];
  if (args.check) {
    console.log(`checksum ${checksum} variant ${variant} ${config} pairs ${pairs}${tolerance ? ` tolerance ${JSON.stringify(tolerance)}` : ''}`);
    return;
  }
  const cases = {
    frame: timeIt(`spatial frame ${variant} ${config} (${k.workers.length} workers, n=${k.n})`, () => k.frame(), { iterations: 20, warmup: 30 }),
  };
  const report = {
    feature: 'spatial-gather-wasm',
    variant,
    config,
    functions: ['SpatialWorker.findNeighborsForOwnedEntities', 'SpatialWorker._findNeighborsWasmGather', v.fn ? `spatialGatherF32.${v.fn}` : 'spatialGather.gather_batch'],
    n: k.n,
    seed: 0x5a71a1,
    checksum,
    tolerance,
    publishedPairs: pairs,
    wasmTier: gather ? wasmTier(gather.gather) : null,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} pairs ${pairs}${gather ? ` tier ${report.wasmTier}` : ''}`);
}

if (isCli(import.meta.url)) await main();
