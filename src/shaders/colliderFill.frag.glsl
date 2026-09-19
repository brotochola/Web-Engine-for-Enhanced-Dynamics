#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vLocal;
in vec2 vWorld;
in vec4 vAtlasUV;
in vec2 vTileInv;
in vec2 vTileOff;
in float vHasTex;
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

void main() {
  if (vHasTex < 0.5) {
    if (vColor.a < 0.01) discard;
    finalColor = vec4(vColor.rgb * vColor.a, vColor.a);
    return;
  }
  vec4 t = texture(uTexture, weedUv());
  float a = t.a * vColor.a;
  if (a < 0.01) discard;
  finalColor = vec4(t.rgb * vColor.rgb * vColor.a, a);
}
