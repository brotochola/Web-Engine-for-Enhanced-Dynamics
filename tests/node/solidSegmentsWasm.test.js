// E-76 W1: the compound-solid polar raster kernel (wasm/test/solidSegments.c, a test module) against the
// shipped collectSolidSegments, on the bins both leave after a light's calls. The JS's bins are read through
// clipVisibilityToPolar (one vertex per bin, no sweep), its owners from which call lowered each bin (checked
// against markSeenPolarOwners), and each call is also run alone so a bin knows its candidates
// (tests/helpers/solidSegmentsKernel.mjs).
//
// The gate (tolerance, not bit-identity: Chrome's Math.atan2 is not fdlibm, Q2): every bin's distance within a
// relative 1e-5 of the JS's (TOLERANCE; every variant computes a stamped distance with the JS's own double
// operations, so a bin either matches or was not stamped by one side), except "flips": bins where one side
// stamped and the other did not, which happen only when an end lies within rounding of a bin edge and moves a
// span's first or last bin. Flips are counted, must each be next to a rastered end's bin, and are bounded. The
// owner must match outside flips and bins whose two nearest candidates of different owners are within the
// tolerance; hit > 0 and the active flag must match. In Node, whose Math.atan2 is the fdlibm the f64 export
// ports, f64 must be bit for bit.
//
// Corpus: rings of 64 and 18 segments, boxes, a comb, a U, a star, a jittered grid; lights in the ring's hole,
// inside the material, inside a box, outside, far (out of range) and half in range; snapped poses (rot 0, whole
// numbers: lights level with, above and diagonal to vertices, edges seen edge-on either side of the 1e-4 span
// cutoff); spans across the +-pi fold; a light on a vertex; the signed-zero chain of polarRasterChain.test.js;
// several solids competing for bins; ends placed on every bin edge, a long edge's end half a pixel from the
// light (so a moved span edge shows in a bin); slivers at grazing angles; rays at the edge of raySegT's slack;
// and the stress scene's eight frames. Mutants: the span cutoff patched in the binary, the float filter's margin
// patched to 0, a cos table nudged by 2e-4, an owner off by one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { POLAR_BINS } from '../../src/render/visibility/angularSweep.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { gridCompound } from '../bench/compoundSolidMicrobench.mjs';
import { mulberry32 } from '../bench/benchMath.js';
import {
  FLIP_LIMIT,
  KERNEL_URL,
  TOLERANCE,
  WASM_VARIANTS,
  addStats,
  buildSolid,
  compareLight,
  createSolidSegmentsKernel,
  jsLightReference,
  ringTriangles,
  sceneFrames,
  sceneGate,
  spanEdgeBins,
  trianglesCompound,
  wasmLight,
} from '../helpers/solidSegmentsKernel.mjs';

const VARIANTS = Object.keys(WASM_VARIANTS);
const TABLE_VARIANTS = VARIANTS.filter((v) => v !== 'f64');

function box(x, y, w, h) {
  return [
    [[x, y], [x + w, y], [x + w, y + h]],
    [[x, y], [x + w, y + h], [x, y + h]],
  ];
}

/** Two triangles per '1' cell; shared edges cancel, so the outline is the union's (concave where the mask is). */
function maskTriangles(rows, cell, x0 = 0, y0 = 0) {
  const tris = [];
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) if (row[c] === '1') tris.push(...box(x0 + c * cell, y0 + r * cell, cell, cell));
  });
  return tris;
}

/** A star, fanned from its centre: concave outline. */
function starTriangles(points, outer, inner) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2;
    const r = i % 2 ? inner : outer;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts.map((p, i) => [[0, 0], p, pts[(i + 1) % pts.length]]);
}

let nextEntity = 300;
function solidOf(tris) {
  return buildSolid(nextEntity++, 1, trianglesCompound(tris));
}

function grid(cols, rows, cell, seed) {
  const body = gridCompound(cols, rows, cell, seed);
  return buildSolid(nextEntity++, 1, body);
}

const call = (solid, wx, wy, rot, owner, frame = null) => ({
  solid, wx, wy, c: frame ? frame.c : rot === 0 ? 1 : Math.cos(rot), s: frame ? frame.s : rot === 0 ? 0 : Math.sin(rot),
  ox: frame ? frame.offX : 0, oy: frame ? frame.offY : 0, owner,
});

