import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { resetWaitMeter, waitMeterMs } from '../../src/util/waitMeter.js';
import { loadWorker } from '../bench/workerHarness.mjs';
import { wallMs, waitedUntil } from '../helpers/wallClockWait.mjs';

// E-198: every worker wakes on the vsync together (runFramePhase: within 0.2 ms), so what a stage finds at its frame's
// start is its upstream's output of a vsync earlier, and an input took 3 frames to reach the screen. Pixi now waits for
// pre-render's queue of this vsync and pre-render for physics's pose (physics for every logic worker: weedjsPost's
// waitForLogic), each within a budget (the frame less its own step and room downstream), counted in WAIT_MS; a timeout
// turns the stage's waits off for 120 frames. E-219: logic waits for main's frame of this vsync (its inputs in).

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

// A thread that stores `value` at `index` at a wall-clock time it is given, and notifies. The time is given 2 ms
// ahead: a hand-off between threads here can take over a millisecond, longer than logic's sub-ms budget. Each test
// reads its tries against that time (N-326, waitedUntil): a loaded machine runs either thread late.
const AT_PUBLISHER = `
const { workerData, parentPort } = require('node:worker_threads');
const a = new Int32Array(workerData.sab);
const at = new Float64Array(workerData.at);
parentPort.postMessage('ready');
while (!(at[0] > 0));
while (performance.timeOrigin + performance.now() < at[0]);
Atomics.store(a, workerData.index, workerData.value);
Atomics.notify(a, workerData.index);
`;

async function publisherAt(sab, index, value) {
  const at = new Float64Array(new SharedArrayBuffer(8));
  const w = new Worker(AT_PUBLISHER, { eval: true, workerData: { sab, index, value, at: at.buffer } });
  await new Promise((resolve) => w.once('message', resolve));
  return {
    /** The store `ms` after the call returns, which itself returns 2 ms after it was made; returns the store's time. */
    publishIn(ms) {
      const d = wallMs() + 2;
      at[0] = d + ms;
      while (wallMs() < d);
      return d + ms;
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
  let r = null;
  let ready = 0;
  let waited = 0;
  let untilPublish = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    r = pixi();
    Atomics.store(r.renderQueueSync, 0, 7);
    const p = await publisherAt(r.renderQueueSync.buffer, 0, 8);
    resetWaitMeter();
    const at = p.publishIn(4);
    const begun = wallMs();
    ready = r._waitForQueue(7);
    await p.stop();
    waited = waitMeterMs();
    untilPublish = waitedUntil(at, begun, waited);
    if (ready === 8 && untilPublish) break;
  }
  assert.equal(ready, 8, 'the queue published during the wait');
  assert.ok(untilPublish, `the wait is in WAIT_MS (${waited.toFixed(2)} ms)`);
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
  let waited = 0;
  let untilPublish = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    pre.poseSync = new Int32Array(new SharedArrayBuffer(16));
    Atomics.store(pre.poseSync, 0, 5);
    Atomics.store(pre.poseSync, 1, 4); // physics holds its next publish until 5 is consumed
    pre.frameNumber = 3;
    pre._poseWaitLatched = 4;
    pre._poseWaitOffUntil = 0;
    pre._poseWaitStepMs = 1;
    pre._poseWaitPeriodMs = 40; // a long frame: room for a slow test machine
    pre._poseWaitLastStart = NaN;
    const p = await publisherAt(pre.poseSync.buffer, 0, 6);
    resetWaitMeter();
    // 4 ms of room within a budget of about 39: this thread must begin the wait before the publish for the try to count.
    const at = p.publishIn(4);
    const begun = wallMs();
    pre._waitForPose();
    await p.stop();
    waited = waitMeterMs();
    untilPublish = waitedUntil(at, begun, waited);
    if (Atomics.load(pre.poseSync, 1) === 5 && Atomics.load(pre.poseSync, 0) === 6 && untilPublish) break;
  }
  assert.equal(Atomics.load(pre.poseSync, 1), 5, 'the pose out at the start marked consumed');
  assert.equal(Atomics.load(pre.poseSync, 0), 6);
  assert.ok(untilPublish, `the wait is in WAIT_MS (${waited.toFixed(2)} ms)`);
  assert.equal(pre._poseWaitOffUntil, 0);
  // Nothing published: the wait runs out and the waits go off.
  pre.frameNumber = 4;
  pre._poseWaitStepMs = 30;
  pre._waitForPose();
  assert.equal(pre._poseWaitOffUntil, 4 + 120);
});

