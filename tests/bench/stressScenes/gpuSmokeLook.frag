precision mediump float;

// gpuParticlesStressScene `?look=1`: the smoke layer's look pass. Its density target holds GPU particles
// (premultiplied gray puffs, added); this bands them into three grays with a dark edge.
varying vec2 vTextureCoord;
uniform sampler2D uTexture;

void main() {
  vec4 d = texture2D(uTexture, vTextureCoord);
  float k = d.a;
  if (k < 0.18) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec3 c = k < 0.3 ? vec3(0.16) : k < 0.6 ? vec3(0.42) : vec3(0.66);
  float a = k < 0.3 ? 0.85 : 0.95;
  gl_FragColor = vec4(c * a, a);
}
