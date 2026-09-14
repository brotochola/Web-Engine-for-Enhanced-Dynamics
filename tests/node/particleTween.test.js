/**
 * Particle tween resolve + ease unit checks (no worker).
 * Run: node tests/node/particleTween.test.js
 */
import assert from 'assert';
import {
  PARTICLE_TWEEN,
  resolveParticleOp,
  resolveParticleColorOp,
  applyParticleEase,
  lerpRgb,
  resolveEaseId,
} from '../../src/util/particleTween.js';
import { PARTICLE_EASE } from '../../src/util/configDefaults.js';

// Spawn-only range
{
  const a = resolveParticleOp(3, 0);
  assert.strictEqual(a.from, 3);
  assert.strictEqual(a.tween, false);
}

// from/to fixed
{
  const a = resolveParticleOp({ from: 1, to: 0 }, 1);
  assert.strictEqual(a.from, 1);
  assert.strictEqual(a.to, 0);
  assert.strictEqual(a.tween, true);
  assert.strictEqual(a.ease, PARTICLE_EASE.LERP);
}

// nested min/max endpoints + ease string
{
  const a = resolveParticleOp(
    { from: { min: 0.5, max: 0.5 }, to: 0, ease: 'quad.out' },
    1
  );
  assert.strictEqual(a.from, 0.5);
  assert.strictEqual(a.to, 0);
  assert.strictEqual(a.ease, PARTICLE_EASE.QUAD_OUT);
}

// start/end aliases
{
  const a = resolveParticleOp({ start: 2, end: 4 }, 0);
  assert.strictEqual(a.from, 2);
  assert.strictEqual(a.to, 4);
}

// color from/to
{
  const c = resolveParticleColorOp({ from: 0xff0000, to: 0x00ff00 }, 0xffffff);
  assert.strictEqual(c.from, 0xff0000);
  assert.strictEqual(c.to, 0x00ff00);
  assert.strictEqual(c.tween, true);
}

// ease table (no sin)
assert.strictEqual(applyParticleEase(0, PARTICLE_EASE.LERP), 0);
assert.strictEqual(applyParticleEase(1, PARTICLE_EASE.LERP), 1);
assert.ok(Math.abs(applyParticleEase(0.5, PARTICLE_EASE.LERP) - 0.5) < 1e-9);
assert.ok(applyParticleEase(0.5, PARTICLE_EASE.QUAD_IN) < 0.5);
assert.ok(applyParticleEase(0.5, PARTICLE_EASE.QUAD_OUT) > 0.5);
assert.strictEqual(resolveEaseId('bounce.out'), PARTICLE_EASE.BOUNCE_OUT);
assert.strictEqual(resolveEaseId(PARTICLE_EASE.CUBIC_IN), PARTICLE_EASE.CUBIC_IN);

// Expo LUT tracks Math.pow within ~1e-3 (256 samples)
{
  const exact = 1 - Math.pow(2, -10 * 0.5);
  const lut = applyParticleEase(0.5, PARTICLE_EASE.EXPO_OUT);
  assert.ok(Math.abs(lut - exact) < 1e-3, `expoOut LUT err ${Math.abs(lut - exact)}`);
}

// rgb lerp midpoint
{
  const mid = lerpRgb(0x000000, 0xffffff, 0.5);
  assert.strictEqual(mid, 0x808080);
}

assert.strictEqual(PARTICLE_TWEEN.ALPHA, 1);
assert.strictEqual(PARTICLE_TWEEN.ROT, 16);

console.log('particleTween.test.js OK');
