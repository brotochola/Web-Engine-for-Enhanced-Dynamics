#!/usr/bin/env node
// L1: 8-dir bucket Dijkstra matching particle_worker flowfield costs (Wave E).
//
//   node tests/bench/navGridMicrobench.mjs

import assert from 'node:assert/strict';

import { DIRECTION } from '../../src/core/navGrid.js';
import { parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const OUTPUT = args.output ? String(args.output) : null;
const W = Number(args.gridW ?? 64);
const H = Number(args.gridH ?? 64);
const TOTAL = W * H;

const NAV_DX = [0, 1, 1, 1, 0, -1, -1, -1];
const NAV_DY = [-1, -1, 0, 1, 1, 1, 0, -1];
const NAV_COST = [10, 14, 10, 14, 10, 14, 10, 14];

function dijkstra(walkability, targetCell, distance) {
  distance.fill(65535);
  const head = new Int32Array(65536);
  const next = new Int32Array(TOTAL);
  head.fill(-1);
  next.fill(-1);
  let bucketCount = 0;
  let bucketHeadDistance = 0;
  let maxDistance = 0;

  function insert(cell, dist) {
    const b = dist < 65535 ? dist : 65535;
    next[cell] = head[b];
    head[b] = cell;
    bucketCount++;
    if (b > maxDistance) maxDistance = b;
  }

  function pop(dist) {
    const cell = head[dist];
    if (cell < 0) return -1;
    head[dist] = next[cell];
    next[cell] = -1;
    bucketCount--;
    return cell;
  }

  distance[targetCell] = 0;
  insert(targetCell, 0);
  const visited = new Uint8Array(TOTAL);

  while (bucketCount > 0) {
    while (bucketHeadDistance <= maxDistance && head[bucketHeadDistance] < 0) {
      bucketHeadDistance++;
    }
    if (bucketHeadDistance > maxDistance) break;
    const cell = pop(bucketHeadDistance);
    if (cell < 0 || visited[cell]) continue;
    visited[cell] = 1;
    const cellDist = distance[cell];
    const cellX = cell % W;
    const cellY = (cell / W) | 0;
    for (let dir = 0; dir < 8; dir++) {
      const nx = cellX + NAV_DX[dir];
      const ny = cellY + NAV_DY[dir];
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const neighbor = ny * W + nx;
      if (walkability[neighbor] === 0 || visited[neighbor]) continue;
      const newDist = cellDist + NAV_COST[dir];
      if (newDist < distance[neighbor]) {
        distance[neighbor] = newDist;
        insert(neighbor, Math.min(newDist, 65535));
      }
    }
  }
}

const walkability = new Uint8Array(TOTAL);
walkability.fill(1);
for (let x = 10; x < 50; x++) walkability[20 * W + x] = 0;

const distance = new Uint16Array(TOTAL);
const target = 40 * W + 40;
dijkstra(walkability, target, distance);
assert.equal(distance[target], 0);
assert.equal(distance[20 * W + 20], 65535);
assert.ok(distance[21 * W + 20] < 65535, 'cell south of wall should be reachable around it');
assert.ok(distance[0] < 65535, 'origin should reach target around the wall');
void DIRECTION;

const cases = {
  dijkstra: timeIt('flowfield_dijkstra', (iters) => {
    for (let i = 0; i < iters; i++) dijkstra(walkability, target, distance);
  }, { iterations: Number(args.iters ?? 80) }),
};

const report = {
  feature: 'nav-grid-dijkstra',
  grid: [W, H],
  targetDistOrigin: distance[0],
  cases,
};
if (OUTPUT) writeReport(OUTPUT, report);
