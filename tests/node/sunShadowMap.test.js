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
  const noon = sunMapTerms([0, 0, 1], new Float32Array(4));
  assert.deepEqual(Array.from(noon), [0, 0, 1, 0], 'straight above: no shift');
  const low = sunMapTerms([1, 0, 0], new Float32Array(4));
  assert.ok(Number.isFinite(low[0]) && low[0] > 10, 'a sun on the horizon is clamped, not infinite');
});

test('a card\'s columns run to the right of someone at the sun, as the light bench\'s', () => {
  // From the south (behind the camera): the sun sees what the camera sees, the picture's right is the screen's.
  const south = sunMapTerms([0, 1, 1], new Float32Array(4));
  close(south[2], 1);
  close(south[3], 0);
  // From the north: the sun sees the back, so the picture's right lands on the screen's left.
  const north = sunMapTerms([0, -1, 1], new Float32Array(4));
  close(north[2], -1);
  close(north[3], 0);
  // From the east: the right of someone looking west is the north (y down).
  const east = sunMapTerms([1, 0, 1], new Float32Array(4));
  close(east[2], 0);
  close(east[3], -1);
});

test('the sun\'s shift stops at the longest shadow it is given (Sun.shadowMaxLengthRatio)', () => {
  const low = sunMapTerms([1, 0, 0.1], new Float32Array(4), 3);
  close(low[0], 3, 1e-6);
  close(low[1], 0, 1e-6);
  const high = sunMapTerms([1, 0, 1], new Float32Array(4), 3);
  close(high[0], 1, 1e-6, 'a shadow shorter than the cap keeps its length');
});

