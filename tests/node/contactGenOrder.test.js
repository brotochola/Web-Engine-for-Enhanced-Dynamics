import test from 'node:test';
import assert from 'node:assert/strict';

import { begin, createContactWorker, end } from '../bench/contactFlowHarness.mjs';

// Box2D reports a contact as (shapeA, shapeB) in its own order, not (min, max).
// A pair whose event arrives with the larger id first, and whose two bodies
// have different generations, must keep firing stay and then fire exit.
test('stay and exit survive an event ordered (max, min) with unequal generations', async () => {
  const log = [];
  const { worker, gen } = await createContactWorker({ n: 8, totalWorkers: 1, log });
  gen[5] = 2;
  gen[3] = 0;
  begin(5, 3, gen);
  worker.processCollisionCallbacks();
  worker.processCollisionCallbacks();
  worker.processCollisionCallbacks();
  assert.ok(worker.frameCollisions.has((3 << 16) | 5), 'pair still tracked');
  end(5, 3, gen);
  worker.processCollisionCallbacks();
  assert.deepEqual(log, ['enter 5 3', 'enter 3 5', 'stay 3 5', 'stay 5 3', 'stay 3 5', 'stay 5 3', 'exit 3 5', 'exit 5 3']);
});

test('a respawned body (generation bump) still drops its stale pair', async () => {
  const log = [];
  const { worker, gen } = await createContactWorker({ n: 8, totalWorkers: 1, log });
  begin(2, 6, gen);
  worker.processCollisionCallbacks();
  gen[6] = 1;
  worker.processCollisionCallbacks();
  assert.equal(worker.frameCollisions.has((2 << 16) | 6), false);
  end(2, 6, gen);
  worker.processCollisionCallbacks();
  assert.deepEqual(log, ['enter 2 6', 'enter 6 2']);
});
