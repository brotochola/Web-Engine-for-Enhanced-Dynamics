// Worker for tests/node/wasmCoexistence.test.js (E-76 T8). Loads every kernel module through the
// product loader onto the shared memory it is given, waits at the start gate, then runs its jobs
// over and over, so its kernels run while every other worker's kernels run.
import { parentPort, workerData } from 'node:worker_threads';

import { loadWasmKernel } from '../../src/util/wasmKernel.js';

const { memory, gate, modules, jobs, iterations } = workerData;
const kernels = {};
for (const m of modules) kernels[m.name] = await loadWasmKernel(m.name, m.url, memory, m.exports);

const start = new Int32Array(gate);
parentPort.postMessage('ready');
Atomics.wait(start, 0, 0);
for (let i = 0; i < iterations; i++) {
  for (const job of jobs) {
    // A job with a stamp argument (the spatial gather's dedup frame) gets a new one each pass.
    if (job.stampArg !== undefined) job.args[job.stampArg] = i + 1;
    kernels[job.module][job.fn](...job.args);
  }
}
parentPort.postMessage('done');
