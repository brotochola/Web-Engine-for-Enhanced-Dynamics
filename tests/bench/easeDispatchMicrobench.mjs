// Kernel: how applyParticleEase picks a curve.
// switch (shipped) vs else-if vs a plain object keyed by ease id.
// Does not patch src/. Each (style, workload, round) runs in its own worker
// so V8 feedback from one arm cannot leak into another.
//
//   node tests/bench/easeDispatchMicrobench.mjs
//   node tests/bench/easeDispatchMicrobench.mjs --output tests/results/ease-dispatch/kernel.json

import { PARTICLE_DEFAULTS, PARTICLE_EASE } from '../../src/util/configDefaults.js';
import { applyParticleEase } from '../../src/util/particleTween.js';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const SEED = 0xe35e0001;
const N = 4096;
const ROUNDS = 3;
const EASE_COUNT = PARTICLE_EASE.BOUNCE_OUT + 1;
const EXPO_LUT_SIZE = PARTICLE_DEFAULTS.expoLutSize | 0;

const STYLES = ['switch', 'ifelse', 'object', 'direct'];
const WORKLOADS = ['lerp', 'quad-in', 'bounce', 'mixed'];

function buildExpoLut(fn) {
  const lut = new Float32Array(EXPO_LUT_SIZE + 1);
  for (let i = 0; i <= EXPO_LUT_SIZE; i++) lut[i] = fn(i / EXPO_LUT_SIZE);
  return lut;
}

const EXPO_IN_LUT = buildExpoLut((t) => Math.pow(2, 10 * (t - 1)));
const EXPO_OUT_LUT = buildExpoLut((t) => 1 - Math.pow(2, -10 * t));
const EXPO_INOUT_LUT = buildExpoLut((t) =>
  t < 0.5 ? 0.5 * Math.pow(2, 20 * t - 10) : 1 - 0.5 * Math.pow(2, -20 * t + 10)
);

function sampleExpoLut(lut, t) {
  const x = t * EXPO_LUT_SIZE;
  const i = x | 0;
  const f = x - i;
  return lut[i] + (lut[i + 1] - lut[i]) * f;
}

function easeLerp(t) {
  return t;
}
function easeQuadIn(t) {
  return t * t;
}
function easeQuadOut(t) {
  return t * (2 - t);
}
function easeQuadInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}
function easeCubicIn(t) {
  return t * t * t;
}
function easeCubicOut(t) {
  const u = t - 1;
  return u * u * u + 1;
}
function easeCubicInOut(t) {
  if (t < 0.5) return 4 * t * t * t;
  const u = 2 * t - 2;
  return (t - 1) * u * u + 1;
}
function easeExpoIn(t) {
  return sampleExpoLut(EXPO_IN_LUT, t);
}
function easeExpoOut(t) {
  return sampleExpoLut(EXPO_OUT_LUT, t);
}
function easeExpoInOut(t) {
  return sampleExpoLut(EXPO_INOUT_LUT, t);
}
function easeBackIn(t) {
  const s = 1.70158;
  return t * t * ((s + 1) * t - s);
}
function easeBackOut(t) {
  const s = 1.70158;
  const u = t - 1;
  return u * u * ((s + 1) * u + s) + 1;
}
function easeBackInOut(t) {
  const s = 1.70158 * 1.525;
  if (t < 0.5) {
    const u = t * 2;
    return 0.5 * (u * u * ((s + 1) * u - s));
  }
  const u = t * 2 - 2;
  return 0.5 * (u * u * ((s + 1) * u + s) + 2);
}
function easeBounceOut(t) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) {
    const u = t - 1.5 / d1;
    return n1 * u * u + 0.75;
  }
  if (t < 2.5 / d1) {
    const u = t - 2.25 / d1;
    return n1 * u * u + 0.9375;
  }
  const u = t - 2.625 / d1;
  return n1 * u * u + 0.984375;
}

