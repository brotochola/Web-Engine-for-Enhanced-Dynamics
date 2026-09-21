#!/usr/bin/env node
// Same-process kernels for the entity-id hotpath campaign.
// Baseline algorithm first, then the bound/integer version. Checksum before timing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { timeIt, writeReport } from './microbenchHelpers.mjs';
import {
  bindEntityIdWidth,
  packPair,
  unpackPair,
  packSpatialPairStamp,
  packSpatialPairStamp16,
  collisionPairKeyWide,
} from '../../src/util/entityIdWidth.js';
import {
  popFl4,
  pushFl4,
  resetFl4,
  popFreeIndex,
  pushFreeIndex,
  resetFreeList,
  popU16,
  pushU16,
  resetU16,
} from '../../src/util/atomicFreeList.js';
import { Grid } from '../../src/core/grid.js';

const NPAIRS = 8192;
const CAP = 4096;

function packIf(width32, minE, maxE) {
  if (width32) return ((minE + maxE) * (minE + maxE + 1)) / 2 + maxE;
  return ((minE & 0xffff) << 16) | (maxE & 0xffff);
}

function unpackCantor(key, out) {
  const w = Math.floor((Math.sqrt(8 * key + 1) - 1) / 2);
  out.b = key - (w * (w + 1)) / 2;
  out.a = w - out.b;
  return out;
}

const mins = new Uint32Array(NPAIRS);
const maxs = new Uint32Array(NPAIRS);
const keys = new Float64Array(NPAIRS);
for (let i = 0; i < NPAIRS; i++) {
  mins[i] = (i * 3) % 299999;
  maxs[i] = (mins[i] + 17 + (i % 50)) % 300000;
  if (maxs[i] < mins[i]) {
    const t = mins[i];
    mins[i] = maxs[i];
    maxs[i] = t;
  }
  keys[i] = ((mins[i] + maxs[i]) * (mins[i] + maxs[i] + 1)) / 2 + maxs[i];
}

let stampChecksum = 0;
for (let a = 0; a < 8; a++) {
  const id = a === 0 ? 1 : a === 1 ? 65537 : 299999;
  stampChecksum = (stampChecksum + packSpatialPairStamp(5, id)) >>> 0;
}
assert.notEqual(packSpatialPairStamp(5, 1), packSpatialPairStamp(5, 65537));
assert.equal(packSpatialPairStamp16(5, 1), packSpatialPairStamp16(5, 65537));

bindEntityIdWidth(32);
const out = { a: 0, b: 0 };
let pairChecksum = 0;
for (let i = 0; i < 64; i++) {
  const k = packPair(mins[i], maxs[i]);
  unpackPair(k, out);
  assert.equal(out.a, mins[i]);
  assert.equal(out.b, maxs[i]);
  pairChecksum = (pairChecksum + (k & 0xffffffff)) >>> 0;
}

const top = new Int32Array(new SharedArrayBuffer(16));
const links = new Uint32Array(new SharedArrayBuffer(CAP * 4));
resetFl4(top, links, CAP, 1);
const a = popFl4(top, links);
pushFl4(top, links, a);
assert.equal(popFl4(top, links), a);
pushFl4(top, links, a);

const top16 = new Int32Array(new SharedArrayBuffer(8));
const links16 = new Uint16Array(new SharedArrayBuffer(CAP * 2));
resetU16(top16, links16, CAP, 1);

Grid.reset();
Grid.initialize(
  {
    gridBuffer: new SharedArrayBuffer(32 * (4 + 8 * 4)),
    neighborBuffer: new SharedArrayBuffer(64 * 5 * 4),
  },
  {
    cellSize: 64,
    gridWidth: 32,
    gridHeight: 1,
    maxEntitiesPerCell: 8,
    maxNeighbors: 4,
    entityIdBytes: 4,
  },
);
let baseChecksum = 0;
for (let c = 0; c < 32; c++) {
  const div = (c * Grid.cellByteSize) / 4 + 1;
  assert.equal(Grid.getCellBase(c), div);
  baseChecksum = (baseChecksum + Grid.getCellBase(c)) >>> 0;
}

