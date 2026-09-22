import test from 'node:test';
import assert from 'node:assert/strict';
import { radixSortIndicesBySortKey, reinsertChangedSlots } from '../../src/util/sortIndexByKey.js';

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
