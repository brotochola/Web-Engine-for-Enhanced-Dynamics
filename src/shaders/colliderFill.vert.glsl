#version 300 es
// E-452: the row (FILL_ROW, colliderFillBatch.js) as 4 vec4 and a vec2 in its order, not one attribute a field, and the
// corner from gl_VertexID, not an attribute, as E-419 made meshUvFill.vert.glsl: the vertex stage's cost was its attribute
// count. main() names the fields as they were.
in vec4 aRow0; // v0, v1
in vec4 aRow1; // v2, xy
in vec4 aRow2; // rotation cos sin, tint bits, depth
in vec4 aRow3; // texture id, tile inverse, tile offset x
in vec2 aRow4; // tile offset y, body

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uColor; // the mesh's group color, premultiplied: its alpha is the layer's
uniform sampler2D uTexLut;
uniform sampler2D uPoseTable;

out vec4 vColor;
out vec2 vLocal;
out vec2 vWorld;
out vec4 vAtlasUV;
out vec2 vTileInv;
out vec2 vTileOff;
out float vHasTex;

void main() {
  // The corner: 0, 1, 2 in each instance of 3 vertices.
  vec2 aTri = vec2(gl_VertexID == 1 ? 1.0 : 0.0, gl_VertexID == 2 ? 1.0 : 0.0);
  vec2 aV0 = aRow0.xy;
  vec2 aV1 = aRow0.zw;
  vec2 aV2 = aRow1.xy;
  vec2 aInstXY = aRow1.zw;
  vec2 aInstRotCS = aRow2.xy;
  float aInstTintBits = aRow2.z;
  float aInstDepth = aRow2.w;
  float aInstTexId = aRow3.x;
  vec2 aInstTileInv = aRow3.yz;
  vec2 aInstTileOff = vec2(aRow3.w, aRow4.x);
  float aInstBody = aRow4.y;
  vec2 local = aV0 + aTri.x * (aV1 - aV0) + aTri.y * (aV2 - aV0);
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
  vec2 world = rotated + xy;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, aInstDepth, 1.0);

  uint tintBits = floatBitsToUint(aInstTintBits);
  vec3 rgb = vec3(
    float((tintBits >> 16u) & 255u),
    float((tintBits >> 8u) & 255u),
    float(tintBits & 255u)
  ) / 255.0;
  float instA = float((tintBits >> 24u) & 255u) / 255.0;
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
  if (vHasTex > 0.5 && aInstTileInv.x == 0.0 && orig.x > 0.0) {
    vTileInv = 1.0 / orig;
  } else {
    vTileInv = aInstTileInv;
  }
}
