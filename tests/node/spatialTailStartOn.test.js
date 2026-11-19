import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { resetWaitMeter, waitMeterMs } from '../../src/util/waitMeter.js';
import { bindFrameClock, createFrameClockBuffer, frameClockSlot, stampStep } from '../../src/util/frameClock.js';
import { SPATIAL_DEFAULTS } from '../../src/util/configDefaults.js';
import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

// E-328 (spatial.startOn 'logicDone'): a spatial worker's frame waits for the logic workers' frame of this vsync, asleep
// on the frame chain's bell ([2], rung by each logic worker at its frame's end after it adds one to [0]), so its search
// runs while logic leaves the cores free. It counts the logic workers already done from the frame clock's stamps, waits
// within the frame less its own step, starts on the vsync when its step would not fit after logic's, and four waits in
// a row that run out turn the waits off for 120 frames.

const wallMs = () => performance.timeOrigin + performance.now();

// A thread that plays logic's frame ends at wall-clock times it is given (each: [0] += 1, [2] += 1, notify [2]), given 2
// ms ahead: a hand-off between threads here can take over a millisecond.
const LOGIC_ENDS = `
const { workerData, parentPort } = require('node:worker_threads');
const chain = new Int32Array(workerData.chain);
const at = new Float64Array(workerData.at);
parentPort.postMessage('ready');
while (!(at[0] > 0));
for (let k = 0; k < at.length && at[k] > 0; k++) {
  while (performance.timeOrigin + performance.now() < at[k]);
  Atomics.add(chain, 0, 1);
  Atomics.add(chain, 2, 1);
  Atomics.notify(chain, 2);
}
`;

async function logicEnds(chain) {
  const at = new Float64Array(new SharedArrayBuffer(8 * 4));
  const w = new Worker(LOGIC_ENDS, { eval: true, workerData: { chain: chain.buffer, at: at.buffer } });
  await new Promise((resolve) => w.once('message', resolve));
  return {
    /** Frame ends `ms[k]` after the call returns (it returns 2 ms after it was made). */
    endIn(...ms) {
      const d = wallMs() + 2;
      for (let k = ms.length - 1; k >= 0; k--) at[k] = d + ms[k];
      while (wallMs() < d);
    },
    stop: () => w.terminate(),
  };
}

/**
 * A spatial worker at a frame's start, waiting on logic: `logic` logic workers whose last steps began `ago` ms before
 * now (each its own; stampLogic again just before the frame when a thread is started in between), a vsync period
 * `period` and an own step `own` (ms).
 */
function spatialAt(w, { logic = 2, ago = [], period = 40, own = 2 } = {}) {
  const chain = new Int32Array(new SharedArrayBuffer(16));
  w._frameChain = chain;
  w._frameClock = bindFrameClock(createFrameClockBuffer());
  stampLogic(w, ago);
  w._startOnLogicDone = true;
  w._logicWorkers = logic;
  w._logicWaitPeriodMs = period;
  w._logicWaitOwnMs = own;
  w._logicWaitLastStart = NaN; // no gap sample: the averages stay as set
  w._logicWaitMisses = 0;
  w._logicWaitOffUntil = 0;
  w._injectedDeltaTime = 0;
  w.frameNumber = 10;
  return chain;
}

/** The logic workers' last finished steps, begun `ago` ms before now (each its own) and 0.5 ms long. */
function stampLogic(w, ago) {
  const now = wallMs();
  for (let i = 0; i < ago.length; i++) stampStep(w._frameClock, frameClockSlot('logic', i), now - ago[i], now - ago[i] + 0.5);
}

test('a logicDone frame sleeps on the bell until every logic worker has ended its frame, and counts the wait', async () => {
  const w = await loadWorker('spatialWorker.js', 'spatialWorker');
  // A loaded machine may run the thread late: a few tries.
  let chain = null;
  let waited = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    // Both logic workers' last steps began a vsync ago (40 ms): neither has done this vsync's frame.
    chain = spatialAt(w, { ago: [40, 40] });
    const ends = await logicEnds(chain);
    resetWaitMeter();
    ends.endIn(3, 6);
    w.beforeUpdate();
    await ends.stop();
    waited = waitMeterMs();
    if (Atomics.load(chain, 0) === 2 && waited < 20) break;
  }
  assert.equal(Atomics.load(chain, 0), 2, 'both frame ends came during the wait');
  assert.ok(waited >= 5, `the first end alone does not end it (${waited.toFixed(2)} ms)`);
  assert.ok(waited < 20, `the second end does, within the budget (${waited.toFixed(2)} ms)`);
  assert.equal(w._logicWaitMs, waited, 'the wait is kept, to take it out of the next own step');
  assert.equal(w._logicWaitMisses, 0);
  assert.equal(w._logicWaitOffUntil, 0);
});

test('logic workers already done with this vsync\'s frame are not waited for, even when the frame began late', async () => {
  const w = await loadWorker('spatialWorker.js', 'spatialWorker');
  // Both began 1 ms ago and ended: done.
  spatialAt(w, { ago: [1, 1] });
  resetWaitMeter();
  w.beforeUpdate();
  assert.equal(waitMeterMs(), 0, 'both done: no wait');
  // This frame began 9 ms after the vsync (kept off the cores), both logic steps at the vsync and done.
  spatialAt(w, { ago: [9, 9.1], period: 16.67, own: 4 });
  resetWaitMeter();
  w.beforeUpdate();
  assert.equal(waitMeterMs(), 0, 'a late frame finds logic\'s frame of this vsync done');
  // One done (began 1 ms ago), one still on the last vsync's step: one frame end ends the wait.
  let chain = null;
  let waited = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    chain = spatialAt(w, { ago: [1, 40] });
    const ends = await logicEnds(chain);
    stampLogic(w, [1, 40]); // the thread took tens of ms to start
    resetWaitMeter();
    ends.endIn(3);
    w.beforeUpdate();
    await ends.stop();
    waited = waitMeterMs();
    if (Atomics.load(chain, 0) === 1 && waited < 20) break;
  }
  assert.equal(Atomics.load(chain, 0), 1);
  assert.ok(waited >= 2 && waited < 20, `one end ended it (${waited.toFixed(2)} ms)`);
  assert.equal(w._logicWaitMisses, 0);
});

