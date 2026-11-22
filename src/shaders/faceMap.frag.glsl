#version 300 es
precision highp float;
in vec2 vLocal;
in vec4 vColor;
in vec2 vWorld;
in vec4 vAtlasUV;
in vec2 vTileInv;
in vec2 vTileOff;
flat in vec2 vFaceOct;
in float vFaceZ;
// N-194: the sprite's |scale y|: its twin's heights (frame px) times this are its world heights.
flat in float vMapScale;
// E-496: the frame's window in the twin page and its marks (the maps table, mapsTable.js).
flat in vec4 vMapsWin;
// N-258: how the sprite turns its frame's normals: its rotation's cosine and sine, the signs of its scale (a flip).
flat in vec4 vNormalTurn;
// #if GBUF
// DX-GBUF: the instance's words (gbufWord.js: its entity's id, normals, surface, ...) and its foot's world y.
flat in vec2 vGbuf;
in float vFootY;
// #endif GBUF
uniform sampler2D uTexture;
// DX-MAPS: the atlas's twin page (spriteMaps.js): height in R, G (1/64 px) and a camera-space normal in B, A.
uniform sampler2D uMaps;
uniform vec4 uFaceSpace; // heightScaleY, groundScaleY
out vec4 finalColor;

// weed:twin

// #include weedUv.glsl

