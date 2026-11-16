// The stamp's per-light selection (wasm/shadowStamp.c) against the JS reference (tests/reference/shadowStamp.mjs), bit for
// bit, on frames built for it: a light keeps its `lim` nearest casters (maxShadowsPerLight, or its own budget) when more
// stand in its range. The frames put many more casters in range than a light keeps (m >> lim: a crowd under lamps, as in
// lampShadowStressScene), ties at the cut (casters on exact rings, so several share the lim-th distance, and casters
// stacked on one spot), ties inside the kept casters with the cut clear of them (their order in the stamp), lim = 1,
// lim >= m and lim = m exactly, budgets on both sides of every size the kernel treats apart, cone and dim lights,
// maxShadowsPerEntity on and off, lights outside the casters' box or with an infinite range, NaN, infinite and far
// casters, coordinates past 2^24 px, and a candidate scratch shorter than the casters (the gather stops early). Each
// frame: the same cursor, every stamp row and every light index.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GPU_CASTER_FLOATS } from '../../src/render/gpuQueueLayout.js';
import { stampLightRange } from '../reference/shadowStamp.mjs';
import { stampLightRangeWasm } from '../../src/render/shadowStampClient.js';
import { LIGHTS, PER_ENTITY, rng, setup, specFor } from '../helpers/shadowStampFrames.mjs';

const SF = GPU_CASTER_FLOATS;
const W = 2400;
const H = 1400;
/** Per-light budgets: around 1, the default 15, 32, 64 and 512, and past every caster. */
const BUDGETS = [1, 2, 3, 7, 15, 16, 31, 32, 33, 63, 64, 65, 100, 300, 511, 512, 513, 5000];
/** maxShadowsPerLight per frame (0: each light's own budget, or every caster). */
const MAX_PER_LIGHT = [0, 1, 15, 32, 64, 65, 512];

/** The casters of a frame into dst.sun: x, y, then random floats so that each row is its own. */
function writeCasters(dst, xy, r) {
  const sun = dst.sun;
  const n = xy.length >> 1;
  for (let c = 0; c < n; c++) {
    const b = c * SF;
    sun[b] = xy[2 * c];
    sun[b + 1] = xy[2 * c + 1];
    for (let f = 2; f < SF; f++) sun[b + f] = r();
  }
  sun.fill(0, n * SF, (n + 1) * SF);
  return n;
}

function crowd(xy, r, n, x0 = 0, y0 = 0, w = W, h = H) {
  for (let c = 0; c < n; c++) xy.push(x0 + r() * w, y0 + r() * h);
}

/** Casters on exact rings around an integer point: the points (±a, ±b), (±b, ±a) share a² + b². */
function rings(xy, cx, cy, pairs) {
  for (const [a, b] of pairs) {
    const pts = new Set();
    for (const [u, v] of [[a, b], [b, a]]) {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) pts.add(`${cx + sx * u},${cy + sy * v}`);
    }
    for (const p of pts) {
      const [x, y] = p.split(',').map(Number);
      xy.push(x, y);
    }
  }
}

function light(x, y, range, maxShadows, r) {
  return { x, y, intensity: 0.5 + r() * 2, rangeSq: range * range, maxShadows };
}

function cone(L, r, invG = 1) {
  const a = r() * Math.PI * 2;
  const half = 0.2 + r() * 1.6;
  L.coneDirX = Math.cos(a);
  L.coneDirYW = Math.sin(a) * invG;
  L.coneCos = Math.cos(half);
  L.coneInvSpan = 1 / Math.max(Math.cos(half * (1 - r())) - L.coneCos, 0.002);
  L.invG2 = invG * invG;
  return L;
}

/** The float distances of a point light's candidates, ascending (null for a cone light or an empty slot). */
function candidateKeys(dst, nSun, L) {
  if (!L || !(L.rangeSq > 0) || !(L.intensity > 0) || L.coneCos > -1) return null;
  const sun = dst.sun;
  const keys = [];
  for (let c = 0; c < nSun; c++) {
    const dx = sun[c * SF] - L.x;
    const dy = sun[c * SF + 1] - L.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > L.rangeSq || Number.isNaN(d2)) continue;
    keys.push(Math.fround(d2));
  }
  return keys.sort((a, b) => a - b);
}

