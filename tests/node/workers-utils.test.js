import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RENDERER_STATS,
  SPATIAL_STATS,
  createStatsReader,
  createStatsWriter,
  createMultiWorkerStatsReaderArray,
  createMultiWorkerStatsWriter,
  getEntityHomeCellIndex,
} from '../../src/workers/workers-utils.js';

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
