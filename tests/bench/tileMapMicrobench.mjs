#!/usr/bin/env node
// L1: TileMap.getTileId ns/op (Wave K).
//
//   node tests/bench/tileMapMicrobench.mjs

import assert from 'node:assert/strict';

import { TileMap } from '../../src/core/tileMap.js';
import { parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const OUTPUT = args.output ? String(args.output) : null;
const W = Number(args.mapW ?? 128);
const H = Number(args.mapH ?? 128);
const TW = 16;
const TH = 16;
const TILES = W * H;
const data = new Array(TILES);
for (let i = 0; i < TILES; i++) data[i] = (i % 17) + 1;

TileMap.initializeFromLoaded({
  benchMap: {
    data: {
      width: W,
      height: H,
      tilewidth: TW,
      tileheight: TH,
      tilesets: [{ firstgid: 1, columns: 8, tilewidth: TW, tileheight: TH }],
      layers: [{ type: 'tilelayer', name: 'ground', data, visible: true, opacity: 1 }],
    },
  },
});

const map = TileMap.get('benchMap');
assert.ok(map, 'benchMap missing');
assert.equal(map.getTileId(0, 0, 'ground'), 1);
assert.equal(map.getTileId(TW, 0, 'ground'), 2);
assert.equal(map.getTileId(-TW, 0), 0);

const cases = {
  getTileId: timeIt('getTileId', (iters) => {
    let sum = 0;
    for (let i = 0; i < iters; i++) {
      const x = (i * 13) % (W * TW);
      const y = (i * 7) % (H * TH);
      sum += map.getTileId(x, y, 'ground');
    }
    if (sum === -1) throw new Error('unreachable');
  }, { iterations: Number(args.iters ?? 400000) }),
};

const nsPerOp = (cases.getTileId.ms / cases.getTileId.iterations) * 1e6;
const report = {
  feature: 'tilemap-getTileId',
  map: [W, H],
  nsPerOp,
  cases,
};
if (OUTPUT) writeReport(OUTPUT, report);
console.log(`getTileId ~${nsPerOp.toFixed(1)} ns/op`);
