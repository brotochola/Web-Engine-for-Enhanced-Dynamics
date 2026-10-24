import test from 'node:test';
import assert from 'node:assert/strict';

import { decideAbab, predatorMetrics } from '../../tests/bench/runPredatorAbab.mjs';

/**
 * The gate is the last thing standing between a hypothesis and a verdict written
 * down as fact, so its rules are tested rather than trusted.
 *
 * Two of these tests use numbers from real sittings that went wrong:
 *   - H-14 reported `spatial` at -21.0 % on a 0.238 ms base.
 *   - H-10's first sitting refused with "ACTIVE_DECORATIONS is 0" on a run whose
 *     own output said `decorations=65000`.
 */

const KINDS = ['logic', 'spatial', 'physics', 'renderer', 'particle', 'preRender'];

/** Build `pairs` so one worker has the requested step times and the rest idle. */
function pairsWith(kind, aVals, bVals, extra = {}) {
  return aVals.map((a, i) => {
    const A = {};
    const B = {};
    for (const k of KINDS) {
      A[`${k}_STEP_MS`] = k === kind ? a : 0.02;
      B[`${k}_STEP_MS`] = k === kind ? bVals[i] : 0.02;
    }
    return { A: { ...A, ...extra }, B: { ...B, ...extra } };
  });
}

test('the idle-worker case from H-14 is refused as a verdict', () => {
  // spatial at -21% on a 0.238 ms base. 21% of 0.238 ms is 0.05 ms of work in a
  // 16.7 ms frame. The old code would have called this a win.
  const pairs = pairsWith('spatial', [0.238, 0.240, 0.236, 0.239], [0.188, 0.19, 0.187, 0.19]);
  const d = decideAbab(pairs, 'spatial');
  assert.equal(d.verdict, 'NEUTRAL (below floor)');
  assert.equal(d.kinds.spatial.interpretable, false);
  assert.equal(d.ownerJudged, false);
  assert.ok(
    d.belowFloor.some((s) => s.includes('spatial') && s.includes('0.238')),
    `the refusal must name the worker and its base, got ${JSON.stringify(d.belowFloor)}`,
  );
});

test('a below-floor owner cannot earn KEPT even when it is clearly faster', () => {
  // A 40% improvement on a 1.4 ms base. Large, consistent, and unjudgeable:
  // docs/HOW_WE_MEASURE.md:79 forbids keeping on a sub-floor pair.
  const pairs = pairsWith('particle', [1.4, 1.41, 1.39, 1.4], [0.84, 0.85, 0.83, 0.84]);
  const d = decideAbab(pairs, 'particle');
  assert.notEqual(d.verdict, 'KEPT (product)');
  assert.equal(d.verdict, 'NEUTRAL (below floor)');
  // The delta is still reported - hiding it would be worse than not judging it.
  assert.ok(Math.abs(d.kinds.particle.pairedDeltaPct + 40) < 1);
});

test('a deep owner with a real improvement is KEPT', () => {
  const pairs = pairsWith('preRender', [8.5, 8.4, 8.6, 8.5], [7.2, 7.1, 7.3, 7.2]);
  const d = decideAbab(pairs, 'preRender');
  assert.equal(d.verdict, 'KEPT (product)');
  assert.equal(d.kinds.preRender.interpretable, true);
});

test('a real regression on a deep owner is REGRESSION', () => {
  const pairs = pairsWith('preRender', [8.0, 8.1, 8.0, 8.0], [9.2, 9.3, 9.1, 9.2]);
  const d = decideAbab(pairs, 'preRender');
  assert.equal(d.verdict, 'REGRESSION');
  assert.ok(d.regress.some((s) => s.startsWith('preRender')));
});

test('exactly at the floor counts as interpretable', () => {
  const pairs = pairsWith('renderer', [3.0, 3.0, 3.0, 3.0], [3.0, 3.0, 3.0, 3.0]);
  const d = decideAbab(pairs, 'renderer');
  assert.equal(d.kinds.renderer.interpretable, true, 'the floor is inclusive');
});

test('just under the floor is not', () => {
  const pairs = pairsWith('renderer', [2.99, 2.99, 2.99, 2.99], [2.99, 2.99, 2.99, 2.99]);
  const d = decideAbab(pairs, 'renderer');
  assert.equal(d.kinds.renderer.interpretable, false);
});

