in vec2 aPosition;
in vec3 aCenterRadius;
uniform vec2 uCameraPos;
uniform float uZoom;
uniform vec2 uCanvasSize;
uniform vec2 uCameraRot;
out vec2 vWorldPos;
out vec2 vCenter;
out float vRadius;

vec2 weedWorldToScreen(vec2 world) {
  vec2 focus = uCameraPos + uCanvasSize / (2.0 * uZoom);
  vec2 d = world - focus;
  return uCanvasSize * 0.5 + vec2(
    uCameraRot.x * d.x - uCameraRot.y * d.y,
    uCameraRot.x * d.y + uCameraRot.y * d.x
  ) * uZoom;
}

void main() {
  vWorldPos = aPosition;
  vCenter = aCenterRadius.xy;
  vRadius = aCenterRadius.z;
  vec2 screenPos = weedWorldToScreen(aPosition);
  vec2 clipPos = (screenPos / uCanvasSize) * 2.0 - 1.0;
  gl_Position = vec4(clipPos, 0.0, 1.0);
}
