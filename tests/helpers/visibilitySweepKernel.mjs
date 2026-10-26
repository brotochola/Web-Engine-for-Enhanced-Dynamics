// The per-light visibility sweep kernel (E-76 W2a, wasm/test/visibilitySweep.c) as its test and its bench use
// it: the memory layout and table (createSweepKernel), pre-render's occluder arrays (emptyScene) and
// visPolyStressScene's frame of them (visPolyFrame), the shipped sweep on them (sweepJs), and the tolerance
// gate (comparePolygons). Browser-safe: tests/bench/visibilitySweepWasmMicrobench.mjs runs it in Chrome.
//
// Users: tests/node/visibilitySweepWasm.test.js, tests/bench/visibilitySweepWasmMicrobench.mjs.
import {
  OCC_CIRCLE,
  OCC_POLY,
  POLAR_BINS,
  writeOrientedBoxVerts,
} from '../../src/render/visibility/angularSweep.js';
import { lightInfluenceRadius } from '../../src/util/lightRadius.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { layoutRegions, NULL_GUARD_BYTES } from '../../src/util/wasmMemoryMap.js';
import { mulberry32 } from '../bench/benchMath.js';
import { buildVisibilityPolygon } from '../reference/visibilitySweepJs.mjs';

export const KERNEL_URL = new URL('../fixtures/wasm/visibilitySweepVariants.wasm', import.meta.url);

/** visibilitySweep.c's table, slot for slot. */
export const SWEEP_SLOTS = [
  'kind', 'cx', 'cy', 'cr', 'vertStart', 'vertCount', 'vertsX', 'vertsY',
  'outX', 'outY', 'maxVerts',
  'evKey', 'evC', 'evS', 'evOcc', 'evType', 'sort', 'maxEvents',
  'occOpen', 'occClose', 'occValid', 'seen', 'occCache',
  'active', 'maxActive',
  'consts', 'fullC', 'fullS', 'fullSegs',
  'polarDist', 'polarOwner', 'polarCos', 'polarSin', 'polarPseudo', 'polarBins',
  'rayAng', 'rayCos', 'raySin', 'rayBest',
  'ownerSeen', 'ownerSeenCap', 'ownerStamp',
  'edgeFx', 'edgeFy', 'edgeEx', 'edgeEy', 'edgeTn',
  'edge32Fx', 'edge32Fy', 'edge32Ex', 'edge32Ey', 'edge32Tn',
  'circDx', 'circDy', 'circDd', 'circR2',
  'occF32',
  'results',
];
/** visibilitySweep.c's result words. */
export const SWEEP_RESULTS = [
  'sweepCount', 'count', 'stamp', 'seenValid', 'eventOverflow', 'activeOverflow',
  'mergeCount', 'mergeGroup', 'mergeEdges', 'ownersMarked', 'events',
];
export const R = Object.fromEntries(SWEEP_RESULTS.map((name, i) => [name, i]));
/** Variant name -> export. */
export const SWEEP_VARIANTS = {
  f64: 'sweep_light_f64',
  pseudo: 'sweep_light_pseudo',
  pre: 'sweep_light_pre',
  simd: 'sweep_light_simd',
  f32: 'sweep_light_f32',
};
/** angularSweep.js' MAX_EVENTS, MAX_OCC_CACHE and MAX_ACTIVE. */
export const JS_CAPS = Object.freeze({ maxEvents: 2048, occCache: 1024, maxActive: 256 });

// The constants angularSweep.js computes at load, with its own expressions: the kernel reads them from the
// memory, so a wrapper passes the module's (they are not exported). The test checks that they reproduce the
// shipped outputs bit for bit (the empty light's 32-gon, the polar merge).
const EPSILON = 1e-5;
const TWO_PI = Math.PI * 2;
const END_ANGLE = Math.PI - EPSILON;
const MAX_ARC_STEP = Math.PI / 16;
const MAX_FREE_GAP = Math.PI / 2;
const FULL_CIRCLE_SEGS = Math.ceil(TWO_PI / MAX_ARC_STEP);

function pseudoAngle(x, y) {
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const p = ay / (ax + ay);
  if (y < 0) return x < 0 ? p - 2 : -p;
  return x < 0 ? 2 - p : p;
}

/**
 * The memory, the tables and the kernel. `sets` are input slots (one table each): the occluder arrays a
 * light's gather fills, sized for `occluders` and `poolVerts`. Scratch, outputs and results are shared.
 * @param {{ sets?: Array<{ occluders: number, poolVerts: number }>, maxVerts?: number, maxEvents?: number,
 *   occCache?: number, maxActive?: number, ownerSeenCap?: number, url?: URL | string }} [opts]
 */
