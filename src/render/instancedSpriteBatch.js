/**
 * Shared SoA → one instanced Mesh upload for ENTITIES / cast shadows / custom layers.
 * Pixi v8 Geometry + Shader + Mesh.
 * Atlas is PMA-on-upload (Pixi ImageSource default). Fragment must:
 *   - scale rgb by instance alpha (vColor.a) so soft particles / smoke fade
 *   - NOT multiply by tex.a again (tex.rgb already has it) — that darkens trails
 * blendMode 'normal' expects PMA (ONE, ONE_MINUS_SRC_ALPHA).
 *
 * GPU record stays interleaved AoS (vertex fetch). CPU pack is compact: LUT
 * size/uv/trim and tint unpack live in the vertex shader (texelFetch uTexLut).
 */

import {
  Container,
  Geometry,
  Mesh,
  Shader,
  GpuProgram,
  GlProgram,
  Buffer,
  BufferUsage,
  State,
  Texture,
  TextureSource,
} from '../vendor/pixi.min.js';

import {
  instancedSpriteGpuProgram,
  instancedSpriteIndexedGpuProgram,
  instancedSpriteShadowGpuProgram,
  instancedSpriteShadowIndexedGpuProgram,
} from './webgpu/instancedSpriteWgsl.js';
import { glProgramFrom } from './webgl/glProgram.js';
import { pickInstancedSpriteFragmentGlsl } from './webgl/instancedSpriteGlsl.js';
import {
  GPU_GBUF_FLOATS, GPU_INDEXED_SLOT_FLOATS, GPU_INDEXED_STATIC_FLOATS, GPU_KEYED_CASTER_FLOATS, GPU_KEYED_STAMP_FLOATS,
  GPU_INDEXED_TEX_WORD, GPU_POSE_FLOATS, GPU_STATIC_FLOATS, gpuIndexedStaticRows, gpuIndexedUpdateRows, makePackContext,
} from './gpuQueueLayout.js';
import { RenderStep, STENCIL_MASK_ACTIVE, STENCIL_MASK_ADD, STENCIL_OFF, stencilStep } from './renderStep.js';
import {
  GPU_KEYED_KEY_WORD, GPU_KEYED_ROW_WORDS, GPU_KEYED_TEX_WORDS, packInstancedRowsWasm, packKeyedRowsByRowWasm, packKeyedRowsWasm,
  packPoseRowsWasm, packSplitRowsWasm,
} from './gpuPackClient.js';
import {
  faceFragmentGlsl, faceGbufFragment, faceIdsFragment, faceMapVertex, faceMapWgsl, faceUnshadedFragment,
  faceUnshadedMaskFragment, gbufAttributeGlsl, gbufAttributeWgsl, unshadedMaskVertex,
} from './faceMap.js';
import { FRAME_UNSCANNED, TEX_LUT_FLAG_BITS, TEX_LUT_FLAGS_PER_ROW, TEX_LUT_SOFT_OR_GLOW, lutBaseFloats } from './frameBase.js';
import {
  OPAQUE_KEYED_ROW_FLOATS, OPAQUE_MAX_ROWS, OPAQUE_POSE_TEXELS, OPAQUE_ROW_FLOATS, buildOpaqueKeyedRows, buildOpaqueRows,
  opaqueFragment, opaquePassPays, opaquePoseTextureRows, opaqueRowVertex, opaqueVertex,
} from './opaquePass.js';
import {
  gbufDepthFragment, gbufDepthVertex, gbufDepthWgsl, pixelDepthFragment, pixelDepthTerms, pixelDepthVertex, pixelDepthWgsl,
} from './pixelDepth.js';
import {
  GBUF_STATICS_MARK, POSE_ROW_FLOATS, POSE_TEX_TEXELS, STATICS_TEXELS_PER_ROW, STATICS_TEX_ROW, poseBlockFloats,
  spriteIndexedVertex, spriteIndexedWgsl, staticsTextureHeight,
} from './spriteIndexed.js';
import { GBUF_FOOT_NONE } from './gbufWord.js';
import { PIXI_KEYED_HEADER, PIXI_KEYED_HEADER_WORDS } from '../util/wasmMemoryMap.js';

/** Compact instance floats: xy, scale, anchor, rotCS, depth, packedARGB, texId, tileInv, tileOff.
 *  tileInv sign: + WORLD (1/period), - LOCAL (worldVis/period), 0 stretch. tileOff is UV 0..1.
 *  A pose batch splits the same terms, with the previous xy, into two streams (below). */
export const INSTANCED_SPRITE_FLOATS = 15;
// E-82. A pose batch uploads two streams instead of one 17-float record. The pose (x, y, rotC, rotS,
// prevX, prevY) goes up every frame; the statics (scale, anchor, depth, tint, texture, tile terms)
// only when they change: when the queue's staticGen, the rows packed, the type filter or the screen
// scale differ from what the static buffer holds. 24 bytes a sprite a frame instead of 68.
export const POSE_DYN_FLOATS = 6;
export const POSE_STATIC_FLOATS = GPU_STATIC_FLOATS;
// E-82b. A split batch is a plain batch in the same two streams, its pose 4 floats (x, y, rotC, rotS) and
// the previous xy read from the current one: 16 bytes a sprite on a frame whose statics hold, the same 60
// as a plain batch on one whose statics change.
export const SPLIT_POSE_FLOATS = GPU_POSE_FLOATS;

export const BATCH_SPACE = Object.freeze({ WORLD: 0, SCREEN: 1 });
export const BATCH_DEPTH = Object.freeze({ INDEX: 0 });

/**
 * DX-FACES, DX-GBUF: the batch's passes over its own instances for the light (InstancedSpriteBatch._auxMesh): the face
 * map, the entity ids map, both in one pass (MRT), the unshaded colour (DX-UNSHADED). Their names and fragment entries
 * (WGSL).
 */
export const AUX_FACE = 0;
export const AUX_IDS = 1;
export const AUX_GBUF = 2;
export const AUX_UNSHADED = 3;
/** E-457: the unshaded mask, the quads of the instances that can be unshaded in the stencil, where the unshaded pass draws. */
export const AUX_UNSHADED_MASK = 4;
/**
 * N-266: with pixel depth the unshaded pass is two, as the canvas's colour is: AUX_UNSHADED the solid pixels that are not
 * unshaded (black, writing the depth), this one the soft and the unshaded ones (testing it).
 */
export const AUX_UNSHADED_EDGE = 5;
const AUX_NAMES = ['face', 'ids', 'gbuf', 'unshaded', 'unshadedMask', 'unshadedEdge'];
const AUX_ENTRIES = ['mainFragFace', 'mainFragIds', 'mainFragGbuf', 'mainFragUnshaded', 'mainFragUnshadedMask', 'mainFragUnshadedEdge'];
/**
 * E-457: the unshaded pass's stencil between its meshes (renderStep.js): the stencil mode, its reference and the colour mask
 * for the meshes after it. The mask is not popped: the target's next render clears the stencil, and the last step turns the
 * test off.
 */
const unshadedStencilStep = (mode, reference, colorMask) =>
  stencilStep('weed-unshaded-stencil', mode, reference, colorMask, true);

/** E-448: what the opaque mesh draws: a pose or split frame's rows (its poses copied each frame), a by-row keyed frame's. */
const OPAQUE_KIND_POSE = 0;
const OPAQUE_KIND_KEYED_ROWS = 1;
/** E-448: frames a by-row batch skips building its opaque rows after a frame where the pass did not pay (a quarter second). */
const OPAQUE_RECHECK_FRAMES = 15;

// E-177. A keyed frame saves KEYED_SAVED_BYTES a row against a split one (the slot pair instead of the statics) and
// spends an update's bytes on each row it sends. When the updates outweigh the saving for KEYED_LOSS_FRAMES frames in a
// row (rows without a key, as a LiquidFun scene's sprites, or statics that all move), the batch draws split for
// KEYED_PAUSE_FRAMES frames, then tries again (E-312: the marks then count from its last keyed frame, so nothing is lost).
export const KEYED_SAVED_BYTES = (GPU_STATIC_FLOATS - GPU_INDEXED_SLOT_FLOATS) * 4;
export const KEYED_LOSS_FRAMES = 10;
export const KEYED_PAUSE_FRAMES = 1800;
/** E-395: the frames enableStaticsMirror asks every slot's statics for, so the CPU copy holds them all. */
const STATICS_MIRROR_FILL_FRAMES = 4;

const EMPTY_UPLOAD_OPTS = Object.freeze({
  space: BATCH_SPACE.WORLD,
  zoom: 1,
  cameraX: 0,
  cameraY: 0,
  resolution: 1,
  depthMode: BATCH_DEPTH.INDEX,
  depthDenom: 0,
  worldHeight: 1,
  sortKey: null,
  texLut: null,
  texLutCount: 0,
  textures: null,
  type: null,
  includeType: -1,
  excludeType0: -1,
  excludeType1: -1,
  indices: null,
  indexCount: 0,
});

// E-387: the G-buffer columns a keyed pack has not been handed (setGbufColumns): none.
const NO_GBUF_U8 = new Uint8Array(0);
const NO_GBUF_I16 = new Int16Array(0);

/**
 * Per-textureId LUT: origW, origH, u0, v0, u1, v1, trimX, trimY, trimW, trimH, and the frame's base (frameBase.js
 * lutBaseFloats: where it stands, read by the shadow passes only).
 */
export const TEX_LUT_FLOATS = 12;
/** RGBA32F texels per textureId in the LUT (12 floats). */
export const TEX_LUT_RGBA_WIDTH = 3;
/**
 * N-111. The LUT's most rows: WebGL 2's promised MAX_TEXTURE_SIZE, so the texture uploads on every GPU (SwiftShader's
 * limit is 8 192, a phone's often 4 096). Past it each row holds several textureIds; the shaders read
 * textureSize(uTexLut).x / TEX_LUT_RGBA_WIDTH of them a row.
 */
export const TEX_LUT_MAX_ROWS = 2048;

/**
 * N-111. The LUT texture for `count` textureIds: `perRow` of them a row (1 until count passes `maxRows`), `width` texels
 * (TEX_LUT_RGBA_WIDTH each, then H-EDGE's flags texel: frameBase.js TEX_LUT_SOFT_OR_GLOW) and `height` rows. textureId t
 * is at texel (TEX_LUT_RGBA_WIDTH * (t % perRow), t / perRow), its row's flags at (TEX_LUT_RGBA_WIDTH * perRow, t / perRow).
 * @param {number} count
 * @param {number} [maxRows]
 * @returns {{ perRow: number, width: number, height: number }}
 */
export function textureLutLayout(count, maxRows = TEX_LUT_MAX_ROWS) {
  const n = Math.max(1, count | 0);
  const perRow = Math.ceil(n / maxRows);
  const width = perRow * TEX_LUT_RGBA_WIDTH + 1;
  if (width > maxRows) {
    throw new Error(
      `WeedJS: the atlas has ${n} frames; its texture table holds at most ${Math.floor((maxRows - 1) / TEX_LUT_RGBA_WIDTH) * maxRows} (${maxRows} x ${maxRows} texels)`
    );
  }
  return { perRow, width, height: Math.ceil(n / perRow) };
}

function writeLutSlot(lut, base, tex) {
  if (typeof tex.updateUvs === 'function') tex.updateUvs();
  const orig = tex.orig;
  const origW = (orig && orig.width) || tex.width || 0;
  const origH = (orig && orig.height) || tex.height || 0;
  const uvs = tex.uvs;
  const trim = tex.trim;
  // Guard: Pixi sometimes leaves raw frame pixels in uvs before source size is known
  const srcW = tex.source?.width || tex.frame?.width || 1;
  const srcH = tex.source?.height || tex.frame?.height || 1;
  let u0 = uvs.x0;
  let v0 = uvs.y0;
  let u1 = uvs.x2;
  let v1 = uvs.y2;
  if (u1 > 1.5 || v1 > 1.5 || u0 > 1.5 || v0 > 1.5) {
    u0 = uvs.x0 / srcW;
    v0 = uvs.y0 / srcH;
    u1 = uvs.x2 / srcW;
    v1 = uvs.y2 / srcH;
  }
  lut[base] = origW;
  lut[base + 1] = origH;
  lut[base + 2] = u0;
  lut[base + 3] = v0;
  lut[base + 4] = u1;
  lut[base + 5] = v1;
  if (trim) {
    lut[base + 6] = trim.x;
    lut[base + 7] = trim.y;
    lut[base + 8] = trim.width;
    lut[base + 9] = trim.height;
  } else {
    lut[base + 6] = 0;
    lut[base + 7] = 0;
    lut[base + 8] = origW;
    lut[base + 9] = origH;
  }
  // DX-SHADOW3D: where the frame stands (set by the Pixi worker from the atlas's json), else [0, 0].
  lutBaseFloats(tex.weedBase, lut, base + 10);
  // DX-SHADOW3D: a render's footprint row (the Pixi worker's footprint texture), + 1, in its base's spare float, negative
  // for a render that casts its card for the sun (frameBase.js lutBaseFloats).
  if (tex.weedFootSlot >= 0 && lut[base + 10] < 0) lut[base + 11] = (lut[base + 11] < 0 ? -1 : 1) * (tex.weedFootSlot + 1);
}

/** E-448: a texture's frame's solid texels (alpha 255: its json base's `solidTexels`), 0 when its scan did not count them. */
function frameSolid(tex) {
  const n = tex && tex.weedBase ? tex.weedBase.solidTexels : undefined;
  return typeof n === 'number' && n > 0 ? n : 0;
}

/** H-EDGE: what a texture's frame's texels hold (frameBase.js FRAME_*: its json base's `texels`, else FRAME_UNSCANNED). */
function frameTexels(tex) {
  const t = tex && tex.weedBase ? tex.weedBase.texels : undefined;
  return typeof t === 'number' ? t & 255 : FRAME_UNSCANNED;
}

/**
 * H-EDGE: a CPU LUT's frames' texels (frameBase.js FRAME_*), a byte a slot, for the LUTs buildTextureLut made: kept beside
 * the LUT, so it stays TEX_LUT_FLOATS a textureId for every reader (sunShadowMap.js compactColumnRows bounds its ids by
 * its length). packTextureLutRgba puts their soft-or-glow bit in each row's flags texel; textureLutTexels reads them.
 */
const LUT_TEXELS = new WeakMap();
/** E-448: a CPU LUT's frames' solid texels, beside it as its texels are (textureLutSolid). */
const LUT_SOLID = new WeakMap();

/**
 * H-EDGE: what each textureId's frame's texels hold (frameBase.js FRAME_SOFT, FRAME_HALF, FRAME_GLOW, FRAME_UNSCANNED), a
 * byte a textureId, for a LUT buildTextureLut made; null for any other.
 * @param {Float32Array} lut
 * @returns {Uint8Array|null}
 */
export function textureLutTexels(lut) {
  return (lut && LUT_TEXELS.get(lut)) || null;
}

/**
 * E-448: each textureId's frame's solid texels (alpha 255; 0 where its scan did not count them), for a LUT
 * buildTextureLut made; null for any other.
 * @param {Float32Array} lut
 * @returns {Float32Array|null}
 */
export function textureLutSolid(lut) {
  return (lut && LUT_SOLID.get(lut)) || null;
}

/** The CPU LUT of `flatTextures`: TEX_LUT_FLOATS a textureId, one slot at least; H-EDGE's texels beside it (textureLutTexels). */
export function buildTextureLut(flatTextures, fallbackTexture) {
  const n = flatTextures?.length || 0;
  const lut = new Float32Array(Math.max(1, n) * TEX_LUT_FLOATS);
  const texels = new Uint8Array(Math.max(1, n)).fill(FRAME_UNSCANNED);
  const solid = new Float32Array(Math.max(1, n));
  const fb = fallbackTexture || Texture.WHITE;
  for (let i = 0; i < n; i++) {
    const tex = flatTextures[i];
    if (!tex) {
      console.warn(
        `[InstancedSpriteBatch] flatTextures[${i}] missing; LUT slot falls back to WHITE`
      );
      writeLutSlot(lut, i * TEX_LUT_FLOATS, fb);
    } else {
      writeLutSlot(lut, i * TEX_LUT_FLOATS, tex);
      texels[i] = frameTexels(tex);
      solid[i] = frameSolid(tex);
    }
  }
  if (n === 0) {
    console.warn('[InstancedSpriteBatch] flatTextures empty; LUT falls back to WHITE');
    writeLutSlot(lut, 0, fb);
  }
  LUT_TEXELS.set(lut, texels);
  LUT_SOLID.set(lut, solid);
  return lut;
}

/**
 * Pack CPU LUT (12 floats/id) into the RGBA32F texture of textureLutLayout(count, maxRows) for vertex texelFetch.
 * The slots past `count` in the last row stay 0 (a zero size). H-EDGE: each row's flags texel holds its frames' soft-or-glow
 * bits (frameBase.js TEX_LUT_SOFT_OR_GLOW, TEX_LUT_FLAG_BITS a channel), set for every frame of a LUT that has no texels
 * (textureLutTexels).
 */
export function packTextureLutRgba(lut, count, maxRows = TEX_LUT_MAX_ROWS) {
  const n = Math.max(1, count | 0);
  const { perRow, width, height } = textureLutLayout(n, maxRows);
  const out = new Float32Array(width * height * 4);
  const srcN = lut ? (lut.length / TEX_LUT_FLOATS) | 0 : 0;
  const texels = textureLutTexels(lut);
  for (let i = 0; i < n; i++) {
    const row = (i / perRow) | 0;
    const slot = i % perRow;
    const dst = (row * width + slot * TEX_LUT_RGBA_WIDTH) * 4;
    if (slot < TEX_LUT_FLAGS_PER_ROW && (texels === null || i >= texels.length || (texels[i] & TEX_LUT_SOFT_OR_GLOW) !== 0)) {
      out[(row * width + perRow * TEX_LUT_RGBA_WIDTH) * 4 + ((slot / TEX_LUT_FLAG_BITS) | 0)] += 2 ** (slot % TEX_LUT_FLAG_BITS);
    }
    if (i < srcN) {
      const s = i * TEX_LUT_FLOATS;
      out[dst] = lut[s];
      out[dst + 1] = lut[s + 1];
      out[dst + 2] = lut[s + 2];
      out[dst + 3] = lut[s + 3];
      out[dst + 4] = lut[s + 4];
      out[dst + 5] = lut[s + 5];
      out[dst + 6] = lut[s + 6];
      out[dst + 7] = lut[s + 7];
      out[dst + 8] = lut[s + 8];
      out[dst + 9] = lut[s + 9];
      out[dst + 10] = lut[s + 10];
      out[dst + 11] = lut[s + 11];
    }
  }
  return out;
}

/** A one-texture LUT for a batch made before the atlas has one, a source per backend (made once each). */
const _dummyLut = { gpu: null, gl: null };
export function dummyLutSource(useWebGpu) {
  const key = useWebGpu ? 'gpu' : 'gl';
  if (_dummyLut[key]) return _dummyLut[key];
  const source = TextureSource.from({
    resource: packTextureLutRgba(null, 1),
    width: textureLutLayout(1).width,
    height: 1,
    format: 'rgba32float',
    scaleMode: 'nearest',
    addressMode: 'clamp-to-edge',
    autoGenerateMipmaps: false,
  });
  source.uploadMethodId = useWebGpu ? 'external' : 'unknown';
  _dummyLut[key] = source;
  return source;
}

