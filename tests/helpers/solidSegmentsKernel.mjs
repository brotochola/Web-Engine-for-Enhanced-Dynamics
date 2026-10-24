// E-76 W1: the compound-solid polar raster kernel (wasm/test/solidSegments.c, a test module) and what its test
// and its bench (tests/node/solidSegmentsWasm.test.js, tests/bench/solidSegmentsWasmMicrobench.mjs) share: the
// memory it works in, the JS's bins read back from angularSweep.js, the tolerance gate, and
// compoundVisPolyStressScene?ringSegments=64's frames. Browser-safe (chromeKernel.mjs runs the bench in Chrome).
//
// The gate: every bin's distance within TOLERANCE (relative) of the JS's. Every variant computes a stamped
// distance with the JS's own double operations, so a bin either matches bit for bit or was stamped by one side
// only: a "flip", which happens when an end lies within rounding of a bin edge and moves its span's first or
// last bin. Flips are counted and must each be next to the bin of a rastered end. The owner must match outside
// flips and outside bins whose two nearest candidates of different owners are within TOLERANCE; hit > 0 and the
// active flag must match.
import {
  POLAR_BINS,
  clearPolarBins,
  clipVisibilityToPolar,
  collectSolidSegments,
  ensureCompoundSolid,
  markSeenPolarOwners,
  polarBinsActive,
  segmentDistSq,
} from '../../src/render/visibility/angularSweep.js';
import { MAX_POLYGON_VERTICES } from '../../src/util/configDefaults.js';
import { normalizeAngleSigned } from '../../src/util/utils.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { NULL_GUARD_BYTES, layoutRegions } from '../../src/util/wasmMemoryMap.js';
import { mulberry32 } from '../bench/benchMath.js';

export const KERNEL_URL = new URL('../fixtures/wasm/solidSegments.wasm', import.meta.url);

/** Variant name -> export. */
export const WASM_VARIANTS = {
  f64: 'collect_solid_f64',
  pseudo: 'collect_solid_pseudo',
  fast: 'collect_solid_fast',
  f64x2: 'collect_solid_f64x2',
  f32x4: 'collect_solid_f32x4',
};

/** Relative distance tolerance of the gate. */
export const TOLERANCE = 1e-5;
/** Flipped bins a passing variant may have over the scene's checksum frames (each next to a rastered end). */
export const FLIP_LIMIT = 8;

/** solidSegments.c's context table, slot for slot. */
export const CTX_SLOTS = ['dist', 'owner', 'active', 'cos', 'sin', 'cosF', 'sinF', 'tan'];
const C = Object.fromEntries(CTX_SLOTS.map((name, i) => [name, i]));

const TWO_PI = Math.PI * 2;
const BIN_SCALE = POLAR_BINS / TWO_PI;
const F32_PAD = 4;

/**
 * The tables the kernel reads, from the JS's own expressions: bin b's centre ray is the angle index m = 2b + 1 of
 * angularSweep.js's _polarCos / _polarSin (-pi + m * 0.5 * (2 pi / POLAR_BINS)), so the doubles are the same.
 */
export function polarTables() {
  const cos = new Float64Array(POLAR_BINS);
  const sin = new Float64Array(POLAR_BINS);
  for (let b = 0; b < POLAR_BINS; b++) {
    const m = 2 * b + 1;
    const ang = -Math.PI + m * 0.5 * (TWO_PI / POLAR_BINS);
    cos[b] = Math.cos(ang);
    sin[b] = Math.sin(ang);
  }
  const cosF = new Float32Array(POLAR_BINS + F32_PAD);
  const sinF = new Float32Array(POLAR_BINS + F32_PAD);
  for (let i = 0; i < POLAR_BINS + F32_PAD; i++) {
    cosF[i] = cos[i % POLAR_BINS];
    sinF[i] = sin[i % POLAR_BINS];
  }
  const tan = new Float64Array(65);
  for (let k = 1; k < 64; k++) tan[k] = Math.tan((k * Math.PI) / 256);
  tan[64] = 1;
  return { cos, sin, cosF, sinF, tan };
}

