import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SPAWN_CMD_KIND,
  createSpawnCommandRingSab,
  bindSpawnCommandRing,
  tryPushSpawn,
  tryPushDespawn,
  drainSpawnCommands,
  spawnCommandRingCapacity,
  spawnCommandRingOverflowCount,
} from '../../src/util/spawnCommandRing.js';

function bindFresh(cap) {
  const sab = createSpawnCommandRingSab(cap);
  bindSpawnCommandRing(sab);
  return sab;
}

function drainAll() {
  const out = [];
  drainSpawnCommands((kind, typeId, entityIndex, x, y) => {
    out.push({ kind, typeId, entityIndex, x, y });
  });
  return out;
}

test('drain empty ring is zero', () => {
  bindFresh(4);
  assert.equal(spawnCommandRingCapacity(), 4);
  assert.equal(drainSpawnCommands(() => {}), 0);
  assert.deepEqual(drainAll(), []);
  bindSpawnCommandRing(null);
});

test('FIFO spawn order and checksum of indices', () => {
  bindFresh(8);
  assert.equal(tryPushSpawn(1, 10, 1.5, 2.5), true);
  assert.equal(tryPushSpawn(1, 11, 3, 4), true);
  assert.equal(tryPushSpawn(2, 20, 0, 0), true);
  const got = drainAll();
  assert.equal(got.length, 3);
  assert.deepEqual(
    got.map((c) => c.entityIndex),
    [10, 11, 20],
  );
  assert.equal(got[0].kind, SPAWN_CMD_KIND.SPAWN);
  assert.equal(got[0].typeId, 1);
  assert.equal(got[0].x, 1.5);
  assert.equal(got[0].y, 2.5);
  let xor = 0;
  for (let i = 0; i < got.length; i++) xor ^= got[i].entityIndex;
  assert.equal(xor, 10 ^ 11 ^ 20);
  bindSpawnCommandRing(null);
});

test('overflow returns false and leaves FIFO prefix', () => {
  bindFresh(4);
  let ok = 0;
  for (let i = 0; i < 6; i++) {
    if (tryPushSpawn(1, i, i, i)) ok++;
  }
  assert.equal(ok, 4);
  assert.ok(spawnCommandRingOverflowCount() >= 2);
  const got = drainAll();
  assert.deepEqual(
    got.map((c) => c.entityIndex),
    [0, 1, 2, 3],
  );
  assert.equal(tryPushSpawn(1, 99, 0, 0), true);
  assert.deepEqual(
    drainAll().map((c) => c.entityIndex),
    [99],
  );
  bindSpawnCommandRing(null);
});

test('wrap reuses slots after drain', () => {
  bindFresh(4);
  for (let i = 0; i < 4; i++) assert.equal(tryPushSpawn(1, i, i, 0), true);
  const first = drainAll();
  assert.deepEqual(
    first.map((c) => c.entityIndex),
    [0, 1, 2, 3],
  );
  assert.equal(tryPushSpawn(1, 40, 0, 0), true);
  assert.equal(tryPushSpawn(1, 41, 0, 0), true);
  const second = drainAll();
  assert.deepEqual(
    second.map((c) => c.entityIndex),
    [40, 41],
  );
  bindSpawnCommandRing(null);
});

test('spawn and despawn stay interleaved FIFO', () => {
  bindFresh(8);
  assert.equal(tryPushSpawn(3, 5, 9, 8), true);
  assert.equal(tryPushDespawn(5), true);
  assert.equal(tryPushSpawn(3, 6, 1, 2), true);
  assert.equal(tryPushDespawn(6), true);
  const got = drainAll();
  assert.equal(got.length, 4);
  assert.equal(got[0].kind, SPAWN_CMD_KIND.SPAWN);
  assert.equal(got[0].entityIndex, 5);
  assert.equal(got[1].kind, SPAWN_CMD_KIND.DESPAWN);
  assert.equal(got[1].entityIndex, 5);
  assert.equal(got[2].kind, SPAWN_CMD_KIND.SPAWN);
  assert.equal(got[2].entityIndex, 6);
  assert.equal(got[3].kind, SPAWN_CMD_KIND.DESPAWN);
  assert.equal(got[3].entityIndex, 6);
  bindSpawnCommandRing(null);
});
