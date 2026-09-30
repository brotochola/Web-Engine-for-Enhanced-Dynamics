#!/usr/bin/env node
/**
 * Kernel: LogicWorker contact flow (ring drain + begin/end + stay purge) on a
 * real LogicWorker instance, pairs taken from the Predator fixture (bodies that
 * touch in the captured frame), 2% of pairs ending and re-beginning per frame.
 *
 *   node tests/bench/contactsMicrobench.mjs                      # shipped code
 *   node tests/bench/contactsMicrobench.mjs --output out.json
 *
 * Variants live here until they are decided (HOW_WE_MEASURE: kernels never
 * write src/). `base` is the shipped LogicWorker; a variant is a subclass that
 * overrides only the methods the hypothesis touches.
 */
import { collisionPairKey } from '../../src/util/utils.js';
import { begin, createContactWorker, end, logicWorkerClass } from './contactFlowHarness.mjs';
import { isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { loadPredatorFixture } from './predatorFixture.mjs';

/**
 * Touching pairs in the fixture frame (uniform grid, 3×3 cells). `reach` is
 * extra distance on top of the two radii: 0.5 is bodies in contact; a larger
 * reach adds sensor-like pairs for a denser regime.
 */
export function fixturePairs(fx, maxPairs = 120000, reach = 0.5) {
  const { x, y, radius, active, colliderActive } = fx.arrays;
  const n = fx.meta.n;
  const cell = 64;
  const cols = Math.ceil(fx.meta.worldWidth / cell) + 1;
  const rows = Math.ceil(fx.meta.worldHeight / cell) + 1;
  const head = new Int32Array(cols * rows).fill(-1);
  const next = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!active[i] || !colliderActive[i]) continue;
    const c = Math.min(cols - 1, Math.max(0, (x[i] / cell) | 0));
    const r = Math.min(rows - 1, Math.max(0, (y[i] / cell) | 0));
    next[i] = head[r * cols + c];
    head[r * cols + c] = i;
  }
  const pairs = [];
  for (let i = 0; i < n && pairs.length < maxPairs; i++) {
    if (!active[i] || !colliderActive[i]) continue;
    const c0 = Math.min(cols - 1, Math.max(0, (x[i] / cell) | 0));
    const r0 = Math.min(rows - 1, Math.max(0, (y[i] / cell) | 0));
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
        for (let j = head[r * cols + c]; j !== -1; j = next[j]) {
          if (j <= i) continue;
          const dx = x[j] - x[i];
          const dy = y[j] - y[i];
          const rr = radius[i] + radius[j] + reach;
          if (dx * dx + dy * dy < rr * rr) pairs.push(i, j);
        }
      }
    }
  }
  return pairs;
}

const VARIANTS = { base: (Base) => Base };

export async function setupContactKernel(opts = {}) {
  const fx = loadPredatorFixture();
  if (!fx) throw new Error('missing tests/fixtures/predator-frame.bin (run capturePredatorFixture.mjs)');
  const n = fx.meta.n;
  const Base = await logicWorkerClass();
  const make = VARIANTS[opts.variant || 'base'];
  if (!make) throw new Error(`unknown variant ${opts.variant}`);
  const { worker, gen } = await createContactWorker({
    n,
    Ctor: make(Base),
    totalWorkers: 3,
    workerIndex: opts.workerIndex ?? 0,
    types: fx.arrays.entityType,
  });
  const pairs = fixturePairs(fx, opts.maxPairs ?? 120000, opts.reach ?? 0.5);
  const P = pairs.length / 2;
  const rng = mulberry32(opts.seed ?? 0xc0417ac7);
  // Box2D order: about half the events arrive (larger id, smaller id).
  const swap = new Uint8Array(P);
  for (let p = 0; p < P; p++) swap[p] = rng() < 0.5 ? 1 : 0;
  for (let i = 0; i < n; i++) gen[i] = rng() < 0.3 ? 1 + ((rng() * 3) | 0) : 0;

  const pub = (fn, p) => {
    const a = pairs[2 * p];
    const b = pairs[2 * p + 1];
    if (swap[p]) fn(b, a, gen);
    else fn(a, b, gen);
  };
  for (let p0 = 0; p0 < P; p0 += 40000) {
    for (let p = p0; p < Math.min(P, p0 + 40000); p++) pub(begin, p);
    worker.processCollisionCallbacks();
  }
  worker.processCollisionCallbacks();

  const churn = Math.max(1, Math.round(P * (opts.churn ?? 0.02)));
  let cursor = 0;
  let prev = -1;
  function frame() {
    if (prev >= 0) for (let k = 0; k < churn; k++) pub(begin, (prev + k) % P);
    for (let k = 0; k < churn; k++) pub(end, (cursor + k) % P);
    prev = cursor;
    cursor = (cursor + churn) % P;
    worker.processCollisionCallbacks();
  }
  // What callers can observe: stay callbacks fired, and which pairs
  // isCollidingWith (frameCollisions.has) reports as touching.
  function checksum() {
    let stays = 0;
    for (let i = 0; i < n; i++) stays += worker.gameObjects[i].stays;
    let touching = 0;
    for (let p = 0; p < P; p++) {
      const a = pairs[2 * p];
      const b = pairs[2 * p + 1];
      if (worker.frameCollisions.has(collisionPairKey(a < b ? a : b, a < b ? b : a))) touching++;
    }
    return (stays * 31 + touching) >>> 0;
  }
  return { worker, n, pairs: P, churn, frame, checksum };
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const cases = {};
  const regimes = {};
  // contact: bodies touching in the fixture. dense: +24 px reach, the sensor /
  // crowd regime closer to the contact stay cost in the Predator trace.
  for (const [name, reach] of [['contact', 0.5], ['dense', 24]]) {
    const k = await setupContactKernel({ variant, reach });
    for (let f = 0; f < 60; f++) k.frame();
    regimes[name] = { pairs: k.pairs, churnPerFrame: k.churn, checksum: k.checksum() };
    cases[name] = timeIt(`contact flow ${variant} ${name} (${k.pairs} pairs)`, () => k.frame(), { iterations: 20, warmup: 20 });
  }
  const report = {
    feature: 'logic-contact-flow',
    functions: ['LogicWorker.processCollisionCallbacks', '_processBox2dCollisionCallbacks', '_applyContactBegin', '_applyContactEnd'],
    variant,
    seed: 0xc0417ac7,
    regimes,
    checksum: (regimes.contact.checksum * 31 + regimes.dense.checksum) >>> 0,
    note: 'Real LogicWorker instance (one of 3 workers), pairs from tests/fixtures/predator-frame.bin.',
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(JSON.stringify(regimes));
}

if (isCli(import.meta.url)) await main();
