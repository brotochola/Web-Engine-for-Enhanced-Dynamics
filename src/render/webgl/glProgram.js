/**
 * An engine GlProgram from GLSL fetched at Pixi init (the sprite, collider-fill, mesh-UV-fill and map programs).
 * Throws, naming the program, when a source did not arrive.
 */
export function glProgramFrom(GlProgram, vertex, fragment, name) {
  if (!vertex || !fragment) throw new Error(`WeedJS: the GLSL of ${name} was not loaded before its GlProgram was made.`);
  return GlProgram.from({ vertex, fragment, name });
}
