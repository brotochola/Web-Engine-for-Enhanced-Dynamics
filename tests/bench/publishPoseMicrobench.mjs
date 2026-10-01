#!/usr/bin/env node
/**
 * Kernel for the shipped publishPose inside weedjsPost.js.
 * The function is a closure, so this evals the real script (importScripts
 * stubbed) and calls weedjsPublishPose. It does not copy the loop.
 * `--variant ph1` applies the epoch fast-path as a source diff before eval.
 *
 *   node tests/bench/publishPoseMicrobench.mjs --variant base
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { checksumInts, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const box2dDir = path.join(repoRoot, 'src/box2d');

const PH1_EDITS = [
  [
    `for (let d = 0; d < n; d++) {
      const i = list[d];
      if (
        bodyGeneration &&
        seenBodyGeneration &&
        (seenBodyGeneration[i] | 0) !== (Atomics.load(bodyGeneration, i) | 0)
      ) {
        continue;
      }`,
    `const epoch = poseGenEpoch ? (Atomics.load(poseGenEpoch, 0) | 0) : 0;
    const epochSame = !poseGenEpoch || epoch === (seenPoseGenEpoch | 0);
    for (let d = 0; d < n; d++) {
      const i = list[d];
      if (
        !epochSame &&
        bodyGeneration &&
        seenBodyGeneration &&
        (seenBodyGeneration[i] | 0) !== (Atomics.load(bodyGeneration, i) | 0)
      ) {
        continue;
      }`,
  ],
  [
    'poseFrame++;',
    `if (poseGenEpoch) seenPoseGenEpoch = epoch;
    poseFrame++;`,
  ],
];

export function loadPost(variant) {
  let src = fs.readFileSync(path.join(box2dDir, 'weedjsPost.js'), 'utf8');
  if (variant === 'ph1') {
    for (const [from, to] of PH1_EDITS) {
      if (!src.includes(from)) throw new Error(`ph1 anchor missing: ${from.slice(0, 80)}`);
      src = src.replace(from, to);
    }
  } else if (variant !== 'base') {
    throw new Error(`unknown variant ${variant}`);
  }
  const prev = {
    self: globalThis.self,
    importScripts: globalThis.importScripts,
  };
  globalThis.self = globalThis;
  globalThis.Module = globalThis.Module || {};
  globalThis.importScripts = (...files) => {
    for (const f of files) {
      const code = fs.readFileSync(path.join(box2dDir, f), 'utf8');
      vm.runInThisContext(code, { filename: f });
    }
  };
  try {
    vm.runInThisContext(src, { filename: 'weedjsPost.js' });
  } finally {
    if (prev.importScripts === undefined) delete globalThis.importScripts;
    else globalThis.importScripts = prev.importScripts;
  }
  if (typeof globalThis.weedjsPublishPose !== 'function') {
    throw new Error('weedjsPublishPose was not installed');
  }
  return globalThis.weedjsPublishPose;
}

function setup(n, seed) {
  const rng = mulberry32(seed);
  const list = new Int32Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const rotC = new Float32Array(n);
  const rotS = new Float32Array(n);
  const generation = new Int32Array(new SharedArrayBuffer(n * 4));
  const seen = new Int32Array(n);
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < n; i++) {
    list[i] = i;
    x[i] = rng() * 10000;
    y[i] = rng() * 5000;
    rotC[i] = 1;
    rotS[i] = 0;
    const g = (rng() * 4) | 0;
    Atomics.store(generation, i, g);
    seen[i] = g;
  }
  const poseSync = new Int32Array(new SharedArrayBuffer(8));
  const mk = () => ({
    x: new Float32Array(n),
    y: new Float32Array(n),
    rotC: new Float32Array(n),
    rotS: new Float32Array(n),
  });
  const poseBuffers = [mk(), mk()];
  globalThis.weedjsBindPoseBench({
    poseSync,
    poseBuffers,
    denseList: list,
    denseCount: n,
    views: { x, y, rotC, rotS },
    bodyGeneration: generation,
    seenBodyGeneration: seen,
    poseFrame: 0,
    poseGenEpoch: epoch,
    seenPoseGenEpoch: 0,
  });
  const bits = new Uint32Array(1);
  const bitsF = new Float32Array(bits.buffer);
  function mix(h, v) {
    bitsF[0] = v;
    return Math.imul(h ^ bits[0], 16777619) >>> 0;
  }
  function checksum() {
    globalThis.weedjsPublishPose();
    const buf = poseBuffers[(poseSync[0] - 1) & 1];
    let h = 2166136261;
    for (let i = 0; i < n; i += 17) {
      h = mix(h, buf.x[i]);
      h = mix(h, buf.y[i]);
      h = mix(h, buf.rotC[i]);
      h = mix(h, buf.rotS[i]);
    }
    return checksumInts([h, poseSync[0]], 2);
  }
  return {
    frame() {
      globalThis.weedjsPublishPose();
    },
    checksum,
  };
}

function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const n = Number(args.n ?? 16500);
  const seed = Number(args.seed ?? 0x0b2d);
  loadPost(variant);
  const k = setup(n, seed);
  const checksum = k.checksum();
  const cases = {
    publish: timeIt(`publishPose ${variant} (n=${n})`, () => k.frame(), { iterations: 40, warmup: 10 }),
  };
  const report = {
    feature: 'publish-pose',
    variant,
    functions: ['publishPose'],
    n,
    seed,
    checksum,
    note: 'Shipped weedjsPost publishPose. ph1 is an in-memory epoch fast-path. Gens match, so both publish every body.',
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} publish ${cases.publish.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) main();
