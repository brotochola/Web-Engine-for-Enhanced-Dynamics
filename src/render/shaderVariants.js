/**
 * N-303 CR-14: the shader variants the renderer makes from their base when it loads them, instead of files that repeat
 * the base. Each is the base with a few exact edits (replaceOnce): a base that lacks a mark throws a WeedJS error that
 * names it.
 */
import { hasOnce, replaceOnce } from './shaderEdit.js';

/** The premultiplied outputs the additive variant replaces: the sprite's (its alpha in `a`) and the GPU particles'. */
const SPRITE_PMA_OUT = '  float ia = abs(vColor.a);\n  float a = vColor.a < 0.0 ? 0.0 : t.a * ia;\n  finalColor = vec4(t.rgb * vColor.rgb * ia, a);\n';
const PARTICLE_PMA_OUT = '  finalColor = vec4(t.rgb * vColor.rgb * vColor.a, t.a * vColor.a);\n';
const ADDITIVE_OUT = '  finalColor = vec4(t.rgb * vColor.rgb * abs(vColor.a), 0.0);\n';

/**
 * The additive (glow) fragment: the same premultiplied colour with alpha 0, so an ADD blend adds the colour and leaves
 * the destination's alpha as it was.
 * @param {string} frag instancedSprite.frag.glsl or gpuParticle.frag.glsl
 * @returns {string}
 */
export function additiveFragGlsl(frag) {
  const from = hasOnce(frag, SPRITE_PMA_OUT) ? SPRITE_PMA_OUT : PARTICLE_PMA_OUT;
  return replaceOnce(frag, from, ADDITIVE_OUT, 'the additive variant of a sprite or particle fragment shader');
}