/** The JS's bin of an end: rasterPolarSpan's ((normalizeAngleSigned(atan2) + pi) * scale) | 0, clamped. */
export function jsEndBin(x, y, lx, ly) {
  let b = ((normalizeAngleSigned(Math.atan2(y - ly, x - lx)) + Math.PI) * BIN_SCALE) | 0;
  if (b < 0) b = 0;
  else if (b >= POLAR_BINS) b = POLAR_BINS - 1;
  return b;
}

/**
 * The shared memory with the context table, the bins and the tables written, and the kernel's exports bound.
 * `wasmUrl` overrides the module (a data: URL of patched bytes, for the mutant tests).
 * @param {{ solidBytes?: number, wasmUrl?: URL | string }} [opts]
 */
export async function createSolidSegmentsKernel(opts = {}) {
  const solidBytes = opts.solidBytes ?? 1 << 20;
  const layout = layoutRegions([
    { name: 'guard', owner: 'none', bytes: NULL_GUARD_BYTES },
    { name: 'ctx', owner: 'pre-render', bytes: CTX_SLOTS.length * 4 },
    { name: 'dist', owner: 'pre-render', bytes: POLAR_BINS * 4 },
    { name: 'owner', owner: 'pre-render', bytes: POLAR_BINS * 4 },
    { name: 'active', owner: 'pre-render', bytes: 4 },
    { name: 'cos', owner: 'pre-render', bytes: POLAR_BINS * 8 },
    { name: 'sin', owner: 'pre-render', bytes: POLAR_BINS * 8 },
    { name: 'cosF', owner: 'pre-render', bytes: (POLAR_BINS + F32_PAD) * 4 },
    { name: 'sinF', owner: 'pre-render', bytes: (POLAR_BINS + F32_PAD) * 4 },
    { name: 'tan', owner: 'pre-render', bytes: 65 * 8 },
    { name: 'solids', owner: 'pre-render', bytes: solidBytes },
  ]);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const R = layout.regions;
  const tables = polarTables();
  new Float64Array(buffer, R.cos.byte, POLAR_BINS).set(tables.cos);
  new Float64Array(buffer, R.sin.byte, POLAR_BINS).set(tables.sin);
  new Float32Array(buffer, R.cosF.byte, POLAR_BINS + F32_PAD).set(tables.cosF);
  new Float32Array(buffer, R.sinF.byte, POLAR_BINS + F32_PAD).set(tables.sinF);
  new Float64Array(buffer, R.tan.byte, 65).set(tables.tan);
  const ctx = new Uint32Array(buffer, R.ctx.byte, CTX_SLOTS.length);
  for (const name of CTX_SLOTS) ctx[C[name]] = R[name].byte;
  const fns = await loadWasmKernel('solidSegments', opts.wasmUrl ?? KERNEL_URL, memory, Object.values(WASM_VARIANTS));
  const byVariant = Object.fromEntries(Object.entries(WASM_VARIANTS).map(([v, name]) => [v, fns[name]]));
  const dist = new Float32Array(buffer, R.dist.byte, POLAR_BINS);
  const owner = new Int32Array(buffer, R.owner.byte, POLAR_BINS);
  const active = new Int32Array(buffer, R.active.byte, 1);
  const placed = new Map();
  let solidCursor = R.solids.byte;
  const solidEnd = R.solids.byte + R.solids.bytes;

  /** The solid's seg and chain in the memory (copied on first use; the chain built first if it is not). */
  function place(solid) {
    let p = placed.get(solid);
    if (p && p.revision === solid.revision && p.n === solid.segCount && solid.chainValid) return p;
    // collectSolidSegments builds the chain on its first call; nothing is in range at radiusSq -1.
    if (!solid.chainValid) collectSolidSegments(solid, 0, 0, 1, 0, 0, 0, 0, 0, -1, -1);
    const n = solid.segCount;
    const segByte = solidCursor;
    const chainByte = segByte + n * 16;
    const next = Math.ceil((chainByte + n * 4) / 64) * 64;
    if (next > solidEnd) throw new Error('solidSegments: the solids region is full');
    new Float32Array(buffer, segByte, n * 4).set(solid.seg.subarray(0, n * 4));
    new Int32Array(buffer, chainByte, n).set(solid.chain.subarray(0, n));
    solidCursor = next;
    p = { segByte, chainByte, n, revision: solid.revision };
    placed.set(solid, p);
    return p;
  }

  /** clearPolarBins on the memory's bins. */
  function clear(radius) {
    const r = radius > 0 ? radius : 0;
    dist.fill(r);
    owner.fill(-1);
    active[0] = 0;
  }

  return { memory, layout, ctxByte: R.ctx.byte, ctx, dist, owner, active, tables, fns: byVariant, place, clear };
}

