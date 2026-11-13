precision highp float;
in vec2 vWorldPos;
in vec2 vUV;
uniform vec2 uLightPos;
uniform float uLightIntensity;
uniform vec3 uLightColor;
uniform vec2 uBodyCenter;
uniform float uBodyRadius;
uniform float uAttenScale;
// 1 / config.lighting.groundScaleY: distances to the light are measured on the floor.
uniform float uGroundInvScaleY;
// DX-SPOT: the light's cone (its direction on the floor, the cosine of its half aperture, 1 / its soft edge); z -2: none.
uniform vec4 uCone;
uniform sampler2D uTexture;

// As lightingBasic's: 1 inside the cone, 0 outside, smooth across its soft edge; 1 at the light itself.
float coneFactor(vec2 delta, vec4 cone) {
  float len2 = dot(delta, delta);
  float cosA = len2 > 0.0 ? dot(delta, cone.xy) * inversesqrt(len2) : 1.0;
  float t = clamp((cosA - cone.z) * cone.w, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

void main() {
  float a = texture2D(uTexture, vUV).a;
  if (a < 0.01) discard;
  vec2 delta = vWorldPos - uLightPos;
  delta.y *= uGroundInvScaleY;
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
  if (uCone.z > -1.0) rgb *= coneFactor(delta, uCone);
  gl_FragColor = vec4(rgb, a);
}
