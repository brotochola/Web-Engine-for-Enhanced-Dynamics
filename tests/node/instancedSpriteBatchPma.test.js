import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, '../../src/workers/InstancedSpriteBatch.js'), 'utf8');
const gpuJs = readFileSync(join(dir, '../../src/workers/instancedSpriteWgsl.js'), 'utf8');
const wgsl = readFileSync(join(dir, '../../src/shaders/instanced_sprite.wgsl'), 'utf8');

test('normal fragment scales PMA rgb by instance alpha without re-multiplying tex.a', () => {
  assert.match(wgsl, /let a = t\.a \* in\.vColor\.a;/);
  assert.match(
    wgsl,
    /return vec4<f32>\(t\.rgb \* in\.vColor\.rgb \* in\.vColor\.a, a\);/
  );
  assert.doesNotMatch(wgsl, /finalColor = c;/);
});

test('depth-write fragment discards clear texels; blend fragment does not', () => {
  assert.match(src, /alphaDiscard = true/);
  assert.match(src, /alphaDiscard !== false \? 'mainFrag' : 'mainFragBlend'/);
  assert.match(wgsl, /fn mainFrag\(in: VertexOut\)[\s\S]*?if \(a < 0\.01\) \{ discard; \}/);
  assert.match(wgsl, /fn mainFragBlend\(in: VertexOut\)[\s\S]*?return vec4<f32>\(t\.rgb \* in\.vColor\.rgb \* in\.vColor\.a, a\);/);
  assert.doesNotMatch(
    wgsl,
    /fn mainFragBlend\(in: VertexOut\)[\s\S]*?discard[\s\S]*?fn mainFragAdd/
  );
});

test('additive fragment scales PMA rgb by instance alpha, alpha forced 0', () => {
  assert.match(wgsl, /return vec4<f32>\(t\.rgb \* in\.vColor\.rgb \* in\.vColor\.a, 0\.0\);/);
});

test('vertex shader uses aInstRotCS without cos/sin of angle', () => {
  assert.match(wgsl, /@location\(4\) aInstRotCS: vec2<f32>/);
  assert.match(wgsl, /let c = aInstRotCS\.x;/);
  assert.doesNotMatch(wgsl, /cos\(aInstRot\)/);
  assert.match(src, /INSTANCED_SPRITE_FLOATS = 15/);
  assert.match(src, /this\.buffer\.update\(out \* INSTANCED_SPRITE_STRIDE\)/);
  assert.match(wgsl, /aInstTileInv/);
  assert.match(wgsl, /aInstTileOff/);
  assert.match(wgsl, /fract\(vWorld\.x \* vTileInv\.x \+ vTileOff\.x\)/);
  assert.match(wgsl, /fract\(vLocal\.x \* \(-vTileInv\.x\) \+ vTileOff\.x\)/);
  assert.match(wgsl, /uTileWorld: vec4<f32>/);
  assert.match(wgsl, /select\(world, world \* uniforms\.uTileWorld\.z \+ uniforms\.uTileWorld\.xy, uniforms\.uTileWorld\.w > 0\.5\)/);
  assert.match(src, /this\._tileWorld = new Float32Array\(4\)/);
  assert.match(src, /tw\[3\] = 1/);
  assert.match(src, /useScreen = space === 'screen'/);
  assert.match(wgsl, /textureLoad\(uTexLut/);
  assert.match(wgsl, /bitcast<u32>\(aInstTintBits\)/);
  assert.match(src, /instancedSpriteGpuProgram/);
  assert.match(wgsl, /@group\(2\) @binding\(2\) var uTexLut/);
  assert.match(gpuJs, /unfilterable-float/);
});

test('ctor sets State.depthMask; upload excludeType accepts a list; indices skip filter', () => {
  assert.match(src, /depthMask = true/);
  assert.match(src, /state\.depthMask = depthMask !== false/);
  assert.match(src, /typeof excludeRaw === 'number' \? \[excludeRaw\] : excludeRaw/);
  assert.match(src, /opts\.indices/);
  assert.match(src, /useIndices/);
});

const pixiSrc = readFileSync(join(dir, '../../src/workers/pixi_worker.js'), 'utf8');

test('particle batch: no Z write, no alpha discard; main queue partitions type 1/3', () => {
  assert.match(pixiSrc, /t === 1\) idxP\[np\+\+\]/);
  assert.match(pixiSrc, /t === 3\) idxG\[ng\+\+\]/);
  assert.match(pixiSrc, /indices: idxP/);
  assert.match(pixiSrc, /indices: idxG/);
  assert.match(pixiSrc, /depthMask: false/);
  assert.match(pixiSrc, /alphaDiscard: false/);
  assert.match(pixiSrc, /entitiesParticleBatch/);
});

