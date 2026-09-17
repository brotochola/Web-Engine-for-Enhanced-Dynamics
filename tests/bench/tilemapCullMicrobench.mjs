#!/usr/bin/env node
// Kernel: listVisibleChunks + listEvictChunkKeys (pixi viewport cull, not getTileId).
//
//   node tests/bench/tilemapCullMicrobench.mjs

import assert from 'node:assert/strict';

import {
  listVisibleChunks,
  listEvictChunkKeys,
  chunkKey,
} from '../../src/render/tilemapCull.js';
import { parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const OUTPUT = args.output ? String(args.output) : null;
const MAP = Number(args.map ?? 64);
const CHUNK = Number(args.chunk ?? 8);
const RING = Number(args.ring ?? 1);

function checksumChunks(list) {
  const chunks = list.chunks;
  const n = list.count;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const c = chunks[i];
    s = (s + (c.cx * 131 + c.cy) * 17 + (c.tileRect.minX | 0)) | 0;
  }
  return s;
}

const view = {
  viewMinX: 4.5,
  viewMinY: 9.2,
  viewMaxX: 28.7,
  viewMaxY: 33.1,
  chunkW: CHUNK,
  chunkH: CHUNK,
  mapW: MAP,
  mapH: MAP,
};

const listA = { chunks: [], count: 0 };
const listB = { chunks: [], count: 0 };
const a = listVisibleChunks(view, RING, listA);
const b = listVisibleChunks({
  ...view,
  viewMinX: view.viewMinX + 0.1,
  viewMaxX: view.viewMaxX + 0.1,
}, RING, listB);
assert.ok(a.count > 0, 'visible empty');
assert.equal(typeof a.chunks[0].key, 'number');
assert.equal(a.chunks[0].key, chunkKey(a.chunks[0].cx, a.chunks[0].cy));
const keep = listVisibleChunks(view, 2, { chunks: [], count: 0 });
const visKeys = [];
for (let i = 0; i < a.count; i++) visKeys.push(a.chunks[i].key);
const keepKeys = new Set();
for (let i = 0; i < keep.count; i++) keepKeys.add(keep.chunks[i].key);
const evict = listEvictChunkKeys(visKeys, keepKeys, []);
assert.ok(Array.isArray(evict));
const sumA = checksumChunks(a);
assert.ok(sumA !== 0 || a.count === 0);

const timedOut = { chunks: [], count: 0 };
const timedView = {
  viewMinX: 2,
  viewMinY: 3,
  viewMaxX: 22,
  viewMaxY: 24,
  chunkW: CHUNK,
  chunkH: CHUNK,
  mapW: MAP,
  mapH: MAP,
};

const cases = {
  listVisibleChunks: timeIt(
    `listVisibleChunks map=${MAP} chunk=${CHUNK}`,
    (iters) => {
      let acc = 0;
      for (let i = 0; i < iters; i++) {
        const ox = (i % 17) * 0.37;
        timedView.viewMinX = 2 + ox;
        timedView.viewMinY = 3 + ox * 0.5;
        timedView.viewMaxX = 22 + ox;
        timedView.viewMaxY = 24 + ox * 0.5;
        const chunks = listVisibleChunks(timedView, RING, timedOut);
        acc += chunks.count + checksumChunks(chunks);
      }
      if (acc === -1) throw new Error('unreachable');
    },
    { iterations: Number(args.iters ?? 20000) }
  ),
  listEvictChunkKeys: timeIt(
    'listEvictChunkKeys',
    (iters) => {
      const cached = visKeys.slice();
      cached.push(chunkKey(99, 99));
      const evictOut = [];
      let n = 0;
      for (let i = 0; i < iters; i++) {
        n += listEvictChunkKeys(cached, keepKeys, evictOut).length;
      }
      if (n === -1) throw new Error('unreachable');
    },
    { iterations: Number(args.iters ?? 20000) }
  ),
};

const report = {
  feature: 'tilemap-cull',
  map: MAP,
  chunk: CHUNK,
  checksum: sumA,
  movedChecksum: checksumChunks(b),
  cases,
};
if (OUTPUT) writeReport(OUTPUT, report);
console.log(`listVisibleChunks ${Math.round(cases.listVisibleChunks.opsPerSec).toLocaleString()} ops/s checksum=${sumA}`);
