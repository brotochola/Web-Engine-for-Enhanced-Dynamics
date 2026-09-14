// L1 microbench: particle ease — prod (LUT) vs exact Math.pow vs local LUT vs cubic/quad.
//
// Usage:
//   node tests/bench/particle-ease-microbench.mjs
//   node tests/bench/particle-ease-microbench.mjs --iters 1000000 --output tests/results/particle-ease-micro.json

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PARTICLE_EASE } from '../../src/core/ConfigDefaults.js';
import { applyParticleEase } from '../../src/core/particleTween.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbench-helpers.mjs';

/** @param {number} t */
function easeExpoOut(t) {
  return 1 - Math.pow(2, -10 * t);
}

/** @param {number} t */
function easeExpoIn(t) {
  return Math.pow(2, 10 * (t - 1));
}

/** @param {number} t */
function easeExpoInOut(t) {
  return t < 0.5
    ? 0.5 * Math.pow(2, 20 * t - 10)
    : 1 - 0.5 * Math.pow(2, -20 * t + 10);
}

/** @param {number} t */
function easeCubicOut(t) {
  const u = t - 1;
  return u * u * u + 1;
}

/** @param {number} t */
function easeQuadOut(t) {
  return t * (2 - t);
}

/** @param {number} t */
function easeIdentity(t) {
  return t;
}

const EASE_FNS = [];
EASE_FNS[PARTICLE_EASE.LERP] = easeIdentity;
EASE_FNS[PARTICLE_EASE.QUAD_OUT] = easeQuadOut;
EASE_FNS[PARTICLE_EASE.CUBIC_OUT] = easeCubicOut;
EASE_FNS[PARTICLE_EASE.EXPO_IN] = easeExpoIn;
EASE_FNS[PARTICLE_EASE.EXPO_OUT] = easeExpoOut;
EASE_FNS[PARTICLE_EASE.EXPO_INOUT] = easeExpoInOut;

/**
 * @param {number} size
 * @param {(t: number) => number} fn
 * @returns {Float32Array}
 */
function buildLut(size, fn) {
  const lut = new Float32Array(size + 1);
  for (let i = 0; i <= size; i++) {
    lut[i] = fn(i / size);
  }
  return lut;
}

/**
 * @param {Float32Array} lut
 * @param {number} size
 * @param {number} t
 * @returns {number}
 */
function sampleLut(lut, size, t) {
  const x = t * size;
  const i = x | 0;
  const f = x - i;
  return lut[i] + (lut[i + 1] - lut[i]) * f;
}

/**
 * @param {Float32Array} samples
 * @param {(t: number) => number} a
 * @param {(t: number) => number} b
 * @returns {{ maxAbs: number, rmse: number }}
 */
function compareFns(samples, a, b) {
  let maxAbs = 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = samples[i];
    const d = a(t) - b(t);
    const abs = d < 0 ? -d : d;
    if (abs > maxAbs) maxAbs = abs;
    sumSq += d * d;
  }
  return { maxAbs, rmse: Math.sqrt(sumSq / samples.length) };
}

/**
 * @param {Record<string, unknown>} [cliArgs]
 */