function corpus() {
  const S = {
    ring64: solidOf(ringTriangles(64, 80, 32)),
    ring18: solidOf(ringTriangles(18, 40, 30)),
    boxes: solidOf([...box(0, 0, 30, 20), ...box(50, -10, 20, 40), ...box(-60, 30, 25, 25)]),
    comb: solidOf(maskTriangles(['1111111', '1010101', '1010101'], 12)),
    u: solidOf(maskTriangles(['111', '101', '101'], 20, -30, -30)),
    star: solidOf(starTriangles(5, 60, 25)),
    grid: grid(16, 8, 10, 23),
  };
  const cases = [];
  const add = (name, lx, ly, radius, calls) => cases.push({ name, light: { lx, ly, radius }, calls });

  // Placed cases.
  add('light in the ring hole', 5, -3, 300, [call(S.ring64, 0, 0, 0.3, 1)]);
  add('light inside a box', 15, 10, 200, [call(solidOf(box(0, 0, 30, 20)), 0, 0, 0, 2)]);
  add('far, out of range', 900, 900, 100, [call(S.ring64, 0, 0, 0, 3)]);
  add('half in range', 0, 150, 120, [call(S.ring64, 0, 0, 0, 4), call(S.grid, -180, -200, 0, 5)]);
  add('fold: solid straddles pi', 200, 7, 400, [call(S.ring18, 0, 0, 0.1, 6), call(S.star, 60, 0, 0, 7)]);
  add('fold, snapped', 300, 0, 500, [call(S.boxes, 0, -10, 0, 8), call(S.comb, 100, -6, 0, 9)]);
  // The boxes' bottom edge runs from (0, 0) to (30, 0) and faces down. Lit from (-50, -d) it spans about
  // 0.0075 d rad: under the 1e-4 cutoff up to d = 0.01333, over it from 0.01334.
  add('edge-on: light on an edge line', -50, 0, 300, [call(S.boxes, 0, 0, 0, 10)]);
  for (const d of [1e-9, 0.0133, 0.01334, 0.02]) {
    add(`edge-on: ${d} below the line`, -50, -d, 300, [call(S.boxes, 0, 0, 0, 11)]);
  }
  add('light inside the ring material', 56, 0, 300, [call(S.ring64, 0, 0, 0, 12)]);
  add('light on a vertex', 30, 20, 300, [call(S.boxes, 0, 0, 0, 13)]);
  add('level, above and diagonal', 80, 40, 400, [call(S.boxes, 0, 0, 0, 14), call(S.u, 40, 120, 0, 15), call(S.comb, -100, 0, 0, 16)]);
  add('diagonal to a corner', -40, -40, 400, [call(S.boxes, 0, 0, 0, 17)]);
  add('competing solids', 0, 0, 600, [
    call(S.ring64, 150, 20, 0.5, 18), call(S.ring18, 90, -30, 0, 19), call(S.star, -120, 40, 1.1, 20),
    call(S.grid, -100, -300, 0, 21), call(S.comb, 60, 140, -0.7, 22), call(S.ring64, 250, 30, 0.2, 23),
  ]);
  // polarRasterChain.test.js: two triangles meet at (2, -0) and (2, +0); the light at (5, 0) sees -pi and pi.
  const signedZero = solidOf([[[-600, -800], [2, -0], [-1000, 0]], [[-1000, 0], [2, 0], [-600, 800]]]);
  add('signed zero end', 5, 0, 400, [call(signedZero, 0, -0, 0, 24, { c: 1, s: -0, offX: 0, offY: -0 })]);

  // Seeded cases: every solid, snapped (rot 0, whole numbers) and turned, one to three solids per light.
  const rng = mulberry32(0x5e61);
  const list = Object.values(S);
  for (let k = 0; k < 240; k++) {
    const snap = k % 3 === 0;
    const lx = snap ? Math.round((rng() - 0.5) * 300) : (rng() - 0.5) * 600;
    const ly = snap ? Math.round((rng() - 0.5) * 300) : (rng() - 0.5) * 600;
    const radius = 40 + rng() * 600;
    const calls = [];
    const m = 1 + Math.floor(rng() * 3);
    for (let j = 0; j < m; j++) {
      const solid = list[Math.floor(rng() * list.length)];
      const wx = snap ? Math.round((rng() - 0.5) * 300) : (rng() - 0.5) * 600;
      const wy = snap ? Math.round((rng() - 0.5) * 300) : (rng() - 0.5) * 600;
      calls.push(call(solid, wx, wy, snap ? 0 : rng() * Math.PI * 2, 30 + j));
    }
    add(`seeded ${k}${snap ? ' snapped' : ''}`, lx, ly, radius, calls);
  }
  return cases;
}