export class InstancedSpriteBatch {
  /**
   * @param {object} opts
   * @param {number} opts.capacity
   * @param {string} opts.label
   * @param {import('../vendor/pixi.min.js').TextureSource} opts.atlasSource
   * @param {boolean} [opts.depthTest=true]
   * @param {boolean} [opts.depthMask=true]
   * @param {boolean} [opts.premultiplyAlpha=true] - true → normal PMA out; false → additive (glows)
   * @param {string} [opts.blendMode='normal'] - Pixi State blend mode
   * @param {boolean} [opts.useWebGpu=true] - compile GpuProgram vs GlProgram
   * @param {object} opts.shaders - fetched engine sources (`sprite` or spriteVert/frag*)
   * @param {object|null} [opts.statics] - E-162, a split batch: what it keeps indexed frames' statics in, with which it
   *   also commits them (commitIndexed). WebGL: Pixi's RGBA32UI texture helper (`maxSize`, `make`, `upload`:
   *   pixiWorker._gpuRecordTexture); WebGPU: `{ maxStorageBytes }`, the device's storage binding size
   * @param {object|null} [opts.keyed] - E-177, a split batch with `statics` whose helper scatters (`scatter`) and that
   *   packs through the kernel: the render-queue memory's keyed regions (renderQueueMemory.js pixiKey*: `keyBase`,
   *   `keyRows`, `updatesByte`, `headerByte`), so its frames go keyed: the poses and the slot pairs in draw order, the
   *   sprites' statics by entity in the texture, sent when the emit marked them changed. Each upload then needs the
   *   queue's frame number and buffer (`keyedFrame`, `keyedBuffer`, set by the caller). E-191: `shadowByte` (-1 for none),
   *   the shadow stream's region, which enableKeyedShadows turns on for the sun's pass over these instances
   * @param {object|null} [opts.opaquePass] - E-448 (opaquePass.js): the instances whose frames are binary drawn first,
   *   nearest first, unblended, writing depth (opaqueHost, which the caller puts right before the batch's own mesh), and
   *   the batch's own mesh testing it: the record texture helper its pose texture is made with and copied into
   *   (pixiWorker._gpuRecordTexture: `make`, `fromBuffer`; null: none). Only a WebGL pose or split batch with normal
   *   premultiplied blending, without pixel depth or G-buffer words, takes it (opaqueOn), on its pose and split frames and
   *   its keyed frames drawn by queue row (not its indexed ones, nor keyed ones drawn by their poses); its target needs a
   *   depth buffer
   * @param {boolean} [opts.staticBuffers=false] - the vertex buffers made with a static usage hint on WebGL, which ANGLE
   *   binds directly instead of copying each draw's attributes; for a batch that uploads once a frame
   * @param {boolean} [opts.depthFaces=false] - DX-FACEDEPTH: with pixel depth, the depth programs read faces from the start
   *   (setDepthFaces)
   * @param {import('../vendor/pixi.min.js').TextureSource|null} [opts.mapsTable] - E-496: the maps table (mapsTable.js),
   *   each frame's window in the twin page, which every program that reads the twin page reads (pixel depth, the passes
   *   for the light); setMapsTable changes it
   */
  constructor({
    capacity,
    label,
    atlasSource,
    depthTest = true,
    depthMask = true,
    premultiplyAlpha = true,
    blendMode = 'normal',
    lutSource = null,
    useWebGpu = true,
    shaders = null,
    poseInterp = false,
    shadowCast = false,
    data = null,
    gpuPack = null,
    split = false,
    arena = null,
    statics = null,
    keyed = null,
    posesByRow = false,
    pixelDepth = null,
    gbuf = false,
    opaquePass = null,
    staticBuffers = false,
    mapsTable = null,
    depthFaces = false,
  }) {
    this.capacity = Math.max(1, capacity | 0);
    // The vertex buffers' usage. ANGLE's D3D11 backend binds a buffer made with DYNAMIC_DRAW to no draw directly: it copies
    // the attributes each draw reads into a streaming buffer of its own, on the GPU process's main thread (instances x
    // stride bytes: bunnyMark's 250 000 sprites, 17 MB and 5.7 ms a draw, found in E-448's sitting). A STATIC_DRAW buffer
    // is bound as it is, rewritten every frame or not, but a rewrite then waits on the GPU for the draws still reading
    // it: `staticBuffers` (WebGL) for a batch that uploads once a frame, whose ring of two the frame pacer keeps clear
    // (with every batch static, light3dCompare's lamps' map pass took 1.23 -> 1.67 ms of GPU). WebGPU has no such hint.
    this._vertexUsage = BufferUsage.VERTEX | BufferUsage.COPY_DST | (staticBuffers && !useWebGpu ? BufferUsage.STATIC : 0);
    this.poseInterp = !!poseInterp;
    this.shadowCast = !!shadowCast && !poseInterp;
    this.split = !!split && !this.poseInterp && !this.shadowCast;
    // DX-GBUF (plan §6.4): each instance's G-buffer words (gbufWord.js), GPU_GBUF_FLOATS a sprite in a stream of their own
    // that every geometry the batch draws carries (aInstGbuf), uploaded after each frame's rows (commitGbuf). The G-buffer
    // pass reads them. Off, the batch's geometries and programs are as they always were.
    this.gbuf = !!gbuf && !this.shadowCast;
    this._gbufData = new Float32Array(this.gbuf ? this.capacity * GPU_GBUF_FLOATS : 0);
    // The instances whose words the CPU copy holds as zeros (commitGbuf with none), so a run of frames without words
    // uploads its zeros once.
    this._gbufZeros = 0;
    // E-387: whether the last upload's keyed pack wrote this frame's words (packedGbuf), from setGbufColumns' columns.
    this.gbufPacked = false;
    // E-455 step 3: whether it put them in the slots' statics instead (a keyed frame without bands), and the instances
    // whose words the CPU copy holds as GBUF_STATICS_MARK (commitGbufFromStatics), so a run of such frames uploads none.
    this.gbufInStatics = false;
    this._gbufMarked = 0;
    // E-455: the batch's drawn frames (each _finishUpload, so every pack that writes its shared rows counts), the one whose
    // commit took the keyed pack's words (-1: none; the frame after compares with them in place), the CPU copy's count at
    // the last commit, its generation (one more each time it changes), and each ring slot's: the generation its buffer
    // holds and how many instances' words it holds of it.
    this._drawSerial = 0;
    this._gbufPackedSerial = -1;
    this._gbufCount = 0;
    this._gbufGen = 1;
    this._ringGbufGen = new Int32Array(2);
    this._ringGbufCount = new Int32Array(2);
    // The ring slot the last upload drew from: its gbuf buffer is the one this frame's words go to.
    this._lastRing = 0;
    // E-162: a split batch given `statics` also takes indexed frames: the poses, a slot stream (each instance's statics
    // row and depth) and every queue row's statics in row order, in a texture (WebGL) or a storage buffer (WebGPU).
    this.indexed = this.split && statics !== null;
    // Two streams, a pose and the statics: a pose batch's (E-82) or a split batch's (E-82b).
    this._twoStreams = this.poseInterp || this.split;
    this._floats = this.poseInterp ? POSE_DYN_FLOATS : this.split ? SPLIT_POSE_FLOATS : INSTANCED_SPRITE_FLOATS;
    if (this.shadowCast) this._floats += 7;
    this._strideBytes = this._floats * 4;
    // W30: in a private memory (sharedCopy.createPrivateArena) when Pixi passes one, so the copies out of the
    // render-queue memory run as memory.copy (copyIn); else arrays of the batch's own. E-448: a pose or split batch that
    // may draw the opaque pass copies its pose buffer into a texture in whole texture rows (opaquePass.js), so its data
    // reaches the last one.
    const dataFloats = Math.max(this.capacity * this._floats, opaquePass !== null && this._twoStreams
      ? opaquePoseTextureRows(this.capacity, this._floats) * OPAQUE_POSE_TEXELS * 4
      : 0);
    this.data = (arena && arena.f32(dataFloats)) || new Float32Array(dataFloats);
    // Its bits, over the same words: in the arena, from the array's own place in it, not from the arena's start (so is
    // staticDataU32).
    this.dataU32 = new Uint32Array(this.data.buffer, this.data.byteOffset, this.data.length);
    // W9d: a plain sprite batch may pack through gpuPack.wasm (`gpuPack`, gpuPackClient.bindGpuPack) into rows
    // of the render-queue memory (`data`); they are copied into `this.data` before the upload, as
    // _commitPackedBatch copies pre-render's. Uploading from the shared rows themselves made every other
    // worker slower in Predator (E-123: physics +9.5 %, spatial +6.3 %, 4/4). A split batch packs the same
    // region as its two streams, the poses first; so does a pose batch (W9e), whose rows are 17 floats.
    const poseFloats = this.poseInterp ? POSE_DYN_FLOATS : SPLIT_POSE_FLOATS;
    const rowFloats = this.poseInterp ? POSE_DYN_FLOATS + POSE_STATIC_FLOATS : INSTANCED_SPRITE_FLOATS;
    const shared = !this.shadowCast && data instanceof Float32Array && data.length >= this.capacity * rowFloats ? data : null;
    this._sharedRows = shared && !this.poseInterp ? shared : new Float32Array(0);
    this._gpuPack = shared && gpuPack ? gpuPack : null;
    this._sharedPose = shared && this._twoStreams ? shared.subarray(0, this.capacity * poseFloats) : new Float32Array(0);
    this._sharedStatic = shared && this._twoStreams
      ? new Float32Array(shared.buffer, shared.byteOffset + this.capacity * poseFloats * 4, this.capacity * POSE_STATIC_FLOATS)
      : new Float32Array(0);
    // The static stream (E-82): its CPU copy, the key of what it holds, and the version each ring
    // slot's GPU copy holds (-1: none).
    this.staticData = (this._twoStreams && arena && arena.f32(this.capacity * POSE_STATIC_FLOATS))
      || new Float32Array(this._twoStreams ? this.capacity * POSE_STATIC_FLOATS : 0);
    this.staticDataU32 = new Uint32Array(this.staticData.buffer, this.staticData.byteOffset, this.staticData.length);
    // W30: the arena's copy, the shared buffer it copies from and the arena's own (null: TypedArray.set).
    this._copy = arena ? arena.copy : null;
    this._copySource = arena ? arena.source : null;
    this._arenaBuffer = arena ? arena.buffer : null;
    this._staticVersion = 0;
    this._slotStaticVersion = [-1, -1];
    this._stGen = 0;
    this._stRows = -1;
    this._stScale = NaN;
    this._stFilter = -1;
    // E-162: the slot stream's CPU copy, the statics rows' (whole texture rows), and the generation and rows the
    // statics texture holds (_ixRows -1: nothing yet).
    const slotFloats = this.indexed ? this.capacity * GPU_INDEXED_SLOT_FLOATS : 0;
    // E-177: a keyed batch's statics texture holds a row for every key: the scene's entities, then a slot per row.
    this.keyed = this.indexed && keyed !== null && (keyed.keyRows | 0) > 0 && this._gpuPack !== null
      && typeof statics.scatter === 'function' && keyed.headerByte >= 0;
    // E-201: a keyed batch drawn by queue row (WebGL): each instance carries its queue row, and the keyed programs fetch
    // its pose from uPoses, the queue's own pose columns (x, y, rotC, rotS: four blocks of _poseBlock floats, their bits
    // in an RGBA32UI texture through the statics helper), instead of a pose stream gathered in the painter's order.
    this.posesByRow = this.keyed && !!posesByRow && !useWebGpu && !!this._gpuPack.spritesKeyedRows
      && typeof statics.make === 'function' && typeof statics.upload === 'function' && !!shaders?.spriteVert;
    this._poseBlock = this.posesByRow ? poseBlockFloats(this.capacity) : 0;
    this._poseTexRows = this._poseBlock / POSE_ROW_FLOATS;
    // In the arena when Pixi passes one (copyIn then runs as memory.copy), a fixed view per block.
    this._poseRows = (this.posesByRow && arena && arena.f32(this._poseBlock * 4)) || new Float32Array(this._poseBlock * 4);
    this._poseRowsU32 = new Uint32Array(this._poseRows.buffer, this._poseRows.byteOffset, this._poseBlock * 4);
    this._poseRowBlocks = [0, 1, 2, 3].map((b) => this._poseRows.subarray(b * this._poseBlock, (b + 1) * this._poseBlock));
    this._poseSource = null;
    const staticRows = this.indexed
      ? Math.max(gpuIndexedStaticRows(this.capacity), this.keyed ? keyed.keyRows | 0 : 0)
      : 0;
    const staticFloats = staticRows * GPU_INDEXED_STATIC_FLOATS;
    this._slotData = (this.indexed && arena && arena.f32(slotFloats)) || new Float32Array(slotFloats);
    // A keyed batch's statics never pass through this copy (the texture is made from its zeros, then scattered into), so
    // it stays out of the arena.
    this._rowStatics = (this.indexed && !this.keyed && arena && arena.f32(staticFloats)) || new Float32Array(staticFloats);
    this._rowStaticsU32 = new Uint32Array(this._rowStatics.buffer, this._rowStatics.byteOffset, staticFloats);
    // E-514: an indexed frame's lists of the statics rows that changed (pre-render's diff, room for a quarter of the rows
    // each), copied out of the render-queue memory (WebGL takes no shared view) for the scatter into the statics.
    this._ixUpdateRows = this.indexed && !this.keyed && typeof statics?.scatter === 'function'
      ? gpuIndexedUpdateRows(this.capacity) : 0;
    const ixWords = this._ixUpdateRows * GPU_KEYED_ROW_WORDS;
    const ixCopy = (ixWords > 0 && arena && arena.f32(ixWords)) || new Float32Array(ixWords);
    this._ixUpdates = new Uint32Array(ixCopy.buffer, ixCopy.byteOffset, ixWords);
    const ixTexWords = this._ixUpdateRows * GPU_KEYED_TEX_WORDS;
    const ixTexCopy = (ixTexWords > 0 && arena && arena.f32(ixTexWords)) || new Float32Array(ixTexWords);
    this._ixTexUpdates = new Uint32Array(ixTexCopy.buffer, ixTexCopy.byteOffset, ixTexWords);
    // Frames whose statics went up as lists, and as every row (a test and a probe read them).
    this._ixScattered = 0;
    this._ixWhole = 0;
    // E-177: the keyed pack's regions (gpuPackClient.packKeyedRowsWasm's `keyed`), the slot pairs it writes over the
    // static stream's half of the shared rows, its updates and their copy, and the resync header.
    const k = this.keyed ? keyed : null;
    const buf = this._sharedStatic.buffer;
    // E-387: a keyed batch's G-buffer words, which its keyed pack writes into the render-queue memory after the slot
    // stream (the static stream's half of the shared rows holds POSE_STATIC_FLOATS a row; a keyed frame writes
    // GPU_INDEXED_SLOT_FLOATS of them) and commitGbuf copies into gbufData.
    const gbufAt = this.capacity * GPU_INDEXED_SLOT_FLOATS;
    this._sharedGbuf = k && this.gbuf
      ? this._sharedStatic.subarray(gbufAt, gbufAt + this.capacity * GPU_GBUF_FLOATS)
      : new Float32Array(0);
    this._keyedPack = {
      keyBase: k ? k.keyBase | 0 : 0,
      updatesByte: k ? k.updatesByte | 0 : 0,
      updates: 0,
      // E-191: the shadow stream's byte (0 until enableKeyedShadows) and whether the last pack wrote it.
      shadowByte: 0,
      shadowed: false,
      // E-189: the texture updates' byte (0: none, the texture-only rows go up whole) and the last pack's count.
      texUpdatesByte: k && k.texUpdatesByte > 0 ? k.texUpdatesByte | 0 : 0,
      texUpdates: 0,
      // E-387: the G-buffer words' destination, the columns they come from (setGbufColumns; empty: none) and whether
      // the last pack wrote them.
      gbufOut: this._sharedGbuf,
      gbufFlags: NO_GBUF_U8,
      gbufSelf: NO_GBUF_U8,
      gbufZ: NO_GBUF_I16,
      gbufWritten: false,
      // E-455: whether any slot's words differ from what its place held.
      gbufChanged: true,
    };
    this._sharedSlots = k ? this._sharedStatic.subarray(0, this.capacity * GPU_INDEXED_SLOT_FLOATS) : new Float32Array(0);
    const updateWords = k ? this.capacity * GPU_KEYED_ROW_WORDS : 0;
    this._sharedUpdates = k ? new Uint32Array(buf, k.updatesByte, updateWords) : new Uint32Array(0);
    const updateCopy = (k && arena && arena.f32(updateWords)) || new Float32Array(updateWords);
    this._keyUpdates = new Uint32Array(updateCopy.buffer, updateCopy.byteOffset, updateWords);
    this._keyUpdatesF = new Float32Array(updateCopy.buffer, updateCopy.byteOffset, updateWords);
    // E-189: the texture updates, in the render-queue memory and their copy (WebGL takes no shared view).
    const texWords = this._keyedPack.texUpdatesByte > 0 ? this.capacity * GPU_KEYED_TEX_WORDS : 0;
    this._sharedTexUpdates = texWords > 0 ? new Uint32Array(buf, this._keyedPack.texUpdatesByte, texWords) : new Uint32Array(0);
    const texCopy = (texWords > 0 && arena && arena.f32(texWords)) || new Float32Array(texWords);
    this._keyTexUpdates = new Uint32Array(texCopy.buffer, texCopy.byteOffset, texWords);
    this._keyTexUpdatesF = new Float32Array(texCopy.buffer, texCopy.byteOffset, texWords);
    this._keyHeader = k ? new Uint32Array(buf, k.headerByte, PIXI_KEYED_HEADER_WORDS) : new Uint32Array(PIXI_KEYED_HEADER_WORDS);
    // The queue frame and buffer of the next upload (the caller's), and the last queue frame the texture took keyed (0:
    // none; E-312: pre-render marks every change after the one the header's DRAWN says, which this batch stores).
    this.keyedFrame = 0;
    this.keyedBuffer = 0;
    this._keyDrawn = 0;
    // The keyed frames in a row whose updates outweighed their saving, and the split frames left of a pause.
    this._keyLosses = 0;
    this._keyPause = 0;
    // E-312 step 2: whether the header's FULL asks pre-render for every row's statics (a pause, a frame not packed keyed).
    this._keyFull = false;
    // E-191: the sun's shadow pass over these instances (enableKeyedShadows): each draw slot's shadow terms in the
    // render-queue memory and their copy, a buffer and a geometry (pose, slot and shadow streams) per ring slot, the
    // program (makeKeyedSunShader), and this frame's geometry once a keyed upload carried them (keyedShadowReady).
    const shadowFloats = k && k.shadowByte >= 0 ? this.capacity * 3 : 0;
    this._sharedShadow = shadowFloats > 0 ? new Float32Array(buf, k.shadowByte, shadowFloats) : new Float32Array(0);
    this._shadowData = (shadowFloats > 0 && arena && arena.f32(shadowFloats)) || new Float32Array(shadowFloats);
    this._shadowBuffers = null;
    this._keyedShadowGeometries = null;
    this._keyedShadowRowGeometries = null;
    this._keyedSunShader = null;
    this.keyedShadows = false;
    this.keyedShadowReady = false;
    this.keyedShadowGeometry = null;
    // E-191 step 2: once the caller draws keyed caster rows (enableKeyedCasters), each keyed upload stores its queue
    // frame in the header's LIVE word, and pre-render writes such rows while it is recent. The programs that draw them
    // (makeKeyedCasterShader: the sun's rows, then the stamps' with their light) on an entity batch; on a caster batch,
    // its geometries over each ring slot for those rows (commitKeyedCasterRows: the sun's, then the stamps').
    this.keyedCasters = false;
    this._keyedCasterShaders = [null, null];
    // DX-FACES, DX-GBUF: the batch's passes over its own instances for the light (AUX_FACE: the face map; AUX_IDS: the
    // entity ids map; AUX_GBUF: both in one pass, MRT; AUX_UNSHADED: the unshaded colour; AUX_UNSHADED_MASK: where it is,
    // E-457): each kind's programs (plain, indexed, by row), its state and a mesh per geometry this batch draws (_auxMesh).
    this._aux = AUX_NAMES.map(() => ({ meshes: [], state: null, shader: null, indexed: null, row: null }));
    this._auxShaderList = [];
    // E-457: the unshaded pass's hosts, one an unshaded mesh (a geometry): { mesh, host }, the host holding the unshaded mask
    // and the unshaded mesh it masks (unshadedPass).
    this._unshadedPasses = [];
    // DX-UNSHADED: the unshaded pass draws the unshaded pixels (unshadedMesh), so the G-buffer's passes leave them out;
    // false: the face map's code for them. Set by the caller before a light pass is first drawn.
    this.unshadedOn = false;
    this._keyedCasterGeometries = null;
    this._ixGen = 0;
    this._ixRows = -1;
    // The slot pairs' generation and slots the CPU copy holds, its version, and each ring slot's GPU copy's (-1: none).
    this._ixSlotsGen = 0;
    this._ixSlots = -1;
    this._slotsVersion = 0;
    this._ringSlotsVersion = [-1, -1];
    this._quad = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    this._index = [0, 1, 2, 0, 2, 3];
    const labelName = label || 'instanced-sprites';
    this._label = labelName;
    // _packRefused said its reason.
    this._packRefusedWarned = false;
    this._buffers = this._ringBuffers(this.data, labelName);
    this._staticBuffers = this._twoStreams ? this._ringBuffers(this.staticData, labelName + '-static') : null;
    this._slotBuffers = this.indexed ? this._ringBuffers(this._slotData, labelName + '-slots') : null;
    // DX-GBUF: a gbuf buffer a ring slot, each geometry over that slot's.
    this._gbufBuffers = this.gbuf ? this._ringBuffers(this._gbufData, labelName + '-gbuf') : null;
    this._geometries = this._buffers.map((buf, r) => this._withGbuf(
      this._geometryFor(buf, this._staticBuffers ? this._staticBuffers[r] : null), r,
    ));
    // E-162: an indexed frame's geometries, over the same pose buffers and the slot buffers: the indexed program's
    // attributes and no other (a program bound to a geometry with attributes it lacks makes Pixi warn, per pair).
    this._indexedGeometries = this.indexed
      ? this._buffers.map((buf, r) => this._withGbuf(this._indexedGeometryFor(buf, this._slotBuffers[r]), r))
      : null;
    // E-201: a by-row keyed frame's geometries: the queue row from the pose buffer's first floats, the slot stream.
    this._rowGeometries = this.posesByRow
      ? this._buffers.map((buf, r) => this._withGbuf(this._rowGeometryFor(buf, this._slotBuffers[r]), r))
      : null;
    this._ring = 0;
    this.buffer = this._buffers[0];
    this.geometry = this._geometries[0];

    this._useWebGpu = useWebGpu;
    this._engineShaders = shaders;
    this._premultiplyAlpha = premultiplyAlpha;
    // DX-DEPTH (F5, pixelDepth.js): { maps }: the colour programs write each pixel's floor depth (gl_FragDepth on WebGL,
    // frag_depth on WebGPU), tested. On WebGPU every target this batch draws into needs a depth attachment.
    this._pixelDepth = pixelDepth && pixelDepth.maps ? pixelDepth : null;
    this.pixelDepthOn = this._pixelDepth !== null;
    // E-496: the maps table every reader of the twin page binds (uMapsLut); an empty texture reads as no maps.
    this._mapsTable = mapsTable || Texture.EMPTY.source;
    // DX-FACEDEPTH: whether the depth programs read faces (setDepthFaces): a face's plane depth from its vertices, the
    // depth continuous, and the opaque pass in two programs (E-378): the frames with heights write gl_FragDepth, the
    // vertex-depth twins (plain, indexed, by row) and their mesh (vdepthMesh, right before the batch's own) the others.
    this._depthFaces = depthFaces === true && this._pixelDepth !== null;
    this._vdepthShader = null;
    this._vdepthIndexedShader = null;
    this._vdepthRowShader = null;
    this.vdepthMesh = null;
    this._depthTerms = new Float32Array([1, 1, 0, 0]);
    // The light's passes' uFaceSpace: heightScaleY, floorScaleY, and N-274's G-buffer depth's view terms (the third and
    // fourth of _depthTerms), one array for every pass's group.
    this._faceSpace = new Float32Array([1, 1, 0, 0]);
    this._faceGroups = [];

    this._tileWorld = new Float32Array(4);
    this._tileWorld[2] = 1;
    const atlas = atlasSource || Texture.WHITE.source;
    const lut = lutSource || dummyLutSource(useWebGpu);
    // DX-DEPTH (F5 v2): the edge pass's programs (the soft and unshaded pixels, depth tested, not written), a twin of each
    // colour program (plain, indexed, by row) made with it; and its mesh, right after the batch's own (edgeMesh).
    this._edgeShader = null;
    this._edgeIndexedShader = null;
    this._edgeRowShader = null;
    this.edgeMesh = null;
    // E-448: the colour program's sources on WebGL (_makeSpriteShader) and the by-row one's before its depth
    // (_makeRowShader), which the opaque pass's programs are made from; whether the batch takes the pass (opaqueOn once
    // made): a WebGL pose or split batch with normal premultiplied blending, without pixel depth or G-buffer words.
    this._colorVertex = '';
    this._colorFragment = '';
    this._colorRowVertex = '';
    this._opWanted = opaquePass !== null && typeof opaquePass?.make === 'function' && typeof opaquePass.fromBuffer === 'function'
      && !useWebGpu && this._twoStreams && this._premultiplyAlpha && (blendMode || 'normal') === 'normal'
      && this._pixelDepth === null && !this.gbuf && this.capacity <= OPAQUE_MAX_ROWS;
    this.shader = this._makeSpriteShader(atlas, lut, label || 'instanced-sprites');
    // E-162: the statics texture and the program that reads it; the mesh draws with it on indexed frames.
    this._statics = this.indexed ? statics : null;
    this._staticsSource = null;
    this._staticsHeight = 0;
    // E-395: the keyed slots' texture and scale (three floats a slot), copied from the keyed updates once something asks
    // (enableStaticsMirror: the renders' columns over keyed rows pick their rows by them); empty until then. The updates'
    // float views read them.
    this._staticsMirror = new Float32Array(0);
    this._keyUpdatesF = new Float32Array(0);
    this._keyTexUpdatesF = new Float32Array(0);
    this._indexedShader = this.indexed ? this._makeIndexedShader(labelName) : null;
    this._rowShader = this.posesByRow ? this._makeRowShader(labelName) : null;
    this.shadowShader = null;
    if (this.shadowCast && (shaders?.shadowVert || shaders?.shadowWgsl)) {
      const sunUniforms = {
        uTileWorld: { value: this._tileWorld, type: 'vec4<f32>' },
        uSun: { value: new Float32Array([1, 0, 1, 0.4]), type: 'vec4<f32>' },
        uLight: { value: new Float32Array([-1, 0, 0, 0]), type: 'vec4<f32>' },
        uCam: { value: new Float32Array(4), type: 'vec4<f32>' },
        uPointScale: { value: 0, type: 'f32' },
        uGroundInvScaleY: { value: 1, type: 'f32' },
        // DX-SHADOW3D: the sun's card (sunShadowMap.js sunMapTerms): kx, ky, 0, heightScaleY; the columns' direction.
        uSunK: { value: new Float32Array([0, 0, 0, 1]), type: 'vec4<f32>' },
        uSunPerp: { value: new Float32Array([1, 0, 0, 0]), type: 'vec4<f32>' },
      };
      this._sunUniforms = sunUniforms;
      const resources = {
        uTexture: atlas,
        uSampler: atlas.style,
        uTexLut: lut,
        uniforms: sunUniforms,
      };
      if (this._useWebGpu && shaders.shadowWgsl) {
        const gpuProgram = instancedSpriteShadowGpuProgram(
          GpuProgram,
          shaders.shadowWgsl,
          (label || 'instanced-sprites') + '-sun'
        );
        this.shadowShader = new Shader({ gpuProgram, resources });
      } else if (shaders.shadowVert) {
        const glProgram = glProgramFrom(
          GlProgram,
          shaders.shadowVert,
          pickInstancedSpriteFragmentGlsl(true, shaders),
          (label || 'instanced-sprites') + '-sun'
        );
        this.shadowShader = new Shader({ glProgram, resources });
      }
    }

    const state = new State();
    state.blend = true;
    state.blendMode = blendMode || 'normal';
    state.depthTest = !!depthTest || this._pixelDepth !== null;
    state.depthMask = depthMask !== false || this._pixelDepth !== null;
    state.culling = false;

    this.mesh = new Mesh({
      geometry: this.geometry,
      shader: this.shader,
      state,
      label: label || 'instanced-sprites',
    });
    this.mesh.blendMode = state.blendMode;
    if (this._edgeShader !== null) {
      // DX-DEPTH (F5 v2): the edge pass, its pixels blended as the batch's, depth tested and not written.
      const edgeState = new State();
      edgeState.blend = true;
      edgeState.blendMode = state.blendMode;
      edgeState.depthTest = true;
      edgeState.depthMask = false;
      edgeState.culling = false;
      this.edgeMesh = new Mesh({ geometry: this.geometry, shader: this._edgeShader, state: edgeState, label: `${labelName}-edge` });
      this.edgeMesh.blendMode = state.blendMode;
      this.edgeMesh.cullable = false;
    }
    // DX-FACEDEPTH: with faces from the start, the opaque pass's vertex-depth mesh (setDepthFaces makes it later).
    if (this._vdepthShader !== null) this.vdepthMesh = this._depthTwinMesh(this._vdepthShader, true, 'vdepth');
    // E-448 (opaquePass.js): the opaque pass: its host (the pose step and its mesh), its rows (each one's statics and painter
    // slot, nearest first: OPAQUE_ROW_FLOATS) and their count, their version and each ring slot's GPU copy's (-1: none), the
    // pose texture this frame's poses are copied into and its rows, the frames' texels the rows are chosen by
    // (setFrameTexels) and their version, what the rows were built from (the statics' version, the rows, the texels'), and
    // whether the caller lets it draw this frame (setOpaqueAllowed). The batch's own mesh takes _depthState (the depth
    // tested, not written) on the frames the opaque pass draws, _blendState on the others.
    this.opaqueOn = false;
    this.opaqueHost = null;
    this.opaqueMesh = null;
    this._opShader = null;
    this._opBuffers = null;
    this._opGeometries = null;
    this._opRows = new Float32Array(0);
    this._opRowsU32 = new Uint32Array(0);
    this._opCount = 0;
    this._opVersion = 0;
    this._opRingVersion = [-1, -1];
    this._opTextures = null;
    this._opPoseSource = null;
    this._opPoseRows = 0;
    // E-448: a keyed batch's frames drawn by queue row: their opaque rows (OPAQUE_KEYED_ROW_FLOATS: the row, the key, the
    // draw slot), a buffer of them and a geometry a ring slot, their program, and what the opaque mesh drew last
    // (OPAQUE_KIND_*: which program and rows it holds, and whether the poses are copied).
    this._opKeyedRows = new Float32Array(0);
    this._opKeyedBuffers = null;
    this._opKeyedGeometries = null;
    this._opRowShader = null;
    this._opKind = OPAQUE_KIND_POSE;
    this._opTexels = new Uint8Array(0);
    // Each frame's solid texels (setFrameTexels; empty: unknown, the pass always drawn), the rows' cover (world px: their
    // frames' solid texels at their scale), the view's zoom and the target's pixels (setOpaqueView), by which each frame
    // decides whether the pass pays (opaquePass.js opaquePassPays).
    this._opArea = new Float32Array(0);
    this._opCover = new Float64Array(1);
    this._opZoom = 1;
    this._opScreen = 0;
    this._opTexelsVersion = 1;
    this._opBuiltTexels = 0;
    this._opBuiltStatics = -1;
    this._opBuiltRows = -1;
    this._opAllowed = true;
    // The by-row pass's frames left to skip its build after a frame where it did not pay, and the view that frame had
    // (_commitOpaqueRows).
    this._opSkipFrames = 0;
    this._opSkipZoom = NaN;
    this._opSkipScreen = NaN;
    this._blendState = state;
    this._depthState = state;
    if (this._opWanted && this._colorVertex !== '' && this._colorFragment !== '') this._makeOpaquePass(labelName, opaquePass);
    this._show(false);
    this.mesh.cullable = false; // bounds ignore instance attrs; don't frustum-cull the batch
    this._uploadCtx = {
      o: null,
      indices: null,
      useIndices: false,
      useScreen: false,
      cameraX: 0,
      cameraY: 0,
      screenScale: 1,
      cameraRot: 0,
      camC: 1,
      camS: 0,
      focusX: 0,
      focusY: 0,
      halfW: 0,
      halfH: 0,
      typeArr: null,
      includeType: -1,
      exclude0: -1,
      exclude1: -1,
      hasInclude: false,
      hasExclude: false,
      filterTypes: false,
      depthDenom: 1,
      scanCount: 0,
      particleCount: 0,
    };
  }

