import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addToActiveEntities,
  removeFromActiveEntities,
  batchRemoveFromActiveEntities,
  addToMatchingQueries,
  removeFromMatchingQueries,
  batchRemoveFromMatchingQueries,
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

test('matching query helpers mutate only queries whose masks match', () => {
  const queryA = new Uint16Array(8);
  const queryB = new Uint16Array(8);
  const queryC = new Uint16Array(8);
  const worker = {
    _queryEntityMetadata: {
      2: { componentMask: 0b011 },
    },
    _precomputedQueries: [
      { queryMask: 0b001 },
      { queryMask: 0b010 },
      { queryMask: 0b111 },
    ],
    _queryResultViews: [queryA, queryB, queryC],
  };

  addToMatchingQueries(8, 2, worker);
  addToMatchingQueries(4, 2, worker);
  addToMatchingQueries(6, 2, worker);
  addToMatchingQueries(4, 2, worker);

  assert.equal(queryA[0], 3);
  assert.deepEqual(Array.from(queryA.slice(1, 4)), [4, 6, 8]);
  assert.equal(queryB[0], 3);
  assert.deepEqual(Array.from(queryB.slice(1, 4)), [4, 6, 8]);
  assert.equal(queryC[0], 0);

  removeFromMatchingQueries(6, 2, worker);
  assert.deepEqual(Array.from(queryA.slice(1, 3)), [4, 8]);
  assert.deepEqual(Array.from(queryB.slice(1, 3)), [4, 8]);

  batchRemoveFromMatchingQueries(new Set([4, 8]), 2, worker);
  assert.equal(queryA[0], 0);
  assert.equal(queryB[0], 0);
  assert.equal(queryC[0], 0);
});
