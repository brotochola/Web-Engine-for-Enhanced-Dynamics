in vec2 aPosition;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vWorld;

void main() {
  vWorld = aPosition;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(aPosition, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
