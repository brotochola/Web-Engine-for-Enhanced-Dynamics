import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSortedWindows, concatWindows } from '../../src/render/idWindowMerge.js';

test('mergeSortedWindows interleaves two id windows by key', () => {
  const fp = 2;
  const cap = 2;
  const src = new Float32Array([
    1, 10, 3, 30,
    2, 20, 4, 40,
  ]);
  const keys = new Float32Array([1, 3, 2, 4]);
  const counts = new Int32Array([2, 2]);
  const heads = new Uint32Array(2);
  const dst = new Float32Array(8);
  const n = mergeSortedWindows(dst, src, keys, counts, cap, fp, heads);
  assert.equal(n, 4);
  assert.deepEqual(Array.from(dst), [1, 10, 2, 20, 3, 30, 4, 40]);
});

test('concatWindows keeps worker order', () => {
  const src = new Float32Array([1, 2, 3, 4]);
  const counts = new Int32Array([2, 2]);
  const dst = new Float32Array(4);
  const n = concatWindows(dst, src, counts, 2, 1);
  assert.equal(n, 4);
  assert.deepEqual(Array.from(dst), [1, 2, 3, 4]);
});
