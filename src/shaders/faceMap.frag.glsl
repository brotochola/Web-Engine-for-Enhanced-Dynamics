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

// DX-FACES: what this pixel is, in painter order: a face's normal and height, or 0 where a sprite that is no face covers it.
// DX-MAPS: a sprite with maps writes its pixel's own: the twin's normal turned from the camera's space into the floor's
// (x along the screen, y across the floor towards the camera, z up), and the twin's height.
void main() {
  vec2 uv = weedUv();
  if (texture(uTexture, uv).a * vColor.a < 0.5) discard;
  vec2 oct = vFaceOct;
  float z = vFaceZ;
  if (oct == vec2(0.0)) {
    vec4 m = texelFetch(uMaps, ivec2(uv * vec2(textureSize(uMaps, 0))), 0);
    // DX-EMISSIVE: a glowing pixel (normal bytes 0, 255) is (1/255, 0) in the face map: the light pass lights it fully.
    if (m.b < 0.5 / 255.0 && m.a > 254.5 / 255.0) {
      finalColor = vec4(1.0 / 255.0, 0.0, 0.0, 0.0);
      return;
    }
    if (m.b + m.a > 0.0) {
      vec3 n = octDecode(floor(m.ba * 255.0 + 0.5));
      vec2 sc = normalize(vec2(uFaceSpace.y, uFaceSpace.x)); // sin, cos of the camera's pitch
      oct = octEncode(vec3(n.x, n.z * sc.y - n.y * sc.x, n.y * sc.y + n.z * sc.x));
      z = (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0;
    }
  }
  float q = floor(clamp(z * 8.0, 0.0, 65535.0));
  finalColor = vec4(oct, floor(q / 256.0) / 255.0, mod(q, 256.0) / 255.0);
}
