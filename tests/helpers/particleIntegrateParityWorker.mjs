// Thread for tests/node/particleIntegrateWasm.test.js (E-79). Boots a real particle worker with the
// integrate in WASM (the particle memory) or in JS (a plain SAB, wasm.particleIntegrate off), drives
// the stress scene's seeded emits, runs the worker's own updateParticlePhysics each frame and posts
// every frame's checksum of the particle state (`sums`) and its active count and free-list hash (`counts`).
// `f32` is wasm.particleIntegrateF32, left out of the config when undefined (the scene's default). Each
// thread has its own component statics.
import { parentPort, workerData } from 'node:worker_threads';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { buildActiveListBuffers } from '../../src/util/particleIntegrate.js';
import { createParticleMemory } from '../../src/util/particleMemory.js';
import { poolFreeListTopBytes, poolSlotBytes } from '../../src/util/poolSlotWidth.js';
import { seededRandom } from '../../src/util/utils.js';
import { checksum, emitConfig, PARTICLE_EASES } from '../bench/particleIntegrateWasmMicrobench.mjs';
import { initWorker, loadWorker } from '../bench/workerHarness.mjs';

const { wasm, f32, n, frames, mix, burst, perFrame } = workerData;
const worker = await loadWorker('particleWorker.js', 'particleWorker');
const componentBytes = ParticleComponent.getBufferSize(n);
const mem = wasm ? createParticleMemory(n, componentBytes) : null;
await initWorker(worker, {
  config: { particle: { maxParticles: n }, wasm: { particleIntegrate: wasm, ...(f32 === undefined ? {} : { particleIntegrateF32: f32 }) } },
  globalEntityCount: 16,
  buffers: { componentData: { ParticleComponent: mem ? mem.buffer : new SharedArrayBuffer(componentBytes) } },
  extra: {
    maxParticles: n,
    // E-129: FL4 buffers past 65 535 particles.
    particleFreeList: new SharedArrayBuffer(n * poolSlotBytes(n)),
    particleFreeListTop: new SharedArrayBuffer(poolFreeListTopBytes(n)),
    particleMemory: mem ? mem.memory : null,
    particleLayout: mem ? mem.layout : null,
  },
});
ParticleEmitter.resetFreeListInterleaved();
globalThis.rng = seededRandom(0xc0de1234, 'parity');
const rnd = seededRandom(0x5eed, 'driver');
const sums = [];
const counts = [];
for (let f = 0; f < frames; f++) {
  if (f === 0) {
    for (const ease of PARTICLE_EASES) ParticleEmitter.emit(emitConfig(mix, Math.floor(burst / PARTICLE_EASES.length), ease, { x: { min: 64, max: 3936 }, y: { min: 64, max: 2936 } }));
  }
  const cx = 64 + rnd() * 3872;
  const cy = 64 + rnd() * 2872;
  ParticleEmitter.emit(emitConfig(mix, perFrame, PARTICLE_EASES[f % PARTICLE_EASES.length], { x: { min: cx - 200, max: cx + 200 }, y: { min: cy - 200, max: cy + 200 } }));
  worker.activeParticleCount = buildActiveListBuffers(n, ParticleComponent.active, worker.activeParticleIndices, null, n);
  worker.activeParticleCount = worker.updateParticlePhysics(1000 / 60, 1);
  sums.push(checksum(worker.activeParticleIndices, worker.activeParticleCount));
  let h = worker.activeParticleCount;
  for (let k = 0; k < n; k++) h = Math.imul(h ^ ParticleEmitter.freeList[k], 16777619) >>> 0;
  counts.push(h ^ ParticleEmitter.freeListTop[0]);
}
parentPort.postMessage({
  sums,
  counts,
  bound: Boolean(worker._wasmIntegrate),
  f32: worker._wasmIntegrate ? worker._wasmIntegrate.f32 : null,
  slotBytes: worker._wasmIntegrate ? worker._wasmIntegrate.slotBytes : null,
  maxIndex: worker.activeParticleIndices.subarray(0, worker.activeParticleCount).reduce((m, i) => (i > m ? i : m), -1),
  active: worker.activeParticleCount,
});
