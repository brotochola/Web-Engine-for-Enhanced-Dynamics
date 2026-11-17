import test from 'node:test';
import assert from 'node:assert/strict';

import { litShare, LitWindows } from '../buenosAiresScene/litWindows.js';

// The Buenos Aires demo's lit windows (demos/buenosAiresScene/litWindows.js): how many are lit by the hour, and how they
// come on and go off, one by one.

test('the share of lit windows: none by day, up to 45 % in the evening, fewer late at night, none after dawn', () => {
  assert.equal(litShare(12), 0);
  assert.equal(litShare(17), 0);
  assert.ok(Math.abs(litShare(21) - 0.45) < 1e-9);
  assert.ok(Math.abs(litShare(3) - 0.12) < 1e-9);
  assert.equal(litShare(7), 0);
  assert.ok(Math.abs(litShare(23.9999) - litShare(0)) < 1e-3, 'no jump at midnight');
  for (let hour = 0; hour < 24; hour += 0.05) {
    const share = litShare(hour);
    assert.ok(share >= 0 && share <= 0.45 + 1e-9, `${share} at ${hour} h`);
  }
});

test('windows come on one by one, each fading in, and go off the same way', () => {
  const panes = Array.from({ length: 100 }, (_, n) => n * 2);
  const alphas = new Float32Array(200);
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const windows = new LitWindows(panes, random, alphas);
  let now = 0;
  const litCount = () => alphas.reduce((count, alpha) => count + (alpha > 0.9 ? 1 : 0), 0);
  windows.update(21, now);
  assert.ok(litCount() === 0, 'a window fades in: none is full the first frame');
  for (let frame = 0; frame < 200; frame++) windows.update(21, (now += 16));
  assert.equal(litCount(), 45, '45 % of 100');
  assert.ok(alphas.every((alpha, index) => index % 2 === 0 || alpha === 0), 'only the panes are touched');
  for (let frame = 0; frame < 200; frame++) windows.update(12, (now += 16));
  assert.equal(litCount(), 0, 'all off by day');
  assert.ok(alphas.every((alpha) => alpha === 0));
});
