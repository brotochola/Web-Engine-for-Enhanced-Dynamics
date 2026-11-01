// E-179: the particle worker's decoration screen test has two copies. The branchless one counts the flips of the
// outcome along the snapshot; it runs while they are many, and one frame in 16 as a probe. Both copies must give the
// same visible list and flags.
import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateCameraScreenBounds } from '../../src/util/utils.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { PoolSlotArray } from '../../src/util/poolSlotWidth.js';
import { setupSwayKernel } from '../bench/decorationSwayWasmMicrobench.mjs';

test('the branch and branchless screen loops give the same list and flags; the flips and a probe pick the loop', async () => {
  const { worker, n } = await setupSwayKernel();
  if (!worker.cameraData) worker.cameraData = new Float32Array(16);
  const SlotArray = PoolSlotArray(n);
  worker.visibleDecorationsData = new SlotArray(new SharedArrayBuffer((n + 1) * SlotArray.BYTES_PER_ELEMENT));
  // Predator's grass (setupSwayKernel): 10 000 x 5 000, random order; the left half on screen.
  calculateCameraScreenBounds(1, 0, 0, 5100, 5000, 0, worker._cameraBounds, 0);

  /** One frame's test; the call steps the probe counter first, so 15 makes it a probe frame. */
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
  assert.equal(branch.flips, 0, 'few flips, no probe: the branch copy, which does not count');
  assert.ok(branch.list.length > n / 4 && branch.list.length < (3 * n) / 4, `about half on screen: ${branch.list.length}`);
  const branchless = run(n);
  assert.deepEqual(branchless.list, branch.list);
  assert.deepEqual(branchless.flags, branch.flags);
  assert.ok(branchless.flips * 8 > n, `random grass flips often (${branchless.flips} of ${n}): it stays branchless`);
  assert.equal(run(0, 15).flips, branchless.flips, 'a probe frame runs the counting copy whatever the flips');

  // In x order the blades on screen are one run: two flips at most, and the next frames take the branch copy.
  const x = DecorationComponent.x;
  const snapshot = worker._activeDecorationSnapshot;
  const ids = Array.from(snapshot.subarray(0, n)).sort((a, b) => (x[a] < x[b] ? -1 : x[a] > x[b] ? 1 : a - b));
  snapshot.set(ids);
  const sorted = run(n);
  assert.ok(sorted.flips <= 2, `sorted: ${sorted.flips} flips`);
  assert.deepEqual([...sorted.list].sort((a, b) => a - b), [...branch.list].sort((a, b) => a - b));
  const next = run(sorted.flips);
  assert.equal(next.flips, sorted.flips, 'the branch copy ran');
  assert.deepEqual(next.list, sorted.list);
});
