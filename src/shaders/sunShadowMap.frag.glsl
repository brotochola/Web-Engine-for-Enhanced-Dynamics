#version 300 es
precision highp float;
in vec2 vLocal;
in vec4 vColor;
in vec2 vWorld;
in vec4 vAtlasUV;
in vec2 vTileInv;
in vec2 vTileOff;
in float vSunZ;
uniform sampler2D uTexture;
out vec4 finalColor;

// DX-SHADOW3D: a caster point's height where its sun ray lands (sunShadowMap.js), drawn with max blending. 512.0 is
// SUN_MAP_ZMAX. A card cuts its silhouette by the picture's alpha; a column's cell is opaque (its vertex shader dropped
// the others), so the same test passes along it.
void main() {
  if (texture(uTexture, mix(vAtlasUV.xy, vAtlasUV.zw, vLocal)).a < 0.5) discard;
  finalColor = vec4(clamp(vSunZ / 512.0, 0.0, 1.0), 0.0, 0.0, 1.0);
}
