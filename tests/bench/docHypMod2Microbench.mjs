/**
 * Buffer index of the double render queue.
 * Same sequence 0,1,0,1 from a counter that starts at 0 and adds 1.
 * % 2 is the N=1 writer and Pixi. & 1 is the sharded writer. xor flips
 * next to the increment. Checksum is the count of odd steps (floor(n/2)).
 */
import { timeIt } from './microbenchHelpers.mjs';

function expectSum(n) {
  return (n / 2) | 0;
}

function sumMod(n) {
  let frame = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum = (sum + (frame % 2)) | 0;
    frame = (frame + 1) | 0;
  }
  return sum;
}

function sumAnd(n) {
  let frame = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum = (sum + (frame & 1)) | 0;
    frame = (frame + 1) | 0;
  }
  return sum;
}

function sumXor(n) {
  let buf = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum = (sum + buf) | 0;
    buf ^= 1;
  }
  return sum;
}

const CHECK_N = 8;
const modCheck = sumMod(CHECK_N);
const andCheck = sumAnd(CHECK_N);
const xorCheck = sumXor(CHECK_N);
const want = expectSum(CHECK_N);
if (modCheck !== want || andCheck !== want || xorCheck !== want) {
  throw new Error(`checksum mod ${modCheck} and ${andCheck} xor ${xorCheck} want ${want}`);
}

let sink = 0;
const mod = timeIt('mod2', (n) => {
  sink = sumMod(n);
});
const band = timeIt('and1', (n) => {
  sink = sumAnd(n);
});
const xor = timeIt('xor1', (n) => {
  sink = sumXor(n);
});

if (sink !== expectSum(xor.iterations) && sink !== expectSum(band.iterations) && sink !== expectSum(mod.iterations)) {
  throw new Error(`timed sink ${sink} is not a floor(n/2) checksum`);
}

const pct = (ops, base) => ((ops - base) / base) * 100;
console.log(`and vs mod ${pct(band.opsPerSec, mod.opsPerSec).toFixed(1)}%`);
console.log(`xor vs mod ${pct(xor.opsPerSec, mod.opsPerSec).toFixed(1)}%`);
console.log(JSON.stringify({
  checksum: want,
  modOps: mod.opsPerSec,
  andOps: band.opsPerSec,
  xorOps: xor.opsPerSec,
}));
