// DX-SHADOW3D (the sun's map) on real code: the sun's terms, where a caster's picture point lands, the map's vertex
// shader made from the sprite shadows' one, and the light pass's blocks for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { SUN_MAP_ZMAX, sunMapLanding, sunMapTerms, sunMapVertex } from '../../src/render/sunShadowMap.js';
import { shaderWithFlag } from '../../src/render/faceMap.js';
import { LIGHTING_DEFAULTS } from '../../src/util/configDefaults.js';
import { unknownConfigKeys } from '../../src/util/configKeys.js';

const shader = (name) => fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8');
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('the sun\'s terms: a px of height shifts its landing away from the sun, and cards run across it', () => {
  // The sun to the south-east at 45°: (cos45·(1, 1)/√2, sin45).
  const s = Math.SQRT1_2;
  const t = sunMapTerms([s * s, s * s, s], new Float32Array(4));
  close(t[0], s, 1e-6);
  close(t[1], s, 1e-6);
  close(t[2] * t[0] + t[3] * t[1], 0, 1e-6);
  assert.ok(t[2] >= 0, 'a card\'s columns run to the right when they can');
  const noon = sunMapTerms([0, 0, 1], new Float32Array(4));
  assert.deepEqual(Array.from(noon), [0, 0, 1, 0], 'straight above: no shift');
  const low = sunMapTerms([1, 0, 0], new Float32Array(4));
  assert.ok(Number.isFinite(low[0]) && low[0] > 10, 'a sun on the horizon is clamped, not infinite');
});

test('a picture point lands its height times the terms away, on the floor drawn at groundScaleY', () => {
  const terms = sunMapTerms([0, 1, 1], new Float32Array(4)); // from the south, at 45°: ky = 1
  const foot = sunMapLanding({ footX: 100, footY: 50, localX: 0, localY: 0, heightScaleY: 0.5 }, terms, 0.5);
  assert.deepEqual(foot, { x: 100, y: 50, z: 0 });
  const top = sunMapLanding({ footX: 100, footY: 50, localX: 0, localY: -10, heightScaleY: 0.5 }, terms, 0.5);
  assert.equal(top.z, 20, '10 screen px up is 20 px of height when a px of height rises 0.5');
  close(top.y, 50 - 20 * 0.5, 1e-9);
  const side = sunMapLanding({ footX: 100, footY: 50, localX: 6, localY: 0, heightScaleY: 0.5 }, terms, 0.5);
  close(side.x, 106, 1e-9);
});

test('the map\'s vertex shader is the sprite shadows\' with its last part turned into landing points', () => {
  const src = sunMapVertex(shader('instancedSpriteShadow.vert.glsl'));
  assert.match(src, /uniform vec4 uSunK;/);
  assert.match(src, /out float vSunZ;/);
  assert.match(src, /vec2 land = foot \+ local\.x \* uSunPerp\.xy - z \* uSunK\.xy;/);
  assert.equal(src.match(/void main\(\)/g).length, 1);
  assert.doesNotMatch(src, /rotated/);
  assert.throws(() => sunMapVertex('void main() {}'), /sun shadow map/);
});

test('the map\'s height span is one number in the module, the map\'s shader and the light pass', () => {
  const span = `${SUN_MAP_ZMAX}.0`;
  assert.ok(shader('sunShadowMap.frag.glsl').includes(`/ ${span}`));
  const light = shaderWithFlag(shader('lightingBasic.frag.glsl'), 'SUNMAP', true);
  assert.ok(light.includes(`* ${span}`));
});

test('the light pass keeps its old sun term without the map and takes the map\'s with it', () => {
  const src = shader('lightingBasic.frag.glsl');
  const off = shaderWithFlag(shaderWithFlag(src, 'SUNMAP', false), '!SUNMAP', true);
  const on = shaderWithFlag(shaderWithFlag(src, 'SUNMAP', true), '!SUNMAP', false);
  assert.doesNotMatch(off, /sunVisibility|uSunMap/);
  assert.match(off, /totalLight \+= sunColor \* uSunIntensity;/);
  assert.match(on, /totalLight \+= sunColor \* uSunIntensity \* sunVisibility\(vec3\(fragWorld, 0\.0\)\);/);
  assert.doesNotMatch(on, /totalLight \+= sunColor \* uSunIntensity;/);
});

test('lighting.sunShadows is a key, sprite by default', () => {
  assert.equal(LIGHTING_DEFAULTS.sunShadows, 'sprite');
  assert.deepEqual(unknownConfigKeys({ lighting: { sunShadows: 'map' } }), []);
});

test('lighting.selfShadow: the light pass steps towards the sun over the face map, only with faces', async () => {
  const { lightingSource } = await import('../../src/render/faceMap.js');
  const src = shader('lightingBasic.frag.glsl');
  assert.match(lightingSource(src, { faces: true, sunMap: false, selfShadow: true }), /sunDirect \*= mix\(1\.0, selfShadow\(p\)/);
  assert.doesNotMatch(lightingSource(src, { faces: true, sunMap: false, selfShadow: false }), /selfShadow|uSelfShadow/);
  assert.doesNotMatch(lightingSource(src, { faces: false, sunMap: false, selfShadow: true }), /selfShadow|uSelfShadow|#if/);
  assert.equal(LIGHTING_DEFAULTS.selfShadow, false);
});
