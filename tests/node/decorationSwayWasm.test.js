// E-76 W22: the sway kernel (tests/fixtures/wasm/decorationSway.wasm, from wasm/test/decorationSway.c) against
// the shipped ParticleWorker.updateDecorationSway (its bucket path, _updateDecorationSwayBuckets) on a real
// particle worker, every array the sway reads in one shared memory as decorationSwayWasmMicrobench lays it
// out, the kernel run through that bench's wrapper (swayDecorationsWasm: the per-bucket Math.sin / Math.cos
// in JS, the kernel, then Math.sin / Math.cos for the decorations it lists). Both sides start each frame from
// the same bytes. The frames start from Predator's grass, then turn random to reach every branch of the JS
// loop: inactive, parented, off-screen and non-swaying decorations; loop, skew, impulse and unknown modes;
// bucket-cache hits and misses, NaN frequencies, frequencies past both ends of the grid, on a rounding tie
// (Math.round takes a tie up) and on the cache's -1 sentinel after the grid shrank (a bucket past the new
// grid: NaN in the JS); grids of 2, 3, 5, 7 and 100 buckets and one past 65 535 (the Uint16Array cache
// wraps); impulses that end (past π, or at a phase of -1), that take Math.sin, and whose phase is ±0, NaN
// or -Infinity; sway angles of ±0, under 0.08 rad, past it (Math.cos / Math.sin), NaN and infinite; NaN,
// infinite and -0 base rotations; a zero, negative, NaN and huge deltaTime; empty, partial and full
// snapshots in any order; chunks of 1, 37 and 1024 decorations; the 32-bit parent column. After every frame
// each DecorationComponent column, the snapshot, the phase and bucket tables and the cache must hold what
// the JS wrote, bit for bit, except that a NaN only has to be a NaN (V8 and WebAssembly may give it
// different payloads).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import {
  bucketFromSwayFrequency,
  SWAY_IMPULSE,
  SWAY_LOOP,
  SWAY_LOOP_SKEW,
  SWAY_OFF,
  swayFrequencyForBucket,
} from '../../src/util/decorationSway.js';
import {
  setupSwayKernel,
  SWAY_SLOTS,
  swayDecorationsWasm,
  TRIG_IMPULSE,
  writeSwayTable,
} from '../bench/decorationSwayWasmMicrobench.mjs';

const N = 1500;
const K_MAX = 70000;
const DT = 1000 / 60;
const LIST_CAP_SLOT = SWAY_SLOTS.indexOf('listCap');
const LIST_CAPS = [1, 37, 1024];

/** Runs of frames: the bucket grid of each, Predator's untouched grass first, the 32-bit parents last. */
const PHASES = [
  { name: 'predator', frames: 6, k: 100, predator: true },
  { name: 'k7', frames: 30, k: 7 },
  { name: 'k3', frames: 12, k: 3 },
  { name: 'k5', frames: 12, k: 5 },
  { name: 'k2', frames: 10, k: 2 },
  { name: 'k100', frames: 16, k: 100 },
  { name: 'k70000', frames: 10, k: 70000 },
  { name: 'k7 after k70000', frames: 12, k: 7 },
  { name: 'wide parents', frames: 16, k: 100, wide: true },
];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function amplitude(r) {
  const u = r();
  if (u < 0.5) return 0.02 + r() * 0.055; // under 0.08 rad
  if (u < 0.58) return 0.079 + r() * 0.002; // either side of 0.08
  if (u < 0.75) return (r() < 0.5 ? -1 : 1) * (0.1 + r() * 1.4); // past it: Math.cos / Math.sin
  if (u < 0.8) return 0;
  if (u < 0.83) return -0;
  if (u < 0.86) return NaN;
  if (u < 0.88) return Infinity;
  if (u < 0.9) return -Infinity;
  if (u < 0.94) return -(0.02 + r() * 0.05);
  if (u < 0.97) return 1e-30;
  return 3e38;
}

