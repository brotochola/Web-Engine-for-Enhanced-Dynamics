import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AbstractWorker } from '../../src/workers/abstractWorker.js';
import {
  CLOCK_BYTES,
  MAX_TIME_SCALE,
  SIM_CLOCK_HOLD_MS,
  SIM_CLOCK_MAX_STEP_MS,
  Time,
  sanitizeTimeScale,
  scaleSimMs,
  simClockStepMs,
} from '../../src/core/timeScale.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function timingStub(wallMsAgo) {
  return {
    lastFrameTime: performance.now() - wallMsAgo,
    fixedFps: 0,
    _injectedDeltaTime: 0,
    frameRateData: new Float32Array(4),
    frameRateIndex: 0,
    frameRateStride: 2,
    currentFPS: 0,
    accumulatedTime: 0,
    frameNumber: 0,
    _timing: { deltaTime: 0, dtRatio: 1 },
  };
}

test('sanitizeTimeScale: non-finite is 1, non-positive is 0, clamped to MAX_TIME_SCALE', () => {
  assert.equal(sanitizeTimeScale(1), 1);
  assert.equal(sanitizeTimeScale(0.25), 0.25);
  assert.equal(sanitizeTimeScale(0), 0);
  assert.equal(sanitizeTimeScale(-2), 0);
  assert.equal(sanitizeTimeScale(Number.NaN), 1);
  assert.equal(sanitizeTimeScale(Number.POSITIVE_INFINITY), 1);
  assert.equal(sanitizeTimeScale(MAX_TIME_SCALE), 4);
  assert.equal(sanitizeTimeScale(100), 4);
  assert.equal(scaleSimMs(16, 0.5), 8);
  assert.equal(scaleSimMs(16, 0), 0);
  assert.equal(scaleSimMs(16, Number.NaN), 16);
  assert.equal(scaleSimMs(16, 10), 16 * 4);
});

test('Time.scale writes the clock SAB and scales sim ms', { concurrency: false }, () => {
  const sab = new SharedArrayBuffer(4);
  const raw = new Float32Array(sab);
  raw[0] = 1;
  Time.bind(sab);
  try {
    assert.equal(Time.scale, 1);
    Time.scale = 0.5;
    assert.equal(raw[0], 0.5);
    assert.equal(Time.scaleSimMs(20), 10);
    Time.scale = 0;
    assert.equal(Time.scaleSimMs(20), 0);
    Time.scale = -4;
    assert.equal(raw[0], 0);
    Time.scale = Number.NaN;
    assert.equal(raw[0], 1);
  } finally {
    Time.unbind();
  }
});

test('updateFrameTiming scales sim dt and leaves wall FPS alone', { concurrency: false }, () => {
  const sab = new SharedArrayBuffer(4);
  new Float32Array(sab)[0] = 1;
  Time.bind(sab);
  try {
    Time.scale = 0.25;
    const stub = timingStub(20);
    const before = stub.accumulatedTime;
    const timing = AbstractWorker.prototype.updateFrameTiming.call(stub);
    const wallFps = stub.frameRateData[0];
    assert.ok(wallFps > 8 && wallFps < 200, `wall FPS ${wallFps}`);
    assert.ok(
      Math.abs(timing.deltaTime * wallFps - 250) < 40,
      `sim ms ${timing.deltaTime} * wall FPS ${wallFps} should be scale*1000`,
    );
    assert.equal(timing.dtRatio, timing.deltaTime / 16.67);
    assert.equal(stub.accumulatedTime, before + timing.deltaTime);

    Time.scale = 0;
    const frozen = timingStub(20);
    frozen.accumulatedTime = 100;
    const hit = AbstractWorker.prototype.updateFrameTiming.call(frozen);
    assert.equal(hit.deltaTime, 0);
    assert.equal(hit.dtRatio, 0);
    assert.equal(frozen.accumulatedTime, 100);
    assert.ok(frozen.frameRateData[0] > 8 && frozen.frameRateData[0] < 200, 'hitstop still publishes wall FPS');

    const locked = timingStub(20);
    locked._injectedDeltaTime = 10;
    Time.scale = 2;
    const stepped = AbstractWorker.prototype.updateFrameTiming.call(locked);
    assert.equal(stepped.deltaTime, 20);
    assert.ok(locked.frameRateData[0] > 8 && locked.frameRateData[0] < 200, 'lockstep FPS stays on the wall gap');
  } finally {
    Time.unbind();
  }
});

