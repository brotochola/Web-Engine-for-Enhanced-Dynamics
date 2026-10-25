import test from 'node:test';
import assert from 'node:assert/strict';

import { coreComponentData, loadWorker, spatialPublishBuffers } from '../bench/workerHarness.mjs';

// Workers used to replace console.log with a no-op unless debug.verboseWorkers
// was on, so a game's console.log inside tick() printed nothing. The engine's
// own worker chatter goes through debugWorkerLog now; a game's logs print.

const N = 16;

function initPayload(debug) {
  const { buffers, gridMetadata, mem } = spatialPublishBuffers(
    { worldWidth: 1000, worldHeight: 1000, cellSize: 100, maxEntitiesPerCell: 8, maxNeighbors: 8 },
    N,
  );
  return {
    msg: 'init',
    pageOrigin: '',
    config: { seed: 123456, canvasWidth: 1280, canvasHeight: 720, worldWidth: 1000, worldHeight: 1000, debug },
    globalEntityCount: N,
    buffers: { ...buffers, componentData: coreComponentData(N) },
    gridMetadata,
    registeredClasses: [],
    componentPools: {},
    frameRateStride: 16,
    frameRateIndex: 0,
    spatialPublishMemory: mem.memory,
  };
}

async function initCapturingLogs(debug) {
  const w = await loadWorker('spatialWorker.js', 'spatialWorker');
  const original = console.log;
  const lines = [];
  const capture = (...args) => lines.push(args.join(' '));
  console.log = capture;
  try {
    await w.handleMessage({ data: initPayload(debug) });
    return { kept: console.log === capture, lines };
  } finally {
    console.log = original;
  }
}

test('a worker keeps console.log after init', async () => {
  const { kept } = await initCapturingLogs({});
  assert.ok(kept, 'init replaced console.log');
});

test('the engine init chatter stays quiet unless debug.verboseWorkers is on', async () => {
  const quiet = await initCapturingLogs({});
  assert.deepEqual(quiet.lines, []);
  const verbose = await initCapturingLogs({ verboseWorkers: true });
  assert.ok(verbose.lines.length > 0, 'verboseWorkers printed nothing');
});
