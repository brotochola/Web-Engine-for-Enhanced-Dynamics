precision highp float;
in vec2 vWorldPos;
uniform vec2 uLightPos;
uniform float uLightIntensity;
uniform float uLightRadius;
uniform vec3 uLightColor;

void main() {
  vec2 delta = vWorldPos - uLightPos;
  float dist = length(delta);
  // Soft clip oversized free-arc fan verts (FREE_OVERSIZE). Hard discard made
  // the rim look like an opaque black polygon edge.
  float radial = 1.0 - smoothstep(uLightRadius * 0.96, uLightRadius, dist);
  if (radial <= 0.0) discard;

  const float DISTANCE_SCALE = 1.0 / 1024.0;
  vec2 deltaScaled = delta * DISTANCE_SCALE;
  float d2Scaled = dot(deltaScaled, deltaScaled);
  float intensityScaled = uLightIntensity * DISTANCE_SCALE * DISTANCE_SCALE;
  float attenuation = intensityScaled / (intensityScaled + d2Scaled);
  attenuation *= radial;
  gl_FragColor = vec4(uLightColor * attenuation, 1.0);
}
