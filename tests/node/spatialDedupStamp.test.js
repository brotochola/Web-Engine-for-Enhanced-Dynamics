import test from 'node:test';
import assert from 'node:assert/strict';

import { Grid } from '../../src/core/grid.js';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

// REVIEW_PLAN N-63: the spatial gather marks each candidate with packSpatialPairStamp(frame,
// entityA), an int32. From stamp frame 4096 the stamp's top bit is set; read back from a
// Uint32Array it never equalled the stamp, so for half of every 8191-frame cycle an entity in
// several grid cells was appended to a candidate list once per cell, and published that many times.

function duplicateNeighbours(n) {
  const rows = Grid.neighborData;
  const stride = Grid._stride;
  let dups = 0;
  for (let i = 0; i < n; i++) {
    const base = i * stride;
    const seen = new Set();
    for (let j = 0; j < rows[base]; j++) {
      const b = rows[base + 1 + j];
      if (seen.has(b)) dups++;
      else seen.add(b);
    }
  }
  return dups;
}

test('no neighbour is published twice, before or after stamp frame 4096', async () => {
  // Every list rebuilt every frame, so every frame runs the gather and its dedup.
  const k = await setupSpatialKernel({ n: 4000, workers: 2, spatial: { neighborReuseSkin: 0, neighborTickInterval: 1 } });
  let published = 0;
  for (const start of [10, 4094]) {
    for (const w of k.workers) w._processedFrameCounter = start;
    for (let f = 0; f < 3; f++) {
      k.frame();
      const frame = k.workers[0]._processedFrameCounter;
      assert.equal(duplicateNeighbours(k.n), 0, `stamp frame ${frame}: a neighbour appears twice in a row`);
      for (let i = 0; i < k.n; i++) published += Grid.neighborData[i * Grid._stride];
    }
  }
  assert.ok(published > 0, 'the scene publishes neighbours');
});
