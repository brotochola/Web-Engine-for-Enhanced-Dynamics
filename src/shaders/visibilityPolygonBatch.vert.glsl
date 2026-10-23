#version 300 es
// Every light's umbra disc and visibility fan in one draw (E-96): the light's terms are vertex
// attributes, constant over its triangles, where the per-light shader had them as uniforms.
in vec2 aPosition;
in vec4 aLight; // x, y, intensity, radius
in vec4 aColor; // r, g, b, attenuation scale
uniform vec2 uCameraPos;
uniform float uZoom;
uniform vec2 uCanvasSize;
uniform vec2 uCameraRot;
out vec2 vWorldPos;
flat out vec4 vLight;
flat out vec4 vColor;

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
  vLight = aLight;
  vColor = aColor;
  vec2 screenPos = weedWorldToScreen(aPosition);
  vec2 clipPos = (screenPos / uCanvasSize) * 2.0 - 1.0;
  gl_Position = vec4(clipPos, 0.0, 1.0);
}
