import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMetrics } from '../bench/measureLib.mjs';

// N-311: the scoreboard judges each worker by its own work (STEP_MS - WAIT_MS, + QUERY_WAKE_MS on physics), as
// HOW_WE_MEASURE's primary and runPredatorAbab do, not by the raw step that counts the frame chain's waits as cost.

const report = (workers) => ({ workers: workers.map(([id, type, avg]) => ({ id, type, statsSamplesAverage: avg })) });

test('every worker key is the step less its waits; physics adds the queries answered between steps', () => {
  const m = extractMetrics(
    report([
      ['physics', 'physics', { STEP_MS: 9, WAIT_MS: 2, QUERY_WAKE_MS: 0.5, BODY_COUNT: 100 }],
      ['logic0', 'logic', { STEP_MS: 0.378, WAIT_MS: 0.15 }],
      ['particle', 'particle', { STEP_MS: 1.2, WAIT_MS: 0 }],
      ['preRender', 'preRender', { STEP_MS: 7, WAIT_MS: 0.9 }],
      ['renderer', 'pixi', { STEP_MS: 5.582, WAIT_MS: 4.995 }],
      ['spatial0', 'spatial', { STEP_MS: 12, WAIT_MS: 7.1 }],
      ['spatial1', 'spatial', { STEP_MS: 11.5, WAIT_MS: 5 }],
    ]),
  );
  assert.equal(m.physics_STEP_MS, 7.5);
  assert.ok(Math.abs(m.logic0_STEP_MS - 0.228) < 1e-12);
  assert.equal(m.particle_STEP_MS, 1.2);
  assert.ok(Math.abs(m.preRender_STEP_MS - 6.1) < 1e-12);
  // meshFillMoving's renderer on the main PC (R-1472): its own work is about half a millisecond, not 5.6 ms.
  assert.ok(Math.abs(m.pixi_STEP_MS - 0.587) < 1e-12);
  // The busiest spatial worker by its own work (spatial1's 6.5 ms), not by its raw step (spatial0's 12 ms).
  assert.equal(m.spatialMax_STEP_MS, 6.5);
  // The waits stay readable, and the load share is the raw step's.
  assert.equal(m.WAIT_MS, 7.1);
  assert.equal(m.physics_WAIT_MS, 2);
  assert.equal(m.BODY_COUNT, 100);
});

test('a revision that publishes no WAIT_MS reads its whole step as work; a missing worker reads 0', () => {
  const m = extractMetrics(report([['renderer', 'pixi', { STEP_MS: 1.03 }]]));
  assert.equal(m.pixi_STEP_MS, 1.03);
  assert.equal(m.physics_STEP_MS, 0);
  assert.equal(m.spatialMax_STEP_MS, 0);
});
