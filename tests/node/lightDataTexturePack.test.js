import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIGHT_DATA_TEX_HEIGHT,
  lightDataTextureFloatCount,
  packLightDataTexel,
  readLightDataTexel,
  clearUnusedLightDataTexels,
} from '../../src/core/utils.js';

test('light data texture pack/read matches 2-row RGBA32F layout', () => {
  const maxLights = 4;
  assert.equal(LIGHT_DATA_TEX_HEIGHT, 2);
  assert.equal(lightDataTextureFloatCount(maxLights), maxLights * 2 * 4);

  const data = new Float32Array(lightDataTextureFloatCount(maxLights));
  packLightDataTexel(data, maxLights, 0, 10, 20, 5000, 1, 0.5, 0.25);
  packLightDataTexel(data, maxLights, 2, -3, 7.5, 10000, 0, 1, 0);

  // Row 0 is contiguous floats [0 .. maxLights*4)
  assert.deepEqual(Array.from(data.subarray(0, 4)), [10, 20, 5000, 0]);
  assert.deepEqual(Array.from(data.subarray(8, 12)), [-3, 7.5, 10000, 0]);

  // Row 1 starts at maxLights * 4
  assert.deepEqual(Array.from(data.subarray(maxLights * 4, maxLights * 4 + 4)), [
    1, 0.5, 0.25, 0,
  ]);
  assert.deepEqual(
    Array.from(data.subarray(maxLights * 4 + 8, maxLights * 4 + 12)),
    [0, 1, 0, 0]
  );

  const a = readLightDataTexel(data, maxLights, 0);
  assert.equal(a.x, 10);
  assert.equal(a.y, 20);
  assert.equal(a.intensity, 5000);
  assert.equal(a.r, 1);
  assert.equal(a.g, 0.5);
  assert.equal(a.b, 0.25);

  const b = readLightDataTexel(data, maxLights, 2);
  assert.equal(b.x, -3);
  assert.equal(b.y, 7.5);
  assert.equal(b.intensity, 10000);
  assert.equal(b.r, 0);
  assert.equal(b.g, 1);
  assert.equal(b.b, 0);
});

test('clearUnusedLightDataTexels zeros leftover compact slots after shrink', () => {
  const maxLights = 4;
  const data = new Float32Array(lightDataTextureFloatCount(maxLights));
  packLightDataTexel(data, maxLights, 0, 10, 20, 5000, 1, 0.5, 0.25);
  packLightDataTexel(data, maxLights, 1, 30, 40, 6000, 0.2, 0.3, 0.4);
  packLightDataTexel(data, maxLights, 2, -3, 7.5, 10000, 0, 1, 0);

  packLightDataTexel(data, maxLights, 0, 11, 22, 4000, 0.5, 0.25, 0.125);
  clearUnusedLightDataTexels(data, maxLights, 1);

  const live = readLightDataTexel(data, maxLights, 0);
  assert.equal(live.x, 11);
  assert.equal(live.y, 22);
  assert.equal(live.intensity, 4000);
  assert.equal(live.r, 0.5);
  assert.equal(live.g, 0.25);
  assert.equal(live.b, 0.125);

  for (let i = 1; i < maxLights; i++) {
    const slot = readLightDataTexel(data, maxLights, i);
    assert.equal(slot.x, 0);
    assert.equal(slot.y, 0);
    assert.equal(slot.intensity, 0);
    assert.equal(slot.r, 0);
    assert.equal(slot.g, 0);
    assert.equal(slot.b, 0);
  }
});

test('clearUnusedLightDataTexels with liveCount 0 zeros the whole buffer', () => {
  const maxLights = 4;
  const data = new Float32Array(lightDataTextureFloatCount(maxLights));
  packLightDataTexel(data, maxLights, 0, 10, 20, 5000, 1, 0.5, 0.25);
  packLightDataTexel(data, maxLights, 1, 30, 40, 6000, 0.2, 0.3, 0.4);
  clearUnusedLightDataTexels(data, maxLights, 0);
  assert.deepEqual(Array.from(data), new Array(lightDataTextureFloatCount(maxLights)).fill(0));
});
