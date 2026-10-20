import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LightEmitter } from '../../src/components/lightEmitter.js';
import { lightInfluenceRadius, LIGHT_INFLUENCE_RADIUS_SCALE } from '../../src/util/utils.js';

// B28 (lights see occluders only within visualRange). Raycasted occluders come
// from the light entity's Collider.visualRange neighbors. The planet lamp had
// 500 px for a 1183 px light and the ship 80 px for 1414 px, so rock past that
// did not block them. LightEmitter.influenceRadius is the reach to cover.

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

test('the planet lamp and ship cover their light with visualRange', () => {
  for (const f of ['planetLamp.js', 'planetShip.js']) {
    const src = readFileSync(new URL(`../../demos/planetPhysicsScene/gameObjects/${f}`, import.meta.url), 'utf8');
    const setIntensity = src.indexOf('lightIntensity =');
    const setRange = src.indexOf('visualRange = this.lightEmitter.influenceRadius');
    assert.ok(setIntensity > 0 && setRange > setIntensity, `${f}: visualRange follows the light, after the intensity is set`);
    assert.doesNotMatch(src.slice(setRange + 1), /visualRange\s*=/, `${f}: nothing overrides it later`);
  }
});
