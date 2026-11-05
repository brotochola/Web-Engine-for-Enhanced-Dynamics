in vec2 aQuad;
in vec2 aInstXY;
in float aInstRadius;
in vec4 aInstColor;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
// The world's x and y axes on screen, y times config.lighting.groundScaleY: the quad (and its falloff,
// which reads vLocal) covers the light's pool on the floor, an ellipse when the floor is foreshortened.
uniform vec4 uGroundAxes;

out vec2 vLocal;
out vec4 vColor;
out float vInstRadius;

void main() {
  vec2 world = aInstXY + (uGroundAxes.xy * aQuad.x + uGroundAxes.zw * aQuad.y) * aInstRadius;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  vLocal = aQuad;
  vColor = aInstColor;
  vInstRadius = aInstRadius;
}
