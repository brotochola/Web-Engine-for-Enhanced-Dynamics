/**
 * E-448: early depth for the sprites whose frames are binary. The painter blends its sprites back to front, so a covered
 * pixel is shaded and blended once for every sprite over it (bunnyMark: 87 % of its GPU time was fill). A batch with the
 * opaque pass draws, before its own mesh:
 *
 * 1. the opaque pass: the instances that can be solid (OPAQUE_FRAME_MASK clear in their frame's texels, an opaque tint,
 *    InstancedSpriteBatch's own eligibility), nearest first, with the depth test (less) and depth writes, no blending.
 *    Their depth is the painter's own (gpuPack.c: 1 - (k + 1) / denom), so a sprite behind a solid pixel already drawn
 *    is rejected before its fragment shader runs. A pixel is drawn only where its alpha times the tint's is exactly 1
 *    (opaqueFragment): there blending would have replaced what was under it, so drawing it unblended, alone, is the same
 *    picture. Linear sampling gives a binary frame's edge pixels fractional alpha (R-1197); they are left to:
 * 2. the batch's own mesh, every instance in painter order and blended as before, the depth tested and not written: a
 *    pixel behind a solid one drawn in the opaque pass is rejected early, a solid pixel the opaque pass drew fails the
 *    test against its own depth (equal is not less), and every other pixel blends over what is there, as it did.
 *
 * Instanced attributes are read in one order only and WebGL 2 has no base instance, so the opaque pass has rows of its
 * own: each one's statics and its painter slot (OPAQUE_ROW_FLOATS, written when the statics move), and its pose read in
 * the vertex shader at that slot from a texture (opaqueVertex) that the batch's own pose buffer is copied into on the GPU
 * every frame (a pixel unpack from the buffer: no byte goes up twice, where a second pose stream doubled the GPU
 * process's work in bunnyMark, R-1195's scene).
 *
 * Each row's depth must stay apart from its neighbours' in the depth buffer (24 bits over window depth 0.5 to 1, where
 * the painter's depths land): OPAQUE_MAX_ROWS rows at most.
 */

import { FRAME_GLOW, FRAME_HALF, FRAME_SOFT, FRAME_UNSCANNED } from './frameBase.js';
import { GPU_INTEGRATED, GPU_TILED, GPU_VENDOR_INTEL } from './gpuClass.js';
import { GPU_STATIC_FLOATS } from './gpuQueueLayout.js';
import { replaceOnce } from './shaderEdit.js';

/** The frame texels (frameBase.js FRAME_*) that keep a frame out of the opaque pass: any alpha but 0 and 255, glow, unknown. */
export const OPAQUE_FRAME_MASK = FRAME_SOFT | FRAME_HALF | FRAME_GLOW | FRAME_UNSCANNED;

/** The most rows a batch with the opaque pass draws: 2^22 painter steps, two depth-buffer steps (2^-24) apart. */
export const OPAQUE_MAX_ROWS = 1 << 22;

/** An opaque row: the statics (instancedSpriteBatch.js POSE_STATIC_FLOATS, its order), then the painter slot as a float. */
export const OPAQUE_ROW_FLOATS = GPU_STATIC_FLOATS + 1;

/** The pose texture's width (RGBA32UI texels, four pose words each) and its words a row's log2. */
export const OPAQUE_POSE_TEXELS = 1024;
const POSE_ROW_SHIFT = 12;

/** The statics' words the opaque pass reads (POSE_STATIC_FLOATS order): the scale, the tint, the texture. */
const STATIC_SCALE_X = 0;
const STATIC_SCALE_Y = 1;
const STATIC_TINT = 5;
const STATIC_TEXTURE = 6;

/**
 * When the pass pays. With it, a pixel under the rows still shades about 2.4 fragments (about 0.7 transparent texels in
 * front of its first solid one, in each pass, and that solid one); without, one a row over it. It costs a second vertex
 * pass over its rows, about 9 ns a row against about 80 ps a blended fragment it spares (bunnyMark, GTX 1650: 2.3 ms for
 * the opaque pass of 250 000 rows, 20 ms of fill without it): it pays where it spares OPAQUE_ROW_PIXELS fragments a row
 * (about 110 at break-even). The cover counts the frames' solid texels (alpha 255) at their scale and the zoom. Predator
 * zoomed out to 0.216 (43 px a person, 0.77 screens of 38 000) does not pay; at zoom 1 (930 px, 4.7 screens of 10 600:
 * 1.14 -> 0.86 ms) it does, as bunnyMarkStress (570 px, 5.5 screens of 20 000) and bunnyMark (1 280 px at its zoom of
 * 1.5, 154 screens of 250 000).
 */
export const OPAQUE_FRAGMENTS_KEPT = 2.4;
export const OPAQUE_ROW_PIXELS = 160;

/**
 * Whether the opaque pass spares more fragments than its rows cost: `cover` the screen pixels its `rows` cover solidly
 * (their frames' solid texels at their scale and the view's zoom, overlaps counted), `screen` the target's pixels.
 * @param {number} cover
 * @param {number} screen
 * @param {number} rows
 * @returns {boolean}
 */