  /**
   * The ring's two vertex buffers over one array (`label` and `label`-ring): the instances' rows, their statics, the
   * indexed slots, the G-buffer words (DX-GBUF) or the keyed frames' shadow terms (E-191).
   */
  _ringBuffers(data, label) {
    return [
      new Buffer({ data, usage: this._vertexUsage, label }),
      new Buffer({ data, usage: this._vertexUsage, label: label + '-ring' }),
    ];
  }

  /**
   * DX-GBUF: `geometry` with ring slot `ring`'s G-buffer words (aInstGbuf) when the batch carries them. Pixi files a
   * geometry's buffers as its attributes name them, so the words' stream is one more buffer; a WebGPU program that does
   * not read it still declares it (gbufAttributeWgsl), and a WebGL one leaves it unbound.
   */
  _withGbuf(geometry, ring) {
    if (this._gbufBuffers === null) return geometry;
    geometry.addAttribute('aInstGbuf', {
      buffer: this._gbufBuffers[ring],
      format: 'float32x3',
      stride: GPU_GBUF_FLOATS * 4,
      offset: 0,
      instance: true,
    });
    return geometry;
  }

  /**
   * DX-GBUF: this frame's G-buffer words for the `count` instances the last upload drew, into the gbuf buffer of the ring
   * slot it drew from. `src` holds them in draw order (the GPU queue's gbuf region, or gbufData that the caller wrote);
   * null: none this frame, each instance is lit as it always was (its words zero). E-455: a keyed frame whose pack found
   * every slot's words as the frame before's (drawn keyed with them too, and committed here whole) leaves the CPU copy
   * as it is; a ring slot's buffer goes up only when it holds an older copy, or fewer instances of it.
   * @param {Float32Array|null} src
   * @param {number} count
   */
  commitGbuf(src, count) {
    if (this._gbufBuffers === null) return;
    const n = Math.min(count | 0, this.capacity);
    if (n <= 0) return;
    const floats = n * GPU_GBUF_FLOATS;
    if (src === this._gbufData) {
      this._gbufZeros = 0;
      this._gbufMarked = 0;
      this._gbufGen++;
    } else if (src !== null && src.length >= floats) {
      const same = src === this._sharedGbuf && this.gbufPacked && !this._keyedPack.gbufChanged
        && this._gbufPackedSerial === this._drawSerial - 1 && this._gbufCount === n;
      if (!same) {
        this.copyIn(this._gbufData, src, floats);
        this._gbufZeros = 0;
        this._gbufMarked = 0;
        this._gbufGen++;
      }
    } else if (this._gbufZeros < n) {
      this._gbufData.fill(0, 0, floats);
      this._gbufZeros = n;
      this._gbufMarked = 0;
      this._gbufGen++;
    }
    this._gbufPackedSerial = src === this._sharedGbuf && this.gbufPacked ? this._drawSerial : -1;
    this._gbufCount = n;
    const ring = this._lastRing;
    if (this._ringGbufGen[ring] !== this._gbufGen || this._ringGbufCount[ring] < n) {
      this._gbufBuffers[ring].update(floats * 4);
      this._ringGbufGen[ring] = this._gbufGen;
      this._ringGbufCount[ring] = n;
    }
  }

  /**
   * E-455 step 3: a frame whose keyed pack put the words in the slots' statics (gbufInStatics): the `count` instances
   * carry GBUF_STATICS_MARK, which the indexed programs read as "the statics row's word" (spriteIndexed.js
   * gbufWordFromStaticsGlsl), band 0 and no foot. The CPU copy is marked once and each ring slot's buffer goes up once,
   * not every frame.
   * @param {number} count
   */
  commitGbufFromStatics(count) {
    if (this._gbufBuffers === null) return;
    const n = Math.min(count | 0, this.capacity);
    if (n <= 0) return;
    if (this._gbufMarked < n) {
      const d = this._gbufData;
      for (let k = this._gbufMarked; k < n; k++) {
        d[k * GPU_GBUF_FLOATS] = GBUF_STATICS_MARK;
        d[k * GPU_GBUF_FLOATS + 1] = 0;
        d[k * GPU_GBUF_FLOATS + 2] = GBUF_FOOT_NONE;
      }
      this._gbufMarked = n;
      this._gbufZeros = 0;
      this._gbufGen++;
    }
    this._gbufPackedSerial = -1;
    this._gbufCount = n;
    const ring = this._lastRing;
    if (this._ringGbufGen[ring] !== this._gbufGen || this._ringGbufCount[ring] < n) {
      this._gbufBuffers[ring].update(n * GPU_GBUF_FLOATS * 4);
      this._ringGbufGen[ring] = this._gbufGen;
      this._ringGbufCount[ring] = n;
    }
  }

  /** DX-GBUF: the words' CPU copy, for a caller that writes them itself (gbufWord.js writeGbufWords), then commitGbuf. */
  get gbufData() {
    // E-455 step 3: a caller that takes the copy writes it: the statics' marks it held are no longer known to be there.
    this._gbufMarked = 0;
    return this._gbufData;
  }

