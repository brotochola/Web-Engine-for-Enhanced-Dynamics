// N-407: the scoreboard's primaries read the exact-frame mean when both sides kept running totals, and the sampled mean
// on both sides when either did not (N-403: a spike frame every 16 hid from the 100 ms sampler).
import test from 'node:test';
import assert from 'node:assert/strict';

import { extractMetrics, rowEstimates, EXACT_SUFFIX } from '../../tests/bench/measureLib.mjs';

function worker(id, avg, exact) {
  return { id, type: id.replace(/\d+$/, ''), statsSamplesAverage: avg, ...(exact ? { exact } : {}) };
}

test('extractMetrics gives each primary its exact-frame twin, NaN where a worker kept no totals', () => {
  const report = {
    workers: [
      worker('physics', { STEP_MS: 2, WAIT_MS: 0.5, QUERY_WAKE_MS: 0.25 }, { workMs: 3, extraMs: 0.5, stepMs: 3, waitMs: 0 }),
      worker('logic0', { STEP_MS: 1 }, { workMs: 1.5 }),
      worker('spatial0', { STEP_MS: 1.3 }, { workMs: 3.02 }),
      worker('spatial1', { STEP_MS: 0.91 }, { workMs: 3.11 }),
      worker('preRender', { STEP_MS: 4 }),
    ],
  };
  const m = extractMetrics(report);
  assert.equal(m.physics_STEP_MS, 1.75, 'sampled: STEP_MS less WAIT_MS plus QUERY_WAKE_MS');
  assert.equal(m[`physics_STEP_MS${EXACT_SUFFIX}`], 3.5, 'exact: workMs plus extraMs on physics');
  assert.equal(m.logic0_STEP_MS_EXACT, 1.5);
  assert.equal(m.spatialMax_STEP_MS, 1.3, 'the sampled max');
  assert.equal(m.spatialMax_STEP_MS_EXACT, 3.11, 'the exact max, from the other worker');
  assert.ok(Number.isNaN(m.preRender_STEP_MS_EXACT), 'no totals: NaN');

  report.workers[3] = worker('spatial1', { STEP_MS: 0.91 });
  assert.ok(Number.isNaN(extractMetrics(report).spatialMax_STEP_MS_EXACT), 'one spatial worker without totals: no exact max');
});

test('rowEstimates reads exact only where both sides have it', () => {
  const stats = (median) => ({ median, mean: median, cv: 0, samples: [median] });
  const base = { spatialMax_STEP_MS: stats(1.3), spatialMax_STEP_MS_EXACT: stats(3.06), pixi_STEP_MS: stats(5) };
  const hyp = { spatialMax_STEP_MS: stats(4.1), spatialMax_STEP_MS_EXACT: stats(4.32), pixi_STEP_MS: stats(5.1), pixi_STEP_MS_EXACT: stats(6) };
  const est = rowEstimates(base, hyp, ['spatialMax_STEP_MS', 'pixi_STEP_MS']);
  assert.deepEqual(est.exact, ['spatialMax_STEP_MS']);
  assert.equal(est.base.spatialMax_STEP_MS.median, 3.06);
  assert.equal(est.hyp.spatialMax_STEP_MS.median, 4.32);
  assert.equal(est.base.pixi_STEP_MS.median, 5, 'the base has no exact pixi: both sides sampled');
  assert.equal(est.hyp.pixi_STEP_MS.median, 5.1);
  assert.equal(base.spatialMax_STEP_MS.median, 1.3, 'the summaries given are not changed');
});
