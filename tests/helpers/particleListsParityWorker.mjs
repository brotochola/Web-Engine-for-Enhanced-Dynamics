// Thread for tests/node/particleListsWasm.test.js (E-80). Boots a real particle worker with its
// lists built in WASM (the particle memory) or in JS (plain SABs, both particle switches off),
// drives the stress scene's seeded emits under a camera that changes every few frames (none yet,
// plain, turned, zoomed out), runs the worker's own list build and integrate each frame and posts
// every frame's checksum of both published lists, every isItOnScreen byte and the particle state
// (`sums`), and of the active list and the particle state alone (`activeSums`). `f32` is
// wasm.particleListsF32, left out of the config when undefined (the scene's default). Each thread has
// its own component statics.
import { parentPort, workerData } from 'node:worker_threads';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { Camera } from '../../src/core/camera.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { createParticleMemory } from '../../src/util/particleMemory.js';
import { seededRandom } from '../../src/util/utils.js';
import { checksum, emitConfig, PARTICLE_EASES } from '../bench/particleIntegrateWasmMicrobench.mjs';
import { initWorker, loadWorker } from '../bench/workerHarness.mjs';

const { lists, integrate, f32, n, frames, burst, perFrame } = workerData;
const W = 1280;
const H = 720;
// [zoom, x, y, rotation] for each run of five frames; null: the camera is not ready yet.
const CAMERAS = [null, [1, 1400, 1100, 0], [0.6, 900, 700, 0.785], [0.3, 0, 0, 0], [1.6, 2000, 1500, -2.2], [1, 1400, 1100, 0]];

const worker = await loadWorker('particleWorker.js', 'particleWorker');
const componentBytes = ParticleComponent.getBufferSize(n);
const mem = lists || integrate ? createParticleMemory(n, componentBytes) : null;
const listBuffers = mem
  ? {
      activeParticlesData: mem.buffer,
      visibleParticlesData: mem.buffer,
      activeParticlesByte: mem.layout.activeListByte,
      visibleParticlesByte: mem.layout.visibleListByte,
    }
  : { activeParticlesData: new SharedArrayBuffer((n + 1) * 2), visibleParticlesData: new SharedArrayBuffer((n + 1) * 2) };
await initWorker(worker, {
  config: { particle: { maxParticles: n }, wasm: { particleIntegrate: integrate, particleLists: lists, ...(f32 === undefined ? {} : { particleListsF32: f32 }) } },
  globalEntityCount: 16,
  buffers: { componentData: { ParticleComponent: mem ? mem.buffer : new SharedArrayBuffer(componentBytes) } },
  extra: {
    maxParticles: n,
    particleFreeList: new SharedArrayBuffer(n * 2),
    particleFreeListTop: new SharedArrayBuffer(8),
    particleMemory: mem ? mem.memory : null,
    particleLayout: mem ? mem.layout : null,
    ...listBuffers,
  },
});

function camera(spec) {
  if (!spec) return null;
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  Camera.initialize(data, W, H);
  data[0] = spec[0];
  data[1] = spec[1];
  data[2] = spec[2];
  data[5] = spec[0];
  data[9] = spec[3];
  return data;
}

worker.canvasWidth = W;
worker.canvasHeight = H;
worker.cullingRatio = 0.1;
ParticleEmitter.resetFreeListInterleaved();
globalThis.rng = seededRandom(0xc0de1234, 'parity');
const rnd = seededRandom(0x5eed, 'driver');
const activeData = worker.activeParticlesData;
const visibleData = worker.visibleParticlesData;
const sums = [];
const activeSums = [];
let visibleSeen = 0;
for (let f = 0; f < frames; f++) {
  if (f % 5 === 0) worker.cameraData = camera(CAMERAS[(f / 5) % CAMERAS.length]);
  if (f === 0) {
    for (const ease of PARTICLE_EASES) ParticleEmitter.emit(emitConfig('tween', Math.floor(burst / PARTICLE_EASES.length), ease, { x: { min: 64, max: 3936 }, y: { min: 64, max: 2936 } }));
  }
  const cx = 64 + rnd() * 3872;
  const cy = 64 + rnd() * 2872;
  ParticleEmitter.emit(emitConfig('tween', perFrame, PARTICLE_EASES[f % PARTICLE_EASES.length], { x: { min: cx - 200, max: cx + 200 }, y: { min: cy - 200, max: cy + 200 } }));
  worker._frameCamValid = false;
  worker.buildActiveAndVisibleParticleLists();
  let h = 2166136261;
  const mix = (v) => {
    h = Math.imul(h ^ (v >>> 0), 16777619) >>> 0;
  };
  for (let k = 0, m = 1 + activeData[0]; k < m; k++) mix(activeData[k]);
  let a = h;
  for (let k = 0, m = 1 + visibleData[0]; k < m; k++) mix(visibleData[k]);
  for (let i = 0; i < n; i++) mix(ParticleComponent.isItOnScreen[i]);
  visibleSeen += visibleData[0];
  worker.activeParticleCount = worker.updateParticlePhysics(1000 / 60, 1);
  const state = checksum(worker.activeParticleIndices, worker.activeParticleCount);
  mix(state);
  sums.push(h);
  a = Math.imul(a ^ state, 16777619) >>> 0;
  activeSums.push(a);
}
parentPort.postMessage({
  sums,
  activeSums,
  lists: Boolean(worker._wasmLists),
  listsF32: worker._wasmLists ? worker._wasmLists.f32 : null,
  integrate: Boolean(worker._wasmIntegrate),
  active: worker.activeParticleCount,
  visibleSeen,
});