  /**
   * E-387: the columns a keyed frame's pack writes the instances' G-buffer words from, the words gbufWord.js
   * writeGbufWords writes from the queue's key column: SpriteRenderer.gbufFlags (its length is the entity count),
   * ShadowCaster.selfShadow and, where the painter orders by zIndex, SpriteRenderer.zIndex (null: none). Handed before
   * the upload: one drawn keyed with them sets gbufPacked, and commitGbuf(packedGbuf, count) takes its words; any other
   * frame leaves them to the caller.
   * @param {Uint8Array|null} flags
   * @param {Uint8Array|null} selfShadow
   * @param {Int16Array|null} zIndex
   */
  setGbufColumns(flags, selfShadow, zIndex) {
    const k = this._keyedPack;
    k.gbufFlags = flags || NO_GBUF_U8;
    k.gbufSelf = selfShadow || NO_GBUF_U8;
    k.gbufZ = zIndex || NO_GBUF_I16;
  }

  /** E-387: the words the last upload's keyed pack wrote, in draw order (read them while gbufPacked says so). */
  get packedGbuf() {
    return this._sharedGbuf;
  }

  /** E-191: the sun's pass over a ring slot's keyed instances: the shadow program's attributes and no other. */
  _keyedShadowGeometryFor(buf, slotBuf, shadowBuf) {
    const ds = this._floats * 4;
    const geometry = new Geometry({
      attributes: {
        aQuad: { buffer: this._quad, format: 'float32x2' },
        aInstXY: { buffer: buf, format: 'float32x2', stride: ds, offset: 0, instance: true },
        aInstRotCS: { buffer: buf, format: 'float32x2', stride: ds, offset: 8, instance: true },
        aInstSlot: { buffer: slotBuf, format: 'float32', stride: GPU_INDEXED_SLOT_FLOATS * 4, offset: 0, instance: true },
        aInstShadow: { buffer: shadowBuf, format: 'float32x3', stride: 12, offset: 0, instance: true },
      },
      indexBuffer: this._index,
    });
    geometry.instanceCount = 0;
    return geometry;
  }

  _geometryFor(buf, staticBuf) {
    if (this._twoStreams) {
      // E-82: the pose stream (24-byte stride) and the static stream (44). E-82b, a split batch: a 16-byte
      // pose whose previous xy is the current one (the pose shader's mix at uPoseAlpha 1 gives it back).
      const ds = this._floats * 4;
      const ss = POSE_STATIC_FLOATS * 4;
      const geometry = new Geometry({
        attributes: {
          aQuad: { buffer: this._quad, format: 'float32x2' },
          aInstXY: { buffer: buf, format: 'float32x2', stride: ds, offset: 0, instance: true },
          aInstRotCS: { buffer: buf, format: 'float32x2', stride: ds, offset: 8, instance: true },
          aInstPrevXY: { buffer: buf, format: 'float32x2', stride: ds, offset: this.poseInterp ? 16 : 0, instance: true },
          aInstScale: { buffer: staticBuf, format: 'float32x2', stride: ss, offset: 0, instance: true },
          aInstAnchor: { buffer: staticBuf, format: 'float32x2', stride: ss, offset: 8, instance: true },
          aInstDepth: { buffer: staticBuf, format: 'float32', stride: ss, offset: 16, instance: true },
          aInstTintBits: { buffer: staticBuf, format: 'float32', stride: ss, offset: 20, instance: true },
          aInstTexId: { buffer: staticBuf, format: 'float32', stride: ss, offset: 24, instance: true },
          aInstTileInv: { buffer: staticBuf, format: 'float32x2', stride: ss, offset: 28, instance: true },
          aInstTileOff: { buffer: staticBuf, format: 'float32x2', stride: ss, offset: 36, instance: true },
        },
        indexBuffer: this._index,
      });
      geometry.instanceCount = 0;
      return geometry;
    }
    const stride = this._strideBytes;
    const attributes = {
      aQuad: { buffer: this._quad, format: 'float32x2' },
      aInstXY: { buffer: buf, format: 'float32x2', stride, offset: 0, instance: true },
      aInstScale: { buffer: buf, format: 'float32x2', stride, offset: 8, instance: true },
      aInstAnchor: { buffer: buf, format: 'float32x2', stride, offset: 16, instance: true },
      aInstRotCS: { buffer: buf, format: 'float32x2', stride, offset: 24, instance: true },
      aInstDepth: { buffer: buf, format: 'float32', stride, offset: 32, instance: true },
      aInstTintBits: { buffer: buf, format: 'float32', stride, offset: 36, instance: true },
      aInstTexId: { buffer: buf, format: 'float32', stride, offset: 40, instance: true },
      aInstTileInv: { buffer: buf, format: 'float32x2', stride, offset: 44, instance: true },
      aInstTileOff: { buffer: buf, format: 'float32x2', stride, offset: 52, instance: true },
    };
    if (this.shadowCast) {
      attributes.aInstShadow = { buffer: buf, format: 'float32x3', stride, offset: 60, instance: true };
      attributes.aInstLight = { buffer: buf, format: 'float32x4', stride, offset: 72, instance: true };
    }
    const geometry = new Geometry({ attributes, indexBuffer: this._index });
    geometry.instanceCount = 0;
    return geometry;
  }

  _indexedGeometryFor(buf, slotBuf) {
    const ds = this._floats * 4;
    const geometry = new Geometry({
      attributes: {
        aQuad: { buffer: this._quad, format: 'float32x2' },
        aInstXY: { buffer: buf, format: 'float32x2', stride: ds, offset: 0, instance: true },
        aInstRotCS: { buffer: buf, format: 'float32x2', stride: ds, offset: 8, instance: true },
        aInstSlot: { buffer: slotBuf, format: 'float32', stride: GPU_INDEXED_SLOT_FLOATS * 4, offset: 0, instance: true },
      },
      indexBuffer: this._index,
    });
    geometry.instanceCount = 0;
    return geometry;
  }

  /** E-201: a by-row keyed frame's geometry: each instance's queue row (aInstRow) and slot (aInstSlot). */
  _rowGeometryFor(buf, slotBuf) {
    const geometry = new Geometry({
      attributes: {
        aQuad: { buffer: this._quad, format: 'float32x2' },
        aInstRow: { buffer: buf, format: 'float32', stride: 4, offset: 0, instance: true },
        aInstSlot: { buffer: slotBuf, format: 'float32', stride: GPU_INDEXED_SLOT_FLOATS * 4, offset: 0, instance: true },
      },
      indexBuffer: this._index,
    });
    geometry.instanceCount = 0;
    return geometry;
  }

  /** E-201: the sun's pass over a by-row keyed frame: its rows, slots and shadow terms. */
  _keyedShadowRowGeometryFor(buf, slotBuf, shadowBuf) {
    const geometry = new Geometry({
      attributes: {
        aQuad: { buffer: this._quad, format: 'float32x2' },
        aInstRow: { buffer: buf, format: 'float32', stride: 4, offset: 0, instance: true },
        aInstSlot: { buffer: slotBuf, format: 'float32', stride: GPU_INDEXED_SLOT_FLOATS * 4, offset: 0, instance: true },
        aInstShadow: { buffer: shadowBuf, format: 'float32x3', stride: 12, offset: 0, instance: true },
      },
      indexBuffer: this._index,
    });
    geometry.instanceCount = 0;
    return geometry;
  }

  /** E-201: the pose texture (made here) and the keyed program that reads it by queue row (WebGL). */
  _makeRowShader(name) {
    // DX-FACEDEPTH: made once; the programs made again (setDepthFaces) keep the texture.
    if (this._poseSource === null) {
      this._poseSource = this._statics.make(this._poseRowsU32, POSE_TEX_TEXELS, this._poseTexRows * 4, `${name}-poses`);
    }
    const shaders = this._engineShaders;
    const rowSource = spriteIndexedVertex(shaders.spriteVert, { poseBlock: this._poseBlock });
    const rowBase = this._depthVertex(rowSource, 'flat');
    // E-448: with the opaque pass, at the painter's depth (its own draw slot), which the pass's twin writes.
    this._colorRowVertex = this._opWanted && rowBase ? rowBase : '';
    const rowVertex = this._colorRowVertex !== '' ? opaqueRowVertex(rowBase, false) : rowBase;
    const color = pickInstancedSpriteFragmentGlsl(this._premultiplyAlpha, shaders);
    const glProgram = glProgramFrom(GlProgram, rowVertex, this._depthFragment(color), `${name}-rows`);
    const r = this.shader.resources;
    const resources = {
      uTexture: r.uTexture,
      uSampler: r.uSampler,
      uTexLut: r.uTexLut,
      uniforms: r.uniforms,
      uStatics: this._staticsSource,
      uPoses: this._poseSource,
    };
    if (this._pixelDepth) {
      resources.uMaps = this._pixelDepth.maps;
      resources.uMapsLut = this._mapsTable;
    }
    const shader = new Shader({ glProgram, resources });
    if (this._pixelDepth) {
      const edgeRowVertex = this._depthFaces || this._pixelDepth.plainEdge === true ? this._depthVertex(rowSource, 'edge') : rowVertex;
      this._edgeRowShader = new Shader({
        glProgram: glProgramFrom(GlProgram, edgeRowVertex, this._depthFragment(color, true), `${name}-rows-edge`),
        resources: this._edgeResources(shader, this._staticsSource),
      });
      this._vdepthRowShader = this._vdepthTwin(rowSource, color, shader, this._staticsSource, `${name}-rows-vdepth`);
    }
    return shader;
  }

  /**
   * DX-DEPTH: a colour program's vertex shader, with the floor depth's terms when pixel depth is on. DX-FACEDEPTH: with
   * faces, `cull` picks the instances of one of the opaque pass's two programs (pixelDepth.js cullGlsl).
   */
  _depthVertex(source, cull = 'none') {
    if (this._pixelDepth && source) {
      // E-378: 'edge' is the edge pass's (every instance, as 'none', less the plain full-alpha ones a nearest atlas lets
      // it leave out).
      const edge = cull === 'edge';
      return pixelDepthVertex(source, {
        gbuf: this.gbuf,
        faces: this._depthFaces,
        cull: this._depthFaces && !edge ? cull : 'none',
        plainEdge: edge && this._pixelDepth.plainEdge === true,
      });
    }
    // DX-GBUF: a batch with words has every geometry carry them; the program takes them, read or not (gbufAttributeGlsl).
    return this.gbuf && source ? gbufAttributeGlsl(source) : source;
  }

  /** DX-DEPTH: a colour program's fragment shader, writing the floor depth when pixel depth is on. */
  _depthFragment(source, edge = false) {
    return this._pixelDepth && source ? pixelDepthFragment(source, { edge, gbuf: this.gbuf, faces: this._depthFaces }) : source;
  }

  /**
   * DX-FACEDEPTH (E-378, WebGL): the opaque pass's vertex-depth twin of a colour program (its vertex shader before the
   * depth's `base`, its colour fragment), the instances without heights, over the colour program's resources; null
   * without faces.
   */
  _vdepthTwin(base, color, shader, statics, name) {
    if (!this._depthFaces || !base || !color) return null;
    return new Shader({
      glProgram: glProgramFrom(
        GlProgram,
        this._depthVertex(base, 'heights'),
        pixelDepthFragment(color, { gbuf: this.gbuf, vertexDepth: true }),
        name,
      ),
      resources: this._edgeResources(shader, statics),
    });
  }

  /**
   * DX-FACEDEPTH: the depth programs read faces (a decoration carries a normal: the caller's "faces in use" signal), or no
   * longer do. The colour programs, their edge and vertex-depth twins are made again; the meshes take them. Only with
   * pixel depth. Returns whether anything changed.
   * @param {boolean} on
   */
  setDepthFaces(on) {
    const want = on === true;
    if (this._pixelDepth === null || want === this._depthFaces) return false;
    this._depthFaces = want;
    this._rebuildDepthPrograms();
    return true;
  }

  /**
   * DX-FACEDEPTH: pixel depth turned on after the batch was made (faces in an oblique scene without a map sheet): the
   * colour programs write the floor depth, the opaque pass of E-448 goes, the batch's mesh tests and writes depth, and the
   * edge mesh is made (the caller puts it, and vdepthMesh, in the scene: InstancedSpriteBatch.pixelDepthMeshes).
   * @param {import('../vendor/pixi.min.js').TextureSource} maps the twin page, or an empty one
   * @param {boolean} [faces] read faces too (setDepthFaces)
   * @returns {boolean} whether it turned on now
   */
  enablePixelDepth(maps, faces = false) {
    if (this._pixelDepth !== null || !maps) return false;
    this._pixelDepth = { maps };
    this.pixelDepthOn = true;
    this._depthFaces = faces === true;
    this.dropOpaquePass();
    this._opWanted = false;
    this.opaqueOn = false;
    this._blendState.depthTest = true;
    this._blendState.depthMask = true;
    this._rebuildDepthPrograms();
    return true;
  }

  /** DX-FACEDEPTH: the colour programs (plain, indexed, by row) made again as the depth now asks, the meshes on them. */
  _rebuildDepthPrograms() {
    // N-274, N-266: the G-buffer's and the unshaded passes are made again on their next use, with the depth or without.
    this._aux[AUX_GBUF] = { meshes: [], state: null, shader: null, indexed: null, row: null };
    this._aux[AUX_UNSHADED] = { meshes: [], state: null, shader: null, indexed: null, row: null };
    this._aux[AUX_UNSHADED_EDGE] = { meshes: [], state: null, shader: null, indexed: null, row: null };
    const r = this.shader.resources;
    const wasRow = this._rowShader !== null && this.mesh.shader === this._rowShader;
    const wasIndexed = this._indexedShader !== null && this.mesh.shader === this._indexedShader;
    this._edgeShader = null;
    this._vdepthShader = null;
    this.shader = this._makeSpriteShader(r.uTexture, r.uTexLut, this._label);
    if (this.indexed) this._indexedShader = this._makeIndexedShader(this._label);
    if (this.posesByRow) this._rowShader = this._makeRowShader(this._label);
    this.mesh.shader = wasRow ? this._rowShader : wasIndexed ? this._indexedShader : this.shader;
    if (this.edgeMesh === null && this._edgeShader !== null) this.edgeMesh = this._depthTwinMesh(this._edgeShader, false, 'edge');
    if (this.vdepthMesh === null && this._vdepthShader !== null) this.vdepthMesh = this._depthTwinMesh(this._vdepthShader, true, 'vdepth');
    this._pointDepthTwins();
  }

  /**
   * DX-DEPTH: a mesh over the batch's geometry for one of its depth twins: the edge pass (blended as the batch, depth
   * tested, not written) or, `writes`, the opaque pass's vertex-depth one (depth tested and written).
   */
  _depthTwinMesh(shader, writes, what) {
    const state = new State();
    state.blend = true;
    state.blendMode = this.mesh.state.blendMode;
    state.depthTest = true;
    state.depthMask = writes;
    state.culling = false;
    const mesh = new Mesh({ geometry: this.geometry, shader, state, label: `${this._label}-${what}` });
    mesh.blendMode = state.blendMode;
    mesh.cullable = false;
    mesh.visible = this.mesh.visible;
    return mesh;
  }

  /** DX-FACEDEPTH: the edge and vertex-depth meshes on the twins of the batch's mesh's program and on its geometry. */
  _pointDepthTwins() {
    const geometry = this.mesh.geometry;
    const edge = this.edgeMesh;
    if (edge !== null) {
      const edgeShader = this.edgeShaderFor(this.mesh.shader);
      if (edgeShader !== null && edge.shader !== edgeShader) edge.shader = edgeShader;
      if (edge.geometry !== geometry) edge.geometry = geometry;
    }
    const vdepth = this.vdepthMesh;
    if (vdepth !== null) {
      const vdepthShader = this.vdepthShaderFor(this.mesh.shader);
      if (vdepthShader === null) {
        vdepth.visible = false;
      } else {
        if (vdepth.shader !== vdepthShader) vdepth.shader = vdepthShader;
        if (vdepth.geometry !== geometry) vdepth.geometry = geometry;
      }
    }
  }

  /**
   * DX-FACEDEPTH: the meshes pixel depth adds to the batch's own, in the order they draw: the vertex-depth opaque one before
   * it (null without faces), the edge pass after it.
   * @returns {{ before: Mesh|null, after: Mesh|null }}
   */
  pixelDepthMeshes() {
    return { before: this.vdepthMesh, after: this.edgeMesh };
  }

  /**
   * DX-DEPTH: this frame's floor depth terms (pixelDepth.js pixelDepthTerms): the camera's foreshortening and the view's
   * floor span.
   */
  setPixelDepthTerms(floorScaleY, heightScaleY, viewTopY, viewHeight) {
    if (this._pixelDepth === null) return;
    pixelDepthTerms(this._depthTerms, floorScaleY, heightScaleY, viewTopY, viewHeight);
    const group = this.shader && this.shader.resources && this.shader.resources.uniforms;
    if (group && typeof group.update === 'function') group.update();
    // N-274: the G-buffer's depth reads the view's terms from uFaceSpace.
    const faceSpace = this._faceSpace;
    if (faceSpace[2] !== this._depthTerms[2] || faceSpace[3] !== this._depthTerms[3]) {
      faceSpace[2] = this._depthTerms[2];
      faceSpace[3] = this._depthTerms[3];
      const groups = this._faceGroups;
      for (let i = 0; i < groups.length; i++) groups[i].update();
    }
  }

  /**
   * N-274: whether the G-buffer's one pass (gbufMesh) tests and writes pixel depth, as the colour pass does: its render
   * target needs a depth attachment then.
   * @returns {boolean}
   */
  get gbufDepthOn() {
    return this._pixelDepth !== null;
  }

  /**
   * E-201: the queue's pose columns for its first `rows` rows into the pose texture: each column copied whole into its
   * block, then the texture rows those rows reach, block by block.
   */
  _uploadPoseRows(q, rows) {
    const n = rows < this._poseBlock ? rows : this._poseBlock;
    if (n <= 0) return;
    const blocks = this._poseRowBlocks;
    this.copyIn(blocks[0], q.x, n);
    this.copyIn(blocks[1], q.y, n);
    this.copyIn(blocks[2], q.rotC, n);
    this.copyIn(blocks[3], q.rotS, n);
    const texRows = Math.ceil(n / POSE_ROW_FLOATS);
    const tr = this._poseTexRows;
    for (let b = 0; b < 4; b++) {
      this._statics.upload(this._poseSource, this._poseRowsU32, POSE_TEX_TEXELS, tr * 4, b * tr, texRows);
    }
  }

