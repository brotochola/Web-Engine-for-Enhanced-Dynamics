// E-27 follow-up. The pair-key kernel could not say what share of the logic step
// the key was, because the live pair count was never published. This pins the slot
// and that the write sits above the detailed-stats return.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGIC_STATS } from '../../src/util/workersUtils.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('PAIR_COUNT and PAIR_OWN are appended and inside the logic stride', () => {
  assert.equal(LOGIC_STATS.PAIR_COUNT, 16);
  assert.equal(LOGIC_STATS.PAIR_OWN, 17);
  assert.equal(LOGIC_STATS.IDLE_MS, 15);
  assert.equal(LOGIC_STATS.STRIDE_FLOATS, 18);
  assert.equal(LOGIC_STATS.BUFFER_SIZE_PER_WORKER, 18 * 4);
});

// Review M11. Every logic worker reads every contact, so _pairSlot (own plus
// foreign pairs) has the same size on each, and PAIR_COUNT says nothing about
// how the per-frame own-pair work is split. PAIR_OWN is this worker's share.
test('a logic worker publishes its own pairs beside the map size', async () => {
  const { loadWorker } = await import('../bench/workerHarness.mjs');
  const w = await loadWorker('logicWorker.js', 'logicWorker');
  w.stats = new Float32Array(LOGIC_STATS.STRIDE_FLOATS);
  w._pairSlot = new Map([[1, 0], [2, 1], [3, -1], [4, -2], [5, -3]]);
  w._pairCount = 2;
  w._foreignCount = 3;
  w.collectDetailedStats = false;
  w.reportFPS();
  assert.equal(w.stats[LOGIC_STATS.PAIR_COUNT], 5);
  assert.equal(w.stats[LOGIC_STATS.PAIR_OWN], 2);
});

test('logic publishes the pair count before the detailed-stats return', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/workers/logicWorker.js'), 'utf8');
  const report = src.slice(src.indexOf('reportFPS()'));
  const write = report.indexOf('LOGIC_STATS.PAIR_COUNT');
  const gate = report.indexOf('if (!this.collectDetailedStats) return');
  assert.ok(write > 0 && gate > 0 && write < gate);
});
