import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { PRE_RENDER_STATS as S } from '../../src/util/workersUtils.js';

// A backpressure skip (Pixi more than one queue behind) does no work. When it
// published its near-zero step, STEP_MS became an average of real frames and
// skips, and fell or rose with how often Pixi kept up: the E-82 sitting read
// pre-render +217 % with the same busy time. A skip publishes only the skip.

test('a backpressure skip leaves the last worked frame in the meters', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  pre.stats = new Float32Array(S.STRIDE_FLOATS);
  pre.collectDetailedStats = true;

  pre.stepTimeThisFrame = 7.5;
  pre.idleTimeThisFrame = 2.25;
  pre.skippedFramesThisFrame = 0;
  pre.reportFPS();
  assert.equal(pre.stats[S.STEP_MS], 7.5);
  assert.equal(pre.stats[S.SKIPPED_FRAMES], 0);

  // The real skip path: update() returns before any work and reportFPS follows.
  pre.pixiIsMoreThanOneFrameBehind = () => true;
  pre._runFrame(false);
  assert.equal(pre.skippedFramesThisFrame, 1);
  assert.equal(pre.stats[S.STEP_MS], 7.5, 'the skip did not overwrite the step');
  assert.equal(pre.stats[S.IDLE_MS], 2.25);
  assert.equal(pre.stats[S.SKIPPED_FRAMES], 1);
});
