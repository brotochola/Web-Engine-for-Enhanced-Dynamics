/**
 * H-TICKALL kernel: compact scratch then dense tickAll vs stride over the active list.
 * Checksum is the sum of visited ids. No workers.
 */
import { timeIt } from './microbenchHelpers.mjs';

const N = 60000;

function fillActive(n) {
  const active = new Uint32Array(n);
  for (let i = 0; i < n; i++) active[i] = i;
  return active;
}

function compactSum(active, count, stride, my, scratch) {
  let n = 0;
  for (let idx = my; idx < count; idx += stride) scratch[n++] = active[idx];
  let sum = 0;
  for (let i = 0; i < n; i++) sum = (sum + scratch[i]) | 0;
  return sum;
}

function strideSum(active, count, stride, my) {
  let sum = 0;
  for (let idx = my; idx < count; idx += stride) sum = (sum + active[idx]) | 0;
  return sum;
}

function runPair(label, stride, my) {
  const active = fillActive(N);
  const scratch = new Uint32Array(N);
  const compact = compactSum(active, N, stride, my, scratch);
  const direct = strideSum(active, N, stride, my);
  if (compact !== direct) {
    throw new Error(`${label} checksum ${compact} vs ${direct}`);
  }
  const a = timeIt(`${label} compact`, () => compactSum(active, N, stride, my, scratch));
  const b = timeIt(`${label} stride`, () => strideSum(active, N, stride, my));
  const pct = ((b.opsPerSec - a.opsPerSec) / a.opsPerSec) * 100;
  console.log(`${label}: stride vs compact ${pct.toFixed(1)}% ops/s  checksum ${compact}`);
  return { label, compactOps: a.opsPerSec, strideOps: b.opsPerSec, pct, checksum: compact };
}

const rows = [
  runPair('w1', 1, 0),
  runPair('w2-slot0', 2, 0),
  runPair('w4-slot0', 4, 0),
];

const out = { rows };
console.log(JSON.stringify(out));
