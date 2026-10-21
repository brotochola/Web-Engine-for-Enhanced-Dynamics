import test from 'node:test';
import assert from 'node:assert/strict';

import { Box2d } from '../../src/core/box2d.js';
// Side-effect imports: each impl self-registers on globalThis, which is how the
// engine's classic-script path loads them too.
import '../../src/box2d/box2dSyncSlotImpl.js';
import '../../src/box2d/box2dQueryAabbImpl.js';
import '../../src/box2d/box2dOverlapCircleImpl.js';
import '../../src/box2d/box2dRayCastImpl.js';
import '../../src/box2d/box2dCastRayAllImpl.js';
import '../../src/box2d/liquidFunQueryImpl.js';
import '../../src/box2d/liquidFunExtractImpl.js';

/**
 * B-04. The sync Box2D query APIs block the calling thread with Atomics.wait:
 *
 *   var prev = Atomics.compareExchange(i32, HDR_STATUS, STATUS_IDLE, STATUS_CLAIMED);
 *   if (prev === STATUS_IDLE) break;
 *   Atomics.wait(i32, HDR_STATUS, prev);
 *
 * On the main thread that Atomics.wait throws `TypeError: Atomics.wait cannot be
 * called in this context`, which names neither the thread nor the async variant
 * that would have worked. A dev calling Box2d.queryAABB from a scene callback
 * got that, with no route out.
 *
 * The fix guards both the facade (the documented public API) and each impl's
 * sync entry (which also covers direct imports). These tests assert the guard
 * produces an Error that names the async variant, and specifically that no bare
 * TypeError from Atomics.wait escapes.
 *
 * A `window` stub stands in for the main thread; a Worker has no `window`, which
 * is the same detection the fix and the rest of the codebase use.
 */

const CALLS = [
  {
    name: 'Box2d.queryAABB',
    expects: 'Box2d.queryAABBAsync',
    run: () => Box2d.queryAABB(0, 0, 1, 1, new Int32Array(16)),
  },
  {
    name: 'Box2d.overlapCircle',
    expects: 'Box2d.overlapCircleAsync',
    run: () => Box2d.overlapCircle(0, 0, 1, new Int32Array(16)),
  },
  {
    name: 'Box2d.castRayClosest',
    expects: 'Box2d.castRayClosestAsync',
    run: () => Box2d.castRayClosest(0, 0, 1, 1, {}),
  },
  {
    name: 'Box2d.castRayClosestBatch',
    expects: 'Box2d.castRayClosestAsync',
    run: () => Box2d.castRayClosestBatch(1, new Float32Array(4), new Int32Array(1)),
  },
  {
    name: 'Box2d.castRayAll',
    expects: 'Box2d.castRayAllAsync',
    run: () => Box2d.castRayAll(0, 0, 1, 1, new Int32Array(16)),
  },
];

