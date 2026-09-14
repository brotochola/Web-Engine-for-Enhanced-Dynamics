// L1 kernels for skip-work hyps: contact publish Atomics, speed hypot, input edges.
//
// Usage:
//   node tests/bench/skipWorkMicrobench.mjs
//   node tests/bench/skipWorkMicrobench.mjs --output tests/results/skip-work-hyps/B0-micro.json

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Keyboard } from '../../src/core/keyboard.js';
import { calculateSpeed } from '../../src/util/utils.js';
import { parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

function publishPairs(pairs, gen, out) {
  let n = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    const a = pairs[i] | 0;
    const b = pairs[i + 1] | 0;
    Atomics.load(gen, a);
    Atomics.load(gen, b);
    out[n++] = a;
    out[n++] = b;
  }
  return n;
}

function deriveSpeed(vx, vy, speed, isStatic, count) {
  for (let i = 0; i < count; i++) {
    if (isStatic[i]) continue;
    speed[i] = calculateSpeed(vx[i], vy[i]);
  }
}

/**
 * @param {Record<string, unknown>} [cliArgs]
 */
export function runSkipWorkMicrobench(cliArgs = parseArgs()) {
  const BODIES = Number(cliArgs.bodies ?? 8000);
  const PAIRS = Number(cliArgs.pairs ?? 20000);
  const FRAMES = Number(cliArgs.frames ?? 400);

  const gen = new Int32Array(BODIES);
  const pairs = new Int32Array(PAIRS * 2);
  const out = new Int32Array(PAIRS * 2);
  for (let i = 0; i < PAIRS; i++) {
    pairs[i * 2] = i % BODIES;
    pairs[i * 2 + 1] = (i * 7 + 1) % BODIES;
  }
  for (let i = 0; i < BODIES; i++) gen[i] = i;

  const vx = new Float32Array(BODIES);
  const vy = new Float32Array(BODIES);
  const speed = new Float32Array(BODIES);
  const isStatic = new Uint8Array(BODIES);
  for (let i = 0; i < BODIES; i++) {
    vx[i] = (i % 17) * 0.3;
    vy[i] = (i % 13) * 0.2;
    isStatic[i] = i % 40 === 0 ? 1 : 0;
  }

  const map = {};
  for (let i = 0; i < 26; i++) map[String.fromCharCode(97 + i)] = i;
  const keys = new Int32Array(64);
  Keyboard.initialize(keys, map);

  console.log(`skip-work micro: bodies=${BODIES} pairs=${PAIRS} frames=${FRAMES}`);

  const h1On = timeIt('H1 publish Atomics (on)', (n) => {
    for (let f = 0; f < n; f++) publishPairs(pairs, gen, out);
  }, { iterations: FRAMES, warmup: 20, reps: 7 });

  const h1Off = timeIt('H1 publish skip', (n) => {
    for (let f = 0; f < n; f++) {
      /* kill switch */
    }
  }, { iterations: FRAMES, warmup: 20, reps: 7 });

  const h2On = timeIt('H2 hypot all dynamic', (n) => {
    for (let f = 0; f < n; f++) deriveSpeed(vx, vy, speed, isStatic, BODIES);
  }, { iterations: FRAMES, warmup: 20, reps: 7 });

  const h2Off = timeIt('H2 hypot skip', (n) => {
    for (let f = 0; f < n; f++) {
      /* kill switch */
    }
  }, { iterations: FRAMES, warmup: 20, reps: 7 });

  const h3On = timeIt('H3 Keyboard.updateEdgeFlags', (n) => {
    for (let f = 0; f < n; f++) Keyboard.updateEdgeFlags();
  }, { iterations: FRAMES * 10, warmup: 200, reps: 7 });

  const h3Off = timeIt('H3 edges skip', (n) => {
    for (let f = 0; f < n; f++) {
      /* needsGameScripts false */
    }
  }, { iterations: FRAMES * 10, warmup: 200, reps: 7 });

  Keyboard.initialize(null);

  const ratio = (on, off) => (on.ms > 0 ? off.ms / on.ms : null);
  const rows = [
    { hyp: 'H1', on: h1On, off: h1Off },
    { hyp: 'H2', on: h2On, off: h2Off },
    { hyp: 'H3', on: h3On, off: h3Off },
  ];

  console.log('\n=== skip-work micro (off/on; <1 skip cheaper — always) ===');
  for (const row of rows) {
    const r = ratio(row.on, row.off);
    console.log(
      `${row.hyp} on ${row.on.ms.toFixed(2)} ms | skip ${row.off.ms.toFixed(2)} ms | skip/on=${r.toFixed(3)}`
    );
  }

  return {
    name: 'skip-work-micro',
    bodies: BODIES,
    pairs: PAIRS,
    frames: FRAMES,
    h1On,
    h1Off,
    h2On,
    h2Off,
    h3On,
    h3Off,
    table: rows.map((row) => ({
      hyp: row.hyp,
      onMs: row.on.ms,
      skipMs: row.off.ms,
      skipOverOn: ratio(row.on, row.off),
    })),
  };
}

const isDirect =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) {
  const args = parseArgs();
  const report = runSkipWorkMicrobench(args);
  const outputPath = args.output
    ? String(args.output)
    : 'tests/results/skip-work-hyps/B0-micro.json';
  writeReport(outputPath, report);
}
