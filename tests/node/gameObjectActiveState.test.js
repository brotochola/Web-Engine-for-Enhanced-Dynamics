import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addToActiveEntities,
  removeFromActiveEntities,
  batchRemoveFromActiveEntities,
  addToTypeActiveList,
  removeFromTypeActiveList,
  clearTypeActiveList,
  mergeSortedIntoActiveList,
} from '../../src/util/gameObjectActiveState.js';
import {
  createSpawnCommandRingSab,
  bindSpawnCommandRing,
  tryPushSpawn,
  drainSpawnCommands,
} from '../../src/util/spawnCommandRing.js';

test('active entity helpers keep lists sorted, deduped, and compacted', () => {
  const activeEntitiesData = new Uint16Array(8);

  addToActiveEntities(activeEntitiesData, 7);
  addToActiveEntities(activeEntitiesData, 3);
  addToActiveEntities(activeEntitiesData, 5);
  addToActiveEntities(activeEntitiesData, 5);

  assert.equal(activeEntitiesData[0], 3);
  assert.deepEqual(Array.from(activeEntitiesData.slice(1, 4)), [3, 5, 7]);

  removeFromActiveEntities(activeEntitiesData, 5);
  assert.equal(activeEntitiesData[0], 2);
  assert.deepEqual(Array.from(activeEntitiesData.slice(1, 3)), [3, 7]);

  batchRemoveFromActiveEntities(activeEntitiesData, new Set([3]));
  assert.equal(activeEntitiesData[0], 1);
  assert.deepEqual(Array.from(activeEntitiesData.slice(1, 2)), [7]);
});

test('type active list helpers keep per-type lists sorted and clearable', () => {
  const typeList = new Uint16Array(8);

  addToTypeActiveList(typeList, 12);
  addToTypeActiveList(typeList, 4);
  addToTypeActiveList(typeList, 9);
  addToTypeActiveList(typeList, 4);

  assert.equal(typeList[0], 3);
  assert.deepEqual(Array.from(typeList.slice(1, 4)), [4, 9, 12]);

  removeFromTypeActiveList(typeList, 9);
  assert.equal(typeList[0], 2);
  assert.deepEqual(Array.from(typeList.slice(1, 3)), [4, 12]);

  clearTypeActiveList(typeList);
  assert.equal(typeList[0], 0);
});

test('mergeSortedIntoActiveList writes count last on empty dest', () => {
  const list = new Uint16Array(8);
  const incoming = [3, 5, 9];
  mergeSortedIntoActiveList(list, incoming, 3);
  assert.equal(list[0], 3);
  assert.deepEqual(Array.from(list.subarray(1, 4)), [3, 5, 9]);
});

test('mergeSortedIntoActiveList merges into existing and dedups', () => {
  const list = new Uint16Array(12);
  list[0] = 3;
  list[1] = 2;
  list[2] = 6;
  list[3] = 10;
  const incoming = [1, 6, 8, 12];
  const scratch = new Uint16Array(12);
  mergeSortedIntoActiveList(list, incoming, 4, scratch);
  assert.equal(list[0], 6);
  assert.deepEqual(Array.from(list.subarray(1, 7)), [1, 2, 6, 8, 10, 12]);
});

test('drain 3 spawn then processListUpdates merge', () => {
  const sab = createSpawnCommandRingSab(8);
  bindSpawnCommandRing(sab);
  assert.equal(tryPushSpawn(1, 4, 0, 0), true);
  assert.equal(tryPushSpawn(1, 1, 0, 0), true);
  assert.equal(tryPushSpawn(1, 9, 0, 0), true);

  const incoming = [];
  const n = drainSpawnCommands((_kind, _typeId, entityIndex) => {
    incoming.push(entityIndex);
  });
  assert.equal(n, 3);
  incoming.sort((a, b) => a - b);

  const list = new Uint16Array(8);
  mergeSortedIntoActiveList(list, incoming, incoming.length);
  assert.equal(list[0], 3);
  assert.deepEqual(Array.from(list.subarray(1, 4)), [1, 4, 9]);
  bindSpawnCommandRing(null);
});

