precision mediump float;

// DX-LAYERPASSES measurement pass: uSource, what the look's first pass read, whatever the passes before drew.
varying vec2 vTextureCoord;
uniform sampler2D uTexture;
uniform sampler2D uSource;

void main() {
  gl_FragColor = texture2D(uSource, vTextureCoord);
}