export async function createSweepKernel({
  sets = [{ occluders: 1024, poolVerts: 8192 }],
  maxVerts = 5000,
  maxEvents = JS_CAPS.maxEvents,
  occCache = JS_CAPS.occCache,
  maxActive = JS_CAPS.maxActive,
  ownerSeenCap = 0,
  url = KERNEL_URL,
} = {}) {
  const outVerts = Math.max(maxVerts, POLAR_BINS);
  const maxOcc = Math.max(1, ...sets.map((s) => s.occluders));
  const maxPool = Math.max(4, ...sets.map((s) => s.poolVerts));
  const list = [{ name: 'guard', owner: 'nobody (address 0)', bytes: NULL_GUARD_BYTES }];
  const add = (name, bytes) => list.push({ name, owner: 'pre-render', bytes: Math.max(4, bytes) });
  sets.forEach((s, k) => {
    add(`kind${k}`, s.occluders);
    add(`cx${k}`, s.occluders * 4);
    add(`cy${k}`, s.occluders * 4);
    add(`cr${k}`, s.occluders * 4);
    add(`vertStart${k}`, s.occluders * 4);
    add(`vertCount${k}`, s.occluders);
    add(`vertsX${k}`, s.poolVerts * 4);
    add(`vertsY${k}`, s.poolVerts * 4);
    add(`table${k}`, SWEEP_SLOTS.length * 4);
  });
  add('outX', outVerts * 4);
  add('outY', outVerts * 4);
  add('evKey', maxEvents * 8);
  add('evC', maxEvents * 8);
  add('evS', maxEvents * 8);
  add('evOcc', maxEvents * 4);
  add('evType', maxEvents);
  add('sort', maxEvents * 4);
  add('occOpen', occCache * 8);
  add('occClose', occCache * 8);
  add('occValid', occCache);
  add('seen', occCache * 4);
  add('active', maxActive * 4);
  add('consts', 3 * 8);
  add('fullC', FULL_CIRCLE_SEGS * 8);
  add('fullS', FULL_CIRCLE_SEGS * 8);
  add('polarDist', POLAR_BINS * 4);
  add('polarOwner', POLAR_BINS * 4);
  add('polarCos', (POLAR_BINS * 2 + 1) * 8);
  add('polarSin', (POLAR_BINS * 2 + 1) * 8);
  add('polarPseudo', (POLAR_BINS * 2 + 1) * 8);
  add('rayAng', POLAR_BINS * 8);
  add('rayCos', POLAR_BINS * 8);
  add('raySin', POLAR_BINS * 8);
  add('rayBest', POLAR_BINS * 8);
  add('ownerSeen', ownerSeenCap * 4);
  for (const name of ['edgeFx', 'edgeFy', 'edgeEx', 'edgeEy', 'edgeTn']) add(name, maxPool * 8);
  for (const name of ['edge32Fx', 'edge32Fy', 'edge32Ex', 'edge32Ey', 'edge32Tn']) add(name, maxPool * 4);
  for (const name of ['circDx', 'circDy', 'circDd', 'circR2']) add(name, maxOcc * 8);
  add('occF32', maxOcc);
  add('results', SWEEP_RESULTS.length * 4);

  const layout = layoutRegions(list);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const G = layout.regions;
  const view = (Ctor, name, n) => new Ctor(buffer, G[name].byte, n);

  const consts = view(Float64Array, 'consts', 3);
  consts[0] = 1 / Math.cos(MAX_FREE_GAP * 0.5);
  consts[1] = Math.cos(END_ANGLE);
  consts[2] = Math.sin(END_ANGLE);
  const fullC = view(Float64Array, 'fullC', FULL_CIRCLE_SEGS);
  const fullS = view(Float64Array, 'fullS', FULL_CIRCLE_SEGS);
  for (let i = 0; i < FULL_CIRCLE_SEGS; i++) {
    const a = -Math.PI + i * (TWO_PI / FULL_CIRCLE_SEGS);
    fullC[i] = Math.cos(a);
    fullS[i] = Math.sin(a);
  }
  const polarCos = view(Float64Array, 'polarCos', POLAR_BINS * 2 + 1);
  const polarSin = view(Float64Array, 'polarSin', POLAR_BINS * 2 + 1);
  const polarPseudo = view(Float64Array, 'polarPseudo', POLAR_BINS * 2 + 1);
  for (let m = 0; m <= POLAR_BINS * 2; m++) {
    const ang = -Math.PI + m * 0.5 * (TWO_PI / POLAR_BINS);
    polarCos[m] = Math.cos(ang);
    polarSin[m] = Math.sin(ang);
    polarPseudo[m] = pseudoAngle(polarCos[m], polarSin[m]);
  }

  const shared = {
    outX: G.outX.byte, outY: G.outY.byte, maxVerts,
    evKey: G.evKey.byte, evC: G.evC.byte, evS: G.evS.byte, evOcc: G.evOcc.byte, evType: G.evType.byte,
    sort: G.sort.byte, maxEvents,
    occOpen: G.occOpen.byte, occClose: G.occClose.byte, occValid: G.occValid.byte, seen: G.seen.byte, occCache,
    active: G.active.byte, maxActive,
    consts: G.consts.byte, fullC: G.fullC.byte, fullS: G.fullS.byte, fullSegs: FULL_CIRCLE_SEGS,
    polarDist: G.polarDist.byte, polarOwner: G.polarOwner.byte, polarCos: G.polarCos.byte,
    polarSin: G.polarSin.byte, polarPseudo: G.polarPseudo.byte, polarBins: POLAR_BINS,
    rayAng: G.rayAng.byte, rayCos: G.rayCos.byte, raySin: G.raySin.byte, rayBest: G.rayBest.byte,
    ownerSeen: ownerSeenCap > 0 ? G.ownerSeen.byte : 0, ownerSeenCap, ownerStamp: 0,
    edgeFx: G.edgeFx.byte, edgeFy: G.edgeFy.byte, edgeEx: G.edgeEx.byte, edgeEy: G.edgeEy.byte, edgeTn: G.edgeTn.byte,
    edge32Fx: G.edge32Fx.byte, edge32Fy: G.edge32Fy.byte, edge32Ex: G.edge32Ex.byte, edge32Ey: G.edge32Ey.byte,
    edge32Tn: G.edge32Tn.byte,
    circDx: G.circDx.byte, circDy: G.circDy.byte, circDd: G.circDd.byte, circR2: G.circR2.byte,
    occF32: G.occF32.byte,
    results: G.results.byte,
  };
  const inputSets = sets.map((s, k) => {
    const words = { ...shared };
    for (const name of ['kind', 'cx', 'cy', 'cr', 'vertStart', 'vertCount', 'vertsX', 'vertsY']) words[name] = G[`${name}${k}`].byte;
    const table = view(Uint32Array, `table${k}`, SWEEP_SLOTS.length);
    SWEEP_SLOTS.forEach((slot, i) => {
      if (!(slot in words)) throw new Error(`visibilitySweep table: no value for ${slot}`);
      table[i] = words[slot];
    });
    return {
      tableByte: G[`table${k}`].byte,
      table,
      occluders: s.occluders,
      poolVerts: s.poolVerts,
      kind: view(Uint8Array, `kind${k}`, s.occluders),
      cx: view(Float32Array, `cx${k}`, s.occluders),
      cy: view(Float32Array, `cy${k}`, s.occluders),
      cr: view(Float32Array, `cr${k}`, s.occluders),
      vertStart: view(Int32Array, `vertStart${k}`, s.occluders),
      vertCount: view(Uint8Array, `vertCount${k}`, s.occluders),
      vertsX: view(Float32Array, `vertsX${k}`, s.poolVerts),
      vertsY: view(Float32Array, `vertsY${k}`, s.poolVerts),
    };
  });

  const fns = await loadWasmKernel('visibilitySweepVariants', url, memory, Object.values(SWEEP_VARIANTS));
  const variants = Object.fromEntries(Object.entries(SWEEP_VARIANTS).map(([v, name]) => [v, fns[name]]));
  const results = view(Uint32Array, 'results', SWEEP_RESULTS.length);
  const resultsI32 = view(Int32Array, 'results', SWEEP_RESULTS.length);
  const seen = view(Uint32Array, 'seen', occCache);
  const ownerSlot = SWEEP_SLOTS.indexOf('ownerStamp');

  return {
    memory,
    buffer,
    regions: G,
    sets: inputSets,
    variants,
    consts,
    outX: view(Float32Array, 'outX', outVerts),
    outY: view(Float32Array, 'outY', outVerts),
    polarDist: view(Float32Array, 'polarDist', POLAR_BINS),
    polarOwner: view(Int32Array, 'polarOwner', POLAR_BINS),
    ownerSeen: view(Uint32Array, 'ownerSeen', ownerSeenCap),
    seen,
    results,
    resultsI32,
    occCache,
    /** Copy a scene's occluders (see visPolyFrame) into input set k. */
    load(k, scene) {
      const s = inputSets[k];
      const n = scene.occCount;
      if (n > s.occluders || scene.poolVerts > s.poolVerts) throw new Error(`input set ${k} is too small for the scene`);
      s.kind.set(scene.kind.subarray(0, n));
      s.cx.set(scene.cx.subarray(0, n));
      s.cy.set(scene.cy.subarray(0, n));
      s.cr.set(scene.cr.subarray(0, n));
      s.vertStart.set(scene.vertStart.subarray(0, n));
      s.vertCount.set(scene.vertCount.subarray(0, n));
      s.vertsX.set(scene.vertsX.subarray(0, scene.poolVerts));
      s.vertsY.set(scene.vertsY.subarray(0, scene.poolVerts));
    },
    /** The stamp markSeenPolarOwners writes (the caller's, every set). */
    setOwnerStamp(stamp) {
      for (const s of inputSets) s.table[ownerSlot] = stamp >>> 0;
    },
    /** sweepSawOccluder(oi) for the kernel's last call. */
    sawOccluder(oi) {
      if (!results[R.seenValid] || oi >= occCache) return true;
      return seen[oi] === results[R.stamp];
    },
  };
}

