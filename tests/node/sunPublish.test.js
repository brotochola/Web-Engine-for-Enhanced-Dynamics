/**
 * DX-SUNPUBLISH: the main thread writes the sun in a private copy and publishes it once a frame, after the scene's
 * update. A worker reads the SAB directly, so these tests read the SAB through views of their own, as one would.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Sun } from '../../src/core/sun.js';
import { Scene } from '../../src/core/scene.js';
import { applySunGlobals, readSunGlobals } from '../../src/core/save/entitySaveSnapshot.js';
import { SUN_DEFAULTS } from '../../src/util/configDefaults.js';

const CYCLE = { enabled: true, speed: 1, dayDurationMinutes: 1 };

/** The SAB as a worker sees it. */
function workerView(sab) {
  const f32 = new Float32Array(sab);
  const u32 = new Uint32Array(sab);
  return {
    get intensity() {
      return f32[Sun.F32.INTENSITY];
    },
    set shadowAlpha(v) {
      f32[Sun.F32.SHADOW_ALPHA] = v;
    },
    get shadowAlpha() {
      return f32[Sun.F32.SHADOW_ALPHA];
    },
    get hour() {
      return f32[Sun.F32.HOUR];
    },
    get color() {
      return u32[Sun.U32.COLOR];
    },
    get shadowDirX() {
      return f32[Sun.F32.SHADOW_DIR_X];
    },
  };
}

function bootSun(config = {}) {
  const sab = new SharedArrayBuffer(Sun.BYTE_LENGTH);
  Sun.initializeStaged(sab);
  Sun.initFromConfig({ ...SUN_DEFAULTS, enabled: true, ...config });
  Sun.setTimeOfDay(config.startHour ?? 12);
  Sun.publish();
  return workerView(sab);
}

/** Scene.updateInternal on the real prototype, with the parts that need a page stubbed out. */
function sceneWith(update, dayCycle = CYCLE) {
  const scene = Object.create(Scene.prototype);
  scene.config = { lighting: { sun: { dayCycle } } };
  scene.audioMetrics = {};
  scene.mainFrameNumber = 0;
  scene.updateCameraBuffer = () => {};
  scene.update = update;
  return scene;
}

beforeEach(() => Sun.unbind());
afterEach(() => Sun.unbind());

test('the cycle never reaches the SAB under a scene that overrides it: last frame during update, the scene after', () => {
  const worker = bootSun({ startHour: 22 });
  const OVERRIDE = 0.25;
  const seen = [];
  const scene = sceneWith(() => {
    seen.push(worker.intensity);
    assert.notEqual(Sun.intensity, OVERRIDE, 'the cycle wrote the copy');
    Sun.intensity = OVERRIDE;
    Sun.color = 0x123456;
  });

  const boot = worker.intensity;
  scene.updateInternal(16);
  assert.equal(seen[0], boot, 'inside update the SAB still holds the last publish');
  assert.equal(worker.intensity, Math.fround(OVERRIDE));
  assert.equal(worker.color, 0x123456);

  for (let i = 0; i < 10; i++) {
    scene.updateInternal(16);
    assert.equal(seen[seen.length - 1], Math.fround(OVERRIDE), 'nothing but the scene’s value is ever published');
    assert.equal(worker.intensity, Math.fround(OVERRIDE));
  }
});

test('without an override the cycle goes out whole at the end of the frame', () => {
  const worker = bootSun({ startHour: 6 });
  const hourBefore = worker.hour;
  let during = NaN;
  const scene = sceneWith(() => {
    during = worker.hour;
  });
  scene.updateInternal(1000);
  assert.equal(during, hourBefore);
  assert.ok(worker.hour > hourBefore);
  assert.equal(worker.hour, Math.fround(Sun.hour));
  assert.equal(worker.intensity, Math.fround(Sun.intensity));
  assert.equal(worker.shadowDirX, Math.fround(Sun.shadowDirX));
});

test('a worker’s write to a field the main thread did not touch stands, and the main thread reads it', () => {
  const worker = bootSun({ startHour: 12 });
  const scene = sceneWith(() => {});
  worker.shadowAlpha = 0.75;
  scene.updateInternal(16);
  assert.equal(worker.shadowAlpha, 0.75, 'the cycle does not write shadowAlpha, so the frame leaves it');
  assert.equal(Sun.shadowAlpha, 0.75, 'the copy took it at the start of the frame');
});

test('when the main thread writes the same field, the main thread’s write wins', () => {
  const worker = bootSun({ startHour: 12 });
  const scene = sceneWith(() => {
    Sun.shadowAlpha = 0.5;
  });
  worker.shadowAlpha = 0.75;
  scene.updateInternal(16);
  assert.equal(worker.shadowAlpha, 0.5);
});

test('setTimeOfDay from a handler between frames reaches the SAB whole at the next publish', () => {
  const worker = bootSun({ startHour: 12 });
  const scene = sceneWith(() => {}, { enabled: false });
  const noonColor = worker.color;

  Sun.setTimeOfDay(22);
  assert.equal(Sun.hour, 22, 'the main thread reads its own write at once');
  assert.notEqual(worker.hour, 22, 'a worker does not');
  assert.equal(worker.color, noonColor);

  scene.updateInternal(16);
  assert.equal(worker.hour, 22);
  assert.equal(worker.color, Sun._getColorForHour(22));
  assert.equal(worker.intensity, Math.fround(Sun.intensity));
  assert.ok(worker.intensity < 0.1, 'the frame’s start did not take the old value back into the copy');
});

test('the paused loop publishes a handler’s write without running the frame', () => {
  const worker = bootSun({ startHour: 12 });
  const scene = sceneWith(() => assert.fail('a paused frame runs no update'));
  scene.state = { pause: true };
  const savedRaf = globalThis.requestAnimationFrame;
  let frame = null;
  globalThis.requestAnimationFrame = (cb) => {
    frame = cb;
    return 1;
  };
  try {
    scene.startMainLoop();
    frame(16);
    Sun.setTimeOfDay(3);
    assert.notEqual(worker.hour, 3);
    frame(32);
    assert.equal(worker.hour, 3);
  } finally {
    globalThis.requestAnimationFrame = savedRaf;
  }
});

test('without a stage (a worker) the setters write the SAB directly and beginFrame and publish do nothing', () => {
  const sab = new SharedArrayBuffer(Sun.BYTE_LENGTH);
  Sun.initialize(sab);
  const worker = workerView(sab);
  Sun.intensity = 0.5;
  assert.equal(worker.intensity, 0.5);
  Sun.beginFrame();
  Sun.publish();
  assert.equal(worker.intensity, 0.5);
});

test('a save’s sun, restored into the copy, reaches the workers, enabled flag included', () => {
  const worker = bootSun({ startHour: 12 });
  Sun.setTimeOfDay(20);
  Sun.publish();
  const saved = readSunGlobals();
  Sun.setTimeOfDay(5);
  Sun.enabled = false;
  Sun.publish();

  applySunGlobals(saved);
  assert.equal(worker.hour, 20);
  assert.equal(new Uint8Array(Sun.buffer)[Sun.OFFSETS.ENABLED], 1);
  assert.equal(Sun.hour, 20);
  Sun.beginFrame();
  assert.equal(Sun.hour, 20);
});

test('unbind forgets the stage: the sun reads as not initialized and the frame calls do nothing', () => {
  bootSun();
  Sun.unbind();
  assert.equal(Sun.isInitialized, false);
  Sun.beginFrame();
  Sun.publish();
  assert.equal(Sun.intensity, 0);
});