test('render-queue partition idx buffers are Uint32 (no Uint16 wrap past 65535)', () => {
  assert.match(pixiSrc, /_rqIdxEntity = new Uint32Array\(maxItems\)/);
  assert.match(pixiSrc, /_rqIdxParticle = new Uint32Array\(maxItems\)/);
  assert.match(pixiSrc, /_rqIdxGlow = new Uint32Array\(maxItems\)/);
  assert.doesNotMatch(pixiSrc, /_rqIdxEntity = new Uint16Array\(maxItems\)/);
  assert.doesNotMatch(pixiSrc, /_rqIdxParticle = new Uint16Array\(maxItems\)/);
  assert.doesNotMatch(pixiSrc, /_rqIdxGlow = new Uint16Array\(maxItems\)/);
});

test('entity and custom-layer uploads pass queue repeatX/Y and tile fields', () => {
  assert.match(pixiSrc, /this\.renderQueueRepeatX = buffer\.repeatX/);
  assert.match(pixiSrc, /repeatX: this\.renderQueueRepeatX/);
  assert.match(pixiSrc, /repeatY: this\.renderQueueRepeatY/);
  assert.match(pixiSrc, /tileMulX: this\.renderQueueTileMulX/);
  assert.match(pixiSrc, /tileOffsetU: this\.renderQueueTileOffsetU/);
  assert.match(pixiSrc, /repeatX: ref\.repeatX/);
  assert.match(pixiSrc, /repeatY: ref\.repeatY/);
  assert.match(pixiSrc, /tileMulX: ref\.tileMulX/);
  assert.match(pixiSrc, /tileOffsetU: ref\.tileOffsetU/);
});

test('GLSL twins keep PMA rgb * instance alpha; no tex.a re-multiply', () => {
  const shaderDir = join(dir, '../../src/shaders');
  const glsl = [
    readFileSync(join(shaderDir, 'instanced_sprite.frag.glsl'), 'utf8'),
    readFileSync(join(shaderDir, 'instanced_sprite_blend.frag.glsl'), 'utf8'),
    readFileSync(join(shaderDir, 'instanced_sprite_additive.frag.glsl'), 'utf8'),
  ].join('\n');
  assert.match(glsl, /finalColor = vec4\(t\.rgb \* vColor\.rgb \* vColor\.a, a\);/);
  assert.match(glsl, /finalColor = vec4\(t\.rgb \* vColor\.rgb \* vColor\.a, 0\.0\);/);
  assert.match(src, /instancedSpriteGlProgram/);
  assert.match(src, /useWebGpu = true/);
});

test('pixi binds packed LUT as rgba32float TextureSource', () => {
  assert.match(pixiSrc, /packTextureLutRgba/);
  assert.match(pixiSrc, /TEX_LUT_RGBA_WIDTH/);
  assert.match(pixiSrc, /setLutSource/);
  assert.match(pixiSrc, /format: 'rgba32float'/);
  assert.match(pixiSrc, /_uploadTexLutTexture/);
  assert.match(pixiSrc, /uploadMethodId = 'external'/);
  assert.match(pixiSrc, /writeRgba32Float/);
  assert.match(pixiSrc, /preference: backend/);
});

test('packTextureLutRgba writes 10 floats into 3 RGBA32F texels', async () => {
  const { packTextureLutRgba, TEX_LUT_FLOATS } = await import(
    '../../src/workers/InstancedSpriteBatch.js'
  );
  const lut = new Float32Array(TEX_LUT_FLOATS);
  for (let i = 0; i < TEX_LUT_FLOATS; i++) lut[i] = i + 1;
  const rgba = packTextureLutRgba(lut, 1);
  assert.equal(rgba.length, 12);
  for (let i = 0; i < 10; i++) assert.equal(rgba[i], i + 1);
  assert.equal(rgba[10], 0);
  assert.equal(rgba[11], 0);
});

test('lighting GLSL loop bound is MAX_LIGHTS token', () => {
  const lighting = readFileSync(join(dir, '../../src/shaders/lighting_basic.frag.glsl'), 'utf8');
  assert.match(lighting, /for \(int i = 0; i < MAX_LIGHTS; i\+\+\)/);
  assert.doesNotMatch(lighting, /\$\{this\.maxLights\}/);
  assert.match(pixiSrc, /\/MAX_LIGHTS\/g/);
  assert.match(pixiSrc, /lighting_basic\.frag\.glsl/);
  assert.match(pixiSrc, /instanced_sprite\.wgsl/);
  assert.match(pixiSrc, /instanced_sprite\.vert\.glsl/);
});

test('lighting WGSL reconstructs world from framebuffer Y without flip', () => {
  const glsl = readFileSync(join(dir, '../../src/shaders/lighting_basic.frag.glsl'), 'utf8');
  const wgsl = readFileSync(join(dir, '../../src/shaders/lighting_basic.wgsl'), 'utf8');
  assert.match(glsl, /normCoord = gl_FragCoord\.xy \/ uViewport/);
  assert.match(wgsl, /normCoord = in\.position\.xy \/ vp/);
  assert.doesNotMatch(wgsl, /1\.0 - in\.position\.y/);
});
