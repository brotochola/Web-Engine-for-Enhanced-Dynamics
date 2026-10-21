import test from 'node:test';
import assert from 'node:assert/strict';

import { median, mulberry32, upperMedian } from '../bench/benchMath.js';

test('benchMath: mulberry32 keeps its sequence (every seeded bench workload is built from it)', () => {
  const r = mulberry32(0xc0ffee);
  assert.deepEqual([r(), r(), r()], [0.021141508361324668, 0.6661099966149777, 0.7799714196007699]);
  assert.equal(mulberry32(0xffffffff)(), 0.8964226141106337);
  const a = mulberry32(7);
  const b = mulberry32(7);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test('benchMath: median averages the two middles, upperMedian takes the upper one', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(upperMedian([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(upperMedian([4, 1, 3, 2]), 3);
  assert.equal(median(new Float64Array([10, -1])), 4.5);
  assert.ok(Number.isNaN(median([])));
  assert.equal(upperMedian([]), undefined);
  const input = [5, 4, 3];
  median(input);
  upperMedian(input);
  assert.deepEqual(input, [5, 4, 3]);
});
