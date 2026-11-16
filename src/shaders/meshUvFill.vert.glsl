#version 300 es
// E-453: each mesh's vertices once, drawn through an index buffer (MeshUvFillBatch): a vertex record (MESH_UV_VERT,
// colliderFillBatch.js) as 4 vec4. E-419 read a triangle's row as 6 vec4 and placed its corner from the vertex index
// (1.86 -> 0.82 ms a draw for volumeStressScene's 486 408 rows, meshFillGpuBench, GTX 1650); a house's vertex sat in 3 to
// 6 of its rows, read and placed again in each. main() names the fields as the rows did.
in vec4 aVert0; // x, y, u, v
in vec4 aVert1; // the pose: xy, rotation cos sin
in vec4 aVert2; // tint bits, the entity's reach, texture id, body
in vec4 aVert3; // tile inverse, tile offset

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uColor; // the mesh's group color, premultiplied: its alpha is the layer's
uniform sampler2D uTexLut;
uniform sampler2D uPoseTable;
// DX-SUNMESH: xy, L · (shadowDirX, shadowDirY) on a sunProjected layer, whose U holds each vertex's height; 0 on any other.
// DX-VOLUME: z, 1 on the volumes' layer.
uniform vec4 uSunShadow;

out vec4 vColor;
out vec2 vLocal;
out vec2 vWorld;
out vec4 vAtlasUV;
out vec2 vTileInv;
out vec2 vTileOff;
out float vHasTex;
out vec2 vMeshUV;

void main() {
  vec2 local = aVert0.xy;
  vec2 aUV = aVert0.zw;
  vec2 aInstXY = aVert1.xy;
  vec2 aInstRotCS = aVert1.zw;
  float aInstTintBits = aVert2.x;
  // The lamps' map's cull reads it (volumeShadowMap.js): how far from the anchor the entity's farthest vertex stands.
  float aInstReach = aVert2.y;
  float aInstTexId = aVert2.z;
  float aInstBody = aVert2.w;
  vec2 aInstTileInv = aVert3.xy;
  vec2 aInstTileOff = aVert3.zw;
  vec2 xy = aInstXY;
  vec2 cs = aInstRotCS;
  int id = int(aInstBody + 0.5);
  vec4 pose = texelFetch(uPoseTable, ivec2(id % 256, id / 256), 0);
  if (pose.z != 0.0 || pose.w != 0.0) {
    xy = pose.xy;
    cs = pose.zw;
  }
  float c = cs.x;
  float s = cs.y;
  vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  float f = aInstTileOff.x;
  if (uSunShadow.z > 0.0 && f > 0.0 && f != 1.0) {
    // A volume's floor is drawn f as tall as it is wide. Its entity's rotation is what the screen shows, so on the floor it
    // looks along (f·c, s), and its long side stays on its path once the floor is flattened. A town is a million of these
    // vertices that do not turn, and the normalize shows: 6 % of the frames drawn at 20 000 houses.
    if (s == 0.0) {
      rotated.y *= f;
    } else {
      vec2 heading = normalize(vec2(f * c, s));
      rotated = vec2(local.x * heading.x - local.y * heading.y, f * (local.x * heading.y + local.y * heading.x));
    }
  }
  // DX-SUNMESH: a sunProjected layer's U is the vertex's height.
  float height = aUV.x;
  vec2 world = rotated + xy + height * uSunShadow.xy;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(world, 1.0);
  // No depth: the layer's draw neither tests nor writes it (N-119).
  gl_Position = vec4(clip.xy, 0.5, 1.0);

  uint tintBits = floatBitsToUint(aInstTintBits);
  vec3 rgb = vec3(
    float((tintBits >> 16u) & 255u),
    float((tintBits >> 8u) & 255u),
    float(tintBits & 255u)
  ) / 255.0;
  float instA = float((tintBits >> 24u) & 255u) / 255.0;
  // A volume's shadow is black whatever its entity's tint: GameObject.tint reaches the mesh too.
  if (uSunShadow.z > 0.0) rgb = vec3(0.0);
  vColor = vec4(rgb, instA * uColor.a);

  int tid = int(aInstTexId + 0.5);
  ivec2 lutSize = textureSize(uTexLut, 0);
  // N-111: lutPerRow textureIds a row, so no side of the LUT passes MAX_TEXTURE_SIZE (instancedSpriteBatch.js).
  int lutPerRow = lutSize.x / 3;
  vec2 orig = vec2(0.0);
  vec4 atlasUV = vec4(0.0);
  if (aInstTexId >= 0.0 && tid >= 0 && tid < lutPerRow * lutSize.y) {
    ivec2 lutAt = ivec2(3 * (tid % lutPerRow), tid / lutPerRow);
    vec4 t0 = texelFetch(uTexLut, lutAt, 0);
    vec4 t1 = texelFetch(uTexLut, lutAt + ivec2(1, 0), 0);
    orig = t0.xy;
    atlasUV = vec4(t0.zw, t1.xy);
    vHasTex = 1.0;
  } else {
    vHasTex = 0.0;
  }

  vLocal = local;
  vWorld = world;
  vAtlasUV = atlasUV;
  vTileOff = aInstTileOff;
  vMeshUV = aUV;
  if (vHasTex > 0.5 && aInstTileInv.x == 0.0 && orig.x > 0.0) {
    vTileInv = 1.0 / orig;
  } else {
    vTileInv = aInstTileInv;
  }
}
