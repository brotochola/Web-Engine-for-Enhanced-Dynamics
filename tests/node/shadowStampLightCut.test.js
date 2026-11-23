// N-413: a light keeps its maxShadowsPerLight nearest casters, and the kept near that cut fade by how near the nearest
// one left out is: f = min(1, (dNext - d) / (0.2 dNext)) in the row's light w (the lamps' map multiplies the caster's
// opacity by it), as N-330 fades a caster's last light. A caster crossing the cut as people walk fades instead of
// popping. With maxShadowsPerEntity a row takes that light's cut fade times N-330's. The shipped kernel against the JS
// reference, bit for bit, and the fade's value, on casters along a line from one light.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GPU_CASTER_FLOATS, GPU_CASTER_LIGHT_FLOAT } from '../../src/render/gpuQueueLayout.js';
import { stampLightRangeWasm } from '../../src/render/shadowStampClient.js';
import { stampLightRange } from '../reference/shadowStamp.mjs';
import { setup } from '../helpers/shadowStampFrames.mjs';

const I = 400;
const RANGE = 2000;

/** Casters at (x, 0), one light at the origin keeping `keep`; the rows' casters (by x) and their light w. */
function stampLine(k, xs, keep, maxPE = 0) {
  const { dst, b, scratch } = k;
  dst.sun.fill(0, 0, xs.length * GPU_CASTER_FLOATS);
  xs.forEach((x, c) => {
    const at = c * GPU_CASTER_FLOATS;
    dst.sun[at] = x;
    for (let f = 2; f < GPU_CASTER_FLOATS; f++) dst.sun[at + f] = 0.25;
  });
  const lights = [{ x: 0, y: 0, intensity: I, rangeSq: RANGE * RANGE, maxShadows: keep, invG2: 1 }];
  const spec = {
    sun: dst.sun, sunN: xs.length, sunFloats: GPU_CASTER_FLOATS, lights, lightBegin: 0, lightEnd: 1, lightStride: 1,
    maxPerLight: 0, maxPerEntity: maxPE, used: null, ...scratch, stamp: dst.stamp, stampFloats: GPU_CASTER_FLOATS,
    stampCap: 16, stampBase: 0, stampLightIdx: dst.stampLightIdx,
  };
  const js = stampLightRange(spec);
  const jsRows = dst.stamp.slice(0, js * GPU_CASTER_FLOATS);
  dst.stamp.fill(0, 0, 16 * GPU_CASTER_FLOATS);
  const n = stampLightRangeWasm(b, spec);
  assert.equal(n, js, 'the kernel writes the rows the JS writes');
  assert.deepEqual(dst.stamp.slice(0, n * GPU_CASTER_FLOATS), jsRows, 'bit for bit');
  const rows = [];
  for (let r = 0; r < n; r++) {
    rows.push({ x: dst.stamp[r * GPU_CASTER_FLOATS], w: dst.stamp[r * GPU_CASTER_FLOATS + GPU_CASTER_LIGHT_FLOAT + 3] });
  }
  return rows;
}

const fade = (d, next) => Math.fround(Math.min(1, (next - d) / (0.2 * next)));

test('the kept near maxShadowsPerLight\'s cut fade by the nearest left out; a light that keeps them all fades none', async () => {
  const k = await setup();
  // Every caster kept: w 1.
  assert.deepEqual(stampLine(k, [100, 200, 300, 340], 4).map((r) => r.w), [1, 1, 1, 1]);
  // Three kept, the fourth at 340 left out: the third (within 20 % of it) fades, the nearer two do not.
  const rows = stampLine(k, [340, 100, 300, 200, 500], 3);
  assert.deepEqual(rows.map((r) => r.x), [100, 200, 300], 'the three nearest, nearest first');
  assert.deepEqual(rows.map((r) => r.w), [1, 1, fade(300, 340)]);
  // Left out from 20 % farther: nothing fades.
  assert.deepEqual(stampLine(k, [100, 200, 300, 380], 3).map((r) => r.w), [1, 1, 1]);
  // Left out as near as the last kept: that shadow is gone (w about 0; the fade reads the float squared distances).
  assert.ok(stampLine(k, [100, 200, 300, 300.0001], 3)[2].w < 1e-5);
});

test('a caster crossing the cut fades out as the one left out comes level, and fades in as it takes its place', async () => {
  const k = await setup();
  let last = Infinity;
  for (const x of [380, 360, 340, 320, 310, 301]) {
    const r = stampLine(k, [100, 200, 300, x], 3);
    assert.equal(r[2].x, 300);
    assert.ok(r[2].w < last, `the fourth at ${x}: the third's shadow goes down (${r[2].w})`);
    last = r[2].w;
  }
  assert.ok(last < 0.05, `just past it, nearly gone (${last})`);
  let prev = -1;
  for (const x of [299, 290, 270, 250]) {
    const r = stampLine(k, [100, 200, 300, x], 3);
    assert.equal(r[2].x, x, `the fourth at ${x}: kept in the third's place`);
    assert.ok(r[2].w > prev, `and its shadow comes up (${r[2].w})`);
    prev = r[2].w;
  }
});

test('with maxShadowsPerEntity the rows from the casters\' records take their light\'s cut fade too', async () => {
  const k = await setup();
  const rows = stampLine(k, [340, 100, 300, 200, 500], 3, 1);
  // The records' rows go caster by caster: the kept are 100, 300 and 200, in the casters' order.
  assert.deepEqual(rows.map((r) => r.x), [100, 300, 200]);
  assert.deepEqual(rows.map((r) => r.w), [1, fade(300, 340), 1]);
});
