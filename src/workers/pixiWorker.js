self.postMessage({
  msg: 'log',
  message: 'js loaded',
  when: Date.now(),
});

// pixi_worker.js - PixiJS instanced renderer. Consumes pre_render render-queue SAB.

// Import engine dependencies

import { Transform } from '../components/transform.js';
import { RigidBody } from '../components/rigidBody.js';

import { Collider } from '../components/collider.js';
import { ColliderFixture } from '../core/colliderFixture.js';
import { ParticleComponent } from '../components/particleComponent.js';
import { DecorationComponent } from '../components/decorationComponent.js';
import { DecorationPool } from '../core/decorationPool.js';
import { SpriteSheetRegistry } from '../core/spriteSheetRegistry.js';
import { AbstractWorker } from './abstractWorker.js';
import { Query } from '../core/query.js';
import { bindBox2dHotFields } from '../box2d/box2dHotFields.js';
import { bindCommandRing } from '../box2d/box2dCommandRing.js';

import { LightEmitter } from '../components/lightEmitter.js';
import { LightOccluder, LIGHT_OCCLUDER_MASK_SPRITE } from '../components/lightOccluder.js';
import { SpriteRenderer } from '../components/spriteRenderer.js';
import { MeshRenderer } from '../components/meshRenderer.js';
import { Sun } from '../core/sun.js';

import {
  DEFAULT_LAYERS,
  RENDERER_DEFAULTS,
  LIGHTING_DEFAULTS,
  ShapeType,
  MAX_POLYGON_VERTICES,
  LAYER_DENSITY_SOURCE,
  LAYER_FEEDER_KIND,
  LAYER_KIND,
  LAYER_SCALE_MODE,
} from '../util/configDefaults.js';
import {
  writeOrientedBoxVerts,
  writePolygonVerts,
} from '../render/visibility/angularSweep.js';
import { Layer } from '../core/layer.js';
import { coverBackgroundTransform } from '../render/coverBackground.js';
import { meshLookFullscreenUvs } from '../render/meshLookUv.js';
import { TileMap } from '../core/tileMap.js';
import {
  listGidPages,
  gidPageSize,
  gidPageByteLength,
  gidPageHasTile,
  packGidPageRgba8,
} from '../render/tilemapGid.js';
import { createViews as createRenderQueueViews, createRenderQueueCameraViews } from '../render/renderQueueLayout.js';
import {
  sortByY,
  normalizeAngleDifference,
  extractRGBNormalizedMut,
  lightInfluenceRadius,
  lightDataTextureFloatCount,
  packLightDataTexel,
  clearUnusedLightDataTexels,
  LIGHT_DATA_TEX_HEIGHT,
} from '../util/utils.js';
import {
  InstancedSpriteBatch,
  BATCH_SPACE,
  BATCH_DEPTH,
  buildTextureLut,
  packTextureLutRgba,
  TEX_LUT_RGBA_WIDTH,
} from '../render/instancedSpriteBatch.js';
import { LiquidFunDensitySplat } from '../render/liquidFunDensitySplat.js';
import {
  ColliderFillBatch,
  packColliderFill,
  packColliderFillPoseOnly,
  colliderFillCanSkipPack,
  copyMeshFillPoseScratch,
  clearMeshFillPaintDirty,
  meshFillPresenceChanged,
  COLLIDER_FILL_PACK_FIRST_FRAME,
} from '../render/colliderFillBatch.js';
import { LiquidFun } from '../core/liquidFun.js';
import { ComputeLayer } from '../render/webgpu/computeLayer.js';
import { releasePixiBindGroupsOnResource } from '../render/releasePixiBindGroups.js';

function finiteOrZero(n) {
  return Number.isFinite(n) ? n : 0;
}

/** Instanced Mesh with instanceCount 0 still GPU-draws if visible / used as RT root. */
function emptyInstancedMesh(obj) {
  return !!(obj && obj.geometry && (obj.geometry.instanceCount | 0) === 0);
}

function setDisplayVisible(obj, on) {
  if (!obj) return;
  obj.visible = !!on && !emptyInstancedMesh(obj);
}

function makeBatchViews() {
  return {
    count: 0,
    x: null,
    y: null,
    scaleX: null,
    scaleY: null,
    rotC: null,
    rotS: null,
    alpha: null,
    tint: null,
    textureId: null,
    anchorX: null,
    anchorY: null,
    repeatX: null,
    repeatY: null,
    tileMode: null,
    tileOffsetU: null,
    tileOffsetV: null,
    tileMulX: null,
    tileMulY: null,
  };
}

function layerIsVisible(id) {
  if (id == null || id < 0) return true;
  if (!Layer._visible) return true;
  const i = id | 0;
  if (Layer._visibleDirty) Atomics.load(Layer._visibleDirty, i);
  return Layer._visible[i] !== 0;
}

function setLookUniform1(map, floats, store, name, value) {
  const e = map[name];
  if (!e || e.size !== 1) return;
  if (floats) floats[e.offset] = value;
  if (store) store[name] = value;
}

function setLookUniform2(map, floats, store, name, x, y) {
  const e = map[name];
  if (!e || e.size < 2) return;
  if (floats) {
    floats[e.offset] = x;
    floats[e.offset + 1] = y;
  }
  if (!store) return;
  const target = store[name];
  if (target) {
    target[0] = x;
    target[1] = y;
  }
}

/** Engine Frame into declared look uniforms. Overwrites reserved names every frame. */
function applyEngineLookUniforms(cl, frame) {
  const map = Layer._uniformMaps[cl.layerId];
  if (!map) return;
  const floats = Layer._uniformFloats[cl.layerId];
  const store = cl.uniformStore;
  const zoom = frame.zoom > 0 ? frame.zoom : 1;
  setLookUniform1(map, floats, store, 'uTime', frame.time);
  setLookUniform1(map, floats, store, 'uDt', frame.dt);
  setLookUniform1(map, floats, store, 'uZoom', zoom);
  setLookUniform2(map, floats, store, 'uCameraPos', frame.cameraX, frame.cameraY);
  setLookUniform2(map, floats, store, 'uCanvasSize', frame.canvasW, frame.canvasH);
  setLookUniform2(map, floats, store, 'uWorldSize', frame.worldW, frame.worldH);
  setLookUniform2(map, floats, store, 'uViewSize', frame.canvasW / zoom, frame.canvasH / zoom);
}

function applyComputeTexSizeUniform(cl) {
  const map = Layer._uniformMaps[cl.layerId];
  if (!map || !cl.compute) return;
  setLookUniform2(
    map,
    Layer._uniformFloats[cl.layerId],
    cl.uniformStore,
    'uTexSize',
    cl.compute.numX,
    cl.compute.numY
  );
}
import { writeRgba32Float } from '../render/webgpu/pinGpuTexture.js';
import { lightingGpuProgram, lookGpuProgram, gpuProgramFromWgsl, isWgslSource } from '../render/webgpu/pixiMeshWgsl.js';
import { prependLookPrelude, findWgslUseBeforeDeclare } from '../render/webgpu/wgslPrelude.js';
import {
  normalizeRendererBackend,
  assertLookShaderCompatible,
  errorPixiTypeMismatch,
  errorMissingGpuDevice,
  errorCompileFailed,
  errorShaderFetchFailed,
  pixiRendererTypeName,
  RENDERER_BACKEND_WEBGPU,
} from '../render/rendererBackend.js';

function fetchEngineShader(path) {
  const slash = path.lastIndexOf('/');
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  // Blob workers have an opaque origin — root-relative `/src/...` is not a
  // valid URL there. Init posts pageOrigin from the page.
  const origin = self.__weedPageOrigin || '';
  const url = path.charCodeAt(0) === 47 && origin ? origin + path : path;
  return fetch(url).then(async (r) => {
    if (!r.ok) throw errorShaderFetchFailed(name, path, r.status);
    const s = await r.text();
    if (!String(s).trim()) throw errorShaderFetchFailed(name, path, 'empty');
    return s;
  });
}

// OPTIMIZED: Pre-defined comparator function for light sorting (avoids closure allocation per frame)
function sortByDistSq(a, b) {
  return a.distSq - b.distSq;
}

import { RENDERER_STATS, createStatsWriter } from '../util/workersUtils.js';

// Import PixiJS 8 library (ES6 module with named exports)
import {
  Application,
  Container,
  Sprite,
  Texture,
  Rectangle,
  TilingSprite,
  TextureSource,
  ImageSource,
  Ticker,
  Matrix,
  // Shader/Mesh for lighting system
  Geometry,
  Mesh,
  Shader,
  GpuProgram,
  GlProgram,
  State,
  RendererType,
  RenderTexture,
  // Web Worker adapter - REQUIRED for PixiJS 8 in workers
  DOMAdapter,
  WebWorkerAdapter,
} from '../vendor/pixi.min.js'

// CRITICAL: Set the WebWorkerAdapter BEFORE any PixiJS operations
// This enables OffscreenCanvas and WebGL support in web workers
DOMAdapter.set(WebWorkerAdapter);

function gpuFromWgsl(source, name) {
  return gpuProgramFromWgsl(GpuProgram, source, name);
}

// Create PIXI-like namespace for compatibility with existing code patterns
const PIXI = Object.freeze({
  Application,
  Container,
  Sprite,
  Texture,
  Rectangle,
  TilingSprite,
  TextureSource,
  ImageSource,
  Ticker,
  Matrix,
  Geometry,
  Mesh,
  Shader,
  GpuProgram,
  GlProgram,
  State,
  RendererType,
  RenderTexture,
});

// Note: Core engine classes (GameObject, Mouse, etc.) and components
// (Transform, RigidBody, etc.) are now registered automatically by AbstractWorker.
// Game-specific entity classes are loaded dynamically.

const QUERY_LIGHT_EMITTER = [LightEmitter];

// Make PIXI namespace available globally (renderer-specific)
self.PIXI = PIXI;

/**
 * PixiRenderer - Manages rendering of game objects using PixiJS in a web worker
 * Extends AbstractWorker for common worker functionality
 */
class PixiRenderer extends AbstractWorker {
  static DEFAULT_LAYERS = DEFAULT_LAYERS;

