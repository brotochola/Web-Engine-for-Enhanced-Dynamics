#version 300 es
precision highp float;
in vec2 vWorldPos;
in vec2 vUV;
flat in vec4 vLight; // the light's x, y, intensity; the body's radius
flat in vec4 vColor; // the light's r, g, b; the attenuation scale
flat in vec2 vBody; // the body's centre
flat in vec4 vCone; // DX-SPOT: the light's cone; z -2: none
out vec4 finalColor;
// 1 / config.lighting.groundScaleY: distances to the light are measured on the floor.
uniform float uGroundInvScaleY;
uniform sampler2D uTexture;

// As lightingBasic's: 1 inside the cone, 0 outside, smooth across its soft edge; 1 at the light itself.
float coneFactor(vec2 delta, vec4 cone) {
  float len2 = dot(delta, delta);
  float cosA = len2 > 0.0 ? dot(delta, cone.xy) * inversesqrt(len2) : 1.0;
  float t = clamp((cosA - cone.z) * cone.w, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// The self-lit fill under a sprite-masked occluder (E-260: the light's terms from the vertex, the same arithmetic as the
// pass per light with uniforms).
void main() {
  float a = texture(uTexture, vUV).a;
  if (a < 0.01) discard;
  vec2 delta = vWorldPos - vLight.xy;
  delta.y *= uGroundInvScaleY;
  const float DISTANCE_SCALE = 1.0 / 1024.0;
  vec2 deltaScaled = delta * DISTANCE_SCALE;
  float d2Scaled = dot(deltaScaled, deltaScaled);
  float intensityScaled = vLight.z * DISTANCE_SCALE * DISTANCE_SCALE;
  float attenuation = intensityScaled / (intensityScaled + d2Scaled);
  vec2 toLight = vLight.xy - vBody;
  float distL = length(toLight);
  float mask = 1.0;
  if (distL > vLight.w && distL > 0.0001) {
    vec2 nL = toLight / distL;
    vec2 toPix = vWorldPos - vBody;
    float pixLen = length(toPix);
    vec2 nP = pixLen > 0.0001 ? toPix / pixLen : nL;
    mask = smoothstep(-0.15, 0.45, dot(nP, nL));
  }
  vec3 rgb = vColor.rgb * attenuation * vColor.w * mask * a;
  if (vCone.z > -1.0) rgb *= coneFactor(delta, vCone);
  finalColor = vec4(rgb, a);
}
