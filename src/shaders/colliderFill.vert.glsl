in vec2 aTri;
in vec2 aV0;
in vec2 aV1;
in vec2 aV2;
in vec2 aInstXY;
in vec2 aInstRotCS;
in float aInstTintBits;
in float aInstDepth;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out vec4 vColor;

void main() {
  vec2 local = aV0 + aTri.x * (aV1 - aV0) + aTri.y * (aV2 - aV0);
  float c = aInstRotCS.x;
  float s = aInstRotCS.y;
  vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 world = rotated + aInstXY;
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
  vColor = vec4(rgb * instA, instA);
}
