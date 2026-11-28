/**
 * N-256 PW-3: the renderer's custom layers, moved out of pixiWorker.js as they were. Each configured layer's runtime
 * (by layerId and as a list): its sprite, fill and UV batches, its targets and their resolution, its look shader, its
 * compute and post-process passes, a world-rect layer's cached draw, the pictures it shares with the logic workers,
 * the painter it sorts with, and the pose snapshot a compute layer packs from. initializeCustomLayers makes them,
 * updateCustomLayers draws them each frame (the worker's drawFrameCustomLayers calls it), setLayerProps applies a
 * run-time change. The look shaders are the SCREEN layers' too.
 *
 * Until the renderer's other subsystems move (N-256), what this class reads of the worker (its renderer, backend,
 * camera, canvas, render helpers, queues, batches, shaders, assets and mesh layers) goes through `this.worker`.
 */

import { GpuParticles } from '../../core/gpuParticles.js';
import { Layer } from '../../core/layer.js';
import { LiquidFun } from '../../core/liquidFun.js';
import { SharedResource } from '../../core/sharedResource.js';
import { Sun } from '../../core/sun.js';
import { LAYER_DENSITY_SOURCE, LAYER_KIND, LAYER_SCALE_MODE } from '../../util/configDefaults.js';
import { debugWorkerLog } from '../../util/debugLog.js';
import { meshLayerCapacities } from '../../util/meshMemory.js';
import { Container, Mesh, RenderTexture, Sprite, Texture, TextureSource } from '../../vendor/pixi.min.js';
import {
  COLLIDER_FILL_FLOATS,
  COLLIDER_FILL_PACK_FIRST_FRAME,
  ColliderFillBatch,
  MESH_FILL_PRESENCE_MOVED,
  clearMeshFillPaintDirty,
  colliderFillEpochsMatch,
  packColliderFill,
  packColliderFillPoseOnly,
  packMeshUvVertsPaint,
  trackMeshFillPose,
} from '../colliderFillBatch.js';
import { GpuParticleLayerBatch } from '../gpuParticleBatch.js';
import { BATCH_SPACE, INSTANCED_SPRITE_FLOATS, InstancedSpriteBatch } from '../instancedSpriteBatch.js';
import { installInstanceRangeDraw } from '../instanceRangeDraw.js';
import { LiquidFunDensitySplat } from '../liquidFunDensitySplat.js';
import { bindPainterRadix, wasmPainterState } from '../painterRadixClient.js';
import { emptyInstancedMesh } from '../pixi/meshLayers.js';
import { errorCompileFailed } from '../rendererBackend.js';
import { createViews as createRenderQueueViews } from '../renderQueueLayout.js';
import { uploadSharedImage } from '../sharedTextureUpload.js';
import { ComputeLayer } from '../webgpu/computeLayer.js';
import {
  WORLD_RECT_DIRECT,
  WORLD_RECT_SHOW,
  createWorldRectCache,
  readsFrameTime,
  worldRectCacheStep,
  worldRectGivesUp,
} from '../worldRectCache.js';
import { createSharedTextureSource, createWorldRectMesh } from '../worldTextureMesh.js';
import {
  applyComputeTexSizeUniform, applyEngineLookUniforms, applyTexelSizeUniform, copyLookUniforms, finiteOrZero, layerIsVisible,
} from './layerHelpers.js';
import { emptyLookTextures, lookReads } from './lookPasses.js';

// The Pixi classes the moved bodies name as PIXI.X, as pixiWorker.js's namespace does.
const PIXI = Object.freeze({ Container, Mesh, RenderTexture, Sprite, Texture, TextureSource });

/** The custom layers' runtimes and their per-frame drawing, for one renderer worker. */
export class PixiCustomLayers {
  /** @param {object} worker the PixiRenderer that owns this (its renderer, camera, queues, batches and the other subsystems) */
  constructor(worker) {
    this.worker = worker;
    // Custom layer rendering infrastructure (populated during initialize)
    this.byId = {};  // layerId -> { buffers, readRef, sprites, poolIndices, prevCount, pc, rt, displaySprite, filter }
    this.list = []; // Cached array of custom layer objects, set once during init
    this.meshFillInstancesThisFrame = 0;
    this.meshRtDrawsThisFrame = 0;
    // Reused compute pack pose (same generation as sprites). Filled on new queue frame.
    this.computePose = {
      poseX: null,
      poseY: null,
      poseRotC: null,
      poseRotS: null,
      prevPoseX: null,
      prevPoseY: null,
      prevPoseRotC: null,
      prevPoseRotS: null,
    };
    this.splatUploadOpts = {
      layerId: 0,
      zoom: 1,
      cameraX: 0,
      cameraY: 0,
      resolution: 1,
      radius: 48,
      intensity: 1,
      useParticleTint: true,
      canvasW: 0,
      canvasH: 0,
    };
    // Per MESH layer: last packed ColliderFixture.revision + pose scratch.
    // ponytail: first frame / replace / moving mesh always pack; skip keeps instanceCount.
    this.fillSkip = [];
    /** E-504: cached worldRect layers drawn into their targets, since the start (tests read it). */
    this.worldRectDraws = 0;
    this.poseSnapX = null;
    this.poseSnapY = null;
    this.poseSnapRotC = null;
    this.poseSnapRotS = null;
    this.poseSnapPrevX = null;
    this.poseSnapPrevY = null;
    this.poseSnapPrevRotC = null;
    this.poseSnapPrevRotS = null;
  }

