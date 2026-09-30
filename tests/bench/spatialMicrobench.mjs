#!/usr/bin/env node
// L1: Grid rebuild + neighbor gather through the Grid API.
// The worker's own loop (rebuildOwnedRows / findNeighborsForOwnedEntities) is
// spatialWorkerMicrobench.mjs; this one isolates Grid.addEntityToCell / setNeighbor.
//
//   node tests/bench/spatialMicrobench.mjs
//   node tests/bench/spatialMicrobench.mjs --entities 2048 --output tests/results/spatial-l1.json

import assert from 'node:assert/strict';

import { Grid } from '../../src/core/grid.js';
import { isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

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

async function main() {
  allocGrid();
  const rng = mulberry32(SEED);
  const { xs, ys } = placeEntities(rng);
  xs[0] = 100;
  ys[0] = 100;
  xs[1] = 110;
  ys[1] = 110;

  rebuild(xs, ys);
  const pairs = writeNeighbors(xs, ys, RANGE);
  const n0 = Grid.getNeighborCount(0);
  let found1 = false;
  for (let k = 0; k < n0; k++) {
    if (Grid.getNeighbor(0, k) === 1) found1 = true;
  }
  assert.ok(found1, 'entity 1 must be a neighbor of entity 0');
  assert.ok(n0 > 0, 'rebuild+neighbor produced an empty list');

  const cases = {
    rebuild: timeIt('rebuild_cells', (iters) => {
      for (let i = 0; i < iters; i++) rebuild(xs, ys);
    }, { iterations: Number(args.rebuildIters ?? 400) }),
    neighbor: timeIt('neighbor_gather', (iters) => {
      for (let i = 0; i < iters; i++) writeNeighbors(xs, ys, RANGE);
    }, { iterations: Number(args.neighborIters ?? 80) }),
  };

  if (OUTPUT) {
    writeReport(OUTPUT, {
      feature: 'spatial-grid-api',
      n: ENTITIES,
      seed: SEED,
      checksum: pairs,
      cases,
    });
  }

  if (args.campaign) {
    const { runSpatialKernel } = await import('./entityIdWidthKernels.mjs');
    await runSpatialKernel({
      output: args.campaignOut || 'tests/results/entity-id-width/kernel-nbr-grid.json',
    });
  }
}

if (isCli(import.meta.url)) await main();