/**
 * An end on every bin edge: the light and the entity at the origin, turned so local (0.5, 0) lands on bin edge
 * k's angle. The edge from (50.5, 86.6) to it is 100 long and half a pixel from the light at that end, so the
 * bin just past the end has its ray within raySegT's 1e-4 slack: a span edge moved by one bin changes it.
 * One case per edge and side (the end opening the span, or closing it).
 */
function binEdgeCases() {
  const opens = solidOf([[[0.5, 0], [100.5, 0], [50.5, 86.6]]]);
  const closes = solidOf([[[0.5, 0], [50.5, -86.6], [100.5, 0]]]);
  const cases = [];
  for (let k = 0; k < POLAR_BINS; k++) {
    const a = -Math.PI + (k * Math.PI * 2) / POLAR_BINS;
    const frame = { c: Math.cos(a), s: Math.sin(a), offX: 0, offY: 0 };
    cases.push({ name: `bin edge ${k} opens`, light: { lx: 0, ly: 0, radius: 300 }, calls: [call(opens, 0, 0, 0, 1, frame)] });
    cases.push({ name: `bin edge ${k} closes`, light: { lx: 0, ly: 0, radius: 300 }, calls: [call(closes, 0, 0, 0, 1, frame)] });
  }
  // Within 1e-17 of the axes: the JS's `+ pi` absorbs the angle, so it puts these on the axis's bin.
  for (const [c, s] of [[1, 1e-17], [1, -1e-17], [-1, 1e-17], [-1, -1e-17], [1e-17, 1], [-1e-17, 1], [1e-17, -1], [-1e-17, -1]]) {
    const frame = { c, s, offX: 0, offY: 0 };
    cases.push({ name: `axis ${c},${s} opens`, light: { lx: 0, ly: 0, radius: 300 }, calls: [call(opens, 0, 0, 0, 1, frame)] });
    cases.push({ name: `axis ${c},${s} closes`, light: { lx: 0, ly: 0, radius: 300 }, calls: [call(closes, 0, 0, 0, 1, frame)] });
  }
  return cases;
}

/** Run every case through the JS and the variants; per-variant totals. */
function runCases(k, cases, variants = VARIANTS, fns = k.fns) {
  const totals = Object.fromEntries(variants.map((v) => [v, {}]));
  const failures = Object.fromEntries(variants.map((v) => [v, []]));
  for (const c of cases) {
    const ref = jsLightReference(c.light, c.calls, k.tables);
    const edges = spanEdgeBins(c.light, c.calls);
    for (const v of variants) {
      const got = wasmLight(k, fns[v], c.light, c.calls);
      const s = compareLight(ref, got, edges);
      addStats(totals[v], s);
      if (s.flips || s.ownerMismatch || s.hitFlagMismatch || s.activeMismatch || s.hitCountMismatch) {
        failures[v].push({ name: c.name, ...s });
      }
    }
  }
  return { totals, failures };
}

/**
 * A mutant of the kernel: every f64.const `from` in its code replaced by `to` (an f64.const is 0x44 and the
 * value's eight bytes, so the module stays valid). Returns the bytes and how many were replaced.
 */
function patchF64Const(bytes, from, to) {
  const f = new Uint8Array(new Float64Array([from]).buffer);
  const t = new Uint8Array(new Float64Array([to]).buffer);
  const out = Uint8Array.from(bytes);
  let count = 0;
  for (let i = 0; i + 9 <= out.length; i++) {
    if (out[i] !== 0x44) continue;
    let same = true;
    for (let j = 0; j < 8 && same; j++) same = out[i + 1 + j] === f[j];
    if (!same) continue;
    out.set(t, i + 1);
    count++;
    i += 8;
  }
  return { bytes: out, count };
}

