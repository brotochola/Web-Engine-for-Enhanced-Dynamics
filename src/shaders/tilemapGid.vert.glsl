in vec2 aPosition;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec2 uTileSize;
uniform vec2 uPageOrigin;
uniform vec2 uPageSize;
out vec2 vPageUv;

void main() {
  vec2 tileSize = uTileSize;
  vec2 pageSize = uPageSize;
  if (tileSize.x > 0.0 && tileSize.y > 0.0 && pageSize.x > 0.0 && pageSize.y > 0.0) {
    vPageUv = (aPosition / tileSize - uPageOrigin) / pageSize;
  } else {
    vPageUv = vec2(0.0);
  }
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(aPosition, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
