#!/usr/bin/env node
/**
 * Kernel: radixPainterOrder (the full painter rebuild Pixi runs when the slot
 * set changes) on Predator-sized queues, keys as the engine writes them.
 *   - sprites: every key is spriteYSortKey(footY, 128) = round(y) * 128.
 *   - mixed: 20 % fractional y * 128 keys (decorations, particles share the list).
 * Foot-Y comes from the Predator fixture; slot order is the fixture's entity order.
 *
 *   node tests/bench/painterRadixMicrobench.mjs
 *   node tests/bench/painterRadixMicrobench.mjs --output out.json
 */
import { createPainterState, radixPainterOrder, radixSortIndicesBySortKey, spriteYSortKey } from '../../src/util/sortIndexByKey.js';
import { checksumInts, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { loadPredatorFixture } from './predatorFixture.mjs';

// Hypotheses: radixPainterOrder variants.
const VARIANTS = { base: radixPainterOrder };

export function painterKeys(fx, n, fractionalShare, seed) {
  const { y, active } = fx.arrays;
  const rng = mulberry32(seed);
  const keys = new Float32Array(n);
  let j = 0;
  for (let i = 0; i < fx.meta.n && j < n; i++) {
    if (!active[i]) continue;
    keys[j++] = rng() < fractionalShare ? y[i] * 128 : spriteYSortKey(y[i], 128);
  }
  for (; j < n; j++) keys[j] = spriteYSortKey(rng() * fx.meta.worldHeight, 128);
  return new Uint32Array(keys.buffer);
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const order = VARIANTS[variant];
  if (!order) throw new Error(`unknown variant ${variant}`);
  const fx = loadPredatorFixture();
  if (!fx) throw new Error('missing tests/fixtures/predator-frame.bin (run capturePredatorFixture.mjs)');
  const n = Number(args.n ?? 16384);
  const cases = {};
  const regimes = {};
  let checksum = 0;
  for (const [name, share] of [['sprites', 0], ['mixed', 0.2]]) {
    const keys = painterKeys(fx, n, share, 0x9a1e7);
    const state = createPainterState(n);
    const out = order(state, null, n, keys);
    const h = checksumInts(out, n);
    // The shipped sort on the same input is the reference for every variant.
    const ref = new Uint32Array(n);
    for (let i = 0; i < n; i++) ref[i] = i;
    radixSortIndicesBySortKey(ref, n, keys, new Uint32Array(n), new Uint32Array(256));
    if (checksumInts(ref, n) !== h) throw new Error(`${variant} ${name}: order differs from the shipped radix`);
    regimes[name] = { n, fractionalShare: share };
    checksum = (Math.imul(checksum, 31) + h) >>> 0;
    cases[name] = timeIt(`radixPainterOrder ${variant} ${name} (${n} slots)`, () => order(state, null, n, keys), {
      iterations: 100,
      warmup: 50,
    });
  }
  const report = {
    feature: 'painter-radix',
    functions: ['radixPainterOrder', 'radixSortIndicesBySortKey'],
    variant,
    n,
    seed: 0x9a1e7,
    regimes,
    checksum,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(checksum);
}

if (isCli(import.meta.url)) await main();