/** Occluder arrays for `n` occluders and `pool` vertices, as pre-render's scratch holds them. */
export function emptyScene(n, pool) {
  return {
    lx: 0,
    ly: 0,
    radius: 0,
    occCount: 0,
    poolVerts: 0,
    kind: new Uint8Array(Math.max(1, n)),
    cx: new Float32Array(Math.max(1, n)),
    cy: new Float32Array(Math.max(1, n)),
    cr: new Float32Array(Math.max(1, n)),
    vertStart: new Int32Array(Math.max(1, n)),
    vertCount: new Uint8Array(Math.max(1, n)),
    vertsX: new Float32Array(Math.max(4, pool)),
    vertsY: new Float32Array(Math.max(4, pool)),
  };
}

/**
 * visPolyStressScene's lights and the boxes pre-render packs for each (see the header). `shape: 'circle'` is
 * the scene's ?occluderShape=circle (radius width / 2).
 */
export function visPolyFrame({ seed = 0x51f01, lights = 360, occluders = 700, shape = 'box', worldWidth = 4000, worldHeight = 3000 } = {}) {
  const rng = mulberry32(seed);
  const w = worldWidth;
  const h = worldHeight;
  const lightPos = [];
  for (let i = 0; i < lights; i++) {
    const x = Math.fround(400 + rng() * (w - 800));
    const y = Math.fround(400 + rng() * (h - 800));
    lightPos.push([x, y]);
  }
  const occ = [];
  for (let i = 0; i < occluders; i++) {
    const x = Math.fround(80 + rng() * (w - 160));
    const y = Math.fround(80 + rng() * (h - 160));
    const width = Math.fround(32 + rng() * 48);
    const height = Math.fround(32 + rng() * 48);
    occ.push({ x, y, width, height, radius: Math.fround(width * 0.5) });
  }
  // LightEmitter: intensity 400, sqrtLightIntensity stored as float32.
  const radius = lightInfluenceRadius(Math.fround(Math.sqrt(400)));
  const out = [];
  for (const [lx, ly] of lightPos) {
    const keep = [];
    for (const o of occ) {
      const dx = o.x - lx;
      const dy = o.y - ly;
      let reach;
      if (shape === 'circle') reach = o.radius;
      else {
        const hw = o.width * 0.5;
        const hh = o.height * 0.5;
        reach = Math.sqrt(hw * hw + hh * hh);
      }
      const maxReach = radius + reach;
      if (dx * dx + dy * dy > maxReach * maxReach) continue;
      keep.push(o);
    }
    const scene = emptyScene(keep.length, keep.length * 4);
    scene.lx = lx;
    scene.ly = ly;
    scene.radius = radius;
    let pool = 0;
    keep.forEach((o, k) => {
      if (shape === 'circle') {
        scene.kind[k] = OCC_CIRCLE;
        scene.cx[k] = o.x;
        scene.cy[k] = o.y;
        scene.cr[k] = o.radius;
      } else {
        scene.kind[k] = OCC_POLY;
        scene.vertStart[k] = pool;
        writeOrientedBoxVerts(scene.vertsX, scene.vertsY, pool, o.x, o.y, o.width, o.height, 1, 0, 0, 0);
        scene.vertCount[k] = 4;
        pool += 4;
      }
    });
    scene.occCount = keep.length;
    scene.poolVerts = pool;
    out.push(scene);
  }
  return out;
}

