#version 300 es
precision highp float;
in vec2 vLocal;
in vec4 vColor;
in vec2 vWorld;
in vec4 vAtlasUV;
in vec2 vTileInv;
in vec2 vTileOff;
flat in vec2 vFaceOct;
in float vFaceZ;
uniform sampler2D uTexture;
out vec4 finalColor;

vec2 weedUv() {
  vec2 t = vLocal;
  if (vTileInv.x > 0.0) t.x = fract(vWorld.x * vTileInv.x + vTileOff.x);
  else if (vTileInv.x < 0.0) t.x = fract(vLocal.x * (-vTileInv.x) + vTileOff.x);
  if (vTileInv.y > 0.0) t.y = fract(vWorld.y * vTileInv.y + vTileOff.y);
  else if (vTileInv.y < 0.0) t.y = fract(vLocal.y * (-vTileInv.y) + vTileOff.y);
  return mix(vAtlasUV.xy, vAtlasUV.zw, t);
}

// DX-FACES: what this pixel is, in painter order: a face's normal and height, or 0 where a sprite that is no face covers it.
void main() {
  if (texture(uTexture, weedUv()).a * vColor.a < 0.5) discard;
  float q = floor(clamp(vFaceZ * 8.0, 0.0, 65535.0));
  finalColor = vec4(vFaceOct, floor(q / 256.0) / 255.0, mod(q, 256.0) / 255.0);
}
