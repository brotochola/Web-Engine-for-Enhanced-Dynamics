import test from 'node:test';
import assert from 'node:assert/strict';

import { AbstractWorker } from '../../src/workers/AbstractWorker.js';
import {
  RENDER_QUEUE_CAMERA_BYTES,
  RENDER_QUEUE_POSE_READY_OFFSET,
  createRenderQueueCameraViews,
} from '../../src/core/RenderQueueLayout.js';

// Regression: src/box2d/weedjs_post.js (physics-worker writer) and
// AbstractWorker._bindPosePublish (every consumer worker's reader) each keep
// their OWN Float32Array views over the same poseDataA/B SAB (documented in
// AbstractWorker._latchPose's JSDoc: "same SAB"). Pin the canonical 4-channel
// layout (x,y,rotC,rotS @ n*0,4,8,12 floats) on the reader here so a future
// field addition to one side without the other fails fast in Node instead of
// only in a browser benchmark.
function makePoseSab(n) {
  const bytesPerBuf = n * 4 * 4;
  return new SharedArrayBuffer(Math.max(bytesPerBuf, 12));
}

test('_bindPosePublish reads the 4-channel layout (x,y,rotC,rotS)', () => {
  const n = 8;
  const dataA = makePoseSab(n);
  const dataB = makePoseSab(n);
  const sync = new SharedArrayBuffer(8);

  // Write known values at the canonical byte offsets, as if weedjs_post.js's
  // publishPose had run.
  const view = new Float32Array(dataA);
  view[0 * n + 3] = 111; // x[3]
  view[1 * n + 3] = 222; // y[3]
  view[2 * n + 3] = 0.5; // rotC[3]
  view[3 * n + 3] = 0.25; // rotS[3]

  const ctx = {};
  AbstractWorker.prototype._bindPosePublish.call(ctx, { sync, dataA, dataB, capacity: n });

  assert.equal(ctx.poseCapacity, n);
  const buf = ctx.poseBuffers[0];
  assert.equal(buf.x[3], 111);
  assert.equal(buf.y[3], 222);
  assert.equal(buf.rotC[3], 0.5);
  assert.equal(buf.rotS[3], 0.25);
  assert.equal(buf.vx, undefined, 'body pose SAB no longer carries a velocity channel');
});

test('_latchPose gates the previous-frame slot on readyFrame >= 2 (for interpolate blending)', () => {
  const n = 4;
  const dataA = makePoseSab(n);
  const dataB = makePoseSab(n);
  const sync = new SharedArrayBuffer(8);
  const syncView = new Int32Array(sync);

  const ctx = {};
  AbstractWorker.prototype._bindPosePublish.call(ctx, { sync, dataA, dataB, capacity: n });

  // Frame 1: publish into buffer A (writeIdx 0), readyFrame = 1.
  ctx.poseBuffers[0].x[0] = 10;
  Atomics.store(syncView, 0, 1);
  AbstractWorker.prototype._latchPose.call(ctx, false);
  assert.equal(ctx._poseX[0], 10);
  assert.equal(ctx._prevPoseX, null, 'no previous frame yet on readyFrame 1');

  // Frame 2: publish into buffer B (writeIdx 1), readyFrame = 2.
  ctx.poseBuffers[1].x[0] = 20;
  Atomics.store(syncView, 0, 2);
  AbstractWorker.prototype._latchPose.call(ctx, false);
  assert.equal(ctx._poseX[0], 20, 'current pose is the latest published frame');
  assert.equal(ctx._prevPoseX[0], 10, 'previous pose is the prior frame, for interpolate blending');
});

test('_latchPose readyOverride pins that generation even if poseSync moved', () => {
  const n = 4;
  const dataA = makePoseSab(n);
  const dataB = makePoseSab(n);
  const sync = new SharedArrayBuffer(8);
  const syncView = new Int32Array(sync);

  const ctx = {};
  AbstractWorker.prototype._bindPosePublish.call(ctx, { sync, dataA, dataB, capacity: n });

  ctx.poseBuffers[0].x[0] = 10;
  ctx.poseBuffers[1].x[0] = 20;
  Atomics.store(syncView, 0, 2);

  AbstractWorker.prototype._latchPose.call(ctx, false, 1);
  assert.equal(ctx._poseReadyFrame, 1);
  assert.equal(ctx._poseX[0], 10, 'override pins slot N, not live poseSync N+1');
  assert.equal(ctx._prevPoseX, null, 'ready 1 has no previous slot');

  AbstractWorker.prototype._latchPose.call(ctx, false);
  assert.equal(ctx._poseReadyFrame, 2);
  assert.equal(ctx._poseX[0], 20);
});

test('render queue camera SAB is 16 bytes with Int32 poseReady at offset 12', () => {
  assert.equal(RENDER_QUEUE_CAMERA_BYTES, 16);
  assert.equal(RENDER_QUEUE_POSE_READY_OFFSET, 12);
  const sab = new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES);
  const views = createRenderQueueCameraViews(sab);
  views.camera[0] = 1.5;
  views.camera[1] = 10;
  views.camera[2] = 20;
  views.poseReady[0] = 0x1000000;
  assert.equal(views.poseReady[0], 0x1000000, 'poseFrame can pass 2^24');
  assert.equal(views.camera[0], 1.5);
  assert.equal(new Int32Array(sab, RENDER_QUEUE_POSE_READY_OFFSET, 1)[0], 0x1000000);
});
