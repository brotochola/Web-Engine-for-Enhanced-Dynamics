/**
 * N-256 PW-10: the SCREEN layers (DX-POST, LAYER_KIND.SCREEN), moved out of pixiWorker.js as they were. Each is a look
 * over the whole finished frame: the stage drawn into a target, then each visible pass in zIndex order samples what is
 * under it (uTexture) and, when it names it, the frame before the first pass (uScene); the last pass draws onto the
 * canvas. The worker's present (_presentStage) goes through them while any is shown.
 *
 * The look shaders are the custom layers' (lookShaders.js: create, makeMesh). Until the renderer's
 * other subsystems move (N-256), what this class reads of the worker goes through `this.worker`.
 */

import { Layer, RESERVED_LOOK_UNIFORMS } from '../../core/layer.js';
import { debugWorkerLog } from '../../util/debugLog.js';
import { RenderTexture, Texture } from '../../vendor/pixi.min.js';
import { rtPixelSize } from '../gpuShadowCasters.js';
import { applyEngineLookUniforms, applyTexelSizeUniform, copyLookUniforms, finiteOrZero, layerIsVisible } from '../pixi/layerHelpers.js';
import { emptyLookTextures, lookReads } from '../pixi/lookPasses.js';
import { fusePointwise } from '../pointwisePass.js';
import { errorCompileFailed } from '../rendererBackend.js';

// The Pixi classes the moved bodies name as PIXI.X, as pixiWorker.js's namespace does.
const PIXI = Object.freeze({ RenderTexture, Texture });

/** Whether a draw of the chain shows: its layer, or any of the pointwise layers fused in it (DX-POSTFUSE). */
function stepIsVisible(step) {
  if (step.members === null) return layerIsVisible(step.layerId);
  for (let i = 0; i < step.members.length; i++) if (layerIsVisible(step.members[i].layerId)) return true;
  return false;
}

/** The SCREEN layers' passes and the frame they read, for one renderer worker. */
export class PixiScreenLayers {
  /** @param {object} worker the PixiRenderer that owns this (its renderer, camera, canvas and custom layers) */
  constructor(worker) {
    this.worker = worker;
    // DX-POST: the LAYER_KIND.SCREEN layers in zIndex order, and the frame they read (the stage drawn into a target).
    this.passes = [];
    // DX-POSTFUSE: the full-screen draws those layers make, in order: a layer's own pass, or a run of pointwise layers fused
    // into one (finish).
    this.steps = [];
    this.sceneRT = null;
    // DX-DEPTH: the frame target given a depth attachment for the entities' pixel depth (WebGPU), so it is asked once.
    this.sceneDepth = null;
    // E-525: the passes before the last draw into two targets a size, in turn (each reads the one before it): the shared
    // ones of slots 0 and 3 (lookPasses.js), each { rt, slot }, held from a pass's first draw at that size to a resize.
    this.chainTargets = [];
    // E-525: no pass reads uScene, so once the first pass has read the frame its target can take a later pass's output.
    this.sceneFree = false;
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
    const resolution = Layer._resolution?.[layerId];
    const record = {
      layerId,
      layerName,
      zIndex: Layer._zIndex?.[layerId] ?? 0,
      resolution: resolution > 0 ? resolution : 1,
      // How it samples the frame it reads ('linear', or 'nearest' for pixel art).
      scaleMode: Layer.scaleModeString(Layer._normalizeScaleMode(config.scaleMode)),
      shader: null,
      uniformStore: null,
      uniformEntries: config.uniformMap ? Object.entries(config.uniformMap) : null,
      mesh: null,
      reads: null,
      // DX-LAYERPASSES: the passes of its look before the last one, or null; E-525: in shared targets (read in this pass).
      earlierPasses: null,
      sharesTargets: true,
      compute: null,
      // DX-POSTFUSE: its map's source when it is pointwise (the fused draw has the shader), what the fusing needs, and where
      // each of its uniforms went in the fused one's.
      pointwise: config.shaderPointwise === true ? config.shaderFragment : null,
      uniformMap: config.uniformMap || null,
      uniformTypes: config.uniformTypes || null,
      fusedUniforms: null,
      members: null,
      on: null,
    };
    this.passes.push(record);
    this.passes.sort((a, b) => a.zIndex - b.zIndex);
    if (record.pointwise !== null) {
      debugWorkerLog(`PIXI WORKER: SCREEN layer "${layerName}" initialized (pointwise)`);
      return;
    }
    const uniformDefs = this.worker.lookShaders.buildUniformDefs(layerId, config.uniformMap, config.uniformTypes);
    // A pass that names uScene reads the frame before the first pass too (a bloom adds a blurred copy to it); DX-GBUFSHADER:
    // one that names uGbufFace or uGbufIds, this frame's G-buffer (gbufSources); DX-LAYERPASSES: one in several passes that
    // names uSource, the frame under the layer.
    const reads = lookReads(config.shaderFragment, true, config.shaderEarlier !== null);
    let shader;
    try {
      shader = this.worker.lookShaders.create(config.shaderFragment, PIXI.Texture.EMPTY.source, uniformDefs, name, layerName,
        emptyLookTextures(reads));
    } catch (err) {
      if (err && typeof err.message === 'string' && err.message.startsWith('WeedJS:')) throw err;
      throw errorCompileFailed('look', name, layerName, this.worker._useWebGpu ? 'WebGPU' : 'WebGL', err);
    }
    record.shader = shader;
    record.uniformStore = shader.resources?.customUniforms?.uniforms || null;
    record.mesh = this.worker.lookShaders.makeMesh(shader, false);
    record.reads = reads;
    record.earlierPasses = this.worker.lookPasses.make(config, true);
    debugWorkerLog(`PIXI WORKER: SCREEN layer "${layerName}" initialized`);
  }

