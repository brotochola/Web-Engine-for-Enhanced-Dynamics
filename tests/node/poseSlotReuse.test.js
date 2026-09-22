import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindBodySyncBuffers,
  bumpBodyGeneration,
  poseRotationLive,
} from '../../src/box2d/box2dBodySync.js';

test('spawn bump drops the previous pose in both buffers', () => {
  const n = 4;
  const bytes = n * 16;
  const dataA = new SharedArrayBuffer(bytes);
  const dataB = new SharedArrayBuffer(bytes);
  const rotA = new Float32Array(dataA, n * 8, n);
  const rotB = new Float32Array(dataB, n * 8, n);
  const sinA = new Float32Array(dataA, n * 12, n);
  const sinB = new Float32Array(dataB, n * 12, n);
  rotA[2] = 1;
  rotB[2] = 1;
  sinA[2] = 0.2;
  sinB[2] = 0.2;
  bindBodySyncBuffers({
    bodyDirtyFlags: new SharedArrayBuffer(n * 4),
    bodyDirtyWords: new SharedArrayBuffer(4),
    bodyGeneration: new SharedArrayBuffer(n * 4),
    poseDataA: dataA,
    poseDataB: dataB,
  });
  assert.equal(poseRotationLive(rotA[2], sinA[2]), true);
  bumpBodyGeneration(2);
  assert.equal(rotA[2], 0);
  assert.equal(rotB[2], 0);
  assert.equal(sinA[2], 0);
  assert.equal(sinB[2], 0);
  assert.equal(poseRotationLive(0, 0), false);
  assert.equal(poseRotationLive(1, 0), true);
  bindBodySyncBuffers(null);
});
