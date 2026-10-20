// E-10 kernel: does the contact pair key spend its time boxing a double?
//
// `pack16(min, max) = ((min & 0xffff) << 16) | (max & 0xffff)` lands in
// [0, 2^32). On 64-bit V8 with pointer compression a Smi is 31-bit signed, so
// **any pair whose high bit is set is a HeapNumber**, not an integer. A Map or Set
// keyed by HeapNumbers pays a boxed-double hash on every get/has.
//
// The bias `key - 0x80000000` maps [0, 2^32) onto [-2^31, 2^31) exactly, with no
// overflow (constant subtraction) and no collision: it is a bijection.
//
// This kernel times the *container operations* under each key encoding, holding
// the same number of inserts, lookups and deletes. That is the thing that changes;
// the arithmetic to build a key is not where the pairs are spent.
//
// Gate 1 (checksum) is the final contents of both tables - identical by
// construction, which is the point: the biased key must be a pure relabelling.
//
// E-10 in docs/internal/EXECUTION_PLAN.md.

import { parseArgs, timeIt, writeReport, isCli, checksumInts } from './microbenchHelpers.mjs';
import { packPair } from '../../src/util/entityIdWidth.js';

const DEFAULTS = {
  seed: 0xe0a0,
  // Predator: ~16.5k bodies, 2 logic workers, thousands of live contact pairs.
  // The engine's own pairs number in the thousands; 4096 is mid-range for a
  // fight and keeps the tables inside L2 so this measures hashing, not capacity.
  pairs: 4096,
  lookupsPerRound: 24000,
  rounds: 24,
  minE: 0,
  maxE: 16583,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shipped encoding: packPair as bound at the default 16-bit width, not a copy (review M9). */
const keyShipped = packPair;

/** Smi-range bias. Bijective with keyShipped; identical for every pair. */
const K32 = 0x80000000;
function keyBiased(minE, maxE) {
  return (((minE & 0xffff) << 16) | (maxE & 0xffff)) - K32;
}

/**
 * One round of the work the logic worker's contact path actually does:
 * `_pairSlot.set` on begin, `_pairSlot.get` / `beginSet.has` on every stay,
 * `delete` on end. Returns the number of stays that matched, so the optimiser
 * cannot drop the lookups.
 */
function round(map, set, pairs, lookupsPerRound) {
  let matched = 0;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    map.set(p.k, i);
    set.add(p.k);
  }
  for (let i = 0; i < lookupsPerRound; i++) {
    const p = pairs[i % pairs.length];
    if (map.has(p.k)) matched++;
    if (set.has(p.k)) matched++;
  }
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    map.delete(p.k);
  }
  set.clear();
  return matched;
}

function buildPairs({ seed, pairs, minE, maxE }, key) {
  const rnd = mulberry32(seed);
  const out = new Array(pairs);
  for (let i = 0; i < pairs; i++) {
    const a = minE + Math.floor(rnd() * (maxE - minE));
    let b = minE + Math.floor(rnd() * (maxE - minE));
    if (a === b) b = a + 1;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    out[i] = { k: key(lo, hi), lo, hi };
  }
  return out;
}

function tableChecksum(pairs, key) {
  // Final contents in insertion order: proves the two encodings address the same
  // pairs, so a timing difference cannot be a behavioural one.
  const map = new Map();
  for (let i = 0; i < pairs.length; i++) map.set(pairs[i].k, i);
  const keys = new Uint32Array(map.size);
  let w = 0;
  for (const k of map.keys()) keys[w++] = k >>> 0;
  keys.sort();
  return { checksum: checksumInts(keys, w), size: map.size };
}

/**
 * Does `pack16` ever leave V8's Smi range?
 *
 * THIS IS THE HYPOTHESIS, expressed as code. The claim under test is:
 *
 *   "`pack16` lands in [0, 2^32), so any key >= 2^31 is a HeapNumber."
 *
 * The premise is wrong, and the reason is one language detail: **JavaScript's `<<`
 * is a 32-bit SIGNED operation.** `(minE & 0xffff) << 16` for minE >= 32768 sets
 * the sign bit, so the result is negative, not a large positive. `pack16` therefore
 * returns values in the full signed 32-bit range [-2^31, 2^31-1], which on 64-bit
 * V8 with pointer compression is exactly the Smi range.
 *
 * So the shipped key is already an unboxed integer for every possible input, and
 * the bias in the hypothesis is a no-op relabelling of an already-fast path.
 * This function measures that instead of assuming it.
 */
