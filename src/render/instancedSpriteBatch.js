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
} from './webgpu/instancedSpriteWgsl.js';
import {
  instancedSpriteGlProgram,
  pickInstancedSpriteFragmentGlsl,
} from './webgl/instancedSpriteGlsl.js';
import {
  GPU_INDEXED_SLOT_FLOATS, GPU_INDEXED_STATIC_FLOATS, GPU_POSE_FLOATS, GPU_STATIC_FLOATS, gpuIndexedStaticRows,
} from './gpuQueueLayout.js';
import { packInstancedRowsWasm, packPoseRowsWasm, packSplitRowsWasm } from './gpuPackClient.js';
import {
  STATICS_TEXELS_PER_ROW, STATICS_TEX_ROW, spriteIndexedVertex, spriteIndexedWgsl, staticsTextureHeight,
} from './spriteIndexed.js';

/** Compact instance floats: xy, scale, anchor, rotCS, depth, packedARGB, texId, tileInv, tileOff.
 *  tileInv sign: + WORLD (1/period), - LOCAL (worldVis/period), 0 stretch. tileOff is UV 0..1.
 *  A pose batch splits the same terms, with the previous xy, into two streams (below). */
export const INSTANCED_SPRITE_FLOATS = 15;
export const INSTANCED_SPRITE_STRIDE = INSTANCED_SPRITE_FLOATS * 4;
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

/**
 * Per-textureId LUT: origW, origH, u0, v0, u1, v1, trimX, trimY, trimW, trimH
 */
export const TEX_LUT_FLOATS = 10;
/** RGBA32F texels per LUT row (12 floats; last two unused). */
export const TEX_LUT_RGBA_WIDTH = 3;

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
}

export function buildTextureLut(flatTextures, fallbackTexture) {
  const n = flatTextures?.length || 0;
  const lut = new Float32Array(Math.max(1, n) * TEX_LUT_FLOATS);
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
    }
  }
  if (n === 0) {
    console.warn('[InstancedSpriteBatch] flatTextures empty; LUT falls back to WHITE');
    writeLutSlot(lut, 0, fb);
  }
  return lut;
}

/** Pack CPU LUT (10 floats/id) into RGBA32F rows for vertex texelFetch. */
export function packTextureLutRgba(lut, count) {
  const n = Math.max(1, count | 0);
  const out = new Float32Array(n * TEX_LUT_RGBA_WIDTH * 4);
  const srcN = lut ? (lut.length / TEX_LUT_FLOATS) | 0 : 0;
  for (let i = 0; i < n; i++) {
    const dst = i * 12;
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
    }
  }
  return out;
}

let _dummyLutGpu = null;
let _dummyLutGl = null;
export function dummyLutSource(useWebGpu) {
  if (useWebGpu) {
    if (_dummyLutGpu) return _dummyLutGpu;
    _dummyLutGpu = TextureSource.from({
      resource: packTextureLutRgba(null, 1),
      width: TEX_LUT_RGBA_WIDTH,
      height: 1,
      format: 'rgba32float',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
    });
    _dummyLutGpu.uploadMethodId = 'external';
    return _dummyLutGpu;
  }
  if (_dummyLutGl) return _dummyLutGl;
  _dummyLutGl = TextureSource.from({
    resource: packTextureLutRgba(null, 1),
    width: TEX_LUT_RGBA_WIDTH,
    height: 1,
    format: 'rgba32float',
    scaleMode: 'nearest',
    addressMode: 'clamp-to-edge',
    autoGenerateMipmaps: false,
  });
  _dummyLutGl.uploadMethodId = 'unknown';
  return _dummyLutGl;
}

