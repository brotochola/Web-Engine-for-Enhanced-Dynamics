import test from 'node:test';
import assert from 'node:assert/strict';

import { NavGrid } from '../../src/core/navGrid.js';
import { NavScratch } from '../../src/core/navAstar.js';
import { loadWorker } from '../bench/workerHarness.mjs';

// N-137: the particle worker's computePath, on the grid where the old open-set rule wrote a path 62 long instead of
// the shortest, 54, into the path slot the logic workers read.
const ROWS = ['...#..', '....#T', 'S....#', '....#.'];
const W = ROWS[0].length;
const H = ROWS.length;
const CONFIG = { cellSize: 1, maxFlowfields: 2, maxPaths: 4, maxPathLength: 32 };

test("the particle worker writes the shortest A* path into the path slot", { concurrency: false }, async () => {
  const sab = new SharedArrayBuffer(NavGrid.calculateSABSize(CONFIG, W, H));
  NavGrid.writeHeader(sab, CONFIG, W, H);
  NavGrid.initialize(sab, { worldWidth: W, worldHeight: H });
  const walk = NavGrid.getWalkabilityArray();
  let from = -1;
  let to = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = y * W + x;
      walk[c] = ROWS[y][x] === '#' ? 0 : 1;
      if (ROWS[y][x] === 'S') from = c;
      if (ROWS[y][x] === 'T') to = c;
    }
  }

  const pw = await loadWorker('particleWorker.js', 'particleWorker');
  pw.gridWidth = W;
  pw.gridHeight = H;
  pw.maxPaths = CONFIG.maxPaths;
  pw.scratch = new NavScratch(W * H, CONFIG.maxPathLength, W, H);
  pw.computePath(from, to);

  let cells = null;
  for (let slot = 0; slot < CONFIG.maxPaths && cells === null; slot++) cells = NavGrid.getPathForVisualization(slot);
  assert.ok(cells && cells.length > 1, 'a path was written');
  const at = (p) => Math.floor(p.y) * W + Math.floor(p.x);
  assert.equal(at(cells[0]), from);
  assert.equal(at(cells[cells.length - 1]), to);
  let cost = 0;
  for (let i = 1; i < cells.length; i++) {
    const dx = Math.abs(cells[i].x - cells[i - 1].x);
    const dy = Math.abs(cells[i].y - cells[i - 1].y);
    assert.ok(dx <= 1 && dy <= 1 && dx + dy > 0, 'each step moves to a neighbour');
    assert.equal(walk[at(cells[i])], 1, 'each step is walkable');
    cost += dx + dy === 2 ? 14 : 10;
  }
  assert.equal(cost, 54);
});
