#!/usr/bin/env node
// L1: AngularSweep visibility polygons/s + winding assert (Wave H/D).
//
//   node tests/bench/angularSweepMicrobench.mjs
//   node tests/bench/angularSweepMicrobench.mjs --output tests/results/angular-sweep-l1.json

import assert from 'node:assert/strict';

import {
  OCC_CIRCLE,
  OCC_POLY,
  POLAR_BINS,
  buildVisibilityPolygon,
  clearPolarBins,
  clipVisibilityToPolar,
  rasterBoundarySegment,
  writeOrientedBoxVerts,
} from '../../src/render/visibility/angularSweep.js';
import { checksumFloats, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const OUTPUT = args.output ? String(args.output) : null;
const OCCLUDERS = Number(args.occluders ?? 24);
const MAX_VERTS = Number(args.maxVerts ?? 256);
const SEED = Number(args.seed ?? 0xa5a5);

function signedArea(xs, ys, n) {
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += xs[i] * ys[j] - xs[j] * ys[i];
  }
  return a;
}

const rng = mulberry32(SEED);
const kind = new Uint8Array(OCCLUDERS);
const cx = new Float32Array(OCCLUDERS);
const cy = new Float32Array(OCCLUDERS);
const cr = new Float32Array(OCCLUDERS);
const vertStart = new Int32Array(OCCLUDERS);
const vertCount = new Uint8Array(OCCLUDERS);
const vertsX = new Float32Array(OCCLUDERS * 4);
const vertsY = new Float32Array(OCCLUDERS * 4);
const outX = new Float32Array(MAX_VERTS);
const outY = new Float32Array(MAX_VERTS);

let pool = 0;
for (let i = 0; i < OCCLUDERS; i++) {
  const ang = (i / OCCLUDERS) * Math.PI * 2;
  const dist = 80 + rng() * 40;
  if ((i & 1) === 0) {
    kind[i] = OCC_CIRCLE;
    cx[i] = Math.cos(ang) * dist;
    cy[i] = Math.sin(ang) * dist;
    cr[i] = 8 + rng() * 6;
    vertStart[i] = 0;
    vertCount[i] = 0;
  } else {
    kind[i] = OCC_POLY;
    const wx = Math.cos(ang) * dist;
    const wy = Math.sin(ang) * dist;
    vertStart[i] = pool;
    writeOrientedBoxVerts(vertsX, vertsY, pool, wx, wy, 16, 12, 1, 0, 0, 0);
    vertCount[i] = 4;
    pool += 4;
  }
}

const n = buildVisibilityPolygon(
  0, 0, 220,
  kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
  OCCLUDERS, outX, outY, MAX_VERTS
);
assert.ok(n >= 3, `visibility polygon too small (${n})`);
const area = signedArea(outX, outY, n);
assert.ok(Math.abs(area) > 1, `degenerate winding area=${area}`);

const emptyN = buildVisibilityPolygon(
  0, 0, 220,
  kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
  0, outX, outY, MAX_VERTS
);
assert.ok(emptyN >= 3, 'empty-light disc should tessellate');

const SEGMENTS = 80;
const polarX = new Float32Array(POLAR_BINS);
const polarY = new Float32Array(POLAR_BINS);
const soup = new Float32Array(SEGMENTS * 4);
for (let i = 0; i < SEGMENTS; i++) {
  const a0 = (i / SEGMENTS) * Math.PI * 2;
  const a1 = ((i + 0.65) / SEGMENTS) * Math.PI * 2;
  soup[i * 4] = Math.cos(a0) * 90;
  soup[i * 4 + 1] = Math.sin(a0) * 90;
  soup[i * 4 + 2] = Math.cos(a1) * 90;
  soup[i * 4 + 3] = Math.sin(a1) * 90;
}

function runPolar() {
  clearPolarBins(220);
  for (let i = 0; i < SEGMENTS; i++) {
    const o = i * 4;
    rasterBoundarySegment(soup[o], soup[o + 1], soup[o + 2], soup[o + 3], 0, 0);
  }
  return clipVisibilityToPolar(0, 0, polarX, polarY, 0, polarX, polarY, POLAR_BINS);
}

const polarN = runPolar();
assert.ok(polarN === POLAR_BINS, `polar polygon ${polarN}`);
const polarChecksum = checksumFloats(polarX, polarN) ^ checksumFloats(polarY, polarN);

// Review M5. A light with both regular and compound occluders merges its sweep
// polygon into the polar bins: n > 0 runs sweepDistAt for every bin (E-43).
// runPolar passes n = 0, so that loop was never timed.
const sweepX = outX.slice(0, n);
const sweepY = outY.slice(0, n);
function runPolarMerge() {
  clearPolarBins(220);
  for (let i = 0; i < SEGMENTS; i++) {
    const o = i * 4;
    rasterBoundarySegment(soup[o], soup[o + 1], soup[o + 2], soup[o + 3], 0, 0);
  }
  return clipVisibilityToPolar(0, 0, sweepX, sweepY, n, polarX, polarY, POLAR_BINS);
}
const mergeN = runPolarMerge();
assert.ok(mergeN === POLAR_BINS, `polar merge polygon ${mergeN}`);
const mergeChecksum = checksumFloats(polarX, mergeN) ^ checksumFloats(polarY, mergeN);
assert.notEqual(mergeChecksum, polarChecksum, 'the sweep polygon must change the merged outline');

const cases = {
  sweep: timeIt('visibility_polygon', (iters) => {
    for (let i = 0; i < iters; i++) {
      buildVisibilityPolygon(
        0, 0, 220,
        kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
        OCCLUDERS, outX, outY, MAX_VERTS
      );
    }
  }, { iterations: Number(args.iters ?? 4000) }),
  polar: timeIt('polar_nearest', (iters) => {
    for (let i = 0; i < iters; i++) runPolar();
  }, { iterations: Number(args.iters ?? 400) }),
  polarMerge: timeIt('polar_merge', (iters) => {
    for (let i = 0; i < iters; i++) runPolarMerge();
  }, { iterations: Number(args.iters ?? 400) }),
};

const report = {
  feature: 'angular-sweep',
  occluders: OCCLUDERS,
  vertexCount: n,
  signedArea: area,
  polarVerts: polarN,
  polarChecksum,
  mergeSweepVerts: n,
  mergeChecksum,
  cases,
};
if (OUTPUT) writeReport(OUTPUT, report);
