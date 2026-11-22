import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIGHT_DATA_TEX_HEIGHT,
  lightDataTextureFloatCount,
  packLightDataTexel,
  clearUnusedLightDataTexels,
} from '../../src/util/utils.js';
import { readLightDataTexel } from '../reference/renderMathJs.mjs';

test('light data texture pack/read matches the RGBA32F layout (row 2: DX-SPOT\'s cones, row 3: N-212\'s fades)', () => {
  const maxLights = 4;
  assert.equal(LIGHT_DATA_TEX_HEIGHT, 4);
  assert.equal(lightDataTextureFloatCount(maxLights), maxLights * 4 * 4);

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

test('clearUnusedLightDataTexels zeros the cone row\'s leftover slots too', () => {
  const maxLights = 4;
  const data = new Float32Array(lightDataTextureFloatCount(maxLights)).fill(7);
  clearUnusedLightDataTexels(data, maxLights, 1);
  for (let row = 0; row < 3; row++) {
    const base = row * maxLights * 4;
    assert.deepEqual(Array.from(data.subarray(base, base + 4)), [7, 7, 7, 7], `row ${row}: the live slot stays`);
    assert.deepEqual(Array.from(data.subarray(base + 4, base + 16)), new Array(12).fill(0), `row ${row}: the rest cleared`);
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

test('E-511: clearUnusedLightDataTexels clears only up to last frame\'s lights, the texels the upload then sends', () => {
  const maxLights = 8;
  const data = new Float32Array(lightDataTextureFloatCount(maxLights));
  for (let i = 0; i < 5; i++) packLightDataTexel(data, maxLights, i, i + 1, i + 2, 1000, 1, 1, 1);
  // A texel past last frame's 5 lights holds a stray value: up to 5 is cleared, past it is not touched.
  data[6 * 4] = 42;
  clearUnusedLightDataTexels(data, maxLights, 2, 5);
  for (let row = 0; row < LIGHT_DATA_TEX_HEIGHT; row++) {
    for (let i = 2; i < 5; i++) {
      for (let c = 0; c < 4; c++) assert.equal(data[(row * maxLights + i) * 4 + c], 0, `row ${row} light ${i}`);
    }
  }
  assert.equal(data[6 * 4], 42, 'past the last frame\'s lights: left alone');
  assert.equal(readLightDataTexel(data, maxLights, 1).x, 2, 'the lights now: kept');
  // Without upTo, every texel past the lights, as before.
  clearUnusedLightDataTexels(data, maxLights, 2);
  assert.equal(data[6 * 4], 0);
});
