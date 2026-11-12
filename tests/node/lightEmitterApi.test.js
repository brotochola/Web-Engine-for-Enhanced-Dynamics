import test from 'node:test';
import assert from 'node:assert/strict';

import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Layer } from '../../src/core/layer.js';

// DX-LIGHTAPI: the instance accessors of LightEmitter. radius, brightness, elevation and the offsets are plain
// columns; glow is never negative; glowLayer takes and gives a layer's name over the glowLayerId column.

function oneLight() {
  const n = 2;
  LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(n)), n);
  return new LightEmitter(1);
}

test('radius, brightness and elevation are the columns', () => {
  const light = oneLight();
  light.radius = 300;
  light.brightness = 0.5;
  light.elevation = 40;
  assert.equal(LightEmitter.radius[1], 300);
  assert.equal(LightEmitter.brightness[1], 0.5);
  assert.equal(LightEmitter.elevation[1], 40);
  assert.equal(light.radius, 300);
});

test('glow is never negative: a negative or NaN value draws no halo', () => {
  const light = oneLight();
  light.glow = 0.75;
  assert.equal(light.glow, 0.75);
  light.glow = -1;
  assert.equal(light.glow, 0);
  light.glow = NaN;
  assert.equal(light.glow, 0);
  light.glow = 1.5;
  assert.equal(light.glow, 1.5, 'over 1 brightens the additive halo');
});

test('glowLayer is set and read by name; null follows the entity; an unknown name throws', () => {
  Layer.initializeFromConfig({ glows: {} }, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  const light = oneLight();
  assert.equal(light.glowLayer, null);
  light.glowLayer = 'glows';
  assert.equal(LightEmitter.glowLayerId[1], Layer.getId('glows'));
  assert.equal(light.glowLayer, 'glows');
  light.glowLayer = null;
  assert.equal(LightEmitter.glowLayerId[1], 0);
  assert.throws(() => { light.glowLayer = 'nope'; }, /no layer named 'nope'/);
});
