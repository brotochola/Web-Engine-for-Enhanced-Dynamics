// L1 microbench: glow collect inside entity loop (baseline) vs lights-only pass (PRE-HOT).
//
// Usage:
//   node tests/bench/pre-hot-microbench.mjs
//   node tests/bench/pre-hot-microbench.mjs --entities 12000 --lights 80 --frames 2000 --output tests/results/pre-hot-micro.json

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { mulberry32, parseArgs, timeIt, writeReport } from './microbench-helpers.mjs';

const MIN_GLOW_INTENSITY = 0.05;
const MIN_GLOW_RANGE = 10;

/**
 * @param {Record<string, unknown>} [cliArgs]
 */
export function runPreHotMicrobench(cliArgs = parseArgs()) {
  const ENTITIES = Number(cliArgs.entities ?? 12000);
  const LIGHTS = Number(cliArgs.lights ?? 80);
  const FRAMES = Number(cliArgs.frames ?? 2000);
  const SEED = Number(cliArgs.seed ?? 0xc0ffee);
  const outputPath = cliArgs.output ? String(cliArgs.output) : null;

  if (LIGHTS > ENTITIES) {
    throw new Error(`--lights (${LIGHTS}) must be <= --entities (${ENTITIES})`);
  }

  const rng = mulberry32(SEED);
  const y = new Float32Array(ENTITIES);
  const onScreen = new Uint8Array(ENTITIES);
  const lightActive = new Uint8Array(ENTITIES);
  const hasGlow = new Uint8Array(ENTITIES);
  const intensity = new Float32Array(ENTITIES);
  const sqrtIntensity = new Float32Array(ENTITIES);
  const lightIndices = new Uint16Array(LIGHTS);

  for (let i = 0; i < ENTITIES; i++) {
    y[i] = rng() * 2000;
    onScreen[i] = rng() < 0.35 ? 1 : 0;
  }

  const picked = new Set();
  while (picked.size < LIGHTS) {
    picked.add((rng() * ENTITIES) | 0);
  }
  let li = 0;
  for (const idx of picked) {
    lightIndices[li++] = idx;
    lightActive[idx] = 1;
    hasGlow[idx] = 1;
    intensity[idx] = 0.1 + rng() * 2;
    sqrtIntensity[idx] = Math.sqrt(intensity[idx]) * 50;
  }

  function collectBaseline(out) {
    let n = 0;
    for (let i = 0; i < ENTITIES; i++) {
      if (!onScreen[i]) continue;
      const spriteY = y[i];
      void spriteY;
      if (
        lightActive[i] &&
        hasGlow[i] &&
        intensity[i] >= MIN_GLOW_INTENSITY &&
        (sqrtIntensity[i] || 200) >= MIN_GLOW_RANGE
      ) {
        out[n++] = i;
      }
    }
    return n;
  }

  function collectOptimized(out) {
    for (let i = 0; i < ENTITIES; i++) {
      if (!onScreen[i]) continue;
      const spriteY = y[i];
      void spriteY;
    }
    let n = 0;
    for (let k = 0; k < LIGHTS; k++) {
      const i = lightIndices[k];
      if (!onScreen[i]) continue;
      if (!lightActive[i] || !hasGlow[i]) continue;
      if (intensity[i] < MIN_GLOW_INTENSITY) continue;
      if ((sqrtIntensity[i] || 200) < MIN_GLOW_RANGE) continue;
      out[n++] = i;
    }
    return n;
  }

  const outA = new Uint16Array(LIGHTS + 8);
  const outB = new Uint16Array(LIGHTS + 8);
  const nA = collectBaseline(outA);
  const nB = collectOptimized(outB);
  if (nA !== nB) {
    throw new Error(`PRE-HOT glow count mismatch: baseline=${nA} opt=${nB}`);
  }
  const setA = new Set(Array.from(outA.subarray(0, nA)));
  for (let i = 0; i < nB; i++) {
    if (!setA.has(outB[i])) {
      throw new Error(`PRE-HOT glow set mismatch at index ${outB[i]}`);
    }
  }
  console.log(`Correctness OK (glow set size ${nA} matches)`);

  const baseline = timeIt(
    'glow checks in entity loop (baseline)',
    (n) => {
      const frames = Math.max(1, n | 0);
      const out = new Uint16Array(LIGHTS + 8);
      let sink = 0;
      for (let f = 0; f < frames; f++) sink += collectBaseline(out);
      if (sink === -1) console.log(sink);
    },
    { iterations: FRAMES }
  );

  const optimized = timeIt(
    'glow via lights pass (PRE-HOT)',
    (n) => {
      const frames = Math.max(1, n | 0);
      const out = new Uint16Array(LIGHTS + 8);
      let sink = 0;
      for (let f = 0; f < frames; f++) sink += collectOptimized(out);
      if (sink === -1) console.log(sink);
    },
    { iterations: FRAMES }
  );

  const report = {
    name: 'pre-hot',
    hyp: 'PRE-HOT',
    seed: SEED,
    entities: ENTITIES,
    lights: LIGHTS,
    frames: FRAMES,
    glowCount: nA,
    correctness: { ok: true },
    timings: { baseline, optimized },
    ratios: { overall: optimized.ms / baseline.ms },
  };

  console.log(`Ratio opt/baseline: ${report.ratios.overall.toFixed(3)} (<1 = faster)`);
  if (outputPath) writeReport(outputPath, report);
  return report;
}

const isDirect =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) {
  runPreHotMicrobench();
}