test("the physics host's readTimeScale is sanitizeTimeScale for every value (R7)", () => {
  // The host is a classic script and keeps a copy. The copy had lost the
  // MAX_TIME_SCALE clamp: gameLoop's 1/30 s dt cap hid it, stepOnce has none.
  const host = readFileSync(join(root, 'src/box2d/physicsHostImpl.js'), 'utf8');
  const start = host.indexOf('  var MAX_TIME_SCALE = ');
  const end = host.indexOf('\n  function gameLoop()');
  assert.ok(start > 0 && end > start, 'readTimeScale block not found in physicsHostImpl.js');
  const state = { clockScale: new Float32Array(1) };
  const readTimeScale = new Function('state', `${host.slice(start, end)}\nreturn readTimeScale;`)(state);
  for (const v of [NaN, Infinity, -Infinity, -2, -0, 0, 1e-6, 0.25, 1, 2.5, MAX_TIME_SCALE, MAX_TIME_SCALE + 0.5, 100]) {
    state.clockScale[0] = v;
    assert.equal(readTimeScale(), sanitizeTimeScale(state.clockScale[0]), `scale ${v}`);
  }
  state.clockScale = null;
  assert.equal(readTimeScale(), 1, 'an unbound clock is real time');
});

test('physics host multiplies solver dt and still times STEP_MS with performance.now', () => {
  const host = readFileSync(join(root, 'src/box2d/physicsHostImpl.js'), 'utf8');
  assert.match(host, /dt \*= readTimeScale\(\)/);
  assert.match(host, /\(deltaTimeMs \/ 1000\) \* readTimeScale\(\)/);
  assert.match(host, /var stepMs = performance\.now\(\) - t0;\s*state\.stats\[PS\.STEP_MS\] = stepMs;/);
  assert.doesNotMatch(host, /STEP_MS\] = dt/);
});

test('Time.simNowMs: the shared sim clock advances by scaled ms, read the same through any view', { concurrency: false }, () => {
  const sab = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(sab, 0, 1)[0] = 1;
  Time.bind(sab);
  try {
    assert.equal(Time.simNowMs, 0, 'starts at 0');
    Time._advanceSimNow(simClockStepMs(16, Time.scale));
    assert.equal(Time.simNowMs, 16);
    Time.scale = 0.5;
    Time._advanceSimNow(simClockStepMs(16, Time.scale));
    assert.equal(Time.simNowMs, 24, 'Time.scale slows it');
    Time.scale = 0;
    Time._advanceSimNow(simClockStepMs(16, Time.scale));
    assert.equal(Time.simNowMs, 24, 'a hitstop stops it');
    assert.equal(new Float64Array(sab, 8, 1)[0], 24, 'another realm reads the same f64');
    assert.equal(Atomics.load(new Int32Array(sab, 4, 1), 0) & 1, 0, 'the sequence is even between writes');
  } finally {
    Time.unbind();
  }
});

test('simClockStepMs clamps a wall delta as the workers do; a lockstep step is not clamped', () => {
  assert.equal(simClockStepMs(16, 1), 16);
  assert.equal(simClockStepMs(5000, 1), SIM_CLOCK_MAX_STEP_MS, 'a tab back from the background does not jump');
  assert.equal(simClockStepMs(-3, 1), 0);
  assert.equal(simClockStepMs(250, 1, true), 250, 'an injected step is taken as given');
  assert.equal(simClockStepMs(40, 2), 80);
});

test('a clock SAB without the sim clock reads 0 and ignores advances', { concurrency: false }, () => {
  Time.bind(new SharedArrayBuffer(4));
  try {
    Time._advanceSimNow(16);
    assert.equal(Time.simNowMs, 0);
    assert.equal(Time.scale, 0, 'a zeroed scale slot is a hitstop, as before');
  } finally {
    Time.unbind();
  }
});

