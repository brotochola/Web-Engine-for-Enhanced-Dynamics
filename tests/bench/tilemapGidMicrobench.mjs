#!/usr/bin/env node
// Kernel: listGidPages + packGidPageRgba8 (native GPU tilemap upload, not getTileId).
//
//   node tests/bench/tilemapGidMicrobench.mjs

import assert from 'node:assert/strict';

import {
  listGidPages,
  gidPageSize,
  gidPageByteLength,
  packGidPageRgba8,
  unpackGidRgba8,
} from '../../src/render/tilemapGid.js';
import { parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const OUTPUT = args.output ? String(args.output) : null;
const MAP = Number(args.map ?? 2082);
const HEIGHT = Number(args.height ?? 416);
const PAGE = Number(args.page ?? 2048);

const pages = listGidPages(MAP, HEIGHT, PAGE);
assert.ok(pages.length > 0, 'no pages');
const first = pages[0];
const { pageW, pageH } = gidPageSize(first);
assert.ok(pageW > 0 && pageH > 0);

const layer = new Int32Array(MAP * HEIGHT);
for (let i = 0; i < layer.length; i++) layer[i] = (i % 97) + 1;
const packed = new Uint8Array(gidPageByteLength(pageW, pageH));
const n = packGidPageRgba8(layer, MAP, first, packed);
assert.equal(n, packed.length);
assert.equal(unpackGidRgba8(packed[0], packed[1], packed[2], packed[3]), layer[0] >>> 0);

let pageChecksum = pages.length;
for (let i = 0; i < pages.length; i++) {
  pageChecksum = (pageChecksum + pages[i].minX + pages[i].maxX * 3 + pages[i].minY * 7) | 0;
}

const cases = {
  listGidPages: timeIt(
    `listGidPages ${MAP}x${HEIGHT} page=${PAGE}`,
    (iters) => {
      let acc = 0;
      for (let i = 0; i < iters; i++) {
        const list = listGidPages(MAP + (i % 3), HEIGHT, PAGE);
        acc += list.length + list[0].maxX;
      }
      if (acc === -1) throw new Error('unreachable');
    },
    { iterations: Number(args.iters ?? 20000) }
  ),
  packGidPageRgba8: timeIt(
    `packGidPageRgba8 ${pageW}x${pageH}`,
    (iters) => {
      let acc = 0;
      for (let i = 0; i < iters; i++) {
        acc += packGidPageRgba8(layer, MAP, first, packed);
      }
      if (acc === -1) throw new Error('unreachable');
    },
    { iterations: Number(args.iters ?? 200) }
  ),
};

const report = {
  feature: 'tilemap-gid',
  map: MAP,
  height: HEIGHT,
  page: PAGE,
  pageCount: pages.length,
  checksum: pageChecksum,
  cases,
};
if (OUTPUT) writeReport(OUTPUT, report);
console.log(`listGidPages ${Math.round(cases.listGidPages.opsPerSec).toLocaleString()} ops/s pages=${pages.length}`);
