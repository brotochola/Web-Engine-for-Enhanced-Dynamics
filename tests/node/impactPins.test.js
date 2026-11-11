import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { GameObject } from '../../src/core/gameObject.js';

// N-129: processImpacts sent each impact to the logic worker targetId % workers, where ticks and collision callbacks
// honour GameObject.forceProcessOnLogicWorker: a pinned entity was shot on a worker that does not tick it.

function impactsOn(worker, workerIndex, totalWorkers, targets) {
  worker.workerIndex = workerIndex;
  worker.totalLogicWorkers = totalWorkers;
  worker._impactData = new Float32Array(targets.length * 6);
  const shots = [];
  const gameObjects = [];
  targets.forEach((id, k) => {
    worker._impactData.set([id, 10 + k, 1, 2, 99, 3], k * 6);
    gameObjects[id] = { onGotShot: (damage) => shots.push([id, damage]) };
  });
  worker.gameObjects = gameObjects;
  worker.processImpacts(targets.length);
  return shots;
}

test('a pinned entity is shot on the worker it is pinned to, the rest by index', async () => {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  const saved = GameObject.forceProcessOnLogicWorker;
  try {
    const pins = new Int16Array(16).fill(-1);
    pins[5] = 0; // 5 % 2 is 1: the modulo would send it to worker 1
    GameObject.forceProcessOnLogicWorker = pins;
    const targets = [4, 5, 7];
    assert.deepEqual(impactsOn(worker, 0, 2, targets), [[4, 10], [5, 11]]);
    assert.deepEqual(impactsOn(worker, 1, 2, targets), [[7, 12]]);
    GameObject.forceProcessOnLogicWorker = null;
    assert.deepEqual(impactsOn(worker, 1, 2, targets), [[5, 11], [7, 12]], 'without pins, by index');
  } finally {
    GameObject.forceProcessOnLogicWorker = saved;
  }
});