  /**
   * @param {object} data the init message (or its layers' part)
   * @param {boolean} [meshMemoryBound] initialize bound the mesh memory with its other kernels (_bindMeshMemory)
   */
  async initialize(data, meshMemoryBound = false) {
    const prev = this.list || [];
    for (let i = 0; i < prev.length; i++) {
      const old = prev[i];
      // E-504: the paint mesh shares the stage mesh's geometry and shader, which the stage mesh's destroy takes.
      if (old && old.worldPaintMesh) old.worldPaintMesh.destroy(false);
      if (old && old.worldMesh) old.worldMesh.destroy(true);
      if (old && old.worldRt) {
        old.displaySprite?.destroy();
        old.worldHolder?.destroy({ children: false });
        old.worldRt.destroy(true);
      }
      if (old && old.gpu) old.gpu.destroy();
      if (old && old.earlierPasses) this.worker.lookPasses.destroy(old);
      const sources = old && old.sharedSources;
      if (!sources) continue;
      const keys = Object.keys(sources);
      for (let k = 0; k < keys.length; k++) {
        const source = sources[keys[k]];
        if (source && typeof source.destroy === 'function') source.destroy();
      }
    }
    this.destroyAllCompute();
    this.worker.screenLayers.destroyAll();
    this.byId = {};
    this.worker._gpuParticleBatches = [];
    if (!meshMemoryBound) await this.worker.meshLayers.bindMemory(data);
    if (!data.layerData) return;

    const metadata = data.layerData.metadata;
    if (!metadata?.layers) return;

    const queues = data.customLayerRenderQueues || {};
    // The y-sorted layers' painter states are regions of the render-queue memory, next to their queues.
    const layerPainterKernel = await this._bindPainter(queues);
    const lfMax =
      (data.liquidFunMaxCount | 0) ||
      (this.worker.config?.physics?.liquidFun?.maxCount | 0) ||
      10000;
    const particleMax =
      (this.worker.config?.particle?.maxParticles | 0) || 0;

    const layerMetas = metadata.layers;
    for (let mi = 0; mi < layerMetas.length; mi++) {
      const config = layerMetas[mi];
      if (!config || config.builtIn || config.id === metadata.entitiesId) continue;

      const isLfDensity = config.densitySource === LAYER_DENSITY_SOURCE.LIQUID_FUN;
      const isCompute = !!config.compute;
      const isMesh = config.kind === LAYER_KIND.MESH;
      const isWorldRect = !!(config.worldRect && config.shaderTextures && config.shaderTextures.length);
      const isGpu = config.kind === LAYER_KIND.GPU_PARTICLES;
      if (config.kind === LAYER_KIND.SCREEN) {
        this.worker.screenLayers.initLayer(config);
        continue;
      }
      if (!config.hasRenderQueue && !isLfDensity && !isCompute && !isMesh && !isWorldRect && !isGpu) continue;

      const layerId = config.id;
      const layerName = config.name;
      const lrq = queues[layerId];
      if (!isLfDensity && !isCompute && !isMesh && !isWorldRect && !isGpu && !lrq) continue;

      const layerObj = Layer.getById(layerId);
      if (!layerObj) continue;

      const maxItems = lrq?.maxItems || 0;
      const resolution = layerObj.resolution;
      const hasShader = layerObj.hasShader;
      const containerBlend = layerObj.containerBlendMode;
      const layerYSort = !!layerObj.ySorting;
      const splatCfg = config.splat || Layer._normalizeSplat({ splat: {} }, LAYER_DENSITY_SOURCE.LIQUID_FUN);

      let buffers = null;
      let batch = null;
      let fillBatch = null;
      let meshRegion = null;
      // E-453: the UV batch's vertex records and indices, made when the layer first packs a mesh with UVs.
      let uvVertCapacity = 0;
      let uvIndexCapacity = 0;
      if (isMesh) {
        const maxFx =
          (data.config?.physics?.maxFixturePoolSize | 0) ||
          (this.worker.config?.physics?.maxFixturePoolSize | 0);
        const entitySlots = this.worker.globalEntityCount | 0;
        const maxMeshVerts =
          (data.config?.renderer?.maxMeshVerts | 0) ||
          (this.worker.config?.renderer?.maxMeshVerts | 0);
        const maxMeshIndices =
          (data.config?.renderer?.maxMeshIndices | 0) ||
          (this.worker.config?.renderer?.maxMeshIndices | 0);
        // Fixtures or one primary shape per entity; each convex is at most 6 fans (8-2).
        const caps = meshLayerCapacities(maxFx, entitySlots, maxMeshVerts, maxMeshIndices);
        // E-76 W11: the rows in the mesh memory, where the corner kernel rewrites them.
        meshRegion = this.worker.meshLayers.layerRegion(layerId, caps);
        // Without MeshGeometry (renderer.maxMeshVerts 0) there is no mesh memory: the layer fills collider shapes in
        // arrays of its own and no corner is ever rewritten. With it, every MESH layer has its regions there.
        if (!meshRegion && this.worker.meshLayers.memoryLayout) {
          throw new Error(`MESH layer "${layerName}": its rows are not in the mesh memory (sized apart from meshLayerCapacities)`);
        }
        fillBatch = new ColliderFillBatch({
          bufferSystem: this.worker.pixiApp?.renderer?.buffer ?? null,
          capacity: caps.fill,
          label: `mesh-layer-${layerName}`,
          useWebGpu: this.worker._useWebGpu,
          shaders: this.worker._engineShaders,
          atlasSource: this.worker.assets.resolveAtlasSource(),
          lutSource: this.worker.assets.texLutSource,
          data: meshRegion
            ? new Float32Array(this.worker.meshLayers.memoryBuffer, meshRegion.fillRowsByte, caps.fill * COLLIDER_FILL_FLOATS)
            : null,
        });
        uvVertCapacity = caps.uvVerts;
        uvIndexCapacity = caps.uvIndices;
        fillBatch.mesh.blendMode = containerBlend;
      }
      let sortKeyU32ByBuf = null;
      let painter = null;
      if (lrq && maxItems > 0) {
        buffers = [
          createRenderQueueViews(lrq.dataA, maxItems, lrq.dataAByte | 0),
          createRenderQueueViews(lrq.dataB, maxItems, lrq.dataBByte | 0),
        ];
        sortKeyU32ByBuf = buffers.map((b) => b.sortKeyU32);
        painter = layerYSort ? this._painterState(layerPainterKernel, lrq, maxItems, layerName) : null;
        // Close-out group B: the layer's rows in the render-queue memory (next to its queues), where gpuPack.wasm
        // packs them; copied out for the upload as the entities' are (W30's arena).
        const layerRows = lrq.rowsByte >= 0 && this.worker._pixiGpuPack && lrq.dataA === this.worker._renderQueueMemory?.buffer
          ? new Float32Array(lrq.dataA, lrq.rowsByte, maxItems * INSTANCED_SPRITE_FLOATS)
          : null;
        batch = new InstancedSpriteBatch({
          capacity: maxItems,
          label: `custom-layer-${layerName}`,
          atlasSource: this.worker.assets.resolveAtlasSource(),
          lutSource: this.worker.assets.texLutSource,
          depthTest: false,
          depthMask: false,
          useWebGpu: this.worker._useWebGpu,
          shaders: this.worker._engineShaders,
          data: layerRows,
          gpuPack: layerRows ? this.worker._pixiGpuPack : null,
          arena: layerRows ? this.worker._batchArena(maxItems * INSTANCED_SPRITE_FLOATS) : null,
        });
        batch.mesh.blendMode = containerBlend;
      }

      // GPU particles: one instanced mesh per writer ring, evaluated in the vertex shader (gpuParticleBatch.js).
      let gpuBatch = null;
      if (isGpu) {
        const info = GpuParticles.layerOf(layerId);
        if (!info) continue;
        installInstanceRangeDraw(this.worker.pixiApp.renderer, this.worker._useWebGpu);
        if (!this.worker.assets.gpuAnimStartSource) this.worker.assets.rebuildGpuAnimStartLookup();
        const looks = !!(hasShader && config.shaderFragment);
        const blend = looks ? containerBlend : layerObj.blendMode;
        gpuBatch = new GpuParticleLayerBatch({
          info,
          useWebGpu: this.worker._useWebGpu,
          shaders: this.worker._engineShaders,
          atlasSource: this.worker.assets.resolveAtlasSource(),
          lutSource: this.worker.assets.texLutSource,
          animStartSource: this.worker.assets.gpuAnimStartSource,
          blendMode: blend,
          additive: !looks && blend === 'add',
          pixelSnap: !!config.gpuParticles?.pixelSnap,
          look: looks,
          label: `gpu-particles-${layerName}`,
          recordTexture: this.worker._useWebGpu ? null : this.worker._gpuRecordTexture(),
        });
        gpuBatch.container.blendMode = blend;
        this.worker._gpuParticleBatches.push(gpuBatch);
      }

      let splatBatch = null;
      if (isLfDensity) {
        splatBatch = new LiquidFunDensitySplat({
          capacity: Math.max(1, lfMax + particleMax),
          label: `lf-splat-${layerName}`,
          blendMode: containerBlend,
          useWebGpu: this.worker._useWebGpu,
          shaders: this.worker._engineShaders,
        });
        splatBatch.mesh.blendMode = containerBlend;
      }

      const cl = {
        layerId,
        layerName,
        maxItems,
        ySorting: layerYSort,
        baseResolution: resolution,
        resolution,
        buffers,
        readRef: buffers ? buffers[0] : null,
        sortKeyU32ByBuf,
        sortKeyU32: sortKeyU32ByBuf ? sortKeyU32ByBuf[0] : null,
        painter,
        prevCount: 0,
        batch,
        fillBatch,
        uvFillBatch: null,
        uvVertCapacity,
        uvIndexCapacity,
        // E-453: the UV batch's vertex records and the indices it draws.
        uvPrevCount: 0,
        uvIndexCount: 0,
        // E-76 W11: this MESH layer's regions of the mesh memory, or null.
        meshRegion,
        splatBatch,
        densitySource: isLfDensity ? LAYER_DENSITY_SOURCE.LIQUID_FUN : LAYER_DENSITY_SOURCE.SPRITES,
        splat: splatCfg ? { ...splatCfg } : null,
        splatRadius: splatCfg?.radius ?? 48,
        scaleMode: Layer._normalizeScaleMode(config.scaleMode),
        containerBlend,
        // N-79: the config set shader.containerBlend (a batch drawn in one pass takes it over blendMode).
        containerBlendSet: config.containerBlendSet === true,
        rt: null,
        rtOut: null,
        shaderMesh: null,
        shader: null,
        displaySprite: null,
        // E-504: a worldRect layer's mesh (on the stage), and with its cache the target, the mesh that paints it (the
        // same geometry and shader) and the container it is painted from, the holder of the stage mesh and the target's
        // sprite (the layer), what the target was painted for, and whether its shader reads the frame's time.
        worldMesh: null,
        worldRt: null,
        worldPaintMesh: null,
        worldRoot: null,
        worldHolder: null,
        worldCache: null,
        worldEveryFrame: false,
        uniformEntries: config.uniformMap ? Object.entries(config.uniformMap) : null,
        uniformStore: null,
        shaderBypass: false,
        // DX-LAYERPASSES: the passes of the look before its last one (null: one), and what the last one reads besides.
        earlierPasses: null,
        reads: lookReads(config.shaderFragment, false, config.shaderEarlier !== null && config.shaderEarlier !== undefined),
        meshLook: false,
        sunProjected: isMesh && config.sunProjected === true,
        volumeFloor: isMesh && config.volumeFloor === true,
        compute: null,
        lookSource: null,
        // LAYER_KIND.GPU_PARTICLES: the layer's GpuParticleLayerBatch, or null.
        gpu: gpuBatch,
      };

      if (isCompute) {
        const device = this.worker.pixiApp.renderer.gpu?.device;
        if (!this.worker._useWebGpu || !device) {
          throw errorCompileFailed(
            'compute',
            config.shaderName || layerName,
            layerName,
            'WebGPU',
            new Error('Compute layers require WebGPU')
          );
        }
        cl.lookSource = PIXI.TextureSource.from({
          resource: new Uint8Array(4),
          width: 8,
          height: 8,
          format: 'rgba8unorm',
          scaleMode: 'linear',
          autoGenerateMipmaps: false,
          alphaMode: 'no-premultiply-alpha',
        });
        cl.lookSource.autoGarbageCollect = false;
        cl.lookSource.uploadMethodId = 'external';
        cl.compute = new ComputeLayer({
          device,
          meta: config,
          renderer: this.worker.pixiApp.renderer,
          lookSource: cl.lookSource,
          live: () => this.worker._gpuLive(),
        });
        try {
          const ok = await cl.compute.compile();
          if (!ok) {
            throw new Error(cl.compute._compileErrorMessage || 'compute pipeline failed');
          }
        } catch (err) {
          const computeAsset =
            (config.compute?.passes || [])
              .map((p) => p.source || p.entry)
              .filter(Boolean)
              .join(',') ||
            config.shaderName ||
            layerName;
          throw errorCompileFailed('compute', computeAsset, layerName, 'WebGPU', err);
        }
      }

      if (isWorldRect) {
        try {
          this._initWorldTextureLayer(cl, config);
        } catch (err) {
          if (err && typeof err.message === 'string' && err.message.startsWith('WeedJS:')) throw err;
          throw errorCompileFailed(
            'look',
            config.shaderName || layerName,
            layerName,
            this.worker._useWebGpu ? 'WebGPU' : 'WebGL',
            err
          );
        }
      } else if (hasShader && config.shaderFragment) {
        const w = this.worker.canvasWidth * resolution;
        const h = this.worker.canvasHeight * resolution;

        if (!isCompute) {
          cl.rt = PIXI.RenderTexture.create({ width: w, height: h });
        }
        if (!isMesh) {
          cl.rtOut = PIXI.RenderTexture.create({ width: w, height: h });
        }
        this.applyScaleMode(cl);

        const uniformDefs = {};
        if (config.uniformMap) {
          for (const [uName, entry] of Object.entries(config.uniformMap)) {
            const uType = config.uniformTypes?.[uName] || 'f32';
            const floats = Layer._uniformFloats[layerId];
            if (entry.size === 1) {
              uniformDefs[uName] = { value: floats[entry.offset], type: uType };
            } else {
              const arr = new Float32Array(entry.size);
              for (let k = 0; k < entry.size; k++) arr[k] = floats[entry.offset + k];
              uniformDefs[uName] = { value: arr, type: uType };
            }
          }
        }

        try {
          const lookSource = cl.lookSource || cl.rt.source;
          cl.shader = this.worker.lookShaders.create(
            config.shaderFragment,
            lookSource,
            uniformDefs,
            config.shaderName || layerName,
            layerName,
            emptyLookTextures(cl.reads)
          );
          cl.uniformStore = cl.shader.resources?.customUniforms?.uniforms || null;
          cl.shaderMesh = this.worker.lookShaders.makeMesh(cl.shader, isMesh && this.worker.meshLayers.lookFlipV());
          cl.earlierPasses = this.worker.lookPasses.make(config, false);
        } catch (err) {
          if (err && typeof err.message === 'string' && err.message.startsWith('WeedJS:')) throw err;
          throw errorCompileFailed(
            'look',
            config.shaderName || layerName,
            layerName,
            this.worker._useWebGpu ? 'WebGPU' : 'WebGL',
            err
          );
        }

        if (isMesh) {
          cl.meshLook = true;
          // The look mesh composes the layer's picture: blendMode, as a look layer's display sprite (N-79).
          this.worker._registerLayerDisplayObject(layerName, cl.shaderMesh, false);
          this.worker.pixiApp.stage.addChild(cl.shaderMesh);
          debugWorkerLog(
            `PIXI WORKER: Custom MESH look layer "${layerName}" initialized (resolution=${resolution}, RT=${w}x${h})`
          );
        } else {
          cl.displaySprite = new PIXI.Sprite(cl.rtOut);
          cl.displaySprite.anchor.set(0, 0);
          cl.displaySprite.position.set(0, 0);
          cl.displaySprite.scale.set(1.0 / resolution);
          this.worker._registerLayerDisplayObject(layerName, cl.displaySprite);

          this.worker.pixiApp.stage.addChild(cl.displaySprite);
          const densLabel = isLfDensity ? ', densitySource=liquidFun' : '';
          debugWorkerLog(
            `PIXI WORKER: Custom shader layer "${layerName}" initialized (resolution=${resolution}, RT=${w}x${h}${densLabel})`
          );
        }
      } else if (fillBatch && (config.alphaBySun || config.sunProjected)) {
        // The sun's factor is one alpha over the whole layer: an RT composed once, or overlaps would darken twice.
        cl.shaderBypass = true;
        this._ensureDensityRT(cl);
        this.worker._registerLayerDisplayObject(layerName, cl.displaySprite);
        debugWorkerLog(`PIXI WORKER: Custom MESH layer "${layerName}" initialized (composed, alphaBySun)`);
      } else if (fillBatch) {
        this.worker._registerLayerDisplayObject(layerName, fillBatch.mesh, cl.containerBlendSet);
        this.worker.pixiApp.stage.addChild(fillBatch.mesh);
        debugWorkerLog(`PIXI WORKER: Custom MESH layer "${layerName}" initialized`);
      } else if (batch) {
        this.worker._registerLayerDisplayObject(layerName, batch.mesh, cl.containerBlendSet);
        this.worker.pixiApp.stage.addChild(batch.mesh);
        debugWorkerLog(`PIXI WORKER: Custom layer "${layerName}" initialized (no shader)`);
      } else if (gpuBatch && this._gpuParticleLayerTarget(cl, gpuBatch, layerObj.blendMode)) {
        // E-431: drawn into a target the layer's resolution of the canvas, composed once at the layer's place.
        this.worker._registerLayerDisplayObject(layerName, cl.displaySprite);
        this.worker.pixiApp.stage.addChild(cl.displaySprite);
        debugWorkerLog(
          `PIXI WORKER: GPU particle layer "${layerName}" initialized (${gpuBatch.rings.length} rings, resolution=${resolution})`
        );
      } else if (gpuBatch) {
        // The layer's own blend mode on the container: its meshes draw with it (Pixi's group blend).
        this.worker._registerLayerDisplayObject(layerName, gpuBatch.container, false);
        this.worker.pixiApp.stage.addChild(gpuBatch.container);
        debugWorkerLog(`PIXI WORKER: GPU particle layer "${layerName}" initialized (${gpuBatch.rings.length} rings)`);
      } else {
        console.warn(`PIXI WORKER: Layer "${layerName}" skipped (no shader RT and no sprite batch)`);
        continue;
      }

      this.byId[layerId] = cl;
    }

    this.worker.screenLayers.finish();
    this.list = Object.values(this.byId);
    this.worker._bindLutToBatches();
    this.worker._initProxies();
    this.worker._collectSunLayers();

    if (this.list.length > 0) {
      this.worker.pixiApp.stage.sortChildren();
    }
    this.worker._syncLayerRefsFromRuntime();
  }

