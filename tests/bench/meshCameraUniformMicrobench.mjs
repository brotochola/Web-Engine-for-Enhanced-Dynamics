/**
 * Kernel H2: 6-float MESH fill camera matrix. Contract, not a speed medal.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { timeIt, writeReport } from './microbenchHelpers.mjs';
import { writeMeshFillCameraMatrix, MESH_FILL_CAMERA_FLOATS } from '../../src/render/meshFillCamera.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const reportDir = path.resolve(here, '../results/pixi-peel/h2-mesh-camera');

const out = new Float32Array(MESH_FILL_CAMERA_FLOATS);
writeMeshFillCameraMatrix(out, 0.4, 1200, 800, 1);
const z = 0.4;
const expect = [z, 0, 0, z, -1200 * z, -800 * z];
for (let i = 0; i < 6; i++) {
  if (Math.abs(out[i] - expect[i]) > 1e-6) {
    throw new Error(`mesh camera matrix checksum failed at ${i}: ${out[i]} vs ${expect[i]}`);
  }
}

const timed = timeIt('writeMeshFillCameraMatrix', (iterations) => {
  for (let i = 0; i < iterations; i++) {
    writeMeshFillCameraMatrix(out, 0.4 + (i & 7) * 0.01, 1200 + i, 800 - i, 1);
  }
}, { iterations: 200000, warmup: 2000, reps: 5 });

writeReport(path.join(reportDir, 'kernel.json'), {
  name: 'mesh-camera-uniform',
  checksumOk: true,
  expect,
  timed,
});
console.log(
  `mesh-camera ${Math.round(timed.opsPerSec).toLocaleString()} ops/s  checksum OK`,
);