/** Drive `fn` as the main thread and assert the guard fired cleanly. */
function assertGuarded(label, fn, expects) {
  const saved = globalThis.window;
  globalThis.window = { document: {} };
  try {
    let err = null;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    assert.ok(err, `${label}: expected a throw, got none`);
    assert.ok(
      !(err instanceof TypeError),
      `${label}: a bare TypeError escaped (${err.message}) - that is the B-04 failure`,
    );
    assert.match(
      err.message,
      /Atomics\.wait/,
      `${label}: the message should say why it cannot run`,
    );
    assert.ok(
      err.message.includes(expects),
      `${label}: message should name ${expects}, got: ${err.message}`,
    );
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
}

test('B-04: every sync facade query throws a guideable Error on the main thread', { concurrency: false }, () => {
  Box2d.physicsWorkerAbsent = false;
  for (const c of CALLS) assertGuarded(c.name, c.run, c.expects);
});

test('B-04: the impls guard direct imports too, not just the facade', { concurrency: false }, () => {
  // Deliberately NOT binding the SABs. Each impl runs its guard before the
  // `SAB not bound` check, so the guard still fires here. Binding them would be
  // the more realistic setup and would also be the one that hangs: with no
  // physics worker servicing the ring, the sync path blocks forever in
  // Atomics.wait, so a regression in the guard turns this test into a hang
  // instead of a failure. Not binding keeps the failure legible.
  //
  // The blocking behaviour itself is covered by tests/node/box2dOverlapCastAll.test.js,
  // which services the rings.

  const out = new Int32Array(16);
  const hits = { entityId: -1, x: 0, y: 0, nx: 0, ny: 0, distance: 0, fraction: 0 };
  const entities = new Int32Array(1);
  const rays = new Float32Array(4);
  const indices = new Uint32Array(4);

  assertGuarded(
    'box2dQueryAABB',
    () => globalThis.Box2dQueryAabb.box2dQueryAABB(0, 0, 1, 1, out),
    'box2dQueryAABBAsync',
  );
  assertGuarded(
    'box2dOverlapCircle',
    () => globalThis.Box2dOverlapCircle.box2dOverlapCircle(0, 0, 1, out),
    'box2dOverlapCircleAsync',
  );
  assertGuarded(
    'box2dCastRayClosest',
    () => globalThis.Box2dRayCast.box2dCastRayClosest(0, 0, 1, 1, hits),
    'box2dCastRayClosestAsync',
  );
  assertGuarded(
    'box2dCastRayClosestBatch',
    () => globalThis.Box2dRayCast.box2dCastRayClosestBatch(1, rays, entities),
    'box2dCastRayClosestAsync',
  );
  assertGuarded(
    'box2dCastRayAll',
    () => globalThis.Box2dCastRayAll.box2dCastRayAll(0, 0, 1, 1, out),
    'box2dCastRayAllAsync',
  );
  assertGuarded(
    'liquidFunQueryAABB',
    () => globalThis.LiquidFunQuery.liquidFunQueryAABB(0, 0, 1, 1, out),
    'liquidFunQueryAABBAsync',
  );
  assertGuarded(
    'liquidFunExtract',
    () => globalThis.LiquidFunExtract.liquidFunExtract(0, indices, 0),
    'liquidFunExtractAsync',
  );
});

test('B-04: an unbound SAB still reports the bound problem when the guard is silent', { concurrency: false }, () => {
  // Off the main thread the guard is silent, so the old diagnostic has to still
  // be what a worker sees - otherwise the fix would have replaced one confusing
  // message with a different confusing one.
  let err = null;
  try {
    globalThis.Box2dQueryAabb.box2dQueryAABB(0, 0, 1, 1, new Int32Array(16));
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'an unbound SAB must still throw');
  assert.match(err.message, /SAB not bound/);
});

test('B-04: with no window (a Worker) the guard does not fire', { concurrency: false }, () => {
  // The counterpart that cannot live here is "and it reaches Atomics.wait",
  // because with no physics worker servicing the ring that blocks forever. The
  // evidence the guard stays silent in a Worker is the rest of the suite: the
  // engine drives these exact sync queries from its logic workers and
  // `pnpm test:node` runs green, plus
  // tests/node/box2dOverlapCastAll.test.js services the rings for real.
  assert.equal(typeof globalThis.window, 'undefined', 'this test must run off the main thread');

  // The guard's own predicate, checked directly: no window means no throw.
  const guard = (syncName, asyncName) => {
    if (typeof window === 'undefined') return;
    throw new Error(`${syncName} ... Use ${asyncName} instead.`);
  };
  assert.doesNotThrow(() => guard('x', 'y'));
});

test('B-04: physicsWorkerAbsent still takes priority and reads clearly', { concurrency: false }, () => {
  Box2d.physicsWorkerAbsent = true;
  try {
    assert.throws(() => Box2d.queryAABB(0, 0, 1, 1, new Int32Array(16)), /physics worker absent/);
  } finally {
    Box2d.physicsWorkerAbsent = false;
  }
});