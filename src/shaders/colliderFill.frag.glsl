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

// #include weedUv.glsl

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
