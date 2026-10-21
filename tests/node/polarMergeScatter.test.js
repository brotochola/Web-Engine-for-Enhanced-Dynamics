import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OCC_CIRCLE,
  OCC_POLY,
  POLAR_BINS,
  buildVisibilityPolygon,
  clearPolarBins,
  clipVisibilityToPolar,
  rasterBoundarySegment,
} from '../../src/render/visibility/angularSweep.js';
import { normalizeAngleSigned } from '../../src/util/utils.js';
import { mulberry32 } from '../bench/benchMath.js';

// E-43. The merge tests each sweep edge only against the rays in the arc it
// subtends from the light. The reference below is the code before that: the
// same boundary raster into its own bins, then every sweep edge for every ray.
// Both must give the same polygon, bit for bit, for real sweeps and for
// arbitrary polygons with edges through, near and in line with the light.

const TWO_PI = Math.PI * 2;
const BIN_SCALE = POLAR_BINS / TWO_PI;
const refDist = new Float32Array(POLAR_BINS);
let refActive = 0;

function raySegT(ox, oy, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax;
  const ey = by - ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-12) return Infinity;
  const fx = ax - ox;
  const fy = ay - oy;
  const t = (fx * ey - fy * ex) / denom;
  const u = (fx * dy - fy * dx) / denom;
  if (t > 1e-4 && u >= -1e-4 && u <= 1 + 1e-4) return t;
  return Infinity;
}

function refStamp(b, x0, y0, x1, y1, lx, ly) {
  const ang = -Math.PI + (2 * b + 1) * 0.5 * (TWO_PI / POLAR_BINS);
  const t = raySegT(lx, ly, Math.cos(ang), Math.sin(ang), x0, y0, x1, y1);
  if (t < refDist[b]) {
    refDist[b] = t;
    refActive = 1;
  }
}

function refRaster(x0, y0, x1, y1, lx, ly) {
  let open = normalizeAngleSigned(Math.atan2(y0 - ly, x0 - lx));
  let close = normalizeAngleSigned(Math.atan2(y1 - ly, x1 - lx));
  let span = close - open;
  if (span < 0) span += TWO_PI;
  if (span > Math.PI) {
    const swap = open;
    open = close;
    close = swap;
    span = TWO_PI - span;
  }
  if (!(span > 1e-4)) return;
  let b0 = ((open + Math.PI) * BIN_SCALE) | 0;
  let b1 = ((close + Math.PI) * BIN_SCALE) | 0;
  if (b0 < 0) b0 = 0;
  else if (b0 >= POLAR_BINS) b0 = POLAR_BINS - 1;
  if (b1 < 0) b1 = 0;
  else if (b1 >= POLAR_BINS) b1 = POLAR_BINS - 1;
  if (open <= close) {
    for (let b = b0; b <= b1; b++) refStamp(b, x0, y0, x1, y1, lx, ly);
  } else {
    for (let b = b0; b < POLAR_BINS; b++) refStamp(b, x0, y0, x1, y1, lx, ly);
    for (let b = 0; b <= b1; b++) refStamp(b, x0, y0, x1, y1, lx, ly);
  }
}

function refClip(lx, ly, inX, inY, n, radius, maxVerts) {
  if (!refActive) return null;
  const cap = maxVerts | 0;
  const xs = Float32Array.from(inX.subarray(0, n));
  const ys = Float32Array.from(inY.subarray(0, n));
  const group = cap >= POLAR_BINS ? 1 : Math.ceil(POLAR_BINS / cap);
  const count = group === 1 ? POLAR_BINS : Math.ceil(POLAR_BINS / group);
  const outX = new Float32Array(count);
  const outY = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const b0 = k * group;
    const b1 = b0 + group < POLAR_BINS ? b0 + group : POLAR_BINS;
    let d = refDist[b0];
    for (let b = b0 + 1; b < b1; b++) {
      if (refDist[b] < d) d = refDist[b];
    }
    const ang = -Math.PI + (b0 + b1) * 0.5 * (TWO_PI / POLAR_BINS);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    if (n >= 3) {
      let best = radius;
      for (let i = 0; i < n; i++) {
        const j = i + 1 < n ? i + 1 : 0;
        const t = raySegT(lx, ly, c, s, xs[i], ys[i], xs[j], ys[j]);
        if (t < best) best = t;
      }
      if (best < d) d = best;
    }
    outX[k] = lx + c * d;
    outY[k] = ly + s * d;
  }
  return { m: count, x: Array.from(outX), y: Array.from(outY) };
}

function check(label, lx, ly, radius, segs, sx, sy, n) {
  for (const maxVerts of [5000, 512, 300, 128, 64, 17, 16, 3]) {
    clearPolarBins(radius);
    refDist.fill(radius);
    refActive = 0;
    for (const [x0, y0, x1, y1] of segs) {
      rasterBoundarySegment(x0, y0, x1, y1, lx, ly);
      refRaster(x0, y0, x1, y1, lx, ly);
    }
    const want = refClip(lx, ly, sx, sy, n, radius, maxVerts);
    const ox = new Float32Array(POLAR_BINS);
    const oy = new Float32Array(POLAR_BINS);
    const m = clipVisibilityToPolar(lx, ly, sx, sy, n, ox, oy, maxVerts);
    if (!want) {
      assert.equal(m, n, `${label} maxVerts ${maxVerts}: no bin written`);
      continue;
    }
    assert.equal(m, want.m, `${label} maxVerts ${maxVerts} count`);
    assert.deepEqual(Array.from(ox.subarray(0, m)), want.x, `${label} maxVerts ${maxVerts} x`);
    assert.deepEqual(Array.from(oy.subarray(0, m)), want.y, `${label} maxVerts ${maxVerts} y`);
  }
}

