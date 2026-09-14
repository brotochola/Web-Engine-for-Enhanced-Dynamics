// L1 microbench: Cantor pair keys (baseline) vs Uint16 bitpack (LOG-PAIR).
//
// Usage:
//   node tests/bench/log-pair-microbench.mjs
//   node tests/bench/log-pair-microbench.mjs --pairs 200000 --contacts 50000 --output tests/results/log-pair-micro.json

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { cantorPair, cantorUnpair } from '../../src/core/utils.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbench-helpers.mjs';

function collisionPairKey(minE, maxE) {
  return ((minE & 0xffff) << 16) | (maxE & 0xffff);
}

function collisionPairUnpack(key, out) {
  out.a = (key >>> 16) & 0xffff;
  out.b = key & 0xffff;
  return out;
}

function orderPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

/**
 * @param {Record<string, unknown>} [cliArgs]
 */
export function runLogPairMicrobench(cliArgs = parseArgs()) {
  const PAIRS = Number(cliArgs.pairs ?? 200000);
  const CONTACTS = Number(cliArgs.contacts ?? 50000);
  const SEED = Number(cliArgs.seed ?? 0xc0ffee);
  const outputPath = cliArgs.output ? String(cliArgs.output) : null;

  const rng = mulberry32(SEED);
  const mins = new Uint16Array(PAIRS);
  const maxs = new Uint16Array(PAIRS);
  const unique = new Set();
  let filled = 0;
  while (filled < PAIRS) {
    let a = (rng() * 60000) | 0;
    let b = (rng() * 60000) | 0;
    if (a === b) b = (b + 1) % 60000;
    const [minE, maxE] = orderPair(a, b);
    const bitKey = collisionPairKey(minE, maxE);
    if (unique.has(bitKey)) continue;
    unique.add(bitKey);
    mins[filled] = minE;
    maxs[filled] = maxE;
    filled++;
  }

  const scratch = { a: 0, b: 0 };
  const seenCantor = new Set();
  const seenBit = new Set();
  let mismatches = 0;
  const CHECK = Math.min(PAIRS, 50000);
  for (let i = 0; i < CHECK; i++) {
    const minE = mins[i];
    const maxE = maxs[i];
    const ck = cantorPair(minE, maxE);
    const bk = collisionPairKey(minE, maxE);
    cantorUnpair(ck, scratch);
    if (scratch.a !== minE || scratch.b !== maxE) mismatches++;
    collisionPairUnpack(bk, scratch);
    if (scratch.a !== minE || scratch.b !== maxE) mismatches++;
    seenCantor.add(ck);
    seenBit.add(bk);
  }
  if (mismatches !== 0) {
    throw new Error(`LOG-PAIR roundtrip mismatches: ${mismatches}`);
  }
  if (seenCantor.size !== CHECK || seenBit.size !== CHECK) {
    throw new Error(
      `LOG-PAIR uniqueness failed: cantor=${seenCantor.size} bit=${seenBit.size} expected=${CHECK}`
    );
  }
  console.log(`Correctness OK (${CHECK} pairs roundtrip + unique keys)`);

  const packCantor = timeIt(
    'pack cantorPair',
    (n) => {
      let sink = 0;
      const lim = Math.min(n, PAIRS);
      for (let i = 0; i < lim; i++) sink ^= cantorPair(mins[i], maxs[i]);
      if (sink === 0x7fffffff) console.log(sink);
    },
    { iterations: PAIRS }
  );

  const packBit = timeIt(
    'pack bitpack',
    (n) => {
      let sink = 0;
      const lim = Math.min(n, PAIRS);
      for (let i = 0; i < lim; i++) sink ^= collisionPairKey(mins[i], maxs[i]);
      if (sink === 0x7fffffff) console.log(sink);
    },
    { iterations: PAIRS }
  );

  const cantorKeys = new Float64Array(PAIRS);
  const bitKeys = new Uint32Array(PAIRS);
  for (let i = 0; i < PAIRS; i++) {
    cantorKeys[i] = cantorPair(mins[i], maxs[i]);
    bitKeys[i] = collisionPairKey(mins[i], maxs[i]);
  }

  const unpackCantor = timeIt(
    'unpack cantorUnpair',
    (n) => {
      const out = { a: 0, b: 0 };
      let sink = 0;
      const lim = Math.min(n, PAIRS);
      for (let i = 0; i < lim; i++) {
        cantorUnpair(cantorKeys[i], out);
        sink ^= out.a ^ out.b;
      }
      if (sink === 0x7fffffff) console.log(sink);
    },
    { iterations: PAIRS }
  );

  const unpackBit = timeIt(
    'unpack bitpack',
    (n) => {
      const out = { a: 0, b: 0 };
      let sink = 0;
      const lim = Math.min(n, PAIRS);
      for (let i = 0; i < lim; i++) {
        collisionPairUnpack(bitKeys[i], out);
        sink ^= out.a ^ out.b;
      }
      if (sink === 0x7fffffff) console.log(sink);
    },
    { iterations: PAIRS }
  );

  const contactCount = Math.min(CONTACTS, PAIRS);
  const setCantor = timeIt(
    'Set contact loop cantor',
    (n) => {
      const set = new Set();
      const lim = Math.min(n, contactCount);
      for (let i = 0; i < lim; i++) set.add(cantorPair(mins[i], maxs[i]));
      let hits = 0;
      for (let i = 0; i < lim; i++) {
        if (set.has(cantorPair(mins[i], maxs[i]))) hits++;
      }
      for (let i = 0; i < lim; i += 2) set.delete(cantorPair(mins[i], maxs[i]));
      if (hits === -1) console.log(hits);
    },
    { iterations: contactCount }
  );

  const setBit = timeIt(
    'Set contact loop bitpack',
    (n) => {
      const set = new Set();
      const lim = Math.min(n, contactCount);
      for (let i = 0; i < lim; i++) set.add(collisionPairKey(mins[i], maxs[i]));
      let hits = 0;
      for (let i = 0; i < lim; i++) {
        if (set.has(collisionPairKey(mins[i], maxs[i]))) hits++;
      }
      for (let i = 0; i < lim; i += 2) set.delete(collisionPairKey(mins[i], maxs[i]));
      if (hits === -1) console.log(hits);
    },
    { iterations: contactCount }
  );

  const report = {
    name: 'log-pair',
    hyp: 'LOG-PAIR',
    seed: SEED,
    pairs: PAIRS,
    contacts: contactCount,
    correctness: { ok: true, checked: CHECK },
    timings: {
      pack: { baseline: packCantor, optimized: packBit },
      unpack: { baseline: unpackCantor, optimized: unpackBit },
      setContact: { baseline: setCantor, optimized: setBit },
    },
    ratios: {
      pack: packBit.ms / packCantor.ms,
      unpack: unpackBit.ms / unpackCantor.ms,
      setContact: setBit.ms / setCantor.ms,
    },
  };

  console.log(
    `Ratios (opt/baseline): pack=${report.ratios.pack.toFixed(3)} unpack=${report.ratios.unpack.toFixed(3)} setContact=${report.ratios.setContact.toFixed(3)} (<1 = faster)`
  );

  if (outputPath) writeReport(outputPath, report);
  return report;
}

const isDirect =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) {
  runLogPairMicrobench();
}
