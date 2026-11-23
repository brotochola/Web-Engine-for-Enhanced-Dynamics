/**
 * N-256 PW-10: the SCREEN layers (DX-POST, LAYER_KIND.SCREEN), moved out of pixiWorker.js as they were. Each is a look
 * over the whole finished frame: the stage drawn into a target, then each visible pass in zIndex order samples what is
 * under it (uTexture) and, when it names it, the frame before the first pass (uScene); the last pass draws onto the
 * canvas. The worker's present (_presentStage) goes through them while any is shown.
 *
 * The look shaders are the custom layers' (lookShaders.js: create, makeMesh). Until the renderer's
 * other subsystems move (N-256), what this class reads of the worker goes through `this.worker`.
 */

import { Layer } from '../../core/layer.js';
import { debugWorkerLog } from '../../util/debugLog.js';
import { RenderTexture, Texture } from '../../vendor/pixi.min.js';
import { rtPixelSize } from '../gpuShadowCasters.js';
import { applyEngineLookUniforms, finiteOrZero, layerIsVisible } from '../pixi/layerHelpers.js';
import { errorCompileFailed } from '../rendererBackend.js';

// The Pixi classes the moved bodies name as PIXI.X, as pixiWorker.js's namespace does.
const PIXI = Object.freeze({ RenderTexture, Texture });

/** The SCREEN layers' passes and the frame they read, for one renderer worker. */
export class PixiScreenLayers {
  /** @param {object} worker the PixiRenderer that owns this (its renderer, camera, canvas and custom layers) */
  constructor(worker) {
    this.worker = worker;
    // DX-POST: the LAYER_KIND.SCREEN passes in zIndex order, and the frame they read (the stage drawn into a target).
    this.passes = [];
    this.sceneRT = null;
    // DX-DEPTH: the frame target given a depth attachment for the entities' pixel depth (WebGPU), so it is asked once.
    this.sceneDepth = null;
    this.clearColor = [0, 0, 0, 1];
    // DX-GBUFSHADER: gbufSources' answer, one object kept.
    this._gbuf = { face: null, ids: null };
  }

  /**
   * DX-POST: a LAYER_KIND.SCREEN layer. Its look reads the frame below it (uTexture, bound each frame by
   * _presentThroughScreenLayers), through one full-screen mesh that draws into a target or onto the canvas alike: every
   * frame the passes read is laid out as the canvas is (on WebGL the stage is drawn into it with the canvas's
   * projection), so the mesh copies texel for pixel, no V flip. It is not on the stage: the stage is what the passes read.
   * @param {object} config the layer's worker metadata
   */
  initLayer(config) {
    const layerId = config.id;
    const layerName = config.name;
    const name = config.shaderName || layerName;
    const uniformDefs = this.worker.lookShaders.buildUniformDefs(layerId, config.uniformMap, config.uniformTypes);
    // A pass that names uScene reads the frame before the first pass too (a bloom adds a blurred copy to it).
    const usesScene = typeof config.shaderFragment === 'string' && /\buScene\b/.test(config.shaderFragment);
    // DX-GBUFSHADER: one that names uGbufFace or uGbufIds reads this frame's G-buffer (gbufSources).
    const usesGbuf = typeof config.shaderFragment === 'string' && /\buGbuf(Face|Ids)\b/.test(config.shaderFragment);
    let shader;
    try {
      const empty = PIXI.Texture.EMPTY.source;
      shader = this.worker.lookShaders.create(config.shaderFragment, empty, uniformDefs, name, layerName, usesScene ? empty : null,
        usesGbuf);
    } catch (err) {
      if (err && typeof err.message === 'string' && err.message.startsWith('WeedJS:')) throw err;
      throw errorCompileFailed('look', name, layerName, this.worker._useWebGpu ? 'WebGPU' : 'WebGL', err);
    }
    const resolution = Layer._resolution?.[layerId];
    this.passes.push({
      layerId,
      layerName,
      zIndex: Layer._zIndex?.[layerId] ?? 0,
      resolution: resolution > 0 ? resolution : 1,
      // How it samples the frame it reads ('linear', or 'nearest' for pixel art).
      scaleMode: Layer.scaleModeString(Layer._normalizeScaleMode(config.scaleMode)),
      shader,
      uniformStore: shader.resources?.customUniforms?.uniforms || null,
      uniformEntries: config.uniformMap ? Object.entries(config.uniformMap) : null,
      mesh: this.worker.lookShaders.makeMesh(shader, false),
      usesScene,
      usesGbuf,
      // Its output when it is not the last visible pass: the canvas's size times its resolution.
      target: null,
    });
    this.passes.sort((a, b) => a.zIndex - b.zIndex);
    debugWorkerLog(`PIXI WORKER: SCREEN layer "${layerName}" initialized`);
  }

