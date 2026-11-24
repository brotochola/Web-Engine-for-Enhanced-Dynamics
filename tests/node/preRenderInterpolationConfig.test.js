import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePreRenderInterpolation } from '../../src/util/configDefaults.js';

test('preRender.interpolation is a boolean', () => {
  assert.equal(resolvePreRenderInterpolation(false), false);
  assert.equal(resolvePreRenderInterpolation(undefined), false);
  assert.equal(resolvePreRenderInterpolation(null), false);
  assert.equal(resolvePreRenderInterpolation(true), true);
});
