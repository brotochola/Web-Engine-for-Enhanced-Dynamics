import test from 'node:test';
import assert from 'node:assert/strict';

import { bumpBodyGeneration, bindBodySyncBuffers } from '../../src/box2d/box2dBodySync.js';
import { loadPost } from '../bench/publishPoseMicrobench.mjs';

test('bumpBodyGeneration increments the shared epoch', () => {
  const n = 4;
  const buffers = {
    bodyDirtyFlags: new SharedArrayBuffer(n * 4),
    bodyDirtyWords: new SharedArrayBuffer(4),
    bodyGeneration: new SharedArrayBuffer(n * 4),
    bodyGenEpoch: new SharedArrayBuffer(4),
  };
  bindBodySyncBuffers(buffers);
  const epoch = new Int32Array(buffers.bodyGenEpoch);
  const gen = new Int32Array(buffers.bodyGeneration);
  assert.equal(epoch[0], 0);
  const next = bumpBodyGeneration(1);
  assert.equal(next, 1);
  assert.equal(Atomics.load(gen, 1), 1);
  assert.equal(Atomics.load(epoch, 0), 1);
  bumpBodyGeneration(1);
  assert.equal(Atomics.load(epoch, 0), 2);
});

test('publishPose skips a stale generation until a clean pass, then stays on the fast path', () => {
  loadPost('base');
  const n = 8;
  const list = new Int32Array(n);
  const x = new Float32Array(n);
  const generation = new Int32Array(new SharedArrayBuffer(n * 4));
  const seen = new Int32Array(n);
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < n; i++) {
    list[i] = i;
    x[i] = 10 + i;
    generation[i] = 1;
    seen[i] = 1;
  }
  const poseSync = new Int32Array(new SharedArrayBuffer(8));
  const buf = () => ({ x: new Float32Array(n), y: new Float32Array(n), rotC: new Float32Array(n), rotS: new Float32Array(n) });
  const poseBuffers = [buf(), buf()];
  const bind = (seenEpoch) => globalThis.weedjsBindPoseBench({
    poseSync,
    poseBuffers,
    denseList: list,
    denseCount: n,
    views: { x, y: x, rotC: x, rotS: x },
    bodyGeneration: generation,
    seenBodyGeneration: seen,
    poseFrame: 0,
    poseGenEpoch: epoch,
    seenPoseGenEpoch: seenEpoch,
  });

  bind(0);
  globalThis.weedjsPublishPose();
  assert.equal(poseBuffers[0].x[3], 13);

  Atomics.store(epoch, 0, 1);
  Atomics.store(generation, 3, 2);
  poseBuffers[0].x[3] = 0;
  poseBuffers[1].x[3] = 0;
  bind(0);
  globalThis.weedjsPublishPose();
  const slowBuf = poseSync[0] & 1 ? poseBuffers[1] : poseBuffers[0];
  // Frame counter advanced; the buffer just written is (poseFrame-1) & 1, but bind reset poseFrame to 0
  // so the write landed in buffer 0.
  assert.equal(poseBuffers[0].x[3], 0, 'stale generation is not published');

  seen[3] = 2;
  poseBuffers[0].x[3] = 0;
  bind(0);
  globalThis.weedjsPublishPose();
  assert.equal(poseBuffers[0].x[3], 13, 'clean pass publishes and latches');

  Atomics.store(generation, 3, 9);
  poseBuffers[0].x[3] = 0;
  bind(1);
  globalThis.weedjsPublishPose();
  assert.equal(poseBuffers[0].x[3], 13, 'latched epoch does not re-read a generation that was not bumped');
  void slowBuf;
});

test('a slot respawned while the fast path publishes gets its invalidation back (N-86)', () => {
  loadPost('base');
  const n = 8;
  const list = new Int32Array(n);
  const x = new Float32Array(n);
  const rot = new Float32Array(n).fill(1);
  const generation = new Int32Array(new SharedArrayBuffer(n * 4));
  const seen = new Int32Array(n);
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < n; i++) {
    list[i] = i;
    x[i] = 10 + i;
    generation[i] = 1;
    seen[i] = 1;
  }
  const poseSync = new Int32Array(new SharedArrayBuffer(8));
  const buf = () => ({ x: new Float32Array(n), y: new Float32Array(n), rotC: new Float32Array(n), rotS: new Float32Array(n) });
  const poseBuffers = [buf(), buf()];
  // Reading slot 2's x stands for a logic worker that despawns and respawns slot 5 meanwhile: the epoch and slot 5's
  // body generation move, and its published rotation is invalidated (box2dBodySync.js invalidatePoseSlot).
  const xs = new Proxy(x, {
    get(t, k) {
      if (k === '2') {
        Atomics.add(epoch, 0, 1);
        Atomics.add(generation, 5, 1);
        for (const b of poseBuffers) {
          b.rotC[5] = 0;
          b.rotS[5] = 0;
        }
      }
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  globalThis.weedjsBindPoseBench({
    poseSync,
    poseBuffers,
    denseList: list,
    denseCount: n,
    views: { x: xs, y: x, rotC: rot, rotS: rot },
    bodyGeneration: generation,
    seenBodyGeneration: seen,
    poseFrame: 0,
    poseGenEpoch: epoch,
    seenPoseGenEpoch: 0,
  });
  globalThis.weedjsPublishPose();
  const out = poseBuffers[0];
  assert.equal(out.rotC[5], 0, 'the respawned slot keeps its invalidation, not its old body\'s rotation');
  assert.equal(out.rotS[5], 0);
  assert.equal(out.rotC[4], 1, 'the others are published');
  assert.equal(out.x[6], 16);
});
