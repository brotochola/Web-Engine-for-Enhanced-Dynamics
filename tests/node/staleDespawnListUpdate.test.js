import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';

// Predator kept 31 of its 32 Flash entities active but out of Flash's active
// list, so they never ticked, never expired, and the pool stayed full (on main
// too). A flash despawned on logic1 frees its index; logic0 reuses it at once
// (LIFO) and processes the new flash's spawn while the index is still listed,
// so the spawn is a no-op; then logic1's despawn arrives and unlists the new
// flash. A despawn for an index that is alive again must be skipped.

test('a late despawn does not unlist the new life that reused the index', async () => {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  const N = 4;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  const removed = [];
  const real = { all: GameObject._removeFromActiveEntities, type: GameObject._removeFromTypeActiveList };
  GameObject._removeFromActiveEntities = (i) => removed.push(i);
  GameObject._removeFromTypeActiveList = () => {};
  try {
    class Flashy {}
    Transform.active[1] = 1; // reused: a new flash lives at 1
    Transform.active[2] = 0; // really gone
    worker._processDespawnSoA(Int32Array.from([1, 2]), [Flashy, Flashy], 2);
    assert.deepEqual(removed, [2]);
  } finally {
    GameObject._removeFromActiveEntities = real.all;
    GameObject._removeFromTypeActiveList = real.type;
  }
});

test('two spawns of one index in a batch list it once', async () => {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  const N = 8;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Transform.active.fill(1);
  class Flashy {}
  Flashy._activeList = new Uint16Array(N + 1);
  Flashy._activeList.set([1, 4]); // [count, 4]
  const prevAll = GameObject.activeEntitiesData;
  GameObject.activeEntitiesData = new Uint16Array(N + 1);
  GameObject.activeEntitiesData.set([1, 4]);
  worker._spawnPerm = worker._spawnPerm || new Int32Array(64);
  try {
    // 2 twice (spawned, despawned, reused), 4 again (already listed), 3 once.
    worker._processSpawnSoA(Int32Array.from([2, 4, 3, 2]), [Flashy, Flashy, Flashy, Flashy], 4);
    assert.deepEqual([...Flashy._activeList.slice(0, 4)], [3, 2, 3, 4]);
    assert.deepEqual([...GameObject.activeEntitiesData.slice(0, 4)], [3, 2, 3, 4]);
  } finally {
    GameObject.activeEntitiesData = prevAll;
  }
});
