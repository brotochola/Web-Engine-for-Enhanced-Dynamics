import { test } from 'node:test';
import assert from 'node:assert/strict';

import { armOrder, armPairs } from '../bench/runMultiArm.mjs';

// N-239: a multi-arm sitting's order and pairs.
test('the arms rotate from round to round and reverse on odd rounds, each arm first and last in turn', () => {
  const labels = ['A', 'e1', 'e2'];
  const orders = [0, 1, 2, 3, 4, 5].map((r) => armOrder(labels, r));
  assert.deepEqual(orders[0], ['A', 'e1', 'e2']);
  assert.deepEqual(orders[1], ['A', 'e2', 'e1']);
  assert.deepEqual(orders[2], ['e2', 'A', 'e1']);
  for (const o of orders) assert.deepEqual([...o].sort(), [...labels].sort());
  // Over six rounds every arm runs first twice and last twice.
  for (const l of labels) {
    assert.equal(orders.filter((o) => o[0] === l).length, 2, `${l} first`);
    assert.equal(orders.filter((o) => o[o.length - 1] === l).length, 2, `${l} last`);
  }
});

test('an arm\'s pairs are each round\'s A against that round\'s arm', () => {
  const rounds = [
    { A: { x: 1 }, e1: { x: 2 }, e2: { x: 3 } },
    { A: { x: 4 }, e1: { x: 5 } },
  ];
  assert.deepEqual(armPairs(rounds, 'e1'), [{ A: { x: 1 }, B: { x: 2 } }, { A: { x: 4 }, B: { x: 5 } }]);
  assert.deepEqual(armPairs(rounds, 'e2'), [{ A: { x: 1 }, B: { x: 3 } }]);
});
