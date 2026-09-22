/**
 * Pose SAB copy: every dense body vs the mover list (5%).
 *   node tests/bench/movedBodiesPoseMicrobench.mjs
 */
import assert from 'node:assert/strict';

import { timeIt } from './microbenchHelpers.mjs';

const N = 48000;
const MOVERS = (N * 0.05) | 0;

function fill(arr, v) {
  for (let i = 0; i < N; i++) arr[i] = v + i * 0.001;
}

const x = new Float32Array(N);
const y = new Float32Array(N);
const c = new Float32Array(N);
const s = new Float32Array(N);
fill(x, 1);
fill(y, 2);
fill(c, 1);
fill(s, 0);
const outX = new Float32Array(N);
const outY = new Float32Array(N);
const outC = new Float32Array(N);
const outS = new Float32Array(N);
const movers = new Uint32Array(MOVERS);
for (let i = 0; i < MOVERS; i++) movers[i] = (i * 17) % N;

function copyAll() {
  outX.set(x);
  outY.set(y);
  outC.set(c);
  outS.set(s);
}

function copyMovers() {
  for (let k = 0; k < MOVERS; k++) {
    const i = movers[k];
    outX[i] = x[i];
    outY[i] = y[i];
    outC[i] = c[i];
    outS[i] = s[i];
  }
}

copyAll();
const before = outX[(movers[0])] ;
copyMovers();
assert.equal(outX[movers[0]], x[movers[0]]);
assert.equal(before, x[movers[0]]);

timeIt(`pose copy all n=${N}`, copyAll, { iterations: 30, warmup: 5 });
timeIt(`pose copy movers n=${MOVERS}`, copyMovers, { iterations: 30, warmup: 5 });
console.log('movedBodiesPoseMicrobench: checksum passed');
