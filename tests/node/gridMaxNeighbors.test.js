import test from 'node:test';
import assert from 'node:assert/strict';

import { Grid } from '../../src/core/grid.js';
import { SPATIAL_DEFAULTS } from '../../src/util/configDefaults.js';

function restoreGrid(snapshot) {
  Grid.maxNeighbors = snapshot.maxNeighbors;
  Grid.maxEntitiesPerCell = snapshot.maxEntitiesPerCell;
  Grid.rowsPerBlock = snapshot.rowsPerBlock;
  Grid.neighborStride = snapshot.neighborStride;
  Grid._stride = snapshot.stride;
  Grid.reset();
}

test('Grid.initialize keeps maxNeighbors 0 instead of defaulting to 128', () => {
  const snapshot = {
    maxNeighbors: Grid.maxNeighbors,
    maxEntitiesPerCell: Grid.maxEntitiesPerCell,
    rowsPerBlock: Grid.rowsPerBlock,
    neighborStride: Grid.neighborStride,
    stride: Grid._stride,
  };

  const entityCount = 1024;
  const neighborBuffer = new SharedArrayBuffer(entityCount * (1 + 0) * 2);

  try {
    Grid.initialize(
      { neighborBuffer },
      { cellSize: 512, gridWidth: 4, gridHeight: 4, maxNeighbors: 0 }
    );

    assert.equal(Grid.maxNeighbors, 0);
    assert.equal(Grid._stride, 1);
    assert.notEqual(Grid.maxNeighbors, SPATIAL_DEFAULTS.maxNeighbors);

    const lateIndex = 7;
    const neighbors = new Uint16Array(
      Grid.neighborData.buffer,
      Grid.neighborData.byteOffset + (lateIndex * Grid._stride + 1) * 2,
      Grid.maxNeighbors
    );
    assert.equal(neighbors.length, 0);
  } finally {
    restoreGrid(snapshot);
  }
});
