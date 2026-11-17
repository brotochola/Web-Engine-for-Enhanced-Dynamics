#version 300 es
// dxCaptureScene's ?worldFloor=1: a procedural floor under everything (a worldRect layer), for E-504's captures: a
// checker of 16 px cells with two slow gradients, so a shift or a resample of the cached picture shows.
precision highp float;
in vec2 vWorld;
out vec4 finalColor;
uniform sampler2D cells;

void main() {
  vec2 cell = floor(vWorld / 16.0);
  float k = mod(cell.x + cell.y, 2.0);
  float t = texelFetch(cells, ivec2(0, 0), 0).r;
  vec2 f = fract(vWorld / 97.0);
  finalColor = vec4(0.25 + 0.5 * k * f.x, 0.3 + 0.4 * f.y, 0.35 + 0.3 * t, 1.0);
}
