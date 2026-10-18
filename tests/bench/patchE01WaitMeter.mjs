// One-shot patcher for E-01: instrument the six identical waitUntilDoneSync
// closures in the UMD/IIFE Box2D + LiquidFun query impls.
//
// The bodies are byte-identical across all six files, so they are replaced
// together. The replacement keeps the exact load/check/wait order of the original
// and only starts the clock when the status is NOT already terminal, so the fast
// path costs one extra load and zero clock reads.
//
// Idempotent: re-running skips files already carrying the marker.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tests/bench -> tests -> repo root
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FILES = [
  'src/box2d/box2dCastRayAllImpl.js',
  'src/box2d/box2dOverlapCircleImpl.js',
  'src/box2d/box2dQueryAabbImpl.js',
  'src/box2d/box2dRayCastImpl.js',
  'src/box2d/liquidFunExtractImpl.js',
  'src/box2d/liquidFunQueryImpl.js',
];

const OLD = `  function waitUntilDoneSync() {
    for (;;) {
      var s = Atomics.load(i32, HDR_STATUS) | 0;
      if (s === STATUS_DONE || s === STATUS_ERROR) return;
      Atomics.wait(i32, HDR_STATUS, s);
    }
  }`;

const NEW = `  // E-01: the engine blocks on a sibling in exactly one place, and this is it.
  // Fold the blocked time into the shared meter so WAIT_MS is a measurement
  // instead of a hardcoded zero. These files are UMD/IIFE loaded by
  // importScripts, so they cannot import the ESM accessor; the meter is created
  // lazily on the global that the IIFE already receives. See src/util/waitMeter.js.
  var WAIT_METER = global.__weedWaitMeter || (global.__weedWaitMeter = { ms: 0 });

  function waitUntilDoneSync() {
    var s = Atomics.load(i32, HDR_STATUS) | 0;
    if (s === STATUS_DONE || s === STATUS_ERROR) return;
    // Clock starts only once we know we are actually going to block.
    var t0 = performance.now();
    for (;;) {
      if (s === STATUS_DONE || s === STATUS_ERROR) break;
      Atomics.wait(i32, HDR_STATUS, s);
      s = Atomics.load(i32, HDR_STATUS) | 0;
    }
    WAIT_METER.ms += performance.now() - t0;
  }`;

let changed = 0;
let skipped = 0;
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  const src = fs.readFileSync(abs, 'utf8');
  if (src.includes('__weedWaitMeter')) {
    skipped++;
    continue;
  }
  if (!src.includes(OLD)) {
    console.error(`MISS  ${rel} - body shape changed; patch manually.`);
    process.exitCode = 1;
    continue;
  }
  fs.writeFileSync(abs, src.replace(OLD, NEW), 'utf8');
  changed++;
  console.log(`ok    ${rel}`);
}
console.log(`\n${changed} patched, ${skipped} already done`);