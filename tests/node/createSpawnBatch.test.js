import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isXyOnlySpawnConfig,
  createCreateSpawnQueue,
  pushCreateSpawn,
  buildSpawnBatchPayloads,
  clearCreateSpawnQueue,
  pushCreateSpawnExtra,
  collectCreateSpawnExtras,
} from '../../src/util/createSpawnBatch.js';

test('isXyOnlySpawnConfig treats position and owner as metadata', () => {
  assert.equal(isXyOnlySpawnConfig(null), true);
  assert.equal(isXyOnlySpawnConfig({}), true);
  assert.equal(isXyOnlySpawnConfig({ x: 1, y: 2 }), true);
  assert.equal(isXyOnlySpawnConfig({ x: 1, y: 2, forceProcessOnLogicWorker: 0 }), true);
  assert.equal(isXyOnlySpawnConfig({ x: 1, y: 2, vx: 3 }), false);
  assert.equal(isXyOnlySpawnConfig({ tint: 0xff00ff }), false);
});

test('buildSpawnBatchPayloads groups by worker and class, transfers indices', () => {
  const queue = createCreateSpawnQueue(4);
  pushCreateSpawn(queue, 10, 'Bunny', { x: 1, y: 2 }, 0);
  pushCreateSpawn(queue, 11, 'Bunny', { x: 3, y: 4 }, 0);
  pushCreateSpawn(queue, 20, 'Ball', { x: 0, y: 0, vx: 5 }, 0);
  pushCreateSpawn(queue, 30, 'Bunny', { x: 9, y: 9 }, 1);

  const payloads = buildSpawnBatchPayloads(queue);
  assert.equal(payloads.length, 2);

  const zero = payloads.find((p) => p.workerIndex === 0);
  const one = payloads.find((p) => p.workerIndex === 1);
  assert.ok(zero);
  assert.ok(one);

  assert.equal(zero.groups.length, 2);
  assert.equal(zero.groups[0].className, 'Bunny');
  assert.deepEqual(Array.from(zero.groups[0].entityIndex), [10, 11]);
  assert.equal(zero.groups[0].spawnConfigs, undefined);
  assert.equal(zero.groups[1].className, 'Ball');
  assert.deepEqual(Array.from(zero.groups[1].entityIndex), [20]);
  assert.deepEqual(zero.groups[1].spawnConfigs, [{ x: 0, y: 0, vx: 5 }]);
  assert.equal(zero.transfers.length, 2);

  assert.equal(one.groups.length, 1);
  assert.deepEqual(Array.from(one.groups[0].entityIndex), [30]);
  assert.equal(one.groups[0].spawnConfigs, undefined);

  clearCreateSpawnQueue(queue);
  assert.equal(queue.n, 0);
  assert.equal(buildSpawnBatchPayloads(queue).length, 0);
});

test('create flush extras sidecar skips xy-only configs', () => {
  const extras = [];
  assert.equal(pushCreateSpawnExtra(extras, 10, 'Bunny', { x: 1, y: 2 }), false);
  assert.equal(pushCreateSpawnExtra(extras, 11, 'Bunny', { x: 3, y: 4, forceProcessOnLogicWorker: 0 }), false);
  assert.equal(pushCreateSpawnExtra(extras, 20, 'Ball', { x: 0, y: 0, vx: 5 }), true);
  assert.equal(extras.length, 1);
  assert.deepEqual(extras[0], {
    entityIndex: 20,
    className: 'Ball',
    spawnConfig: { x: 0, y: 0, vx: 5 },
  });

  const queue = createCreateSpawnQueue(4);
  pushCreateSpawn(queue, 10, 'Bunny', { x: 1, y: 2 }, 0);
  pushCreateSpawn(queue, 20, 'Ball', { x: 0, y: 0, vx: 5 }, 0);
  const fromQueue = collectCreateSpawnExtras(queue);
  assert.equal(fromQueue.length, 1);
  assert.equal(fromQueue[0].entityIndex, 20);
  assert.equal(fromQueue[0].className, 'Ball');
  assert.deepEqual(fromQueue[0].spawnConfig, { x: 0, y: 0, vx: 5 });
});
