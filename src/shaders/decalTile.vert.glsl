// E-552: the decal tiles of one chunk of the tiles' array texture, an instance a tile (src/render/pixi/decalTiles.js).
in vec2 aPosition;  // the quad's corner, 0..1
in vec3 aTile;      // the tile's corner (world px) and its layer of the array

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform float uTileSize; // a tile's side, world px

out vec2 vTileUv;
flat out float vLayer;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(aTile.xy + aPosition * uTileSize, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  vTileUv = aPosition;
  vLayer = aTile.z;
}
