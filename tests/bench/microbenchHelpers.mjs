// Shared helpers for L1 isolated microbenches (Node, no workers).

import fs from 'node:fs';
import path from 'node:path';

import { STEP_MS_FLOOR } from './benchmarkDefaults.mjs';

const TIMEIT_MAX_ITERATIONS = 50_000_000;

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
 * Each sample must last at least `STEP_MS_FLOOR` ms (same 3 ms noise floor as
 * stress STEP_MS). If the median is cheaper, iterations grow up to
 * TIMEIT_MAX_ITERATIONS. Arity-0 `fn` is invoked that many times per sample.
 * Pass `minMs: 0` to skip the floor (unit tests / one-shot probes).
 * @param {string} label
 * @param {(iterations: number) => void} fn
 * @param {{ iterations?: number, warmup?: number, reps?: number, silent?: boolean, minMs?: number, maxIterations?: number }} [opts]
 */
export function timeIt(label, fn, opts = {}) {
  const minMs = opts.minMs === undefined ? STEP_MS_FLOOR : Number(opts.minMs);
  const maxIterations = opts.maxIterations ?? TIMEIT_MAX_ITERATIONS;
  const reps = opts.reps ?? 5;
  const loopArity0 = fn.length === 0;
  let iterations = opts.iterations ?? (loopArity0 ? 1 : 100000);
  const startIterations = iterations;
  const invoke = (n) => {
    if (loopArity0) {
      for (let i = 0; i < n; i++) fn();
    } else {
      fn(n);
    }
  };

  const runReps = (n) => {
    const warmup = opts.warmup ?? Math.min(2000, n);
    invoke(warmup);
    const times = [];
    for (let r = 0; r < reps; r++) {
      const t0 = performance.now();
      invoke(n);
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    return times[(times.length / 2) | 0];
  };

  let ms = runReps(iterations);
  while (minMs > 0 && ms < minMs && iterations < maxIterations) {
    const next = Math.min(
      maxIterations,
      Math.max(iterations + 1, Math.ceil((iterations * minMs) / Math.max(ms, 1e-6) * 1.15))
    );
    if (next === iterations) break;
    if (!opts.silent) {
      console.log(
        `${label}: sample ${ms.toFixed(3)} ms < ${minMs} ms floor; iterations ${iterations} → ${next}`
      );
    }
    iterations = next;
    ms = runReps(iterations);
  }
  if (minMs > 0 && ms < minMs) {
    throw new Error(
      `${label}: timeIt sample still ${ms.toFixed(3)} ms after ${iterations} iterations (floor ${minMs} ms)`
    );
  }
  const opsPerSec = (iterations / ms) * 1000;
  if (!opts.silent) {
    const scaled = iterations !== startIterations ? ` (scaled from ${startIterations})` : '';
    console.log(
      `${label}: median ${ms.toFixed(1)} ms for ${iterations} ops${scaled} -> ${Math.round(opsPerSec).toLocaleString()} ops/s`
    );
  }
  return { label, ms, opsPerSec, iterations, reps, startIterations };
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
