import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadWorker } from '../bench/workerHarness.mjs';
import { nextFixedDeadline } from '../../src/util/fixedRate.js';

// N-128: a worker's fixedFps scheduled setInterval(loop, 1000 / fps), and timers take whole milliseconds: 60 frames a
// second asked for 16 ms and ran at 62.5, each step's dt fixed at 1/60, so the simulation ran about 4 % fast. Each
// frame is now due one period after the last frame's deadline.

/**
 * Runs `frames` frames of `worker` at fixedFps under fake timers that, like a browser's, take whole ms and fire a
 * little late; returns the fake clock's ms from the first frame's schedule to the last frame's start.
 */
function runFixed(worker, fps, frames) {
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const realNow = performance.now;
  let now = 1000;
  let pending = null;
  let timers = 0;
  let late = 0x2545f491;
  globalThis.setTimeout = (fn, delay) => {
    timers++;
    pending = { fn, delay: Math.trunc(Number(delay) || 0) };
    return timers;
  };
  // An interval would run the real loop on and on: it fails here instead.
  globalThis.setInterval = () => {
    throw new Error('fixedFps scheduled setInterval, which takes whole ms (N-128)');
  };
  performance.now = () => now;
  try {
    worker.fixedFps = fps;
    worker.timeoutId = null;
    worker._fixedNextAt = NaN;
    const start = now;
    for (let f = 0; f < frames; f++) {
      pending = null;
      worker.scheduleNextFrame();
      assert.ok(pending, `frame ${f}: a timer for the next frame`);
      // A second ask while one frame is pending does not start a second loop.
      const before = timers;
      worker.scheduleNextFrame();
      assert.equal(timers, before, 'one frame pending at a time');
      // The timer fires after its whole ms, 0 to 3 ms late; the frame's own work takes no fake time.
      late = (Math.imul(late, 1103515245) + 12345) >>> 0;
      now += pending.delay + (late % 4);
      worker.timeoutId = null; // as the timer's callback does before the loop asks for the next one
    }
    return now - start;
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
    performance.now = realNow;
  }
}

test('a worker at fixedFps 60 runs 60 frames a second, not 62.5', async () => {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  const frames = 600;
  const elapsed = runFixed(worker, 60, frames);
  const rate = (frames * 1000) / elapsed;
  // setInterval(16) would read 62.5 (and late timers make a deadline loop catch up, not drift).
  assert.ok(Math.abs(rate - 60) < 0.2, `${rate.toFixed(3)} frames a second`);
});

test('a pause starts the fixed-rate loop again one period from the resume', async () => {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  runFixed(worker, 60, 10);
  worker._clearFrameSchedulers();
  assert.ok(Number.isNaN(worker._fixedNextAt), 'no deadline kept across a pause');
});

test('the next deadline is one period after the last, or one from now when there is none or the loop fell behind', () => {
  const P = 1000 / 60;
  assert.equal(nextFixedDeadline(NaN, P, 500), 500 + P);
  assert.equal(nextFixedDeadline(1000, P, 1010), 1000 + P);
  // Late by less than a period: due at once, and the mean rate holds.
  assert.equal(nextFixedDeadline(1000, P, 1020), 1000 + P);
  // More than a period behind (a stall): no burst of catch-up frames.
  assert.equal(nextFixedDeadline(1000, P, 1100), 1100 + P);
});

test('the physics host schedules its fixed rate by deadline, not setInterval', () => {
  // physicsHostImpl.js is a classic worker script that a Node test cannot instantiate (physicsHostDtClamp.test.js).
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const host = readFileSync(join(root, 'src/box2d/physicsHostImpl.js'), 'utf8');
  // A call, not the comment that says why there is none.
  const code = host
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(code, /setInterval\(/, 'no setInterval: it takes whole ms');
  assert.match(host, /state\.fixedNextAt = fixedNext > fixedNow - fixedPeriod \? fixedNext : fixedNow \+ fixedPeriod;/);
  assert.match(host, /setTimeout\(fixedTick, /);
});
