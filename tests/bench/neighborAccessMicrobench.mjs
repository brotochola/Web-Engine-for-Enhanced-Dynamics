#!/usr/bin/env node
/**
 * E-141: neighbour reads from game code, as entities' own ticks do them, over several entity classes.
 *
 *   node tests/bench/neighborAccessMicrobench.mjs [--entities 2000] [--neighbors 12] [--output path]
 *
 * shipped:  this.neighborCount and this.getNeighbor(k) (gameObject.js), on five classes.
 * row:      the call-free read of the entity's row of Grid's neighbour memory, in a local loop (count at the row's
 *           start, ids after it), with the engine's private fields.
 * Each tick also does a little work per neighbour (a sum), as game code would. Reports ops/s (one op = every entity's
 * tick once) and a checksum (the sum of the ids read).
 */
import { Grid } from '../../src/core/grid.js';
import { GameObject } from '../../src/core/gameObject.js';
import { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

function makeClasses() {
  class Soldier extends GameObject {
    sumShipped() {
      let s = 0;
      const n = this.neighborCount;
      for (let k = 0; k < n; k++) s += this.getNeighbor(k);
      return s + 1;
    }
    sumRow() {
      const nd = Grid._neighborData;
      const o = this._neighborOffset;
      let s = 0;
      for (let k = o + 1, end = o + 1 + nd[o]; k < end; k++) s += nd[k];
      return s + 1;
    }
  }
  class Civilian extends Soldier {}
  class Boid extends GameObject {
    sumShipped() {
      let s = 0;
      for (let k = 0; k < this.neighborCount; k++) s += this.getNeighbor(k) * 2;
      return s;
    }
    sumRow() {
      const nd = Grid._neighborData;
      const o = this._neighborOffset;
      let s = 0;
      for (let k = o + 1, end = o + 1 + nd[o]; k < end; k++) s += nd[k] * 2;
      return s;
    }
  }
  class Car extends Boid {}
  class Ant extends GameObject {
    sumShipped() {
      let s = 0;
      const n = this.neighborCount;
      for (let k = n - 1; k >= 0; k--) s += this.getNeighbor(k);
      return s;
    }
    sumRow() {
      const nd = Grid._neighborData;
      const o = this._neighborOffset;
      let s = 0;
      for (let k = o + nd[o]; k > o; k--) s += nd[k];
      return s;
    }
  }
  return [Soldier, Civilian, Boid, Car, Ant];
}

export function runNeighborAccessMicrobench({ entities = 2000, neighbors = 12 } = {}) {
  const stride = 1 + 32;
  const data = new Uint16Array(new SharedArrayBuffer(entities * stride * 2));
  for (let e = 0; e < entities; e++) {
    data[e * stride] = neighbors;
    for (let k = 0; k < neighbors; k++) data[e * stride + 1 + k] = (e * 7 + k * 13) % entities;
  }
  const savedMax = Grid.maxNeighbors;
  Grid.maxNeighbors = stride - 1;
  Grid._stride = stride;
  Grid._neighborData = data;
  const savedDescriptor = Object.getOwnPropertyDescriptor(Grid, 'neighborData');
  Object.defineProperty(Grid, 'neighborData', { get: () => data, configurable: true });
  try {
    const classes = makeClasses();
    for (const C of classes) GameObject._assignComponentClassMap(C);
    const ents = [];
    for (let i = 0; i < entities; i++) ents.push(new classes[i % classes.length](i, {}, null, { page: true }));
    const shipped = (list) => {
      let s = 0;
      for (let i = 0; i < list.length; i++) s += list[i].sumShipped();
      return s;
    };
    const row = (list) => {
      let s = 0;
      for (let i = 0; i < list.length; i++) s += list[i].sumRow();
      return s;
    };
    const checksum = shipped(ents);
    if (row(ents) !== checksum) throw new Error('the row read sees other neighbours');
    warmNormalCompile(() => shipped(ents.slice(0, 40)));
    warmNormalCompile(() => row(ents.slice(0, 40)));
    const cases = {
      shipped: timeIt('shipped', () => shipped(ents), { iterations: 200 }),
      row: timeIt('row', () => row(ents), { iterations: 200 }),
    };
    const nsPerRead = (c) => (c.ms / c.iterations / (entities * neighbors)) * 1e6;
    for (const [name, c] of Object.entries(cases)) console.log(`${name.padEnd(8)} ~${nsPerRead(c).toFixed(2)} ns a neighbour read`);
    console.log(`checksum ${checksum}`);
    return { feature: 'neighbor-access', entities, neighbors, checksum, cases };
  } finally {
    if (savedDescriptor) Object.defineProperty(Grid, 'neighborData', savedDescriptor);
    Grid.maxNeighbors = savedMax;
  }
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const report = runNeighborAccessMicrobench({ entities: Number(args.entities ?? 2000), neighbors: Number(args.neighbors ?? 12) });
  if (args.output) writeReport(String(args.output), report);
}
