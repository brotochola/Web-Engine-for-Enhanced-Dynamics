in vec2 aQuad;
in vec2 aInstXY;
in vec2 aInstScale;
in vec2 aInstAnchor;
in vec2 aInstRotCS;
in float aInstDepth;
in float aInstTintBits;
in float aInstTexId;
in vec2 aInstTileInv;
in vec2 aInstTileOff;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform sampler2D uTexLut;
uniform vec4 uTileWorld;

out vec2 vLocal;
out vec4 vColor;
out vec2 vWorld;
out vec4 vAtlasUV;
out vec2 vTileInv;
out vec2 vTileOff;

void main() {
  int tid = int(aInstTexId + 0.5);
  ivec2 lutSize = textureSize(uTexLut, 0);
  vec2 aInstSize = vec2(0.0);
  vec4 aInstUV = vec4(0.0);
  vec4 aInstTrim = vec4(0.0);
  if (tid >= 0 && tid < lutSize.y) {
    vec4 t0 = texelFetch(uTexLut, ivec2(0, tid), 0);
    vec4 t1 = texelFetch(uTexLut, ivec2(1, tid), 0);
    vec4 t2 = texelFetch(uTexLut, ivec2(2, tid), 0);
    aInstSize = t0.xy;
    aInstUV = vec4(t0.zw, t1.xy);
    aInstTrim = vec4(t1.zw, t2.xy);
  }

  uint tintBits = floatBitsToUint(aInstTintBits);
  vec3 rgb = vec3(
    float((tintBits >> 16u) & 255u),
    float((tintBits >> 8u) & 255u),
    float(tintBits & 255u)
  ) / 255.0;
  float instA = float((tintBits >> 24u) & 255u) / 255.0;

  vec2 content = aInstTrim.xy + aQuad * aInstTrim.zw;
  vec2 local = (content - aInstAnchor * aInstSize) * aInstScale;
  float c = aInstRotCS.x;
  float s = aInstRotCS.y;
  vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 world = rotated + aInstXY;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, aInstDepth, 1.0);
  vLocal = aQuad;
  vColor = vec4(rgb, instA);
  vWorld = uTileWorld.w > 0.5 ? world * uTileWorld.z + uTileWorld.xy : world;
  vAtlasUV = aInstUV;
  vTileInv = aInstTileInv;
  vTileOff = aInstTileOff;
}
