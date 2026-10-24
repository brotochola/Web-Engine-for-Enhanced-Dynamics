import test from 'node:test';
import assert from 'node:assert/strict';
import { ladderAtLeast, recommendedMB } from '../bench/box2dMemorySurvey.mjs';

// BM-10 (docs/internal/BOX2D_MEMORY_PLAN.md): the survey recommends peak x 1.25, rounded up to a
// size on the ladder, 16 MB to 2 GB.

test('the recommendation is the peak plus a quarter, rounded up to the ladder', () => {
  assert.equal(recommendedMB(10), 16);
  assert.equal(recommendedMB(40), 64);
  assert.equal(recommendedMB(51.3), 96);
  assert.equal(recommendedMB(100), 128);
  assert.equal(recommendedMB(410), 768);
});

test('the ladder tops out at 2048 MB; a peak that needs more has no recommendation', () => {
  assert.equal(ladderAtLeast(2048), 2048);
  assert.equal(recommendedMB(1700), null);
});
