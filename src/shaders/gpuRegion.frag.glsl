#version 300 es
precision highp float;
// The look target is premultiplied, as the layer's full-screen composite draws it; uColor.a is the mesh's group
// alpha (the layer's alpha times the entities').
in vec2 vUV;
uniform sampler2D uTexture;
uniform vec4 uColor;
out vec4 finalColor;

void main() {
  finalColor = texture(uTexture, vUV) * uColor.a;
}
