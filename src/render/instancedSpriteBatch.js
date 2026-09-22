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

import { DECORATION_Y_SORT_SCALE, ENTITY_GLOW_SORT_BIAS } from '../util/configDefaults.js';
import { instancedSpriteGpuProgram } from './webgpu/instancedSpriteWgsl.js';
import {
  instancedSpriteGlProgram,
  pickInstancedSpriteFragmentGlsl,
} from './webgl/instancedSpriteGlsl.js';
import { writePosePrev } from './poseQueueInterp.js';

/** Below this, a texel is coverage, not a Z writer. Near 1 so the AA rim blends after every opaque core. */
export const SPRITE_OPAQUE_ALPHA = 254 / 255;

/** Compact instance floats: xy, scale, anchor, rotCS, depth, packedARGB, texId, tileInv, tileOff.
 *  tileInv sign: + WORLD (1/period), - LOCAL (worldVis/period), 0 stretch. tileOff is UV 0..1.
 *  Two extra floats vs pre-tile-offset stride — per visible instance, not per pool entity. */
export const INSTANCED_SPRITE_FLOATS = 15;
export const INSTANCED_SPRITE_STRIDE = INSTANCED_SPRITE_FLOATS * 4;
export const INSTANCED_SPRITE_POSE_FLOATS = 17;
export const INSTANCED_SPRITE_POSE_STRIDE = INSTANCED_SPRITE_POSE_FLOATS * 4;

export const BATCH_SPACE = Object.freeze({ WORLD: 0, SCREEN: 1 });
export const BATCH_DEPTH = Object.freeze({ INDEX: 0, SORT_KEY: 1 });

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

const Y_SORT_K = DECORATION_Y_SORT_SCALE;
const GLOW_BIAS = ENTITY_GLOW_SORT_BIAS;

/** Nearest sampling: land the anchor on a device pixel so every sprite shares the texel phase. */
export function snapWorldToPixel(v, cam, zoom) {
  if (!(zoom > 0)) return v;
  return Math.round((v - cam) * zoom) / zoom + cam;
}

const _snapXY = { x: 0, y: 0 };