export function runParticleEaseMicrobench(cliArgs = parseArgs()) {
  const ITERS = Number(cliArgs.iters ?? 500000);
  const SEED = Number(cliArgs.seed ?? 0xc0ffee);
  const outputPath = cliArgs.output ? String(cliArgs.output) : null;

  const rng = mulberry32(SEED);
  const samples = new Float32Array(ITERS);
  for (let i = 0; i < ITERS; i++) {
    // Keep off exact 0/1 so clamp paths do not dominate.
    samples[i] = 1e-6 + rng() * (1 - 2e-6);
  }

  const lut64 = buildLut(64, easeExpoOut);
  const lut128 = buildLut(128, easeExpoOut);
  const lut256 = buildLut(256, easeExpoOut);

  // Production path (applyParticleEase) uses LUT256 for expo.
  const prodExpo = (t) => applyParticleEase(t, PARTICLE_EASE.EXPO_OUT);
  const prodLerp = (t) => applyParticleEase(t, PARTICLE_EASE.LERP);
  const fnTableExpo = (t) => EASE_FNS[PARTICLE_EASE.EXPO_OUT](t);

  const prodVsExact = compareFns(samples, prodExpo, easeExpoOut);
  if (!Number.isFinite(prodVsExact.maxAbs) || prodVsExact.maxAbs > 2e-3) {
    throw new Error(
      `prod LUT vs exact Math.pow maxAbs ${prodVsExact.maxAbs} (expected < 2e-3)`
    );
  }
  const prodVsLut256 = compareFns(
    samples,
    prodExpo,
    (t) => sampleLut(lut256, 256, t)
  );
  if (prodVsLut256.maxAbs >= 1e-5) {
    throw new Error(
      `prod vs local lut256 maxAbs ${prodVsLut256.maxAbs} (expected near-identical)`
    );
  }

  const lutErr = {
    64: compareFns(samples, (t) => sampleLut(lut64, 64, t), easeExpoOut),
    128: compareFns(samples, (t) => sampleLut(lut128, 128, t), easeExpoOut),
    256: compareFns(samples, (t) => sampleLut(lut256, 256, t), easeExpoOut),
  };
  for (const [size, err] of Object.entries(lutErr)) {
    if (!Number.isFinite(err.maxAbs) || !Number.isFinite(err.rmse)) {
      throw new Error(`LUT${size} non-finite error`);
    }
  }

  console.log(
    `Correctness OK (prod LUT vs exact maxAbs=${prodVsExact.maxAbs.toExponential(2)}; prod vs lut256 maxAbs=${prodVsLut256.maxAbs.toExponential(2)})`
  );
  console.log(
    `LUT errors vs exact expoOut: ` +
      `64 maxAbs=${lutErr[64].maxAbs.toExponential(2)} rmse=${lutErr[64].rmse.toExponential(2)}; ` +
      `128 maxAbs=${lutErr[128].maxAbs.toExponential(2)} rmse=${lutErr[128].rmse.toExponential(2)}; ` +
      `256 maxAbs=${lutErr[256].maxAbs.toExponential(2)} rmse=${lutErr[256].rmse.toExponential(2)}`
  );

  /** @param {(t: number) => number} fn */
  function makeArm(fn) {
    return (n) => {
      const lim = Math.min(n, ITERS);
      let sink = 0;
      for (let i = 0; i < lim; i++) {
        sink += fn(samples[i]);
      }
      if (sink === Infinity) console.log(sink);
    };
  }

  const timeOpts = { iterations: ITERS };

  const prodExpoOut = timeIt(
    'prod applyParticleEase expoOut (LUT256)',
    makeArm(prodExpo),
    timeOpts
  );
  const exactExpoOut = timeIt(
    'exact Math.pow expoOut',
    makeArm(easeExpoOut),
    timeOpts
  );
  const fnTableExpoOut = timeIt(
    'fnTable exact expoOut',
    makeArm(fnTableExpo),
    timeOpts
  );
  const lut64Timing = timeIt(
    'lut64 expoOut',
    makeArm((t) => sampleLut(lut64, 64, t)),
    timeOpts
  );
  const lut128Timing = timeIt(
    'lut128 expoOut',
    makeArm((t) => sampleLut(lut128, 128, t)),
    timeOpts
  );
  const lut256Timing = timeIt(
    'lut256 expoOut (local)',
    makeArm((t) => sampleLut(lut256, 256, t)),
    timeOpts
  );
  const dedicatedCubicOut = timeIt(
    'dedicated cubicOut',
    makeArm(easeCubicOut),
    timeOpts
  );
  const dedicatedQuadOut = timeIt(
    'dedicated quadOut',
    makeArm(easeQuadOut),
    timeOpts
  );
  const prodLerpTiming = timeIt(
    'prod lerp (floor)',
    makeArm(prodLerp),
    timeOpts
  );
  const dedicatedIdentity = timeIt(
    'dedicated identity (floor)',
    makeArm(easeIdentity),
    timeOpts
  );

  const exactExpoIn = timeIt(
    'exact Math.pow expoIn',
    makeArm(easeExpoIn),
    timeOpts
  );
  const exactExpoInOut = timeIt(
    'exact Math.pow expoInOut',
    makeArm(easeExpoInOut),
    timeOpts
  );

  const report = {
    name: 'particle-ease',
    seed: SEED,
    iters: ITERS,
    correctness: {
      prodVsExactMaxAbs: prodVsExact.maxAbs,
      prodVsLut256MaxAbs: prodVsLut256.maxAbs,
      lut: lutErr,
    },
    timings: {
      prodExpoOut,
      exactExpoOut,
      fnTableExpoOut,
      lut64: lut64Timing,
      lut128: lut128Timing,
      lut256: lut256Timing,
      dedicatedCubicOut,
      dedicatedQuadOut,
      prodLerp: prodLerpTiming,
      dedicatedIdentity,
      exactExpoIn,
      exactExpoInOut,
    },
    ratios: {
      prodOverExact: prodExpoOut.ms / exactExpoOut.ms,
      fnTableOverExact: fnTableExpoOut.ms / exactExpoOut.ms,
      lut64OverExact: lut64Timing.ms / exactExpoOut.ms,
      lut128OverExact: lut128Timing.ms / exactExpoOut.ms,
      lut256OverExact: lut256Timing.ms / exactExpoOut.ms,
      cubicOverExact: dedicatedCubicOut.ms / exactExpoOut.ms,
      quadOverExact: dedicatedQuadOut.ms / exactExpoOut.ms,
      prodLerpOverProdExpo: prodLerpTiming.ms / prodExpoOut.ms,
    },
  };

  console.log('Ratios (<1 = faster):');
  for (const [k, v] of Object.entries(report.ratios)) {
    console.log(`  ${k}: ${v.toFixed(3)}`);
  }

  if (outputPath) writeReport(outputPath, report);
  return report;
}

const isDirect =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) {
  runParticleEaseMicrobench();
}