const cellByteSize = Grid.cellByteSize;
function baseDiv(cell) {
  return (cell * cellByteSize) / 4 + 1;
}
const stride = Grid._cellIdStride;
const header = Grid._headerIds;
function baseMul(cell) {
  return cell * stride + header;
}

let sink = 0;
const scratch = { a: 0, b: 0 };

const cases = {
  pairIf: timeIt('pair_if_width', (iters) => {
    let s = 0;
    for (let n = 0; n < iters; n++) {
      for (let i = 0; i < NPAIRS; i++) s += packIf(true, mins[i], maxs[i]);
    }
    sink = s;
  }, { iterations: 20 }),
  pairBound: timeIt('pair_let', (iters) => {
    let s = 0;
    for (let n = 0; n < iters; n++) {
      for (let i = 0; i < NPAIRS; i++) s += packPair(mins[i], maxs[i]);
    }
    sink = s;
  }, { iterations: 20 }),
  pairStable: timeIt('pair_stable_if', (iters) => {
    let s = 0;
    for (let n = 0; n < iters; n++) {
      for (let i = 0; i < NPAIRS; i++) s += collisionPairKeyWide(mins[i], maxs[i]);
    }
    sink = s;
  }, { iterations: 20 }),
  popDispatch: timeIt('pop_dispatch_u32', (iters) => {
    for (let i = 0; i < iters; i++) {
      const idx = popFreeIndex(top, links);
      pushFreeIndex(top, links, idx);
    }
  }, { iterations: 200000 }),
  popDirect: timeIt('pop_fl4_direct', (iters) => {
    for (let i = 0; i < iters; i++) {
      const idx = popFl4(top, links);
      pushFl4(top, links, idx);
    }
  }, { iterations: 200000 }),
  popU16direct: timeIt('pop_u16_direct', (iters) => {
    for (let i = 0; i < iters; i++) {
      const idx = popU16(top16, links16);
      pushU16(top16, links16, idx);
    }
  }, { iterations: 200000 }),
  cellDiv: timeIt('cell_base_div', (iters) => {
    let s = 0;
    for (let n = 0; n < iters; n++) {
      for (let c = 0; c < 32; c++) s += baseDiv(c);
    }
    sink = s;
  }, { iterations: 50000 }),
  cellMul: timeIt('cell_base_mul', (iters) => {
    let s = 0;
    for (let n = 0; n < iters; n++) {
      for (let c = 0; c < 32; c++) s += baseMul(c);
    }
    sink = s;
  }, { iterations: 50000 }),
  stayUnpack: timeIt('stay_unpack_cantor', (iters) => {
    let s = 0;
    for (let n = 0; n < iters; n++) {
      for (let i = 0; i < NPAIRS; i++) {
        unpackCantor(keys[i], scratch);
        s += scratch.a + scratch.b;
      }
    }
    sink = s;
  }, { iterations: 30 }),
  stayColumns: timeIt('stay_u32_columns', (iters) => {
    let s = 0;
    for (let n = 0; n < iters; n++) {
      for (let i = 0; i < NPAIRS; i++) s += mins[i] + maxs[i];
    }
    sink = s;
  }, { iterations: 30 }),
};

bindEntityIdWidth(16);
resetFreeList(top, links, CAP, 1);

const report = {
  feature: 'entity-id-hotpath-kernels',
  stampChecksum,
  pairChecksum,
  baseChecksum,
  sink,
  cases,
};
const outPath = path.join('tests', 'results', 'entity-id-hotpath', 'kernels.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
writeReport(outPath, report);
console.log(JSON.stringify({
  pairIf: cases.pairIf.opsPerSec,
  pairLet: cases.pairBound.opsPerSec,
  pairStable: cases.pairStable.opsPerSec,
  popDispatch: cases.popDispatch.opsPerSec,
  popDirect: cases.popDirect.opsPerSec,
  popU16: cases.popU16direct.opsPerSec,
  cellDiv: cases.cellDiv.opsPerSec,
  cellMul: cases.cellMul.opsPerSec,
  stayUnpack: cases.stayUnpack.opsPerSec,
  stayColumns: cases.stayColumns.opsPerSec,
}, null, 2));
