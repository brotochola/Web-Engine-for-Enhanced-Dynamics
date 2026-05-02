import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addToActiveEntities,
  removeFromActiveEntities,
  batchRemoveFromActiveEntities,
  addToTypeActiveList,
  removeFromTypeActiveList,
  clearTypeActiveList,
} from '../../src/core/gameObjectActiveState.js';

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

