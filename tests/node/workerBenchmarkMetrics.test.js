import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStatsWriter,
  createMultiWorkerStatsWriter,
  PHYSICS_STATS,
  RENDERER_STATS,
  PARTICLE_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
  PRE_RENDER_STATS,
} from '../../src/workers/workers-utils.js';
import {
  getWorkerFrameRateLayout,
  createWorkerBenchmarkReader,
  summarizeWorkerBenchmarkWindow,
} from '../../src/core/benchmark/workerBenchmarkMetrics.js';

function createBenchmarkSceneStub() {
  const scene = {
    constructor: { name: 'BenchmarkSceneStub' },
    config: {
      spatial: { numberOfSpatialWorkers: 2 },
      logic: { numberOfLogicWorkers: 2 },
    },
    numberOfLogicWorkers: 2,
    buffers: {
      physicsStats: new SharedArrayBuffer(PHYSICS_STATS.BUFFER_SIZE),
      rendererStats: new SharedArrayBuffer(RENDERER_STATS.BUFFER_SIZE),
      particleStats: new SharedArrayBuffer(PARTICLE_STATS.BUFFER_SIZE),
      preRenderStats: new SharedArrayBuffer(PRE_RENDER_STATS.BUFFER_SIZE),
      spatialStats: new SharedArrayBuffer(SPATIAL_STATS.BUFFER_SIZE_PER_WORKER * 2),
      logicStats: new SharedArrayBuffer(LOGIC_STATS.BUFFER_SIZE_PER_WORKER * 2),
    },
    views: {
      frameRate: new Float32Array(new SharedArrayBuffer(16 * 8 * 4)),
    },
    mainFrameNumber: 0,
    mainFPS: 0,
  };

  scene.writers = {
    physics: createStatsWriter(scene.buffers.physicsStats, PHYSICS_STATS),
    renderer: createStatsWriter(scene.buffers.rendererStats, RENDERER_STATS),
    particle: createStatsWriter(scene.buffers.particleStats, PARTICLE_STATS),
    preRender: createStatsWriter(scene.buffers.preRenderStats, PRE_RENDER_STATS),
    spatial0: createMultiWorkerStatsWriter(scene.buffers.spatialStats, SPATIAL_STATS, 0),
    spatial1: createMultiWorkerStatsWriter(scene.buffers.spatialStats, SPATIAL_STATS, 1),
    logic0: createMultiWorkerStatsWriter(scene.buffers.logicStats, LOGIC_STATS, 0),
    logic1: createMultiWorkerStatsWriter(scene.buffers.logicStats, LOGIC_STATS, 1),
  };

  return scene;
}

test('worker frame-rate layout stays contiguous across all active workers', () => {
  assert.deepEqual(getWorkerFrameRateLayout({ spatialWorkerCount: 2, logicWorkerCount: 2 }), [
    { id: 'spatial0', type: 'spatial', workerIndex: 0, frameRateIndex: 0 },
    { id: 'spatial1', type: 'spatial', workerIndex: 1, frameRateIndex: 1 },
    { id: 'physics', type: 'physics', workerIndex: 0, frameRateIndex: 2 },
    { id: 'renderer', type: 'renderer', workerIndex: 0, frameRateIndex: 3 },
    { id: 'particle', type: 'particle', workerIndex: 0, frameRateIndex: 4 },
    { id: 'logic0', type: 'logic', workerIndex: 0, frameRateIndex: 5 },
    { id: 'logic1', type: 'logic', workerIndex: 1, frameRateIndex: 6 },
    { id: 'preRender', type: 'preRender', workerIndex: 0, frameRateIndex: 7 },
  ]);
});

test('worker benchmark reader summarizes average FPS from sampled worker snapshots', () => {
  const scene = createBenchmarkSceneStub();
  const reader = createWorkerBenchmarkReader(scene);

  scene.mainFrameNumber = 100;
  scene.mainFPS = 58;

  scene.writers.spatial0[SPATIAL_STATS.FPS] = 120;
  scene.writers.logic1[LOGIC_STATS.FPS] = 90;
  scene.writers.preRender[PRE_RENDER_STATS.FPS] = 75;

  const startSnapshot = reader.snapshot(1000);

  scene.mainFPS = 62;
  scene.writers.spatial0[SPATIAL_STATS.FPS] = 140;
  scene.writers.logic1[LOGIC_STATS.FPS] = 100;
  scene.writers.preRender[PRE_RENDER_STATS.FPS] = 85;
  const midSnapshot = reader.snapshot(4000);

  scene.mainFrameNumber = 460;
  scene.mainFPS = 61;

  scene.writers.spatial0[SPATIAL_STATS.FPS] = 122;
  scene.writers.logic1[LOGIC_STATS.FPS] = 95;
  scene.writers.preRender[PRE_RENDER_STATS.FPS] = 80;

  const endSnapshot = reader.snapshot(7000);
  const summary = summarizeWorkerBenchmarkWindow(startSnapshot, endSnapshot, {
    sampleSnapshots: [midSnapshot],
  });

  assert.equal(summary.sceneName, 'BenchmarkSceneStub');
  assert.equal(summary.measurementDurationMs, 6000);
  assert.equal(summary.mainThread.frameDelta, 360);
  assert.equal(summary.mainThread.averageFPS, 61.5);

  const spatial0 = summary.workers.find((worker) => worker.id === 'spatial0');
  const logic1 = summary.workers.find((worker) => worker.id === 'logic1');
  const preRender = summary.workers.find((worker) => worker.id === 'preRender');

  assert.equal(spatial0.averageFPS, 131);
  assert.equal(logic1.averageFPS, 97.5);
  assert.equal(preRender.averageFPS, 82.5);
  assert.equal(spatial0.sampleCount, 2);
  assert.equal(summary.workersByType.logic.length, 2);
});
