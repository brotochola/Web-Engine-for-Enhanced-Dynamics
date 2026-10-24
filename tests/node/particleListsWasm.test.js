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

// 12 007 slots: the kernel's 16-slot blocks end in a tail of 7. wasm.particleListsF32 off: the double build.
const base = { n: 12007, frames: 30, burst: 9000, perFrame: 500, f32: false };

test('WASM lists are the JS lists under every camera path', async () => {
  const [js, wasm, listsOnly] = await Promise.all([
    run({ ...base, lists: false, integrate: false }),
    run({ ...base, lists: true, integrate: true }),
    run({ ...base, lists: true, integrate: false }),
  ]);
  assert.equal(js.lists, false, 'both switches off keep the JS lists');
  assert.equal(wasm.lists, true, 'the particle worker bound the WASM lists');
  assert.equal(wasm.listsF32, false, 'wasm.particleListsF32 false binds the double build');
  assert.equal(wasm.integrate, true, 'and the WASM integrate');
  assert.equal(listsOnly.integrate, false, 'wasm.particleIntegrate false keeps the JS integrate');
  assert.ok(js.active > 0 && js.visibleSeen > 0, 'particles are alive and some are visible');
  for (const [name, side] of [['WASM lists and integrate', wasm], ['WASM lists, JS integrate', listsOnly]]) {
    const first = js.sums.findIndex((s, i) => s !== side.sums[i]);
    assert.equal(first, -1, `${name}: the lists or the state differ from frame ${first}`);
  }
});

// The float32 screen test (build_lists_f32x4, the default): its flags may differ from the JS build's only
// within a float32 rounding of the culling box's edge (particleListsF32.test.js holds it to that), so here
// the active list and the particle state the integrate leaves from it must be the JS ones exactly.
test('wasm.particleListsF32 (default on) binds the float32 build: the same active lists and particle state', async (t) => {
  const [js, f32] = await Promise.all([
    run({ ...base, lists: false, integrate: false }),
    run({ ...base, lists: true, integrate: false, f32: undefined }),
  ]);
  assert.equal(f32.listsF32, true, 'the particle worker bound build_lists_f32x4 by default');
  const first = js.activeSums.findIndex((s, i) => s !== f32.activeSums[i]);
  assert.equal(first, -1, `the active list or the particle state differs from frame ${first}`);
  const sameFlags = js.sums.filter((s, i) => s === f32.sums[i]).length;
  t.diagnostic(`${sameFlags} of ${js.sums.length} frames with the JS build's visible list and flags exactly`);
});
