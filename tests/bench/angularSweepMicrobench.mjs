#!/usr/bin/env node
// L1: AngularSweep visibility polygons/s + winding assert (Wave H/D).
//
//   node tests/bench/angularSweepMicrobench.mjs
//   node tests/bench/angularSweepMicrobench.mjs --output tests/results/angular-sweep-l1.json

import assert from 'node:assert/strict';

import {
  OCC_CIRCLE,
  OCC_POLY,
  buildVisibilityPolygon,
  writeOrientedBoxVerts,
} from '../../src/render/visibility/angularSweep.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

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
};

const report = {
  feature: 'angular-sweep',
  occluders: OCCLUDERS,
  vertexCount: n,
  signedArea: area,
  cases,
};
if (OUTPUT) writeReport(OUTPUT, report);