export function opaquePassPays(cover, screen, rows) {
  return cover - OPAQUE_FRAGMENTS_KEPT * Math.min(cover, screen) >= OPAQUE_ROW_PIXELS * rows;
}

/**
 * E-502: whether the opaque pass may draw on a GPU of this class and maker (gpuClass.js gpuClassOf, gpuVendorOf).
 * opaquePassPays's costs are the GTX 1650's, and integrated GPUs split by maker:
 * - Intel's draw slower with the pass even where that gate says it pays: the HD 620 drew bunnyMark (100 000) 53 % and
 *   bunnyMarkStress 78 % more frames without it, Predator level (R-1277). The cost is the pass's drawing, not its pose
 *   copy. Only Gen9 was measured; the other Intel generations follow it.
 * - AMD's gain from it like a discrete GPU: the Ryzen 4800H's Radeon (Vega) drew bunnyMark 100 000 at 43.6 fps with the
 *   pass and 32.0 without (-27 %, 4/4).
 * A tile-based GPU (Apple, Mali, Adreno, PowerVR) removes hidden surfaces on chip by itself, and its makers warn that a
 * draw with discard and depth writes (the pass's) defeats that: off there, not measured. Every other GPU keeps it.
 * @param {string} gpuClass
 * @param {string} vendor
 * @returns {boolean}
 */
export function opaquePassSuits(gpuClass, vendor) {
  if (gpuClass === GPU_TILED) return false;
  return gpuClass !== GPU_INTEGRATED || vendor !== GPU_VENDOR_INTEL;
}

/**
 * Whether the opaque pass may draw, from the setting debug.opaquePass (true always, false never, anything else the GPU
 * decides: opaquePassSuits) and the GPU's class and maker.
 * @param {boolean|string|undefined} setting
 * @param {string} gpuClass
 * @param {string} vendor
 * @returns {boolean}
 */
export function opaquePassOn(setting, gpuClass, vendor) {
  if (setting === true) return true;
  if (setting === false) return false;
  return opaquePassSuits(gpuClass, vendor);
}

/**
 * The pose texture's rows for `rows` pose rows of `poseWords` words (the batch's pose stream, copied whole).
 * @param {number} rows
 * @param {number} poseWords
 * @returns {number}
 */
export function opaquePoseTextureRows(rows, poseWords) {
  return Math.max(1, Math.ceil((Math.max(0, rows | 0) * poseWords) / (4 * OPAQUE_POSE_TEXELS)));
}

/**
 * The opaque pass's fragment shader from the batch's blending one (instancedSprite.frag.glsl): the same colour, and
 * a pixel whose alpha is not exactly 1 discarded.
 * @param {string} source
 * @returns {string}
 */
export function opaqueFragment(source) {
  const mark = 'float a = vColor.a < 0.0 ? 0.0 : t.a * ia;\n';
  const at = source.indexOf(mark);
  if (at < 0 || source.indexOf(mark, at + 1) >= 0) throw new Error('WeedJS: the opaque pass needs the sprite blend fragment shader');
  return `${source.slice(0, at + mark.length)}  if (a < 1.0) discard;\n${source.slice(at + mark.length)}`;
}

/** The shader the opaque pass's edits expect (replaceOnce's error names it). */
const OPAQUE_VERT = 'the opaque pass\'s sprite vertex shader';

/**
 * The opaque pass's vertex shader from the batch's (instancedSprite.vert.glsl's pose variant, a pose or a split batch's): the pose
 * attributes become globals read first from uOpPoses, the batch's pose stream in an RGBA32UI texture (a float's bits a
 * channel, OPAQUE_POSE_TEXELS texels a row), at the row's painter slot aInstSlot: `poseWords` 6 (x, y, the turn, the
 * previous x, y: a pose batch) or 4 (x, y, the turn; the previous pose is the current one, as a split batch's geometry
 * reads it). The rest of the shader is the batch's own, so the statics, the position and the colour are its own.
 * @param {string} source
 * @param {number} poseWords
 * @returns {string}
 */