  /**
   * Update all custom layer sprites from their render queues and render shader
   * layers through the two-RT pipeline (density → threshold → display).
   */
  update() {
    for (let li = 0; li < this.list.length; li++) {
      const cl = this.list[li];
      if (!layerIsVisible(cl.layerId)) continue;
      // DX-SHADOW3D (F6): in map mode the volumes cast into the sun's map (_drawVolumesInSunMap); their own layer, which
      // darkens every light, shows nothing. Its rows are still packed: the map draws them.
      if (cl.sunProjected && this.worker._sunMapOn) {
        if (cl.displaySprite) cl.displaySprite.renderable = false;
        if (cl.uvFillBatch) cl.uvFillBatch.mesh.renderable = false;
      }
      const uploaded = this._uploadSharedPictures(cl);
      const renderToRT = !!cl.rt;
      let densityMesh = null;
      let uniformsChanged = false;

      if (cl.shader && Layer._uniformDirty[cl.layerId]) {
        const dirtyRef = Layer._uniformDirty[cl.layerId];
        if (Atomics.load(dirtyRef, 0) === 1) {
          Atomics.store(dirtyRef, 0, 0);
          uniformsChanged = true;
          const floats = Layer._uniformFloats[cl.layerId];
          copyLookUniforms(cl.uniformEntries, floats, cl.uniformStore);
          this.worker.lookPasses.syncUniforms(cl, cl.uniformEntries, floats);
        }
      }

      const frameUniforms = this.worker._computeFrame;
      frameUniforms.dt = this.worker._lastDt || 1 / 60;
      frameUniforms.cameraX = this.worker._renderCameraX;
      frameUniforms.cameraY = this.worker._renderCameraY;
      frameUniforms.canvasW = this.worker.canvasWidth;
      frameUniforms.canvasH = this.worker.canvasHeight;
      frameUniforms.zoom = this.worker._renderZoom;
      frameUniforms.time = (this.worker.accumulatedTime || 0) * 0.001;
      frameUniforms.worldW = finiteOrZero(this.worker.worldWidth);
      frameUniforms.worldH = finiteOrZero(this.worker.worldHeight);
      // DX-GBUFSHADER: a layer's look reads no G-buffer (a SCREEN pass does).
      frameUniforms.gbufW = 0;
      frameUniforms.gbufH = 0;
      applyEngineLookUniforms(cl, frameUniforms);
      if (cl.earlierPasses === null) applyTexelSizeUniform(cl, cl.lookSource || (cl.rt !== null ? cl.rt.source : null));
      // E-504: a cached worldRect layer draws its target when what it shows changed; nothing else of it runs here.
      if (cl.worldRt !== null) {
        this._drawWorldRectCache(cl, uploaded > 0 || uniformsChanged, uploaded > 0);
        continue;
      }

      const rtOpts = this.worker._rtRenderOpts;
      if (cl.compute) {
        if (!this.worker._gpuLive()) continue;
        cl.compute.step(frameUniforms, this.computePose);
        applyComputeTexSizeUniform(cl);
        if (!cl.shaderBypass && cl.shaderMesh && cl.rtOut) {
          this._drawEarlierPasses(cl);
          rtOpts.container = cl.shaderMesh;
          rtOpts.target = cl.rtOut;
          rtOpts.clear = true;
          rtOpts.clearColor = this.worker._clearTransparent;
          this.worker._submitRender(rtOpts);
        }
      } else if (cl.densitySource === LAYER_DENSITY_SOURCE.LIQUID_FUN && cl.splatBatch) {
        const views = LiquidFun.getViews();
        const so = this.splatUploadOpts;
        so.layerId = cl.layerId;
        so.zoom = this.worker._renderZoom;
        so.cameraX = this.worker._renderCameraX;
        so.cameraY = this.worker._renderCameraY;
        so.resolution = cl.resolution || 1.0;
        so.radius = cl.splatRadius || cl.splat?.radius || 48;
        so.intensity = cl.splat?.intensity ?? 1;
        so.useParticleTint = cl.splat?.useParticleTint !== false;
        so.canvasW = this.worker.canvasWidth;
        so.canvasH = this.worker.canvasHeight;
        so.cameraRot = this.worker._renderCameraRot || 0;
        cl.splatBatch.upload(views, so);
        densityMesh = cl.splatBatch.mesh;
        cl.prevCount = views?.count ? views.count[0] | 0 : 0;
      } else if (cl.gpu) {
        // Updated this frame by updateGpuParticleLayers; with a look shader, its density pass is drawn here.
        if (cl.rt) {
          // E-431: a layer drawn at its resolution with no look shows nothing, and draws nothing, while no particle lives.
          if (cl.shaderBypass && cl.displaySprite !== null) {
            const live = cl.gpu.liveRecords > 0;
            if (cl.displaySprite.renderable !== live) cl.displaySprite.renderable = live;
            if (!live) continue;
          }
          this._renderGpuParticlesToRt(cl);
          if (!cl.shaderBypass && cl.shaderMesh && cl.rtOut) {
            this._drawEarlierPasses(cl);
            rtOpts.transform = null;
            rtOpts.container = cl.shaderMesh;
            rtOpts.target = cl.rtOut;
            rtOpts.clear = true;
            rtOpts.clearColor = this.worker._clearTransparent;
            this.worker._submitRender(rtOpts);
          }
        }
        continue;
      } else if (cl.batch && cl.readRef) {
        const ref = cl.readRef;
        const count = ref.count[0];
        cl.prevCount = count;
        const q = this.worker._entityUploadQ;
        this.worker._bindSpriteQueue(q, ref, count);
        const opts = this.worker._entityUploadOpts;
        this.worker._resetSpriteUploadOpts(opts);
        opts.depthDenom = cl.maxItems;
        opts.worldHeight = this.worker.config?.worldHeight || 10000;
        opts.type = ref.type;
        if (renderToRT) {
          opts.space = BATCH_SPACE.SCREEN;
          opts.zoom = this.worker._renderZoom;
          opts.cameraX = this.worker._renderCameraX;
          opts.cameraY = this.worker._renderCameraY;
          opts.resolution = cl.resolution || 1.0;
          opts.cameraRot = this.worker._renderCameraRot || 0;
          opts.canvasW = this.worker.canvasWidth || 0;
          opts.canvasH = this.worker.canvasHeight || 0;
        } else {
          opts.space = BATCH_SPACE.WORLD;
          opts.zoom = 1;
          opts.cameraX = 0;
          opts.cameraY = 0;
          opts.resolution = 1;
        }
        // DBG-4: the layer's flag can change at run time (Layer#ySorting): unsorted, pre-render writes no sort keys and
        // the rows go in queue order.
        const painter = Layer._ySorting[cl.layerId] === 1 ? cl.painter : null;
        this.worker._uploadSortedSprites(cl.batch, q, opts, painter, cl.sortKeyU32, null, count);
        densityMesh = cl.batch.mesh;
      } else if (cl.fillBatch) {
        const views = this.worker._ensureColliderFillViews();
        views.outU32 = cl.fillBatch.rowsU32;
        let skip = this.fillSkip[cl.layerId];
        if (!skip) {
          skip = this.fillSkip[cl.layerId] = {
            lastRevision: COLLIDER_FILL_PACK_FIRST_FRAME,
            lastMeshRevision: 0,
            lastPaintEpoch: -1,
            lastOutsetEpoch: 0,
            lastVertEpoch: 0,
            lastVertGen: null,
            frameVertGen: null,
            // E-118: the UV generations drawn and this frame's copy (_captureUvGen).
            lastUvGen: new Uint32Array(0),
            frameUvGen: new Uint32Array(0),
            // The fill batch's instance-to-entity list, written by its full pack (the UV batch holds its own, E-453).
            instanceEntity: new Uint32Array(0),
            // The layer's record of every mesh's presence and pose, which trackMeshFillPose compares and updates once a
            // frame and the pose tables upload from; sized on the first frame.
            prevPose: {
              x: new Float32Array(0),
              y: new Float32Array(0),
              rotC: new Float32Array(0),
              rotS: new Float32Array(0),
              active: new Uint8Array(0),
              visible: new Uint8Array(0),
            },
            camX: NaN,
            camY: NaN,
            zoom: NaN,
            camRot: NaN,
            rtReady: false,
            // Rows changed while a sunProjected layer showed nothing: its RT is old when the sun comes back.
            rtStale: false,
            uvLocalsReady: false,
            // Set later each frame (CR-32: there from the start): the fill's locals packed, and the RT pass skipped.
            localsReady: false,
            _skipRt: false,
          };
          if (cl.meshRegion) this.worker.meshLayers.bindSkipRegions(skip, cl.meshRegion);
        }
        views.lastPaintEpoch = skip.lastPaintEpoch;
        views.lastMeshRevision = skip.lastMeshRevision | 0;
        views.lastOutsetEpoch = skip.lastOutsetEpoch | 0;
        views.lastVertEpoch = skip.lastVertEpoch >>> 0;
        let packedThisFrame = false;
        // The layer's one pass over every entity this frame: whether any mesh's pose or presence moved since its
        // record, and this frame's into the record, where the pose tables below take them from.
        const moved = trackMeshFillPose(views, skip.prevPose);
        const poseMoved = moved !== 0;
        if (poseMoved || !colliderFillEpochsMatch(views, skip.lastRevision)) {
          const cap = cl.fillBatch.capacity;
          if (!skip.instanceEntity || skip.instanceEntity.length < cap) {
            skip.instanceEntity = new Uint32Array(cap);
          }
          const lastPacked = cl.prevCount | 0;
          const rev = views.fixtureRevision ? (views.fixtureRevision[0] | 0) : 0;
          const meshRev = views.meshGeomRevision ? (views.meshGeomRevision[0] | 0) : 0;
          const outsetRev = views.outsetEpoch ? (views.outsetEpoch[0] | 0) : 0;
          const vertEpoch = views.meshVertEpoch ? Atomics.load(views.meshVertEpoch, 0) : 0;
          const topologyStable =
            skip.lastRevision !== COLLIDER_FILL_PACK_FIRST_FRAME &&
            rev === (skip.lastRevision | 0) &&
            meshRev === (skip.lastMeshRevision | 0) &&
            outsetRev === (skip.lastOutsetEpoch | 0) &&
            (moved & MESH_FILL_PRESENCE_MOVED) === 0;
          const paintMoved = !!(
            views.paintEpoch &&
            (views.paintEpoch[0] | 0) !== (skip.lastPaintEpoch | 0)
          );
          const vertsMoved = vertEpoch !== (skip.lastVertEpoch >>> 0);
          this.worker.meshLayers.ensureVertGenScratch(skip, views);
          let full = !topologyStable;
          // Generations before vertices (B24): both paths below read vertices.
          const genNow = full || vertsMoved ? this.worker.meshLayers.captureVertGen(skip, views) : null;
          // E-118: the UV generations right after, for the same reads.
          const uvGenNow = genNow ? this.worker.meshLayers.captureUvGen(skip, views) : null;
          // The rows of each batch this frame's rewrite touched: a mesh edit anywhere moves the one vertex epoch. E-453: the
          // UV batch's records, and the indices of its triangles.
          let fillFirst = 0;
          let fillPast = lastPacked;
          let uvFirst = 0;
          let uvPast = cl.uvPrevCount | 0;
          let uvIndexFirst = 0;
          let uvIndexPast = 0;
          if (!full && vertsMoved) {
            this.worker.meshLayers.cornerFirstRow = 0;
            this.worker.meshLayers.cornerPastRow = lastPacked;
            const fillRewrite = this.worker.meshLayers.rewriteCorners(
              cl.fillBatch.rows,
              lastPacked,
              skip.instanceEntity,
              views,
              COLLIDER_FILL_FLOATS,
              skip.lastVertGen,
              genNow,
            );
            fillFirst = this.worker.meshLayers.cornerFirstRow;
            fillPast = this.worker.meshLayers.cornerPastRow;
            const uvCount = cl.uvPrevCount | 0;
            this.worker.meshLayers.cornerFirstRow = 0;
            this.worker.meshLayers.cornerPastRow = !cl.uvFillBatch ? 0 : uvCount;
            this.worker.meshLayers.cornerFirstIndex = 0;
            this.worker.meshLayers.cornerPastIndex = 0;
            const uvRewrite = !cl.uvFillBatch || uvCount <= 0
              ? 1
              : this.worker.meshLayers.rewriteUvVerts(
                cl.uvFillBatch,
                uvCount,
                views,
                skip.lastVertGen,
                genNow,
                skip.lastUvGen,
                uvGenNow,
              );
            uvFirst = this.worker.meshLayers.cornerFirstRow;
            uvPast = this.worker.meshLayers.cornerPastRow;
            uvIndexFirst = this.worker.meshLayers.cornerFirstIndex;
            uvIndexPast = this.worker.meshLayers.cornerPastIndex;
            if (fillRewrite < 0 || uvRewrite < 0) full = true;
          }
          const noRowMoved = !full && vertsMoved && !paintMoved && !poseMoved && fillPast <= fillFirst && uvPast <= uvFirst;
          if (full) {
            views.instanceEntity = skip.instanceEntity;
            views.outU32 = cl.fillBatch.rowsU32;
            const packed = packColliderFill(cl.fillBatch.rows, cap, cl.layerId, views);
            skip.localsReady = packed > 0;
            cl.fillBatch.upload(packed);
            cl.prevCount = packed;
            if (packed > 0) {
              cl.fillBatch.uploadPoseTable(skip.instanceEntity, packed, views, skip.prevPose);
              this.worker.meshLayers.uploadPoseSource(cl.fillBatch, 'mesh-pose');
            }
            this.worker.meshLayers.packUvLayer(cl, views, skip);
            this.worker.meshLayers.commitVertGen(skip, views);
            this.worker.meshLayers.commitUvGen(skip, views);
          } else {
            if (paintMoved) {
              if (lastPacked > 0) {
                views.outU32 = cl.fillBatch.rowsU32;
                packColliderFillPoseOnly(
                  cl.fillBatch.rows,
                  cap,
                  lastPacked,
                  skip.instanceEntity,
                  views,
                );
              }
              const uvCount = cl.uvPrevCount | 0;
              if (cl.uvFillBatch && uvCount > 0) packMeshUvVertsPaint(cl.uvFillBatch, uvCount, views);
            }
            if (paintMoved) {
              if (lastPacked > 0) cl.fillBatch.upload(lastPacked);
              const uvCount = cl.uvPrevCount | 0;
              // The indices too: this frame's rewrite may have written some.
              if (cl.uvFillBatch && uvCount > 0) cl.uvIndexCount = cl.uvFillBatch.upload(uvCount, cl.uvIndexCount);
            } else if (vertsMoved) {
              // Only the rows the rewrite wrote; none on a layer the edit did not reach.
              if (fillPast > fillFirst) cl.fillBatch.uploadRange(fillFirst, fillPast);
              if (cl.uvFillBatch && uvPast > uvFirst) cl.uvFillBatch.uploadRange(uvFirst, uvPast);
              if (cl.uvFillBatch && uvIndexPast > uvIndexFirst) cl.uvFillBatch.uploadIndexRange(uvIndexFirst, uvIndexPast);
            }
            if (poseMoved) {
              if (lastPacked > 0) {
                cl.fillBatch.uploadPoseTable(skip.instanceEntity, lastPacked, views, skip.prevPose);
                this.worker.meshLayers.uploadPoseSource(cl.fillBatch, 'mesh-pose');
              }
              const uvCount = cl.uvPrevCount | 0;
              if (cl.uvFillBatch && uvCount > 0) {
                cl.uvFillBatch.uploadPoseTable(cl.uvFillBatch.vertexEntity, uvCount, views, skip.prevPose);
                this.worker.meshLayers.uploadPoseSource(cl.uvFillBatch, 'mesh-uv-pose');
              }
            }
            if (vertsMoved) {
              this.worker.meshLayers.commitVertGen(skip, views);
              this.worker.meshLayers.commitUvGen(skip, views);
            }
          }
          skip.lastRevision = rev;
          skip.lastMeshRevision = meshRev;
          skip.lastPaintEpoch = views.paintEpoch ? (views.paintEpoch[0] | 0) : 0;
          skip.lastOutsetEpoch = outsetRev;
          skip.lastVertEpoch = vertEpoch;
          clearMeshFillPaintDirty(views);
          // An edit on another layer draws nothing new here: an RT layer keeps the picture it has.
          packedThisFrame = !noRowMoved;
        }
        densityMesh = cl.fillBatch.mesh;
        // Triangles, as when the UV batch drew a row a triangle (E-453: its indices over 3).
        this.meshFillInstancesThisFrame += (cl.prevCount | 0) + (((cl.uvIndexCount | 0) / 3) | 0);
        const camChanged =
          skip.camX !== this.worker._renderCameraX ||
          skip.camY !== this.worker._renderCameraY ||
          skip.zoom !== this.worker._renderZoom ||
          skip.camRot !== (this.worker._renderCameraRot || 0);
        if (packedThisFrame) skip.rtStale = true;
        skip._skipRt = !skip.rtStale && !camChanged && skip.rtReady;
        if (cl.sunProjected) {
          // The sun moves the shadows on the GPU: a new position redraws the layer's RT, no pack. With nothing to show
          // (night, or the sun's factor at 0), it draws nothing.
          const sunFactors = this.worker._layerSunFactor;
          if (cl.layerId < sunFactors.length && sunFactors[cl.layerId] === 0) {
            if (skip.rtReady) skip._skipRt = true;
          } else if (cl.uvFillBatch) {
            const len = Sun.isInitialized ? Sun.shadowLengthRatio : 0;
            if (cl.uvFillBatch.setSunShadow(len * Sun.shadowDirX, len * Sun.shadowDirY)) skip._skipRt = false;
          }
        }
      } else {
        continue;
      }

      if (cl.rt && densityMesh) {
        if (cl.fillBatch) {
          const skipRt = this.fillSkip[cl.layerId];
          if (!skipRt || !skipRt._skipRt) {
            this.worker.meshLayers.renderFillToRt(cl, densityMesh);
            this.meshRtDrawsThisFrame++;
            if (skipRt) {
              skipRt.camX = this.worker._renderCameraX;
              skipRt.camY = this.worker._renderCameraY;
              skipRt.zoom = this.worker._renderZoom;
              skipRt.camRot = this.worker._renderCameraRot || 0;
              skipRt.rtReady = true;
              skipRt.rtStale = false;
              skipRt._skipRt = false;
            }
          }
          // A composed look (_ensureMeshLookComposite) runs every frame, as a look on the stage does; so do its earlier passes.
          if (!cl.shaderBypass && cl.shaderMesh) this._drawEarlierPasses(cl);
          if (!cl.shaderBypass && cl.shaderMesh && cl.rtOut) {
            rtOpts.transform = null;
            rtOpts.container = cl.shaderMesh;
            rtOpts.target = cl.rtOut;
            rtOpts.clear = true;
            rtOpts.clearColor = this.worker._clearTransparent;
            this.worker._submitRender(rtOpts);
          }
        } else {
          rtOpts.transform = null;
          rtOpts.container = emptyInstancedMesh(densityMesh)
            ? this.worker._rtEmptyContainer
            : densityMesh;
          rtOpts.target = cl.rt;
          rtOpts.clear = true;
          rtOpts.clearColor = this.worker._clearTransparent;
          this.worker._submitRender(rtOpts);
          if (!cl.shaderBypass && cl.shaderMesh && cl.rtOut) {
            this._drawEarlierPasses(cl);
            rtOpts.container = cl.shaderMesh;
            rtOpts.target = cl.rtOut;
            this.worker._submitRender(rtOpts);
          }
        }
      }
    }
  }

