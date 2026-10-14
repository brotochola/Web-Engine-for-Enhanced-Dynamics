/**
 * Is the plan's core claim about Math.hypot true?
 *
 * H-03 asserts that in V8 `Math.hypot` is "an implementation with deliberate
 * overflow/underflow handling and special-casing of +/-Infinity and NaN, costing
 * roughly an order of magnitude more" than `Math.sqrt(x*x + y*y)`.
 *
 * "Roughly an order of magnitude" is the whole claim. If it is off by a factor
 * of two, swapping a call whose result feeds a per-vertex geometry loop is not
 * worth the loss of overflow safety. If it is real, the swap is free money at
 * the sites where the inputs are bounded.
 *
 * This measures the two builtins directly, in the same alternating-round shape
 * as the other kernels: one process per side cannot resolve 3 %.
 *
 * Also measured: how the ratio behaves as the inputs grow, because "bounded
 * inputs" is the precondition the swap depends on and the guard only pays off
 * when the values are large enough for overflow/underflow to matter at all.
 */
import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(HERE, '../results/h03-hypot');

const ROUNDS = 5;
const FLOOR_PCT = 3;

/** Magnitudes bracketing the "bounded pixel space" the plan relies on. */
const SCALES = [
  { name: 'sub-unit (1e-3)', v: 1e-3 },
  { name: 'unit', v: 1 },
  { name: 'pixel (~1e3)', v: 1e3 },
  { name: 'world (~1e4)', v: 1e4 },
  { name: 'large (~1e7)', v: 1e7 },
];

function median(v) {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Both variants consume the array and accumulate, so neither call can be
 * eliminated as dead. The accumulator is returned so the JIT keeps it live.
 */
function benchHypot(n, xs, ys) {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const k = i & (xs.length - 1);
    acc += Math.hypot(xs[k], ys[k]);
  }
  return acc;
}

function benchSqrt(n, xs, ys) {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const k = i & (xs.length - 1);
    const x = xs[k];
    const y = ys[k];
    acc += Math.sqrt(x * x + y * y);
  }
  return acc;
}

/** Pairs that are neither degenerate nor exactly representable, so neither call folds. */
function makePairs(count, magnitude) {
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  let s = 0x9e3779b9;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = 0; i < count; i++) {
    xs[i] = magnitude * (0.3 + rnd());
    ys[i] = magnitude * (0.3 + rnd());
  }
  return { xs, ys };
}

function main() {
  const args = parseArgs();
  const cases = {};

  for (const scale of SCALES) {
    const { xs, ys } = makePairs(4096, scale.v);
    const hypotRuns = [];
    const sqrtRuns = [];
    let sqrtWins = 0;

    for (let r = 0; r < ROUNDS; r++) {
      const h = () => timeIt(`hypot#${r}@${scale.name}`, (n) => benchHypot(n, xs, ys));
      const s = () => timeIt(`sqrt#${r}@${scale.name}`, (n) => benchSqrt(n, xs, ys));
      // Counterbalanced.
      let th, ts;
      if (r % 2 === 0) {
        th = h();
        ts = s();
      } else {
        ts = s();
        th = h();
      }
      hypotRuns.push(th.opsPerSec);
      sqrtRuns.push(ts.opsPerSec);
      if (ts.opsPerSec > th.opsPerSec) sqrtWins++;
    }

    const medH = median(hypotRuns);
    const medS = median(sqrtRuns);
    const gain = ((medS / medH) - 1) * 100;

    // Exactness check: where do the two agree bit-for-bit?
    let bitIdentical = 0;
    let maxUlp = 0;
    for (let i = 0; i < xs.length; i++) {
      const a = Math.hypot(xs[i], ys[i]);
      const b = Math.sqrt(xs[i] * xs[i] + ys[i] * ys[i]);
      if (Object.is(a, b)) bitIdentical++;
      else {
        const ulp = Math.abs(a - b) / Number.EPSILON / Math.max(1, Math.abs(a));
        if (ulp > maxUlp) maxUlp = ulp;
      }
    }

    cases[scale.name] = {
      hypotOpsPerSec: medH,
      sqrtOpsPerSec: medS,
      sqrtGainPct: Number(gain.toFixed(2)),
      ratio: Number((medH / medS).toFixed(2)),
      sqrtWins,
      rounds: ROUNDS,
      bitIdenticalFraction: Number((bitIdentical / xs.length).toFixed(4)),
      maxUlp,
    };
  }

  const payload = {
    kernel: 'hypotVsSqrt',
    hypothesis: 'H-03',
    protocol: { rounds: ROUNDS, order: 'counterbalanced per round', floorPct: FLOOR_PCT },
    claimUnderTest: 'Math.hypot costs roughly an order of magnitude more than Math.sqrt(x*x+y*y)',
    cases,
    scope:
      'builtin-vs-builtin cost only. Says nothing about how often these sites are reached; ' +
      'none of them appears in the CPU trace.',
  };

  console.log('scale                hypot ops/s     sqrt ops/s   ratio   gain    sqrt wins   bit-identical');
  for (const scale of SCALES) {
    const c = cases[scale.name];
    console.log(
      `${scale.name.padEnd(20)} ${Math.round(c.hypotOpsPerSec).toLocaleString().padStart(12)} ` +
        `${Math.round(c.sqrtOpsPerSec).toLocaleString().padStart(14)} ` +
        `${c.ratio.toFixed(2).padStart(6)}x ${c.sqrtGainPct.toFixed(1).padStart(6)}% ` +
        `${(c.sqrtWins + '/' + ROUNDS).padStart(9)} ${(c.bitIdenticalFraction * 100).toFixed(1).padStart(12)}%`,
    );
  }

  writeReport(args.output ? String(args.output) : path.join(REPORT_DIR, 'kernel.json'), payload);
}

if (isCli(import.meta.url)) {
  main();
}