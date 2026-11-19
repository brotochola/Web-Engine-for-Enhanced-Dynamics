import test from 'node:test';
import assert from 'node:assert/strict';

import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

// N-323: a list skin reuse keeps (its entity did not move) is rebuilt when it reaches neighborReuseMaxFrames. Lists
// built on one frame (every list at the start, which SST-21's prime builds before the first frame) all reached the cap
// on one frame and were rebuilt together for good: stationarySpatialScene's 9000 lists every 16 frames, 8 to 16 ms on
// the ASUS's 2 cores against 0.23 to 0.29 ms on the other frames (R-1594). A list's first build now starts at an age
// spread by its id, so each frame of the cycle rebuilds about one cap's share, and no list stands past the cap.

const CAP = 15;

async function stillKernel() {
  return setupSpatialKernel({
    n: 4000,
    workers: 1,
    still: true,
    spatial: { neighborReuseSkin: 0.04, neighborReuseMaxFrames: CAP, neighborTickInterval: 1 },
  });
}

test('N-323: still lists built on one frame are rebuilt spread over the reuse cap, each once a cycle', async () => {
  const k = await stillKernel();
  const w = k.workers[0];
  k.frame(); // every list built on this frame
  const listed = w.neighborsRebuiltThisFrame;
  assert.ok(listed > 2000, `lists built at the start: ${listed}`);
  const per = [];
  for (let f = 0; f < 3 * (CAP + 1); f++) {
    k.frame();
    per.push(w.neighborsRebuiltThisFrame);
  }
  const cycle = per.slice(CAP + 1, 2 * (CAP + 1));
  const total = cycle.reduce((a, b) => a + b, 0);
  // Each list once a cycle of CAP + 1 frames (none kept past the cap, none rebuilt twice).
  assert.ok(Math.abs(total - listed) <= listed * 0.02, `a cycle rebuilt ${total} of ${listed} lists`);
  // Spread: no frame of the cycle takes more than twice its even share.
  const even = listed / (CAP + 1);
  assert.ok(Math.max(...cycle) <= 2 * even, `rebuilds a frame over a cycle: ${cycle.join(' ')} (even share ${even.toFixed(0)})`);
});
