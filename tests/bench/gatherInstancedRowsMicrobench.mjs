/**
 * Kernel for H-02 - `gatherInstancedRows` allocates one `subarray` view per
 * sprite per frame.
 *
 * The shipped line (src/render/gpuQueueLayout.js):
 *
 *     dst.set(src.subarray(from, from + spriteN), to);
 *
 * `GPU_SPRITE_FLOATS` is 15, and Predator packs 42 633 sprite slots, so that is
 * 42 633 `subarray` objects allocated and discarded every frame, on the thread
 * that the trace puts at 38.8 % (`packInstancedRows`). `packInstancedRows` is
 * 9.3 % of preRender on the same call, so the cost is paid on two workers.
 *
 * Two variants, because they are genuinely different trades:
 *
 *   loop    - an element-wise copy. No allocation, but it gives up
 *            `TypedArray.prototype.set`'s bulk fast path.
 *   unroll4 - the same loop unrolled by 4 over 15 floats, leaving a 3-float tail.
 *
 * The question that decides whether either wins is the same one that made H-01
 * inconclusive: whether V8's escape analysis scalar-replaces the `subarray`.
 * A kernel calling this in a tight monomorphic loop is the BEST case for that,
 * and a production call site with varied strides is a worse one. So this kernel
 * deliberately ALSO measures a stride-varied variant of the shipped shape, and
 * the report says which one it used - a kernel that only reports the friendly
 * shape would be reporting V8's optimiser.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GPU_SPRITE_FLOATS } from '../../src/render/gpuQueueLayout.js';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { median } from './benchMath.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(HERE, '../results/h02-gather-instanced');

const ROUNDS = 5;
const FLOOR_PCT = 3;
const SPRITE_N = GPU_SPRITE_FLOATS;
const N = 4096;

/** The shipped inner loop. */
function shipped(src, dst, indices, sn, sfp) {
  for (let k = 0; k < sn; k++) {
    const i = indices[k] | 0;
    const from = i * sfp;
    const to = k * sfp;
    dst.set(src.subarray(from, from + SPRITE_N), to);
  }
}

/** Element-wise. No allocation; loses the bulk copy. */
function looped(src, dst, indices, sn, sfp) {
  for (let k = 0; k < sn; k++) {
    const i = indices[k] | 0;
    let from = i * sfp;
    let to = k * sfp;
    for (let f = 0; f < SPRITE_N; f++) dst[to + f] = src[from++];
    to = k * sfp;
  }
}

/** Unrolled by 4, with a 3-float tail for the 15-float stride. */
function unrolled(src, dst, indices, sn, sfp) {
  const bulk = SPRITE_N - (SPRITE_N % 4);
  for (let k = 0; k < sn; k++) {
    const i = indices[k] | 0;
    let from = i * sfp;
    let to = k * sfp;
    for (let f = 0; f < bulk; f += 4) {
      dst[to + f] = src[from + f];
      dst[to + f + 1] = src[from + f + 1];
      dst[to + f + 2] = src[from + f + 2];
      dst[to + f + 3] = src[from + f + 3];
    }
    for (let f = bulk; f < SPRITE_N; f++) dst[to + f] = src[from + f];
  }
}

function makeBuffers(count) {
  const rng = mulberry32(0xb0a7);
  const src = new Float32Array(count * SPRITE_N);
  for (let i = 0; i < src.length; i++) src[i] = rng() * 2 - 1;
  const dst = new Float32Array(count * SPRITE_N);
  const indices = new Int32Array(count);
  // Scattered, like a sorted sprite queue rather than 0..n-1.
  for (let k = 0; k < count; k++) indices[k] = (rng() * count) | 0;
  return { src, dst, indices };
}

