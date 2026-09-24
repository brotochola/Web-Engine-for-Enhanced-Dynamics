#version 300 es
in vec2 aTri;
in vec2 aV0;
in vec2 aV1;
in vec2 aV2;
in vec2 aInstXY;
in vec2 aInstRotCS;
in float aInstTintBits;
in float aInstDepth;
in float aInstTexId;
in vec2 aInstTileInv;
in vec2 aInstTileOff;
in float aInstBody;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
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
  vColor = vec4(rgb, instA);

  int tid = int(aInstTexId + 0.5);
  ivec2 lutSize = textureSize(uTexLut, 0);
  vec2 orig = vec2(0.0);
  vec4 atlasUV = vec4(0.0);
  if (aInstTexId >= 0.0 && tid >= 0 && tid < lutSize.y) {
    vec4 t0 = texelFetch(uTexLut, ivec2(0, tid), 0);
    vec4 t1 = texelFetch(uTexLut, ivec2(1, tid), 0);
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