  /**
   * DX-POSTFUSE: the draws the SCREEN layers make, once every layer is in: each one's own pass, and a run of consecutive
   * pointwise layers of one resolution as one draw that reads the frame once (pointwisePass.js).
   */
  finish() {
    this.steps = [];
    const layers = this.passes;
    for (let i = 0; i < layers.length;) {
      if (layers[i].pointwise === null) {
        this.steps.push(layers[i++]);
        continue;
      }
      let end = i + 1;
      while (end < layers.length && layers[end].pointwise !== null && layers[end].resolution === layers[i].resolution) end++;
      this.steps.push(this._fuse(layers.slice(i, end)));
      i = end;
    }
    let readsScene = false;
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      if (step.reads.scene) readsScene = true;
      const earlier = step.earlierPasses;
      if (earlier !== null) for (let p = 0; p < earlier.length; p++) if (earlier[p].reads.scene) readsScene = true;
    }
    this.sceneFree = !readsScene;
  }

  /** One fused draw of consecutive pointwise layers: their maps in order, each behind a uniform that says it is shown. */
  _fuse(members) {
    const wgsl = this.worker._useWebGpu;
    const own = members.map((m) => Object.keys(m.uniformMap || {}).filter((n) => !(n in RESERVED_LOOK_UNIFORMS)));
    const engine = Object.entries(RESERVED_LOOK_UNIFORMS).map(([name, def]) => ({ name, type: def.type }));
    const label = members.map((m) => m.layerName).join('+');
    const fused = fusePointwise(
      members.map((m, i) => ({ source: m.pointwise, layerName: m.layerName, uniforms: own[i], uniformTypes: m.uniformTypes || {} })),
      wgsl,
      engine,
    );
    // The fused shader's uniforms: the engine's, each member's switch, each member's own with its suffix.
    const defs = {};
    const map = {};
    const types = {};
    const add = (name, size, type, value) => {
      map[name] = { offset: -1, size };
      types[name] = type;
      defs[name] = { value: size === 1 ? value[0] : new Float32Array(value), type };
    };
    for (const [name, def] of Object.entries(RESERVED_LOOK_UNIFORMS)) {
      const size = Layer._getUniformSize(def.type);
      add(name, size, def.type, new Array(size).fill(0));
    }
    for (const name of fused.on) add(name, 1, 'f32', [0]);
    for (const u of fused.uniforms) {
      const m = members[u.member];
      const entry = m.uniformMap[u.uniform];
      const floats = Layer._uniformFloats[m.layerId];
      const value = [];
      for (let k = 0; k < entry.size; k++) value.push(floats ? floats[entry.offset + k] : 0);
      add(u.name, entry.size, m.uniformTypes?.[u.uniform] || 'f32', value);
      if (m.fusedUniforms === null) m.fusedUniforms = [];
      m.fusedUniforms.push([u.name, entry]);
    }
    let shader;
    try {
      shader = this.worker.lookShaders.create(fused.source, PIXI.Texture.EMPTY.source, defs, label, members[0].layerName,
        { uniformMap: map, uniformTypes: types });
    } catch (err) {
      if (err && typeof err.message === 'string' && err.message.startsWith('WeedJS:')) throw err;
      throw errorCompileFailed('look', label, label, wgsl ? 'WebGPU' : 'WebGL', err);
    }
    return {
      layerId: members[0].layerId,
      layerName: label,
      zIndex: members[0].zIndex,
      resolution: members[0].resolution,
      scaleMode: members[0].scaleMode,
      shader,
      uniformStore: shader.resources?.customUniforms?.uniforms || null,
      uniformEntries: null,
      mesh: this.worker.lookShaders.makeMesh(shader, false),
      reads: lookReads(null, true, false),
      earlierPasses: null,
      sharesTargets: true,
      compute: null,
      pointwise: null,
      uniformMap: map,
      uniformTypes: types,
      fusedUniforms: null,
      members,
      on: fused.on,
    };
  }

  destroyAll() {
    const steps = this.steps;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      this._unbindTextures(step);
      this.worker.lookPasses.destroy(step);
      step.mesh.destroy();
    }
    this.passes = [];
    this.steps = [];
    this._giveChainTargets();
    this.sceneFree = false;
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
   * target, and the last onto the canvas (DX-POSTFUSE: a run of pointwise layers is one such draw). Without a visible
   * one: false, and the present is the stage's as before.
   */
  present() {
    const layers = this.steps;
    let last = -1;
    for (let i = 0; i < layers.length; i++) if (stepIsVisible(layers[i])) last = i;
    if (last < 0) return false;
    const app = this.worker.pixiApp;
    if (!app?.renderer || !app.stage) return false;
    // E-448: the stage's target here has no depth buffer on WebGL, which the opaque pass draws with.
    if (this.worker.entitiesBatch !== null) this.worker.entitiesBatch.dropOpaquePass();
    const width = this.worker.canvasWidth;
    const height = this.worker.canvasHeight;
    this.sceneRT = this._sceneTarget(width, height);
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
    // E-525: with a depth attachment (DX-DEPTH) the frame's target is the stage's alone.
    const sceneFree = this.sceneFree && this.sceneDepth !== this.sceneRT;
    for (let i = 0; i <= last; i++) {
      const cl = layers[i];
      if (!stepIsVisible(cl)) continue;
      if (cl.members !== null) this._syncFused(cl);
      else this._syncUniforms(cl);
      applyEngineLookUniforms(cl, frame);
      const input = source.source;
      if (input.scaleMode !== cl.scaleMode) input.scaleMode = cl.scaleMode;
      this._bindFrame(cl.shader, cl.reads);
      if (cl.earlierPasses !== null) {
        for (let p = 0; p < cl.earlierPasses.length; p++) this._bindFrame(cl.earlierPasses[p].shader, cl.earlierPasses[p].reads);
        this.worker.lookPasses.draw(cl, input, rtPixelSize(width, cl.resolution), rtPixelSize(height, cl.resolution));
      } else {
        this.worker.lookPasses.bind(cl.shader, input, null);
      }
      applyTexelSizeUniform(cl, cl.shader.resources.uTexture);
      if (i === last) {
        // The canvas, cleared to its background first: a pass that copies gives the frame the stage would have.
        this.worker._submitRender(cl.mesh);
      } else {
        const out = this._chainTarget(source, rtPixelSize(width, cl.resolution), rtPixelSize(height, cl.resolution), sceneFree);
        opts.container = cl.mesh;
        opts.target = out;
        opts.clear = true;
        opts.clearColor = this.worker._clearTransparent;
        this.worker._submitRender(opts);
        source = out;
      }
    }
    opts.container = null;
    opts.target = null;
    opts.clearColor = this.worker._clearTransparent;
    return true;
  }

  /**
   * The frame's target at the canvas's size, width × height: the one there is when it has that size, else a new one. A
   * new size unbinds every pass first, then destroys the old one (a resized source keeps a stale framebuffer, as the other
   * viewport targets found) and gives back the chain's targets, which were its shares.
   */
  _sceneTarget(width, height) {
    const rt = this.sceneRT;
    if (rt && rt.width === width && rt.height === height) return rt;
    const layers = this.steps;
    for (let i = 0; i < layers.length; i++) this._unbindTextures(layers[i]);
    this._giveChainTargets();
    if (rt) {
      this.worker._releaseTextureBindGroups(rt);
      rt.destroy(true);
    }
    return PIXI.RenderTexture.create({ width, height });
  }

  /**
   * E-525: where a pass that is not the last draws, width × height: of the chain's two targets of that size the one it
   * does not read (`source`, the pass before it), or, with `sceneFree`, the frame's target once a pass has read it.
   */
  _chainTarget(source, width, height, sceneFree) {
    const scene = this.sceneRT;
    if (sceneFree && source !== scene && scene.width === width && scene.height === height) return scene;
    const first = this._chainHeld(width, height, 0);
    return first !== source ? first : this._chainHeld(width, height, 3);
  }

  /** E-525: the chain's shared target of width × height in `slot`, taken on its first draw (lookPasses.js). */
  _chainHeld(width, height, slot) {
    const held = this.chainTargets;
    for (let i = 0; i < held.length; i++) {
      const e = held[i];
      if (e.slot === slot && e.rt.width === width && e.rt.height === height) return e.rt;
    }
    const rt = this.worker.lookPasses.takeTarget(width, height, slot);
    held.push({ rt, slot });
    return rt;
  }

  /** E-525: the chain's targets given back (a resize, the scene's end); every pass is off them already. */
  _giveChainTargets() {
    const held = this.chainTargets;
    for (let i = 0; i < held.length; i++) this.worker.lookPasses.giveTarget(held[i].rt);
    held.length = 0;
  }

  _unbindTextures(cl) {
    this.worker.lookShaders.unbindTexture(cl.shader);
    this.worker.lookPasses.unbind(cl);
    this._unbindFrame(cl.shader, cl.reads);
    if (cl.earlierPasses === null) return;
    for (let p = 0; p < cl.earlierPasses.length; p++) this._unbindFrame(cl.earlierPasses[p].shader, cl.earlierPasses[p].reads);
  }

  /** What a pass reads of the frame besides its input: the frame before the first pass, the G-buffer. */
  _bindFrame(shader, reads) {
    const res = shader.resources;
    if (reads.scene && res.uScene !== this.sceneRT.source) res.uScene = this.sceneRT.source;
    if (reads.gbuf) {
      const g = this.gbufSources();
      if (res.uGbufFace !== g.face) res.uGbufFace = g.face;
      if (res.uGbufIds !== g.ids) res.uGbufIds = g.ids;
    }
  }

  _unbindFrame(shader, reads) {
    const empty = PIXI.Texture.EMPTY.source;
    if (reads.scene) shader.resources.uScene = empty;
    if (reads.gbuf) {
      shader.resources.uGbufFace = empty;
      shader.resources.uGbufIds = empty;
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

  /** DX-POSTFUSE: a fused draw's uniforms: each member's written from any thread, and whether it is shown. */
  _syncFused(step) {
    const store = step.uniformStore;
    if (!store) return;
    for (let k = 0; k < step.members.length; k++) {
      const m = step.members[k];
      store[step.on[k]] = layerIsVisible(m.layerId) ? 1 : 0;
      const dirtyRef = Layer._uniformDirty?.[m.layerId];
      if (!dirtyRef || Atomics.load(dirtyRef, 0) !== 1) continue;
      Atomics.store(dirtyRef, 0, 0);
      copyLookUniforms(m.fusedUniforms, Layer._uniformFloats[m.layerId], store);
    }
  }

  /** A SCREEN layer's uniforms written from any thread (Layer.x.setUniform), as updateCustomLayers does for looks. */
  _syncUniforms(cl) {
    const dirtyRef = Layer._uniformDirty?.[cl.layerId];
    if (!dirtyRef || Atomics.load(dirtyRef, 0) !== 1) return;
    Atomics.store(dirtyRef, 0, 0);
    const floats = Layer._uniformFloats[cl.layerId];
    copyLookUniforms(cl.uniformEntries, floats, cl.uniformStore);
    this.worker.lookPasses.syncUniforms(cl, cl.uniformEntries, floats);
  }
}
