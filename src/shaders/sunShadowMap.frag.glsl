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
// DX-MAPS: the atlas's twin page; where a caster has a height map, its own height is the depth.
uniform sampler2D uMaps;
out vec4 finalColor;

// DX-SHADOW3D: a caster point's height where its sun ray lands (sunShadowMap.js), drawn with max blending. 512.0 is
// SUN_MAP_ZMAX. A card's rows give the height; a height map's texel, when there is one, gives it instead (a crate's lid
// is lower than the card's top row: the card alone shades the lid).
void main() {
  vec2 uv = mix(vAtlasUV.xy, vAtlasUV.zw, vLocal);
  if (texture(uTexture, uv).a < 0.5) discard;
  float z = vSunZ;
  vec4 m = texelFetch(uMaps, ivec2(uv * vec2(textureSize(uMaps, 0))), 0);
  if (m.b + m.a > 0.0) z = (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0;
  finalColor = vec4(clamp(z / 512.0, 0.0, 1.0), 0.0, 0.0, 1.0);
}
