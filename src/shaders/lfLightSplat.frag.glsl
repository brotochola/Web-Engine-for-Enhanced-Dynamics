precision highp float;
in vec2 vLocal;
in vec4 vColor;
in float vInstRadius;

uniform float uInvScreenScale;

void main() {
  if (uInvScreenScale <= 0.0) discard;
  float worldRadius = vInstRadius * uInvScreenScale;
  if (worldRadius <= 0.0) discard;
  float intensity = (worldRadius * 0.1) * (worldRadius * 0.1);
  float d = length(vLocal) * worldRadius;
  float att = intensity / (intensity + d * d);
  float a = att * vColor.a;
  if (a < 0.001) discard;
  gl_FragColor = vec4(vColor.rgb * a, a);
}
