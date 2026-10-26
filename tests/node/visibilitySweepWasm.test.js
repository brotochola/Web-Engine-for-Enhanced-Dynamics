// E-76 W2a: the per-light visibility sweep kernel (wasm/test/visibilitySweep.c, a test module) against the
// shipped buildVisibilityPolygon, clipVisibilityToPolar and markSeenPolarOwners (angularSweep.js), on the
// memory tests/helpers/visibilitySweepKernel.mjs lays out.
//
// The gate (comparePolygons there): with equal counts, every vertex within H-06's 1e-4 world units plus one
// float32 ulp of the coordinate (double variants), or 1e-4 of its ray length plus that ulp (f32). A polygon
// that does not pass vertex for vertex is a flip: an event tie or a sample on a threshold went the other way
// (integer scenes put a circle's tangent exactly on the start ray at -pi, where JS's atan2 and pseudoAngle
// round to opposite ends of the sweep). A flip must keep the area within 1e-4 and the vertex count within 4,
// and flips must stay under 0.5 % of the scenes. sweepSawOccluder must agree on every polygon that passes
// (double variants) or on all but 0.1 % (f32: two overlapping occluders hit at the same point can swap).
//
// Scenes: mixed circles, boxes and polygons around lights inside and outside them; integer scenes (ties,
// edges in line with the light); occluders straddling the +-pi fold; degenerate polygons (repeated vertices,
// collinear, under 3 vertices, zero-size boxes); small vertex caps; visPolyStressScene's frame; the empty
// light; event, active and occluder-cache overflows; the polar bins of compound solids (the shipped raster's,
// with the merge and the seen owners compared bit for bit); the seen stamp's wrap. Mutants of the binary
// (EPSILON, the dedupe distance) must fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  OCC_CIRCLE,
  OCC_POLY,
  POLAR_BINS,
  polarBinsActive,
  writeOrientedBoxVerts,
  writePolygonVerts,
} from '../../src/render/visibility/angularSweep.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { mulberry32 } from '../bench/benchMath.js';
import { raySegT } from '../helpers/polarReference.mjs';
import {
  FLIP_AREA_TOLERANCE,
  KERNEL_URL,
  R,
  RELATIVE_GATE,
  SWEEP_SLOTS,
  SWEEP_VARIANTS,
  comparePolygons,
  createSweepKernel,
  emptyScene,
  sweepJs,
  visPolyFrame,
} from '../helpers/visibilitySweepKernel.mjs';
import {
  buildVisibilityPolygon,
  clearPolarBins,
  clipVisibilityToPolar,
  markSeenPolarOwners,
  rasterBoundarySegment,
  sweepSawOccluder,
} from '../reference/visibilitySweepJs.mjs';

const VARIANTS = Object.keys(SWEEP_VARIANTS);
const DOUBLE_VARIANTS = VARIANTS.filter((v) => !RELATIVE_GATE.has(v));
const MAX_FLIP_RATE = 0.005;
const MAX_F32_SEEN_RATE = 0.001;
const SLOT = Object.fromEntries(SWEEP_SLOTS.map((s, i) => [s, i]));

/** console.warn silenced (the shipped sweep warns once per overflow kind). */
function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

// ---- scenes -------------------------------------------------------------------------------------------

function addCircle(sc, x, y, r) {
  const i = sc.occCount++;
  sc.kind[i] = OCC_CIRCLE;
  sc.cx[i] = x;
  sc.cy[i] = y;
  sc.cr[i] = r;
  sc.vertStart[i] = 0;
  sc.vertCount[i] = 0;
}

function addBox(sc, x, y, w, h, t) {
  const i = sc.occCount++;
  sc.kind[i] = OCC_POLY;
  sc.vertStart[i] = sc.poolVerts;
  writeOrientedBoxVerts(sc.vertsX, sc.vertsY, sc.poolVerts, x, y, w, h, Math.cos(t), Math.sin(t), 0, 0);
  sc.vertCount[i] = 4;
  sc.poolVerts += 4;
}

const LOCAL_X = new Float32Array(8);
const LOCAL_Y = new Float32Array(8);
function addPolygon(sc, x, y, sides, r, t) {
  for (let k = 0; k < sides; k++) {
    LOCAL_X[k] = Math.cos((k / sides) * Math.PI * 2) * r;
    LOCAL_Y[k] = Math.sin((k / sides) * Math.PI * 2) * r;
  }
  const i = sc.occCount++;
  sc.kind[i] = OCC_POLY;
  sc.vertStart[i] = sc.poolVerts;
  writePolygonVerts(sc.vertsX, sc.vertsY, sc.poolVerts, x, y, Math.cos(t), Math.sin(t), 0, 0, LOCAL_X, LOCAL_Y, 0, sides);
  sc.vertCount[i] = sides;
  sc.poolVerts += sides;
}

