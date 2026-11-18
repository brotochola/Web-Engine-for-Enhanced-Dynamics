// SST-0: the load marks (src/util/loadMarks.js) and the waterfall the runner builds from them (tests/bench/loadWaterfall.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadMark, takeLoadMarks } from '../../src/util/loadMarks.js';
import { waterfall } from '../bench/loadWaterfall.mjs';

test('loadMark keeps names with times on one clock, and takeLoadMarks hands them over once', () => {
  takeLoadMarks();
  const before = performance.timeOrigin + performance.now();
  loadMark('a');
  loadMark('b');
  const after = performance.timeOrigin + performance.now();
  const marks = takeLoadMarks();
  assert.equal(marks.length, 4);
  assert.deepEqual([marks[0], marks[2]], ['a', 'b']);
  assert.ok(marks[1] >= before && marks[3] <= after && marks[1] <= marks[3]);
  assert.deepEqual(takeLoadMarks(), []);
});

test('the waterfall names the asset branch, the worker and the phase the load waited for', () => {
  const t0 = 1_000_000;
  const main = [
    'loadScene', t0, 'scene init', t0 + 5, 'atlas', t0 + 900, 'sounds', t0 + 400, 'shaders', t0 + 300,
    'assets', t0 + 910, 'init sent', t0 + 950, 'ready spatial0', t0 + 1200, 'ready renderer', t0 + 1800,
    'workers', t0 + 1810, 'start', t0 + 1900, 'loadScene end', t0 + 2010,
  ];
  const workers = {
    spatial0: ['modules', t0 + 100, 'init', t0 + 960, 'ready', t0 + 1190],
    renderer: ['modules', t0 + 120, 'init', t0 + 960, 'pixi init', t0 + 1000, 'programs linked', t0 + 1700,
      'ready', t0 + 1790, 'first draw', t0 + 1950],
  };
  const w = waterfall({ main, workers });
  assert.equal(w.lastAsset.name, 'atlas');
  assert.equal(w.lastAsset.t, 900);
  assert.equal(w.lastWorker.name, 'renderer');
  assert.deepEqual(w.lastWorkerSlowest, { from: 'pixi init', to: 'programs linked', ms: 700 });
  assert.equal(w.firstDraw, 1950);
  assert.equal(w.start, 1900);
  assert.equal(w.workers.spatial0[1].ms, 960);
});
