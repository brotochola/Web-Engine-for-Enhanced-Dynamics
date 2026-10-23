import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

// E-80: the particle worker's list build in WASM (the particle memory, wasm.particleLists on) must
// publish exactly the lists the JS build does (plain SABs, both particle switches off), frame after
// frame, under every camera path: none yet, plain, turned and zoomed out. Both lists, every
// isItOnScreen byte and the particle state the integrate leaves from that list are compared. Each
// side boots a real particle worker in its own thread.

function run(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../helpers/particleListsParityWorker.mjs', import.meta.url), { workerData });
    w.once('message', (m) => {
      w.terminate();
      resolve(m);
    });
    w.once('error', reject);
  });
}

// 12 007 slots: the kernel's 16-slot blocks end in a tail of 7.
const base = { n: 12007, frames: 30, burst: 9000, perFrame: 500 };

test('WASM lists are the JS lists under every camera path', async () => {
  const [js, wasm, listsOnly] = await Promise.all([
    run({ ...base, lists: false, integrate: false }),
    run({ ...base, lists: true, integrate: true }),
    run({ ...base, lists: true, integrate: false }),
  ]);
  assert.equal(js.lists, false, 'both switches off keep the JS lists');
  assert.equal(wasm.lists, true, 'the particle worker bound the WASM lists');
  assert.equal(wasm.integrate, true, 'and the WASM integrate');
  assert.equal(listsOnly.integrate, false, 'wasm.particleIntegrate false keeps the JS integrate');
  assert.ok(js.active > 0 && js.visibleSeen > 0, 'particles are alive and some are visible');
  for (const [name, side] of [['WASM lists and integrate', wasm], ['WASM lists, JS integrate', listsOnly]]) {
    const first = js.sums.findIndex((s, i) => s !== side.sums[i]);
    assert.equal(first, -1, `${name}: the lists or the state differ from frame ${first}`);
  }
});