  destroyAll() {
    const layers = this.passes;
    for (let i = 0; i < layers.length; i++) {
      const cl = layers[i];
      this._unbindTextures(cl);
      if (cl.target) {
        this.worker._releaseTextureBindGroups(cl.target);
        cl.target.destroy(true);
      }
      cl.mesh.destroy();
    }
    this.passes = [];
    if (this.sceneRT) {
      this.worker._releaseTextureBindGroups(this.sceneRT);
      this.sceneRT.destroy(true);
      this.sceneRT = null;
    }
    this.sceneDepth = null;
  }

  /** DX-POST: whether a SCREEN layer is visible, so the stage goes into a target of its own (_presentThroughScreenLayers). */
  shown() {
    const layers = this.passes;
    for (let i = 0; i < layers.length; i++) if (layerIsVisible(layers[i].layerId)) return true;
    return false;
  }

  /**
   * DX-POST: with a visible SCREEN layer, the stage goes into a target the canvas's size, cleared to the canvas's
   * background. Each visible SCREEN layer then, in zIndex order, reads what came before it and draws into its own
   * target, and the last onto the canvas. Without a visible one: false, and the present is the stage's as before.
   */
  present() {
    const layers = this.passes;
    let last = -1;
    for (let i = 0; i < layers.length; i++) if (layerIsVisible(layers[i].layerId)) last = i;
    if (last < 0) return false;
    const app = this.worker.pixiApp;
    if (!app?.renderer || !app.stage) return false;
    // E-448: the stage's target here has no depth buffer on WebGL, which the opaque pass draws with.
    if (this.worker.entitiesBatch !== null) this.worker.entitiesBatch.dropOpaquePass();
    const width = this.worker.canvasWidth;
    const height = this.worker.canvasHeight;
    this.sceneRT = this._target(this.sceneRT, width, height);
    // DX-DEPTH: the entities' pixel depth writes frag_depth on WebGPU, and a pipeline that does needs a depth attachment
    // in its target (WebGL draws the painter alone in a target without one).
    if (this.sceneDepth !== this.sceneRT && this.worker._useWebGpu && this.worker.entitiesBatch !== null
      && this.worker.entitiesBatch.pixelDepthOn) {
      this.worker._ensureTargetDepth(this.sceneRT);
      this.sceneDepth = this.sceneRT;
    }

    const opts = this.worker._rtRenderOpts;
    const background = app.renderer.background?.colorRgba;
    const clear = this.clearColor;
    if (background) {
      clear[0] = background[0];
      clear[1] = background[1];
      clear[2] = background[2];
      clear[3] = background[3];
    }
    opts.transform = null;
    opts.container = app.stage;
    opts.target = this.sceneRT;
    opts.clear = true;
    opts.clearColor = clear;
    // WebGL draws into a texture upside down from the canvas (Pixi flips the projection): flipY undoes it, so the
    // stage lands as on the canvas, pixel for pixel, and a copy pass is exact. WebGPU has no such flip.
    opts.flipY = !this.worker._useWebGpu;
    this.worker._submitRender(opts);
    opts.flipY = false;

    const frame = this.worker._computeFrame;
    frame.dt = this.worker._lastDt || 1 / 60;
    frame.cameraX = this.worker._renderCameraX;
    frame.cameraY = this.worker._renderCameraY;
    frame.canvasW = width;
    frame.canvasH = height;
    // DX-GBUFSHADER: the G-buffer's size in texels (uGbufSize), 0 0 in a scene that draws none.
    const gb = this.gbufSources();
    frame.gbufW = gb.face.pixelWidth > 1 ? gb.face.pixelWidth : 0;
    frame.gbufH = gb.face.pixelWidth > 1 ? gb.face.pixelHeight : 0;
    frame.zoom = this.worker._renderZoom;
    frame.time = (this.worker.accumulatedTime || 0) * 0.001;
    frame.worldW = finiteOrZero(this.worker.worldWidth);
    frame.worldH = finiteOrZero(this.worker.worldHeight);

    let source = this.sceneRT;
    for (let i = 0; i <= last; i++) {
      const cl = layers[i];
      if (!layerIsVisible(cl.layerId)) continue;
      this._syncUniforms(cl);
      applyEngineLookUniforms(cl, frame);
      const input = source.source;
      if (input.scaleMode !== cl.scaleMode) input.scaleMode = cl.scaleMode;
      const res = cl.shader.resources;
      if (res.uTexture !== input) res.uTexture = input;
      if (res.uSampler !== undefined && res.uSampler !== input.style) res.uSampler = input.style;
      if (cl.usesScene && res.uScene !== this.sceneRT.source) res.uScene = this.sceneRT.source;
      if (cl.usesGbuf) {
        const g = this.gbufSources();
        if (res.uGbufFace !== g.face) res.uGbufFace = g.face;
        if (res.uGbufIds !== g.ids) res.uGbufIds = g.ids;
      }
      if (i === last) {
        // The canvas, cleared to its background first: a pass that copies gives the frame the stage would have.
        this.worker._submitRender(cl.mesh);
      } else {
        cl.target = this._target(cl.target, rtPixelSize(width, cl.resolution), rtPixelSize(height, cl.resolution));
        opts.container = cl.mesh;
        opts.target = cl.target;
        opts.clear = true;
        opts.clearColor = this.worker._clearTransparent;
        this.worker._submitRender(opts);
        source = cl.target;
      }
    }
    opts.container = null;
    opts.target = null;
    opts.clearColor = this.worker._clearTransparent;
    return true;
  }

