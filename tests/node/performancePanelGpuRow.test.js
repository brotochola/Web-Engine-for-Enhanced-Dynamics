/**
 * DBG-11: the Performance tab's GPU row prints the renderer's always-on counters RENDERER_STATS publishes (mesh fill,
 * scenery, decal tiles, input lag, besides the passes, casters and shadow lights), and its title names the GPU the
 * page got, the backend and the opaque pass's setting for that GPU.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RENDERER_STATS, WORKER_DISPLAY_CONFIG, STAT_KIND } from '../../src/util/workersUtils.js';
import { gpuRowTitle } from '../../src/core/debug/panels/performancePanel.js';

test('the GPU row lists the renderer counters that need no detailed stats, each a published slot', () => {
  const keys = WORKER_DISPLAY_CONFIG.gpu.stats.map((s) => s.key);
  for (const key of [
    'GPU_PASSES', 'GPU_CASTERS', 'GPU_SHADOW_LIGHTS', 'MESH_FILL_INSTANCES', 'MESH_RT_DRAWS', 'SCENERY_COUNT',
    'DECAL_TILES_DIRTY', 'DECAL_TILES_UPLOADED', 'INPUT_LAG_MS', 'INPUT_LAG_P95_MS',
  ]) {
    assert.ok(keys.includes(key), key);
    assert.ok(Number.isInteger(RENDERER_STATS[key]), `${key} is a RENDERER_STATS slot`);
  }
  // No time chip: the GPU row has no clock to take a rest from, and input lag is not part of a step.
  assert.ok(WORKER_DISPLAY_CONFIG.gpu.stats.every((s) => s.kind !== STAT_KIND.TIME));
});

test('the GPU row title: the GPU, the backend and the opaque pass for that GPU', () => {
  const scene = (gpu, opaquePass) => ({ gpu, config: { debug: { opaquePass } } });
  const gtx = { backend: 'webgl', name: 'NVIDIA GeForce GTX 1650', vendor: 'nvidia', kind: 'discrete' };
  const hd620 = { backend: 'webgl', name: 'Intel(R) HD Graphics 620', vendor: 'intel', kind: 'integrated' };
  assert.equal(gpuRowTitle(scene(gtx)), 'GPU NVIDIA GeForce GTX 1650 · webgl · opaque pass on');
  assert.equal(gpuRowTitle(scene(hd620)), 'GPU Intel(R) HD Graphics 620 · webgl · opaque pass off');
  assert.equal(gpuRowTitle(scene(hd620, true)), 'GPU Intel(R) HD Graphics 620 · webgl · opaque pass on');
  assert.equal(gpuRowTitle(scene(gtx, false)), 'GPU NVIDIA GeForce GTX 1650 · webgl · opaque pass off');
  assert.equal(gpuRowTitle(scene({ ...gtx, backend: 'webgpu' })), 'GPU NVIDIA GeForce GTX 1650 · webgpu · opaque pass off (WebGL only)');
  assert.equal(gpuRowTitle({ gpu: null }), 'GPU', 'before the renderer reports its GPU');
});
