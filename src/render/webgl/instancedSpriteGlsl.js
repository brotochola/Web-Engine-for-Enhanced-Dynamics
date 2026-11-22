/**
 * Instanced sprite GLSL program factory. Sources are fetched at Pixi init.
 */

/** The sprite fragment: premultiplied alpha (spriteFrag), or additive (spriteFragAdd, the glows). */
export function pickInstancedSpriteFragmentGlsl(premultiplyAlpha, shaders) {
  return premultiplyAlpha ? shaders?.spriteFrag : shaders?.spriteFragAdd;
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