  /**
   * DX-LAYERPASSES: the passes of a layer's look before its last one (lookPasses.js), just before it: they read the layer's
   * own picture and draw at the layer's size, and the last one's input becomes what they drew. One null test without them.
   */
  _drawEarlierPasses(cl) {
    if (cl.earlierPasses === null) return;
    const size = cl.rtOut || cl.rt;
    this.worker.lookPasses.draw(cl, Layer.customLayerLookTexture(cl), size.source.pixelWidth, size.source.pixelHeight);
    applyTexelSizeUniform(cl, cl.shader.resources.uTexture);
  }

  /**
   * The debug UI's shader swap and splat radius for a layer. Visibility, alpha, blend and z are the Layer facade's
   * setters (config SAB plus dirty flags), applied each frame (DBG-2).
   * @param {Object} data - { layer, shader, shaderFragment, splatRadius }
   */
  setLayerProps(data) {
    const { layer, shader, shaderFragment, splatRadius } = data;

    if (shader !== undefined || shaderFragment !== undefined) {
      this.worker.lookShaders.setLayerShader(layer, shaderFragment || null, shader || null);
    }

    if (splatRadius !== undefined) {
      const layerObj = Layer.get(layer);
      if (layerObj) {
        const cl = this.byId[layerObj.id];
        if (cl && splatRadius > 0) {
          cl.splatRadius = splatRadius;
          if (cl.splat) cl.splat.radius = splatRadius;
        }
      }
    }
  }

