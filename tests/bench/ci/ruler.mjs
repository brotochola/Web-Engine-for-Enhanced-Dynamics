/**
 * The ruler: three loops that import nothing of the engine and NEVER CHANGE, timed at the start and at the end of every CI job.
 * GitHub hands out another CPU each time (40 % apart and more): a measure kept today is compared with one of another day by
 * the ruler's times on each, never by its own numbers alone. A change here breaks every measure kept before it: add another
 * loop with another name instead, and leave these as they are.
 *
 *   float   a float32 column integrated in place, 4 096 rows (the workers' SoA loops, L1)
 *   memory  a walk of a random cycle over 8 MB of int32 (a miss a step: entities reached by index)
 *   branch  a branchy integer loop over bytes (culls, flags)
 *
 *   node tests/bench/ci/ruler.mjs
 */
import { isCli } from '../microbenchHelpers.mjs';

const ROWS = 4096;
const WALK = 1 << 21;

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 0x1000000;
}

function floatLoop(x, v, rounds) {
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < ROWS; i++) {
      const nx = x[i] + v[i] * 0.016;
      if (nx > 1000 || nx < 0) v[i] = -v[i];
      x[i] = nx;
    }
  }
  return x[17];
}

function memoryLoop(next, steps, from) {
  let at = from;
  for (let i = 0; i < steps; i++) at = next[at];
  return at;
}

function branchLoop(flags, rounds) {
  let n = 0;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < ROWS; i++) {
      const f = flags[i];
      if ((f & 1) !== 0) {
        if ((f & 2) !== 0) n += 3;
        else n ^= i;
      } else if ((f & 4) !== 0) n = (n + f) | 0;
    }
  }
  return n;
}

/** Milliseconds of work, each loop: rows (or steps) a second, the median of nine tries. */
export function runRuler() {
  const rnd = lcg(7);
  const x = Float32Array.from({ length: ROWS }, () => rnd() * 1000);
  const v = Float32Array.from({ length: ROWS }, () => (rnd() - 0.5) * 100);
  const flags = Uint8Array.from({ length: ROWS }, () => (rnd() * 8) | 0);
  const order = Int32Array.from({ length: WALK }, (_, i) => i);
  for (let i = WALK - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const next = new Int32Array(WALK);
  for (let i = 0; i < WALK; i++) next[order[i]] = order[(i + 1) % WALK];
  let sink = 0;
  const rate = (f, units) => {
    for (let k = 0; k < 20; k++) sink += f();
    const tries = [];
    for (let t = 0; t < 9; t++) {
      const t0 = performance.now();
      let n = 0;
      while (performance.now() - t0 < 60) {
        sink += f();
        n++;
      }
      tries.push((n * units * 1000) / (performance.now() - t0));
    }
    return Math.round(tries.sort((a, b) => a - b)[4]);
  };
  const out = {
    float: rate(() => floatLoop(x, v, 8), ROWS * 8),
    memory: rate(() => memoryLoop(next, 20000, sink & 1023), 20000),
    branch: rate(() => branchLoop(flags, 8), ROWS * 8),
  };
  if (!Number.isFinite(sink)) throw new Error('ruler');
  return out;
}

if (isCli(import.meta.url)) console.log(JSON.stringify(runRuler()));
