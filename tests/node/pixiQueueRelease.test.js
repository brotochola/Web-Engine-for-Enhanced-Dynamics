import test from 'node:test';
import assert from 'node:assert/strict';

import { GpuFramePacer } from '../../src/render/gpuFramePacer.js';

// pixiWorker.js registers its instance on `self` rather than exporting it, and
// it reads `self` at module scope. Stub first, import, then read the prototype.
const previousSelf = globalThis.self;
const previousPostMessage = globalThis.postMessage;
globalThis.self = globalThis;
globalThis.postMessage = () => {};
await import('../../src/workers/pixiWorker.js');
const PixiRenderer = globalThis.pixiRenderer.constructor;

/**
 * B-01. `PixiRenderer.update` acquires a render queue frame in
 * `consumeNextRenderQueue` (it sets `_deferredRenderQueueRelease`) and releases
 * it in `releaseRenderQueueIfHeld`. An early `return` between the two skipped
 * the `finally`, so `Atomics.store(renderQueueSync, 1, frame)` never ran.
 * `preRenderWorker.pixiIsMoreThanOneFrameBehind` then saw the renderer as
 * permanently two frames behind and skipped every subsequent frame.
 *
 * The invariant under test is the one that matters, not the fix shape:
 *   after update() returns, any consumed frame must have been released, i.e.
 *   Atomics.load(renderQueueSync, 1) === lastReadFrame.
 */

test.after(() => {
  globalThis.self = previousSelf;
  globalThis.postMessage = previousPostMessage;
});

function makeSync() {
  const sab = new SharedArrayBuffer(8);
  const sync = new Int32Array(sab);
  Atomics.store(sync, 0, 0); // [0] readyFrame (pre-render publishes)
  Atomics.store(sync, 1, 0); // [1] consumedFrame (renderer releases)
  return sync;
}

/**
 * Minimal worker context. Only the handful of members `update()` and
 * `consumeNextRenderQueue()` touch are stubbed; the two methods under test are
 * the real ones taken off the prototype.
 */
function makeContext({ sync, gpuLive, presenting = true, backpressure = true }) {
  return {
    renderQueueSync: sync,
    collectDetailedStats: false,
    queueTimeThisFrame: 0,
    presentTimeThisFrame: 0,
    lastReadFrame: 0,
    _queueBackpressure: backpressure,
    _queueInterp: false,
    _queueInterpSnapshot: false,
    _customLayerList: [],
    _presenting: presenting,
    _deferredRenderQueueRelease: 0,
    renderQueueX: null,
    renderQueueY: null,
    renderQueueCount: null,
    renderQueueCamera: null,
    renderQueuePoseReady: null,
    _newQueueThisFrame: 0,
    _latchedPrevX: null,
    _latchedPrevY: null,
    _latchedPrevCount: 0,
    _renderZoom: 1,
    _renderCameraX: 0,
    _renderCameraY: 0,
    _cameraInitialized: false,
    _poseSnap: false,
    _gpuClockStart: 0,
    _injectedDeltaTime: 0,
    _framePacer: new GpuFramePacer(),
    _pacedTick: false,
    _gpuLive: () => gpuLive,
    presentationIsActive() {
      return true;
    },
    _stopGpuClock() {},
    rememberDeltaTime() {},
    _setReadBuffer() {},
    _latchPose() {},
    _snapshotComputePose() {},
    _notePosePublish() {},
  };
}

// The three methods under test come from the real prototype, not from a stub.
function withRealMethods(ctx) {
  const P = PixiRenderer.prototype;
  for (const name of ['consumeNextRenderQueue', 'releaseRenderQueueIfHeld', 'gpuIsAvailable']) {
    assert.equal(typeof P[name], 'function', `${name} must exist on PixiRenderer.prototype`);
    ctx[name] = P[name];
  }
  return ctx;
}

function update(ctx) {
  withRealMethods(ctx);
  PixiRenderer.prototype.update.call(ctx, 16.67, 1, false);
}

