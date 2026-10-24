// The running totals the bench reads a window from exactly (HOW_WE_MEASURE "Known limits", tool 1).
//
// What can go wrong without a browser seeing it: the physics host's hand copy drifting from addFrame,
// a frame counted that published no meters (pre-render's backpressure skip), the wait not subtracted
// from the histogram, a percentile off by a bin.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HEADER_BYTES,
  HIST_BINS,
  HIST_BIN_MS,
  SLOT_BYTES,
  FRAME_TOTALS_BYTES,
  createFrameTotalsBuffer,
  bindFrameTotals,
  addFrame,
  readTotals,
  totalsWindow,
} from '../../src/util/frameTotals.js';
import { SLOT_COUNT, frameClockSlot } from '../../src/util/frameClock.js';
import { PRE_RENDER_STATS, SPATIAL_STATS } from '../../src/util/workersUtils.js';
import { loadWorker } from '../bench/workerHarness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('layout: one slot per frame clock slot, each on its own cache lines', () => {
  assert.equal(SLOT_BYTES, HEADER_BYTES + HIST_BINS * 4);
  assert.equal(SLOT_BYTES % 64, 0);
  assert.equal(FRAME_TOTALS_BYTES, SLOT_COUNT * SLOT_BYTES);
  assert.equal(HIST_BIN_MS * HIST_BINS, 128);
  assert.equal(bindFrameTotals(new SharedArrayBuffer(16)), null);
});

test('the physics host adds byte for byte what addFrame adds', () => {
  const host = fs.readFileSync(path.join(ROOT, 'src/box2d/physicsHostImpl.js'), 'utf8');
  const start = host.indexOf('  var FT_HEADER = 64;');
  const end = host.indexOf('\n  // Mirrors Transform / RigidBody ARRAY_SCHEMA');
  assert.ok(start > 0 && end > start, 'frame totals block not found in physicsHostImpl.js');
  const { ftAdd } = new Function(`${host.slice(start, end)}\nreturn { ftAdd: ftAdd };`)();
  const ours = bindFrameTotals(createFrameTotalsBuffer());
  const hosts = bindFrameTotals(createFrameTotalsBuffer());
  const slot = frameClockSlot('physics');
  const state = { ftI32: hosts.i32, ftF64: hosts.f64, ftU32: hosts.u32, fcSlot: slot };
  const frames = [[7.31, 0, 0], [8.02, 1.5, 0.25], [0.04, 0, 0], [140, 0, 3], [6.5, 6.5, 0]];
  for (const [step, wait, wake] of frames) {
    addFrame(ours, slot, step, wait, wake);
    ftAdd(state, step, wait, wake);
  }
  assert.deepEqual(new Uint8Array(hosts.sab), new Uint8Array(ours.sab));
});

test('a window is the difference of two reads: frames, means, median and p95 of the work', () => {
  const view = bindFrameTotals(createFrameTotalsBuffer());
  const slot = frameClockSlot('logic', 2);
  // Warm-up frames before the window must not count.
  for (let i = 0; i < 50; i++) addFrame(view, slot, 30, 0, 0);
  const start = readTotals(view, slot);
  // 200 frames: step 1..200 × 0.05 ms, each with 0.5 ms of wait.
  let stepSum = 0;
  for (let i = 1; i <= 200; i++) {
    addFrame(view, slot, i * 0.05 + 0.5, 0.5, 0);
    stepSum += i * 0.05 + 0.5;
  }
  const end = readTotals(view, slot);
  const w = totalsWindow(start, end);
  assert.equal(w.frames, 200);
  assert.ok(Math.abs(w.stepMs - stepSum / 200) < 1e-9);
  assert.ok(Math.abs(w.waitMs - 0.5) < 1e-12);
  assert.ok(Math.abs(w.workMs - (stepSum / 200 - 0.5)) < 1e-9);
  assert.equal(w.extraMs, 0);
  // Work is 0.05..10 ms uniform: the median is 5 ms and the p95 9.5 ms, to within a bin.
  assert.ok(Math.abs(w.p50Ms - 5) <= HIST_BIN_MS, `p50 ${w.p50Ms}`);
  assert.ok(Math.abs(w.p95Ms - 9.5) <= HIST_BIN_MS, `p95 ${w.p95Ms}`);
  // Another slot saw nothing.
  assert.equal(totalsWindow(readTotals(view, 0), readTotals(view, 0)), null);
});

