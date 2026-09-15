#!/usr/bin/env node
// L1: dirty-pose skip-emit (Bevy Changed<T> analog). Not merged — measure only.
//
//   node tests/bench/poseSkipMicrobench.mjs

import assert from 'node:assert/strict';

import { parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const OUTPUT = args.output ? String(args.output) : null;
const N = Number(args.entities ?? 8000);

const x = new Float32Array(N);
const y = new Float32Array(N);
const tex = new Uint16Array(N);
const poseGen = new Uint32Array(N);
const lastGen = new Uint32Array(N);
const lastTex = new Uint16Array(N);
const emitted = new Uint16Array(N);

for (let i = 0; i < N; i++) {
  x[i] = i;
  y[i] = i * 0.5;
  tex[i] = i & 7;
  poseGen[i] = 1;
  lastGen[i] = 1;
  lastTex[i] = tex[i];
}

function emitAll() {
  let n = 0;
  for (let i = 0; i < N; i++) {
    emitted[n++] = i;
  }
  return n;
}

function emitDirty() {
  let n = 0;
  for (let i = 0; i < N; i++) {
    if (poseGen[i] === lastGen[i] && tex[i] === lastTex[i]) continue;
    lastGen[i] = poseGen[i];
    lastTex[i] = tex[i];
    emitted[n++] = i;
  }
  return n;
}

assert.equal(emitDirty(), 0);
poseGen[0] = 2;
assert.equal(emitDirty(), 1);
assert.equal(emitAll(), N);

const cases = {
  emitAll: timeIt('emit_all', (iters) => {
    for (let i = 0; i < iters; i++) emitAll();
  }, { iterations: Number(args.iters ?? 2000) }),
  emitDirty: timeIt('emit_dirty_skip', (iters) => {
    for (let i = 0; i < iters; i++) emitDirty();
  }, { iterations: Number(args.iters ?? 2000) }),
};

const report = { feature: 'pose-skip-emit', entities: N, cases };
if (OUTPUT) writeReport(OUTPUT, report);
