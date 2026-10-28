#!/usr/bin/env node
// L1: TileMap.getTileId ns/op (Wave K), and E-142's candidates for its world-to-tile step.
//
//   node tests/bench/tileMapMicrobench.mjs [--mapW 128 --mapH 128 --iters 400000]
//
// shipped:    TileMap.getTileId(x, y, 'ground'), as tilemapStressScene calls it (the layer looked up by name).
// layer:      the shipped TileMapLayer.getTileId, without the lookup.
// The rest are copies of the layer method with another world-to-tile step, over the same data:
// floorDiv:   Math.floor(x / w), the N-78 fix (a coordinate in (-w, 0) is outside, not tile 0).
// guardDiv:   a negative or NaN coordinate is outside, then (x / w) | 0.
// guardRecip: the same guard, then (x * (1 / w)) | 0, the reciprocal stored with the layer.
// The parity check counts where each form's tile differs from Math.floor(x / w) over widths 16, 24, 48, 49 and 100.

import assert from 'node:assert/strict';

import { TileMap } from '../../src/core/tileMap.js';
import { parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const OUTPUT = args.output ? String(args.output) : null;
const W = Number(args.mapW ?? 128);
const H = Number(args.mapH ?? 128);
const ITERS = Number(args.iters ?? 400000);
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
const layer = map.getLayer('ground');
assert.equal(map.getTileId(0, 0, 'ground'), 1);
assert.equal(map.getTileId(TW, 0, 'ground'), 2);
assert.equal(map.getTileId(-TW, 0), 0);

/** A TileMapLayer copy with another world-to-tile step: the fields the shipped one has, plus the reciprocals. */
class FloorDivLayer {
  constructor(src) {
    this.data = src.data;
    this.mapWidth = src.mapWidth;
    this.mapHeight = src.mapHeight;
    this.tileWidth = src.tileWidth;
    this.tileHeight = src.tileHeight;
  }
  getTileId(worldX, worldY) {
    const tileX = Math.floor(worldX / this.tileWidth);
    const tileY = Math.floor(worldY / this.tileHeight);
    if (tileX < 0 || tileX >= this.mapWidth || tileY < 0 || tileY >= this.mapHeight) return 0;
    return this.data[tileY * this.mapWidth + tileX];
  }
}

class GuardDivLayer {
  constructor(src) {
    this.data = src.data;
    this.mapWidth = src.mapWidth;
    this.mapHeight = src.mapHeight;
    this.tileWidth = src.tileWidth;
    this.tileHeight = src.tileHeight;
  }
  getTileId(worldX, worldY) {
    if (!(worldX >= 0 && worldY >= 0)) return 0;
    const tileX = (worldX / this.tileWidth) | 0;
    const tileY = (worldY / this.tileHeight) | 0;
    if (tileX >= this.mapWidth || tileY >= this.mapHeight) return 0;
    return this.data[tileY * this.mapWidth + tileX];
  }
}

class GuardRecipLayer {
  constructor(src) {
    this.data = src.data;
    this.mapWidth = src.mapWidth;
    this.mapHeight = src.mapHeight;
    this.invTileWidth = 1 / src.tileWidth;
    this.invTileHeight = 1 / src.tileHeight;
  }
  getTileId(worldX, worldY) {
    if (!(worldX >= 0 && worldY >= 0)) return 0;
    const tileX = (worldX * this.invTileWidth) | 0;
    const tileY = (worldY * this.invTileHeight) | 0;
    if (tileX >= this.mapWidth || tileY >= this.mapHeight) return 0;
    return this.data[tileY * this.mapWidth + tileX];
  }
}

/** The world-pixel bounds first: negatives, NaN, the infinities and the far side out at once; then truncation. */
class BoundsDivLayer {
  constructor(src) {
    this.data = src.data;
    this.mapWidth = src.mapWidth;
    this.mapHeight = src.mapHeight;
    this.tileWidth = src.tileWidth;
    this.tileHeight = src.tileHeight;
    this.widthPx = src.mapWidth * src.tileWidth;
    this.heightPx = src.mapHeight * src.tileHeight;
  }
  getTileId(worldX, worldY) {
    if (!(worldX >= 0 && worldX < this.widthPx && worldY >= 0 && worldY < this.heightPx)) return 0;
    const tileX = (worldX / this.tileWidth) | 0;
    const tileY = (worldY / this.tileHeight) | 0;
    // A width that is not a power of two can round a quotient just under the edge up to it.
    if (tileX >= this.mapWidth || tileY >= this.mapHeight) return 0;
    return this.data[tileY * this.mapWidth + tileX];
  }
}

const variants = {
  layer,
  floorDiv: new FloorDivLayer(layer),
  guardDiv: new GuardDivLayer(layer),
  guardRecip: new GuardRecipLayer(layer),
  boundsDiv: new BoundsDivLayer(layer),
};

// The coordinates no tile holds: boundsDiv answers 0 (empty) for each. The shipped form returns tile 0 for (-w, 0), NaN
// and the infinities; floorDiv reads data[NaN] for NaN.
for (const [x, y] of [[-0.5, 4], [4, -0.5], [NaN, 4], [4, NaN], [Infinity, 4], [-Infinity, 4], [4, Infinity], [1e12, 4], [W * TW, 4], [4, H * TH]]) {
  assert.equal(variants.boundsDiv.getTileId(x, y), 0, `boundsDiv at ${x}, ${y}`);
}

// Parity: each form's tile against Math.floor(x / w), on quarter pixels from -2 tiles to 400 tiles.
const tileOf = {
  shipped: (x, w) => (x / w) | 0,
  guardDiv: (x, w) => (x >= 0 ? (x / w) | 0 : -1),
  guardRecip: (x, w, inv) => (x >= 0 ? (x * inv) | 0 : -1),
};
const parity = {};
for (const w of [16, 24, 48, 49, 100]) {
  const inv = 1 / w;
  const row = { shipped: 0, guardDiv: 0, guardRecip: 0 };
  for (let q = -8 * w; q <= 1600 * w; q++) {
    const x = q * 0.25;
    const want = Math.floor(x / w);
    for (const name of Object.keys(row)) {
      const got = tileOf[name](x, w, inv);
      // A negative tile is outside the map whichever negative it is.
      if (want < 0 ? got >= 0 : got !== want) row[name]++;
    }
  }
  parity[w] = row;
}
console.log('tiles that differ from Math.floor(x / w):', JSON.stringify(parity));

// One loop per case, written out: a loop shared by the cases would make its call site polymorphic.
const MAP_W_PX = W * TW;
const MAP_H_PX = H * TH;
const { floorDiv, guardDiv, guardRecip, boundsDiv } = variants;
const loops = {
  shipped(iters) {
    let sum = 0;
    for (let i = 0; i < iters; i++) sum += map.getTileId((i * 13) % MAP_W_PX, (i * 7) % MAP_H_PX, 'ground');
    return sum;
  },
  layer(iters) {
    let sum = 0;
    for (let i = 0; i < iters; i++) sum += layer.getTileId((i * 13) % MAP_W_PX, (i * 7) % MAP_H_PX);
    return sum;
  },
  floorDiv(iters) {
    let sum = 0;
    for (let i = 0; i < iters; i++) sum += floorDiv.getTileId((i * 13) % MAP_W_PX, (i * 7) % MAP_H_PX);
    return sum;
  },
  guardDiv(iters) {
    let sum = 0;
    for (let i = 0; i < iters; i++) sum += guardDiv.getTileId((i * 13) % MAP_W_PX, (i * 7) % MAP_H_PX);
    return sum;
  },
  guardRecip(iters) {
    let sum = 0;
    for (let i = 0; i < iters; i++) sum += guardRecip.getTileId((i * 13) % MAP_W_PX, (i * 7) % MAP_H_PX);
    return sum;
  },
  boundsDiv(iters) {
    let sum = 0;
    for (let i = 0; i < iters; i++) sum += boundsDiv.getTileId((i * 13) % MAP_W_PX, (i * 7) % MAP_H_PX);
    return sum;
  },
};

// Same answers on the timed coordinates (all inside the map).
const checksum = loops.shipped(ITERS);
for (const [name, loop] of Object.entries(loops)) assert.equal(loop(ITERS), checksum, `${name} checksum`);

const cases = {};
for (const [name, loop] of Object.entries(loops)) {
  warmNormalCompile(() => loop(64));
  cases[name] = timeIt(name, loop, { iterations: ITERS });
}

const nsPerOp = (c) => (c.ms / c.iterations) * 1e6;
const report = {
  feature: 'tilemap-getTileId',
  map: [W, H],
  nsPerOp: Object.fromEntries(Object.entries(cases).map(([k, c]) => [k, nsPerOp(c)])),
  parity,
  checksum,
  cases,
};
if (OUTPUT) writeReport(OUTPUT, report);
for (const [name, c] of Object.entries(cases)) console.log(`${name.padEnd(11)} ~${nsPerOp(c).toFixed(2)} ns/op`);
