#!/usr/bin/env node
/**
 * Kernel: packParticleLights (review E-52). Under the cap the packer is one
 * loop; over it, the brightest are kept. Cases: 200 lights under a 256 cap,
 * and the terrain ship's laser shape: 600 dim beam particles plus 8 bright
 * sparks at the end of the pool, over a 256 cap. The checksum is the packed
 * data, sorted, so it does not depend on slot order.
 *
 *   node tests/bench/particleLightPackMicrobench.mjs [--output path]
 */
import { packParticleLights, PARTICLE_LIGHT_FLOATS } from '../../src/render/particleLightSplat.js';
import { checksumInts, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

function views(dim, bright, seed) {
  const n = dim + bright;
  const rnd = mulberry32(seed);
  const active = new Uint16Array(n + 1);
  active[0] = n;
  for (let i = 0; i < n; i++) active[1 + i] = i;
  const v = {
    active,
    lightSqrt: new Float32Array(n),
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    alpha: new Float32Array(n),
    tint: new Uint32Array(n),
  };
  for (let i = 0; i < n; i++) {
    v.lightSqrt[i] = i < dim ? Math.sqrt(10) : Math.sqrt(200);
    v.x[i] = rnd() * 1200;
    v.y[i] = rnd() * 700;
    v.alpha[i] = 0.3 + rnd() * 0.7;
    v.tint[i] = 0xff8040;
  }
  return v;
}

const CAP = 256;
const OPTS = { zoom: 1, cameraX: 0, cameraY: 0, resolution: 1, canvasW: 1280, canvasH: 720, max: CAP };

function runCase(label, v) {
  const data = new Float32Array(CAP * PARTICLE_LIGHT_FLOATS);
  const dataU32 = new Uint32Array(data.buffer);
  let packed = packParticleLights(data, dataU32, CAP, v, OPTS);
  const rows = [];
  for (let k = 0; k < packed; k++) rows.push(Array.from(dataU32.subarray(k * 4, k * 4 + 4)));
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  const checksum = checksumInts(new Int32Array(rows.flat()), rows.length * 4);
  const timed = timeIt(label, (iters) => {
    for (let k = 0; k < iters; k++) packed = packParticleLights(data, dataU32, CAP, v, OPTS);
  }, { iterations: 2000 });
  return { ...timed, packed, checksum };
}

function main() {
  const args = parseArgs();
  const cases = {
    underCap: runCase('200 lights, cap 256', views(200, 0, 11)),
    overCap: runCase('600 beam + 8 sparks, cap 256', views(600, 8, 12)),
  };
  const report = { feature: 'particle-light-pack', cases, checksum: (cases.underCap.checksum ^ cases.overCap.checksum) >>> 0 };
  if (args.output) writeReport(String(args.output), report);
  else for (const [k, c] of Object.entries(cases)) console.log(k, (1e6 / c.opsPerSec).toFixed(2), 'us', c.packed, 'packed');
}

if (isCli(import.meta.url)) main();
