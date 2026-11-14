import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPost } from '../bench/publishPoseMicrobench.mjs';

// E-246: publishPose and snapshotPrevPose walk the slots in order and copy runs of bodies with set() when at least 3/4 of
// the slots hold a body; otherwise they follow the dense list. Either way a slot with a body gets its pose and a slot
// without one is left alone; a respawn (the epoch moved) still goes through the dense list's generation checks.

const N = 1200;
const SENTINEL = -7;
loadPost('base');

/** Bodies in the slots `isBody` picks, the dense list shuffled as despawns and respawns leave it. */
function world(isBody, { epochMoved = false, staleSlot = -1 } = {}) {
  const list = [];
  for (let i = 0; i < N; i++) if (isBody(i)) list.push(i);
  for (let k = list.length - 1; k > 0; k--) {
    const j = (k * 7919) % (k + 1);
    const t = list[k];
    list[k] = list[j];
    list[j] = t;
  }
  const denseList = Int32Array.from(list);
  const densePositions = new Int32Array(N).fill(-1);
  for (let d = 0; d < denseList.length; d++) densePositions[denseList[d]] = d;
  const views = {
    x: new Float32Array(N),
    y: new Float32Array(N),
    rotC: new Float32Array(N),
    rotS: new Float32Array(N),
    px: new Float32Array(N).fill(SENTINEL),
    py: new Float32Array(N).fill(SENTINEL),
  };
  for (let i = 0; i < N; i++) {
    views.x[i] = i + 0.5;
    views.y[i] = -i - 0.25;
    views.rotC[i] = (i % 3) - 1;
    views.rotS[i] = 1 - (i % 5) * 0.5;
  }
  const mk = () => ({
    x: new Float32Array(N).fill(SENTINEL),
    y: new Float32Array(N).fill(SENTINEL),
    rotC: new Float32Array(N).fill(SENTINEL),
    rotS: new Float32Array(N).fill(SENTINEL),
  });
  const poseBuffers = [mk(), mk()];
  const bodyGeneration = new Int32Array(new SharedArrayBuffer(N * 4));
  const seenBodyGeneration = new Int32Array(N);
  if (staleSlot >= 0) Atomics.store(bodyGeneration, staleSlot, 1);
  const poseGenEpoch = new Int32Array(new SharedArrayBuffer(4));
  if (epochMoved) Atomics.store(poseGenEpoch, 0, 1);
  globalThis.weedjsBindPoseBench({
    poseSync: new Int32Array(new SharedArrayBuffer(16)),
    poseBuffers,
    denseList,
    denseCount: denseList.length,
    densePositions,
    views,
    bodyGeneration,
    seenBodyGeneration,
    poseFrame: 0,
    poseGenEpoch,
    seenPoseGenEpoch: 0,
  });
  return { views, out: poseBuffers[0], isBody };
}

function checkPublished({ views, out, isBody }, skip = -1) {
  globalThis.weedjsPublishPose();
  for (let i = 0; i < N; i++) {
    const want = isBody(i) && i !== skip;
    assert.equal(out.x[i], want ? views.x[i] : SENTINEL, `x of slot ${i}`);
    assert.equal(out.y[i], want ? views.y[i] : SENTINEL, `y of slot ${i}`);
    assert.equal(out.rotC[i], want ? views.rotC[i] : SENTINEL, `rotC of slot ${i}`);
    assert.equal(out.rotS[i], want ? views.rotS[i] : SENTINEL, `rotS of slot ${i}`);
  }
}

function checkSnapshot({ views, isBody }) {
  for (let i = 0; i < N; i++) {
    assert.equal(views.px[i], isBody(i) ? views.x[i] : SENTINEL, `px of slot ${i}`);
    assert.equal(views.py[i], isBody(i) ? views.y[i] : SENTINEL, `py of slot ${i}`);
  }
}

// Mostly bodies: a long run, short runs between single holes, and a hole of 40 slots (about 92 % of the slots).
const mostly = (i) => !(i % 37 === 0 && i > 400) && !(i >= 300 && i < 340);
// Half bodies: the dense list's path.
const half = (i) => i % 2 === 0;

test('E-246: publishPose by slot copies every body and leaves the other slots', () => {
  checkPublished(world(mostly));
});

test('E-246: publishPose with few bodies follows the dense list, same result', () => {
  checkPublished(world(half));
});

test('E-246: after a respawn the dense list skips a slot whose body changed', () => {
  checkPublished(world(mostly, { epochMoved: true, staleSlot: 12 }), 12);
});

test('E-246: snapshotPrevPose by slot and by list copies x and y of every body only', () => {
  const a = world(mostly);
  globalThis.weedjsSnapshotPrevPose(N);
  checkSnapshot(a);
  const b = world(half);
  globalThis.weedjsSnapshotPrevPose(N);
  checkSnapshot(b);
});
