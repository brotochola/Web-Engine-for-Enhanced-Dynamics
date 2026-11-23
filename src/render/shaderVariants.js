/**
 * N-303 CR-14: the shader variants the renderer makes from their base when it loads them, instead of files that repeat
 * the base. Each is the base with a few exact edits (replaceOnce): a base that lacks a mark throws a WeedJS error that
 * names it.
 */
import { hasOnce, replaceOnce } from './shaderEdit.js';

/**
 * The pose batch's vertex shader: instancedSprite.vert.glsl plus the previous position `aInstPrevXY` and
 * `uPoseAlpha`, the sprite placed at mix(previous, current, uPoseAlpha) between two physics poses.
 * @param {string} vert instancedSprite.vert.glsl
 * @returns {string}
 */
export function spritePoseGlsl(vert) {
  const what = 'the pose variant of instancedSprite.vert.glsl';
  let out = replaceOnce(vert, 'in vec2 aInstTileOff;\n', 'in vec2 aInstTileOff;\nin vec2 aInstPrevXY;\n', what);
  out = replaceOnce(out, 'uniform vec4 uTileWorld;\n', 'uniform vec4 uTileWorld;\nuniform float uPoseAlpha;\n', what);
  return replaceOnce(
    out,
    '  vec2 world = (isShear ? sheared : spun) + aInstXY;\n',
    '  vec2 xy = mix(aInstPrevXY, aInstXY, uPoseAlpha);\n  vec2 world = (isShear ? sheared : spun) + xy;\n',
    what,
  );
}

/**
 * spritePoseGlsl's WGSL twin: instancedSprite.wgsl with `uPoseAlpha` in its tile uniforms and `aInstPrevXY` at
 * location 10.
 * @param {string} wgsl instancedSprite.wgsl
 * @returns {string}
 */
export function spritePoseWgsl(wgsl) {
  const what = 'the pose variant of instancedSprite.wgsl';
  let out = replaceOnce(wgsl, '  uTileWorld: vec4<f32>,\n', '  uTileWorld: vec4<f32>,\n  uPoseAlpha: f32,\n', what);
  out = replaceOnce(
    out,
    '  @location(9) aInstTileOff: vec2<f32>,\n',
    '  @location(9) aInstTileOff: vec2<f32>,\n  @location(10) aInstPrevXY: vec2<f32>,\n',
    what,
  );
  return replaceOnce(
    out,
    '  let world = select(spun, sheared, isShear) + aInstXY;\n',
    '  let xy = mix(aInstPrevXY, aInstXY, uniforms.uPoseAlpha);\n  let world = select(spun, sheared, isShear) + xy;\n',
    what,
  );
}

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
