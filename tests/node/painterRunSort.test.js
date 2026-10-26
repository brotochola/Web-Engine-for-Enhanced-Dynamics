import test from 'node:test';
import assert from 'node:assert/strict';

import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { createPainterState, radixPainterOrder, radixSortIndicesBySortKey } from '../reference/painterJs.mjs';

// E-103. radixPainterOrder sorts runs (consecutive slots under one key, an Adobe Animate character's
// pieces) by their first slot and expands them. The order must be the one the stable radix gives
// every row: runs with equal keys, separate runs with the same key, a filtered slot list with gaps,
// and the bail-out when runs do not pay.

function reference(slots, n, keys) {
  const order = Uint32Array.from(slots.subarray(0, n));
  radixSortIndicesBySortKey(order, n, keys, new Uint32Array(n), new Uint32Array(256));
  return order;
}

/** Keys in runs of 1..maxRun, drawn from `distinct` values so separate runs share keys too. */
function runKeys(n, maxRun, distinct, seed) {
  const rng = mulberry32(seed);
  const f = new Float32Array(n);
  let j = 0;
  while (j < n) {
    const key = ((rng() * distinct) | 0) * 128 - (distinct * 64) + (rng() < 0.1 ? 0.5 : 0);
    const len = 1 + ((rng() * maxRun) | 0);
    for (let k = 0; k < len && j < n; k++) f[j++] = key;
  }
  return new Uint32Array(f.buffer);
}

test('runs sort to the order the stable radix gives every row', () => {
  for (const [n, maxRun, distinct, seed] of [[4000, 25, 50, 1], [12000, 12, 9, 2], [3000, 40, 3000, 3], [1500, 2, 20, 4]]) {
    const keys = runKeys(n, maxRun, distinct, seed);
    const dense = Uint32Array.from({ length: n }, (_, i) => i);
    const state = createPainterState(n);
    const got = radixPainterOrder(state, null, n, keys);
    assert.deepEqual(Array.from(got.subarray(0, n)), Array.from(reference(dense, n, keys)), `dense n=${n} maxRun=${maxRun}`);
  }
});

test('a filtered slot list (gaps between runs) sorts the same', () => {
  const n = 6000;
  const keys = runKeys(n, 20, 30, 7);
  const rng = mulberry32(8);
  const kept = [];
  for (let i = 0; i < n; i++) if (rng() > 0.05) kept.push(i); // glow rows left out
  const idxE = Uint32Array.from(kept);
  const state = createPainterState(n);
  const got = radixPainterOrder(state, idxE, idxE.length, keys);
  assert.deepEqual(Array.from(got.subarray(0, idxE.length)), Array.from(reference(idxE, idxE.length, keys)));
});

test('rows without runs take the plain radix and sort the same', () => {
  const n = 5000;
  const keys = runKeys(n, 1, 100000, 9);
  const state = createPainterState(n);
  const got = radixPainterOrder(state, null, n, keys);
  const dense = Uint32Array.from({ length: n }, (_, i) => i);
  assert.deepEqual(Array.from(got.subarray(0, n)), Array.from(reference(dense, n, keys)));
});