test('B-01: a queue frame consumed while the GPU is unavailable is still released', { concurrency: false }, () => {
  const sync = makeSync();
  Atomics.store(sync, 0, 1); // pre-render published frame 1
  const ctx = makeContext({ sync, gpuLive: false });

  update(ctx);

  assert.equal(
    Atomics.load(sync, 1),
    ctx.lastReadFrame,
    'renderQueueSync[1] must be released to the last frame update() consumed',
  );
});

test('B-01: release happens on the normal (GPU available) path too', { concurrency: false }, () => {
  const sync = makeSync();
  Atomics.store(sync, 0, 1);
  const ctx = makeContext({ sync, gpuLive: true });
  // Stub the draw passes so update() reaches its finally without a GPU.
  ctx.tickInterpolatedPose = () => {};
  ctx.ensureCameraBeforeFirstFrame = () => {};
  ctx.updateCameraTransform = () => {};
  ctx.updateGpuParticleLayers = () => {};
  ctx.syncLayerAlphaFromSharedState = () => {};
  ctx.updateDecalTiles = () => {};
  ctx.shouldDrawFrameLockedPasses = () => false;
  ctx.applyLayerVisibility = () => {};
  ctx.presentStage = () => {};

  update(ctx);

  assert.equal(ctx.lastReadFrame, 1, 'frame 1 should have been consumed');
  assert.equal(Atomics.load(sync, 1), 1, 'the consumed frame must be released');
});

test('B-01: nothing is released when no frame is ready', { concurrency: false }, () => {
  const sync = makeSync();
  Atomics.store(sync, 0, 0); // nothing published
  const ctx = makeContext({ sync, gpuLive: false });

  update(ctx);

  assert.equal(ctx.lastReadFrame, 0);
  assert.equal(Atomics.load(sync, 1), 0, 'must not release a frame that was never consumed');
});

test('B-01: not presenting releases immediately inside consumeNextRenderQueue', { concurrency: false }, () => {
  const sync = makeSync();
  Atomics.store(sync, 0, 1);
  // gpuLive must be true here: after the B-01 fix an unavailable GPU returns
  // before the consume, so the not-presenting branch is only reachable with a
  // live GPU.
  const ctx = makeContext({ sync, gpuLive: true, presenting: false });
  ctx.tickInterpolatedPose = () => {};
  ctx.ensureCameraBeforeFirstFrame = () => {};
  ctx.updateCameraTransform = () => {};
  ctx.updateGpuParticleLayers = () => {};
  ctx.syncLayerAlphaFromSharedState = () => {};
  ctx.updateDecalTiles = () => {};
  ctx.shouldDrawFrameLockedPasses = () => false;
  ctx.applyLayerVisibility = () => {};
  ctx.presentStage = () => {};

  update(ctx);

  assert.equal(ctx.lastReadFrame, 1, 'frame 1 should have been consumed');
  assert.equal(Atomics.load(sync, 1), 1, 'the non-presenting path stores the release directly');
});

test('B-01: an unavailable GPU takes no queue at all', { concurrency: false }, () => {
  const sync = makeSync();
  Atomics.store(sync, 0, 1);
  const ctx = makeContext({ sync, gpuLive: false });

  update(ctx);

  assert.equal(ctx.lastReadFrame, 0, 'no queue is consumed while the GPU is unavailable');
  assert.equal(Atomics.load(sync, 1), 0, 'and so nothing is released or stranded');
  assert.equal(ctx._deferredRenderQueueRelease, 0, 'no frame is held');
});

