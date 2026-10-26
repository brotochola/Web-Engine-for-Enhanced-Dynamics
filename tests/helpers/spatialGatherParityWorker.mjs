// Thread for tests/node/spatialGatherWasm.test.js (E-76 W5). Runs the Predator mix for some frames on real spatial
// workers on the publish memory, with the gather in WASM or the JS search the kernels replaced
// (tests/reference/spatialGather.mjs), and posts every frame's checksum of the neighbour rows and counters. Each
// thread has its own Grid statics. `plain` runs the JS filter too, in place of the publish kernel; `idWidth` 32 runs
// at 32-bit entity ids (W8b); `detailedStats` turns on the WASM publish's recount of neighborsFoundThisFrame (E-02),
// which the JS filter counts inline.
import { parentPort, workerData } from 'node:worker_threads';

import { Grid } from '../../src/core/grid.js';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

const { gather, spatial, n, workers, frames, plain = false, idWidth = 16, detailedStats = false } = workerData;
const k = await setupSpatialKernel({
  n,
  workers,
  spatial,
  idWidth,
  js: gather ? null : { publish: plain ? 'js' : 'kernel' },
});
const publishBound = k.workers.map((w) => !plain && Boolean(w._wasmPub));
if (detailedStats) for (const w of k.workers) w.collectDetailedStats = true;
const bound = k.workers.map((w) => gather && Boolean(w._wasmGather));
const sums = [];
let published = 0;
for (let f = 0; f < frames; f++) {
  k.frame();
  sums.push(k.checksum());
}
for (let i = 0; i < k.n; i++) published += Grid.neighborData[i * Grid._stride];
parentPort.postMessage({ sums, bound, publishBound, published });
