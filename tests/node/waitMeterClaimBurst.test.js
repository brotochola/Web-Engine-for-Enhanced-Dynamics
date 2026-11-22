import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { createRayCastSab, bindRayCastSab, box2dCastRayClosest, box2dCastRayClosestAsync } from '../../src/box2d/box2dRayCast.js';
import { waitedUntil, wallMs } from '../helpers/wallClockWait.mjs';

// M4. WAIT_MS (E-01) metered only waitUntilDoneSync. Two other blocks on a
// sibling were invisible: a logic worker waiting in the claim loop while
// another worker holds the query slot, and the physics step spinning and
// waiting for the next query of a burst. Both land in STEP_MS untagged.

const meter = () => globalThis.__weedWaitMeter;
const STATUS_IDLE = 0;
const STATUS_PENDING = 1;
const STATUS_DONE = 2;
const STATUS_CLAIMED = 4;

/**
 * One try: a peer holds the slot until a wall-clock time given ahead (N-400, as N-326's frame chain tests), then
 * answers the request. Before, it held the slot 30 ms from its own start, and on the ASUS's 2 cores under the suite's
 * parallel files this thread sometimes reached the call after the slot was free (nothing to meter).
 */
async function claimTry(holdMs) {
  const sab = createRayCastSab();
  bindRayCastSab(sab);
  const i32 = new Int32Array(sab);
  Atomics.store(i32, 0, STATUS_CLAIMED); // another worker holds the slot
  const clock = new SharedArrayBuffer(16); // [0] Int32 go flag, [1] Float64 the release time
  const peer = new Worker(
    `const { workerData, parentPort } = require('node:worker_threads');
     const i32 = new Int32Array(workerData.sab);
     const go = new Int32Array(workerData.clock, 0, 1);
     const at = new Float64Array(workerData.clock, 8, 1);
     const wallMs = () => performance.timeOrigin + performance.now();
     const nap = new Int32Array(new SharedArrayBuffer(4));
     parentPort.postMessage('up');
     Atomics.wait(go, 0, 0);
     for (let left = at[0] - wallMs(); left > 0; left = at[0] - wallMs()) Atomics.wait(nap, 0, 0, left);
     Atomics.store(i32, 0, ${STATUS_IDLE});
     Atomics.notify(i32, 0);
     for (;;) {
       const s = Atomics.load(i32, 0);
       if (s === ${STATUS_PENDING}) break;
       Atomics.wait(i32, 0, s, 1);
     }
     Atomics.store(i32, 0, ${STATUS_DONE});
     Atomics.notify(i32, 0);`,
    { eval: true, workerData: { sab, clock } },
  );
  await new Promise((r) => peer.once('message', r));
  try {
    const at = wallMs() + holdMs;
    new Float64Array(clock, 8, 1)[0] = at;
    const go = new Int32Array(clock, 0, 1);
    Atomics.store(go, 0, 1);
    Atomics.notify(go, 0);
    const begun = wallMs();
    const before = meter().ms;
    box2dCastRayClosest(0, 0, 10, 0);
    const waited = meter().ms - before;
    return { at, begun, waited };
  } finally {
    await peer.terminate();
    bindRayCastSab(null);
  }
}

test('a blocked claim counts as wait', async () => {
  // A try counts when this thread reached the call before the release; it must then meter the wait up to it.
  for (let t = 0; t < 5; t++) {
    const { at, begun, waited } = await claimTry(30);
    if (!(begun < at)) continue;
    assert.ok(waitedUntil(at, begun, waited), `claim wait not metered: ${waited.toFixed(2)} ms of ${(at - begun).toFixed(2)}`);
    return;
  }
  assert.fail('in 5 tries this thread never reached the claim before the peer released it');
});

test('the burst servicer waiting for the next query counts as wait', async () => {
  const sab = createRayCastSab();
  bindRayCastSab(sab);
  try {
    const pending = box2dCastRayClosestAsync(0, 0, 10, 0);
    await new Promise((r) => setImmediate(r)); // let the async claim write the request
    const before = meter().ms;
    const served = globalThis.Box2dRayCast.servicePendingRayCastBurst(() => ({ hit: false }), 4);
    const waited = meter().ms - before;
    await pending; // settle the client before any assertion can unbind the SAB
    assert.equal(served, 1);
    // No second query comes: the servicer spins for one, metered, and ends.
    // Since E-56 there is no timed wait after the spin: a later query is the
    // physics host's wake's to answer, not the step's.
    assert.ok(waited > 0, `burst wait not metered: ${waited.toFixed(3)} ms`);
    assert.ok(waited < 50, `the burst waited ${waited.toFixed(2)} ms for a query that never came`);
  } finally {
    bindRayCastSab(null);
  }
});
