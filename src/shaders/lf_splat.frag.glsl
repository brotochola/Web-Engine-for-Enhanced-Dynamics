precision highp float;
in vec2 vLocal;
in vec4 vColor;

void main() {
  float d2 = dot(vLocal, vLocal);
  float a = max(0.0, 1.0 - d2) * vColor.a;
  if (a < 0.001) discard;
  gl_FragColor = vec4(vColor.rgb * a, a);
}