  _makeSpriteShader(atlas, lut, name) {
    const uniforms = {
      uTileWorld: { value: this._tileWorld, type: 'vec4<f32>' },
    };
    if (this._twoStreams) {
      // Number, not Float32Array. Pixi's WebGL f32 sync compares the value
      // with !==. The same array never looks changed, so the GPU stays at 0.
      // A split batch keeps 1 (setPoseAlpha leaves it).
      uniforms.uPoseAlpha = { value: 1, type: 'f32' };
    }
    if (this._pixelDepth) uniforms.uDepth = { value: this._depthTerms, type: 'vec4<f32>' };
    // E-448: the painter's depth step of a by-row keyed frame (opaquePass.js opaqueRowVertex), 1 / denom.
    if (this._opWanted && this.posesByRow) uniforms.uOpDepth = { value: 1 / (this.capacity + 1), type: 'f32' };
    const resources = {
      uTexture: atlas,
      uSampler: atlas.style,
      uTexLut: lut,
      uniforms,
    };
    if (this._pixelDepth) {
      resources.uMaps = this._pixelDepth.maps;
      resources.uMapsLut = this._mapsTable;
    }
    let fragEntry = 'mainFragAdd';
    if (this._premultiplyAlpha) {
      fragEntry = 'mainFrag';
    }
    const shaders = this._engineShaders;
    const spriteSource = this._twoStreams ? shaders?.spritePose : shaders?.sprite;
    const vertSource = this._twoStreams ? shaders?.spriteVertPose : shaders?.spriteVert;
    if (this._useWebGpu) {
      // DX-DEPTH: the sprite WGSL writing the floor depth, uDepth after the group's other entries (as `uniforms` lists
      // them), the twin page as binding 5.
      const depth = this._pixelDepth !== null && !!spriteSource;
      // DX-GBUF: the words' stream is in every geometry of a batch with words, so its programs declare it.
      const source = this.gbuf && spriteSource ? gbufAttributeWgsl(spriteSource) : spriteSource;
      const faces = this._depthFaces;
      // E-378: the edge program's module of its own when its vertex culls (a nearest atlas) or runs over every instance.
      const plainEdge = this._pixelDepth?.plainEdge === true;
      const depthOf = (cull, edge = false) => pixelDepthWgsl(source, { gbuf: this.gbuf, faces, cull, plainEdge: edge && plainEdge });
      const program = depth ? depthOf(faces ? 'flat' : 'none') : source;
      const gpuProgram = instancedSpriteGpuProgram(GpuProgram, program, fragEntry, name, { maps: depth });
      const shader = new Shader({ gpuProgram, resources });
      if (depth) {
        // DX-DEPTH (F5 v2): the edge pass's entry (pixelDepthWgsl's <entry>Edge) over the same group; with faces, over every
        // instance (the opaque program keeps the frames with heights).
        this._edgeShader = new Shader({
          gpuProgram: instancedSpriteGpuProgram(GpuProgram, faces || plainEdge ? depthOf('none', true) : program, `${fragEntry}Edge`, `${name}-edge`, { maps: true }),
          resources: this._edgeResources(shader, null),
        });
        // DX-FACEDEPTH (E-378): the opaque pass's vertex-depth twin.
        this._vdepthShader = faces
          ? new Shader({
              gpuProgram: instancedSpriteGpuProgram(GpuProgram, depthOf('heights'), fragEntry, `${name}-vdepth`, { maps: true }),
              resources: this._edgeResources(shader, null),
            })
          : null;
      }
      return shader;
    }
    let vert = vertSource;
    if (this.shadowCast && vert) {
      vert = vert
        .replace('in vec2 aInstTileOff;\n', 'in vec2 aInstTileOff;\nin vec3 aInstShadow;\n')
        .replace(
          'gl_Position = vec4(clip.xy, aInstDepth, 1.0);',
          'gl_Position = vec4(clip.xy, aInstDepth, 1.0);\n  if (aInstShadow.x < -1000.0) gl_Position.x += aInstShadow.y + aInstShadow.z;'
        );
    }
    const color = pickInstancedSpriteFragmentGlsl(this._premultiplyAlpha, shaders);
    let frag = color;
    const depth = !!(this._pixelDepth && vert && frag);
    // DX-GBUF: without pixel depth the colour program reads no words, yet the batch's geometry carries them.
    if (!depth && this.gbuf && vert) vert = gbufAttributeGlsl(vert);
    const baseVert = vert;
    if (depth) {
      vert = this._depthVertex(baseVert, this._depthFaces ? 'flat' : 'none');
      frag = this._depthFragment(frag);
    }
    this._colorVertex = vert || '';
    this._colorFragment = frag || '';
    const glProgram = glProgramFrom(GlProgram, vert, frag, name);
    const shader = new Shader({ glProgram, resources });
    if (depth) {
      // DX-DEPTH (F5 v2): the edge pass's twin, the same vertex shader (with faces, over every instance).
      const edgeVert = this._depthFaces || this._pixelDepth.plainEdge === true ? this._depthVertex(baseVert, 'edge') : vert;
      this._edgeShader = new Shader({
        glProgram: glProgramFrom(GlProgram, edgeVert, this._depthFragment(color, true), `${name}-edge`),
        resources: this._edgeResources(shader, null),
      });
      this._vdepthShader = this._vdepthTwin(baseVert, color, shader, null, `${name}-vdepth`);
    }
    return shader;
  }

  /**
   * DX-DEPTH (F5 v2): an edge program's resources, its colour twin's (the atlas, the LUT, the uniform group, the twin page;
   * `statics`: the statics, and the poses of a by-row one).
   */
  _edgeResources(shader, statics) {
    const r = shader.resources;
    const out = { uTexture: r.uTexture, uSampler: r.uSampler, uTexLut: r.uTexLut, uniforms: r.uniforms };
    if (this._pixelDepth) {
      out.uMaps = this._pixelDepth.maps;
      out.uMapsLut = this._mapsTable;
    }
    if (statics !== null) {
      out.uStatics = statics;
      if (r.uPoses) out.uPoses = r.uPoses;
    }
    return out;
  }

  /**
   * E-162: where the statics go, and the indexed program (spriteIndexed.js: the plain sprite vertex shader reading
   * them by row) over the split program's resources and uniform group. WebGL: a texture made at its full height;
   * WebGPU: a read-only storage buffer over the same copy.
   */
  _makeIndexedShader(name) {
    if (this._useWebGpu) return this._makeIndexedGpuShader(name);
    const width = STATICS_TEX_ROW * STATICS_TEXELS_PER_ROW;
    const height = staticsTextureHeight(this._rowStatics.length / GPU_INDEXED_STATIC_FLOATS);
    const max = this._statics.maxSize | 0;
    if (width > max || height > max) {
      throw new Error(
        `WeedJS: renderer.indexedSprites needs a ${width} x ${height} texture for ${this.capacity} sprites, and this GPU ` +
          `allows ${max} texels a side: turn the option off or lower renderer.maxVisibleRenderables.`
      );
    }
    this._staticsHeight = height;
    // DX-FACEDEPTH: made once; the programs made again (setDepthFaces) keep the texture and what it holds.
    if (this._staticsSource === null) this._staticsSource = this._statics.make(this._rowStaticsU32, width, height, `${name}-statics`);
    const shaders = this._engineShaders;
    const indexedBase = shaders?.spriteVert ? spriteIndexedVertex(shaders.spriteVert) : null;
    const indexedVertex = this._depthVertex(indexedBase, 'flat');
    const color = pickInstancedSpriteFragmentGlsl(this._premultiplyAlpha, shaders);
    const glProgram = glProgramFrom(GlProgram, indexedVertex, this._depthFragment(color), `${name}-indexed`);
    const r = this.shader.resources;
    const resources = {
      uTexture: r.uTexture,
      uSampler: r.uSampler,
      uTexLut: r.uTexLut,
      uniforms: r.uniforms,
      uStatics: this._staticsSource,
    };
    if (this._pixelDepth) {
      resources.uMaps = this._pixelDepth.maps;
      resources.uMapsLut = this._mapsTable;
    }
    const shader = new Shader({ glProgram, resources });
    if (this._pixelDepth && indexedVertex) {
      this._edgeIndexedShader = new Shader({
        glProgram: glProgramFrom(GlProgram, this._depthVertex(indexedBase, 'edge'), this._depthFragment(color, true), `${name}-indexed-edge`),
        resources: this._edgeResources(shader, this._staticsSource),
      });
      this._vdepthIndexedShader = this._vdepthTwin(indexedBase, color, shader, this._staticsSource, `${name}-indexed-vdepth`);
    }
    return shader;
  }

  _makeIndexedGpuShader(name) {
    const bytes = this._rowStatics.byteLength;
    const max = this._statics.maxStorageBytes || 0;
    if (bytes > max) {
      throw new Error(
        `WeedJS: renderer.indexedSprites needs a storage buffer of ${bytes} bytes for ${this.capacity} sprites, and this ` +
          `GPU binds ${max}: turn the option off or lower renderer.maxVisibleRenderables.`
      );
    }
    // DX-FACEDEPTH: made once; the programs made again (setDepthFaces) keep the buffer and what it holds.
    if (this._staticsSource === null) {
      this._staticsSource = new Buffer({
        data: this._rowStatics,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
        label: `${name}-statics`,
      });
      // E-187: a keyed batch's statics live on the GPU alone (its scatter's compute pass writes them; this copy stays at
      // zeros): Pixi must never make the buffer again from it, as its resource GC would after a minute undrawn.
      if (this.keyed) this._staticsSource.autoGarbageCollect = false;
    }
    const shaders = this._engineShaders;
    // DX-DEPTH: over the split program's group, which holds uPoseAlpha before uDepth (the plain WGSL reads neither).
    const depth = this._pixelDepth !== null && !!shaders?.sprite;
    const plainSource = shaders?.sprite && this.gbuf ? gbufAttributeWgsl(shaders.sprite) : shaders?.sprite;
    const indexedSource = plainSource ? spriteIndexedWgsl(plainSource) : null;
    const faces = this._depthFaces;
    // E-378: the edge program's module of its own when its vertex culls (a nearest atlas) or runs over every instance.
    const plainEdge = this._pixelDepth?.plainEdge === true;
    const depthOf = (cull, edge = false) =>
      pixelDepthWgsl(indexedSource, { poseAlpha: this._twoStreams, gbuf: this.gbuf, faces, cull, plainEdge: edge && plainEdge });
    const program = depth ? depthOf(faces ? 'flat' : 'none') : indexedSource;
    const entry = this._premultiplyAlpha ? 'mainFrag' : 'mainFragAdd';
    const gpuProgram = instancedSpriteIndexedGpuProgram(GpuProgram, program, entry, `${name}-indexed`, { maps: depth });
    const r = this.shader.resources;
    const resources = {
      uTexture: r.uTexture,
      uSampler: r.uSampler,
      uTexLut: r.uTexLut,
      uniforms: r.uniforms,
      uStatics: this._staticsSource,
    };
    if (depth) {
      resources.uMaps = this._pixelDepth.maps;
      resources.uMapsLut = this._mapsTable;
    }
    const shader = new Shader({ gpuProgram, resources });
    if (depth) {
      this._edgeIndexedShader = new Shader({
        gpuProgram: instancedSpriteIndexedGpuProgram(GpuProgram, faces || plainEdge ? depthOf('none', true) : program, `${entry}Edge`, `${name}-indexed-edge`, { maps: true }),
        resources: this._edgeResources(shader, this._staticsSource),
      });
      this._vdepthIndexedShader = faces
        ? new Shader({
            gpuProgram: instancedSpriteIndexedGpuProgram(GpuProgram, depthOf('heights'), entry, `${name}-indexed-vdepth`, { maps: true }),
            resources: this._edgeResources(shader, this._staticsSource),
          })
        : null;
    }
    return shader;
  }

  /**
   * E-448: the opaque pass (opaquePass.js): its rows and a buffer of them a ring slot, each with a geometry (the statics as
   * the batch's own geometry reads them, the painter slot), the pose texture the pose buffer is copied into, its program
   * (opaqueVertex and opaqueFragment over the colour program's sources) over the colour program's resources and uniform
   * group, unblended with the depth tested and written, the step that copies the poses before it, and the depth-testing
   * twin of the batch's own state.
   */
  _makeOpaquePass(name, textures) {
    const cap = this.capacity;
    const poseWords = this._floats;
    this._opRows = new Float32Array(cap * OPAQUE_ROW_FLOATS);
    this._opRowsU32 = new Uint32Array(this._opRows.buffer);
    const buffer = (label) => new Buffer({ data: this._opRows, usage: this._vertexUsage, label });
    this._opBuffers = [buffer(`${name}-opaque`), buffer(`${name}-opaque-ring`)];
    const stride = OPAQUE_ROW_FLOATS * 4;
    this._opGeometries = this._opBuffers.map((buf) => {
      const geometry = new Geometry({
        attributes: {
          aQuad: { buffer: this._quad, format: 'float32x2' },
          aInstScale: { buffer: buf, format: 'float32x2', stride, offset: 0, instance: true },
          aInstAnchor: { buffer: buf, format: 'float32x2', stride, offset: 8, instance: true },
          aInstDepth: { buffer: buf, format: 'float32', stride, offset: 16, instance: true },
          aInstTintBits: { buffer: buf, format: 'float32', stride, offset: 20, instance: true },
          aInstTexId: { buffer: buf, format: 'float32', stride, offset: 24, instance: true },
          aInstTileInv: { buffer: buf, format: 'float32x2', stride, offset: 28, instance: true },
          aInstTileOff: { buffer: buf, format: 'float32x2', stride, offset: 36, instance: true },
          aInstSlot: { buffer: buf, format: 'float32', stride, offset: POSE_STATIC_FLOATS * 4, instance: true },
        },
        indexBuffer: this._index,
      });
      geometry.instanceCount = 0;
      return geometry;
    });
    this._opTextures = textures;
    this._opPoseRows = opaquePoseTextureRows(cap, poseWords);
    this._opPoseSource = textures.make(new Uint32Array(OPAQUE_POSE_TEXELS * 4 * this._opPoseRows), OPAQUE_POSE_TEXELS,
      this._opPoseRows, `${name}-opaque-poses`);
    const r = this.shader.resources;
    this._opShader = new Shader({
      glProgram: glProgramFrom(GlProgram, opaqueVertex(this._colorVertex, poseWords), opaqueFragment(this._colorFragment),
        `${name}-opaque`),
      resources: { uTexture: r.uTexture, uSampler: r.uSampler, uTexLut: r.uTexLut, uniforms: r.uniforms, uOpPoses: this._opPoseSource },
    });
    if (this._rowShader !== null && this._colorRowVertex !== '') {
      // A by-row keyed frame's: its rows read their pose from the queue's columns (uPoses) and their statics by key
      // (uStatics), as the batch's by-row program does, at the draw slot each carries.
      this._opKeyedRows = new Float32Array(cap * OPAQUE_KEYED_ROW_FLOATS);
      const keyedBuffer = (label) => new Buffer({ data: this._opKeyedRows, usage: this._vertexUsage, label });
      this._opKeyedBuffers = [keyedBuffer(`${name}-opaque-rows`), keyedBuffer(`${name}-opaque-rows-ring`)];
      const ks = OPAQUE_KEYED_ROW_FLOATS * 4;
      this._opKeyedGeometries = this._opKeyedBuffers.map((buf) => {
        const geometry = new Geometry({
          attributes: {
            aQuad: { buffer: this._quad, format: 'float32x2' },
            aInstRow: { buffer: buf, format: 'float32', stride: ks, offset: 0, instance: true },
            aInstSlot: { buffer: buf, format: 'float32', stride: ks, offset: 4, instance: true },
            aInstPainter: { buffer: buf, format: 'float32', stride: ks, offset: 8, instance: true },
          },
          indexBuffer: this._index,
        });
        geometry.instanceCount = 0;
        return geometry;
      });
      const rr = this._rowShader.resources;
      this._opRowShader = new Shader({
        glProgram: glProgramFrom(GlProgram, opaqueRowVertex(this._colorRowVertex, true), opaqueFragment(this._colorFragment),
          `${name}-opaque-rows`),
        resources: {
          uTexture: rr.uTexture, uSampler: rr.uSampler, uTexLut: rr.uTexLut, uniforms: rr.uniforms, uStatics: rr.uStatics, uPoses: rr.uPoses,
        },
      });
    }
    const opaque = new State();
    opaque.blend = false;
    opaque.depthTest = true;
    opaque.depthMask = true;
    opaque.culling = false;
    this.opaqueMesh = new Mesh({ geometry: this._opGeometries[0], shader: this._opShader, state: opaque, label: `${name}-opaque` });
    this.opaqueMesh.cullable = false;
    this.opaqueHost = new Container();
    this.opaqueHost.label = `${name}-opaque-pass`;
    // E-448: the opaque pass's step before its mesh, where the mesh's draw is: this frame's poses into the pass's pose
    // texture (_copyOpaquePoses), on the GPU.
    this.opaqueHost.addChild(new RenderStep('weed-opaque-poses', (renderer) => this._copyOpaquePoses(renderer)));
    this.opaqueHost.addChild(this.opaqueMesh);
    this.opaqueHost.visible = false;
    const tested = new State();
    tested.blend = true;
    tested.blendMode = this._blendState.blendMode;
    tested.depthTest = true;
    tested.depthMask = false;
    tested.culling = false;
    this._depthState = tested;
    this.opaqueOn = true;
  }

  /**
   * E-448: what each textureId's frame's texels hold (textureLutTexels of the LUT this batch draws with), which the opaque
   * pass reads to choose its rows; an empty table (or none) keeps every row out. With `solid` (textureLutSolid), each
   * frame's solid texels, by which a frame's rows say whether the pass pays (setOpaqueView).
   * @param {Uint8Array|null} texels
   * @param {Float32Array|null} [solid]
   */
  setFrameTexels(texels, solid = null) {
    this._opTexels = texels instanceof Uint8Array ? texels : new Uint8Array(0);
    this._opArea = solid instanceof Float32Array ? solid : new Float32Array(0);
    this._opTexelsVersion++;
  }

  /**
   * E-448: the view the next frames are drawn at: the world's px to the target's (the camera's zoom times the resolution)
   * and the target's pixels. The opaque pass draws a frame when its rows cover enough of it (opaquePass.js
   * opaquePassPays); without a view (0 pixels), whenever its rows' frames average OPAQUE_ROW_PIXELS.
   * @param {number} zoom
   * @param {number} pixels
   */
  setOpaqueView(zoom, pixels) {
    this._opZoom = zoom > 0 ? +zoom : 1;
    this._opScreen = pixels > 0 ? +pixels : 0;
  }

  /** E-448: whether the opaque pass over `rows` rows whose cover _opCover holds pays at the view (always, areas unknown). */
  _opaquePays(rows) {
    if (this._opArea.length === 0) return true;
    const z = this._opZoom;
    return opaquePassPays(this._opCover[0] * z * z, this._opScreen, rows);
  }

  /**
   * E-448: whether the opaque pass may draw from the next upload on (the caller's: a frame whose target has no depth
   * buffer, or whose painter draws other things between the batch's instances, must not).
   * @param {boolean} on
   */
  setOpaqueAllowed(on) {
    this._opAllowed = !!on;
  }

  /**
   * DBG-2: the entities layer's blend (layer.blendMode) on the batch's mesh and its edge pass; the depth twins made later
   * take it from the blend state. The opaque pass drops itself while it is not 'normal' (_commitOpaque).
   * @param {string} mode
   */
  setLayerBlend(mode) {
    this.mesh.blendMode = mode;
    this._blendState.blendMode = mode;
    if (this.edgeMesh !== null) this.edgeMesh.blendMode = mode;
  }

  /** E-448: this frame draws no opaque pass (the batch's own mesh blends every instance, untested, as without it). */
  dropOpaquePass() {
    if (this.opaqueHost === null) return;
    this.opaqueHost.visible = false;
    if (this.mesh.state !== this._blendState) this.mesh.state = this._blendState;
  }

