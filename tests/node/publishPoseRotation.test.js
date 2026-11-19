import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPost } from '../bench/publishPoseMicrobench.mjs';

// E-327: publishPose copies a slot's rotation (rotC, rotS) only in the blocks of 64 slots Box2D stamped with an epoch
// after the one the buffer it writes was last published at. Every stamped turn reaches both buffers, each when it is
// next published; N-86's invalidation is repaired on that buffer's next publish; a module without stamps (none bound)
// copies every rotation every time.

const N = 1200;
const SHIFT = 6;
loadPost('base');

/**
 * Bodies in every slot but a hole of 40 (the slot walk, runs long and short) or in every second slot (the dense list),
 * each turned to its own angle; both pose buffers start empty. With `stamps`, Box2D's stamps and epoch as the physics
 * worker binds them.
 */
function world(isBody, { epochMoved = false, stamps = true } = {}) {
  const list = [];
  for (let i = 0; i < N; i++) if (isBody(i)) list.push(i);
  const denseList = Int32Array.from(list);
  const densePositions = new Int32Array(N).fill(-1);
  for (let d = 0; d < denseList.length; d++) densePositions[denseList[d]] = d;
  const shared = (n) => new Float32Array(new SharedArrayBuffer(n * 4));
  const views = { x: shared(N), y: shared(N), rotC: shared(N), rotS: shared(N) };
  for (let i = 0; i < N; i++) {
    views.x[i] = i;
    views.y[i] = -i;
    views.rotC[i] = Math.cos(i * 0.01);
    views.rotS[i] = Math.sin(i * 0.01);
  }
  const mk = () => ({ x: shared(N), y: shared(N), rotC: shared(N), rotS: shared(N) });
  const poseBuffers = [mk(), mk()];
  const bodyGeneration = new Int32Array(new SharedArrayBuffer(N * 4));
  const seenBodyGeneration = new Int32Array(N);
  const poseGenEpoch = new Int32Array(new SharedArrayBuffer(4));
  if (epochMoved) Atomics.store(poseGenEpoch, 0, 1);
  const poseSync = new Int32Array(new SharedArrayBuffer(16));
  const rotationStamps = stamps ? new Int32Array(new SharedArrayBuffer(((N + 63) >> SHIFT) * 4)) : null;
  const rotationEpoch = stamps ? new Int32Array(new SharedArrayBuffer(4)) : null;
  if (rotationEpoch) rotationEpoch[0] = 1;
  globalThis.weedjsBindPoseBench({
    poseSync,
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
    rotationStamps,
    rotationEpoch,
    rotationBlockShift: SHIFT,
  });
  /** A turn as Box2D's export makes it: the rotation, then its block stamped with the current epoch. */
  function turn(i, c, s) {
    views.rotC[i] = c;
    views.rotS[i] = s;
    if (rotationStamps) rotationStamps[i >> SHIFT] = rotationEpoch[0];
  }
  return { views, poseBuffers, poseSync, isBody, rotationStamps, rotationEpoch, turn };
}

/** Publish once; the buffer just written must hold every body's pose, bit for bit. */
function publishAndCheck(w, label) {
  globalThis.weedjsPublishPose();
  const out = w.poseBuffers[(w.poseSync[0] - 1) & 1];
  const bits = (f) => new Uint32Array(f.buffer, f.byteOffset, f.length);
  const [vc, vs, oc, os] = [bits(w.views.rotC), bits(w.views.rotS), bits(out.rotC), bits(out.rotS)];
  for (let i = 0; i < N; i++) {
    if (!w.isBody(i)) {
      assert.equal(oc[i], 0, `${label}: rotC of empty slot ${i} untouched`);
      continue;
    }
    assert.equal(out.x[i], w.views.x[i], `${label}: x of slot ${i}`);
    assert.equal(oc[i], vc[i], `${label}: rotC bits of slot ${i}`);
    assert.equal(os[i], vs[i], `${label}: rotS bits of slot ${i}`);
  }
}

const mostly = (i) => !(i >= 300 && i < 340);
const half = (i) => i % 2 === 0;

for (const [name, isBody] of [
  ['the slot walk', mostly],
  ['the dense list', half],
]) {
  test(`E-327 (${name}): a stamped turn reaches both buffers, each when it is next published`, () => {
    const w = world(isBody);
    publishAndCheck(w, 'first A');
    publishAndCheck(w, 'first B');
    // A few bodies turn (a teleport, a respawn, a spinning body), the others keep their rotation.
    for (const i of [0, 2, 298, 700, 1198]) w.turn(i, -w.views.rotC[i], 0.5);
    publishAndCheck(w, 'turned A');
    w.turn(64, 0.25, 0.75);
    publishAndCheck(w, 'turned B');
    publishAndCheck(w, 'still A');
    publishAndCheck(w, 'still B');
  });

  test(`E-327 (${name}): a block nobody stamped is neither read nor written`, () => {
    const w = world(isBody);
    publishAndCheck(w, 'first A');
    publishAndCheck(w, 'first B');
    // Written behind Box2D's back (no export, no stamp): the buffers keep what they held.
    const before = w.poseBuffers[0].rotC[2];
    w.views.rotC[2] = 0.125;
    globalThis.weedjsPublishPose();
    assert.equal(w.poseBuffers[0].rotC[2], before);
    assert.equal(w.poseBuffers[0].x[2], w.views.x[2]);
  });

  test(`E-327 (${name}): without stamps every rotation is copied every time`, () => {
    const w = world(isBody, { stamps: false });
    publishAndCheck(w, 'first A');
    w.views.rotC[4] = -0;
    w.views.rotS[700] = 0.5;
    publishAndCheck(w, 'B');
    publishAndCheck(w, 'A');
  });
}

test('E-327: a rotation N-86 invalidated (0, 0) is written again on the next publish of that buffer', () => {
  const w = world(mostly);
  publishAndCheck(w, 'first A');
  publishAndCheck(w, 'first B');
  // N-86's repair, in A's publish: rotC = rotS = 0 for a slot respawned during it, its block stamped with the epoch after
  // the one that publish carried (the epoch word holds it once the publish is done).
  globalThis.weedjsPublishPose();
  w.poseBuffers[0].rotC[10] = 0;
  w.poseBuffers[0].rotS[10] = 0;
  w.rotationStamps[10 >> SHIFT] = w.rotationEpoch[0];
  publishAndCheck(w, 'B');
  publishAndCheck(w, 'repaired A');
});

test('E-327: after a respawn (the epoch moved) the checked slot walk publishes stamped turns too', () => {
  const w = world(mostly, { epochMoved: true });
  publishAndCheck(w, 'first A');
  w.turn(500, 0.25, 0.5);
  publishAndCheck(w, 'turned B');
  publishAndCheck(w, 'turned A');
});

test('E-327: each publish moves the epoch on, and a buffer copies the blocks stamped since its own last publish', () => {
  const w = world(mostly);
  assert.equal(w.rotationEpoch[0], 1);
  publishAndCheck(w, 'first A');
  assert.equal(w.rotationEpoch[0], 2);
  w.turn(130, 0.5, 0.5); // stamped 2: after A's publish (1)
  publishAndCheck(w, 'B');
  assert.equal(w.rotationEpoch[0], 3);
  publishAndCheck(w, 'A again'); // A was published at 1, the stamp is 2
});
