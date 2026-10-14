import test from 'node:test';
import assert from 'node:assert/strict';

import { createContactRingSab, drainContactRing } from '../../src/box2d/box2dContactRing.js';
import {
  createContactHitRingSab,
  drainContactHitRing,
} from '../../src/box2d/box2dContactHitRing.js';
import {
  createJointBreakRingSab,
  drainJointBreakRing,
} from '../../src/box2d/box2dJointBreakRing.js';
import { bindBodySyncBuffers, bumpBodyGeneration } from '../../src/box2d/box2dBodySync.js';
import { AbstractWorker } from '../../src/workers/abstractWorker.js';

/**
 * Three small correctness fixes that share one property: each was a silent
 * failure that nothing in the output could reveal.
 *
 * B-08  A `step` message forced isPaused = false and only restored it under
 *       config.manualStep, so stepping a running-but-paused worker left it
 *       running for good.
 * B-11  invalidatePoseSlot returned out of the loop over both pose buffers
 *       instead of continuing. Harmless today because both are allocated with
 *       the same capacity; one line from not being.
 * B-12  The contact-hit and joint-break rings dropped events on overrun
 *       without touching HDR_OVERFLOW, so impacts and broken joints vanished
 *       with no telemetry. The contact ring already did the right thing and is
 *       used here as the reference.
 */

// These rings do NOT share the command ring's header layout. They have no
// HDR_READ: each consumer keeps its own cursor and passes it in. Verified in
// box2dContactRingImpl / box2dContactHitRingImpl / box2dJointBreakRingImpl.
const HDR_WRITE = 0;
const HDR_CAP = 1;
const HDR_OVERFLOW = 2;

function overflowOf(sab) {
  return Atomics.load(new Int32Array(sab), HDR_OVERFLOW);
}
function setWrite(sab, v) {
  Atomics.store(new Int32Array(sab), HDR_WRITE, v);
}

/**
 * Push the write cursor far enough past capacity that a drain from cursor 0
 * overruns. The rings clamp capacity to a minimum of 64, so read it back rather
 * than assuming the value we passed.
 */
function forceOverrun(sab) {
  const cap = Atomics.load(new Int32Array(sab), HDR_CAP);
  assert.ok(cap > 0, 'ring must report a capacity');
  setWrite(sab, cap * 3);
  return cap;
}

test('B-12: the contact ring is the reference: it counts its overruns', { concurrency: false }, () => {
  const sab = createContactRingSab(8);
  forceOverrun(sab);

  // Signature note: drainContactRing(i32, cursor, cb) - three params, no f32.
  const res = drainContactRing(new Int32Array(sab), 0, () => {});
  assert.equal(res.overrun, true);
  assert.equal(overflowOf(sab), 1, 'the contact ring has always counted its overruns');
});

test('B-12: the contact-hit ring counts its overruns', { concurrency: false }, () => {
  const sab = createContactHitRingSab(8);
  forceOverrun(sab);

  // Signature note: drainContactHitRing(i32, f32, cursor, cb) - four params.
  const res = drainContactHitRing(new Int32Array(sab), new Float32Array(sab), 0, () => {});
  assert.equal(res.overrun, true, 'the overrun must still be reported to the caller');
  assert.equal(
    overflowOf(sab),
    1,
    'an overrun drops impacts; without the counter the loss is invisible',
  );
});

test('B-12: the joint-break ring counts its overruns', { concurrency: false }, () => {
  const sab = createJointBreakRingSab(8);
  forceOverrun(sab);

  // Signature note: drainJointBreakRing(i32, cursor, cb) - three params, no f32.
  const res = drainJointBreakRing(new Int32Array(sab), 0, () => {});
  assert.equal(res.overrun, true);
  assert.equal(overflowOf(sab), 1, 'an overrun drops joint breaks; it must be counted');
});

test('B-12: repeated overruns accumulate', { concurrency: false }, () => {
  const sab = createContactHitRingSab(8);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  for (let i = 0; i < 3; i++) {
    forceOverrun(sab);
    const res = drainContactHitRing(i32, f32, 0, () => {});
    assert.equal(res.overrun, true, `overrun ${i} must be reported`);
  }
  assert.equal(overflowOf(sab), 3, 'each lost batch is counted, so the total is meaningful');
});

test('B-12: an empty drain does not count an overrun', { concurrency: false }, () => {
  const sab = createContactHitRingSab(8);
  assert.equal(overflowOf(sab), 0);
  drainContactHitRing(new Int32Array(sab), new Float32Array(sab), 0, () => {});
  assert.equal(overflowOf(sab), 0, 'a clean drain must stay quiet');
});