function snapSpritePos(x, y, o, useScreen) {
  if (!o.pixelSnap) {
    _snapXY.x = x;
    _snapXY.y = y;
    return _snapXY;
  }
  if (useScreen) {
    _snapXY.x = Math.round(x);
    _snapXY.y = Math.round(y);
    return _snapXY;
  }
  _snapXY.x = snapWorldToPixel(x, o.snapCameraX, o.snapZoom);
  _snapXY.y = snapWorldToPixel(y, o.snapCameraY, o.snapZoom);
  return _snapXY;
}

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
   * @param {boolean} [opts.depthMask=true] - false → test Z (Y-sort) without writing (soft particles)
   * @param {boolean} [opts.alphaDiscard=true] - false → blend-only fragment (no discard; soft particles)
   * @param {Float32Array} [opts.alphaCut] - xy: discard below x, discard at/above y (y=0 off). Default 0.01 when discarding.
   * @param {boolean} [opts.coveragePass=false] - second draw: partial alpha, depth test, no Z write
   * @param {boolean} [opts.premultiplyAlpha=true] - true → normal PMA out; false → additive (glows)
   * @param {string} [opts.blendMode='normal'] - Pixi State blend mode
   * @param {boolean} [opts.useWebGpu=true] - compile GpuProgram vs GlProgram
   * @param {object} opts.shaders - fetched engine sources (`sprite` or spriteVert/frag*)
   */
  constructor({
    capacity,
    label,
    atlasSource,
    depthTest = true,
    depthMask = true,
    alphaDiscard = true,
    alphaCut = null,
    coveragePass = false,
    premultiplyAlpha = true,
    blendMode = 'normal',
    lutSource = null,
    useWebGpu = true,
    shaders = null,
    poseInterp = false,
  }) {
    this.capacity = Math.max(1, capacity | 0);
    this.poseInterp = !!poseInterp;
    this._floats = this.poseInterp ? INSTANCED_SPRITE_POSE_FLOATS : INSTANCED_SPRITE_FLOATS;
    this._strideBytes = this._floats * 4;
    this.data = new Float32Array(this.capacity * this._floats);
    this.dataU32 = new Uint32Array(this.data.buffer);
    this.buffer = new Buffer({
      data: this.data,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: label || 'instanced-sprites',
    });

    const quad = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const stride = this._strideBytes;
    const buf = this.buffer;
    const attributes = {
      aQuad: { buffer: quad, format: 'float32x2' },
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
    if (this.poseInterp) {
      attributes.aInstPrevXY = {
        buffer: buf,
        format: 'float32x2',
        stride,
        offset: 60,
        instance: true,
      };
    }

    this.geometry = new Geometry({
      attributes,
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });
    this.geometry.instanceCount = 0;

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

    this.coverageMesh = null;
    if (coveragePass) {
      const partialCut = new Float32Array([0, SPRITE_OPAQUE_ALPHA, 0, 0]);
      const partialShader = this._makeSpriteShader(
        atlas,
        lut,
        partialCut,
        (label || 'instanced-sprites') + '-partial'
      );
      const partialState = new State();
      partialState.blend = true;
      partialState.blendMode = blendMode || 'normal';
      partialState.depthTest = true;
      partialState.depthMask = false;
      partialState.culling = false;
      this.coverageMesh = new Mesh({
        geometry: this.geometry,
        shader: partialShader,
        state: partialState,
        label: (label || 'instanced-sprites') + '-partial',
      });
      this.coverageMesh.blendMode = partialState.blendMode;
      this.coverageMesh.visible = false;
      this.coverageMesh.cullable = false;
      this._coverageShader = partialShader;
    }
  }

  _makeSpriteShader(atlas, lut, alphaCut, name) {
    const uniforms = {
      uTileWorld: { value: this._tileWorld, type: 'vec4<f32>' },
      uAlphaCut: { value: alphaCut, type: 'vec4<f32>' },
    };
    if (this.poseInterp) {
      // Number, not Float32Array. Pixi's WebGL f32 sync compares the value
      // with !==. The same array never looks changed, so the GPU stays at 0.
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
      fragEntry = this._alphaDiscard ? 'mainFrag' : 'mainFragBlend';
    }
    const shaders = this._engineShaders;
    const spriteSource = this.poseInterp ? shaders?.spritePose : shaders?.sprite;
    const vertSource = this.poseInterp ? shaders?.spriteVertPose : shaders?.spriteVert;
    if (this._useWebGpu) {
      const gpuProgram = instancedSpriteGpuProgram(GpuProgram, spriteSource, fragEntry, name);
      return new Shader({ gpuProgram, resources });
    }
    const glProgram = instancedSpriteGlProgram(
      GlProgram,
      vertSource,
      pickInstancedSpriteFragmentGlsl(this._premultiplyAlpha, this._alphaDiscard, shaders),
      name
    );
    return new Shader({ glProgram, resources });
  }

  _show(on) {
    this.mesh.visible = on;
    if (this.coverageMesh) this.coverageMesh.visible = on;
  }

  setAtlasSource(source) {
    if (!source) return;
    this.shader.resources.uTexture = source;
    this.shader.resources.uSampler = source.style;
    if (this._coverageShader) {
      this._coverageShader.resources.uTexture = source;
      this._coverageShader.resources.uSampler = source.style;
    }
  }

  setLutSource(source) {
    if (source) this.shader.resources.uTexLut = source;
    if (source && this._coverageShader) this._coverageShader.resources.uTexLut = source;
  }

  setPoseAlpha(alpha) {
    if (!this.poseInterp) return;
    const group = this.shader?.resources?.uniforms;
    if (!group?.uniforms) return;
    group.uniforms.uPoseAlpha = alpha;
    if (typeof group.update === 'function') group.update();
    const cover = this._coverageShader?.resources?.uniforms;
    if (cover?.uniforms) {
      cover.uniforms.uPoseAlpha = alpha;
      if (typeof cover.update === 'function') cover.update();
    }
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
   * @param {number} [opts.depthMode=0] - BATCH_DEPTH.INDEX | SORT_KEY
   * @param {number} [opts.worldHeight=1]
   * @param {Float32Array|null} [opts.sortKey] - composite collector keys (depthMode SORT_KEY)
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
    const o = opts || EMPTY_UPLOAD_OPTS;
    const count = q.count | 0;
    const indices = o.indices;
    const indexCount = o.indexCount | 0;
    const useIndices = indices != null;
    if ((!useIndices && count <= 0) || (useIndices && indexCount <= 0)) {
      this.geometry.instanceCount = 0;
      this._show(false);
      return 0;
    }

    const data = this.data;
    const dataU32 = this.dataU32;
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
    const depthMode = o.depthMode | 0;
    const worldHeight = o.worldHeight > 0 ? o.worldHeight : 1;
    const typeArr = o.type || null;
    const sortKeyArr = o.sortKey || null;
    const includeType = o.includeType | 0;
    const exclude0 = o.excludeType0 | 0;
    const exclude1 = o.excludeType1 | 0;
    const hasInclude = includeType >= 0;
    const hasExclude = exclude0 >= 0 || exclude1 >= 0;
    const filterTypes = !useIndices && typeArr && (hasInclude || hasExclude);
    const depthDenom = (o.depthDenom || this.capacity) + 1;
    const sortKeyMax = worldHeight * Y_SORT_K + GLOW_BIAS + 1;

    const rqX = q.x;
    const rqY = q.y;
    const rqScaleX = q.scaleX;
    const rqScaleY = q.scaleY;
    const rqRotC = q.rotC;
    const rqRotS = q.rotS;
    const rqAlpha = q.alpha;
    const rqTint = q.tint;
    const rqTextureId = q.textureId;
    const rqAnchorX = q.anchorX;
    const rqAnchorY = q.anchorY;
    const rqRepeatX = q.repeatX;
    const rqRepeatY = q.repeatY;
    const rqTileMulX = q.tileMulX;
    const rqTileMulY = q.tileMulY;
    const rqTileOffU = q.tileOffsetU;
    const rqTileOffV = q.tileOffsetV;

    const useSortKey = depthMode === BATCH_DEPTH.SORT_KEY && sortKeyArr;
    if (!useIndices && hasInclude && !typeArr) {
      this.geometry.instanceCount = 0;
      this._show(false);
      return 0;
    }
    const scanCount = useIndices
      ? indexCount
      : count > this.capacity && !filterTypes
        ? this.capacity
        : count;
    let base = 0;
    let out = 0;
    for (let k = 0; k < scanCount; k++) {
      const i = useIndices ? indices[k] : k;
      if (filterTypes) {
        const t = typeArr[i];
        if (hasInclude && t !== includeType) continue;
        if ((exclude0 >= 0 && t === exclude0) || (exclude1 >= 0 && t === exclude1)) continue;
      }
      if (out >= this.capacity) break;

      const worldY = rqY[i];
      let x = rqX[i];
      let y = worldY;
      let sx = rqScaleX[i];
      let sy = rqScaleY[i];
      if (useScreen) {
        x = (x - cameraX) * screenScale;
        y = (y - cameraY) * screenScale;
        sx *= screenScale;
        sy *= screenScale;
      }
      const snapped = snapSpritePos(x, y, o, useScreen);
      x = snapped.x;
      y = snapped.y;

      let depth;
      if (useSortKey) {
        depth = 1.0 - sortKeyArr[i] / sortKeyMax;
        depth -= (out + 1) * 1e-7;
      } else {
        depth = 1.0 - (out + 1) / depthDenom;
      }

      let a = rqAlpha[i];
      if (a < 0) a = 0;
      else if (a > 1) a = 1;
      const a8 = (a * 255 + 0.5) | 0;
      const packed = ((a8 & 255) << 24) | (rqTint[i] & 0xffffff);

      const rx = rqRepeatX ? rqRepeatX[i] : 0;
      const ry = rqRepeatY ? rqRepeatY[i] : 0;
      const invX = rqTileMulX ? rqTileMulX[i] : (rx > 0 ? 1 / rx : 0);
      const invY = rqTileMulY ? rqTileMulY[i] : (ry > 0 ? 1 / ry : 0);
      data[base] = x;
      data[base + 1] = y;
      data[base + 2] = sx;
      data[base + 3] = sy;
      data[base + 4] = rqAnchorX[i];
      data[base + 5] = rqAnchorY[i];
      data[base + 6] = rqRotC[i];
      data[base + 7] = rqRotS[i];
      data[base + 8] = depth;
      dataU32[base + 9] = packed >>> 0;
      data[base + 10] = rqTextureId[i];
      data[base + 11] = invX;
      data[base + 12] = invY;
      data[base + 13] = rqTileOffU ? rqTileOffU[i] * (1 / 65535) : 0;
      data[base + 14] = rqTileOffV ? rqTileOffV[i] * (1 / 65535) : 0;
      base += INSTANCED_SPRITE_FLOATS;
      out++;
    }

    if (out <= 0) {
      this.geometry.instanceCount = 0;
      this._show(false);
      return 0;
    }

    this._show(true);
    this.buffer.update(out * INSTANCED_SPRITE_STRIDE);
    this.geometry.instanceCount = out;
    return out;
  }

  _uploadPose(q, opts) {
    const o = opts || EMPTY_UPLOAD_OPTS;
    const count = q.count | 0;
    const indices = o.indices;
    const indexCount = o.indexCount | 0;
    const useIndices = indices != null;
    if ((!useIndices && count <= 0) || (useIndices && indexCount <= 0)) {
      this.geometry.instanceCount = 0;
      this._show(false);
      return 0;
    }
    const data = this.data;
    const dataU32 = this.dataU32;
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
    const depthMode = o.depthMode | 0;
    const worldHeight = o.worldHeight > 0 ? o.worldHeight : 1;
    const typeArr = o.type || null;
    const sortKeyArr = o.sortKey || null;
    const includeType = o.includeType | 0;
    const exclude0 = o.excludeType0 | 0;
    const exclude1 = o.excludeType1 | 0;
    const hasInclude = includeType >= 0;
    const hasExclude = exclude0 >= 0 || exclude1 >= 0;
    const filterTypes = !useIndices && typeArr && (hasInclude || hasExclude);
    const depthDenom = (o.depthDenom || this.capacity) + 1;
    const sortKeyMax = worldHeight * Y_SORT_K + GLOW_BIAS + 1;
    const snap = !!o.snap;
    const prevXArr = snap ? null : o.prevX;
    const prevYArr = snap ? null : o.prevY;
    const rqX = q.x;
    const rqY = q.y;
    const rqScaleX = q.scaleX;
    const rqScaleY = q.scaleY;
    const rqRotC = q.rotC;
    const rqRotS = q.rotS;
    const rqAlpha = q.alpha;
    const rqTint = q.tint;
    const rqTextureId = q.textureId;
    const rqAnchorX = q.anchorX;
    const rqAnchorY = q.anchorY;
    const rqRepeatX = q.repeatX;
    const rqRepeatY = q.repeatY;
    const rqTileMulX = q.tileMulX;
    const rqTileMulY = q.tileMulY;
    const rqTileOffU = q.tileOffsetU;
    const rqTileOffV = q.tileOffsetV;
    const useSortKey = depthMode === BATCH_DEPTH.SORT_KEY && sortKeyArr;
    const scanCount = useIndices
      ? indexCount
      : count > this.capacity && !filterTypes
        ? this.capacity
        : count;
    let base = 0;
    let out = 0;
    for (let k = 0; k < scanCount; k++) {
      const i = useIndices ? indices[k] : k;
      if (filterTypes) {
        const t = typeArr[i];
        if (hasInclude && t !== includeType) continue;
        if ((exclude0 >= 0 && t === exclude0) || (exclude1 >= 0 && t === exclude1)) continue;
      }
      if (out >= this.capacity) break;
      let x = rqX[i];
      let y = rqY[i];
      let px = prevXArr ? prevXArr[i] : x;
      let py = prevYArr ? prevYArr[i] : y;
      let sx = rqScaleX[i];
      let sy = rqScaleY[i];
      if (useScreen) {
        x = (x - cameraX) * screenScale;
        y = (y - cameraY) * screenScale;
        px = (px - cameraX) * screenScale;
        py = (py - cameraY) * screenScale;
        sx *= screenScale;
        sy *= screenScale;
      }
      const snapped = snapSpritePos(x, y, o, useScreen);
      x = snapped.x;
      y = snapped.y;
      const snappedPrev = snapSpritePos(px, py, o, useScreen);
      px = snappedPrev.x;
      py = snappedPrev.y;
      let depth;
      if (useSortKey) {
        depth = 1.0 - sortKeyArr[i] / sortKeyMax;
        depth -= (out + 1) * 1e-7;
      } else {
        depth = 1.0 - (out + 1) / depthDenom;
      }
      let a = rqAlpha[i];
      if (a < 0) a = 0;
      else if (a > 1) a = 1;
      const a8 = (a * 255 + 0.5) | 0;
      const packed = ((a8 & 255) << 24) | (rqTint[i] & 0xffffff);
      const rx = rqRepeatX ? rqRepeatX[i] : 0;
      const ry = rqRepeatY ? rqRepeatY[i] : 0;
      const invX = rqTileMulX ? rqTileMulX[i] : (rx > 0 ? 1 / rx : 0);
      const invY = rqTileMulY ? rqTileMulY[i] : (ry > 0 ? 1 / ry : 0);
      data[base] = x;
      data[base + 1] = y;
      data[base + 2] = sx;
      data[base + 3] = sy;
      data[base + 4] = rqAnchorX[i];
      data[base + 5] = rqAnchorY[i];
      data[base + 6] = rqRotC[i];
      data[base + 7] = rqRotS[i];
      data[base + 8] = depth;
      dataU32[base + 9] = packed >>> 0;
      data[base + 10] = rqTextureId[i];
      data[base + 11] = invX;
      data[base + 12] = invY;
      data[base + 13] = rqTileOffU ? rqTileOffU[i] * (1 / 65535) : 0;
      data[base + 14] = rqTileOffV ? rqTileOffV[i] * (1 / 65535) : 0;
      writePosePrev(data, base, px, py);
      base += INSTANCED_SPRITE_POSE_FLOATS;
      out++;
    }
    if (out <= 0) {
      this.geometry.instanceCount = 0;
      this._show(false);
      return 0;
    }
    this._show(true);
    this.buffer.update(out * INSTANCED_SPRITE_POSE_STRIDE);
    this.geometry.instanceCount = out;
    return out;
  }
}