/** Raw vertices (any count, any order): the degenerate shapes. */
function addRaw(sc, pts) {
  const i = sc.occCount++;
  sc.kind[i] = OCC_POLY;
  sc.vertStart[i] = sc.poolVerts;
  for (const [x, y] of pts) {
    sc.vertsX[sc.poolVerts] = x;
    sc.vertsY[sc.poolVerts] = y;
    sc.poolVerts++;
  }
  sc.vertCount[i] = pts.length;
}

const KINDS = ['free', 'snap', 'fold', 'inside', 'degenerate'];

/** One random scene of a kind, at most 48 occluders, in the style of sweepEventDirection.test.js. */
function randomScene(rng, kind) {
  const n = 1 + Math.floor(rng() * 40);
  const sc = emptyScene(48, 48 * 8);
  const snap = kind === 'snap';
  const q = (v) => (snap ? Math.round(v) : v);
  sc.lx = q((rng() - 0.5) * 200);
  sc.ly = q((rng() - 0.5) * 200);
  sc.radius = q(100 + rng() * 500);
  if (kind === 'inside') {
    // The light inside one occluder of each kind.
    addCircle(sc, sc.lx + 3, sc.ly - 2, 10 + rng() * 20);
    addBox(sc, sc.lx - 1, sc.ly + 1, 12 + rng() * 30, 12 + rng() * 30, rng() * 6);
    addPolygon(sc, sc.lx, sc.ly + 0.5, 3 + Math.floor(rng() * 6), 8 + rng() * 20, rng() * 6);
  }
  if (kind === 'degenerate') {
    const x = sc.lx + 60 + rng() * 50;
    const y = sc.ly + (rng() - 0.5) * 100;
    addRaw(sc, [[x, y], [x, y], [x + 20, y], [x + 20, y + 20], [x, y + 20]]); // a repeated vertex
    addRaw(sc, [[x - 150, y], [x - 130, y + 10], [x - 110, y + 20]]); // collinear
    addRaw(sc, [[x, y - 80], [x + 10, y - 70]]); // two vertices
    addRaw(sc, [[x - 50, y - 120]]); // one
    addBox(sc, x - 40, y + 70, 0, 25, 0); // zero width
    addBox(sc, x + 40, y - 30, 0, 0, 0); // a point
    // A vertex exactly on the light: convex, it counts as inside; as a bowtie it is the tangent vertex on
    // both sides (length 0: the events keep cos/sin of atan2(0, 0)).
    addRaw(sc, [[sc.lx, sc.ly], [sc.lx + 30, sc.ly], [sc.lx + 30, sc.ly + 30]]);
    addRaw(sc, [[sc.lx, sc.ly], [sc.lx + 30, sc.ly + 20], [sc.lx + 30, sc.ly - 20], [sc.lx + 60, sc.ly]]);
    // An edge in line with the light.
    addRaw(sc, [[sc.lx - 30, sc.ly - 40], [sc.lx + 30, sc.ly - 40], [sc.lx + 30, sc.ly - 70], [sc.lx - 30, sc.ly - 70]]);
  }
  while (sc.occCount < n + (kind === 'inside' ? 3 : 0) && sc.occCount < 48) {
    let a = rng() * Math.PI * 2;
    if (kind === 'fold' && rng() < 0.6) a = Math.PI + (rng() - 0.5) * 0.6; // west of the light: across +-pi
    const d = rng() * sc.radius * 1.3;
    const x = q(sc.lx + Math.cos(a) * d);
    const y = q(sc.ly + Math.sin(a) * d);
    const pick = rng();
    if (pick < 0.4) addCircle(sc, x, y, q(2 + rng() * 40));
    else if (pick < 0.75) addBox(sc, x, y, q(4 + rng() * 80), q(4 + rng() * 80), snap ? 0 : rng() * Math.PI * 2);
    else addPolygon(sc, x, y, 3 + Math.floor(rng() * 6), 3 + rng() * 40, rng() * Math.PI * 2);
  }
  sc.maxVerts = rng() < 0.15 ? [3, 8, 17, 40][Math.floor(rng() * 4)] : rng() < 0.5 ? 256 : 512;
  return sc;
}

