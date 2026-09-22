precision highp float;
in vec2 vWorldPos;
in vec2 vCenter;
in float vRadius;
uniform vec2 uLightPos;
uniform float uLightIntensity;
uniform float uLightRadius;
uniform vec3 uLightColor;
uniform float uAttenScale;

float facingMask(vec2 world, vec2 center, float bodyR) {
  vec2 toLight = uLightPos - center;
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
  vec2 delta = vWorldPos - uLightPos;
  float dist = length(delta);
  float radial = 1.0 - smoothstep(uLightRadius * 0.96, uLightRadius, dist);
  if (radial <= 0.0) discard;

  const float DISTANCE_SCALE = 1.0 / 1024.0;
  vec2 deltaScaled = delta * DISTANCE_SCALE;
  float d2Scaled = dot(deltaScaled, deltaScaled);
  float intensityScaled = uLightIntensity * DISTANCE_SCALE * DISTANCE_SCALE;
  float attenuation = intensityScaled / (intensityScaled + d2Scaled);
  attenuation *= radial * uAttenScale * facingMask(vWorldPos, vCenter, vRadius);
  gl_FragColor = vec4(uLightColor * attenuation, 1.0);
}