/** Numeric ease-id keys. Dense 0..13, same ids the switch matches. */
const EASE_BY_ID = {
  [PARTICLE_EASE.LERP]: easeLerp,
  [PARTICLE_EASE.QUAD_IN]: easeQuadIn,
  [PARTICLE_EASE.QUAD_OUT]: easeQuadOut,
  [PARTICLE_EASE.QUAD_INOUT]: easeQuadInOut,
  [PARTICLE_EASE.CUBIC_IN]: easeCubicIn,
  [PARTICLE_EASE.CUBIC_OUT]: easeCubicOut,
  [PARTICLE_EASE.CUBIC_INOUT]: easeCubicInOut,
  [PARTICLE_EASE.EXPO_IN]: easeExpoIn,
  [PARTICLE_EASE.EXPO_OUT]: easeExpoOut,
  [PARTICLE_EASE.EXPO_INOUT]: easeExpoInOut,
  [PARTICLE_EASE.BACK_IN]: easeBackIn,
  [PARTICLE_EASE.BACK_OUT]: easeBackOut,
  [PARTICLE_EASE.BACK_INOUT]: easeBackInOut,
  [PARTICLE_EASE.BOUNCE_OUT]: easeBounceOut,
};

function applyObject(t, easeId) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const fn = EASE_BY_ID[easeId | 0];
  return fn ? fn(t) : t;
}

function directLerp(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

function directQuadIn(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t;
}

function directBounce(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return easeBounceOut(t);
}

const DIRECT_FN = {
  lerp: directLerp,
  'quad-in': directQuadIn,
  bounce: directBounce,
};

function applyIfElse(t, easeId) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const id = easeId | 0;
  if (id === PARTICLE_EASE.QUAD_IN) return t * t;
  else if (id === PARTICLE_EASE.QUAD_OUT) return t * (2 - t);
  else if (id === PARTICLE_EASE.QUAD_INOUT) return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  else if (id === PARTICLE_EASE.CUBIC_IN) return t * t * t;
  else if (id === PARTICLE_EASE.CUBIC_OUT) {
    const u = t - 1;
    return u * u * u + 1;
  } else if (id === PARTICLE_EASE.CUBIC_INOUT) {
    if (t < 0.5) return 4 * t * t * t;
    const u = 2 * t - 2;
    return (t - 1) * u * u + 1;
  } else if (id === PARTICLE_EASE.EXPO_IN) return sampleExpoLut(EXPO_IN_LUT, t);
  else if (id === PARTICLE_EASE.EXPO_OUT) return sampleExpoLut(EXPO_OUT_LUT, t);
  else if (id === PARTICLE_EASE.EXPO_INOUT) return sampleExpoLut(EXPO_INOUT_LUT, t);
  else if (id === PARTICLE_EASE.BACK_IN) {
    const s = 1.70158;
    return t * t * ((s + 1) * t - s);
  } else if (id === PARTICLE_EASE.BACK_OUT) {
    const s = 1.70158;
    const u = t - 1;
    return u * u * ((s + 1) * u + s) + 1;
  } else if (id === PARTICLE_EASE.BACK_INOUT) {
    const s = 1.70158 * 1.525;
    if (t < 0.5) {
      const u = t * 2;
      return 0.5 * (u * u * ((s + 1) * u - s));
    }
    const u = t * 2 - 2;
    return 0.5 * (u * u * ((s + 1) * u + s) + 2);
  } else if (id === PARTICLE_EASE.BOUNCE_OUT) {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) {
      const u = t - 1.5 / d1;
      return n1 * u * u + 0.75;
    }
    if (t < 2.5 / d1) {
      const u = t - 2.25 / d1;
      return n1 * u * u + 0.9375;
    }
    const u = t - 2.625 / d1;
    return n1 * u * u + 0.984375;
  }
  return t;
}

const STYLE_FN = {
  switch: applyParticleEase,
  ifelse: applyIfElse,
  object: applyObject,
};

function fill(workload) {
  const rng = mulberry32(SEED);
  const ts = new Float32Array(N);
  const ids = new Uint8Array(N);
  const fixed =
    workload === 'lerp' ? PARTICLE_EASE.LERP
    : workload === 'quad-in' ? PARTICLE_EASE.QUAD_IN
    : workload === 'bounce' ? PARTICLE_EASE.BOUNCE_OUT
    : -1;
  for (let i = 0; i < N; i++) {
    ts[i] = 1e-6 + rng() * (1 - 2e-6);
    ids[i] = fixed >= 0 ? fixed : (rng() * EASE_COUNT) | 0;
  }
  return { ts, ids };
}

function checksumOf(fn, ts, ids) {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = fn(ts[i], ids[i]);
  return { sum: checksumFloats(out, N), out };
}

