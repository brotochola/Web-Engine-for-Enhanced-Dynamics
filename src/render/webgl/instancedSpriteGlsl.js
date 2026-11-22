/** The sprite fragment: premultiplied alpha (spriteFrag), or additive (spriteFragAdd, the glows). */
export function pickInstancedSpriteFragmentGlsl(premultiplyAlpha, shaders) {
  return premultiplyAlpha ? shaders?.spriteFrag : shaders?.spriteFragAdd;
}
