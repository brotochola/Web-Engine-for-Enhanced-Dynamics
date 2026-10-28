import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from '../bench/workerHarness.mjs';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { GameObject } from '../../src/core/gameObject.js';

// E-140: a tick resets the entity's accelerations (physics applies them every step until the next tick) only for
// types with a RigidBody; types without one take their own copies of the loops, which skip the resets. Both tick
// every entity they own, in the plain path and in the tickInterval buckets.

const N = 8;

class Walker {
  constructor(index, log) {
    this.index = index;
    this.log = log;
  }
  tick() {
    this.log.push(this.index);
  }
}

async function worker() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  const w = await loadWorker('logicWorker.js', 'logicWorker');
  for (let i = 0; i < N; i++) {
    Transform.active[i] = 1;
    RigidBody.ax[i] = 5;
    RigidBody.ay[i] = 5;
    RigidBody.angularAccel[i] = 5;
  }
  w.decimatedTypes = [];
  w.nonDecimatedTypes = [];
  w.tickAllTypes = [];
  w.totalLogicWorkers = 1;
  w.workerIndex = 0;
  w.config = { logic: {} };
  w._drainSpawnCommandRing = () => {};
  w.processListUpdates = () => {};
  w._latchDisplayPose = () => {};
  w.sendListUpdatesToLogic0 = () => {};
  return w;
}

const accels = (from, to) => {
  const out = [];
  for (let i = from; i < to; i++) out.push(RigidBody.ax[i], RigidBody.ay[i], RigidBody.angularAccel[i]);
  return out;
};

test('every-frame types: the resets only for the type with a RigidBody, ticks for both', async () => {
  const w = await worker();
  const log = [];
  w.gameObjects = Array.from({ length: N }, (_, i) => new Walker(i, log));
  w.nonDecimatedTypes = [
    { activeList: Uint16Array.of(4, 0, 1, 2, 3), needsScreenCallbacks: false, entityType: 0, hasRigidBody: true },
    { activeList: Uint16Array.of(4, 4, 5, 6, 7), needsScreenCallbacks: false, entityType: 1, hasRigidBody: false },
  ];
  w.update(16.67, 1, false);
  assert.deepEqual(log, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(accels(0, 4), new Array(12).fill(0), 'reset for the bodies');
  assert.deepEqual(accels(4, 8), new Array(12).fill(5), 'untouched without one');
  assert.equal(w.entitiesProcessedThisFrame, 8);
});

test('tickInterval buckets: each entity once in four frames, the resets only with a RigidBody', async () => {
  const w = await worker();
  const savedNextTick = GameObject.nextTick;
  GameObject.nextTick = new Int32Array(N);
  try {
    const log = [];
    w.gameObjects = Array.from({ length: N }, (_, i) => new Walker(i, log));
    w.decimatedTypes = [
      { activeList: Uint16Array.of(4, 0, 1, 2, 3), tickInterval: 4, needsScreenCallbacks: false, entityType: 0, hasRigidBody: true },
      { activeList: Uint16Array.of(4, 4, 5, 6, 7), tickInterval: 4, needsScreenCallbacks: false, entityType: 1, hasRigidBody: false },
    ];
    for (let f = 0; f < 4; f++) {
      w.frameNumber = f;
      w.update(16.67, 1, false);
    }
    assert.deepEqual(log.slice().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7], 'each once');
    assert.deepEqual(accels(0, 4), new Array(12).fill(0));
    assert.deepEqual(accels(4, 8), new Array(12).fill(5));
  } finally {
    GameObject.nextTick = savedNextTick;
  }
});
