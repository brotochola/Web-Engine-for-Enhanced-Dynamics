// E-162: an indexed sprite frame. Its statics stay in the render queue's row order and come from a texture; each
// instance carries its pose and its slot pair, the row of its statics and its depth (gpuPack.c
// pack_sprites_indexed_scatter), so a frame whose painter order moved uploads 24 bytes a sprite instead of 60. This
// turns the sprite vertex shader into one that fetches its statics, as gpuParticleTextureVertex does for GPU particle
// records (E-157).

import { GPU_INDEXED_STATIC_FLOATS, GPU_INDEXED_TEX_ROW } from './gpuQueueLayout.js';

/** Statics rows a texture row holds, and its log2: three RGBA32UI texels a statics row, a texture 3 072 texels wide. */
export const STATICS_TEX_ROW = GPU_INDEXED_TEX_ROW;
export const STATICS_TEX_ROW_SHIFT = 10;
export const STATICS_TEXELS_PER_ROW = GPU_INDEXED_STATIC_FLOATS / 4;

/** The texture's height for `rows` statics rows (the statics region holds whole texture rows). */
export function staticsTextureHeight(rows) {
  return Math.max(1, Math.ceil(Math.max(0, rows | 0) / STATICS_TEX_ROW));
}

/**
 * instancedSprite.vert.glsl's static attributes, which the indexed shader fills instead: the depth from the slot pair
 * (it follows the draw order), the rest from the statics texture.
 */
const STATIC_ATTRIBUTES = [
  ['vec2', 'aInstScale'],
  ['vec2', 'aInstAnchor'],
  ['float', 'aInstDepth'],
  ['float', 'aInstTintBits'],
  ['float', 'aInstTexId'],
  ['vec2', 'aInstTileInv'],
  ['vec2', 'aInstTileOff'],
];

/**
 * instancedSprite.vert.glsl reading its statics from the statics texture: the static attributes become globals the
 * shader fills first, from the three texels of the statics row (the words of gpuPack.c sprite_static: scale, anchor,
 * an unused depth, tint bits, texture, tile terms, and a zero) and the slot pair. The words go through
 * uintBitsToFloat, a bitcast, so the tint bits the shader reads back with floatBitsToUint keep every bit; an RGBA32F
 * texture could change a NaN pattern. `aInstSlot` is the slot stream's pair (the row, as a float, and the depth), an
 * instance attribute of its own name, so one geometry holds both layouts' buffers and each program binds what it
 * reads; per instance, a chunk drawn from any first instance reads its own, whatever the backend's range draw
 * (instanceRangeDraw.js).
 * @param {string} source instancedSprite.vert.glsl
 * @returns {string}
 */
export function spriteIndexedVertex(source) {
  let out = source;
  for (const [type, name] of STATIC_ATTRIBUTES) {
    const declaration = new RegExp(`^in ${type} ${name};`, 'm');
    if (!declaration.test(out)) throw new Error(`WeedJS: the sprite vertex shader has no "in ${type} ${name};"`);
    out = out.replace(declaration, `${type} ${name};`);
  }
  const main = 'void main() {\n';
  const at = out.indexOf(main);
  if (at < 0 || out.indexOf(main, at + 1) >= 0) throw new Error('WeedJS: the sprite vertex shader needs one "void main() {"');
  return (
    out.slice(0, at) +
    "in vec2 aInstSlot; // this instance's statics row and depth (E-162)\n" +
    "uniform highp usampler2D uStatics; // the statics in the queue's row order, three texels a row\n\n" +
    main +
    '  aInstDepth = aInstSlot.y;\n' +
    '  int weedRow = int(aInstSlot.x + 0.5);\n' +
    `  ivec2 weedTexel = ivec2((weedRow & ${STATICS_TEX_ROW - 1}) * ${STATICS_TEXELS_PER_ROW}, weedRow >> ${STATICS_TEX_ROW_SHIFT});\n` +
    '  uvec4 weedS0 = texelFetch(uStatics, weedTexel, 0);\n' +
    '  uvec4 weedS1 = texelFetch(uStatics, weedTexel + ivec2(1, 0), 0);\n' +
    '  uvec4 weedS2 = texelFetch(uStatics, weedTexel + ivec2(2, 0), 0);\n' +
    '  aInstScale = uintBitsToFloat(weedS0.xy);\n' +
    '  aInstAnchor = uintBitsToFloat(weedS0.zw);\n' +
    '  aInstTintBits = uintBitsToFloat(weedS1.y);\n' +
    '  aInstTexId = uintBitsToFloat(weedS1.z);\n' +
    '  aInstTileInv = uintBitsToFloat(uvec2(weedS1.w, weedS2.x));\n' +
    '  aInstTileOff = uintBitsToFloat(weedS2.yz);\n' +
    out.slice(at + main.length)
  );
}
