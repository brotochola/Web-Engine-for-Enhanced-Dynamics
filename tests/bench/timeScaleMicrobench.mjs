// Kernel: Time.scaleSimMs over a mixed scale stream.
// Imports the shipped function. Does not patch src/.
//
//   node tests/bench/timeScaleMicrobench.mjs
//   node tests/bench/timeScaleMicrobench.mjs --output tests/results/time-scale/kernel.json

import { Time, scaleSimMs } from '../../src/core/timeScale.js';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const SEED = 0x71e5ca1e;
const N = 4096;

function fill(rng, scales, bases) {
  for (let i = 0; i < N; i++) {
    const pick = rng();
    scales[i] = pick < 0.05 ? 0 : pick < 0.1 ? Number.NaN : 0.25 + rng() * 2;
    bases[i] = 8 + rng() * 24;
  }
}

function checksum(scales, bases) {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = scaleSimMs(bases[i], scales[i]);
  return checksumFloats(out, N);
}

function run(iterations, scales, bases) {
  const sab = new SharedArrayBuffer(4);
  const raw = new Float32Array(sab);
  raw[0] = 1;
  Time.bind(sab);
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    const k = i % N;
    raw[0] = scales[k];
    acc += Time.scaleSimMs(bases[k]);
  }
  return acc;
}

function main() {
  const args = parseArgs();
  const rng = mulberry32(SEED);
  const scales = new Float32Array(N);
  const bases = new Float32Array(N);
  fill(rng, scales, bases);
  const sum = checksum(scales, bases);
  if (!Number.isFinite(sum)) throw new Error('time scale checksum is not finite');

  const probe = run(N, scales, bases);
  if (!Number.isFinite(probe)) throw new Error('time scale probe is not finite');

  const timed = timeIt('timeScale', (iterations) => {
    run(iterations, scales, bases);
  }, { iterations: args.iters || 200000 });

  const payload = {
    seed: SEED,
    n: N,
    checksum: sum,
    cases: {
      scale: {
        opsPerSec: timed.opsPerSec,
        n: timed.iterations,
        seed: SEED,
        checksum: sum,
        sampleMs: timed.ms,
      },
    },
  };

  if (args.output) writeReport(args.output, payload);
  return payload;
}

if (isCli(import.meta.url)) main();

export { main };