  /**
   * E-448: the opaque pass over the `n` instances the upload just drew from ring slot _lastRing: its rows rebuilt from
   * the statics when they moved since they were built (_staticVersion), the rows did or the frames' texels did, and
   * uploaded into that ring slot's buffer when it holds older ones; the batch's own mesh testing the depth while the pass
   * draws. Its poses go into the pass's texture at render time (_copyOpaquePoses).
   * @param {number} n
   */
  _commitOpaque(n) {
    if (n <= 0 || !this._opAllowed || this.mesh.blendMode !== 'normal') {
      this.dropOpaquePass();
      return;
    }
    if (this._opBuiltStatics !== this._staticVersion || this._opBuiltRows !== n || this._opBuiltTexels !== this._opTexelsVersion) {
      this._opCount = buildOpaqueRows(this.staticData, this.staticDataU32, POSE_STATIC_FLOATS, n, this._opTexels, this._opArea,
        this._opRows, this._opRowsU32, this._opCover);
      this._opBuiltStatics = this._staticVersion;
      this._opBuiltRows = n;
      this._opBuiltTexels = this._opTexelsVersion;
      this._opVersion++;
    }
    const m = this._opCount;
    if (m <= 0 || !this._opaquePays(m)) {
      this.dropOpaquePass();
      return;
    }
    const ring = this._lastRing;
    if (this._opRingVersion[ring] !== this._opVersion) {
      this._opBuffers[ring].update(m * OPAQUE_ROW_FLOATS * 4);
      this._opRingVersion[ring] = this._opVersion;
    }
    const geometry = this._opGeometries[ring];
    geometry.instanceCount = m;
    this._showOpaque(OPAQUE_KIND_POSE, this._opShader, geometry);
  }

  /**
   * E-448: the opaque pass over a by-row keyed frame's `n` draw slots (this.data: each one's queue row, _slotData: its
   * key; `q`: the queue, whose alpha and texture columns choose the rows), built and uploaded every frame (the painter's
   * order moves), at the painter's depth step of `ctx`.
   * @param {number} n
   * @param {object} q
   * @param {object} ctx
   */
  _commitOpaqueRows(n, q, ctx) {
    if (n <= 0 || !this._opAllowed || this.mesh.blendMode !== 'normal' || this._opRowShader === null || !q.alpha || !q.textureId
      || !q.scaleX || !q.scaleY) {
      this.dropOpaquePass();
      return;
    }
    // While the pass does not pay at this view, its rows (every draw slot's) are not built every frame: the cover moves
    // slowly, so it is checked again every OPAQUE_RECHECK_FRAMES frames, or at once when the zoom or the target changes.
    // Built every frame, they cost Pixi 1.29 -> 1.71 ms a frame in Predator, where the gate keeps the pass off.
    if (this._opSkipFrames > 0 && this._opSkipZoom === this._opZoom && this._opSkipScreen === this._opScreen) {
      this._opSkipFrames--;
      this.dropOpaquePass();
      return;
    }
    const m = buildOpaqueKeyedRows(this.data, this._slotData, n, q.alpha, q.textureId, q.scaleX, q.scaleY, this._opTexels,
      this._opArea, this._opKeyedRows, this._opCover);
    if (m <= 0 || !this._opaquePays(m)) {
      this._opSkipFrames = OPAQUE_RECHECK_FRAMES;
      this._opSkipZoom = this._opZoom;
      this._opSkipScreen = this._opScreen;
      this.dropOpaquePass();
      return;
    }
    this._opSkipFrames = 0;
    const group = this.shader.resources.uniforms;
    const step = 1 / (ctx.depthDenom > 0 ? ctx.depthDenom : this.capacity + 1);
    if (group.uniforms.uOpDepth !== step) {
      group.uniforms.uOpDepth = step;
      group.update();
    }
    const ring = this._lastRing;
    this._opKeyedBuffers[ring].update(m * OPAQUE_KEYED_ROW_FLOATS * 4);
    const geometry = this._opKeyedGeometries[ring];
    geometry.instanceCount = m;
    this._showOpaque(OPAQUE_KIND_KEYED_ROWS, this._opRowShader, geometry);
  }

  /** E-448: the opaque mesh draws `geometry` with `shader` (a frame of `kind`), and the batch's own mesh tests the depth. */
  _showOpaque(kind, shader, geometry) {
    this._opKind = kind;
    const mesh = this.opaqueMesh;
    if (mesh.shader !== shader) mesh.shader = shader;
    if (mesh.geometry !== geometry) mesh.geometry = geometry;
    this.opaqueHost.visible = true;
    if (this.mesh.state !== this._depthState) this.mesh.state = this._depthState;
  }

  /**
   * E-448 (OpaquePoseStep, at render time): this frame's pose buffer (ring slot _lastRing, uploaded now if Pixi has not
   * yet) into the opaque pass's pose texture, the texture rows its rows reach, on the GPU.
   * @param {object} renderer
   */
  _copyOpaquePoses(renderer) {
    if (this.opaqueHost === null || !this.opaqueHost.visible || this._opKind !== OPAQUE_KIND_POSE) return;
    const rows = opaquePoseTextureRows(this._opBuiltRows, this._floats);
    this._opTextures.fromBuffer(renderer, this._opPoseSource, this._buffers[this._lastRing], OPAQUE_POSE_TEXELS,
      rows < this._opPoseRows ? rows : this._opPoseRows);
  }

  _show(on) {
    this.mesh.visible = on;
    if (this.edgeMesh !== null) this.edgeMesh.visible = on;
    if (this.vdepthMesh !== null) this.vdepthMesh.visible = on && this.vdepthShaderFor(this.mesh.shader) !== null;
    if (!on) this.dropOpaquePass();
  }

  /** The batch draws nothing this frame (its mesh and, with pixel depth, its edge pass hidden). */
  hide() {
    this._show(false);
  }

  /**
   * DX-DEPTH (F5 v2): the edge pass's twin of one of this batch's colour programs (the plain, the indexed or the by-row
   * one), or null without pixel depth.
   * @param {Shader} shader
   */
  edgeShaderFor(shader) {
    if (shader === this._rowShader && this._rowShader !== null) return this._edgeRowShader;
    if (shader === this._indexedShader && this._indexedShader !== null) return this._edgeIndexedShader;
    return this._edgeShader;
  }

  /** DX-FACEDEPTH: the vertex-depth twin of one of this batch's colour programs, or null without faces. */
  vdepthShaderFor(shader) {
    if (shader === this._rowShader && this._rowShader !== null) return this._vdepthRowShader;
    if (shader === this._indexedShader && this._indexedShader !== null) return this._vdepthIndexedShader;
    return this._vdepthShader;
  }

  setAtlasSource(source) {
    if (!source) return;
    this.shader.resources.uTexture = source;
    this.shader.resources.uSampler = source.style;
    const sh = this.shadowShader;
    if (sh) {
      sh.resources.uTexture = source;
      sh.resources.uSampler = source.style;
    }
    const ix = this._indexedShader;
    if (ix) {
      ix.resources.uTexture = source;
      ix.resources.uSampler = source.style;
    }
    if (this._rowShader !== null) {
      this._rowShader.resources.uTexture = source;
      this._rowShader.resources.uSampler = source.style;
    }
    for (const edge of [this._edgeShader, this._edgeIndexedShader, this._edgeRowShader, this._opShader, this._opRowShader,
      this._vdepthShader, this._vdepthIndexedShader, this._vdepthRowShader]) {
      if (edge !== null) {
        edge.resources.uTexture = source;
        edge.resources.uSampler = source.style;
      }
    }
    const aux = this._auxShaders();
    for (let i = 0; i < aux.length; i++) {
      aux[i].resources.uTexture = source;
      aux[i].resources.uSampler = source.style;
    }
    const ks = this._keyedSunShader;
    if (ks) {
      ks.resources.uTexture = source;
      ks.resources.uSampler = source.style;
    }
  }

  setLutSource(source) {
    if (!source) return;
    this.shader.resources.uTexLut = source;
    if (this.shadowShader) this.shadowShader.resources.uTexLut = source;
    if (this._indexedShader) this._indexedShader.resources.uTexLut = source;
    if (this._keyedSunShader) this._keyedSunShader.resources.uTexLut = source;
    const aux = this._auxShaders();
    for (let i = 0; i < aux.length; i++) aux[i].resources.uTexLut = source;
    if (this._rowShader !== null) this._rowShader.resources.uTexLut = source;
    for (const edge of [this._edgeShader, this._edgeIndexedShader, this._edgeRowShader, this._opShader, this._opRowShader,
      this._vdepthShader, this._vdepthIndexedShader, this._vdepthRowShader]) {
      if (edge !== null) edge.resources.uTexLut = source;
    }
  }

  /**
   * E-496: the maps table (mapsTable.js) for every program of the batch that reads the twin page: the colour programs and
   * their edge twins with pixel depth, the passes for the light.
   * @param {import('../vendor/pixi.min.js').TextureSource} source
   */
  setMapsTable(source) {
    if (!source || source === this._mapsTable) return;
    this._mapsTable = source;
    const list = [this.shader, this._indexedShader, this._rowShader, this._edgeShader, this._edgeIndexedShader, this._edgeRowShader,
      this._vdepthShader, this._vdepthIndexedShader, this._vdepthRowShader];
    for (let i = 0; i < list.length; i++) {
      const sh = list[i];
      if (sh && sh.resources.uMapsLut !== undefined) sh.resources.uMapsLut = source;
    }
    const aux = this._auxShaders();
    for (let i = 0; i < aux.length; i++) aux[i].resources.uMapsLut = source;
  }

  /** Match `_beginUpload` tileWorld when committing pre-packed rows. */
  setTargetSpace(useScreen, cameraX, cameraY, screenScale) {
    const tw = this._tileWorld;
    if (!tw) return;
    if (useScreen) {
      tw[0] = cameraX || 0;
      tw[1] = cameraY || 0;
      const s = screenScale || 1;
      tw[2] = s > 0 ? 1 / s : 1;
      tw[3] = 1;
    } else {
      tw[0] = 0;
      tw[1] = 0;
      tw[2] = 1;
      tw[3] = 0;
    }
  }

  setPoseAlpha(alpha) {
    if (!this.poseInterp) return;
    const group = this.shader?.resources?.uniforms;
    if (!group?.uniforms) return;
    group.uniforms.uPoseAlpha = alpha;
    if (typeof group.update === 'function') group.update();
  }

  /**
   * Call-level setup shared by upload() and _uploadPose(). Mutates this._uploadCtx.
   * @returns {object|null}
   */
  _beginUpload(q, opts) {
    // N-303 CR-18: the call's setup is makePackContext's (gpuQueueLayout.js; pre-render's packs use it too), on this
    // batch's own context. The batch adds the empty mesh and the tile world.
    const ctx = makePackContext(q, opts || EMPTY_UPLOAD_OPTS, this.capacity, this._uploadCtx);
    if (ctx === null) {
      this.geometry.instanceCount = 0;
      this._show(false);
      return null;
    }
    const tw = this._tileWorld;
    if (tw) {
      if (ctx.useScreen) {
        tw[0] = ctx.cameraX;
        tw[1] = ctx.cameraY;
        tw[2] = ctx.screenScale > 0 ? 1 / ctx.screenScale : 1;
        tw[3] = 1;
      } else {
        tw[0] = 0;
        tw[1] = 0;
        tw[2] = 1;
        tw[3] = 0;
      }
    }
    return ctx;
  }

  /** `indexed`: true for an indexed or keyed frame, 'rows' for a keyed frame drawn by queue row (E-201). */
  _finishUpload(out, stride, indexed = false) {
    this._drawSerial++;
    if (out <= 0) {
      this.geometry.instanceCount = 0;
      this._show(false);
      return 0;
    }
    this._show(true);
    const ring = this._ring;
    this._ring = ring ^ 1;
    this._lastRing = ring;
    const byRow = indexed === 'rows';
    const geometry = byRow ? this._rowGeometries[ring] : indexed ? this._indexedGeometries[ring] : this._geometries[ring];
    this._buffers[ring].update(out * stride);
    if (indexed) {
      // E-162: the slot stream goes up when this ring slot's copy is older than the CPU one; the statics are the
      // texture's.
      if (this._ringSlotsVersion[ring] !== this._slotsVersion) {
        this._slotBuffers[ring].update(out * GPU_INDEXED_SLOT_FLOATS * 4);
        this._ringSlotsVersion[ring] = this._slotsVersion;
      }
    } else {
      // E-82: a ring slot's static copy goes up only when it is older than the CPU one.
      const statics = this._staticBuffers;
      if (statics && this._slotStaticVersion[ring] !== this._staticVersion) {
        statics[ring].update(out * POSE_STATIC_FLOATS * 4);
        this._slotStaticVersion[ring] = this._staticVersion;
      }
    }
    if (this.indexed) {
      // E-162: the program that reads this frame's layout.
      const shader = byRow ? this._rowShader : indexed ? this._indexedShader : this.shader;
      if (this.mesh.shader !== shader) this.mesh.shader = shader;
    }
    geometry.instanceCount = out;
    this.geometry = geometry;
    this.buffer = this._buffers[ring];
    this.mesh.geometry = geometry;
    if (this.edgeMesh !== null || this.vdepthMesh !== null) this._pointDepthTwins();
    return out;
  }

  /** Upload `count` instances already written into `this.data`. */
  commitInstances(count) {
    return this._finishUpload(count | 0, this._strideBytes);
  }

  /**
   * Upload SoA views into instance buffer.
   * @param {object} q - typed array views + count
   * @param {object} [opts]
   * @param {number} [opts.space=0] - BATCH_SPACE.WORLD | SCREEN
   * @param {number} [opts.zoom=1]
   * @param {number} [opts.cameraX=0]
   * @param {number} [opts.cameraY=0]
   * @param {number} [opts.resolution=1] - RT scale (shadows/custom shader layers)
   * @param {number} [opts.depthMode=0] - painter draw order (BATCH_DEPTH.INDEX)
   * @param {number} [opts.worldHeight=1]
   * @param {Float32Array|null} [opts.texLut] - unused (LUT is a vertex texture); kept for callers
   * @param {number} [opts.texLutCount=0]
   * @param {Array|null} [opts.textures]
   * @param {Uint8Array|null} [opts.type] - render queue type (filter)
   * @param {number} [opts.includeType=-1] - only pack this type (e.g. 3 = light glow)
   * @param {number} [opts.excludeType0=-1]
   * @param {number} [opts.excludeType1=-1]
   * @param {Uint16Array|null} [opts.indices] - compact source indices (skips type filter)
   * @param {number} [opts.indexCount]
   */
  upload(q, opts) {
    this.keyedShadowReady = false;
    this.gbufPacked = false;
    this.gbufInStatics = false;
    if (this.poseInterp) return this._uploadPose(q, opts);
    if (this.split) return this._uploadSplit(q, opts);
    const ctx = this._beginUpload(q, opts);
    if (!ctx) return 0;
    // W9d, close-out group B: gpuPack.wasm packs every call into the batch's rows of the render-queue memory, then
    // they are copied into its own (E-123); the JS packer it replaced is tests/reference/gpuPackJs.mjs.
    const out = this._gpuPack !== null
      ? packInstancedRowsWasm(this._gpuPack, q, ctx, this._sharedRows, this._floats, this.capacity, this.shadowCast)
      : -1;
    if (out < 0) return this._packRefused(this._strideBytes);
    if (out > 0) this.copyIn(this.data, this._sharedRows, out * this._floats);
    return this._finishUpload(out, this._strideBytes);
  }

  /**
   * Does staticData already hold this upload's statics (E-82)? True when the queue's staticGen is
   * known and unchanged, the rows are packed densely in the same number, under the same type filter
   * and, in screen space, at the same scale. Otherwise the key is set to this upload's, for the
   * full pack that follows.
   */
  _staticsCurrent(q, ctx) {
    const genView = q.staticGen;
    const gen = genView && genView.length ? genView[0] : 0;
    const rows = ctx.scanCount | 0;
    const scale = ctx.useScreen ? ctx.screenScale : 0;
    const filter = ctx.filterTypes
      ? ((ctx.hasInclude ? ctx.includeType + 1 : 0) | ((ctx.exclude0 + 1) << 8) | ((ctx.exclude1 + 1) << 16))
      : 0;
    if (gen !== 0 && !ctx.useIndices && gen === this._stGen && rows === this._stRows
      && scale === this._stScale && filter === this._stFilter) {
      return true;
    }
    this._stGen = gen;
    this._stRows = rows;
    this._stScale = scale;
    this._stFilter = filter;
    this._staticVersion++;
    return false;
  }

  /**
   * A pose batch's upload (renderer.interpolation): the pose stream, and the statics when _staticsCurrent says the
   * GPU's are not this upload's. Through gpuPack.wasm (W9e, pack_pose), into its region of the render-queue memory and
   * then into its own arrays (E-123).
   */
  _uploadPose(q, opts) {
    const ctx = this._beginUpload(q, opts);
    if (!ctx) return 0;
    const current = this._staticsCurrent(q, ctx);
    const out = this._gpuPack !== null
      ? packPoseRowsWasm(this._gpuPack, q, ctx, this._sharedPose, current ? null : this._sharedStatic, this.capacity)
      : -1;
    if (out < 0) return this._packRefused(POSE_DYN_FLOATS * 4);
    if (out > 0) {
      this.copyIn(this.data, this._sharedPose, out * POSE_DYN_FLOATS);
      if (!current) this.copyIn(this.staticData, this._sharedStatic, out * POSE_STATIC_FLOATS);
    }
    const drawn = this._finishUpload(out, POSE_DYN_FLOATS * 4);
    if (this.opaqueOn) this._commitOpaque(drawn);
    return drawn;
  }

  /**
   * E-82b. A split batch's upload: the pose stream, and the statics when _staticsCurrent says the GPU's are
   * not this upload's. Through gpuPack.wasm (W9d); the values are a plain batch's. A split batch is a world-space
   * one with no pixel snap (a nearest atlas keeps 15-float rows) and no type filter, which the kernel takes.
   */
  _uploadSplit(q, opts) {
    const ctx = this._beginUpload(q, opts);
    if (!ctx) return 0;
    if (this.keyed) {
      const n = this._uploadKeyed(q, ctx);
      if (n >= 0) return n;
    }
    const current = this._staticsCurrent(q, ctx);
    const out = this._gpuPack !== null
      ? packSplitRowsWasm(this._gpuPack, q, ctx, this._sharedPose, current ? null : this._sharedStatic, this.capacity)
      : -1;
    if (out < 0) return this._packRefused(SPLIT_POSE_FLOATS * 4);
    if (out > 0) {
      this.copyIn(this.data, this._sharedPose, out * SPLIT_POSE_FLOATS);
      if (!current) this.copyIn(this.staticData, this._sharedStatic, out * POSE_STATIC_FLOATS);
    }
    const drawn = this._finishUpload(out, SPLIT_POSE_FLOATS * 4);
    if (this.opaqueOn) this._commitOpaque(drawn);
    return drawn;
  }

