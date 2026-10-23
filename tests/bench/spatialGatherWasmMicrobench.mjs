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
 *
 * One variant per process: run it through runKernelVariants.mjs, which alternates processes and
 * rejects a variant whose checksum differs. The checksum covers every warm-up frame's rows and
 * counters (45 frames), not only the last.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/spatialGatherWasmMicrobench.mjs --variants base,wasm,ordered --rounds 5
 *   node tests/bench/spatialGatherWasmMicrobench.mjs --variant wasm [--config predator|rebuild] [--output path]
 *
 * predator: Predator's spatial settings (skin 0.01, 30 frames, stagger 15) and drift, 3 workers.
 * rebuild: every list rebuilt every frame (skin 0, stagger 1): the gather's own cost.
 */
import { Grid } from '../../src/core/grid.js';
import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { setupSpatialKernel } from './spatialWorkerMicrobench.mjs';
import { machineState, wasmTier } from './wasmKernelHelpers.mjs';

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const config = String(args.config || 'predator');
  if (!['base', 'wasm', 'ordered'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const spatial = config === 'rebuild' ? { neighborReuseSkin: 0, neighborTickInterval: 1 } : config === 'predator' ? {} : null;
  if (!spatial) throw new Error(`unknown config ${config}`);
  const k = await setupSpatialKernel({
    n: Number(args.n ?? 16500),
    workers: 3,
    spatial: { ...spatial, gatherCellOrder: variant === 'ordered' },
    publishMemory: 'product',
    wasm: { spatialGather: variant !== 'base' },
  });
  if (!k.workers.every((w) => w._wasmPub)) throw new Error('the workers did not bind the WASM publish');
  const gather = k.workers[0]._wasmGather;
  if (Boolean(gather) !== (variant !== 'base')) throw new Error(`variant ${variant}: the gather is ${gather ? 'bound' : 'not bound'}`);

  // 45 frames, as spatialWorkerMicrobench: every entity passes a full rebuild and the stagger twice.
  let checksum = 2166136261;
  for (let f = 0; f < 45; f++) {
    k.frame();
    checksum = Math.imul(checksum ^ k.checksum(), 16777619) >>> 0;
  }
  let pairs = 0;
  for (let i = 0; i < k.n; i++) pairs += Grid.neighborData[i * Grid._stride];
  const cases = {
    frame: timeIt(`spatial frame ${variant} ${config} (${k.workers.length} workers, n=${k.n})`, () => k.frame(), { iterations: 20, warmup: 30 }),
  };
  const report = {
    feature: 'spatial-gather-wasm',
    variant,
    config,
    functions: ['SpatialWorker.findNeighborsForOwnedEntities', 'SpatialWorker._findNeighborsWasmGather', 'spatialGather.gather_batch'],
    n: k.n,
    seed: 0x5a71a1,
    checksum,
    publishedPairs: pairs,
    wasmTier: gather ? wasmTier(gather.gather) : null,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} pairs ${pairs}${gather ? ` tier ${report.wasmTier}` : ''}`);
}

if (isCli(import.meta.url)) await main();
