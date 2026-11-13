#version 300 es
// Every light's self-lit fills of occluders masked by their sprite in one draw per texture source (E-260): the light's
// and the body's terms are vertex attributes, constant over a quad, where the pass per light had them as uniforms.
in vec2 aPosition;
in vec2 aUV;
in vec4 aLight; // the light's x, y, intensity; the body's radius
in vec4 aColor; // the light's r, g, b; the attenuation scale
in vec2 aBody; // the body's centre, for the facing term
in vec4 aCone; // DX-SPOT: the cone's direction on the floor (x, y), the cosine of its half aperture, 1 / its soft edge; z -2: none
uniform vec2 uCameraPos;
uniform float uZoom;
uniform vec2 uCanvasSize;
uniform vec2 uCameraRot;
out vec2 vWorldPos;
out vec2 vUV;
flat out vec4 vLight;
flat out vec4 vColor;
flat out vec2 vBody;
flat out vec4 vCone;

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
  vUV = aUV;
  vLight = aLight;
  vColor = aColor;
  vBody = aBody;
  vCone = aCone;
  vec2 screenPos = weedWorldToScreen(aPosition);
  vec2 clipPos = (screenPos / uCanvasSize) * 2.0 - 1.0;
  gl_Position = vec4(clipPos, 0.0, 1.0);
}
