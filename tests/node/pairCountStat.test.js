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

test('PAIR_COUNT is appended and inside the logic stride', () => {
  assert.equal(LOGIC_STATS.PAIR_COUNT, 16);
  assert.equal(LOGIC_STATS.IDLE_MS, 15);
  assert.equal(LOGIC_STATS.STRIDE_FLOATS, 17);
  assert.equal(LOGIC_STATS.BUFFER_SIZE_PER_WORKER, 17 * 4);
});

test('logic publishes the pair count before the detailed-stats return', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/workers/logicWorker.js'), 'utf8');
  const report = src.slice(src.indexOf('reportFPS()'));
  const write = report.indexOf('LOGIC_STATS.PAIR_COUNT');
  const gate = report.indexOf('if (!this.collectDetailedStats) return');
  assert.ok(write > 0 && gate > 0 && write < gate);
});
