import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORCE_PROCESS_ON_LOGIC_WORKER_NONE,
  resolveForceProcessOnLogicWorker,
  logicWorkerThatShouldTick,
  logicBlockRange,
  tickBucketPhase,
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

test('tickBucketPhase matches the countdown schedule', () => {
  function countdownFrames(id, interval, frames) {
    let next = (id % interval) + 1;
    const hit = [];
    for (let frame = 1; frame <= frames; frame++) {
      if (--next > 0) continue;
      hit.push(frame);
      next = interval;
    }
    return hit;
  }
  for (const interval of [2, 4, 6]) {
    for (let id = 0; id < interval * 3; id++) {
      const phase = tickBucketPhase(id, interval);
      const fromCountdown = countdownFrames(id, interval, interval * 4);
      const fromBucket = [];
      for (let frame = 1; frame <= interval * 4; frame++) {
        if (frame % interval === phase) fromBucket.push(frame);
      }
      assert.deepEqual(fromBucket, fromCountdown);
    }
  }
});

test('logicBlockRange covers every slot once', () => {
  const count = 60000;
  const seen = new Uint8Array(count);
  for (const w of [1, 2, 4]) {
    seen.fill(0);
    for (let i = 0; i < w; i++) {
      const { start, end } = logicBlockRange(count, i, w);
      for (let s = start; s < end; s++) seen[s]++;
    }
    for (let s = 0; s < count; s++) assert.equal(seen[s], 1);
  }
  assert.deepEqual(logicBlockRange(10, 0, 1), { start: 0, end: 10 });
});
