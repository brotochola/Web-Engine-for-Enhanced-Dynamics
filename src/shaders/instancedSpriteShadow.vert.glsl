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
// 1 / the camera's floorScaleY: a point light's falloff and range are measured on the floor.
uniform float uGroundInvScaleY;
// DX-SHADOW3D: the sun's terms (sunShadowMap.js sunMapTerms): kx, ky (a px of height's landing shift on the floor), 0,
// heightScaleY; and the floor direction a card's columns run along (to the right of someone at the sun).
uniform vec4 uSunK;
uniform vec4 uSunPerp;

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
  // N-111: lutPerRow textureIds a row, so no side of the LUT passes MAX_TEXTURE_SIZE (instancedSpriteBatch.js).
  int lutPerRow = lutSize.x / 3;
  vec2 aInstSize = vec2(0.0);
  vec4 aInstUV = vec4(0.0);
  vec4 aInstTrim = vec4(0.0);
  // DX-SHADOW3D: where the frame stands (frameBase.js lutBaseFloats), the table's last two floats.
  vec2 aInstBase = vec2(0.0);
  if (tid >= 0 && tid < lutPerRow * lutSize.y) {
    ivec2 lutAt = ivec2(3 * (tid % lutPerRow), tid / lutPerRow);
    vec4 t0 = texelFetch(uTexLut, lutAt, 0);
    vec4 t1 = texelFetch(uTexLut, lutAt + ivec2(1, 0), 0);
    vec4 t2 = texelFetch(uTexLut, lutAt + ivec2(2, 0), 0);
    aInstSize = t0.xy;
    aInstUV = vec4(t0.zw, t1.xy);
    aInstTrim = vec4(t1.zw, t2.xy);
    aInstBase = t2.zw;
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
  // DX-CASTER (F9): the caster's own way when pre-render tagged its row (-(code + 1) in the depth float, which no
  // shadow program reads otherwise): kinds for the sun and the lamps (0 the sheet's, 1 a card, 2 its solid, 6 none),
  // how much light it takes out.
  int castCode = aInstDepth < -0.5 ? int(-aInstDepth - 0.5) : 0;
  int sunKind = castCode & 7;
  int lampKind = (castCode >> 3) & 7;
  float castOpacity = aInstDepth < -0.5 ? float((castCode >> 7) & 255) / 255.0 : 1.0;
  // weed:afterAnchor
  vec2 content = aInstTrim.xy + aQuad * aInstTrim.zw;
  vec4 light = aInstLight.w > 0.0 ? aInstLight : uLight;
  vec2 world;
  float alpha;
  if (light.w > 0.0) {
    vec2 d = aInstXY - light.xy;
    vec2 floorD = vec2(d.x, d.y * uGroundInvScaleY);
    float distSq = dot(floorD, floorD);
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
    float sy = -(0.3 + distRatio * 0.9) * abs(aInstScale.y) * height;
    // The shadow points away from the light on screen (the floor's projection keeps straight lines).
    float invScreenDist = inversesqrt(max(dot(d, d), 1e-6));
    float c = d.y * invScreenDist;
    float s = -d.x * invScreenDist;
    float fade = 1.0 - distSq / rangeSq;
    alpha = light.z / (light.z + distSq);
    alpha = clamp(alpha, 0.0, 1.0) * uPointScale * fade * castOpacity;
    if (lampKind == 6) alpha = 0.0;
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
    vec2 local = (content - anchor * aInstSize) * vec2(aInstScale.x, sy);
    world = vec2(local.x * c - local.y * s, local.x * s + local.y * c) + aInstXY;
  } else {
    // weed:sunCard
    // DX-SHADOW3D: the sun's card. It stands on the frame's lowest opaque row (its trim's bottom), faces the sun, and
    // each point of the picture lands on the floor along the sun's ray: its columns run across the sun, a px of the
    // picture's height above that row is 1 / heightScaleY px of height (times the caster's height), the landing shift
    // per px of height is uSunK.xy, all in the floor's terms (y over floorScaleY).
    alpha = sunKind == 6 ? 0.0 : uSun.w * castOpacity;
    float bottom = aInstTrim.y + aInstTrim.w;
    float sunZ = max(bottom - content.y, 0.0) * abs(aInstScale.y) / uSunK.w * height;
    // The picture's column at the card's foot, and the foot: under the lowest row, unless the frame's base says more.
    float footCol = anchor.x * aInstSize.x;
    vec2 foot = vec2(aInstXY.x, (aInstXY.y + (bottom - aInstAnchor.y * aInstSize.y) * aInstScale.y) * uGroundInvScaleY);
    float kLen = length(uSunK.xy);
    vec2 toSun = kLen > 1e-6 ? uSunK.xy / kLen : vec2(0.0);
    if (aInstBase.x >= 1.0) {
      // One view: the base is an ellipse on the floor (the feet; a trunk, round), its centre one radius north of the
      // lowest row. The card stands on its edge towards the sun, so the whole base lies on its own shadow.
      float rx = abs(aInstBase.y) * abs(aInstScale.x);
      float ry = (aInstBase.y < 0.0 ? -aInstBase.y : 0.6 * aInstBase.y) * abs(aInstScale.y);
      footCol = aInstBase.x - 1.0;
      foot.x = aInstXY.x + (footCol - aInstAnchor.x * aInstSize.x) * aInstScale.x;
      foot.y -= ry;
      foot += toSun * sqrt(rx * rx * toSun.x * toSun.x + ry * ry * toSun.y * toSun.y);
    } else if (aInstBase.x < 0.0) {
      // A render: this frame is the view from the sun (the sun where the camera is), so its contact nearest the sun is
      // its lowest one. The card stands there, that far from the anchor towards the sun.
      float reach = (-aInstBase.x - 1.0 - aInstAnchor.y * aInstSize.y) * abs(aInstScale.y) * uGroundInvScaleY;
      foot = vec2(aInstXY.x, aInstXY.y * uGroundInvScaleY) + toSun * reach;
    }
    vec2 land = foot + (content.x - footCol) * aInstScale.x * uSunPerp.xy - sunZ * uSunK.xy;
    world = vec2(land.x, land.y / uGroundInvScaleY);
    // weed:sunOut
  }

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
