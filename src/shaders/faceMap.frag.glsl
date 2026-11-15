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

vec2 weedUv() {
  vec2 t = vLocal;
  if (vTileInv.x > 0.0) t.x = fract(vWorld.x * vTileInv.x + vTileOff.x);
  else if (vTileInv.x < 0.0) t.x = fract(vLocal.x * (-vTileInv.x) + vTileOff.x);
  if (vTileInv.y > 0.0) t.y = fract(vWorld.y * vTileInv.y + vTileOff.y);
  else if (vTileInv.y < 0.0) t.y = fract(vLocal.y * (-vTileInv.y) + vTileOff.y);
  return mix(vAtlasUV.xy, vAtlasUV.zw, t);
}

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

// #if GBUF
// DX-GBUF: a twin texel's height (px), or `here` where the texel has no map (a transparent pixel of the frame).
float twinHeight(ivec2 c, float here) {
  vec4 m = texelFetch(uMaps, c, 0);
  return m.b + m.a > 0.0 ? (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0 : here;
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
// #endif GBUF

// DX-FACES: what this pixel is, in painter order: a face's normal and height, or 0 where a sprite that is no face covers it.
// DX-MAPS: a sprite with maps writes its pixel's own: the twin's normal turned from the camera's space into the floor's
// (x along the screen, y across the floor towards the camera, z up), and the twin's height.
void main() {
  vec2 uv = weedUv();
  if (texture(uTexture, uv).a * vColor.a < 0.5) discard;
  vec2 oct = vFaceOct;
  float z = vFaceZ;
  if (oct == vec2(0.0)) {
    ivec2 tc = ivec2(uv * vec2(textureSize(uMaps, 0)));
    vec4 m = texelFetch(uMaps, tc, 0);
    // DX-EMISSIVE: a glowing pixel (normal bytes 0, 255). F10 v1: (1/255, 0) in the face map, the light pass lights it
    // fully. v2 (GLOW: the glow pass draws its glow): it writes nothing here, and what is behind it is lit.
    if (m.b < 0.5 / 255.0 && m.a > 254.5 / 255.0) {
// #if GLOW
      discard;
// #endif GLOW
// #if !GLOW
      finalColor = vec4(1.0 / 255.0, 0.0, 0.0, 0.0);
      return;
// #endif !GLOW
    }
    vec2 sc = normalize(vec2(uFaceSpace.y, uFaceSpace.x)); // sin, cos of the camera's pitch
// #if GBUF
    // DX-GBUF (plan §5.4): an entity's sprite as its normals and surface say. With maps: the twin's height, and its normal
    // (normals 'auto' or 'map'), the heights' (normals 'height') or none (normals 'flat': lit as drawn). Without: a card
    // standing on its foot (surface 'standing'), a row's height its rise over the foot's, lit as drawn; or the floor.
    uint word = uint(vGbuf.x + 0.5);
// #if GLOW
    // DX-EMISSIVE v2: an entity that glows by itself (its word's emissive level) writes nothing here either.
    if (((word >> 19u) & 7u) != 0u) discard;
// #endif GLOW
    if ((word & 65535u) != 0u) {
      uint flags = (word >> 16u) & 63u;
      uint normals = flags & 3u;
      if (m.b + m.a > 0.0) {
        float zm = (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0;
        if (normals == 3u) {
          finalColor = faceTexel(vec2(254.0 / 255.0), zm, false);
          return;
        }
        vec3 n = normals == 2u ? heightNormal(tc, zm) : octDecode(floor(m.ba * 255.0 + 0.5));
        finalColor = faceTexel(octEncode(vec3(n.x, n.z * sc.y - n.y * sc.x, n.y * sc.y + n.z * sc.x)), zm, true);
        return;
      }
      if ((flags & 4u) == 0u) {
        finalColor = faceTexel(vec2(254.0 / 255.0), max(vFootY - vWorld.y, 0.0) / uFaceSpace.x, false);
        return;
      }
      finalColor = vec4(0.0);
      return;
    }
// #endif GBUF
    if (m.b + m.a > 0.0) {
      vec3 n = octDecode(floor(m.ba * 255.0 + 0.5));
      oct = octEncode(vec3(n.x, n.z * sc.y - n.y * sc.x, n.y * sc.y + n.z * sc.x));
      z = (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0;
    }
  }
  finalColor = faceTexel(oct, z, false);
}
