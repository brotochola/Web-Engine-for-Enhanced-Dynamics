// N-300: near a compound solid a light's polygon is the polar merge, 512 rays 0.7 degrees apart. It sampled the sweep's
// polygon at those rays alone, so a thin wall between two rays was on no vertex: it cast no shadow and the lamp's row did
// not name it. The merge now keeps the sweep's own vertices where the sweep is the nearer layer (and the free vertices
// that end a kept wall's shadow sides), by angle among the rays. The JS reference (the kernel's parity reference; the
// kernel against it in visibilitySweepWasm.test.js and polarMergeScatter.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { POLAR_BINS } from '../../src/render/visibility/angularSweep.js';
import { clearPolarBins, clipVisibilityToPolar, rasterBoundarySegment } from '../reference/visibilitySweepJs.mjs';

const R = 400;
const DEG = Math.PI / 180;

/**
 * A sweep polygon (rising angle) of free vertices on the radius every 11.25 degrees, with one thin wall at `dist`
 * between `a0` and `a1` (radians): its far point, its two corners, its far point.
 */
function sweepWithWall(dist, a0, a1) {
  const pts = [];
  for (let k = 0; k < 32; k++) {
    const a = -Math.PI + (k + 0.5) * (Math.PI / 16);
    if (a > a0 - 1e-9 && a < a1 + 1e-9) continue;
    pts.push([a, R]);
  }
  pts.push([a0, R + 1], [a0, dist], [a1, dist], [a1, R + 1]);
  // Rising angle, the far point before the corner on the near side and after it on the far side (as the sweep emits).
  pts.sort((p, q) => p[0] - q[0] || (p[0] === a0 ? q[1] - p[1] : p[1] - q[1]));
  const x = new Float32Array(pts.length);
  const y = new Float32Array(pts.length);
  pts.forEach(([a, d], i) => {
    x[i] = Math.cos(a) * d;
    y[i] = Math.sin(a) * d;
  });
  return { x, y, n: pts.length };
}

function merge(sweep, maxVerts) {
  const outX = new Float32Array(Math.max(maxVerts, 2048));
  const outY = new Float32Array(Math.max(maxVerts, 2048));
  const n = clipVisibilityToPolar(0, 0, sweep.x, sweep.y, sweep.n, outX, outY, maxVerts);
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ a: Math.atan2(outY[i], outX[i]), d: Math.sqrt(outX[i] * outX[i] + outY[i] * outY[i]) });
  return { n, pts };
}

test('a thin wall between two rays keeps its corners in the merged polygon, and the shadow behind it', () => {
  clearPolarBins(R);
  rasterBoundarySegment(-30, 150, 30, 150, 0, 0); // a compound solid's edge to the north: the merge runs
  // A wall 0.3 degrees wide at angle 0, 100 px out: the rays nearest are at +-0.35 degrees.
  const a0 = -0.15 * DEG;
  const a1 = 0.15 * DEG;
  const { n, pts } = merge(sweepWithWall(100, a0, a1), 5000);
  assert.equal(n, POLAR_BINS + 4, 'the 512 rays and the wall\'s four vertices');
  // Rising angle (a corner and its shadow side's far point share an angle, up to float32 rounding).
  for (let i = 1; i < n; i++) assert.ok(pts[i].a >= pts[i - 1].a - 1e-6, `rising angle at ${i}`);
  const near = pts.filter((p) => Math.abs(p.d - 100) < 0.01);
  assert.equal(near.length, 2, 'both corners are vertices');
  assert.ok(Math.abs(near[0].a - a0) < 1e-6 && Math.abs(near[1].a - a1) < 1e-6);
  // The shadow's sides: the far points at the corners' angles.
  const far = pts.filter((p) => (Math.abs(p.a - a0) < 1e-6 || Math.abs(p.a - a1) < 1e-6) && p.d > R);
  assert.equal(far.length, 2, 'the shadow sides end on the radius');
  // The solid still bounds its bins: the vertex facing it sits on it.
  const north = pts.filter((p) => Math.abs(p.a - 90 * DEG) < 2 * DEG);
  assert.ok(north.every((p) => p.d < 151), 'the compound solid\'s bins keep their hit');
});

