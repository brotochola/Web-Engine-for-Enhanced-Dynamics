// E-179: the particle worker's decoration screen test has two copies: updateDecorationScreenVisibility, as shipped,
// and one without its branch. One frame in 16 samples the flips of the outcome on a window of the snapshot, and the
// branchless copy runs while they are many. Both copies must give the same visible list and flags.
import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateCameraScreenBounds } from '../../src/util/utils.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { PoolSlotArray } from '../../src/util/poolSlotWidth.js';
import { setupSwayKernel } from '../bench/decorationSwayWasmMicrobench.mjs';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { DecorationSpatial } from '../../src/core/decorationSpatial.js';
import { Transform } from '../../src/components/transform.js';

test('the branch and branchless screen loops give the same list and flags; a sample of the flips picks the loop', async () => {
  const { worker, n } = await setupSwayKernel();
  if (!worker.cameraData) worker.cameraData = new Float32Array(16);
  const SlotArray = PoolSlotArray(n);
  worker.visibleDecorationsData = new SlotArray(new SharedArrayBuffer((n + 1) * SlotArray.BYTES_PER_ELEMENT));
  // Predator's grass (setupSwayKernel): 10 000 x 5 000, random order; the left half on screen.
  calculateCameraScreenBounds(1, 0, 0, 5100, 5000, 0, worker._cameraBounds, 0);
  assert.ok(worker._decorationScreenScratch.length >= n, 'the scratch is sized at init');

  /** One frame's test (the update loop's call); it steps the sample counter after the test, so 15 samples. */
  const run = (flipsBefore, probeBefore = 0) => {
    worker._frameCamValid = true;
    worker._decorationScreenFlips = flipsBefore;
    worker._decorationScreenProbe = probeBefore;
    worker.updateDecorationScreen();
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

// E-179c: with the camera bounds the last test ran with, and no decoration spawned, despawned or moved since (the pool's
// list header counts both), the test is skipped and its list and flags stand; so is the active snapshot's copy while
// the list holds. Each change runs them again, and what they write is what a full test writes.
test('E-179c: the screen test and the snapshot copy skip a frame that changed nothing, and run on any change', async () => {
  const { worker, n } = await setupSwayKernel({ n: 4000, listCounters: true });
  if (!worker.cameraData) worker.cameraData = new Float32Array(16);
  const SlotArray = PoolSlotArray(n + 8);
  worker.visibleDecorationsData = new SlotArray(new SharedArrayBuffer((n + 9) * SlotArray.BYTES_PER_ELEMENT));
  assert.ok(DecorationPool.listEpoch() >= 0 && DecorationPool.moveEpoch() >= 0, 'the header counts');
  let tests = 0;
  let copies = 0;
  const screen = worker.updateDecorationScreenVisibility.bind(worker);
  const branchless = worker._updateDecorationScreenBranchless.bind(worker);
  worker.updateDecorationScreenVisibility = () => { tests++; screen(); };
  worker._updateDecorationScreenBranchless = (s) => { tests++; branchless(s); };
  const copy = DecorationPool.copyActiveSnapshot;
  DecorationPool.copyActiveSnapshot = function (out) { copies++; return copy.call(this, out); };
  const bounds = (x0) => {
    calculateCameraScreenBounds(1, x0, 0, 5100, 5000, 0, worker._cameraBounds, 0);
  };
  /** One frame of the update loop's decoration passes; the list and flags they leave. */
  const frame = () => {
    worker._frameCamValid = true;
    worker.refreshActiveDecorationSnapshot();
    worker.resolveAttachedDecorations(0);
    worker.updateDecorationScreen();
    const visible = worker.visibleDecorationsData;
    return {
      list: Array.from(visible.subarray(1, 1 + visible[0])).sort((a, b) => a - b),
      flags: Array.from(DecorationComponent.isItOnScreen.subarray(0, n + 8)),
    };
  };
  /** What a full test writes now, the skip bypassed. */
  const full = () => {
    worker._decoScreenListEpoch = -2;
    return frame();
  };
  try {
    bounds(0);
    let got = frame();
    assert.equal(tests, 1, 'the first frame tests');
    assert.ok(got.list.length > 0 && got.list.length < n, `some on screen: ${got.list.length}`);
    const t0 = tests;
    const c0 = copies;
    assert.deepEqual(frame(), got, 'a frame that changed nothing keeps the list and flags');
    assert.equal(tests, t0, 'without testing');
    assert.equal(copies, c0, 'or copying the snapshot');

    // A move into view: tested again, the decoration on the list.
    const off = got.flags.findIndex((f, i) => i < n && f === 0);
    DecorationSpatial.move(off, DecorationComponent.x[got.list[0]], DecorationComponent.y[got.list[0]]);
    got = frame();
    assert.equal(tests, t0 + 1, 'a move runs the test');
    assert.equal(copies, c0, 'not the copy: the list holds');
    assert.ok(got.list.includes(off), 'the moved decoration is on screen');
    assert.deepEqual(full(), got);
    assert.deepEqual(frame(), got, 'and the next frame skips again');
    assert.equal(tests, t0 + 2);

    // A despawn of one on screen, then a spawn on screen: the copy and the test run, and the lists follow.
    const gone = got.list[1];
    DecorationPool.despawn(gone);
    const t1 = tests;
    got = frame();
    assert.equal(copies, c0 + 1, 'a despawn copies the snapshot again');
    assert.equal(tests, t1 + 1, 'and tests');
    assert.ok(!got.list.includes(gone));
    const born = DecorationPool.spawn({ x: DecorationComponent.x[got.list[0]], y: DecorationComponent.y[got.list[0]], sway: false });
    assert.ok(born >= 0);
    got = frame();
    assert.equal(copies, c0 + 2, 'a spawn copies it again');
    assert.ok(got.list.includes(born), 'the spawned decoration is on screen');
    assert.deepEqual(full(), got);

    // The camera moves: tested again, a different list.
    const t2 = tests;
    bounds(2500);
    const moved = frame();
    assert.equal(tests, t2 + 1, 'a camera move runs the test');
    assert.notDeepEqual(moved.list, got.list);
    assert.deepEqual(full(), moved);
    frame();
    assert.equal(tests, t2 + 2, 'only the full test above ran since');

    // An attached decoration (the harness has no Transform: stand-in columns for its parent) runs the test when the
    // pass that places it moves it, once, and not while its parent holds.
    for (const [key, Ctor] of [['active', Uint8Array], ['x', Float32Array], ['y', Float32Array], ['rotC', Float32Array], ['rotS', Float32Array]]) {
      Transform[key] = new Ctor(16);
    }
    Transform.active[3] = 1;
    Transform.x[3] = 2600;
    Transform.y[3] = 100;
    Transform.rotC[3] = 1;
    DecorationPool.despawn(moved.flags.findIndex((f, i) => i < n && f === 0)); // a free slot
    const kid = DecorationPool.spawn({ parent: 3, localX: 5, localY: 0, sway: false });
    assert.ok(kid >= 0);
    got = frame();
    assert.equal(DecorationComponent.x[kid], 2605, 'placed by its parent');
    assert.ok(got.list.includes(kid));
    const t3 = tests;
    assert.deepEqual(frame(), got, 'its parent holds: nothing to test');
    assert.equal(tests, t3);
    Transform.x[3] = 9000;
    got = frame();
    assert.equal(tests, t3 + 1, 'its parent moved: tested');
    assert.ok(!got.list.includes(kid), 'and off screen');
    assert.deepEqual(frame(), got);
    assert.equal(tests, t3 + 1, 'once');
  } finally {
    worker.updateDecorationScreenVisibility = screen;
    worker._updateDecorationScreenBranchless = branchless;
    DecorationPool.copyActiveSnapshot = copy;
    for (const key of ['active', 'x', 'y', 'rotC', 'rotS']) Transform[key] = undefined;
  }
});
