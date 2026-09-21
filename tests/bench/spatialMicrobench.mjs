#!/usr/bin/env node
// L1: Grid rebuild + neighbor gather (Wave C). Also times Map+subarray vs flat table
// for neighbor-cell lists (C16) and a dead cell-version hash walk (C17, unused in prod).
//
//   node tests/bench/spatialMicrobench.mjs
//   node tests/bench/spatialMicrobench.mjs --entities 2048 --output tests/results/spatial-l1.json

import assert from 'node:assert/strict';

import { Grid } from '../../src/core/grid.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const ENTITIES = Number(args.entities ?? 2048);
const CELL_SIZE = Number(args.cellSize ?? 64);
const GRID_W = Number(args.gridW ?? 32);
const GRID_H = Number(args.gridH ?? 32);
const MEC = Number(args.maxPerCell ?? 64);
const MAX_NEIGHBORS = Number(args.maxNeighbors ?? 64);
const RANGE = Number(args.range ?? 90);
const SEED = Number(args.seed ?? 0x51a7);
const OUTPUT = args.output ? String(args.output) : null;
const MAX_R = 4;

function allocGrid() {
  const totalCells = GRID_W * GRID_H;
  const cellByteSize = 4 + MEC * 2;
  Grid.reset();
  Grid.initialize(
    {
      gridBuffer: new SharedArrayBuffer(totalCells * cellByteSize),
      neighborBuffer: new SharedArrayBuffer(ENTITIES * (1 + MAX_NEIGHBORS) * 2),
      cellVersionBuffer: new SharedArrayBuffer(totalCells * 4),
    },
    {
      cellSize: CELL_SIZE,
      gridWidth: GRID_W,
      gridHeight: GRID_H,
      maxEntitiesPerCell: MEC,
      maxNeighbors: MAX_NEIGHBORS,
    }
  );
}

function placeEntities(rng) {
  const xs = new Float32Array(ENTITIES);
  const ys = new Float32Array(ENTITIES);
  const worldW = GRID_W * CELL_SIZE;
  const worldH = GRID_H * CELL_SIZE;
  for (let i = 0; i < ENTITIES; i++) {
    xs[i] = 8 + rng() * (worldW - 16);
    ys[i] = 8 + rng() * (worldH - 16);
  }
  return { xs, ys };
}

function clearCells() {
  const counts = Grid._gridCounts;
  const byteSize = Grid.cellByteSize;
  const n = Grid.totalCells;
  for (let c = 0; c < n; c++) counts[c * byteSize] = 0;
}

function rebuild(xs, ys) {
  clearCells();
  for (let i = 0; i < ENTITIES; i++) {
    const cell = Grid.getCellIndex(xs[i], ys[i]);
    if (cell >= 0) Grid.addEntityToCell(cell, i);
  }
}

function writeNeighbors(xs, ys, range) {
  const rangeSq = range * range;
  const inv = Grid.invCellSize;
  const gridW = Grid.gridWidth;
  const gridH = Grid.gridHeight;
  const cellR = Math.ceil(range * inv);
  let pairs = 0;
  for (let a = 0; a < ENTITIES; a++) {
    const col = (xs[a] * inv) | 0;
    const row = (ys[a] * inv) | 0;
    let count = 0;
    const minC = col - cellR < 0 ? 0 : col - cellR;
    const maxC = col + cellR >= gridW ? gridW - 1 : col + cellR;
    const minR = row - cellR < 0 ? 0 : row - cellR;
    const maxR = row + cellR >= gridH ? gridH - 1 : row + cellR;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const cell = r * gridW + c;
        const n = Grid.getCellCount(cell);
        for (let k = 0; k < n; k++) {
          const b = Grid.getCellEntity(cell, k);
          if (b === a) continue;
          const dx = xs[b] - xs[a];
          const dy = ys[b] - ys[a];
          if (dx * dx + dy * dy < rangeSq && count < MAX_NEIGHBORS) {
            Grid.setNeighbor(a, count++, b);
          }
        }
      }
    }
    Grid.setNeighborCount(a, count);
    pairs += count;
  }
  return pairs;
}

function fillNeighborCells(out, centerRow, centerCol, cellRadius) {
  const gridW = GRID_W;
  const gridH = GRID_H;
  let count = 0;
  for (let dr = -cellRadius; dr <= cellRadius; dr++) {
    for (let dc = -cellRadius; dc <= cellRadius; dc++) {
      const row = centerRow + dr;
      const col = centerCol + dc;
      if (row < 0 || row >= gridH || col < 0 || col >= gridW) continue;
      out[count++] = row * gridW + col;
    }
  }
  return count;
}

function neighborCellsMap(cellIndex, cellRadius, centerRow, centerCol, cache) {
  const key = cellIndex * (MAX_R + 1) + cellRadius;
  const hit = cache.get(key);
  if (hit) return hit;
  const buf = new Uint16Array((2 * cellRadius + 1) * (2 * cellRadius + 1));
  const n = fillNeighborCells(buf, centerRow, centerCol, cellRadius);
  const view = n === buf.length ? buf : buf.subarray(0, n);
  cache.set(key, view);
  return view;
}

