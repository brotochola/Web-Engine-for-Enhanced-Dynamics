import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { begin, createContactWorker, end } from '../bench/contactFlowHarness.mjs';

// E-302: with no type defining onCollisionStay, the logic worker skips the per-frame walk over its pairs (a sweep every
// 30 frames instead). What callers observe must not change: enter and exit for live pairs, nothing for despawned or
// rebuilt bodies, isCollidingWith true only for pairs that still hold.

async function lazyWorker(n = 8) {
  const log = [];
  const ctx = await createContactWorker({ n, totalWorkers: 1, log });
  ctx.worker.collisionStayByType.fill(0);
  return { ...ctx, log };
}
const key = (a, b) => ((a < b ? a : b) << 16) | (a < b ? b : a);

test('no stay listener: enter, then exit, and no stay calls', async () => {
  const { worker, gen, log } = await lazyWorker();
  begin(1, 4, gen);
  worker.processCollisionCallbacks();
  worker.processCollisionCallbacks();
  assert.equal(worker._lazyPairs, true);
  assert.ok(worker.frameCollisions.has(key(1, 4)));
  end(1, 4, gen);
  worker.processCollisionCallbacks();
  assert.equal(worker.frameCollisions.has(key(1, 4)), false);
  assert.deepEqual(log, ['enter 1 4', 'enter 4 1', 'exit 1 4', 'exit 4 1']);
});

test('no stay listener: a despawned entity ends its pairs silently and isCollidingWith says no at once', async () => {
  const { worker, gen, log } = await lazyWorker();
  begin(2, 6, gen);
  worker.processCollisionCallbacks();
  Transform.active[6] = 0;
  worker.processCollisionCallbacks();
  assert.equal(worker.frameCollisions.has(key(2, 6)), false, 'checked when asked, without the walk');
  assert.equal(worker._pairCount, 0, 'the check dropped the pair');
  Transform.active[6] = 1;
  end(2, 6, gen);
  worker.processCollisionCallbacks();
  assert.deepEqual(log, ['enter 2 6', 'enter 6 2']);
});

test('no stay listener: an end that arrives after the despawn fires no exit', async () => {
  const { worker, gen, log } = await lazyWorker();
  begin(3, 5, gen);
  worker.processCollisionCallbacks();
  Transform.active[5] = 0;
  end(3, 5, gen);
  worker.processCollisionCallbacks();
  assert.deepEqual(log, ['enter 3 5', 'enter 5 3']);
  assert.equal(worker._pairCount, 0);
});

test('no stay listener: a new body at a stale pair\'s index fires enter again', async () => {
  const { worker, gen, log } = await lazyWorker();
  begin(2, 7, gen);
  worker.processCollisionCallbacks();
  // Index 7 is despawned and respawned with a new body before any sweep or has() drops the old pair.
  gen[7] = 1;
  begin(2, 7, gen);
  worker.processCollisionCallbacks();
  assert.deepEqual(log, ['enter 2 7', 'enter 7 2', 'enter 2 7', 'enter 7 2']);
  assert.ok(worker.frameCollisions.has(key(2, 7)));
});

test('no stay listener: the sweep frees dead pairs within 30 frames', async () => {
  const { worker, gen } = await lazyWorker(16);
  for (let i = 0; i < 6; i++) begin(i, i + 8, gen);
  worker.processCollisionCallbacks();
  assert.equal(worker._pairCount, 6);
  for (let i = 0; i < 3; i++) Transform.active[i + 8] = 0;
  for (let f = 0; f < 30; f++) worker.processCollisionCallbacks();
  assert.equal(worker._pairCount, 3);
});

test('a stay listener keeps the walk every frame', async () => {
  const log = [];
  const { worker, gen } = await createContactWorker({ n: 8, totalWorkers: 1, log });
  begin(1, 2, gen);
  worker.processCollisionCallbacks();
  worker.processCollisionCallbacks();
  assert.equal(worker._lazyPairs, false);
  assert.deepEqual(log, ['enter 1 2', 'enter 2 1', 'stay 1 2', 'stay 2 1']);
  Transform.active[2] = 0;
  worker.processCollisionCallbacks();
  assert.equal(worker._pairCount, 0, 'walked and dropped this frame');
  Transform.active[2] = 1;
});
