import test from 'node:test';
import assert from 'node:assert/strict';

import { declaredEntityCount, resolveEntityIdWidth, MAX_ENTITIES_U16 } from '../../src/util/entityIdWidth.js';
import { SCENE_DEFAULTS } from '../../src/util/configDefaults.js';

// entityIdWidth 'auto' (the default): the engine picks 16-bit ids while every pool the scene declares fits
// them, 32-bit past that; 16 or 32 is still the developer's to force.

class A {}
class B {}

test('auto is the default and decides from the declared pools', () => {
  assert.equal(SCENE_DEFAULTS.entityIdWidth, 'auto');
  const auto = { entityIdWidth: 'auto' };
  assert.equal(resolveEntityIdWidth(auto, 0), 16);
  assert.equal(resolveEntityIdWidth(auto, MAX_ENTITIES_U16), 16);
  assert.equal(resolveEntityIdWidth(auto, MAX_ENTITIES_U16 + 1), 32);
  assert.equal(resolveEntityIdWidth({}, 250001), 32, 'no key reads as auto');
  assert.equal(resolveEntityIdWidth(auto), 16, 'a caller without a count gets 16, as before');
});

test('16 and 32 still force the width', () => {
  assert.equal(resolveEntityIdWidth({ entityIdWidth: 32 }, 10), 32);
  assert.equal(resolveEntityIdWidth({ entityIdWidth: '32' }, 10), 32);
  assert.equal(resolveEntityIdWidth({ entityIdWidth: 16 }, 100000), 16, 'forced 16 then fails validation, as before');
});

test('the declared count is every static pool plus the Flash pool', () => {
  assert.equal(declaredEntityCount([[A, 250000], [B, 1]], 0), 250001);
  assert.equal(declaredEntityCount([[A, 60000]], 6000), 66000);
  assert.equal(declaredEntityCount([[A, 0], [B, -3]], undefined), 0);
  assert.equal(declaredEntityCount(undefined, 10), 10);
});
