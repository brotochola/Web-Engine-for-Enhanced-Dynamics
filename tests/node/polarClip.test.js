import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POLAR_BINS,
  clearPolarBins,
  clipVisibilityToPolar,
  rasterBoundarySegment,
} from '../../src/render/visibility/angularSweep.js';

const R = 200;

// One compound boundary edge: a vertical wall at x = 50, |y| <= 20, light at the origin.
// It occupies the bins around angle 0 at distance 50; everything else stays at R.
function stampWall() {
  clearPolarBins(R);
  rasterBoundarySegment(50, -20, 50, 20, 0, 0);
}

function clip(maxVerts) {
  const outX = new Float32Array(Math.max(maxVerts, POLAR_BINS));
  const outY = new Float32Array(Math.max(maxVerts, POLAR_BINS));
  const n = clipVisibilityToPolar(0, 0, outX, outY, 0, outX, outY, maxVerts);
  return { n, outX, outY };
}

function anglesOf({ n, outX, outY }) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.atan2(outY[i], outX[i]));
  return out;
}

for (const maxVerts of [128, 200, POLAR_BINS, 5000]) {
  test(`maxPolygonVertices ${maxVerts}: the clip covers the whole circle and keeps the wall`, () => {
    stampWall();
    const res = clip(maxVerts);
    assert.ok(res.n >= 3 && res.n <= Math.min(maxVerts, POLAR_BINS), `vertex count ${res.n}`);
    const angles = anglesOf(res);
    // Consecutive vertices step by at most a few bins, and wrap all the way around.
    const maxGap = (2 * Math.PI / POLAR_BINS) * Math.ceil(POLAR_BINS / Math.min(maxVerts, POLAR_BINS)) + 1e-4;
    for (let i = 1; i < angles.length; i++) {
      assert.ok(angles[i] > angles[i - 1], 'ascending angle');
      assert.ok(angles[i] - angles[i - 1] <= maxGap, `gap at ${i}`);
    }
    assert.ok(angles[0] < -Math.PI + maxGap, 'starts at -pi');
    assert.ok(angles[angles.length - 1] > Math.PI - maxGap, 'ends at +pi');
    // The vertex facing the wall sits on it, not at the light radius.
    let nearest = Infinity;
    for (let i = 0; i < res.n; i++) {
      const x = res.outX[i];
      const y = res.outY[i];
      if (Math.abs(angles[i]) < 0.2) nearest = Math.min(nearest, Math.sqrt(x * x + y * y));
    }
    assert.ok(Math.abs(nearest - 50) < 1, `wall distance ${nearest}`);
  });
}

test('the clip never returns more vertices than the budget (the caller stores y at x + maxVerts)', () => {
  for (let maxVerts = 1; maxVerts <= 600; maxVerts++) {
    stampWall();
    const { n } = clip(maxVerts);
    assert.ok(n <= maxVerts, `maxVerts ${maxVerts} returned ${n}`);
  }
});

test('at 512 or more vertices the clip is one vertex per bin, as before', () => {
  stampWall();
  const res = clip(POLAR_BINS);
  assert.equal(res.n, POLAR_BINS);
  const step = (2 * Math.PI) / POLAR_BINS;
  const a = -Math.PI + 0.5 * step;
  assert.equal(res.outX[0], Math.fround(Math.cos(a) * R));
  assert.equal(res.outY[0], Math.fround(Math.sin(a) * R));
});
