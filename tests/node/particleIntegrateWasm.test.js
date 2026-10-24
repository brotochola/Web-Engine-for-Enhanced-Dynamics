import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

// E-79: the particle worker's integrate in WASM (the particle memory, wasm.particleIntegrate on)
// must leave the particle state exactly as the JS integrate does (wasm.particleIntegrate off), frame
// after frame: lifetimes, deaths back to the pool in the same order (later spawns land in the same
// slots), tweens, rotation and tint. Each side boots a real particle worker in its own thread.

function run(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../helpers/particleIntegrateParityWorker.mjs', import.meta.url), { workerData });
    w.once('message', (m) => {
      w.terminate();
      resolve(m);
    });
    w.once('error', reject);
  });
}

for (const mix of ['tween', 'spin']) {
  test(`WASM integrate leaves the particles as the JS integrate does (${mix})`, async () => {
    // wasm.particleIntegrateF32 off: the double integrate.
    const base = { n: 12000, frames: 40, mix, burst: 9000, perFrame: 600, f32: false };
    const [js, wasm] = await Promise.all([run({ ...base, wasm: false }), run({ ...base, wasm: true })]);
    assert.equal(js.bound, false, 'wasm.particleIntegrate false keeps the JS integrate');
    assert.equal(wasm.bound, true, 'the particle worker bound the WASM integrate');
    assert.equal(wasm.f32, false, 'wasm.particleIntegrateF32 false binds integrate_batch');
    assert.ok(js.active > 0, 'particles are alive');
    const first = js.sums.findIndex((s, i) => s !== wasm.sums[i]);
    assert.equal(first, -1, `the particle state differs from frame ${first}`);
  });
}

// The float32 integrate (integrate_batch_f32x4, the default): its floats are held to integrateF32Tolerance by
// particleIntegrateF32.test.js; here the worker binds it and the active count and the free list (every death,
// in order) are the JS integrate's frame for frame.
test('wasm.particleIntegrateF32 (default on) binds the float32 integrate: the same deaths, in order', async () => {
  const base = { n: 12000, frames: 40, mix: 'spin', burst: 9000, perFrame: 600 };
  const [js, f32] = await Promise.all([run({ ...base, wasm: false }), run({ ...base, wasm: true })]);
  assert.equal(f32.f32, true, 'the particle worker bound integrate_batch_f32x4 by default');
  const first = js.counts.findIndex((s, i) => s !== f32.counts[i]);
  assert.equal(first, -1, `the active count or the free list differs from frame ${first}`);
});
