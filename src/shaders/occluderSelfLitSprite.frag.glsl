precision highp float;
in vec2 vWorldPos;
in vec2 vUV;
uniform vec2 uLightPos;
uniform float uLightIntensity;
uniform vec3 uLightColor;
uniform vec2 uBodyCenter;
uniform float uBodyRadius;
uniform float uAttenScale;
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
  vec2 toLight = uLightPos - uBodyCenter;
  float distL = length(toLight);
  float mask = 1.0;
  if (distL > uBodyRadius && distL > 0.0001) {
    vec2 nL = toLight / distL;
    vec2 toPix = vWorldPos - uBodyCenter;
    float pixLen = length(toPix);
    vec2 nP = pixLen > 0.0001 ? toPix / pixLen : nL;
    mask = smoothstep(-0.15, 0.45, dot(nP, nL));
  }
  vec3 rgb = uLightColor * attenuation * uAttenScale * mask * a;
  gl_FragColor = vec4(rgb, a);
}
