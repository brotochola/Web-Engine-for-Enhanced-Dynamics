#version 300 es
precision highp float;
precision highp int;

// E-432: one draw composites up to 8 of a tilemap's layers over a page. uGid holds each tile's stack of the layers with a
// tile there, top first (entry s at rows s * pageH on, its layer in GID bits 26 to 28: tilemapGid.js packGidStacksRgba8);
// the pixel reads it front to back and stops at the first opaque texel or the stack's end, so each pixel is written and
// blended once instead of once a layer, and a layer with no tile there costs it nothing.
in vec2 vPageUv;
uniform vec2 uTileSize;
uniform vec2 uPageOrigin;
uniform vec2 uPageSize;
uniform float uFirstGid;
uniform float uColumns;
uniform vec2 uAtlasSize;
uniform float uStackDepth;
uniform vec4 uOpacityLo;
uniform vec4 uOpacityHi;
uniform sampler2D uGid;
uniform sampler2D uTileset;
out vec4 finalColor;

uint unpackGid(vec4 c) {
  uint r = uint(round(c.r * 255.0));
  uint g = uint(round(c.g * 255.0));
  uint b = uint(round(c.b * 255.0));
  uint a = uint(round(c.a * 255.0));
  return r | (g << 8u) | (b << 16u) | (a << 24u);
}

void main() {
  vec2 tileSize = uTileSize;
  if (tileSize.x <= 0.0 || tileSize.y <= 0.0) discard;
  vec2 pageSize = uPageSize;
  if (pageSize.x <= 0.0 || pageSize.y <= 0.0) discard;
  int columns = int(uColumns);
  if (columns <= 0) discard;

  vec2 tileF = vPageUv * pageSize + 1e-5;
  ivec2 local = ivec2(floor(tileF));
  ivec2 page = ivec2(pageSize);
  if (local.x < 0 || local.y < 0 || local.x >= page.x || local.y >= page.y) discard;
  vec2 tileUv = fract(tileF);
  int firstGid = int(uFirstGid);
  int depth = int(uStackDepth);

  // Premultiplied, front to back: what the layers under a pixel add is scaled by what the ones above leave.
  vec4 acc = vec4(0.0);
  for (int s = 0; s < 8; s++) {
    if (s >= depth) break;
    uint raw = unpackGid(texelFetch(uGid, ivec2(local.x, local.y + s * page.y), 0));
    // The tile's stack ends.
    if (raw == 0u) break;
    int l = int((raw >> 26u) & 7u);
    int tileId = int(raw & 0x03ffffffu) - firstGid;
    if (tileId < 0) continue;

    vec2 localUv = tileUv;
    if ((raw & 0x20000000u) != 0u) localUv = localUv.yx;
    if ((raw & 0x80000000u) != 0u) localUv.x = 1.0 - localUv.x;
    if ((raw & 0x40000000u) != 0u) localUv.y = 1.0 - localUv.y;

    int col = tileId % columns;
    int row = tileId / columns;
    vec2 atlasPx = vec2(float(col), float(row)) * tileSize + vec2(0.5) + localUv * (tileSize - vec2(1.0));
    // Level 0: the tileset has no mipmaps, and a sample in a loop that leaves early has no derivatives to choose one.
    vec4 tex = textureLod(uTileset, atlasPx / uAtlasSize, 0.0);
    float a = tex.a * (l < 4 ? uOpacityLo[l] : uOpacityHi[l - 4]);
    if (a < 0.01) continue;
    acc += (1.0 - acc.a) * vec4(tex.rgb * a, a);
    // What a layer below could still add is under half a step of the 8-bit target.
    if (acc.a >= 0.999) break;
  }
  if (acc.a <= 0.0) discard;
  finalColor = acc;
}
