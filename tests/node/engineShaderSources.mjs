/**
 * The engine's shader sources for tests, as the renderer holds them: a file of src/shaders, or one of the variants it
 * makes from a base at load (src/render/shaderVariants.js, N-303 CR-14), read here under the name its file had.
 */
import fs from 'node:fs';
import { additiveFragGlsl, spritePoseGlsl, spritePoseWgsl } from '../../src/render/shaderVariants.js';

const SHADER_DIR = new URL('../../src/shaders/', import.meta.url);
const file = (name) => fs.readFileSync(new URL(name, SHADER_DIR), 'utf8');

/** The variants the renderer makes, by the name each one's file had. */
const MADE = {
  'instancedSpritePose.vert.glsl': () => spritePoseGlsl(file('instancedSprite.vert.glsl')),
  'instancedSpritePose.wgsl': () => spritePoseWgsl(file('instancedSprite.wgsl')),
  'instancedSpriteAdditive.frag.glsl': () => additiveFragGlsl(file('instancedSprite.frag.glsl')),
  'gpuParticleAdditive.frag.glsl': () => additiveFragGlsl(file('gpuParticle.frag.glsl')),
};

/** A shader's source by file name: a file of src/shaders, or a variant made as the renderer makes it. */
export function readEngineShader(name) {
  const made = MADE[name];
  return made ? made() : file(name);
}

/** The instanced sprite batch's WebGL sources, by the keys the renderer gives the batch (a new object each call). */
export function spriteGlslShaders() {
  return {
    spriteVertPose: readEngineShader('instancedSpritePose.vert.glsl'),
    spriteVert: readEngineShader('instancedSprite.vert.glsl'),
    spriteFrag: readEngineShader('instancedSprite.frag.glsl'),
    spriteFragAdd: readEngineShader('instancedSpriteAdditive.frag.glsl'),
  };
}
