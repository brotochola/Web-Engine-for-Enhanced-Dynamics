import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POLAR_BINS,
  buildVisibilityPolygon,
  clearPolarBins,
  clipVisibilityToPolar,
  rasterBoundarySegment,
} from '../../src/render/visibility/angularSweep.js';
import { mulberry32 } from '../bench/benchMath.js';

// E-41. A light with only compound occluders sweeps nothing, so its sweep
// polygon is the 32-segment placeholder circle, and the polar merge tests only
// three of its edges per bin. The same circle starting one vertex later is the
// same set of edges but not the placeholder, so it takes the full scan: both
// must give the same polygon, bit for bit.

const empty = {
  kind: new Uint8Array(1), cx: new Float32Array(1), cy: new Float32Array(1), cr: new Float32Array(1),
  vertStart: new Int32Array(1), vertCount: new Int32Array(1), vertsX: new Float32Array(8), vertsY: new Float32Array(8),
};

function placeholder(lx, ly, r, Buf = Float32Array) {
  const x = new Buf(64);
  const y = new Buf(64);
  const n = buildVisibilityPolygon(
    lx, ly, r, empty.kind, empty.cx, empty.cy, empty.cr, empty.vertStart, empty.vertCount,
    empty.vertsX, empty.vertsY, 0, x, y, 64,
  );
  return { x, y, n };
}

function merge(lx, ly, r, segs, poly, maxVerts) {
  clearPolarBins(r);
  for (const [x0, y0, x1, y1] of segs) rasterBoundarySegment(x0, y0, x1, y1, lx, ly);
  const outX = new Float32Array(POLAR_BINS);
  const outY = new Float32Array(POLAR_BINS);
  const m = clipVisibilityToPolar(lx, ly, poly.x, poly.y, poly.n, outX, outY, maxVerts);
  return { m, x: Array.from(outX.subarray(0, m)), y: Array.from(outY.subarray(0, m)) };
}

function rotated(poly) {
  const x = new Float32Array(64);
  const y = new Float32Array(64);
  for (let i = 0; i < poly.n; i++) {
    x[i] = poly.x[(i + 1) % poly.n];
    y[i] = poly.y[(i + 1) % poly.n];
  }
  return { x, y, n: poly.n };
}

test('polar merge with the placeholder circle matches the full scan bit for bit', () => {
  const rng = mulberry32(0xe41);
  for (let trial = 0; trial < 60; trial++) {
    const lx = (rng() - 0.5) * 4000;
    const ly = (rng() - 0.5) * 4000;
    const r = 40 + rng() * 1800;
    const segs = [];
    for (let s = 0; s < 6 + (trial % 9) * 4; s++) {
      const a = rng() * Math.PI * 2;
      const d = r * (0.2 + rng() * 0.9);
      const half = 0.05 + rng() * 0.6;
      segs.push([
        lx + Math.cos(a - half) * d, ly + Math.sin(a - half) * d,
        lx + Math.cos(a + half) * d, ly + Math.sin(a + half) * d,
      ]);
    }
    const poly = placeholder(lx, ly, r);
    assert.equal(poly.n, 32);
    for (const maxVerts of [5000, 512, 300, 128, 64, 17, 16, 3]) {
      const fast = merge(lx, ly, r, segs, poly, maxVerts);
      const full = merge(lx, ly, r, segs, rotated(poly), maxVerts);
      assert.equal(fast.m, full.m);
      assert.deepEqual(fast.x, full.x, `trial ${trial} maxVerts ${maxVerts} x`);
      assert.deepEqual(fast.y, full.y, `trial ${trial} maxVerts ${maxVerts} y`);
    }
  }
});

test('a Float64 placeholder takes the same path and gives the same polygon', () => {
  const segs = [[100, 50, 140, -30], [-80, 90, -20, 120]];
  const f32 = merge(10, -5, 300, segs, placeholder(10, -5, 300), 512);
  const f64 = merge(10, -5, 300, segs, placeholder(10, -5, 300, Float64Array), 512);
  const full = merge(10, -5, 300, segs, rotated(placeholder(10, -5, 300)), 512);
  assert.deepEqual(f32, full);
  assert.equal(f64.m, full.m);
  for (let i = 0; i < full.m; i++) {
    assert.ok(Math.abs(f64.x[i] - full.x[i]) < 1e-3 && Math.abs(f64.y[i] - full.y[i]) < 1e-3, `vertex ${i}`);
  }
});