function smiRangeProbe(minE, maxE) {
  let total = 0;
  let negative = 0;
  let boxed = 0;
  let outsideSmi31 = 0;
  let maxSeen = -Infinity;
  let minSeen = Infinity;
  for (let a = minE; a < maxE; a += 1) {
    for (let b = a + 1; b < maxE; b += 3) {
      const k = keyShipped(a, b);
      total++;
      if (k < 0) negative++;
      if (!(k >= -2147483648 && k <= 2147483647)) boxed++;
      if (!(k >= -1073741824 && k <= 1073741823)) outsideSmi31++;
      if (k > maxSeen) maxSeen = k;
      if (k < minSeen) minSeen = k;
    }
  }
  return {
    keysProbed: total,
    signedRange: [+minSeen, +maxSeen],
    negativeFraction: total ? +(negative / total).toFixed(4) : null,
    // Outside int32: a `<<` result never is, so this is 0 by construction (review M10).
    boxedFraction: total ? +(boxed / total).toFixed(4) : null,
    allWithinSmiRange: boxed === 0,
    // Outside [-2^30, 2^30): heap numbers in Chrome, whose Smis are 31-bit (E-54).
    outsideSmi31Fraction: total ? +(outsideSmi31 / total).toFixed(4) : null,
  };
}

/** Fraction of the built keys that are boxed, for the configured id range. */
function smiFraction(pairs, lo = -2147483648, hi = 2147483647) {
  let boxed = 0;
  for (const p of pairs) {
    if (!(p.k >= lo && p.k <= hi)) boxed++;
  }
  return boxed / pairs.length;
}

function bench(pairs, lookupsPerRound, rounds) {
  const map = new Map();
  const set = new Set();
  let matched = 0;
  // Warmup: the Map/Set must be optimised for this call shape before the clock,
  // and every bench in this repo got burned by measuring the first cold pass.
  for (let i = 0; i < 4; i++) matched += round(map, set, pairs, lookupsPerRound);
  const t = timeIt(
    'pair-key',
    () => {
      let m = 0;
      for (let r = 0; r < rounds; r++) m += round(map, set, pairs, lookupsPerRound);
      return m;
    },
    { iterations: 1 },
  );
  return { ...t, matched };
}

async function main() {
  const args = { ...DEFAULTS, ...parseArgs(process.argv.slice(2)) };
  const shipPairs = buildPairs(args, keyShipped);
  const biasPairs = buildPairs(args, keyBiased);

  const shipCk = tableChecksum(shipPairs, keyShipped);
  const biasCk = tableChecksum(biasPairs, keyBiased);

  const boxedFraction = smiFraction(shipPairs);
  // Chrome's 31-bit Smis (E-54): the configured pairs that are heap numbers there.
  const chromeBoxedFraction = smiFraction(shipPairs, -1073741824, 1073741823);

  const shipped = bench(shipPairs, args.lookupsPerRound, args.rounds);
  const biased = bench(biasPairs, args.lookupsPerRound, args.rounds);

  const pct = ((biased.opsPerSec - shipped.opsPerSec) / shipped.opsPerSec) * 100;

  const report = {
    name: 'pairKeySmi',
    seed: args.seed,
    cases: {
      shipped: { opsPerSec: shipped.opsPerSec, medianMs: shipped.medianMs },
      biased: { opsPerSec: biased.opsPerSec, medianMs: biased.medianMs },
    },
    checksum: shipCk.checksum,
    checksumBiased: biasCk.checksum,
    checksumMatch: shipCk.checksum === biasCk.checksum,
    pairCount: shipCk.size,
    shape: {
      pairs: args.pairs,
      lookupsPerRound: args.lookupsPerRound,
      roundsPerSample: args.rounds,
      idRange: [args.minE, args.maxE],
    },
    boxedKeyFraction: +boxedFraction.toFixed(4),
    chromeBoxedKeyFraction: +chromeBoxedFraction.toFixed(4),
    premiseProbe: {
      ...smiRangeProbe(0, 65536),
      claim: 'pack16 lands in [0, 2^32), so keys >= 2^31 are HeapNumbers',
      refuted:
        'JS `<<` is a 32-bit SIGNED operation, so minE >= 32768 yields a NEGATIVE ' +
        'key. pack16 spans the full signed 32-bit range, which is the Smi range in ' +
        'Node (V8 built without pointer compression). Chrome compresses pointers: its ' +
        'Smis are 31-bit, and outsideSmi31Fraction of these keys are heap numbers there (E-54).',
    },
    deltaPct: +pct.toFixed(2),
    note:
      'ops/s counts one full round: 2x pairs inserts into a Map and a Set, then ' +
      '2x lookupsPerRound has() probes, then pairs deletes. The bias changes only the ' +
      'integer the containers are keyed by - and premiseProbe shows that integer was ' +
      'already a Smi for every input.',
  };

  if (isCli(import.meta.url)) writeReport(args.output || 'tests/results/e10-pair-key-smi/kernel.json', report);
  console.log(JSON.stringify(report, null, 2));
}

if (isCli(import.meta.url)) main();