import test from 'node:test';
import assert from 'node:assert/strict';

import { applyParticleEase } from '../../src/util/particleTween.js';
import { PARTICLE_DEFAULTS, PARTICLE_EASE } from '../../src/util/configDefaults.js';

// E-59. applyParticleEase was split so TurboFan can inline it (its front now
// uses literal case labels). This is the single-switch version it replaced,
// written with the PARTICLE_EASE names: every id, in and out of range, must
// give the same double, bit for bit.

const EXPO_LUT_SIZE = PARTICLE_DEFAULTS.expoLutSize | 0;
function buildExpoLut(fn) {
  const lut = new Float32Array(EXPO_LUT_SIZE + 1);
  for (let i = 0; i <= EXPO_LUT_SIZE; i++) lut[i] = fn(i / EXPO_LUT_SIZE);
  return lut;
}
const EXPO_IN_LUT = buildExpoLut((t) => Math.pow(2, 10 * (t - 1)));
const EXPO_OUT_LUT = buildExpoLut((t) => 1 - Math.pow(2, -10 * t));
const EXPO_INOUT_LUT = buildExpoLut((t) =>
  t < 0.5 ? 0.5 * Math.pow(2, 20 * t - 10) : 1 - 0.5 * Math.pow(2, -20 * t + 10)
);
function sampleExpoLut(lut, t) {
  const x = t * EXPO_LUT_SIZE;
  const i = x | 0;
  const f = x - i;
  return lut[i] + (lut[i + 1] - lut[i]) * f;
}

function referenceEase(t, easeId) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  switch (easeId | 0) {
    case PARTICLE_EASE.QUAD_IN: return t * t;
    case PARTICLE_EASE.QUAD_OUT: return t * (2 - t);
    case PARTICLE_EASE.QUAD_INOUT: return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case PARTICLE_EASE.CUBIC_IN: return t * t * t;
    case PARTICLE_EASE.CUBIC_OUT: { const u = t - 1; return u * u * u + 1; }
    case PARTICLE_EASE.CUBIC_INOUT: {
      if (t < 0.5) return 4 * t * t * t;
      const u = 2 * t - 2;
      return (t - 1) * u * u + 1;
    }
    case PARTICLE_EASE.EXPO_IN: return sampleExpoLut(EXPO_IN_LUT, t);
    case PARTICLE_EASE.EXPO_OUT: return sampleExpoLut(EXPO_OUT_LUT, t);
    case PARTICLE_EASE.EXPO_INOUT: return sampleExpoLut(EXPO_INOUT_LUT, t);
    case PARTICLE_EASE.BACK_IN: { const s = 1.70158; return t * t * ((s + 1) * t - s); }
    case PARTICLE_EASE.BACK_OUT: { const s = 1.70158; const u = t - 1; return u * u * ((s + 1) * u + s) + 1; }
    case PARTICLE_EASE.BACK_INOUT: {
      const s = 1.70158 * 1.525;
      if (t < 0.5) { const u = t * 2; return 0.5 * (u * u * ((s + 1) * u - s)); }
      const u = t * 2 - 2;
      return 0.5 * (u * u * ((s + 1) * u + s) + 2);
    }
    case PARTICLE_EASE.BOUNCE_OUT: {
      const n1 = 7.5625;
      const d1 = 2.75;
      if (t < 1 / d1) return n1 * t * t;
      if (t < 2 / d1) { const u = t - 1.5 / d1; return n1 * u * u + 0.75; }
      if (t < 2.5 / d1) { const u = t - 2.25 / d1; return n1 * u * u + 0.9375; }
      const u = t - 2.625 / d1;
      return n1 * u * u + 0.984375;
    }
    case PARTICLE_EASE.LERP:
    default:
      return t;
  }
}

const ts = [-1, -1e-9, 0, 1e-7, 0.001, 0.25, 0.3636363636, 0.49999999, 0.5, 0.50000001, 0.7272727, 0.9090909, 0.999999, 1, 1.5, NaN];
for (let i = 0; i <= 1000; i++) ts.push(i / 1000);
const ids = [...Object.values(PARTICLE_EASE), -1, 14, 99, 2.7, NaN];

test('applyParticleEase: every id gives the single-switch value bit for bit', () => {
  const ref = new Float64Array(1);
  const got = new Float64Array(1);
  const refBits = new BigUint64Array(ref.buffer);
  const gotBits = new BigUint64Array(got.buffer);
  for (const id of ids) {
    for (const t of ts) {
      ref[0] = referenceEase(t, id);
      got[0] = applyParticleEase(t, id);
      assert.equal(gotBits[0], refBits[0], `id ${id}, t ${t}: ${got[0]} vs ${ref[0]}`);
    }
  }
});

test('applyParticleEase: the literal case labels are the PARTICLE_EASE ids', () => {
  // The front writes these as numbers; renumbering PARTICLE_EASE must fail here.
  assert.equal(PARTICLE_EASE.LERP, 0);
  assert.equal(PARTICLE_EASE.QUAD_IN, 1);
  assert.equal(PARTICLE_EASE.QUAD_OUT, 2);
  assert.equal(PARTICLE_EASE.QUAD_INOUT, 3);
  assert.equal(PARTICLE_EASE.CUBIC_IN, 4);
  assert.equal(PARTICLE_EASE.CUBIC_OUT, 5);
  assert.equal(PARTICLE_EASE.CUBIC_INOUT, 6);
});