test('a load-key shift outranks everything', () => {
  // BODY_COUNT moving >5% invalidates the pair whatever the timings say.
  // Every pair shifts: the gate compares MEDIANS, so a single outlier pair leaves
  // the median untouched and is correctly not treated as a load shift.
  const pairs = pairsWith('preRender', [8.5, 8.5, 8.5, 8.5], [7.0, 7.0, 7.0, 7.0]).map((p) => ({
    A: { ...p.A, BODY_COUNT: 1000 },
    B: { ...p.B, BODY_COUNT: 1100 },
  }));
  const d = decideAbab(pairs, 'preRender');
  assert.equal(d.verdict, 'FAIL (load)');
  assert.ok(d.reasons.some((r) => r.includes('BODY_COUNT')));
});

test('one outlier pair is not a load shift', () => {
  // The complement of the test above, and the reason it is worth stating: the
  // median is deliberately robust, so a single drifted pair is noise.
  const pairs = pairsWith('preRender', [8.5, 8.5, 8.5, 8.5], [7.0, 7.0, 7.0, 7.0]).map((p, i) => ({
    A: { ...p.A, BODY_COUNT: 1000 },
    B: { ...p.B, BODY_COUNT: i === 0 ? 1400 : 1000 },
  }));
  const d = decideAbab(pairs, 'preRender');
  assert.equal(d.verdict, 'KEPT (product)');
  assert.equal(d.reasons.length, 0);
});

test('every LOAD_KEY the workers publish is extracted, not a hand-picked few', () => {
  // The H-10 refusal: the probe needed ACTIVE_DECORATIONS, the gate listed it,
  // and the extractor never collected it - so it read 0 on a run that said
  // decorations=65000. A key absent from the workers' stats must stay ABSENT
  // rather than becoming a confident zero that fails a probe.
  const report = {
    workers: [
      {
        type: 'particle',
        statsSamplesAverage: { STEP_MS: 1.36, ACTIVE_DECORATIONS: 65000, ACTIVE_PARTICLES: 0 },
      },
      {
        type: 'preRender',
        statsSamplesAverage: { STEP_MS: 8.4, RENDER_QUEUE_SIZE: 45568, COLLECT_MS: 3.9 },
      },
      { type: 'renderer', statsSamplesAverage: { STEP_MS: 1.1, VISIBLE_ENTITIES: 45568 } },
    ],
  };
  const m = predatorMetrics(report);
  assert.equal(m.ACTIVE_DECORATIONS, 65000);
  assert.equal(m.RENDER_QUEUE_SIZE, 45568);
  assert.equal(m.VISIBLE_ENTITIES, 45568);
  // Never published by any worker, so it must not appear at all.
  assert.equal('DECORATIONS_ACTIVE' in m, false);
  assert.equal('BODY_COUNT' in m, false);
});

test('multiple workers publishing the same key do not clobber each other', () => {
  // physics and renderer can both be present; the max is the meaningful figure,
  // and a later zero must not erase an earlier real value.
  const m = predatorMetrics({
    workers: [
      { type: 'renderer', statsSamplesAverage: { STEP_MS: 1, VISIBLE_ENTITIES: 45568 } },
      { type: 'preRender', statsSamplesAverage: { STEP_MS: 8, VISIBLE_ENTITIES: 0 } },
    ],
  });
  assert.equal(m.VISIBLE_ENTITIES, 45568);
});

test('a report with no workers yields zeros, not a crash', () => {
  const m = predatorMetrics({});
  for (const k of KINDS) assert.equal(m[`${k}_STEP_MS`], 0);
});
test('fewer presented frames is a regression even when the owner wins (E-82)', () => {
  // The E-82 sitting: Pixi 13.6 -> 3.2 ms while the page went from ~55 to ~44 fps.
  const pairs = pairsWith('renderer', [13.6, 14.4, 11.7, 16.1], [3.4, 3.0, 2.9, 3.8]);
  [55.1, 54.2, 55.4, 54.8].forEach((f, i) => { pairs[i].A.MAIN_FPS = f; });
  [44.2, 43.7, 44.4, 44.2].forEach((f, i) => { pairs[i].B.MAIN_FPS = f; });
  const d = decideAbab(pairs, 'renderer');
  assert.equal(d.verdict, 'REGRESSION');
  assert.ok(d.regress.some((r) => r.startsWith('presented frames -')), JSON.stringify(d.regress));
  assert.equal(d.presented.lowerFraction, 1);
});

test('--owner presented keeps a consistent rise in presented frames', () => {
  const pairs = pairsWith('renderer', [13.6, 14.4, 11.7, 16.1], [4.4, 4.5, 4.3, 4.6]);
  [55.1, 54.2, 55.4, 54.8].forEach((f, i) => { pairs[i].A.MAIN_FPS = f; });
  [59.9, 60.0, 59.8, 59.9].forEach((f, i) => { pairs[i].B.MAIN_FPS = f; });
  const d = decideAbab(pairs, 'presented');
  assert.equal(d.verdict, 'KEPT (product)');
  assert.ok(d.presented.pairedDeltaPct > 8);
});