const NONE = 0xffff;
const V = MAX_POLYGON_VERTICES;

/** Fixture columns of a compound of triangles (CCW), one fixture each, linked in order. */
export function trianglesCompound(tris) {
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

/** compoundVisIsland's makeRingPolys: `segments` quads between innerR and outerR, two CCW triangles each. */
export function ringTriangles(segments, outerR, innerR) {
  const pt = (i, r) => {
    const a = ((i % segments) / segments) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  const tris = [];
  for (let i = 0; i < segments; i++) {
    tris.push([pt(i, innerR), pt(i, outerR), pt(i + 1, outerR)]);
    tris.push([pt(i, innerR), pt(i + 1, outerR), pt(i + 1, innerR)]);
  }
  return tris;
}

/** ensureCompoundSolid for a body from trianglesCompound (segments only, as pre-render asks). */
export function buildSolid(entity, revision, body) {
  return ensureCompoundSolid(
    entity, revision, body.head, body.next, body.active, body.vertCount, body.vx, body.vy, 0, body.fixtures, false,
  );
}

const _readX = new Float64Array(POLAR_BINS);
const _readY = new Float64Array(POLAR_BINS);

/**
 * The module's bins as distances: clipVisibilityToPolar with no sweep and one vertex per bin writes
 * lx + cos * d, ly + sin * d (d the bin's float); d is read back from the larger component and checked by
 * recomputing both. Without an active bin it writes nothing, and every bin holds the cleared radius.
 */
export function readJsDist(lx, ly, radius, tables, out) {
  if (!polarBinsActive()) {
    out.fill(radius > 0 ? radius : 0);
    return false;
  }
  const m = clipVisibilityToPolar(lx, ly, _readX, _readY, 0, _readX, _readY, POLAR_BINS);
  if (m !== POLAR_BINS) throw new Error(`readJsDist: ${m} vertices`);
  for (let b = 0; b < POLAR_BINS; b++) {
    const c = tables.cos[b];
    const s = tables.sin[b];
    const d = Math.fround(Math.abs(c) >= Math.abs(s) ? (_readX[b] - lx) / c : (_readY[b] - ly) / s);
    if (lx + c * d !== _readX[b] || ly + s * d !== _readY[b]) throw new Error(`readJsDist: bin ${b} does not read back`);
    out[b] = d;
  }
  return true;
}

/**
 * One light's calls through the shipped JS: the bins after all of them, each bin's owner (the call that last
 * lowered it), each call's hit, the active flag, markSeenPolarOwners' marks, and which bins are ambiguous (each
 * call run alone gives the bin's candidates). calls[k] = { solid, wx, wy, c, s, ox, oy, owner }.
 */
export function jsLightReference(light, calls, tables) {
  const { lx, ly, radius } = light;
  const r2 = radius * radius;
  const cleared = Math.fround(radius > 0 ? radius : 0);
  const solo = [];
  const scratch = new Float32Array(POLAR_BINS);
  for (const call of calls) {
    clearPolarBins(radius);
    collectSolidSegments(call.solid, call.wx, call.wy, call.c, call.s, call.ox, call.oy, lx, ly, r2, call.owner);
    readJsDist(lx, ly, radius, tables, scratch);
    solo.push(Float32Array.from(scratch));
  }
  clearPolarBins(radius);
  const dist = new Float32Array(POLAR_BINS).fill(cleared);
  const owner = new Int32Array(POLAR_BINS).fill(-1);
  const hits = new Int32Array(calls.length);
  calls.forEach((call, k) => {
    hits[k] = collectSolidSegments(call.solid, call.wx, call.wy, call.c, call.s, call.ox, call.oy, lx, ly, r2, call.owner);
    readJsDist(lx, ly, radius, tables, scratch);
    for (let b = 0; b < POLAR_BINS; b++) {
      if (scratch[b] < dist[b]) owner[b] = call.owner;
      dist[b] = scratch[b];
    }
  });
  const active = polarBinsActive();
  const seen = new Map();
  if (active) {
    const marks = new Int32Array(Math.max(1, ...calls.map((c) => c.owner + 1)));
    clipVisibilityToPolar(lx, ly, _readX, _readY, 0, _readX, _readY, POLAR_BINS);
    seen.set('marked', markSeenPolarOwners(marks, 1));
    const owners = [];
    marks.forEach((v, i) => {
      if (v) owners.push(i);
    });
    seen.set('owners', owners);
  }
  const ambiguous = new Uint8Array(POLAR_BINS);
  for (let b = 0; b < POLAR_BINS; b++) {
    const best = new Map();
    calls.forEach((call, k) => {
      const d = solo[k][b];
      if (d < cleared && !(best.get(call.owner) <= d)) best.set(call.owner, d);
    });
    const ds = [...best.values()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    if (ds.length >= 2 && ds[1] - ds[0] <= TOLERANCE * ds[1]) ambiguous[b] = 1;
  }
  return { dist, owner, hits, active, seen, ambiguous, cleared };
}

/** The same calls through one WASM export: the memory's bins after all of them, the hits, the active flag. */
export function wasmLight(k, fn, light, calls) {
  const { lx, ly, radius } = light;
  const r2 = radius * radius;
  k.clear(radius);
  const hits = new Int32Array(calls.length);
  calls.forEach((call, i) => {
    const p = k.place(call.solid);
    hits[i] = fn(k.ctxByte, p.segByte, p.chainByte, p.n, call.wx, call.wy, call.c, call.s, call.ox, call.oy, lx, ly, r2, call.owner);
  });
  return { dist: Float32Array.from(k.dist), owner: Int32Array.from(k.owner), hits, active: k.active[0] };
}

/**
 * The bins next to an end of an edge the JS rasters, for these calls (collectSolidSegments' facing and range
 * tests): each end's JS bin and its neighbours. A bin that flips when an end sits on a bin edge is the first or
 * last of its span, so it is one of these.
 */
export function spanEdgeBins(light, calls) {
  const { lx, ly, radius } = light;
  const r2 = radius * radius;
  const near = new Uint8Array(POLAR_BINS);
  const mark = (b) => {
    for (let d = -1; d <= 1; d++) near[(b + d + POLAR_BINS) % POLAR_BINS] = 1;
  };
  for (const call of calls) {
    const { solid, wx, wy, c, s, ox, oy } = call;
    const originX = wx + c * ox - s * oy;
    const originY = wy + s * ox + c * oy;
    for (let i = 0; i < solid.segCount; i++) {
      const o = i * 4;
      const x0 = originX + c * solid.seg[o] - s * solid.seg[o + 1];
      const y0 = originY + s * solid.seg[o] + c * solid.seg[o + 1];
      const x1 = originX + c * solid.seg[o + 2] - s * solid.seg[o + 3];
      const y1 = originY + s * solid.seg[o + 2] + c * solid.seg[o + 3];
      if ((x1 - x0) * (ly - y0) - (y1 - y0) * (lx - x0) >= 0) continue;
      if (segmentDistSq(lx, ly, x0, y0, x1, y1) > r2) continue;
      mark(jsEndBin(x0, y0, lx, ly));
      mark(jsEndBin(x1, y1, lx, ly));
    }
  }
  return near;
}

/** A variant's light against the JS's (see the header). */
export function compareLight(ref, got, edgeBins) {
  const out = {
    bins: POLAR_BINS, flips: 0, strayFlips: 0, worstRel: 0, ownerChecked: 0, ownerMismatch: 0, ambiguous: 0,
    hitFlagMismatch: 0, hitCountMismatch: 0, activeMismatch: (ref.active ? 1 : 0) !== (got.active ? 1 : 0) ? 1 : 0,
    flipBins: [],
  };
  for (let b = 0; b < POLAR_BINS; b++) {
    const dj = ref.dist[b];
    const dv = got.dist[b];
    const rel = dj === dv ? 0 : Math.abs(dv - dj) / Math.max(Math.abs(dj), Math.abs(dv));
    if (!(rel <= TOLERANCE)) {
      out.flips++;
      out.flipBins.push(b);
      if (!edgeBins || !edgeBins[b]) out.strayFlips++;
      continue;
    }
    if (rel > out.worstRel) out.worstRel = rel;
    if (ref.ambiguous[b]) {
      out.ambiguous++;
      continue;
    }
    out.ownerChecked++;
    if (ref.owner[b] !== got.owner[b]) out.ownerMismatch++;
  }
  for (let i = 0; i < ref.hits.length; i++) {
    if ((ref.hits[i] > 0) !== (got.hits[i] > 0)) out.hitFlagMismatch++;
    if (ref.hits[i] !== got.hits[i]) out.hitCountMismatch++;
  }
  return out;
}

/** Sum of compareLight results. */
export function addStats(total, s) {
  for (const key of Object.keys(s)) {
    if (key === 'flipBins') continue;
    if (key === 'worstRel') total.worstRel = Math.max(total.worstRel ?? 0, s.worstRel);
    else total[key] = (total[key] ?? 0) + s[key];
  }
  return total;
}

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function fnvBins(h, dist, owner) {
  for (let b = 0; b < POLAR_BINS; b++) {
    _f32[0] = dist[b];
    h = Math.imul(h ^ _u32[0], 16777619) >>> 0;
    h = Math.imul(h ^ (owner[b] >>> 0), 16777619) >>> 0;
  }
  return h;
}
function fnvHits(h, hits) {
  for (let i = 0; i < hits.length; i++) h = Math.imul(h ^ (hits[i] > 0 ? 1 : 0), 16777619) >>> 0;
  return h;
}

// compoundVisPolyStressScene's defaults with ringSegments=64.
export const SCENE_SEED = 0xc0ffee;
const ISLANDS = 40;
const LIGHTS = 24;
const WORLD = 2400;
const RING_SEGMENTS = 64;
const OUTER_R = 80;
const INNER_R = 32;
const LIGHT_RADIUS = Math.sqrt(22500) * 10; // lightInfluenceRadius(sqrt(lightIntensity))
const RING_REACH = Math.sqrt(80 * 80 + 80 * 80); // half diagonal of the 160 x 160 collider box
export const FRAME_TIMES = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
export const SCENE_ISLANDS = ISLANDS;

/** Position after t seconds bouncing between lo and hi (the scene's walls). */
function bounce(x0, v, t, lo, hi) {
  const span = hi - lo;
  let u = (x0 - lo + v * t) % (2 * span);
  if (u < 0) u += 2 * span;
  return lo + (u <= span ? u : 2 * span - u);
}

/**
 * The scene's islands (40 rings of 64 segments, outer radius 80, inner 32: 128 outline edges each) and lights
 * (24, intensity 22 500: influence radius 1500) at FRAME_TIMES, with the scene's seeded positions, headings,
 * spins, speeds and wall bounces, and pre-render's calls for each light: the islands that pass its reach test
 * (radius plus the half diagonal of the ring's 160 x 160 box), the island's entity as owner. One shipped solid
 * per island (entity = island index + entityBase).
 */
export function sceneFrames({ entityBase = 0 } = {}) {
  const rng = mulberry32(SCENE_SEED);
  const islands = [];
  for (let i = 0; i < ISLANDS; i++) {
    const dir = rng() * Math.PI * 2;
    const speed = 30 + rng() * 50;
    const rotation = rng() * Math.PI * 2;
    const spin = (rng() - 0.5) * 1.2;
    islands.push({
      x: 360 + (i % 8) * 220, y: 360 + ((i / 8) | 0) * 220, rotation, spin,
      vx: Math.cos(dir) * speed, vy: Math.sin(dir) * speed,
    });
  }
  const lights = [];
  for (let i = 0; i < LIGHTS; i++) {
    const dir = rng() * Math.PI * 2;
    const speed = 40 + rng() * 70;
    lights.push({ x: 300 + rng() * (WORLD - 600), y: 300 + rng() * (WORLD - 600), vx: Math.cos(dir) * speed, vy: Math.sin(dir) * speed });
  }
  const body = trianglesCompound(ringTriangles(RING_SEGMENTS, OUTER_R, INNER_R));
  const solids = islands.map((_, i) => buildSolid(entityBase + i, 1, body));
  const frames = FRAME_TIMES.map((t) => {
    const pose = islands.map((isl) => {
      const a = isl.rotation + isl.spin * t;
      return { x: bounce(isl.x, isl.vx, t, 160, WORLD - 160), y: bounce(isl.y, isl.vy, t, 160, WORLD - 160), c: Math.cos(a), s: Math.sin(a) };
    });
    return lights.map((L) => {
      const lx = bounce(L.x, L.vx, t, 200, WORLD - 200);
      const ly = bounce(L.y, L.vy, t, 200, WORLD - 200);
      const bound = LIGHT_RADIUS + RING_REACH;
      const calls = [];
      pose.forEach((p, i) => {
        const dx = p.x - lx;
        const dy = p.y - ly;
        if (dx * dx + dy * dy > bound * bound) return;
        calls.push({ island: i, solid: solids[i], wx: p.x, wy: p.y, c: p.c, s: p.s, ox: 0, oy: 0, owner: entityBase + i });
      });
      return { light: { lx, ly, radius: LIGHT_RADIUS }, calls };
    });
  });
  return { frames, solids };
}

/**
 * The scene's frames, the kernel bound to a memory, the JS's reference for every light, and the gate:
 * verify(variant) -> { checksum, pass, stats }. A passing variant (flips <= FLIP_LIMIT, none away from a
 * rastered end, owners, hit > 0 and active equal) reports the FNV hash of the JS's bins, owners and hit flags
 * (refHash); a failing one the hash of its own. 'js' is the reference itself.
 * @param {{ wasmUrl?: URL | string }} [opts]
 */
export async function sceneGate(opts = {}) {
  const { frames } = sceneFrames();
  const k = await createSolidSegmentsKernel({ solidBytes: ISLANDS * (128 * 20 + 64), wasmUrl: opts.wasmUrl });
  const reference = frames.map((frame) => frame.map(({ light, calls }) => ({
    ref: jsLightReference(light, calls, k.tables), edges: spanEdgeBins(light, calls),
  })));
  let refHash = 2166136261;
  frames.forEach((frame, f) => frame.forEach((_, l) => {
    const { ref } = reference[f][l];
    refHash = fnvHits(fnvBins(refHash, ref.dist, ref.owner), ref.hits);
  }));

  function verify(variant) {
    if (variant === 'js') return { checksum: refHash, pass: true, stats: null };
    const fn = k.fns[variant];
    if (!fn) throw new Error(`unknown variant ${variant}`);
    const stats = {};
    let own = 2166136261;
    frames.forEach((frame, f) => frame.forEach(({ light, calls }, l) => {
      const got = wasmLight(k, fn, light, calls);
      const { ref, edges } = reference[f][l];
      addStats(stats, compareLight(ref, got, edges));
      own = fnvHits(fnvBins(own, got.dist, got.owner), got.hits);
    }));
    const pass = stats.flips <= FLIP_LIMIT && stats.strayFlips === 0 && stats.ownerMismatch === 0 &&
      stats.hitFlagMismatch === 0 && stats.activeMismatch === 0;
    return { checksum: pass ? refHash : own, pass, stats };
  }

  return { k, frames, reference, refHash, verify };
}
