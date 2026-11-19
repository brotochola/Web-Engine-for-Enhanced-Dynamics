import test from 'node:test';
import assert from 'node:assert/strict';
import { stepSpinSetting, validatePhysicsConfig } from '../../src/box2d/physicsConfig.js';
import { PHYSICS_DEFAULTS } from '../../src/util/configDefaults.js';

// E-426: physics.stepSpin, 'auto' by default (E-298's rule, physicsStepSpin.test.js: spin where every engine thread has
// a logical CPU), or true / false to force Box2D's pool threads to spin or sleep through a step.

test("physics.stepSpin is 'auto' by default; true and false force it; anything else is 'auto'", () => {
  assert.equal(PHYSICS_DEFAULTS.stepSpin, 'auto');
  assert.equal(validatePhysicsConfig(null, {}).stepSpin, 'auto');
  assert.equal(validatePhysicsConfig(null, { stepSpin: false }).stepSpin, false);
  assert.equal(validatePhysicsConfig(null, { stepSpin: true }).stepSpin, true);
  for (const v of ['off', 0, 1, null, 'auto']) assert.equal(stepSpinSetting(v), 'auto', String(v));
  const off = validatePhysicsConfig(null, { stepSpin: false });
  assert.equal(validatePhysicsConfig(off, { subStepCount: 2 }).stepSpin, false, 'an update without the key keeps it');
});
