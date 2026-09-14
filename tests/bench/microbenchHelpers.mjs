// Shared helpers for L1 isolated microbenches (Node, no workers).

import fs from 'node:fs';
import path from 'node:path';

/** Deterministic PRNG so before/after runs see identical scenarios. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Time `fn(iterations)` over `reps` runs; return median ms and ops/s.
 * @param {string} label
 * @param {(iterations: number) => void} fn
 * @param {{ iterations?: number, warmup?: number, reps?: number, silent?: boolean }} [opts]
 */
export function timeIt(label, fn, opts = {}) {
  const iterations = opts.iterations ?? 100000;
  const warmup = opts.warmup ?? Math.min(2000, iterations);
  const reps = opts.reps ?? 5;
  fn(warmup);
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    fn(iterations);
    times.push(performance.now() - t0);
  }
  times.sort((x, y) => x - y);
  const ms = times[(times.length / 2) | 0];
  const opsPerSec = (iterations / ms) * 1000;
  if (!opts.silent) {
    console.log(
      `${label}: median ${ms.toFixed(1)} ms for ${iterations} ops -> ${Math.round(opsPerSec).toLocaleString()} ops/s`
    );
  }
  return { label, ms, opsPerSec, iterations, reps };
}

/**
 * Minimal argv parser: `--key value`, `--flag`, positional ignored.
 * Numbers coerced when the string is purely numeric.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    i++;
    if (/^-?\d+(\.\d+)?$/.test(next)) {
      out[key] = Number(next);
    } else {
      out[key] = next;
    }
  }
  return out;
}

/** Write a JSON report under tests/results/ (or absolute path). */
export function writeReport(outputPath, payload) {
  const resolved = path.isAbsolute(outputPath)
    ? outputPath
    : path.resolve(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const body = {
    ...payload,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(resolved, JSON.stringify(body, null, 2) + '\n');
  console.log(`Wrote ${resolved}`);
  return resolved;
}
