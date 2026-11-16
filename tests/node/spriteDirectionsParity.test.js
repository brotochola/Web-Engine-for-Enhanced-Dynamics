// E-388: pickDirectionArgs (pickDirection's doubles in PICK_ARGS, its angle math written out so no double crosses a
// call) gives bit for bit what pickDirection gave, on uniform and uneven tables, angles in and out of [0, 2π), facings
// over several turns either way, margins, and the current direction or none.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PICK_ARGS, pickDirection, pickDirectionArgs, wrapAngle, angleDistance } from '../../src/core/spriteDirections.js';

/** pickDirection as it was before E-388, the reference. */
function pickDirectionBefore(t, facing, current, margin) {
  const count = t.count;
  let best;
  let bestD;
  if (t.uniform) {
    const step = t.step;
    const k = Math.round(wrapAngle(facing - t.start) / step);
    best = k >= count ? k - count : k;
    if (best === current) return current;
    bestD = angleDistance(facing, t.angles[best]);
  } else {
    best = 0;
    bestD = Infinity;
    for (let k = 0; k < count; k++) {
      const d = angleDistance(facing, t.angles[k]);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
  }
  if (current < count && current !== best && angleDistance(facing, t.angles[current]) <= bestD + margin) return current;
  return best;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;

function tables(r) {
  const out = [];
  for (const count of [1, 2, 4, 8, 16, 32]) {
    const step = TWO_PI / count;
    // A uniform table from east, and one from 90 degrees whose angles run clockwise into negatives (the fence's).
    out.push({ count, uniform: true, start: 0, step, angles: Array.from({ length: count }, (_, k) => k * step) });
    out.push({
      count, uniform: true, start: wrapAngle(90 * DEG), step,
      angles: Array.from({ length: count }, (_, k) => (90 - k * (360 / count)) * DEG),
    });
    // An uneven one: sorted random angles, some past 2π.
    const angles = Array.from({ length: count }, () => r() * TWO_PI * (r() < 0.2 ? 1.5 : 1)).sort((a, b) => a - b);
    out.push({ count, uniform: false, start: angles[0], step: 0, angles });
  }
  return out;
}

test('E-388: pickDirectionArgs is pickDirection bit for bit', () => {
  const r = rng(388);
  const ts = tables(r);
  const special = [0, -0, Math.PI, -Math.PI, TWO_PI, -TWO_PI, 2 * TWO_PI, -2 * TWO_PI, 1e-17, -1e-17, TWO_PI - 1e-15, -TWO_PI + 1e-15, NaN];
  let n = 0;
  for (const t of ts) {
    for (let k = 0; k < 4000; k++) {
      const facing = k < special.length ? special[k] : (r() - 0.5) * (r() < 0.1 ? 40 : 4) * Math.PI;
      const current = r() < 0.2 ? 255 : Math.floor(r() * (t.count + 1));
      const margin = r() < 0.3 ? 0 : r() * 0.4;
      const want = pickDirectionBefore(t, facing, current, margin);
      PICK_ARGS[0] = facing;
      PICK_ARGS[1] = margin;
      const got = pickDirectionArgs(t, current);
      assert.equal(got, want, `count ${t.count} uniform ${t.uniform} facing ${facing} current ${current} margin ${margin}`);
      assert.equal(pickDirection(t, facing, current, margin), want);
      n++;
    }
  }
  assert.ok(n > 70000);
});
