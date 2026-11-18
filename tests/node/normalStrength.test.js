// OL-2: lighting.normalStrength, how much a sprite's own normals count for the sun and for the lamps. The light pass's
// formula is checked in the browser (tests/bench/normalLightCheck.mjs); here, what a scene may write and what it reads as.
import test from 'node:test';
import assert from 'node:assert/strict';

import { LIGHTING_DEFAULTS, normalStrengthOf } from '../../src/util/configDefaults.js';
import { unknownConfigKeys } from '../../src/util/configKeys.js';

test('the default keeps a sprite as drawn under the sun and by its normals under a lamp', () => {
  assert.deepEqual({ ...LIGHTING_DEFAULTS.normalStrength }, { sun: 0, lamps: 1 });
  assert.deepEqual(normalStrengthOf(undefined), { sun: 0, lamps: 1 });
  assert.deepEqual(normalStrengthOf({}), { sun: 0, lamps: 1 });
  assert.deepEqual(normalStrengthOf({ normalStrength: null }), { sun: 0, lamps: 1 });
});

test('a scene may write one of the two numbers, or both', () => {
  assert.deepEqual(normalStrengthOf({ normalStrength: { sun: 1 } }), { sun: 1, lamps: 1 });
  assert.deepEqual(normalStrengthOf({ normalStrength: { lamps: 0.25 } }), { sun: 0, lamps: 0.25 });
  assert.deepEqual(normalStrengthOf({ normalStrength: { sun: 0.5, lamps: 0 } }), { sun: 0.5, lamps: 0 });
});

test('a number outside 0..1 is cut to it, and what is not a number reads as the default', () => {
  assert.deepEqual(normalStrengthOf({ normalStrength: { sun: 3, lamps: -2 } }), { sun: 1, lamps: 0 });
  assert.deepEqual(normalStrengthOf({ normalStrength: { sun: 'full', lamps: NaN } }), { sun: 0, lamps: 1 });
  assert.deepEqual(normalStrengthOf({ normalStrength: 0.5 }), { sun: 0, lamps: 1 }, 'one number for both is not the key');
});

test('the scene knows the key and its two names', () => {
  assert.deepEqual(unknownConfigKeys({ lighting: { normalStrength: { sun: 1, lamps: 1 } } }), []);
  const [item] = unknownConfigKeys({ lighting: { normalStrength: { lamp: 1 } } });
  assert.equal(item.path, 'lighting.normalStrength.lamp');
  assert.equal(item.nearest, 'lamps');
});