  /**
   * N-79: whether a custom layer's display object draws with the container blend. A batch or a world-rect mesh on
   * the stage is the layer's only pass: it takes blendMode, unless the config set shader.containerBlend. A display
   * sprite or a look mesh composes the layer's picture, which its batches drew with the container blend: blendMode.
   */
  forcesContainerBlend(cl, displayObject) {
    const onePass = displayObject === cl.batch?.mesh || displayObject === cl.fillBatch?.mesh || displayObject === cl.worldMesh
      || displayObject === cl.worldHolder;
    return onePass && cl.containerBlendSet === true;
  }

  _ensureDensityRT(cl) {
    const resolution = cl.resolution || 1.0;
    const w = this.worker.canvasWidth * resolution;
    const h = this.worker.canvasHeight * resolution;
    if (cl.batch?.mesh?.parent) cl.batch.mesh.parent.removeChild(cl.batch.mesh);
    if (cl.fillBatch?.mesh?.parent) cl.fillBatch.mesh.parent.removeChild(cl.fillBatch.mesh);
    if (cl.uvFillBatch?.mesh?.parent) cl.uvFillBatch.mesh.parent.removeChild(cl.uvFillBatch.mesh);
    if (!cl.rt) cl.rt = PIXI.RenderTexture.create({ width: w, height: h });
    const meshLook = !!cl.fillBatch;
    if (!meshLook && !cl.rtOut) cl.rtOut = PIXI.RenderTexture.create({ width: w, height: h });
    this.applyScaleMode(cl);
    if (meshLook && !cl.shaderBypass) return;
    const tex = (meshLook || cl.shaderBypass || !cl.rtOut) ? cl.rt : cl.rtOut;
    if (!cl.displaySprite) {
      cl.displaySprite = new PIXI.Sprite(tex);
      cl.displaySprite.anchor.set(0, 0);
      cl.displaySprite.position.set(0, 0);
      cl.displaySprite.scale.set(1.0 / resolution);
      this.worker.pixiApp.stage.addChild(cl.displaySprite);
    } else {
      cl.displaySprite.texture = tex;
      cl.displaySprite.scale.set(1.0 / resolution);
      if (!cl.displaySprite.parent) this.worker.pixiApp.stage.addChild(cl.displaySprite);
    }
  }

