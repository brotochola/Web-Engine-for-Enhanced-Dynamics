import test from 'node:test';
import assert from 'node:assert/strict';

import { LightEmitter } from '../../src/components/lightEmitter.js';
import { lightInfluenceRadius, LIGHT_INFLUENCE_RADIUS_SCALE } from '../../src/util/utils.js';

// B28 (lights see occluders only within visualRange). Raycasted occluders come
// from the light entity's Collider.visualRange neighbors, so game code needs the
// light's reach to cover it: LightEmitter.influenceRadius.

test('influenceRadius is the radius the lighting culls use', () => {
  const n = 2;
  LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(n)), n);
  const light = new LightEmitter(1);
  light.lightIntensity = 14000;
  assert.equal(light.influenceRadius, lightInfluenceRadius(LightEmitter.sqrtLightIntensity[1]));
  assert.ok(Math.abs(light.influenceRadius - Math.sqrt(14000) * LIGHT_INFLUENCE_RADIUS_SCALE) < 1e-3);
  light.lightIntensity = 0;
  assert.equal(light.influenceRadius, 0);
});

