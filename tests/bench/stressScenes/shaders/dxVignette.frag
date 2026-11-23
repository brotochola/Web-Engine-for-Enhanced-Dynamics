precision mediump float;

// DX-POSTFUSE measurement pass: the corners darker and the colour warmer, by uAmount: a whole look.
varying vec2 vTextureCoord;
uniform sampler2D uTexture;
uniform float uAmount;
uniform vec2 uCanvasSize;

const vec3 WARM = vec3(1.1, 1.0, 0.85);

vec4 tint(vec4 color, vec2 uv) {
  vec2 d = uv - 0.5;
  d.x *= uCanvasSize.x / max(uCanvasSize.y, 1.0);
  float v = 1.0 - uAmount * smoothstep(0.2, 0.9, length(d));
  return vec4(mix(color.rgb, color.rgb * WARM, uAmount) * v, color.a);
}

void main() {
  gl_FragColor = tint(texture2D(uTexture, vTextureCoord), vTextureCoord);
}