  resizeRTs(cl, width, height) {
    if (!Layer.customLayerNeedsViewportResize(cl)) return;
    // The new RT is empty: a still layer would otherwise keep showing it.
    const skip = this.fillSkip[cl.layerId];
    if (skip) skip.rtReady = false;
    const resolution = cl.resolution || 1.0;
    const lw = width * resolution;
    const lh = height * resolution;

    if (cl.displaySprite) cl.displaySprite.texture = PIXI.Texture.EMPTY;
    this.worker.lookShaders.unbindTexture(cl.shader);
    if (cl.earlierPasses) this.worker.lookPasses.unbind(cl);
    // A sorted layer's regions sample rtOut too. Releasing rtOut's bind groups would destroy theirs, and the next
    // setTexture would write into the destroyed group: off it first, onto the new rtOut below.
    const regions = this.worker._proxyLayers[cl.layerId]?.regions ?? null;
    if (regions !== null) regions.setTexture(PIXI.Texture.EMPTY);

    if (cl.rt) {
      this.worker._releaseTextureBindGroups(cl.rt);
      cl.rt.destroy(true);
      cl.rt = PIXI.RenderTexture.create({ width: lw, height: lh });
    }
    if (cl.rtOut) {
      this.worker._releaseTextureBindGroups(cl.rtOut);
      cl.rtOut.destroy(true);
      cl.rtOut = PIXI.RenderTexture.create({ width: lw, height: lh });
    }
    if (regions !== null && cl.rtOut) regions.setTexture(cl.rtOut);

    if (cl.shader) {
      const lookTex = Layer.customLayerLookTexture(cl);
      if (lookTex) {
        cl.shader.resources.uTexture = lookTex;
        if (cl.shader.resources.uSampler && lookTex.style) {
          cl.shader.resources.uSampler = lookTex.style;
        }
      }
    }

    this.applyScaleMode(cl);

    if (cl.displaySprite) {
      cl.displaySprite.texture = (cl.shaderBypass || !cl.rtOut) ? cl.rt : cl.rtOut;
      cl.displaySprite.scale.set(1.0 / resolution);
    }
  }

  /**
   * Pixi v8 TextureSource.scaleMode for RT upsample (LINEAR soft / NEAREST blocky).
   * @param {import('../vendor/pixi.min.js').RenderTexture|null|undefined} rt
   * @param {string} mode
   */
  _setRtScaleMode(rt, mode) {
    if (!rt?.source) return;
    rt.source.scaleMode = Layer.scaleModeString(mode);
  }

  applyScaleMode(cl) {
    if (!cl) return;
    const mode = cl.scaleMode ?? LAYER_SCALE_MODE.LINEAR;
    this._setRtScaleMode(cl.rt, mode);
    this._setRtScaleMode(cl.rtOut, mode);
  }

  /**
   * E-431: a GPU particle layer with a resolution under 1 and no look of its own is drawn into a target that share of the
   * canvas (cl.rt, _renderGpuParticlesToRt) and composed onto the frame once by a sprite at the layer's place, as a look
   * layer's picture is. Soft particles are fill: Predator's fire smoke cost about 0.9 to 1.3 ms of GPU a frame at 1920 x
   * 1080, 0.003 under a 1 px scissor. Only where the target composes back what the particles drew (blend normal, whose
   * over is associative, or add); a layer drawn among the entities (sortWithEntities) stays there. The layer's alpha then
   * applies to its picture as a whole.
   * @returns {boolean} whether the layer draws through a target
   */
  _gpuParticleLayerTarget(cl, gpuBatch, blend) {
    const resolution = cl.resolution;
    if (!(resolution > 0 && resolution < 1)) return false;
    if (gpuBatch.look || gpuBatch.info.sortWithEntities) return false;
    if (blend !== 'normal' && blend !== 'add') return false;
    cl.rt = PIXI.RenderTexture.create({ width: this.worker.canvasWidth * resolution, height: this.worker.canvasHeight * resolution });
    this.applyScaleMode(cl);
    // No look: the sprite shows the target itself (_resizeCustomLayerRTs keeps it on cl.rt).
    cl.shaderBypass = true;
    const sprite = new PIXI.Sprite(cl.rt);
    sprite.anchor.set(0, 0);
    sprite.position.set(0, 0);
    sprite.scale.set(1.0 / resolution);
    sprite.renderable = false;
    cl.displaySprite = sprite;
    return true;
  }

