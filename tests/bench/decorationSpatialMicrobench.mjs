#!/usr/bin/env node
// L1: DecorationSpatial.queryCircle ops/s (Wave G).
//
//   node tests/bench/decorationSpatialMicrobench.mjs

import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { DecorationSpatial } from '../../src/core/decorationSpatial.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const OUTPUT = args.output ? String(args.output) : null;
const N = Number(args.decorations ?? 4096);
const CELL = Number(args.cellSize ?? 64);
const GRID_W = Number(args.gridW ?? 32);
const GRID_H = Number(args.gridH ?? 32);
const RADIUS = Number(args.radius ?? 80);
const SEED = Number(args.seed ?? 0xdec0);

DecorationComponent.initializeArrays(
  new SharedArrayBuffer(DecorationComponent.getBufferSize(N)),
  N
);
DecorationSpatial.reset();
DecorationSpatial.initialize(
  {
    head: new SharedArrayBuffer(GRID_W * GRID_H * 2),
    next: new SharedArrayBuffer(N * 2),
    prev: new SharedArrayBuffer(N * 2),
    cellOf: new SharedArrayBuffer(N * 4),
    lock: new SharedArrayBuffer(4),
  },
  {
    cellSize: CELL,
    gridWidth: GRID_W,
    gridHeight: GRID_H,
    maxDecorations: N,
  },
  true
);

const rng = mulberry32(SEED);
const worldW = GRID_W * CELL;
const worldH = GRID_H * CELL;
for (let i = 0; i < N; i++) {
  DecorationComponent.x[i] = 4 + rng() * (worldW - 8);
  DecorationComponent.y[i] = 4 + rng() * (worldH - 8);
  DecorationSpatial.insert(i);
}

const cx = worldW * 0.5;
const cy = worldH * 0.5;
const out = new Uint16Array(N);
const count = DecorationSpatial.queryCircle(cx, cy, RADIUS, out);
assert.ok(count > 0, 'queryCircle found nobody');
const r2 = RADIUS * RADIUS;
for (let i = 0; i < count; i++) {
  const idx = out[i];
  const dx = DecorationComponent.x[idx] - cx;
  const dy = DecorationComponent.y[idx] - cy;
  assert.ok(dx * dx + dy * dy <= r2 + 1e-3, `false positive ${idx}`);
}

const cases = {
  queryCircle: timeIt('queryCircle', (iters) => {
    for (let i = 0; i < iters; i++) DecorationSpatial.queryCircle(cx, cy, RADIUS, out);
  }, { iterations: Number(args.iters ?? 4000) }),
};

const report = {
  feature: 'decoration-spatial',
  decorations: N,
  hitCount: count,
  cases,
};
if (OUTPUT) writeReport(OUTPUT, report);

DecorationSpatial.reset();
