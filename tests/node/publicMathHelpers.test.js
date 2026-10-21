import test from 'node:test';
import assert from 'node:assert/strict';

import WEED, { normalizeAngle, dot2, randomUnitCS } from '../../src/index.js';

// Angle and vector helpers games need (the demos used them through
// /src/util/utils.js, which no bundle exports).

test('normalizeAngle, dot2 and randomUnitCS are named exports and on WEED', () => {
  for (const [name, fn] of Object.entries({ normalizeAngle, dot2, randomUnitCS })) {
    assert.equal(typeof fn, 'function', name);
    assert.equal(WEED[name], fn, name);
  }
});

test('they compute what they say', () => {
  assert.ok(Math.abs(normalizeAngle(-Math.PI / 2) - (3 * Math.PI) / 2) < 1e-12);
  assert.ok(Math.abs(normalizeAngle(5 * Math.PI) - Math.PI) < 1e-12);
  assert.equal(dot2(1, 2, 3, 4), 11);
  const out = { c: 0, s: 0 };
  assert.equal(randomUnitCS(out), out);
  assert.ok(Math.abs(out.c * out.c + out.s * out.s - 1) < 1e-12);
});
