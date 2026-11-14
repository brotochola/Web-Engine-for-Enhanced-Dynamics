import test from 'node:test';
import assert from 'node:assert/strict';

import { earlyStop } from '../../tests/bench/runPredatorAbab.mjs';

// runPredatorAbab --early stops after 2 pairs only on an unmistakable result: a judged kind at least +6 % in both pairs
// (a regression), the owner at least -6 % in both with no other judged kind +3 % in both (the speed reading), or every
// judged kind within ±2 % in both (a clean gate). Anything else runs the rest of the pairs.

const KINDS = ['logic', 'spatial', 'physics', 'renderer', 'particle', 'preRender'];

/** Pairs whose base is 10 ms for the listed kinds (judged) and idle for the rest; `pct` gives each pair's B. */
function pairs(pct) {
  return [0, 1].map((i) => {
    const A = {};
    const B = {};
    for (const k of KINDS) {
      const delta = pct[k];
      A[`${k}_STEP_MS`] = delta === undefined ? 0.02 : 10;
      B[`${k}_STEP_MS`] = delta === undefined ? 0.02 : 10 * (1 + delta[i] / 100);
    }
    return { A, B };
  });
}

test('--early: a kind +6 % in both pairs stops as a regression', () => {
  assert.match(earlyStop(pairs({ physics: [-1, 0], spatial: [7, 9] }), 'physics'), /spatial at least \+6 %/);
});

test('--early: the owner -6 % in both pairs stops, unless another kind is +3 % in both', () => {
  assert.match(earlyStop(pairs({ physics: [-8, -7], spatial: [1, -2] }), 'physics'), /physics at least -6 %/);
  assert.equal(earlyStop(pairs({ physics: [-8, -7], spatial: [4, 5] }), 'physics'), null);
});

test('--early: every judged kind within ±2 % stops as a clean gate', () => {
  assert.match(earlyStop(pairs({ physics: [1.5, -1], logic: [-2, 0.5] }), null), /within ±2 %/);
});

test('--early: anything less clear runs on', () => {
  assert.equal(earlyStop(pairs({ physics: [-8, -2] }), 'physics'), null, 'one pair short of -6 %');
  assert.equal(earlyStop(pairs({ physics: [3, -1] }), 'physics'), null, 'a 3 % move is for 4 pairs to judge');
  assert.equal(earlyStop([pairs({ physics: [-9, -9] })[0]], 'physics'), null, 'one pair is never enough');
});

test('--early: idle kinds (under the floor) neither stop nor block a sitting', () => {
  assert.equal(earlyStop(pairs({}), 'physics'), null, 'nothing judged: run on');
  assert.match(earlyStop(pairs({ physics: [-7, -6.5] }), 'physics'), /physics at least -6 %/);
});
