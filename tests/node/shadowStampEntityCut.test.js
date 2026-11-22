// N-330: with maxShadowsPerEntity, a caster's last shown light fades by how near the next light (the first one past the
// cut) is: f = min(1, (dNext - dLast) / (0.2 dNext)) on its row's intensity, folded as DX-SPOT folds a cone's f, so the
// shadow's alpha is f times the light's own. A caster crossing the cut (the next light coming nearer than the last)
// loses that shadow gradually: at the swap both lights stand at f 0. The shipped kernel against the JS reference, and
// the fade's value, on a caster with lights on a line.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GPU_CASTER_FLOATS, GPU_CASTER_LIGHT_FLOAT } from '../../src/render/gpuQueueLayout.js';
import { stampLightRangeWasm } from '../../src/render/shadowStampClient.js';
import { stampLightRange } from '../reference/shadowStamp.mjs';
import { setup } from '../helpers/shadowStampFrames.mjs';

const I = 400;
const RANGE = 2000;

/** Lights at (x, 0); the caster at the origin, one row of GPU_CASTER_FLOATS. */
function stampOne(k, xs, maxPE, extra = {}) {
  const { dst, b, scratch } = k;
  dst.sun.fill(0, 0, GPU_CASTER_FLOATS);
  for (let f = 2; f < GPU_CASTER_FLOATS; f++) dst.sun[f] = 0.25;
  const lights = xs.map((x) => ({ x, y: 0, intensity: I, rangeSq: RANGE * RANGE, maxShadows: 0, invG2: 1, ...extra }));
  const spec = {
    sun: dst.sun, sunN: 1, sunFloats: GPU_CASTER_FLOATS, lights, lightBegin: 0, lightEnd: lights.length, lightStride: 1,
    maxPerLight: 0, maxPerEntity: maxPE, used: null, ...scratch, stamp: dst.stamp, stampFloats: GPU_CASTER_FLOATS,
    stampCap: 16, stampBase: 0, stampLightIdx: dst.stampLightIdx,
  };
  const js = stampLightRange(spec);
  const jsRows = dst.stamp.slice(0, js * GPU_CASTER_FLOATS);
  const jsIdx = dst.stampLightIdx.slice(0, js);
  dst.stamp.fill(0, 0, 16 * GPU_CASTER_FLOATS);
  const n = stampLightRangeWasm(b, spec);
  assert.equal(n, js, 'the kernel writes the rows the JS writes');
  assert.deepEqual(dst.stamp.slice(0, n * GPU_CASTER_FLOATS), jsRows, 'bit for bit');
  assert.deepEqual(dst.stampLightIdx.slice(0, n), jsIdx);
  const rows = [];
  for (let r = 0; r < n; r++) rows.push({ light: dst.stampLightIdx[r], intensity: dst.stamp[r * GPU_CASTER_FLOATS + GPU_CASTER_LIGHT_FLOAT + 2] });
  return rows;
}

/** The intensity a row takes for fade f at floor distance d (cone_intensity's formula, f under 1). */
function faded(f, d) {
  const d2 = d * d;
  return Math.fround(f * I * d2 / (I + d2 - f * I));
}

test('the last shown light fades by how near the next one is; nearer lights and a call without a fourth light do not', async () => {
  const k = await setup();
  // Three lights, three shown: no fade.
  assert.deepEqual(stampOne(k, [100, 200, 300], 3).map((r) => r.intensity), [I, I, I]);
  // A fourth at 340: the third takes f = (340 - 300) / (0.2 * 340).
  const rows = stampOne(k, [100, 200, 300, 340], 3);
  assert.deepEqual(rows.map((r) => r.light), [0, 1, 2]);
  assert.equal(rows[0].intensity, I);
  assert.equal(rows[1].intensity, I);
  assert.equal(rows[2].intensity, faded((340 - 300) / (0.2 * 340), 300));
  // From 20 % farther the fourth changes nothing.
  assert.deepEqual(stampOne(k, [100, 200, 300, 380], 3).map((r) => r.intensity), [I, I, I]);
  // As near as the third: f 0, that shadow is gone.
  assert.equal(stampOne(k, [100, 200, 300, -300], 3)[2].intensity, 0);
  // One shadow a caster: the nearest fades by the second.
  assert.equal(stampOne(k, [100, 110], 1)[0].intensity, faded((110 - 100) / (0.2 * 110), 100));
});

test('a light crossing the cut: the shown shadow goes down to 0 as the next comes level, then the newcomer comes up from 0', async () => {
  const k = await setup();
  let last = Infinity;
  for (const x of [380, 360, 340, 320, 310, 301]) {
    const r = stampOne(k, [100, 200, 300, x], 3);
    assert.equal(r[2].light, 2);
    assert.ok(r[2].intensity < last, `fourth at ${x}: the third's shadow goes down (${r[2].intensity})`);
    last = r[2].intensity;
  }
  assert.ok(last < 0.05 * I, `just past the third, it is nearly gone (${last})`);
  let prev = -1;
  for (const x of [299, 290, 270, 250]) {
    const r = stampOne(k, [100, 200, 300, x], 3);
    assert.equal(r[2].light, 3, `fourth at ${x}: now shown in the third's place`);
    assert.ok(r[2].intensity > prev, `and its shadow comes up (${r[2].intensity})`);
    prev = r[2].intensity;
  }
});

test('a cone or dim light folds the fade with its own f', async () => {
  const k = await setup();
  const rows = stampOne(k, [100, 200, 300, 340], 3, { shade: 0.5 });
  const f = 0.5 * ((340 - 300) / (0.2 * 340));
  assert.equal(rows[2].intensity, faded(f, 300));
  assert.equal(rows[0].intensity, faded(0.5, 100));
});