  /**
   * A GPU particle layer's density pass: its meshes keep world positions, and the camera into the layer's RT is
   * the render transform (as a MESH layer's fill).
   */
  _renderGpuParticlesToRt(cl) {
    const container = cl.gpu.container;
    container.x = 0;
    container.y = 0;
    container.rotation = 0;
    container.pivot.set(0, 0);
    if (container.scale.x !== 1 || container.scale.y !== 1) container.scale.set(1);
    const rtOpts = this.worker._rtRenderOpts;
    rtOpts.container = cl.gpu.liveRecords > 0 ? container : this.worker._rtEmptyContainer;
    rtOpts.target = cl.rt;
    rtOpts.clear = true;
    rtOpts.clearColor = this.worker._clearTransparent;
    rtOpts.transform = this.worker._writeCameraRtTransform(this.worker._meshRtTransform, cl);
    this.worker._submitRender(rtOpts);
    rtOpts.transform = null;
  }

  _destroyCompute(cl) {
    if (!cl?.compute) return;
    cl.compute.destroy();
    cl.compute = null;
  }

  destroyAllCompute() {
    const ids = Object.keys(this.byId);
    for (let i = 0; i < ids.length; i++) {
      this._destroyCompute(this.byId[ids[i]]);
    }
  }

  /**
   * Initialize custom layer rendering infrastructure.
   *
   * NON-SHADER LAYERS:
   *   Instanced Mesh (InstancedSpriteBatch) added directly to stage at the layer's zIndex.
   *   Camera transform applied via mesh.scale / mesh.position.
   *
   * SHADER LAYERS (two-RT pipeline):
   *   1. Instanced Mesh rendered (container blend) → raw density RenderTexture (RT)
   *   2. Fullscreen Mesh with custom fragment shader reads density RT → output RT
   *   3. Output RT displayed on stage via Sprite at the layer's zIndex
   *   This enables screen-space effects (metaballs, heat distortion, etc.)
   *   driven by entity positions without per-entity shader overhead.
   *
   * Uniforms are shared via Layer SABs with Atomics dirty flags -- any thread
   * can call Layer.water.setUniform('uThreshold', 0.4) and the change
   * is picked up next frame with zero postMessage overhead.
   */
  _byteView(slot, raw) {
    if (!raw) return null;
    if (raw instanceof Uint8Array) return raw;
    const prev = slot.byteView;
    if (prev && prev.buffer === raw.buffer && prev.byteOffset === raw.byteOffset && prev.byteLength === raw.byteLength) {
      return prev;
    }
    slot.byteView = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    return slot.byteView;
  }

  /** @returns {number} how many pictures went up this frame */
  _uploadSharedPictures(cl) {
    const bag = Layer.textureSlotsFor(cl.layerId);
    if (!bag) return 0;
    let uploaded = 0;
    const renderer = this.worker.pixiApp && this.worker.pixiApp.renderer;
    // for...in, not Object.keys: this runs per layer per frame (review G7).
    for (const name in bag) {
      const slot = bag[name];
      const rect = Layer.consumeTextureUpload(cl.layerId, name);
      if (!rect || rect.w < 1 || rect.h < 1) continue;
      const raw = SharedResource.viewAt(rect.resourceIndex, rect.fieldIndex);
      if (!raw) continue;
      if (slot.buffer) {
        if (cl.compute) cl.compute.uploadFromSharedBuffer(name, raw, rect);
        continue;
      }
      if (slot.compute && cl.compute) {
        cl.compute.uploadFromShared(name, this._byteView(slot, raw), rect);
        continue;
      }
      const source = cl.sharedSources && cl.sharedSources[name];
      if (!source) continue;
      const gpu = renderer && source._gpuData && renderer.uid != null
        ? source._gpuData[renderer.uid]
        : null;
      uploadSharedImage({
        useWebGpu: this.worker._useWebGpu,
        device: renderer && renderer.gpu && renderer.gpu.device,
        gpuTexture: gpu && gpu.gpuTexture,
        gl: renderer && renderer.gl,
        renderer,
        source,
        bytes: this._byteView(slot, raw),
        width: slot.width,
        height: slot.height,
        format: slot.format,
        rect,
        glReady: !!source._weedGlReady,
      });
      source._weedGlReady = true;
      source.uploadMethodId = 'external';
      uploaded++;
    }
    return uploaded;
  }

  /**
   * E-504. A cached worldRect layer this frame (worldRectCacheStep): its target shown as painted, painted again when
   * what the layer shows changed (the camera, the canvas' size, its uniforms or pictures, every frame for a shader that
   * reads the frame's time), with the camera placed on the paint mesh as the stage places the stage mesh
   * (_placeWorldCamera), so the target holds what the stage mesh would draw; or, while the view keeps changing, the stage
   * mesh drawn instead.
   */
  _drawWorldRectCache(cl, changed, uploaded) {
    // N-292: a picture uploaded frame after frame never holds; the layer leaves its cache for the plain stage mesh.
    if (worldRectGivesUp(cl.worldCache, uploaded)) {
      this._dropWorldRectCache(cl);
      return;
    }
    const zoom = this.worker._renderZoom;
    const x = this.worker._renderCameraX;
    const y = this.worker._renderCameraY;
    const rot = this.worker._renderCameraRot || 0;
    const w = Math.max(1, this.worker.canvasWidth | 0);
    const h = Math.max(1, this.worker.canvasHeight | 0);
    const step = worldRectCacheStep(cl.worldCache, zoom, x, y, rot, w, h, changed || cl.worldEveryFrame);
    if (step === WORLD_RECT_SHOW) return;
    // N-292: never paint the target in a frame a picture went up: painting a just-uploaded picture into the target made
    // every later upload of it slow, for good (textureUploadStressScene's renderer 12 -> 40 ms, its cache given up or
    // not). The mesh draws on the stage this frame; the view is marked unpainted, so the next frame without an upload
    // paints.
    if (step === WORLD_RECT_DIRECT || uploaded) {
      if (uploaded) cl.worldCache.drawn = false;
      if (!cl.worldMesh.visible || cl.displaySprite.visible) {
        cl.worldMesh.visible = true;
        cl.displaySprite.visible = false;
      }
      return;
    }
    if (cl.worldMesh.visible || !cl.displaySprite.visible) {
      cl.worldMesh.visible = false;
      cl.displaySprite.visible = true;
    }
    if (cl.worldRt.width !== w || cl.worldRt.height !== h) {
      const old = cl.worldRt;
      cl.worldRt = PIXI.RenderTexture.create({ width: w, height: h });
      cl.displaySprite.texture = cl.worldRt;
      old.destroy(true);
    }
    this.worker._placeWorldCamera(cl.worldPaintMesh, zoom, x, y, rot);
    const o = this.worker._rtRenderOpts;
    o.container = cl.worldRoot;
    o.target = cl.worldRt;
    o.clear = true;
    o.clearColor = this.worker._clearTransparent;
    o.transform = null;
    this.worker._submitRender(o);
    this.worldRectDraws++;
  }

  /**
   * N-292: a cached worldRect layer back to the layout it has without a cache (shader.cache false): its mesh on the stage
   * where the holder was, registered as the layer, the target, its sprite and the paint mesh gone. The custom-layer loop
   * then treats it as an uncached worldRect layer (cl.worldRt null), its camera placed on the mesh every frame.
   */
  _dropWorldRectCache(cl) {
    const holder = cl.worldHolder;
    const mesh = cl.worldMesh;
    const parent = holder ? holder.parent : null;
    const at = parent ? parent.getChildIndex(holder) : -1;
    if (holder) holder.removeChild(mesh);
    mesh.visible = true;
    if (parent) {
      parent.addChildAt(mesh, at);
      parent.removeChild(holder);
    } else {
      this.worker.pixiApp.stage.addChild(mesh);
    }
    this.worker._registerLayerDisplayObject(cl.layerName, mesh, cl.containerBlendSet);
    // The paint mesh shares the stage mesh's geometry and shader, which stay with the stage mesh.
    if (cl.worldPaintMesh) cl.worldPaintMesh.destroy(false);
    if (cl.displaySprite) cl.displaySprite.destroy();
    if (holder) holder.destroy({ children: false });
    if (cl.worldRt) cl.worldRt.destroy(true);
    cl.worldRt = null;
    cl.worldPaintMesh = null;
    cl.worldRoot = null;
    cl.worldHolder = null;
    cl.displaySprite = null;
    cl.worldCache = null;
    this.worker._syncLayerRefsFromRuntime();
  }

