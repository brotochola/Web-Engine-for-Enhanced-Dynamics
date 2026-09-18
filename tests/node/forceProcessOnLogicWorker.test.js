import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORCE_PROCESS_ON_LOGIC_WORKER_NONE,
  resolveForceProcessOnLogicWorker,
  logicWorkerThatShouldTick,
} from '../../src/util/logicOwner.js';
import { GameObject } from '../../src/core/gameObject.js';

test('resolveForceProcessOnLogicWorker ignores force when only one worker', () => {
  assert.equal(resolveForceProcessOnLogicWorker(1, 1), FORCE_PROCESS_ON_LOGIC_WORKER_NONE);
  assert.equal(resolveForceProcessOnLogicWorker(0, 1), FORCE_PROCESS_ON_LOGIC_WORKER_NONE);
  assert.equal(resolveForceProcessOnLogicWorker(-1, 4), FORCE_PROCESS_ON_LOGIC_WORKER_NONE);
});

test('resolveForceProcessOnLogicWorker wraps into worker count', () => {
  assert.equal(resolveForceProcessOnLogicWorker(0, 2), 0);
  assert.equal(resolveForceProcessOnLogicWorker(1, 2), 1);
  assert.equal(resolveForceProcessOnLogicWorker(3, 2), 1);
  assert.equal(resolveForceProcessOnLogicWorker(4, 3), 1);
});

test('logicWorkerThatShouldTick uses forced worker when set, else slot modulo', () => {
  const forceProcessOnLogicWorker = new Int16Array([-1, 1, -1, 0]);
  assert.equal(logicWorkerThatShouldTick(0, 0, 2, forceProcessOnLogicWorker), 0);
  assert.equal(logicWorkerThatShouldTick(0, 1, 2, forceProcessOnLogicWorker), 1);
  assert.equal(logicWorkerThatShouldTick(1, 2, 2, forceProcessOnLogicWorker), 1);
  assert.equal(logicWorkerThatShouldTick(3, 3, 2, forceProcessOnLogicWorker), 0);
});

test('worker 0 is a real forced worker, not the none sentinel', () => {
  const forceProcessOnLogicWorker = new Int16Array([0, FORCE_PROCESS_ON_LOGIC_WORKER_NONE]);
  assert.equal(logicWorkerThatShouldTick(5, 0, 3, forceProcessOnLogicWorker), 0);
  assert.equal(logicWorkerThatShouldTick(5, 1, 3, forceProcessOnLogicWorker), 5 % 3);
});

test('despawn of the last forced instance returns the type to stride', () => {
  const previousForce = GameObject.forceProcessOnLogicWorker;
  const previousFlag = GameObject.entityTypeHasForcedLogicWorker;
  const previousCount = GameObject.entityTypeForcedLogicWorkerCount;
  GameObject.forceProcessOnLogicWorker = new Int16Array([-1, -1]);
  GameObject.entityTypeHasForcedLogicWorker = new Uint8Array(4);
  GameObject.entityTypeForcedLogicWorkerCount = new Uint16Array(4);
  try {
    GameObject.writeForceProcessOnLogicWorker(0, 2, 1);
    GameObject.writeForceProcessOnLogicWorker(1, 2, FORCE_PROCESS_ON_LOGIC_WORKER_NONE);
    assert.equal(GameObject.entityTypeForcedLogicWorkerCount[2], 1);
    assert.equal(GameObject.entityTypeHasForcedLogicWorker[2], 1);
    assert.equal(logicWorkerThatShouldTick(0, 0, 2, GameObject.forceProcessOnLogicWorker), 1);
    assert.equal(logicWorkerThatShouldTick(1, 1, 2, GameObject.forceProcessOnLogicWorker), 1);

    GameObject.writeForceProcessOnLogicWorker(0, 2, FORCE_PROCESS_ON_LOGIC_WORKER_NONE);
    assert.equal(GameObject.entityTypeForcedLogicWorkerCount[2], 0);
    assert.equal(GameObject.entityTypeHasForcedLogicWorker[2], 0);
    assert.equal(logicWorkerThatShouldTick(0, 0, 2, GameObject.forceProcessOnLogicWorker), 0);
    assert.equal(logicWorkerThatShouldTick(1, 1, 2, GameObject.forceProcessOnLogicWorker), 1);
  } finally {
    GameObject.forceProcessOnLogicWorker = previousForce;
    GameObject.entityTypeHasForcedLogicWorker = previousFlag;
    GameObject.entityTypeForcedLogicWorkerCount = previousCount;
  }
});

test('Int16 stores 128 without wrapping into “not forced”', () => {
  const forceProcessOnLogicWorker = new Int16Array(1);
  forceProcessOnLogicWorker[0] = 128;
  assert.equal(forceProcessOnLogicWorker[0], 128);
  assert.ok(forceProcessOnLogicWorker[0] >= 0);
  const asInt8 = new Int8Array(1);
  asInt8[0] = 128;
  assert.equal(asInt8[0], -128);
});