// ---- running both sides -------------------------------------------------------------------------------

const OUT_CAP = 5000;
const jsX = new Float32Array(OUT_CAP);
const jsY = new Float32Array(OUT_CAP);

/** The shipped sweep and what sweepSawOccluder says after it, for occluders 0 .. occCount + 1. */
function runJs(sc) {
  const n = quiet(() => sweepJs(sc, jsX, jsY, sc.maxVerts));
  const saw = [];
  for (let oi = 0; oi < sc.occCount + 2; oi++) saw.push(sweepSawOccluder(oi));
  return { n, x: jsX.slice(0, n), y: jsY.slice(0, n), saw };
}

function setMaxVerts(k, set, maxVerts) {
  k.sets[set].table[SLOT.maxVerts] = maxVerts;
}

/** A tally of one variant over many scenes. */
function newTally() {
  return { scenes: 0, vertices: 0, exact: 0, flips: 0, seenOff: 0, err: 0, maxAbs: 0, maxRayRel: 0, worstArea: 0, worstCount: 0, firstFlip: null };
}

function tallyOne(t, variant, sc, ref, k, n, label) {
  const c = comparePolygons(ref.x, ref.y, ref.n, k.outX, k.outY, n, { lx: sc.lx, ly: sc.ly, relative: RELATIVE_GATE.has(variant) });
  t.scenes++;
  t.vertices += ref.n;
  let exact = n === ref.n;
  for (let i = 0; exact && i < n; i++) exact = k.outX[i] === ref.x[i] && k.outY[i] === ref.y[i];
  if (exact) t.exact++;
  if (c.ok) {
    if (c.err > t.err) t.err = c.err;
    if (c.maxAbs > t.maxAbs) t.maxAbs = c.maxAbs;
    if (c.maxRayRel > t.maxRayRel) t.maxRayRel = c.maxRayRel;
    for (let oi = 0; oi < ref.saw.length; oi++) {
      if (k.sawOccluder(oi) !== ref.saw[oi]) {
        t.seenOff++;
        if (!RELATIVE_GATE.has(variant)) assert.fail(`${label} ${variant}: sweepSawOccluder(${oi}) is ${k.sawOccluder(oi)}, the JS says ${ref.saw[oi]}`);
        break;
      }
    }
    return;
  }
  t.flips++;
  if (!t.firstFlip) t.firstFlip = `${label}: ${ref.n} -> ${n} vertices, first move at ${c.first}, area ${c.areaRel.toExponential(2)}`;
  if (c.areaRel > t.worstArea) t.worstArea = c.areaRel;
  if (Math.abs(c.countDelta) > t.worstCount) t.worstCount = Math.abs(c.countDelta);
  assert.ok(c.areaRel <= FLIP_AREA_TOLERANCE, `${label} ${variant}: a flip changed the area by ${c.areaRel} (${ref.n} -> ${n} vertices)`);
  assert.ok(Math.abs(c.countDelta) <= 4, `${label} ${variant}: a flip changed the vertex count by ${c.countDelta}`);
}

function assertTallies(tallies, what) {
  for (const [v, t] of Object.entries(tallies)) {
    assert.ok(t.flips <= MAX_FLIP_RATE * t.scenes, `${what} ${v}: ${t.flips} flips in ${t.scenes} scenes (${t.firstFlip})`);
    if (RELATIVE_GATE.has(v)) assert.ok(t.seenOff <= MAX_F32_SEEN_RATE * t.scenes, `${what} ${v}: sweepSawOccluder differs in ${t.seenOff} scenes`);
  }
}

/** Every variant (or `fns`) on the scenes, against the JS. */
async function runScenes(scenes, { k = null, fns = null } = {}) {
  const kernel = k ?? (await createSweepKernel({ sets: [{ occluders: 48, poolVerts: 48 * 8 }], maxVerts: 512 }));
  const run = fns ?? kernel.variants;
  const tallies = Object.fromEntries(Object.keys(run).map((v) => [v, newTally()]));
  scenes.forEach((sc, s) => {
    const ref = runJs(sc);
    kernel.load(0, sc);
    setMaxVerts(kernel, 0, sc.maxVerts);
    for (const [v, fn] of Object.entries(run)) {
      const n = fn(kernel.sets[0].tableByte, sc.lx, sc.ly, sc.radius, sc.occCount, 0);
      assert.equal(kernel.results[R.count], n >>> 0, 'the result word holds the count');
      tallyOne(tallies[v], v, sc, ref, kernel, n, `${sc.kindName} scene ${s}`);
    }
  });
  return tallies;
}

