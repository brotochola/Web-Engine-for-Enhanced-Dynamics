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
in vec3 aInstShadow;
in vec4 aInstLight;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform sampler2D uTexLut;
uniform vec4 uTileWorld;
uniform vec4 uSun;
uniform vec4 uLight;
uniform vec4 uCam;
uniform float uPointScale;

out vec2 vLocal;
out vec4 vColor;
out vec2 vWorld;
out vec4 vAtlasUV;
out vec2 vTileInv;
out vec2 vTileOff;

void main() {
  float height = aInstShadow.x;
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

  if (height <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    vColor = vec4(0.0);
    vLocal = aQuad;
    vWorld = aInstXY;
    vAtlasUV = aInstUV;
    vTileInv = aInstTileInv;
    vTileOff = aInstTileOff;
    return;
  }

  vec2 anchor = aInstAnchor + aInstShadow.yz;
  float sy = aInstScale.y;
  float alpha = uSun.w;
  float c = uSun.x;
  float s = uSun.y;
  vec4 light = aInstLight.w > 0.0 ? aInstLight : uLight;
  if (light.w > 0.0) {
    vec2 d = aInstXY - light.xy;
    float distSq = dot(d, d);
    float rangeSq = light.w;
    if (distSq < 1.0 || distSq > rangeSq) {
      gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
      vColor = vec4(0.0);
      vLocal = aQuad;
      vWorld = aInstXY;
      vAtlasUV = aInstUV;
      vTileInv = aInstTileInv;
      vTileOff = aInstTileOff;
      return;
    }
    float invDist = inversesqrt(distSq);
    float distRatio = clamp(distSq * invDist * 0.00390625, 0.0, 1.0);
    sy = -(0.3 + distRatio * 0.9) * abs(aInstScale.y) * height;
    c = d.y * invDist;
    s = -d.x * invDist;
    float fade = 1.0 - distSq / rangeSq;
    alpha = light.z / (light.z + distSq);
    alpha = clamp(alpha, 0.0, 1.0) * uPointScale * fade;
    if (alpha < 0.003) {
      gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
      vColor = vec4(0.0);
      vLocal = aQuad;
      vWorld = aInstXY;
      vAtlasUV = aInstUV;
      vTileInv = aInstTileInv;
      vTileOff = aInstTileOff;
      return;
    }
  } else {
    sy = -abs(aInstScale.y) * height * uSun.z;
  }

  vec2 content = aInstTrim.xy + aQuad * aInstTrim.zw;
  vec2 local = (content - anchor * aInstSize) * vec2(aInstScale.x, sy);
  vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 world = rotated + aInstXY;
  vec2 screen = (world - uCam.xy) * uCam.z;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(screen, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  if (abs(aInstRotCS.x) > 2.0) gl_Position.x += aInstRotCS.y + aInstDepth + aInstTintBits;
  vLocal = aQuad;
  vColor = vec4(0.0, 0.0, 0.0, alpha);
  vWorld = world;
  vAtlasUV = aInstUV;
  vTileInv = aInstTileInv;
  vTileOff = aInstTileOff;
}
