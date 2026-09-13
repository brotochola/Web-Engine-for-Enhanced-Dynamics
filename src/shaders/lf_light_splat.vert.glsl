in vec2 aQuad;
in vec2 aInstXY;
in float aInstRadius;
in vec4 aInstColor;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out vec2 vLocal;
out vec4 vColor;
out float vInstRadius;

void main() {
  vec2 world = aInstXY + aQuad * aInstRadius;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  vLocal = aQuad;
  vColor = aInstColor;
  vInstRadius = aInstRadius;
}
