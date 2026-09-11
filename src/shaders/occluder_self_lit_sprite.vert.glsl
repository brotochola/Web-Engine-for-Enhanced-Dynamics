in vec2 aPosition;
in vec2 aUV;
uniform vec2 uCameraPos;
uniform float uZoom;
uniform vec2 uCanvasSize;
out vec2 vWorldPos;
out vec2 vUV;

void main() {
  vWorldPos = aPosition;
  vUV = aUV;
  vec2 screenPos = (aPosition - uCameraPos) * uZoom;
  vec2 clipPos = (screenPos / uCanvasSize) * 2.0 - 1.0;
  gl_Position = vec4(clipPos, 0.0, 1.0);
}