function report(tallies) {
  return Object.entries(tallies)
    .map(([v, t]) => `${v}: ${t.exact}/${t.scenes} bit for bit, ${t.flips} flips, worst move ${t.maxAbs.toExponential(2)} (${(t.err * 100).toFixed(1)} % of its allowance)`)
    .join('; ');
}

const SCENES_PER_KIND = 1200;
function randomScenes(seed) {
  const rng = mulberry32(seed);
  const out = [];
  for (const kind of KINDS) {
    for (let s = 0; s < SCENES_PER_KIND; s++) {
      const sc = randomScene(rng, kind);
      sc.kindName = kind;
      out.push(sc);
    }
  }
  return out;
}

// ---- tests --------------------------------------------------------------------------------------------

test('W2a sweep: the empty light is the shipped 32-gon, bit for bit, at every vertex cap', async () => {
  const k = await createSweepKernel({ sets: [{ occluders: 4, poolVerts: 16 }], maxVerts: 64 });
  for (const maxVerts of [64, 32, 17, 3, 1]) {
    const sc = emptyScene(4, 16);
    sc.lx = 37.5;
    sc.ly = -12.25;
    sc.radius = 220;
    sc.maxVerts = maxVerts;
    const ref = runJs(sc);
    k.load(0, sc);
    setMaxVerts(k, 0, maxVerts);
    for (const [v, fn] of Object.entries(k.variants)) {
      const n = fn(k.sets[0].tableByte, sc.lx, sc.ly, sc.radius, 0, 0);
      assert.equal(n, ref.n, `${v} maxVerts ${maxVerts}`);
      assert.deepEqual(Array.from(k.outX.subarray(0, n)), Array.from(ref.x), `${v} x`);
      assert.deepEqual(Array.from(k.outY.subarray(0, n)), Array.from(ref.y), `${v} y`);
      assert.equal(k.results[R.seenValid], 1);
      for (let oi = 0; oi < ref.saw.length; oi++) assert.equal(k.sawOccluder(oi), ref.saw[oi]);
    }
  }
});

test('W2a sweep: visPolyStressScene\'s frame (boxes and circles) passes the gate with no flip', async () => {
  for (const shape of ['box', 'circle']) {
    const frame = visPolyFrame({ shape });
    const k = await createSweepKernel({ sets: [{ occluders: 64, poolVerts: 256 }], maxVerts: 5000 });
    const tallies = Object.fromEntries(VARIANTS.map((v) => [v, newTally()]));
    frame.forEach((sc, i) => {
      sc.maxVerts = 5000;
      const ref = runJs(sc);
      k.load(0, sc);
      for (const [v, fn] of Object.entries(k.variants)) {
        const n = fn(k.sets[0].tableByte, sc.lx, sc.ly, sc.radius, sc.occCount, 0);
        tallyOne(tallies[v], v, sc, ref, k, n, `${shape} light ${i}`);
      }
    });
    for (const [v, t] of Object.entries(tallies)) {
      assert.equal(t.flips, 0, `${shape} ${v}: ${t.firstFlip}`);
      assert.equal(t.seenOff, 0, `${shape} ${v}: sweepSawOccluder differs`);
      assert.ok(t.vertices > frame.length * 20, `${shape}: real polygons (${t.vertices} vertices)`);
    }
  }
});

test('W2a sweep: mixed, integer, folded, enclosing and degenerate scenes pass the gate', async () => {
  const scenes = randomScenes(0x2a2a);
  const tallies = await runScenes(scenes);
  assertTallies(tallies, 'random scenes');
  for (const v of DOUBLE_VARIANTS) {
    // In Node, Math.atan2 and Math.asin are fdlibm's (Q2): the double variants differ from the JS only at ties.
    assert.ok(tallies[v].exact >= tallies[v].scenes - tallies[v].flips - 2, `${v}: ${report({ [v]: tallies[v] })}`);
  }
  assert.ok(tallies.f64.vertices > scenes.length * 10, 'the scenes make real polygons');
  console.log(`# random scenes (${scenes.length}): ${report(tallies)}`);
});

