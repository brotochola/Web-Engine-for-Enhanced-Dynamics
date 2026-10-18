import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RENDERER_STATS,
  SPATIAL_STATS,
  PRE_RENDER_STATS,
  createStatsReader,
  createStatsWriter,
  createMultiWorkerStatsReaderArray,
  createMultiWorkerStatsWriter,
  getEntityHomeCellIndex,
} from '../../src/util/workersUtils.js';

test('single-worker stats readers share the same buffer layout', () => {
  const buffer = new SharedArrayBuffer(RENDERER_STATS.BUFFER_SIZE);
  const writer = createStatsWriter(buffer, RENDERER_STATS);
  const reader = createStatsReader(buffer, RENDERER_STATS);

  writer[RENDERER_STATS.FPS] = 144.5;
  writer[RENDERER_STATS.DRAW_CALLS] = 321;
  writer[RENDERER_STATS.MSG_MS] = 2.5;

  assert.equal(reader[RENDERER_STATS.FPS], 144.5);
  assert.equal(reader[RENDERER_STATS.DRAW_CALLS], 321);
  assert.equal(reader[RENDERER_STATS.MSG_MS], 2.5);
});

test('RENDERER_STATS peel load keys sit inside stride 39', () => {
  assert.equal(RENDERER_STATS.DECAL_TILES_DIRTY, 16);
  assert.equal(RENDERER_STATS.DECAL_TILES_UPLOADED, 17);
  assert.equal(RENDERER_STATS.SCENERY_COUNT, 18);
  assert.equal(RENDERER_STATS.MESH_FILL_INSTANCES, 19);
  assert.equal(RENDERER_STATS.MESH_RT_DRAWS, 20);
  assert.equal(RENDERER_STATS.SORT_MS, 21);
  assert.equal(RENDERER_STATS.QUEUE_MS, 22);
  assert.equal(RENDERER_STATS.PRESENT_MS, 23);
  assert.equal(RENDERER_STATS.GPU_CUSTOM_MS, 32);
  assert.equal(RENDERER_STATS.GPU_TIMER, 33);
  assert.equal(RENDERER_STATS.GPU_SORT_MS, 34);
  assert.equal(RENDERER_STATS.LAST_UPLOAD_MS, 35);
  assert.equal(RENDERER_STATS.NEW_QUEUE, 36);
  // E-01 took 37 (WAIT_MS) and 38 (IDLE_MS), so the stride moved 37 -> 39.
  assert.equal(RENDERER_STATS.WAIT_MS, 37);
  assert.equal(RENDERER_STATS.IDLE_MS, 38);
  assert.equal(RENDERER_STATS.STRIDE_FLOATS, 39);
  assert.equal(RENDERER_STATS.BUFFER_SIZE, 39 * 4);
  const buffer = new SharedArrayBuffer(RENDERER_STATS.BUFFER_SIZE);
  const writer = createStatsWriter(buffer, RENDERER_STATS);
  const reader = createStatsReader(buffer, RENDERER_STATS);
  writer[RENDERER_STATS.DECAL_TILES_UPLOADED] = 48;
  writer[RENDERER_STATS.MESH_RT_DRAWS] = 1;
  assert.equal(reader[RENDERER_STATS.DECAL_TILES_UPLOADED], 48);
  assert.equal(reader[RENDERER_STATS.MESH_RT_DRAWS], 1);
});

test('multi-worker stats views stay isolated by worker stride', () => {
  const workerCount = 2;
  const buffer = new SharedArrayBuffer(
    SPATIAL_STATS.BUFFER_SIZE_PER_WORKER * workerCount
  );
  const worker0 = createMultiWorkerStatsWriter(buffer, SPATIAL_STATS, 0);
  const worker1 = createMultiWorkerStatsWriter(buffer, SPATIAL_STATS, 1);
  const readers = createMultiWorkerStatsReaderArray(buffer, SPATIAL_STATS, workerCount);

  worker0[SPATIAL_STATS.FPS] = 61;
  worker0[SPATIAL_STATS.ENTITIES_PROCESSED] = 610;
  worker1[SPATIAL_STATS.FPS] = 119;
  worker1[SPATIAL_STATS.ENTITIES_PROCESSED] = 2380;

  assert.equal(readers[0][SPATIAL_STATS.FPS], 61);
  assert.equal(readers[0][SPATIAL_STATS.ENTITIES_PROCESSED], 610);
  assert.equal(readers[1][SPATIAL_STATS.FPS], 119);
  assert.equal(readers[1][SPATIAL_STATS.ENTITIES_PROCESSED], 2380);
});

test('getEntityHomeCellIndex returns -1 when out of bounds', () => {
  assert.equal(getEntityHomeCellIndex(10, 10, 0.1, 4, 4), 5);
  assert.equal(getEntityHomeCellIndex(-11, 10, 0.1, 4, 4), -1);
  assert.equal(getEntityHomeCellIndex(10, 999, 0.1, 4, 4), -1);
});

test('PRE_RENDER_STATS sprite pack sits past the old stride', () => {
  assert.equal(PRE_RENDER_STATS.ADOBE_MS, 15);
  assert.equal(PRE_RENDER_STATS.WAIT_MS, 16);
  assert.equal(PRE_RENDER_STATS.SPRITE_PACK_MS, 17);
  // E-01 took 18 (IDLE_MS), so the stride moved 18 -> 19. WAIT_MS stays at 16:
  // it is still 0 by construction for pre-render (its only sibling wait is the
  // backpressure skip, counted as SKIPPED_FRAMES), but it is now a documented
  // zero rather than an accidental one.
  assert.equal(PRE_RENDER_STATS.IDLE_MS, 18);
  // E-29 took 19 and 20 (VISIBLE_LIGHTS_MS, STAMP_LIGHTS_MS), so the stride moved
  // 19 -> 21. Appending rather than renumbering is the point: slots 0-18 keep their
  // indices, so a saved sitting's sub-timer still means what it meant when it was
  // recorded. `preRenderLightTimers.test.js` pins that explicitly.
  assert.equal(PRE_RENDER_STATS.VISIBLE_LIGHTS_MS, 19);
  assert.equal(PRE_RENDER_STATS.STAMP_LIGHTS_MS, 20);
  assert.equal(PRE_RENDER_STATS.STRIDE_FLOATS, 21);
  assert.equal(PRE_RENDER_STATS.BUFFER_SIZE, 21 * 4);
  assert.equal(PRE_RENDER_STATS.BUFFER_SIZE_PER_WORKER, 21 * 4);
});
