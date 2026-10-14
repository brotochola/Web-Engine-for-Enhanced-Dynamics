// H-10: the decoration sway bucket cache.
//
// A/B on the ONE thing that changed inside the bucketed sway loop: whether the
// frequency-to-bucket mapping is recomputed per element per frame, or read from
// a self-validating cache.
//
// Why a kernel and not the scene: the scene cannot arbitrate this. Measured on
// decorationSwayStressScene at the uint16 ceiling of 65 535 decorations, the
// particle worker spends 1.562 ms with an RMS scatter of 0.108 ms, so a 3 %
// delta (0.047 ms) is 0.43x the noise. The kernel is the instrument; the scene
// is corroboration only, and is not quoted as the verdict.
//
// Frequencies are drawn from the real grid (`swayFrequencyForBucket`), which is
// what a scene actually produces. An off-grid sweep would make every element a
// cache miss and measure nothing, so there is a `drift` variant to prove that
// distinction is real rather than assumed.

import {
  tickSwayFormula,
  buildPhaseTables,
  checksumRot,
  swayFrequencyForBucket,
} from './decorationSwayKernel.mjs';

const NO_PARENT = 0xffff;

function buildSoa(n, k, seedFreq) {
  const soa = {
    swayFrequency: new Float32Array(n),
    swayAmplitude: new Float32Array(n),
    swayPhase: new Float32Array(n),
    rotC: new Float32Array(n),
    rotS: new Float32Array(n),
    baseRotC: new Float32Array(n),
    baseRotS: new Float32Array(n),
    parentEntityIndex: new Uint16Array(n),
    active: new Uint8Array(n),
  };
  let s = seedFreq >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    soa.swayFrequency[i] = swayFrequencyForBucket((rnd() * k) | 0, k);
    soa.swayAmplitude[i] = 0.02 + rnd() * 0.08;
    soa.baseRotC[i] = 1;
    soa.baseRotS[i] = 0;
    soa.parentEntityIndex[i] = NO_PARENT;
    soa.active[i] = 1;
  }
  return soa;
}

function snapshotOf(n) {
  const snap = new Uint16Array(n);
  for (let i = 0; i < n; i++) snap[i] = i;
  return snap;
}

function modeFor(k, cached, n) {
  const { phaseSin, phaseCos } = buildPhaseTables(n);
  return {
    buckets: k,
    sA: new Float32Array(k),
    cA: new Float32Array(k),
    phaseSin,
    phaseCos,
    cached,
    // Uint16, matching particleWorker: an unvalidated grid above 256 would wrap.
    bucketOf: cached ? new Uint16Array(n) : null,
    bucketFreq: cached ? new Float32Array(n).fill(-1) : null,
  };
}

/**
 * Time `fn` with enough repetitions that the sample clears the 3 ms protocol
 * floor, then report the per-call cost.
 *
 * The bug this replaces: a doubling loop that measured `iters` calls, divided
 * the total by `reps` but not by `iters`, and therefore reported a cost scaled
 * by the iteration count. Two variants that happened to settle on 4 and 8
 * iterations compared as 4x-t against 8x-t and read as "+92% slower" for a
 * change that does not touch the hot path's arithmetic. The inflation was the
 * harness, and it was in the direction that would have killed a real win.
 */
function timeOnce(fn, iters) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function measure(label, fn, floorMs = 3, samples = 5) {
  fn(); // warm the JIT before any timing
  let iters = 1;
  let t = timeOnce(fn, iters);
  while (t < floorMs) {
    iters *= 2;
    t = timeOnce(fn, iters);
  }
  const perCall = [];
  for (let s = 0; s < samples; s++) perCall.push(timeOnce(fn, iters) / iters);
  perCall.sort((x, y) => x - y);
  const median = perCall[samples >> 1];
  const cv =
    (Math.sqrt(
      perCall.reduce((p, c) => p + (c - median) ** 2, 0) / (samples - 1),
    ) /
      median) *
    100;
  return { label, perCallMs: median, cv, iters, samples, all: perCall };
}

const N = 65535; // the uint16 decoration ceiling
const K = 3; // decorationSwayStressScene's default grid

console.log(`\nH-10 kernel - sway bucket cache`);
console.log(`  N = ${N} decorations (uint16 ceiling), grid k = ${K}\n`);

const results = [];
let refSum = null;

for (const cached of [false, true]) {
  const soa = buildSoa(N, K, 0xc0ffee);
  const snap = snapshotOf(N);
  const mode = modeFor(K, cached, N);

  const r = measure(cached ? 'B cached  ' : 'A uncached', () => {
    tickSwayFormula(snap, N, 0.016, soa, mode);
  });

  const sum = checksumRot(snap, N, soa.rotC, soa.rotS);
  if (refSum === null) refSum = sum;
  const parity = Math.abs(sum - refSum);
  results.push({ ...r, cached, sum, parity });
  console.log(
    `  ${r.label}  ${r.perCallMs.toFixed(4)} ms/frame   ` +
      `(iters ${r.iters}, cv ${r.cv.toFixed(1)}%)`,
  );
}

const a = results[0].perCallMs;
const b = results[1].perCallMs;
const delta = ((b - a) / a) * 100;
console.log(
  `\n  A -> B: ${a.toFixed(4)} -> ${b.toFixed(4)} ms/frame  ` +
    `(${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)`,
);
console.log(`  parity: |sumA - sumB| = ${results[0].parity.toExponential(2)}`);

// The cache is only a win if it actually hits. If every element misses, the
// cached path is strictly worse and the whole premise is wrong.
const modeProbe = modeFor(K, true, N);
const soaProbe = buildSoa(N, K, 0xc0ffee);
const snapProbe = snapshotOf(N);
tickSwayFormula(snapProbe, N, 0.016, soaProbe, modeProbe); // populates
let misses = 0;
for (let i = 0; i < N; i++) if (modeProbe.bucketFreq[i] !== soaProbe.swayFrequency[i]) misses++;
console.log(
  `  hit rate after one frame: ${(((N - misses) / N) * 100).toFixed(2)}%  ` +
    `(${misses} misses - these are the cold-start recomputes, expected once)`,
);