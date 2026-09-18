import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGIC_WORKER_UNPINNED,
  resolveLogicWorker,
  logicOwner,
} from '../../src/util/logicOwner.js';

test('resolveLogicWorker ignores pin when only one worker', () => {
  assert.equal(resolveLogicWorker(1, 1), LOGIC_WORKER_UNPINNED);
  assert.equal(resolveLogicWorker(0, 1), LOGIC_WORKER_UNPINNED);
  assert.equal(resolveLogicWorker(-1, 4), LOGIC_WORKER_UNPINNED);
});

test('resolveLogicWorker wraps into worker count', () => {
  assert.equal(resolveLogicWorker(0, 2), 0);
  assert.equal(resolveLogicWorker(1, 2), 1);
  assert.equal(resolveLogicWorker(3, 2), 1);
  assert.equal(resolveLogicWorker(4, 3), 1);
});

test('logicOwner uses pin when set, else slot modulo', () => {
  const pins = new Int8Array([-1, 1, -1, 0]);
  assert.equal(logicOwner(0, 0, 2, pins), 0);
  assert.equal(logicOwner(0, 1, 2, pins), 1);
  assert.equal(logicOwner(1, 2, 2, pins), 1);
  assert.equal(logicOwner(3, 3, 2, pins), 0);
});
