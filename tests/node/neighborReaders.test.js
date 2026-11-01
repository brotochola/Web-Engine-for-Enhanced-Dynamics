import test from 'node:test';
import assert from 'node:assert/strict';

import { Grid } from '../../src/core/grid.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';

// E-176: the spatial worker builds neighbour lists only for entity types whose code reads them (and for active
// lights). A read marks the reader's type in Grid.neighborReaders; nothing else may mark it, or every type would
// keep its lists.

const N = 16;
const MAX_NEIGHBORS = 4;

function setup() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  for (let i = 0; i < N; i++) Transform.entityType[i] = i < 8 ? 2 : 5; // two types: 2 and 5
  const stride = 1 + MAX_NEIGHBORS;
  const neighborBuffer = new SharedArrayBuffer(N * stride * 2);
  Grid.initialize({ neighborBuffer }, { cellSize: 64, gridWidth: 1, gridHeight: 1, maxNeighbors: MAX_NEIGHBORS, entityIdBytes: 2 });
  const readers = new SharedArrayBuffer(GameObject.ENTITY_TYPE_FORCE_PROCESS_FLAG_COUNT);
  GameObject.initializeArrays(N, neighborBuffer, null, null, null, null, 0, readers);
  const rows = Grid.neighborData;
  rows[3 * stride] = 2; // entity 3 (type 2) has two neighbours
  rows[3 * stride + 1] = 4;
  rows[3 * stride + 2] = 9;
  return new Uint8Array(readers);
}

/** An entity's instance, as a worker binds it (no constructor: the accessors read index and the neighbour row). */
function instance(index) {
  const e = Object.create(GameObject.prototype);
  Object.defineProperty(e, 'index', { value: index });
  e._neighborOffset = index * Grid._stride;
  return e;
}

test('neighbour readers: the instance accessors mark the reader type, and only it', () => {
  const readers = setup();
  assert.equal(readers[2], 0);
  const e = instance(3);
  assert.equal(e.neighborCount, 2);
  assert.equal(readers[2], 1);
  assert.equal(readers[5], 0);
  assert.deepEqual([...e.getAllNeighborIds()], [4, 9]);
  Grid.reset();
});

test('neighbour readers: Grid.getNeighborCount and getNeighborsOfEntityId mark the entity they ask about', () => {
  const readers = setup();
  assert.equal(Grid.getNeighborCount(12), 0); // type 5
  assert.equal(readers[5], 1);
  assert.equal(readers[2], 0);
  assert.deepEqual([...Grid.getNeighborsOfEntityId(3)], [4, 9]);
  assert.equal(readers[2], 1);
  Grid.reset();
});

test('neighbour readers: without the buffer nothing is marked and reads still work', () => {
  setup();
  Grid.neighborReaders = null;
  const e = instance(3);
  assert.equal(e.neighborCount, 2);
  assert.equal(Grid.getNeighborCount(3), 2);
  Grid.reset();
});
