#version 300 es
precision highp float;
in vec2 vLocal;
in vec4 vColor;
in vec2 vWorld;
in vec4 vAtlasUV;
in vec2 vTileInv;
in vec2 vTileOff;
uniform sampler2D uTexture;
out vec4 finalColor;

// #include weedUv.glsl

void main() {
  vec4 t = texture(uTexture, weedUv());
  float a = t.a * vColor.a;
  finalColor = vec4(t.rgb * vColor.rgb * vColor.a, a);
}
