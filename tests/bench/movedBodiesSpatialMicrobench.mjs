/**
 * Occupancy incremental grid vs full clear+insert.
 * Checksum must match at 0%, 5%, and 100% movers, including multi-cell spans.
 * Also checks the dirty-cell neighbor stamp has zero false negatives.
 *
 *   node tests/bench/movedBodiesSpatialMicrobench.mjs
 */
import assert from 'node:assert/strict';

import { mulberry32, timeIt } from './microbenchHelpers.mjs';
import {
  OCC_SPAN,
  INCREMENTAL_DIRTY_FRACTION,
  clearGrid,
  insertEntityInCell,
  membershipChecksum,
  occupyEntity,
  stampAffected,
  vacateEntity,
} from '../../src/util/spatialOccupancy.js';

const ENTITIES = 4096;
const GRID = 64;
const MAX_PER = 64;
const CELL = 64;

function makeGrid() {
  const cells = GRID * GRID;
  const idBytes = 4;
  const cellByteSize = 4 + MAX_PER * idBytes;
  const buf = new ArrayBuffer(cells * cellByteSize);
  return {
    counts: new Uint8Array(buf),
    entities: new Uint32Array(buf),
    cellByteSize,
    cellIdStride: cellByteSize / idBytes,
    headerIds: 4 / idBytes,
    maxPerCell: MAX_PER,
    gridWidth: GRID,
    gridHeight: GRID,
  };
}

function place(rng, span) {
  const xs = new Float32Array(ENTITIES);
  const ys = new Float32Array(ENTITIES);
  const half = span > 1 ? 30 : 4;
  const world = GRID * CELL;
  for (let i = 0; i < ENTITIES; i++) {
    xs[i] = half + 1 + rng() * (world - half * 2 - 2);
    ys[i] = half + 1 + rng() * (world - half * 2 - 2);
  }
  return { xs, ys, half };
}

function rangeOf(x, y, half) {
  const inv = 1 / CELL;
  let minC = ((x - half) * inv) | 0;
  let maxC = ((x + half) * inv) | 0;
  let minR = ((y - half) * inv) | 0;
  let maxR = ((y + half) * inv) | 0;
  if (minC < 0) minC = 0;
  if (minR < 0) minR = 0;
  if (maxC >= GRID) maxC = GRID - 1;
  if (maxR >= GRID) maxR = GRID - 1;
  return { minC, maxC, minR, maxR };
}

const owner = new Uint8Array(GRID);
function fullRebuild(grid, xs, ys, half) {
  clearGrid(grid);
  for (let i = 0; i < ENTITIES; i++) {
    const r = rangeOf(xs[i], ys[i], half);
    for (let row = r.minR; row <= r.maxR; row++) {
      const rowBase = row * GRID;
      for (let col = r.minC; col <= r.maxC; col++) {
        insertEntityInCell(grid, rowBase + col, i);
      }
    }
  }
}

function incremental(grid, occCount, occCells, xs, ys, half, dirty, dirtyN) {
  for (let d = 0; d < dirtyN; d++) {
    const e = dirty[d];
    vacateEntity(grid, occCount, occCells, e);
    const r = rangeOf(xs[e], ys[e], half);
    const ok = occupyEntity(
      grid, occCount, occCells, e,
      r.minC, r.maxC, r.minR, r.maxR, owner, 0,
    );
    assert.equal(ok, true, 'span fits OCC_SPAN');
    assert.ok((occCount[e] | 0) <= OCC_SPAN);
  }
}

function seedOcc(grid, occCount, occCells) {
  occCount.fill(0);
  const cells = GRID * GRID;
  for (let c = 0; c < cells; c++) {
    const count = grid.counts[c * grid.cellByteSize] | 0;
    const base = c * grid.cellIdStride + grid.headerIds;
    for (let k = 0; k < count; k++) {
      const e = grid.entities[base + k] | 0;
      const prev = occCount[e] | 0;
      occCells[e * OCC_SPAN + prev] = c;
      occCount[e] = prev + 1;
    }
  }
}

