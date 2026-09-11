// SAB protocol unit test for LiquidFun QueryAABB / RayCast (no WASM).
// Use async APIs so the event loop can run the service timer (Atomics.wait blocks Node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiquidFunQuerySab,
  bindLiquidFunQuerySab,
  liquidFunQueryAABBAsync,
  liquidFunRayCastAsync,
  liquidFunQueryAABB,
  servicePendingLiquidFunQuery,
  LIQUIDFUN_QUERY_OP_AABB,
  LIQUIDFUN_QUERY_OP_RAY,
} from '../../src/box2d/liquidFunQuery.js';

function startService(mode) {
  return setInterval(() => {
    servicePendingLiquidFunQuery((op, a, b, c, d, results, cap) => {
      if (mode === 'error') throw new Error('boom');
      if (mode === 'ray') {
        assert.equal(op, LIQUIDFUN_QUERY_OP_RAY);
        results[0] = 7;
        return 1;
      }
      assert.equal(op, LIQUIDFUN_QUERY_OP_AABB);
      assert.equal(a, 10);
      assert.equal(b, 20);
      assert.equal(c, 30);
      assert.equal(d, 40);
      const n = 3;
      const write = Math.min(n, cap);
      for (let i = 0; i < write; i++) results[i] = 100 + i;
      return n;
    });
  }, 1);
}

test('liquidFunQueryAABBAsync: claim → service → copy particle indices', async () => {
  const sab = createLiquidFunQuerySab(64);
  bindLiquidFunQuerySab(sab);
  const out = new Int32Array(16);
  const timer = startService('aabb');
  try {
    const count = await liquidFunQueryAABBAsync(10, 20, 30, 40, out);
    assert.equal(count, 3);
    assert.equal(out[0], 100);
    assert.equal(out[1], 101);
    assert.equal(out[2], 102);
  } finally {
    clearInterval(timer);
    bindLiquidFunQuerySab(null);
  }
});

test('liquidFunRayCastAsync + error path', async () => {
  const sab = createLiquidFunQuerySab(32);
  bindLiquidFunQuerySab(sab);
  const out = new Int32Array(8);

  const rayTimer = startService('ray');
  try {
    const count = await liquidFunRayCastAsync(0, 0, 100, 50, out);
    assert.equal(count, 1);
    assert.equal(out[0], 7);
  } finally {
    clearInterval(rayTimer);
  }

  const logged = [];
  const origError = console.error;
  console.error = (...args) => {
    logged.push(args);
  };
  const errTimer = startService('error');
  try {
    await assert.rejects(
      () => liquidFunQueryAABBAsync(0, 0, 1, 1, out),
      /physics reported error/,
    );
    assert.equal(logged.length, 1);
  } finally {
    clearInterval(errTimer);
    console.error = origError;
    bindLiquidFunQuerySab(null);
  }
});

test('liquidFunQuery rejects non-Int32Array out', () => {
  const sab = createLiquidFunQuerySab(16);
  bindLiquidFunQuerySab(sab);
  try {
    assert.throws(() => liquidFunQueryAABB(0, 0, 1, 1, new Float32Array(4)), /Int32Array/);
  } finally {
    bindLiquidFunQuerySab(null);
  }
});