test('B-11: bumpBodyGeneration invalidates both pose buffers', { concurrency: false }, () => {
  const capacity = 4;
  const poseBytes = capacity * 16;
  const poseA = new SharedArrayBuffer(poseBytes);
  const poseB = new SharedArrayBuffer(poseBytes);

  bindBodySyncBuffers({
    bodyDirtyFlags: new SharedArrayBuffer(capacity * 4),
    bodyDirtyWords: new SharedArrayBuffer(8),
    bodyGeneration: new SharedArrayBuffer(capacity * 4),
    bodyGenEpoch: new SharedArrayBuffer(4),
    poseDataA: poseA,
    poseDataB: poseB,
  });

  const rotCAt = (sab) => new Float32Array(sab, capacity * 8, capacity);
  const rotSAt = (sab) => new Float32Array(sab, capacity * 12, capacity);

  // Publish a live rotation for slot 2 in both buffers, as a prior life would.
  for (const sab of [poseA, poseB]) {
    rotCAt(sab)[2] = 1;
    rotSAt(sab)[2] = 0;
  }

  bumpBodyGeneration(2);

  for (const [name, sab] of [['A', poseA], ['B', poseB]]) {
    assert.equal(rotCAt(sab)[2], 0, `pose ${name} must be invalidated`);
    assert.equal(rotSAt(sab)[2], 0, `pose ${name} rotS must be invalidated`);
  }

  bindBodySyncBuffers(null);
});

test('B-11: a shorter first pose buffer does not skip the longer second', { concurrency: false }, () => {
  const capA = 2;
  const capB = 8;
  const genCap = 8;
  const poseA = new SharedArrayBuffer(capA * 16);
  const poseB = new SharedArrayBuffer(capB * 16);

  bindBodySyncBuffers({
    bodyDirtyFlags: new SharedArrayBuffer(genCap * 4),
    bodyDirtyWords: new SharedArrayBuffer(8),
    bodyGeneration: new SharedArrayBuffer(genCap * 4),
    bodyGenEpoch: new SharedArrayBuffer(4),
    poseDataA: poseA,
    poseDataB: poseB,
  });

  const rotC = new Float32Array(poseB, capB * 8, capB);
  const rotS = new Float32Array(poseB, capB * 12, capB);
  rotC[4] = 1;
  rotS[4] = 0.5;

  // Index 4 exists only in B. A `return` on A's shorter view leaves this set.
  bumpBodyGeneration(4);

  assert.equal(rotC[4], 0, 'the longer buffer must still be invalidated');
  assert.equal(rotS[4], 0, 'rotS on the longer buffer must still be invalidated');

  bindBodySyncBuffers(null);
});

test('B-08: step on a paused non-manualStep worker leaves it paused', { concurrency: false }, () => {
  const posted = [];
  const previousSelf = globalThis.self;
  globalThis.self = { postMessage: (m) => posted.push(m) };

  try {
    let frames = 0;
    // config.manualStep is deliberately false: that is the branch that leaked.
    const ctx = {
      isPaused: true,
      _injectedDeltaTime: 0,
      config: { manualStep: false },
      _runFrame() {
        frames++;
      },
      afterManualStep() {},
    };

    return AbstractWorker.prototype.handleMessage
      .call(ctx, { data: { msg: 'step', deltaTime: 16.67, id: 7 } })
      .then(() => {
        assert.equal(frames, 1, 'exactly one frame ran');
        assert.equal(ctx.isPaused, true, 'the worker must still be paused afterwards');
        assert.equal(ctx._injectedDeltaTime, 0, 'the injected delta is cleared');
        assert.deepEqual(posted, [{ msg: 'stepDone', id: 7 }], 'the waiter is released');
      });
  } finally {
    globalThis.self = previousSelf;
  }
});

test('B-08: step on an unpaused worker leaves it unpaused', { concurrency: false }, () => {
  const previousSelf = globalThis.self;
  globalThis.self = { postMessage: () => {} };

  try {
    let frames = 0;
    const ctx = {
      isPaused: false,
      _injectedDeltaTime: 0,
      config: { manualStep: false },
      _runFrame() {
        frames++;
      },
      afterManualStep() {},
    };

    return AbstractWorker.prototype.handleMessage
      .call(ctx, { data: { msg: 'step', deltaTime: 16.67, id: 1 } })
      .then(() => {
        assert.equal(frames, 1);
        assert.equal(ctx.isPaused, false, 'an unpaused worker must stay unpaused');
      });
  } finally {
    globalThis.self = previousSelf;
  }
});

test('B-08: step on a manualStep worker leaves it paused', { concurrency: false }, () => {
  const previousSelf = globalThis.self;
  globalThis.self = { postMessage: () => {} };

  try {
    let frames = 0;
    const ctx = {
      isPaused: true,
      _injectedDeltaTime: 0,
      config: { manualStep: true },
      _runFrame() {
        frames++;
      },
      afterManualStep() {},
    };

    return AbstractWorker.prototype.handleMessage
      .call(ctx, { data: { msg: 'step', deltaTime: 8, id: 2 } })
      .then(() => {
        assert.equal(frames, 1);
        assert.equal(ctx.isPaused, true, 'manual stepping must still pause after each frame');
      });
  } finally {
    globalThis.self = previousSelf;
  }
});
