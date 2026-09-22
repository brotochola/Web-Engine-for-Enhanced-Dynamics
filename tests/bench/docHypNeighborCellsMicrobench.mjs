/**
 * H-NCACHE kernel: warm Map of neighbor cells vs direct offsets vs interior/border hybrid.
 * Same cell list, same order. Grid like a stationary hunt (cell 128, radius 2).
 */
import { timeIt } from './microbenchHelpers.mjs';
import { generateSymmetricalCirclePattern } from '../../src/util/utils.js';

const GRID_W = 80;
const GRID_H = 80;
const CELL = 128;
const RADIUS = 2;
const MAX_RADIUS = 8;
const QUERIES = 4096;

const pattern = generateSymmetricalCirclePattern(RADIUS, CELL);
const patternLen = pattern.length;
const patternCells = patternLen >> 1;

function cellsFor(row, col) {
  const out = new Uint16Array(patternCells);
  let n = 0;
  for (let i = 0; i < patternLen; i += 2) {
    const r = row + pattern[i];
    const c = col + pattern[i + 1];
    if (r >= 0 && r < GRID_H && c >= 0 && c < GRID_W) out[n++] = r * GRID_W + c;
  }
  return n === patternCells ? out : out.subarray(0, n);
}

function buildQueries() {
  const rows = new Int32Array(QUERIES);
  const cols = new Int32Array(QUERIES);
  let k = 0;
  for (let r = 0; r < GRID_H && k < QUERIES; r++) {
    for (let c = 0; c < GRID_W && k < QUERIES; c++) {
      rows[k] = r;
      cols[k] = c;
      k++;
    }
  }
  return { rows, cols, count: k };
}

function checksumOf(list) {
  let s = 0;
  for (let i = 0; i < list.length; i++) s = (s + list[i] * (i + 1)) | 0;
  return s;
}

const { rows, cols, count } = buildQueries();

const cache = new Map();
let cacheSum = 0;
for (let q = 0; q < count; q++) {
  const cell = rows[q] * GRID_W + cols[q];
  const key = cell * (MAX_RADIUS + 1) + RADIUS;
  let list = cache.get(key);
  if (!list) {
    list = cellsFor(rows[q], cols[q]);
    cache.set(key, list);
  }
  cacheSum = (cacheSum + checksumOf(list)) | 0;
}

function directSum() {
  let s = 0;
  for (let q = 0; q < count; q++) {
    const row = rows[q];
    const col = cols[q];
    let ord = 1;
    for (let i = 0; i < patternLen; i += 2) {
      const r = row + pattern[i];
      const c = col + pattern[i + 1];
      if (r >= 0 && r < GRID_H && c >= 0 && c < GRID_W) {
        s = (s + (r * GRID_W + c) * ord) | 0;
        ord++;
      }
    }
  }
  return s;
}

const interior = RADIUS;
function hybridSum() {
  let s = 0;
  for (let q = 0; q < count; q++) {
    const row = rows[q];
    const col = cols[q];
    const inside =
      row >= interior &&
      col >= interior &&
      row < GRID_H - interior &&
      col < GRID_W - interior;
    let ord = 1;
    if (inside) {
      const base = row * GRID_W + col;
      for (let i = 0; i < patternLen; i += 2) {
        s = (s + (base + pattern[i] * GRID_W + pattern[i + 1]) * ord) | 0;
        ord++;
      }
    } else {
      for (let i = 0; i < patternLen; i += 2) {
        const r = row + pattern[i];
        const c = col + pattern[i + 1];
        if (r >= 0 && r < GRID_H && c >= 0 && c < GRID_W) {
          s = (s + (r * GRID_W + c) * ord) | 0;
          ord++;
        }
      }
    }
  }
  return s;
}

function cacheSumRun() {
  let s = 0;
  for (let q = 0; q < count; q++) {
    const cell = rows[q] * GRID_W + cols[q];
    const key = cell * (MAX_RADIUS + 1) + RADIUS;
    const list = cache.get(key);
    s = (s + checksumOf(list)) | 0;
  }
  return s;
}

const direct = directSum();
const hybrid = hybridSum();
const cached = cacheSumRun();
if (direct !== cached || hybrid !== cached) {
  throw new Error(`checksum cache ${cached} direct ${direct} hybrid ${hybrid}`);
}

const a = timeIt('map-hit', () => cacheSumRun());
const b = timeIt('direct', () => directSum());
const c = timeIt('hybrid', () => hybridSum());
const pct = (x, base) => ((x - base) / base) * 100;
console.log(`direct vs map ${pct(b.opsPerSec, a.opsPerSec).toFixed(1)}%`);
console.log(`hybrid vs map ${pct(c.opsPerSec, a.opsPerSec).toFixed(1)}%`);
console.log(JSON.stringify({
  checksum: cached,
  mapOps: a.opsPerSec,
  directOps: b.opsPerSec,
  hybridOps: c.opsPerSec,
}));
