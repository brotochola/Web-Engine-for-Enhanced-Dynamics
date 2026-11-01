#version 300 es
precision highp float;
// GPU particles drawn with an additive blend: color only, no alpha, as instancedSpriteAdditive.frag.glsl.
in vec2 vLocal;
in vec4 vColor;
in vec4 vAtlasUV;
uniform sampler2D uTexture;
out vec4 finalColor;

void main() {
  vec4 t = texture(uTexture, mix(vAtlasUV.xy, vAtlasUV.zw, vLocal));
  finalColor = vec4(t.rgb * vColor.rgb * vColor.a, 0.0);
}