  constructor(selfRef) {
    super(selfRef);

    // Use PIXI ticker instead of requestAnimationFrame
    this.usesCustomScheduler = true;

    // Renderer configuration options (set during initialize)
    this.ySorting = false; // Enable/disable Y-sorting for depth ordering
    this.physicsWorkerIndex = 1; // Updated during initialize() based on spatial worker count

    // PIXI application and rendering
    this.pixiApp = null;
    /** @type {InstancedSpriteBatch|null} */
    this.entitiesBatch = null;
    /** @type {InstancedSpriteBatch|null} light-glow (type=3) ADD batch */
    this.entitiesGlowBatch = null;
    /** @type {InstancedSpriteBatch|null} particles (type=1) Y-sort test, no Z write */
    this.entitiesParticleBatch = null;
    /** @type {InstancedSpriteBatch|null} */
    this.shadowBatch = null;
    this.spriteMesh = null; // entitiesBatch.mesh alias for layer refs
    this.spriteGlowMesh = null; // entitiesGlowBatch.mesh
    this.spriteParticleMesh = null; // entitiesParticleBatch.mesh
    this._texLut = null;
    this._texLutCount = 0;
    this._texLutSource = null;
    this._texLutRgba = null;
    this._texLutNeedsGpuUpload = false;
    this._rqIdxEntity = null;
    this._rqIdxParticle = null;
    this._rqIdxGlow = null;
    /** @type {Array<{kind:string, displayObject:*, parallaxX:number, parallaxY:number, cover?:object, tilemap?:object}|null>} */
    this._scenery = [];
    this._tilemapGidProgramOpts = null;
    this._sceneryCamDirty = true;
    this._sceneryCamZoom = NaN;
    this._sceneryCamX = NaN;
    this._sceneryCamY = NaN;
    this._sceneryCamCw = -1;
    this._sceneryCamCh = -1;
    this._coverBgArgs = null;
    this._coverBgOut = null;

    /** From renderer.autoGenerateMipmaps (default false) — applied at ImageSource create */
    this.autoGenerateMipmaps = RENDERER_DEFAULTS.autoGenerateMipmaps;

    // Texture and spritesheet storage
    this.textures = {}; // Store simple PIXI textures by name
    this.spritesheets = {}; // Store loaded spritesheets by name
    this.tilemaps = {}; // Store PIXI tileset textures by tilemap name (tile data comes from TileMap SAB)

    // Per-frame subtimers (ms) — written to RENDERER_STATS in reportFPS
    this.lightsTimeThisFrame = 0;
    this.shadowsTimeThisFrame = 0;
    this.spritesTimeThisFrame = 0;
    this.customLayersTimeThisFrame = 0;
    this.miscTimeThisFrame = 0;

    // Entity / particle / decoration rendering goes through the render queue
    // (see updateSpritesFromRenderQueue). Animation/texture selection happens in
    // pre_render_worker, which writes resolved textureIds into the queue.
    this.maxParticles = 0;
    this.maxDecorations = 0;
    this.visibleDecorationCount = 0;

    // World and viewport dimensions
    this.worldWidth = 0;
    this.worldHeight = 0;
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.canvasView = null;

    // Visible units tracking (throttled reporting)
    this.lastReportedVisibleCount = -1;
    this.visibleUnitsReportInterval = 500; // Report every 500ms
    this.lastVisibleUnitsReportTime = 0;

    // Draw call tracking
    this.drawCallCount = 0;
    this.visibleEntityCount = 0;
    this.visibleParticleCount = 0;

    // ========================================
    // Y-SORTING POOL (unused leftover; y-sort happens in pre_render)
    // ========================================
    this._ySortPool = [];
    this._ySortPoolSize = 0;

    // ========================================
    // RENDER QUEUE SYSTEM (DOUBLE BUFFERED)
    // ========================================
    // Pre-sorted, screen-visible renderables from pre_render_worker
    // pixi_worker NEVER waits - always reads from latest ready buffer
    // pre_render skips a frame if >1 ahead (backpressure)
    this.renderQueueEnabled = false;
    this._queueInterp = false;
    this._latchedPrevX = null;
    this._latchedPrevY = null;
    this._latchedPrevCount = 0;
    this._poseWall = 0;
    this._poseInterval = 0;
    this._poseAlpha = 1;
    this._poseSnap = true;
    this._posePacked = false;
    this.renderQueueMaxItems = 0;

    // Double buffer storage - views for both buffers
    this.renderQueueBuffers = [null, null];
    this.renderQueueCameraBuffers = [null, null];
    this.renderQueuePoseReadyBuffers = [null, null];

    // Sync buffer for coordination: [readyFrame, consumedFrame]
    this.renderQueueSync = null;
    this.lastReadFrame = -1; // Last frame we read (to signal consumption)

    // Current read buffer reference (set each frame based on readyFrame)
    // Tile fields (tileMode / tileOffset / tileMul): see renderQueueLayout.js
    this.renderQueueCount = null;  // Int32Array[1] - current item count
    this.renderQueueX = null;      // Float32Array - interpolated X
    this.renderQueueY = null;      // Float32Array - interpolated Y
    this.renderQueueScaleX = null; // Float32Array
    this.renderQueueScaleY = null; // Float32Array
    this.renderQueueRotC = null; // Float32Array
    this.renderQueueRotS = null; // Float32Array
    this.renderQueueAlpha = null;  // Float32Array
    this.renderQueueTint = null;   // Uint32Array
    this.renderQueueTextureId = null; // Uint16Array (encoded)
    this.renderQueueAnchorX = null; // Float32Array
    this.renderQueueAnchorY = null; // Float32Array
    this.renderQueueRepeatX = null; // Uint16Array
    this.renderQueueRepeatY = null; // Uint16Array
    this.renderQueueType = null;
    this.renderQueueSortKey = null;
    this.renderQueueCamera = null; // Float32Array[3] -> [zoom, x, y]
    this.renderQueuePoseReady = null; // Int32Array[1] -> pose generation stamped with this queue slot

    // Render queue — instanced Mesh (no Particle pool for ENTITIES)
    this._rqPrevCount = 0;

    // Custom layer rendering infrastructure (populated during initialize)
    this._customLayers = {};  // layerId -> { buffers, readRef, sprites, poolIndices, prevCount, pc, rt, displaySprite, filter }
    this._customLayerList = []; // Cached array of custom layer objects, set once during init
    this._layerRuntime = Object.create(null); // layerName -> display object
    this.layerRefs = {};

    // ========================================
    // FLAT TEXTURE LOOKUP (Zero-cost texture resolution)
    // ========================================
    // All textures flattened into single array for O(1) lookup
    // Index = globalTextureId from pre_render_worker
    this.flatTextures = [];           // PIXI.Texture[] indexed by globalTextureId
    this.animationFrameStart = [];    // Starting index in flatTextures for each animation
    this.animationFrameCount = [];    // Number of frames per animation

    // ========================================
    // BLOOD DECAL SPLAT GRID (SAB tiles, not TileMap background)
    // ========================================
    // ========================================
    // Renders decal splats stamped by particle_worker onto tile sprites
    this.decalsEnabled = false;
    this.decalsTileSize = 256; // World units each tile covers
    this.decalsTilePixelSize = 256; // Actual texture pixel size
    this.decalsResolution = 1.0; // Resolution multiplier
    this.decalsTilesX = 0;
    this.decalsTilesY = 0;
    this.decalsTotalTiles = 0;
    this.maxDecalTileUploadsPerFrame = RENDERER_DEFAULTS.maxDecalTileUploadsPerFrame;
    this._nextDecalTileScanIndex = 0;
    this._decalTilesDirtyThisFrame = 0;
    this._decalTilesUploadedThisFrame = 0;
    this._meshFillInstancesThisFrame = 0;
    this._meshRtDrawsThisFrame = 0;

    // SharedArrayBuffer views (shared with particle_worker)
    this.decalsTilesRGBA = null; // Uint8ClampedArray - RGBA pixel data
    this.decalsTilesDirty = null; // Uint8Array - dirty flags (0=clean, 1=modified)

    // PIXI rendering
    this.decalTileContainer = null; // Container for decal tile sprites
    this.decalTileSprites = []; // Array of Sprite per tile
    this.decalTileTextureSources = []; // TextureSource per tile (for updating)

    // ========================================
    // LIGHTING SYSTEM
    // ========================================
    // Full-screen shader mesh for dynamic lighting (multiply blend)
    // Configured via config.lighting: { enabled, baseAmbient }
    this.lightingEnabled = false;
    this.lightingMesh = null; // PIXI.Mesh with lighting shader
    this.lightingShader = null; // Shader instance for updating uniforms
    this.baseAmbient = 0.05; // Base ambient light level (0-1), read from config (night/minimum light)
    this.maxLights = 128; // Light-data texture width / capacity (config.lighting.maxLights)
    this.lightingResolution = 1.0; // Resolution multiplier for lighting (e.g. 0.5 for half res)
    this.lightingRT = null; // RenderTexture for low-res lighting
    this.lightingDisplaySprite = null; // Sprite to display the lightingRT on stage
    this._lightDataFloats = null; // Float32Array RGBA32F payload (maxLights x 2)
    this._lightDataSource = null; // BufferImageSource uploading _lightDataFloats
    this.liquidFunMaxCount = 0;
    this._lfLightSplat = null;

    // ========================================
    // SUN / DIRECTIONAL LIGHT
    // ========================================
    // Sun provides global ambient light that varies with time of day
    // Reads from SharedArrayBuffer via static Sun class (initialized by AbstractWorker)
    this.sunEnabled = false;

    // Reusable pool for light sorting (GC optimization)
    this._lightPool = [];
    this._lightPoolSize = 0;

    // Pre-computed visible lights (computed once per frame, used by updateLighting shader)
    this._visibleLightsAll = [];      // All visible lights (for shader uniforms)
    this._visibleLightsAllCount = 0;

    // ========================================
    // RENDER-TEXTURE SHADOW SYSTEM (DOUBLE BUFFERED)
    // ========================================
    // Shadows are rendered to a RenderTexture from pre-sorted shadowRenderQueue
    // Built by pre_render_worker: light1_gradient, light1_shadows..., light2_gradient, etc.
    // The final texture is applied with MULTIPLY blend to darken the scene
    // Uses same sync as main render queue (swapped together)
    this.shadowSpritesEnabled = false;
    this.maxShadowRenderItems = 0;

    // Double buffer storage for shadows
    this.shadowRenderQueueBuffers = [null, null];

    // Current read buffer reference (set each frame based on readyFrame)
    this.shadowRenderQueueCount = null;
    this.shadowRenderQueueX = null;
    this.shadowRenderQueueY = null;
    this.shadowRenderQueueScaleX = null;
    this.shadowRenderQueueScaleY = null;
    this.shadowRenderQueueRotC = null;
    this.shadowRenderQueueRotS = null;
    this.shadowRenderQueueAlpha = null;
    this.shadowRenderQueueTint = null;
    this.shadowRenderQueueTextureId = null;
    this.shadowRenderQueueAnchorX = null;
    this.shadowRenderQueueAnchorY = null;

    // RenderTexture-based shadow compositing
    this.shadowRT = null; // RenderTexture for shadow compositing
    this.shadowDisplaySprite = null; // Sprite to display shadowRT with multiply blend
    this.shadowResolution = LIGHTING_DEFAULTS.shadowResolution;

    // Reusable camera render-state
    this._renderCameraX = 0;
    this._renderCameraY = 0;
    this._renderZoom = 1.0;
    this._cameraInitialized = false;
    // Reused compute pack pose (same generation as sprites). Filled on new queue frame.
    this._computePose = {
      poseX: null,
      poseY: null,
      poseRotC: null,
      poseRotS: null,
      prevPoseX: null,
      prevPoseY: null,
      prevPoseRotC: null,
      prevPoseRotS: null,
    };
    this._computeFrame = {
      dt: 0,
      cameraX: 0,
      cameraY: 0,
      canvasW: 0,
      canvasH: 0,
      zoom: 1,
      time: 0,
      worldW: 0,
      worldH: 0,
    };
    this._clearTransparent = [0, 0, 0, 0];
    this._rtEmptyContainer = new Container();
    this._meshRtRoot = new Container();
    this._meshRtRoot.eventMode = 'none';
    this._meshRtRoot.cullable = false;
    this._entityUploadQ = makeBatchViews();
    this._entityUploadOpts = {
      space: BATCH_SPACE.WORLD,
      zoom: 1,
      cameraX: 0,
      cameraY: 0,
      resolution: 1,
      depthMode: BATCH_DEPTH.INDEX,
      depthDenom: 1,
      worldHeight: 10000,
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
    };
    this._shadowUploadQ = makeBatchViews();
    this._shadowUploadOpts = {
      space: BATCH_SPACE.SCREEN,
      zoom: 1,
      cameraX: 0,
      cameraY: 0,
      resolution: 1,
      depthMode: BATCH_DEPTH.INDEX,
      depthDenom: 1,
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
    };
    this._splatUploadOpts = {
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
    this._lfLightOpts = {
      zoom: 1,
      cameraX: 0,
      cameraY: 0,
      resolution: 1,
      canvasW: 0,
      canvasH: 0,
    };
    this._rtRenderOpts = {
      container: null,
      target: null,
      transform: null,
      clear: true,
      clearColor: this._clearTransparent,
    };
    this._rtRenderOptsNoClear = {
      container: null,
      target: null,
      clear: false,
    };

    // OPTIMIZED: Preallocated RGB object to avoid allocation per light per frame
    this._rgbResult = { r: 0, g: 0, b: 0 };

    // ========================================
    // RAYCASTED LIGHT OCCLUSION (visibility polygons)
    // ========================================
    this._visPolyEnabled = false;
    this._visPolyBuffers = [null, null]; // Double-buffered typed views + header pairs
    this._visPolyMaxVerts = 128;
    this._visPolyMaxLights = 10;
    this._visPolySlotBytes = 0;
    this._visPolyContainer = null;   // Container for light meshes
    this._visPolyMeshes = [];        // Reusable PIXI.Mesh pool
    this._visPolyRT = null;          // RenderTexture for visibility lighting
    this._visPolyDisplaySprite = null; // Sprite displaying the RT with multiply blend
    this._selfLitBuffers = [null, null];
    this._selfLitItemBytes = 28;
    this._selfLitContainer = null;
    this._selfLitColliderMesh = null;
    this._selfLitSpriteMeshes = [];
    this._selfLitCircleSegs = 16;
    this._selfLitPosScratch = null;
    this._selfLitIdxScratch = null;
    this._selfLitBoxScratchX = new Float32Array(8);
    this._selfLitBoxScratchY = new Float32Array(8);
    this._colliderFillViews = null;
    this._colliderFillMeshBitsCached = 0;
    this._colliderFillLayerCount = -1;
    // Per MESH layer: last packed ColliderFixture.revision + pose scratch.
    // ponytail: first frame / replace / moving mesh always pack; skip keeps instanceCount.
    this._colliderFillSkip = [];

    // Reusable matrices for low-res rendering
    this._shadowTransform = new PIXI.Matrix();
    this._lightingTransform = new PIXI.Matrix();
    this._meshRtTransform = new PIXI.Matrix();

  }

  /**
   * Set the current read buffer for main render queue
   * @param {number} bufferIdx - 0 or 1
   */
  _setReadBuffer(bufferIdx) {
    const buffer = this.renderQueueBuffers[bufferIdx];
    if (!buffer) return;

    this.renderQueueCount = buffer.count;
    this.renderQueueX = buffer.x;
    this.renderQueueY = buffer.y;
    this.renderQueueScaleX = buffer.scaleX;
    this.renderQueueScaleY = buffer.scaleY;
    this.renderQueueRotC = buffer.rotC;
    this.renderQueueRotS = buffer.rotS;
    this.renderQueueAlpha = buffer.alpha;
    this.renderQueueTint = buffer.tint;
    this.renderQueueTextureId = buffer.textureId;
    this.renderQueueAnchorX = buffer.anchorX;
    this.renderQueueAnchorY = buffer.anchorY;
    this.renderQueueRepeatX = buffer.repeatX;
    this.renderQueueRepeatY = buffer.repeatY;
    this.renderQueueTileMode = buffer.tileMode;
    this.renderQueueTileOffsetU = buffer.tileOffsetU;
    this.renderQueueTileOffsetV = buffer.tileOffsetV;
    this.renderQueueTileMulX = buffer.tileMulX;
    this.renderQueueTileMulY = buffer.tileMulY;
    this.renderQueueType = buffer.type;
    this.renderQueueSortKey = buffer.sortKey;
    this.renderQueueCamera = this.renderQueueCameraBuffers[bufferIdx];
    this.renderQueuePoseReady = this.renderQueuePoseReadyBuffers[bufferIdx];
  }

  _notePosePublish() {
    const now = performance.now();
    if (this._poseWall > 0) {
      const gap = now - this._poseWall;
      if (gap > 0) {
        this._poseInterval = this._poseInterval ? this._poseInterval * 0.8 + gap * 0.2 : gap;
      }
    }
    this._poseWall = now;
    this._poseAlpha = this._poseSnap ? 1 : 0;
  }

  _tickPoseAlpha() {
    const elapsed = performance.now() - this._poseWall;
    this._poseAlpha = this._poseInterval > 0 ? Math.min(1, elapsed / this._poseInterval) : 1;
  }

  /** Copy latched pose views into reused _computePose (no alloc). */
  _syncComputePose() {
    const computePose = this._computePose;
    computePose.poseX = this._poseX;
    computePose.poseY = this._poseY;
    computePose.poseRotC = this._poseRotC;
    computePose.poseRotS = this._poseRotS;
    computePose.prevPoseX = this._prevPoseX;
    computePose.prevPoseY = this._prevPoseY;
    computePose.prevPoseRotC = this._prevPoseRotC;
    computePose.prevPoseRotS = this._prevPoseRotS;
  }

  /**
   * Set the current read buffer for shadow render queue
   * @param {number} bufferIdx - 0 or 1
   */
  _setShadowReadBuffer(bufferIdx) {
    const buffer = this.shadowRenderQueueBuffers[bufferIdx];
    if (!buffer) return;

    this.shadowRenderQueueCount = buffer.count;
    this.shadowRenderQueueX = buffer.x;
    this.shadowRenderQueueY = buffer.y;
    this.shadowRenderQueueScaleX = buffer.scaleX;
    this.shadowRenderQueueScaleY = buffer.scaleY;
    this.shadowRenderQueueRotC = buffer.rotC;
    this.shadowRenderQueueRotS = buffer.rotS;
    this.shadowRenderQueueAlpha = buffer.alpha;
    this.shadowRenderQueueTint = buffer.tint;
    this.shadowRenderQueueTextureId = buffer.textureId;
    this.shadowRenderQueueAnchorX = buffer.anchorX;
    this.shadowRenderQueueAnchorY = buffer.anchorY;
  }

  /**
   * Hook into WebGL context to count draw calls per frame
   */
  setupWebGLHooks() {
    if (this._useWebGpu) return;
    this.setupDrawCallMonitoring();

    const gl = this.pixiApp.renderer.gl;
    if (gl && gl.canvas) {
      gl.canvas.addEventListener(
        'webglcontextlost',
        (e) => {
          e.preventDefault();
          this.reportError(
            'WebGL Context Lost',
            new Error(
              'The GPU context was lost. This usually happens due to GPU driver crashes or excessive resource usage.'
            )
          );
        },
        false
      );

      gl.canvas.addEventListener(
        'webglcontextrestored',
        () => {
          this.reportLog('WebGL context restored');
        },
        false
      );
    }
  }

  /**
   * Pixi 8.20 presents via CanvasSource._gpuContext.getCurrentTexture().
   * Re-configure after canvas width/height assignment (that resets WebGPU).
   */
  _bindWebGpuSwapchain() {
    const renderer = this.pixiApp?.renderer;
    const device = renderer?.gpu?.device;
    const canvas = this.canvasView || renderer?.view?.canvas;
    if (!device || !canvas || typeof canvas.getContext !== 'function') return;
    const viewRt = renderer.view?.renderTarget;
    if (!viewRt) return;
    const colorTexture =
      viewRt.colorAttachments?.[0]?.texture ?? viewRt.colorTextures?.[0];
    const source = colorTexture?.resource ? colorTexture : colorTexture?.source;
    const texFormat = source?.format;
    const format =
      texFormat === 'bgra8unorm' || texFormat === 'rgba8unorm' || texFormat === 'rgba16float'
        ? texFormat
        : 'bgra8unorm';
    const context = source?._gpuContext || canvas.getContext('webgpu');
    if (!context) {
      console.error('PIXI WORKER: OffscreenCanvas getContext("webgpu") failed');
      return;
    }
    context.configure({
      device,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC,
      format,
      alphaMode: 'premultiplied',
    });
    if (source) source._gpuContext = context;
    const gpuRt = renderer.renderTarget.getGpuRenderTarget(viewRt);
    gpuRt.contexts[0] = context;
    if (!this._loggedSwapchainBind) {
      this._loggedSwapchainBind = true;
      console.log(
        'PIXI WORKER: WebGPU swapchain bound',
        JSON.stringify({
          format,
          w: canvas.width,
          h: canvas.height,
          color0: colorTexture?.constructor?.name,
          hasGpuContext: !!source?._gpuContext,
        })
      );
    }
  }

  setupDrawCallMonitoring() {
    if (this._useWebGpu) return;
    const gl = this.pixiApp.renderer.gl;
    if (!gl) {
      console.warn('PIXI WORKER: Could not access WebGL context for draw call monitoring');
      return;
    }

    const renderer = this;

    const originalDrawArrays = gl.drawArrays.bind(gl);
    gl.drawArrays = function (...args) {
      renderer.drawCallCount++;
      return originalDrawArrays(...args);
    };

    const originalDrawElements = gl.drawElements.bind(gl);
    gl.drawElements = function (...args) {
      renderer.drawCallCount++;
      return originalDrawElements(...args);
    };

    if (gl.drawArraysInstanced) {
      const originalDrawArraysInstanced = gl.drawArraysInstanced.bind(gl);
      gl.drawArraysInstanced = function (...args) {
        renderer.drawCallCount++;
        return originalDrawArraysInstanced(...args);
      };
    }

    if (gl.drawElementsInstanced) {
      const originalDrawElementsInstanced = gl.drawElementsInstanced.bind(gl);
      gl.drawElementsInstanced = function (...args) {
        renderer.drawCallCount++;
        return originalDrawElementsInstanced(...args);
      };
    }
  }

  /**
   * Override reportFPS to write stats to SharedArrayBuffer
   */
  reportFPS() {
    if (this.stats) {
      this.stats[RENDERER_STATS.FPS] = this.currentFPS;
      this.stats[RENDERER_STATS.STEP_MS] = this.stepTimeThisFrame;
      this.stats[RENDERER_STATS.DECAL_TILES_DIRTY] = this._decalTilesDirtyThisFrame;
      this.stats[RENDERER_STATS.DECAL_TILES_UPLOADED] = this._decalTilesUploadedThisFrame;
      let sceneryN = 0;
      const sc = this._scenery;
      if (sc) {
        for (let i = 0; i < sc.length; i++) {
          if (sc[i]?.displayObject) sceneryN++;
        }
      }
      this.stats[RENDERER_STATS.SCENERY_COUNT] = sceneryN;
      this.stats[RENDERER_STATS.MESH_FILL_INSTANCES] = this._meshFillInstancesThisFrame;
      this.stats[RENDERER_STATS.MESH_RT_DRAWS] = this._meshRtDrawsThisFrame;
      if (this.collectDetailedStats) {
        this.stats[RENDERER_STATS.DRAW_CALLS] = this.drawCallCount;

        const totalVisibleSprites =
          this.visibleEntityCount + this.visibleParticleCount + this.visibleDecorationCount;

        const instancedBatchCount =
          (this.entitiesBatch ? 1 : 0) +
          (this.entitiesParticleBatch ? 1 : 0) +
          (this.entitiesGlowBatch ? 1 : 0) +
          (this.shadowBatch ? 1 : 0) +
          this._customLayerList.length;
        this.stats[RENDERER_STATS.SPRITES_CREATED] = instancedBatchCount;
        this.stats[RENDERER_STATS.VISIBLE_SPRITES] = totalVisibleSprites;
        this.stats[RENDERER_STATS.DECORATION_SPRITES] = instancedBatchCount;
        this.stats[RENDERER_STATS.VISIBLE_DECORATIONS] = this.visibleDecorationCount;
        this.stats[RENDERER_STATS.VISIBLE_ENTITIES] = this.visibleEntityCount;
        this.stats[RENDERER_STATS.VISIBLE_PARTICLES] = this.visibleParticleCount;
        this.stats[RENDERER_STATS.ACTIVE_DECORATIONS] = DecorationPool.getActiveCount();
        this.stats[RENDERER_STATS.MSG_MS] = this.messageTimeThisFrame;
        this.stats[RENDERER_STATS.LIGHTS_MS] = this.lightsTimeThisFrame;
        this.stats[RENDERER_STATS.SHADOWS_MS] = this.shadowsTimeThisFrame;
        this.stats[RENDERER_STATS.SPRITES_MS] = this.spritesTimeThisFrame;
        this.stats[RENDERER_STATS.CUSTOM_LAYERS_MS] = this.customLayersTimeThisFrame;
        this.stats[RENDERER_STATS.MISC_MS] = this.miscTimeThisFrame;
      }
    }

    // Reset draw call counter for next frame
    this.drawCallCount = 0;
  }

  _colliderFillMeshBits() {
    let bits = 0;
    const n = Layer.count | 0;
    for (let id = 0; id < n; id++) {
      if (Layer.feederKind(id) === LAYER_FEEDER_KIND.MESH) bits |= 1 << id;
    }
    return bits;
  }

  _ensureColliderFillViews() {
    let v = this._colliderFillViews;
    if (!v || !v.meshActive) {
      v = this._colliderFillViews = {};
      v.meshActive = MeshRenderer.active;
      v.meshVisible = MeshRenderer.renderVisible;
      v.meshLayerMask = MeshRenderer.layerMask;
      v.meshTint = MeshRenderer.tint;
      v.meshAlpha = MeshRenderer.alpha;
      v.meshDirty = MeshRenderer.renderDirty;
      v.meshTextureId = MeshRenderer.textureId;
      v.meshTileMode = MeshRenderer.tileMode;
      v.meshRepeatX = MeshRenderer.repeatX;
      v.meshRepeatY = MeshRenderer.repeatY;
      v.meshTileOffU = MeshRenderer.tileOffsetU;
      v.meshTileOffV = MeshRenderer.tileOffsetV;
      v.meshVisualOutset = MeshRenderer.visualOutset;
      v.fixtureCount = Collider.fixtureCount;
      v.fixtureHead = ColliderFixture.head;
      v.fixtureNext = ColliderFixture.next;
      v.fixtureActive = ColliderFixture.active;
      v.vertCount = ColliderFixture.vertCount;
      v.vertexX = ColliderFixture.vertexX;
      v.vertexY = ColliderFixture.vertexY;
      v.rbStatic = RigidBody.static;
      v.offsetX = Collider.offsetX;
      v.offsetY = Collider.offsetY;
      v.primaryShapeType = Collider.shapeType;
      v.primaryPolyCount = Collider.polyCount;
      v.primaryPolyVertexX = Collider.polyVertexX;
      v.primaryPolyVertexY = Collider.polyVertexY;
      v.primaryWidth = Collider.width;
      v.primaryHeight = Collider.height;
      v.primaryRadius = Collider.radius;
      v.maxFixtures = ColliderFixture.maxCount | 0;
      v.fixtureRevision = ColliderFixture.revision;
      v.paintEpoch = MeshRenderer.paintEpoch;
    }
    v.entityCount = MeshRenderer.active ? MeshRenderer.active.length : 0;
    v.animationFrameStart = this.animationFrameStart;
    if (this._poseX) {
      v.x = this._poseX;
      v.y = this._poseY;
      v.rotC = this._poseRotC;
      v.rotS = this._poseRotS;
    } else {
      v.x = Transform.x;
      v.y = Transform.y;
      v.rotC = Transform.rotC;
      v.rotS = Transform.rotS;
    }
    v.liveX = Transform.x;
    v.liveY = Transform.y;
    v.liveRotC = Transform.rotC;
    v.liveRotS = Transform.rotS;
    const layerN = Layer.count | 0;
    if (this._colliderFillLayerCount !== layerN) {
      this._colliderFillLayerCount = layerN;
      this._colliderFillMeshBitsCached = this._colliderFillMeshBits();
    }
    v.meshBits = this._colliderFillMeshBitsCached;
    return v;
  }

  /**
   * Update camera on instanced meshes, background, tilemap root, decals
   */
  updateCameraTransform() {
    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;

    // Apply camera to ENTITIES instanced mesh + particle (Y-sort, no Z write) + glow ADD
    if (this.spriteMesh) {
      this.spriteMesh.scale.set(zoom);
      this.spriteMesh.x = -cameraX * zoom;
      this.spriteMesh.y = -cameraY * zoom;
    }
    if (this.spriteParticleMesh) {
      this.spriteParticleMesh.scale.set(zoom);
      this.spriteParticleMesh.x = -cameraX * zoom;
      this.spriteParticleMesh.y = -cameraY * zoom;
      // After ENTITIES so the depth buffer already has Y-sorted opaque sprites
      this.spriteParticleMesh.zIndex = (this.spriteMesh?.zIndex ?? 0) + 0.0005;
    }
    if (this.spriteGlowMesh) {
      this.spriteGlowMesh.scale.set(zoom);
      this.spriteGlowMesh.x = -cameraX * zoom;
      this.spriteGlowMesh.y = -cameraY * zoom;
      // Above LIGHTING multiply so soft ADD bloom is not crushed into gray falloff
      const lightDisp = this._visPolyDisplaySprite || this.lightingDisplaySprite || this.lightingMesh;
      const lightZ = lightDisp?.zIndex ?? (this.spriteMesh?.zIndex ?? 0) + 1;
      this.spriteGlowMesh.zIndex = lightZ + 0.001;
    }

    this._applySceneryCamera(zoom, cameraX, cameraY);

    // Apply camera state to decal tile container
    if (this.decalTileContainer) {
      this.decalTileContainer.scale.set(zoom);
      this.decalTileContainer.x = -cameraX * zoom;
      this.decalTileContainer.y = -cameraY * zoom;
    }

    // Shadow sprites render in screen space directly to shadowRT (no camera transform needed here)

    // Apply camera to custom layer meshes (non-shader layers only).
    // Look-shader MESH keeps world verts; camera is the reused RT Container.
    for (let i = 0; i < this._customLayerList.length; i++) {
      const cl = this._customLayerList[i];
      if (!cl.rt) {
        const mesh = cl.batch?.mesh || cl.fillBatch?.mesh;
        if (mesh) {
          mesh.scale.set(zoom);
          mesh.x = -cameraX * zoom;
          mesh.y = -cameraY * zoom;
        }
      }
    }
  }

  // ========================================
  // RENDER QUEUE UPDATE (Optimized Path)
  // ========================================
  /**
   * Upload main render queue SoA into ENTITIES + particles (no Z write) + glow (add) meshes.
   * Type 1 = particles — own batch tests Y-sort depth, does not punch Z.
   * Type 3 = light glow (_lightGradient) — separate ADD batch avoids gray halos.
   */
  updateSpritesFromRenderQueue() {
    if (!this.renderQueueEnabled || !this.entitiesBatch) return;
    if (!layerIsVisible(Layer.entitiesId)) {
      this.entitiesBatch.mesh.visible = false;
      if (this.entitiesParticleBatch) this.entitiesParticleBatch.mesh.visible = false;
      if (this.entitiesGlowBatch) this.entitiesGlowBatch.mesh.visible = false;
      this.visibleEntityCount = 0;
      this.visibleParticleCount = 0;
      return;
    }

    const count = this.renderQueueCount[0];
    const q = this._entityUploadQ;
    q.count = count;
    q.x = this.renderQueueX;
    q.y = this.renderQueueY;
    q.scaleX = this.renderQueueScaleX;
    q.scaleY = this.renderQueueScaleY;
    q.rotC = this.renderQueueRotC;
    q.rotS = this.renderQueueRotS;
    q.alpha = this.renderQueueAlpha;
    q.tint = this.renderQueueTint;
    q.textureId = this.renderQueueTextureId;
    q.anchorX = this.renderQueueAnchorX;
    q.anchorY = this.renderQueueAnchorY;
    q.repeatX = this.renderQueueRepeatX;
    q.repeatY = this.renderQueueRepeatY;
    q.tileMode = this.renderQueueTileMode;
    q.tileOffsetU = this.renderQueueTileOffsetU;
    q.tileOffsetV = this.renderQueueTileOffsetV;
    q.tileMulX = this.renderQueueTileMulX;
    q.tileMulY = this.renderQueueTileMulY;

    const useSortKey = !!(this.ySorting && this.renderQueueSortKey);
    const opts = this._entityUploadOpts;
    opts.space = BATCH_SPACE.WORLD;
    opts.depthMode = useSortKey ? BATCH_DEPTH.SORT_KEY : BATCH_DEPTH.INDEX;
    opts.depthDenom = this.renderQueueMaxItems;
    opts.worldHeight = this.config?.worldHeight || 10000;
    opts.sortKey = useSortKey ? this.renderQueueSortKey : null;
    opts.texLut = this._texLut;
    opts.texLutCount = this._texLutCount;
    opts.textures = this.flatTextures;
    opts.type = this.renderQueueType;
    opts.zoom = 1;
    opts.cameraX = 0;
    opts.cameraY = 0;
    opts.resolution = 1;
    opts.includeType = -1;
    opts.excludeType0 = -1;
    opts.excludeType1 = -1;
    opts.indices = null;
    opts.indexCount = 0;

    const typeArr = this.renderQueueType;
    let ne = count;
    let np = 0;
    let ng = 0;
    if (typeArr && this._rqIdxEntity) {
      const idxE = this._rqIdxEntity;
      const idxP = this._rqIdxParticle;
      const idxG = this._rqIdxGlow;
      ne = 0;
      for (let i = 0; i < count; i++) {
        const t = typeArr[i];
        if (t === 1) idxP[np++] = i;
        else if (t === 3) idxG[ng++] = i;
        else idxE[ne++] = i;
      }
      opts.indices = idxE;
      opts.indexCount = ne;
      if (this.entitiesBatch.poseInterp) {
        opts.prevX = this._latchedPrevX;
        opts.prevY = this._latchedPrevY;
        opts.snap = this._poseSnap;
      }
      this.visibleEntityCount = this.entitiesBatch.upload(q, opts);
      opts.prevX = null;
      opts.prevY = null;
      opts.snap = false;
      this.entitiesBatch.setPoseAlpha(this._poseAlpha);
      this._posePacked = true;
      opts.indices = idxP;
      opts.indexCount = np;
      this.visibleParticleCount = this.entitiesParticleBatch
        ? this.entitiesParticleBatch.upload(q, opts)
        : 0;
      if (this.entitiesGlowBatch) {
        opts.indices = idxG;
        opts.indexCount = ng;
        this.entitiesGlowBatch.upload(q, opts);
      }
      return;
    }

    opts.excludeType0 = 1;
    opts.excludeType1 = 3;
    if (this.entitiesBatch.poseInterp) {
      opts.prevX = this._latchedPrevX;
      opts.prevY = this._latchedPrevY;
      opts.snap = this._poseSnap;
    }
    this.visibleEntityCount = this.entitiesBatch.upload(q, opts);
    opts.prevX = null;
    opts.prevY = null;
    opts.snap = false;
    this.entitiesBatch.setPoseAlpha(this._poseAlpha);
    this._posePacked = true;
    opts.excludeType0 = -1;
    opts.excludeType1 = -1;
    opts.includeType = 1;
    this.visibleParticleCount = this.entitiesParticleBatch
      ? this.entitiesParticleBatch.upload(q, opts)
      : 0;
    if (this.entitiesGlowBatch) {
      opts.includeType = 3;
      this.entitiesGlowBatch.upload(q, opts);
    }
  }

  /** Resolve atlas ImageSource for instanced batches. */
  _resolveAtlasSource() {
    if (this.flatTextures) {
      for (let i = 0; i < this.flatTextures.length; i++) {
        const t = this.flatTextures[i];
        if (t?.source) return t.source;
      }
    }
    return PIXI.Texture.WHITE.source;
  }

  /**
   * Force RGBA32F LUT into a GPUTexture Pixi samples (no RENDER_ATTACHMENT).
   */
  _uploadTexLutTexture() {
    const source = this._texLutSource;
    const data = this._texLutRgba;
    if (!source || !data) return;
    if (this._useWebGpu) {
      const renderer = this.pixiApp?.renderer;
      if (!renderer?.gpu?.device) return;
      writeRgba32Float(
        renderer,
        source,
        data,
        TEX_LUT_RGBA_WIDTH,
        Math.max(1, this._texLutCount),
        'weed-tex-lut'
      );
      this._texLutNeedsGpuUpload = false;
      return;
    }
    this._uploadRgba32FloatGl(source, data, TEX_LUT_RGBA_WIDTH, Math.max(1, this._texLutCount));
    this._texLutNeedsGpuUpload = false;
  }

  _uploadRgba32FloatGl(source, data, width, height) {
    const renderer = this.pixiApp?.renderer;
    const gl = renderer?.gl;
    if (!gl || !source || !data || !renderer?.texture) return;

    source.update();

    const texSys = renderer.texture;
    if (typeof texSys.bind === 'function') {
      texSys.bind(source, 0);
    } else if (typeof texSys.bindSource === 'function') {
      texSys.bindSource(source, 0);
    }

    const glSource = typeof texSys.getGlSource === 'function' ? texSys.getGlSource(source) : null;
    const target = glSource?.target || gl.TEXTURE_2D;
    if (glSource?.texture) {
      gl.bindTexture(target, glSource.texture);
    }

    const internalFormat = gl.RGBA32F != null ? gl.RGBA32F : gl.RGBA;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (gl.UNPACK_FLIP_Y_WEBGL != null) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    if (gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL != null) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    }

    gl.texImage2D(
      target,
      0,
      internalFormat,
      width,
      height,
      0,
      gl.RGBA,
      gl.FLOAT,
      data
    );
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  _bindLutToBatches() {
    const lut = this._texLutSource;
    if (!lut) return;
    if (this.entitiesBatch) this.entitiesBatch.setLutSource(lut);
    if (this.entitiesParticleBatch) this.entitiesParticleBatch.setLutSource(lut);
    if (this.entitiesGlowBatch) this.entitiesGlowBatch.setLutSource(lut);
    if (this.shadowBatch) this.shadowBatch.setLutSource(lut);
    for (let i = 0; i < this._customLayerList.length; i++) {
      const cl = this._customLayerList[i];
      if (cl.batch) cl.batch.setLutSource(lut);
      if (cl.fillBatch) cl.fillBatch.setLutSource(lut);
    }
  }

  /** Rebuild per-textureId UV/trim/orig LUT after atlas load. */
  rebuildInstancedTextureLut() {
    const fallback = this.textures?.['_white'] || PIXI.Texture.WHITE;
    this._texLut = buildTextureLut(this.flatTextures || [], fallback);
    this._texLutCount = this.flatTextures?.length || 0;
    const rgba = packTextureLutRgba(this._texLut, Math.max(1, this._texLutCount));
    this._texLutRgba = rgba;
    this._texLutSource = PIXI.TextureSource.from({
      resource: rgba,
      width: TEX_LUT_RGBA_WIDTH,
      height: Math.max(1, this._texLutCount),
      format: 'rgba32float',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
    });
    this._texLutSource.uploadMethodId = this._useWebGpu ? 'external' : 'unknown';
    this._texLutNeedsGpuUpload = true;
    this._uploadTexLutTexture();
    const src = this._resolveAtlasSource();
    if (this.entitiesBatch) this.entitiesBatch.setAtlasSource(src);
    if (this.entitiesParticleBatch) this.entitiesParticleBatch.setAtlasSource(src);
    if (this.entitiesGlowBatch) this.entitiesGlowBatch.setAtlasSource(src);
    if (this.shadowBatch) this.shadowBatch.setAtlasSource(src);
    for (let i = 0; i < this._customLayerList.length; i++) {
      const cl = this._customLayerList[i];
      if (cl.batch) cl.batch.setAtlasSource(src);
      if (cl.fillBatch) cl.fillBatch.setAtlasSource(src);
    }
    this._bindLutToBatches();
  }

  createEntitiesInstancedBatch(maxItems) {
    // Y-order via GPU depth + sortKey (alpha discard in frag). Without depthTest,
    // transparent atlas texels still punch Z when depth is on — discard handles that.
    const useGpuYSort = !!this.ySorting;
    // Uint32: queue slot indices can exceed 65535 (Adobe piece expansion).
    this._rqIdxEntity = new Uint32Array(maxItems);
    this._rqIdxParticle = new Uint32Array(maxItems);
    this._rqIdxGlow = new Uint32Array(maxItems);
    this.entitiesBatch = new InstancedSpriteBatch({
      capacity: maxItems,
      label: 'entities-instanced',
      atlasSource: this._resolveAtlasSource(),
      lutSource: this._texLutSource,
      depthTest: useGpuYSort,
      premultiplyAlpha: true,
      useWebGpu: this._useWebGpu,
      shaders: this._engineShaders,
      poseInterp: this._queueInterp,
    });
    this.spriteMesh = this.entitiesBatch.mesh;

    // Soft particles: Y-sort depth test, no Z write, blend-only frag (no discard)
    this.entitiesParticleBatch = new InstancedSpriteBatch({
      capacity: maxItems,
      label: 'entities-particles-instanced',
      atlasSource: this._resolveAtlasSource(),
      lutSource: this._texLutSource,
      depthTest: useGpuYSort,
      depthMask: false,
      alphaDiscard: false,
      premultiplyAlpha: true,
      useWebGpu: this._useWebGpu,
      shaders: this._engineShaders,
    });
    this.spriteParticleMesh = this.entitiesParticleBatch.mesh;

    // Soft light glows (type=3) on ADD batch — normal+PMA made gray doughnuts around TallLights
    this.entitiesGlowBatch = new InstancedSpriteBatch({
      capacity: maxItems,
      label: 'entities-glow-instanced',
      atlasSource: this._resolveAtlasSource(),
      lutSource: this._texLutSource,
      depthTest: false,
      premultiplyAlpha: false,
      blendMode: 'add',
      useWebGpu: this._useWebGpu,
      shaders: this._engineShaders,
    });
    this.spriteGlowMesh = this.entitiesGlowBatch.mesh;

    // Atlas may have loaded before batch existed — bind LUT/source now
    if (this.flatTextures?.length) this.rebuildInstancedTextureLut();
    console.log(`PIXI WORKER: ENTITIES instanced batch ready (capacity ${maxItems}, particles no-Z-write, glow ADD split)`);
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   */
  update(deltaTime, dtRatio, resuming) {
    this._lastDt = deltaTime > 0 ? deltaTime / 1000 : 1 / 60;

    // ========================================
    // DOUBLE BUFFER SYNC: Select read buffer
    // ========================================
    // pixi_worker NEVER waits - always reads the latest available frame
    // If pre_render hasn't written anything new, we just re-render the same buffer
    // pre_render writes to (renderQueueFrame % 2) BEFORE incrementing, then stores sync[0]=renderQueueFrame
    // So when sync[0]=N, the data is in buffer (N-1)%2, not N%2
    let consumedNewFrame = false;
    if (this.renderQueueSync) {
      const readyFrame = Atomics.load(this.renderQueueSync, 0);

      // Only switch buffers if a new frame is available (readyFrame>0 ensures at least one frame was written)
      if (readyFrame > this.lastReadFrame && readyFrame > 0) {
        if (this._queueInterp && this.renderQueueX) {
          this._latchedPrevX = this.renderQueueX;
          this._latchedPrevY = this.renderQueueY;
          this._latchedPrevCount = this.renderQueueCount[0] | 0;
        }
        const prevReady = this.lastReadFrame;
        consumedNewFrame = true;
        const readBufferIdx = (readyFrame - 1) % 2;
        this._setReadBuffer(readBufferIdx);

        // Shadow queue uses same buffer index (swapped together)
        if (this.shadowSpritesEnabled) {
          this._setShadowReadBuffer(readBufferIdx);
        }

        // Custom layer queues also swap with the same frame
        for (let i = 0; i < this._customLayerList.length; i++) {
          const cl = this._customLayerList[i];
          if (cl.buffers) cl.readRef = cl.buffers[readBufferIdx];
        }

        // Signal that we've consumed this frame
        // This allows pre_render_worker to reuse this buffer
        this.lastReadFrame = readyFrame;
        Atomics.store(this.renderQueueSync, 1, readyFrame);
        // Wake pre_render_worker if it was waiting (it might be if >1 frame ahead)
        Atomics.notify(this.renderQueueSync, 1, 1);

        // Frame-locked camera + pose generation from the same renderQueue slot.
        if (this.renderQueueCamera) {
          this._renderZoom = this.renderQueueCamera[0];
          this._renderCameraX = this.renderQueueCamera[1];
          this._renderCameraY = this.renderQueueCamera[2];
          this._cameraInitialized = true;
        }
        this._latchPose(false, this.renderQueuePoseReady ? this.renderQueuePoseReady[0] : 0);
        this._syncComputePose();
        if (this._queueInterp) {
          const curCount = this.renderQueueCount ? this.renderQueueCount[0] | 0 : 0;
          const consecutive = prevReady > 0 && readyFrame === prevReady + 1;
          this._poseSnap = !consecutive || this._latchedPrevCount !== curCount;
          this._notePosePublish();
        }
      }
    }

    // STALE-FRAME GATING: every input to the sprite syncs and offscreen GPU
    // passes below is frame-locked to the render queue (sprite/shadow/custom
    // queues, camera snapshot, pre_render's visible-lights buffer). When no
    // new frame arrived, re-running them produces pixel-identical output, so
    // skip the work (matters when pixi outpaces pre_render, i.e. exactly when
    // the system is loaded). Fall back to per-tick behavior before the first
    // frame (keeps lightingRT/shadowRT initialized), if the queue is absent,
    // and on resume after a pause.
    if (!consumedNewFrame && this._queueInterp && this._posePacked && this.entitiesBatch) {
      this._tickPoseAlpha();
      this.entitiesBatch.setPoseAlpha(this._poseAlpha);
    }

    const runFrameLockedPasses =
      consumedNewFrame || resuming || this.lastReadFrame <= 0 || !this.renderQueueSync;

    // Reset subtimers every frame (stale-gated frames keep zeros for skipped work)
    this.lightsTimeThisFrame = 0;
    this.shadowsTimeThisFrame = 0;
    this.spritesTimeThisFrame = 0;
    this.customLayersTimeThisFrame = 0;
    this.miscTimeThisFrame = 0;
    this._decalTilesDirtyThisFrame = 0;
    this._decalTilesUploadedThisFrame = 0;
    this._meshFillInstancesThisFrame = 0;
    this._meshRtDrawsThisFrame = 0;

    const detail = this.collectDetailedStats;
    let t0 = 0;
    if (detail) t0 = performance.now();

    // Camera is always provided by the pre-render worker via renderQueueCamera.
    // Fall back to live SAB only during the very first frames before init completes.
    if (!this._cameraInitialized && this.cameraData) {
      this._renderZoom = this.cameraData[0];
      this._renderCameraX = this.cameraData[1];
      this._renderCameraY = this.cameraData[2];
      this._cameraInitialized = true;
    }

    this.updateCameraTransform();

    // Sync mutable layer properties from SAB (cross-worker writes via Atomics)
    if (Layer._alphaDirty) {
      for (let i = 0; i < Layer.count; i++) {
        if (Atomics.load(Layer._alphaDirty, i) === 1) {
          Atomics.store(Layer._alphaDirty, i, 0);
          const name = Layer.getName(i);
          const displayObj = name ? this._layerRuntime[name] : null;
          if (displayObj) displayObj.alpha = Layer._alpha[i];
        }
      }
    }

    // Update blood decal splat tiles (dirty flags from particle_worker)
    // Not frame-locked: driven by particle_worker dirty flags, so always poll.
    this.updateDecalTiles();

    if (detail) this.miscTimeThisFrame = performance.now() - t0;

    if (runFrameLockedPasses) {
      if (this._texLutNeedsGpuUpload) this._uploadTexLutTexture();
      // Pre-compute visible lights once (shared by updateLighting, updateShadowSprites)
      if (detail) t0 = performance.now();
      this.computeVisibleLights();
      this.updateLighting();
      if (detail) this.lightsTimeThisFrame = performance.now() - t0;

      // Update shadow RenderTexture with interleaved lights + shadows
      if (detail) t0 = performance.now();
      this.updateShadowSprites();
      if (detail) this.shadowsTimeThisFrame = performance.now() - t0;

      // Use render queue from pre_render_worker - no fallback
      if (detail) t0 = performance.now();
      this.updateSpritesFromRenderQueue();
      if (detail) this.spritesTimeThisFrame = performance.now() - t0;

      // Update custom layer sprites and render shader layers to their RenderTextures
      if (detail) t0 = performance.now();
      this.updateCustomLayers();
      if (detail) this.customLayersTimeThisFrame = performance.now() - t0;

      // ========================================
      // LOW-RES OFF-SCREEN RENDERING
      // ========================================
      // Render lighting to lower-resolution texture if configured.
      // This significantly improves performance on GPU-bound systems.
      if (detail) t0 = performance.now();
      if (this._visPolyEnabled) {
        // Raycasted lighting: render visibility polygon meshes
        this.renderVisibilityLighting();
      } else if (this.lightingRT && this.lightingMesh && layerIsVisible(Layer.lighting?.id)) {
        // Standard lighting: render full-screen shader
        const rtOpts = this._rtRenderOpts;
        rtOpts.transform = null;
        rtOpts.container = this.lightingMesh;
        rtOpts.target = this.lightingRT;
        rtOpts.clear = true;
        rtOpts.clearColor = this._clearTransparent;
        this.pixiApp.renderer.render(rtOpts);
        this._renderLiquidFunLightingField();
      }
      if (detail) this.lightsTimeThisFrame += performance.now() - t0;
    }

    this._applyLayerVisibility();
  }

  /**
   * Setup PIXI ticker to call gameLoop (custom scheduler implementation)
   */
  onCustomSchedulerStart() {
    if (this.fixedFps > 0 || this.noLimitFPS) {
      // Bypass PIXI ticker — use AbstractWorker scheduleNextFrame (interval / uncapped / RAF)
      this.usesCustomScheduler = false;
      this.scheduleNextFrame();
    } else {
      // Standard mode: PIXI ticker will call gameLoop on every tick (60fps)
      this.pixiApp.ticker.add(() => this.gameLoop());
    }
  }

  afterManualStep() {
    const app = this.pixiApp;
    if (!app?.renderer || !app.stage) return;
    if (app.ticker) {
      app.ticker.autoStart = false;
      app.ticker.stop();
    }
    app.renderer.render(app.stage);
  }

  /**
   * Create sprites for each blood decal splat tile (SAB tiles, not TileMap background)
   * Each tile is a Sprite with an initially transparent texture
   * Textures are updated when particle_worker marks tiles as dirty
   */
  createDecalTileSprites() {
    const tileSize = this.decalsTileSize;
    const tilePixelSize = this.decalsTilePixelSize;

    // Create a single shared OffscreenCanvas for synchronous bitmap generation
    // Reused for all tiles - transferToImageBitmap is sync and zero-copy
    this._decalTileCanvas = new OffscreenCanvas(tilePixelSize, tilePixelSize);
    this._decalTileCtx = this._decalTileCanvas.getContext('2d', { willReadFrequently: true });

    for (let ty = 0; ty < this.decalsTilesY; ty++) {
      for (let tx = 0; tx < this.decalsTilesX; tx++) {
        const tileIndex = tx + ty * this.decalsTilesX;

        // Create an initially transparent texture for this tile
        // We'll update the texture source when the tile becomes dirty
        const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
        sprite.x = tx * tileSize;
        sprite.y = ty * tileSize;
        sprite.width = tileSize;
        sprite.height = tileSize;
        sprite.visible = false; // Hidden until first decal splat

        this.decalTileSprites[tileIndex] = sprite;
        this.decalTileTextureSources[tileIndex] = null; // Created on first update
        this.decalTileContainer.addChild(sprite);
      }
    }

    console.log(`PIXI WORKER: Created ${this.decalsTotalTiles} decal tile sprites`);
  }

  /**
   * Update decal tile textures for any dirty tiles
   * Called each frame to check for tiles modified by particle_worker
   * Uses synchronous transferToImageBitmap for zero-allocation texture updates
   * Optimized to reuse buffers, ImageData, and textures to reduce GC pressure
   */
  updateDecalTiles() {
    if (!this.decalsEnabled) return;

    // Use pixel size for buffer operations (not world tile size)
    const tilePixelSize = this.decalsTilePixelSize;
    const bytesPerTile = tilePixelSize * tilePixelSize * 4;
    const ctx = this._decalTileCtx;
    const totalTiles = this.decalsTotalTiles;
    if (totalTiles <= 0) return;

    const maxUploads = Math.min(this.maxDecalTileUploadsPerFrame || totalTiles, totalTiles);
    let dirtyN = 0;
    for (let i = 0; i < totalTiles; i++) {
      if (this.decalsTilesDirty[i]) dirtyN++;
    }
    this._decalTilesDirtyThisFrame = dirtyN;
    let processed = 0;
    let scanned = 0;
    let tileIndex = this._nextDecalTileScanIndex % totalTiles;

    while (scanned < totalTiles && processed < maxUploads) {
      // Check if this tile was modified by particle_worker
      if (this.decalsTilesDirty[tileIndex] === 0) {
        tileIndex = (tileIndex + 1) % totalTiles;
        scanned++;
        continue;
      }

      // Clear dirty flag immediately (particle_worker may set it again)
      this.decalsTilesDirty[tileIndex] = 0;

      // Get the RGBA data for this tile from SharedArrayBuffer
      const tileByteOffset = tileIndex * bytesPerTile;
      const tileRGBAShared = new Uint8ClampedArray(
        this.decalsTilesRGBA.buffer,
        tileByteOffset,
        bytesPerTile
      );

      // Reuse pre-allocated buffer and ImageData if available
      let tileRGBA = this._decalCopyBuffers?.[tileIndex];
      let imageData = this._decalImageDatas?.[tileIndex];

      if (!tileRGBA) {
        // Lazy init on first use - allocate once per tile, reuse forever
        this._decalCopyBuffers ??= [];
        this._decalImageDatas ??= [];
        tileRGBA = new Uint8ClampedArray(bytesPerTile);
        imageData = new ImageData(tileRGBA, tilePixelSize, tilePixelSize);
        this._decalCopyBuffers[tileIndex] = tileRGBA;
        this._decalImageDatas[tileIndex] = imageData;
      }

      // Copy data into reusable buffer
      tileRGBA.set(tileRGBAShared);

      // Synchronous bitmap creation via OffscreenCanvas - no promises, no closures
      // putImageData + transferToImageBitmap is sync and zero-copy
      ctx.putImageData(imageData, 0, 0);
      const bitmap = this._decalTileCanvas.transferToImageBitmap();

      const sprite = this.decalTileSprites[tileIndex];

      // Close old bitmap to release GPU memory immediately (avoid GC delay)
      const oldBitmap = sprite.texture?.source?.resource;
      if (oldBitmap?.close) oldBitmap.close();

      // Reuse existing texture source instead of creating new ones
      if (sprite.texture !== PIXI.Texture.EMPTY && sprite.texture.source) {
        sprite.texture.source.resource = bitmap;
        sprite.texture.source.update();
      } else {
        const source = new PIXI.ImageSource({ resource: bitmap });
        sprite.texture = new PIXI.Texture({ source });
      }
      sprite.visible = true; // Show the tile now that it has content

      processed++;
      tileIndex = (tileIndex + 1) % totalTiles;
      scanned++;
    }

    this._nextDecalTileScanIndex = tileIndex;
    this._decalTilesUploadedThisFrame = processed;
  }

  /* =====================
LIGHTING SYSTEM SETUP
===================== */

  createLightingSystem() {
    const geometry = new PIXI.Geometry({
      attributes: {
        aPosition: [-1, -1, 1, -1, 1, 1, -1, 1],
      },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });

    const maxLights = this.maxLights;

    this._lightDataFloats = new Float32Array(lightDataTextureFloatCount(maxLights));
    this._lightDataSource = PIXI.TextureSource.from({
      resource: this._lightDataFloats,
      width: maxLights,
      height: LIGHT_DATA_TEX_HEIGHT,
      format: 'rgba32float',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
    });
    this._lightDataSource.uploadMethodId = this._useWebGpu ? 'external' : 'unknown';

    const lightingResources = {
      uLightData: this._lightDataSource,
      uniforms: {
        uCameraPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
        uZoom: { value: 1.0, type: 'f32' },
        uViewport: {
          value: new Float32Array([
            this.canvasWidth * this.lightingResolution,
            this.canvasHeight * this.lightingResolution,
          ]),
          type: 'vec2<f32>',
        },
        uFullCanvasSize: {
          value: new Float32Array([this.canvasWidth, this.canvasHeight]),
          type: 'vec2<f32>',
        },
        uInvResolution: { value: 1.0 / this.lightingResolution, type: 'f32' },
        uLightTexWidth: { value: maxLights, type: 'f32' },
        uLightCount: { value: 0, type: 'i32' },
        uBaseAmbient: { value: this.baseAmbient, type: 'f32' },
        uSunIntensity: { value: 0, type: 'f32' },
        uSunR: { value: 1.0, type: 'f32' },
        uSunG: { value: 1.0, type: 'f32' },
        uSunB: { value: 1.0, type: 'f32' },
      },
    };

    const lightingSrc = (this._engineShaders?.lightingFrag || '').replace(
      /MAX_LIGHTS/g,
      String(this.maxLights | 0 || 64)
    );
    if (this._useWebGpu) {
      if (!lightingSrc) {
        throw new Error('WeedJS: Failed to compile look shader "lighting_basic" for layer "LIGHTING" on WebGPU: lighting_basic.wgsl is missing.');
      }
      const gpuProgram = lightingGpuProgram(GpuProgram, lightingSrc, 'lighting-basic');
      this.lightingShader = new PIXI.Shader({ gpuProgram, resources: lightingResources });
    } else {
      if (!lightingSrc) {
        throw new Error('WeedJS: Failed to compile look shader "lighting_basic" for layer "LIGHTING" on WebGL: lighting_basic.frag.glsl is missing.');
      }
      const glProgram = new PIXI.GlProgram({
        vertex: `
  in vec2 aPosition;
  void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  }
  `,
        fragment: lightingSrc,
      });
      this.lightingShader = new PIXI.Shader({ glProgram, resources: lightingResources });
    }

    this.lightingMesh = new PIXI.Mesh({
      geometry,
      shader: this.lightingShader,
    });

    // Low-res lighting, or LiquidFun field splat, needs an RT target.
    const needRt = this.lightingResolution < 1.0 || this.liquidFunMaxCount > 0;
    if (needRt) {
      this.lightingRT = PIXI.RenderTexture.create({
        width: this.canvasWidth * this.lightingResolution,
        height: this.canvasHeight * this.lightingResolution,
      });
      this.lightingDisplaySprite = new PIXI.Sprite(this.lightingRT);
      this.lightingDisplaySprite.anchor.set(0, 0); // Ensure top-left anchor
      this.lightingDisplaySprite.position.set(0, 0); // Position at top-left of screen
      this.lightingDisplaySprite.scale.set(1.0 / this.lightingResolution);
      this._registerLayerDisplayObject('lighting', this.lightingDisplaySprite);
      this.pixiApp.stage.addChild(this.lightingDisplaySprite);

      console.log(
        `PIXI WORKER: Lighting RenderTexture created (${this.lightingRT.width}x${this.lightingRT.height})`
      );
    } else {
      this._registerLayerDisplayObject('lighting', this.lightingMesh);
      this.pixiApp.stage.addChild(this.lightingMesh);
    }
  }

  _createLiquidFunLightSplat(lfMax) {
    const cap = lfMax | 0;
    if (cap <= 0) return;
    const shaders = this._useWebGpu
      ? { lfSplat: this._engineShaders.lfLightSplat }
      : {
        lfSplatVert: this._engineShaders.lfLightSplatVert,
        lfSplatFrag: this._engineShaders.lfLightSplatFrag,
      };
    if (this._useWebGpu && !shaders.lfSplat) return;
    if (!this._useWebGpu && (!shaders.lfSplatVert || !shaders.lfSplatFrag)) return;
    this._lfLightSplat = new LiquidFunDensitySplat({
      capacity: Math.max(1, cap),
      label: 'lf-light-splat',
      blendMode: 'add',
      useWebGpu: this._useWebGpu,
      shaders,
      shaderResources: {
        uniforms: {
          uInvScreenScale: { value: 1.0, type: 'f32' },
        },
      },
    });
    this._lfLightSplat.mesh.blendMode = 'add';
  }

  _renderLiquidFunLightingField() {
    const splat = this._lfLightSplat;
    if (!splat || !this.lightingRT || this._visPolyEnabled) return;
    const views = LiquidFun.getViews();
    const groups = LiquidFun.getGroupViews();
    const o = this._lfLightOpts;
    o.zoom = this._renderZoom;
    o.cameraX = this._renderCameraX;
    o.cameraY = this._renderCameraY;
    o.resolution = this.lightingResolution;
    o.canvasW = this.canvasWidth;
    o.canvasH = this.canvasHeight;
    const packed = splat.uploadLitGroups(views, groups, o);
    if (packed <= 0) return;
    const screenScale = (this._renderZoom || 1) * (this.lightingResolution || 1);
    const u = splat.shader?.resources?.uniforms?.uniforms;
    if (u) u.uInvScreenScale = screenScale > 0 ? 1 / screenScale : 0;
    const rtOpts = this._rtRenderOptsNoClear;
    rtOpts.container = splat.mesh;
    rtOpts.target = this.lightingRT;
    this.pixiApp.renderer.render(rtOpts);
  }

  /* =====================
RAYCASTED LIGHT OCCLUSION (visibility polygon system)
===================== */

  /**
   * Initialize the visibility polygon rendering system.
   * Creates a Container, RenderTexture, and display sprite for rendering
   * light visibility polygons with additive blending.
   */
  initVisibilityPolygonSystem(vpConfig) {
    this._visPolyEnabled = true;
    this._visPolyMaxVerts = vpConfig.maxPolygonVertices;
    this._visPolyMaxLights = vpConfig.maxLights;
    this._visPolySlotBytes = 16 + this._visPolyMaxVerts * 8;

    const sabs = [vpConfig.dataA, vpConfig.dataB];
    for (let b = 0; b < 2; b++) {
      this._visPolyBuffers[b] = {
        header: new Int32Array(sabs[b], 0, 1),
        i32: new Int32Array(sabs[b]),
        f32: new Float32Array(sabs[b]),
      };
    }

    // Self-lit queue (collider / sprite fill under occluders)
    // Layout: entityIdx, lightIdx, x,y,rotC,rotS, texId, maskMode, pad = 28
    this._selfLitItemBytes = 28;
    const selfLitSabs = [vpConfig.selfLitDataA, vpConfig.selfLitDataB];
    if (selfLitSabs[0] && selfLitSabs[1]) {
      for (let b = 0; b < 2; b++) {
        const sab = selfLitSabs[b];
        this._selfLitBuffers[b] = {
          header: new Int32Array(sab, 0, 1),
          i32: new Int32Array(sab),
          f32: new Float32Array(sab),
          u16: new Uint16Array(sab),
          u8: new Uint8Array(sab),
        };
      }
    }

    // Container for all light meshes (additive blend)
    this._visPolyContainer = new PIXI.Container();
    this._selfLitContainer = new PIXI.Container();

    // RenderTexture for the visibility-polygon lighting
    const res = this.lightingResolution || 1.0;
    const rtW = Math.max(1, Math.floor(this.canvasWidth * res));
    const rtH = Math.max(1, Math.floor(this.canvasHeight * res));
    this._visPolyRT = PIXI.RenderTexture.create({ width: rtW, height: rtH });

    // Display sprite with multiply blend (same as existing LIGHTING layer)
    this._visPolyDisplaySprite = new PIXI.Sprite(this._visPolyRT);
    this._visPolyDisplaySprite.anchor.set(0, 0);
    this._visPolyDisplaySprite.position.set(0, 0);
    this._visPolyDisplaySprite.scale.set(1.0 / res);

    // Replace the existing lighting display on the LIGHTING layer
    if (this.lightingDisplaySprite) {
      this.pixiApp.stage.removeChild(this.lightingDisplaySprite);
    } else if (this.lightingMesh) {
      this.pixiApp.stage.removeChild(this.lightingMesh);
    }
    this._registerLayerDisplayObject('lighting', this._visPolyDisplaySprite);
    this.pixiApp.stage.addChild(this._visPolyDisplaySprite);

    // Visibility polygons already do attenuation + occlusion. CASTED_SHADOWS
    // light cookies multiply on top and crush umbra to pitch black (cookies clear
    // to black outside the gradient; soft shadow sprites used ~0.33 alpha).
    if (this.shadowDisplaySprite) {
      this.shadowDisplaySprite.visible = false;
    }
    this.shadowSpritesEnabled = false;

    const visPolyUniforms = {
      uniforms: {
        uCameraPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
        uZoom: { value: 1.0, type: 'f32' },
        uCanvasSize: { value: new Float32Array([this.canvasWidth, this.canvasHeight]), type: 'vec2<f32>' },
        uLightPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
        uLightIntensity: { value: 1000, type: 'f32' },
        uLightRadius: { value: 1e6, type: 'f32' },
        uLightColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
      },
    };

    if (this._useWebGpu) {
      this._visPolyProgramOpts = { gpuProgram: gpuFromWgsl(this._visPolyWgsl, 'visibility-polygon') };
      if (this._selfLitSpriteWgsl) {
        this._selfLitSpriteProgramOpts = {
          gpuProgram: gpuFromWgsl(this._selfLitSpriteWgsl, 'occluder-self-lit-sprite'),
        };
      }
    } else {
      this._visPolyProgramOpts = {
        glProgram: new PIXI.GlProgram({
          vertex: this._visPolyVertexShader,
          fragment: this._visPolyFragmentShader,
        }),
      };
      if (this._selfLitSpriteVertShader && this._selfLitSpriteFragShader) {
        this._selfLitSpriteProgramOpts = {
          glProgram: new PIXI.GlProgram({
            vertex: this._selfLitSpriteVertShader,
            fragment: this._selfLitSpriteFragShader,
          }),
        };
      }
    }

    // Collider self-lit reuses vis-poly program (attenuation, no texture)
    {
      const maxFillVerts = 256 * 20;
      this._selfLitMaxFillVerts = maxFillVerts;
      const geometry = new PIXI.Geometry({
        attributes: { aPosition: { buffer: new Float32Array(maxFillVerts * 2), size: 2 } },
        indexBuffer: new Uint16Array(maxFillVerts * 3),
      });
      const shader = new PIXI.Shader({
        ...this._visPolyProgramOpts,
        resources: visPolyUniforms,
      });
      const mesh = new PIXI.Mesh({ geometry, shader });
      mesh.blendMode = 'add';
      this._selfLitColliderMesh = { mesh, geometry, shader };
    }

    console.log(`PIXI WORKER: Visibility polygon system initialized (${this._visPolyMaxLights} lights, ${this._visPolyMaxVerts} verts, RT: ${rtW}x${rtH})`);
  }

  /**
   * Get or create a PIXI.Mesh for rendering a light's visibility polygon.
   * Meshes are pooled and reused across frames.
   */
  _getVisPolyMesh(index) {
    if (this._visPolyMeshes[index]) return this._visPolyMeshes[index];

    const geometry = new PIXI.Geometry({
      attributes: { aPosition: { buffer: new Float32Array((this._visPolyMaxVerts + 1) * 2), size: 2 } },
      indexBuffer: new Uint16Array(this._visPolyMaxVerts * 3),
    });

    const shader = new PIXI.Shader({
      ...this._visPolyProgramOpts,
      resources: {
        uniforms: {
          uCameraPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uZoom: { value: 1.0, type: 'f32' },
          uCanvasSize: { value: new Float32Array([this.canvasWidth, this.canvasHeight]), type: 'vec2<f32>' },
          uLightPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uLightIntensity: { value: 1000, type: 'f32' },
          uLightRadius: { value: 1e6, type: 'f32' },
          uLightColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
        },
      },
    });

    const mesh = new PIXI.Mesh({ geometry, shader });
    mesh.blendMode = 'add';

    this._visPolyMeshes[index] = { mesh, geometry, shader };
    return this._visPolyMeshes[index];
  }

  /**
   * Render visibility polygon meshes for all visible lights.
   * Reads polygon data from the SAB, builds triangle-fan meshes,
   * renders to the visibility RT with additive blending over an ambient base.
   */
  renderVisibilityLighting() {
    if (!this._visPolyEnabled) return;

    const syncFrame = this.renderQueueSync ? Atomics.load(this.renderQueueSync, 0) : 0;
    const readBufferIdx = syncFrame > 0 ? (syncFrame - 1) % 2 : 0;
    const buf = this._visPolyBuffers[readBufferIdx];
    if (!buf) return;

    const lightCount = buf.header[0];
    const i32 = buf.i32;
    const f32 = buf.f32;
    const maxVerts = this._visPolyMaxVerts;
    const slotBytes = this._visPolySlotBytes;
    const res = this.lightingResolution || 1.0;
    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;

    const container = this._visPolyContainer;
    container.removeChildren();

    // LightEmitter data for color
    const lightColor = LightEmitter.lightColor;
    const lightIntensityArr = LightEmitter.lightIntensity;
    const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;
    const lightHeight = LightEmitter.height;

    const rgb = this._rgbResult;

    for (let li = 0; li < lightCount; li++) {
      const baseIndex = (4 + li * slotBytes) >> 2;
      const lightIdx = i32[baseIndex];
      const lx = f32[baseIndex + 1];
      const ly = f32[baseIndex + 2];
      const vertCount = i32[baseIndex + 3];

      if (vertCount < 3) continue;

      const xStart = baseIndex + 4;
      const yStart = xStart + maxVerts;

      // Get or create mesh for this light
      const { mesh, geometry, shader } = this._getVisPolyMesh(li);

      // Build triangle fan: center = light position, fan around polygon vertices
      const posBuffer = geometry.attributes.aPosition.buffer;
      const positions = posBuffer.data;
      const indexBuffer = geometry.indexBuffer;
      const indices = indexBuffer.data;

      // Vertex 0 = light center
      positions[0] = lx;
      positions[1] = ly - (lightHeight[lightIdx] || 0);

      // Vertices 1..vertCount = polygon boundary
      for (let v = 0; v < vertCount; v++) {
        positions[(v + 1) * 2] = f32[xStart + v];
        positions[(v + 1) * 2 + 1] = f32[yStart + v];
      }

      // Triangle fan indices: (0, v, v+1) for each consecutive boundary pair
      let iCount = 0;
      for (let v = 1; v < vertCount; v++) {
        indices[iCount++] = 0;
        indices[iCount++] = v;
        indices[iCount++] = v + 1;
      }
      // Close the fan: last boundary vertex connects back to first
      indices[iCount++] = 0;
      indices[iCount++] = vertCount;
      indices[iCount++] = 1;

      // Zero remaining indices (degenerate triangles, no visible fragments)
      for (let j = iCount; j < indices.length; j++) indices[j] = 0;

      // Push updated data to GPU
      posBuffer.update();
      indexBuffer.update();

      // Update shader uniforms
      const uniforms = shader.resources.uniforms.uniforms;
      uniforms.uCameraPos[0] = cameraX;
      uniforms.uCameraPos[1] = cameraY;
      uniforms.uZoom = zoom;
      uniforms.uCanvasSize[0] = this.canvasWidth;
      uniforms.uCanvasSize[1] = this.canvasHeight;
      uniforms.uLightPos[0] = lx;
      uniforms.uLightPos[1] = ly - (lightHeight[lightIdx] || 0);
      uniforms.uLightIntensity = lightIntensityArr[lightIdx];
      uniforms.uLightRadius = lightInfluenceRadius(sqrtLightIntensity[lightIdx]);

      extractRGBNormalizedMut(lightColor[lightIdx], rgb);
      uniforms.uLightColor[0] = rgb.r;
      uniforms.uLightColor[1] = rgb.g;
      uniforms.uLightColor[2] = rgb.b;

      container.addChild(mesh);
    }

    // Render to the visibility RT
    // Clear with base ambient + sun (same as what the full-screen shader starts with)
    const sunIntensity = (Sun.isInitialized && Sun.enabled) ? Sun.intensity : 0;
    const ambient = this.baseAmbient + sunIntensity;
    const clampedAmbient = Math.min(ambient, 1.0);

    this.pixiApp.renderer.render({
      container,
      target: this._visPolyRT,
      clear: true,
      clearColor: [clampedAmbient, clampedAmbient, clampedAmbient, 1.0],
    });

    // Restore unoccluded light under occluder footprints (no self-darken)
    this._renderOccluderSelfLit(readBufferIdx);
  }

  /**
   * ADD unoccluded light attenuation into the lighting RT under each occluder.
   * Default: Collider footprint. maskMode=sprite: sprite alpha mask.
   */
  _renderOccluderSelfLit(readBufferIdx) {
    const buf = this._selfLitBuffers[readBufferIdx];
    if (!buf || !this._visPolyRT || !LightOccluder.active || !Collider.active) return;

    const count = buf.header[0] | 0;
    if (count <= 0) return;

    const i32 = buf.i32;
    const f32 = buf.f32;
    const u16 = buf.u16;
    const u8 = buf.u8;
    const itemBytes = this._selfLitItemBytes;
    const lightIntensityArr = LightEmitter.lightIntensity;
    const lightColor = LightEmitter.lightColor;
    const lightHeight = LightEmitter.height;
    const rgb = this._rgbResult;
    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;

    // Process contiguous runs sharing the same lightIdx (collector writes per-light)
    let i = 0;
    while (i < count) {
      const byte0 = 4 + i * itemBytes;
      const lightIdx = i32[(byte0 >> 2) + 1];
      let j = i + 1;
      while (j < count) {
        const b = 4 + j * itemBytes;
        if (i32[(b >> 2) + 1] !== lightIdx) break;
        j++;
      }

      // Light center: baked into visibility poly; here Transform is fine (lights rarely have RB)
      const lx = Transform.x[lightIdx];
      const ly = Transform.y[lightIdx] - (lightHeight[lightIdx] || 0);
      const intensity = lightIntensityArr[lightIdx];
      extractRGBNormalizedMut(lightColor[lightIdx], rgb);

      // --- Collider fills for this light (batched) ---
      let vertCount = 0;
      let idxCount = 0;
      const colliderEntry = this._selfLitColliderMesh;
      if (!colliderEntry) { i = j; continue; }
      const posBuf = colliderEntry.geometry.attributes.aPosition.buffer;
      const idxBuf = colliderEntry.geometry.indexBuffer;
      const positions = posBuf.data;
      const indices = idxBuf.data;
      const maxVerts = this._selfLitMaxFillVerts;
      const segs = this._selfLitCircleSegs;
      const boxX = this._selfLitBoxScratchX;
      const boxY = this._selfLitBoxScratchY;

      for (let e = i; e < j; e++) {
        const byteOff = 4 + e * itemBytes;
        const maskMode = u8[byteOff + 26];
        if (maskMode === LIGHT_OCCLUDER_MASK_SPRITE) continue;

        const i32Off = byteOff >> 2;
        const entityIdx = i32[i32Off];
        if (!Transform.active[entityIdx] || !Collider.active[entityIdx]) continue;

        const shape = Collider.shapeType[entityIdx];
        const ox = Collider.offsetX[entityIdx] || 0;
        const oy = Collider.offsetY[entityIdx] || 0;
        // Baked display pose from pre_render (same as sprite / umbra)
        const ex = f32[i32Off + 2];
        const ey = f32[i32Off + 3];
        const c = f32[i32Off + 4];
        const s = f32[i32Off + 5];

        if (shape === ShapeType.Circle) {
          const r = Collider.radius[entityIdx];
          if (!(r > 0)) continue;
          const cx = ex + ox;
          const cy = ey + oy;
          if (vertCount + segs + 1 > maxVerts) break;
          const center = vertCount;
          positions[vertCount * 2] = cx;
          positions[vertCount * 2 + 1] = cy;
          vertCount++;
          for (let si = 0; si < segs; si++) {
            const a = (si / segs) * Math.PI * 2;
            positions[vertCount * 2] = cx + Math.cos(a) * r;
            positions[vertCount * 2 + 1] = cy + Math.sin(a) * r;
            vertCount++;
          }
          for (let si = 0; si < segs; si++) {
            indices[idxCount++] = center;
            indices[idxCount++] = center + 1 + si;
            indices[idxCount++] = center + 1 + ((si + 1) % segs);
          }
        } else {
          let vc = 0;
          if (shape === ShapeType.Box) {
            const w = Collider.width[entityIdx];
            const h = Collider.height[entityIdx];
            if (!(w > 0) || !(h > 0)) continue;
            writeOrientedBoxVerts(boxX, boxY, 0, ex, ey, w, h, c, s, ox, oy);
            vc = 4;
          } else {
            const pc = Collider.polyCount[entityIdx] | 0;
            if (pc >= 3) {
              const base = entityIdx * MAX_POLYGON_VERTICES;
              writePolygonVerts(
                boxX, boxY, 0, ex, ey, c, s, ox, oy,
                Collider.polyVertexX, Collider.polyVertexY, base, pc
              );
              vc = pc;
            } else {
              const w = Collider.width[entityIdx];
              const h = Collider.height[entityIdx];
              if (!(w > 0) || !(h > 0)) continue;
              writeOrientedBoxVerts(boxX, boxY, 0, ex, ey, w, h, c, s, ox, oy);
              vc = 4;
            }
          }
          if (vertCount + vc > maxVerts) break;
          const baseV = vertCount;
          for (let v = 0; v < vc; v++) {
            positions[vertCount * 2] = boxX[v];
            positions[vertCount * 2 + 1] = boxY[v];
            vertCount++;
          }
          for (let v = 1; v < vc - 1; v++) {
            indices[idxCount++] = baseV;
            indices[idxCount++] = baseV + v;
            indices[idxCount++] = baseV + v + 1;
          }
        }
      }

      if (idxCount > 0 && this._selfLitColliderMesh) {
        const { mesh, geometry, shader } = this._selfLitColliderMesh;
        const prevIdx = this._selfLitLastIdxCount || 0;
        for (let k = idxCount; k < prevIdx; k++) indices[k] = 0;
        this._selfLitLastIdxCount = idxCount;

        posBuf.update();
        idxBuf.update();

        const uniforms = shader.resources.uniforms.uniforms;
        uniforms.uCameraPos[0] = cameraX;
        uniforms.uCameraPos[1] = cameraY;
        uniforms.uZoom = zoom;
        uniforms.uCanvasSize[0] = this.canvasWidth;
        uniforms.uCanvasSize[1] = this.canvasHeight;
        uniforms.uLightPos[0] = lx;
        uniforms.uLightPos[1] = ly;
        uniforms.uLightIntensity = intensity;
        uniforms.uLightRadius = lightInfluenceRadius(
          LightEmitter.sqrtLightIntensity ? LightEmitter.sqrtLightIntensity[lightIdx] : 0
        );
        uniforms.uLightColor[0] = rgb.r;
        uniforms.uLightColor[1] = rgb.g;
        uniforms.uLightColor[2] = rgb.b;

        const container = this._selfLitContainer;
        container.removeChildren();
        container.addChild(mesh);

        this.pixiApp.renderer.render({
          container,
          target: this._visPolyRT,
          clear: false,
        });
      }

      // --- Sprite mask fills for this light ---
      if (this._selfLitSpriteProgramOpts) {
        let spriteMeshIdx = 0;
        const container = this._selfLitContainer;
        container.removeChildren();

        for (let e = i; e < j; e++) {
          const byteOff = 4 + e * itemBytes;
          const maskMode = u8[byteOff + 26];
          if (maskMode !== LIGHT_OCCLUDER_MASK_SPRITE) continue;

          const i32Off = byteOff >> 2;
          const entityIdx = i32[i32Off];
          const texId = u16[(byteOff >> 1) + 12];
          if (texId === 0xFFFF || !this.flatTextures || !this.flatTextures[texId]) continue;
          if (!Transform.active[entityIdx] || !SpriteRenderer.active?.[entityIdx]) continue;

          const tex = this.flatTextures[texId];
          const entry = this._getSelfLitSpriteMesh(spriteMeshIdx++, tex);
          if (!entry) continue;

          const { mesh, geometry, shader } = entry;
          const ox = f32[i32Off + 2];
          const oy = f32[i32Off + 3];
          const sx = SpriteRenderer.scaleX[entityIdx];
          const sy = SpriteRenderer.scaleY[entityIdx];
          const ax = SpriteRenderer.anchorX[entityIdx];
          const ay = SpriteRenderer.anchorY[entityIdx];
          const inherit = SpriteRenderer.inheritTransformRotation[entityIdx];
          let c, s;
          if (inherit) {
            c = f32[i32Off + 4];
            s = f32[i32Off + 5];
          } else {
            c = SpriteRenderer.spriteRotC[entityIdx];
            s = SpriteRenderer.spriteRotS[entityIdx];
          }

          const orig = tex.orig;
          const ow = (orig && orig.width) || tex.width || 0;
          const oh = (orig && orig.height) || tex.height || 0;
          const hw = ow * sx;
          const hh = oh * sy;

          // Local corners relative to anchor, then rotate+translate
          const x0 = -ax * hw;
          const y0 = -ay * hh;
          const x1 = (1 - ax) * hw;
          const y1 = (1 - ay) * hh;
          const corners = [
            x0, y0,
            x1, y0,
            x1, y1,
            x0, y1,
          ];
          const uvs = tex.uvs || { x0: 0, y0: 0, x1: 1, y1: 0, x2: 1, y2: 1, x3: 0, y3: 1 };
          const uvArr = [
            uvs.x0, uvs.y0,
            uvs.x1 !== undefined ? uvs.x1 : uvs.x2, uvs.y0,
            uvs.x2, uvs.y2,
            uvs.x3 !== undefined ? uvs.x3 : uvs.x0, uvs.y3 !== undefined ? uvs.y3 : uvs.y2,
          ];

          const posBuf = geometry.attributes.aPosition.buffer;
          const uvBuf = geometry.attributes.aUV.buffer;
          const pos = posBuf.data;
          const uv = uvBuf.data;
          for (let v = 0; v < 4; v++) {
            const lxocal = corners[v * 2];
            const lyocal = corners[v * 2 + 1];
            pos[v * 2] = ox + c * lxocal - s * lyocal;
            pos[v * 2 + 1] = oy + s * lxocal + c * lyocal;
            uv[v * 2] = uvArr[v * 2];
            uv[v * 2 + 1] = uvArr[v * 2 + 1];
          }
          posBuf.update();
          uvBuf.update();

          const uniforms = shader.resources.uniforms.uniforms;
          uniforms.uCameraPos[0] = cameraX;
          uniforms.uCameraPos[1] = cameraY;
          uniforms.uZoom = zoom;
          uniforms.uCanvasSize[0] = this.canvasWidth;
          uniforms.uCanvasSize[1] = this.canvasHeight;
          uniforms.uLightPos[0] = lx;
          uniforms.uLightPos[1] = ly;
          uniforms.uLightIntensity = intensity;
          uniforms.uLightColor[0] = rgb.r;
          uniforms.uLightColor[1] = rgb.g;
          uniforms.uLightColor[2] = rgb.b;

          container.addChild(mesh);
        }

        if (container.children.length > 0) {
          this.pixiApp.renderer.render({
            container,
            target: this._visPolyRT,
            clear: false,
          });
        }
      }

      i = j;
    }
  }

  _getSelfLitSpriteMesh(index, texture) {
    if (!this._selfLitSpriteProgramOpts) return null;

    if (!this._selfLitSpriteMeshes[index]) {
      const geometry = new PIXI.Geometry({
        attributes: {
          aPosition: { buffer: new Float32Array(8), size: 2 },
          aUV: { buffer: new Float32Array(8), size: 2 },
        },
        indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
      });

      const shader = new PIXI.Shader({
        ...this._selfLitSpriteProgramOpts,
        resources: {
          uniforms: {
            uCameraPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
            uZoom: { value: 1.0, type: 'f32' },
            uCanvasSize: { value: new Float32Array([this.canvasWidth, this.canvasHeight]), type: 'vec2<f32>' },
            uLightPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
            uLightIntensity: { value: 1000, type: 'f32' },
            uLightColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          },
          uTexture: texture.source,
          uSampler: texture.source.style,
        },
      });

      const mesh = new PIXI.Mesh({ geometry, shader });
      mesh.blendMode = 'add';
      this._selfLitSpriteMeshes[index] = { mesh, geometry, shader, texture };
    }

    const entry = this._selfLitSpriteMeshes[index];
    if (entry.texture !== texture) {
      entry.shader.resources.uTexture = texture.source;
      entry.shader.resources.uSampler = texture.source.style;
      entry.texture = texture;
    }
    return entry;
  }

  /* =====================
COMPUTE VISIBLE LIGHTS (used by updateLighting shader)
===================== */

  /**
   * Pre-compute visible lights once per frame.
   * updateLighting() uses this data for shader uniforms.
   * Avoids duplicate queryActiveEntities, culling, and sorting.
   */
  computeVisibleLights() {
    // Early return if lighting is disabled (LightEmitter arrays not initialized)
    if (!LightEmitter.active) return;

    const worldX = Transform.x;
    const worldY = Transform.y;
    const lightEnabled = LightEmitter.active;
    const lightHeight = LightEmitter.height;
    const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;

    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;

    // Calculate viewport bounds for culling
    const viewWidth = this.canvasWidth / zoom;
    const viewHeight = this.canvasHeight / zoom;
    const viewRight = cameraX + viewWidth;
    const viewBottom = cameraY + viewHeight;

    // Viewport center for sorting by distance
    const viewCenterX = cameraX + viewWidth / 2;
    const viewCenterY = cameraY + viewHeight / 2;

    // Use pre_render's visible lights buffer when available (avoids duplicate queryActiveEntities)
    const useSharedBuffer = !!this.visibleLightsData;
    const lightCount = useSharedBuffer ? this.visibleLightsData[0] : 0;
    const lightEntities = useSharedBuffer ? null : Query.queryActiveEntities(QUERY_LIGHT_EMITTER);

    // Reset pool
    this._visibleLightsAllCount = 0;

    const iterCount = useSharedBuffer ? lightCount : lightEntities.length;
    for (let idx = 0; idx < iterCount; idx++) {
      const i = useSharedBuffer ? this.visibleLightsData[1 + idx] : lightEntities[idx];
      if (!lightEnabled[i]) continue;
      if (!(sqrtLightIntensity[i] > 0)) continue;

      // World-space light position from Transform SAB, same source as
      // updateLighting/updateShadowSprites/renderVisibilityLighting use.
      const x = worldX[i];
      const yForLight = worldY[i] - (lightHeight[i] || 0);

      // Viewport culling: shared lightInfluenceRadius(sqrtIntensity)
      const influenceRadius = lightInfluenceRadius(sqrtLightIntensity[i]);

      if (
        x + influenceRadius < cameraX ||
        x - influenceRadius > viewRight ||
        yForLight + influenceRadius < cameraY ||
        yForLight - influenceRadius > viewBottom
      ) {
        continue;
      }

      // Distance squared to camera center (for prioritization)
      const dx = x - viewCenterX;
      const dy = yForLight - viewCenterY;
      const distSq = dx * dx + dy * dy;

      // Add to "all lights" pool (for shader uniforms)
      const allIdx = this._visibleLightsAllCount++;
      if (!this._visibleLightsAll[allIdx]) {
        this._visibleLightsAll[allIdx] = { entityId: 0, distSq: 0 };
      }
      this._visibleLightsAll[allIdx].entityId = i;
      this._visibleLightsAll[allIdx].distSq = distSq;
    }

    // Sort by distance (closest first), truncate to active size
    this._visibleLightsAll.length = this._visibleLightsAllCount;
    this._visibleLightsAll.sort(sortByDistSq);
  }

  /**
   * Pack path mutates _lightDataFloats in place. Pin RGBA32F GPUTexture (no RENDER_ATTACHMENT).
   */
  _uploadLightDataTexture() {
    const source = this._lightDataSource;
    const data = this._lightDataFloats;
    if (!source || !data) return;
    if (this._useWebGpu) {
      const renderer = this.pixiApp?.renderer;
      if (!renderer?.gpu?.device) return;
      writeRgba32Float(
        renderer,
        source,
        data,
        this.maxLights,
        LIGHT_DATA_TEX_HEIGHT,
        'weed-light-data'
      );
      return;
    }
    this._uploadRgba32FloatGl(source, data, this.maxLights, LIGHT_DATA_TEX_HEIGHT);
  }

  /* =====================
UPDATE LIGHTING (NO ZOOM SCALING)
===================== */

  updateLighting() {
    if (!this.lightingEnabled || !this.lightingShader) return;

    const uniformGroup = this.lightingShader.resources.uniforms;

    // Cache component arrays
    const worldX = Transform.x;
    const worldY = Transform.y;
    const lightColor = LightEmitter.lightColor;
    const lightIntensity = LightEmitter.lightIntensity;
    const lightHeight = LightEmitter.height;

    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;

    // Update camera uniforms (vec2 types)
    uniformGroup.uniforms.uCameraPos[0] = cameraX;
    uniformGroup.uniforms.uCameraPos[1] = cameraY;
    uniformGroup.uniforms.uZoom = zoom;

    // Update viewport uniform every frame (handles resizes and resolution changes)
    uniformGroup.uniforms.uViewport[0] = this.canvasWidth * this.lightingResolution;
    uniformGroup.uniforms.uViewport[1] = this.canvasHeight * this.lightingResolution;

    uniformGroup.uniforms.uFullCanvasSize[0] = this.canvasWidth;
    uniformGroup.uniforms.uFullCanvasSize[1] = this.canvasHeight;

    const lightData = this._lightDataFloats;
    const maxLights = this.maxLights;

    // Use pre-computed visible lights (computed in computeVisibleLights())
    const visibleLights = this._visibleLightsAll;
    const countToRender = Math.min(this._visibleLightsAllCount, maxLights);

    // OPTIMIZED: Reuse preallocated RGB object to avoid allocation per light
    const rgb = this._rgbResult;

    for (let i = 0; i < countToRender; i++) {
      const entityIndex = visibleLights[i].entityId;
      const color = lightColor[entityIndex];

      // Always use world coordinates for lights (shader converts screen to world)
      // Apply height offset to position light above the entity
      extractRGBNormalizedMut(color, rgb);
      packLightDataTexel(
        lightData,
        maxLights,
        i,
        worldX[entityIndex],
        worldY[entityIndex] - (lightHeight[entityIndex] || 0),
        lightIntensity[entityIndex],
        rgb.r,
        rgb.g,
        rgb.b
      );
    }

    clearUnusedLightDataTexels(lightData, maxLights, countToRender);

    if (this._lightDataSource) {
      this._uploadLightDataTexture();
    }

    // Update light count uniform
    uniformGroup.uniforms.uLightCount = countToRender;

    // ========================================
    // SUN UNIFORMS
    // ========================================
    // Sun provides global ambient light that varies with time of day
    if (Sun.isInitialized && Sun.enabled) {
      const sunIntensity = Sun.intensity;
      const sunColor = Sun.color;

      uniformGroup.uniforms.uSunIntensity = sunIntensity;

      // Extract sun color RGB
      extractRGBNormalizedMut(sunColor, rgb);
      uniformGroup.uniforms.uSunR = rgb.r;
      uniformGroup.uniforms.uSunG = rgb.g;
      uniformGroup.uniforms.uSunB = rgb.b;
    } else {
      // Sun disabled - no sun contribution
      uniformGroup.uniforms.uSunIntensity = 0;
    }

    if (typeof uniformGroup.update === 'function') uniformGroup.update();
  }

  /**
   * Create the RenderTexture-based shadow system:
   * 1. Create shadowRT (RenderTexture) - cleared transparent each frame
   * 2. Create shadowBatch - instanced Mesh (per-light soft cookies + black shadows)
   * 3. Create shadowDisplaySprite - displays shadowRT with multiply blend
   *
   * Rendering order per frame (SoA already interleaved per light):
   * - Clear shadowRT to transparent (not opaque black — that fills the multiply layer)
   * - Draw light cookies then that light's shadows (multi-light attenuation)
   * - shadowDisplaySprite (multiply) darkens the scene where RT is dark
   */
  createShadowSpriteSystem() {
    this.shadowResolution = this.config.lighting?.shadowResolution ?? LIGHTING_DEFAULTS.shadowResolution;

    this.shadowRT = PIXI.RenderTexture.create({
      width: this.canvasWidth * this.shadowResolution,
      height: this.canvasHeight * this.shadowResolution,
    });

    this.shadowBatch = new InstancedSpriteBatch({
      capacity: this.maxShadowRenderItems || 1,
      label: 'shadows-instanced',
      atlasSource: this._resolveAtlasSource(),
      lutSource: this._texLutSource,
      depthTest: false,
      useWebGpu: this._useWebGpu,
      shaders: this._engineShaders,
    });

    this.shadowDisplaySprite = new PIXI.Sprite(this.shadowRT);
    this.shadowDisplaySprite.anchor.set(0, 0);
    this.shadowDisplaySprite.position.set(0, 0);
    this.shadowDisplaySprite.scale.set(1.0 / this.shadowResolution);
    this._registerLayerDisplayObject('castedShadows', this.shadowDisplaySprite);
    this.pixiApp.stage.addChild(this.shadowDisplaySprite);

    console.log(
      `PIXI WORKER: Shadow instanced RT (${this.maxShadowRenderItems} max, ${this.shadowRT.width}x${this.shadowRT.height})`
    );
  }

  /**
   * Upload shadow SoA → instanced Mesh → shadowRT (screen space).
   */
  updateShadowSprites() {
    if (!this.shadowSpritesEnabled || !this.shadowRenderQueueCount) return;
    if (!this.shadowBatch || !this.shadowRT) return;
    if (!layerIsVisible(Layer.castedShadows?.id)) return;

    const q = this._shadowUploadQ;
    q.count = this.shadowRenderQueueCount[0];
    q.x = this.shadowRenderQueueX;
    q.y = this.shadowRenderQueueY;
    q.scaleX = this.shadowRenderQueueScaleX;
    q.scaleY = this.shadowRenderQueueScaleY;
    q.rotC = this.shadowRenderQueueRotC;
    q.rotS = this.shadowRenderQueueRotS;
    q.alpha = this.shadowRenderQueueAlpha;
    q.tint = this.shadowRenderQueueTint;
    q.textureId = this.shadowRenderQueueTextureId;
    q.anchorX = this.shadowRenderQueueAnchorX;
    q.anchorY = this.shadowRenderQueueAnchorY;

    const opts = this._shadowUploadOpts;
    opts.space = BATCH_SPACE.SCREEN;
    opts.zoom = this._renderZoom;
    opts.cameraX = this._renderCameraX;
    opts.cameraY = this._renderCameraY;
    opts.resolution = this.shadowResolution;
    opts.depthMode = BATCH_DEPTH.INDEX;
    opts.depthDenom = this.maxShadowRenderItems;
    opts.texLut = this._texLut;
    opts.texLutCount = this._texLutCount;
    opts.textures = this.flatTextures;
    this.shadowBatch.upload(q, opts);

    const rtOpts = this._rtRenderOpts;
    rtOpts.container = emptyInstancedMesh(this.shadowBatch.mesh)
      ? this._rtEmptyContainer
      : this.shadowBatch.mesh;
    rtOpts.target = this.shadowRT;
    rtOpts.clear = true;
    rtOpts.clearColor = this._clearTransparent;
    this.pixiApp.renderer.render(rtOpts);
  }

  /**
   * Load simple textures from transferred ImageBitmaps
   * PixiJS 8: Uses ImageSource instead of BaseTexture
   */
  loadTextures(texturesData) {
    if (!texturesData) return;

    // console.log(
    //   `PIXI WORKER: Loading ${Object.keys(texturesData).length} textures`
    // );

    for (const [name, imageBitmap] of Object.entries(texturesData)) {
      // PixiJS 8: Create TextureSource from ImageBitmap, then create Texture
      const source = new PIXI.ImageSource({
        resource: imageBitmap,
        autoGenerateMipmaps: this.autoGenerateMipmaps,
      });
      this.textures[name] = new PIXI.Texture({ source });

      // console.log(`✅ Loaded texture: ${name}`);
    }
  }

  /**
   * Load spritesheets from JSON + texture data
   * NOTE: PIXI.Spritesheet.parse() doesn't work in workers, so we manually build animations
   */
  loadSpritesheets(spritesheetData, proxySheets = {}) {
    if (!spritesheetData) {
      // console.log("PIXI WORKER: No spritesheets to load");
      return;
    }

    // console.log(
    //   `PIXI WORKER: Loading ${Object.keys(spritesheetData).length} spritesheets`
    // );

    for (const [name, data] of Object.entries(spritesheetData)) {
      try {
        // console.log(`  Loading spritesheet "${name}"...`);

        // Validate data
        if (!data.imageBitmap || !data.json) {
          throw new Error(`Missing imageBitmap or json for ${name}`);
        }

        // PixiJS 8: Create ImageSource from ImageBitmap.
        // Default alphaMode is premultiply-alpha-on-upload (PMA on GPU). Do not
        // re-premultiply in InstancedSpriteBatch fragment — that darkens soft alpha.
        const source = new PIXI.ImageSource({
          resource: data.imageBitmap,
          autoGenerateMipmaps: this.autoGenerateMipmaps,
        });
        const jsonData = data.json;

        // Manually create textures for each frame
        const frameTextures = {};
        for (const [frameName, frameData] of Object.entries(jsonData.frames)) {
          const frame = frameData.frame;
          const sourceSize = frameData.sourceSize;
          const spriteSourceSize = frameData.spriteSourceSize;

          // Build texture options
          const textureOptions = {
            source,
            frame: new PIXI.Rectangle(frame.x, frame.y, frame.w, frame.h),
          };

          // If frame is trimmed, add orig and trim for proper anchor handling
          // PixiJS uses these to offset the sprite so anchors work relative to original size
          if (sourceSize && spriteSourceSize &&
            (sourceSize.w !== frame.w || sourceSize.h !== frame.h)) {
            textureOptions.orig = new PIXI.Rectangle(0, 0, sourceSize.w, sourceSize.h);
            textureOptions.trim = new PIXI.Rectangle(
              spriteSourceSize.x, spriteSourceSize.y,
              spriteSourceSize.w, spriteSourceSize.h
            );
          }

          const texture = new PIXI.Texture(textureOptions);
          frameTextures[frameName] = texture;
        }

        // Manually build animation arrays
        const animations = {};
        if (jsonData.animations) {
          for (const [animName, frameNames] of Object.entries(jsonData.animations)) {
            animations[animName] = frameNames.map((frameName) => frameTextures[frameName]);
          }
        }

        // Store as a spritesheet-like object
        this.spritesheets[name] = {
          textures: frameTextures,
          animations: animations,
          source: source, // PixiJS 8: uses source instead of baseTexture
        };

        // BIGATLAST SUPPORT: If this is the bigAtlas, also populate this.textures
        // This allows static textures (like "bunny") to be accessed directly
        if (name === 'bigAtlas') {
          for (const [frameName, texture] of Object.entries(frameTextures)) {
            this.textures[frameName] = texture;
          }

          const textureKeys = Object.keys(frameTextures);

          console.log(
            `✅ BigAtlas loaded: ${Object.keys(frameTextures).length} frames available as textures`
          );

          // DEBUG: Check if _lightGradient texture is available
          if (this.textures['_lightGradient']) {
            console.log(`✅ PIXI WORKER: _lightGradient texture found in BigAtlas textures`);
          } else {
            console.warn(`⚠️ PIXI WORKER: _lightGradient texture NOT found in BigAtlas textures`);
            console.log(`   Available texture keys (first 20):`, textureKeys.slice(0, 20));
            console.log(
              `   Looking for textures with "light" or "gradient" in name:`,
              textureKeys.filter(
                (k) => k.toLowerCase().includes('light') || k.toLowerCase().includes('gradient')
              )
            );
          }

          // ========================================
          // BUILD FLAT TEXTURE LOOKUP ARRAY
          // ========================================
          // Flatten all animation frames into single array for O(1) lookup
          // pre_render writes textureId; pixi uploads via texLut / InstancedSpriteBatch
          this.flatTextures = [];
          this.animationFrameStart = [];
          this.animationFrameCount = [];

          // Get animation names in consistent order (same as SpriteSheetRegistry)
          const animNames = Object.keys(animations);
          for (let animIdx = 0; animIdx < animNames.length; animIdx++) {
            const animName = animNames[animIdx];
            const frames = animations[animName];

            this.animationFrameStart[animIdx] = this.flatTextures.length;
            this.animationFrameCount[animIdx] = frames.length;

            for (let f = 0; f < frames.length; f++) {
              this.flatTextures.push(frames[f]);
            }
          }

          console.log(`✅ Built flat texture array: ${this.flatTextures.length} textures, ${animNames.length} animations`);

          this.rebuildInstancedTextureLut();
        }

        // console.log(
        //   `✅ Loaded spritesheet: ${name} with ${
        //     Object.keys(animations).length
        //   } animations`
        // );
      } catch (error) {
        console.error(`❌ Failed to load spritesheet ${name}:`, error);
      }
    }

    // Create proxy spritesheet entries that redirect to bigAtlas
    if (proxySheets && Object.keys(proxySheets).length > 0) {
      console.log(`🔗 Creating ${Object.keys(proxySheets).length} proxy spritesheets...`);

      const bigAtlas = this.spritesheets.bigAtlas;
      if (!bigAtlas) {
        console.error('❌ Cannot create proxy sheets: bigAtlas not loaded!');
        return;
      }

      for (const [proxyName, proxyData] of Object.entries(proxySheets)) {
        const prefix = proxyData.prefix;

        // Extract animations from bigAtlas that match this proxy's prefix
        const proxyAnimations = {};
        const proxyTextures = {};

        for (const [animName, animInfo] of Object.entries(proxyData.animations)) {
          const prefixedName = animInfo.prefixedName;
          if (bigAtlas.animations[prefixedName]) {
            // Map unprefixed name to bigAtlas animation
            proxyAnimations[animName] = bigAtlas.animations[prefixedName];
          } else {
            console.warn(
              `⚠️ Proxy "${proxyName}": Animation "${animName}" (${prefixedName}) not found in bigAtlas`
            );
          }
        }

        // Also extract frame textures with this prefix
        for (const [frameName, texture] of Object.entries(bigAtlas.textures)) {
          if (frameName.startsWith(prefix)) {
            const unprefixedName = frameName.substring(prefix.length);
            proxyTextures[unprefixedName] = texture;
          }
        }

        // Create proxy spritesheet entry (for PIXI rendering)
        this.spritesheets[proxyName] = {
          textures: proxyTextures,
          animations: proxyAnimations,
          source: bigAtlas.source, // PixiJS 8: uses source instead of baseTexture
          isProxy: true,
          targetSheet: 'bigAtlas',
        };

        // Also register in SpriteSheetRegistry (for animation lookups)
        SpriteSheetRegistry.registerProxy(proxyName, proxyData);

        console.log(`  ✅ Proxy "${proxyName}": ${Object.keys(proxyAnimations).length} animations`);
      }
    }

    // console.log("PIXI WORKER: Finished loading all spritesheets");
  }

  /**
   * Load tileset bitmaps and create PIXI Textures for tilemap rendering.
   * Tile data is accessed via TileMap static class (SAB-backed, initialized by AbstractWorker).
   */
  loadTilesetBitmaps(tilesetBitmaps) {
    if (!tilesetBitmaps || Object.keys(tilesetBitmaps).length === 0) {
      return;
    }

    console.log(`PIXI WORKER: Loading ${Object.keys(tilesetBitmaps).length} tileset textures...`);

    for (const [tilemapId, bitmap] of Object.entries(tilesetBitmaps)) {
      try {
        const source = new PIXI.ImageSource({
          resource: bitmap,
          autoGenerateMipmaps: false,
          scaleMode: 'nearest',
        });
        if (source.style) {
          source.style.scaleMode = 'nearest';
          source.style.addressMode = 'clamp-to-edge';
        }
        const tilesetTexture = new PIXI.Texture({ source });

        this.tilemaps[tilemapId] = { tilesetTexture };

        console.log(`  ✅ Loaded tileset texture: ${tilemapId}`);
      } catch (error) {
        console.error(`  ❌ Failed to load tileset texture "${tilemapId}":`, error);
      }
    }
  }

  handleCustomMessage(data) {
    const { msg } = data;
    if (msg === 'box2dReady' && data.channelOffsets) {
      bindBox2dHotFields(data);
      if (data.commandSab) {
        bindCommandRing(data.commandSab);
      }
      if (data.liquidFunHeap) {
        LiquidFun.bindHeapPose(data.liquidFunHeap);
      }
      return;
    }
    if (msg === 'liquidFunHeap' && data.liquidFunHeap) {
      LiquidFun.bindHeapPose(data.liquidFunHeap);
      return;
    }
    if (msg === 'liquidFunCleared') return;
    console.log(`PIXI WORKER: handleCustomMessage called with msg: ${msg}`);

    if (msg === 'setLayerContent') {
      this.handleSetLayerContent(data);
    } else if (msg === 'setLayerProps') {
      this.handleSetLayerProps(data);
    } else {
      console.log(`PIXI WORKER: Unhandled message type: ${msg}`);
    }
  }

  /**
   * Handle layer property changes from debug UI
   * @param {Object} data - { layer, visible, blendMode, containerBlendMode, zIndex, shader, shaderFragment }
   */
  handleSetLayerProps(data) {
    const { layer, visible, blendMode, containerBlendMode, zIndex, shader, shaderFragment, splatRadius } = data;

    if (shader !== undefined || shaderFragment !== undefined) {
      this._setCustomLayerShader(layer, shaderFragment || null, shader || null);
    }

    const displayObject = this.layerRefs?.[layer];
    if (!displayObject && splatRadius === undefined) {
      return;
    }

    if (visible !== undefined && displayObject) {
      setDisplayVisible(displayObject, visible);
      if (layer === 'entities') {
        setDisplayVisible(this.spriteParticleMesh, visible);
        setDisplayVisible(this.spriteGlowMesh, visible);
      }
    }

    if (blendMode !== undefined && displayObject) {
      displayObject.blendMode = blendMode;
    }

    if (containerBlendMode !== undefined) {
      const layerObj = Layer.get(layer);
      if (layerObj) {
        const cl = this._customLayers[layerObj.id];
        if (cl?.batch?.mesh) {
          cl.batch.mesh.blendMode = containerBlendMode;
        }
        if (cl?.fillBatch?.mesh) {
          cl.fillBatch.mesh.blendMode = containerBlendMode;
        }
        if (cl?.splatBatch?.mesh) {
          cl.splatBatch.mesh.blendMode = containerBlendMode;
        }
      }
    }

    if (splatRadius !== undefined) {
      const layerObj = Layer.get(layer);
      if (layerObj) {
        const cl = this._customLayers[layerObj.id];
        if (cl && splatRadius > 0) {
          cl.splatRadius = splatRadius;
          if (cl.splat) cl.splat.radius = splatRadius;
        }
      }
    }

    if (zIndex !== undefined && displayObject) {
      displayObject.zIndex = zIndex;
      if (layer === 'entities') {
        if (this.spriteParticleMesh) this.spriteParticleMesh.zIndex = zIndex + 0.0005;
        if (this.spriteGlowMesh) this.spriteGlowMesh.zIndex = zIndex + 0.001;
      }
      this.pixiApp.stage.sortChildren();
    }
  }

  _buildCustomLayerUniformDefs(layerId, uniformMap, uniformTypes) {
    const uniformDefs = {};
    if (!uniformMap) return uniformDefs;
    const floats = Layer._uniformFloats[layerId];
    for (const [uName, entry] of Object.entries(uniformMap)) {
      const uType = uniformTypes?.[uName] || 'f32';
      if (entry.size === 1) {
        uniformDefs[uName] = { value: floats ? floats[entry.offset] : 0, type: uType };
      } else {
        const arr = new Float32Array(entry.size);
        if (floats) {
          for (let k = 0; k < entry.size; k++) arr[k] = floats[entry.offset + k];
        }
        uniformDefs[uName] = { value: arr, type: uType };
      }
    }
    return uniformDefs;
  }

  _meshLookFlipV() {
    // WebGL RT is top-origin; look-on-stage needs V flip.
    // WebGPU RT origin matches NDC — the same flip inverts terrain.
    return !this._useWebGpu;
  }

  _createLayerFullscreenGeometry(flipV) {
    // Look-to-rtOut + Sprite already flips V (GL RT write). Look on stage
    // samples the fill RT directly. Flip is backend-specific (_meshLookFlipV).
    const uv = meshLookFullscreenUvs(flipV);
    return new Geometry({
      attributes: {
        aPosition: { buffer: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), format: 'float32x2' },
        aUV: { buffer: uv, format: 'float32x2' },
      },
      indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
    });
  }

  _makeLookShaderMesh(shader, flipV) {
    const state = new State();
    state.blend = true;
    state.depthTest = false;
    state.depthMask = false;
    state.culling = false;
    const mesh = new Mesh({
      geometry: this._createLayerFullscreenGeometry(!!flipV),
      shader,
      state,
    });
    mesh.eventMode = 'none';
    mesh.cullable = false;
    return mesh;
  }

  /**
   * World verts + camera on a reused Container. Pixi 8 ignores Mesh x/y/scale
   * when that Mesh is the RT render root.
   */
  _renderMeshFillToRt(cl, fillMesh) {
    const z = this._renderZoom * (cl.resolution || 1);
    const mx = this._meshRtTransform;
    mx.set(z, 0, 0, z, -this._renderCameraX * z, -this._renderCameraY * z);
    const root = this._meshRtRoot;
    if (fillMesh.parent !== root) {
      if (fillMesh.parent) fillMesh.parent.removeChild(fillMesh);
      root.addChild(fillMesh);
    }
    fillMesh.x = 0;
    fillMesh.y = 0;
    if (fillMesh.scale.x !== 1 || fillMesh.scale.y !== 1) fillMesh.scale.set(1);
    root.x = 0;
    root.y = 0;
    if (root.scale.x !== 1 || root.scale.y !== 1) root.scale.set(1);
    const rtOpts = this._rtRenderOpts;
    rtOpts.container = emptyInstancedMesh(fillMesh)
      ? this._rtEmptyContainer
      : root;
    rtOpts.target = cl.rt;
    rtOpts.clear = true;
    rtOpts.clearColor = this._clearTransparent;
    rtOpts.transform = mx;
    this.pixiApp.renderer.render(rtOpts);
    rtOpts.transform = null;
  }

  _destroyCustomLayerPostProcess(cl) {
    if (!cl) return;
    if (cl.shaderMesh) {
      cl.shaderMesh.destroy(true);
      cl.shaderMesh = null;
    }
    cl.shader = null;
    cl.uniformStore = null;
  }

  _destroyCustomLayerCompute(cl) {
    if (!cl?.compute) return;
    cl.compute.destroy();
    cl.compute = null;
  }

  _destroyAllCustomLayerCompute() {
    const ids = Object.keys(this._customLayers);
    for (let i = 0; i < ids.length; i++) {
      this._destroyCustomLayerCompute(this._customLayers[ids[i]]);
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

  _applyCustomLayerScaleMode(cl) {
    if (!cl) return;
    const mode = cl.scaleMode ?? LAYER_SCALE_MODE.LINEAR;
    this._setRtScaleMode(cl.rt, mode);
    this._setRtScaleMode(cl.rtOut, mode);
  }

  _unbindLookShaderTexture(shader) {
    const res = shader?.resources;
    if (!res) return;
    const empty = PIXI.Texture.EMPTY;
    if (res.uTexture) res.uTexture = empty.source;
    if (res.uSampler) res.uSampler = empty.source.style;
  }

  /**
   * Pixi batch BindGroups stay subscribed to TextureSource "change" after
   * sprite.texture is swapped. Destroy those groups before RT.destroy(true)
   * or we get the BindGroup warning and a dead GPU bind.
   */
  _releaseTextureBindGroups(texture) {
    if (!texture) return;
    const hash = this.pixiApp?.renderer?.texture?._bindGroupHash;
    if (hash && texture.uid != null) {
      const bg = hash[texture.uid];
      if (bg && typeof bg.destroy === 'function') bg.destroy();
      hash[texture.uid] = null;
    }
    releasePixiBindGroupsOnResource(texture.source);
    releasePixiBindGroupsOnResource(texture.source?.style);
  }

  /**
   * Destroy+create at the new pixel size. source.resize() does not rebuild
   * the GPU framebuffer for look/lighting RTs (fire desyncs vs bodies).
   */
  _replaceRT(rt, width, height, sprite, scale) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (sprite) sprite.texture = PIXI.Texture.EMPTY;
    if (rt) {
      this._releaseTextureBindGroups(rt);
      rt.destroy(true);
    }
    const next = PIXI.RenderTexture.create({ width: w, height: h });
    if (sprite) {
      sprite.texture = next;
      if (scale != null) sprite.scale.set(scale);
    }
    return next;
  }

  _ensureCustomLayerDensityRT(cl) {
    const resolution = cl.resolution || 1.0;
    const w = this.canvasWidth * resolution;
    const h = this.canvasHeight * resolution;
    if (cl.batch?.mesh?.parent) cl.batch.mesh.parent.removeChild(cl.batch.mesh);
    if (cl.fillBatch?.mesh?.parent) cl.fillBatch.mesh.parent.removeChild(cl.fillBatch.mesh);
    if (!cl.rt) cl.rt = PIXI.RenderTexture.create({ width: w, height: h });
    const meshLook = !!cl.fillBatch;
    if (!meshLook && !cl.rtOut) cl.rtOut = PIXI.RenderTexture.create({ width: w, height: h });
    this._applyCustomLayerScaleMode(cl);
    if (meshLook && !cl.shaderBypass) return;
    const tex = (meshLook || cl.shaderBypass || !cl.rtOut) ? cl.rt : cl.rtOut;
    if (!cl.displaySprite) {
      cl.displaySprite = new PIXI.Sprite(tex);
      cl.displaySprite.anchor.set(0, 0);
      cl.displaySprite.position.set(0, 0);
      cl.displaySprite.scale.set(1.0 / resolution);
      this.pixiApp.stage.addChild(cl.displaySprite);
    } else {
      cl.displaySprite.texture = tex;
      cl.displaySprite.scale.set(1.0 / resolution);
      if (!cl.displaySprite.parent) this.pixiApp.stage.addChild(cl.displaySprite);
    }
  }

  /**
   * Live-swap custom layer fragment, or bypass post-process (shader=null).
   * Bypass keeps density RT at layer resolution and shows raw accumulation —
   * avoids dumping tens of thousands of sprites onto the full-res stage.
   */
  _setCustomLayerShader(layerName, fragmentSource, shaderName) {
    const layerObj = Layer.get(layerName);
    if (!layerObj || layerObj.builtIn) return;
    const cl = this._customLayers[layerObj.id];
    if (!cl || (!cl.batch && !cl.splatBatch && !cl.compute && !cl.fillBatch)) return;

    const meta = Layer._metadata?.layers?.[layerObj.id];
    if (meta) {
      meta.shaderName = shaderName || null;
      meta.shaderFragment = fragmentSource || null;
    }

    const resolution = cl.resolution || 1.0;

    // (none): keep density RT, skip fullscreen frag, show raw cl.rt
    if (!fragmentSource) {
      if (!cl.compute && !cl.rt) this._ensureCustomLayerDensityRT(cl);
      this._destroyCustomLayerPostProcess(cl);
      cl.shaderBypass = true;
      if (cl.fillBatch && cl.rt && !cl.displaySprite) {
        cl.displaySprite = new PIXI.Sprite(cl.rt);
        cl.displaySprite.anchor.set(0, 0);
        cl.displaySprite.position.set(0, 0);
        cl.displaySprite.scale.set(1.0 / resolution);
        this.pixiApp.stage.addChild(cl.displaySprite);
      } else if (cl.displaySprite && cl.rt) {
        cl.displaySprite.texture = cl.rt;
        cl.displaySprite.scale.set(1.0 / resolution);
        if (!cl.displaySprite.parent) this.pixiApp.stage.addChild(cl.displaySprite);
      }
      this._registerLayerDisplayObject(layerName, cl.displaySprite);
      this.pixiApp.stage.sortChildren();
      this._syncLayerRefsFromRuntime();
      return;
    }

    cl.shaderBypass = false;
    if (!cl.compute) this._ensureCustomLayerDensityRT(cl);
    this._destroyCustomLayerPostProcess(cl);

    if (meta) meta.hasShader = true;
    if (Layer._hasShader) Layer._hasShader[layerObj.id] = 1;

    const uniformMap = meta?.uniformMap || null;
    const uniformTypes = meta?.uniformTypes || null;
    cl.uniformEntries = uniformMap ? Object.entries(uniformMap) : null;
    const uniformDefs = this._buildCustomLayerUniformDefs(cl.layerId, uniformMap, uniformTypes);

    try {
      const lookSource = cl.lookSource || cl.rt.source;
      cl.shader = this._createLookShader(fragmentSource, lookSource, uniformDefs, shaderName || 'look', layerName);
      cl.uniformStore = cl.shader.resources?.customUniforms?.uniforms || null;
      cl.shaderMesh = this._makeLookShaderMesh(cl.shader, !!cl.fillBatch && this._meshLookFlipV());
    } catch (err) {
      if (err && typeof err.message === 'string' && err.message.startsWith('WeedJS:')) throw err;
      throw errorCompileFailed('look', shaderName || 'look', layerName, this._useWebGpu ? 'WebGPU' : 'WebGL', err);
    }

    if (cl.fillBatch) {
      cl.meshLook = true;
      if (cl.displaySprite) {
        cl.displaySprite.visible = false;
        if (cl.displaySprite.parent) cl.displaySprite.parent.removeChild(cl.displaySprite);
      }
      if (!cl.shaderMesh.parent) this.pixiApp.stage.addChild(cl.shaderMesh);
      this._registerLayerDisplayObject(layerName, cl.shaderMesh, true);
    } else {
      cl.displaySprite.texture = cl.rtOut;
      cl.displaySprite.scale.set(1.0 / resolution);
      this._registerLayerDisplayObject(layerName, cl.displaySprite);
    }
    this.pixiApp.stage.sortChildren();
    this._syncLayerRefsFromRuntime();

    if (Layer._uniformDirty?.[cl.layerId]) {
      Atomics.store(Layer._uniformDirty[cl.layerId], 0, 1);
    }
  }

  _applyLayerPresentation(layerName, displayObject, forceContainerBlend) {
    if (!displayObject) return;
    const layer = Layer.get(layerName);
    if (!layer) return;
    displayObject.zIndex = layer.zIndex;
    displayObject.alpha = layer.alpha;
    setDisplayVisible(displayObject, layer.visible);
    displayObject.blendMode = forceContainerBlend ? layer.containerBlendMode : layer.blendMode;
  }

  _applyLayerVisibility() {
    if (!Layer._visible) return;
    for (let i = 0; i < Layer.count; i++) {
      if (Layer._visibleDirty) Atomics.load(Layer._visibleDirty, i);
      const on = Layer._visible[i] === 1;
      const name = Layer.getName(i);
      const displayObj = name ? this._layerRuntime[name] : null;
      if (displayObj) setDisplayVisible(displayObj, on);
      if (i === Layer.entitiesId) {
        setDisplayVisible(this.spriteParticleMesh, on);
        setDisplayVisible(this.spriteGlowMesh, on);
      }
    }
  }

  _registerLayerDisplayObject(layerName, displayObject, forceContainerBlend) {
    if (!layerName || !displayObject) return;
    this._applyLayerPresentation(layerName, displayObject, forceContainerBlend);
    this._layerRuntime[layerName] = displayObject;
  }

  _syncLayerRefsFromRuntime() {
    const refs = {};
    const allLayers = Layer.getAll();
    for (let i = 0; i < allLayers.length; i++) {
      const layer = allLayers[i];
      if (!layer) continue;
      const runtimeObj = this._layerRuntime[layer.name];
      if (runtimeObj) refs[layer.name] = runtimeObj;
    }
    this.layerRefs = refs;
  }

  _resizeCustomLayerRTs(cl, width, height) {
    if (!Layer.customLayerNeedsViewportResize(cl)) return;
    const resolution = cl.resolution || 1.0;
    const lw = width * resolution;
    const lh = height * resolution;

    if (cl.displaySprite) cl.displaySprite.texture = PIXI.Texture.EMPTY;
    this._unbindLookShaderTexture(cl.shader);

    if (cl.rt) {
      this._releaseTextureBindGroups(cl.rt);
      cl.rt.destroy(true);
      cl.rt = PIXI.RenderTexture.create({ width: lw, height: lh });
    }
    if (cl.rtOut) {
      this._releaseTextureBindGroups(cl.rtOut);
      cl.rtOut.destroy(true);
      cl.rtOut = PIXI.RenderTexture.create({ width: lw, height: lh });
    }

    if (cl.shader) {
      const lookTex = Layer.customLayerLookTexture(cl);
      if (lookTex) {
        cl.shader.resources.uTexture = lookTex;
        if (cl.shader.resources.uSampler && lookTex.style) {
          cl.shader.resources.uSampler = lookTex.style;
        }
      }
    }

    this._applyCustomLayerScaleMode(cl);

    if (cl.displaySprite) {
      cl.displaySprite.texture = (cl.shaderBypass || !cl.rtOut) ? cl.rt : cl.rtOut;
      cl.displaySprite.scale.set(1.0 / resolution);
    }
  }

  /**
   * PixiJS-specific resize: resize renderer and render textures.
   * Base class (AbstractWorker) already updates canvasWidth/Height, config, and Camera.
   */
  onResize(width, height) {
    // Let PixiJS resize the renderer first (updates viewport, projection, and canvas)
    if (this.pixiApp) {
      this.pixiApp.renderer.resize(width, height);
    }

    // Fallback: ensure the OffscreenCanvas pixel buffer actually matches.
    // Do this AFTER renderer.resize() so we don't confuse PixiJS's internal size tracking.
    // Setting width/height resets a WebGPU canvas context — rebind after.
    if (this.canvasView) {
      if (this.canvasView.width !== width) this.canvasView.width = width;
      if (this.canvasView.height !== height) this.canvasView.height = height;
    }
    if (this._useWebGpu) this._bindWebGpuSwapchain();

    // Viewport RTs follow canvas. Destroy+create (source.resize leaves a
    // stale GPU framebuffer). Unbind BindGroups first to avoid Pixi warns.
    if (this.lightingRT) {
      this.lightingRT = this._replaceRT(
        this.lightingRT,
        width * this.lightingResolution,
        height * this.lightingResolution,
        this.lightingDisplaySprite,
        1.0 / this.lightingResolution
      );
    }

    // Sync lighting shader uniforms immediately
    if (this.lightingShader) {
      const u = this.lightingShader.resources.uniforms.uniforms;
      u.uViewport[0] = width * this.lightingResolution;
      u.uViewport[1] = height * this.lightingResolution;
      u.uFullCanvasSize[0] = width;
      u.uFullCanvasSize[1] = height;
    }

    if (this.shadowRT) {
      this.shadowRT = this._replaceRT(
        this.shadowRT,
        width * this.shadowResolution,
        height * this.shadowResolution,
        this.shadowDisplaySprite,
        1.0 / this.shadowResolution
      );
    }

    if (this._visPolyRT) {
      const res = this.lightingResolution || 1.0;
      this._visPolyRT = this._replaceRT(
        this._visPolyRT,
        Math.max(1, Math.floor(width * res)),
        Math.max(1, Math.floor(height * res)),
        this._visPolyDisplaySprite,
        1.0 / res
      );
    }

    // Viewport look/density RTs (compute layers have rtOut only).
    for (let i = 0; i < this._customLayerList.length; i++) {
      this._resizeCustomLayerRTs(this._customLayerList[i], width, height);
    }

    this._applyCoverSceneryTransforms();

    console.log(`PIXI WORKER: Resized to ${width}x${height}`);
  }

  /**
   * Scenery content for one layer (cover / static / tiling / tilemap / none).
   * @param {object} data
   */
  handleSetLayerContent(data) {
    const { type, layerId, requestId, textureId, tileScale, tilemapId, options, parallaxX, parallaxY, margin, zoomParallax } = data;
    const layer = Layer.getById(layerId);
    const layerName = layer?.name;
    if (!layer || !layerName) {
      console.warn(`PIXI WORKER: setLayerContent unknown layerId ${layerId}`);
      self.postMessage({ msg: 'layerContentReady', layerId, requestId });
      return;
    }

    this._destroyScenery(layerId);

    switch (type) {
      case 'static':
        this._createStaticScenery(layerId, layerName, textureId, parallaxX, parallaxY);
        break;
      case 'cover':
        this._createCoverScenery(layerId, layerName, textureId, { parallaxX, parallaxY, margin, zoomParallax });
        break;
      case 'tiling':
        this._createTilingScenery(layerId, layerName, textureId, tileScale, parallaxX, parallaxY);
        break;
      case 'tilemap':
        this._createTilemapScenery(layerId, layerName, tilemapId, options, parallaxX, parallaxY);
        break;
      case 'none':
        break;
      default:
        console.warn(`PIXI WORKER: Unknown scenery type: ${type}`);
    }

    if (!this._cameraInitialized && this.cameraData) {
      this._renderZoom = this.cameraData[0];
      this._renderCameraX = this.cameraData[1];
      this._renderCameraY = this.cameraData[2];
      this._cameraInitialized = true;
    }
    this.updateCameraTransform();

    if (this.pixiApp && this.pixiApp.renderer) {
      this.pixiApp.renderer.render(this.pixiApp.stage);
    }

    self.postMessage({ msg: 'layerContentReady', layerId, requestId });
  }

  _destroyScenery(layerId) {
    const s = this._scenery[layerId];
    if (!s) return;
    if (s.tilemap) this._destroyTilemapPages(s.tilemap);
    if (s.displayObject) {
      if (s.displayObject.parent) s.displayObject.parent.removeChild(s.displayObject);
      s.displayObject.destroy({ children: true });
    }
    const name = Layer.getName(layerId);
    if (name) delete this._layerRuntime[name];
    this._scenery[layerId] = null;
    this._syncLayerRefsFromRuntime();
  }

  _bindScenery(layerId, layerName, entry) {
    const tmScale = entry.tilemap && entry.tilemap.scale;
    entry.sx = tmScale ? +tmScale.x || 1 : 1;
    entry.sy = tmScale ? +tmScale.y || 1 : 1;
    entry.px = Number.isFinite(entry.parallaxX) ? entry.parallaxX : 1;
    entry.py = Number.isFinite(entry.parallaxY) ? entry.parallaxY : 1;
    this._scenery[layerId] = entry;
    this._sceneryCamDirty = true;
    if (entry.displayObject) {
      this._registerLayerDisplayObject(layerName, entry.displayObject);
      this.pixiApp.stage.addChild(entry.displayObject);
    }
    this._syncLayerRefsFromRuntime();
  }

  _createStaticScenery(layerId, layerName, textureId, parallaxX, parallaxY) {
    const texture = this.textures[textureId];
    if (!texture) {
      console.warn(`PIXI WORKER: Texture "${textureId}" not found for static scenery`);
      return;
    }
    const sprite = new PIXI.Sprite(texture);
    sprite.width = this.worldWidth;
    sprite.height = this.worldHeight;
    this._bindScenery(layerId, layerName, {
      kind: 'static',
      displayObject: sprite,
      parallaxX: Number.isFinite(parallaxX) ? parallaxX : 1,
      parallaxY: Number.isFinite(parallaxY) ? parallaxY : 1,
    });
  }

  _createCoverScenery(layerId, layerName, textureId, { parallaxX, parallaxY, margin, zoomParallax } = {}) {
    const texture = this.textures[textureId];
    if (!texture) {
      console.warn(`PIXI WORKER: Texture "${textureId}" not found for cover scenery`);
      return;
    }
    const sprite = new PIXI.Sprite(texture);
    const entry = {
      kind: 'cover',
      displayObject: sprite,
      parallaxX: Number.isFinite(parallaxX) ? parallaxX : 0,
      parallaxY: Number.isFinite(parallaxY) ? parallaxY : 0,
      cover: { parallaxX, parallaxY, margin, zoomParallax },
    };
    this._bindScenery(layerId, layerName, entry);
    this._applyCoverTransform(entry);
  }

  _createTilingScenery(layerId, layerName, textureId, tileScale = 1, parallaxX, parallaxY) {
    const texture = this.textures[textureId];
    if (!texture) {
      console.warn(`PIXI WORKER: Texture "${textureId}" not found for tiling scenery`);
      return;
    }
    const sprite = new PIXI.TilingSprite({
      texture,
      width: this.worldWidth,
      height: this.worldHeight,
    });
    const scale = Number.isFinite(tileScale) ? tileScale : 1;
    sprite.tileScale.set(scale, scale);
    sprite.tilePosition.set(0, 0);
    this._bindScenery(layerId, layerName, {
      kind: 'tiling',
      displayObject: sprite,
      parallaxX: Number.isFinite(parallaxX) ? parallaxX : 1,
      parallaxY: Number.isFinite(parallaxY) ? parallaxY : 1,
    });
  }

  _applySceneryCamera(zoom, cameraX, cameraY) {
    const cw = this.canvasWidth;
    const ch = this.canvasHeight;
    if (
      !this._sceneryCamDirty &&
      zoom === this._sceneryCamZoom &&
      cameraX === this._sceneryCamX &&
      cameraY === this._sceneryCamY &&
      cw === this._sceneryCamCw &&
      ch === this._sceneryCamCh
    ) {
      return;
    }
    this._sceneryCamDirty = false;
    this._sceneryCamZoom = zoom;
    this._sceneryCamX = cameraX;
    this._sceneryCamY = cameraY;
    this._sceneryCamCw = cw;
    this._sceneryCamCh = ch;
    for (let i = 0; i < this._scenery.length; i++) {
      const s = this._scenery[i];
      if (!s || !s.displayObject) continue;
      if (s.kind === 'cover' && s.cover) {
        this._applyCoverTransform(s);
        continue;
      }
      s.displayObject.scale.set(zoom * s.sx, zoom * s.sy);
      s.displayObject.x = -cameraX * zoom * s.px;
      s.displayObject.y = -cameraY * zoom * s.py;
    }
  }

  _applyCoverSceneryTransforms() {
    for (let i = 0; i < this._scenery.length; i++) {
      const s = this._scenery[i];
      if (s?.kind === 'cover') this._applyCoverTransform(s);
    }
  }

  _applyCoverTransform(entry) {
    const sprite = entry?.displayObject;
    const cfg = entry?.cover;
    if (!sprite || !cfg) return;
    const tex = sprite.texture;
    const args = this._coverBgArgs || (this._coverBgArgs = {
      canvasW: 0,
      canvasH: 0,
      texW: 1,
      texH: 1,
      zoom: 1,
      cameraX: 0,
      cameraY: 0,
      worldW: 0,
      worldH: 0,
      parallaxX: 0,
      parallaxY: 0,
      margin: 0,
      zoomParallax: 0,
    });
    args.canvasW = this.canvasWidth;
    args.canvasH = this.canvasHeight;
    args.texW = tex?.width || 1;
    args.texH = tex?.height || 1;
    args.zoom = this._renderZoom;
    args.cameraX = this._renderCameraX;
    args.cameraY = this._renderCameraY;
    args.worldW = this.worldWidth;
    args.worldH = this.worldHeight;
    args.parallaxX = cfg.parallaxX;
    args.parallaxY = cfg.parallaxY;
    args.margin = cfg.margin;
    args.zoomParallax = cfg.zoomParallax;
    const t = coverBackgroundTransform(args, this._coverBgOut || (this._coverBgOut = { scale: 1, x: 0, y: 0 }));
    sprite.scale.set(t.scale);
    sprite.x = t.x;
    sprite.y = t.y;
  }

  _createTilemapRuntime() {
    return {
      container: null,
      tilemapId: null,
      buildOptions: null,
      tilesetTexture: null,
      pages: [],
      scale: { x: 1, y: 1 },
    };
  }

  _destroyTilemapPages(tm) {
    if (!tm?.pages) return;
    for (let i = 0; i < tm.pages.length; i++) {
      const entry = tm.pages[i];
      if (entry.mesh) {
        if (entry.mesh.parent) entry.mesh.parent.removeChild(entry.mesh);
        entry.mesh.destroy();
      }
      if (entry.gidSource && typeof entry.gidSource.destroy === 'function') {
        entry.gidSource.destroy();
      }
    }
    tm.pages.length = 0;
  }

  _initTilemapGidProgram() {
    if (this._tilemapGidProgramOpts) return;
    if (this._useWebGpu) {
      const src = this._engineShaders?.tilemapGid;
      if (!src) {
        throw new Error('WeedJS: tilemapGid.wgsl was not loaded before tilemap creation.');
      }
      this._tilemapGidProgramOpts = { gpuProgram: gpuFromWgsl(src, 'tilemap-gid') };
      return;
    }
    const vert = this._engineShaders?.tilemapGidVert;
    const frag = this._engineShaders?.tilemapGidFrag;
    if (!vert || !frag) {
      throw new Error('WeedJS: tilemapGid GLSL was not loaded before tilemap creation.');
    }
    this._tilemapGidProgramOpts = {
      glProgram: new GlProgram({ vertex: vert, fragment: frag, name: 'tilemap-gid' }),
    };
  }

  _createTilemapGidShader(gidSource, tilesetSource, uniforms) {
    this._initTilemapGidProgram();
    const resources = this._useWebGpu
      ? {
        uGid: gidSource,
        uTileset: tilesetSource,
        uTilesetSampler: tilesetSource.style,
        uniforms,
      }
      : {
        uGid: gidSource,
        uTileset: tilesetSource,
        uniforms,
      };
    return new Shader({
      ...this._tilemapGidProgramOpts,
      resources,
    });
  }

  _fillTilemapPages(tm, tileMapData) {
    this._destroyTilemapPages(tm);
    const tileset = tileMapData.tilesets && tileMapData.tilesets[0];
    if (!tileset || !tm.tilesetTexture) return;
    const atlas = tm.tilesetTexture;
    const atlasSource = atlas.source || atlas;
    const atlasW = atlas.width || atlasSource.width || 1;
    const atlasH = atlas.height || atlasSource.height || 1;
    const tw = tileMapData.tileWidth || 1;
    const th = tileMapData.tileHeight || 1;
    const pages = listGidPages(tileMapData.mapWidth, tileMapData.mapHeight);
    const layersFilter = tm.buildOptions && tm.buildOptions.layers;
    const layers = tileMapData.getLayers();
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      if (layersFilter && !layersFilter.includes(layer.name)) continue;
      if (!layer.visible) continue;
      for (let pi = 0; pi < pages.length; pi++) {
        const page = pages[pi];
        const { pageW, pageH } = gidPageSize(page);
        if (pageW <= 0 || pageH <= 0) continue;
        if (!gidPageHasTile(layer.data, tileMapData.mapWidth, page)) continue;
        const bytes = new Uint8Array(gidPageByteLength(pageW, pageH));
        packGidPageRgba8(layer.data, tileMapData.mapWidth, page, bytes);
        const gidSource = TextureSource.from({
          resource: bytes,
          width: pageW,
          height: pageH,
          format: 'rgba8unorm',
          scaleMode: 'nearest',
          addressMode: 'clamp-to-edge',
          autoGenerateMipmaps: false,
          alphaMode: 'no-premultiply-alpha',
        });
        gidSource.autoGarbageCollect = false;
        if (gidSource.style) {
          gidSource.style.scaleMode = 'nearest';
          gidSource.style.addressMode = 'clamp-to-edge';
        }
        const x0 = page.minX * tw;
        const y0 = page.minY * th;
        const x1 = page.maxX * tw;
        const y1 = page.maxY * th;
        const geometry = new Geometry({
          attributes: {
            aPosition: {
              buffer: new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]),
              format: 'float32x2',
            },
          },
          indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
        });
        const uniforms = {
          uTileSize: { value: new Float32Array([tw, th]), type: 'vec2<f32>' },
          uPageOrigin: { value: new Float32Array([page.minX, page.minY]), type: 'vec2<f32>' },
          uPageSize: { value: new Float32Array([pageW, pageH]), type: 'vec2<f32>' },
          uFirstGid: { value: tileset.firstgid || 1, type: 'f32' },
          uColumns: { value: tileset.columns || 1, type: 'f32' },
          uAtlasSize: { value: new Float32Array([atlasW, atlasH]), type: 'vec2<f32>' },
          uOpacity: { value: layer.opacity !== undefined ? +layer.opacity : 1, type: 'f32' },
        };
        const shader = this._createTilemapGidShader(gidSource, atlasSource, uniforms);
        const mesh = new Mesh({ geometry, shader });
        mesh.eventMode = 'none';
        tm.container.addChild(mesh);
        tm.pages.push({ mesh, gidSource });
      }
    }
  }

  _createTilemapScenery(layerId, layerName, tilemapId, options = {}, parallaxX, parallaxY) {
    const texEntry = this.tilemaps[tilemapId];
    if (!texEntry || !texEntry.tilesetTexture) {
      console.warn(`PIXI WORKER: Tileset texture for "${tilemapId}" not found`);
      return;
    }

    const tileMapData = TileMap.get(tilemapId);
    if (!tileMapData) {
      console.warn(`PIXI WORKER: TileMap "${tilemapId}" not initialized (SAB not available)`);
      return;
    }

    const tm = this._createTilemapRuntime();
    tm.container = new PIXI.Container();
    tm.tilemapId = tilemapId;
    tm.buildOptions = options || {};
    tm.tilesetTexture = texEntry.tilesetTexture;
    this._destroyTilemapPages(tm);

    if (options.scale !== undefined) {
      if (typeof options.scale === 'number') {
        tm.scale = { x: options.scale, y: options.scale };
      } else if (typeof options.scale === 'object' && options.scale.x !== undefined) {
        tm.scale = {
          x: options.scale.x,
          y: options.scale.y !== undefined ? options.scale.y : options.scale.x,
        };
      }
    }

    this._bindScenery(layerId, layerName, {
      kind: 'tilemap',
      displayObject: tm.container,
      parallaxX: Number.isFinite(parallaxX) ? parallaxX : 1,
      parallaxY: Number.isFinite(parallaxY) ? parallaxY : 1,
      tilemap: tm,
    });

    const zoom = this.cameraData ? this.cameraData[0] : 1;
    tm.container.scale.set(zoom * tm.scale.x, zoom * tm.scale.y);
    this._fillTilemapPages(tm, tileMapData);
  }

  /**
   * Initialize the PIXI renderer with provided data
   */
  async initialize(data) {
    const backend = normalizeRendererBackend(
      data.config?.renderer?.backend ?? this.config?.renderer?.backend
    );
    this._rendererBackend = backend;
    this._useWebGpu = backend === RENDERER_BACKEND_WEBGPU;

    this._engineShaders = {};
    const sh = this._engineShaders;
    const shaderFetches = [];
    if (this._useWebGpu) {
      shaderFetches.push(
        fetchEngineShader('/src/shaders/instancedSprite.wgsl').then((s) => {
          sh.sprite = s;
        }),
        fetchEngineShader('/src/shaders/instancedSpritePose.wgsl').then((s) => {
          sh.spritePose = s;
        }),
        fetchEngineShader('/src/shaders/lfSplat.wgsl').then((s) => {
          sh.lfSplat = s;
        }),
        fetchEngineShader('/src/shaders/lfLightSplat.wgsl').then((s) => {
          sh.lfLightSplat = s;
        }),
        fetchEngineShader('/src/shaders/fullscreenLook.vert.wgsl').then((s) => {
          sh.lookVert = s;
        }),
        fetchEngineShader('/src/shaders/lightingBasic.wgsl').then((s) => {
          sh.lightingFrag = s;
        }),
        fetchEngineShader('/src/shaders/colliderFill.wgsl').then((s) => {
          sh.colliderFill = s;
        }),
        fetchEngineShader('/src/shaders/tilemapGid.wgsl').then((s) => {
          sh.tilemapGid = s;
        })
      );
    } else {
      shaderFetches.push(
        fetchEngineShader('/src/shaders/instancedSprite.vert.glsl').then((s) => {
          sh.spriteVert = s;
        }),
        fetchEngineShader('/src/shaders/instancedSpritePose.vert.glsl').then((s) => {
          sh.spriteVertPose = s;
        }),
        fetchEngineShader('/src/shaders/instancedSprite.frag.glsl').then((s) => {
          sh.spriteFrag = s;
        }),
        fetchEngineShader('/src/shaders/instancedSpriteBlend.frag.glsl').then((s) => {
          sh.spriteFragBlend = s;
        }),
        fetchEngineShader('/src/shaders/instancedSpriteAdditive.frag.glsl').then((s) => {
          sh.spriteFragAdd = s;
        }),
        fetchEngineShader('/src/shaders/lfSplat.vert.glsl').then((s) => {
          sh.lfSplatVert = s;
        }),
        fetchEngineShader('/src/shaders/lfSplat.frag.glsl').then((s) => {
          sh.lfSplatFrag = s;
        }),
        fetchEngineShader('/src/shaders/lfLightSplat.vert.glsl').then((s) => {
          sh.lfLightSplatVert = s;
        }),
        fetchEngineShader('/src/shaders/lfLightSplat.frag.glsl').then((s) => {
          sh.lfLightSplatFrag = s;
        }),
        fetchEngineShader('/src/shaders/fullscreenLook.vert.glsl').then((s) => {
          sh.lookVert = s;
        }),
        fetchEngineShader('/src/shaders/lightingBasic.frag.glsl').then((s) => {
          sh.lightingFrag = s;
        }),
        fetchEngineShader('/src/shaders/colliderFill.vert.glsl').then((s) => {
          sh.colliderFillVert = s;
        }),
        fetchEngineShader('/src/shaders/colliderFill.frag.glsl').then((s) => {
          sh.colliderFillFrag = s;
        }),
        fetchEngineShader('/src/shaders/tilemapGid.vert.glsl').then((s) => {
          sh.tilemapGidVert = s;
        }),
        fetchEngineShader('/src/shaders/tilemapGid.frag.glsl').then((s) => {
          sh.tilemapGidFrag = s;
        })
      );
    }
    if (data.visibilityPolygons && data.visibilityPolygons.enabled) {
      if (this._useWebGpu) {
        shaderFetches.push(
          fetchEngineShader('/src/shaders/visibilityPolygon.wgsl').then((s) => {
            this._visPolyWgsl = s;
          }),
          fetchEngineShader('/src/shaders/occluderSelfLitSprite.wgsl').then((s) => {
            this._selfLitSpriteWgsl = s;
          })
        );
      } else {
        shaderFetches.push(
          fetchEngineShader('/src/shaders/visibilityPolygon.vert.glsl').then((s) => {
            this._visPolyVertexShader = s;
          }),
          fetchEngineShader('/src/shaders/visibilityPolygon.frag.glsl').then((s) => {
            this._visPolyFragmentShader = s;
          }),
          fetchEngineShader('/src/shaders/occluderSelfLitSprite.vert.glsl').then((s) => {
            this._selfLitSpriteVertShader = s;
          }),
          fetchEngineShader('/src/shaders/occluderSelfLitSprite.frag.glsl').then((s) => {
            this._selfLitSpriteFragShader = s;
          })
        );
      }
    }
    await Promise.all(shaderFetches);
    this._initTilemapGidProgram();

    // Initialize stats buffer for writing metrics
    if (data.buffers.rendererStats) {
      this.stats = createStatsWriter(data.buffers.rendererStats, RENDERER_STATS);
      console.log('PIXI WORKER: Stats buffer initialized');
    }

    // Store viewport and world dimensions from config
    this.worldWidth = data.config.worldWidth;
    this.worldHeight = data.config.worldHeight;
    this.canvasWidth = data.config.canvasWidth;
    this.canvasHeight = data.config.canvasHeight;
    this.canvasView = data.view;
    this.physicsWorkerIndex = data.config.spatial.numberOfSpatialWorkers;

    // Read renderer-specific configuration
    const rendererConfig = this.config.renderer || {};
    this._queueInterp = rendererConfig.interpolation === true;

    // Configure scheduling (AbstractWorker may miss 'renderer' key before aliases)
    const fixedFps = Number(rendererConfig.fixedFps);
    if (fixedFps > 0) {
      this.fixedFps = fixedFps;
      this.noLimitFPS = false;
    } else if (rendererConfig.noLimitFPS === true) {
      this.noLimitFPS = true;
    }

    // Configure Y-sorting (default: true)
    this.ySorting = rendererConfig.ySorting !== undefined ? rendererConfig.ySorting : true;

    this.autoGenerateMipmaps =
      rendererConfig.autoGenerateMipmaps !== undefined
        ? !!rendererConfig.autoGenerateMipmaps
        : RENDERER_DEFAULTS.autoGenerateMipmaps;

    // Configure decoration zoom culling thresholds
    this.decorationFadeStartZoom =
      rendererConfig.startFadingDecorationsAtZoom !== undefined
        ? rendererConfig.startFadingDecorationsAtZoom
        : RENDERER_DEFAULTS.startFadingDecorationsAtZoom;
    this.decorationHideZoom =
      rendererConfig.hideDecorationsAtZoom !== undefined
        ? rendererConfig.hideDecorationsAtZoom
        : RENDERER_DEFAULTS.hideDecorationsAtZoom;
    const maxDecalUploads = rendererConfig.maxDecalTileUploadsPerFrame;
    this.maxDecalTileUploadsPerFrame =
      Number.isFinite(maxDecalUploads) && maxDecalUploads > 0
        ? maxDecalUploads
        : RENDERER_DEFAULTS.maxDecalTileUploadsPerFrame;

    // Note: Component arrays are automatically initialized by AbstractWorker.initializeAllComponents()
    // This includes Transform, RigidBody, SpriteRenderer, and all custom components

    // Note: ParticleComponent is automatically initialized by AbstractWorker.initializeCommonBuffers()
    this.maxParticles = data.maxParticles || 0;
    if (data.buffers.componentData.ParticleComponent && this.maxParticles > 0) {
      console.log(`PIXI WORKER: ParticleComponent initialized for ${this.maxParticles} particles`);
    }

    // Initialize particle free list for early-exit optimization
    // freeListTop[1] is the free count, so activeCount = maxParticles - freeListTop[1]
    this.particleFreeListTop = data.particleFreeListTop
      ? new Int32Array(data.particleFreeListTop)
      : null;

    // Note: DecorationComponent is automatically initialized by AbstractWorker.initializeCommonBuffers()
    this.maxDecorations = data.maxDecorations || 0;
    if (data.buffers.componentData.DecorationComponent && this.maxDecorations > 0) {
      console.log(
        `PIXI WORKER: DecorationComponent initialized for ${this.maxDecorations} decorations`
      );
    }

    // Note: LightEmitter is automatically initialized by AbstractWorker.initializeAllComponents()
    if (data.buffers.componentData.LightEmitter) {
      console.log(
        `PIXI WORKER: LightEmitter component initialized (${this.globalEntityCount} slots)`
      );
    }

    // Deserialize spritesheet metadata for animation lookups
    if (data.spritesheetMetadata) {
      SpriteSheetRegistry.deserialize(data.spritesheetMetadata);
      // console.log(
      //   `PIXI WORKER: Loaded ${
      //     SpriteSheetRegistry.getSpritesheetNames().length
      //   } spritesheets`
      // );
    }

    // Create PIXI application (PixiJS 8 uses async init)
    try {
      this.pixiApp = new PIXI.Application();
      await this.pixiApp.init({
        width: this.canvasWidth,
        height: this.canvasHeight,
        resolution: 1,
        canvas: this.canvasView, // v8 uses 'canvas' instead of 'view'
        backgroundColor: 0x000000,
        depth: true,
        // Performance optimizations
        powerPreference: 'high-performance',
        preference: backend,
      });

      if (!this.pixiApp.renderer) {
        throw new Error('PIXI.Application.init() succeeded but renderer is null');
      }

      const actualName = pixiRendererTypeName(this.pixiApp.renderer.type, PIXI.RendererType);
      if (this._useWebGpu) {
        if (this.pixiApp.renderer.type !== PIXI.RendererType.WEBGPU) {
          throw errorPixiTypeMismatch(backend, actualName);
        }
        if (!this.pixiApp.renderer.gpu?.device) {
          throw errorMissingGpuDevice();
        }
        this.pixiApp.renderer.gpu.device.addEventListener('uncapturederror', (ev) => {
          console.error('WebGPU uncapturederror:', ev.error?.message || String(ev.error));
        });
        this._bindWebGpuSwapchain();
      } else {
        if (this.pixiApp.renderer.type !== PIXI.RendererType.WEBGL) {
          throw errorPixiTypeMismatch(backend, actualName);
        }
        if (!this.pixiApp.renderer.gl) {
          throw new Error(
            'WeedJS: This scene requested renderer.backend "webgl", but the WebGL context is missing.'
          );
        }
      }
    } catch (error) {
      this.reportError('PIXI Initialization Failed', error);
      return;
    }

    if (this.config?.manualStep && this.pixiApp.ticker) {
      this.pixiApp.ticker.autoStart = false;
      this.pixiApp.ticker.stop();
    }

    // Enable z-index based sorting on the stage
    this.pixiApp.stage.sortableChildren = true;

    // Hook into WebGL context for draw call monitoring and context loss
    this.setupWebGLHooks();

    this.reportLog('finished initializing pixi app');
    // Load simple textures
    this.loadTextures(data.textures);
    this.reportLog('finished loading textures');

    // Load spritesheets (synchronous now - manually parsed)
    this.loadSpritesheets(data.spritesheets, data.bigAtlasProxySheets);
    this.reportLog('finished loading spritesheets');

    // Load tileset textures (tile data comes from TileMap SAB via AbstractWorker)
    this.loadTilesetBitmaps(data.tilesetBitmaps);
    this.reportLog('finished loading tileset textures');

    // ========================================
    // BLOOD DECAL SPLAT GRID - Initialize (SAB tiles, not TileMap background)
    // ========================================
    if (data.decals && data.decals.enabled) {
      this.decalsEnabled = true;
      this.decalsTileSize = data.decals.tileSize; // World units per tile
      this.decalsTilePixelSize = data.decals.tilePixelSize; // Actual texture pixels
      this.decalsResolution = data.decals.resolution; // Resolution multiplier
      this.decalsTilesX = data.decals.tilesX;
      this.decalsTilesY = data.decals.tilesY;
      this.decalsTotalTiles = data.decals.totalTiles;

      // Create typed array views over SharedArrayBuffers
      this.decalsTilesRGBA = new Uint8ClampedArray(data.decals.tilesRGBA);
      this.decalsTilesDirty = new Uint8Array(data.decals.tilesDirty);

      // Create decal tile container (renders between background and entities)
      this.decalTileContainer = new PIXI.Container();
      this._registerLayerDisplayObject('decals', this.decalTileContainer);

      // Create sprites for each tile
      this.createDecalTileSprites();

      // Add decal tile container to stage
      this.pixiApp.stage.addChild(this.decalTileContainer);

      console.log(
        `PIXI WORKER: decal decals enabled - ${this.decalsTilesX}×${this.decalsTilesY} tiles (${this.decalsTileSize}px world, ${this.decalsTilePixelSize}px texture @ ${this.decalsResolution}x)`
      );
    }

    // ========================================
    // RENDER QUEUE SYSTEM - Initialize (DOUBLE BUFFERED)
    // ========================================
    if (data.renderQueue && data.renderQueue.dataA && data.renderQueue.dataB) {
      console.log('PIXI WORKER: Initializing double-buffered render queue system...');
      this.renderQueueEnabled = true;
      this.renderQueueMaxItems = data.renderQueue.maxItems;

      // Initialize sync buffer
      this.renderQueueSync = new Int32Array(data.renderQueue.sync);
      this.lastReadFrame = -1;

      const maxItems = this.renderQueueMaxItems;

      // Create typed array views for BOTH buffers (must match RenderQueueLayout / Scene alloc)
      const bufferSABs = [data.renderQueue.dataA, data.renderQueue.dataB];
      const cameraSABs = [data.renderQueue.cameraA || null, data.renderQueue.cameraB || null];

      for (let bufIdx = 0; bufIdx < 2; bufIdx++) {
        this.renderQueueBuffers[bufIdx] = createRenderQueueViews(bufferSABs[bufIdx], maxItems);
        const camViews = createRenderQueueCameraViews(cameraSABs[bufIdx]);
        this.renderQueueCameraBuffers[bufIdx] = camViews ? camViews.camera : null;
        this.renderQueuePoseReadyBuffers[bufIdx] = camViews ? camViews.poseReady : null;
      }

      // Set initial read buffer (frame 0 uses buffer 0)
      this._setReadBuffer(0);

      // Entity texture lookup buffer (separate SAB)
      // Maps entityIndex -> last computed globalTextureId for shadow system
      if (data.renderQueue.entityTextureData) {
        this.entityLastTextureId = new Uint16Array(data.renderQueue.entityTextureData);
      }

      this._rqPrevCount = 0;

      console.log(`PIXI WORKER: Double-buffered render queue initialized (max ${maxItems} items)`);
    } else {
      console.log('PIXI WORKER: Render queue NOT enabled');
    }

    // ========================================
    // CASTED SHADOWS SYSTEM - Initialize
    // ========================================
    this.createCastedShadowsSystem(data);

    // ENTITIES always render through the instanced Mesh (no ParticleContainer path)
    if (this.renderQueueEnabled) {
      this.createEntitiesInstancedBatch(this.renderQueueMaxItems);
      this._registerLayerDisplayObject('entities', this.spriteMesh);
      this.pixiApp.stage.addChild(this.spriteMesh);
      if (this.spriteParticleMesh) {
        this.spriteParticleMesh.zIndex = (this.spriteMesh.zIndex || 0) + 0.0005;
        this.pixiApp.stage.addChild(this.spriteParticleMesh);
      }
      if (this.spriteGlowMesh) {
        // Temporary; updateCameraTransform sets z above LIGHTING once that exists
        this.spriteGlowMesh.zIndex = (this.spriteMesh.zIndex || 0) + 0.001;
        this.pixiApp.stage.addChild(this.spriteGlowMesh);
      }
      console.log('PIXI WORKER: ENTITIES layer using instanced sprite mesh (+ particles no-Z-write, glow ADD)');
    }

    // ========================================
    // LIGHTING SYSTEM - Initialize
    // ========================================
    const lightingConfig = this.config.lighting || {};
    if (lightingConfig.enabled && data.buffers.componentData.LightEmitter) {
      this.lightingEnabled = true;
      this.visibleLightsData = data.buffers.visibleLightsData
        ? new Uint16Array(data.buffers.visibleLightsData)
        : null;
      this.lightingResolution = lightingConfig.resolution || 1.0;
      // baseAmbient is the night/minimum light level (when sun is down)
      this.baseAmbient = lightingConfig.baseAmbient !== undefined ? lightingConfig.baseAmbient : 0.05;
      this.maxLights = lightingConfig.maxLights !== undefined ? lightingConfig.maxLights : 128;
      this.liquidFunMaxCount = data.liquidFunMaxCount | 0;

      // Create lighting mesh (full-screen quad with multiply blend)
      // Shadows are now sprites, not in shader
      this.createLightingSystem();
      this._createLiquidFunLightSplat(this.liquidFunMaxCount);

      console.log(
        `PIXI WORKER: Lighting system enabled (baseAmbient: ${this.baseAmbient}, maxLights: ${this.maxLights}, resolution: ${this.lightingResolution})`
      );

    }

    // ========================================
    // RAYCASTED LIGHT OCCLUSION - Initialize
    // ========================================
    if (data.visibilityPolygons && data.visibilityPolygons.enabled) {
      this.initVisibilityPolygonSystem(data.visibilityPolygons);
    }

    // ========================================
    // SUN SYSTEM - Initialize
    // ========================================
    // Note: Sun static class is initialized by AbstractWorker.initializeCommonBuffers()
    if (Sun.isInitialized) {
      this.sunEnabled = Sun.enabled;
      console.log(`PIXI WORKER: Sun system initialized (enabled: ${this.sunEnabled})`);
    }

    // Debug visualization is handled by DebugUI on the page thread
    // This removes ~400 lines of debug rendering code from pixi_worker

    // Entity / particle / decoration sprites come from the render queue
    // (see updateSpritesFromRenderQueue); no per-slot sprite arrays in this worker.

    // ========================================
    // CUSTOM LAYER RENDERING INFRASTRUCTURE
    // ========================================
    await this.initializeCustomLayers(data);

    // ========================================
    // LAYER REFERENCES MAP - For debug UI control
    // ========================================
    this.buildLayerRefsMap();

    console.log('PIXI WORKER: Initialization complete, waiting for start signal...');
    console.log(
      `PIXI WORKER: Instanced rendering ready (entities: ${this.globalEntityCount} slots, particles: ${this.maxParticles} slots, decorations: ${this.maxDecorations} slots)`
    );

    // Note: Game loop will start when "start" message is received from Scene
  }

  // ========================================
  // CUSTOM LAYER SYSTEM
  // ========================================

  /**
   * Standard fullscreen quad vertex shader for post-processing meshes.
   * Maps NDC quad to UV space so the fragment shader can sample a RenderTexture.
   */
  _createLookShader(fragmentSource, textureSource, uniformDefs, name, layerName) {
    const asset = name || 'look';
    const layer = layerName || name || 'look';
    const backend = this._useWebGpu ? 'webgpu' : 'webgl';
    assertLookShaderCompatible({
      backend,
      layerName: layer,
      asset,
      path: asset,
      source: fragmentSource,
    });
    const backendLabel = this._useWebGpu ? 'WebGPU' : 'WebGL';
    try {
      if (this._useWebGpu) {
        // Engine prelude generates GlobalUniforms/LocalUniforms/CustomUniforms/
        // VertexOut + group(2) bindings from the layer uniform map.
        let wgslSource = fragmentSource;
        if (isWgslSource(wgslSource)) {
          const layerObj = Layer.get(layer);
          const lid = layerObj ? layerObj.id : -1;
          wgslSource = prependLookPrelude(
            wgslSource,
            Layer._uniformMaps[lid] || null,
            Layer._metadata?.layers?.[lid]?.uniformTypes || null
          );
        }
        const earlyLook = findWgslUseBeforeDeclare(wgslSource);
        if (earlyLook.length) {
          throw new Error(
            earlyLook.map((e) => `'${e.name}' used before declaration (line ${e.line})`).join('; ')
          );
        }
        const gpuProgram = lookGpuProgram(
          GpuProgram,
          wgslSource,
          asset,
          this._engineShaders.lookVert
        );
        return new Shader({
          gpuProgram,
          resources: {
            customUniforms: uniformDefs,
            uTexture: textureSource,
            uSampler: textureSource.style,
          },
        });
      }
      const lookVert = this._engineShaders.lookVert;
      if (!lookVert) {
        throw new Error(
          'WeedJS: Fullscreen look vertex shader was not loaded before look program creation.'
        );
      }
      const glProgram = GlProgram.from({
        vertex: lookVert,
        fragment: fragmentSource,
        name: asset,
      });
      return new Shader({
        glProgram,
        resources: {
          customUniforms: uniformDefs,
          uTexture: textureSource,
        },
      });
    } catch (err) {
      throw errorCompileFailed('look', asset, layer, backendLabel, err);
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
  async initializeCustomLayers(data) {
    this._destroyAllCustomLayerCompute();
    this._customLayers = {};
    if (!data.layerData) return;

    const metadata = data.layerData.metadata;
    if (!metadata?.layers) return;

    const queues = data.customLayerRenderQueues || {};
    const lfMax =
      (data.liquidFunMaxCount | 0) ||
      (this.config?.physics?.liquidFun?.maxCount | 0) ||
      10000;
    const particleMax =
      (this.config?.particle?.maxParticles | 0) || 0;

    const layerMetas = metadata.layers;
    for (let mi = 0; mi < layerMetas.length; mi++) {
      const config = layerMetas[mi];
      if (!config || config.builtIn || config.id === metadata.entitiesId) continue;

      const isLfDensity = config.densitySource === LAYER_DENSITY_SOURCE.LIQUID_FUN;
      const isCompute = !!config.compute;
      const isMesh = config.kind === LAYER_KIND.MESH;
      if (!config.hasRenderQueue && !isLfDensity && !isCompute && !isMesh) continue;

      const layerId = config.id;
      const layerName = config.name;
      const lrq = queues[layerId];
      if (!isLfDensity && !isCompute && !isMesh && !lrq) continue;

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
      if (isMesh) {
        const maxFx =
          (data.config?.physics?.maxFixturePoolSize | 0) ||
          (this.config?.physics?.maxFixturePoolSize | 0) ||
          (data.config?.physics?.maxFixtures | 0) ||
          (this.config?.physics?.maxFixtures | 0);
        const entitySlots = this.globalEntityCount | 0;
        // Fixtures or one primary shape per entity; each convex is at most 6 fans (8-2).
        fillBatch = new ColliderFillBatch({
          capacity: Math.max(1, Math.max(maxFx, entitySlots) * (MAX_POLYGON_VERTICES - 2)),
          label: `mesh-layer-${layerName}`,
          useWebGpu: this._useWebGpu,
          shaders: this._engineShaders,
          atlasSource: this._resolveAtlasSource(),
          lutSource: this._texLutSource,
        });
        fillBatch.mesh.blendMode = containerBlend;
      }
      if (lrq && maxItems > 0) {
        buffers = [
          createRenderQueueViews(lrq.dataA, maxItems),
          createRenderQueueViews(lrq.dataB, maxItems),
        ];
        batch = new InstancedSpriteBatch({
          capacity: maxItems,
          label: `custom-layer-${layerName}`,
          atlasSource: this._resolveAtlasSource(),
          lutSource: this._texLutSource,
          depthTest: layerYSort,
          useWebGpu: this._useWebGpu,
          shaders: this._engineShaders,
        });
        batch.mesh.blendMode = containerBlend;
      }

      let splatBatch = null;
      if (isLfDensity) {
        splatBatch = new LiquidFunDensitySplat({
          capacity: Math.max(1, lfMax + particleMax),
          label: `lf-splat-${layerName}`,
          blendMode: containerBlend,
          useWebGpu: this._useWebGpu,
          shaders: this._engineShaders,
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
        prevCount: 0,
        batch,
        fillBatch,
        splatBatch,
        densitySource: isLfDensity ? LAYER_DENSITY_SOURCE.LIQUID_FUN : LAYER_DENSITY_SOURCE.SPRITES,
        splat: splatCfg ? { ...splatCfg } : null,
        splatRadius: splatCfg?.radius ?? 48,
        scaleMode: Layer._normalizeScaleMode(config.scaleMode),
        containerBlend,
        rt: null,
        rtOut: null,
        shaderMesh: null,
        shader: null,
        displaySprite: null,
        uniformEntries: config.uniformMap ? Object.entries(config.uniformMap) : null,
        uniformStore: null,
        shaderBypass: false,
        meshLook: false,
        compute: null,
        lookSource: null,
      };

      if (isCompute) {
        const device = this.pixiApp.renderer.gpu?.device;
        if (!this._useWebGpu || !device) {
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
          renderer: this.pixiApp.renderer,
          lookSource: cl.lookSource,
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

      if (hasShader && config.shaderFragment) {
        const w = this.canvasWidth * resolution;
        const h = this.canvasHeight * resolution;

        if (!isCompute) {
          cl.rt = PIXI.RenderTexture.create({ width: w, height: h });
        }
        if (!isMesh) {
          cl.rtOut = PIXI.RenderTexture.create({ width: w, height: h });
        }
        this._applyCustomLayerScaleMode(cl);

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
          cl.shader = this._createLookShader(
            config.shaderFragment,
            lookSource,
            uniformDefs,
            config.shaderName || layerName,
            layerName
          );
          cl.uniformStore = cl.shader.resources?.customUniforms?.uniforms || null;
          cl.shaderMesh = this._makeLookShaderMesh(cl.shader, isMesh && this._meshLookFlipV());
        } catch (err) {
          if (err && typeof err.message === 'string' && err.message.startsWith('WeedJS:')) throw err;
          throw errorCompileFailed(
            'look',
            config.shaderName || layerName,
            layerName,
            this._useWebGpu ? 'WebGPU' : 'WebGL',
            err
          );
        }

        if (isMesh) {
          cl.meshLook = true;
          this._registerLayerDisplayObject(layerName, cl.shaderMesh, true);
          this.pixiApp.stage.addChild(cl.shaderMesh);
          console.log(
            `PIXI WORKER: Custom MESH look layer "${layerName}" initialized (resolution=${resolution}, RT=${w}x${h})`
          );
        } else {
          cl.displaySprite = new PIXI.Sprite(cl.rtOut);
          cl.displaySprite.anchor.set(0, 0);
          cl.displaySprite.position.set(0, 0);
          cl.displaySprite.scale.set(1.0 / resolution);
          this._registerLayerDisplayObject(layerName, cl.displaySprite);

          this.pixiApp.stage.addChild(cl.displaySprite);
          const densLabel = isLfDensity ? ', densitySource=liquidFun' : '';
          console.log(
            `PIXI WORKER: Custom shader layer "${layerName}" initialized (resolution=${resolution}, RT=${w}x${h}${densLabel})`
          );
        }
      } else if (fillBatch) {
        this._registerLayerDisplayObject(layerName, fillBatch.mesh, true);
        this.pixiApp.stage.addChild(fillBatch.mesh);
        console.log(`PIXI WORKER: Custom MESH layer "${layerName}" initialized`);
      } else if (batch) {
        this._registerLayerDisplayObject(layerName, batch.mesh, true);
        this.pixiApp.stage.addChild(batch.mesh);
        console.log(`PIXI WORKER: Custom layer "${layerName}" initialized (no shader)`);
      } else {
        console.warn(`PIXI WORKER: Layer "${layerName}" skipped (no shader RT and no sprite batch)`);
        continue;
      }

      this._customLayers[layerId] = cl;
    }

    this._customLayerList = Object.values(this._customLayers);
    this._bindLutToBatches();

    if (this._customLayerList.length > 0) {
      this.pixiApp.stage.sortChildren();
    }
    this._syncLayerRefsFromRuntime();
  }

  /**
   * Update all custom layer sprites from their render queues and render shader
   * layers through the two-RT pipeline (density → threshold → display).
   */
  updateCustomLayers() {
    for (let li = 0; li < this._customLayerList.length; li++) {
      const cl = this._customLayerList[li];
      if (!layerIsVisible(cl.layerId)) continue;
      const renderToRT = !!cl.rt;
      let densityMesh = null;

      if (cl.shader && Layer._uniformDirty[cl.layerId]) {
        const dirtyRef = Layer._uniformDirty[cl.layerId];
        if (Atomics.load(dirtyRef, 0) === 1) {
          Atomics.store(dirtyRef, 0, 0);
          const floats = Layer._uniformFloats[cl.layerId];
          const entries = cl.uniformEntries;
          const u = cl.uniformStore;
          if (floats && entries && u) {
            for (let ei = 0; ei < entries.length; ei++) {
              const [uName, entry] = entries[ei];
              if (entry.size === 1) {
                u[uName] = floats[entry.offset];
              } else {
                const target = u[uName];
                if (target && typeof target.set === 'function') {
                  target.set(floats.subarray(entry.offset, entry.offset + entry.size));
                } else if (target && typeof target === 'object' && target.length) {
                  for (let k = 0; k < entry.size; k++) {
                    target[k] = floats[entry.offset + k];
                  }
                }
              }
            }
          }
        }
      }

      const frameUniforms = this._computeFrame;
      frameUniforms.dt = this._lastDt || 1 / 60;
      frameUniforms.cameraX = this._renderCameraX;
      frameUniforms.cameraY = this._renderCameraY;
      frameUniforms.canvasW = this.canvasWidth;
      frameUniforms.canvasH = this.canvasHeight;
      frameUniforms.zoom = this._renderZoom;
      frameUniforms.time = (this.accumulatedTime || 0) * 0.001;
      frameUniforms.worldW = finiteOrZero(this.worldWidth);
      frameUniforms.worldH = finiteOrZero(this.worldHeight);
      applyEngineLookUniforms(cl, frameUniforms);

      const rtOpts = this._rtRenderOpts;
      if (cl.compute) {
        cl.compute.step(frameUniforms, this._computePose);
        applyComputeTexSizeUniform(cl);
        if (!cl.shaderBypass && cl.shaderMesh && cl.rtOut) {
          rtOpts.container = cl.shaderMesh;
          rtOpts.target = cl.rtOut;
          rtOpts.clear = true;
          rtOpts.clearColor = this._clearTransparent;
          this.pixiApp.renderer.render(rtOpts);
        }
      } else if (cl.densitySource === LAYER_DENSITY_SOURCE.LIQUID_FUN && cl.splatBatch) {
        const views = LiquidFun.getViews();
        const so = this._splatUploadOpts;
        so.layerId = cl.layerId;
        so.zoom = this._renderZoom;
        so.cameraX = this._renderCameraX;
        so.cameraY = this._renderCameraY;
        so.resolution = cl.resolution || 1.0;
        so.radius = cl.splatRadius || cl.splat?.radius || 48;
        so.intensity = cl.splat?.intensity ?? 1;
        so.useParticleTint = cl.splat?.useParticleTint !== false;
        so.canvasW = this.canvasWidth;
        so.canvasH = this.canvasHeight;
        cl.splatBatch.upload(views, so);
        densityMesh = cl.splatBatch.mesh;
        cl.prevCount = views?.count ? views.count[0] | 0 : 0;
      } else if (cl.batch && cl.readRef) {
        const ref = cl.readRef;
        const count = ref.count[0];
        cl.prevCount = count;
        const useSortKey = !!(cl.ySorting && ref.sortKey);
        const q = this._entityUploadQ;
        q.count = count;
        q.x = ref.x;
        q.y = ref.y;
        q.scaleX = ref.scaleX;
        q.scaleY = ref.scaleY;
        q.rotC = ref.rotC;
        q.rotS = ref.rotS;
        q.alpha = ref.alpha;
        q.tint = ref.tint;
        q.textureId = ref.textureId;
        q.anchorX = ref.anchorX;
        q.anchorY = ref.anchorY;
        q.repeatX = ref.repeatX;
        q.repeatY = ref.repeatY;
        q.tileMode = ref.tileMode;
        q.tileOffsetU = ref.tileOffsetU;
        q.tileOffsetV = ref.tileOffsetV;
        q.tileMulX = ref.tileMulX;
        q.tileMulY = ref.tileMulY;

        const opts = this._entityUploadOpts;
        opts.indices = null;
        opts.indexCount = 0;
        opts.includeType = -1;
        opts.excludeType0 = -1;
        opts.excludeType1 = -1;
        opts.depthMode = useSortKey ? BATCH_DEPTH.SORT_KEY : BATCH_DEPTH.INDEX;
        opts.depthDenom = cl.maxItems;
        opts.worldHeight = this.config?.worldHeight || 10000;
        opts.sortKey = useSortKey ? ref.sortKey : null;
        opts.texLut = this._texLut;
        opts.texLutCount = this._texLutCount;
        opts.textures = this.flatTextures;
        opts.type = ref.type;
        if (renderToRT) {
          opts.space = BATCH_SPACE.SCREEN;
          opts.zoom = this._renderZoom;
          opts.cameraX = this._renderCameraX;
          opts.cameraY = this._renderCameraY;
          opts.resolution = cl.resolution || 1.0;
        } else {
          opts.space = BATCH_SPACE.WORLD;
          opts.zoom = 1;
          opts.cameraX = 0;
          opts.cameraY = 0;
          opts.resolution = 1;
        }
        cl.batch.upload(q, opts);
        densityMesh = cl.batch.mesh;
      } else if (cl.fillBatch) {
        const views = this._ensureColliderFillViews();
        views.outU32 = cl.fillBatch.dataU32;
        let skip = this._colliderFillSkip[cl.layerId];
        if (!skip) {
          skip = this._colliderFillSkip[cl.layerId] = {
            lastRevision: COLLIDER_FILL_PACK_FIRST_FRAME,
            lastPaintEpoch: -1,
            prevPose: {},
            camX: NaN,
            camY: NaN,
            zoom: NaN,
            rtReady: false,
          };
        }
        views.lastPaintEpoch = skip.lastPaintEpoch;
        let packedThisFrame = false;
        if (!colliderFillCanSkipPack(views, skip.lastRevision, skip.prevPose)) {
          const cap = cl.fillBatch.capacity;
          if (!skip.instanceEntity || skip.instanceEntity.length < cap) {
            skip.instanceEntity = new Uint32Array(cap);
          }
          views.instanceEntity = skip.instanceEntity;
          const lastPacked = cl.prevCount | 0;
          const rev = views.fixtureRevision ? (views.fixtureRevision[0] | 0) : 0;
          const canPoseOnly =
            lastPacked > 0 &&
            skip.localsReady &&
            rev === (skip.lastRevision | 0) &&
            skip.lastRevision !== COLLIDER_FILL_PACK_FIRST_FRAME &&
            !meshFillPresenceChanged(views, skip.prevPose);
          const packed = canPoseOnly
            ? packColliderFillPoseOnly(
              cl.fillBatch.data,
              cap,
              lastPacked,
              skip.instanceEntity,
              views,
            )
            : packColliderFill(cl.fillBatch.data, cap, cl.layerId, views);
          if (!canPoseOnly) skip.localsReady = packed > 0;
          cl.fillBatch.upload(packed);
          cl.prevCount = packed;
          copyMeshFillPoseScratch(views, skip.prevPose);
          skip.lastRevision = rev;
          skip.lastPaintEpoch = views.paintEpoch ? (views.paintEpoch[0] | 0) : 0;
          clearMeshFillPaintDirty(views);
          packedThisFrame = true;
        }
        densityMesh = cl.fillBatch.mesh;
        this._meshFillInstancesThisFrame += cl.prevCount | 0;
        const camChanged =
          skip.camX !== this._renderCameraX ||
          skip.camY !== this._renderCameraY ||
          skip.zoom !== this._renderZoom;
        skip._skipRt = !packedThisFrame && !camChanged && skip.rtReady;
      } else {
        continue;
      }

      if (cl.rt && densityMesh) {
        if (cl.fillBatch) {
          const skipRt = this._colliderFillSkip[cl.layerId];
          if (!skipRt || !skipRt._skipRt) {
            this._renderMeshFillToRt(cl, densityMesh);
            this._meshRtDrawsThisFrame++;
            if (skipRt) {
              skipRt.camX = this._renderCameraX;
              skipRt.camY = this._renderCameraY;
              skipRt.zoom = this._renderZoom;
              skipRt.rtReady = true;
              skipRt._skipRt = false;
            }
          }
        } else {
          rtOpts.transform = null;
          rtOpts.container = emptyInstancedMesh(densityMesh)
            ? this._rtEmptyContainer
            : densityMesh;
          rtOpts.target = cl.rt;
          rtOpts.clear = true;
          rtOpts.clearColor = this._clearTransparent;
          this.pixiApp.renderer.render(rtOpts);
          if (!cl.shaderBypass && cl.shaderMesh && cl.rtOut) {
            rtOpts.container = cl.shaderMesh;
            rtOpts.target = cl.rtOut;
            this.pixiApp.renderer.render(rtOpts);
          }
        }
      }
    }
  }

  /**
   * Build a map of layer name -> PIXI display object for debug UI control
   * Called after all layers are initialized
   */
  buildLayerRefsMap() {
    for (let i = 0; i < this._scenery.length; i++) {
      const s = this._scenery[i];
      const name = Layer.getName(i);
      if (s?.displayObject && name) this._registerLayerDisplayObject(name, s.displayObject);
    }
    if (this.decalTileContainer) this._registerLayerDisplayObject('decals', this.decalTileContainer);
    if (this.shadowDisplaySprite) this._registerLayerDisplayObject('castedShadows', this.shadowDisplaySprite);
    if (this.spriteMesh) {
      this._registerLayerDisplayObject('entities', this.spriteMesh);
    }
    if (this._visPolyDisplaySprite) this._registerLayerDisplayObject('lighting', this._visPolyDisplaySprite);
    else if (this.lightingDisplaySprite) this._registerLayerDisplayObject('lighting', this.lightingDisplaySprite);
    else if (this.lightingMesh) this._registerLayerDisplayObject('lighting', this.lightingMesh);
    for (let i = 0; i < this._customLayerList.length; i++) {
      const cl = this._customLayerList[i];
      this._registerLayerDisplayObject(
        cl.layerName,
        cl.displaySprite || cl.shaderMesh || cl.batch?.mesh || cl.fillBatch?.mesh,
        !cl.displaySprite
      );
    }
    this._syncLayerRefsFromRuntime();

    const layerNames = Object.keys(this.layerRefs);
    console.log(
      `PIXI WORKER: Layer refs map built (${layerNames.length} layers: ${layerNames.join(', ')})`
    );
  }

  createCastedShadowsSystem(data) {
    // ========================================
    // SHADOW RENDER QUEUE - Initialize (DOUBLE BUFFERED)
    // ========================================
    if (data.shadows && data.shadows.enabled && data.shadows.renderQueueDataA && data.shadows.renderQueueDataB) {
      this.shadowSpritesEnabled = true;
      this.maxShadowRenderItems = data.shadows.maxRenderItems;

      const maxItems = this.maxShadowRenderItems;

      // Create typed array views for BOTH shadow buffers
      const shadowSABs = [data.shadows.renderQueueDataA, data.shadows.renderQueueDataB];

      for (let bufIdx = 0; bufIdx < 2; bufIdx++) {
        const sab = shadowSABs[bufIdx];
        let offset = 0;

        const buffer = {
          count: new Int32Array(sab, offset, 1),
        };
        offset += 4;

        buffer.x = new Float32Array(sab, offset, maxItems);
        offset += maxItems * 4;

        buffer.y = new Float32Array(sab, offset, maxItems);
        offset += maxItems * 4;

        buffer.scaleX = new Float32Array(sab, offset, maxItems);
        offset += maxItems * 4;

        buffer.scaleY = new Float32Array(sab, offset, maxItems);
        offset += maxItems * 4;

        buffer.rotC = new Float32Array(sab, offset, maxItems);
        offset += maxItems * 4;

        buffer.rotS = new Float32Array(sab, offset, maxItems);
        offset += maxItems * 4;

        buffer.alpha = new Float32Array(sab, offset, maxItems);
        offset += maxItems * 4;

        buffer.tint = new Uint32Array(sab, offset, maxItems);
        offset += maxItems * 4;

        buffer.textureId = new Uint16Array(sab, offset, maxItems);
        offset += maxItems * 2;

        offset = Math.ceil(offset / 4) * 4;

        buffer.anchorX = new Float32Array(sab, offset, maxItems);
        offset += maxItems * 4;

        buffer.anchorY = new Float32Array(sab, offset, maxItems);

        this.shadowRenderQueueBuffers[bufIdx] = buffer;
      }

      // Set initial read buffer (same as main queue)
      this._setShadowReadBuffer(0);

      // Create shadow RenderTexture system
      this.createShadowSpriteSystem();

      console.log(`PIXI WORKER: Double-buffered shadow render queue enabled (${maxItems} max items)`);
    }
  }
}

// Create singleton instance and setup message handler
self.pixiRenderer = new PixiRenderer(self);
