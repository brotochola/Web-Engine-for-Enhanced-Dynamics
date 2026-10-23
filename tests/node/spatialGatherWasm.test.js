import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

// E-78: the spatial candidate gather in WASM (wasm/spatialGather.c, wasm.spatialGather on) must
// publish exactly what the JS gather publishes (wasm.spatialGather off), frame after frame, with
// Predator's reuse settings and drift and with every list rebuilt every frame. Each side runs in
// its own thread: Grid is static state, one setup per thread.

function run(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../helpers/spatialGatherParityWorker.mjs', import.meta.url), { workerData });
    w.once('message', (m) => {
      w.terminate();
      resolve(m);
    });
    w.once('error', reject);
  });
}

const CONFIGS = {
  predator: {},
  rebuild: { neighborReuseSkin: 0, neighborTickInterval: 1 },
};

for (const [name, spatial] of Object.entries(CONFIGS)) {
  test(`WASM gather publishes what the JS gather publishes (${name})`, async () => {
    const base = { spatial, n: 4000, workers: 3, frames: 40 };
    const [js, wasm] = await Promise.all([run({ ...base, gather: false }), run({ ...base, gather: true })]);
    assert.deepEqual(js.bound, [false, false, false], 'wasm.spatialGather false keeps the JS gather');
    assert.deepEqual(wasm.bound, [true, true, true], 'the WASM gather is bound in every spatial worker');
    assert.ok(js.published > 0, 'neighbours are published');
    const first = js.sums.findIndex((s, i) => s !== wasm.sums[i]);
    assert.equal(first, -1, `rows or counters differ from frame ${first}`);
  });
}
