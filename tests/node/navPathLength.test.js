import test from 'node:test';
import assert from 'node:assert/strict';

import { NavGrid } from '../../src/core/navGrid.js';

/**
 * B-07. The A* reconstruction loop in particleWorker filled its scratch buffer
 * exactly, then appended the origin cell unconditionally:
 *
 *   while (current !== fromCell && pathLength < scratch.pathResult.length) {
 *     scratch.pathResult[pathLength++] = current;
 *     ...
 *   }
 *   scratch.pathResult[pathLength++] = fromCell;   // pathLength may === .length
 *   NavGrid.writePathData(slot, scratch.pathResult, pathLength);
 *
 * Writing past the end of a typed array is a silent no-op, but pathLength still
 * advanced. writePathData then read one element beyond the array, got undefined,
 * and `u32[i] = undefined` stores 0. Cell 0 is a real cell, so a truncated path
 * gained a phantom waypoint at the origin.
 *
 * Fixed at both ends: the caller no longer increments past the end, and
 * writePathData clamps explicitLength to the source it was handed. These tests
 * pin the sink, which is the reachable half.
 */

const GRID_W = 8;
const GRID_H = 8;
const CELL_SIZE = 1;
const MAX_PATH_LENGTH = 8;

const CONFIG = {
  cellSize: CELL_SIZE,
  maxFlowfields: 2,
  maxPaths: 4,
  maxPathLength: MAX_PATH_LENGTH,
};

function makeGrid() {
  const sab = new SharedArrayBuffer(NavGrid.calculateSABSize(CONFIG, GRID_W, GRID_H));
  NavGrid.writeHeader(sab, CONFIG, GRID_W, GRID_H);
  NavGrid.initialize(sab, { worldWidth: GRID_W * CELL_SIZE, worldHeight: GRID_H * CELL_SIZE });
  return sab;
}

/** getPathForVisualization maps cell -> world centre. cellSize 1 -> +0.5. */
function cellCenter(cell) {
  return {
    x: (cell % GRID_W) * CELL_SIZE + CELL_SIZE / 2,
    y: Math.floor(cell / GRID_W) * CELL_SIZE + CELL_SIZE / 2,
  };
}

const CELL_ZERO = cellCenter(0); // the value `undefined` coerces to

function writeAndRead(src, explicitLength) {
  const slot = NavGrid.allocatePathSlot(2, 3);
  NavGrid.writePathData(slot, src, explicitLength);
  return NavGrid.getPathForVisualization(slot) || [];
}

test('B-07: a normal path round-trips unchanged', { concurrency: false }, () => {
  makeGrid();
  const src = new Uint32Array([9, 10, 11]);
  const cells = writeAndRead(src, src.length);
  assert.equal(cells.length, 3);
  assert.deepEqual(cells, [cellCenter(9), cellCenter(10), cellCenter(11)]);
});

test('B-07: writePathData clamps an explicitLength past the source array', { concurrency: false }, () => {
  makeGrid();
  // Four real cells; the caller claims nine. Before the fix, the fifth slot read
  // undefined and stored 0.
  const src = new Uint32Array([9, 10, 11, 12]);
  const cells = writeAndRead(src, 9);

  assert.ok(cells.length <= src.length, `path length ${cells.length} exceeds source ${src.length}`);
  for (const c of cells) {
    assert.notDeepEqual(c, CELL_ZERO, 'a phantom cell-0 waypoint reached the path');
  }
  assert.deepEqual(cells, [cellCenter(9), cellCenter(10), cellCenter(11), cellCenter(12)]);
});

test('B-07: an empty source writes no phantom origin', { concurrency: false }, () => {
  makeGrid();
  const cells = writeAndRead(new Uint32Array(0), 1);
  assert.equal(cells.length, 0, `an empty source must produce no cells, got ${JSON.stringify(cells)}`);
});

test('B-07: explicitLength beyond maxPathLength clamps to maxPathLength', { concurrency: false }, () => {
  makeGrid();
  const src = new Uint32Array([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  const cells = writeAndRead(src, 100);
  assert.ok(cells.length <= MAX_PATH_LENGTH, `length ${cells.length} exceeded maxPathLength`);
});

test('B-07: a source exactly at maxPathLength is not extended', { concurrency: false }, () => {
  makeGrid();
  const src = new Uint32Array([9, 10, 11, 12, 13, 14, 15, 16]); // exactly 8
  const cells = writeAndRead(src, src.length);
  assert.equal(cells.length, MAX_PATH_LENGTH);
  for (const c of cells) {
    assert.notDeepEqual(c, CELL_ZERO, 'cell 0 appeared at full length');
  }
});

test('B-07: negative explicitLength is treated as absent', { concurrency: false }, () => {
  makeGrid();
  const src = new Uint32Array([9, 10]);
  const cells = writeAndRead(src, -1);
  assert.deepEqual(cells, [cellCenter(9), cellCenter(10)]);
});
