// Thread for tests/node/visibleListTear.test.js (N-112): a real particle worker booted on a scene's decoration
// buffers, as sceneWorkerBootstrap hands them over, whose screen test (updateDecorationScreen) runs as fast as it
// goes with the camera alternating between two views, until the test sets `stop`. It first posts each view's
// visible list as the worker writes it alone, then, on 'go', loops and posts how many frames it wrote.
import { parentPort, workerData } from 'node:worker_threads';

import { calculateCameraScreenBounds } from '../../src/util/utils.js';
import { initWorker, loadWorker } from '../bench/workerHarness.mjs';

const { config, n, buffers, views, stop } = workerData;
const halt = new Int32Array(stop);

const worker = await loadWorker('particleWorker.js', 'particleWorker');
await initWorker(worker, {
  config,
  globalEntityCount: 16,
  buffers: {
    componentData: { DecorationComponent: buffers.decorationComponent },
    componentDataByte: { DecorationComponent: buffers.decorationComponentByte },
  },
  extra: {
    maxDecorations: n,
    decorationFreeList: buffers.decorationFreeList,
    decorationFreeListTop: buffers.decorationFreeListTop,
    activeDecorationsData: buffers.activeDecorationsData,
    activeDecorationsLock: buffers.activeDecorationsLock,
    visibleDecorationsData: buffers.visibleDecorationsData,
  },
});
// The screen test runs once there is a camera; each frame's bounds are set below, as _frameCameraBounds caches them.
worker.cameraData = new Float32Array(16);

/** One frame of the screen test with view `v`: [x, y, width, height] at zoom 1, no margin. */
function frame(v) {
  const [x, y, w, h] = views[v];
  calculateCameraScreenBounds(1, x, y, w, h, 0, worker._cameraBounds, 0);
  worker._frameCamValid = true;
  worker.refreshActiveDecorationSnapshot();
  worker.updateDecorationScreen();
}

/** The list the worker wrote last: [count, index …] as it stands. */
function lastList() {
  const list = worker.visibleDecorationsData;
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