test('the sprite shadows\' sun card stands on the frame\'s lowest opaque row, not on the anchor', () => {
  const src = shader('instancedSpriteShadow.vert.glsl');
  // The trim's bottom (the lowest opaque row): heights count up from it, and the foot is where it is drawn.
  assert.match(src, /float bottom = aInstTrim\.y \+ aInstTrim\.w;/);
  assert.match(src, /float sunZ = max\(bottom - content\.y, 0\.0\) \* abs\(aInstScale\.y\) \/ uSunK\.w \* height;/);
  assert.match(src, /vec2 foot = vec2\(aInstXY\.x, \(aInstXY\.y \+ \(bottom - aInstAnchor\.y \* aInstSize\.y\) \* aInstScale\.y\) \* uGroundInvScaleY\);/);
  assert.match(src, /vec2 land = foot \+ \(content\.x - footCol\) \* aInstScale\.x \* uSunPerp\.xy - sunZ \* uSunK\.xy;/);
  // A base in the texture table's spare floats moves the foot: an ellipse's edge, or a render's lowest contact.
  assert.match(src, /aInstBase = t2\.zw;/);
  assert.match(src, /foot \+= toSun \* sqrt\(rx \* rx \* toSun\.x \* toSun\.x \+ ry \* ry \* toSun\.y \* toSun\.y\);/);
  assert.match(src, /foot = vec2\(aInstXY\.x, aInstXY\.y \* uGroundInvScaleY\) \+ toSun \* reach;/);
  // The old skewed sprite (stretched by shadowLengthRatio, turned on the screen) is gone from the sun's branch.
  assert.doesNotMatch(src, /uSun\.z/);
  const wgsl = shader('instancedSpriteShadow.wgsl');
  assert.match(wgsl, /let sunZ = max\(bottom - content\.y, 0\.0\) \* abs\(aInstScale\.y\) \/ uniforms\.uSunK\.w \* height;/);
  assert.match(wgsl, /uSunK: vec4<f32>,\n  uSunPerp: vec4<f32>,\n\}/);
  assert.doesNotMatch(wgsl, /uSun\.z/);
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

test('the map\'s vertex shader is the sprite shadows\' with the same sun card, its height passed on', () => {
  const src = sunMapVertex(shader('instancedSpriteShadow.vert.glsl'));
  assert.match(src, /uniform vec4 uSunK;/);
  assert.match(src, /out float vSunZ;/);
  assert.match(src, /vec2 land = foot \+ \(content\.x - footCol\) \* aInstScale\.x \* uSunPerp\.xy - sunZ \* uSunK\.xy;/);
  assert.match(src, /vSunZ = sunZ;/);
  assert.match(src, /vColor = vec4\(1\.0\);/);
  assert.equal(src.match(/void main\(\)/g).length, 1);
  assert.equal(src.match(/uniform vec4 uSunK;/g).length, 1, 'declared once');
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

test('a caster with a height map casts columns: each cell where it is in 3D, the column under it to the floor', async () => {
  const { SUN_MAP_COLUMNS, sunMapColumnGrid, sunMapColumnsVertex } = await import('../../src/render/sunShadowMap.js');
  const grid = sunMapColumnGrid(2);
  assert.equal(grid.length, 2 * 2 * 6 * 4);
  assert.deepEqual(Array.from(grid.subarray(0, 8)), [0.25, 0.25, 0, -1, 0.25, 0.25, 1, -1]);
  const src = sunMapColumnsVertex(shader('instancedSpriteShadow.vert.glsl'));
  assert.match(src, /in vec4 aCell;/);
  assert.match(src, /aQuad = aCell\.xy;/);
  // The floor point under a cell is its screen place moved down by its height (the faces' formula), then the strip runs
  // from there (height 0) to where its ray lands (height z).
  assert.match(src, /vec2 base = vec2\(pix\.x, \(pix\.y \+ uSunK\.w \* z\) \* uGroundInvScaleY\);/);
  assert.match(src, /vSunZ = z \* aCell\.z;/);
  assert.match(src, new RegExp(`/ ${SUN_MAP_COLUMNS}\\.0;`));
  // A render (its base has a contact) casts columns and no card; a picture of one view, maps or not, its card.
  assert.match(src, /if \(aInstBase\.x >= 0\.0 \|\| m\.b \+ m\.a <= 0\.0/);
  assert.match(sunMapVertex(shader('instancedSpriteShadow.vert.glsl')), /if \(aInstBase\.x < 0\.0\) \{/);
  // Drawn on the sprite shadows' layer: the shadow's colour and opacity, no height.
  const flat = sunMapColumnsVertex(shader('instancedSpriteShadow.vert.glsl'), SUN_MAP_COLUMNS, { heights: false });
  assert.match(flat, /vColor = vec4\(0\.0, 0\.0, 0\.0, uSun\.w\);/);
  assert.doesNotMatch(flat, /vSunZ/);
});

test('WebGPU: the map\'s and the solids\' WGSL come from the sprite shadows\' WGSL as the GLSL ones do', async () => {
  const { SUN_MAP_COLUMNS, sunMapWgsl, sunMapColumnsWgsl } = await import('../../src/render/sunShadowMap.js');
  const { sunShadowGpuProgram } = await import('../../src/render/webgpu/instancedSpriteWgsl.js');
  const { lightingGpuProgram } = await import('../../src/render/webgpu/pixiMeshWgsl.js');
  const wgsl = shader('instancedSpriteShadow.wgsl');
  const map = sunMapWgsl(wgsl);
  assert.match(map, /@location\(6\) vSunZ: f32,/);
  assert.ok(map.includes('    out.vSunZ = sunZ;\n'), 'the card\'s height');
  assert.ok(map.includes('fn mainFragMap(in: VertexOut)'), 'the map\'s fragment');
  assert.ok(map.includes('    if (aInstBase.x < 0.0) {'), 'a render\'s frame skips its card');
  const cards = sunMapWgsl(wgsl, { heights: false });
  assert.doesNotMatch(cards, /vSunZ|mainFragMap/, 'the solids\' cards keep the shadow program\'s colour and fragment');
  const columns = sunMapColumnsWgsl(wgsl);
  assert.match(columns, /@location\(0\) aCell: vec4<f32>,/);
  assert.ok(columns.includes('  let aQuad = aCell.xy;\n'));
  assert.match(columns, /@group\(2\) @binding\(5\) var uMaps: texture_2d<f32>;/);
  assert.ok(columns.includes('  out.vSunZ = z * aCell.z;\n'));
  assert.equal(columns.match(/fn mainVert\(/g).length, 1);
  const flat = sunMapColumnsWgsl(wgsl, SUN_MAP_COLUMNS, { heights: false });
  assert.ok(flat.includes('out.vColor = vec4<f32>(0.0, 0.0, 0.0, uniforms.uSun.w);'));
  assert.doesNotMatch(flat, /vSunZ/);
  // The columns read the atlas and the twin page in the vertex stage: their layout says so.
  const GpuProgram = { from: (o) => o };
  const p = sunShadowGpuProgram(GpuProgram, columns, 'mainFragMap', 'c', { maps: true });
  assert.equal(p.layout[2].uMaps, 5);
  assert.ok(p.gpuLayout[2].find((e) => e.binding === 0).visibility === p.gpuLayout[2].find((e) => e.binding === 5).visibility);
  const lit = lightingGpuProgram(GpuProgram, 'x', 'l', true, true);
  assert.deepEqual([lit.layout[2].uFaceMap, lit.layout[2].uSunMap], [4, 5]);
});