test('the scene allocates the sim clock; the frame loop steps it, pause stops it, stepFrame advances it', () => {
  const sharedBuffers = readFileSync(join(root, 'src/util/sceneSharedBuffers.js'), 'utf8');
  assert.match(sharedBuffers, /buffers\.clockData = new SharedArrayBuffer\(CLOCK_BYTES\)/);
  const scene = readFileSync(join(root, 'src/core/scene.js'), 'utf8');
  assert.equal((scene.match(/Time\._advanceSimNow\(simClockStepMs\(/g) || []).length, 1, 'stepFrame');
  assert.match(scene, /Time\._stepSimFrame\(frameAbs\);/, 'the frame loop steps it');
  assert.match(scene, /pause\(\) \{\s*this\.state\.pause = true;\s*Time\._stopSimClock\(\);/, 'pause stops it');
});

/** Spin for `ms` of wall time (the clock reads performance.now, so no timer may stand in for the wait). */
function busy(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end);
}

/** A main frame at this wall time, as Scene's frame loop gives it. */
function mainFrame() {
  Time._stepSimFrame(performance.timeOrigin + performance.now());
}

test('a running sim clock moves once a main frame, by the frame, at Time.scale; a stop freezes it', { concurrency: false }, () => {
  const sab = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(sab, 0, 1)[0] = 1;
  Time.bind(sab);
  try {
    mainFrame();
    assert.equal(Time.simRunning, true, 'the first frame starts it');
    const t0 = Time.simNowMs;
    busy(25);
    assert.equal(Time.simNowMs, t0, 'between frames it holds');
    mainFrame();
    const t1 = Time.simNowMs;
    assert.ok(t1 - t0 >= 24 && t1 - t0 < 60, `a 25 ms frame: ${t1 - t0}`);
    // A scale change steps what ran at the old scale: no jump past the frame.
    busy(5);
    Time.scale = 0;
    const held = Time.simNowMs;
    assert.ok(held >= t1 && held - t1 < 20, `no jump at the hitstop: ${t1} -> ${held}`);
    busy(15);
    mainFrame();
    assert.equal(Time.simNowMs, held, 'a hitstop stops it');
    Time.scale = 2;
    busy(10);
    mainFrame();
    const fast = Time.simNowMs - held;
    assert.ok(fast >= 19 && fast < 60, `twice the frame at scale 2: ${fast}`);
    Time.scale = 1;
    Time._stopSimClock();
    assert.equal(Time.simRunning, false);
    const stopped = Time.simNowMs;
    busy(10);
    assert.equal(Time.simNowMs, stopped, 'a stop freezes it');
    mainFrame();
    busy(5);
    mainFrame();
    assert.ok(Time.simNowMs - stopped < 20, 'a start goes on from where it stopped, not from the wall time missed');
    assert.equal(Atomics.load(new Int32Array(sab, 4, 1), 0) & 1, 0, 'the sequence is even between writes');
  } finally {
    Time.unbind();
  }
});

test('past SIM_CLOCK_HOLD_MS without a main frame the readers carry the clock on, and the next frame goes on from there', { concurrency: false }, () => {
  const sab = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(sab, 0, 1)[0] = 1;
  Time.bind(sab);
  try {
    mainFrame();
    const t0 = Time.simNowMs;
    busy(SIM_CLOCK_HOLD_MS + 60);
    const carried = Time.simNowMs - t0;
    assert.ok(carried >= 55 && carried < 120, `60 ms past the hold: ${carried}`);
    mainFrame();
    const after = Time.simNowMs - t0;
    assert.ok(after >= SIM_CLOCK_HOLD_MS && after < SIM_CLOCK_HOLD_MS + 40, `the stall's frame steps a hold: ${after}`);
    busy(3 * SIM_CLOCK_HOLD_MS);
    const before = Time.simNowMs;
    mainFrame();
    assert.ok(Time.simNowMs - before >= 0 && Time.simNowMs - before < 20, 'a long stall\'s frame does not jump past the readers');
  } finally {
    Time.unbind();
  }
});

test('a reader that never finds the clock unlocked goes on from its last consistent read (N-85)', { concurrency: false }, () => {
  const sab = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(sab, 0, 1)[0] = 1;
  Time.bind(sab);
  const seq = new Int32Array(sab, 4, 1);
  const base = new Float64Array(sab, 8, 2);
  try {
    mainFrame();
    busy(20);
    mainFrame();
    const t1 = Time.simNowMs;
    assert.ok(t1 >= 19, `the clock runs: ${t1}`);
    // A writer descheduled inside its stores: the sequence stays odd, and the base it was rewriting reads 0.
    Atomics.store(seq, 0, Atomics.load(seq, 0) + 1);
    base[0] = 0;
    busy(SIM_CLOCK_HOLD_MS + 10);
    const t2 = Time.simNowMs;
    assert.ok(t2 - t1 >= 9 && t2 - t1 < 60, `${t1} -> ${t2}: on from the last read, not back to the stale base`);
  } finally {
    Atomics.store(seq, 0, (Atomics.load(seq, 0) + 1) & ~1);
    Time.unbind();
  }
});

test('another thread reads the clock moving while this one stalls', { concurrency: false }, async () => {
  const sab = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(sab, 0, 1)[0] = 1;
  Time.bind(sab);
  try {
    mainFrame();
    const url = new URL('../../src/core/timeScale.js', import.meta.url).href;
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.url).then(({ Time, SIM_CLOCK_HOLD_MS }) => {
        Time.bind(workerData.sab);
        const a = Time.simNowMs;
        const end = performance.now() + SIM_CLOCK_HOLD_MS + 100;
        while (performance.now() < end);
        parentPort.postMessage([a, Time.simNowMs]);
      });`,
      { eval: true, workerData: { sab, url } },
    );
    // This thread stands for the stalled main thread: it gives no frame while the worker reads the clock.
    const [a, b] = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    await worker.terminate();
    assert.ok(b - a >= 90, `the worker saw ${b - a} ms in ${SIM_CLOCK_HOLD_MS + 100} of wall time`);
  } finally {
    Time.unbind();
  }
});
