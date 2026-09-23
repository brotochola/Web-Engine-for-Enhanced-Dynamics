import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, '../../src/render/instancedSpriteBatch.js'), 'utf8');
const gpuJs = readFileSync(join(dir, '../../src/render/webgpu/instancedSpriteWgsl.js'), 'utf8');
const wgsl = readFileSync(join(dir, '../../src/shaders/instancedSprite.wgsl'), 'utf8');

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
  assert.match(src, /this\._alphaDiscard = alphaDiscard !== false/);
  assert.match(src, /fragEntry = this\._alphaDiscard \? 'mainFrag' : 'mainFragBlend'/);
  assert.match(wgsl, /fn mainFrag\(in: VertexOut\)[\s\S]*?if \(a < cut\.x\) \{ discard; \}/);
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
  assert.match(src, /_finishUpload\(out, INSTANCED_SPRITE_STRIDE\)/);
  assert.match(wgsl, /aInstTileInv/);
  assert.match(wgsl, /aInstTileOff/);
  assert.match(wgsl, /fract\(vWorld\.x \* vTileInv\.x \+ vTileOff\.x\)/);
  assert.match(wgsl, /fract\(vLocal\.x \* \(-vTileInv\.x\) \+ vTileOff\.x\)/);
  assert.match(wgsl, /uTileWorld: vec4<f32>/);
  assert.match(wgsl, /select\(world, world \* uniforms\.uTileWorld\.z \+ uniforms\.uTileWorld\.xy, uniforms\.uTileWorld\.w > 0\.5\)/);
  assert.match(src, /this\._tileWorld = new Float32Array\(4\)/);
  assert.match(src, /tw\[3\] = 1/);
  assert.match(src, /useScreen = space === BATCH_SPACE\.SCREEN/);
  assert.match(wgsl, /textureLoad\(uTexLut/);
  assert.match(wgsl, /bitcast<u32>\(aInstTintBits\)/);
  assert.match(src, /instancedSpriteGpuProgram/);
  assert.match(wgsl, /@group\(2\) @binding\(2\) var uTexLut/);
  assert.match(gpuJs, /unfilterable-float/);
});

test('ctor sets State.depthMask; upload excludeType0/1; indices skip filter', () => {
  assert.match(src, /depthMask = true/);
  assert.match(src, /state\.depthMask = depthMask !== false/);
  assert.match(src, /excludeType0/);
  assert.match(src, /excludeType1/);
  assert.match(src, /o\.indices/);
  assert.match(src, /useIndices/);
});

const pixiSrc = readFileSync(join(dir, '../../src/workers/pixiWorker.js'), 'utf8');

test('empty instanced meshes stay hidden and are not RT roots (WebGPU instanceCount 0)', () => {
  assert.match(pixiSrc, /function emptyInstancedMesh\(obj\)/);
  assert.match(pixiSrc, /setDisplayVisible\(this\.spriteGlowMesh, on\)/);
  assert.match(pixiSrc, /this\._rtEmptyContainer = new Container\(\)/);
  assert.match(pixiSrc, /emptyInstancedMesh\(this\.shadowBatch\.mesh\)/);
  assert.match(pixiSrc, /emptyInstancedMesh\(densityMesh\)/);

  const start = pixiSrc.indexOf('function emptyInstancedMesh');
  const end = pixiSrc.indexOf('function makeBatchViews');
  assert.ok(start >= 0 && end > start);
  const box = {};
  new Function(`${pixiSrc.slice(start, end)}; this.emptyInstancedMesh = emptyInstancedMesh; this.setDisplayVisible = setDisplayVisible`).call(box);

  assert.equal(box.emptyInstancedMesh(null), false);
  assert.equal(box.emptyInstancedMesh({}), false);
  assert.equal(box.emptyInstancedMesh({ geometry: { instanceCount: 1 } }), false);
  assert.equal(box.emptyInstancedMesh({ geometry: { instanceCount: 0 } }), true);

  const sprite = { visible: true };
  box.setDisplayVisible(sprite, true);
  assert.equal(sprite.visible, true);
  const emptyMesh = { visible: true, geometry: { instanceCount: 0 } };
  box.setDisplayVisible(emptyMesh, true);
  assert.equal(emptyMesh.visible, false);
  const filled = { visible: false, geometry: { instanceCount: 4 } };
  box.setDisplayVisible(filled, true);
  assert.equal(filled.visible, true);
  box.setDisplayVisible(filled, false);
  assert.equal(filled.visible, false);
});

