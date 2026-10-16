#version 300 es
precision highp float;
precision highp int;
in vec2 vWorld;
out vec4 finalColor;
uniform sampler2D cells;
uniform float uCell;
uniform float uGW;
uniform float uPCX;
uniform float uPCY;
uniform float uPR;

int cellAt(ivec2 p) {
  int gw = int(uGW);
  if (p.x < 0 || p.y < 0 || p.x >= gw || p.y >= gw) return 0;
  int b = int(texelFetch(cells, ivec2(p.x >> 3, p.y), 0).r * 255.0 + 0.5);
  return (b >> (p.x & 7)) & 1;
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 cp = vWorld / uCell;
  float cpp = max(length(dFdx(cp)), 1e-6);
  vec2 q = cp - 0.5;
  ivec2 b0 = ivec2(floor(q));
  vec2 f = q - vec2(b0);
  int a = cellAt(b0);
  int b = cellAt(b0 + ivec2(1, 0));
  int c = cellAt(b0 + ivec2(0, 1));
  int d = cellAt(b0 + ivec2(1, 1));
  int n = a + b + c + d;
  float s;
  float K = 0.70710678;
  if (n == 0) s = -1.0;
  else if (n == 4) s = 1.0;
  else if (n == 1) {
    float t = a == 1 ? f.x + f.y : b == 1 ? (1.0 - f.x) + f.y : c == 1 ? f.x + (1.0 - f.y) : (1.0 - f.x) + (1.0 - f.y);
    s = (0.5 - t) * K;
  } else if (n == 3) {
    float t = a == 0 ? f.x + f.y : b == 0 ? (1.0 - f.x) + f.y : c == 0 ? f.x + (1.0 - f.y) : (1.0 - f.x) + (1.0 - f.y);
    s = (t - 0.5) * K;
  } else if (a == b) {
    s = a == 1 ? 0.5 - f.y : f.y - 0.5;
  } else if (a == c) {
    s = a == 1 ? 0.5 - f.x : f.x - 0.5;
  } else {
    float t1 = a == 1 ? (1.0 - f.x) + f.y : f.x + f.y;
    float t2 = a == 1 ? f.x + (1.0 - f.y) : (1.0 - f.x) + (1.0 - f.y);
    s = min(t1 - 0.5, t2 - 0.5) * K;
  }
  float ep = s / cpp;
  float alpha = clamp(ep + 0.5, 0.0, 1.0);
  if (alpha <= 0.0) discard;
  vec2 id = floor(cp);
  float nz = hash(id);
  vec2 pc = vec2(uPCX, uPCY);
  float depth = uPR - length(id + 0.5 - pc) + (nz - 0.5) * 3.0;
  vec3 col = depth < 5.0 ? vec3(0.42, 0.62, 0.28) : (depth < 26.0 ? vec3(0.48, 0.34, 0.21) : vec3(0.40, 0.42, 0.47));
  col *= 0.9 + 0.1 * nz;
  col *= mix(0.68, 1.0, smoothstep(0.0, 2.5, ep));
  finalColor = vec4(col * alpha, alpha);
}
