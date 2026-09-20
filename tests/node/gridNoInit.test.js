import test from 'node:test';
import assert from 'node:assert/strict';

import { Grid } from '../../src/core/grid.js';

test('getEntitiesInRadius returns empty when the grid was never initialized', { concurrency: false }, () => {
  const snapshot = {
    maxNeighbors: Grid.maxNeighbors,
    maxEntitiesPerCell: Grid.maxEntitiesPerCell,
    rowsPerBlock: Grid.rowsPerBlock,
    neighborStride: Grid.neighborStride,
    stride: Grid._stride,
  };
  Grid.reset();
  try {
    const box = Grid.getEntitiesInRadius(100, 100, 80);
    assert.equal(box.count, 0);
    assert.ok(box.entities);
  } finally {
    Grid.maxNeighbors = snapshot.maxNeighbors;
    Grid.maxEntitiesPerCell = snapshot.maxEntitiesPerCell;
    Grid.rowsPerBlock = snapshot.rowsPerBlock;
    Grid.neighborStride = snapshot.neighborStride;
    Grid._stride = snapshot.stride;
    Grid.reset();
  }
});