test('a wall in front of a solid: its shadow sides end on the solid, their far ends pulled in to its hit', () => {
  clearPolarBins(R);
  // A compound solid's edge across the east, x = 300 from y -60 to 60 (about -11 to 11 degrees).
  rasterBoundarySegment(300, -60, 300, 60, 0, 0);
  const a0 = -0.15 * DEG;
  const a1 = 0.15 * DEG;
  const { n, pts } = merge(sweepWithWall(100, a0, a1), 5000);
  assert.equal(n, POLAR_BINS + 4, 'the rays and the wall\'s four vertices');
  for (let i = 1; i < n; i++) assert.ok(pts[i].a >= pts[i - 1].a - 1e-6, `rising angle at ${i}`);
  assert.equal(pts.filter((p) => Math.abs(p.d - 100) < 0.01).length, 2, 'both corners');
  const ends = pts.filter((p) => (Math.abs(p.a - a0) < 1e-6 || Math.abs(p.a - a1) < 1e-6) && p.d > 101);
  assert.equal(ends.length, 2, 'a far end at each corner\'s direction');
  for (const p of ends) assert.ok(Math.abs(p.d * Math.cos(p.a) - 300) < 0.01, `on the solid (${p.d} px out)`);
  assert.ok(pts.filter((p) => Math.abs(p.a) < 10 * DEG).every((p) => p.d * Math.cos(p.a) < 300.01), 'nothing past the solid');
});

test('a wall behind the solid adds nothing: the bins are the nearer layer there', () => {
  clearPolarBins(R);
  rasterBoundarySegment(-60, 150, 60, 150, 0, 0);
  const a0 = 89.9 * DEG;
  const a1 = 90.1 * DEG;
  const { n, pts } = merge(sweepWithWall(300, a0, a1), 5000);
  assert.equal(n, POLAR_BINS, 'the rays alone');
  assert.ok(pts.every((p) => p.d > 140), 'nothing at the wall');
});

test('without a near vertex kept, the merge is the rays alone (a light with only compound solids: no inserts)', () => {
  clearPolarBins(R);
  rasterBoundarySegment(-30, 150, 30, 150, 0, 0);
  const free = sweepWithWall(R - 0.1, 10 * DEG, 10.2 * DEG); // its "wall" on the radius: free vertices only
  assert.equal(merge(free, 5000).n, POLAR_BINS);
});

test('a smaller budget groups the rays from the room the inserts leave', () => {
  clearPolarBins(R);
  rasterBoundarySegment(-30, 150, 30, 150, 0, 0);
  const { n, pts } = merge(sweepWithWall(100, -0.15 * DEG, 0.15 * DEG), 128);
  assert.ok(n <= 128, `within the budget (${n})`);
  assert.equal(pts.filter((p) => Math.abs(p.d - 100) < 0.01).length, 2, 'the corners are kept');
  for (let i = 1; i < n; i++) assert.ok(pts[i].a >= pts[i - 1].a - 1e-6, `rising angle at ${i}`);
});

test('the merge never writes more than the budget, nor a row\'s 1024', () => {
  clearPolarBins(R);
  rasterBoundarySegment(-30, 150, 30, 150, 0, 0);
  const sweep = sweepWithWall(100, -0.15 * DEG, 0.15 * DEG);
  for (const maxVerts of [3, 4, 10, 100, 516, 600, 1024, 5000]) {
    const { n } = merge(sweep, maxVerts);
    assert.ok(n <= Math.min(maxVerts, 1024), `maxVerts ${maxVerts} wrote ${n}`);
  }
});
