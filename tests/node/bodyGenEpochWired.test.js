import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSceneSharedBuffers } from '../../src/util/sceneWorkerBootstrap.js';
import { advanceBodyGeneration, bindBodySyncBuffers } from '../../src/box2d/box2dBodySync.js';

// The body generation epoch reaches the workers. A spawn moves it with the slot's generation, and physics'
// pose publish (weedjsPost.js publishPose) skips the per-body generation load while it holds. The workers'
// buffer list left it out, so physics never had it and took the per-body path every step (Boids: 42 % of
// publishPose), and a logic worker's spawn could not move it.

test('the workers get bodyGenEpoch, and a spawn on a worker moves it', () => {
  const n = 8;
  const buffers = {
    bodyDirtyFlags: new SharedArrayBuffer(n * 4),
    bodyDirtyWords: new SharedArrayBuffer(Math.ceil(n / 32) * 4 + 4),
    bodyGeneration: new SharedArrayBuffer(n * 4),
    bodyGenEpoch: new SharedArrayBuffer(4),
  };
  const shared = buildSceneSharedBuffers({ buffers });
  assert.equal(shared.bodyGenEpoch, buffers.bodyGenEpoch, 'the epoch is in the workers\' buffers');
  assert.equal(shared.bodyGeneration, buffers.bodyGeneration);

  // What a worker binds from that list.
  bindBodySyncBuffers(shared);
  const epoch = new Int32Array(buffers.bodyGenEpoch);
  const generation = new Int32Array(buffers.bodyGeneration);
  advanceBodyGeneration(3);
  assert.equal(generation[3], 1);
  assert.equal(epoch[0], 1, 'the spawn moved the epoch the physics worker reads');
  bindBodySyncBuffers(null);
});
