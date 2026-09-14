// L1 microbench: anim frameDuration = 1/(speed*60) every tick vs cached (PRE-ANIM).
//
// Usage:
//   node tests/bench/pre-anim-microbench.mjs
//   node tests/bench/pre-anim-microbench.mjs --entities 8000 --ticks 2000 --speed-change-rate 0.001 --output tests/results/pre-anim-micro.json

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { mulberry32, parseArgs, timeIt, writeReport } from './microbench-helpers.mjs';

/**
 * @param {Record<string, unknown>} [cliArgs]
 */
export function runPreAnimMicrobench(cliArgs = parseArgs()) {
  const ENTITIES = Number(cliArgs.entities ?? 8000);
  const TICKS = Number(cliArgs.ticks ?? 2000);
  const SPEED_CHANGE_RATE = Number(cliArgs['speed-change-rate'] ?? 0.001);
  const SEED = Number(cliArgs.seed ?? 0xc0ffee);
  const outputPath = cliArgs.output ? String(cliArgs.output) : null;
  const DT = 1 / 60;

  const rng = mulberry32(SEED);
  const animSpeed = new Float32Array(ENTITIES);
  const frameCount = new Uint16Array(ENTITIES);
  for (let i = 0; i < ENTITIES; i++) {
    animSpeed[i] = 0.5 + rng() * 1.5;
    frameCount[i] = 2 + ((rng() * 6) | 0);
  }

  const rngSched = mulberry32(SEED ^ 0x1111);
  const speedSchedule = new Float32Array(animSpeed);
  const baseAccum = new Float32Array(ENTITIES);
  const baseIndex = new Uint16Array(ENTITIES);
  const optAccum = new Float32Array(ENTITIES);
  const optIndex = new Uint16Array(ENTITIES);
  const durationCache = new Float32Array(ENTITIES);
  const speedCached = new Float32Array(ENTITIES);
  speedCached.fill(NaN);

  const CORRECT_TICKS = 200;
  for (let t = 0; t < CORRECT_TICKS; t++) {
    for (let i = 0; i < ENTITIES; i++) {
      if (rngSched() < SPEED_CHANGE_RATE) {
        speedSchedule[i] = 0.5 + rngSched() * 1.5;
      }
      const sp = speedSchedule[i];
      const frameDuration = 1 / (sp * 60);

      baseAccum[i] += DT;
      while (baseAccum[i] >= frameDuration) {
        baseAccum[i] -= frameDuration;
        baseIndex[i] = (baseIndex[i] + 1) % frameCount[i];
      }

      let dur = durationCache[i];
      if (speedCached[i] !== sp) {
        speedCached[i] = sp;
        dur = frameDuration;
        durationCache[i] = dur;
      }
      optAccum[i] += DT;
      while (optAccum[i] >= dur) {
        optAccum[i] -= dur;
        optIndex[i] = (optIndex[i] + 1) % frameCount[i];
      }
    }
  }

  let mismatches = 0;
  for (let i = 0; i < ENTITIES; i++) {
    if (baseIndex[i] !== optIndex[i]) mismatches++;
  }
  if (mismatches !== 0) {
    throw new Error(`PRE-ANIM correctness mismatches: ${mismatches}`);
  }
  console.log(
    `Correctness OK (${ENTITIES} entities x ${CORRECT_TICKS} ticks, frameIndex match)`
  );

  const baseline = timeIt(
    'frameDuration div every tick (baseline)',
    (n) => {
      const ticks = Math.max(1, (n / ENTITIES) | 0);
      const speed = new Float32Array(animSpeed);
      const accum = new Float32Array(ENTITIES);
      const index = new Uint16Array(ENTITIES);
      const localRng = mulberry32(SEED ^ 0xabcd);
      let sink = 0;
      for (let t = 0; t < ticks; t++) {
        for (let i = 0; i < ENTITIES; i++) {
          if (localRng() < SPEED_CHANGE_RATE) speed[i] = 0.5 + localRng() * 1.5;
          const frameDuration = 1 / (speed[i] * 60);
          accum[i] += DT;
          if (accum[i] >= frameDuration) {
            accum[i] -= frameDuration;
            index[i] = (index[i] + 1) % frameCount[i];
          }
          sink += index[i];
        }
      }
      if (sink === -1) console.log(sink);
    },
    { iterations: ENTITIES * TICKS }
  );

  const optimized = timeIt(
    'frameDuration cached (PRE-ANIM)',
    (n) => {
      const ticks = Math.max(1, (n / ENTITIES) | 0);
      const speed = new Float32Array(animSpeed);
      const accum = new Float32Array(ENTITIES);
      const index = new Uint16Array(ENTITIES);
      const durCache = new Float32Array(ENTITIES);
      const spCache = new Float32Array(ENTITIES);
      spCache.fill(NaN);
      const localRng = mulberry32(SEED ^ 0xabcd);
      let sink = 0;
      for (let t = 0; t < ticks; t++) {
        for (let i = 0; i < ENTITIES; i++) {
          if (localRng() < SPEED_CHANGE_RATE) speed[i] = 0.5 + localRng() * 1.5;
          const sp = speed[i];
          let dur = durCache[i];
          if (spCache[i] !== sp) {
            spCache[i] = sp;
            dur = sp > 0 ? 1 / (sp * 60) : 1e9;
            durCache[i] = dur;
          }
          accum[i] += DT;
          if (accum[i] >= dur) {
            accum[i] -= dur;
            index[i] = (index[i] + 1) % frameCount[i];
          }
          sink += index[i];
        }
      }
      if (sink === -1) console.log(sink);
    },
    { iterations: ENTITIES * TICKS }
  );

  const report = {
    name: 'pre-anim',
    hyp: 'PRE-ANIM',
    seed: SEED,
    entities: ENTITIES,
    ticks: TICKS,
    speedChangeRate: SPEED_CHANGE_RATE,
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
  runPreAnimMicrobench();
}
