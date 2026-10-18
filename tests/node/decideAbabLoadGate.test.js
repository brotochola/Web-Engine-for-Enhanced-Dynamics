// E-32: the load gate, and the two sittings it cost.
//
// `runPredatorAbab.mjs` decides `FAIL (load)` when a load key moves by more than
// 5%. The STEP_MS path has always guarded that comparison with the key's own
// coefficient of variation (`quiet = max(cvBase, cvHyp) <= 0.1`). The load path did
// not, and two sittings were lost to it:
//
//   E-05: DECAL_TILES_DIRTY 0.8 -> 1.0  -> FAIL (load), 25 % "mismatch"
//   E-17: DECAL_TILES_DIRTY 1.1 -> 0.8  -> FAIL (load), -27 % "mismatch"
//
// Neither was a load difference. Every other load key in both runs matched to
// within 0.1 %: BODY_COUNT 0.0 %, GPU_CASTERS 0.1 %, ACTIVE_DECORATIONS exactly
// 20 000 on both sides. Predator's dirty-decal count sits at about one tile, and
// a mean of ~1 cannot hold a 5 % band at any threshold.
//
// Two independent defects, and this file tests them separately because they are
// separable:
//
//   1. FLOOR. A key whose value is structurally too small to gate (DECAL_TILES_DIRTY
//      ~1, floored at 8; ACTIVE_PARTICLES ~100, floored at 1000).
//   2. NOISE. A key whose value is large enough but whose run-to-run spread exceeds
//      the delta. This one is the general fix - it needs no floor and applies to
//      every key - and it is the one most likely to be re-broken by someone
//      tightening the band back to a constant.
//
// The tests below are in that order of importance. `a real shift still fails the
// sitting` is the load-bearing one: a gate that cannot fire is worse than no gate,
// because it looks like a pass.
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
  // Muting must be bounded: noise widens the band, it does not disable the gate.
  // Here the key jitters by ~29 % but its median moves by 20 % in the same
  // direction as B's median in the previous test - i.e. that would be muted. A
  // delta of 300 % on a noisy key must still fire, or the gate can be defeated by
  // making the key noisier.
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

test('a delta inside the key\'s own noise is muted, not fatal', () => {
  // The median moves 20 % but one pair is an outlier that drags the spread wide.
  // Without the guard this read as a 20 % load mismatch.
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
  assert.ok(l.noisePct > 5, `expected a noisy key, got ${l.noisePct.toFixed(1)}%`);
  assert.ok(Math.abs(l.deltaPct) <= l.bandPct, 'the delta must be inside the band for this to be a mute');
  assert.equal(l.mutedBy, 'noise');
  assert.ok(
    !d.reasons.some((r) => r.includes('ENTITIES_PROCESSED')),
    'a muted key must not appear in reasons',
  );
  assert.ok(
    d.muted.some((s) => s.includes('ENTITIES_PROCESSED') && s.includes('noise')),
    `a muted key must be explained, not silently dropped: ${JSON.stringify(d.muted)}`,
  );
});

test('a muted key is still reported with its numbers, cv and band', () => {
  // The run says the load matched; the table says a key moved 20 %. Without the
  // cv and band on the same line that reads as a contradiction rather than a
  // decision, which is how the E-05/E-17 failures got mistaken for real findings.
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
  // It survives a JSON round trip - the summary is written to disk from this.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(d.load)));
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