  /**
   * A target of width × height: `rt` when it has that size, else a new one. The old one is unbound from every pass
   * first and destroyed (a resized source keeps a stale framebuffer, as the other viewport targets found).
   */
  _target(rt, width, height) {
    if (rt && rt.width === width && rt.height === height) return rt;
    if (rt) {
      const layers = this.passes;
      for (let i = 0; i < layers.length; i++) this._unbindTextures(layers[i]);
      this.worker._releaseTextureBindGroups(rt);
      rt.destroy(true);
    }
    return PIXI.RenderTexture.create({ width, height });
  }

  _unbindTextures(cl) {
    this.worker.lookShaders.unbindTexture(cl.shader);
    if (cl.usesScene) cl.shader.resources.uScene = PIXI.Texture.EMPTY.source;
    if (cl.usesGbuf) {
      cl.shader.resources.uGbufFace = PIXI.Texture.EMPTY.source;
      cl.shader.resources.uGbufIds = PIXI.Texture.EMPTY.source;
    }
  }

  /**
   * DX-GBUFSHADER: this frame's G-buffer for a pass that reads it: the face map and the entity ids map (faceMap.js), at the
   * light pass's size; a 1 x 1 empty texture (alpha 0: nothing written) for one the scene does not draw (no lit G-buffer:
   * no map shadows, maps, faces, walls or unshaded sprites). The passes run after the frame's light pass, so they read its own.
   * @returns {{ face: TextureSource, ids: TextureSource }}
   */
  gbufSources() {
    const lighting = this.worker.lighting;
    const empty = PIXI.Texture.EMPTY.source;
    const out = this._gbuf;
    out.face = lighting && lighting.faceRT ? lighting.faceRT.source : empty;
    out.ids = lighting && lighting.faceIdsRT ? lighting.faceIdsRT.source : empty;
    return out;
  }

  /** A SCREEN layer's uniforms written from any thread (Layer.x.setUniform), as updateCustomLayers does for looks. */
  _syncUniforms(cl) {
    const dirtyRef = Layer._uniformDirty?.[cl.layerId];
    if (!dirtyRef || Atomics.load(dirtyRef, 0) !== 1) return;
    Atomics.store(dirtyRef, 0, 0);
    const floats = Layer._uniformFloats[cl.layerId];
    const entries = cl.uniformEntries;
    const u = cl.uniformStore;
    if (!floats || !entries || !u) return;
    for (let ei = 0; ei < entries.length; ei++) {
      const [uName, entry] = entries[ei];
      if (entry.size === 1) {
        u[uName] = floats[entry.offset];
      } else {
        const target = u[uName];
        if (target && typeof target === 'object' && target.length) {
          for (let k = 0; k < entry.size; k++) target[k] = floats[entry.offset + k];
        }
      }
    }
  }
}