export function opaqueVertex(source, poseWords) {
  if (poseWords !== 4 && poseWords !== 6) throw new Error(`WeedJS: the opaque pass reads 4 or 6 pose words, not ${poseWords}`);
  let out = replaceOnce(source, 'in vec2 aInstXY;\n', 'vec2 aInstXY;\n', OPAQUE_VERT);
  out = replaceOnce(out, 'in vec2 aInstRotCS;\n', 'vec2 aInstRotCS;\n', OPAQUE_VERT);
  out = replaceOnce(out, 'in vec2 aInstPrevXY;\n', 'vec2 aInstPrevXY;\n', OPAQUE_VERT);
  const fetch = (t) => `texelFetch(uOpPoses, ivec2((${t}) & ${OPAQUE_POSE_TEXELS - 1}, (${t}) >> ${POSE_ROW_SHIFT - 2}), 0)`;
  const head = '// E-448: this row\'s painter slot, whose pose uOpPoses holds (the batch\'s pose stream, copied on the GPU).\n' +
    'in float aInstSlot;\nuniform highp usampler2D uOpPoses;\n\n';
  const body = poseWords === 4
    ? `  int weedOpSlot = int(aInstSlot + 0.5);\n  uvec4 weedOpA = ${fetch('weedOpSlot')};\n` +
      '  aInstXY = uintBitsToFloat(weedOpA.xy);\n  aInstRotCS = uintBitsToFloat(weedOpA.zw);\n  aInstPrevXY = aInstXY;\n'
    : '  int weedOpSlot = int(aInstSlot + 0.5);\n  int weedOpT = (weedOpSlot * 6) >> 2;\n' +
      `  uvec4 weedOpA = ${fetch('weedOpT')};\n  uvec4 weedOpB = ${fetch('weedOpT + 1')};\n` +
      '  bool weedOpOdd = (weedOpSlot & 1) == 1;\n' +
      '  aInstXY = uintBitsToFloat(weedOpOdd ? weedOpA.zw : weedOpA.xy);\n' +
      '  aInstRotCS = uintBitsToFloat(weedOpOdd ? weedOpB.xy : weedOpA.zw);\n' +
      '  aInstPrevXY = uintBitsToFloat(weedOpOdd ? weedOpB.zw : weedOpB.xy);\n';
  const main = 'void main() {\n';
  const at = out.indexOf(main);
  if (at < 0 || out.indexOf(main, at + 1) >= 0) throw new Error('WeedJS: the opaque pass needs one "void main() {" in the sprite vertex shader');
  return out.slice(0, at) + head + main + body + out.slice(at + main.length);
}

/**
 * A keyed frame drawn by queue row (spriteIndexed.js spriteIndexedVertex with `poseBlock`) at the painter's depth, which
 * that program leaves at 0 (nothing tested it): `painter` false, the batch's own program, its draw slot gl_InstanceID;
 * true, the opaque pass's, the slot its row carries (aInstPainter). Both 1 - (k + 1) * uOpDepth (uOpDepth = 1 / denom,
 * the split pack's terms) by the same expression, so a row tests equal against the depth its own solid pixels wrote.
 * @param {string} source
 * @param {boolean} painter
 * @returns {string}
 */
export function opaqueRowVertex(source, painter) {
  let out = replaceOnce(source, '  aInstDepth = 0.0;\n',
    `  aInstDepth = 1.0 - (${painter ? 'aInstPainter' : 'float(gl_InstanceID)'} + 1.0) * uOpDepth;\n`, OPAQUE_VERT);
  const main = 'void main() {\n';
  const at = out.indexOf(main);
  if (at < 0 || out.indexOf(main, at + 1) >= 0) throw new Error('WeedJS: the opaque pass needs one "void main() {" in the sprite vertex shader');
  const head = `// E-448: the painter's depth step (1 / denom)${painter ? ', and this row\'s draw slot in the painter\'s order' : ''}.\n` +
    `uniform float uOpDepth;\n${painter ? 'in float aInstPainter;\n' : ''}`;
  out = out.slice(0, at) + head + out.slice(at);
  return out;
}

/** An opaque row of a keyed frame drawn by queue row: the queue row, the statics key, the draw slot (floats). */
export const OPAQUE_KEYED_ROW_FLOATS = 3;

/**
 * The opaque rows of `n` painter slots' statics (`statics`, `floats` a slot, its u32 view `staticsU32`): the slots whose
 * tint is opaque and whose frame (texels[texture]) has none of OPAQUE_FRAME_MASK, nearest first (the last painter slot
 * first), `floats` + 1 words a row: the slot's statics, copied as words (a tint's bits can be a NaN pattern, an opaque
 * white tint is one, which a copy through a float may change), then the slot as a float (`outF32` and `outU32` view the
 * same rows). Returns how many, and their cover in cover[0]: each one's frame's solid texels (`area`, by texture) times
 * its statics' scale's, in world px.
 * @param {Float32Array} statics
 * @param {Uint32Array} staticsU32
 * @param {number} floats
 * @param {number} n
 * @param {Uint8Array} texels
 * @param {Float32Array} area
 * @param {Float32Array} outF32
 * @param {Uint32Array} outU32
 * @param {Float64Array} cover
 * @returns {number}
 */
export function buildOpaqueRows(statics, staticsU32, floats, n, texels, area, outF32, outU32, cover) {
  const frames = texels.length;
  const areas = area.length;
  const row = floats + 1;
  let sum = 0;
  let m = 0;
  for (let o = n - 1; o >= 0; o--) {
    const at = o * floats;
    if (staticsU32[at + STATIC_TINT] >>> 24 !== 255) continue;
    const tex = statics[at + STATIC_TEXTURE] | 0;
    if (tex < 0 || tex >= frames || (texels[tex] & OPAQUE_FRAME_MASK) !== 0) continue;
    const to = m * row;
    for (let f = 0; f < floats; f++) outU32[to + f] = staticsU32[at + f];
    outF32[to + floats] = o;
    if (tex < areas) sum += Math.abs(area[tex] * statics[at + STATIC_SCALE_X] * statics[at + STATIC_SCALE_Y]);
    m++;
  }
  cover[0] = sum;
  return m;
}
