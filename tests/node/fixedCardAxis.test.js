// N-209: a fixed card's axis (bits 15..20 of its caster code) follows the direction drawn, not the facing: a fence at
// facing 15 is drawn with its 11.25 degree frame, and its silhouette must lie along that picture.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';

const DEG = Math.PI / 180;
// A prop's table as the fence's json gives it: 32 directions from 90 degrees, counter-clockwise.
const TABLE = {
  count: 32, uniform: true, start: 90 * DEG, step: (360 / 32) * DEG,
  angles: Array.from({ length: 32 }, (_, i) => (90 - i * 11.25) * DEG),
  anim: Array.from({ length: 32 }, (_, i) => i), flip: new Array(32).fill(0), groups: ['stand'], solid: false,
};
/** The axis bits the shader reads for a card whose picture faces `deg`. */
const axisBits = (deg) => {
  let q = (deg * DEG - Math.PI / 2) / (2 * Math.PI);
  q -= Math.floor(q);
  return Math.round(q * 64) & 63;
};

async function codesFor(facingDeg, drawn, withTable) {
  await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const { computeCasterCodes, sunFrameTables } = await import('../../src/workers/preRenderWorker.js');
  const out = new Int32Array(1);
  const one = (v) => Uint8Array.of(v);
  computeCasterCodes(out, one(1), one(1), one(1), one(1), Float32Array.of(1), one(1), Float32Array.of(facingDeg * DEG), 1,
    withTable ? sunFrameTables({ 1: TABLE }) : null, one(1), one(drawn));
  return (out[0] >> 15) & 63;
}

test('N-209: a fixed card lies along the direction drawn', async () => {
  // Facing 15: the frame drawn is direction 7, 90 - 7 x 11.25 = 11.25 degrees.
  assert.equal(await codesFor(15, 7, true), axisBits(11.25));
  assert.notEqual(axisBits(11.25), axisBits(15), 'the facing alone would stand it off the picture');
  // Facing 188: direction 23, 90 - 23 x 11.25 = -168.75 (191.25) degrees.
  assert.equal(await codesFor(188, 23, true), axisBits(191.25));
});

test('N-209: without a direction table the facing gives the axis', async () => {
  assert.equal(await codesFor(15, 7, false), axisBits(15));
});
