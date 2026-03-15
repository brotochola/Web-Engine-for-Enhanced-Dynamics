precision highp float;
in vec2 vWorldPos;
uniform vec2 uLightPos;
uniform float uLightIntensity;
uniform vec3 uLightColor;

void main() {
  vec2 delta = vWorldPos - uLightPos;
  const float DISTANCE_SCALE = 1.0 / 1024.0;
  vec2 deltaScaled = delta * DISTANCE_SCALE;
  float d2Scaled = dot(deltaScaled, deltaScaled);
  float intensityScaled = uLightIntensity * DISTANCE_SCALE * DISTANCE_SCALE;
  float attenuation = intensityScaled / (intensityScaled + d2Scaled);
  gl_FragColor = vec4(uLightColor * attenuation, 1.0);
}