test('steps past the histogram land in its last bin; extra time is summed apart', () => {
  const view = bindFrameTotals(createFrameTotalsBuffer());
  const slot = frameClockSlot('physics');
  const start = readTotals(view, slot);
  for (let i = 0; i < 10; i++) addFrame(view, slot, 500, 0, 2);
  const w = totalsWindow(start, readTotals(view, slot));
  assert.equal(w.frames, 10);
  assert.equal(w.stepMs, 500);
  assert.equal(w.extraMs, 2);
  assert.ok(w.p95Ms >= (HIST_BINS - 1) * HIST_BIN_MS);
});

test('out-of-range slots and non-numbers are ignored', () => {
  const view = bindFrameTotals(createFrameTotalsBuffer());
  addFrame(view, -1, 5, 0, 0);
  addFrame(view, SLOT_COUNT, 5, 0, 0);
  addFrame(view, 0, NaN, 0, 0);
  addFrame(view, 0, -1, 0, 0);
  assert.equal(readTotals(view, SLOT_COUNT), null);
  assert.equal(readTotals(view, 0).frames, 0);
  assert.ok(new Uint8Array(view.sab).every((b) => b === 0));
});

test('a worker counts the frames it publishes meters for, and pre-render\'s backpressure skip is not one', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const view = bindFrameTotals(createFrameTotalsBuffer());
  const slot = frameClockSlot('preRender');
  pre.stats = new Float32Array(PRE_RENDER_STATS.STRIDE_FLOATS);
  pre._frameTotals = view;
  pre._frameClockSlot = slot;
  const start = readTotals(view, slot);
  for (const [step, skipped] of [[6.25, 0], [0.01, 1], [7.75, 0], [0.02, 1]]) {
    pre.stepTimeThisFrame = step;
    pre.skippedFramesThisFrame = skipped;
    pre.reportFPS();
  }
  const w = totalsWindow(start, readTotals(view, slot));
  assert.equal(w.frames, 2);
  assert.equal(w.stepMs, 7);
  // The stats slot keeps the last frame that worked, as before.
  assert.equal(pre.stats[PRE_RENDER_STATS.STEP_MS], 7.75);
});

test('the base worker\'s frame loop feeds the totals with the step it publishes', async () => {
  const spatial = await loadWorker('spatialWorker.js', 'spatialWorker');
  const { AbstractWorker } = await import('../../src/workers/abstractWorker.js');
  const view = bindFrameTotals(createFrameTotalsBuffer());
  const slot = frameClockSlot('spatial', 1);
  // A real AbstractWorker subclass instance, its update replaced by a fixed amount of work.
  const w = Object.create(Object.getPrototypeOf(spatial));
  Object.assign(w, spatial);
  w.stats = new Float32Array(SPATIAL_STATS.STRIDE_FLOATS);
  w._frameTotals = view;
  w._frameClockSlot = slot;
  w._frameClock = null;
  w.needsGameScripts = false;
  w.update = function () {
    const until = performance.now() + 0.3;
    while (performance.now() < until);
  };
  w.reportFPS = function () {
    this._writeFrameMeters(SPATIAL_STATS);
  };
  assert.ok(w instanceof AbstractWorker);
  const start = readTotals(view, slot);
  let published = 0;
  for (let i = 0; i < 20; i++) {
    w._runFrame(false);
    published += w.stats[SPATIAL_STATS.STEP_MS];
  }
  const win = totalsWindow(start, readTotals(view, slot));
  assert.equal(win.frames, 20);
  assert.ok(win.stepMs >= 0.3, `step ${win.stepMs}`);
  // The totals hold the doubles the Float32 stats slot rounds.
  assert.ok(Math.abs(win.stepMs - published / 20) < 1e-3, `${win.stepMs} vs ${published / 20}`);
});
