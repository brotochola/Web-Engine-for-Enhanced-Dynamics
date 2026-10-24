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

import { instancedSpriteGpuProgram, instancedSpriteShadowGpuProgram } from './webgpu/instancedSpriteWgsl.js';
import {
  instancedSpriteGlProgram,
  pickInstancedSpriteFragmentGlsl,
} from './webgl/instancedSpriteGlsl.js';
import { packInstancedRows } from './gpuQueueLayout.js';
import { packInstancedRowsWasm } from './gpuPackClient.js';

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
export const POSE_STATIC_FLOATS = 11;

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
   * @param {boolean} [opts.depthMask=true]
   * @param {boolean} [opts.alphaDiscard=true] - false → blend-only fragment (no discard)
   * @param {Float32Array} [opts.alphaCut] - xy: discard below x, discard at/above y (y=0 off). Default 0.01 when discarding.
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
    premultiplyAlpha = true,
    blendMode = 'normal',
    lutSource = null,
    useWebGpu = true,
    shaders = null,
    poseInterp = false,
    shadowCast = false,
    data = null,
    gpuPack = null,
  }) {
    this.capacity = Math.max(1, capacity | 0);
    this.poseInterp = !!poseInterp;
    this.shadowCast = !!shadowCast && !poseInterp;
    this._floats = this.poseInterp ? POSE_DYN_FLOATS : INSTANCED_SPRITE_FLOATS;
    if (this.shadowCast) this._floats += 7;
    this._strideBytes = this._floats * 4;
    // W9d: a plain sprite batch may take its rows from the render-queue memory, where gpuPack.wasm
    // writes them; `gpuPack` is that kernel's binding (gpuPackClient.bindGpuPack).
    const shared = !this.poseInterp && !this.shadowCast && data instanceof Float32Array
      && data.length >= this.capacity * this._floats ? data : null;
    this.data = shared || new Float32Array(this.capacity * this._floats);
    this.dataU32 = new Uint32Array(this.data.buffer, this.data.byteOffset, this.data.length);
    this._gpuPack = shared && gpuPack ? gpuPack : null;
    // A pose batch's static stream (E-82): its CPU copy, the key of what it holds, and the version
    // each ring slot's GPU copy holds (-1: none).
    this.staticData = new Float32Array(this.poseInterp ? this.capacity * POSE_STATIC_FLOATS : 0);
    this.staticDataU32 = new Uint32Array(this.staticData.buffer);
    this._staticVersion = 0;
    this._slotStaticVersion = [-1, -1];
    this._stGen = 0;
    this._stRows = -1;
    this._stScale = NaN;
    this._stFilter = -1;
    this._quad = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    this._index = [0, 1, 2, 0, 2, 3];
    const labelName = label || 'instanced-sprites';
    this._buffers = [
      this._makeInstanceBuffer(labelName),
      this._makeInstanceBuffer(labelName + '-ring'),
    ];
    this._staticBuffers = this.poseInterp
      ? [this._makeStaticBuffer(labelName + '-static'), this._makeStaticBuffer(labelName + '-static-ring')]
      : null;
    this._geometries = this._buffers.map((buf, r) => this._geometryFor(buf, this._staticBuffers ? this._staticBuffers[r] : null));
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

  _geometryFor(buf, staticBuf) {
    if (this.poseInterp) {
      // E-82: the pose stream (24-byte stride) and the static stream (44).
      const ds = POSE_DYN_FLOATS * 4;
      const ss = POSE_STATIC_FLOATS * 4;
      const geometry = new Geometry({
        attributes: {
          aQuad: { buffer: this._quad, format: 'float32x2' },
          aInstXY: { buffer: buf, format: 'float32x2', stride: ds, offset: 0, instance: true },
          aInstRotCS: { buffer: buf, format: 'float32x2', stride: ds, offset: 8, instance: true },
          aInstPrevXY: { buffer: buf, format: 'float32x2', stride: ds, offset: 16, instance: true },
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

  _makeSpriteShader(atlas, lut, alphaCut, name) {
    const uniforms = {
      uTileWorld: { value: this._tileWorld, type: 'vec4<f32>' },
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
      fragEntry = 'mainFrag';
    }
    const shaders = this._engineShaders;
    const spriteSource = this.poseInterp ? shaders?.spritePose : shaders?.sprite;
    const vertSource = this.poseInterp ? shaders?.spriteVertPose : shaders?.spriteVert;
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
  }

  setLutSource(source) {
    if (!source) return;
    this.shader.resources.uTexLut = source;
    if (this.shadowShader) this.shadowShader.resources.uTexLut = source;
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

  _finishUpload(out, stride) {
    if (out <= 0) {
      this.geometry.instanceCount = 0;
      this._show(false);
      return 0;
    }
    this._show(true);
    const ring = this._ring;
    this._ring = ring ^ 1;
    const geometry = this._geometries[ring];
    this._buffers[ring].update(out * stride);
    // E-82: a ring slot's static copy goes up only when it is older than the CPU one.
    const statics = this._staticBuffers;
    if (statics && this._slotStaticVersion[ring] !== this._staticVersion) {
      statics[ring].update(out * POSE_STATIC_FLOATS * 4);
      this._slotStaticVersion[ring] = this._staticVersion;
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
    const ctx = this._beginUpload(q, opts);
    if (!ctx) return 0;
    // W9d: the kernel packs what packInstancedRows' fast paths pack, bit for bit, and declines (-1)
    // the rest.
    let out = this._gpuPack !== null
      ? packInstancedRowsWasm(this._gpuPack, q, ctx, this.data, this._floats, this.capacity, this.shadowCast)
      : -1;
    if (out < 0) {
      out = packInstancedRows(
        q,
        ctx,
        this.data,
        this.dataU32,
        this._floats,
        this.capacity,
        this.shadowCast
      );
    }
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

  _uploadPose(q, opts) {
    const ctx = this._beginUpload(q, opts);
    if (!ctx) return 0;
    const out = this._staticsCurrent(q, ctx) ? this._packPoseOnly(q, ctx) : this._packPoseAndStatics(q, ctx);
    return this._finishUpload(out, POSE_DYN_FLOATS * 4);
  }

  /** The pose stream alone: the statics on the GPU are current. A copy of the loop below. */
  _packPoseOnly(q, ctx) {
    const o = ctx.o;
    const data = this.data;
    const indices = ctx.indices;
    const useIndices = ctx.useIndices;
    const useScreen = ctx.useScreen;
    const cameraX = ctx.cameraX;
    const cameraY = ctx.cameraY;
    const screenScale = ctx.screenScale;
    const typeArr = ctx.typeArr;
    const includeType = ctx.includeType;
    const exclude0 = ctx.exclude0;
    const exclude1 = ctx.exclude1;
    const hasInclude = ctx.hasInclude;
    const filterTypes = ctx.filterTypes;
    const scanCount = ctx.scanCount;
    const snap = !!o.snap;
    const prevXArr = snap ? null : o.prevX;
    const prevYArr = snap ? null : o.prevY;
    const rqX = q.x;
    const rqY = q.y;
    const rqRotC = q.rotC;
    const rqRotS = q.rotS;
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
      if (useScreen) {
        if (ctx.cameraRot) {
          const c = ctx.camC;
          const s = ctx.camS;
          const dx = x - ctx.focusX;
          const dy = y - ctx.focusY;
          x = ctx.halfW + (dx * c - dy * s) * screenScale;
          y = ctx.halfH + (dx * s + dy * c) * screenScale;
          const pdx = px - ctx.focusX;
          const pdy = py - ctx.focusY;
          px = ctx.halfW + (pdx * c - pdy * s) * screenScale;
          py = ctx.halfH + (pdx * s + pdy * c) * screenScale;
        } else {
          x = (x - cameraX) * screenScale;
          y = (y - cameraY) * screenScale;
          px = (px - cameraX) * screenScale;
          py = (py - cameraY) * screenScale;
        }
      }
      const snapped = snapSpritePos(x, y, o, useScreen);
      x = snapped.x;
      y = snapped.y;
      const snappedPrev = snapSpritePos(px, py, o, useScreen);
      px = snappedPrev.x;
      py = snappedPrev.y;
      let rc = rqRotC[i];
      let rs = rqRotS[i];
      if (useScreen && ctx.cameraRot) {
        const c = ctx.camC;
        const s = ctx.camS;
        const nrc = rc * c - rs * s;
        rs = rs * c + rc * s;
        rc = nrc;
      }
      data[base] = x;
      data[base + 1] = y;
      data[base + 2] = rc;
      data[base + 3] = rs;
      data[base + 4] = px;
      data[base + 5] = py;
      base += POSE_DYN_FLOATS;
      out++;
    }
    return out;
  }

  /** Both streams: the pose into data, the statics into staticData. */
  _packPoseAndStatics(q, ctx) {
    const o = ctx.o;
    const data = this.data;
    const stat = this.staticData;
    const statU32 = this.staticDataU32;
    const indices = ctx.indices;
    const useIndices = ctx.useIndices;
    const useScreen = ctx.useScreen;
    const cameraX = ctx.cameraX;
    const cameraY = ctx.cameraY;
    const screenScale = ctx.screenScale;
    const typeArr = ctx.typeArr;
    const includeType = ctx.includeType;
    const exclude0 = ctx.exclude0;
    const exclude1 = ctx.exclude1;
    const hasInclude = ctx.hasInclude;
    const filterTypes = ctx.filterTypes;
    const depthDenom = ctx.depthDenom;
    const scanCount = ctx.scanCount;
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
    let base = 0;
    let sBase = 0;
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
        if (ctx.cameraRot) {
          const c = ctx.camC;
          const s = ctx.camS;
          const dx = x - ctx.focusX;
          const dy = y - ctx.focusY;
          x = ctx.halfW + (dx * c - dy * s) * screenScale;
          y = ctx.halfH + (dx * s + dy * c) * screenScale;
          const pdx = px - ctx.focusX;
          const pdy = py - ctx.focusY;
          px = ctx.halfW + (pdx * c - pdy * s) * screenScale;
          py = ctx.halfH + (pdx * s + pdy * c) * screenScale;
        } else {
          x = (x - cameraX) * screenScale;
          y = (y - cameraY) * screenScale;
          px = (px - cameraX) * screenScale;
          py = (py - cameraY) * screenScale;
        }
        sx *= screenScale;
        sy *= screenScale;
      }
      const snapped = snapSpritePos(x, y, o, useScreen);
      x = snapped.x;
      y = snapped.y;
      const snappedPrev = snapSpritePos(px, py, o, useScreen);
      px = snappedPrev.x;
      py = snappedPrev.y;
      const depth = 1.0 - (out + 1) / depthDenom;
      let a = rqAlpha[i];
      if (a < 0) a = 0;
      else if (a > 1) a = 1;
      const a8 = (a * 255 + 0.5) | 0;
      const packed = ((a8 & 255) << 24) | (rqTint[i] & 0xffffff);
      const rx = rqRepeatX ? rqRepeatX[i] : 0;
      const ry = rqRepeatY ? rqRepeatY[i] : 0;
      const invX = rqTileMulX ? rqTileMulX[i] : (rx > 0 ? 1 / rx : 0);
      const invY = rqTileMulY ? rqTileMulY[i] : (ry > 0 ? 1 / ry : 0);
      let rc = rqRotC[i];
      let rs = rqRotS[i];
      if (useScreen && ctx.cameraRot) {
        const c = ctx.camC;
        const s = ctx.camS;
        const nrc = rc * c - rs * s;
        rs = rs * c + rc * s;
        rc = nrc;
      }
      data[base] = x;
      data[base + 1] = y;
      data[base + 2] = rc;
      data[base + 3] = rs;
      data[base + 4] = px;
      data[base + 5] = py;
      stat[sBase] = sx;
      stat[sBase + 1] = sy;
      stat[sBase + 2] = rqAnchorX[i];
      stat[sBase + 3] = rqAnchorY[i];
      stat[sBase + 4] = depth;
      statU32[sBase + 5] = packed >>> 0;
      stat[sBase + 6] = rqTextureId[i];
      stat[sBase + 7] = invX;
      stat[sBase + 8] = invY;
      stat[sBase + 9] = rqTileOffU ? rqTileOffU[i] * (1 / 65535) : 0;
      stat[sBase + 10] = rqTileOffV ? rqTileOffV[i] * (1 / 65535) : 0;
      base += POSE_DYN_FLOATS;
      sBase += POSE_STATIC_FLOATS;
      out++;
    }
    return out;
  }
}
