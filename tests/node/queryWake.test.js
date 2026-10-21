import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import '../../src/box2d/box2dQueryAabb.js';
import '../../src/box2d/box2dOverlapCircle.js';
import '../../src/box2d/box2dRayCast.js';
import '../../src/box2d/box2dCastRayAll.js';
import '../../src/box2d/liquidFunQuery.js';
import '../../src/box2d/liquidFunExtract.js';

// Review N-24 / E-56. Physics answered the sync queries only inside doStep, and
// only QueryAABB had a wake between steps: a ray batch posted after the step's
// service point blocked its logic worker until the next frame (16.5 of 16.6 ms
// on RayVsBox2dBoxIdleScene). Every kind now wakes the host, and a burst no
// longer waits up to 2 ms inside the step for a request that may not come.

const KINDS = [
  { name: 'Box2dQueryAabb', create: 'createQueryAabbSab', bind: 'bindQueryAabbSab', post: (R) => R.box2dQueryAABBAsync(0, 0, 1, 1, new Int32Array(4)), service: (R) => R.servicePendingQuery(() => 0) },
  { name: 'Box2dOverlapCircle', create: 'createOverlapCircleSab', bind: 'bindOverlapCircleSab', post: (R) => R.box2dOverlapCircleAsync(0, 0, 1, new Int32Array(4)), service: (R) => R.servicePendingOverlapCircle(() => 0) },
  { name: 'Box2dRayCast', create: 'createRayCastSab', bind: 'bindRayCastSab', post: (R) => R.box2dCastRayClosestAsync(0, 0, 1, 0), service: (R) => R.servicePendingRayCast(() => ({ hit: false })) },
  { name: 'Box2dCastRayAll', create: 'createCastRayAllSab', bind: 'bindCastRayAllSab', post: (R) => R.box2dCastRayAllAsync(0, 0, 1, 0, []), service: (R) => R.servicePendingCastRayAll(() => 0) },
  { name: 'LiquidFunQuery', create: 'createLiquidFunQuerySab', bind: 'bindLiquidFunQuerySab', post: (R) => R.liquidFunQueryAABBAsync(0, 0, 1, 1, new Int32Array(4)), service: (R) => R.servicePendingLiquidFunQuery(() => 0) },
  { name: 'LiquidFunExtract', create: 'createLiquidFunExtractSab', bind: 'bindLiquidFunExtractSab', post: (R) => R.liquidFunExtractAsync(0, new Int32Array(1), 0), service: (R) => R.servicePendingLiquidFunExtract(() => -1) },
];

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('a request on every sync query kind wakes physics', async () => {
  for (const kind of KINDS) {
    const R = globalThis[kind.name];
    assert.equal(typeof R.armPendingWake, 'function', `${kind.name} has no armPendingWake`);
    const sab = R[kind.create]();
    R[kind.bind](sab);
    try {
      let fired = 0;
      assert.equal(R.armPendingWake(() => fired++), true, `${kind.name}: could not arm`);
      const pending = kind.post(R);
      await tick(10);
      assert.ok(fired >= 1, `${kind.name}: the request did not wake physics`);
      assert.ok(kind.service(R), `${kind.name}: nothing pending to answer`);
      await pending;
    } finally {
      R[kind.bind](null);
    }
  }
});

test('a burst ends without a timed wait inside the step', async () => {
  const R = globalThis.Box2dRayCast;
  R.bindRayCastSab(R.createRayCastSab());
  const realWait = Atomics.wait;
  let waits = 0;
  Atomics.wait = function (...args) {
    waits++;
    return realWait.apply(this, args);
  };
  try {
    const pending = R.box2dCastRayClosestAsync(0, 0, 10, 0);
    await new Promise((r) => setImmediate(r));
    assert.equal(R.servicePendingRayCastBurst(() => ({ hit: false }), 4), 1);
    assert.equal(waits, 0, 'the step blocked in Atomics.wait for a request that never came');
    await pending;
  } finally {
    Atomics.wait = realWait;
    R.bindRayCastSab(null);
  }
});

// The host's wake loop, evaluated alone (as physicsWorkerCount.test.js does)
// against fake query kinds.
function loadWakeLoop(state, serviceQueries) {
  const src = readFileSync(new URL('../../src/box2d/physicsHostImpl.js', import.meta.url), 'utf8');
  const start = src.indexOf('  var WAKE_KINDS = [');
  const end = src.indexOf('\n  // ponytail: classic IIFE cannot import timeScale.js');
  assert.ok(start > 0 && end > start, 'wake block not found in physicsHostImpl.js');
  const fakes = {};
  const global = {};
  for (const { name } of KINDS) {
    const fake = { arms: 0, onPending: null, fireOnArm: false };
    fake.armPendingWake = (onPending) => {
      fake.arms++;
      fake.onPending = onPending;
      if (fake.fireOnArm) onPending();
      return true;
    };
    fakes[name] = fake;
    global[name] = fake;
  }
  const host = new Function(
    'global',
    'state',
    'globalThis',
    `${src.slice(start, end)}\nreturn { pumpQueryWake: pumpQueryWake, wakeMs: function () { return queryWakeMs; } };`,
  )(global, state, { weedjsServiceQueries: serviceQueries });
  return { host, fakes };
}

test('the physics host arms one wake per query kind, once', () => {
  const { host, fakes } = loadWakeLoop({ _inStep: false, box2dReady: true }, () => {});
  host.pumpQueryWake();
  host.pumpQueryWake();
  for (const { name } of KINDS) assert.equal(fakes[name].arms, 1, `${name} armed ${fakes[name].arms} times`);
});

test('a wake answers the queries and arms that kind again', () => {
  let serviced = 0;
  const { host, fakes } = loadWakeLoop({ _inStep: false, box2dReady: true }, () => serviced++);
  host.pumpQueryWake();
  fakes.Box2dRayCast.onPending();
  assert.equal(serviced, 1);
  assert.equal(fakes.Box2dRayCast.arms, 2);
  assert.equal(fakes.LiquidFunQuery.arms, 1);
  assert.ok(host.wakeMs() >= 0);
});

test('a wake while not ready or mid-step leaves it to the end-of-frame pump', () => {
  for (const state of [{ _inStep: false, box2dReady: false }, { _inStep: true, box2dReady: true }]) {
    let serviced = 0;
    const { host, fakes } = loadWakeLoop(state, () => serviced++);
    host.pumpQueryWake();
    fakes.Box2dQueryAabb.onPending();
    assert.equal(serviced, 0);
    assert.equal(fakes.Box2dQueryAabb.arms, 1);
    host.pumpQueryWake();
    assert.equal(fakes.Box2dQueryAabb.arms, 2, 'the pump did not arm it again');
  }
});

test('a wake that keeps firing as it is armed stops instead of overflowing the stack', () => {
  let serviced = 0;
  const { host, fakes } = loadWakeLoop({ _inStep: false, box2dReady: true }, () => serviced++);
  fakes.Box2dRayCast.fireOnArm = true;
  host.pumpQueryWake();
  assert.ok(serviced > 0 && serviced <= 10, `serviced ${serviced} times in one synchronous chain`);
});
