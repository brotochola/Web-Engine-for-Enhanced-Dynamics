precision highp float;
in vec2 vWorldPos;
in vec2 vUV;
uniform vec2 uLightPos;
uniform float uLightIntensity;
uniform vec3 uLightColor;
uniform sampler2D uTexture;

void main() {
  float a = texture2D(uTexture, vUV).a;
  if (a < 0.01) discard;
  vec2 delta = vWorldPos - uLightPos;
  const float DISTANCE_SCALE = 1.0 / 1024.0;
  vec2 deltaScaled = delta * DISTANCE_SCALE;
  float d2Scaled = dot(deltaScaled, deltaScaled);
  float intensityScaled = uLightIntensity * DISTANCE_SCALE * DISTANCE_SCALE;
  float attenuation = intensityScaled / (intensityScaled + d2Scaled);
  vec3 rgb = uLightColor * attenuation * a;
  gl_FragColor = vec4(rgb, a);
}
