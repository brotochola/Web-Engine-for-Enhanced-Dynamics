import test from 'node:test';
import assert from 'node:assert/strict';

import { POLAR_BINS, ensureCompoundSolid, segmentDistSq } from '../../src/render/visibility/angularSweep.js';
import { MAX_POLYGON_VERTICES } from '../../src/util/configDefaults.js';
import { gridCompound } from '../bench/compoundSolidMicrobench.mjs';
import { mulberry32 } from '../bench/benchMath.js';
import { createPolarReference } from '../helpers/polarReference.mjs';
import { clearPolarBins, clipVisibilityToPolar, collectSolidSegments } from '../reference/visibilitySweepJs.mjs';

// E-61. collectSolidSegments walks an outline's edges in chain order and the
// raster reuses the angle of the end it just computed as the next start. The
// reference rasters every lit edge in stored order with its own two atan2.
// Both must leave the same bins, bit for bit.

const NONE = 0xffff;
const V = MAX_POLYGON_VERTICES;
const ref = createPolarReference();

/** A ring of `segs` quads between radii r0 < r1, two CCW triangles each. */
function ringCompound(segs, r0, r1) {
  const n = segs * 2;
  const vx = new Float32Array(n * V);
  const vy = new Float32Array(n * V);
  const vertCount = new Uint8Array(n);
  const active = new Uint8Array(n).fill(1);
  const next = new Uint16Array(n);
  const at = (k, r) => {
    const a = ((k % segs) / segs) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  let f = 0;
  const put = (a, b, c) => {
    const o = f * V;
    [vx[o], vy[o]] = a;
    [vx[o + 1], vy[o + 1]] = b;
    [vx[o + 2], vy[o + 2]] = c;
    vertCount[f] = 3;
    next[f] = f + 1 < n ? f + 1 : NONE;
    f++;
  };
  for (let k = 0; k < segs; k++) {
    put(at(k, r0), at(k, r1), at(k + 1, r1));
    put(at(k, r0), at(k + 1, r1), at(k + 1, r0));
  }
  return { head: new Uint16Array([0]), next, active, vertCount, vx, vy, fixtures: n };
}

function build(entity, revision, body) {
  return ensureCompoundSolid(
    entity, revision, body.head, body.next, body.active, body.vertCount, body.vx, body.vy, 0, body.fixtures, false,
  );
}

/** The reference: collectSolidSegments' filter, in stored order, uncached. */
function refCollect(solid, ex, ey, c, s, offX, offY, lx, ly, radiusSq) {
  // The engine's origin expression, signed zeros included.
  const ox = ex + c * offX - s * offY;
  const oy = ey + s * offX + c * offY;
  let hit = 0;
  for (let i = 0; i < solid.segCount; i++) {
    const o = i * 4;
    const x0 = ox + c * solid.seg[o] - s * solid.seg[o + 1];
    const y0 = oy + s * solid.seg[o] + c * solid.seg[o + 1];
    const x1 = ox + c * solid.seg[o + 2] - s * solid.seg[o + 3];
    const y1 = oy + s * solid.seg[o + 2] + c * solid.seg[o + 3];
    if (segmentDistSq(lx, ly, x0, y0, x1, y1) > radiusSq) continue;
    hit++;
    if ((x1 - x0) * (ly - y0) - (y1 - y0) * (lx - x0) >= 0) continue;
    ref.raster(x0, y0, x1, y1, lx, ly);
  }
  return hit;
}

const outX = new Float32Array(POLAR_BINS);
const outY = new Float32Array(POLAR_BINS);

function checkLight(label, solid, ex, ey, rot, lx, ly, R, frame = null) {
  const c = frame ? frame.c : rot === 0 ? 1 : Math.cos(rot);
  const s = frame ? frame.s : rot === 0 ? 0 : Math.sin(rot);
  const offX = frame ? frame.offX : 0;
  const offY = frame ? frame.offY : 0;
  clearPolarBins(R);
  const hit = collectSolidSegments(solid, ex, ey, c, s, offX, offY, lx, ly, R * R);
  ref.clear(R);
  const want = refCollect(solid, ex, ey, c, s, offX, offY, lx, ly, R * R);
  assert.equal(hit > 0, want > 0, `${label}: hit`);
  const m = clipVisibilityToPolar(lx, ly, outX, outY, 0, outX, outY, POLAR_BINS);
  const w = ref.clip(lx, ly, outX, outY, 0, POLAR_BINS);
  if (!w) {
    assert.equal(m, 0, `${label}: no bin written`);
    return;
  }
  assert.equal(m, w.m, `${label}: count`);
  assert.deepEqual(Array.from(outX.subarray(0, m)), w.x, `${label}: x`);
  assert.deepEqual(Array.from(outY.subarray(0, m)), w.y, `${label}: y`);
}

test('chained raster matches the stored-order raster bit for bit', () => {
  const rng = mulberry32(0xe61);
  const bodies = [
    ['ring 18', ringCompound(18, 30, 40)],
    ['ring 64', ringCompound(64, 70, 90)],
    ['grid 16x8', gridCompound(16, 8, 10, 23)],
    ['grid 5x3', gridCompound(5, 3, 10, 9)],
  ];
  let entity = 40;
  for (const [name, body] of bodies) {
    const solid = build(entity++, 1, body);
    assert.ok(solid.segCount > 0);
    for (let k = 0; k < 40; k++) {
      // Even trials: no rotation, whole-number entity and light, so lights sit
      // level with grid vertices and on them. Odd: turned and fractional.
      const snap = k % 2 === 0;
      const ex = snap ? Math.round((rng() - 0.5) * 100) : (rng() - 0.5) * 800;
      const ey = snap ? Math.round((rng() - 0.5) * 100) : (rng() - 0.5) * 800;
      const rot = snap ? 0 : rng() * Math.PI * 2;
      const spread = name.startsWith('grid') ? 300 : 150;
      const lx = snap ? ex + 100 + Math.round((rng() - 0.5) * spread) : ex + (rng() - 0.5) * spread * 2;
      const ly = snap ? ey + 200 + Math.round((rng() - 0.5) * spread / 3) * (k % 4 === 0 ? 0 : 1) : ey + (rng() - 0.5) * spread * 2;
      const R = 40 + rng() * 600;
      checkLight(`${name} light ${k}`, solid, ex, ey, rot, lx, ly, R);
    }
  }
});

test('the chain visits every edge once and links a ring into two loops', () => {
  const body = ringCompound(24, 30, 40);
  const solid = build(60, 1, body);
  clearPolarBins(500);
  collectSolidSegments(solid, 0, 0, 1, 0, 0, 0, 0, 0, 500 * 500);
  assert.ok(solid.chainValid);
  const n = solid.segCount;
  assert.equal(n, 48);
  const seen = new Set(Array.from(solid.chain.subarray(0, n)));
  assert.equal(seen.size, n);
  let linked = 0;
  for (let q = 0; q + 1 < n; q++) {
    const a = solid.chain[q] * 4;
    const b = solid.chain[q + 1] * 4;
    if (solid.seg[a + 2] === solid.seg[b] && solid.seg[a + 3] === solid.seg[b + 1]) linked++;
  }
  assert.equal(linked, n - 2, 'two closed loops: one break between them, none inside');
});

test('a rebuilt outline gets a new chain', () => {
  const solid = build(61, 1, ringCompound(12, 30, 40));
  checkLight('before', solid, 0, 0, 0, 0, 0, 300);
  const again = build(61, 2, gridCompound(6, 4, 10, 3));
  assert.equal(again, solid);
  assert.equal(solid.chainValid, false);
  checkLight('after', solid, 0, 0, 0, 120, 210, 300);
  checkLight('after, level', solid, 0, 0, 0, 170, 200, 300);
});

/** Triangles of up to MAX_POLYGON_VERTICES-stride fixtures, in one compound. */
function trianglesCompound(tris) {
  const n = tris.length;
  const vx = new Float32Array(n * V);
  const vy = new Float32Array(n * V);
  const vertCount = new Uint8Array(n).fill(3);
  const active = new Uint8Array(n).fill(1);
  const next = new Uint16Array(n);
  tris.forEach((tri, f) => {
    for (let k = 0; k < 3; k++) {
      vx[f * V + k] = tri[k][0];
      vy[f * V + k] = tri[k][1];
    }
    next[f] = f + 1 < n ? f + 1 : NONE;
  });
  return { head: new Uint16Array([0]), next, active, vertCount, vx, vy, fixtures: n };
}

test('a reused end angle survives a signed zero', () => {
  // Two triangles meet at local (2, -0) and (2, +0), so the chain links the edge
  // ending at one to the edge starting at the other. With the entity at y = -0,
  // rotS = -0 and offset y = -0, the world ends are (2, -0) and (2, +0). The
  // light is at (5, 0): atan2(-0, -3) = -π, atan2(+0, -3) = π. The reuse is right
  // because normalizeAngleSigned folds -π to π. Unfolded, the second edge would
  // also stamp bin 0 (t ≈ 2.986, inside raySegT's slack) over the first's 3.014.
  const solid = build(62, 1, trianglesCompound([
    [[-600, -800], [2, -0], [-1000, 0]],
    [[-1000, 0], [2, 0], [-600, 800]],
  ]));
  assert.equal(solid.segCount, 4);
  checkLight('signed zero', solid, 0, -0, 0, 5, 0, 400, { c: 1, s: -0, offX: 0, offY: -0 });
});

test('a reused angle needs both coordinates of the end', () => {
  // Two squares, one above the other, lit from the left. The rastered edges in
  // chain order are A's top and left, then B's bottom and left: A's left ends at
  // (0, 0) and B's bottom starts at (0, 20), the same x on another vertex.
  const square = (y) => [
    [[0, y], [10, y], [10, y + 10]],
    [[0, y], [10, y + 10], [0, y + 10]],
  ];
  const solid = build(63, 1, trianglesCompound([...square(0), ...square(20)]));
  assert.equal(solid.segCount, 8);
  checkLight('stacked squares', solid, 0, 0, 0, -50, 15, 400);
});