function checkFraction(label, fraction, span) {
  const rng = mulberry32(0x51a7 + (fraction * 1000) | 0 + span);
  const { xs, ys, half } = place(rng, span);
  const full = makeGrid();
  const inc = makeGrid();
  fullRebuild(full, xs, ys, half);
  fullRebuild(inc, xs, ys, half);
  const occCount = new Uint8Array(ENTITIES);
  const occCells = new Uint32Array(ENTITIES * OCC_SPAN);
  seedOcc(inc, occCount, occCells);
  const dirtyN = Math.max(0, Math.round(ENTITIES * fraction));
  const dirty = new Uint32Array(dirtyN);
  for (let i = 0; i < dirtyN; i++) {
    dirty[i] = i;
    xs[i] += 3;
    ys[i] += 1;
  }
  fullRebuild(full, xs, ys, half);
  incremental(inc, occCount, occCells, xs, ys, half, dirty, dirtyN);
  const a = membershipChecksum(full);
  const b = membershipChecksum(inc);
  assert.equal(b, a, `${label} checksum`);
  console.log(`${label}: checksum ${a.toString(16)} OK, dirty ${dirtyN}/${ENTITIES}`);
  return { full, inc, xs, ys, half, dirty, dirtyN, occCount, occCells };
}

function neighborOracle() {
  const rng = mulberry32(0x0e11);
  const n = 512;
  const range = 90;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const world = GRID * CELL;
  for (let i = 0; i < n; i++) {
    xs[i] = rng() * (world - 8) + 4;
    ys[i] = rng() * (world - 8) + 4;
  }
  const home = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c = (xs[i] / CELL) | 0;
    const r = (ys[i] / CELL) | 0;
    home[i] = r * GRID + c;
  }
  const movers = 16;
  const dirtyCells = new Uint32Array(movers * 2);
  let dirtyN = 0;
  for (let i = 0; i < movers; i++) {
    const prev = home[i];
    xs[i] += CELL * 1.5;
    const c = Math.min(GRID - 1, (xs[i] / CELL) | 0);
    const r = (ys[i] / CELL) | 0;
    home[i] = r * GRID + c;
    dirtyCells[dirtyN++] = prev;
    dirtyCells[dirtyN++] = home[i];
  }
  const affected = new Uint8Array(GRID * GRID);
  const ids = new Uint32Array(GRID * GRID);
  const radius = Math.ceil(range / CELL) + 1;
  stampAffected(affected, ids, 0, GRID, GRID, dirtyCells, dirtyN, radius);
  const rangeSq = range * range;
  let fn = 0;
  let checked = 0;
  for (let a = 0; a < n; a++) {
    const refresh = affected[home[a]] === 1 || a < movers;
    if (refresh) continue;
    for (let b = 0; b < movers; b++) {
      const dx = xs[a] - xs[b];
      const dy = ys[a] - ys[b];
      if (dx * dx + dy * dy <= rangeSq) fn++;
      checked++;
    }
  }
  assert.equal(fn, 0, 'dirty-cell stamp missed a neighbor');
  console.log(`neighbor oracle: FN 0 over ${checked} skipped-vs-mover pairs, radius ${radius}`);
}

console.log(`INCREMENTAL_DIRTY_FRACTION ${INCREMENTAL_DIRTY_FRACTION}`);
checkFraction('one-cell 0%', 0, 1);
checkFraction('one-cell 5%', 0.05, 1);
checkFraction('one-cell 100%', 1, 1);
checkFraction('multi-cell 5%', 0.05, 3);
neighborOracle();

function bench(label, fraction) {
  const rng = mulberry32(99);
  const { xs, ys, half } = place(rng, 1);
  const grid = makeGrid();
  fullRebuild(grid, xs, ys, half);
  const occCount = new Uint8Array(ENTITIES);
  const occCells = new Uint32Array(ENTITIES * OCC_SPAN);
  seedOcc(grid, occCount, occCells);
  const dirtyN = Math.round(ENTITIES * fraction);
  const dirty = new Uint32Array(dirtyN);
  for (let i = 0; i < dirtyN; i++) dirty[i] = i;
  const fullGrid = makeGrid();
  timeIt(`${label} full`, () => {
    fullRebuild(fullGrid, xs, ys, half);
  }, { iterations: 20, warmup: 5 });
  timeIt(`${label} incremental`, () => {
    incremental(grid, occCount, occCells, xs, ys, half, dirty, dirtyN);
  }, { iterations: 20, warmup: 5 });
}

bench('0%', 0);
bench('5%', 0.05);
bench('100%', 1);
console.log('movedBodiesSpatialMicrobench: checksums passed');
