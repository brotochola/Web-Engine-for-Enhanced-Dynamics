import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OCC_CIRCLE,
  OCC_POLY,
  writeOrientedBoxVerts,
  writePolygonVerts,
} from '../../src/render/visibility/angularSweep.js';
import { buildVisibilityPolygonReference } from '../helpers/sweepReference.mjs';
import { buildVisibilityPolygon } from '../reference/visibilitySweepJs.mjs';

// E-63. The sweep took Math.cos/sin of every event's angle, an angle that came
// from atan2 of the very vertex (or circle tangent) the ray points at. The
// direction is now kept from that geometry. Not bit for bit: each direction
// differs by a few float64 ulps, so a polygon vertex can move by rounding-sized
// amounts, and the Float32 store usually hides even that. The gate is H-06's,
// stated before the edit: same vertex count, every vertex within 1e-4 world
// units of the pre-E-63 sweep, on scenes mixing circles, boxes and polygons.

const TOLERANCE = 1e-4;
const SCENES = 3000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scene(rng) {
  const n = 1 + Math.floor(rng() * 40);
  const kind = new Uint8Array(n);
  const cx = new Float32Array(n);
  const cy = new Float32Array(n);
  const cr = new Float32Array(n);
  const vertStart = new Int32Array(n);
  const vertCount = new Uint8Array(n);
  const vx = new Float32Array(n * 8);
  const vy = new Float32Array(n * 8);
  const lx = (rng() - 0.5) * 200;
  const ly = (rng() - 0.5) * 200;
  const radius = 100 + rng() * 500;
  let pool = 0;
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const d = rng() * radius * 1.3;
    const x = lx + Math.cos(a) * d;
    const y = ly + Math.sin(a) * d;
    const pick = rng();
    if (pick < 0.4) {
      kind[i] = OCC_CIRCLE;
      cx[i] = x;
      cy[i] = y;
      cr[i] = 2 + rng() * 40;
    } else if (pick < 0.75) {
      const t = rng() * Math.PI * 2;
      kind[i] = OCC_POLY;
      vertStart[i] = pool;
      writeOrientedBoxVerts(vx, vy, pool, x, y, 4 + rng() * 80, 4 + rng() * 80, Math.cos(t), Math.sin(t), 0, 0);
      vertCount[i] = 4;
      pool += 4;
    } else {
      // A regular convex polygon, 3 to 8 sides, as world-space local verts.
      const sides = 3 + Math.floor(rng() * 6);
      const r = 3 + rng() * 40;
      const lxs = new Float32Array(8);
      const lys = new Float32Array(8);
      for (let k = 0; k < sides; k++) {
        lxs[k] = Math.cos((k / sides) * Math.PI * 2) * r;
        lys[k] = Math.sin((k / sides) * Math.PI * 2) * r;
      }
      const t = rng() * Math.PI * 2;
      kind[i] = OCC_POLY;
      vertStart[i] = pool;
      writePolygonVerts(vx, vy, pool, x, y, Math.cos(t), Math.sin(t), 0, 0, lxs, lys, 0, sides);
      vertCount[i] = sides;
      pool += sides;
    }
  }
  const maxVerts = rng() < 0.5 ? 256 : 512;
  return { args: [lx, ly, radius, kind, cx, cy, cr, vertStart, vertCount, vx, vy, n], maxVerts };
}

test('E-63: the sweep matches the pre-E-63 sweep within 1e-4 on mixed scenes', () => {
  const rng = mulberry32(0xe63);
  let maxMove = 0;
  let verts = 0;
  for (let s = 0; s < SCENES; s++) {
    const { args, maxVerts } = scene(rng);
    const ax = new Float32Array(maxVerts);
    const ay = new Float32Array(maxVerts);
    const bx = new Float32Array(maxVerts);
    const by = new Float32Array(maxVerts);
    const na = buildVisibilityPolygon(...args, ax, ay, maxVerts);
    const nb = buildVisibilityPolygonReference(...args, bx, by, maxVerts);
    assert.equal(na, nb, `scene ${s}: vertex count`);
    for (let i = 0; i < na; i++) {
      const dx = ax[i] - bx[i];
      const dy = ay[i] - by[i];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > maxMove) maxMove = d;
    }
    verts += na;
  }
  assert.ok(verts > SCENES * 10, `the scenes produce real polygons (${verts} vertices)`);
  assert.ok(maxMove <= TOLERANCE, `max vertex move ${maxMove} exceeds ${TOLERANCE}`);
});
