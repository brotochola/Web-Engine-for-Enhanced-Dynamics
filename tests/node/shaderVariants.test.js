import test from 'node:test';
import assert from 'node:assert/strict';
import { additiveFragGlsl } from '../../src/render/shaderVariants.js';
import { readEngineShader } from './engineShaderSources.mjs';

// N-303 CR-14: the additive variants are their base with an exact edit, and nothing else of the base changes on the way.
// When their files went, each variant equalled its file byte for byte (the particle one but a comment line).

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
  assert.equal(readEngineShader('instancedSpriteAdditive.frag.glsl'), additiveFragGlsl(readEngineShader('instancedSprite.frag.glsl')));
  assert.equal(readEngineShader('gpuParticleAdditive.frag.glsl'), additiveFragGlsl(readEngineShader('gpuParticle.frag.glsl')));
});

test('a base without the marks throws a WeedJS error that names the variant', () => {
  assert.throws(() => additiveFragGlsl('void main() {}'), /WeedJS: the additive variant of a sprite or particle fragment shader/);
});
