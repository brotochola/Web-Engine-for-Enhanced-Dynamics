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

// A render drawn for another camera than the scene's (frameBase.js ART_FLOOR_CODES): how tall its floor is drawn against the
// scene's, from its base's second float (1: the scene's own).
float artFloorRatio(float y, float groundInvScaleY) {
  float code = floor(fract(abs(y)) * 2048.0 + 0.5);
  return code > 0.5 && code < 1023.5 ? code / 512.0 * groundInvScaleY : 1.0;
}

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
  // shadow program reads otherwise): kinds for the sun and the lamps (0 the sheet's, 1 a card, 2 its solid; 3 a box, 4 a
  // hull, 5 a wall and 6 none cast no sprite shadow: the volume or the wall does),
  // how much light it takes out.
  int castCode = aInstDepth < -0.5 ? int(-aInstDepth - 0.5) : 0;
  int sunKind = castCode & 7;
  int lampKind = (castCode >> 3) & 7;
  float castOpacity = aInstDepth < -0.5 ? float((castCode >> 7) & 255) / 255.0 : 1.0;
  // A fixed card lies along the object (orient bit 6), its axis on the floor in 64 steps from bit 15.
  bool castFixed = ((castCode >> 6) & 1) == 1;
  float castAxisA = float((castCode >> 15) & 63) * 0.09817477042;
  vec2 castAxis = vec2(cos(castAxisA), sin(castAxisA));
  // ShadowCaster.baseRadius (px, 0: the measured base): pre-render writes it into a tagged row's tile offset, which a caster
  // that does not repeat its texture leaves at 0 (its tile terms 0).
  float castBaseRadius = aInstTileInv == vec2(0.0) ? max(aInstTileOff.x, 0.0) : 0.0;
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
    if (lampKind >= 3) alpha = 0.0;
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
    alpha = sunKind >= 3 ? 0.0 : uSun.w * castOpacity;
    float bottom = aInstTrim.y + aInstTrim.w;
    // The picture's rows above the card's foot (screen px), and what a row is: px of depth on the floor, away from where
    // the picture is seen from, and px of height. A picture of one view stands upright: every row is height.
    float rows = (bottom - content.y) * abs(aInstScale.y);
    float rowDepth = 0.0;
    float rowHeight = height / uSunK.w;
    // The picture's column at the card's foot, and the foot: under the lowest row, unless the frame's base says more.
    float footCol = anchor.x * aInstSize.x;
    vec2 foot = vec2(aInstXY.x, (aInstXY.y + (bottom - aInstAnchor.y * aInstSize.y) * aInstScale.y) * uGroundInvScaleY);
    float kLen = length(uSunK.xy);
    vec2 toSun = kLen > 1e-6 ? uSunK.xy / kLen : vec2(0.0);
    // The floor direction towards where the picture is seen from (the sun, unless a render's frame says otherwise), and
    // the one its columns run along.
    vec2 toView = toSun;
    vec2 sunPerp = uSunPerp.xy;
    if (aInstBase.x >= 1.0) {
      // One view: the base is an ellipse on the floor (the feet; a trunk, round), its centre one radius north of the
      // lowest row. The card stands on its edge towards the sun, so the whole base lies on its own shadow.
      float rx = abs(aInstBase.y) * abs(aInstScale.x);
      float ry = (aInstBase.y < 0.0 ? -aInstBase.y : 0.6 * aInstBase.y) * abs(aInstScale.y);
      // DX-CASTER: the caster's baseRadius corrects the measured radius, the ellipse's shape kept.
      if (castBaseRadius > 0.0) {
        ry = rx > 1e-3 ? ry * castBaseRadius / rx : (aInstBase.y < 0.0 ? castBaseRadius : 0.6 * castBaseRadius);
        rx = castBaseRadius;
      }
      footCol = aInstBase.x - 1.0;
      foot.x = aInstXY.x + (footCol - aInstAnchor.x * aInstSize.x) * aInstScale.x;
      foot.y -= ry;
      foot += toSun * sqrt(rx * rx * toSun.x * toSun.x + ry * ry * toSun.y * toSun.y);
    } else if (aInstBase.x < 0.0) {
      // A render: this frame is the view from the sun (the sun where the camera is), so its contact nearest the sun is
      // its lowest one. The card stands there, that far from the anchor towards the sun.
      // N-297: the base's first float keeps the contact's whole row and, in its fraction, how much height a row of the
      // picture is (frameBase.js lutBaseFloats; 0: not measured).
      float packed = -aInstBase.x - 1.0;
      float contactRow = floor(packed) + 0.5;
      float perRowCode = floor(fract(packed) * 512.0 + 0.5);
      // N-297: the frame is the direction nearest the sun's, up to half a step of the sheet's directions to a side
      // (6 degrees for a car's sheet), and a card that faced the sun turned the whole picture by that much: the shadow
      // turned with the sun and jumped back at each new frame. Pre-render says how far the frame's own view is from the
      // sun's, in the row's texture float's fraction (preRenderWorker.js sunFrameTurnCode: 128ths, 0 none, else 32 is no
      // turn and a step 0.75 degrees): the picture's floor stays where the object is, and only its heights fall along the
      // sun's ray.
      // The picture's floor is its art's: a render drawn for another camera is worked out there (where the sun is on it, the
      // frame's turn, its depth a row) and its floor then drawn as the picture draws it. Read on the scene's floor (drawn 0.5
      // tall, a car drawn 0.736) the card stood half as far again towards the sun: a dark wedge on the lit side.
      float art = artFloorRatio(aInstBase.y, uGroundInvScaleY);
      if (art != 1.0 && kLen > 1e-6) {
        toView = normalize(vec2(toSun.x, toSun.y / art));
        sunPerp = vec2(toView.y, -toView.x);
      }
      float turnCode = floor(fract(aInstTexId) * 128.0 + 0.5);
      if (turnCode > 0.5) {
        float turn = (turnCode - 32.0) * 0.01308996939;
        float tc = cos(turn);
        float ts = sin(turn);
        toView = vec2(toView.x * tc - toView.y * ts, toView.x * ts + toView.y * tc);
        sunPerp = vec2(sunPerp.x * tc - sunPerp.y * ts, sunPerp.x * ts + sunPerp.y * tc);
      }
      toView.y *= art;
      sunPerp.y *= art;
      float artInvScaleY = uGroundInvScaleY / art;
      float reach = (contactRow - aInstAnchor.y * aInstSize.y) * abs(aInstScale.y) * artInvScaleY;
      foot = vec2(aInstXY.x, aInstXY.y * uGroundInvScaleY) + toView * reach;
      rows = (contactRow - content.y) * abs(aInstScale.y);
      // N-297: that frame is drawn from the camera's pitch, so a row above the contact is part depth on the floor and
      // part height. Every row taken for height was right only for a sun as high as the camera looks down (44 degrees
      // on the light bench): a higher sun pulled the far side's shadow under the object, a lower one stretched it. The
      // card leans back instead, by the frame's own measure: its top edge lands where the object's far top edge does.
      if (perRowCode > 0.5) {
        float heightShare = clamp((perRowCode - 1.0) / 256.0 * uSunK.w, 0.0, 1.0);
        rowDepth = (1.0 - heightShare) * artInvScaleY;
        rowHeight = heightShare * height / uSunK.w;
      }
    }
    if (castFixed) {
      // DX-CASTER: a fixed card stands along the object through its anchor (the frame shows it face on), upright.
      foot = vec2(aInstXY.x, aInstXY.y * uGroundInvScaleY);
      footCol = aInstAnchor.x * aInstSize.x;
      sunPerp = castAxis;
      rows = (bottom - content.y) * abs(aInstScale.y);
      rowDepth = 0.0;
      rowHeight = height / uSunK.w;
    }
    float sunZ = rows * rowHeight;
    vec2 land = foot + (content.x - footCol) * aInstScale.x * sunPerp - toView * (rows * rowDepth) - sunZ * uSunK.xy;
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
