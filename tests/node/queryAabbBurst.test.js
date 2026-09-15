import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createQueryAabbSab,
  bindQueryAabbSab,
  servicePendingQueryBurst,
} from '../../src/box2d/box2dQueryAabb.js';

test('servicePendingQueryBurst drains a pending AABB with overlapFn', () => {
  const sab = createQueryAabbSab(64);
  bindQueryAabbSab(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  f32[8] = 0;
  f32[9] = 0;
  f32[10] = 10;
  f32[11] = 10;
  Atomics.store(i32, 0, 1); // PENDING

  const serviced = servicePendingQueryBurst((x0, y0, x1, y1, _cat, _mask, results, cap) => {
    assert.equal(x0, 0);
    assert.equal(y0, 0);
    assert.equal(x1, 10);
    assert.equal(y1, 10);
    const n = Math.min(3, cap);
    for (let i = 0; i < n; i++) results[i] = 100 + i;
    return n;
  }, 8);

  assert.equal(serviced, 1);
  assert.equal(Atomics.load(i32, 0), 2); // DONE
  assert.equal(Atomics.load(i32, 1), 3);
  assert.equal(servicePendingQueryBurst(() => 0, 4), 0);
});
