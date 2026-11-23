// N-277 (lighting.dither, off by default): the light pass dithers its output by half an 8-bit step, so a lamp's dim falloff
// does not band into rings in the light's 8-bit target. Both languages, both outputs (a face's texel and the floor's); with
// pixelArt the noise is the art pixel's, so each art pixel stays one colour; without the option the light is as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lightingSource } from '../../src/render/faceMap.js';
import { readEngineShader } from './engineShaderSources.mjs';

const shader = (name) => readEngineShader(name);

// The shaders' noise in JS (interleaved gradient noise of a pixel's coordinates), as weedDither adds it.
const noise = (x, y) => {
  const f = (v) => v - Math.floor(v);
  return f(52.9829189 * f(x * 0.06711056 + y * 0.00583715)) - 0.5;
};

test('N-277: the noise stays within half a step and spreads evenly over a tile of pixels', () => {
  let min = 1, max = -1, sum = 0;
  const n = 64;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = noise(x + 0.5, y + 0.5);
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
  }
  assert.ok(min >= -0.5 && max < 0.5, 'within half a step either way');
  assert.ok(Math.abs(sum / (n * n)) < 0.01, 'no bias: the light keeps its level on average');
  assert.ok(max - min > 0.95, 'the whole step is used');
});

test('N-277: with lighting.dither both outputs of the light pass are dithered, in GLSL and WGSL, by the art pixel with pixelArt', () => {
  const flags = { faces: true, sunMap: true, ids: true, dither: true };
  for (const [name, faceOut, floorOut] of [
    ['lightingBasic.frag.glsl', 'finalColor = vec4(weedDither(min(faceLight(', 'totalLight = weedDither(min(totalLight, vec3(1.0)), ditherAt);'],
    ['lightingBasic.wgsl', 'return vec4<f32>(weedDither(min(faceLight(', 'totalLight = weedDither(min(totalLight, vec3<f32>(1.0)), ditherAt);'],
  ]) {
    const plain = lightingSource(shader(name), flags);
    assert.ok(plain.includes(faceOut) && plain.includes(floorOut), name);
    assert.ok(!plain.includes('ditherAt = fragWorld;'), `${name}: the screen pixel's noise`);
    const art = lightingSource(shader(name), { ...flags, pixelArt: true });
    assert.ok(art.includes('ditherAt = fragWorld;'), `${name}: the art pixel's noise`);
    assert.ok(plain.includes('fract(52.9829189 * fract(dot(p, vec2'), `${name}: the noise`);
  }
});

test('N-277: without lighting.dither the light is stored as it is (weedDither returns its colour)', () => {
  for (const name of ['lightingBasic.frag.glsl', 'lightingBasic.wgsl']) {
    const off = lightingSource(shader(name), { faces: true, sunMap: true });
    const body = off.slice(off.indexOf('weedDither('), off.indexOf('}', off.indexOf('weedDither(')));
    assert.ok(body.includes('return c;') && !body.includes('fract('), `${name}: no noise`);
    assert.ok(!/#if !?DITHER/.test(off), `${name}: its blocks resolved`);
  }
});
