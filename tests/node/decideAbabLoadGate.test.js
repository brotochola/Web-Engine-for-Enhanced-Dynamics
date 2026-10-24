// E-32: the load gate, and the two sittings it cost.
//
// `runPredatorAbab.mjs` decides `FAIL (load)` when a load key moves by more than
// 5%, or when its coefficient of variation is 50% or higher. That is
// HOW_WE_MEASURE. The band does not widen with the key's own noise.
//
// Two sittings were lost to a count of about one dirty tile:
//
//   E-05: DECAL_TILES_DIRTY 0.8 -> 1.0  -> FAIL (load), 25 % "mismatch"
//   E-17: DECAL_TILES_DIRTY 1.1 -> 0.8  -> FAIL (load), -27 % "mismatch"
//
// Neither was a load difference. The floor mutes a key only when BOTH medians
// are under it. One side at or above the floor is a normal 5% check.
//
// E-32 in docs/internal/EXECUTION_PLAN.md.

import test from 'node:test';
import assert from 'node:assert/strict';

import { decideAbab } from '../../tests/bench/runPredatorAbab.mjs';

const KINDS = ['logic', 'spatial', 'physics', 'renderer', 'particle', 'preRender'];

/**
 * Build `pairs` with one worker's step times and a per-side load key.
 *
 * `loadA`/`loadB` are per-pair arrays because the whole point of this file is that
 * the gate now looks at how a key moves BETWEEN PAIRS, not just at its two
 * medians. A helper that put the same load on both sides could not express the
 * difference between "shifted" and "jittered", which is the distinction under test.
 */
function pairsWithLoad(kind, aVals, bVals, loadKey, loadA, loadB, quiet = true) {
  return aVals.map((a, i) => {
    const A = {};
    const B = {};
    for (const k of KINDS) {
      // `quiet` false makes the step times jittery too, for tests that care.
      A[`${k}_STEP_MS`] = k === kind ? a : 0.02;
      B[`${k}_STEP_MS`] = k === kind ? bVals[i] : 0.02;
    }
    if (loadKey) {
      A[loadKey] = loadA[i];
      B[loadKey] = loadB[i];
    }
    return { A, B };
  });
}

// ---------------------------------------------------------------------------
// 1. The two real failures
// ---------------------------------------------------------------------------

test('E-17: DECAL_TILES_DIRTY 1.1 -> 0.8 no longer fails the sitting', () => {
  // As shipped that run printed `- load DECAL_TILES_DIRTY -26.1%` and the verdict
  // was FAIL (load). The pre-render number was +3.1 % worse, 3/4 pairs - the run
  // had a finding in it and the gate hid it.
  const pairs = pairsWithLoad(
    'preRender',
    [7.472, 7.50, 7.46, 7.48],
    [7.794, 7.80, 7.79, 7.78],
    'DECAL_TILES_DIRTY',
    [1.1, 1.2, 1.0, 1.1],
    [0.8, 0.9, 0.7, 0.8],
  );
  const d = decideAbab(pairs, 'preRender');
  assert.equal(d.load.DECAL_TILES_DIRTY.mutedBy, 'floor', 'the key must be muted by its floor');
  assert.ok(
    !d.reasons.some((r) => r.includes('DECAL_TILES_DIRTY')),
    `DECAL_TILES_DIRTY must not invalidate the sitting, got ${JSON.stringify(d.reasons)}`,
  );
  assert.notEqual(d.verdict, 'FAIL (load)');
  // And the underlying result must still be visible - the fix is to un-hide a
  // regression, not to also lose it.
  assert.ok(d.regress.some((s) => s.includes('preRender')), `expected preRender to regress, got ${JSON.stringify(d.regress)}`);
});

test('E-05: DECAL_TILES_DIRTY 0.8 -> 1.0 no longer fails the sitting', () => {
  const pairs = pairsWithLoad(
    'preRender',
    [6.475, 6.48, 6.47, 6.47],
    [7.412, 7.40, 7.41, 7.42],
    'DECAL_TILES_DIRTY',
    [0.8, 0.8, 0.9, 0.7],
    [1.0, 1.1, 0.9, 1.0],
  );
  const d = decideAbab(pairs, 'preRender');
  assert.notEqual(d.verdict, 'FAIL (load)');
  assert.ok(!d.reasons.some((r) => r.includes('DECAL_TILES_DIRTY')));
});

// ---------------------------------------------------------------------------
// 2. A real shift still fails the sitting  (the load-bearing test)
// ---------------------------------------------------------------------------

