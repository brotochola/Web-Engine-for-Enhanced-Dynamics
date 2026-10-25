// Thread for tests/node/particlePoolWide.test.js (E-129). Builds a scene's shared buffers for a particle pool of
// `n` slots with createSceneSharedBuffers (particleIntegrateStressScene's particle config; `wasm` the config's wasm
// block), reports what it made (buffer sizes, list and link classes, the particle memory's layout), boots a real
// particle worker on those buffers as sceneWorkerBootstrap hands them over, and runs `frames` frames of the stress
// scene's driver (particleIntegrateDriver.js: a 60 000 burst in seven eases, then 4 000 a frame) under its camera
// (zoom 0.3 over the 4000 x 3000 world): the worker's list build and integrate each frame. Posts what the worker
// bound and what the lists held. Each thread has its own component statics.
import { parentPort, workerData } from 'node:worker_threads';

import { Transform } from '../../src/components/transform.js';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { Camera } from '../../src/core/camera.js';
import { GameObject } from '../../src/core/gameObject.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { Query } from '../../src/core/query.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';
import { particleMemoryBytes } from '../../src/util/particleMemory.js';
import { seededRandom } from '../../src/util/utils.js';
import { emitConfig, PARTICLE_EASES } from '../bench/particleIntegrateWasmMicrobench.mjs';
import { initWorker, loadWorker } from '../bench/workerHarness.mjs';
import { installParticleJs } from '../reference/particleWorkerJs.mjs';

// `js`: the JS integrate and list build the kernels replaced, put on the worker in their place.
const { n, frames = 0, wasm = {}, js = false } = workerData;
const W = 1920;
const H = 1080;

class Driver extends GameObject {}
Driver.components = [];

function buildScene() {
  const log = console.log;
  console.log = () => {};
  try {
    Query.reset();
    const scene = {
      totalEntityCount: 16,
      nextComponentId: 1,
      registeredClasses: [{ class: Driver, count: 16, startIndex: 0, entityType: 0, components: [] }],
      componentPools: { Transform: { ComponentClass: Transform } },
      config: {
        worldWidth: 4000,
        worldHeight: 3000,
        canvasWidth: W,
        canvasHeight: H,
        particle: { maxParticles: n, decals: false },
        decoration: { maxDecorations: 0 },
        bullet: { maxBullets: 0 },
        physics: { maxJoints: 0 },
        spatial: { cellSize: 128, maxNeighbors: 64, maxEntitiesPerCell: 96, rowsPerBlock: 2, numberOfSpatialWorkers: 1 },
        lighting: { enabled: false, maxLights: 10, shadowsEnabled: false, maxFlashes: 0, raycasted: false },
        logic: { staggeredUpdates: false },
        debug: { maxDebugDrawEntries: 1 },
        navigation: { enabled: false },
        renderer: { maxVisibleRenderables: n > 65535 ? n + 16 : 55000 },
        layers: {},
        wasm: { ...WASM_DEFAULTS, ...wasm },
      },
      buffers: { componentData: {} },
      views: {},
      camera: { zoom: 1, x: 0, y: 0 },
      inputBufferSize: 1,
      keyMap: {},
      updateKeyboardBuffer() {},
      preInitializeEntityTypeArrays() {},
      constructor: { queries: [] },
    };
    createSceneSharedBuffers(scene);
    return scene;
  } finally {
    console.log = log;
  }
}

const scene = buildScene();
const b = scene.buffers;
const mem = scene.particleMemory;
const made = {
  freeListBytes: b.particleFreeList.byteLength,
  freeListTopBytes: b.particleFreeListTop.byteLength,
  links: ParticleEmitter.freeList.constructor.name,
  activeListBytes: mem ? null : b.activeParticlesData.byteLength,
  // The particle memory's offsets from its first byte (it is a region of the render-queue memory), and its bytes.
  layout: mem ? relativeLayout(mem.layout) : null,
  bytes: mem ? particleMemoryBytes(n, ParticleComponent.getBufferSize(n)) : 0,
  componentByte: mem ? mem.layout.componentByte : -1,
};

function relativeLayout(layout) {
  const out = {};
  for (const [k, v] of Object.entries(layout)) {
    if (k === 'componentByte') continue;
    out[k] = k === 'slotBytes' ? v : v - layout.componentByte;
  }
  return out;
}

