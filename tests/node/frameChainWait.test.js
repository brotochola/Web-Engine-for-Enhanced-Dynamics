import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { resetWaitMeter, waitMeterMs } from '../../src/util/waitMeter.js';
import { loadWorker } from '../bench/workerHarness.mjs';

// E-198: every worker wakes on the vsync together (runFramePhase: within 0.2 ms), so what a stage finds at its frame's
// start is its upstream's output of a vsync earlier, and an input took 3 frames to reach the screen. Pixi now waits for
// pre-render's queue of this vsync and pre-render for physics's pose (physics for every logic worker: weedjsPost's
// waitForLogic), each within a budget (the frame less its own step and room downstream), counted in WAIT_MS; a timeout
// turns the stage's waits off for 120 frames.

const previousSelf = globalThis.self;
const previousPostMessage = globalThis.postMessage;
globalThis.self = globalThis;
globalThis.postMessage = () => {};
await import('../../src/workers/pixiWorker.js');
const PixiRenderer = globalThis.pixiRenderer.constructor;

test.after(() => {
  globalThis.self = previousSelf;
  globalThis.postMessage = previousPostMessage;
});

const PUBLISHER = `
const { workerData, parentPort } = require('node:worker_threads');
const a = new Int32Array(workerData.sab);
const go = new Int32Array(workerData.go);
parentPort.postMessage('ready');
Atomics.wait(go, 0, 0);
// A spin, not a timer: Windows rounds timers to about 15 ms.
const until = performance.now() + workerData.ms;
while (performance.now() < until);
Atomics.store(a, workerData.index, workerData.value);
Atomics.notify(a, workerData.index);
`;

/**
 * A thread that stores `value` at `index` of `sab` `ms` after go(), and notifies. Started and waiting before the stage
 * under test waits (a Node worker takes tens of ms to start).
 */
async function publisher(sab, index, value, ms) {
  const go = new Int32Array(new SharedArrayBuffer(4));
  const w = new Worker(PUBLISHER, { eval: true, workerData: { sab, index, value, ms, go: go.buffer } });
  await new Promise((resolve) => w.once('message', resolve));
  return {
    go() {
      Atomics.store(go, 0, 1);
      Atomics.notify(go, 0);
    },
    stop: () => w.terminate(),
  };
}

function pixi() {
  const r = Object.create(PixiRenderer.prototype);
  r.renderQueueSync = new Int32Array(new SharedArrayBuffer(8));
  r.frameNumber = 10;
  r._queueWaitOffUntil = 0;
  r._queueWaitStepMs = 1;
  r._queueWaitPeriodMs = 40; // a long frame: room for a slow test machine
  r._queueWaitLastStart = NaN;
  return r;
}

test('Pixi waits for the queue pre-render publishes this vsync, and counts the wait', async () => {
  const r = pixi();
  Atomics.store(r.renderQueueSync, 0, 7);
  const p = await publisher(r.renderQueueSync.buffer, 0, 8, 4);
  resetWaitMeter();
  p.go();
  const ready = r._waitForQueue(7);
  await p.stop();
  assert.equal(ready, 8, 'the queue published during the wait');
  assert.ok(waitMeterMs() >= 2, `the wait is in WAIT_MS (${waitMeterMs().toFixed(2)} ms)`);
  assert.equal(r._queueWaitOffUntil, 0, 'not turned off');
});

test('a wait that runs out turns Pixi\'s waits off for 120 frames, and takes no wait while off', () => {
  const r = pixi();
  r._queueWaitStepMs = 34; // a budget of about 5 ms
  Atomics.store(r.renderQueueSync, 0, 7);
  assert.equal(r._waitForQueue(7), 7, 'nothing published');
  assert.equal(r._queueWaitOffUntil, r.frameNumber + 120);
  resetWaitMeter();
  r.frameNumber += 1;
  assert.equal(r._waitForQueue(7), 7);
  assert.equal(waitMeterMs(), 0, 'off: no wait');
});

test('no budget (Pixi\'s own step fills the frame): no wait', () => {
  const r = pixi();
  r._queueWaitStepMs = 39;
  resetWaitMeter();
  assert.equal(r._waitForQueue(0), 0);
  assert.equal(waitMeterMs(), 0);
});

test('pre-render waits for this vsync\'s pose, marking the one out consumed so physics may publish', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  pre.poseSync = new Int32Array(new SharedArrayBuffer(16));
  Atomics.store(pre.poseSync, 0, 5);
  Atomics.store(pre.poseSync, 1, 4); // physics holds its next publish until 5 is consumed
  pre.frameNumber = 3;
  pre._poseWaitLatched = 4;
  pre._poseWaitOffUntil = 0;
  pre._poseWaitStepMs = 1;
  pre._poseWaitPeriodMs = 40; // a long frame: room for a slow test machine
  pre._poseWaitLastStart = NaN;
  const p = await publisher(pre.poseSync.buffer, 0, 6, 1);
  resetWaitMeter();
  p.go();
  pre._waitForPose();
  await p.stop();
  assert.equal(Atomics.load(pre.poseSync, 1), 5, 'the pose out at the start marked consumed');
  assert.equal(Atomics.load(pre.poseSync, 0), 6);
  assert.ok(waitMeterMs() >= 0.5, `the wait is in WAIT_MS (${waitMeterMs().toFixed(2)} ms)`);
  assert.equal(pre._poseWaitOffUntil, 0);
  // Nothing published: the wait runs out and the waits go off.
  pre.frameNumber = 4;
  pre._poseWaitStepMs = 30;
  pre._waitForPose();
  assert.equal(pre._poseWaitOffUntil, 4 + 120);
});
