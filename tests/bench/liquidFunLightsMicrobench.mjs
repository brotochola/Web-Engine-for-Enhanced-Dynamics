// L1 packLiquidFunLightSlabs throughput (no GPU). 4096 particles / 32 lit groups.

import {
  packLiquidFunLightSlabs,
  LF_LIGHT_SPLAT_FLOATS,
} from '../../src/core/liquidFunLightSplat.js';
import { parseArgs, timeIt, writeReport } from './microbench-helpers.mjs';

const args = parseArgs();
const OUTPUT = args.output ? String(args.output) : 'tests/results/liquidfun-lights-micro.json';

const PARTICLE_N = 4096;
const GROUP_N = 32;
const PER_GROUP = PARTICLE_N / GROUP_N;

function setup() {
  const views = {
    x: new Float32Array(PARTICLE_N),
    y: new Float32Array(PARTICLE_N),
    tint: new Uint32Array(PARTICLE_N),
    alpha: new Float32Array(PARTICLE_N),
    baseAlpha: new Float32Array(PARTICLE_N),
    maxCount: PARTICLE_N,
  };
  const groups = {
    count: new Int32Array(1),
    id: new Int32Array(GROUP_N),
    particleCount: new Int32Array(GROUP_N),
    firstIndex: new Int32Array(GROUP_N),
    lastIndex: new Int32Array(GROUP_N),
    lightIntensity: new Float32Array(256),
    sqrtLightIntensity: new Float32Array(256),
    maxGroups: 256,
  };
  groups.count[0] = GROUP_N;
  for (let g = 0; g < GROUP_N; g++) {
    const first = g * PER_GROUP;
    groups.id[g] = g + 1;
    groups.particleCount[g] = PER_GROUP;
    groups.firstIndex[g] = first;
    groups.lastIndex[g] = first + PER_GROUP;
    groups.lightIntensity[g + 1] = 5000;
    groups.sqrtLightIntensity[g + 1] = Math.sqrt(5000);
    for (let i = 0; i < PER_GROUP; i++) {
      const p = first + i;
      views.x[p] = (g * 40 + i) % 800;
      views.y[p] = (g * 12) % 600;
      views.tint[p] = 0x6b3a1f;
      views.alpha[p] = 1;
      views.baseAlpha[p] = 1;
    }
  }
  const cap = PARTICLE_N;
  const data = new Float32Array(cap * LF_LIGHT_SPLAT_FLOATS);
  const dataU32 = new Uint32Array(data.buffer);
  return { views, groups, data, dataU32, cap };
}

const ctx = setup();
const packed = packLiquidFunLightSlabs(ctx.data, ctx.dataU32, ctx.cap, ctx.views, ctx.groups, {
  zoom: 1,
  cameraX: 0,
  cameraY: 0,
  resolution: 0.25,
  canvasW: 800,
  canvasH: 600,
});
if (packed <= 0) {
  throw new Error(`liquidfun-lights-microbench: expected packed instances, got ${packed}`);
}

const result = timeIt(
  'packLiquidFunLightSlabs 4096/32',
  (iterations) => {
    for (let i = 0; i < iterations; i++) {
      packLiquidFunLightSlabs(ctx.data, ctx.dataU32, ctx.cap, ctx.views, ctx.groups, {
        zoom: 1,
        cameraX: 0,
        cameraY: 0,
        resolution: 0.25,
        canvasW: 800,
        canvasH: 600,
      });
    }
  },
  { iterations: 2000, warmup: 50, reps: 5 }
);

writeReport(OUTPUT, { packed, ...result });
