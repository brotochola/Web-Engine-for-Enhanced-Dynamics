import test from 'node:test';
import assert from 'node:assert/strict';

import { Ray } from '../../src/core/ray.js';

test('Ray beginFrame / consumeStats track outermost calls', { concurrency: false }, () => {
  const prev = Ray.collectDetailedStats;
  Ray.collectDetailedStats = true;
  try {
    Ray.beginFrame();
    Ray._enterStats();
    Ray._enterStats(); // nested
    Ray._leaveStats();
    Ray._leaveStats();
    const a = Ray.consumeStats();
    assert.equal(a.count, 1);
    assert.ok(a.ms >= 0);

    Ray.beginFrame();
    Ray._enterStats();
    Ray._leaveStats();
    Ray._enterStats();
    Ray._leaveStats();
    const b = Ray.consumeStats();
    assert.equal(b.count, 2);
  } finally {
    Ray.collectDetailedStats = prev;
  }
});

test('Ray.consumeStats clears accumulators', { concurrency: false }, () => {
  const prev = Ray.collectDetailedStats;
  Ray.collectDetailedStats = true;
  try {
    Ray.beginFrame();
    Ray._enterStats();
    Ray._leaveStats();
    Ray.consumeStats();
    const again = Ray.consumeStats();
    assert.equal(again.count, 0);
    assert.equal(again.ms, 0);
  } finally {
    Ray.collectDetailedStats = prev;
  }
});
