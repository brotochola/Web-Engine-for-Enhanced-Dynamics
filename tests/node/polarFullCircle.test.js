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
// polygon is the 32-segment placeholder circle. E-41 merged it at three edges
// per bin and anything else with the full scan; E-43's arc scatter now merges
// both. The same circle starting one vertex later is the same set of edges, so
// it must still give the same polygon, bit for bit.

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

// E-42. The bin directions come from a cos/sin table built with the loops' own
// angle expression. These hashes are the merged polygons from the code before
// the table (and before E-41), for a light with no sweep (nearest), a real sweep
// (merge) and the placeholder circle (full), at four vertex caps.
const GOLDEN = {
  nearest_5000: [512, 27090489], nearest_512: [512, 27090489], nearest_128: [128, 428382817], nearest_17: [17, 4136368722],
  merge_5000: [512, 2828365352], merge_512: [512, 2828365352], merge_128: [128, 1255936873], merge_17: [17, 547287056],
  full_5000: [512, 2528039606], full_512: [512, 2528039606], full_128: [128, 4289685741], full_17: [17, 3401231949],
};

function fnv(xs, ys, n) {
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < n; i++) {
    f[0] = xs[i]; h = Math.imul(h ^ u[0], 16777619) >>> 0;
    f[0] = ys[i]; h = Math.imul(h ^ u[0], 16777619) >>> 0;
  }
  return h;
}

test('polar merge output is pinned bit for bit (E-41, E-42)', () => {
  const kind = new Uint8Array(8), cx = new Float32Array(8), cy = new Float32Array(8), cr = new Float32Array(8);
  const vs = new Int32Array(8), vc = new Int32Array(8), vx = new Float32Array(64), vy = new Float32Array(64);
  kind[0] = 0; cx[0] = 60; cy[0] = 10; cr[0] = 15;
  kind[1] = 0; cx[1] = -40; cy[1] = 70; cr[1] = 22;
  const segs = [];
  for (let i = 0; i < 40; i++) {
    const a0 = (i / 40) * Math.PI * 2;
    const a1 = ((i + 0.6) / 40) * Math.PI * 2;
    segs.push([Math.cos(a0) * 130, Math.sin(a0) * 130, Math.cos(a1) * 150, Math.sin(a1) * 150]);
  }
  for (const [name, lx, ly, occ] of [['nearest', 0, 0, -1], ['merge', 3.5, -7.25, 2], ['full', 11.5, 4.75, 0]]) {
    for (const maxVerts of [5000, 512, 128, 17]) {
      const sx = new Float32Array(512), sy = new Float32Array(512);
      let n = 0;
      if (occ >= 0) n = buildVisibilityPolygon(lx, ly, 220, kind, cx, cy, cr, vs, vc, vx, vy, occ, sx, sy, 512);
      clearPolarBins(220);
      for (const [a, b, c, d] of segs) rasterBoundarySegment(a + lx, b + ly, c + lx, d + ly, lx, ly);
      const ox = new Float32Array(POLAR_BINS), oy = new Float32Array(POLAR_BINS);
      const k = clipVisibilityToPolar(lx, ly, sx, sy, n, ox, oy, maxVerts);
      assert.deepEqual([k, fnv(ox, oy, k)], GOLDEN[`${name}_${maxVerts}`], `${name} maxVerts ${maxVerts}`);
    }
  }
});