const dataUrl = (bytes) => `data:application/wasm;base64,${Buffer.from(bytes).toString('base64')}`;

const kernel = await createSolidSegmentsKernel();

test('the JS readout: derived owners are the ones markSeenPolarOwners marks', () => {
  for (const c of corpus().slice(0, 80)) {
    const ref = jsLightReference(c.light, c.calls, kernel.tables);
    const owners = new Set();
    let owned = 0;
    for (let b = 0; b < POLAR_BINS; b++) {
      if (ref.owner[b] >= 0) {
        owners.add(ref.owner[b]);
        owned++;
      }
    }
    if (!ref.active) {
      assert.equal(owned, 0, `${c.name}: owners without an active bin`);
      continue;
    }
    assert.deepEqual([...owners].sort((a, b) => a - b), ref.seen.get('owners'), `${c.name}: owner set`);
    assert.equal(owned, ref.seen.get('marked'), `${c.name}: owned bins`);
  }
});

test('the corpus reaches the cases it names', () => {
  const cases = corpus();
  const ref = (name) => {
    const c = cases.find((x) => x.name === name);
    return { c, r: jsLightReference(c.light, c.calls, kernel.tables) };
  };
  for (const name of ['fold: solid straddles pi', 'fold, snapped']) {
    const { r } = ref(name);
    assert.ok(r.owner[0] >= 0 && r.owner[POLAR_BINS - 1] >= 0, `${name}: a span across the fold`);
  }
  // Every edge of a box faces away from a light inside it. (Inside the ring's material the light still faces
  // the far wall of the hole.)
  const inside = ref('light inside a box').r;
  assert.ok(inside.hits[0] > 0 && !inside.active, 'inside a box: in range, nothing rastered');
  assert.equal(ref('far, out of range').r.hits[0], 0);
  const half = ref('half in range');
  assert.ok(half.r.hits[0] > 0 && half.r.active);
  assert.ok(ref('light in the ring hole').r.active);
  assert.ok(ref('signed zero end').r.active);
});

test('every variant is within the tolerance of collectSolidSegments on the corpus', () => {
  const cases = corpus();
  const { totals, failures } = runCases(kernel, cases);
  for (const v of VARIANTS) {
    const t = totals[v];
    assert.ok(t.ownerChecked > cases.length * 400, `${v}: owners checked ${t.ownerChecked}`);
    assert.equal(t.strayFlips, 0, `${v}: a flip away from every span edge ${JSON.stringify(failures[v].slice(0, 3))}`);
    assert.equal(t.ownerMismatch, 0, `${v}: owners ${JSON.stringify(failures[v].slice(0, 3))}`);
    assert.equal(t.hitFlagMismatch, 0, `${v}: hit > 0 ${JSON.stringify(failures[v].slice(0, 3))}`);
    assert.equal(t.activeMismatch, 0, `${v}: active flag`);
    assert.ok(t.worstRel <= TOLERANCE, `${v}: worst ${t.worstRel}`);
    assert.ok(t.flips <= 2, `${v}: ${t.flips} flipped bins ${JSON.stringify(failures[v].slice(0, 3))}`);
  }
  // Node's Math.atan2 is the fdlibm collect_solid_f64 ports: bit for bit, hit counts too. pseudo keeps the
  // JS's range test, so its counts match as well.
  assert.deepEqual(failures.f64, [], 'f64 is bit for bit in Node');
  assert.equal(totals.f64.worstRel, 0);
  assert.equal(totals.pseudo.hitCountMismatch, 0);
  const summary = Object.fromEntries(VARIANTS.map((v) => [v, {
    flips: totals[v].flips, worstRel: totals[v].worstRel, ambiguous: totals[v].ambiguous, hitCounts: totals[v].hitCountMismatch,
  }]));
  console.log(`corpus ${cases.length} lights, ${totals.f64.bins} bins: ${JSON.stringify(summary)}`);
});

