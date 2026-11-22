import { gbufWordFromStaticsGlsl } from '../spriteIndexed.js';

/**
 * An engine GlProgram from GLSL fetched at Pixi init (the sprite, collider-fill, mesh-UV-fill and map programs).
 * Throws, naming the program, when a source did not arrive.
 */
export function glProgramFrom(GlProgram, vertex, fragment, name) {
  if (!vertex || !fragment) throw new Error(`WeedJS: the GLSL of ${name} was not loaded before its GlProgram was made.`);
  // E-455 step 3: an indexed program that reads the G-buffer words takes a statics frame's word from its statics row.
  return GlProgram.from({ vertex: gbufWordFromStaticsGlsl(vertex), fragment, name });
}
