#version 300 es
precision highp float;
in vec2 vWorld;
out vec4 finalColor;
uniform sampler2D cells;

void main() {
  float v = texelFetch(cells, ivec2(int(vWorld.x), int(vWorld.y)), 0).r;
  finalColor = vec4(v, v, v, 1.0);
}
