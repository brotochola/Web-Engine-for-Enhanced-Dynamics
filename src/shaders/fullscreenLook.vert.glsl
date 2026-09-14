// Fullscreen look quad. No V-flip (WebGL RT UV already top-origin).
attribute vec2 aPosition;
attribute vec2 aUV;
varying vec2 vTextureCoord;
void main() {
  vTextureCoord = aUV;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