export class InstancedSpriteBatch {
  /**
   * @param {object} opts
   * @param {number} opts.capacity
   * @param {string} opts.label
   * @param {import('../vendor/pixi.min.js').TextureSource} opts.atlasSource
   * @param {boolean} [opts.depthTest=true]
   * @param {boolean} [opts.depthMask=true]
   * @param {boolean} [opts.alphaDiscard=true] - false → blend-only fragment (no discard)
   * @param {Float32Array} [opts.alphaCut] - xy: discard below x, discard at/above y (y=0 off). Default 0.01 when discarding.
   * @param {boolean} [opts.premultiplyAlpha=true] - true → normal PMA out; false → additive (glows)
   * @param {string} [opts.blendMode='normal'] - Pixi State blend mode
   * @param {boolean} [opts.useWebGpu=true] - compile GpuProgram vs GlProgram
   * @param {object} opts.shaders - fetched engine sources (`sprite` or spriteVert/frag*)
   * @param {object|null} [opts.statics] - E-162, a split batch: what it keeps indexed frames' statics in, with which it
   *   also commits them (commitIndexed). WebGL: Pixi's RGBA32UI texture helper (`maxSize`, `make`, `upload`:
   *   pixiWorker._gpuRecordTexture); WebGPU: `{ maxStorageBytes }`, the device's storage binding size
   */
  constructor({
    capacity,
    label,
    atlasSource,
    depthTest = true,
    depthMask = true,
    alphaDiscard = true,
    alphaCut = null,
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
  }) {
    this.capacity = Math.max(1, capacity | 0);
    this.poseInterp = !!poseInterp;
    this.shadowCast = !!shadowCast && !poseInterp;
    this.split = !!split && !this.poseInterp && !this.shadowCast;
    // E-162: a split batch given `statics` also takes indexed frames: the poses, a slot stream (each instance's statics
    // row and depth) and every queue row's statics in row order, in a texture (WebGL) or a storage buffer (WebGPU).
    this.indexed = this.split && statics !== null;
    // Two streams, a pose and the statics: a pose batch's (E-82) or a split batch's (E-82b).
    this._twoStreams = this.poseInterp || this.split;
    this._floats = this.poseInterp ? POSE_DYN_FLOATS : this.split ? SPLIT_POSE_FLOATS : INSTANCED_SPRITE_FLOATS;
    if (this.shadowCast) this._floats += 7;
    this._strideBytes = this._floats * 4;
    // W30: in a private memory (sharedCopy.createPrivateArena) when Pixi passes one, so the copies out of the
    // render-queue memory run as memory.copy (copyIn); else arrays of the batch's own.
    this.data = (arena && arena.f32(this.capacity * this._floats)) || new Float32Array(this.capacity * this._floats);
    this.dataU32 = new Uint32Array(this.data.buffer);
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
    this.staticDataU32 = new Uint32Array(this.staticData.buffer);
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
    const staticFloats = this.indexed ? gpuIndexedStaticRows(this.capacity) * GPU_INDEXED_STATIC_FLOATS : 0;
    this._slotData = (this.indexed && arena && arena.f32(slotFloats)) || new Float32Array(slotFloats);
    this._rowStatics = (this.indexed && arena && arena.f32(staticFloats)) || new Float32Array(staticFloats);
    this._rowStaticsU32 = new Uint32Array(this._rowStatics.buffer, this._rowStatics.byteOffset, staticFloats);
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
    this._buffers = [
      this._makeInstanceBuffer(labelName),
      this._makeInstanceBuffer(labelName + '-ring'),
    ];
    this._staticBuffers = this._twoStreams
      ? [this._makeStaticBuffer(labelName + '-static'), this._makeStaticBuffer(labelName + '-static-ring')]
      : null;
    this._slotBuffers = this.indexed
      ? [this._makeSlotBuffer(labelName + '-slots'), this._makeSlotBuffer(labelName + '-slots-ring')]
      : null;
    this._geometries = this._buffers.map((buf, r) => this._geometryFor(buf, this._staticBuffers ? this._staticBuffers[r] : null));
    // E-162: an indexed frame's geometries, over the same pose buffers and the slot buffers: the indexed program's
    // attributes and no other (a program bound to a geometry with attributes it lacks makes Pixi warn, per pair).
    this._indexedGeometries = this.indexed
      ? this._buffers.map((buf, r) => this._indexedGeometryFor(buf, this._slotBuffers[r]))
      : null;
    this._ring = 0;
    this.buffer = this._buffers[0];
    this.geometry = this._geometries[0];

    this._useWebGpu = useWebGpu;
    this._engineShaders = shaders;
    this._premultiplyAlpha = premultiplyAlpha;
    this._alphaDiscard = alphaDiscard !== false;

    this._tileWorld = new Float32Array(4);
    this._tileWorld[2] = 1;
    const cut = alphaCut || new Float32Array(this._alphaDiscard ? [0.01, 0, 0, 0] : [0, 0, 0, 0]);
    this._alphaCut = cut;
    const atlas = atlasSource || Texture.WHITE.source;
    const lut = lutSource || dummyLutSource(useWebGpu);
    this.shader = this._makeSpriteShader(atlas, lut, cut, label || 'instanced-sprites');
    // E-162: the statics texture and the program that reads it; the mesh draws with it on indexed frames.
    this._statics = this.indexed ? statics : null;
    this._staticsSource = null;
    this._staticsHeight = 0;
    this._indexedShader = this.indexed ? this._makeIndexedShader(labelName) : null;
    this.shadowShader = null;
    if (this.shadowCast && (shaders?.shadowVert || shaders?.shadowWgsl)) {
      const sunUniforms = {
        uTileWorld: { value: this._tileWorld, type: 'vec4<f32>' },
        uSun: { value: new Float32Array([1, 0, 1, 0.4]), type: 'vec4<f32>' },
        uLight: { value: new Float32Array([-1, 0, 0, 0]), type: 'vec4<f32>' },
        uCam: { value: new Float32Array(4), type: 'vec4<f32>' },
        uPointScale: { value: 0, type: 'f32' },
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
        const glProgram = instancedSpriteGlProgram(
          GlProgram,
          shaders.shadowVert,
          pickInstancedSpriteFragmentGlsl(true, false, shaders),
          (label || 'instanced-sprites') + '-sun'
        );
        this.shadowShader = new Shader({ glProgram, resources });
      }
    }

    const state = new State();
    state.blend = true;
    state.blendMode = blendMode || 'normal';
    state.depthTest = !!depthTest;
    state.depthMask = depthMask !== false;
    state.culling = false;

    this.mesh = new Mesh({
      geometry: this.geometry,
      shader: this.shader,
      state,
      label: label || 'instanced-sprites',
    });
    this.mesh.blendMode = state.blendMode;
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
    };
  }

  _makeInstanceBuffer(label) {
    return new Buffer({
      data: this.data,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label,
    });
  }

  _makeStaticBuffer(label) {
    return new Buffer({
      data: this.staticData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label,
    });
  }

  _makeSlotBuffer(label) {
    return new Buffer({
      data: this._slotData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label,
    });
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
        aInstSlot: { buffer: slotBuf, format: 'float32x2', stride: GPU_INDEXED_SLOT_FLOATS * 4, offset: 0, instance: true },
      },
      indexBuffer: this._index,
    });
    geometry.instanceCount = 0;
    return geometry;
  }

  _makeSpriteShader(atlas, lut, alphaCut, name) {
    const uniforms = {
      uTileWorld: { value: this._tileWorld, type: 'vec4<f32>' },
    };
    if (this._twoStreams) {
      // Number, not Float32Array. Pixi's WebGL f32 sync compares the value
      // with !==. The same array never looks changed, so the GPU stays at 0.
      // A split batch keeps 1 (setPoseAlpha leaves it).
      uniforms.uPoseAlpha = { value: 1, type: 'f32' };
    }
    const resources = {
      uTexture: atlas,
      uSampler: atlas.style,
      uTexLut: lut,
      uniforms,
    };
    let fragEntry = 'mainFragAdd';
    if (this._premultiplyAlpha) {
      fragEntry = 'mainFrag';
    }
    const shaders = this._engineShaders;
    const spriteSource = this._twoStreams ? shaders?.spritePose : shaders?.sprite;
    const vertSource = this._twoStreams ? shaders?.spriteVertPose : shaders?.spriteVert;
    if (this._useWebGpu) {
      const gpuProgram = instancedSpriteGpuProgram(GpuProgram, spriteSource, fragEntry, name);
      return new Shader({ gpuProgram, resources });
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
    const glProgram = instancedSpriteGlProgram(
      GlProgram,
      vert,
      pickInstancedSpriteFragmentGlsl(this._premultiplyAlpha, this._alphaDiscard, shaders),
      name
    );
    return new Shader({ glProgram, resources });
  }

  /**
   * E-162: where the statics go, and the indexed program (spriteIndexed.js: the plain sprite vertex shader reading
   * them by row) over the split program's resources and uniform group. WebGL: a texture made at its full height;
   * WebGPU: a read-only storage buffer over the same copy.
   */
  _makeIndexedShader(name) {
    if (this._useWebGpu) return this._makeIndexedGpuShader(name);
    const width = STATICS_TEX_ROW * STATICS_TEXELS_PER_ROW;
    const height = staticsTextureHeight(this.capacity);
    const max = this._statics.maxSize | 0;
    if (width > max || height > max) {
      throw new Error(
        `WeedJS: renderer.indexedSprites needs a ${width} x ${height} texture for ${this.capacity} sprites, and this GPU ` +
          `allows ${max} texels a side: turn the option off or lower renderer.maxVisibleRenderables.`
      );
    }
    this._staticsHeight = height;
    this._staticsSource = this._statics.make(this._rowStaticsU32, width, height, `${name}-statics`);
    const shaders = this._engineShaders;
    const glProgram = instancedSpriteGlProgram(
      GlProgram,
      shaders?.spriteVert ? spriteIndexedVertex(shaders.spriteVert) : null,
      pickInstancedSpriteFragmentGlsl(this._premultiplyAlpha, this._alphaDiscard, shaders),
      `${name}-indexed`
    );
    const r = this.shader.resources;
    const resources = {
      uTexture: r.uTexture,
      uSampler: r.uSampler,
      uTexLut: r.uTexLut,
      uniforms: r.uniforms,
      uStatics: this._staticsSource,
    };
    return new Shader({ glProgram, resources });
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
    this._staticsSource = new Buffer({
      data: this._rowStatics,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      label: `${name}-statics`,
    });
    const shaders = this._engineShaders;
    const gpuProgram = instancedSpriteIndexedGpuProgram(
      GpuProgram,
      shaders?.sprite ? spriteIndexedWgsl(shaders.sprite) : null,
      this._premultiplyAlpha ? 'mainFrag' : 'mainFragAdd',
      `${name}-indexed`
    );
    const r = this.shader.resources;
    const resources = {
      uTexture: r.uTexture,
      uSampler: r.uSampler,
      uTexLut: r.uTexLut,
      uniforms: r.uniforms,
      uStatics: this._staticsSource,
    };
    return new Shader({ gpuProgram, resources });
  }

  _show(on) {
    this.mesh.visible = on;
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
  }

  setLutSource(source) {
    if (!source) return;
    this.shader.resources.uTexLut = source;
    if (this.shadowShader) this.shadowShader.resources.uTexLut = source;
    if (this._indexedShader) this._indexedShader.resources.uTexLut = source;
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
    const o = opts || EMPTY_UPLOAD_OPTS;
    const count = q.count | 0;
    const indices = o.indices;
    const indexCount = o.indexCount | 0;
    const useIndices = indices != null;
    if ((!useIndices && count <= 0) || (useIndices && indexCount <= 0)) {
      this.geometry.instanceCount = 0;
      this._show(false);
      return null;
    }
    const includeType = o.includeType | 0;
    const hasInclude = includeType >= 0;
    if (!useIndices && hasInclude && !o.type) {
      this.geometry.instanceCount = 0;
      this._show(false);
      return null;
    }
    const space = o.space | 0;
    const zoom = o.zoom ?? 1;
    const cameraX = o.cameraX ?? 0;
    const cameraY = o.cameraY ?? 0;
    const resolution = o.resolution ?? 1;
    const useScreen = space === BATCH_SPACE.SCREEN;
    const screenScale = zoom * resolution;
    const tw = this._tileWorld;
    if (tw) {
      if (useScreen) {
        tw[0] = cameraX;
        tw[1] = cameraY;
        tw[2] = screenScale > 0 ? 1 / screenScale : 1;
        tw[3] = 1;
      } else {
        tw[0] = 0;
        tw[1] = 0;
        tw[2] = 1;
        tw[3] = 0;
      }
    }
    const typeArr = o.type || null;
    const exclude0 = o.excludeType0 | 0;
    const exclude1 = o.excludeType1 | 0;
    const hasExclude = exclude0 >= 0 || exclude1 >= 0;
    const filterTypes = !useIndices && typeArr && (hasInclude || hasExclude);
    const ctx = this._uploadCtx;
    ctx.o = o;
    ctx.indices = indices;
    ctx.useIndices = useIndices;
    ctx.useScreen = useScreen;
    ctx.cameraX = cameraX;
    ctx.cameraY = cameraY;
    ctx.screenScale = screenScale;
    const rot = o.cameraRot || 0;
    ctx.cameraRot = rot;
    if (rot && useScreen) {
      const z = zoom || 1;
      const canvasW = o.canvasW || 0;
      const canvasH = o.canvasH || 0;
      const res = resolution || 1;
      ctx.camC = Math.cos(rot);
      ctx.camS = Math.sin(rot);
      ctx.focusX = cameraX + canvasW / (2 * z);
      ctx.focusY = cameraY + canvasH / (2 * z);
      ctx.halfW = canvasW * 0.5 * res;
      ctx.halfH = canvasH * 0.5 * res;
    } else {
      ctx.camC = 1;
      ctx.camS = 0;
      ctx.focusX = 0;
      ctx.focusY = 0;
      ctx.halfW = 0;
      ctx.halfH = 0;
    }
    ctx.typeArr = typeArr;
    ctx.includeType = includeType;
    ctx.exclude0 = exclude0;
    ctx.exclude1 = exclude1;
    ctx.hasInclude = hasInclude;
    ctx.hasExclude = hasExclude;
    ctx.filterTypes = filterTypes;
    ctx.depthDenom = (o.depthDenom || this.capacity) + 1;
    ctx.scanCount = useIndices
      ? indexCount
      : count > this.capacity && !filterTypes
        ? this.capacity
        : count;
    return ctx;
  }

  _finishUpload(out, stride, indexed = false) {
    if (out <= 0) {
      this.geometry.instanceCount = 0;
      this._show(false);
      return 0;
    }
    this._show(true);
    const ring = this._ring;
    this._ring = ring ^ 1;
    const geometry = indexed ? this._indexedGeometries[ring] : this._geometries[ring];
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
      const shader = indexed ? this._indexedShader : this.shader;
      if (this.mesh.shader !== shader) this.mesh.shader = shader;
    }
    geometry.instanceCount = out;
    this.geometry = geometry;
    this.buffer = this._buffers[ring];
    this.mesh.geometry = geometry;
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
    return this._finishUpload(out, POSE_DYN_FLOATS * 4);
  }

  /**
   * E-82b. A split batch's upload: the pose stream, and the statics when _staticsCurrent says the GPU's are
   * not this upload's. Through gpuPack.wasm (W9d); the values are a plain batch's. A split batch is a world-space
   * one with no pixel snap (a nearest atlas keeps 15-float rows) and no type filter, which the kernel takes.
   */
  _uploadSplit(q, opts) {
    const ctx = this._beginUpload(q, opts);
    if (!ctx) return 0;
    const current = this._staticsCurrent(q, ctx);
    const out = this._gpuPack !== null
      ? packSplitRowsWasm(this._gpuPack, q, ctx, this._sharedPose, current ? null : this._sharedStatic, this.capacity)
      : -1;
    if (out < 0) return this._packRefused(SPLIT_POSE_FLOATS * 4);
    if (out > 0) {
      this.copyIn(this.data, this._sharedPose, out * SPLIT_POSE_FLOATS);
      if (!current) this.copyIn(this.staticData, this._sharedStatic, out * POSE_STATIC_FLOATS);
    }
    return this._finishUpload(out, SPLIT_POSE_FLOATS * 4);
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
    return this._finishUpload(keep, SPLIT_POSE_FLOATS * 4);
  }

  /**
   * E-162: commit `count` slots of an indexed frame another worker packed (pre-render's GPU queue with
   * GPU_FLAG_INDEXED): the poses and the slot pairs in draw order, and `rows` queue rows' statics in row order, `gen`
   * their generation (0: unknown). The statics go up, the texture rows they fill, only when the generation or the
   * rows moved; the slot pairs only when their own generation `slotsGen` (the painter's order) or the slots moved.
   * A frame whose order moved uploads 24 bytes a sprite, one whose order holds 16.
   */
  commitIndexed(pose, slots, rowStatics, count, rows, gen, slotsGen) {
    const n = count | 0;
    const keep = n > this.capacity ? this.capacity : n;
    if (keep <= 0) return this._finishUpload(0, SPLIT_POSE_FLOATS * 4);
    const cap = (this._rowStatics.length / GPU_INDEXED_STATIC_FLOATS) | 0;
    const r = rows > cap ? cap : rows | 0;
    const g = gen >>> 0;
    if (g === 0 || g !== this._ixGen || r !== this._ixRows) {
      this._ixGen = g;
      this._ixRows = r;
      this.copyIn(this._rowStatics, rowStatics, r * GPU_INDEXED_STATIC_FLOATS);
      if (this._useWebGpu) {
        this._staticsSource.update(r * GPU_INDEXED_STATIC_FLOATS * 4);
      } else {
        const width = STATICS_TEX_ROW * STATICS_TEXELS_PER_ROW;
        this._statics.upload(this._staticsSource, this._rowStaticsU32, width, this._staticsHeight, 0, staticsTextureHeight(r));
      }
    }
    const sg = slotsGen >>> 0;
    if (sg === 0 || sg !== this._ixSlotsGen || keep !== this._ixSlots) {
      this._ixSlotsGen = sg;
      this._ixSlots = keep;
      this._slotsVersion++;
      this.copyIn(this._slotData, slots, keep * GPU_INDEXED_SLOT_FLOATS);
    }
    this.copyIn(this.data, pose, keep * SPLIT_POSE_FLOATS);
    return this._finishUpload(keep, SPLIT_POSE_FLOATS * 4, true);
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
