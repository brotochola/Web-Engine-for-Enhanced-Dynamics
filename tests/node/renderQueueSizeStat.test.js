import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { PRE_RENDER_STATS } from '../../src/util/workersUtils.js';

// M1. RENDER_QUEUE_SIZE is a load key of the A/B gate, but pre-render wrote it
// only with detailed stats on. Off, both sides read 0, and the gate skips a key
// whose baseline is 0, so a run that queued a different number of sprites
// still passed. It is now published every frame, like VISIBLE_ENTITIES.

test('RENDER_QUEUE_SIZE is published without detailed stats', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  pre.stats = new Float32Array(64);
  pre.collectDetailedStats = false;
  pre.renderQueueCount = new Uint32Array([123]);
  pre.reportFPS();
  assert.equal(pre.stats[PRE_RENDER_STATS.RENDER_QUEUE_SIZE], 123);
  // Detail-only timers stay off.
  pre.collectTimeThisFrame = 5;
  pre.reportFPS();
  assert.equal(pre.stats[PRE_RENDER_STATS.COLLECT_MS], 0);
});