test('a real shift still fails the sitting', () => {
  // ENTITIES_PROCESSED is not floored, so this exercises the NOISE path rather
  // than the floor. Every pair shifts by the same 20 %, so the cv is ~0 and the
  // delta is far above the 5 % band. This is the shape a genuine load mismatch
  // has, and it must still invalidate the sitting.
  const pairs = pairsWithLoad(
    'preRender',
    [7.0, 7.0, 7.0, 7.0],
    [7.0, 7.0, 7.0, 7.0],
    'ENTITIES_PROCESSED',
    [100, 100, 100, 100],
    [120, 121, 119, 120],
  );
  const d = decideAbab(pairs, 'preRender');
  assert.ok(
    d.load.ENTITIES_PROCESSED.noisePct < 5,
    `a consistent shift must have low noise, got ${d.load.ENTITIES_PROCESSED.noisePct.toFixed(1)}%`,
  );
  assert.equal(d.load.ENTITIES_PROCESSED.bandPct, 5, 'the band must stay at the plain 5 % for a quiet key');
  assert.equal(d.load.ENTITIES_PROCESSED.mutedBy, null);
  assert.ok(
    d.reasons.some((r) => r.includes('ENTITIES_PROCESSED')),
    `a real load shift must invalidate the sitting, got ${JSON.stringify(d.reasons)}`,
  );
  assert.equal(d.verdict, 'FAIL (load)');
});

test('a large shift still fails even when the key is noisy', () => {
  // Noise must not widen the band. A 300% move on a jittery key still fails.
  const pairs = pairsWithLoad(
    'preRender',
    [7.0, 7.0, 7.0, 7.0],
    [7.0, 7.0, 7.0, 7.0],
    'ENTITIES_PROCESSED',
    [100, 100, 100, 100],
    [400, 500, 350, 450],
  );
  const d = decideAbab(pairs, 'preRender');
  assert.ok(d.load.ENTITIES_PROCESSED.noisePct > 5, 'this test needs a noisy key to be meaningful');
  assert.ok(
    d.reasons.some((r) => r.includes('ENTITIES_PROCESSED')),
    `a large shift on a noisy key must still invalidate the sitting, got ${JSON.stringify(d.reasons)}`,
  );
});

// ---------------------------------------------------------------------------
// 3. The noise guard itself
// ---------------------------------------------------------------------------

test('a 20% shift fails even when one pair is an outlier', () => {
  // The median moves 20%. One pair is an outlier. The band stays 5%, so this
  // is a load failure, not a mute.
  const pairs = pairsWithLoad(
    'preRender',
    [7.0, 7.0, 7.0, 7.0],
    [7.0, 7.0, 7.0, 7.0],
    'ENTITIES_PROCESSED',
    [100, 100, 100, 100],
    [120, 120, 60, 120],
  );
  const d = decideAbab(pairs, 'preRender');
  const l = d.load.ENTITIES_PROCESSED;
  assert.equal(l.bandPct, 5);
  assert.equal(l.mutedBy, null);
  assert.ok(d.reasons.some((r) => r.includes('ENTITIES_PROCESSED')));
  assert.equal(d.verdict, 'FAIL (load)');
});

test('a failing key is still reported with its numbers, cv and band', () => {
  const pairs = pairsWithLoad(
    'preRender',
    [7.0, 7.0, 7.0, 7.0],
    [7.0, 7.0, 7.0, 7.0],
    'ENTITIES_PROCESSED',
    [100, 100, 100, 100],
    [120, 120, 60, 120],
  );
  const d = decideAbab(pairs, 'preRender');
  const l = d.load.ENTITIES_PROCESSED;
  for (const f of ['base', 'hyp', 'deltaPct', 'cvBase', 'cvHyp', 'noisePct', 'bandPct', 'gated', 'mutedBy']) {
    assert.ok(f in l, `load entries must carry ${f}`);
    assert.ok(l[f] === null || l[f] === undefined || typeof l[f] !== 'number' || Number.isFinite(l[f]), `${f} is not finite: ${l[f]}`);
  }
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(d.load)));
});