vec3 octDecode(vec2 bytes) {
  vec2 f = (bytes - 127.0) / 126.0;
  vec3 n = vec3(f, 1.0 - abs(f.x) - abs(f.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}

/** A normal's octahedral bytes over 255, 1..253 each (faceMap.js's encodeFaceNormal). */
vec2 octEncode(vec3 n) {
  n /= abs(n.x) + abs(n.y) + abs(n.z);
  vec2 p = n.xy;
  if (n.z < 0.0) p = (1.0 - abs(p.yx)) * vec2(p.x >= 0.0 ? 1.0 : -1.0, p.y >= 0.0 ? 1.0 : -1.0);
  return floor(p * 126.0 + 127.5) / 255.0;
}

/**
 * The face map's texel: a normal's bytes (or a code: faceMap.js FACE_FLAT_CODE) and a height in eighths of a px, 15 bits;
 * the top bit marks a sprite's own normal (`k`, faceMap.js FACE_K_BIT), which the light shows by the lamps' share.
 */
vec4 faceTexel(vec2 oct, float z, bool k) {
  float q = floor(clamp(z * 8.0, 0.0, 32767.0)) + (k ? 32768.0 : 0.0);
  return vec4(oct, floor(q / 256.0) / 255.0, mod(q, 256.0) / 255.0);
}

// N-258: a frame's normal (its own camera space: x right, y up) as its sprite draws it: mirrored where its scale is
// negative (flipX, flipY), then turned with it (the screen's rotation, y down, is the opposite turn with y up).
vec3 turnNormal(vec3 n) {
  vec2 f = n.xy * vNormalTurn.zw;
  return vec3(f.x * vNormalTurn.x + f.y * vNormalTurn.y, f.y * vNormalTurn.x - f.x * vNormalTurn.y, n.z);
}

// DX-GBUF: a twin texel's height (px), or `here` where the texel has no map (a transparent pixel of the frame).
float twinHeight(ivec2 c, float here) {
  vec4 m = twinRaw(c);
  return twinPresent(m) ? twinZ(m) : here;
}

// DX-GBUF: normals 'height': the twin page's heights around texel c through spriteMaps.js normalsFromHeight's Sobel, in
// the camera's space (y up), whatever normal the twin holds (a sheet's normal map).
vec3 heightNormal(ivec2 c, float z) {
  float a = twinHeight(c + ivec2(-1, -1), z);
  float b = twinHeight(c + ivec2(0, -1), z);
  float d = twinHeight(c + ivec2(1, -1), z);
  float l = twinHeight(c + ivec2(-1, 0), z);
  float r = twinHeight(c + ivec2(1, 0), z);
  float e = twinHeight(c + ivec2(-1, 1), z);
  float g = twinHeight(c + ivec2(0, 1), z);
  float h = twinHeight(c + ivec2(1, 1), z);
  float gx = (d + 2.0 * r + h - a - 2.0 * l - e) / 8.0;
  float gy = (e + 2.0 * g + h - a - 2.0 * b - d) / 8.0;
  return normalize(vec3(-gx, gy, 1.0));
}

// DX-FACES: what this pixel is, in painter order: a face's normal and height, or 0 where a sprite that is no face covers it.
// DX-MAPS: a sprite with maps writes its pixel's own: the twin's normal turned from the camera's space into the floor's
// (x along the screen, y across the floor towards the camera, z up), and the twin's height.
void main() {
  vec2 uv = weedUv();
  if (texture(uTexture, uv).a * vColor.a < 0.5) discard;
  // DX-UNSHADED: a pixel of an unshaded sheet (the maps table's mark), face or not. With the unshaded pass (UNSHADED) it
  // writes nothing here, and what is behind it is lit; without, (1/255, 0) in the face map, which the light pass lights
  // fully.
  if (twinUnshaded(vMapsWin)) {
// #if UNSHADED
    discard;
// #endif UNSHADED
// #if !UNSHADED
    finalColor = vec4(1.0 / 255.0, 0.0, 0.0, 0.0);
    return;
// #endif !UNSHADED
  }
  vec2 oct = vFaceOct;
  float z = vFaceZ;
  if (oct == vec2(0.0)) {
    ivec2 tc = twinCoord(uv, vMapsWin);
    vec4 m = twinHas(vMapsWin) ? texelFetch(uMaps, tc, 0) : vec4(0.0);
    vec2 sc = normalize(vec2(uFaceSpace.y, uFaceSpace.x)); // sin, cos of the camera's pitch
// #if GBUF
    // DX-GBUF (plan §5.4): an entity's sprite as its normals and surface say. With maps: the twin's height, and its normal
    // (normals 'auto' or 'map'), the heights' (normals 'height') or none (normals 'flat': lit as drawn). Without: a card
    // standing on its foot (surface 'standing'), a row's height its rise over the foot's, lit as drawn; or the floor.
    uint word = uint(vGbuf.x + 0.5);
// #if UNSHADED
    // DX-UNSHADED: an unshaded entity (its word's unshaded bit, gbufWord.js) writes nothing here either.
    if (((word >> 21u) & 1u) != 0u) discard;
// #endif UNSHADED
    if ((word & 65535u) != 0u) {
      uint flags = (word >> 16u) & 63u;
      uint normals = flags & 3u;
      if (twinPresent(m)) {
        float zm = twinZ(m);
        // N-257: a frame without heights (a normal or a relief map alone) stands as its surface says, as a sprite without
        // maps does: a card on its foot, or the floor. OL-4: where the camera shows no height (heightScaleY 0: straight
        // down, or from the side) nothing stands: it lies on the floor.
        float zw = twinHeights(vMapsWin) ? zm * vMapScale
          : ((flags & 4u) == 0u && uFaceSpace.x > 0.0 ? max(vFootY - vWorld.y, 0.0) / uFaceSpace.x : 0.0);
        if (normals == 3u) {
          finalColor = faceTexel(vec2(254.0 / 255.0), zw, false);
          return;
        }
        // The Sobel reads the frame's own heights, or its relief (DX-RELIEF): a scale stretches the heights and the texels
        // alike. A normal map alone has none to read: its own normals.
        // E-497: a format that keeps no normals (B) always takes the Sobel.
        bool sobel = (normals == 2u || !TWIN_NORMALS) && (twinHeights(vMapsWin) || twinRelief(vMapsWin));
        vec3 n = turnNormal(sobel ? heightNormal(tc, zm) : twinStoredNormal(m, tc));
        finalColor = faceTexel(octEncode(vec3(n.x, n.z * sc.y - n.y * sc.x, n.y * sc.y + n.z * sc.x)), zw, true);
        return;
      }
      if ((flags & 4u) == 0u && uFaceSpace.x > 0.0) {
        finalColor = faceTexel(vec2(254.0 / 255.0), max(vFootY - vWorld.y, 0.0) / uFaceSpace.x, false);
        return;
      }
      finalColor = vec4(0.0);
      return;
    }
// #endif GBUF
    if (twinPresent(m)) {
      vec3 n = turnNormal(TWIN_NORMALS ? twinStoredNormal(m, tc) : heightNormal(tc, twinZ(m)));
      oct = octEncode(vec3(n.x, n.z * sc.y - n.y * sc.x, n.y * sc.y + n.z * sc.x));
      // N-257: without words a frame without heights lies on the floor, as a decoration without maps does.
      z = twinHeights(vMapsWin) ? twinZ(m) * vMapScale : 0.0;
    }
  }
  finalColor = faceTexel(oct, z, false);
}
