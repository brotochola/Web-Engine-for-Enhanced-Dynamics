import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadWorker } from '../bench/workerHarness.mjs';

// M4. IDLE_MS is the gap since the previous frame ended. resume() reset the
// delta clock but not that stamp, so the first frame after a pause reported the
// whole pause as idle (seconds), and every save pauses now (pauseAndSettle).

test('the first frame after resume does not report the pause as idle', async () => {
  const w = await loadWorker('particleWorker.js', 'particleWorker');
  w.usesCustomScheduler = true; // resume() must not start a real loop here
  w.update = () => {};
  w.reportFPS = () => {};
  w._runFrame(false);
  w.pause();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); // a real 250 ms pause
  w.resume();
  w._runFrame(true);
  assert.ok(w.idleTimeThisFrame < 50, `idle after resume: ${w.idleTimeThisFrame.toFixed(1)} ms`);
});

test('the physics host forgets the last frame end when it starts again', () => {
  const src = readFileSync(new URL('../../src/box2d/physicsHostImpl.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function startGameLoop()'), src.indexOf('self.onmessage'));
  assert.match(fn, /state\._lastFrameEndAt = 0;/);
});