/**
 * Logic at a frame's start, main's last animation frame `mainAgo` ms ago (a frame of the 40 ms period below: this
 * vsync's is not out yet).
 */
function logicAt(w, gen, mainAgo = 40) {
  w._frameChain = new Int32Array(new SharedArrayBuffer(16));
  Atomics.store(w._frameChain, 1, gen);
  w._frameClock = { f64: new Float64Array([wallMs() - mainAgo]) };
  w._inputWait = true;
  w._inputWaitOffUntil = 0;
  w._inputWaitMisses = 0;
  w._inputWaitPeriodMs = 40; // a long frame: the budget is its cap, 0.95 ms
  w._inputWaitLastStart = NaN;
  w._injectedDeltaTime = 0;
  w.frameNumber = 10;
  return w._frameChain;
}

test('logic waits for main\'s frame of this vsync before it reads inputs, and counts the wait', async () => {
  const w = await loadWorker('logicWorker.js', 'logicWorker');
  // A loaded machine may run the publisher late (past logic's 0.95 ms budget), or keep this thread off a core until
  // main's frame is already out (no wait at all): a few tries, each read against the publish's time (N-326,
  // waitedUntil; each a miss at most, and logicAt clears the misses, so the waits stay on). N-406: 24 tries, as 8 all
  // missed on the ASUS's 2 cores beside a browser job; a try that lands ends the loop, so they cost only on such a machine.
  let chain = null;
  let waited = 0;
  let untilPublish = false;
  for (let attempt = 0; attempt < 24; attempt++) {
    chain = logicAt(w, 7);
    const p = await publisherAt(chain.buffer, 1, 8);
    resetWaitMeter();
    const at = p.publishIn(0.3);
    const begun = wallMs();
    w.beforeUpdate();
    await p.stop();
    waited = waitMeterMs();
    untilPublish = waitedUntil(at, begun, waited);
    if (Atomics.load(chain, 1) === 8 && untilPublish && waited < 0.95) break;
  }
  assert.equal(Atomics.load(chain, 1), 8, 'main\'s frame published during the wait');
  assert.ok(untilPublish, `the wait is in WAIT_MS (${waited.toFixed(2)} ms)`);
  assert.ok(waited < 0.95, 'within the budget');
  assert.equal(w._inputWaitOffUntil, 0, 'not turned off');
  // Main's frame of this vsync out before this frame began (its animation frame 0.2 ms earlier): no wait.
  logicAt(w, 9, 0.2);
  resetWaitMeter();
  w.beforeUpdate();
  assert.equal(waitMeterMs(), 0);
});

test('four waits in a row that run out turn logic\'s waits off for 120 frames; lockstep frames never wait', async () => {
  const w = await loadWorker('logicWorker.js', 'logicWorker');
  logicAt(w, 7);
  // A miss costs about its 0.95 ms budget, not Windows's timer period (about 15 ms). Load only stretches a miss, so
  // the cheapest of the three is read (N-326: one ran over 2 ms under the suite's parallel files): a wait that slept to
  // the timer period would cost 10 ms or more every time.
  const misses = [];
  for (let k = 0; k < 3; k++) {
    resetWaitMeter();
    w.beforeUpdate();
    misses.push(waitMeterMs());
    assert.equal(w._inputWaitOffUntil, 0, `miss ${k + 1}: still on`);
    w.frameNumber++;
  }
  assert.ok(Math.min(...misses) < 3, `a miss costs under a millisecond, not Windows's timer period (${misses.map((m) => m.toFixed(2)).join(', ')} ms)`);
  w.beforeUpdate();
  assert.equal(w._inputWaitOffUntil, w.frameNumber + 120, 'the fourth miss in a row');
  resetWaitMeter();
  w.frameNumber++;
  w.beforeUpdate();
  assert.equal(waitMeterMs(), 0, 'off: no wait');

  logicAt(w, 7);
  w._injectedDeltaTime = 16.67; // a { msg: 'step' } frame
  resetWaitMeter();
  w.beforeUpdate();
  assert.equal(waitMeterMs(), 0);
  assert.equal(w._inputWaitOffUntil, 0);

  logicAt(w, 7);
  w._frameClock = null; // no frame clock: no wait
  resetWaitMeter();
  w.beforeUpdate();
  assert.equal(waitMeterMs(), 0);
});
