import test from 'node:test';
import assert from 'node:assert/strict';

import { Grid } from '../../src/core/grid.js';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

// The stagger skip reads a dense per-entity candidate count. It must always
// equal the count stored at the head of that entity's candidate row, through
// rebuilds, reuse frames and stagger skips. The rows live in the publish memory,
// shared by the spatial workers, and each worker's counts cover the entities it
// rebuilt: one worker owns them all here.
test('dense candidate count mirrors the candidate row head', async () => {
  const k = await setupSpatialKernel({ n: 3000, seed: 0x7e57, workers: 1 });
  const stride = 1 + Grid.maxNeighbors;
  for (let f = 0; f < 40; f++) {
    k.frame();
    for (const w of k.workers) {
      const rows = w._neighborCandidateData;
      const counts = w._candidateCountOf;
      for (let i = 0; i < k.n; i++) {
        assert.equal(counts[i], rows[i * stride], `worker ${w.workerId} frame ${f} entity ${i}`);
      }
    }
  }
});