function maxAbs(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    const abs = d < 0 ? -d : d;
    if (abs > m) m = abs;
  }
  return m;
}

function runCase(style, workload) {
  const fn = style === 'direct' ? DIRECT_FN[workload] : STYLE_FN[style];
  if (!fn) throw new Error(`unknown style ${style} workload ${workload}`);
  const { ts, ids } = fill(workload);
  const mine = checksumOf(fn, ts, ids);
  const shipped = checksumOf(applyParticleEase, ts, ids);
  if (mine.sum !== shipped.sum) {
    throw new Error(
      `${style}/${workload} checksum ${mine.sum} != shipped ${shipped.sum} (maxAbs ${maxAbs(mine.out, shipped.out)})`
    );
  }
  const mask = N - 1;
  const timed = timeIt(`${style} ${workload}`, (iterations) => {
    let acc = 0;
    for (let i = 0; i < iterations; i++) {
      const k = i & mask;
      acc += fn(ts[k], ids[k]);
    }
    if (acc === Infinity) console.log(acc);
  }, { iterations: 500000 });
  return {
    style,
    workload,
    opsPerSec: timed.opsPerSec,
    ms: timed.ms,
    iterations: timed.iterations,
    checksum: mine.sum,
  };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[(s.length / 2) | 0];
}

async function main() {
  const args = parseArgs();
  const { Worker } = await import('node:worker_threads');
  const rounds = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (const workload of WORKLOADS) {
        for (const style of STYLES) {
          if (style === 'direct' && workload === 'mixed') continue;
          const res = await new Promise((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), {
            workerData: { role: 'case', style, workload },
          });
          w.once('message', resolve);
          w.once('error', reject);
        });
        res.round = round;
        rounds.push(res);
        console.log(
          `round ${round} ${workload} ${style}: ${Math.round(res.opsPerSec).toLocaleString()} ops/s  checksum ${res.checksum}`
        );
      }
    }
  }

  const cases = {};
  for (const workload of WORKLOADS) {
    cases[workload] = {};
    for (const style of STYLES) {
      const rows = rounds.filter((r) => r.workload === workload && r.style === style);
      if (rows.length === 0) continue;
      const sums = new Set(rows.map((r) => r.checksum));
      if (sums.size !== 1) throw new Error(`${workload}/${style} checksum drifted across rounds`);
      cases[workload][style] = {
        opsPerSec: median(rows.map((r) => r.opsPerSec)),
        sampleMs: median(rows.map((r) => r.ms)),
        iterations: rows[0].iterations,
        checksum: rows[0].checksum,
        rounds: rows.map((r) => r.opsPerSec),
      };
    }
    const base = cases[workload].switch.checksum;
    for (const style of STYLES) {
      const cell = cases[workload][style];
      if (!cell) continue;
      if (cell.checksum !== base) throw new Error(`${workload}/${style} checksum != switch`);
    }
  }

  console.log('\nMedian ops/s over 3 fresh isolates. Percent is versus the shipped switch.');
  for (const workload of WORKLOADS) {
    const sw = cases[workload].switch.opsPerSec;
    const parts = STYLES.filter((style) => cases[workload][style]).map((style) => {
      const ops = cases[workload][style].opsPerSec;
      const pct = ((ops / sw) - 1) * 100;
      const sign = pct >= 0 ? '+' : '';
      const ns = (1e9 / ops).toFixed(1);
      return `${style} ${Math.round(ops).toLocaleString()} (${sign}${pct.toFixed(1)}%, ${ns} ns)`;
    });
    console.log(`  ${workload}: ${parts.join('   ')}`);
  }

  const payload = {
    feature: 'ease-dispatch',
    seed: SEED,
    n: N,
    rounds: ROUNDS,
    note: 'switch is the shipped applyParticleEase. ifelse is the same bodies in source order. object is a plain object of functions keyed by numeric ease id. direct is the curve with no id test, a ceiling for the single-ease rows. One worker thread per cell. direct is skipped on mixed.',
    cases,
  };
  if (args.output) writeReport(String(args.output), payload);
  return payload;
}

const { isMainThread, workerData, parentPort } = await import('node:worker_threads');
if (!isMainThread && workerData?.role === 'case') {
  parentPort.postMessage(runCase(workerData.style, workerData.workload));
} else if (isCli(import.meta.url)) {
  await main();
}

export { main };
