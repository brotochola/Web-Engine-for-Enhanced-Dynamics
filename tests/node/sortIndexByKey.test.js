import test from 'node:test';
import assert from 'node:assert/strict';
import {
  radixSortIndicesBySortKey,
  reinsertChangedSlots,
  createPainterState,
  painterSameSet,
  orderPainterSlots,
} from '../../src/util/sortIndexByKey.js';

function cmpFloat(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortCheck(values) {
  const keys = new Float32Array(values);
  const n = keys.length;
  const keysU32 = new Uint32Array(keys.buffer);
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  radixSortIndicesBySortKey(idx, n, keysU32, new Uint32Array(Math.max(1, n)), new Uint32Array(256));
  const expect = Array.from({ length: n }, (_, i) => i);
  expect.sort((a, b) => cmpFloat(keys[a], keys[b]));
  assert.deepEqual(Array.from(idx), expect);
}

test('radix sort indices by float sortKey', () => {
  sortCheck([]);
  sortCheck([3]);
  sortCheck([4, 3, 2, 1]);
  sortCheck([0, -1, 2, 2, 100.5, -100.5]);
});

test('reinsert a slot index above the list length', () => {
  const keys = new Float32Array(8);
  keys[0] = 1;
  keys[5] = 3;
  const keysU32 = new Uint32Array(keys.buffer);
  const order = new Uint32Array([0, 5]);
  const prev = new Uint32Array(keysU32);
  keys[5] = 0;
  const n = 2;
  const slotMoved = new Uint8Array(8);
  const movedList = new Uint32Array(8);
  const merge = new Uint32Array(8);
  assert.equal(
    reinsertChangedSlots(order, n, keysU32, prev, slotMoved, movedList, merge, new Uint32Array(8), new Uint32Array(256)),
    1,
  );
  assert.deepEqual(Array.from(order.subarray(0, n)), [5, 0]);
});

test('reinsert only the slot whose key changed', () => {
  const keys = new Float32Array([1, 2, 3, 4]);
  const keysU32 = new Uint32Array(keys.buffer);
  const n = 4;
  const order = new Uint32Array([0, 1, 2, 3]);
  const prev = new Uint32Array(keysU32);
  const slotMoved = new Uint8Array(n);
  const movedList = new Uint32Array(n);
  const merge = new Uint32Array(n);
  const scratch = new Uint32Array(n);
  const hist = new Uint32Array(256);
  keys[2] = 0;
  assert.equal(reinsertChangedSlots(order, n, keysU32, prev, slotMoved, movedList, merge, scratch, hist), 1);
  assert.deepEqual(Array.from(order), [2, 0, 1, 3]);
  assert.equal(reinsertChangedSlots(order, n, keysU32, prev, slotMoved, movedList, merge, scratch, hist), 0);
});

function orderCheck(keysU32, ne, idxE, state, mode) {
  const order = orderPainterSlots(state, idxE, ne, keysU32, mode);
  const slots = idxE ? Array.from(idxE.subarray(0, ne)) : Array.from({ length: ne }, (_, i) => i);
  const got = order ? Array.from(order.subarray(0, ne)) : slots;
  const expect = slots.slice().sort((a, b) => keysU32[a] - keysU32[b] || a - b);
  // Compare as sets sorted by key value (bit pattern order for our all-positive
  // test keys matches numeric order, so a plain numeric compare is fine here).
  const gotSorted = got
    .map((slot) => keysU32[slot])
    .every((k, i) => i === 0 || k >= got.map((s) => keysU32[s])[i - 1]);
  assert.equal(got.length, ne);
  assert.deepEqual(new Set(got), new Set(slots), 'order is a permutation of the live slot set');
  assert.ok(gotSorted, `order not ascending by key: ${got.map((s) => keysU32[s])}`);
  void expect;
}

test('orderPainterSlots: dense layer queue (idxE=null) sorts by key every frame', () => {
  const cap = 16;
  const keys = new Float32Array(cap);
  const keysU32 = new Uint32Array(keys.buffer);
  const state = createPainterState(cap);

  keys.set([50, 10, 30, 20, 40]);
  orderCheck(keysU32, 5, null, state, 'reinsert');

  // Same dense count next frame, values reshuffled — models a shard split
  // shifting while the total published count happens to stay the same.
  keys.set([15, 45, 5, 35, 25]);
  orderCheck(keysU32, 5, null, state, 'reinsert');

  // Count drops (some slot fell out of the queue): must not reuse stale order.
  keys.set([1, 2, 3, 4]);
  orderCheck(keysU32, 4, null, state, 'reinsert');

  // Count grows back past the old size.
  keys.set([9, 8, 7, 6, 5, 4]);
  orderCheck(keysU32, 6, null, state, 'reinsert');
});

test('orderPainterSlots: radix and decimate modes stay a valid permutation', () => {
  const cap = 10;
  const keys = new Float32Array(cap);
  const keysU32 = new Uint32Array(keys.buffer);

  const radixState = createPainterState(cap);
  for (const vals of [[3, 1, 2], [1, 3, 2], [2, 2, 2]]) {
    keys.set(vals);
    orderCheck(keysU32, vals.length, null, radixState, 'radix');
  }

  const decState = createPainterState(cap);
  for (let frame = 0; frame < 6; frame++) {
    keys.set([frame, frame * 2, frame * 3, frame * 4]);
    orderCheck(keysU32, 4, null, decState, 'decimate');
  }
});

test('painterSameSet: dense set (idxE=null) needs only a matching count', () => {
  const state = createPainterState(8);
  state.ready = true;
  state.n = 4;
  assert.equal(painterSameSet(state, null, 4), true);
  assert.equal(painterSameSet(state, null, 5), false);
});

test('painterSameSet: filtered set (real idxE) needs matching integers, not just count', () => {
  const cap = 8;
  const keys = new Float32Array(cap);
  const keysU32 = new Uint32Array(keys.buffer);
  const state = createPainterState(cap);
  keys.set([10, 20, 30, 40]);
  const idxE = new Uint32Array([0, 1, 2, 3]);
  orderPainterSlots(state, idxE, 4, keysU32, 'reinsert');
  // Same count, different integer set (2 swapped for 4) — must not be "same set".
  const shiftedIdxE = new Uint32Array([0, 1, 3, 4]);
  assert.equal(painterSameSet(state, shiftedIdxE, 4), false);
  assert.equal(painterSameSet(state, idxE, 4), true);
});