function limitOf(L, maxPL, nSun) {
  if (L.maxShadows > 0) return maxPL > 0 ? Math.min(maxPL, L.maxShadows | 0) : (L.maxShadows | 0);
  return maxPL > 0 ? maxPL : nSun;
}

/** The first run of equal distances at or after `from`: [start, end), or null. */
function tieRun(keys, from = 0) {
  for (let k = from; k + 1 < keys.length; k++) {
    if (keys[k] !== keys[k + 1]) continue;
    let e = k + 1;
    while (e < keys.length && keys[e] === keys[k]) e++;
    return [k, e];
  }
  return null;
}

/** The longest run of equal distances: [start, end), or null. */
function longestRun(keys) {
  let best = null;
  for (let k = 0; k < keys.length;) {
    let e = k + 1;
    while (e < keys.length && keys[e] === keys[k]) e++;
    if (e - k > 1 && (!best || e - k > best[1] - best[0])) best = [k, e];
    k = e;
  }
  return best;
}

/**
 * A frame of kind `kind`: { nSun, lights, maxPerLight, maxPerEntity, ... } with its casters in dst.sun.
 * 0 crowd under lamps · 1 rings cut inside a tie · 2 a stack of casters on one spot · 3 ties among the kept, the cut
 * clear · 4 few casters (lim >= m, lim = m, lim = m - 1) · 5 cone and dim lights over a crowd · 6 lights outside the
 * casters' box, infinite and huge ranges · 7 NaN, infinite or far casters · 8 coordinates past 2^24 px · 9 lim = 1 at a
 * tie.
 */
