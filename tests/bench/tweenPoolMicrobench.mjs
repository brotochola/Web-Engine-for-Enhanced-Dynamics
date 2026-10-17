// Kernel: one alpha tween per entity, 65535 slots. Imports Tween.tick. Does not patch src/.
//
//   node tests/bench/tweenPoolMicrobench.mjs
//   node tests/bench/tweenPoolMicrobench.mjs --output tests/results/tween-65535/kernel.json

import { Tween, tweenBufferBytes } from '../../src/core/tween.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { checksumFloats, isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const SEED = 0x65535;
const N = 65535;

function setup() {
  SpriteRenderer.active = new Uint8Array(N);
  SpriteRenderer.active.fill(1);
  SpriteRenderer.alpha = new Float32Array(N);
  SpriteRenderer.alpha.fill(1);
  SpriteRenderer.tint = new Uint32Array(N);
  SpriteRenderer.scaleX = new Float32Array(N);
  SpriteRenderer.scaleX.fill(1);
  SpriteRenderer.scaleY = new Float32Array(N);
  SpriteRenderer.scaleY.fill(1);
  SpriteRenderer.renderDirty = new Uint8Array(N);
  Tween.bind(new SharedArrayBuffer(tweenBufferBytes(N)), N);
  for (let i = 0; i < N; i++) {
    const slot = Tween.to(i, { alpha: 0 }, 1e9, 0);
    if (slot !== i) throw new Error(`slot ${slot} !== entity ${i}`);
  }
}

function rewind() {
  Tween.elapsed.fill(0);
}

function checksum() {
  rewind();
  Tween.tick(16);
  return checksumFloats(SpriteRenderer.alpha, N);
}

function run(iterations) {
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    rewind();
    Tween.tick(16);
    acc += SpriteRenderer.alpha[0] + SpriteRenderer.alpha[N - 1];
  }
  return acc;
}

function main() {
  const args = parseArgs();
  setup();
  const sum = checksum();
  if (!Number.isFinite(sum)) throw new Error('tween checksum is not finite');
  const probe = run(1);
  if (!Number.isFinite(probe)) throw new Error('tween probe is not finite');

  const timed = timeIt('tween65535', (iterations) => {
    run(iterations);
  }, { iterations: args.iters || 4 });

  const payload = {
    seed: SEED,
    n: N,
    checksum: sum,
    cases: {
      tick: {
        opsPerSec: timed.opsPerSec,
        n: timed.iterations,
        seed: SEED,
        checksum: sum,
        sampleMs: timed.ms,
      },
    },
  };
  if (args.output) writeReport(args.output, payload);
  Tween.unbind();
  return payload;
}

if (isCli(import.meta.url)) main();

export { main };