test('cv at or above 50% fails a gated key even when the median matches', () => {
  const pairs = pairsWithLoad(
    'preRender',
    [7.0, 7.0, 7.0, 7.0],
    [7.0, 7.0, 7.0, 7.0],
    'ENTITIES_PROCESSED',
    [100, 100, 100, 100],
    [10, 10, 190, 190],
  );
  const d = decideAbab(pairs, 'preRender');
  const l = d.load.ENTITIES_PROCESSED;
  assert.ok(Math.max(l.cvBase, l.cvHyp) >= 0.5);
  assert.ok(Math.abs(l.deltaPct) <= 5);
  assert.ok(d.reasons.some((r) => r.includes('ENTITIES_PROCESSED') && r.includes('cv')));
  assert.equal(d.verdict, 'FAIL (load)');
});

test('the band falls back to 5% when there are too few pairs to estimate noise', () => {
  // A cv from two pairs is itself mostly noise. Letting it widen the band would
  // let a 2-pair run pass anything, which is worse than the original bug.
  const pairs = pairsWithLoad(
    'preRender',
    [7.0, 7.0],
    [7.0, 7.0],
    'ENTITIES_PROCESSED',
    [100, 100],
    [120, 60],
  );
  const d = decideAbab(pairs, 'preRender');
  const l = d.load.ENTITIES_PROCESSED;
  assert.equal(l.bandPct, 5, 'too few pairs must not widen the band');
  assert.ok(
    d.reasons.some((r) => r.includes('ENTITIES_PROCESSED')),
    'a 2-pair run with a 20% median shift must still be caught by the plain band',
  );
});

test('the band never drops below 5%', () => {
  const pairs = pairsWithLoad(
    'preRender',
    [7.0, 7.0, 7.0, 7.0],
    [7.0, 7.0, 7.0, 7.0],
    'ENTITIES_PROCESSED',
    [100, 100, 100, 100],
    [100, 100, 100, 100],
  );
  const d = decideAbab(pairs, 'preRender');
  for (const [key, l] of Object.entries(d.load)) {
    assert.ok(l.bandPct >= 5, `${key} band ${l.bandPct} is below 5%`);
  }
});

// ---------------------------------------------------------------------------
// 4. The floor is still a floor
// ---------------------------------------------------------------------------

test('ACTIVE_PARTICLES keeps its floor', () => {
  // Predator emits ~100 particles. The floor predates E-32 and must survive it -
  // the fix is additive, not a replacement of the existing guard.
  const pairs = pairsWithLoad(
    'preRender',
    [7.0, 7.0, 7.0, 7.0],
    [7.0, 7.0, 7.0, 7.0],
    'ACTIVE_PARTICLES',
    [100, 110, 90, 100],
    [200, 180, 220, 190],
  );
  const d = decideAbab(pairs, 'preRender');
  assert.equal(d.load.ACTIVE_PARTICLES.mutedBy, 'floor');
  assert.ok(!d.reasons.some((r) => r.includes('ACTIVE_PARTICLES')));
});

test('a base under the floor still fails when the other side is above it', () => {
  const pairs = pairsWithLoad(
    'preRender',
    [7.0, 7.0, 7.0, 7.0],
    [7.0, 7.0, 7.0, 7.0],
    'ACTIVE_PARTICLES',
    [100, 110, 90, 100],
    [5000, 5100, 4900, 5000],
  );
  const d = decideAbab(pairs, 'preRender');
  assert.notEqual(d.load.ACTIVE_PARTICLES.mutedBy, 'floor');
  assert.ok(d.reasons.some((r) => r.includes('ACTIVE_PARTICLES')));
  assert.equal(d.verdict, 'FAIL (load)');
});

test('a floored key comes back under the gate once its base is large enough', () => {
  // The floor must be a floor, not a permanent exemption. The same key at a large
  // base, shifting consistently, has to invalidate the sitting.
  const pairs = pairsWithLoad(
    'preRender',
    [7.0, 7.0, 7.0, 7.0],
    [7.0, 7.0, 7.0, 7.0],
    'ACTIVE_PARTICLES',
    [50000, 50010, 49990, 50000],
    [60000, 60010, 59990, 60000],
  );
  const d = decideAbab(pairs, 'preRender');
  assert.notEqual(d.load.ACTIVE_PARTICLES.mutedBy, 'floor');
  assert.ok(d.reasons.some((r) => r.includes('ACTIVE_PARTICLES')));
});

// ---------------------------------------------------------------------------
// 5. Nothing regressed
// ---------------------------------------------------------------------------

test('a sitting with every load key matched is still NEUTRAL / KEPT as before', () => {
  const load = pairsWithLoad(
    'preRender',
    [7.0, 7.0, 7.0, 7.0],
    [6.5, 6.5, 6.5, 6.5],
    null,
    null,
    null,
  );
  const d = decideAbab(load, 'preRender');
  assert.equal(d.verdict, 'KEPT (product)');
  assert.deepEqual(d.reasons, []);
  assert.deepEqual(d.muted, []);
});