test('presented frames are judged only when every pair has them', () => {
  const pairs = pairsWith('renderer', [13.6, 14.4, 11.7, 16.1], [3.4, 3.0, 2.9, 3.8]);
  pairs[0].A.MAIN_FPS = 55;
  pairs[0].B.MAIN_FPS = 30;
  const d = decideAbab(pairs, 'renderer');
  assert.equal(d.presented, null);
  assert.equal(d.verdict, 'KEPT (product)');
});

test('predatorMetrics reads the main thread\'s FPS as the presented frames', () => {
  const m = predatorMetrics({ workers: [], mainThread: { averageFPS: 57.5 } });
  assert.equal(m.MAIN_FPS, 57.5);
  assert.equal('MAIN_FPS' in predatorMetrics({ workers: [] }), false);
});

test('predatorMetrics: the exact primary is step minus wait, plus query wake on physics, worst worker of a kind', () => {
  const ex = (stepMs, waitMs, extraMs, p95Ms = 9, frames = 600) => ({ frames, stepMs, waitMs, extraMs, workMs: stepMs - waitMs, p50Ms: 5, p95Ms });
  const m = predatorMetrics({
    workers: [
      { type: 'logic', statsSamplesAverage: { STEP_MS: 5.9 }, exact: ex(6, 1, 0, 8) },
      { type: 'logic', statsSamplesAverage: { STEP_MS: 5.1 }, exact: ex(5.5, 0, 0, 11) },
      { type: 'physics', statsSamplesAverage: { STEP_MS: 7.7 }, exact: ex(8, 0.5, 0.25) },
      { type: 'spatial', statsSamplesAverage: { STEP_MS: 3.3 }, exact: ex(3.4, 0, 0) },
      { type: 'spatial', statsSamplesAverage: { STEP_MS: 3.1 }, exact: null },
    ],
    mainThread: { averageFPS: 58.2, exactFPS: 59.4 },
  });
  assert.equal(m.logic_STEP_MS_EXACT, 5.5);
  assert.equal(m.logic_P95_MS, 11);
  assert.equal(m.logic_STEP_MS_SAMPLED, 5.9);
  assert.equal(m.logic_STEP_MS, 5.5);
  assert.equal(m.physics_STEP_MS_EXACT, 7.75);
  // One spatial worker without totals: the kind stays sampled.
  assert.equal('spatial_STEP_MS_EXACT' in m, false);
  assert.equal(m.spatial_STEP_MS, 3.3);
  assert.equal(m.MAIN_FPS, 59.4);
  assert.equal(m.MAIN_FPS_SAMPLED, 58.2);
});

test('decideAbab reads the exact primary only when every side of every pair has it', () => {
  const both = pairsWith('preRender', [8, 8.1, 7.9, 8], [7, 7.1, 6.9, 7]);
  for (const p of both) {
    for (const side of ['A', 'B']) {
      for (const k of KINDS) {
        p[side][`${k}_STEP_MS_SAMPLED`] = p[side][`${k}_STEP_MS`];
        p[side][`${k}_STEP_MS_EXACT`] = p[side][`${k}_STEP_MS`] * 1.1;
      }
    }
  }
  let d = decideAbab(both, 'preRender');
  assert.equal(d.kinds.preRender.source, 'exact');
  assert.ok(Math.abs(d.kinds.preRender.baseMedian - 8.8) < 1e-9);
  // A baseline revision without the totals: every pair of that kind falls back to the samples, on both sides.
  delete both[2].A.preRender_STEP_MS_EXACT;
  d = decideAbab(both, 'preRender');
  assert.equal(d.kinds.preRender.source, 'sampled');
  assert.equal(d.kinds.preRender.baseMedian, 8);
  assert.equal(d.verdict, 'KEPT (product)');
});

test('sideQuery: a side\'s parameters on top of the shared query', async () => {
  const { sideQuery } = await import('../../tests/bench/runPredatorAbab.mjs');
  assert.equal(sideQuery('sprites=250000', ''), 'sprites=250000');
  assert.equal(sideQuery('?sprites=250000', null), 'sprites=250000');
  assert.equal(sideQuery('sprites=250000', 'wasmOff=gpuPack,shadowStamp'), 'sprites=250000&wasmOff=gpuPack,shadowStamp');
  assert.equal(sideQuery('sprites=250000&wasmOff=gpuPack', 'wasmOff=shadowStamp'), 'sprites=250000&wasmOff=shadowStamp');
  assert.equal(sideQuery('', 'wasmOff=gpuPack'), 'wasmOff=gpuPack');
});