test('ends on bin edges move at most a span edge bin, and only next to the end', () => {
  const cases = binEdgeCases();
  const { totals, failures } = runCases(kernel, cases);
  for (const v of VARIANTS) {
    const t = totals[v];
    assert.equal(t.strayFlips, 0, `${v}: stray flips ${JSON.stringify(failures[v].slice(0, 3))}`);
    assert.equal(t.ownerMismatch, 0, v);
    assert.equal(t.hitFlagMismatch, 0, v);
    assert.equal(t.activeMismatch, 0, v);
    // One end sits on the edge in each case: at most one bin moves. Which side of the edge such an end is on
    // is rounding (the JS's atan2, its `+ pi`, the tan table): the table variants and the JS disagree on about
    // half of these ends, and random data puts an end that close to an edge about once in 1e13.
    for (const f of failures[v]) assert.ok(f.flips <= 1, `${v} ${f.name}: ${f.flips} bins`);
  }
  assert.equal(totals.f64.flips, 0, 'f64 takes the JS angles in Node');
  const flips = Object.fromEntries(VARIANTS.map((v) => [v, totals[v].flips]));
  const axis = Object.fromEntries(VARIANTS.map((v) => [v, failures[v].filter((f) => f.name.startsWith('axis')).length]));
  console.log(`bin-edge cases ${cases.length}: flipped bins ${JSON.stringify(flips)}, of them near an axis ${JSON.stringify(axis)}`);
});

test('fast, f64x2 and f32x4 leave the bins pseudo leaves, bit for bit, on slivers seen at grazing angles', () => {
  // They take pseudo's span bins and stamp each bin through the JS's raySegT behind a filter; a filter that
  // refused a bin the JS stamps would show here. Slivers 0.1 to 400 long and 1e-4 to 1 thick, lit from
  // 0.05 to 1000 away, so most rays meet their edges nearly edge-on.
  const rng = mulberry32(0xf32);
  let compared = 0;
  for (let k = 0; k < 400; k++) {
    const len = 0.1 * Math.pow(4000, rng());
    const thick = 1e-4 * Math.pow(1e4, rng());
    const phi = rng() * Math.PI * 2;
    const ax = (rng() - 0.5) * 200;
    const ay = (rng() - 0.5) * 200;
    const b = [ax + Math.cos(phi) * len, ay + Math.sin(phi) * len];
    const c = [ax + len * 0.5 * Math.cos(phi) - Math.sin(phi) * thick, ay + len * 0.5 * Math.sin(phi) + Math.cos(phi) * thick];
    const solid = solidOf([[[ax, ay], b, c]]);
    const dist = 0.05 * Math.pow(2e4, rng());
    const dir = rng() * Math.PI * 2;
    const light = { lx: ax + Math.cos(dir) * dist, ly: ay + Math.sin(dir) * dist, radius: 2000 };
    const calls = [call(solid, 0, 0, 0, 1), call(solid, (rng() - 0.5) * 2, (rng() - 0.5) * 2, rng() * 0.01, 2)];
    const want = wasmLight(kernel, kernel.fns.pseudo, light, calls);
    for (const v of ['fast', 'f64x2', 'f32x4']) {
      const got = wasmLight(kernel, kernel.fns[v], light, calls);
      assert.deepEqual(Array.from(got.dist), Array.from(want.dist), `${v} sliver ${k}: dist`);
      assert.deepEqual(Array.from(got.owner), Array.from(want.owner), `${v} sliver ${k}: owner`);
      assert.equal(got.active, want.active, `${v} sliver ${k}`);
      assert.deepEqual(Array.from(got.hits, (h) => h > 0), Array.from(want.hits, (h) => h > 0), `${v} sliver ${k}`);
    }
    if (want.active) compared++;
  }
  assert.ok(compared > 300, `${compared} slivers stamped`);
});

/**
 * Rays that meet an edge's line just inside raySegT's slack (u in [1 + 1e-4 - 2e-7, 1 + 1e-4]), where a float
 * filter's rounding decides: the light at the origin, edge p0 -> p1 front-facing, a bin's centre ray past p1
 * (or, with the ends swapped, before p0). The ends are floats (local = world: entity at the origin, rot 0); a
 * candidate is kept when the JS's own u lands in the band.
 */
