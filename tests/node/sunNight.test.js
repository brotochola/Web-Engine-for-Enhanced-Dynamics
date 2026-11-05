/** DX-SUNNIGHT: the night's own light and the scene's hour-to-color table, on the real Sun and the shipped shaders. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { Sun } from '../../src/core/sun.js';
import { Scene } from '../../src/core/scene.js';
import { SUN_DEFAULTS } from '../../src/util/configDefaults.js';

const NIGHT = { intensity: 0.3, color: 0x5473f2, from: 0.4, to: 0.1 };

function bootSun(config = {}) {
  const sab = new SharedArrayBuffer(Sun.BYTE_LENGTH);
  Sun.initializeStaged(sab);
  Sun.initFromConfig({ ...SUN_DEFAULTS, enabled: true, ...config });
  return sab;
}

beforeEach(() => Sun.unbind());
afterEach(() => Sun.unbind());

test('the layout only grows: the old fields keep their offsets, the new ones sit after them', () => {
  assert.equal(Sun.BYTE_LENGTH, 96);
  assert.equal(Sun.OFFSETS.SHADOW_ANGLE, 56);
  assert.equal(Sun.OFFSETS.NIGHT_FACTOR, 60);
  for (const [name, index] of Object.entries(Sun.F32)) assert.equal(Sun.OFFSETS[name], index * 4, name);
  for (const [name, index] of Object.entries(Sun.U32)) assert.equal(Sun.OFFSETS[name], index * 4, name);
});

test('nightFactor: 1 at 22 h, 0 at noon, and the formula on the way', () => {
  bootSun({ night: NIGHT });
  Sun.setTimeOfDay(22);
  assert.equal(Sun.nightFactor, 1);
  Sun.setTimeOfDay(12);
  assert.equal(Sun.nightFactor, 0);
  Sun.setTimeOfDay(5);
  const i = Sun.intensity;
  assert.ok(i > 0.1 && i < 0.4, `5 h sits in the ramp, intensity ${i}`);
  assert.ok(Math.abs(Sun.nightFactor - (0.4 - i) / 0.3) < 1e-6);
});

test('nightFactor works without a day cycle and follows an intensity set by hand', () => {
  bootSun({ night: NIGHT });
  Sun.intensity = 0.25;
  assert.ok(Math.abs(Sun.nightFactor - 0.5) < 1e-6);
  Sun.nightFrom = 0.5;
  assert.ok(Math.abs(Sun.nightFactor - 0.25 / 0.4) < 1e-6, 'the setters recompute it');
  Sun.nightFrom = 0.25;
  Sun.nightTo = 0.25;
  assert.equal(Sun.nightFactor, 1, 'from = to is a step at that intensity');
  Sun.intensity = 0.3;
  assert.equal(Sun.nightFactor, 0);
});

test('nightFactor reaches the SAB with the publish, and a worker intensity write refreshes it on its side', () => {
  const sab = bootSun({ night: NIGHT });
  Sun.publish();
  Sun.setTimeOfDay(22);
  const f32 = new Float32Array(sab);
  assert.equal(f32[Sun.F32.NIGHT_FACTOR], 0);
  Sun.publish();
  assert.equal(f32[Sun.F32.NIGHT_FACTOR], 1);
  assert.equal(f32[Sun.F32.NIGHT_INTENSITY], Math.fround(0.3));

  Sun.unbind();
  Sun.initialize(sab);
  Sun.intensity = 1;
  assert.equal(Sun.nightFactor, 0);
});

test('nightLightRGB is color × strength × factor, and 0 by default', () => {
  bootSun();
  const out = new Float32Array(3);
  Sun.setTimeOfDay(22);
  Sun.nightLightRGB(out);
  assert.deepEqual(Array.from(out), [0, 0, 0], 'SUN_DEFAULTS has no night light');

  Sun.nightIntensity = NIGHT.intensity;
  Sun.nightColor = NIGHT.color;
  Sun.nightLightRGB(out);
  assert.ok(Math.abs(out[0] - (0x54 / 255) * 0.3) < 1e-6);
  assert.ok(Math.abs(out[1] - (0x73 / 255) * 0.3) < 1e-6);
  assert.ok(Math.abs(out[2] - (0xf2 / 255) * 0.3) < 1e-6);
  Sun.setTimeOfDay(12);
  Sun.nightLightRGB(out);
  assert.deepEqual(Array.from(out), [0, 0, 0]);
});

test('the night light leaves Sun.intensity and every shadow value exactly as they were', () => {
  const read = () => {
    Sun.setTimeOfDay(22);
    return [Sun.intensity, Sun.color, Sun.shadowDirX, Sun.shadowDirY, Sun.shadowLengthRatio, Sun.shadowAngle];
  };
  bootSun();
  const without = read();
  Sun.unbind();
  bootSun({ night: NIGHT });
  assert.deepEqual(read(), without);
  assert.ok(Sun.intensity < 0.1, 'still under the sun-shadow threshold');
});

test('the scene merges a partial night over the defaults', () => {
  const scene = Object.create(Scene.prototype);
  const lighting = { sun: { night: { intensity: 0.2 } } };
  scene.config = { lighting };
  Scene.prototype._applyConfigDefaults.call(scene, { lighting });
  assert.deepEqual({ ...scene.config.lighting.sun.night }, { ...SUN_DEFAULTS.night, intensity: 0.2 });
});

test('lighting.sun.colors replaces the table for the scene, in any order, wrapping midnight', () => {
  bootSun({ colors: [{ hour: 18, color: 0x000000 }, { hour: 6, color: 0xff0000 }] });
  assert.equal(Sun._getColorForHour(6), 0xff0000);
  assert.equal(Sun._getColorForHour(12), 0x800000);
  assert.equal(Sun._getColorForHour(18), 0x000000);
  assert.equal(Sun._getColorForHour(0), 0x800000, 'midnight sits halfway from 18 h to 6 h');
  assert.equal(Sun._getColorForHour(3), 0xbf0000);
  Sun.setTimeOfDay(6);
  assert.equal(Sun.color, 0xff0000);
});

test('with no table the default one stands, unchanged, and teardown forgets a scene table', () => {
  bootSun();
  const hours = Sun.DEFAULT_COLORS.slice(0, -1);
  assert.deepEqual(hours.map((k) => Sun._getColorForHour(k.hour)), hours.map((k) => k.color));
  Sun.setColors([{ hour: 12, color: 0x010203 }]);
  assert.equal(Sun._getColorForHour(3), 0x010203);
  Sun.unbind();
  assert.equal(Sun._colors, Sun.DEFAULT_COLORS);
  Sun.setColors([]);
  assert.equal(Sun._colors, Sun.DEFAULT_COLORS);
});

test('both lighting shaders add the night term, and the WGSL struct lists what the uniform group does, in order', () => {
  const glsl = fs.readFileSync(new URL('../../src/shaders/lightingBasic.frag.glsl', import.meta.url), 'utf8');
  const wgsl = fs.readFileSync(new URL('../../src/shaders/lightingBasic.wgsl', import.meta.url), 'utf8');
  const pixi = fs.readFileSync(new URL('../../src/workers/pixiWorker.js', import.meta.url), 'utf8');
  assert.match(glsl, /totalLight \+= vec3\(uNightR, uNightG, uNightB\)/);
  assert.match(wgsl, /totalLight \+= vec3<f32>\(uniforms\.uNightR, uniforms\.uNightG, uniforms\.uNightB\)/);
  const struct = wgsl.match(/struct LightingUniforms \{([^}]*)\}/)[1];
  const names = [...struct.matchAll(/^\s*(u\w+):/gm)].map((m) => m[1]);
  const end = pixi.indexOf('...this._lightingShadowResources()');
  const start = pixi.lastIndexOf('uCameraPos:', end);
  const declared = [...pixi.slice(start, end).matchAll(/^\s*(u\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(declared, names, 'Pixi lays the buffer out in the group order');
});
