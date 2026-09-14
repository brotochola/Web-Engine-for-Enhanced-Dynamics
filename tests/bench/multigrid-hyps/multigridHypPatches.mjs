/**
 * Multigrid smoke: M0 baseline vs M1 fine+4×coarse.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

export const PATHS = {
  spatial: path.join(repoRoot, 'src/workers/spatialWorker.js'),
  balls: path.join(repoRoot, 'demos/ballsScene/ballsScene.js'),
  predator: path.join(repoRoot, 'demos/predatorScene/predatorScene.js'),
  baselineSpatial: path.join(here, 'baselineSpatialWorker.js'),
  baselineBalls: path.join(here, 'baselineBallsScene.js'),
  baselinePredator: path.join(here, 'baselinePredatorScene.js'),
  m1Spatial: path.join(here, 'm1SpatialWorker.js'),
};

export function restoreAll() {
  fs.copyFileSync(PATHS.baselineSpatial, PATHS.spatial);
  fs.copyFileSync(PATHS.baselineBalls, PATHS.balls);
  fs.copyFileSync(PATHS.baselinePredator, PATHS.predator);
}

export const HYPS = [
  { id: 'M0', title: 'Baseline single grid', apply: () => {} },
  {
    id: 'M1',
    title: 'Fine + coarse 4×cellSize hierarchical hash',
    apply: () => {
      fs.copyFileSync(PATHS.m1Spatial, PATHS.spatial);
    },
  },
];

export function applyHyp(id) {
  restoreAll();
  const hyp = HYPS.find((h) => h.id === id);
  if (!hyp) throw new Error(`Unknown hyp ${id}`);
  hyp.apply();
  return hyp;
}