function slackCases(count) {
  const rng = mulberry32(0x51ac);
  const tables = kernel.tables;
  const out = [];
  for (let tries = 0; out.length < count && tries < count * 400; tries++) {
    const b = Math.floor(rng() * POLAR_BINS);
    const c = tables.cos[b];
    const s = tables.sin[b];
    const t = 20 + rng() * 300;
    const L = 5 + rng() * 80;
    const psi = Math.atan2(s, c) + 0.3 + rng() * 2.5;
    const ex = Math.cos(psi);
    const ey = Math.sin(psi);
    const over = (1e-4 - rng() * 2e-7) * L;
    const p1 = [Math.fround(t * c - over * ex), Math.fround(t * s - over * ey)];
    const p0 = [Math.fround(p1[0] - L * ex), Math.fround(p1[1] - L * ey)];
    let a = p0;
    let z = p1;
    if (a[0] * z[1] - a[1] * z[0] >= 0) [a, z] = [z, a];
    // The JS's raySegT u for this ray (the light at the origin).
    const dx = z[0] - a[0];
    const dy = z[1] - a[1];
    const denom = c * dy - s * dx;
    const u = (a[0] * s - a[1] * c) / denom;
    const tt = (a[0] * dy - a[1] * dx) / denom;
    const nearHi = u <= 1 + 1e-4 && u >= 1 + 1e-4 - 2e-7;
    const nearLo = u >= -1e-4 && u <= -1e-4 + 2e-7;
    if (!(nearHi || nearLo) || !(tt > 1e-4)) continue;
    // Close a CCW triangle on the far side of the edge from the light.
    const mx = (a[0] + z[0]) / 2;
    const my = (a[1] + z[1]) / 2;
    const nx = dy;
    const ny = -dx;
    const away = nx * -a[0] + ny * -a[1] > 0 ? -1 : 1;
    const q = [Math.fround(mx + away * nx * 0.5), Math.fround(my + away * ny * 0.5)];
    const tri = [a, z, q];
    const cr = (z[0] - a[0]) * (q[1] - a[1]) - (z[1] - a[1]) * (q[0] - a[0]);
    if (!(cr > 0)) continue;
    out.push({ name: `slack bin ${b}`, light: { lx: 0, ly: 0, radius: 1000 }, calls: [call(solidOf([tri]), 0, 0, 0, 1)], bin: b });
  }
  return out;
}

test('the float filter keeps rays at the edge of raySegT\'s slack, and needs its margins to', async () => {
  const cases = slackCases(200);
  assert.equal(cases.length, 200);
  // The JS stamps each case's bin through the slack.
  let stampedJs = 0;
  for (const c of cases) if (jsLightReference(c.light, c.calls, kernel.tables).owner[c.bin] === 1) stampedJs++;
  assert.ok(stampedJs > 150, `${stampedJs} slack bins stamped by the JS`);
  const { totals, failures } = runCases(kernel, cases);
  for (const v of VARIANTS) assert.deepEqual(failures[v], [], `${v}: ${JSON.stringify(totals[v])}`);
  // Mutant: F32_MARGIN 0 (the float filter at its bare rounding) drops some of them.
  const patched = patchF64Const(fs.readFileSync(KERNEL_URL), 1e-6, 0);
  assert.ok(patched.count > 0);
  const bare = await createSolidSegmentsKernel({ wasmUrl: dataUrl(patched.bytes) });
  const mutant = runCases(bare, cases, ['f32x4']);
  assert.ok(mutant.totals.f32x4.flips > 0, `the bare filter kept every slack bin: ${JSON.stringify(mutant.totals.f32x4)}`);
  console.log(`slack cases ${cases.length}: JS stamps ${stampedJs}; f32x4 without margins loses ${mutant.totals.f32x4.flips}`);
});

test('the stress scene frames: every variant passes the bench gate with the JS checksum', async () => {
  const gate = await sceneGate();
  const calls = gate.frames.reduce((n, frame) => n + frame.reduce((m, l) => m + l.calls.length, 0), 0);
  assert.ok(calls / gate.frames.length > 800, `${calls / gate.frames.length} calls a frame`);
  const summary = {};
  for (const v of VARIANTS) {
    const g = gate.verify(v);
    assert.ok(g.pass, `${v}: ${JSON.stringify(g.stats)}`);
    assert.equal(g.checksum, gate.refHash, v);
    assert.ok(g.stats.flips <= FLIP_LIMIT, v);
    summary[v] = { flips: g.stats.flips, worstRel: g.stats.worstRel, hitCounts: g.stats.hitCountMismatch };
  }
  console.log(`scene ${gate.frames.length} frames, ${calls} calls: ${JSON.stringify(summary)}`);
});

