#version 300 es
precision highp float;
in vec2 vWorldPos;
flat in vec4 vLight; // x, y, intensity, radius
flat in vec4 vColor; // r, g, b, attenuation scale
out vec4 finalColor;

// visibilityPolygon.frag.glsl with the light's terms from the vertex (E-96).
void main() {
  vec2 delta = vWorldPos - vLight.xy;
  float dist = length(delta);
  // Soft clip oversized free-arc fan verts (FREE_OVERSIZE). Hard discard made
  // the rim look like an opaque black polygon edge.
  float radial = 1.0 - smoothstep(vLight.w * 0.96, vLight.w, dist);
  if (radial <= 0.0) discard;

  const float DISTANCE_SCALE = 1.0 / 1024.0;
  vec2 deltaScaled = delta * DISTANCE_SCALE;
  float d2Scaled = dot(deltaScaled, deltaScaled);
  float intensityScaled = vLight.z * DISTANCE_SCALE * DISTANCE_SCALE;
  float attenuation = intensityScaled / (intensityScaled + d2Scaled);
  attenuation *= radial * vColor.w;
  finalColor = vec4(vColor.rgb * attenuation, 1.0);
}
