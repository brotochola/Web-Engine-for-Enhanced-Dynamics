import test from 'node:test';
import assert from 'node:assert/strict';

import { Ray } from '../../src/core/ray.js';

test('Ray beginFrame / consumeStats track outermost calls', () => {
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

test('Ray work does not increment Box2d ray stats', async () => {
  const { Box2d } = await import('../../src/core/box2d.js');
  const prevRay = Ray.collectDetailedStats;
  const prevBox = Box2d.collectDetailedStats;
  Ray.collectDetailedStats = true;
  Box2d.collectDetailedStats = true;
  try {
    Ray.beginFrame();
    Box2d.beginFrame();
    Ray._enterStats();
    Ray._leaveStats();
    const ray = Ray.consumeStats();
    const box = Box2d.consumeStats();
    assert.equal(ray.count, 1);
    assert.equal(box.count, 0);
    assert.equal(box.ms, 0);
  } finally {
    Ray.collectDetailedStats = prevRay;
    Box2d.collectDetailedStats = prevBox;
  }
});

test('Ray.consumeStats clears accumulators', () => {
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