test('mutant: a span cutoff of 0.02 rad instead of 1e-4 fails the gate', async () => {
  const original = fs.readFileSync(KERNEL_URL);
  // The table variants' cutoff, tan(1e-4); the f64 export's `span > 1e-4` shares 1e-4 with raySegT's slack.
  const tables = patchF64Const(original, 1.0000000033333334e-4, Math.tan(0.02));
  assert.ok(tables.count >= TABLE_VARIANTS.length, `patched ${tables.count} constants`);
  const both = patchF64Const(tables.bytes, 1e-4, 0.02);
  assert.ok(both.count > 0);
  const gate = await sceneGate({ wasmUrl: dataUrl(both.bytes) });
  for (const v of VARIANTS) {
    const g = gate.verify(v);
    assert.equal(g.pass, false, `${v} should fail: ${JSON.stringify(g.stats)}`);
    assert.notEqual(g.checksum, gate.refHash, v);
    assert.ok(g.stats.flips > FLIP_LIMIT, `${v}: ${g.stats.flips} flips`);
  }
});

test('mutant: cos/sin tables 2e-4 off in every 7th bin are outside the tolerance', async () => {
  const k = await createSolidSegmentsKernel();
  const cos = new Float64Array(k.memory.buffer, k.ctx[3], POLAR_BINS);
  const sin = new Float64Array(k.memory.buffer, k.ctx[4], POLAR_BINS);
  for (let b = 0; b < POLAR_BINS; b += 7) {
    cos[b] *= 1 + 2e-4;
    sin[b] *= 1 + 2e-4;
  }
  const { totals } = runCases(k, corpus().slice(0, 60));
  for (const v of VARIANTS) assert.ok(totals[v].flips > 50, `${v}: ${totals[v].flips} bins outside the tolerance`);
});

test('mutant: an owner off by one is caught', () => {
  const c = corpus().find((x) => x.name === 'competing solids');
  const ref = jsLightReference(c.light, c.calls, kernel.tables);
  const edges = spanEdgeBins(c.light, c.calls);
  const wrong = c.calls.map((x, i) => (i === 2 ? { ...x, owner: x.owner + 1 } : x));
  for (const v of VARIANTS) {
    const s = compareLight(ref, wasmLight(kernel, kernel.fns[v], c.light, wrong), edges);
    assert.equal(s.flips, 0, v);
    assert.ok(s.ownerMismatch > 0, `${v}: ${s.ownerMismatch}`);
  }
});

test('the shipped solidSegments.wasm writes the screening module\'s f32x4 bits', async () => {
  const k = await createSolidSegmentsKernel({ solidBytes: 8 << 20 });
  const url = new URL('../../src/wasm/engine.wasm', import.meta.url);
  const shipped = (await loadWasmKernel('solidSegments', url, k.memory, ['collect_solid_f32x4'])).collect_solid_f32x4;
  const cases = [...corpus(), ...binEdgeCases(), ...slackCases(200)];
  for (const frame of sceneFrames({ entityBase: 2000 }).frames) {
    frame.forEach(({ light, calls }, l) => cases.push({ name: `scene light ${l}`, light, calls }));
  }
  let stamped = 0;
  for (const c of cases) {
    const ref = wasmLight(k, k.fns.f32x4, c.light, c.calls);
    const got = wasmLight(k, shipped, c.light, c.calls);
    assert.deepEqual(got, ref, c.name);
    if (ref.active) stamped++;
  }
  assert.ok(stamped > 1000, `${stamped} of ${cases.length} lights stamped bins`);
});

test('an empty solid and n = 0 return 0 and stamp nothing', () => {
  const p = kernel.place(solidOf(box(0, 0, 10, 10)));
  for (const v of VARIANTS) {
    kernel.clear(100);
    assert.equal(kernel.fns[v](kernel.ctxByte, p.segByte, p.chainByte, 0, 0, 0, 1, 0, 0, 0, -20, 5, 1e4, 1), 0, v);
    assert.equal(kernel.active[0], 0, v);
    assert.ok(kernel.dist.every((d) => d === 100), v);
  }
});