function frequency(r, k) {
  const step = 2 / (k - 1);
  const u = r();
  if (u < 0.4) return swayFrequencyForBucket(Math.floor(r() * k), k); // on the grid
  if (u < 0.6) return r() * 4 - 0.5; // between buckets and past both ends
  if (u < 0.66) return 1 + (Math.floor(r() * (k - 1)) + 0.5) * step; // halfway: a tie where step is 2^-n
  if (u < 0.7) return [0.5, 1.25, 1.5, 1.75, 2, 2.5][Math.floor(r() * 6)]; // ties at 2, 3 and 5 buckets
  if (u < 0.73) return NaN;
  if (u < 0.75) return Infinity;
  if (u < 0.77) return -Infinity;
  if (u < 0.8) return -1; // the cache's sentinel
  if (u < 0.82) return 0;
  if (u < 0.84) return -0;
  if (u < 0.86) return 1e30;
  return 1 + r() * 2;
}

function phase(r) {
  const u = r();
  if (u < 0.3) return 0;
  if (u < 0.55) return r() * Math.PI;
  if (u < 0.7) return Math.PI - r() * 0.05; // ends within a few frames
  if (u < 0.75) return NaN;
  if (u < 0.78) return -Infinity;
  if (u < 0.85) return -r() * 3;
  if (u < 0.9) return 100;
  return r() * 0.5;
}

/** Re-roll a share of the decorations; the rest keep their state, so the cache hits and impulses run on. */
function scramble(r, s, k, share, wide) {
  const D = DecorationComponent;
  const noParent = s.worker._noParent;
  for (let i = 0; i < N; i++) {
    if (r() >= share) continue;
    let u = r();
    D.active[i] = u < 0.06 ? 0 : u < 0.1 ? 9 : 1;
    u = r();
    D.parentEntityIndex[i] = u < 0.08 ? Math.floor(r() * 40) : wide && u < 0.12 ? 0xffff : noParent;
    u = r();
    D.isItOnScreen[i] = u < 0.2 ? 0 : u < 0.25 ? 255 : 1;
    u = r();
    D.sway[i] = u < 0.08 ? SWAY_OFF : u < 0.36 ? SWAY_LOOP_SKEW : u < 0.66 ? SWAY_LOOP : u < 0.9 ? SWAY_IMPULSE : [4, 9, 255][Math.floor(r() * 3)];
    D.swayAmplitude[i] = amplitude(r);
    D.swayFrequency[i] = frequency(r, k);
    D.swayPhase[i] = phase(r);
    if (D.sway[i] === SWAY_IMPULSE) {
      u = r();
      if (u < 0.06) {
        D.swayPhase[i] = -1; // the next phase is -1, which the JS takes for IMPULSE_DONE
        D.swayFrequency[i] = 0;
      } else if (u < 0.12) {
        D.swayPhase[i] = 0; // the next phase is +0
        D.swayFrequency[i] = 0;
      } else if (u < 0.16) {
        D.swayPhase[i] = -0; // and -0
        D.swayFrequency[i] = -0;
      } else if (u < 0.5) {
        D.swayFrequency[i] = 1 + r() * 2;
      }
    }
    const a = r() * 2 * Math.PI;
    u = r();
    D.baseRotC[i] = u < 0.03 ? NaN : u < 0.05 ? -0 : u < 0.06 ? Infinity : Math.cos(a);
    D.baseRotS[i] = u < 0.03 ? Math.sin(a) : u < 0.05 ? -0 : u < 0.06 ? -Infinity : Math.sin(a);
    // Outputs: whatever was there must stay where the JS writes nothing.
    D.rotC[i] = r() * 4 - 2;
    D.rotS[i] = r() * 4 - 2;
  }
}

/** Empty, full in order, full shuffled, or a shuffled part of the pool: each index at most once. */
function pickSnapshot(r, s) {
  const w = s.worker;
  const snap = w._activeDecorationSnapshot;
  const u = r();
  if (u < 0.06) {
    w._activeDecorationSnapshotCount = 0;
    return;
  }
  const ids = Array.from({ length: N }, (_, i) => i);
  if (u >= 0.3) {
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
  }
  const m = u < 0.4 ? N : 1 + Math.floor(r() * N);
  for (let k = 0; k < m; k++) snap[k] = ids[k];
  w._activeDecorationSnapshotCount = m;
}

