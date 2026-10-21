import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AbstractWorker } from '../../src/workers/abstractWorker.js';
import { Time, sanitizeTimeScale, scaleSimMs, MAX_TIME_SCALE } from '../../src/core/timeScale.js';

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
  assert.match(host, /state\.stats\[PS\.STEP_MS\] = performance\.now\(\) - t0/);
  assert.doesNotMatch(host, /STEP_MS\] = dt/);
});
