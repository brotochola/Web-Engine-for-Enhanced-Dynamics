import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORCE_PROCESS_ON_LOGIC_WORKER_NONE,
  resolveForceProcessOnLogicWorker,
  logicWorkerThatShouldTick,
} from '../../src/util/logicOwner.js';

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
