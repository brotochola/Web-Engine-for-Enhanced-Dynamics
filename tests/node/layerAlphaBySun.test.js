/** DX-LAYERSUN: the sun's factor on a layer's alpha, and the shared formula with the ShadowCaster pass. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { Sun } from '../../src/core/sun.js';
import { normalizeAlphaBySun } from '../../src/core/layer.js';
import { SUN_DEFAULTS } from '../../src/util/configDefaults.js';

function bootSun(config = {}) {
  Sun.initializeStaged(new SharedArrayBuffer(Sun.BYTE_LENGTH));
  Sun.initFromConfig({ ...SUN_DEFAULTS, enabled: true, ...config });
}

/** The formula the ShadowCaster pass had before it moved to Sun.shadowOpacity. */
function oldPass() {
  const sunOn = Sun.isInitialized && Sun.enabled && Sun.intensity > 0.1;
  if (!sunOn) return 0;
  const si = Sun.intensity;
  const len = Sun.shadowLengthRatio || 1;
  return Sun.shadowAlpha * si * (1 - Sun.shadowStretchAlphaFactor * (1 - Sun.shadowMinLengthRatio / len));
}

beforeEach(() => Sun.unbind());
afterEach(() => Sun.unbind());

test('Sun.shadowOpacity is the old pass formula at every hour and config', () => {
  for (const shadowAlpha of [0.25, 0.4, 1]) {
    for (const shadowStretchAlphaFactor of [0, 0.5, 1]) {
      bootSun({ shadowAlpha, shadowStretchAlphaFactor });
      for (let h = 0; h < 24; h += 0.25) {
        Sun.setTimeOfDay(h);
        assert.equal(Sun.shadowOpacity, oldPass(), `hour ${h}`);
      }
      Sun.unbind();
    }
  }
});

test('Sun.shadowOpacity is 0 with no sun, the sun off, and at or under the threshold', () => {
  assert.equal(Sun.shadowOpacity, 0);
  bootSun();
  Sun.setTimeOfDay(12);
  assert.ok(Sun.shadowOpacity > 0);
  Sun.intensity = 0.09;
  assert.equal(Sun.shadowOpacity, 0);
  Sun.intensity = 0.11;
  assert.ok(Sun.shadowOpacity > 0);
  Sun.enabled = false;
  assert.equal(Sun.shadowOpacity, 0);
});

test('the pass reads the one function', () => {
  const pixi = fs.readFileSync(new URL('../../src/workers/pixiWorker.js', import.meta.url), 'utf8');
  assert.match(pixi, /u\.uSun\[3\] = Sun\.shadowOpacity;/);
});

test('alphaFactor: shadow, night and the ramp, both ways', () => {
  bootSun({ night: { intensity: 0.3, color: 0x5473f2, from: 0.4, to: 0.1 } });
  Sun.setTimeOfDay(12);
  assert.equal(Sun.alphaFactor('shadow'), Sun.shadowOpacity);
  assert.equal(Sun.alphaFactor('night'), 0);
  Sun.setTimeOfDay(22);
  assert.equal(Sun.alphaFactor('shadow'), 0);
  assert.equal(Sun.alphaFactor('night'), 1);

  Sun.intensity = 0.25;
  assert.ok(Math.abs(Sun.alphaFactor({ from: 0.1, to: 0.4 }) - 0.5) < 1e-6);
  assert.ok(Math.abs(Sun.alphaFactor({ from: 0.4, to: 0.1 }) - 0.5) < 1e-6);
  Sun.intensity = 0.05;
  assert.equal(Sun.alphaFactor({ from: 0.1, to: 0.4 }), 0);
  assert.equal(Sun.alphaFactor({ from: 0.4, to: 0.1 }), 1);
  Sun.intensity = 0.9;
  assert.equal(Sun.alphaFactor({ from: 0.1, to: 0.4 }), 1);
  assert.equal(Sun.alphaFactor({ from: 0.4, to: 0.1 }), 0);
  assert.equal(Sun.alphaFactor({ from: 0.5, to: 0.5 }), 1, 'from = to is a step');
});

test('normalizeAlphaBySun keeps the three forms and refuses the rest, by name', () => {
  assert.equal(normalizeAlphaBySun('a', undefined), null);
  assert.equal(normalizeAlphaBySun('a', null), null);
  assert.equal(normalizeAlphaBySun('a', 'shadow'), 'shadow');
  assert.equal(normalizeAlphaBySun('a', 'night'), 'night');
  assert.deepEqual(normalizeAlphaBySun('a', { from: 1, to: 0, extra: 1 }), { from: 1, to: 0 });
  assert.throws(() => normalizeAlphaBySun('shadows', 'noon'), /layer "shadows" alphaBySun/);
  assert.throws(() => normalizeAlphaBySun('shadows', { from: 1 }), /layer "shadows" alphaBySun/);
});

test('every instanced sprite and mesh fill shader, both dialects, takes the layer alpha', () => {
  const read = (name) => fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8');
  for (const name of ['instancedSprite', 'instancedSpritePose', 'colliderFill', 'meshUvFill']) {
    const glsl = read(`${name}.vert.glsl`);
    assert.match(glsl, /uniform vec4 uColor;/, name);
    assert.match(glsl, /vColor = vec4\(rgb, instA \* uColor\.a\);/, name);
    assert.match(read(`${name}.wgsl`), /vec4<f32>\(rgb, instA \* localUniforms\.uColor\.a\)/, name);
  }
});