function frameDelta(r) {
  const u = r();
  if (u < 0.05) return 0;
  if (u < 0.08) return NaN;
  if (u < 0.1) return 1e6;
  if (u < 0.13) return -40;
  return DT * (1 + Math.floor(r() * 3));
}

function setGrid(s, k) {
  const w = s.worker;
  w._swayBuckets = k;
  // The same regions (the table points there); the JS reads these lengths.
  w._bucketSin = new Float32Array(s.buffer, s.regions.bucketSin.byte, k);
  w._bucketCos = new Float32Array(s.buffer, s.regions.bucketCos.byte, k);
}

/** entityIdWidth 32: a u32 parent column with 0xffffffff for none (0xffff is an entity there). */
function useWideParents(s) {
  const D = DecorationComponent;
  const wide = new Uint32Array(s.buffer, s.regions.parent32.byte, N);
  for (let i = 0; i < N; i++) wide[i] = D.parentEntityIndex[i] === 0xffff ? 0xffffffff : D.parentEntityIndex[i];
  D.parentEntityIndex = wide;
  s.worker._noParent = 0xffffffff;
  writeSwayTable(s.b, s.worker);
}

/** Which branch of the JS each snapshot entry takes this frame, from the state before it (coverage only). */
function classify(s, deltaTime, k, cov) {
  const D = DecorationComponent;
  const w = s.worker;
  const snap = w._activeDecorationSnapshot;
  const count = w._activeDecorationSnapshotCount;
  const reset = w._swayBucketCacheK !== k;
  const step = 2 / (k - 1);
  if (count === 0) cov.emptySnapshot++;
  if (count === N) cov.fullSnapshot++;
  for (let idx = 0; idx < count; idx++) {
    const i = snap[idx];
    if (!D.active[i]) cov.inactive++;
    else if (D.parentEntityIndex[i] !== w._noParent) cov.parented++;
    else if (!D.isItOnScreen[i]) cov.offScreen++;
    else if (D.sway[i] === SWAY_OFF) cov.swayOff++;
    else if (D.sway[i] === SWAY_LOOP || D.sway[i] === SWAY_LOOP_SKEW) {
      cov[D.sway[i] === SWAY_LOOP ? 'loop' : 'skew']++;
      const f = D.swayFrequency[i];
      if ((reset ? -1 : w._swayBucketFreq[i]) !== f) {
        cov.bucketMiss++;
        const x = (f - 1) / step;
        if (Number.isNaN(f)) cov.nanFrequency++;
        else if (x - Math.floor(x) === 0.5) cov.roundingTie++;
        if (bucketFromSwayFrequency(f, k) > 0xffff) cov.wrappedBucket++;
      } else {
        cov.bucketHit++;
        if (w._swayBucketOf[i] >= k) cov.staleBucket++;
      }
      if (D.sway[i] === SWAY_LOOP) {
        const amp = Math.abs(D.swayAmplitude[i]);
        if (amp === 0) cov.zeroAngle++;
        else if (amp < 0.075) cov.smallAngle++;
        else if (!Number.isFinite(amp)) cov.nonFiniteAngle++;
      }
    } else if (D.sway[i] === SWAY_IMPULSE) {
      const next = D.swayPhase[i] + deltaTime * 0.002 * D.swayFrequency[i];
      if (next >= Math.PI) cov.impulseEnds++;
      else if (next === -1) cov.impulseAtMinusOne++;
      else if (next === 0) cov.impulseZeroPhase++;
      else if (Number.isFinite(next)) cov.impulseSin++;
      else cov.impulseNaN++;
    } else cov.otherMode++;
  }
}

function stateViews(s) {
  const D = DecorationComponent;
  const w = s.worker;
  const out = Object.keys(D.ARRAY_SCHEMA).map((name) => [name, D[name]]);
  out.push(
    ['snapshot', w._activeDecorationSnapshot],
    ['phaseSin', w._phaseSin],
    ['phaseCos', w._phaseCos],
    ['bucketSin', w._bucketSin],
    ['bucketCos', w._bucketCos],
    ['bucketOf', w._swayBucketOf],
    ['bucketFreq', w._swayBucketFreq],
  );
  return out;
}

