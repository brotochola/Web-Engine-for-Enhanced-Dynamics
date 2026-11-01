// crispPixels.frag – look shader for the explosionPieces layer.
//
// The layer draws sparks, embers and debris into a texture with one texel per
// world pixel. Sprite edges come out soft; this makes every texel fully on or
// fully off, so the pieces are hard pixels on the same grid as the field.
precision mediump float;

varying vec2 vTextureCoord;
uniform sampler2D uTexture;

void main() {
  vec4 color = texture2D(uTexture, vTextureCoord);
  if (color.a < 0.5) {
    gl_FragColor = vec4(0.0);
    return;
  }
  gl_FragColor = vec4(color.rgb / color.a, 1.0); // un-premultiply, then draw opaque
}