test('STEP_MS verdicts are untouched by the load-gate change', () => {
  // The gate change must not have touched the regression path. A +3% quiet
  // regression on the owner is still a REGRESSION.
  const pairs = pairsWithLoad(
    'preRender',
    [7.0, 7.0, 7.0, 7.0],
    [7.5, 7.5, 7.5, 7.5],
    null,
    null,
    null,
  );
  const d = decideAbab(pairs, 'preRender');
  assert.equal(d.verdict, 'REGRESSION');
});
// ---------------------------------------------------------------------------
// Review M6: two gate branches no test reached
// ---------------------------------------------------------------------------

test('a load key missing from some pairs fails the sitting', () => {
  // One B run did not publish the key. A median over the runs that did would
  // look matched; the gate refuses instead of judging on a partial set.
  const pairs = pairsWithLoad(
    'preRender',
    [7.0, 7.0, 7.0, 7.0],
    [7.0, 7.0, 7.0, 7.0],
    'ENTITIES_PROCESSED',
    [100, 100, 100, 100],
    [100, 100, 100, 100],
  );
  delete pairs[2].B.ENTITIES_PROCESSED;
  const d = decideAbab(pairs, 'preRender');
  assert.ok(d.reasons.includes('load ENTITIES_PROCESSED missing'), JSON.stringify(d.reasons));
  assert.equal(d.verdict, 'FAIL (load)');
});

test('a zero baseline against a non-zero hypothesis fails the sitting', () => {
  // No percentage exists against 0, so this is its own rule: the hypothesis
  // ran work the baseline never did.
  const pairs = pairsWithLoad(
    'preRender',
    [7.0, 7.0, 7.0, 7.0],
    [7.0, 7.0, 7.0, 7.0],
    'ENTITIES_PROCESSED',
    [0, 0, 0, 0],
    [500, 500, 500, 500],
  );
  const d = decideAbab(pairs, 'preRender');
  assert.equal(d.load.ENTITIES_PROCESSED.deltaPct, null);
  assert.ok(d.reasons.includes('load ENTITIES_PROCESSED 0 -> 500'), JSON.stringify(d.reasons));
  assert.equal(d.verdict, 'FAIL (load)');
});

// ---------------------------------------------------------------------------
// A load key as the owner (E-122): a deadline-bound search computes more per frame, its STEP_MS holds

test('a load key named as the owner is the claim: judged higher-is-better, out of the drift check', () => {
  // navStress: the particle worker runs to its 8 ms deadline either way; the flowfields it fits rise 6x.
  const pairs = pairsWithLoad('particle', [8.5, 8.6, 8.4, 8.5], [8.4, 8.5, 8.5, 8.4],
    'FLOWFIELDS_COMPUTED', [6.0, 6.1, 5.9, 6.0], [36.0, 37.5, 35.8, 36.4]);
  const asLoad = decideAbab(pairs, 'particle');
  assert.equal(asLoad.verdict, 'FAIL (load)', 'with a worker as the owner the count is load, and it moved');
  const owned = decideAbab(pairs, 'FLOWFIELDS_COMPUTED');
  assert.equal(owned.verdict, 'KEPT (product)');
  assert.ok(owned.throughput.pairedDeltaPct > 400);
  assert.equal(owned.throughput.higherFraction, 1);
  assert.equal(owned.load.FLOWFIELDS_COMPUTED.mutedBy, 'owner');

  const fewer = pairsWithLoad('particle', [8.5, 8.6, 8.4, 8.5], [8.4, 8.5, 8.5, 8.4],
    'FLOWFIELDS_COMPUTED', [6.0, 6.1, 5.9, 6.0], [5.0, 5.1, 4.9, 5.2]);
  assert.equal(decideAbab(fewer, 'FLOWFIELDS_COMPUTED').verdict, 'REGRESSION', 'fewer flowfields a frame');
  const flat = pairsWithLoad('particle', [8.5, 8.6, 8.4, 8.5], [8.4, 8.5, 8.5, 8.4],
    'FLOWFIELDS_COMPUTED', [6.0, 6.1, 5.9, 6.0], [6.1, 6.0, 6.0, 6.1]);
  assert.equal(decideAbab(flat, 'FLOWFIELDS_COMPUTED').verdict, 'NEUTRAL');
});
