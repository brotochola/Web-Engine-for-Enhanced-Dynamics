import test from 'node:test';
import assert from 'node:assert/strict';
import { additiveFragGlsl, spritePoseGlsl, spritePoseWgsl } from '../../src/render/shaderVariants.js';
import { readEngineShader } from './engineShaderSources.mjs';

// N-303 CR-14: the pose and additive variants are their base with a few exact edits, and nothing else of the base
// changes on the way. When their files went, each variant equalled its file byte for byte (the particle one but a
// comment line).

test('the pose variants read the previous position and draw at the pose mix, the rest the base', () => {
  const vert = readEngineShader('instancedSprite.vert.glsl');
  const pose = spritePoseGlsl(vert);
  assert.match(pose, /^in vec2 aInstPrevXY;$/m);
  assert.match(pose, /^uniform float uPoseAlpha;$/m);
  assert.match(pose, /vec2 xy = mix\(aInstPrevXY, aInstXY, uPoseAlpha\);\n {2}vec2 world = \(isShear \? sheared : spun\) \+ xy;/);
  const back = pose
    .replace('in vec2 aInstPrevXY;\n', '')
    .replace('uniform float uPoseAlpha;\n', '')
    .replace('  vec2 xy = mix(aInstPrevXY, aInstXY, uPoseAlpha);\n', '')
    .replace('spun) + xy;', 'spun) + aInstXY;');
  assert.equal(back, vert);

  const wgsl = readEngineShader('instancedSprite.wgsl');
  const poseWgsl = spritePoseWgsl(wgsl);
  assert.match(poseWgsl, /uTileWorld: vec4<f32>,\n {2}uPoseAlpha: f32,/);
  assert.match(poseWgsl, /@location\(9\) aInstTileOff: vec2<f32>,\n {2}@location\(10\) aInstPrevXY: vec2<f32>,/);
  assert.match(poseWgsl, /let xy = mix\(aInstPrevXY, aInstXY, uniforms\.uPoseAlpha\);\n {2}let world = select\(spun, sheared, isShear\) \+ xy;/);
  const backWgsl = poseWgsl
    .replace('  uPoseAlpha: f32,\n', '')
    .replace('  @location(10) aInstPrevXY: vec2<f32>,\n', '')
    .replace('  let xy = mix(aInstPrevXY, aInstXY, uniforms.uPoseAlpha);\n', '')
    .replace('isShear) + xy;', 'isShear) + aInstXY;');
  assert.equal(backWgsl, wgsl);
});

test('the additive variants write the premultiplied colour with alpha 0, the rest the base', () => {
  const additive = '  finalColor = vec4(t.rgb * vColor.rgb * abs(vColor.a), 0.0);\n';
  const sprite = readEngineShader('instancedSprite.frag.glsl');
  const spriteAdd = additiveFragGlsl(sprite);
  assert.ok(spriteAdd.includes(additive));
  assert.doesNotMatch(spriteAdd, /float a = /);
  assert.equal(spriteAdd.replace(additive, '  float ia = abs(vColor.a);\n  float a = vColor.a < 0.0 ? 0.0 : t.a * ia;\n  finalColor = vec4(t.rgb * vColor.rgb * ia, a);\n'), sprite);

  const particle = readEngineShader('gpuParticle.frag.glsl');
  const particleAdd = additiveFragGlsl(particle);
  assert.ok(particleAdd.includes(additive));
  assert.equal(particleAdd.replace(additive, '  finalColor = vec4(t.rgb * vColor.rgb * vColor.a, t.a * vColor.a);\n'), particle);
});

test('the shared test reader gives the variants by the names their files had', () => {
  assert.equal(readEngineShader('instancedSpritePose.vert.glsl'), spritePoseGlsl(readEngineShader('instancedSprite.vert.glsl')));
  assert.equal(readEngineShader('instancedSpritePose.wgsl'), spritePoseWgsl(readEngineShader('instancedSprite.wgsl')));
  assert.equal(readEngineShader('instancedSpriteAdditive.frag.glsl'), additiveFragGlsl(readEngineShader('instancedSprite.frag.glsl')));
  assert.equal(readEngineShader('gpuParticleAdditive.frag.glsl'), additiveFragGlsl(readEngineShader('gpuParticle.frag.glsl')));
});

test('a base without the marks throws a WeedJS error that names the variant', () => {
  assert.throws(() => spritePoseGlsl('void main() {}'), /WeedJS: the pose variant of instancedSprite\.vert\.glsl needs one "in vec2 aInstTileOff;"/);
  assert.throws(() => spritePoseWgsl('@vertex fn main() {}'), /WeedJS: the pose variant of instancedSprite\.wgsl needs one/);
  assert.throws(() => additiveFragGlsl('void main() {}'), /WeedJS: the additive variant of a sprite or particle fragment shader/);
});