function selectFrame(r, k, dst) {
  const kind = k % 10;
  const xy = [];
  const lights = [];
  let maxPerLight = MAX_PER_LIGHT[(k >> 1) % MAX_PER_LIGHT.length];
  const maxPerEntity = [0, 1, PER_ENTITY][Math.floor(k / 10) % 3];
  const budget = () => BUDGETS[Math.floor(r() * BUDGETS.length)];
  if (kind === 0) {
    crowd(xy, r, 2600 + Math.floor(r() * 300));
    const n = 8 + Math.floor(r() * (LIGHTS - 8));
    for (let i = 0; i < n; i++) lights.push(light(r() * W, r() * H, 150 + r() * 260, r() < 0.3 ? 0 : budget(), r));
  } else if (kind === 1 || kind === 9) {
    const cx = 900 + Math.floor(r() * 600);
    const cy = 500 + Math.floor(r() * 400);
    rings(xy, cx, cy, [[3, 4], [0, 5], [6, 8], [1, 7], [5, 5], [9, 12], [8, 15], [12, 16], [7, 24], [20, 21], [15, 20]]);
    crowd(xy, r, 900, cx - 300, cy - 300, 600, 600);
    maxPerLight = 0;
    lights.push(light(cx, cy, 120, 0, r));
    lights.push(light(cx, cy, 200, 0, r));
    lights.push(light(cx + 0.5, cy - 0.25, 160, budget(), r));
  } else if (kind === 2) {
    const sx = 1000 + r() * 400;
    const sy = 600 + r() * 200;
    crowd(xy, r, 1500, sx - 400, sy - 400, 800, 800);
    for (let q = 0; q < 40; q++) xy.push(Math.fround(sx + 37.25), Math.fround(sy - 12.5));
    maxPerLight = 0;
    for (let i = 0; i < 6; i++) lights.push(light(sx + (r() - 0.5) * 120, sy + (r() - 0.5) * 120, 250, 0, r));
  } else if (kind === 3) {
    const cx = 800 + Math.floor(r() * 800);
    const cy = 400 + Math.floor(r() * 600);
    rings(xy, cx, cy, [[2, 3], [4, 7]]);
    crowd(xy, r, 1200, cx - 350, cy - 350, 700, 700);
    maxPerLight = 0;
    lights.push(light(cx, cy, 300, 0, r));
    lights.push(light(cx, cy, 300, 0, r));
  } else if (kind === 4) {
    crowd(xy, r, 20 + Math.floor(r() * 60));
    maxPerLight = 0;
    const n = 4 + Math.floor(r() * 10);
    for (let i = 0; i < n; i++) lights.push(light(r() * W, r() * H, 400 + r() * 900, r() < 0.5 ? budget() : 64, r));
  } else if (kind === 5) {
    crowd(xy, r, 2500);
    const invG = [1, 0.7, 0.5][k % 3];
    const n = 8 + Math.floor(r() * (LIGHTS - 8));
    for (let i = 0; i < n; i++) {
      const L = light(r() * W, r() * H, 180 + r() * 220, r() < 0.3 ? 0 : budget(), r);
      if (r() < 0.6) cone(L, r, 1 / invG);
      if (r() < 0.4) {
        L.shade = r();
        if (!(L.invG2 > 0)) L.invG2 = 1 / (invG * invG);
      }
      lights.push(L);
    }
  } else if (kind === 6) {
    crowd(xy, r, 2000, 200, 200, 1800, 1000);
    lights.push(light(-150, 700, 400, budget(), r));
    lights.push(light(2300, 1300, 500, budget(), r));
    lights.push(light(1000, -380, 400, budget(), r));
    lights.push(light(-90, -90, 450, budget(), r));
    lights.push({ x: 1100, y: 600, intensity: 1, rangeSq: Infinity, maxShadows: budget() });
    lights.push({ x: 1100.5, y: 600.5, intensity: 1, rangeSq: 1e30, maxShadows: budget() });
    for (let i = 0; i < 6; i++) lights.push(light(200 + r() * 1800, 200 + r() * 1000, 200 + r() * 200, budget(), r));
  } else if (kind === 7) {
    crowd(xy, r, 2200);
    const sub = Math.floor(k / 10) % 3;
    if (sub === 0) xy.push(NaN, 700, 900, NaN, NaN, NaN);
    else if (sub === 1) xy.push(Infinity, 600, 1200, -Infinity);
    else xy.push(3.5e7, 800);
    lights.push(light(100, 100, 300, budget(), r));
    const n = 6 + Math.floor(r() * 10);
    for (let i = 0; i < n; i++) lights.push(light(r() * W, r() * H, 200 + r() * 200, budget(), r));
  } else if (kind === 8) {
    // Casters and lights around 2e7 px: float32 steps of 2 px, past the 2^24 px a cell's bounds are trusted to.
    const x0 = 2e7;
    for (let c = 0; c < 2000; c++) xy.push(Math.fround(x0 + r() * 3000), Math.fround(x0 + r() * 2000));
    const n = 6 + Math.floor(r() * 8);
    for (let i = 0; i < n; i++) lights.push(light(x0 + r() * 3000, x0 + r() * 2000, 200 + r() * 200, budget(), r));
  }
  const nSun = writeCasters(dst, xy, r);
  const keysOf = (L) => candidateKeys(dst, nSun, L);
  if (kind === 1) {
    // Budgets that cut inside a run of equal distances.
    for (const L of lights.slice(0, 2)) {
      const run = tieRun(keysOf(L), Math.floor(r() * 12));
      L.maxShadows = run ? run[0] + 1 + Math.floor(r() * (run[1] - run[0] - 1)) : 1 + Math.floor(r() * 20);
    }
  } else if (kind === 9) {
    // lim = 1 where the nearest distance is shared: the light sits at the centre of the (3, 4) and (0, 5) rings.
    lights[0].maxShadows = 1;
    lights[1].maxShadows = 1;
  } else if (kind === 2) {
    // The stack is the longest run: cut inside it, right after it, right before it.
    lights.forEach((L, i) => {
      const run = longestRun(keysOf(L));
      if (!run) return;
      const [a, e] = run;
      L.maxShadows = [a + 1 + Math.floor(r() * (e - a - 1)), e, Math.max(1, a)][i % 3];
    });
  } else if (kind === 3) {
    // The cut clear of ties: a budget past both pairs where the next distance differs; the other light cuts the first.
    const keys = keysOf(lights[0]);
    let lim = 20 + Math.floor(r() * 10);
    while (lim < keys.length && keys[lim - 1] === keys[lim]) lim++;
    lights[0].maxShadows = lim;
    lights[1].maxShadows = 6;
  } else if (kind === 4) {
    // lim = m, lim = m - 1 (one too many), lim = m + 1.
    lights.slice(0, 3).forEach((L, i) => {
      const m = keysOf(L).length;
      if (m > 1) L.maxShadows = m + [0, -1, 1][i];
    });
  }
  return {
    nSun,
    lights,
    maxPerLight,
    maxPerEntity,
    lightBegin: k % 13 === 12 ? 1 : 0,
    lightStride: k % 11 === 10 ? 2 : 1,
    stampCap: k % 17 === 16 ? Math.floor(r() * 300) : Infinity,
    stampBase: k % 19 === 18 ? 5 : 0,
    // A candidate scratch of 400: the gather stops at 400 candidates (the kernel's tmpCap).
    shortTmp: kind === 0 && k % 20 === 10,
  };
}

