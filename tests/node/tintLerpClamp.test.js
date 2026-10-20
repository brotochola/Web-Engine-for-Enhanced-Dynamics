import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { lerpRgb, applyParticleEase } from '../../src/util/particleTween.js';
import { PARTICLE_EASE } from '../../src/util/configDefaults.js';

// B29 (tint tween wraps). Back and elastic eases overshoot: t leaves 0..1, so a
// tint channel went past 255 or below 0. The entity tween masked it (a white
// tint flashed near-black at the overshoot); the particle lerp did not, and the
// overflow spilled into the next channel. One shared, clamped lerp now.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ch = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

test('channels saturate instead of wrapping when the ease overshoots', () => {
  assert.equal(lerpRgb(0x000000, 0xffffff, 1.2), 0xffffff);
  assert.equal(lerpRgb(0xffffff, 0x000000, -0.2), 0xffffff);
  assert.equal(lerpRgb(0xff00ff, 0x00ff00, 1.5), 0x00ff00);
  assert.equal(lerpRgb(0x808080, 0xff0000, 0.5), 0xc04040);
  assert.ok(lerpRgb(0xffffff, 0x000000, 1.3) === 0, 'no negative spill');
});

test('a back.out tint stays between and at its endpoints', () => {
  const from = 0x20f0a0;
  const to = 0xf02010;
  const lo = ch(from).map((v, k) => Math.min(v, ch(to)[k]));
  const hi = ch(from).map((v, k) => Math.max(v, ch(to)[k]));
  for (let i = 0; i <= 100; i++) {
    const eased = applyParticleEase(i / 100, PARTICLE_EASE.BACK_OUT);
    const c = lerpRgb(from, to, eased);
    assert.ok(c >= 0 && c <= 0xffffff, `packed ${c.toString(16)}`);
    const v = ch(c);
    for (let k = 0; k < 3; k++) {
      // Overshoot may pass an endpoint but only toward 0 or 255, never wrap around.
      const crossedLow = v[k] < lo[k] && v[k] !== 0 && lo[k] - v[k] > 128;
      const crossedHigh = v[k] > hi[k] && v[k] !== 255 && v[k] - hi[k] > 128;
      assert.ok(!crossedLow && !crossedHigh, `t ${i / 100}: channel ${k} = ${v[k]}`);
    }
  }
});

test('entity and particle tweens use the same lerp', () => {
  const tween = readFileSync(join(root, 'src/core/tween.js'), 'utf8');
  assert.ok(!/function lerpRgb/.test(tween), 'no private copy');
  assert.match(tween, /import \{ applyParticleEase, lerpRgb \} from '\.\.\/util\/particleTween\.js'/);
});
