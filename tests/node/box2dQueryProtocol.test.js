import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import {
  createQueryAabbSab,
  bindQueryAabbSab,
  box2dQueryAABBAsync,
  servicePendingQuery,
} from '../../src/box2d/box2dQueryAabb.js';
import { createRayCastSab, bindRayCastSab, servicePendingRayCast } from '../../src/box2d/box2dRayCast.js';

// Review N-21. Box2D QueryAABB and closest-ray had no round-trip test since
// queryAabbBurst.test.js went (f68a182e); overlapCircle, castRayAll and the
// LiquidFun queries have theirs. A worker thread is the logic side here: the
// sync calls block in Atomics.wait, which the main thread cannot do.

const STATUS_IDLE = 0;
const STATUS_PENDING = 1;
const BOX2D_DIR = new URL('../../src/box2d/', import.meta.url).href;

function inWorker(sab, body) {
  const worker = new Worker(
    `const { workerData, parentPort } = require('node:worker_threads');
     (async () => { const base = workerData.base; ${body} })().then(
       (r) => parentPort.postMessage({ ok: true, r }),
       (e) => parentPort.postMessage({ ok: false, e: String((e && e.message) || e) }),
     );`,
    { eval: true, workerData: { sab, base: BOX2D_DIR } },
  );
  const reply = new Promise((resolve) => worker.once('message', resolve));
  return { worker, reply };
}

async function serviceWhenPending(service, fn) {
  for (let i = 0; i < 5000; i++) {
    const r = service(fn);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 1));
  }
  throw new Error('no request arrived');
}

test('queryAABB: a worker gets the ids physics wrote, with its box and filter', async () => {
  const sab = createQueryAabbSab();
  bindQueryAabbSab(sab);
  const { worker, reply } = inWorker(
    sab,
    `const m = await import(base + 'box2dQueryAabb.js');
     m.bindQueryAabbSab(workerData.sab);
     const out = new Int32Array(4);
     const count = m.box2dQueryAABB(1, 2, 3, 4, out, { categoryBits: 2, maskBits: 6 });
     return { count, out: Array.from(out) };`,
  );
  try {
    let args = null;
    await serviceWhenPending(servicePendingQuery, (...a) => {
      args = a.slice(0, 6);
      const results = a[6];
      results[0] = 7;
      results[1] = 8;
      results[2] = 9;
      return 3;
    });
    const msg = await reply;
    assert.ok(msg.ok, msg.e);
    assert.deepEqual(args, [1, 2, 3, 4, 2, 6]);
    assert.deepEqual(msg.r, { count: 3, out: [7, 8, 9, 0] });
    assert.equal(Atomics.load(new Int32Array(sab), 0), STATUS_IDLE);
  } finally {
    await worker.terminate();
    bindQueryAabbSab(null);
  }
});

test('queryAABB: a count above the result capacity is published as the capacity', () => {
  const sab = createQueryAabbSab(64);
  bindQueryAabbSab(sab);
  try {
    const i32 = new Int32Array(sab);
    Atomics.store(i32, 0, STATUS_PENDING);
    servicePendingQuery((x0, y0, x1, y1, cat, mask, results, cap) => {
      for (let i = 0; i < cap; i++) results[i] = i;
      return 100;
    });
    // Only 64 slots hold ids; a caller with a longer `out` must not read past them.
    assert.equal(Atomics.load(i32, 1), 64);
  } finally {
    bindQueryAabbSab(null);
  }
});

test('queryAABB: a physics error rejects the caller and frees the slot', async () => {
  const sab = createQueryAabbSab();
  bindQueryAabbSab(sab);
  const quiet = console.error;
  console.error = () => {};
  try {
    const pending = box2dQueryAABBAsync(0, 0, 1, 1, new Int32Array(4));
    await new Promise((r) => setImmediate(r));
    assert.equal(servicePendingQuery(() => {
      throw new Error('boom');
    }), true);
    await assert.rejects(pending, /physics reported error/);
    assert.equal(Atomics.load(new Int32Array(sab), 0), STATUS_IDLE);
  } finally {
    console.error = quiet;
    bindQueryAabbSab(null);
  }
});

test('castRayClosest: a worker gets the hit physics wrote, and a miss reads as a miss', async () => {
  const sab = createRayCastSab();
  bindRayCastSab(sab);
  const { worker, reply } = inWorker(
    sab,
    `const m = await import(base + 'box2dRayCast.js');
     m.bindRayCastSab(workerData.sab);
     const hit = { ...m.box2dCastRayClosest(1, 2, 30, 0, undefined, { categoryBits: 4, maskBits: 8 }) };
     const miss = { ...m.box2dCastRayClosest(0, 0, 1, 1) };
     return { hit, miss };`,
  );
  try {
    let args = null;
    assert.equal(await serviceWhenPending(servicePendingRayCast, (...a) => {
      args = a;
      return { hit: true, entityIndex: 42, fraction: 0.25, hitX: 8.5, hitY: 2 };
    }), 1);
    await serviceWhenPending(servicePendingRayCast, () => ({ hit: false, entityIndex: 5, fraction: 1 }));
    const msg = await reply;
    assert.ok(msg.ok, msg.e);
    assert.deepEqual(args, [1, 2, 30, 0, 4, 8]);
    assert.deepEqual(msg.r.hit, { hit: true, entityIndex: 42, fraction: 0.25, hitX: 8.5, hitY: 2 });
    assert.deepEqual(msg.r.miss, { hit: false, entityIndex: -1, fraction: 0, hitX: 0, hitY: 0 });
  } finally {
    await worker.terminate();
    bindRayCastSab(null);
  }
});

test('castRayClosestBatch: one request carries every ray; each gets its entity or -1', async () => {
  const sab = createRayCastSab();
  bindRayCastSab(sab);
  const { worker, reply } = inWorker(
    sab,
    `const m = await import(base + 'box2dRayCast.js');
     m.bindRayCastSab(workerData.sab);
     const rays = new Float32Array([0, 0, 10, 0, 5, 5, 0, 10, 1, 1, 1, 1]);
     const entities = new Int32Array(3);
     const n = m.box2dCastRayClosestBatch(3, rays, entities, { categoryBits: 1, maskBits: 3 });
     return { n, entities: Array.from(entities) };`,
  );
  try {
    const seen = [];
    const kind = await serviceWhenPending(servicePendingRayCast, (...a) => {
      seen.push(a);
      const i = seen.length - 1;
      return i === 1 ? { hit: false } : { hit: true, entityIndex: 100 + i };
    });
    const msg = await reply;
    assert.ok(msg.ok, msg.e);
    assert.equal(kind, 2, 'a batch is serviced as one request');
    assert.deepEqual(seen, [
      [0, 0, 10, 0, 1, 3],
      [5, 5, 0, 10, 1, 3],
      [1, 1, 1, 1, 1, 3],
    ]);
    assert.deepEqual(msg.r, { n: 3, entities: [100, -1, 102] });
  } finally {
    await worker.terminate();
    bindRayCastSab(null);
  }
});
