// L1: melt heat writes — N× SET_PARTICLE_USER_DATA vs one list (indices + add).
//
// Usage:
//   node tests/bench/liquidFunUserDataListMicrobench.mjs
//   node tests/bench/liquidFunUserDataListMicrobench.mjs --output tests/results/liquidfun-userdata-list/after.json

import {
  createCommandRingSab,
  bindCommandRing,
  drainCommandRing,
  enqueueSetParticleUserData,
} from '../../src/box2d/box2dCommandRing.js';
import {
  createLiquidFunUserDataListSab,
  bindLiquidFunUserDataListSab,
  applyLiquidFunUserDataList,
} from '../../src/box2d/liquidFunUserDataList.js';
import { LiquidFun } from '../../src/core/liquidFun.js';
import { parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

function setupMelt(particleN, groupN, boxN) {
  const per = (particleN / groupN) | 0;
  const x = new Float32Array(particleN);
  const y = new Float32Array(particleN);
  const ud = new Uint32Array(particleN);
  const first = new Int32Array(groupN);
  const last = new Int32Array(groupN);
  const flags = new Int32Array(groupN);
  for (let g = 0; g < groupN; g++) {
    first[g] = g * per;
    last[g] = (g + 1) * per;
    flags[g] = 2;
    for (let i = first[g]; i < last[g]; i++) {
      x[i] = (i % 80) * 4;
      y[i] = ((i / 80) | 0) * 4;
      ud[i] = i & 31;
    }
  }
  const boxX0 = new Float32Array(boxN);
  const boxY0 = new Float32Array(boxN);
  const boxX1 = new Float32Array(boxN);
  const boxY1 = new Float32Array(boxN);
  for (let b = 0; b < boxN; b++) {
    boxX0[b] = b * 20;
    boxY0[b] = 0;
    boxX1[b] = b * 20 + 48;
    boxY1[b] = 48;
  }
  return { x, y, ud, first, last, flags, boxN, boxX0, boxY0, boxX1, boxY1, groupN };
}

function collectHits(scene, out, add) {
  let n = 0;
  const cap = out.length;
  for (let k = 0; k < scene.groupN; k++) {
    if (!(scene.flags[k] & 2)) continue;
    for (let idx = scene.first[k]; idx < scene.last[k]; idx++) {
      const px = scene.x[idx];
      const py = scene.y[idx];
      let hit = false;
      for (let b = 0; b < scene.boxN; b++) {
        if (px >= scene.boxX0[b] && px <= scene.boxX1[b] && py >= scene.boxY0[b] && py <= scene.boxY1[b]) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      const prev = scene.ud[idx] >>> 0;
      let t = (prev & 255) + add;
      if (t > 255) t = 255;
      if (t !== (prev & 255) && n < cap) out[n++] = idx;
    }
  }
  return n;
}

function run(cli = parseArgs()) {
  const N = Number(cli.n ?? 512);
  const FRAMES = Number(cli.frames ?? 400);
  const PARTICLE_N = Number(cli.particles ?? 4096);
  const GROUP_N = Number(cli.groups ?? 4);
  const BOX_N = Number(cli.boxes ?? 8);
  const ADD = 4;
  const output = cli.output
    ? String(cli.output)
    : 'tests/results/liquidfun-userdata-list/latest.json';

  const indices = new Int32Array(N);
  for (let i = 0; i < N; i++) indices[i] = i;
  const heapA = new Uint32Array(N);
  const heapB = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    heapA[i] = i & 15;
    heapB[i] = i & 15;
  }

  const ringSab = createCommandRingSab(4096);
  bindCommandRing(ringSab);
  const ringI32 = new Int32Array(ringSab);
  const ringF32 = new Float32Array(ringSab);
  const applyOne = {
    setParticleUserData(index, bits) {
      heapA[index] = bits >>> 0;
    },
  };

  const listSab = createLiquidFunUserDataListSab();
  bindLiquidFunUserDataListSab(listSab);
  const applyListHandler = {
    setParticleUserDataList() {
      applyLiquidFunUserDataList(heapB);
    },
  };

  const scene = setupMelt(PARTICLE_N, GROUP_N, BOX_N);
  const heated = new Int32Array(PARTICLE_N);

  const perParticle = timeIt(
    `per-particle setUserData enqueue+drain n=${N}`,
    (iters) => {
      for (let f = 0; f < iters; f++) {
        for (let i = 0; i < N; i++) {
          const prev = heapA[i] >>> 0;
          let t = (prev & 255) + ADD;
          if (t > 255) t = 255;
          enqueueSetParticleUserData(i, (prev & ~255) | t);
        }
        drainCommandRing(ringI32, ringF32, applyOne);
      }
    },
    { iterations: FRAMES, warmup: 20, reps: 7 },
  );

  const listMs = timeIt(
    `real addUserData enqueue+drain n=${N}`,
    (iters) => {
      for (let f = 0; f < iters; f++) {
        LiquidFun.addUserData(indices, N, ADD);
        drainCommandRing(ringI32, ringF32, applyListHandler);
      }
    },
    { iterations: FRAMES, warmup: 20, reps: 7 },
  );

  const meltPer = timeIt(
    `melt walk + N setUserData nHits`,
    (iters) => {
      for (let f = 0; f < iters; f++) {
        const n = collectHits(scene, heated, ADD);
        for (let i = 0; i < n; i++) {
          const idx = heated[i];
          const prev = scene.ud[idx] >>> 0;
          let t = (prev & 255) + ADD;
          if (t > 255) t = 255;
          enqueueSetParticleUserData(idx, (prev & ~255) | t);
        }
        drainCommandRing(ringI32, ringF32, {
          setParticleUserData(index, bits) {
            scene.ud[index] = bits >>> 0;
          },
        });
      }
    },
    { iterations: FRAMES, warmup: 20, reps: 7 },
  );

  const meltList = timeIt(
    `melt walk + addUserData nHits`,
    (iters) => {
      for (let f = 0; f < iters; f++) {
        const n = collectHits(scene, heated, ADD);
        LiquidFun.addUserData(heated, n, ADD);
        drainCommandRing(ringI32, ringF32, {
          setParticleUserDataList() {
            applyLiquidFunUserDataList(scene.ud);
          },
        });
      }
    },
    { iterations: FRAMES, warmup: 20, reps: 7 },
  );

  heapB[0] = 10;
  LiquidFun.addUserData(indices, 1, 4);
  drainCommandRing(ringI32, ringF32, applyListHandler);
  if ((heapB[0] & 255) !== 14) {
    throw new Error(`userData list apply broken: got ${heapB[0] & 255}`);
  }

  const report = {
    n: N,
    frames: FRAMES,
    particles: PARTICLE_N,
    listMode: 'real',
    perParticle,
    list: listMs,
    meltPer,
    meltList,
    speedupEnqueue: perParticle.ms / listMs.ms,
    speedupMelt: meltPer.ms / meltList.ms,
  };
  console.log(
    `speedup enqueue ${report.speedupEnqueue.toFixed(2)}x  melt ${report.speedupMelt.toFixed(2)}x`,
  );
  writeReport(output, report);
  return report;
}

run();