  _initWorldTextureLayer(cl, config) {
    const fragment = config.shaderFragment;
    const rect = config.worldRect;
    const pics = config.shaderTextures || [];
    if (typeof fragment !== 'string' || !rect || !pics.length) {
      console.warn(`PIXI WORKER: world-rect layer "${cl.layerName}" is missing its shader or pictures`);
      return;
    }
    const renderer = this.worker.pixiApp.renderer;
    const pictures = [];
    cl.sharedSources = {};
    for (let i = 0; i < pics.length; i++) {
      const spec = pics[i];
      const source = createSharedTextureSource(spec, renderer, this.worker._useWebGpu);
      cl.sharedSources[spec.name] = source;
      pictures.push({ name: spec.name, format: spec.format, source });
    }
    const uniformDefs = {};
    if (config.uniformMap) {
      for (const [uName, entry] of Object.entries(config.uniformMap)) {
        const uType = config.uniformTypes?.[uName] || 'f32';
        const floats = Layer._uniformFloats[cl.layerId];
        if (entry.size === 1) {
          uniformDefs[uName] = { value: floats[entry.offset], type: uType };
        } else {
          const arr = new Float32Array(entry.size);
          for (let k = 0; k < entry.size; k++) arr[k] = floats[entry.offset + k];
          uniformDefs[uName] = { value: arr, type: uType };
        }
      }
    }
    const built = createWorldRectMesh({
      useWebGpu: this.worker._useWebGpu,
      worldW: rect.width,
      worldH: rect.height,
      fragmentSource: fragment,
      uniformDefs,
      uniformMap: config.uniformMap,
      uniformTypes: config.uniformTypes,
      pictures,
      name: cl.layerName,
    });
    cl.worldMesh = built.mesh;
    cl.shader = built.shader;
    cl.uniformStore = built.shader.resources?.customUniforms?.uniforms || null;
    cl.uniformEntries = config.uniformMap ? Object.entries(config.uniformMap) : null;
    if (config.shaderCache === true) {
      // E-504: painted into a target the canvas' size when what it shows changes (_drawWorldRectCache), by a mesh on the
      // same geometry and shader; the target's sprite, 1:1 on the screen, shows it. A view that keeps changing draws the
      // stage mesh instead (worldRectCacheStep). Both in one holder, which is the layer.
      cl.worldRt = PIXI.RenderTexture.create({ width: Math.max(1, this.worker.canvasWidth | 0), height: Math.max(1, this.worker.canvasHeight | 0) });
      cl.worldPaintMesh = new PIXI.Mesh({ geometry: built.mesh.geometry, shader: built.shader });
      cl.worldPaintMesh.eventMode = 'none';
      cl.worldPaintMesh.cullable = false;
      cl.worldRoot = new PIXI.Container();
      cl.worldRoot.addChild(cl.worldPaintMesh);
      cl.worldCache = createWorldRectCache();
      cl.worldEveryFrame = readsFrameTime(fragment);
      cl.displaySprite = new PIXI.Sprite(cl.worldRt);
      cl.displaySprite.anchor.set(0, 0);
      cl.displaySprite.position.set(0, 0);
      built.mesh.visible = false;
      cl.worldHolder = new PIXI.Container();
      cl.worldHolder.addChild(built.mesh);
      cl.worldHolder.addChild(cl.displaySprite);
      this.worker._registerLayerDisplayObject(cl.layerName, cl.worldHolder, cl.containerBlendSet);
      this.worker.pixiApp.stage.addChild(cl.worldHolder);
    } else {
      this.worker._registerLayerDisplayObject(cl.layerName, built.mesh, cl.containerBlendSet);
      this.worker.pixiApp.stage.addChild(built.mesh);
    }
    debugWorkerLog(`PIXI WORKER: world-rect layer "${cl.layerName}" ${rect.width}x${rect.height}${cl.worldRt ? ' (cached)' : ''}`);
  }

  hasComputeLayer() {
    const list = this.list;
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      if (list[i].compute) return true;
    }
    return false;
  }

  /** Private pose copies. One alloc, size poseCapacity. Compute must not read the live SAB. */
  _ensureComputePoseSnap() {
    const n = this.worker.poseCapacity | 0;
    if (!(n > 0)) return false;
    if (this.poseSnapX && this.poseSnapX.length === n) return true;
    this.poseSnapX = new Float32Array(n);
    this.poseSnapY = new Float32Array(n);
    this.poseSnapRotC = new Float32Array(n);
    this.poseSnapRotS = new Float32Array(n);
    this.poseSnapPrevX = new Float32Array(n);
    this.poseSnapPrevY = new Float32Array(n);
    this.poseSnapPrevRotC = new Float32Array(n);
    this.poseSnapPrevRotS = new Float32Array(n);
    return true;
  }

  /**
   * Copy the latched pose before pre-render is woken. publishPose reuses that
   * SAB slot once the next consume lands; the stamp must keep this frame's numbers.
   */
  snapshotComputePose() {
    const computePose = this.computePose;
    if (!this.hasComputeLayer() || !this._ensureComputePoseSnap()) {
      computePose.poseX = this.worker._poseX;
      computePose.poseY = this.worker._poseY;
      computePose.poseRotC = this.worker._poseRotC;
      computePose.poseRotS = this.worker._poseRotS;
      computePose.prevPoseX = this.worker._prevPoseX;
      computePose.prevPoseY = this.worker._prevPoseY;
      computePose.prevPoseRotC = this.worker._prevPoseRotC;
      computePose.prevPoseRotS = this.worker._prevPoseRotS;
      return;
    }
    if (!this.worker._poseX) {
      computePose.poseX = null;
      computePose.poseY = null;
      computePose.poseRotC = null;
      computePose.poseRotS = null;
      computePose.prevPoseX = null;
      computePose.prevPoseY = null;
      computePose.prevPoseRotC = null;
      computePose.prevPoseRotS = null;
      return;
    }
    this.poseSnapX.set(this.worker._poseX);
    this.poseSnapY.set(this.worker._poseY);
    this.poseSnapRotC.set(this.worker._poseRotC);
    this.poseSnapRotS.set(this.worker._poseRotS);
    computePose.poseX = this.poseSnapX;
    computePose.poseY = this.poseSnapY;
    computePose.poseRotC = this.poseSnapRotC;
    computePose.poseRotS = this.poseSnapRotS;
    if (this.worker._prevPoseX) {
      this.poseSnapPrevX.set(this.worker._prevPoseX);
      this.poseSnapPrevY.set(this.worker._prevPoseY);
      this.poseSnapPrevRotC.set(this.worker._prevPoseRotC);
      this.poseSnapPrevRotS.set(this.worker._prevPoseRotS);
      computePose.prevPoseX = this.poseSnapPrevX;
      computePose.prevPoseY = this.poseSnapPrevY;
      computePose.prevPoseRotC = this.poseSnapPrevRotC;
      computePose.prevPoseRotS = this.poseSnapPrevRotS;
    } else {
      computePose.prevPoseX = null;
      computePose.prevPoseY = null;
      computePose.prevPoseRotC = null;
      computePose.prevPoseRotS = null;
    }
  }

  /**
   * painterRadix.wasm for the y-sorted custom layers, whose painter states are regions of the render-queue memory
   * next to their queues: Pixi's entities kernel when it has one (a kernel sorts any state of its memory), else one
   * bound for them; null when no layer has such a state.
   */
  async _bindPainter(queues) {
    const memory = this.worker._renderQueueMemory;
    let layout = null;
    for (const q of Object.values(queues)) {
      if (q && q.painter) {
        layout = q.painter;
        break;
      }
    }
    if (!memory || !layout) return null;
    if (this.worker._painterWasm) return this.worker._painterWasm.kernel;
    return (await bindPainterRadix(memory, layout)).kernel;
  }

  /**
   * A y-sorted custom layer's painter state, on its regions of the memory and sorted by `kernel`; null (the layer drawn
   * in queue order, said once) when it has none there.
   */
  _painterState(kernel, lrq, maxItems, layerName) {
    const layout = lrq.painter;
    if (!kernel || !layout || lrq.dataA !== kernel.buffer || layout.rows < maxItems) {
      console.error(`[PIXI WORKER] custom layer "${layerName}" sorts by y, but its painter state is not in the render-queue `
        + 'memory with its queues: it is drawn in queue order');
      return null;
    }
    return wasmPainterState(kernel.buffer, layout, kernel);
  }
}
