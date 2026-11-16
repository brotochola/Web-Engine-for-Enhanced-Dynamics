// Kernel: one alpha tween per entity, 65535 slots. Imports Tween.tick. Does not patch src/.
//
//   node tests/bench/tweenPoolMicrobench.mjs
//   node tests/bench/tweenPoolMicrobench.mjs --output tests/results/tween-65535/kernel.json
//
// tick: slot i tweens entity i (tweenStressScene's layout). scattered: slot i tweens a seeded
// shuffle of the same 65535 entities, so each per-entity read and write lands away from the last,
// as in a game whose tweens start in any order (E-275: paintTarget's SpriteRenderer.active read).
// 16-bit entity ids in both (the default width), so the tween's entity column is the same type.

import { Tween, tweenBufferBytes } from '../../src/core/tween.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const SEED = 0x65535;
const N = 65535;

/** Entity i for slot i. */
function identityIds() {
  const ids = new Uint32Array(N);
  for (let i = 0; i < N; i++) ids[i] = i;
  return ids;
}

/** The N entities in a seeded shuffled order (Fisher-Yates). */
function scatteredIds() {
  const rand = mulberry32(SEED);
  const ids = identityIds();
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = ids[i];
    ids[i] = ids[j];
    ids[j] = t;
  }
  return ids;
}

function setup(ids) {
  const entityCount = N;
  SpriteRenderer.active = new Uint8Array(entityCount);
  SpriteRenderer.active.fill(1);
  SpriteRenderer.alpha = new Float32Array(entityCount);
  SpriteRenderer.alpha.fill(1);
  SpriteRenderer.tint = new Uint32Array(entityCount);
  SpriteRenderer.scaleX = new Float32Array(entityCount);
  SpriteRenderer.scaleX.fill(1);
  SpriteRenderer.scaleY = new Float32Array(entityCount);
  SpriteRenderer.scaleY.fill(1);
  SpriteRenderer.renderDirty = new Uint8Array(entityCount);
  Tween.bind(new SharedArrayBuffer(tweenBufferBytes(N)), N);
  for (let i = 0; i < N; i++) {
    const slot = Tween.to(ids[i], { alpha: 0 }, 1e9, 0);
    if (slot !== i) throw new Error(`slot ${slot} !== ${i}`);
  }
}

function rewind() {
  Tween.elapsed.fill(0);
}

/** Alpha of the tweened entities, in slot order. */
function checksum(ids) {
  rewind();
  Tween.tick(16);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = SpriteRenderer.alpha[ids[i]];
  return checksumFloats(out, N);
}

function run(iterations, first, last) {
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    rewind();
    Tween.tick(16);
    acc += SpriteRenderer.alpha[first] + SpriteRenderer.alpha[last];
  }
  return acc;
}

/** N-28: Tween.tick loops over every slot, so a few long calls leave only OSR code. */
function warmSmallPool() {
  const W = 64;
  Tween.bind(new SharedArrayBuffer(tweenBufferBytes(W)), W);
  for (let i = 0; i < W; i++) Tween.to(i, { alpha: 0 }, 1e9, 0);
  warmNormalCompile(() => {
    Tween.elapsed.fill(0);
    Tween.tick(16);
  });
}

function timeCase(label, ids, iterations) {
  setup(ids);
  const sum = checksum(ids);
  if (!Number.isFinite(sum)) throw new Error(`${label} checksum is not finite`);
  const first = ids[0];
  const last = ids[N - 1];
  const probe = run(1, first, last);
  if (!Number.isFinite(probe)) throw new Error(`${label} probe is not finite`);
  const timed = timeIt(label, (iters) => {
    run(iters, first, last);
  }, { iterations });
  return { opsPerSec: timed.opsPerSec, n: timed.iterations, seed: SEED, checksum: sum, sampleMs: timed.ms };
}

function main() {
  const args = parseArgs();
  const iterations = args.iters || 4;
  setup(identityIds());
  warmSmallPool();
  const tick = timeCase('tween65535', identityIds(), iterations);
  const scattered = timeCase('tween65535Scattered', scatteredIds(), iterations);

  const payload = {
    seed: SEED,
    n: N,
    checksum: tick.checksum,
    cases: { tick, scattered },
  };
  if (args.output) writeReport(args.output, payload);
  Tween.unbind();
  return payload;
}

if (isCli(import.meta.url)) main();

export { main };
