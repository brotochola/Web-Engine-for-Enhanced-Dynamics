#version 300 es
precision highp float;
in vec2 vLocal;
in vec4 vColor;
in vec2 vWorld;
in vec4 vAtlasUV;
in vec2 vTileInv;
in vec2 vTileOff;
in float vSunZ;
flat in float vSunId;
uniform sampler2D uTexture;
out vec4 finalColor;

// DX-SHADOW3D: a caster point's height where its sun ray lands (sunShadowMap.js), 512.0 being SUN_MAP_ZMAX. The map keeps
// the highest one by a depth test (its depth 1 - height / 512, the nearest wins) rather than max blending, so the texel
// also keeps that caster's entity (DX-GBUF: its G-buffer id in B·256 + A), which the light pass compares with a pixel's
// own: a caster's own shadow never paints its own sprite. A card cuts its silhouette by the picture's alpha; a column's
// cell is opaque (its vertex shader dropped the others), so the same test passes along it.
void main() {
  if (texture(uTexture, mix(vAtlasUV.xy, vAtlasUV.zw, vLocal)).a < 0.5) discard;
  float h = clamp(vSunZ / 512.0, 0.0, 1.0);
  int id = int(vSunId + 0.5);
  finalColor = vec4(h, 0.0, float(id >> 8) / 255.0, float(id & 255) / 255.0);
  gl_FragDepth = 1.0 - h;
}
