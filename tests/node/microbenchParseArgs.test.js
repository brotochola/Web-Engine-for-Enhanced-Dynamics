import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../bench/microbenchHelpers.mjs';

// N-231: the bench tools' argument parser turned an all-digit git sha into a number, which lost its leading zero and
// named another revision (runPredatorAbab --vs 09443713 reached git as 9443713).
test('parseArgs keeps a value with a leading zero a string, and numbers numbers', () => {
  const a = parseArgs(['--vs', '09443713', '--pairs', '4', '--zero', '0', '--half', '0.5', '--neg', '-3', '--big', '12345678', '--flag']);
  assert.equal(a.vs, '09443713');
  assert.equal(a.pairs, 4);
  assert.equal(a.zero, 0);
  assert.equal(a.half, 0.5);
  assert.equal(a.neg, -3);
  assert.equal(a.big, 12345678);
  assert.equal(a.flag, true);
});