function boundary(rng, lx, ly, r, count) {
  const segs = [];
  for (let s = 0; s < count; s++) {
    const a = rng() * TWO_PI;
    const d = r * (0.2 + rng() * 0.9);
    const half = 0.02 + rng() * 0.5;
    segs.push([
      lx + Math.cos(a - half) * d, ly + Math.sin(a - half) * d,
      lx + Math.cos(a + half) * d, ly + Math.sin(a + half) * d,
    ]);
  }
  return segs;
}

test('polar merge of a real sweep matches the full scan bit for bit', () => {
  const rng = mulberry32(0xe43);
  const MAX_OCC = 80;
  const kind = new Uint8Array(MAX_OCC);
  const cx = new Float32Array(MAX_OCC);
  const cy = new Float32Array(MAX_OCC);
  const cr = new Float32Array(MAX_OCC);
  const vs = new Int32Array(MAX_OCC);
  const vc = new Int32Array(MAX_OCC);
  const vx = new Float32Array(MAX_OCC * 4);
  const vy = new Float32Array(MAX_OCC * 4);
  const sx = new Float32Array(5000);
  const sy = new Float32Array(5000);
  for (let trial = 0; trial < 40; trial++) {
    // Whole-number lights on a grid of whole-number boxes put edges in line
    // with the light on half the trials.
    const snap = trial % 2 === 0;
    const lx = snap ? Math.round((rng() - 0.5) * 400) : (rng() - 0.5) * 4000;
    const ly = snap ? Math.round((rng() - 0.5) * 400) : (rng() - 0.5) * 4000;
    const r = 120 + rng() * 900;
    const occ = 1 + (trial % 8) * 10;
    for (let i = 0; i < occ; i++) {
      const ox = lx + (rng() - 0.5) * r * 1.6;
      const oy = ly + (rng() - 0.5) * r * 1.6;
      if (rng() < 0.2) {
        kind[i] = OCC_CIRCLE;
        cx[i] = ox;
        cy[i] = oy;
        cr[i] = 6 + rng() * 30;
        continue;
      }
      kind[i] = OCC_POLY;
      vs[i] = i * 4;
      vc[i] = 4;
      const hw = 6 + rng() * 30;
      const hh = 6 + rng() * 30;
      const rot = snap ? 0 : rng() * Math.PI;
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
      for (let k = 0; k < 4; k++) {
        const [px, py] = corners[k];
        const x = ox + px * c - py * s;
        const y = oy + px * s + py * c;
        vx[i * 4 + k] = snap ? Math.round(x) : x;
        vy[i * 4 + k] = snap ? Math.round(y) : y;
      }
    }
    const n = buildVisibilityPolygon(lx, ly, r, kind, cx, cy, cr, vs, vc, vx, vy, occ, sx, sy, 5000);
    check(`trial ${trial} (${n} vertices)`, lx, ly, r, boundary(rng, lx, ly, r, 4 + (trial % 5) * 8), sx, sy, n);
  }
});

test('polar merge of an arbitrary polygon matches the full scan bit for bit', () => {
  const rng = mulberry32(0x43e);
  const sx = new Float32Array(600);
  const sy = new Float32Array(600);
  for (let trial = 0; trial < 60; trial++) {
    const lx = trial % 3 === 0 ? 0 : (rng() - 0.5) * 3000;
    const ly = trial % 3 === 0 ? 0 : (rng() - 0.5) * 3000;
    const r = 80 + rng() * 700;
    const n = 3 + ((rng() * 400) | 0);
    for (let i = 0; i < n; i++) {
      const pick = rng();
      let x;
      let y;
      if (pick < 0.15 && i > 0) {
        // A repeated vertex: a zero-length edge.
        x = sx[i - 1];
        y = sy[i - 1];
      } else if (pick < 0.3) {
        // On a line through the light, often an axis: the next edge is radial
        // or lies along a ray.
        const along = (rng() - 0.5) * 2 * r;
        const axis = rng() < 0.5;
        x = lx + (axis ? along : along * 0.6);
        y = ly + (axis ? 0 : along * 0.8);
      } else if (pick < 0.4) {
        // Close to the light: edges pass by it, under raySegT's 1e-4 slack.
        x = lx + (rng() - 0.5) * 2e-3;
        y = ly + (rng() - 0.5) * 2e-3;
      } else {
        const a = rng() * TWO_PI;
        const d = r * rng() * 1.3;
        x = lx + Math.cos(a) * d;
        y = ly + Math.sin(a) * d;
      }
      sx[i] = x;
      sy[i] = y;
    }
    check(`trial ${trial} (${n} vertices)`, lx, ly, r, boundary(rng, lx, ly, r, 3 + (trial % 7) * 6), sx, sy, n);
  }
});

test('polar merge with fewer than 3 sweep vertices is the bins alone', () => {
  const rng = mulberry32(7);
  const segs = boundary(rng, 5, -3, 300, 20);
  const sx = Float32Array.of(40, 60);
  const sy = Float32Array.of(10, -20);
  for (const n of [0, 1, 2]) check(`n ${n}`, 5, -3, 300, segs, sx, sy, n);
});
