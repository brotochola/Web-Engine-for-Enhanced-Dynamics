import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POLAR_BINS,
  clearPolarBins,
  clipVisibilityToPolar,
  collectSolidSegments,
  ensureCompoundSolid,
} from '../../src/render/visibility/angularSweep.js';
import { gridCompound } from '../bench/compoundSolidMicrobench.mjs';

// E-50. collectSolidSegments runs the cheap facing test before the range test
// (a division), and stops range-testing back-facing edges once something hit.
// Pre-render reads only `hit > 0`. These are the polar polygons and hit flags of
// the code before the reorder, including a light inside the body, where every
// edge faces away: nothing is rastered, but the body still counts as hit.
const GOLDEN = {
  inside: [true, 0, 2166136261],
  left: [true, 512, 3989714986],
  below: [true, 512, 2409740340],
  far: [false, 0, 2166136261],
  edgeOnly: [false, 0, 2166136261],
  turned: [true, 512, 2471249955],
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

test('collectSolidSegments: same polar output and hit flag as before the reorder', () => {
  const body = gridCompound(12, 6, 10, 31);
  const solid = ensureCompoundSolid(
    77, 1, body.head, body.next, body.active, body.vertCount, body.vx, body.vy, 0, body.fixtures, false,
  );
  const ox = new Float32Array(POLAR_BINS);
  const oy = new Float32Array(POLAR_BINS);
  for (const [name, lx, ly, r, rot] of [
    ['inside', 160, 230, 400, 0], ['left', 40, 220, 300, 0], ['below', 150, 330, 300, 0.7],
    ['far', 900, 900, 400, 0], ['edgeOnly', 160, 400, 140, 0], ['turned', 300, 150, 500, -1.2],
  ]) {
    clearPolarBins(r);
    const hit = collectSolidSegments(solid, 5, -3, Math.cos(rot), Math.sin(rot), 2, 1, lx, ly, r * r);
    const m = clipVisibilityToPolar(lx, ly, ox, oy, 0, ox, oy, POLAR_BINS);
    assert.deepEqual([hit > 0, m, fnv(ox, oy, m)], GOLDEN[name], name);
  }
});
