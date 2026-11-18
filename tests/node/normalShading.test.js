// OL-6: lighting.normalShading, the shading a sprite's own normals cause under the sun and under the lamps: an amount
// subtracted from it (never under 0), then a strength that multiplies the rest. The light pass's formula is checked in
// the browser (tests/bench/normalLightCheck.mjs); here, what a scene may write and what it reads as.
import test from 'node:test';
import assert from 'node:assert/strict';

import { LIGHTING_DEFAULTS, normalShadingOf } from '../../src/util/configDefaults.js';
import { unknownConfigKeys } from '../../src/util/configKeys.js';

const DEFAULT = { sun: { strength: 0, subtract: 0 }, lamps: { strength: 1, subtract: 0 } };

test('the default keeps a sprite as drawn under the sun and by its normals under a lamp, nothing subtracted', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(LIGHTING_DEFAULTS.normalShading)), DEFAULT);
  assert.deepEqual(normalShadingOf(undefined), DEFAULT);
  assert.deepEqual(normalShadingOf({}), DEFAULT);
  assert.deepEqual(normalShadingOf({ normalShading: null }), DEFAULT);
  assert.deepEqual(normalShadingOf({ normalShading: { sun: null, lamps: 3 } }), DEFAULT);
});

test('a scene may write any of the four numbers', () => {
  assert.deepEqual(
    normalShadingOf({ normalShading: { sun: { strength: 0.8, subtract: 0.2 } } }),
    { sun: { strength: 0.8, subtract: 0.2 }, lamps: { strength: 1, subtract: 0 } },
  );
  assert.deepEqual(
    normalShadingOf({ normalShading: { lamps: { subtract: 0.25 } } }),
    { sun: { strength: 0, subtract: 0 }, lamps: { strength: 1, subtract: 0.25 } },
  );
  assert.deepEqual(
    normalShadingOf({ normalShading: { sun: { strength: 1 }, lamps: { strength: 0 } } }),
    { sun: { strength: 1, subtract: 0 }, lamps: { strength: 0, subtract: 0 } },
  );
});

test('a number outside 0..1 is cut to it, and what is not a number reads as the default', () => {
  assert.deepEqual(
    normalShadingOf({ normalShading: { sun: { strength: 3, subtract: -1 }, lamps: { strength: -2, subtract: 7 } } }),
    { sun: { strength: 1, subtract: 0 }, lamps: { strength: 0, subtract: 1 } },
  );
  assert.deepEqual(normalShadingOf({ normalShading: { sun: { strength: 'full', subtract: NaN } } }), DEFAULT);
  assert.deepEqual(normalShadingOf({ normalShading: { sun: 0.5, lamps: 0.5 } }), DEFAULT, 'one number a light is not the key');
});

test('the scene knows the key, its two lights and their two numbers', () => {
  assert.deepEqual(
    unknownConfigKeys({ lighting: { normalShading: { sun: { strength: 1, subtract: 0.2 }, lamps: { strength: 1, subtract: 0 } } } }),
    [],
  );
  const [light] = unknownConfigKeys({ lighting: { normalShading: { lamp: { strength: 1 } } } });
  assert.equal(light.path, 'lighting.normalShading.lamp');
  assert.equal(light.nearest, 'lamps');
  const [number] = unknownConfigKeys({ lighting: { normalShading: { sun: { substract: 0.2 } } } });
  assert.equal(number.path, 'lighting.normalShading.sun.substract');
  assert.equal(number.nearest, 'subtract');
});

test('lighting.normalStrength, which never left its branch, is not a key', () => {
  const [item] = unknownConfigKeys({ lighting: { normalStrength: { sun: 1, lamps: 1 } } });
  assert.equal(item.path, 'lighting.normalStrength');
});
