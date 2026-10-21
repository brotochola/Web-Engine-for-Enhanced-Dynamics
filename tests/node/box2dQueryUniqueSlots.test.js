import test from 'node:test';
import assert from 'node:assert/strict';

import { copyUniqueSlots } from '../../src/box2d/box2dQueryAabb.js';

// Review N-22. The WASM reports a body once per overlapping shape, so
// Box2d.queryAABB and overlapCircle returned a compound body's id once per
// fixture (a 3-shape body came back as [11, 11, 11]). Physics copies the WASM
// query slots through copyUniqueSlots.

const CAPACITY = 512; // the WASM query capacity, in bodies (in shapes before N-22)

function slotsOf(ids, capacity = CAPACITY) {
  const slots = new Int32Array(capacity);
  slots.set(ids);
  return slots;
}

test('a compound body is reported once, in first-seen order', () => {
  const results = new Int32Array(8);
  const n = copyUniqueSlots(slotsOf([11, 11, 22, 11, 33, 22]), 6, results, 8, 'test-order');
  assert.equal(n, 3);
  assert.deepEqual(Array.from(results.subarray(0, n)), [11, 22, 33]);
});

test('an id seen by one query is reported again by the next', () => {
  const results = new Int32Array(4);
  assert.equal(copyUniqueSlots(slotsOf([5, 5]), 2, results, 4, 'test-repeat'), 1);
  assert.equal(copyUniqueSlots(slotsOf([5, 5]), 2, results, 4, 'test-repeat'), 1);
  assert.equal(results[0], 5);
});

test('the result capacity bounds the copy', () => {
  const results = new Int32Array([-9, -9, -9]);
  assert.equal(copyUniqueSlots(slotsOf([1, 2, 3, 4]), 4, results, 2, 'test-cap'), 2);
  assert.deepEqual(Array.from(results), [1, 2, -9]);
});

test('slot ids past the first stamp size still dedupe', () => {
  const results = new Int32Array(4);
  assert.equal(copyUniqueSlots(slotsOf([70000, 3, 70000]), 3, results, 4, 'test-grow'), 2);
  assert.deepEqual(Array.from(results.subarray(0, 2)), [70000, 3]);
});

test('reaching the WASM query capacity warns once per query kind', () => {
  const warned = [];
  const original = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    const full = slotsOf([1, 2, 3, 4], 4);
    const results = new Int32Array(8);
    assert.equal(copyUniqueSlots(full, 4, results, 8, 'test-full-a'), 4);
    copyUniqueSlots(full, 4, results, 8, 'test-full-a');
    copyUniqueSlots(full, 4, results, 8, 'test-full-b');
    copyUniqueSlots(slotsOf([1, 2], 4), 2, results, 8, 'test-full-c');
    assert.equal(warned.length, 2, warned.join('\n'));
    assert.match(warned[0], /Box2d\.test-full-a.*4 bodies/);
    assert.match(warned[1], /Box2d\.test-full-b/);
  } finally {
    console.warn = original;
  }
});
