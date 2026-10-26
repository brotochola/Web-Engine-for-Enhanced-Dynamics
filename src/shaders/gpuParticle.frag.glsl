#version 300 es
precision highp float;
// GPU particles (gpuParticle.vert.glsl): the atlas frame, tinted, premultiplied, as instancedSprite.frag.glsl.
in vec2 vLocal;
in vec4 vColor;
in vec4 vAtlasUV;
uniform sampler2D uTexture;
out vec4 finalColor;

void main() {
  vec4 t = texture(uTexture, mix(vAtlasUV.xy, vAtlasUV.zw, vLocal));
  finalColor = vec4(t.rgb * vColor.rgb * vColor.a, t.a * vColor.a);
}