test('B-01: catch-up after an outage walks forward one frame at a time', { concurrency: false }, () => {
  const sync = makeSync();
  Atomics.store(sync, 0, 1);
  const ctx = makeContext({ sync, gpuLive: true });
  const drawStubs = () => {
    ctx.tickInterpolatedPose = () => {};
    ctx.ensureCameraBeforeFirstFrame = () => {};
    ctx.updateCameraTransform = () => {};
    ctx.updateGpuParticleLayers = () => {};
    ctx.syncLayerAlphaFromSharedState = () => {};
    ctx.updateDecalTiles = () => {};
    ctx.shouldDrawFrameLockedPasses = () => false;
    ctx.applyLayerVisibility = () => {};
    ctx.presentStage = () => {};
  };
  drawStubs();

  // Normal frame: consume 1.
  update(ctx);
  assert.equal(ctx.lastReadFrame, 1);

  // GPU drops. pre-render manages to publish 2 and 3 before it sees the lag.
  ctx._gpuLive = () => false;
  Atomics.store(sync, 0, 3);
  update(ctx);
  assert.equal(ctx.lastReadFrame, 1, 'no queue taken during the outage');
  assert.equal(Atomics.load(sync, 1), 1, 'nothing stranded during the outage');

  // GPU returns. Backpressure must walk us forward one frame at a time.
  ctx._gpuLive = () => true;
  update(ctx);
  assert.equal(ctx.lastReadFrame, 2, 'backpressure clamps the catch-up to one frame');
  assert.equal(Atomics.load(sync, 1), 2, 'and that frame is released');

  update(ctx);
  assert.equal(ctx.lastReadFrame, 3, 'the next frame follows on the next tick');
  assert.equal(Atomics.load(sync, 1), 3);
});

// E-97. A fake WebGL2 context whose fences stay unsignaled until the test says so.
function busyGl() {
  return {
    SYNC_STATUS: 0x9114,
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    fences: [],
    fenceSync() {
      const f = { done: false };
      this.fences.push(f);
      return f;
    },
    getSyncParameter(f) {
      return f.done ? 0x9119 : 0x9118;
    },
    deleteSync() {},
  };
}

function drawableContext(sync) {
  const ctx = makeContext({ sync, gpuLive: true });
  ctx.tickInterpolatedPose = () => {};
  ctx.ensureCameraBeforeFirstFrame = () => {};
  ctx.updateCameraTransform = () => {};
  ctx.updateGpuParticleLayers = () => {};
  ctx.syncLayerAlphaFromSharedState = () => {};
  ctx.updateDecalTiles = () => {};
  ctx.shouldDrawFrameLockedPasses = () => false;
  ctx.applyLayerVisibility = () => {};
  ctx.presents = 0;
  ctx.presentStage = () => { ctx.presents++; };
  return ctx;
}

test('E-97: a paced tick takes no queue and strands nothing; the next free tick takes it', { concurrency: false }, () => {
  const sync = makeSync();
  const ctx = drawableContext(sync);
  const gl = busyGl();
  ctx._framePacer.bindGl(gl);

  Atomics.store(sync, 0, 1);
  update(ctx);
  Atomics.store(sync, 0, 2);
  update(ctx);
  assert.equal(ctx.presents, 2, 'two frames in flight');
  assert.equal(ctx.lastReadFrame, 2);

  Atomics.store(sync, 0, 3);
  update(ctx); // frame 1 still on the GPU
  assert.equal(ctx._pacedTick, true);
  assert.equal(ctx.presents, 2, 'nothing submitted');
  assert.equal(ctx.lastReadFrame, 2, 'queue 3 is not taken');
  assert.equal(Atomics.load(sync, 1), 2, 'and nothing is held');
  assert.equal(ctx._deferredRenderQueueRelease, 0);

  gl.fences[0].done = true;
  update(ctx);
  assert.equal(ctx._pacedTick, false);
  assert.equal(ctx.presents, 3);
  assert.equal(ctx.lastReadFrame, 3);
  assert.equal(Atomics.load(sync, 1), 3);
});

test('E-97: a lockstep step draws while the GPU is busy', { concurrency: false }, () => {
  const sync = makeSync();
  const ctx = drawableContext(sync);
  ctx._framePacer.bindGl(busyGl());
  for (let f = 1; f <= 4; f++) {
    Atomics.store(sync, 0, f);
    ctx._injectedDeltaTime = 16.67;
    update(ctx);
  }
  assert.equal(ctx.presents, 4);
  assert.equal(ctx.lastReadFrame, 4);
});

test('E-97: a paced tick publishes no stats', { concurrency: false }, () => {
  const r = globalThis.pixiRenderer;
  const stats = new Float32Array(64).fill(-1);
  const prevStats = r.stats;
  r.stats = stats;
  try {
    r._pacedTick = true;
    r.reportFPS();
    assert.ok(stats.every((v) => v === -1), 'a paced tick wrote a stat');
  } finally {
    r._pacedTick = false;
    r.stats = prevStats;
  }
});
