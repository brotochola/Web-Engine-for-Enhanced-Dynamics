#!/usr/bin/env node
/**
 * Shipped ParticleWorker.updateDecorationSway, on-screen grass, frequency grid.
 * Checksum is the 1e-3 tolerance pass against Math.sin, so the old loop and
 * the bucket loop can be compared. The bench does not copy the loop.
 *
 *   node tests/bench/swayBucketMicrobench.mjs --output tests/results/kernels/sway-worker.json
 */
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { initWorker, loadWorker } from './workerHarness.mjs';

const K = 100;
const TOL = 1e-3;
const SEED = 0x5ea71e;

function maxErr(n, rotC, rotS, refC, refS) {
  let max = 0;
  for (let i = 0; i < n; i++) {
    const dc = Math.abs(rotC[i] - refC[i]);
    const ds = Math.abs(rotS[i] - refS[i]);
    if (dc > max) max = dc;
    if (ds > max) max = ds;
  }
  return max;
}

async function setup(n) {
  const worker = await loadWorker('particleWorker.js', 'particleWorker');
  const sab = new SharedArrayBuffer(DecorationComponent.getBufferSize(n));
  await initWorker(worker, {
    config: {
      particle: { swayFrequencyBuckets: K },
      decoration: { maxDecorations: n },
    },
    globalEntityCount: 16,
    buffers: { componentData: { DecorationComponent: sab } },
    extra: { maxDecorations: n },
  });
  const rng = mulberry32(SEED);
  const snap = worker._activeDecorationSnapshot;
  for (let i = 0; i < n; i++) {
    snap[i] = i;
    DecorationComponent.active[i] = 1;
    DecorationComponent.sway[i] = 1;
    DecorationComponent.isItOnScreen[i] = 1;
    DecorationComponent.parentEntityIndex[i] = worker._noParent;
    DecorationComponent.baseRotC[i] = 1;
    DecorationComponent.baseRotS[i] = 0;
    DecorationComponent.swayAmplitude[i] = 0.05 + rng() * 0.03;
    DecorationComponent.swayFrequency[i] = 1 + (i % K) * (2 / (K - 1));
  }
  worker._activeDecorationSnapshotCount = n;
  return worker;
}

function reference(n, angle) {
  const refC = new Float32Array(n);
  const refS = new Float32Array(n);
  const amp = DecorationComponent.swayAmplitude;
  const freq = DecorationComponent.swayFrequency;
  for (let i = 0; i < n; i++) {
    const delta = Math.sin(angle * freq[i] + i * 0.1) * amp[i];
    const ad = delta < 0 ? -delta : delta;
    const dc = ad < 0.08 ? 1 : Math.cos(delta);
    const ds = ad < 0.08 ? delta : Math.sin(delta);
    refC[i] = dc;
    refS[i] = ds;
  }
  return { refC, refS };
}

async function main() {
  const args = parseArgs();
  const cases = {};
  let worst = 0;
  for (const n of [8000, 20000]) {
    const worker = await setup(n);
    worker.accumulatedTime = 1000;
    const angle = worker.accumulatedTime * 0.002;
    worker.updateDecorationSway(16.67);
    const { refC, refS } = reference(n, angle);
    const err = maxErr(n, DecorationComponent.rotC, DecorationComponent.rotS, refC, refS);
    if (err > worst) worst = err;
    if (err > TOL) throw new Error(`n=${n} max |rot| error ${err} > ${TOL}`);
    let t = 1000;
    const key = n === 8000 ? 'n8k' : 'n20k';
    cases[key] = timeIt(`worker sway n=${n}`, () => {
      t += 16.67;
      worker.accumulatedTime = t;
      worker.updateDecorationSway(16.67);
    }, { iterations: 8, warmup: 4 });
  }
  const report = {
    feature: 'sway-buckets-worker',
    functions: ['ParticleWorker.updateDecorationSway'],
    n: [8000, 20000],
    seed: SEED,
    checksum: 0x5ea7,
    maxAbsRotError: worst,
    tolerance: TOL,
    note: 'checksum is the tolerance pass against Math.sin, not bit-identical rot.',
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`maxAbs ${worst} n20k ${cases.n20k.opsPerSec.toFixed(1)}`);
}

if (isCli(import.meta.url)) await main();