test('W2a sweep: overflows fall back to the full circle as the JS does, and the occluder cache cap holds', async () => {
  const k = await createSweepKernel({ sets: [{ occluders: 1200, poolVerts: 1200 * 4 }], maxVerts: 512 });
  const cases = [];

  // Event cap: 1100 circles in reach make 2200 events, over MAX_EVENTS (2048).
  {
    const sc = emptyScene(1200, 16);
    sc.radius = 400;
    for (let i = 0; i < 1100; i++) {
      const a = (i / 1100) * Math.PI * 2;
      addCircle(sc, Math.cos(a) * (60 + (i % 7) * 30), Math.sin(a) * (60 + (i % 7) * 30), 2);
    }
    cases.push(['events', sc, 'eventOverflow']);
  }
  // Active cap: 300 circles along one ray are all open at once (over MAX_ACTIVE, 256).
  {
    const sc = emptyScene(1200, 16);
    sc.radius = 600;
    for (let i = 0; i < 300; i++) addCircle(sc, 30 + i * 1.8, 0.4 * Math.sin(i), 3);
    cases.push(['active', sc, 'activeOverflow']);
  }
  // Active cap while seeding: 260 occluders straddling -pi.
  {
    const sc = emptyScene(1200, 16);
    sc.radius = 600;
    for (let i = 0; i < 260; i++) addCircle(sc, -40 - i * 2, 0, 1.5);
    cases.push(['seeding', sc, 'activeOverflow']);
  }
  // Past the occluder cache (1024): occluders 1024 and up get events but are never seeded at -pi, and
  // sweepSawOccluder says true for them. 1030 boxes, most out of reach so the events stay under the cap.
  {
    const sc = emptyScene(1200, 1200 * 4);
    sc.radius = 300;
    for (let i = 0; i < 1030; i++) {
      if (i < 1018) addBox(sc, 5000 + i * 10, 5000, 4, 4, 0);
      else addBox(sc, -80 - (1029 - i) * 15, (i % 2 ? 6 : -6), 8, 30, 0); // across -pi, the uncached nearest
    }
    cases.push(['cache', sc, null]);
  }
  for (const [name, sc, flag] of cases) {
    sc.maxVerts = 512;
    const ref = runJs(sc);
    k.load(0, sc);
    setMaxVerts(k, 0, 512);
    for (const [v, fn] of Object.entries(k.variants)) {
      const n = fn(k.sets[0].tableByte, sc.lx, sc.ly, sc.radius, sc.occCount, 0);
      if (flag) {
        assert.equal(k.results[R[flag]], 1, `${name} ${v}: ${flag}`);
        assert.equal(k.results[R.seenValid], 0, `${name} ${v}: the seen stamps are invalid after an overflow`);
        assert.equal(n, 32, `${name}: the full circle`);
      } else {
        assert.equal(k.results[R.eventOverflow] + k.results[R.activeOverflow], 0, `${name} ${v}: no overflow`);
      }
      const c = comparePolygons(ref.x, ref.y, ref.n, k.outX, k.outY, n, { lx: sc.lx, ly: sc.ly, relative: RELATIVE_GATE.has(v) });
      assert.ok(c.ok, `${name} ${v}: ${ref.n} -> ${n} vertices, first move at ${c.first}`);
      for (let oi = 0; oi < sc.occCount + 2; oi++) {
        assert.equal(k.sawOccluder(oi), ref.saw[oi], `${name} ${v}: sweepSawOccluder(${oi})`);
      }
    }
  }
  // The cache case depends on the cap: with room for every occluder, the uncached boxes are seeded at -pi.
  const big = await createSweepKernel({ sets: [{ occluders: 1200, poolVerts: 1200 * 4 }], maxVerts: 512, occCache: 2048 });
  const [, sc] = cases[3];
  big.load(0, sc);
  const ref = runJs(sc);
  const n = big.variants.f64(big.sets[0].tableByte, sc.lx, sc.ly, sc.radius, sc.occCount, 0);
  assert.ok(!comparePolygons(ref.x, ref.y, ref.n, big.outX, big.outY, n, { lx: sc.lx, ly: sc.ly }).ok, 'the cache cap changes the cache case');
});

test('W2a sweep: the seen stamp wraps to 1 and clears, as the JS stamp does', async () => {
  const k = await createSweepKernel({ sets: [{ occluders: 48, poolVerts: 48 * 8 }], maxVerts: 512 });
  const rng = mulberry32(0x5eed);
  for (let s = 0; s < 40; s++) {
    const sc = randomScene(rng, 'free');
    const ref = runJs(sc);
    k.load(0, sc);
    setMaxVerts(k, 0, sc.maxVerts);
    k.seen.fill(1); // stale stamps equal to the post-wrap stamp: the wrap must clear them
    k.results[R.stamp] = 0xffffffff;
    k.variants.pre(k.sets[0].tableByte, sc.lx, sc.ly, sc.radius, sc.occCount, 0);
    assert.equal(k.results[R.stamp], 1);
    for (let oi = 0; oi < ref.saw.length; oi++) assert.equal(k.sawOccluder(oi), ref.saw[oi], `scene ${s} occluder ${oi}`);
  }
});

