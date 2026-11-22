/**
 * N-405: the deopt summary's steady window. Cut at --warmup-ms from each log's start, a page that loads for longer than
 * the warm-up (the ASUS: 5 to 10 s) put its start-up deopts in it; --tail-ms takes the last that many ms of each log,
 * the measure window that ends the run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { steadyFromUs } from '../bench/summarizeV8Deopt.mjs';

test('steady starts tailMs before the log ends, or warmupMs after it starts without one', () => {
  assert.equal(steadyFromUs(20e6, 6000, 8000), 12e6, 'a 20 s log, the last 8 s');
  assert.equal(steadyFromUs(20e6, 6000, NaN), 6e6, 'no tail: the warm-up from the start, as before');
  assert.equal(steadyFromUs(5e6, 6000, 8000), 0, 'a log shorter than the tail: all of it');
  assert.equal(steadyFromUs(20e6, 6000, 0), 6e6, 'a tail of 0 is no tail');
});
