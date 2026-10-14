import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAngleSigned } from '../../src/util/utils.js';

/**
 * H-08. The old function reduced with `%` and then one branch. The replacement
 * drops the remainder and applies the branch at most twice, which is what
 * [-3π, 3π] needs. Bit-identical on (-π, π), where the remainder was a no-op.
 * At most 1 ulp on the closed range, where the remainder rounded.
 */
function legacyNormalize(angle) {
  const TWO_PI = Math.PI * 2;
  angle = angle % TWO_PI;
  if (angle > Math.PI) angle -= TWO_PI;
  else if (angle <= -Math.PI) angle += TWO_PI;
  return angle;
}

function ulpsBetween(a, b) {
  if (Object.is(a, b)) return 0;
  const buf = new ArrayBuffer(8);
  const f = new Float64Array(buf);
  const i = new BigInt64Array(buf);
  const ordered = (x) => {
    f[0] = x;
    const bits = i[0];
    return bits < 0n ? bits ^ 0x7fffffffffffffffn : bits;
  };
  const d = ordered(a) - ordered(b);
  return d < 0n ? -d : d;
}

test('H-08: bit-identical on (-π, π)', () => {
  const lo = -Math.PI;
  const hi = Math.PI;
  const steps = 100000;
  for (let i = 1; i < steps; i++) {
    const angle = lo + ((hi - lo) * i) / steps;
    assert.equal(normalizeAngleSigned(angle), legacyNormalize(angle));
  }
  assert.equal(normalizeAngleSigned(0), 0);
  assert.equal(Object.is(normalizeAngleSigned(-0), -0), true);
});

test('H-08: at most 1 ulp on [-3π, 3π]', () => {
  const lo = -Math.PI * 3;
  const hi = Math.PI * 3;
  const steps = 1000000;
  let maxUlps = 0n;
  let worst = 0;
  for (let i = 0; i <= steps; i++) {
    const angle = lo + ((hi - lo) * i) / steps;
    const got = normalizeAngleSigned(angle);
    const exp = legacyNormalize(angle);
    const ulps = ulpsBetween(got, exp);
    if (ulps > maxUlps) {
      maxUlps = ulps;
      worst = angle;
    }
  }
  assert.ok(
    maxUlps <= 1n,
    `worst ${worst}: ${maxUlps} ulps, got ${normalizeAngleSigned(worst)} expected ${legacyNormalize(worst)}`,
  );
});