test('particles share the painter list; glow stays ADD; no second particle batch', () => {
  assert.match(pixiSrc, /t === 1\) np\+\+/);
  assert.match(pixiSrc, /t === 3\) idxG\[ng\+\+\]/);
  assert.match(pixiSrc, /opts\.indices = idxG/);
  assert.match(pixiSrc, /alphaDiscard: false/);
  assert.doesNotMatch(pixiSrc, /entitiesParticleBatch/);
  assert.doesNotMatch(pixiSrc, /_rqIdxParticle/);
});

test('render-queue partition idx buffers are Uint32 (no Uint16 wrap past 65535)', () => {
  assert.match(pixiSrc, /_rqIdxEntity = new Uint32Array\(maxItems\)/);
  assert.match(pixiSrc, /_rqIdxGlow = new Uint32Array\(maxItems\)/);
  assert.doesNotMatch(pixiSrc, /_rqIdxEntity = new Uint16Array\(maxItems\)/);
  assert.doesNotMatch(pixiSrc, /_rqIdxGlow = new Uint16Array\(maxItems\)/);
  assert.doesNotMatch(pixiSrc, /_rqIdxParticle/);
});

test('entity and custom-layer uploads pass queue repeatX/Y and tile fields', () => {
  assert.match(pixiSrc, /this\.renderQueueRepeatX = buffer\.repeatX/);
  assert.match(pixiSrc, /repeatX: this\.renderQueueRepeatX/);
  assert.match(pixiSrc, /repeatY: this\.renderQueueRepeatY/);
  assert.match(pixiSrc, /tileMulX: this\.renderQueueTileMulX/);
  assert.match(pixiSrc, /tileOffsetU: this\.renderQueueTileOffsetU/);
  assert.match(pixiSrc, /this\._bindSpriteQueue\(q, ref, count\)/);
  assert.match(src, /_beginUpload\(/);
  assert.match(src, /_finishUpload\(/);
  assert.doesNotMatch(src, /coveragePass/);
  assert.doesNotMatch(src, /SPRITE_OPAQUE_ALPHA/);
});

test('GLSL twins keep PMA rgb * instance alpha; no tex.a re-multiply', () => {
  const shaderDir = join(dir, '../../src/shaders');
  const glsl = [
    readFileSync(join(shaderDir, 'instancedSprite.frag.glsl'), 'utf8'),
    readFileSync(join(shaderDir, 'instancedSpriteBlend.frag.glsl'), 'utf8'),
    readFileSync(join(shaderDir, 'instancedSpriteAdditive.frag.glsl'), 'utf8'),
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
    '../../src/render/instancedSpriteBatch.js'
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
  const lighting = readFileSync(join(dir, '../../src/shaders/lightingBasic.frag.glsl'), 'utf8');
  assert.match(lighting, /for \(int i = 0; i < MAX_LIGHTS; i\+\+\)/);
  assert.doesNotMatch(lighting, /\$\{this\.maxLights\}/);
  assert.match(pixiSrc, /\/MAX_LIGHTS\/g/);
  assert.match(pixiSrc, /lightingBasic\.frag\.glsl/);
  assert.match(pixiSrc, /instancedSprite\.wgsl/);
  assert.match(pixiSrc, /instancedSprite\.vert\.glsl/);
});

test('lighting WGSL reconstructs world from framebuffer Y without flip', () => {
  const glsl = readFileSync(join(dir, '../../src/shaders/lightingBasic.frag.glsl'), 'utf8');
  const wgsl = readFileSync(join(dir, '../../src/shaders/lightingBasic.wgsl'), 'utf8');
  assert.match(glsl, /normCoord = gl_FragCoord\.xy \/ uViewport/);
  assert.match(wgsl, /normCoord = in\.position\.xy \/ vp/);
  assert.doesNotMatch(wgsl, /1\.0 - in\.position\.y/);
});
