// E-01 parity test: the WAIT_MS meter must be a measurement.
//
// Three things are being pinned here, and the third is the one that matters most:
//
//   1. The schemas expose WAIT_MS and IDLE_MS with no slot collisions and a
//      stride large enough to hold them.
//   2. The meter accumulates, resets, and ignores non-positive deltas.
//   3. `waitUntilDoneSync` behaves IDENTICALLY to the version it replaced -
//      same terminal-status outcomes, same number of Atomics.load calls, no
//      clock read on the fast path.
//
// (3) is the real test. A speed metric that changes the behaviour it measures is
// worse than no metric, and the previous state of this code - a hardcoded zero -
// was harmless precisely because it could not affect anything.
//
// E-01 in docs/internal/EXECUTION_PLAN.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RENDERER_STATS,
  PARTICLE_STATS,
  PHYSICS_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
  PRE_RENDER_STATS,
} from '../../src/util/workersUtils.js';
import { waitMeterMs, resetWaitMeter, addWaitMs, WAIT_METER_GLOBAL_KEY } from '../../src/util/waitMeter.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------- schemas ---

const SCHEMAS = [
  ['RENDERER_STATS', RENDERER_STATS],
  ['PARTICLE_STATS', PARTICLE_STATS],
  ['PHYSICS_STATS', PHYSICS_STATS],
  ['SPATIAL_STATS', SPATIAL_STATS],
  ['LOGIC_STATS', LOGIC_STATS],
  ['PRE_RENDER_STATS', PRE_RENDER_STATS],
];

test('every worker schema exposes WAIT_MS and IDLE_MS', () => {
  for (const [name, s] of SCHEMAS) {
    assert.equal(typeof s.WAIT_MS, 'number', `${name}.WAIT_MS`);
    assert.equal(typeof s.IDLE_MS, 'number', `${name}.IDLE_MS`);
    assert.notEqual(s.WAIT_MS, s.IDLE_MS, `${name}: WAIT_MS and IDLE_MS collide`);
  }
});

test('WAIT_MS and IDLE_MS fit inside the published stride', () => {
  // A slot at or past STRIDE_FLOATS would be silently dropped by the SAB read on
  // the consumer side, and the debug panel would show 0 forever - which is the
  // exact failure this hypothesis exists to fix.
  for (const [name, s] of SCHEMAS) {
    assert.ok(s.WAIT_MS < s.STRIDE_FLOATS, `${name}.WAIT_MS (${s.WAIT_MS}) >= STRIDE_FLOATS (${s.STRIDE_FLOATS})`);
    assert.ok(s.IDLE_MS < s.STRIDE_FLOATS, `${name}.IDLE_MS (${s.IDLE_MS}) >= STRIDE_FLOATS (${s.STRIDE_FLOATS})`);
  }
});

test('no slot aliasing in any worker schema', () => {
  // Guards the whole layout, not just the two new fields: a duplicate key in a
  // frozen schema literal silently drops one and the panel shows the other.
  for (const [name, s] of SCHEMAS) {
    const seen = new Map();
    for (const [k, v] of Object.entries(s)) {
      if (k === 'STRIDE_FLOATS' || k === 'BUFFER_SIZE' || k === 'BUFFER_SIZE_PER_WORKER') continue;
      assert.ok(Number.isInteger(v) && v >= 0, `${name}.${k} is not a slot index`);
      assert.ok(!seen.has(v), `${name}: ${k} and ${seen.get(v)} both claim slot ${v}`);
      seen.set(v, k);
    }
  }
});

test('multi-worker buffer sizes cover the stride', () => {
  // sceneSharedBuffers allocates BUFFER_SIZE / BUFFER_SIZE_PER_WORKER floats.
  // If those were left at the old stride the new fields would not be published.
  assert.equal(RENDERER_STATS.BUFFER_SIZE, RENDERER_STATS.STRIDE_FLOATS * 4);
  assert.equal(PARTICLE_STATS.BUFFER_SIZE, PARTICLE_STATS.STRIDE_FLOATS * 4);
  assert.equal(PHYSICS_STATS.BUFFER_SIZE, PHYSICS_STATS.STRIDE_FLOATS * 4);
  assert.equal(PRE_RENDER_STATS.BUFFER_SIZE, PRE_RENDER_STATS.STRIDE_FLOATS * 4);
  assert.equal(PRE_RENDER_STATS.BUFFER_SIZE_PER_WORKER, PRE_RENDER_STATS.STRIDE_FLOATS * 4);
  for (const [n, s] of [['SPATIAL', SPATIAL_STATS], ['LOGIC', LOGIC_STATS]]) {
    assert.equal(s.BUFFER_SIZE_PER_WORKER, s.STRIDE_FLOATS * 4, n);
  }
});

