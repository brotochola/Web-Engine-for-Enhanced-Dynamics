#version 300 es
precision highp float;
in vec2 vWorldPos;
in vec2 vCenter;
in float vRadius;
flat in vec4 vLight; // x, y, intensity, radius
flat in vec4 vColor; // r, g, b, attenuation scale
out vec4 finalColor;

// The self-lit collider fill with the light's terms from the vertex (E-96b). A wedge vertex carries a
// radius past any light's distance, so its facing term is 1 and it is the visibility fan's fragment.
float facingMask(vec2 world, vec2 center, float bodyR) {
  vec2 toLight = vLight.xy - center;
  float distL = length(toLight);
  if (distL <= bodyR || distL <= 0.0001) return 1.0;
  vec2 nL = toLight / distL;
  vec2 toPix = world - center;
  float pixLen = length(toPix);
  vec2 nP = pixLen > 0.0001 ? toPix / pixLen : nL;
  float facing = dot(nP, nL);
  return smoothstep(-0.15, 0.45, facing);
}

void main() {
  vec2 delta = vWorldPos - vLight.xy;
  float dist = length(delta);
  float radial = 1.0 - smoothstep(vLight.w * 0.96, vLight.w, dist);
  if (radial <= 0.0) discard;

  const float DISTANCE_SCALE = 1.0 / 1024.0;
  vec2 deltaScaled = delta * DISTANCE_SCALE;
  float d2Scaled = dot(deltaScaled, deltaScaled);
  float intensityScaled = vLight.z * DISTANCE_SCALE * DISTANCE_SCALE;
  float attenuation = intensityScaled / (intensityScaled + d2Scaled);
  attenuation *= radial * vColor.w * facingMask(vWorldPos, vCenter, vRadius);
  finalColor = vec4(vColor.rgb * attenuation, 1.0);
}
