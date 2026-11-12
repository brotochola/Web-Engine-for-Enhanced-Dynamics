import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';

// E-218: a tickAll type's listed entities went to tickAll copied into a scratch list, each checked active on the way:
// 200 000 a frame in BunnyMark. A type without a body whose listed entities are all active now gets a view of its
// active list; one that is not (an entity despawned this frame) is filtered and copied as before.

const N = 8;

async function setup() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  const w = await loadWorker('logicWorker.js', 'logicWorker');
  const calls = [];
  class Flock {
    static tickAll(list, count) {
      calls.push({ list, ids: Array.from(list.subarray(0, count)) });
    }
  }
  // Every logic worker's list of the type: [count, ids...] over shared memory.
  const activeList = new Uint16Array(new SharedArrayBuffer(2 * (N + 1)));
  activeList.set([5, 1, 2, 3, 5, 6]);
  for (const i of [1, 2, 3, 5, 6]) Transform.active[i] = 1;
  w.tickAllTypes = [{
    EntityClass: Flock,
    activeList,
    startIndex: 0,
    entityType: 0,
    hasRigidBody: false,
    view: activeList.subarray(1),
    viewFrom: 0,
  }];
  w.totalLogicWorkers = 1;
  w.workerIndex = 0;
  w._tickAllScratch = new Uint16Array(N);
  return { w, calls, activeList };
}

test('all listed entities active: tickAll reads a view of the active list, no copy', async () => {
  const { w, calls, activeList } = await setup();
  const packed = w._runTickAllTypes(1, Transform.active, RigidBody.ax, RigidBody.ay, RigidBody.angularAccel);
  assert.equal(packed, 5);
  assert.deepEqual(calls[0].ids, [1, 2, 3, 5, 6]);
  assert.equal(calls[0].list.buffer, activeList.buffer, 'the list itself');
  assert.equal(calls[0].list.byteOffset, activeList.byteOffset + 2, 'from its first id');
});

test('an entity despawned this frame: filtered into the scratch as before', async () => {
  const { w, calls } = await setup();
  Transform.active[3] = 0;
  const packed = w._runTickAllTypes(1, Transform.active, RigidBody.ax, RigidBody.ay, RigidBody.angularAccel);
  assert.equal(packed, 4);
  assert.deepEqual(calls[0].ids, [1, 2, 5, 6]);
  assert.equal(calls[0].list, w._tickAllScratch, 'the scratch');
});

test('a type with a body still resets each accelerations and goes through the scratch', async () => {
  const { w, calls } = await setup();
  w.tickAllTypes[0].hasRigidBody = true;
  const ax = new Float32Array(N).fill(7);
  const ay = new Float32Array(N).fill(7);
  const aa = new Float32Array(N).fill(7);
  w._runTickAllTypes(1, Transform.active, ax, ay, aa);
  assert.deepEqual(calls[0].ids, [1, 2, 3, 5, 6]);
  assert.equal(calls[0].list, w._tickAllScratch);
  for (const i of [1, 2, 3, 5, 6]) assert.equal(ax[i] + ay[i] + aa[i], 0, `entity ${i} reset`);
  assert.equal(ax[0], 7, 'an unlisted one is not');
});