  /**
   * E-177. A keyed batch's frame: the poses and the slot pairs (each row's key and depth) in draw order, and the statics
   * of the sprites the emit marked changed and of the rows without a key, scattered into the texture by key (the statics
   * helper's scatter): 24 bytes a sprite and 64 an update, against 60 a sprite for a split frame. E-312: the marks say
   * what changed after the queue frame pre-render read from the header's DRAWN (the header's SINCE for this buffer), so
   * the texture is right after this frame whenever that is not past the last frame this batch drew keyed: a queue frame
   * it skipped, or one it drew split, loses nothing. Behind it (never with this batch's one texture) the frame is drawn
   * split. Frames whose updates outweigh their saving pause the keyed frames (KEYED_LOSS_FRAMES). Step 2: pre-render
   * leaves an unmarked row's statics unwritten while this batch draws keyed, so a buffer says whether it holds every
   * row's (COMPLETE); a pause draws split only from one that does (keyed from any other), and asks for them (FULL).
   * Returns -1 for a frame drawn split.
   */
  _uploadKeyed(q, ctx) {
    const H = this._keyHeader;
    const buf = this.keyedBuffer & 1;
    if (this._keyPause > 0) {
      this._keyPause--;
      if (Atomics.load(H, PIXI_KEYED_HEADER.COMPLETE0 + buf) !== 0) return -1;
    }
    const frame = this.keyedFrame >>> 0;
    // E-312: the frame this buffer's marks count from, against the frame the texture holds.
    const since = Atomics.load(H, PIXI_KEYED_HEADER.SINCE0 + buf) >>> 0;
    if (since > this._keyDrawn) return this._keyedMiss(H);
    const k = this._keyedPack;
    // E-201: by queue row when the batch draws so and the queue has its pose columns here.
    const byRow = this.posesByRow && !!q.x && !!q.y && !!q.rotC && !!q.rotS;
    // E-455 step 3: the words in the slots' statics where the pack can (no bands): its programs read them there.
    k.gbufStatics = this.gbuf;
    const out = byRow
      ? packKeyedRowsByRowWasm(this._gpuPack, q, ctx, this._sharedPose, this._sharedSlots, k, this.capacity)
      : packKeyedRowsWasm(this._gpuPack, q, ctx, this._sharedPose, this._sharedSlots, k, this.capacity);
    if (out < 0) return this._keyedMiss(H);
    // E-387: the words too, when it had their columns; E-455 step 3: or in the slots' statics.
    this.gbufPacked = k.gbufWritten;
    this.gbufInStatics = k.gbufInStatics === true;
    // E-312 step 2: drawn keyed again after a pause or a miss, so pre-render may skip unmarked rows' statics again.
    if (this._keyFull && this._keyPause === 0) {
      this._keyFull = false;
      Atomics.store(H, PIXI_KEYED_HEADER.FULL, 0);
    }
    // The texture holds this queue frame now (its updates scattered below); pre-render marks from it on.
    if (frame > this._keyDrawn) {
      this._keyDrawn = frame;
      Atomics.store(H, PIXI_KEYED_HEADER.DRAWN, frame);
    }
    const shadowed = this.keyedShadows && k.shadowed;
    if (shadowed && out > 0) this.copyIn(this._shadowData, this._sharedShadow, out * 3);
    const n = k.updates;
    const nt = k.texUpdates;
    if (this._keyPause > 0) {
      // A paused frame drawn keyed from a buffer that skipped statics: not counted.
    } else if (n * (GPU_KEYED_ROW_WORDS * 4) + nt * (GPU_KEYED_TEX_WORDS * 4) <= out * KEYED_SAVED_BYTES) {
      this._keyLosses = 0;
    } else if (++this._keyLosses >= KEYED_LOSS_FRAMES) {
      this._keyLosses = 0;
      this._keyPause = KEYED_PAUSE_FRAMES;
      this._keyFull = true;
      Atomics.store(H, PIXI_KEYED_HEADER.FULL, 1);
    }
    if (n > 0 || nt > 0) {
      if (n > 0) this.copyIn(this._keyUpdates, this._sharedUpdates, n * GPU_KEYED_ROW_WORDS);
      if (nt > 0) this.copyIn(this._keyTexUpdates, this._sharedTexUpdates, nt * GPU_KEYED_TEX_WORDS);
      if (this._staticsMirror.length > 0) this._mirrorKeyedStatics(n, nt);
      this._statics.scatter(
        this._staticsSource, this._keyUpdates, n, STATICS_TEX_ROW * STATICS_TEXELS_PER_ROW, this._staticsHeight,
        this._keyTexUpdates, nt,
      );
    }
    // E-191: the texture holds this queue frame's statics now; pre-render writes keyed caster rows while it is recent.
    if (this.keyedCasters) Atomics.store(H, PIXI_KEYED_HEADER.LIVE, frame >>> 0);
    if (out > 0) {
      if (byRow) {
        this.copyIn(this.data, this._sharedPose, out);
        // N-202: a list's rows reach past its length (Pixi's entity list leaves out the glow rows, which sit before the
        // decorations' and bullets'), so the poses of every queue row go up, not of as many rows as the list holds.
        this._uploadPoseRows(q, ctx.useIndices ? q.count | 0 : ctx.scanCount | 0);
      } else {
        this.copyIn(this.data, this._sharedPose, out * SPLIT_POSE_FLOATS);
      }
      this.copyIn(this._slotData, this._sharedSlots, out * GPU_INDEXED_SLOT_FLOATS);
      this._slotsVersion++;
    }
    const drawn = byRow ? this._finishUpload(out, 4, 'rows') : this._finishUpload(out, SPLIT_POSE_FLOATS * 4, true);
    // E-448: a frame drawn by queue row takes the opaque pass; a keyed frame drawn by its pose stream does not.
    if (byRow && this.opaqueOn) this._commitOpaqueRows(drawn, q, ctx);
    else this.dropOpaquePass();
    if (shadowed && out > 0) {
      // The ring slot _finishUpload just took.
      const ring = this._ring ^ 1;
      this._shadowBuffers[ring].update(out * 12);
      const g = (byRow ? this._keyedShadowRowGeometries : this._keyedShadowGeometries)[ring];
      g.instanceCount = out;
      this.keyedShadowGeometry = g;
      this.keyedShadowReady = true;
    }
    return drawn;
  }

  /**
   * E-312 step 2: a frame this batch cannot draw keyed (the kernel declined its options): drawn split, pre-render asked
   * for every row's statics until a keyed frame. One from a buffer that skipped some (an option that changed while
   * drawing keyed) shows those rows' last statics in that buffer for the frame or two before pre-render writes them.
   */
  _keyedMiss(H) {
    if (!this._keyFull) {
      this._keyFull = true;
      Atomics.store(H, PIXI_KEYED_HEADER.FULL, 1);
    }
    return -1;
  }

  /**
   * DX-FACES: this batch's instances for the face map, over this frame's geometry: the same rows, in the same order, drawn
   * again with a program that writes what each pixel is. Made on first use.
   * @param {number} heightScaleY
   * @param {number} groundScaleY
   * @param {import('pixi.js').TextureSource} maps the atlas's twin page (DX-MAPS), or an empty one
   * @returns {Mesh|null}
   */
  faceMesh(heightScaleY, groundScaleY, maps) {
    return this._auxMesh(AUX_FACE, heightScaleY, groundScaleY, maps);
  }

  /**
   * DX-GBUF (plan §6.4): this batch's instances for the entity ids map (faceMap.js FACE_IDS_SELF), the G-buffer's second
   * target, drawn as faceMesh draws the face map (lighting.gbuffer 'pass'). Needs the batch's words.
   * @returns {Mesh|null}
   */
  idsMesh(heightScaleY, groundScaleY, maps) {
    return this.gbuf ? this._auxMesh(AUX_IDS, heightScaleY, groundScaleY, maps) : null;
  }

  /**
   * DX-GBUF (plan §6.4, lighting.gbuffer 'mrt'): this batch's instances for the face map and the entity ids map in one
   * pass, two colour targets (faceMap.js faceGbufFragment; the caller's render target holds both). Needs the batch's words.
   * @returns {Mesh|null}
   */
  gbufMesh(heightScaleY, groundScaleY, maps) {
    return this.gbuf ? this._auxMesh(AUX_GBUF, heightScaleY, groundScaleY, maps) : null;
  }

  /**
   * DX-UNSHADED (was DX-EMISSIVE v2, plan §6.9, F10): this batch's instances for the unshaded target (faceMap.js
   * faceUnshadedFragment), the canvas's size: an unshaded pixel's colour, any other black with its alpha, normal blending.
   * Needs words.
   * @returns {Mesh|null}
   */
  unshadedMesh(heightScaleY, groundScaleY, maps) {
    return this.gbuf ? this._auxMesh(AUX_UNSHADED, heightScaleY, groundScaleY, maps) : null;
  }

  /**
   * E-457: the unshaded pass over this frame's geometry, a host of the unshaded mask (the quads of the instances that can be
   * unshaded, marked in the stencil: faceUnshadedMaskFragment) and the unshaded mesh drawn where they are (every instance,
   * as before), the stencil set between them (UnshadedStencilStep). Elsewhere no instance adds anything to its colour, so
   * the target holds what the unshaded mesh alone drew, for the fill of the unshaded quads: the rest were 0.81 ms of fill
   * in Predator ?light3d=1. DX-UNSHADED: an unshaded sheet's instances are marked too (the maps table's mark), so the mask
   * holds whatever is unshaded. The unshaded mesh alone where the mask cannot be made. Needs words.
   * @returns {Container|Mesh|null}
   */
  unshadedPass(heightScaleY, groundScaleY, maps) {
    const mesh = this.unshadedMesh(heightScaleY, groundScaleY, maps);
    if (mesh === null) return null;
    const passes = this._unshadedPasses;
    for (let i = 0; i < passes.length; i++) {
      if (passes[i].mesh === mesh) return passes[i].host;
    }
    const mask = this._auxMesh(AUX_UNSHADED_MASK, heightScaleY, groundScaleY, maps);
    if (mask === null) return mesh;
    // N-266: with pixel depth, the edge pass after the opaque one (the stencil step makes the target's depth).
    const edge = this._pixelDepth !== null ? this._auxMesh(AUX_UNSHADED_EDGE, heightScaleY, groundScaleY, maps) : null;
    const host = new Container();
    host.addChild(unshadedStencilStep(STENCIL_MASK_ADD, 0, 0));
    host.addChild(mask);
    host.addChild(unshadedStencilStep(STENCIL_MASK_ACTIVE, 1, 15));
    host.addChild(mesh);
    if (edge !== null) host.addChild(edge);
    host.addChild(unshadedStencilStep(STENCIL_OFF, 0, 15));
    passes.push({ mesh, host });
    return host;
  }

  /**
   * DX-GBUF: one of the batch's passes over its own instances for the light (AUX_FACE, AUX_IDS, ...), over this frame's
   * geometry: one mesh a geometry the batch draws from, none swapped (the ring swaps the geometry every frame, and Mesh's
   * setter makes garbage), the program that reads that geometry's layout (plain, indexed, by row). The programs are made on
   * the kind's first use, their uniforms the face map's group (uTileWorld, uFaceSpace, uPoseAlpha).
   * @returns {Mesh|null}
   */
  _auxMesh(kind, heightScaleY, groundScaleY, maps) {
    const aux = this._aux[kind];
    const geometry = this.mesh.geometry;
    const meshes = aux.meshes;
    for (let i = 0; i < meshes.length; i++) {
      if (meshes[i].geometry === geometry) return meshes[i];
    }
    if (aux.state === null && !this._makeAux(kind, aux, heightScaleY, groundScaleY, maps)) return null;
    const shader = this.mesh.shader === this._rowShader && this._rowShader !== null
      ? aux.row
      : this.mesh.shader === this._indexedShader && this._indexedShader !== null ? aux.indexed : aux.shader;
    if (shader === null) return null;
    const mesh = new Mesh({ geometry, shader, state: aux.state, label: `${this._label}-${AUX_NAMES[kind]}` });
    mesh.cullable = false;
    meshes.push(mesh);
    return mesh;
  }

  /** DX-GBUF: a pass kind's programs (plain, indexed, by row) and state, the first time it draws. */
  _makeAux(kind, aux, heightScaleY, groundScaleY, maps) {
    const shaders = this._engineShaders;
    if (!(this._useWebGpu ? shaders?.sprite : shaders?.faceFrag && shaders?.spriteVert)) return false;
    const face = this._aux[AUX_FACE];
    let uniforms;
    if (kind !== AUX_FACE && face.shader !== null) {
      // Pixi made the face map's group from its object: every kind shares it.
      uniforms = face.shader.resources.uniforms;
    } else {
      this._faceSpace[0] = heightScaleY;
      this._faceSpace[1] = groundScaleY;
      uniforms = {
        uTileWorld: { value: this._tileWorld, type: 'vec4<f32>' },
        uFaceSpace: { value: this._faceSpace, type: 'vec4<f32>' },
      };
      if (this._twoStreams) uniforms.uPoseAlpha = { value: 1, type: 'f32' };
    }
    const r = this.shader.resources;
    const resources = { uTexture: r.uTexture, uSampler: r.uSampler, uTexLut: r.uTexLut, uMaps: maps, uMapsLut: this._mapsTable, uniforms };
    const name = `${this._label}-${AUX_NAMES[kind]}`;
    // DX-GBUF: with words, each entity's sprite as its normals and surface say (faceMap.frag.glsl's GBUF block); every kind
    // past the face map reads them.
    const gbuf = { gbuf: kind === AUX_FACE ? this.gbuf : true, unshaded: this.unshadedOn, unshadedMask: kind === AUX_UNSHADED_MASK };
    const entry = AUX_ENTRIES[kind];
    // N-274: the G-buffer's one pass takes the colour pass's depth (pixelDepth.js gbufDepthVertex, gbufDepthFragment,
    // gbufDepthWgsl), so it keeps the surface the canvas shows at each texel; N-266: so does the unshaded pass, so a lit
    // sprite in front of an unshaded one covers it there as on the canvas, whichever the painter drew last.
    const depth = (kind === AUX_GBUF || kind === AUX_UNSHADED || kind === AUX_UNSHADED_EDGE) && this._pixelDepth !== null;
    // N-266: the colour pass's formula, stepped without faces.
    const depthOpts = { faces: this._depthFaces };
    const depthWgsl = (source) => (depth ? gbufDepthWgsl(source, depthOpts) : source);
    // E-457: the unshaded mask's vertex shader leaves out the instances that cannot be unshaded.
    const vertexOf = (source) => (kind === AUX_UNSHADED_MASK
      ? unshadedMaskVertex(faceMapVertex(source, gbuf))
      : depth ? gbufDepthVertex(faceMapVertex(source, gbuf)) : faceMapVertex(source, gbuf));
    const frag = this._useWebGpu ? null : depth ? gbufDepthFragment(this._auxFragment(kind, true), depthOpts) : this._auxFragment(kind, false);
    if (this._useWebGpu) {
      const source = depthWgsl(faceMapWgsl(this._twoStreams ? shaders.spritePose : shaders.sprite, gbuf));
      aux.shader = new Shader({ gpuProgram: instancedSpriteGpuProgram(GpuProgram, source, entry, name, { maps: true }), resources });
    } else {
      const vertex = vertexOf(this._twoStreams ? shaders.spriteVertPose : shaders.spriteVert);
      aux.shader = new Shader({ glProgram: glProgramFrom(GlProgram, vertex, frag, name), resources });
    }
    // The shared group, for the kinds made after this one.
    if (kind === AUX_FACE) resources.uniforms = aux.shader.resources.uniforms;
    const group = aux.shader.resources.uniforms;
    if (group && typeof group.update === 'function' && !this._faceGroups.includes(group)) this._faceGroups.push(group);
    if (this._indexedShader !== null) {
      const indexedResources = { ...resources, uStatics: this._indexedShader.resources.uStatics };
      const indexedName = `${name}-indexed`;
      aux.indexed = new Shader(
        this._useWebGpu
          ? {
              gpuProgram: instancedSpriteIndexedGpuProgram(
                GpuProgram,
                depthWgsl(spriteIndexedWgsl(faceMapWgsl(shaders.sprite, gbuf))),
                entry,
                indexedName,
                { maps: true },
              ),
              resources: indexedResources,
            }
          : {
              glProgram: glProgramFrom(GlProgram, spriteIndexedVertex(vertexOf(shaders.spriteVert)), frag, indexedName),
              resources: indexedResources,
            },
      );
    }
    if (this._rowShader !== null) {
      // E-201: over a by-row keyed frame (WebGL only).
      aux.row = new Shader({
        glProgram: glProgramFrom(
          GlProgram,
          spriteIndexedVertex(vertexOf(shaders.spriteVert), { poseBlock: this._poseBlock }),
          frag,
          `${name}-rows`,
        ),
        resources: { ...resources, uStatics: this._staticsSource, uPoses: this._poseSource },
      });
    }
    const state = new State();
    // The G-buffer's targets hold codes: written as they are. The unshaded target is a colour, blended as the sprites are
    // (PMA).
    state.blendMode = kind === AUX_UNSHADED || kind === AUX_UNSHADED_EDGE ? 'normal' : 'none';
    // N-274, N-266: the G-buffer's and the unshaded passes test and write the depth (less) in their target's depth attachment.
    state.depthTest = depth;
    state.depthMask = depth && kind !== AUX_UNSHADED_EDGE;
    state.culling = false;
    aux.state = state;
    return true;
  }

  /** DX-GBUF: a pass kind's fragment shader on WebGL (`depth`: N-266's unshaded pass with pixel depth). */
  _auxFragment(kind, depth) {
    const shaders = this._engineShaders;
    const unshaded = this.unshadedOn;
    if (kind === AUX_IDS) return faceIdsFragment({ unshaded });
    if (kind === AUX_GBUF) return faceGbufFragment(shaders.faceFrag, { unshaded });
    if (kind === AUX_UNSHADED) return faceUnshadedFragment({ depth });
    if (kind === AUX_UNSHADED_EDGE) return faceUnshadedFragment({ depth: true, edge: true });
    if (kind === AUX_UNSHADED_MASK) return faceUnshadedMaskFragment();
    return faceFragmentGlsl(shaders.faceFrag, { gbuf: this.gbuf, unshaded });
  }

  /** DX-GBUF: every program of the batch's passes for the light, for the atlas and LUT setters. */
  _auxShaders() {
    const out = this._auxShaderList;
    out.length = 0;
    for (let k = 0; k < this._aux.length; k++) {
      const aux = this._aux[k];
      if (aux.shader !== null) out.push(aux.shader);
      if (aux.indexed !== null) out.push(aux.indexed);
      if (aux.row !== null) out.push(aux.row);
    }
    return out;
  }