/** The first element that differs: a float as Object.is sees it (NaN is NaN, +0 is not -0), the rest exactly. */
function firstDiff(a, b) {
  const float = a instanceof Float32Array;
  for (let i = 0; i < a.length; i++) {
    if (float ? !Object.is(a[i], b[i]) : a[i] !== b[i]) return i;
  }
  return -1;
}

/** One frame on each side from the same bytes; the kernel's state is the next frame's. */
function runFrame(s, deltaTime) {
  const w = s.worker;
  const mem = new Uint8Array(s.buffer, 0, s.layout.bytes);
  const before = mem.slice();
  const cacheK = w._swayBucketCacheK;
  w.updateDecorationSway(deltaTime);
  const js = stateViews(s).map(([name, v]) => [name, v.slice()]);
  const jsCacheK = w._swayBucketCacheK;
  mem.set(before);
  w._swayBucketCacheK = cacheK;
  const listed = swayDecorationsWasm(s.b, w, deltaTime);
  const views = stateViews(s);
  for (let c = 0; c < views.length; c++) {
    const [name, v] = views[c];
    const at = firstDiff(v, js[c][1]);
    if (at >= 0) return { listed, diff: `${name}[${at}]: JS ${js[c][1][at]}, kernel ${v[at]}` };
  }
  if (w._swayBucketCacheK !== jsCacheK) return { listed, diff: `_swayBucketCacheK: JS ${jsCacheK}, kernel ${w._swayBucketCacheK}` };
  return { listed, diff: null };
}

test('the sway kernel writes what _updateDecorationSwayBuckets writes, frame after frame', async (t) => {
  const s = await setupSwayKernel({ n: N, k: 100, kMax: K_MAX, listCap: 1024, seed: 0x5ee0 });
  const w = s.worker;
  const r = rng(0xdec0);
  const cov = {
    inactive: 0, parented: 0, offScreen: 0, swayOff: 0, loop: 0, skew: 0, otherMode: 0,
    bucketMiss: 0, bucketHit: 0, nanFrequency: 0, roundingTie: 0, wrappedBucket: 0, staleBucket: 0,
    zeroAngle: 0, smallAngle: 0, nonFiniteAngle: 0, listedAngle: 0,
    impulseEnds: 0, impulseAtMinusOne: 0, impulseZeroPhase: 0, impulseNaN: 0, impulseSin: 0, listedImpulse: 0,
    emptySnapshot: 0, fullSnapshot: 0, wideFrames: 0,
  };
  let frame = 0;
  for (const p of PHASES) {
    if (p.wide) useWideParents(s);
    if (w._swayBuckets !== p.k) setGrid(s, p.k);
    for (let f = 0; f < p.frames; f++, frame++) {
      s.b.table[LIST_CAP_SLOT] = LIST_CAPS[frame % LIST_CAPS.length];
      let deltaTime = DT;
      if (!p.predator) {
        scramble(r, s, p.k, f === 0 ? 1 : 0.25, p.wide);
        pickSnapshot(r, s);
        deltaTime = frameDelta(r);
      }
      w.accumulatedTime += DT;
      classify(s, deltaTime, p.k, cov);
      if (p.wide) cov.wideFrames++;
      const { listed, diff } = runFrame(s, deltaTime);
      assert.equal(diff, null, `${p.name} frame ${f} (${w._activeDecorationSnapshotCount} in the snapshot, deltaTime ${deltaTime})`);
      if (w._activeDecorationSnapshotCount > 0) assert.ok(listed >= 0, `${p.name} frame ${f}: the kernel ran`);
      if (p.predator) assert.equal(listed, 0, `${p.name} frame ${f}: Predator's grass needs no Math.sin / Math.cos`);
      for (let e = 0; e < listed; e++) cov[(s.b.trig[e] & TRIG_IMPULSE) !== 0 ? 'listedImpulse' : 'listedAngle']++;
    }
  }
  for (const [branch, hits] of Object.entries(cov)) assert.ok(hits > 0, `no frame reached ${branch}`);
  t.diagnostic(`${frame} frames: ${JSON.stringify(cov)}`);
});