/** The shipped sweep of a scene into (outX, outY). */
export function sweepJs(scene, outX, outY, maxVerts) {
  return buildVisibilityPolygon(
    scene.lx, scene.ly, scene.radius,
    scene.kind, scene.cx, scene.cy, scene.cr, scene.vertStart, scene.vertCount, scene.vertsX, scene.vertsY,
    scene.occCount, outX, outY, maxVerts,
  );
}

/**
 * H-06's gate: 1e-4 world units. The double variants are held to it plus one float32 ulp of the coordinate
 * (the store's rounding: a last-bit difference in double can round to the neighbouring float, 2.4e-4 at
 * 4000). The float32 variant to 1e-4 of the vertex's distance from the light (the ray length the sweep
 * computes; 1e-4 world units within one unit of the light), plus the same ulp.
 */
export const SWEEP_TOLERANCE = 1e-4;
/** Variants held to the relative gate. */
export const RELATIVE_GATE = new Set(['f32']);
/** A flip (see comparePolygons) may change the polygon's area by at most this, relative. */
export const FLIP_AREA_TOLERANCE = 1e-4;
/** At most this share of the polygons may be flips. */
export const MAX_FLIP_SHARE = 0.01;

/** One float32 ulp at |v| (the spacing of floats there). */
export function ulp32(v) {
  const a = Math.abs(Math.fround(v));
  if (!(a >= 1.1754943508222875e-38)) return 1.401298464324817e-45;
  return 2 ** (Math.floor(Math.log2(a)) - 23);
}

