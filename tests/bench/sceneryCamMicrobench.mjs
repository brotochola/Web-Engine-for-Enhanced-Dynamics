/**
 * Kernel H1c: scenery camera pack (instances) vs dummy display objects.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mulberry32, timeIt, writeReport } from './microbenchHelpers.mjs';
import {
  SCENERY_CAM_FLOATS,
  packSceneryCamera,
  packSceneryDummies,
} from '../../src/render/sceneryCamPack.js';

const N = 256;
const here = path.dirname(fileURLToPath(import.meta.url));
const reportDir = path.resolve(here, '../results/pixi-peel/h1c-scenery');

function makeLayers(rng) {
  const kinds = ['cover', 'static', 'tiling'];
  const layers = [];
  for (let i = 0; i < N; i++) {
    layers.push({
      kind: kinds[i % 3],
      px: 0.1 + (i % 7) * 0.05,
      py: 0.1 + (i % 5) * 0.04,
      sx: 1,
      sy: 1,
      texW: 512,
      texH: 512,
      margin: 0.2,
      zoomParallax: 0.35,
    });
  }
  return layers;
}

const rng = mulberry32(0x5ce11e);
const layers = makeLayers(rng);
const cam = {
  canvasW: 1920,
  canvasH: 1080,
  zoom: 0.85,
  cameraX: 1400,
  cameraY: 900,
  worldW: 8000,
  worldH: 8000,
};
const inst = new Float32Array(N * SCENERY_CAM_FLOATS);
const dummies = [];
const nA = packSceneryCamera(inst, layers, cam);
const nB = packSceneryDummies(dummies, layers, cam);
if (nA !== N || nB !== N) throw new Error(`scenery pack count ${nA}/${nB}`);
let checksum = 0;
for (let i = 0; i < N; i++) {
  const o = i * SCENERY_CAM_FLOATS;
  const dx = Math.abs(inst[o] - dummies[i].x);
  const dy = Math.abs(inst[o + 1] - dummies[i].y);
  const ds = Math.abs(inst[o + 2] - dummies[i].scale);
  if (dx > 1e-4 || dy > 1e-4 || ds > 1e-4) {
    throw new Error('scenery cam pack checksum failed; times do not count');
  }
  checksum = (checksum + (inst[o] * 1000) | 0) >>> 0;
}

const dummyT = timeIt('scenery dummies', (iterations) => {
  for (let i = 0; i < iterations; i++) packSceneryDummies(dummies, layers, cam);
}, { iterations: 200, warmup: 20, reps: 5 });

const packT = timeIt('packSceneryCamera', (iterations) => {
  for (let i = 0; i < iterations; i++) packSceneryCamera(inst, layers, cam);
}, { iterations: 200, warmup: 20, reps: 5 });

writeReport(path.join(reportDir, 'kernel.json'), {
  name: 'scenery-cam-pack',
  layers: N,
  checksum,
  checksumOk: true,
  dummies: dummyT,
  pack: packT,
});
console.log(
  `scenery dummies ${Math.round(dummyT.opsPerSec).toLocaleString()} ops/s  ` +
    `pack ${Math.round(packT.opsPerSec).toLocaleString()} ops/s`,
);
