// Kernel: Joint.addPrismatic field writes. Imports the shipped class. Does not patch src/.
//
//   node tests/bench/prismaticJointMicrobench.mjs
//   node tests/bench/prismaticJointMicrobench.mjs --output tests/results/prismatic-joint/kernel.json

import { Joint } from '../../src/core/joint.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { checksumFloats, isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const SEED = 0x07157;
const MAX = 64;

function boot() {
  Joint.reset();
  const sab = new SharedArrayBuffer(Joint.getBufferSize(MAX, 8));
  Joint.initializeArrays(sab, MAX, 8);
  const freeListSab = new SharedArrayBuffer(MAX * 2);
  const freeListTopSab = new SharedArrayBuffer(8);
  resetFreeList(new Int32Array(freeListTopSab), new Uint16Array(freeListSab), MAX, 1);
  Joint.initialize(MAX);
  Joint.initializeFreeList(freeListSab, freeListTopSab);
}

function checksum() {
  const idx = Joint.addPrismatic({
    entityA: 1,
    entityB: 2,
    axisAngle: 0.75,
    lowerTranslation: -4,
    upperTranslation: 8,
    maxMotorForce: 3,
  });
  const out = new Float32Array([
    Joint.linearHertz[idx],
    Joint.lowerAngle[idx],
    Joint.upperAngle[idx],
    Joint.maxMotorTorque[idx],
  ]);
  Joint.remove(idx);
  return checksumFloats(out, 4);
}

function run(iterations) {
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    const idx = Joint.addPrismatic({
      entityA: 1,
      entityB: 2,
      axisAngle: 0.75,
      lowerTranslation: -4,
      upperTranslation: 8,
      maxMotorForce: 3,
    });
    acc += Joint.linearHertz[idx];
    Joint.remove(idx);
  }
  return acc;
}

function main() {
  const args = parseArgs();
  boot();
  const sum = checksum();
  if (!Number.isFinite(sum)) throw new Error('prismatic checksum is not finite');
  const probe = run(1);
  if (!Number.isFinite(probe)) throw new Error('prismatic probe is not finite');

  const timed = timeIt('prismatic', (iterations) => {
    run(iterations);
  }, { iterations: args.iters || 50000 });

  const payload = {
    seed: SEED,
    n: MAX,
    checksum: sum,
    cases: {
      add: {
        opsPerSec: timed.opsPerSec,
        n: timed.iterations,
        seed: SEED,
        checksum: sum,
        sampleMs: timed.ms,
      },
    },
  };
  if (args.output) writeReport(args.output, payload);
  Joint.reset();
  return payload;
}

if (isCli(import.meta.url)) main();

export { main };