// ------------------------------------------------------------------ meter ---

test('wait meter accumulates, resets, and ignores non-positive deltas', () => {
  resetWaitMeter();
  assert.equal(waitMeterMs(), 0);
  addWaitMs(5);
  addWaitMs(2.5);
  assert.equal(waitMeterMs(), 7.5);
  // A clock that did not advance must not subtract from a real measurement.
  addWaitMs(0);
  addWaitMs(-3);
  assert.equal(waitMeterMs(), 7.5);
  resetWaitMeter();
  assert.equal(waitMeterMs(), 0);
});

test('wait meter is reachable by the UMD impls that cannot import ESM', () => {
  // The six box2d*/liquidFun* factories are loaded with importScripts, so they
  // reach the counter only through the global. If this key drifts, WAIT_MS goes
  // back to a silent zero with no error anywhere.
  assert.equal(typeof globalThis[WAIT_METER_GLOBAL_KEY], 'object');
  assert.equal(typeof globalThis[WAIT_METER_GLOBAL_KEY].ms, 'number');
});

// ------------------------------------------------- waitUntilDoneSync parity ---

const IMPLS = [
  'src/box2d/box2dCastRayAllImpl.js',
  'src/box2d/box2dOverlapCircleImpl.js',
  'src/box2d/box2dQueryAabbImpl.js',
  'src/box2d/box2dRayCastImpl.js',
  'src/box2d/liquidFunExtractImpl.js',
  'src/box2d/liquidFunQueryImpl.js',
];

test('every sync-wait impl is instrumented', () => {
  for (const rel of IMPLS) {
    const src = read(rel);
    assert.match(src, /__weedWaitMeter/, `${rel} does not create the wait meter`);
    assert.match(src, /WAIT_METER\.ms \+= performance\.now\(\) - t0;/, `${rel} does not fold the blocked time in`);
  }
});

test('the instrumented wait keeps the original load/check/wait order', () => {
  // The original was:
  //   for (;;) { s = load(); if (DONE|ERROR) return; wait(s); }
  // The replacement must not add or remove an Atomics.load on any path, or the
  // single-flight protocol with the physics worker changes shape.
  for (const rel of IMPLS) {
    const src = read(rel);
    const body = src.slice(src.indexOf('function waitUntilDoneSync()'));
    const fn = body.slice(0, body.indexOf('\n  }'));
    const loads = (fn.match(/Atomics\.load\(i32, HDR_STATUS\)/g) || []).length;
    assert.equal(loads, 2, `${rel}: expected 2 HDR_STATUS loads in the wait, found ${loads}`);
    assert.match(fn, /var t0 = performance\.now\(\);/, `${rel}: no clock read`);
    // The clock must start AFTER the terminal check, so the fast path is free.
    assert.ok(
      fn.indexOf('if (s === STATUS_DONE || s === STATUS_ERROR) return;') < fn.indexOf('var t0 = performance.now();'),
      `${rel}: clock starts before the terminal-status check`,
    );
    // And it must break, not return, so the meter is always folded in.
    assert.match(fn, /if \(s === STATUS_DONE \|\| s === STATUS_ERROR\) break;/, `${rel}: loop must break, not return`);
  }
});

test('the physics host publishes IDLE_MS from its own loop', () => {
  // physicsHostImpl.js is not an AbstractWorker, so it cannot inherit the idle
  // measurement and has to do its own bookkeeping.
  const src = read('src/box2d/physicsHostImpl.js');
  assert.match(src, /IDLE_MS:\s*48/, 'PS mirror does not carry IDLE_MS');
  assert.match(src, /_lastFrameEndAt/, 'physics host never stamps its frame end');
  assert.match(src, /PS\.IDLE_MS\]\s*=\s*Math\.max\(0, frameStart - state\._lastFrameEndAt\)/);
});