/** JS then kernel on one frame; the outputs compared byte for byte. */
function compare(s, f, label) {
  const { dst, b, scratch, caps } = s;
  const spec = specFor(f, dst, scratch);
  spec.stampCap = Number.isFinite(f.stampCap) ? f.stampCap : caps.maxStamp;
  if (f.shortTmp) spec.tmpIdx = new Uint32Array(400);
  const stampBytes = new Uint8Array(dst.stamp.buffer, dst.stamp.byteOffset, dst.stamp.byteLength);
  const idxBytes = new Uint8Array(dst.stampLightIdx.buffer, dst.stampLightIdx.byteOffset, dst.stampLightIdx.byteLength);
  stampBytes.fill(0xa5);
  idxBytes.fill(0xa5);
  const jsCursor = stampLightRange(spec);
  const jsStamp = stampBytes.slice();
  const jsIdx = idxBytes.slice();
  stampBytes.fill(0xa5);
  idxBytes.fill(0xa5);
  const cursor = stampLightRangeWasm(b, spec);
  assert.equal(cursor, jsCursor, `${label}: cursor`);
  const at = firstDifference(stampBytes, jsStamp);
  assert.equal(at, -1, `${label}: stamp rows differ at byte ${at} (row ${Math.floor(at / (SF * 4))})`);
  const ai = firstDifference(idxBytes, jsIdx);
  assert.equal(ai, -1, `${label}: light indices differ at byte ${ai}`);
  return cursor;
}

/** The first byte where two byte views differ, or -1 (a native compare first: the stamp region is megabytes). */
function firstDifference(a, b) {
  const ba = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  const bb = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (ba.equals(bb)) return -1;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : Math.min(a.length, b.length);
}

/** What a frame exercises: per point light, its candidates against its budget. */
function tally(t, dst, f) {
  for (const L of f.lights) {
    const keys = candidateKeys(dst, f.nSun, L);
    if (!keys) continue;
    const lim = limitOf(L, f.maxPerLight, f.nSun);
    const m = keys.length;
    if (!(lim > 0) || m === 0) continue;
    if (m <= lim) {
      t.keepAll++;
      if (m === lim) t.limIsM++;
      continue;
    }
    t.select++;
    if (m === lim + 1) t.oneOver++;
    if (m >= 20 * lim) t.manyPerKept++;
    if (lim === 1) t.limOne++;
    if (keys[lim - 1] === keys[lim]) t.cutTie++;
    else if (tieRun(keys.slice(0, lim))) t.keptTie++;
  }
}

test('the kernel keeps the JS reference\'s casters, in its order, on frames built for the selection', async (t) => {
  const s = await setup({ allPairs: true });
  const r = rng(0x5e1ec7);
  const seen = { select: 0, manyPerKept: 0, cutTie: 0, keptTie: 0, limOne: 0, oneOver: 0, keepAll: 0, limIsM: 0 };
  let rows = 0;
  for (let k = 0; k < 150; k++) {
    const f = selectFrame(r, k, s.dst);
    tally(seen, s.dst, f);
    rows += compare(s, f, `frame ${k} (kind ${k % 10}, ${f.nSun} casters, ${f.lights.length} lights, maxPL ${f.maxPerLight}, maxPE ${f.maxPerEntity})`);
  }
  t.diagnostic(`${rows} rows; point lights: ${JSON.stringify(seen)}`);
  assert.ok(seen.manyPerKept > 100, `lights with 20 times more candidates than they keep (${seen.manyPerKept})`);
  assert.ok(seen.cutTie > 20, `ties at the cut (${seen.cutTie})`);
  assert.ok(seen.keptTie > 10, `ties among the kept, the cut clear (${seen.keptTie})`);
  assert.ok(seen.limOne > 10, `lim 1 (${seen.limOne})`);
  assert.ok(seen.oneOver > 0, `m = lim + 1 (${seen.oneOver})`);
  assert.ok(seen.keepAll > 50 && seen.limIsM > 0, `lights that keep every candidate (${seen.keepAll}, ${seen.limIsM} with lim = m)`);
  assert.ok(rows > 30000, `the frames stamp something (${rows} rows)`);
});
