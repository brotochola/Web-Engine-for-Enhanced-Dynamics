// Thread for tests/node/particleIntegrateWasm.test.js (E-79). Boots a real particle worker with the
// integrate in WASM (the particle memory) or in JS (a plain SAB, wasm.particleIntegrate off), drives
// the stress scene's seeded emits, runs the worker's own updateParticlePhysics each frame and posts
// every frame's checksum of the particle state. Each thread has its own component statics.
import { parentPort, workerData } from 'node:worker_threads';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { buildActiveListBuffers } from '../../src/util/particleIntegrate.js';
import { createParticleMemory } from '../../src/util/particleMemory.js';
import { seededRandom } from '../../src/util/utils.js';
import { checksum, emitConfig, PARTICLE_EASES } from '../bench/particleIntegrateWasmMicrobench.mjs';
import { initWorker, loadWorker } from '../bench/workerHarness.mjs';

const { wasm, n, frames, mix, burst, perFrame } = workerData;
const worker = await loadWorker('particleWorker.js', 'particleWorker');
const componentBytes = ParticleComponent.getBufferSize(n);
const mem = wasm ? createParticleMemory(n, componentBytes) : null;
await initWorker(worker, {
  config: { particle: { maxParticles: n }, wasm: { particleIntegrate: wasm } },
  globalEntityCount: 16,
  buffers: { componentData: { ParticleComponent: mem ? mem.buffer : new SharedArrayBuffer(componentBytes) } },
  extra: {
    maxParticles: n,
    particleFreeList: new SharedArrayBuffer(n * 2),
    particleFreeListTop: new SharedArrayBuffer(8),
    particleMemory: mem ? mem.memory : null,
    particleLayout: mem ? mem.layout : null,
  },
});
ParticleEmitter.resetFreeListInterleaved();
globalThis.rng = seededRandom(0xc0de1234, 'parity');
const rnd = seededRandom(0x5eed, 'driver');
const sums = [];
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
}
parentPort.postMessage({ sums, bound: Boolean(worker._wasmIntegrate), active: worker.activeParticleCount });