// ---------------------------------------------------------------- idle split ---

/**
 * Isolate the body of the `_runFrame` *definition*.
 *
 * Two separate near-misses had to be avoided here, and both produced an empty or
 * truncated slice before this helper existed:
 *   - `gameLoop` CALLS `_runFrame(resuming)`, so a plain `indexOf('_runFrame(')`
 *     lands in the call site, not the definition.
 *   - `gameLoop` also calls `this.scheduleNextFrame()`, and it sits above the
 *     definition, so an end bound of plain `indexOf('scheduleNextFrame()')`
 *     lands before the start.
 * So: match the definition signature, then bound the end from there.
 */
function runFrameBody() {
  const src = read('src/workers/abstractWorker.js');
  const start = src.indexOf('_runFrame(resuming = false) {');
  assert.ok(start > 0, 'could not find the _runFrame definition');
  const end = src.indexOf('\n  scheduleNextFrame(', start);
  assert.ok(end > start, 'could not find the end of _runFrame');
  return src.slice(start, end);
}

test('idle is measured before the step, so it can never be part of STEP_MS', async () => {
  const frame = runFrameBody();
  const idleAt = frame.indexOf('this.idleTimeThisFrame =');
  const stepAt = frame.indexOf('this.stepTimeThisFrame = performance.now() - t0;');
  const callAt = frame.indexOf('this.update(timing.deltaTime');
  assert.ok(idleAt >= 0 && stepAt >= 0 && callAt >= 0, 'could not locate the three points in _runFrame');
  assert.ok(idleAt < stepAt, 'idle must be measured before STEP_MS is recorded');
  assert.ok(idleAt < callAt, 'idle must be measured before update() runs');
  assert.ok(
    !frame.includes('stepTimeThisFrame += this.idleTimeThisFrame'),
    'idle must never be folded into STEP_MS (HOW_WE_MEASURE: WAIT_MS "is not algorithm time")',
  );
});

test('the wait meter is reset before update, after updateFrameTiming', () => {
  // Order matters twice: waits happen inside update(), and resetWaitMeter() after
  // reportFPS() would publish the previous frame's number.
  const frame = runFrameBody();
  const reset = frame.indexOf('resetWaitMeter();');
  const update = frame.indexOf('this.update(timing.deltaTime');
  const report = frame.indexOf('this.reportFPS();');
  assert.ok(reset > 0, 'resetWaitMeter() missing from _runFrame');
  assert.ok(reset < update, 'the meter must be reset before update() accumulates into it');
  assert.ok(reset < report, 'the meter must be reset before reportFPS() publishes it');
});

test('every worker publishes IDLE_MS outside the collectDetailedStats gate', async () => {
  // The gate is the trap: a stat published only under collectDetailedStats is
  // invisible on exactly the runs that write a verdict, because the protocol
  // requires detailed stats OFF for the pair that decides.
  for (const [file, idl] of [
    ['src/workers/spatialWorker.js', 'SPATIAL_STATS.IDLE_MS'],
    ['src/workers/logicWorker.js', 'LOGIC_STATS.IDLE_MS'],
    ['src/workers/particleWorker.js', 'PARTICLE_STATS.IDLE_MS'],
    ['src/workers/pixiWorker.js', 'RENDERER_STATS.IDLE_MS'],
    ['src/workers/preRenderWorker.js', 'PRE_RENDER_STATS.IDLE_MS'],
  ]) {
    const src = read(file);
    const at = src.indexOf(idl);
    assert.ok(at > 0, `${file} never publishes ${idl}`);
    // The store sits in reportFPS() above its detail gate. (This used to look
    // for the gate inside the text before the store, so it could not fail:
    // review M6.)
    const fnStart = src.lastIndexOf('reportFPS() {', at);
    assert.ok(fnStart > 0, `${file}: ${idl} is not published in reportFPS()`);
    const gate = src.indexOf('if (!this.collectDetailedStats) return;', fnStart);
    assert.ok(gate === -1 || gate > at, `${file}: ${idl} is published after the collectDetailedStats gate`);
  }
});