// ---- the polar bins -----------------------------------------------------------------------------------

/**
 * The bins the shipped raster makes, for the kernel's input: every bin's centre ray against every segment, in
 * raster order, with raySegT from tests/helpers/polarReference.mjs (the frozen raster polarMergeScatter.test.js
 * holds the shipped one to, bit for bit). Testing every bin instead of each segment's angular range gives the
 * same bins: a ray outside the range misses the segment (its 1e-4 slack is far under half a bin for these
 * segments). The owner is the segment's whose hit was the last strictly nearer one.
 */
function polarBins(segsOf, lx, ly, radius, polarCos, polarSin) {
  const dist = new Float32Array(POLAR_BINS).fill(radius > 0 ? radius : 0);
  const owner = new Int32Array(POLAR_BINS).fill(-1);
  let active = 0;
  segsOf.forEach((segs, o) => {
    for (const [x0, y0, x1, y1] of segs) {
      for (let b = 0; b < POLAR_BINS; b++) {
        const t = raySegT(lx, ly, polarCos[2 * b + 1], polarSin[2 * b + 1], x0, y0, x1, y1);
        if (t < dist[b]) {
          dist[b] = t;
          owner[b] = o;
          active = 1;
        }
      }
    }
  });
  return { dist, owner, active };
}

/**
 * Check `dist` against the shipped bins through clipVisibilityToPolar with no sweep polygon and one vertex per
 * bin: vertex b is light + (cos, sin)[2b + 1] · dist[b], rounded to float32. (The read-back alone cannot give
 * the bins: neighbouring floats often round to the same vertex.)
 */
const READ_X = new Float32Array(POLAR_BINS);
const READ_Y = new Float32Array(POLAR_BINS);
const NONE = new Float32Array(1);
function assertShippedBins(dist, lx, ly, polarCos, polarSin, label) {
  assert.equal(clipVisibilityToPolar(lx, ly, NONE, NONE, 0, READ_X, READ_Y, POLAR_BINS), POLAR_BINS);
  for (let b = 0; b < POLAR_BINS; b++) {
    const m = 2 * b + 1;
    assert.equal(READ_X[b], Math.fround(lx + polarCos[m] * dist[b]), `${label} bin ${b} x`);
    assert.equal(READ_Y[b], Math.fround(ly + polarSin[m] * dist[b]), `${label} bin ${b} y`);
  }
}

function boundary(rng, lx, ly, r, count) {
  const segs = [];
  for (let s = 0; s < count; s++) {
    const a = rng() * Math.PI * 2;
    const d = r * (0.2 + rng() * 0.9);
    const half = 0.02 + rng() * 0.5;
    segs.push([lx + Math.cos(a - half) * d, ly + Math.sin(a - half) * d, lx + Math.cos(a + half) * d, ly + Math.sin(a + half) * d]);
  }
  return segs;
}