test('no wait when the own step would not fit after logic, in lockstep, without the chain, or with startOn vsync', async () => {
  const w = await loadWorker('spatialWorker.js', 'spatialWorker');
  spatialAt(w, { ago: [40, 40], period: 16.67, own: 15.8 }); // budget 16.67 - 15.8 - 1 < 1 ms
  resetWaitMeter();
  w.beforeUpdate();
  assert.equal(waitMeterMs(), 0, 'a step that does not fit starts on the vsync');
  spatialAt(w, { ago: [40, 40] });
  w._injectedDeltaTime = 16.67; // a { msg: 'step' } frame
  resetWaitMeter();
  w.beforeUpdate();
  assert.equal(waitMeterMs(), 0, 'lockstep');
  spatialAt(w, { ago: [40, 40] });
  w._frameChain = null;
  resetWaitMeter();
  w.beforeUpdate();
  assert.equal(waitMeterMs(), 0, 'no chain');
  spatialAt(w, { ago: [40, 40] });
  w._startOnLogicDone = false;
  resetWaitMeter();
  w.beforeUpdate();
  assert.equal(waitMeterMs(), 0, "startOn 'vsync'");
});

test('four waits in a row that run out turn the waits off for 120 frames', async () => {
  const w = await loadWorker('spatialWorker.js', 'spatialWorker');
  // Nothing rings; a 1.5 ms budget (Windows may sleep a timed-out wait to its timer period, about 15 ms).
  spatialAt(w, { ago: [40, 40], period: 16.67, own: 14.17 });
  for (let k = 0; k < 3; k++) {
    w._logicWaitLastStart = NaN;
    resetWaitMeter();
    w.beforeUpdate();
    assert.ok(waitMeterMs() >= 1, `miss ${k + 1} waited its budget (${waitMeterMs().toFixed(2)} ms)`);
    assert.equal(w._logicWaitMisses, k + 1);
    assert.equal(w._logicWaitOffUntil, 0, `miss ${k + 1}: still on`);
    w.frameNumber++;
  }
  w._logicWaitLastStart = NaN;
  w.beforeUpdate();
  assert.equal(w._logicWaitOffUntil, w.frameNumber + 120, 'the fourth miss in a row');
  assert.equal(w._logicWaitMisses, 0);
  w.frameNumber++;
  w._logicWaitLastStart = NaN;
  resetWaitMeter();
  w.beforeUpdate();
  assert.equal(waitMeterMs(), 0, 'off: no wait');
});

test('the vsync period and the own step are moving averages of the frames (a skipped vsync counts as two)', async () => {
  const w = await loadWorker('spatialWorker.js', 'spatialWorker');
  spatialAt(w, { ago: [1, 1], period: 16.67, own: 5 });
  w._logicWaitLastStart = performance.now() - 33.3; // the last frame began two vsyncs ago
  w.stepTimeThisFrame = 9; // its step, of which 2 ms waited
  w._logicWaitMs = 2;
  w.beforeUpdate();
  assert.ok(Math.abs(w._logicWaitPeriodMs - 16.67) < 0.1, `period ${w._logicWaitPeriodMs}`);
  assert.ok(Math.abs(w._logicWaitOwnMs - (5 * 0.9 + 7 * 0.1)) < 1e-9, `own ${w._logicWaitOwnMs}`);
  assert.equal(w._logicWaitMs, 0, 'no wait this frame (both done)');
});

test('spatial.startOn defaults to vsync; an array sets each worker; a timer-paced logic or no logic workers never wait', async () => {
  assert.equal(SPATIAL_DEFAULTS.startOn, 'vsync');
  const k = await setupSpatialKernel({ n: 400, workers: 2, spatial: { startOn: ['vsync', 'logicDone'] } });
  const [w0, w1] = k.workers;
  for (const w of k.workers) {
    w.config.logic = { numberOfLogicWorkers: 2 };
    w._setupStartOn();
  }
  assert.equal(w0._startOnLogicDone, false, 'worker 0: vsync');
  assert.equal(w1._startOnLogicDone, true, 'worker 1: logicDone');
  assert.equal(w1._logicWorkers, 2);
  w1.config.spatial = { ...w1.config.spatial, startOn: 'logicDone' };
  w1.config.logic = { numberOfLogicWorkers: 2, noLimitFPS: true };
  w1._setupStartOn();
  assert.equal(w1._startOnLogicDone, false, 'logic paced by a timer');
  w1.config.logic = { numberOfLogicWorkers: 0 };
  w1._setupStartOn();
  assert.equal(w1._startOnLogicDone, false, 'no logic workers');
  const warned = [];
  const warn = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    w1.config.spatial = { ...w1.config.spatial, startOn: 'logic' };
    w1.config.logic = { numberOfLogicWorkers: 2 };
    await quietly(() => w1._setupStartOn());
  } finally {
    console.warn = warn;
  }
  assert.equal(w1._startOnLogicDone, false);
  assert.ok(warned.some((m) => m.includes('spatial.startOn')), 'an unknown value is named');
});
