/**
 * DX-GLOWRADIUS: a light's halo has its own radius (LightEmitter.glowRadius, px; 0 keeps 0.85 of the light's radius),
 * and a scene whose halos join the entities (lighting.lightGlow 'sprite') has them unshaded. The halo's size in the
 * emit kernel is held equal to the JS reference by preRenderEmitWasm.test.js; this file checks the column and the rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LightEmitter } from '../../src/components/lightEmitter.js';
import { LIGHTING_DEFAULTS, unshadedGlowsOf } from '../../src/util/configDefaults.js';

test('glowRadius is appended to LightEmitter (the columns before it keep their place) and reads back at least 0', () => {
  const columns = Object.keys(LightEmitter.ARRAY_SCHEMA);
  assert.equal(columns.at(-1), 'glowRadius', 'append, do not move');
  assert.equal(LightEmitter.ARRAY_SCHEMA.glowRadius, Float32Array);
  const previous = LightEmitter.glowRadius;
  try {
    LightEmitter.glowRadius = new Float32Array(2);
    const light = Object.create(LightEmitter.prototype);
    Object.defineProperty(light, 'index', { value: 1 });
    light.glowRadius = 24;
    assert.equal(light.glowRadius, 24);
    assert.equal(LightEmitter.glowRadius[0], 0, 'its own row only');
    for (const bad of [-5, NaN, 'x', null]) {
      light.glowRadius = bad;
      assert.equal(light.glowRadius, 0, `${bad} reads as no radius of its own`);
    }
  } finally {
    LightEmitter.glowRadius = previous;
  }
});

test("halos are unshaded in a lit scene whose halos join the entities (lightGlow 'sprite'), and nowhere else", () => {
  assert.equal(LIGHTING_DEFAULTS.lightGlow, 'add', 'the default keeps its additive layer');
  assert.equal(unshadedGlowsOf({ enabled: true, lightGlow: 'sprite' }), true);
  assert.equal(unshadedGlowsOf({ enabled: true, lightGlow: 'add' }), false);
  assert.equal(unshadedGlowsOf({ enabled: true }), false, 'the default');
  assert.equal(unshadedGlowsOf({ enabled: false, lightGlow: 'sprite' }), false, 'no light, nothing to be unshaded from');
  assert.equal(unshadedGlowsOf(undefined), false);
});
