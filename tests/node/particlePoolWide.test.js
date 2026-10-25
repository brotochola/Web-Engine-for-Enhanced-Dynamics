// E-129: the particle pool sizes its slot ids from particle.maxParticles. Each case builds a scene's shared
// buffers with createSceneSharedBuffers and boots a real particle worker on them (tests/helpers/
// particlePoolBootWorker.mjs, a thread each):
// - at 65 535 particles the scene makes the 16-bit layout it always made: the free list's Uint16 links and 8-byte
//   head, the particle memory's regions at the offsets the 16-bit formulas give (written out below as they were);
//   the worker binds the 16-bit kernels and Uint16 lists, and the JS integrate and lists the kernels replaced
//   (tests/reference) run on them too;
// - at 200 000 particles (particleIntegrateStressScene?maxParticles=200000's pool): FL4 links, u32 lists, the
//   _u32 kernels (float32 by default), and the stress scene's driver fills the pool within 40 frames; the lists
//   hold slots past 65 535 and particles are drawn from them;
// - past MAX_POOL_SLOTS the scene refuses the pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { PARTICLE_LUT_ENTRIES } from '../../src/util/particleMemory.js';
import { MAX_POOL_SLOTS } from '../../src/util/poolSlotWidth.js';
import { CACHE_LINE_BYTES, layoutRegions } from '../../src/util/wasmMemoryMap.js';

function boot(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../helpers/particlePoolBootWorker.mjs', import.meta.url), { workerData });
    w.once('message', (m) => {
      w.terminate();
      resolve(m);
    });
    w.once('error', reject);
  });
}

/** The particle memory's layout as the 16-bit code laid it out (wasmMemoryMap.js before E-129), for n slots. */
function oldLayout(n) {
  const map = layoutRegions([
    { name: 'component', owner: '', bytes: ParticleComponent.getBufferSize(n) },
    { name: 'activeList', owner: '', bytes: (n + 2) * 2 },
    { name: 'visibleList', owner: '', bytes: (n + 2) * 2 },
    { name: 'stamp', owner: '', bytes: n * 2 },
    { name: 'flat', owner: '', bytes: 65536 * 2 },
    { name: 'heighted', owner: '', bytes: 65536 * 2 },
    { name: 'dead', owner: '', bytes: n * 2 },
    { name: 'trig', owner: '', bytes: n * 2 },
    { name: 'trigAngle', owner: '', bytes: n * 8 },
    { name: 'luts', owner: '', bytes: 3 * PARTICLE_LUT_ENTRIES * 4 },
    { name: 'columns', owner: '', bytes: CACHE_LINE_BYTES * 4 },
    { name: 'results', owner: '', bytes: 16 },
  ]);
  const r = map.regions;
  return {
    pages: map.pages,
    layout: {
      activeListByte: r.activeList.byte,
      visibleListByte: r.visibleList.byte,
      slotBytes: 2,
      indicesByte: r.activeList.byte + 2,
      stampByte: r.stamp.byte,
      flatByte: r.flat.byte,
      heightedByte: r.heighted.byte,
      deadByte: r.dead.byte,
      trigByte: r.trig.byte,
      trigAngleByte: r.trigAngle.byte,
      lutByte: r.luts.byte,
      columnsByte: r.columns.byte,
      resultsByte: r.results.byte,
    },
  };
}

test('at 65 535 particles the scene and the worker bind the 16-bit layout they always had', async () => {
  const n = 65535;
  const [wasm, js] = await Promise.all([boot({ n }), boot({ n, js: true })]);
  const old = oldLayout(n);
  assert.equal(wasm.made.freeListBytes, n * 2, 'Uint16 links');
  assert.equal(wasm.made.freeListTopBytes, 8, 'an 8-byte head');
  assert.equal(wasm.made.links, 'Uint16Array');
  assert.deepEqual(wasm.made.layout, old.layout, 'the particle memory at the 16-bit offsets');
  assert.equal(wasm.made.pages, old.pages, 'and of the same size');
  assert.deepEqual(wasm.bound.lists, { slotBytes: 2, f32: true }, 'the 16-bit list builds');
  assert.deepEqual(wasm.bound.integrate, { slotBytes: 2, f32: true }, 'the 16-bit integrate');
  for (const key of ['activeList', 'visibleList', 'indices', 'stamp']) assert.equal(wasm.bound[key], 'Uint16Array', key);
  assert.equal(wasm.bound.emitBatch, 'Uint16Array');
  for (const key of ['activeList', 'visibleList', 'indices', 'stamp']) assert.equal(js.bound[key], 'Uint16Array', key);
});

test('a 200 000-particle pool boots with 32-bit slot ids and the stress driver fills it', async (t) => {
  const n = 200000;
  const [wasm, js] = await Promise.all([boot({ n, frames: 40 }), boot({ n, frames: 40, js: true })]);
  assert.equal(wasm.made.freeListBytes, n * 4, 'Uint32 links');
  assert.equal(wasm.made.freeListTopBytes, 16, 'the FL4 head');
  assert.equal(wasm.made.links, 'Uint32Array');
  assert.equal(wasm.made.layout.slotBytes, 4);
  assert.equal(wasm.made.layout.indicesByte, wasm.made.layout.activeListByte + 4);
  assert.deepEqual(wasm.bound.lists, { slotBytes: 4, f32: true }, 'the _u32 list builds, float32');
  assert.deepEqual(wasm.bound.integrate, { slotBytes: 4, f32: true }, 'the _u32 integrate, float32');
  for (const side of [wasm, js]) {
    for (const key of ['activeList', 'visibleList', 'indices', 'stamp']) assert.equal(side.bound[key], 'Uint32Array', key);
    assert.equal(side.bound.emitBatch, 'Uint32Array');
    assert.equal(side.run.error, null);
    assert.ok(side.run.maxActive >= n - 4000, `the pool fills (${side.run.maxActive} live)`);
    assert.ok(side.run.maxIndex > 65535 && side.run.maxVisibleIndex > 65535, `slots up to ${side.run.maxIndex} live, ${side.run.maxVisibleIndex} drawn`);
    assert.ok(side.run.maxVisible > 1000, `${side.run.maxVisible} in view`);
    assert.equal(side.run.active, side.run.poolActive, 'the integrate and the free list agree on the live count');
  }
  t.diagnostic(`WASM: ${wasm.run.maxActive} live at most, ${wasm.run.maxVisible} in view; JS: ${js.run.maxActive}, ${js.run.maxVisible}`);
});

test('the scene refuses a particle pool past MAX_POOL_SLOTS', async () => {
  await assert.rejects(boot({ n: MAX_POOL_SLOTS + 1 }), /particle\.maxParticles must be an integer in \[0, 524287\]/);
});
