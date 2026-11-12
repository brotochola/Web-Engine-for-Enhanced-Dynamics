import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LAG_SAMPLES,
  LagMeter,
  STAMP_INPUT,
  STAMP_LOGIC,
  bindInputStamp,
  bindLatencyStamp,
  createLatencyStampBuffer,
  stampInput,
  stampNow,
} from '../../src/util/latencyStamp.js';
import { RENDERER_STATS } from '../../src/util/workersUtils.js';
import { createRenderQueueCameraViews, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';

// E-197: nothing measured the frames between an input and the picture that shows it. Main stamps inputs, each stage
// carries the newest stamp it consumed, and Pixi's LagMeter times the first frame that draws a newer stamp.

test('a stamp is tenths of a ms since the scene base, the same clock in every thread', () => {
  const sab = createLatencyStampBuffer();
  const s = bindLatencyStamp(sab);
  assert.ok(s.base > 1e12, 'a wall time');
  const a = stampNow(s);
  assert.ok(a >= 1 && a < 10000, `just after the base: ${a}`);
  assert.equal(bindLatencyStamp(new SharedArrayBuffer(8)), null, 'too small: no stamp');
});

test('main stamps an input into the buffer; logic copies it to its word', () => {
  const sab = createLatencyStampBuffer();
  const s = bindLatencyStamp(sab);
  assert.equal(s.i32[STAMP_INPUT], 0, 'no input yet');
  bindInputStamp(sab);
  stampInput();
  const t = s.i32[STAMP_INPUT];
  assert.ok(t > 0);
  bindInputStamp(null);
  stampInput();
  assert.equal(s.i32[STAMP_INPUT], t, 'unbound: nothing written');
  assert.equal(s.i32[STAMP_LOGIC], 0);
});

test('the meter samples a stamp newer than any drawn, and its median and 95th percentile', () => {
  const m = new LagMeter();
  assert.equal(m.note(0, 100), false, 'no stamp');
  assert.equal(m.note(100, 600), true);
  assert.equal(m.median, 50, '500 tenths of a ms');
  assert.equal(m.note(100, 900), false, 'the same input drawn again is not a sample');
  assert.equal(m.note(90, 900), false, 'nor an older one');
  for (let k = 1; k <= 99; k++) m.note(100 + k * 1000, 100 + k * 1000 + k * 10);
  assert.equal(m.count, LAG_SAMPLES, 'the last 64 inputs');
  // The last 64 samples are 36..99 ms: median 67 (the 32nd), 95th percentile 96 (the 61st).
  assert.equal(m.median, 67);
  assert.equal(m.p95, 96);
});

test('the queue camera buffer carries a stamp; the renderer stats have the lag slots', () => {
  assert.ok(RENDER_QUEUE_CAMERA_BYTES >= 24);
  const v = createRenderQueueCameraViews(new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES));
  assert.ok(v.stamp, 'a stamp view');
  v.stamp[0] = 1234;
  assert.equal(v.poseReady[0], 0, 'apart from poseReady');
  assert.ok(RENDERER_STATS.INPUT_LAG_N < RENDERER_STATS.STRIDE_FLOATS);
  assert.equal(RENDERER_STATS.BUFFER_SIZE, RENDERER_STATS.STRIDE_FLOATS * 4);
});
