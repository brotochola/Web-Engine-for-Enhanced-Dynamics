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
    const [js, wasm, ordered] = await Promise.all([
      run({ ...base, gather: false }),
      run({ ...base, gather: true }),
      // spatial.gatherCellOrder: the batch in home-cell order gathers and publishes the same rows.
      run({ ...base, spatial: { ...spatial, gatherCellOrder: true }, gather: true }),
    ]);
    assert.deepEqual(js.bound, [false, false, false], 'wasm.spatialGather false keeps the JS gather');
    assert.deepEqual(wasm.bound, [true, true, true], 'the WASM gather is bound in every spatial worker');
    assert.ok(js.published > 0, 'neighbours are published');
    const first = js.sums.findIndex((s, i) => s !== wasm.sums[i]);
    assert.equal(first, -1, `rows or counters differ from frame ${first}`);
    const firstOrdered = js.sums.findIndex((s, i) => s !== ordered.sums[i]);
    assert.equal(firstOrdered, -1, `in cell order, rows or counters differ from frame ${firstOrdered}`);
  });
}

// W8b: past 65 535 entities the ids are 32-bit and the publish and the gather take the kernels' _u32 exports.
// Against the plain buffers' JS publish and gather, frame after frame, with ids above the 16-bit range in
// every row. Detailed stats on: the JS publish counts the neighbours it finds, the WASM one only then (E-02).
test('at 32-bit ids the WASM publish and gather publish what the JS path publishes', async () => {
  const base = {
    spatial: { maxNeighbors: 64, neighborReuseSkin: 0, neighborTickInterval: 1 },
    n: 70000,
    workers: 3,
    frames: 6,
    idWidth: 32,
    detailedStats: true,
  };
  const [js, publish, gather, ordered] = await Promise.all([
    run({ ...base, plain: true, gather: false }),
    run({ ...base, gather: false }),
    run({ ...base, gather: true }),
    run({ ...base, spatial: { ...base.spatial, gatherCellOrder: true }, gather: true }),
  ]);
  assert.deepEqual(js.publishBound, [false, false, false], 'the plain buffers keep the JS publish');
  assert.deepEqual(publish.publishBound, [true, true, true], 'the WASM publish is bound at 32-bit ids');
  assert.deepEqual(gather.bound, [true, true, true], 'the WASM gather is bound at 32-bit ids');
  assert.ok(js.published > 0, 'neighbours are published');
  for (const [name, r] of [['publish', publish], ['gather', gather], ['cell order', ordered]]) {
    const first = js.sums.findIndex((s, i) => s !== r.sums[i]);
    assert.equal(first, -1, `${name}: rows or counters differ from frame ${first}`);
  }
});
