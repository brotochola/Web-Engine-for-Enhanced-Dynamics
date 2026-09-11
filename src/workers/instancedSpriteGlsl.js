/**
 * Instanced sprite GLSL program factory. Sources are fetched at Pixi init.
 */

export function pickInstancedSpriteFragmentGlsl(premultiplyAlpha, alphaDiscard, shaders) {
  if (!premultiplyAlpha) return shaders?.spriteFragAdd;
  return alphaDiscard !== false ? shaders?.spriteFrag : shaders?.spriteFragBlend;
}

export function instancedSpriteGlProgram(GlProgram, vertex, fragment, name) {
  if (!vertex || !fragment) {
    throw new Error(
      'WeedJS: Instanced sprite GLSL was not loaded before GlProgram creation.'
    );
  }
  return GlProgram.from({
    vertex,
    fragment,
    name,
  });
}