test('W2a sweep: with compound solids, the clip and merge and the seen owners match the shipped ones', async () => {
  const OWNER_CAP = 64;
  const k = await createSweepKernel({ sets: [{ occluders: 48, poolVerts: 48 * 8 }], maxVerts: 5000, ownerSeenCap: OWNER_CAP });
  const polarCos = new Float64Array(k.buffer, k.regions.polarCos.byte, POLAR_BINS * 2 + 1);
  const polarSin = new Float64Array(k.buffer, k.regions.polarSin.byte, POLAR_BINS * 2 + 1);
  const rng = mulberry32(0x9a1a);
  const jsOut = { x: new Float32Array(5000), y: new Float32Array(5000) };
  const seenJs = new Uint32Array(OWNER_CAP);
  const tallies = Object.fromEntries(VARIANTS.map((v) => [v, newTally()]));
  let stamp = 0;
  let merged = 0;
  let ownersCompared = 0;
  for (let s = 0; s < 160; s++) {
    const sc = randomScene(rng, s % 3 === 0 ? 'fold' : 'free');
    const owners = 1 + Math.floor(rng() * 6);
    const segsOf = [];
    for (let o = 0; o < owners; o++) segsOf.push(boundary(rng, sc.lx, sc.ly, sc.radius, 1 + Math.floor(rng() * 12)));
    const raster = () => {
      clearPolarBins(sc.radius);
      for (let o = 0; o < owners; o++) for (const [x0, y0, x1, y1] of segsOf[o]) rasterBoundarySegment(x0, y0, x1, y1, sc.lx, sc.ly, o);
    };
    const bins = polarBins(segsOf, sc.lx, sc.ly, sc.radius, polarCos, polarSin);
    raster();
    const active = polarBinsActive();
    assert.equal(active, bins.active, `scene ${s}: the bins are active`);
    if (active) assertShippedBins(bins.dist, sc.lx, sc.ly, polarCos, polarSin, `scene ${s}`);

    for (const maxVerts of [5000, 512, 300, 128, 17, 3, 2]) {
      sc.maxVerts = maxVerts;
      raster(); // as pre-render does per light, so no merge of an earlier call is left
      const nSweep = quiet(() => buildVisibilityPolygon(
        sc.lx, sc.ly, sc.radius, sc.kind, sc.cx, sc.cy, sc.cr, sc.vertStart, sc.vertCount, sc.vertsX, sc.vertsY,
        sc.occCount, jsOut.x, jsOut.y, maxVerts));
      let n = nSweep;
      if (active) n = clipVisibilityToPolar(sc.lx, sc.ly, jsOut.x, jsOut.y, nSweep, jsOut.x, jsOut.y, maxVerts);
      stamp++;
      seenJs.fill(0);
      const marked = active ? markSeenPolarOwners(seenJs, stamp) : -1;
      const ref = { n, x: jsOut.x.slice(0, n), y: jsOut.y.slice(0, n), saw: [] };

      k.load(0, sc);
      setMaxVerts(k, 0, maxVerts);
      k.setOwnerStamp(stamp);
      k.polarDist.set(bins.dist);
      k.polarOwner.set(bins.owner);
      for (const [v, fn] of Object.entries(k.variants)) {
        k.ownerSeen.fill(0);
        const m = fn(k.sets[0].tableByte, sc.lx, sc.ly, sc.radius, sc.occCount, active);
        const flipsBefore = tallies[v].flips;
        tallyOne(tallies[v], v, sc, ref, k, m, `polar scene ${s} maxVerts ${maxVerts}`);
        if (!active) continue;
        if (maxVerts >= 3) {
          merged++;
          assert.equal(k.resultsI32[R.mergeCount], m, `${v}: the merge's count`);
        } else {
          assert.equal(k.resultsI32[R.mergeCount], -1, `${v}: no merge under 3 vertices`);
        }
        // Bit for bit where the sweep did not flip (the merge is exact arithmetic); f32's sweep polygon and
        // rays are not the JS ones bit for bit.
        if (v === 'f32' || tallies[v].flips !== flipsBefore) continue;
        assert.deepEqual(Array.from(k.outX.subarray(0, m)), Array.from(ref.x), `polar scene ${s} maxVerts ${maxVerts} ${v}: x`);
        assert.deepEqual(Array.from(k.outY.subarray(0, m)), Array.from(ref.y), `polar scene ${s} maxVerts ${maxVerts} ${v}: y`);
        assert.equal(k.resultsI32[R.ownersMarked], marked, `polar scene ${s} maxVerts ${maxVerts} ${v}: bins marked`);
        assert.deepEqual(Array.from(k.ownerSeen), Array.from(seenJs), `polar scene ${s} ${v}: seen owners`);
        ownersCompared++;
      }
    }
  }
  assertTallies(tallies, 'polar scenes');
  assert.ok(merged > 300, `the merge ran (${merged})`);
  assert.ok(ownersCompared > 2000, `${ownersCompared} merges and seen owners compared bit for bit`);
});

// ---- mutants ------------------------------------------------------------------------------------------

/** The module with every f64.const `from` replaced by `to`; how many it replaced. */
function mutantBytes(from, to) {
  const bytes = new Uint8Array(fs.readFileSync(KERNEL_URL));
  const a = new Uint8Array(new Float64Array([from]).buffer);
  const b = new Uint8Array(new Float64Array([to]).buffer);
  let hits = 0;
  for (let i = 0; i + 9 <= bytes.length; i++) {
    if (bytes[i] !== 0x44) continue;
    let same = true;
    for (let j = 0; j < 8 && same; j++) same = bytes[i + 1 + j] === a[j];
    if (!same) continue;
    bytes.set(b, i + 1);
    hits++;
  }
  return { bytes, hits };
}

