#version 300 es
precision highp float;
precision highp int;

in vec2 vPageUv;
uniform vec2 uTileSize;
uniform vec2 uPageOrigin;
uniform vec2 uPageSize;
uniform float uFirstGid;
uniform float uColumns;
uniform vec2 uAtlasSize;
uniform float uOpacity;
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

  vec2 tileF = vPageUv * pageSize + 1e-5;
  ivec2 local = ivec2(floor(tileF));
  ivec2 page = ivec2(pageSize);
  if (local.x < 0 || local.y < 0 || local.x >= page.x || local.y >= page.y) discard;

  uint raw = unpackGid(texelFetch(uGid, local, 0));
  if (raw == 0u) discard;

  bool flipH = (raw & 0x80000000u) != 0u;
  bool flipV = (raw & 0x40000000u) != 0u;
  bool flipD = (raw & 0x20000000u) != 0u;
  uint gid = raw & 0x1fffffffu;
  int firstGid = int(uFirstGid);
  int tileId = int(gid) - firstGid;
  if (tileId < 0) discard;

  vec2 localUv = fract(tileF);
  if (flipD) {
    localUv = localUv.yx;
  }
  if (flipH) localUv.x = 1.0 - localUv.x;
  if (flipV) localUv.y = 1.0 - localUv.y;

  int columns = int(uColumns);
  if (columns <= 0) discard;
  int col = tileId % columns;
  int row = tileId / columns;
  vec2 atlasPx = vec2(float(col), float(row)) * tileSize + vec2(0.5) + localUv * (tileSize - vec2(1.0));
  vec4 tex = texture(uTileset, atlasPx / uAtlasSize);
  float a = tex.a * uOpacity;
  if (a < 0.01) discard;
  finalColor = vec4(tex.rgb * a, a);
}