export function signedArea(xs, ys, n) {
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 < n ? i + 1 : 0;
    a += xs[i] * ys[j] - xs[j] * ys[i];
  }
  return a * 0.5;
}

/**
 * Compare a polygon with the shipped one (ref), lit by (lx, ly). With equal counts, vertex for vertex: `err` is
 * the worst vertex move over its allowance (see SWEEP_TOLERANCE; `relative` for the float32 gate), `ok` that
 * every vertex is within it. Otherwise the polygon is a flip: an event tie (two angles equal to rounding, an
 * occluder's tangent on the start ray at -pi) or a sample on a threshold (the 0.5-unit dedupe, the free-sky
 * radius) went the other way, which reorders, adds or drops vertices. A flip is described by the count
 * difference, the first index that moved past its allowance and the relative area change.
 */
export function comparePolygons(rx, ry, rn, wx, wy, wn, { lx = 0, ly = 0, relative = false, tol = SWEEP_TOLERANCE } = {}) {
  let err = 0;
  let maxAbs = 0;
  let maxRayRel = 0;
  let first = -1;
  const m = rn < wn ? rn : wn;
  for (let i = 0; i < m; i++) {
    const dx = wx[i] - rx[i];
    const dy = wy[i] - ry[i];
    const move = Math.sqrt(dx * dx + dy * dy);
    const ox = rx[i] - lx;
    const oy = ry[i] - ly;
    const ray = Math.max(1, Math.sqrt(ox * ox + oy * oy));
    const ulp = Math.max(ulp32(rx[i]), ulp32(ry[i]));
    const allowance = (relative ? tol * ray : tol) + ulp;
    const e = move / allowance;
    if (e > err) err = e;
    if (move > maxAbs) maxAbs = move;
    if (move / ray > maxRayRel) maxRayRel = move / ray;
    if (e > 1 && first < 0) first = i;
  }
  const ok = rn === wn && first < 0;
  if (ok) return { ok, err, maxAbs, maxRayRel, countDelta: 0, first: -1, areaRel: 0 };
  const ra = signedArea(rx, ry, rn);
  const wa = signedArea(wx, wy, wn);
  return {
    ok,
    err,
    maxAbs,
    maxRayRel,
    countDelta: wn - rn,
    first: first < 0 ? m : first,
    areaRel: Math.abs(wa - ra) / Math.max(1, Math.abs(ra)),
  };
}

/** FNV-1a over a polygon quantised to 1/16 world unit. */
export function hashPolygon(h, xs, ys, n) {
  h = Math.imul(h ^ n, 16777619) >>> 0;
  for (let i = 0; i < n; i++) {
    h = Math.imul(h ^ (Math.round(xs[i] * 16) | 0), 16777619) >>> 0;
    h = Math.imul(h ^ (Math.round(ys[i] * 16) | 0), 16777619) >>> 0;
  }
  return h;
}

