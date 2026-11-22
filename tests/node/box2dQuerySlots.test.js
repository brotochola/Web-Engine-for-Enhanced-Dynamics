import test from 'node:test';
import assert from 'node:assert/strict';

import { copyQuerySlots } from '../../src/box2d/box2dQueryAabb.js';

// Physics copies the WASM query slots of Box2d.queryAABB and overlapCircle into the results view. The WASM lists each
// body once (N-22, box2dOverlapCastAll.wasm.test.js), so the copy keeps the slots as they are (CR-31: the dedupe for a
// wasm before N-22 is gone).

const CAPACITY = 512; // the WASM query capacity, in bodies

function slotsOf(ids, capacity = CAPACITY) {
  const slots = new Int32Array(capacity);
  slots.set(ids);
  return slots;
}

test('the slots are copied in order', () => {
  const results = new Int32Array(8);
  const n = copyQuerySlots(slotsOf([11, 22, 33]), 3, results, 8, 'test-order');
  assert.equal(n, 3);
  assert.deepEqual(Array.from(results.subarray(0, n)), [11, 22, 33]);
});

test('the result capacity bounds the copy', () => {
  const results = new Int32Array([-9, -9, -9]);
  assert.equal(copyQuerySlots(slotsOf([1, 2, 3, 4]), 4, results, 2, 'test-cap'), 2);
  assert.deepEqual(Array.from(results), [1, 2, -9]);
});

test('reaching the WASM query capacity warns once per query kind', () => {
  const warned = [];
  const original = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    const full = slotsOf([1, 2, 3, 4], 4);
    const results = new Int32Array(8);
    assert.equal(copyQuerySlots(full, 4, results, 8, 'test-full-a'), 4);
    copyQuerySlots(full, 4, results, 8, 'test-full-a');
    copyQuerySlots(full, 4, results, 8, 'test-full-b');
    copyQuerySlots(slotsOf([1, 2], 4), 2, results, 8, 'test-full-c');
    assert.equal(warned.length, 2, warned.join('\n'));
    assert.match(warned[0], /Box2d\.test-full-a.*4 bodies/);
    assert.match(warned[1], /Box2d\.test-full-b/);
  } finally {
    console.warn = original;
  }
});
