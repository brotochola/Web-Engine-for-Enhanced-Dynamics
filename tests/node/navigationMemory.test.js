import test from 'node:test';
import assert from 'node:assert/strict';

import { NavGrid } from '../../src/core/navGrid.js';
import { createNavigationMemory } from '../../src/util/navigationMemory.js';
import { NAV_MAX_BUCKETS, NAV_QUOTIENT_BYTES, NAV_TABLE_SLOTS } from '../../src/util/wasmMemoryMap.js';

// E-76 W14: the nav buffer at byte 0 of the navigation memory, the flowfield's scratch after it, each
// region on its own line and apart from the others; NavGrid reads the memory's buffer as a plain one.

test('the navigation memory holds the nav buffer at byte 0 and the flowfield scratch after it', () => {
  const navigation = { cellSize: 32, maxFlowfields: 16, maxPaths: 16, maxPathLength: 64 };
  const gridWidth = 40;
  const gridHeight = 30;
  const cells = gridWidth * gridHeight;
  const navBytes = NavGrid.calculateSABSize(navigation, gridWidth, gridHeight);
  const m = createNavigationMemory(navBytes, cells);
  assert.ok(m, 'the memory is made');
  const L = m.layout;
  assert.equal(L.cells, cells);
  assert.equal(L.navBytes, navBytes);
  const spans = [
    ['nav', 0, navBytes],
    ['state', L.stateByte, cells],
    ['dist', L.distByte, cells * 2],
    ['dir', L.dirByte, cells],
    ['next', L.nextByte, cells * 4],
    ['prev', L.prevByte, cells * 4],
    ['head', L.headByte, NAV_MAX_BUCKETS * 4],
    ['sums', L.sumsByte, cells * 4],
    ['quotient', L.quotientByte, NAV_QUOTIENT_BYTES],
    ['vectors', L.vectorsByte, cells * 2],
    ['table', L.tableByte, NAV_TABLE_SLOTS * 4],
  ].sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < spans.length; i++) {
    const [name, at, bytes] = spans[i];
    assert.equal(at % 64, 0, `${name} starts on a line`);
    assert.ok(at + bytes <= m.buffer.byteLength, `${name} fits`);
    if (i > 0) assert.ok(at >= spans[i - 1][1] + spans[i - 1][2], `${name} overlaps ${spans[i - 1][0]}`);
  }
  // NavGrid on the memory's buffer, as every worker binds it.
  NavGrid.writeHeader(m.buffer, navigation, gridWidth, gridHeight);
  NavGrid.initialize(m.buffer, { worldWidth: gridWidth * 32, worldHeight: gridHeight * 32 });
  assert.equal(NavGrid.getWalkabilityArray().buffer, m.buffer);
  assert.equal(NavGrid.getWalkabilityArray().byteOffset, NavGrid._HEADER_SIZE);
  assert.equal(NavGrid.getGridInfo().totalCells, cells);
  assert.equal(createNavigationMemory(navBytes, 0), null, 'no grid, no memory');
});
