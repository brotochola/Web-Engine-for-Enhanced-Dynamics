import test from 'node:test';
import assert from 'node:assert/strict';

import { clearsLimit, decideAbab, detectionLimits } from '../../tests/bench/runPredatorAbab.mjs';

// runPredatorAbab --aa (HOW_WE_MEASURE rule 7): the session's A/A gives each worker kind a detection limit, 2.5 times the
// spread of its A/A paired deltas over the square root of the sitting's pairs, raw and against the other judged kinds; a
// keep or a regression must also clear it. Two A/As of Predator crowd=2.5 on 2026-11-14 read pre-render -6.3 % and +4.7 %
// on identical code (one a KEPT, one a REGRESSION by the 3 % bars alone).

const KINDS = ['logic', 'spatial', 'physics', 'renderer', 'particle', 'preRender'];

/** Pairs whose base is 10 ms for the listed kinds (judged) and idle for the rest; pct[kind][i] is pair i's B delta in %. */
function pairs(pct, n) {
  return Array.from({ length: n }, (_, i) => {
    const A = {};
    const B = {};
    for (const k of KINDS) {
      const delta = pct[k];
      A[`${k}_STEP_MS`] = delta === undefined ? 0.02 : 10;
      B[`${k}_STEP_MS`] = delta === undefined ? 0.02 : 10 * (1 + delta[i % delta.length] / 100);
    }
    return { A, B };
  });
}

test('detectionLimits: 2.5 x the A/A spread over the square root of the pairs, raw and against the others', () => {
  const aa = pairs({ physics: [2, -2, 2, -2], spatial: [0, 0, 0, 0], logic: [0, 0, 0, 0] }, 4);
  const at4 = detectionLimits(aa, 4);
  const sd = Math.sqrt((4 * 4) / 3); // deltas +-2 % (relative change of 10 ms by 2 %, so exactly +-2)
  assert.ok(Math.abs(at4.physics.spreadPct - sd) < 1e-9, `spread ${at4.physics.spreadPct}`);
  assert.ok(Math.abs(at4.physics.limitPct - (2.5 * sd) / 2) < 1e-9, `limit ${at4.physics.limitPct}`);
  assert.ok(Math.abs(at4.physics.againstLimitPct - (2.5 * sd) / 2) < 1e-9, 'against the others: the others did not move');
  const at16 = detectionLimits(aa, 16);
  assert.ok(Math.abs(at16.physics.limitPct - at4.physics.limitPct / 2) < 1e-9, 'four times the pairs halves the limit');
  assert.equal(at4.renderer, undefined, 'a kind under the floor gets no limit');
});

test('--aa: a -4 % keep inside a wide A/A spread is neutral; past a narrow one it stays', () => {
  const sitting = pairs({ physics: [-4, -4, -4, -4], spatial: [0, 0.5, -0.5, 0], logic: [0.5, 0, 0, -0.5] }, 4);
  assert.equal(decideAbab(sitting, 'physics').verdict, 'KEPT (product)', 'the 3 % bars alone keep it');
  const wide = detectionLimits(pairs({ physics: [8, -8, 6, -6], spatial: [1, -1, 0, 0], logic: [0, 1, -1, 0] }, 4), 4);
  assert.equal(decideAbab(sitting, 'physics', null, wide).verdict, 'NEUTRAL (within the detection limit)');
  const narrow = detectionLimits(pairs({ physics: [1, -1, 0.5, -0.5], spatial: [1, -1, 0, 0], logic: [0, 1, -1, 0] }, 4), 4);
  assert.equal(decideAbab(sitting, 'physics', null, narrow).verdict, 'KEPT (product)');
});

test('--aa: a +4 % regression inside the limit does not block, past it it does', () => {
  const sitting = pairs({ physics: [-1, 0, 1, 0], spatial: [4, 4, 4, 4], logic: [0, 0.5, -0.5, 0], preRender: [0, 0, 0, 0] }, 4);
  assert.equal(decideAbab(sitting, 'physics').verdict, 'REGRESSION', 'the 3 % bars alone call it');
  const wide = detectionLimits(pairs({ physics: [1, -1, 0, 0], spatial: [9, -9, 7, -7], logic: [0, 1, -1, 0], preRender: [1, 0, -1, 0] }, 4), 4);
  const d = decideAbab(sitting, 'physics', null, wide);
  assert.notEqual(d.verdict, 'REGRESSION');
  assert.ok(d.kinds.spatial.limit && d.kinds.spatial.limit.limitPct > 4, 'the limit travels with the kind');
  const narrow = detectionLimits(pairs({ physics: [1, -1, 0, 0], spatial: [1, -1, 0.5, -0.5], logic: [0, 1, -1, 0], preRender: [1, 0, -1, 0] }, 4), 4);
  assert.equal(decideAbab(sitting, 'physics', null, narrow).verdict, 'REGRESSION');
});

test('clearsLimit: the against-others reading where there is one, the raw one otherwise, true without a limit', () => {
  assert.equal(clearsLimit({ pairedDeltaPct: -10, againstOthers: null }, null, -1), true);
  assert.equal(clearsLimit({ pairedDeltaPct: -10, againstOthers: { medianPct: -2 } }, { limitPct: 5, againstLimitPct: 3 }, -1), false);
  assert.equal(clearsLimit({ pairedDeltaPct: -2, againstOthers: { medianPct: -4 } }, { limitPct: 5, againstLimitPct: 3 }, -1), true);
  assert.equal(clearsLimit({ pairedDeltaPct: -6, againstOthers: null }, { limitPct: 5, againstLimitPct: null }, -1), true);
  assert.equal(clearsLimit({ pairedDeltaPct: 6, againstOthers: null }, { limitPct: 5, againstLimitPct: null }, -1), false);
});

test('--early with --aa: an owner -6 % in both pairs does not stop the sitting inside a wide limit', async () => {
  const { earlyStop } = await import('../../tests/bench/runPredatorAbab.mjs');
  const two = pairs({ physics: [-7, -8], spatial: [0, 1], logic: [1, 0] }, 2);
  assert.match(earlyStop(two, 'physics'), /physics at least -6 %/);
  const wide = detectionLimits(pairs({ physics: [9, -9, 7, -7], spatial: [1, -1, 0, 0], logic: [0, 1, -1, 0] }, 4), 2);
  assert.equal(earlyStop(two, 'physics', wide), null);
});
