// Thread for tests/node/visibleListTear.test.js (N-112, N-113): a real particle worker booted on a scene's decoration,
// bullet or particle buffers, as sceneWorkerBootstrap hands them over, that writes the pool's visible list as fast as
// it goes with the camera alternating between two views, until the test sets `stop`: the decorations' screen test
// (updateDecorationScreen), the bullet tick (tickAllBullets, on bullets that stand still) or the particle lists'
// kernel (buildActiveAndVisibleParticleLists, on particles nothing moves). `activeParticles` (N-136) writes the active
// particle list instead: view v makes the particles whose slot has parity v the live ones, so the list changes whole
// every frame. It first posts each view's list as the worker writes it alone, then, on 'go', loops and posts how many
// lists it wrote.
import { parentPort, workerData } from 'node:worker_threads';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { calculateCameraScreenBounds } from '../../src/util/utils.js';
import { initWorker, loadWorker } from '../bench/workerHarness.mjs';

const { kind, config, n, buffers, views, stop } = workerData;
const halt = new Int32Array(stop);
const decorations = kind === 'decorations';
const activeParticles = kind === 'activeParticles';
const particles = kind === 'particles' || activeParticles;
const Component = decorations ? 'DecorationComponent' : particles ? 'ParticleComponent' : 'BulletComponent';

function extra() {
  if (decorations) {
    return {
      maxDecorations: n,
      decorationFreeList: buffers.freeList,
      decorationFreeListTop: buffers.freeListTop,
      activeDecorationsData: buffers.active,
      activeDecorationsLock: buffers.activeLock,
      visibleDecorationsData: buffers.visible,
    };
  }
  if (particles) {
    return {
      maxParticles: n,
      particleFreeList: buffers.freeList,
      particleFreeListTop: buffers.freeListTop,
      activeParticlesData: buffers.active,
      visibleParticlesData: buffers.visible,
      activeParticlesByte: buffers.activeByte,
      visibleParticlesByte: buffers.visibleByte,
      particleMemory: buffers.memory,
      particleLayout: buffers.layout,
    };
  }
  return {
    maxBullets: n,
    bulletFreeList: buffers.freeList,
    bulletFreeListTop: buffers.freeListTop,
    activeBulletsData: buffers.active,
    visibleBulletsData: buffers.visible,
    impactBuffer: buffers.impact,
  };
}

const worker = await loadWorker('particleWorker.js', 'particleWorker');
await initWorker(worker, {
  config,
  globalEntityCount: 16,
  buffers: {
    componentData: { [Component]: buffers.component },
    componentDataByte: { [Component]: buffers.componentByte },
  },
  extra: extra(),
});
// The lists are written once there is a camera; each frame's bounds are set below, as _frameCameraBounds caches them.
worker.cameraData = new Float32Array(16);

/** One frame with view `v`: [x, y, width, height] at zoom 1, no margin. */
function frame(v) {
  const [x, y, w, h] = views[v];
  calculateCameraScreenBounds(1, x, y, w, h, 0, worker._cameraBounds, 0);
  worker._frameCamValid = true;
  if (decorations) {
    worker.refreshActiveDecorationSnapshot();
    worker.updateDecorationScreen();
  } else if (particles) {
    if (activeParticles) {
      const active = ParticleComponent.active;
      for (let k = 0; k < n; k++) active[k] = (k & 1) === v ? 1 : 0;
    }
    worker.buildActiveAndVisibleParticleLists();
  } else {
    worker.tickAllBullets(1000 / 60, 1);
  }
}

/** The list the worker wrote last: its indices as they stand. */
function lastList() {
  const list = decorations
    ? worker.visibleDecorationsData
    : activeParticles
      ? worker.activeParticlesData
      : particles
        ? worker.visibleParticlesData
        : worker.visibleBulletsData;
  return Array.from(list.subarray(1, 1 + list[0]));
}

const expected = views.map((_, v) => {
  frame(v);
  return lastList();
});
parentPort.postMessage({ expected });

parentPort.once('message', () => {
  let frames = 0;
  while (Atomics.load(halt, 0) === 0) {
    frame(frames & 1);
    frames++;
  }
  parentPort.postMessage({ frames });
});
