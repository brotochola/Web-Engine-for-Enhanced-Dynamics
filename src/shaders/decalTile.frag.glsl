#version 300 es
precision highp float;
precision highp sampler2DArray;

// E-552: a decal tile's texels (premultiplied), its layer of the chunk's array (decalTile.vert.glsl).
in vec2 vTileUv;
flat in float vLayer;
uniform sampler2DArray uTiles;
uniform vec4 uColor; // the layer's colour, premultiplied: its alpha is the layer's
out vec4 finalColor;

void main() {
  finalColor = texture(uTiles, vec3(vTileUv, vLayer)) * uColor;
}