  /**
   * E-191: the sun's shadow pass draws this batch's keyed instances. From now on a keyed frame also packs each draw
   * slot's shadow terms and uploads them, and keyedShadowGeometry is that frame's geometry over its pose, slot and
   * shadow buffers (keyedShadowReady). False when the batch is not keyed or the render-queue memory has no shadow
   * region for it.
   * @returns {boolean}
   */
  enableKeyedShadows() {
    if (!this.keyed || this._sharedShadow.length === 0) return false;
    if (this._shadowBuffers === null) {
      this._shadowBuffers = this._ringBuffers(this._shadowData, this._label + '-shadow');
      this._keyedShadowGeometries = this._buffers.map((b, r) =>
        this._keyedShadowGeometryFor(b, this._slotBuffers[r], this._shadowBuffers[r]));
      this._keyedShadowRowGeometries = this.posesByRow
        ? this._buffers.map((b, r) => this._keyedShadowRowGeometryFor(b, this._slotBuffers[r], this._shadowBuffers[r]))
        : null;
      this.keyedShadowGeometry = this._keyedShadowGeometries[0];
    }
    this._keyedPack.shadowByte = this._sharedShadow.byteOffset;
    this.keyedShadows = true;
    return true;
  }

  /**
   * E-211: whether the next keyed packs write the slots' shadow terms (after enableKeyedShadows, which turns them on).
   * Off, a keyed frame reads and writes none and leaves keyedShadowReady false, for a sun pass that draws other rows.
   * @param {boolean} on
   */
  setKeyedShadowStream(on) {
    if (!this.keyedShadows) return;
    this._keyedPack.shadowByte = on ? this._sharedShadow.byteOffset : 0;
  }

  /**
   * E-191: the program of the sun's shadow pass over these instances: instancedSpriteShadow.vert.glsl reading its
   * statics by key from this batch's statics texture (spriteIndexedVertex's shadow form), with the fragment program
   * and the resources of `sun` (the caster batch's shadow shader: its atlas, its LUT and the uniform group that pass
   * fills). Null without keyed shadows, on WebGPU, or without the shadow vertex source.
   * @param {Shader|null} sun
   * @returns {Shader|null}
   */
  makeKeyedSunShader(sun) {
    if (!this.keyedShadows || !sun) return null;
    const program = this._keyedSunProgram();
    if (program === null) return null;
    if (this._keyedSunShader === null) {
      const r = sun.resources;
      const resources = {
        uTexture: r.uTexture,
        uSampler: r.uSampler,
        uTexLut: r.uTexLut,
        uniforms: r.uniforms,
        uStatics: this._staticsSource,
      };
      if (this.posesByRow) resources.uPoses = this._poseSource;
      this._keyedSunShader = new Shader({ ...program, resources });
    }
    return this._keyedSunShader;
  }

  /**
   * E-191 step 2: the program of a shadow pass over keyed caster rows (pre-render's sun rows, GPU_KEYED_CASTER_FLOATS;
   * with `light`, its stamp rows, GPU_KEYED_STAMP_FLOATS): instancedSpriteShadow.vert.glsl reading the statics by key
   * from this batch's statics texture, with no rotation (a shadow's angle is the sun's or the light's) and, for a stamp,
   * the row's own light; the fragment program and the resources of `sun`, as makeKeyedSunShader's. Null where the keyed
   * frames are off, on WebGPU, or without the shadow vertex source.
   * @param {Shader|null} sun
   * @param {boolean} light
   * @returns {Shader|null}
   */
  makeKeyedCasterShader(sun, light) {
    if (!this.keyed || !sun) return null;
    const i = light ? 1 : 0;
    if (this._keyedCasterShaders[i] === null) {
      const program = this._keyedCasterProgram(light);
      if (program === null) return null;
      const r = sun.resources;
      this._keyedCasterShaders[i] = new Shader({
        ...program,
        resources: {
          uTexture: r.uTexture,
          uSampler: r.uSampler,
          uTexLut: r.uTexLut,
          uniforms: r.uniforms,
          uStatics: this._staticsSource,
        },
      });
    }
    return this._keyedCasterShaders[i];
  }

  /**
   * E-191 step 2: `count` keyed caster rows of `floats` floats (GPU_KEYED_CASTER_FLOATS, or GPU_KEYED_STAMP_FLOATS with
   * the light) from `src` into this batch's next ring slot, and their geometry (makeKeyedCasterShader's attributes over
   * them), or null for none or more than the batch holds. The batch's own mesh and geometry stay as they were.
   * @returns {Geometry|null}
   */
  commitKeyedCasterRows(src, count, floats, tiles = null) {
    const f = floats | 0;
    const n = count | 0;
    const keep = n > this.capacity ? this.capacity : n;
    if (keep <= 0 || !src || keep * f > this.data.length) return null;
    this.copyIn(this.data, src, keep * f);
    // E-395: the lamps' map's stamp rows carry their lamp's tile + 1 in the light's z, which its programs read as the tile.
    if (tiles !== null) {
      const data = this.data;
      for (let k = 0, at = GPU_KEYED_CASTER_FLOATS + 2; k < keep; k++, at += f) data[at] = tiles[k] + 1;
    }
    const ring = this._ring;
    this._ring = ring ^ 1;
    this._buffers[ring].update(keep * f * 4);
    const geometry = this.keyedCasterGeometry(f > GPU_KEYED_CASTER_FLOATS, ring);
    geometry.instanceCount = keep;
    return geometry;
  }

  /**
   * E-395: keep a CPU copy of each keyed slot's texture and scale (staticsMirror), for the renders' columns over keyed
   * caster rows. The keyed updates carry only what changed, so this asks pre-render for every slot's statics again (the
   * keyed pause, as after a loss) and the copy fills from them. False without keyed frames or a statics texture yet.
   * @returns {boolean}
   */
  enableStaticsMirror() {
    if (!this.keyed || this._staticsHeight <= 0) return false;
    const slots = this._staticsHeight * STATICS_TEX_ROW;
    if (this._staticsMirror.length < slots * 3) this._staticsMirror = new Float32Array(slots * 3);
    // A few frames of every slot's statics (KEYED_PAUSE_FRAMES is the loss's long pause): the copy fills from them.
    this._keyPause = Math.max(this._keyPause, STATICS_MIRROR_FILL_FRAMES);
    this._keyFull = true;
    Atomics.store(this._keyHeader, PIXI_KEYED_HEADER.FULL, 1);
    return true;
  }

  /** E-395: the keyed slots' texture and scale (textureId, scaleX, scaleY a slot), or null before enableStaticsMirror. */
  get staticsMirror() {
    return this._staticsMirror.length > 0 ? this._staticsMirror : null;
  }

  /** E-395: this frame's keyed updates into the statics' CPU copy: an update's scale (words 0, 1) and texture (word 6). */
  _mirrorKeyedStatics(n, nt) {
    const M = this._staticsMirror;
    const U = this._keyUpdates;
    const UF = this._keyUpdatesF;
    const max = (M.length / 3) | 0;
    for (let k = 0; k < n; k++) {
      const at = k * GPU_KEYED_ROW_WORDS;
      const s = U[at + GPU_KEYED_KEY_WORD];
      if (s >= max) continue;
      M[s * 3] = UF[at + 6];
      M[s * 3 + 1] = UF[at];
      M[s * 3 + 2] = UF[at + 1];
    }
    const T = this._keyTexUpdates;
    const TF = this._keyTexUpdatesF;
    for (let k = 0; k < nt; k++) {
      const s = T[2 * k];
      if (s < max) M[s * 3] = TF[2 * k + 1];
    }
  }

  /**
   * E-395: a shader of `program` (a shadow map's, composed over spriteIndexedVertex's keyed caster rows) with `resources`
   * and this batch's statics texture, which those rows read by key. Null where the keyed frames are off.
   * @param {object} program a Shader's program options ({ glProgram } or { gpuProgram })
   * @param {object} resources the map's own resources (atlas, sampler, LUT, uniform group, ...)
   * @returns {Shader|null}
   */
  makeKeyedRowsShader(program, resources) {
    if (!this.keyed || !program) return null;
    return new Shader({ ...program, resources: { ...resources, uStatics: this._staticsSource } });
  }

  /** E-191 step 2: a ring slot's geometry for keyed caster rows (the stamps' with `light`), made on first use. */
  keyedCasterGeometry(light, ring = 0) {
    if (this._keyedCasterGeometries === null) {
      this._keyedCasterGeometries = this._buffers.map((buf) => [
        this._keyedCasterGeometryFor(buf, GPU_KEYED_CASTER_FLOATS, false),
        this._keyedCasterGeometryFor(buf, GPU_KEYED_STAMP_FLOATS, true),
      ]);
    }
    return this._keyedCasterGeometries[ring & 1][light ? 1 : 0];
  }

  /** E-191 step 2: a ring slot's keyed caster rows of `floats` floats: x and y, the key's slot pair, the shadow terms. */
  /**
   * E-191/E-220: a keyed shadow program, the shadow vertex shader reading the statics by key (spriteIndexed.js), as a
   * Shader's options: `{ glProgram }` on WebGL, `{ gpuProgram }` on WebGPU (the statics a storage buffer); null without
   * the shadow source.
   * @param {{ shadow: boolean, casterRows?: boolean, light?: boolean }} opts
   * @param {string} name
   */
  /**
   * SST-7 step 3: what the batch's mesh draws with, a frame's kind each (plain, indexed, by row): its program and a geometry
   * of that layout (both ring slots share it), for building the render pipelines ahead.
   * @returns {{ shader: Shader, geometry: Geometry }[]}
   */
  drawVariants() {
    const out = [{ shader: this.shader, geometry: this._geometries[0] }];
    if (this._indexedShader !== null) out.push({ shader: this._indexedShader, geometry: this._indexedGeometries[0] });
    if (this._rowShader !== null) out.push({ shader: this._rowShader, geometry: this._rowGeometries[0] });
    return out;
  }

  /** E-191: the keyed sun pass's program (E-201: a by-row batch's keyed frames are drawn by queue row, and so is it). */
  _keyedSunProgram() {
    return this._keyedShadowProgram(
      this.posesByRow ? { shadow: true, poseBlock: this._poseBlock } : { shadow: true },
      `${this._label}-keyed-sun`
    );
  }

  /** E-191 step 2: the keyed caster rows' program, the sun's or (`light`) the stamps'. */
  _keyedCasterProgram(light) {
    return this._keyedShadowProgram(
      { shadow: true, casterRows: true, light },
      `${this._label}-keyed-${light ? 'stamp' : 'sun'}-rows`
    );
  }

  /**
   * E-494: the programs the sun pass makes on its first use over this batch's keyed instances, made now with the same
   * sources and names (GlProgram.from on WebGL), so the caller links them before the first frame: `sun`, the keyed sun
   * pass's (where enableKeyedShadows can turn it on); `casters`, the keyed caster rows' two (makeKeyedCasterShader).
   * @param {boolean} sun
   * @param {boolean} casters
   */
  makeKeyedShadowPrograms(sun, casters) {
    if (sun && this.keyed && this._sharedShadow.length > 0) this._keyedSunProgram();
    if (casters && this.keyed) {
      this._keyedCasterProgram(false);
      this._keyedCasterProgram(true);
    }
  }

  _keyedShadowProgram(opts, name) {
    const shaders = this._engineShaders;
    if (this._useWebGpu) {
      if (!shaders?.shadowWgsl) return null;
      return { gpuProgram: instancedSpriteShadowIndexedGpuProgram(GpuProgram, spriteIndexedWgsl(shaders.shadowWgsl, opts), name) };
    }
    if (!shaders?.shadowVert) return null;
    return {
      glProgram: glProgramFrom(
        GlProgram,
        spriteIndexedVertex(shaders.shadowVert, opts),
        pickInstancedSpriteFragmentGlsl(true, shaders),
        name
      ),
    };
  }

  _keyedCasterGeometryFor(buf, floats, light) {
    const ds = floats * 4;
    const attributes = {
      aQuad: { buffer: this._quad, format: 'float32x2' },
      aInstXY: { buffer: buf, format: 'float32x2', stride: ds, offset: 0, instance: true },
      aInstSlot: { buffer: buf, format: 'float32', stride: ds, offset: 8, instance: true },
      // DX-SHADOW3D (plan §17.2): the frame the light sees, ±(textureId + 1), 0 the sprite's own (pre-render writes it).
      aInstFrame: { buffer: buf, format: 'float32', stride: ds, offset: 12, instance: true },
      aInstShadow: { buffer: buf, format: 'float32x3', stride: ds, offset: 16, instance: true },
    };
    if (light) attributes.aInstLight = { buffer: buf, format: 'float32x4', stride: ds, offset: GPU_KEYED_CASTER_FLOATS * 4, instance: true };
    const geometry = new Geometry({ attributes, indexBuffer: this._index });
    geometry.instanceCount = 0;
    return geometry;
  }

  /**
   * A call gpuPack.wasm cannot pack (the batch has no rows in the render-queue memory, or the queue's columns are
   * elsewhere): drawn empty, the reason said once.
   */
  _packRefused(stride) {
    if (!this._packRefusedWarned) {
      this._packRefusedWarned = true;
      console.error(`[INSTANCED SPRITES] ${this._label}: gpuPack.wasm cannot pack this upload (its rows or the queue's `
        + 'columns are outside the render-queue memory): it is drawn empty');
    }
    return this._finishUpload(0, stride);
  }

  /**
   * E-82b: commit `count` rows another worker packed in the two streams (pre-render's GPU queue with
   * GPU_FLAG_SPLIT). `gen` is their statics' generation (0: unknown); the statics are copied only when it
   * or the row count differs from what this batch holds.
   */
  commitSplit(pose, stat, count, gen) {
    const n = count | 0;
    const keep = n > this.capacity ? this.capacity : n;
    if (keep <= 0) return this._finishUpload(0, SPLIT_POSE_FLOATS * 4);
    const g = gen >>> 0;
    if (g === 0 || g !== this._stGen || keep !== this._stRows || this._stScale !== 0 || this._stFilter !== 0) {
      this._stGen = g;
      this._stRows = keep;
      this._stScale = 0;
      this._stFilter = 0;
      this._staticVersion++;
      this.copyIn(this.staticData, stat, keep * POSE_STATIC_FLOATS);
    }
    this.copyIn(this.data, pose, keep * SPLIT_POSE_FLOATS);
    const drawn = this._finishUpload(keep, SPLIT_POSE_FLOATS * 4);
    if (this.opaqueOn) this._commitOpaque(drawn);
    return drawn;
  }

  /**
   * E-162: commit `count` slots of an indexed frame another worker packed (pre-render's GPU queue with
   * GPU_FLAG_INDEXED): the poses and the slot pairs in draw order, and `rows` queue rows' statics in row order, `gen`
   * their generation (0: unknown). The statics go up, the texture rows they fill, only when the generation or the
   * rows moved; the slot pairs only when their own generation `slotsGen` (the painter's order) or the slots moved.
   * A frame whose order moved uploads 24 bytes a sprite, one whose order holds 16. E-514: `ix` (null: none), the frame's
   * lists of the statics rows that changed and their bases (gpuQueueLayout GPU_HDR_IXUP): when the statics here are one
   * base, only those rows go up (_scatterIndexedStatics).
   */
  commitIndexed(pose, slots, rowStatics, count, rows, gen, slotsGen, ix = null) {
    const n = count | 0;
    const keep = n > this.capacity ? this.capacity : n;
    if (keep <= 0) return this._finishUpload(0, SPLIT_POSE_FLOATS * 4);
    const cap = (this._rowStatics.length / GPU_INDEXED_STATIC_FLOATS) | 0;
    const r = rows > cap ? cap : rows | 0;
    const g = gen >>> 0;
    if (g === 0 || g !== this._ixGen || r !== this._ixRows) {
      if (r === (rows | 0) && this._scatterIndexedStatics(ix, g)) {
        this._ixScattered++;
      } else {
        this._ixWhole++;
        this.copyIn(this._rowStatics, rowStatics, r * GPU_INDEXED_STATIC_FLOATS);
        if (this._useWebGpu) {
          this._staticsSource.update(r * GPU_INDEXED_STATIC_FLOATS * 4);
        } else {
          const width = STATICS_TEX_ROW * STATICS_TEXELS_PER_ROW;
          this._statics.upload(this._staticsSource, this._rowStaticsU32, width, this._staticsHeight, 0, staticsTextureHeight(r));
        }
      }
      this._ixGen = g;
      this._ixRows = r;
    }
    const sg = slotsGen >>> 0;
    if (sg === 0 || sg !== this._ixSlotsGen || keep !== this._ixSlots) {
      this._ixSlotsGen = sg;
      this._ixSlots = keep;
      this._slotsVersion++;
      this.copyIn(this._slotData, slots, keep * GPU_INDEXED_SLOT_FLOATS);
    }
    this.copyIn(this.data, pose, keep * SPLIT_POSE_FLOATS);
    // E-448: an indexed frame draws no opaque pass.
    this.dropOpaquePass();
    return this._finishUpload(keep, SPLIT_POSE_FLOATS * 4, true);
  }

  /**
   * E-514: an indexed frame's statics (generation `gen`) as the rows that changed, when the statics here are one of the
   * bases pre-render listed them against (ix.genA / ix.rowsA, ix.genB / ix.rowsB): the lists copied out of the shared
   * memory, applied to the CPU copy (a later upload of every row starts from it) and scattered into the texture (WebGL)
   * or the storage buffer (WebGPU) by the keyed batches' scatter. False, nothing done, without lists, a base or a scatter:
   * the caller then sends every row.
   */
  _scatterIndexedStatics(ix, gen) {
    if (ix === null || gen === 0 || this._ixGen === 0 || this._ixUpdateRows === 0) return false;
    const n = ix.count | 0;
    const nt = ix.texCount | 0;
    if (n < 0 || n > this._ixUpdateRows || nt < 0 || nt > this._ixUpdateRows) return false;
    const held = this._ixGen;
    const heldRows = this._ixRows;
    const onA = (ix.genA >>> 0) === held && (ix.rowsA | 0) === heldRows;
    const onB = (ix.genB >>> 0) === held && (ix.rowsB | 0) === heldRows;
    if (!onA && !onB) return false;
    const U = this._ixUpdates;
    const T = this._ixTexUpdates;
    if (n > 0) this.copyIn(U, ix.updates, n * GPU_KEYED_ROW_WORDS);
    if (nt > 0) this.copyIn(T, ix.texUpdates, nt * GPU_KEYED_TEX_WORDS);
    const S = this._rowStaticsU32;
    for (let k = 0; k < n; k++) {
      const at = k * GPU_KEYED_ROW_WORDS;
      const to = U[at + GPU_KEYED_KEY_WORD] * GPU_INDEXED_STATIC_FLOATS;
      for (let w = 0; w < GPU_INDEXED_STATIC_FLOATS; w++) S[to + w] = U[at + w];
    }
    for (let k = 0; k < nt; k++) S[T[2 * k] * GPU_INDEXED_STATIC_FLOATS + GPU_INDEXED_TEX_WORD] = T[2 * k + 1];
    if (n > 0 || nt > 0) {
      this._statics.scatter(this._staticsSource, U, n, STATICS_TEX_ROW * STATICS_TEXELS_PER_ROW, this._staticsHeight, T, nt);
    }
    return true;
  }

  /**
   * dst[0..floats) = src[0..floats). W30: by memory.copy when dst is in this batch's arena and src in the shared
   * memory the arena copies from; else TypedArray.set.
   */
  copyIn(dst, src, floats) {
    if (this._copy !== null && dst.buffer === this._arenaBuffer && src.buffer === this._copySource) {
      this._copy(dst.byteOffset, src.byteOffset, floats * 4);
    } else {
      dst.set(src.subarray(0, floats));
    }
  }

}