function neighborCellsFlat(cellIndex, cellRadius, centerRow, centerCol, table, lengths) {
  const key = cellIndex * (MAX_R + 1) + cellRadius;
  const hit = table[key];
  if (hit && lengths[key] >= 0) return hit.subarray(0, lengths[key]);
  const cap = (2 * cellRadius + 1) * (2 * cellRadius + 1);
  const buf = table[key] || (table[key] = new Uint16Array(cap));
  const n = fillNeighborCells(buf, centerRow, centerCol, cellRadius);
  lengths[key] = n;
  return buf.subarray(0, n);
}

function fnvCells(cells) {
  const versions = Grid._cellVersionData;
  let hash = 2166136261;
  for (let i = 0; i < cells.length; i++) {
    hash = Math.imul(hash ^ versions[cells[i]], 16777619) >>> 0;
  }
  return hash;
}

allocGrid();
const rng = mulberry32(SEED);
const { xs, ys } = placeEntities(rng);
xs[0] = 100;
ys[0] = 100;
xs[1] = 110;
ys[1] = 110;

rebuild(xs, ys);
writeNeighbors(xs, ys, RANGE);
const n0 = Grid.getNeighborCount(0);
let found1 = false;
for (let k = 0; k < n0; k++) {
  if (Grid.getNeighbor(0, k) === 1) found1 = true;
}
assert.ok(found1, 'entity 1 must be a neighbor of entity 0');
assert.ok(n0 > 0, 'rebuild+neighbor produced an empty list');

const cache = new Map();
const table = [];
const lengths = new Int16Array(GRID_W * GRID_H * (MAX_R + 1));
lengths.fill(-1);
const cell0 = Grid.getCellIndex(xs[0], ys[0]);
const row0 = (ys[0] * Grid.invCellSize) | 0;
const col0 = (xs[0] * Grid.invCellSize) | 0;
const mapA = neighborCellsMap(cell0, 2, row0, col0, cache);
const flatA = neighborCellsFlat(cell0, 2, row0, col0, table, lengths);
assert.equal(mapA.length, flatA.length);
for (let i = 0; i < mapA.length; i++) assert.equal(mapA[i], flatA[i]);

const cases = {
  rebuild: timeIt('rebuild_cells', (iters) => {
    for (let i = 0; i < iters; i++) rebuild(xs, ys);
  }, { iterations: Number(args.rebuildIters ?? 400) }),
  neighbor: timeIt('neighbor_gather', (iters) => {
    for (let i = 0; i < iters; i++) writeNeighbors(xs, ys, RANGE);
  }, { iterations: Number(args.neighborIters ?? 80) }),
};

const queryCells = [];
for (let i = 0; i < ENTITIES; i++) {
  queryCells.push({
    cell: Grid.getCellIndex(xs[i], ys[i]),
    row: (ys[i] * Grid.invCellSize) | 0,
    col: (xs[i] * Grid.invCellSize) | 0,
    r: 1 + (i & 1),
  });
}

const mapCache = new Map();
cases.c16_map = timeIt('C16_map_subarray', (iters) => {
  for (let n = 0; n < iters; n++) {
    if ((n & 63) === 0) mapCache.clear();
    for (let i = 0; i < queryCells.length; i++) {
      const q = queryCells[i];
      neighborCellsMap(q.cell, q.r, q.row, q.col, mapCache);
    }
  }
}, { iterations: Number(args.cacheIters ?? 40) });

const flatTable = [];
const flatLen = new Int16Array(GRID_W * GRID_H * (MAX_R + 1));
cases.c16_flat = timeIt('C16_flat_table', (iters) => {
  for (let n = 0; n < iters; n++) {
    if ((n & 63) === 0) flatLen.fill(-1);
    for (let i = 0; i < queryCells.length; i++) {
      const q = queryCells[i];
      neighborCellsFlat(q.cell, q.r, q.row, q.col, flatTable, flatLen);
    }
  }
}, { iterations: Number(args.cacheIters ?? 40) });

const scratch = new Uint16Array(81);
cases.c17_hash = timeIt('C17_dependency_hash', (iters) => {
  for (let n = 0; n < iters; n++) {
    for (let i = 0; i < queryCells.length; i++) {
      const q = queryCells[i];
      const count = fillNeighborCells(scratch, q.row, q.col, q.r);
      fnvCells(scratch.subarray(0, count));
    }
  }
}, { iterations: Number(args.hashIters ?? 40) });

const report = {
  feature: 'spatial-rebuild-neighbor',
  entities: ENTITIES,
  range: RANGE,
  correctness: { entity0Neighbors: n0, includesEntity1: found1 },
  cases,
};

if (OUTPUT) writeReport(OUTPUT, report);
console.log(`C16 map ${Math.round(cases.c16_map.opsPerSec)} ops/s vs flat ${Math.round(cases.c16_flat.opsPerSec)} ops/s`);
console.log(`C17 dependency hash ${Math.round(cases.c17_hash.opsPerSec)} ops/s (dead in prod Verlet path)`);

if (args.campaign) {
  const { runSpatialKernel } = await import('./entityIdWidthKernels.mjs');
  await runSpatialKernel({
    output: args.campaignOut || 'tests/results/entity-id-width/kernel-nbr-grid.json',
  });
}
