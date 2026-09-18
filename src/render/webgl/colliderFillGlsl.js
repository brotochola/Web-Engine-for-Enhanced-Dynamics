export function colliderFillGlProgram(GlProgram, vertex, fragment, name) {
  if (!vertex || !fragment) {
    throw new Error(
      'WeedJS: Collider fill GLSL was not loaded before GlProgram creation.'
    );
  }
  return GlProgram.from({
    vertex,
    fragment,
    name,
  });
}
