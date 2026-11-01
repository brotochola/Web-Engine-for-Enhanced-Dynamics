import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from '../bench/workerHarness.mjs';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { GameObject } from '../../src/core/gameObject.js';

// E-180: a type's tickInterval buckets are rebuilt when its own active list changed (its version in
// GameObject.typeListVersions), not whenever the global query version moves: that moved with every spawn and despawn
// of any type, and every interval type rebuilt its buckets.

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
  for (let i = 0; i < N; i++) Transform.active[i] = 1;
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
  w.queryVersionData = new Int32Array(new SharedArrayBuffer(4));
  return w;
}

test('interval buckets rebuild when their own type list changes, not when another type spawns', async () => {
  const w = await worker();
  const saved = { nextTick: GameObject.nextTick, versions: GameObject.typeListVersions };
  GameObject.nextTick = new Int32Array(N);
  GameObject.typeListVersions = new Int32Array(new SharedArrayBuffer(4 * 3));
  try {
    const log = [];
    w.gameObjects = Array.from({ length: N }, (_, i) => new Walker(i, log));
    const a = { activeList: Uint16Array.of(4, 0, 1, 2, 3), tickInterval: 4, needsScreenCallbacks: false, entityType: 0, hasRigidBody: false };
    const b = { activeList: Uint16Array.of(3, 4, 5, 6, 0), tickInterval: 4, needsScreenCallbacks: false, entityType: 1, hasRigidBody: false };
    w.decimatedTypes = [a, b];
    const rebuilt = [];
    const rebuild = w._rebuildTickBuckets;
    w._rebuildTickBuckets = function (typeInfo, ...rest) {
      rebuilt.push(typeInfo.entityType);
      return rebuild.call(this, typeInfo, ...rest);
    };
    const frames = (from, count) => {
      for (let f = from; f < from + count; f++) {
        w.frameNumber = f;
        w.update(16.67, 1, false);
      }
    };

    frames(0, 4);
    assert.deepEqual(rebuilt, [0, 1], 'each type builds its buckets once');
    assert.deepEqual(log.slice().sort((p, q) => p - q), [0, 1, 2, 3, 4, 5, 6]);

    // A third type spawns and despawns every frame: the global version moves, its own version moves.
    for (let f = 4; f < 8; f++) {
      Atomics.add(w.queryVersionData, 0, 1);
      Atomics.add(GameObject.typeListVersions, 2, 1);
      frames(f, 1);
    }
    assert.deepEqual(rebuilt, [0, 1], 'neither interval type rebuilt for another type');

    // Type 1 swaps an entity, same count: its version moves, it rebuilds, and the new entity ticks.
    b.activeList.set([3, 4, 5, 7]);
    GameObject._typeListChanged({ entityType: 1 });
    log.length = 0;
    frames(8, 4);
    assert.deepEqual(rebuilt, [0, 1, 1], 'type 1 rebuilt once');
    assert.deepEqual(log.slice().sort((p, q) => p - q), [0, 1, 2, 3, 4, 5, 7]);
  } finally {
    GameObject.nextTick = saved.nextTick;
    GameObject.typeListVersions = saved.versions;
  }
});

test('the list helpers move their type list version', () => {
  const saved = GameObject.typeListVersions;
  GameObject.typeListVersions = new Int32Array(new SharedArrayBuffer(4 * 4));
  try {
    const Cls = { entityType: 3, _activeList: new Uint16Array(8) };
    GameObject._addToTypeActiveList(Cls, 5);
    GameObject._addToTypeActiveList(Cls, 2);
    GameObject._removeFromTypeActiveList(Cls, 5);
    GameObject._clearTypeActiveList(Cls);
    assert.deepEqual(Array.from(GameObject.typeListVersions), [0, 0, 0, 4]);
  } finally {
    GameObject.typeListVersions = saved;
  }
});
