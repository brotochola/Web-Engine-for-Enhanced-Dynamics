import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRestMs,
  WORKER_DISPLAY_CONFIG,
  SPATIAL_STATS,
  LOGIC_STATS,
  PRE_RENDER_STATS,
  PHYSICS_STATS,
  STAT_KIND,
} from '../../src/util/workersUtils.js';

// M3. The Performance panel's Rest is STEP_MS minus the time chips. It summed
// IDLE_MS, the gap between frames, so spatial, logic and pre-render read about
// -16 ms at 60 Hz; it also subtracted STAMP_LIGHTS_MS twice (inside SHADOW_Q_MS)
// and LIQUIDFUN_MS twice (inside BOX2D_MS). Numbers below are a real planet
// bench report (2026-10-20).

function viewOf(schema, values) {
  const view = new Float32Array(schema.STRIDE_FLOATS || 64);
  for (const [k, v] of Object.entries(values)) view[schema[k]] = v;
  return view;
}

const close = (a, b) => Math.abs(a - b) < 1e-4;

test('idle time between frames is not part of the step', () => {
  const spatial = viewOf(SPATIAL_STATS, { STEP_MS: 0.588, REBUILD_MS: 0.47, NEIGHBOR_MS: 0.11, IDLE_MS: 16.089 });
  assert.ok(close(computeRestMs(WORKER_DISPLAY_CONFIG.spatial, spatial, SPATIAL_STATS), 0.008));
  // TICK_MS (and rays, decimation, query waits) run inside ENTITY_MS.
  const logic = viewOf(LOGIC_STATS, { STEP_MS: 0.185, ENTITY_MS: 0.146, TICK_MS: 0.132, WAIT_MS: 0.01, IDLE_MS: 16.523 });
  assert.ok(close(computeRestMs(WORKER_DISPLAY_CONFIG.logic, logic, LOGIC_STATS), 0.039));
});

test('nested timers are not subtracted twice', () => {
  const pre = viewOf(PRE_RENDER_STATS, {
    STEP_MS: 1, SHADOW_Q_MS: 0.4, STAMP_LIGHTS_MS: 0.3, VISIBILITY_MS: 0.2, IDLE_MS: 15,
  });
  assert.ok(close(computeRestMs(WORKER_DISPLAY_CONFIG.preRender, pre, PRE_RENDER_STATS), 0.4));
  const physics = viewOf(PHYSICS_STATS, { STEP_MS: 0.625, BOX2D_MS: 0.376, LIQUIDFUN_MS: 0.176 });
  assert.ok(close(computeRestMs(WORKER_DISPLAY_CONFIG.physics, physics, PHYSICS_STATS), 0.249));
});

test('only step-partition chips are TIME', () => {
  for (const [worker, cfg] of Object.entries(WORKER_DISPLAY_CONFIG)) {
    for (const stat of cfg.stats || []) {
      if (stat.key === 'IDLE_MS') assert.equal(stat.kind, STAT_KIND.OUTSIDE, `${worker}.IDLE_MS`);
    }
  }
  const nested = (worker, key) => WORKER_DISPLAY_CONFIG[worker].stats.find((s) => s.key === key).kind;
  assert.equal(nested('preRender', 'STAMP_LIGHTS_MS'), STAT_KIND.NESTED);
  assert.equal(nested('physics', 'LIQUIDFUN_MS'), STAT_KIND.NESTED);
});
