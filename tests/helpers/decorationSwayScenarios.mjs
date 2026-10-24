// The random frames of the sway parity tests (decorationSwayWasm.test.js, decorationSwayF32.test.js): the
// decorations, snapshots, frame times and bucket grids they run, on the state setupSwayKernel
// (decorationSwayWasmMicrobench.mjs) builds. Each generator draws from the rng it is given, so a test that
// replays the same calls gets the same frames.
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import {
  SWAY_IMPULSE,
  SWAY_LOOP,
  SWAY_LOOP_SKEW,
  SWAY_OFF,
  swayFrequencyForBucket,
} from '../../src/util/decorationSway.js';
import { writeSwayTable } from '../bench/decorationSwayWasmMicrobench.mjs';

export const N = 1500;
export const K_MAX = 70000;
export const DT = 1000 / 60;
export const LIST_CAPS = [1, 37, 1024];

/** Runs of frames: the bucket grid of each, Predator's untouched grass first, the 32-bit parents last. */
export const PHASES = [
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

export function rng(seed) {
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
export function scramble(r, s, k, share, wide) {
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
export function pickSnapshot(r, s) {
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

export function frameDelta(r) {
  const u = r();
  if (u < 0.05) return 0;
  if (u < 0.08) return NaN;
  if (u < 0.1) return 1e6;
  if (u < 0.13) return -40;
  return DT * (1 + Math.floor(r() * 3));
}

export function setGrid(s, k) {
  const w = s.worker;
  w._swayBuckets = k;
  // The same regions (the table points there); the JS reads these lengths.
  w._bucketSin = new Float32Array(s.buffer, s.regions.bucketSin.byte, k);
  w._bucketCos = new Float32Array(s.buffer, s.regions.bucketCos.byte, k);
}

/** entityIdWidth 32: a u32 parent column with 0xffffffff for none (0xffff is an entity there). */
export function useWideParents(s) {
  const D = DecorationComponent;
  const wide = new Uint32Array(s.buffer, s.regions.parent32.byte, N);
  for (let i = 0; i < N; i++) wide[i] = D.parentEntityIndex[i] === 0xffff ? 0xffffffff : D.parentEntityIndex[i];
  D.parentEntityIndex = wide;
  s.worker._noParent = 0xffffffff;
  writeSwayTable(s.b, s.worker);
}

/** Every array the sway reads or writes, by name: the DecorationComponent columns and the worker's. */
export function stateViews(s) {
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
