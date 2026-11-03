// Thread for tests/node/visibleListTear.test.js (N-112): a real particle worker booted on a scene's decoration or
// bullet buffers, as sceneWorkerBootstrap hands them over, that writes the pool's visible list as fast as it goes
// with the camera alternating between two views, until the test sets `stop`: the decorations' screen test
// (updateDecorationScreen) or the bullet tick (tickAllBullets, on bullets that stand still). It first posts each
// view's list as the worker writes it alone, then, on 'go', loops and posts how many lists it wrote.
import { parentPort, workerData } from 'node:worker_threads';

import { calculateCameraScreenBounds } from '../../src/util/utils.js';
import { initWorker, loadWorker } from '../bench/workerHarness.mjs';

const { kind, config, n, buffers, views, stop } = workerData;
const halt = new Int32Array(stop);
const decorations = kind === 'decorations';
const Component = decorations ? 'DecorationComponent' : 'BulletComponent';

const worker = await loadWorker('particleWorker.js', 'particleWorker');
await initWorker(worker, {
  config,
  globalEntityCount: 16,
  buffers: {
    componentData: { [Component]: buffers.component },
    componentDataByte: { [Component]: buffers.componentByte },
  },
  extra: decorations
    ? {
        maxDecorations: n,
        decorationFreeList: buffers.freeList,
        decorationFreeListTop: buffers.freeListTop,
        activeDecorationsData: buffers.active,
        activeDecorationsLock: buffers.activeLock,
        visibleDecorationsData: buffers.visible,
      }
    : {
        maxBullets: n,
        bulletFreeList: buffers.freeList,
        bulletFreeListTop: buffers.freeListTop,
        activeBulletsData: buffers.active,
        visibleBulletsData: buffers.visible,
        impactBuffer: buffers.impact,
      },
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
  } else {
    worker.tickAllBullets(1000 / 60, 1);
  }
}

/** The list the worker wrote last: its indices as they stand. */
function lastList() {
  const list = decorations ? worker.visibleDecorationsData : worker.visibleBulletsData;
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
