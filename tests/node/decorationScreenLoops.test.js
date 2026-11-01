// E-179: the particle worker's decoration screen test has two copies, with and without its branch. One frame in 16
// samples the flips of the outcome on a window of the snapshot, and the branchless copy runs while they are many.
// Both copies must give the same visible list and flags.
import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateCameraScreenBounds } from '../../src/util/utils.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { PoolSlotArray } from '../../src/util/poolSlotWidth.js';
import { setupSwayKernel } from '../bench/decorationSwayWasmMicrobench.mjs';

test('the branch and branchless screen loops give the same list and flags; a sample of the flips picks the loop', async () => {
  const { worker, n } = await setupSwayKernel();
  if (!worker.cameraData) worker.cameraData = new Float32Array(16);
  const SlotArray = PoolSlotArray(n);
  worker.visibleDecorationsData = new SlotArray(new SharedArrayBuffer((n + 1) * SlotArray.BYTES_PER_ELEMENT));
  // Predator's grass (setupSwayKernel): 10 000 x 5 000, random order; the left half on screen.
  calculateCameraScreenBounds(1, 0, 0, 5100, 5000, 0, worker._cameraBounds, 0);
  assert.ok(worker._decorationScreenScratch.length >= n, 'the scratch is sized at init');

  /** One frame's test; the call steps the sample counter, so 15 makes it a sample frame. */
  const run = (flipsBefore, probeBefore = 0) => {
    worker._frameCamValid = true;
    worker._decorationScreenFlips = flipsBefore;
    worker._decorationScreenProbe = probeBefore;
    worker.updateDecorationScreenVisibility();
    const visible = worker.visibleDecorationsData;
    return {
      list: Array.from(visible.subarray(1, 1 + visible[0])),
      flags: Array.from(DecorationComponent.isItOnScreen.subarray(0, n)),
      flips: worker._decorationScreenFlips,
    };
  };
  const branch = run(0);
  assert.equal(branch.flips, 0, 'few flips and no sample: the branch copy');
  assert.ok(branch.list.length > n / 4 && branch.list.length < (3 * n) / 4, `about half on screen: ${branch.list.length}`);
  const branchless = run(n);
  assert.deepEqual(branchless.list, branch.list);
  assert.deepEqual(branchless.flags, branch.flags);
  assert.equal(run(0, 15).flips, n, 'a sample of random grass sends the next frames to the branchless copy');
  assert.equal(run(n, 15).flips, n, 'and keeps them there');

  // In x order the blades on screen are one run: a sample finds a flip at most, and the branch copy runs next.
  const x = DecorationComponent.x;
  const snapshot = worker._activeDecorationSnapshot;
  const ids = Array.from(snapshot.subarray(0, n)).sort((a, b) => (x[a] < x[b] ? -1 : x[a] > x[b] ? 1 : a - b));
  snapshot.set(ids);
  const sortedBranchless = run(n, 15);
  assert.equal(sortedBranchless.flips, 0, 'a sample of the sorted list goes back to the branch copy');
  const sortedBranch = run(0);
  assert.deepEqual(sortedBranch.list, sortedBranchless.list);
  assert.deepEqual(sortedBranch.flags, sortedBranchless.flags);
  assert.deepEqual([...sortedBranch.list].sort((a, b) => a - b), [...branch.list].sort((a, b) => a - b));
});
