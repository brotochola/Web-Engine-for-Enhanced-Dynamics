// Kernel: deadzoneCenter. Imports the shipped function. Does not patch src/.
//
//   node tests/bench/cameraDeadzoneMicrobench.mjs
//   node tests/bench/cameraDeadzoneMicrobench.mjs --output tests/results/camera-deadzone/kernel.json

import { deadzoneCenter } from '../../src/core/camera.js';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const SEED = 0xc4e2a0e;
const N = 4096;
const scratch = { x: 0, y: 0 };

function fill(rng, xs, ys) {
  for (let i = 0; i < N; i++) {
    xs[i] = (rng() - 0.5) * 400;
    ys[i] = (rng() - 0.5) * 300;
  }
}

function checksum(xs, ys) {
  const out = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    deadzoneCenter(xs[i], ys[i], 0, 0, 80, 60, scratch);
    out[i * 2] = scratch.x;
    out[i * 2 + 1] = scratch.y;
  }
  return checksumFloats(out, N * 2);
}

function run(iterations, xs, ys) {
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    const k = i % N;
    deadzoneCenter(xs[k], ys[k], 0, 0, 80, 60, scratch);
    acc += scratch.x + scratch.y;
  }
  return acc;
}

function main() {
  const args = parseArgs();
  const rng = mulberry32(SEED);
  const xs = new Float32Array(N);
  const ys = new Float32Array(N);
  fill(rng, xs, ys);
  const sum = checksum(xs, ys);
  if (!Number.isFinite(sum)) throw new Error('deadzone checksum is not finite');
  const probe = run(N, xs, ys);
  if (!Number.isFinite(probe)) throw new Error('deadzone probe is not finite');

  const timed = timeIt('deadzone', (iterations) => {
    run(iterations, xs, ys);
  }, { iterations: args.iters || 200000 });

  const payload = {
    seed: SEED,
    n: N,
    checksum: sum,
    cases: {
      deadzone: {
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