test('W2a sweep: mutants of the kernel fail the gate (EPSILON 1e-5 -> 2e-5, the dedupe 0.25 -> 0)', async () => {
  const scenes = randomScenes(0x3a3a).filter((_, i) => i % 6 === 0);
  const k = await createSweepKernel({ sets: [{ occluders: 48, poolVerts: 48 * 8 }], maxVerts: 512 });
  for (const [label, from, to] of [['EPSILON', 1e-5, 2e-5], ['dedupe', 0.25, 0]]) {
    const { bytes, hits } = mutantBytes(from, to);
    assert.ok(hits > 0, `${label}: the constant is in the module`);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory: k.memory } });
    const fns = Object.fromEntries(VARIANTS.map((v) => [v, instance.exports[SWEEP_VARIANTS[v]]]));
    const caught = [];
    for (const v of VARIANTS) {
      try {
        assertTallies(await runScenes(scenes, { k, fns: { [v]: fns[v] } }), `${label} mutant`);
      } catch (err) {
        if (!(err instanceof assert.AssertionError)) throw err;
        caught.push(`${v}: ${String(err.message).split('\n')[0]}`);
      }
    }
    assert.equal(caught.length, VARIANTS.length, `${label}: every variant's mutant fails the gate (${caught.join('; ')})`);
    console.log(`# ${label} mutant (${hits} constants): ${caught.join('; ')}`);
  }
  // And the unmutated module on the same scenes passes.
  assertTallies(await runScenes(scenes, { k }), 'unmutated');
});

// ---- the shipped module -------------------------------------------------------------------------------

const SHIPPED_URL = new URL('../../src/wasm/engine.wasm', import.meta.url);
const SHIPPED = { f32: 'sweep_light_f32', simd: 'sweep_light_simd' };

test('W2a sweep: the shipped visibilitySweep.wasm writes the screening module\'s f32 and simd bits', async () => {
  const OWNER_CAP = 64;
  const k = await createSweepKernel({ sets: [{ occluders: 48, poolVerts: 48 * 8 }], maxVerts: 512, ownerSeenCap: OWNER_CAP });
  const shipped = await loadWasmKernel('visibilitySweep', SHIPPED_URL, k.memory, Object.values(SHIPPED));
  const polarCos = new Float64Array(k.buffer, k.regions.polarCos.byte, POLAR_BINS * 2 + 1);
  const polarSin = new Float64Array(k.buffer, k.regions.polarSin.byte, POLAR_BINS * 2 + 1);
  const rng = mulberry32(0x5b1b);
  const scenes = randomScenes(0x5a5a).filter((_, i) => i % 3 === 0);
  let calls = 0;
  let polarCalls = 0;
  let stamp = 0;
  /** A call and everything it left: the polygon, the result words but the stamp, who it saw, the seen owners. */
  const run = (fn, sc, active) => {
    k.ownerSeen.fill(0);
    const n = quiet(() => fn(k.sets[0].tableByte, sc.lx, sc.ly, sc.radius, sc.occCount, active));
    const saw = [];
    for (let oi = 0; oi < sc.occCount + 2; oi++) saw.push(k.sawOccluder(oi));
    const res = Array.from(k.results);
    res[R.stamp] = 0;
    return { n, x: Array.from(k.outX.subarray(0, n)), y: Array.from(k.outY.subarray(0, n)), res, saw, owners: Array.from(k.ownerSeen) };
  };
  for (const [s, sc] of scenes.entries()) {
    k.load(0, sc);
    setMaxVerts(k, 0, sc.maxVerts);
    let active = 0;
    if (s % 2 === 1) {
      const segsOf = [];
      const owners = 1 + Math.floor(rng() * 6);
      for (let o = 0; o < owners; o++) segsOf.push(boundary(rng, sc.lx, sc.ly, sc.radius, 1 + Math.floor(rng() * 12)));
      const bins = polarBins(segsOf, sc.lx, sc.ly, sc.radius, polarCos, polarSin);
      k.polarDist.set(bins.dist);
      k.polarOwner.set(bins.owner);
      active = bins.active;
    }
    k.setOwnerStamp(++stamp);
    for (const [v, name] of Object.entries(SHIPPED)) {
      const ref = run(k.variants[v], sc, active);
      const got = run(shipped[name], sc, active);
      assert.deepEqual(got, ref, `${sc.kindName} scene ${s} ${v}`);
      calls++;
      if (active) polarCalls++;
    }
  }
  assert.ok(calls > 3000 && polarCalls > 1000, `${calls} calls compared, ${polarCalls} with polar bins`);
});
