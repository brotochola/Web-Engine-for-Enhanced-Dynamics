import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { createRayCastSab, bindRayCastSab, box2dCastRayClosest, box2dCastRayClosestAsync } from '../../src/box2d/box2dRayCast.js';

// M4. WAIT_MS (E-01) metered only waitUntilDoneSync. Two other blocks on a
// sibling were invisible: a logic worker waiting in the claim loop while
// another worker holds the query slot, and the physics step spinning and
// waiting for the next query of a burst. Both land in STEP_MS untagged.

const meter = () => globalThis.__weedWaitMeter;
const STATUS_IDLE = 0;
const STATUS_PENDING = 1;
const STATUS_DONE = 2;
const STATUS_CLAIMED = 4;

test('a blocked claim counts as wait', async () => {
  const sab = createRayCastSab();
  bindRayCastSab(sab);
  const i32 = new Int32Array(sab);
  Atomics.store(i32, 0, STATUS_CLAIMED); // another worker holds the slot
  // The peer releases the slot after 30 ms, then answers the request at once.
  const peer = new Worker(
    `const { workerData, parentPort } = require('node:worker_threads');
     const i32 = new Int32Array(workerData);
     parentPort.postMessage('up');
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
     Atomics.store(i32, 0, ${STATUS_IDLE});
     Atomics.notify(i32, 0);
     for (;;) {
       const s = Atomics.load(i32, 0);
       if (s === ${STATUS_PENDING}) break;
       Atomics.wait(i32, 0, s, 1);
     }
     Atomics.store(i32, 0, ${STATUS_DONE});
     Atomics.notify(i32, 0);`,
    { eval: true, workerData: sab },
  );
  await new Promise((r) => peer.once('message', r));
  try {
    const before = meter().ms;
    box2dCastRayClosest(0, 0, 10, 0);
    const waited = meter().ms - before;
    assert.ok(waited >= 20, `claim wait not metered: ${waited.toFixed(2)} ms`);
  } finally {
    await peer.terminate();
    bindRayCastSab(null);
  }
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
    // No second query comes: the servicer spins, then waits its 2 ms and ends.
    assert.ok(waited >= 1.5, `burst wait not metered: ${waited.toFixed(2)} ms`);
  } finally {
    bindRayCastSab(null);
  }
});
