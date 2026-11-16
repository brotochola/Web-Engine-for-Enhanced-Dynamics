/**
 * N-180: Sun.angle, Sun.elevation and the shadow terms' setters move the shadows (SHADOW_DIR_X/Y, the length ratio the
 * renderers read), not only setTimeOfDay. Read through the SAB as a worker does.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Sun } from '../../src/core/sun.js';
import { SUN_DEFAULTS } from '../../src/util/configDefaults.js';

function boot(hour = 10) {
  const sab = new SharedArrayBuffer(Sun.BYTE_LENGTH);
  Sun.initializeStaged(sab);
  Sun.initFromConfig({ ...SUN_DEFAULTS, enabled: true });
  Sun.setTimeOfDay(hour);
  Sun.publish();
  const f32 = new Float32Array(sab);
  return {
    dirX: () => f32[Sun.F32.SHADOW_DIR_X],
    dirY: () => f32[Sun.F32.SHADOW_DIR_Y],
    ratio: () => f32[Sun.F32.SHADOW_LENGTH_RATIO],
  };
}

beforeEach(() => Sun.unbind());
afterEach(() => Sun.unbind());

test('Sun.angle turns the shadows: their direction is the sun bearing turned half a turn and by the offset', () => {
  const w = boot();
  for (const angle of [0, 45, 90, 200, 315]) {
    Sun.angle = angle;
    Sun.publish();
    const t = (angle / 360) * Math.PI * 2 + Sun.shadowAngleOffset;
    assert.ok(Math.abs(w.dirX() + Math.cos(t)) < 1e-5, `dir x at ${angle}`);
    assert.ok(Math.abs(w.dirY() + Math.sin(t)) < 1e-5, `dir y at ${angle}`);
  }
});

test('Sun.elevation and the length ratios set the shadows\' length: horizon the longest, zenith the shortest', () => {
  const w = boot();
  Sun.shadowMinLengthRatio = 0.2;
  Sun.shadowMaxLengthRatio = 1.5;
  Sun.elevation = 0;
  Sun.publish();
  assert.ok(Math.abs(w.ratio() - 1.5) < 1e-6);
  Sun.elevation = 90;
  Sun.publish();
  assert.ok(Math.abs(w.ratio() - 0.2) < 1e-6);
  Sun.elevation = 45;
  Sun.publish();
  assert.ok(Math.abs(w.ratio() - 0.85) < 1e-6);
});

test('Sun.shadowAngleOffset turns the shadows too', () => {
  const w = boot();
  Sun.angle = 90;
  Sun.shadowAngleOffset = 0;
  Sun.publish();
  const x0 = w.dirX();
  const y0 = w.dirY();
  Sun.shadowAngleOffset = Math.PI;
  Sun.publish();
  assert.ok(Math.abs(w.dirX() + x0) < 1e-5 && Math.abs(w.dirY() + y0) < 1e-5, 'a half turn of offset flips the shadows');
});

test('setTimeOfDay still derives the same shadows as before (angle, elevation, then one update)', () => {
  const w = boot(15);
  const angle = ((15 / 24 - 0.25) * 360 + 360) % 360;
  const t = (angle / 360) * Math.PI * 2 + Sun.shadowAngleOffset;
  assert.ok(Math.abs(Sun.angle - angle) < 1e-4);
  assert.ok(Math.abs(w.dirX() + Math.cos(t)) < 1e-5);
  assert.ok(Math.abs(w.dirY() + Math.sin(t)) < 1e-5);
});