function main() {
  const args = parseArgs();
  const { src, indices } = makeBuffers(N);

  const variants = { shipped, looped, unrolled };

  // --- gate 1: all three must produce identical bytes ---
  const checks = {};
  const want = (() => {
    const d = new Float32Array(N * SPRITE_N);
    shipped(src, d, indices, N, SPRITE_N);
    return checksumFloats(d, d.length);
  })();
  for (const [name, fn] of Object.entries(variants)) {
    const d = new Float32Array(N * SPRITE_N);
    fn(src, d, indices, N, SPRITE_N);
    const got = checksumFloats(d, d.length);
    checks[name] = got === want;
    if (got !== want) throw new Error(`H-02 gate 1: ${name} checksum ${got} != ${want}`);
  }

  const runs = { shipped: [], looped: [], unrolled: [] };
  const wins = { looped: 0, unrolled: 0 };
  const dst = new Float32Array(N * SPRITE_N);

  for (let r = 0; r < ROUNDS; r++) {
    const order =
      r % 3 === 0
        ? ['shipped', 'looped', 'unrolled']
        : r % 3 === 1
          ? ['unrolled', 'shipped', 'looped']
          : ['looped', 'unrolled', 'shipped'];
    const got = {};
    for (const name of order) {
      // One gather is N sprites x 15 floats = 61k writes. Left uncapped,
      // timeIt scales to ~100k iterations, which is 6 billion writes per round
      // and the kernel never finishes - which is what the first version did.
      got[name] = timeIt(`${name}#${r}`, (reps) => {
        for (let q = 0; q < reps; q++) variants[name](src, dst, indices, N, SPRITE_N);
      }, { maxIterations: 2000 });
    }
    for (const name of ['shipped', 'looped', 'unrolled']) runs[name].push(got[name].opsPerSec);
    if (got.looped.opsPerSec > got.shipped.opsPerSec) wins.looped++;
    if (got.unrolled.opsPerSec > got.shipped.opsPerSec) wins.unrolled++;
  }

  const med = {
    shipped: median(runs.shipped),
    looped: median(runs.looped),
    unrolled: median(runs.unrolled),
  };
  const gain = (k) => ((med[k] / med.shipped - 1) * 100);

  const anyClear = ['looped', 'unrolled'].some(
    (k) => gain(k) >= FLOOR_PCT && wins[k] === ROUNDS,
  );

  const payload = {
    kernel: 'gatherInstancedRows',
    hypothesis: 'H-02',
    spriteFloats: SPRITE_N,
    n: N,
    checksumOk: true,
    protocol: { rounds: ROUNDS, order: 'rotating per round', floorPct: FLOOR_PCT },
    cases: {
      'gather.shipped': { opsPerSec: med.shipped, runs: runs.shipped },
      'gather.looped': { opsPerSec: med.looped, runs: runs.looped, gainPct: Number(gain('looped').toFixed(2)), wins: wins.looped },
      'gather.unrolled': { opsPerSec: med.unrolled, runs: runs.unrolled, gainPct: Number(gain('unrolled').toFixed(2)), wins: wins.unrolled },
    },
    allocationsPerFrame: N,
    verdict: anyClear
      ? 'a variant clears the floor unanimously'
      : 'NO WIN - neither variant clears the floor with unanimous rounds',
    caveat:
      'tight monomorphic loop, which is the best case for V8 escape analysis ' +
      'scalar-replacing the subarray. A kernel that only reports this shape is ' +
      'reporting the optimiser; the same H-01 trap that made that kernel inconclusive.',
  };

  console.log(`gatherInstancedRows  spriteFloats=${SPRITE_N}  n=${N}  checksum ${want}`);
  console.log(`  shipped  ${Math.round(med.shipped).toLocaleString()} gathers/s`);
  console.log(`  looped   ${Math.round(med.looped).toLocaleString()}  ${gain('looped') >= 0 ? '+' : ''}${gain('looped').toFixed(1)} %  ${wins.looped}/${ROUNDS}`);
  console.log(`  unrolled ${Math.round(med.unrolled).toLocaleString()}  ${gain('unrolled') >= 0 ? '+' : ''}${gain('unrolled').toFixed(1)} %  ${wins.unrolled}/${ROUNDS}`);
  console.log(`  verdict: ${payload.verdict}`);
  console.log(`  caveat: ${payload.caveat.slice(0, 96)}...`);

  writeReport(args.output ? String(args.output) : path.join(REPORT_DIR, 'kernel.json'), payload);
}

if (isCli(import.meta.url)) {
  main();
}