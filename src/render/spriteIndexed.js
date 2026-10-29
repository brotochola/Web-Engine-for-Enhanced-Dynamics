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

/** Replace the one `from` in `source`, or say the shader is not the one this rewrite knows. */
function replaceOnce(source, from, to, what) {
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) throw new Error(`WeedJS: the sprite ${what} needs one "${from.trim()}"`);
  return source.slice(0, at) + to + source.slice(at + from.length);
}

/**
 * instancedSprite.vert.glsl reading its statics from the statics texture: the static attributes become globals the
 * shader fills first, from the three texels of the statics row (the words of gpuPack.c sprite_static: scale, anchor,
 * an unused depth, tint bits, texture, tile terms, and a zero) and the slot pair. The words go through
 * uintBitsToFloat, a bitcast; the tint's bits are read as the uint they are, with no float between that could change a
 * NaN pattern (an opaque white tint is one). `aInstSlot` is the slot stream's pair (the row, as a float, and the
 * depth), per instance, so a chunk drawn from any first instance reads its own, whatever the backend's range draw
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
  out = replaceOnce(out, 'uint tintBits = floatBitsToUint(aInstTintBits);', 'uint tintBits = weedS1.y;', 'vertex shader');
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
    '  aInstTexId = uintBitsToFloat(weedS1.z);\n' +
    '  aInstTileInv = uintBitsToFloat(uvec2(weedS1.w, weedS2.x));\n' +
    '  aInstTileOff = uintBitsToFloat(weedS2.yz);\n' +
    out.slice(at + main.length)
  );
}

/** The WGSL types of STATIC_ATTRIBUTES' GLSL ones. */
const WGSL_TYPES = { float: 'f32', vec2: 'vec2<f32>' };

/**
 * instancedSprite.wgsl reading its statics from a storage buffer (WebGPU): the static vertex inputs leave mainVert's
 * parameters for `let`s of the same names at the top of its body, from the three vec4<u32> of the statics row (the
 * words spriteIndexedVertex reads) and the slot pair, `aInstSlot` taking a free location; the tint's bits are read as
 * the u32 they are. `uStatics` is group 2's binding 4 (instancedSpriteIndexedGpuProgram).
 * @param {string} source instancedSprite.wgsl
 * @returns {string}
 */
export function spriteIndexedWgsl(source) {
  let out = source;
  for (const [type, name] of STATIC_ATTRIBUTES) {
    const param = new RegExp(`^[ \\t]*@location\\(\\d+\\) ${name}: ${WGSL_TYPES[type].replace(/[<>]/g, '\\$&')},\\n`, 'm');
    if (!param.test(out)) throw new Error(`WeedJS: the sprite WGSL has no "${name}: ${WGSL_TYPES[type]}" input`);
    out = out.replace(param, '');
  }
  out = replaceOnce(
    out,
    '@group(2) @binding(3) var<uniform> uniforms: TileUniforms;\n',
    '@group(2) @binding(3) var<uniform> uniforms: TileUniforms;\n' +
      "// The statics in the queue's row order, three vec4<u32> a row (E-162).\n" +
      '@group(2) @binding(4) var<storage, read> uStatics: array<vec4<u32>>;\n',
    'WGSL'
  );
  out = replaceOnce(out, '  @location(4) aInstRotCS: vec2<f32>,\n', '  @location(4) aInstRotCS: vec2<f32>,\n  @location(2) aInstSlot: vec2<f32>,\n', 'WGSL');
  out = replaceOnce(out, '  let tintBits = bitcast<u32>(aInstTintBits);\n', '  let tintBits = weedS1.y;\n', 'WGSL');
  const body = ') -> VertexOut {\n';
  const vert = out.indexOf('fn mainVert(');
  const at = vert < 0 ? -1 : out.indexOf(body, vert);
  if (at < 0) throw new Error('WeedJS: the sprite WGSL needs "fn mainVert(…) -> VertexOut {"');
  const head = at + body.length;
  return (
    out.slice(0, head) +
    '  let weedRow = u32(aInstSlot.x + 0.5) * 3u;\n' +
    '  let weedS0 = uStatics[weedRow];\n' +
    '  let weedS1 = uStatics[weedRow + 1u];\n' +
    '  let weedS2 = uStatics[weedRow + 2u];\n' +
    '  let aInstScale = bitcast<vec2<f32>>(weedS0.xy);\n' +
    '  let aInstAnchor = bitcast<vec2<f32>>(weedS0.zw);\n' +
    '  let aInstDepth = aInstSlot.y;\n' +
    '  let aInstTexId = bitcast<f32>(weedS1.z);\n' +
    '  let aInstTileInv = bitcast<vec2<f32>>(vec2<u32>(weedS1.w, weedS2.x));\n' +
    '  let aInstTileOff = bitcast<vec2<f32>>(weedS2.yz);\n' +
    out.slice(head)
  );
}