const worker = await loadWorker('particleWorker.js', 'particleWorker');
await initWorker(worker, {
  config: scene.config,
  globalEntityCount: scene.totalEntityCount,
  buffers: {
    componentData: { ParticleComponent: b.componentData.ParticleComponent },
    componentDataByte: { ParticleComponent: b.componentDataByte.ParticleComponent },
  },
  extra: {
    maxParticles: n,
    particleFreeList: b.particleFreeList,
    particleFreeListTop: b.particleFreeListTop,
    activeParticlesData: b.activeParticlesData,
    visibleParticlesData: b.visibleParticlesData,
    activeParticlesByte: b.activeParticlesByte | 0,
    visibleParticlesByte: b.visibleParticlesByte | 0,
    particleMemory: mem ? mem.memory : null,
    particleLayout: mem ? mem.layout : null,
  },
});
if (js) installParticleJs(worker);

const bound = {
  lists: worker._wasmLists ? { slotBytes: worker._wasmLists.slotBytes, f32: worker._wasmLists.f32 } : null,
  integrate: worker._wasmIntegrate ? { slotBytes: worker._wasmIntegrate.slotBytes, f32: worker._wasmIntegrate.f32 } : null,
  activeList: worker.activeParticlesData.constructor.name,
  visibleList: worker.visibleParticlesData.constructor.name,
  indices: worker.activeParticleIndices.constructor.name,
  stamp: worker.particlesToStamp.constructor.name,
  emitBatch: ParticleEmitter._acquireBatch.constructor.name,
};

// The stress scene's camera: zoom 0.3 at the world's centre (Camera.centerOn, Camera.setZoom(0.3)).
const cam = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
Camera.initialize(cam, W, H);
cam[0] = 0.3;
cam[1] = 2000 - W / (2 * 0.3);
cam[2] = 1500 - H / (2 * 0.3);
cam[5] = 0.3;
worker.canvasWidth = W;
worker.canvasHeight = H;
worker.cullingRatio = 0.1;
worker.cameraData = cam;

globalThis.rng = seededRandom(0xc0de1234, 'boot');
const rnd = seededRandom(0x5eed, 'driver');
const warn = console.warn;
let warned = 0;
console.warn = () => {
  warned++;
};
let maxActive = 0;
let maxVisible = 0;
let maxIndex = -1;
let maxVisibleIndex = -1;
let error = null;
try {
  for (let f = 0; f < frames; f++) {
    if (f === 0) {
      for (const ease of PARTICLE_EASES) {
        ParticleEmitter.emit(emitConfig('tween', Math.floor(60000 / PARTICLE_EASES.length), ease, { x: { min: 64, max: 3936 }, y: { min: 64, max: 2936 } }));
      }
    }
    const cx = 64 + rnd() * 3872;
    const cy = 64 + rnd() * 2872;
    ParticleEmitter.emit(emitConfig('tween', 4000, PARTICLE_EASES[f % PARTICLE_EASES.length], { x: { min: cx - 200, max: cx + 200 }, y: { min: cy - 200, max: cy + 200 } }));
    worker._frameCamValid = false;
    worker.buildActiveAndVisibleParticleLists();
    const active = worker.activeParticlesData;
    const visible = worker.visibleParticlesData;
    if (active[0] > maxActive) maxActive = active[0];
    if (visible[0] > maxVisible) maxVisible = visible[0];
    for (let k = 1; k <= active[0]; k++) if (active[k] > maxIndex) maxIndex = active[k];
    for (let k = 1; k <= visible[0]; k++) if (visible[k] > maxVisibleIndex) maxVisibleIndex = visible[k];
    worker.activeParticleCount = worker.updateParticlePhysics(1000 / 60, 1);
  }
} catch (err) {
  error = String(err && err.stack ? err.stack : err);
} finally {
  console.warn = warn;
}
parentPort.postMessage({
  made,
  bound,
  run: {
    maxActive,
    maxVisible,
    maxIndex,
    maxVisibleIndex,
    active: worker.activeParticleCount,
    poolActive: ParticleEmitter.getActiveCount(),
    warned,
    error,
  },
});
