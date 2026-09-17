// Occupancy kernel for decoration sway: scan maxDecorations vs compact snapshot.
//
//   node tests/bench/decorationSwayMicrobench.mjs
//   node tests/bench/decorationSwayMicrobench.mjs --output tests/results/pool-flow/deco-sway-kernel.json

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import {
  tickDecorationSwayBuffers,
  checksumRot,
  SWAY_LOOP,
  NO_PARENT,
} from './decorationSwayKernel.mjs';

const args = parseArgs();
const POOL = Number(args.pool ?? 20000);
const STEPS = Number(args.steps ?? 400);
const SEED = Number(args.seed ?? 0xdec05e);
const OUTPUT = args.output ? String(args.output) : null;
const KEEP_OPS_PCT = 3;
const OCCUPANCY = [10, 50, 95];
const TIME_MS = 1000;
const DT = 16.6667;

function setupPool(n) {
  const sab = new SharedArrayBuffer(DecorationComponent.getBufferSize(n));
  DecorationComponent.initializeArrays(sab, n);
  DecorationComponent.decorationCount = n;
}

function fillOccupancy(pool, liveCount, rng) {
  const active = DecorationComponent.active;
  const sway = DecorationComponent.sway;
  const swayAmplitude = DecorationComponent.swayAmplitude;
  const swayFrequency = DecorationComponent.swayFrequency;
  const swayPhase = DecorationComponent.swayPhase;
  const rotC = DecorationComponent.rotC;
  const rotS = DecorationComponent.rotS;
  const baseRotC = DecorationComponent.baseRotC;
  const baseRotS = DecorationComponent.baseRotS;
  const parentEntityIndex = DecorationComponent.parentEntityIndex;
  active.fill(0);
  sway.fill(0);
  parentEntityIndex.fill(NO_PARENT);
  baseRotC.fill(1);
  baseRotS.fill(0);
  rotC.fill(1);
  rotS.fill(0);
  const snapshot = new Uint16Array(liveCount);
  const stride = Math.max(1, (pool / liveCount) | 0);
  let n = 0;
  for (let i = 0; i < pool && n < liveCount; i += stride) {
    active[i] = 1;
    sway[i] = SWAY_LOOP;
    swayAmplitude[i] = 0.04 + rng() * 0.03;
    swayFrequency[i] = 0.8 + rng() * 1.4;
    swayPhase[i] = 0;
    snapshot[n++] = i;
  }
  if (n !== liveCount) throw new Error(`deco fill got ${n}, want ${liveCount}`);
  return snapshot;
}

function soaViews() {
  return {
    active: DecorationComponent.active,
    sway: DecorationComponent.sway,
    swayAmplitude: DecorationComponent.swayAmplitude,
    swayFrequency: DecorationComponent.swayFrequency,
    swayPhase: DecorationComponent.swayPhase,
    rotC: DecorationComponent.rotC,
    rotS: DecorationComponent.rotS,
    baseRotC: DecorationComponent.baseRotC,
    baseRotS: DecorationComponent.baseRotS,
    parentEntityIndex: DecorationComponent.parentEntityIndex,
  };
}

function snapshotRot(pool) {
  return {
    rotC: DecorationComponent.rotC.slice(0, pool),
    rotS: DecorationComponent.rotS.slice(0, pool),
    sway: DecorationComponent.sway.slice(0, pool),
    swayPhase: DecorationComponent.swayPhase.slice(0, pool),
  };
}

function restoreRot(snap) {
  DecorationComponent.rotC.set(snap.rotC);
  DecorationComponent.rotS.set(snap.rotS);
  DecorationComponent.sway.set(snap.sway);
  DecorationComponent.swayPhase.set(snap.swayPhase);
}

function assertApprox(actual, expected, eps, msg) {
  if (!(Math.abs(actual - expected) <= eps)) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

setupPool(POOL);
const rng = mulberry32(SEED);
const soa = soaViews();
const cases = {};
const pairs = {};

for (const occ of OCCUPANCY) {
  const liveCount = Math.max(1, Math.round((POOL * occ) / 100));
  const snapshot = fillOccupancy(POOL, liveCount, mulberry32(SEED ^ occ));
  const rotSnap = snapshotRot(POOL);
  const opts = {
    maxDecorations: POOL,
    snapshot,
    snapshotCount: liveCount,
    accumulatedTimeMs: TIME_MS,
    deltaTime: DT,
  };

  restoreRot(rotSnap);
  tickDecorationSwayBuffers('scan', soa, opts);
  const scanSum = checksumRot(snapshot, liveCount, DecorationComponent.rotC, DecorationComponent.rotS);
  restoreRot(rotSnap);
  tickDecorationSwayBuffers('snapshot', soa, opts);
  assertApprox(
    checksumRot(snapshot, liveCount, DecorationComponent.rotC, DecorationComponent.rotS),
    scanSum,
    1e-5,
    `occ ${occ}% scan vs snapshot checksum`
  );

  const key = `occ${occ}`;
  cases[`${key}Scan`] = timeIt(
    `sway scan ${liveCount}/${POOL} (${occ}%)`,
    (iters) => {
      for (let s = 0; s < iters; s++) {
        restoreRot(rotSnap);
        tickDecorationSwayBuffers('scan', soa, opts);
      }
    },
    { iterations: STEPS }
  );
  cases[`${key}Snapshot`] = timeIt(
    `sway snapshot ${liveCount}/${POOL} (${occ}%)`,
    (iters) => {
      for (let s = 0; s < iters; s++) {
        restoreRot(rotSnap);
        tickDecorationSwayBuffers('snapshot', soa, opts);
      }
    },
    { iterations: STEPS }
  );
  const scanOps = cases[`${key}Scan`].opsPerSec;
  const snapOps = cases[`${key}Snapshot`].opsPerSec;
  pairs[key] = scanOps > 0 ? ((snapOps - scanOps) / scanOps) * 100 : null;
  rng();
}

const caseSummary = {};
for (const [key, result] of Object.entries(cases)) {
  caseSummary[key] = {
    ms: result.ms,
    opsPerSec: result.opsPerSec,
    iterations: result.iterations,
  };
}

for (const occ of OCCUPANCY) {
  const d = pairs[`occ${occ}`];
  console.log(
    `occ ${occ}% snapshot vs scan: ${d == null ? 'n/a' : `${d.toFixed(1)}%`} ops/s (positive = snapshot cheaper)`
  );
}

if (OUTPUT) {
  writeReport(OUTPUT, {
    feature: 'decoration-sway',
    layer: 'kernel',
    seed: SEED,
    pool: POOL,
    occupancy: OCCUPANCY,
    keepOpsPct: KEEP_OPS_PCT,
    snapshotVsScanPct: pairs,
    cases: caseSummary,
  });
}
