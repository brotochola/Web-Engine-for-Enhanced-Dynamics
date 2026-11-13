#version 300 es
precision highp float;
in vec2 vWorldPos;
in vec2 vCenter;
in float vRadius;
flat in vec4 vLight; // x, y, intensity, radius
flat in vec4 vColor; // r, g, b, attenuation scale
// #if CONE
flat in vec4 vCone; // DX-SPOT: the cone's direction on the floor, the cosine of its half aperture, 1 / its soft edge
// #endif CONE
out vec4 finalColor;
// 1 / config.lighting.groundScaleY: distances to the light are measured on the floor.
uniform float uGroundInvScaleY;

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

// #if CONE
// DX-SPOT, as lightingBasic's: how far inside its cone a point at floor offset delta from the light is: 1 inside, 0
// outside, smooth across the soft edge; 1 at the light itself.
float coneFactor(vec2 delta, vec4 cone) {
  float len2 = dot(delta, delta);
  float cosA = len2 > 0.0 ? dot(delta, cone.xy) * inversesqrt(len2) : 1.0;
  float t = clamp((cosA - cone.z) * cone.w, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// #endif CONE
void main() {
  vec2 delta = vWorldPos - vLight.xy;
  delta.y *= uGroundInvScaleY;
  float dist = length(delta);
  float radial = 1.0 - smoothstep(vLight.w * 0.96, vLight.w, dist);
  if (radial <= 0.0) discard;

  const float DISTANCE_SCALE = 1.0 / 1024.0;
  vec2 deltaScaled = delta * DISTANCE_SCALE;
  float d2Scaled = dot(deltaScaled, deltaScaled);
  float intensityScaled = vLight.z * DISTANCE_SCALE * DISTANCE_SCALE;
  float attenuation = intensityScaled / (intensityScaled + d2Scaled);
  attenuation *= radial * vColor.w * facingMask(vWorldPos, vCenter, vRadius);
  // #if CONE
  attenuation *= coneFactor(delta, vCone);
  // #endif CONE
  finalColor = vec4(vColor.rgb * attenuation, 1.0);
}
