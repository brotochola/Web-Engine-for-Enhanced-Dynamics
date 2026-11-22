// N-300: near a compound solid a light's polygon is the polar merge. It sampled the sweep's polygon at its 512 rays alone
// (0.7 degrees apart), so a thin wall between two rays was on no vertex: it cast no shadow and the lamp's row did not name
// it. The merge now takes the sweep's own vertices wherever the sweep is the polygon (every bin no solid stamped, and in
// front of a solid, with the far ends of those walls' shadow sides), and its rays only over the bins a solid stamped and
// the one each side of a run of them. The JS reference (the kernel's parity reference; the kernel against it in
// visibilitySweepWasm.test.js and polarMergeScatter.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { POLAR_BINS } from '../../src/render/visibility/angularSweep.js';
import { clearPolarBins, clipVisibilityToPolar, polarMergeRays, rasterBoundarySegment } from '../reference/visibilitySweepJs.mjs';

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

/** Rising angle along the polygon (a corner and its shadow side's far end share one, up to float32 rounding). */
function assertRising(pts) {
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].a >= pts[i - 1].a - 1e-6, `rising angle at ${i}`);
}

/** A compound solid's edge to the north, 150 px out (x from -30 to 30: about 79 to 101 degrees). */
function solidNorth(half = 30) {
  clearPolarBins(R);
  rasterBoundarySegment(-half, 150, half, 150, 0, 0);
}

test('a thin wall between two rays keeps its corners and its shadow; the rays only around the solid', () => {
  solidNorth();
  // A wall 0.3 degrees wide at angle 0, 100 px out: the rays nearest it were at +-0.35 degrees.
  const a0 = -0.15 * DEG;
  const a1 = 0.15 * DEG;
  const { n, pts } = merge(sweepWithWall(100, a0, a1), 5000);
  assertRising(pts);
  const near = pts.filter((p) => Math.abs(p.d - 100) < 0.01);
  assert.equal(near.length, 2, 'both corners are vertices');
  assert.ok(Math.abs(near[0].a - a0) < 1e-6 && Math.abs(near[1].a - a1) < 1e-6);
  const far = pts.filter((p) => (Math.abs(p.a - a0) < 1e-6 || Math.abs(p.a - a1) < 1e-6) && p.d > R);
  assert.equal(far.length, 2, 'the shadow sides end past the radius');
  // The solid still bounds its bins: the vertices facing it sit on it, and the rays are only there.
  const north = pts.filter((p) => Math.abs(p.a - 90 * DEG) < 2 * DEG);
  assert.ok(north.length > 3 && north.every((p) => p.d < 151), 'the compound solid\'s bins keep their hit');
  const rays = polarMergeRays();
  assert.ok(rays > 30 && rays < 60, `rays over the solid and beside it alone (${rays})`);
  assert.ok(n < 100, `the sweep's 36 vertices but the solid's two, and the rays there (${n})`);
});

test('a wall in front of a solid: its shadow sides end on the solid, their far ends pulled in to its hit', () => {
  clearPolarBins(R);
  // A compound solid's edge across the east, x = 300 from y -60 to 60 (about -11 to 11 degrees).
  rasterBoundarySegment(300, -60, 300, 60, 0, 0);
  const a0 = -0.15 * DEG;
  const a1 = 0.15 * DEG;
  const { pts } = merge(sweepWithWall(100, a0, a1), 5000);
  assertRising(pts);
  assert.equal(pts.filter((p) => Math.abs(p.d - 100) < 0.01).length, 2, 'both corners');
  const ends = pts.filter((p) => (Math.abs(p.a - a0) < 1e-6 || Math.abs(p.a - a1) < 1e-6) && p.d > 101);
  assert.equal(ends.length, 2, 'a far end at each corner\'s direction');
  for (const p of ends) assert.ok(Math.abs(p.d * Math.cos(p.a) - 300) < 0.01, `on the solid (${p.d} px out)`);
  assert.ok(pts.filter((p) => Math.abs(p.a) < 10 * DEG).every((p) => p.d * Math.cos(p.a) < 300.01), 'nothing past the solid');
});

test('a wall behind the solid adds nothing: the bins are the nearer layer there', () => {
  solidNorth(60);
  const { pts } = merge(sweepWithWall(300, 89.9 * DEG, 90.1 * DEG), 5000);
  assertRising(pts);
  const north = pts.filter((p) => Math.abs(p.a - 90 * DEG) < 14 * DEG);
  assert.ok(north.length > 0 && north.every((p) => p.d < 155), 'nothing at the wall');
});

test('where no solid stamped a bin the sweep is the polygon: its free vertices, no rays', () => {
  solidNorth();
  const sweep = sweepWithWall(R - 0.1, 10 * DEG, 10.2 * DEG); // its "wall" on the radius: free vertices only
  const { pts } = merge(sweep, 5000);
  assertRising(pts);
  // Away from the solid every vertex is one of the sweep's (on the radius, or its one past it); by the solid, its rays.
  for (const p of pts) {
    const bySolid = Math.abs(p.a - 90 * DEG) < 14 * DEG;
    assert.ok(bySolid || Math.abs(p.d - R) < 1.01, `a sweep vertex at ${(p.a / DEG).toFixed(2)} degrees (${p.d} px)`);
  }
  assert.ok(polarMergeRays() < 60, 'the rays only by the solid');
});

test('with no sweep polygon (a light among compound solids only) the merge is every ray, as before', () => {
  solidNorth();
  const outX = new Float32Array(1024);
  const outY = new Float32Array(1024);
  const none = new Float32Array(1);
  assert.equal(clipVisibilityToPolar(0, 0, none, none, 0, outX, outY, 5000), POLAR_BINS);
  assert.equal(polarMergeRays(), POLAR_BINS);
});

test('a smaller budget keeps the wall and groups the rays only where they do not fit', () => {
  solidNorth();
  const { n, pts } = merge(sweepWithWall(100, -0.15 * DEG, 0.15 * DEG), 128);
  assert.ok(n <= 128, `within the budget (${n})`);
  assert.equal(pts.filter((p) => Math.abs(p.d - 100) < 0.01).length, 2, 'the corners are kept');
  assertRising(pts);
  // A budget the rays over a wide solid do not fit at one a bin: grouped, still within it.
  clearPolarBins(R);
  rasterBoundarySegment(-400, 150, 400, 150, 0, 0);
  const wide = merge(sweepWithWall(100, -0.15 * DEG, 0.15 * DEG), 128);
  assert.ok(wide.n <= 128, `within the budget (${wide.n})`);
  assertRising(wide.pts);
});

test('the merge never writes more than the budget, nor a row\'s 1024', () => {
  solidNorth();
  const sweep = sweepWithWall(100, -0.15 * DEG, 0.15 * DEG);
  for (const maxVerts of [3, 4, 10, 100, 516, 600, 1024, 5000]) {
    const { n } = merge(sweep, maxVerts);
    assert.ok(n <= Math.min(maxVerts, 1024), `maxVerts ${maxVerts} wrote ${n}`);
  }
});
