import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * H-03 parity - guards the change from Math.hypot to Math.sqrt(x*x + y*y).
 *
 * The plan claimed the swap was "bit-identical". Measured, it is not: over
 * random in-range pairs only ~64% agree exactly and the rest differ by a few
 * ulps, because sqrt(x*x + y*y) rounds at every step while hypot is
 * deliberately the more accurate of the two. So the gate here is a TOLERANCE.
 *
 * What has to hold, and why the tolerance is safe:
 *   - the two agree to within a few ulps for every reachable input, so any
 *     consumer working in Float32 (~1e-7 relative) cannot see the difference;
 *   - the sqrt form never produces NaN or Infinity where hypot did not, for
 *     every value the engine can actually hold in these variables;
 *   - no live engine source under src/ calls Math.hypot.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Float32 has ~1e-7 relative precision. The sqrt/hypot gap is a few ulps of
// Float64, ~1e-16, so anything at or under Float32 resolution is invisible.
const F32_RESOLUTION = 1e-6;
const ULP = Number.EPSILON;

function maxRelDiff(a, b) {
  if (a === b) return 0;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return 0;
  return Math.abs(a - b) / scale;
}

test('H-03: sqrt and hypot agree to within Float32 resolution across magnitudes', { concurrency: false }, () => {
  const magnitudes = [1e-6, 1e-3, 1, 1e3, 1e4, 1e7, 1e12];
  let s = 0x1234567;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };

  let worstRel = 0;
  let bitIdentical = 0;
  let total = 0;

  for (const m of magnitudes) {
    for (let i = 0; i < 2000; i++) {
      const x = m * (rnd() * 2);
      const y = m * (rnd() * 2);
      const a = Math.hypot(x, y);
      const b = Math.sqrt(x * x + y * y);
      total++;
      if (Object.is(a, b)) bitIdentical++;
      const rel = maxRelDiff(a, b);
      if (rel > worstRel) worstRel = rel;
    }
  }

  assert.ok(
    worstRel < F32_RESOLUTION,
    `worst relative difference ${worstRel} exceeds Float32 resolution ${F32_RESOLUTION}`,
  );
  // And the plan's "bit-identical" claim, stated as the measurement it is.
  assert.ok(
    bitIdentical / total < 0.95,
    'if ~100% agree exactly, the tolerance test above is vacuous - update the plan note',
  );
});

test('H-03: the sqrt form never yields NaN or Infinity where hypot is finite, below the overflow threshold', { concurrency: false }, () => {
  // The whole reason Math.hypot exists is overflow/underflow. The argument for
  // the swap is that neither is reachable here. This pins that argument.
  //
  // The threshold is sqrt(Float64 max) ~ 1.3408e154, so the top of this list is
  // deliberately below it. The boundary itself is the next test.
  const reachable = [1e-150, 1e-100, 1e-10, 0, 1, 10, 1e5, 1e10, 1e30, 1e100, 1e150];
  for (const x of reachable) {
    for (const y of reachable) {
      const a = Math.hypot(x, y);
      const b = Math.sqrt(x * x + y * y);
      assert.ok(
        Number.isFinite(a) === Number.isFinite(b),
        `finite-ness disagrees at (${x}, ${y}): hypot=${a} sqrt=${b}`,
      );
    }
  }
});

test('H-03: the two forms diverge exactly at sqrt(Float64 max), which nothing here can reach', { concurrency: false }, () => {
  // Where the swap would start losing is documented rather than hand-waved.
  const threshold = Math.sqrt(Number.MAX_VALUE);
  assert.ok(threshold > 1e154, '1e154 itself is still representable after squaring');

  assert.ok(Number.isFinite(Math.hypot(1e154, 1e154)), 'hypot survives at 1e154');
  assert.ok(Number.isFinite(Math.sqrt(1e154 * 1e154)), 'and so does sqrt - this is the bug in my first version of this test');

  const past = threshold * 1.1;
  assert.ok(Number.isFinite(Math.hypot(past, past)), 'hypot survives past the threshold');
  assert.equal(Math.sqrt(past * past + past * past), Infinity, 'sqrt does not - this is the whole trade');

  // The margin between that threshold and anything a world coordinate or a
  // collider dimension could be. A float32 coordinate tops out near 3.4e38.
  assert.ok(threshold / 3.4e38 > 1e115, 'the unreachable margin is over 115 orders of magnitude');
});

test('H-03: no engine source under src/ calls Math.hypot', { concurrency: false }, () => {
  const live = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!ent.name.endsWith('.js') && !ent.name.endsWith('.mjs')) continue;
      const rel = path.relative(REPO, full).replaceAll('\\', '/');
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('Math.hypot') && !line.trim().startsWith('//')) {
          live.push(`${rel}:${i + 1}`);
        }
      }
    }
  };
  walk(path.join(REPO, 'src'));
  assert.deepEqual(live, [], 'engine source still calls Math.hypot');
});