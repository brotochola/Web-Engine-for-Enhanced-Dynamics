self.postMessage({
  msg: 'log',
  message: 'js loaded',
  when: Date.now(),
});

// pixi_worker.js - PixiJS instanced renderer. Consumes pre_render render-queue SAB.

// Import engine dependencies

import { cameraFloorScaleY, cameraHeightScaleY } from '../util/cameraView.js';
import { Transform } from '../components/transform.js';
import { debugWorkerLog } from '../util/debugLog.js';
import { RigidBody } from '../components/rigidBody.js';

import { Collider } from '../components/collider.js';
import { ColliderFixture } from '../core/colliderFixture.js';
import { ParticleComponent } from '../components/particleComponent.js';
import { DecorationComponent } from '../components/decorationComponent.js';
import { DecorationPool } from '../core/decorationPool.js';
import { SpriteSheetRegistry } from '../core/spriteSheetRegistry.js';
import { AbstractWorker } from './abstractWorker.js';
import { bindBox2dHotFields } from '../box2d/box2dHotFields.js';
import { bindCommandRing } from '../box2d/box2dCommandRing.js';

import { LightEmitter } from '../components/lightEmitter.js';
import { SpriteRenderer } from '../components/spriteRenderer.js';
import { ShadowCaster } from '../components/shadowCaster.js';
import { VolumeShadowCaster } from '../components/volumeShadowCaster.js';
import { MeshRenderer } from '../components/meshRenderer.js';
import { MeshGeometry } from '../core/meshGeometry.js';
import { meshUvFillProgram } from '../render/meshUvFillBatch.js';
import { Sun } from '../core/sun.js';

import {
  DEFAULT_LAYERS,
  RENDERER_DEFAULTS,
  LIGHTING_DEFAULTS,
  LAYER_FEEDER_KIND,
  LIGHT_CULLING_TILE_SIZE_MAX,
  LIGHT_CULLING_TILE_SIZE_MIN,
  SHADOW_SAMPLES_MAX,
  SELF_SHADOW_MARCHES,
  lightCullingTileSizeOf,
  selfShadowMarchOf,
  shadowSamplesOf,
} from '../util/configDefaults.js';
import { Layer } from '../core/layer.js';
import { meshLookFullscreenUvs } from '../render/meshLookUv.js';
import { applyMipmapBias } from '../render/mipmapBias.js';
import { applyPixelSnap } from '../render/pixelSnap.js';
import { gbufWanted, writeGbufWords } from '../render/gbufWord.js';
import { unshadedQuadPositions } from '../render/unshadedComposite.js';
import {
  RENDER_VIEW,
  RENDER_TILES_FRAG,
  RENDER_VIEW_FRAG,
  RENDER_VIEW_HEIGHT_PX,
  RENDER_VIEW_VERT,
  RENDER_VIEW_Z,
  availableRenderViews,
  renderTilesGpuProgram,
  renderViewGpuProgram,
  renderViewTextures,
} from '../render/renderViews.js';
import { wallEdgesWanted } from '../render/lightEdges.js';
import { additiveFragGlsl } from '../render/shaderVariants.js';
import { createViews as createRenderQueueViews, createRenderQueueCameraViews } from '../render/renderQueueLayout.js';
import {
  GPU_SPRITE_FLOATS,
  GPU_HDR_SPRITE,
  GPU_HDR_GLOW,
  GPU_HDR_PARTICLE,
  GPU_HDR_FLAGS,
  GPU_QUEUE_VERSION,
  GPU_HDR_VERSION,
  GPU_HDR_STATIC_GEN,
  GPU_FLAG_SORTED,
  GPU_FLAG_SPLIT,
  GPU_FLAG_INDEXED,
  GPU_FLAG_GBUF,
  GPU_HDR_INDEXED_ROWS,
  GPU_HDR_IXUP,
  GPU_HDR_IXUP_GEN_A,
  GPU_HDR_IXUP_GEN_B,
  GPU_HDR_IXUP_ROWS_A,
  GPU_HDR_IXUP_ROWS_B,
  GPU_HDR_IXUP_TEX,
  GPU_HDR_SLOTS_GEN,
  GPU_INDEXED_SLOT_FLOATS,
  GPU_INDEXED_STATIC_FLOATS,
  gpuIndexedStaticRows,
  createGpuQueueViews,
} from '../render/gpuQueueLayout.js';
import { stashResizeWhileHidden, takePendingResize } from '../util/utils.js';
import { takePublishedList } from '../util/publishedList.js';
import { bindMeshPoseList, takeMeshPoseList, MESH_POSE_FLOATS } from '../util/meshPoseList.js';
import {
  InstancedSpriteBatch,
  INSTANCED_SPRITE_FLOATS,
  POSE_STATIC_FLOATS,
  SPLIT_POSE_FLOATS,
  BATCH_SPACE,
  BATCH_DEPTH,
  TEX_LUT_FLOATS,
  textureLutSolid,
  textureLutTexels,
} from '../render/instancedSpriteBatch.js';
import { bindPainterRadix, createWasmPainterState, painterSlotList } from '../render/painterRadixClient.js';
import { keyedColumnTextures } from '../render/sunShadowMap.js';
import { resolveParticleLights } from '../render/particleLightSplat.js';
import { LiquidFun } from '../core/liquidFun.js';
import { releasePixiBindGroupsOnResource } from '../render/releasePixiBindGroups.js';
import { rtPixelSize } from '../render/gpuShadowCasters.js';

/** Instanced Mesh with instanceCount 0 still GPU-draws if visible / used as RT root. */
function setDisplayVisible(obj, on) {
  if (!obj) return;
  obj.visible = !!on && !emptyInstancedMesh(obj);
}

/**
 * A sprite queue's columns as a pack reads them (_bindSpriteQueue fills it each frame), every field there from the start
 * (N-303 CR-32: type, sortKey, the shadow terms and key were added on the first frame, a new map for every function that
 * had seen the object).
 */
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
    type: null,
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
    sortKey: null,
    shadowH: null,
    shadowOffX: null,
    shadowOffY: null,
    // E-82: the queue's staticGen column, or null (a queue whose statics are not counted).
    staticGen: null,
    key: null,
  };
}

import { bindDecalPremultiply } from '../render/decalPremultiplyClient.js';
import {
  normalizeRendererBackend,
  errorPixiTypeMismatch,
  errorMissingGpuDevice,
  errorShaderFetchFailed,
  shaderSourceLf,
  pixiRendererTypeName,
  RENDERER_BACKEND_WEBGPU,
  ySortEnabled,
  resolveSpritePipeline,
  PACK_GPU_SPRITES_PIXI,
  SORT_SPRITES_NONE,
  WEBGPU_DEFAULT_STORAGE_BINDING,
} from '../render/rendererBackend.js';
import { requestWeedGpu } from '../render/webgpu/requestGpuDevice.js';
import { loadMark, takeLoadMarks } from '../util/loadMarks.js';
import { PixiAssets } from '../render/pixi/assets.js';
import { PixiScenery } from '../render/pixi/scenery.js';
import { PixiMeshLayers, emptyInstancedMesh } from '../render/pixi/meshLayers.js';
import { PixiCustomLayers } from '../render/pixi/customLayers.js';
import { PixiLookPasses } from '../render/pixi/lookPasses.js';
import { PixiLookShaders } from '../render/pixi/lookShaders.js';
import { PixiGlowLayer } from '../render/pixi/glowLayer.js';
import { PixiShadowMaps } from '../render/pixi/shadowMaps.js';
import { PixiLampMap } from '../render/pixi/lampMap.js';
import { PixiLighting } from '../render/pixi/lighting.js';
import { PixiDecalTiles } from '../render/pixi/decalTiles.js';
import { PixiScreenLayers } from '../render/pixi/screenLayers.js';
import { layerIsVisible } from '../render/pixi/layerHelpers.js';
import { packSpriteLayer } from '../render/packSpriteLayer.js';
import { GPU_KEYED_ROW_WORDS, bindGpuPack } from '../render/gpuPackClient.js';
import { createStaticsScatterGl, scatterStaticsGl } from '../render/webgl/staticsScatterGl.js';
import { poseBlockFloats } from '../render/spriteIndexed.js';
import { createStaticsScatterGpu, scatterStaticsGpu } from '../render/webgpu/staticsScatterGpu.js';
import { createPrivateArena } from '../render/sharedCopy.js';
import { GpuFramePacer } from '../render/gpuFramePacer.js';
import { OPAQUE_POSE_TEXELS, opaquePassOn } from '../render/opaquePass.js';
import {
  GPU_UNKNOWN, gpuClassOf, gpuVendorOf, offscreenWebglRendererName, webglRendererName, webgpuGpu,
} from '../render/gpuClass.js';

// Bundles embed the engine shaders (WEED.EngineShaders, posted at init): an npm
// install has no /src/shaders to fetch. Source builds fetch them. Either way their includes are resolved here
// (N-303 CR-15, shaderChunks.js).
let embeddedEngineShaders = null;

function fetchEngineShader(path) {
  if (embeddedEngineShaders !== null && embeddedEngineShaders[path] !== undefined) {
    return Promise.resolve(withShaderChunks(shaderSourceLf(embeddedEngineShaders[path])));
  }
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
    return withShaderChunks(shaderSourceLf(s));
  });
}

/**
 * The blend mode Pixi draws a mesh with as a child: its own, or the nearest parent's where it inherits (Pixi's
 * groupBlendMode); normal at the top.
 */
function drawnBlendMode(container) {
  for (let c = container; c; c = c.parent) {
    const mode = c.localBlendMode;
    if (mode && mode !== 'inherit') return mode;
  }
  return 'normal';
}

import { RENDERER_STATS, createStatsWriter } from '../util/workersUtils.js';
import { Time } from '../core/timeScale.js';
import { GpuParticles } from '../core/gpuParticles.js';
import {
  PROXY, PROXY_CAMERA, PROXY_KIND, PROXY_MAX_ENTRIES, ProxyCollector, bindProxyHalves, localProxyHalf, proxyView,
} from '../render/gpuParticleProxies.js';
import { EntityChunks, RegionQuads } from '../render/gpuParticleChunks.js';
import { LagMeter, stampNow } from '../util/latencyStamp.js';
import { addWaitMs, waitMeterMs } from '../util/waitMeter.js';
import { withShaderChunks } from '../render/shaderChunks.js';

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
  Buffer,
  BufferUsage,
  UniformGroup,
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

/** E-475: the longest the worker waits for its programs' links before it reports ready (a driver that never answers). */
const LINK_AHEAD_WAIT_MS = 20000;
/** N-458: how long the renderer's boot waits for a WebGL context lost while it ran. */
const BOOT_RESTORE_WAIT_MS = 10000;

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
    this._presenting = true;
    this._presentingFlag = null;
    // E-97. Frames in flight on the GPU: a tick submits nothing while the frame before last is
    // unfinished. Bound to the WebGL2 context or the WebGPU device once the renderer exists;
    // _pacedTick marks a tick that submitted nothing, which publishes no stats.
    this._framePacer = new GpuFramePacer();
    this._pacedTick = false;
    // W9d. With packGpuSprites 'pixi' and no pose interpolation, the entity batch's rows live in the
    // render-queue memory (the view below) and gpuPack.wasm packs them, on Pixi's own scratch.
    this._pixiGpuPack = null;
    this._pixiInstanceRows = null;
    // E-177: the render-queue memory's keyed regions for the entity batch (renderQueueMemory.js pixiKey*), or null.
    this._pixiKeyed = null;
    // N-256 PW-8: the sun's and the lamps' shadow maps and the casters' passes (src/render/pixi/shadowMaps.js).
    this.shadowMaps = new PixiShadowMaps(this);
    // N-256: the lamps' shadow map, its tiles, passes and volumes' cache (src/render/pixi/lampMap.js).
    this.lampMap = new PixiLampMap(this);
    // The statics scatter's GL objects (_scatterStaticsGl), made on its first call.
    this._staticsScatterGl = null;
    // E-187: the keyed statics scatter's pipelines and buffers on WebGPU (staticsScatterGpu.js), made on first use.
    this._staticsScatterGpu = null;
    // E-514: an indexed frame's lists of the statics rows that changed, as commitIndexed takes them (the GPU queue
    // header's GPU_HDR_IXUP*, the queue's update regions).
    this._ixCommit = {
      updates: new Uint32Array(0), texUpdates: new Uint32Array(0), count: -1, texCount: 0, genA: 0, rowsA: 0, genB: 0, rowsB: 0,
    };
    // E-475: the WebGL programs made while the worker starts (GlProgram.weedMade), linked together before it reports
    // ready (_linkProgramsAhead).
    this._madePrograms = [];
    // SST-1: the backend (rendererBackend.js) and the engine shaders' sources by key, from boot; an error boot met, which
    // initialize reports (null: none).
    this._useWebGpu = false;
    // N-301: true while loseGpuForTest's destroy() of the WebGPU device stands for a real loss.
    this._gpuLossTest = false;
    this._engineShaders = {};
    this._bootError = null;
    // The glow batch's rows in the render-queue memory (pixi pack mode), or null.
    this._pixiGlowRows = null;
    // W30. The batches Pixi fills from the render-queue memory keep their arrays in private WebAssembly.Memories, copied
    // into by memory.copy (_batchArena, sharedCopy.createPrivateArena); the memory they copy from.
    this._renderQueueMemory = null;
    // W10. With sortSprites 'pixi', the ENTITIES painter state and its slot lists live in the render-queue
    // memory and painterRadix.wasm sorts them there (painterRadixClient.bindPainterRadix).
    this._painterWasm = null;
    this._pendingResizeW = null;
    this._pendingResizeH = null;
    this._surfaceUnconfigured = false;
    this._pixiPresent = null;

    // Renderer configuration options (set during initialize)
    this._ySort = false;
    this._ySortMode = false;
    this._entitiesRoot = null;
    // E-448: whether the last frame drew the entities in chunks around GPU particle groups (_applyProxies), which the
    // opaque pass cannot.
    this._entityChunksActive = false;
    // E-502: the WebGL renderer's name, its class and maker (gpuClass.js), read at GL init, and whether the opaque pass
    // may draw on it (opaquePass.js opaquePassOn, with debug.opaquePass).
    this._gpuRendererName = '';
    this._gpuClass = GPU_UNKNOWN;
    this._gpuVendor = '';
    this._opaqueOn = true;
    this._lightGlowAdd = true;
    // _refusePackedFrame said its reason.
    this._refusedFrameWarned = false;
    // The pipeline's sorter (resolveSpritePipeline): 'none' when nobody orders the sprites.
    this._sortSpritesOn = SORT_SPRITES_NONE;

    // PIXI application and rendering
    this.pixiApp = null;
    /** @type {InstancedSpriteBatch|null} */
    this.entitiesBatch = null;
    /** @type {InstancedSpriteBatch|null} light-glow (type=3) ADD batch */
    this.entitiesGlowBatch = null;
    this.spriteMesh = null; // entitiesBatch.mesh alias for layer refs
    this.spriteGlowMesh = null; // entitiesGlowBatch.mesh
    /** @type {GpuParticleLayerBatch[]} */
    this._gpuParticleBatches = [];
    // WebGL: the rings' record textures, made and filled here (E-157); null until the first GPU particle layer.
    this._gpuRecordTextureOps = null;
    // GPU particle groups among the entities (gpuParticleProxies.js): the sortWithEntities layers by id, as
    // { layerId, cl, batch, regions }, the entities batch in chunks, and the frame's entries. Pre-render's split
    // halves when it packs the entities; Pixi's own half and collector when Pixi packs them.
    this._proxyLayers = [];
    this._proxyLayerList = [];
    this._entityChunks = null;
    this._proxyHalves = null;
    this._proxyReadHalf = 0;
    this._proxyLocal = null;
    this._proxyCollector = null;
    // The proxies' camera and culled view (gpuParticleProxies.js proxyView), and the sim clock: typed arrays, so
    // no double crosses a call.
    this._proxyCamera = new Float64Array(6);
    this._proxyView = new Float64Array(4);
    this._gpuClock = new Float64Array(1);
    this._proxyApplyHalf = null;
    this._proxyDrawEntry = null;
    this._proxyMatrix = new Matrix();
    this._proxiesOn = false;
    this._rqIdxEntity = null;
    this._rqIdxGlow = null;
    /** SST-0: true until the first frame drawn once the game runs posts this worker's load marks. */
    this._loadMarksOpen = true;
    // N-256 PW-5: the scenery layers (static, cover, tiling, tilemap) and their camera (src/render/pixi/scenery.js).
    this.scenery = new PixiScenery(this);

    /** From renderer.autoGenerateMipmaps at boot (null: on with a linear atlas) — applied at ImageSource create */
    this.autoGenerateMipmaps = false;
    /** From renderer.atlasScaleMode. bigAtlas + loose textures. Both sprite passes share it. */
    this.atlasScaleMode = RENDERER_DEFAULTS.atlasScaleMode;
    /** From renderer.pixelSnapCorners (N-302): with a nearest atlas, an axis-aligned sprite's corners on the pixel grid. */
    this.pixelSnapCorners = RENDERER_DEFAULTS.pixelSnapCorners;

    // N-256 PW-1: the textures, the spritesheets, the tileset textures, the atlas and its tables (src/render/pixi/assets.js).
    this.assets = new PixiAssets(this);

    // Per-frame subtimers (ms) — written to RENDERER_STATS in reportFPS
    this.lightsTimeThisFrame = 0;
    this.shadowsTimeThisFrame = 0;
    this.spritesTimeThisFrame = 0;
    this._lastUploadMs = 0;
    this._newQueueThisFrame = 0;
    this.sortTimeThisFrame = 0;
    this.queueTimeThisFrame = 0;
    this.presentTimeThisFrame = 0;
    this.customLayersTimeThisFrame = 0;
    this.miscTimeThisFrame = 0;
    this._gpuPassesThisFrame = 0;
    this._gpuCastersThisFrame = 0;
    this._gpuShadowLightsThisFrame = 0;

    // Entity / particle / decoration rendering goes through the render queue
    // (see updateSpritesFromRenderQueue). Animation/texture selection happens in
    // pre_render_worker, which writes resolved textureIds into the queue.
    this.maxParticles = 0;
    // N-136: the active particles' published list (header and three copies, bound at init); empty when the worker was
    // handed one list.
    this.activeParticlesCtl = new Int32Array(0);
    this.activeParticlesCopies = [];
    this.maxDecorations = 0;
    this.visibleDecorationCount = 0;

    // World and viewport dimensions
    this.worldWidth = 0;
    this.worldHeight = 0;
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.canvasView = null;

    // Draw call tracking
    this.drawCallCount = 0;
    this.visibleEntityCount = 0;
    this.visibleParticleCount = 0;

    // ========================================
    // RENDER QUEUE SYSTEM (DOUBLE BUFFERED)
    // ========================================
    // Pre-sorted, screen-visible renderables from pre_render_worker
    // pixi_worker NEVER waits - reads the oldest unread ready buffer
    // pre_render skips a frame if >1 ahead (backpressure)
    this.renderQueueEnabled = false;
    this._queueBackpressure = true;
    // E-198: whether Pixi waits for this vsync's queue (renderer.waitForQueue), the frame it may wait again from after a
    // timeout, its own step without the wait (an average), and the wall time between its frames (an average).
    this._queueWait = false;
    this._queueWaitOffUntil = 0;
    this._queueWaitStepMs = NaN;
    this._queueWaitPeriodMs = NaN;
    this._queueWaitLastStart = NaN;
    /** E-201: renderer.keyedPosesByRow (the entity batch's keyed frames drawn by queue row). */
    this._keyedPosesByRow = false;
    /** N-138: pre-render's lists of the poses its sprites that have a mesh were drawn at, one per queue buffer. */
    this._meshPoseLists = [];
    /** Per entity, the frame whose sprite pose _meshQueuePose holds (x, y, rotC, rotS); the mesh fill takes it. */
    this._meshQueueStamp = new Int32Array(0);
    this._meshQueuePose = new Float32Array(0);
    this.renderQueueMaxItems = 0;

    // Double buffer storage - views for both buffers
    this.renderQueueBuffers = [null, null];
    this.gpuQueueBuffers = [null, null];
    this._gpuQueueRead = null;
    this._sortKeyU32ByBuf = [null, null];
    this._sortKeyU32 = null;
    this.renderQueueCameraBuffers = [null, null];
    this.renderQueuePoseReadyBuffers = [null, null];
    // E-197: each queue buffer's latency stamp, the one of the queue drawn, and the meter.
    this.renderQueueStampBuffers = [null, null];
    this._queueStamp = 0;
    this._lagMeter = new LagMeter();

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

    // N-256 PW-10: the SCREEN layers' passes over the finished frame (src/render/pixi/screenLayers.js).
    this.screenLayers = new PixiScreenLayers(this);
    this._layerRuntime = Object.create(null); // layerName -> display object
    this._sunLayers = []; // layers with alphaBySun: { layerId, name, spec }
    this._layerSunFactor = new Float32Array(0); // by layer id: the sun's factor on its alpha (1 without alphaBySun)
    this.layerRefs = {};

    // ========================================
    // FLAT TEXTURE LOOKUP (Zero-cost texture resolution)

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
    // N-256 PW-10: the decal grid's tiles: their draws, cull and uploads (src/render/pixi/decalTiles.js).
    this.decalTiles = new PixiDecalTiles(this);
    this._decalTilesDirtyThisFrame = 0;
    this._decalTilesUploadedThisFrame = 0;

    // SharedArrayBuffer views (shared with particle_worker)
    this.decalsTilesDirty = null; // Uint8Array - dirty flags (0=clean, 1=modified)
    // E-272: the same flags four to a word, for the frame's count (an empty array of its class until decals bind).
    this._decalDirtyWords = new Uint32Array(0);

    // PIXI rendering
    this.decalTileContainer = null; // Container for the decal tiles' meshes

    // ========================================
    // LIGHTING SYSTEM
    // ========================================
    // Full-screen shader mesh for dynamic lighting (multiply blend)
    // Configured via config.lighting: { enabled, baseAmbient }
    this.lightingEnabled = false;
    // N-256 PW-6: the light pass, its lights, tiles, splats, walls, face map, G-buffer and composites (src/render/pixi/lighting.js).
    this.lighting = new PixiLighting(this);
    this.baseAmbient = 0.05; // Base ambient light level (0-1), read from config (night/minimum light)
    this.maxLights = 128; // Light-data texture width / capacity (config.lighting.maxLights)
    this.maxShadowCastingLights = LIGHTING_DEFAULTS.maxShadowCastingLights;
    this.lightingResolution = 1.0; // Resolution multiplier for lighting (e.g. 0.5 for half res)
    // DX-GBUF (plan §6.4): lighting.gbuffer 'mrt': the face map and the ids map drawn in one pass, a render target with both
    // as colour targets (made once they are, remade with them); 'pass' (default): a pass each.
    this._gbufMrt = false;
    // DBG-5 (renderViews.js): the debug UI's render view, 0 the final picture: the only per-frame cost while it is 0. The
    // view's quad, its uniforms and its vertex buffer are made on first use and released when the view goes back to 0.
    this._renderView = 0;
    this._renderViewOpacity = NaN;
    this._renderViewMesh = null;
    this._renderViewQuad = new Float32Array(8);
    this._renderViewQuadBuffer = null;
    this._renderViewParams = new Float32Array(4);
    this._renderViewUniforms = null;
    this._renderViewPair = [null, null];
    // DBG-7: the light tiles view, a quad of its own over the tiles' R32UI texture; made on first use as the other.
    this._renderTilesMesh = null;
    this._renderTilesUniforms = null;
    this._renderTilesGrid = new Float32Array(4);
    this._renderTilesWords = new Float32Array(4);
    this._renderTilesCanvas = new Float32Array(4);
    this._renderTilesQuad = new Float32Array(8);
    this._renderTilesQuadBuffer = null;
    // N-256 PW-9: the light glows' layer in a target of its own (src/render/pixi/glowLayer.js).
    this.glowLayer = new PixiGlowLayer(this);
    // DX-SHADOW3D, E-531: with shadows on, the sun's shadow map (src/render/sunShadowMap.js), its pass and terms.
    this._sunMapOn = false;
    // DX-SHADOW3D (F7), E-531: with shadows on, a shadow map a lamp (lampShadowMap.js), tiles in an atlas.
    this._lampMapOn = false;
    // E-508: the lamps' volumes' cache (lampVolumeCache.js): lighting.lampMapCache; the volumes' program into its two
    // colours; its plan; its target (two colour textures, a slot a still lamp's floor half, and a depth buffer), its
    // slots and their layout; the copy's mesh into the lamps' map; the volumes' epoch (it moves when a volume, the
    // volumes' layers or their scales move) and what it was taken from.
    this._lampCacheOn = true;
    this._lampTileSize = 256;
    /** N-196: lampShadowTile 'auto' (the tile follows the widest casting lamp's reach and the shadows' resolution). */
    this._lampTileAuto = false;
    /** DX-PIXELSHADOW: lighting.pixelArt (each world pixel lit whole, the maps read with one tap). */
    this._pixelArtLight = false;
    this._selfShadowOn = false; // DX-SELFSHADOW: lighting.selfShadow, WebGL for now
    /** E-423: lighting.selfShadowMarch, the self-shadow's walk: 'steps' or 'dda' (selfShadowMarchOf). */
    this._selfShadowMarch = LIGHTING_DEFAULTS.selfShadowMarch;
    this.sunMapRT = null;
    // N-317: the sun map reaches past the screen so a pixel near its edge finds its ray's landing (sunMapMargins): the
    // margins it was made with (texels: left, top, right, bottom), the ones this frame needs, the light pass's uv into it
    // (uSunMapRect: the screen's uv times xy plus zw), the atlas's tallest frame (screen px, with the texture LUT) and the
    // camera its passes draw from (world px, doubles).
    this._sunMapMargins = new Int32Array(4);
    // DX-BARRIOS: faces have no switch. Whether the light pass reads the face map, whether the faces-in-use word was acted
    // on (_useFaces), whether this scene's light can take faces (lit); the px a px of height rises (the
    // camera's); the faces' light terms (uFaceLight: heightScaleY, 0, 0, the sun's direct share 1 - Sun.skyLight) and what a
    // sprite's own normals take (uNormalShade, OL-6: lighting.normalShading's strength and subtract for the sun, then
    // for the lamps).
    this._facesOn = false;
    this._facesUsed = false;
    this._facesWatch = false;
    this._heightScaleY = NaN;
    /** lighting.lightCullingTileSize: the tiles' side asked for, px of the light pass's target (lightCullingTileSizeOf). */
    this._lightCullingTileSize = LIGHTING_DEFAULTS.lightCullingTileSize;
    /** lighting.shadowSamples: the shadow maps' taps a light pixel averages, 1 to 9 (shadowSamplesOf). */
    this._shadowSamples = LIGHTING_DEFAULTS.shadowSamples;
    // E-259: each float data source's GL texture once allocated, and its size: later uploads are a texSubImage2D on it.
    this._floatTexHeld = new WeakMap();
    // config.camera.floorScaleY and its inverse: light falloff measures the floor distance
    // sqrt(dx² + (dy / groundScaleY)²). Doubles from the start (NaN until the config is read).
    this._groundScaleY = NaN;
    this._groundInvScaleY = NaN;
    this.liquidFunMaxCount = 0;

    // ========================================
    // SUN / DIRECTIONAL LIGHT
    // ========================================
    // Sun provides global ambient light that varies with time of day
    // Reads from SharedArrayBuffer via static Sun class (initialized by AbstractWorker)
    this.sunEnabled = false;

    // Shadows on (lighting.shadowsEnabled): the sun's and the lamps' maps (shadowMaps.js), at lighting.shadowResolution.
    this.shadowsEnabled = false;
    this.shadowResolution = LIGHTING_DEFAULTS.shadowResolution;

    // Reusable camera render-state
    this._renderCameraX = 0;
    this._renderCameraY = 0;
    this._renderCameraRot = 0;
    this._renderZoom = 1.0;
    this._cameraInitialized = false;
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
      // DX-GBUFSHADER: the G-buffer's size a SCREEN pass reads it at (0 for the other looks).
      gbufW: 0,
      gbufH: 0,
    };
    this._clearTransparent = [0, 0, 0, 0];
    this._rtEmptyContainer = new Container();
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
    this._particleLightsEnabled = false;
    this._particleLightMax = 0;
    this._rtRenderOpts = {
      container: null,
      target: null,
      transform: null,
      // N-272: the area of the target drawn (the face map's pass only; null: the whole target).
      frame: null,
      clear: true,
      clearColor: this._clearTransparent,
      // DX-POST: true only while the stage is drawn into the SCREEN passes' frame on WebGL (the canvas's projection).
      flipY: false,
    };
    this._rtRenderOptsNoClear = {
      container: null,
      target: null,
      clear: false,
    };

    this._colliderFillViews = null;
    this._colliderFillMeshBitsCached = 0;
    this._colliderFillLayerCount = -1;
    // N-256 PW-3: the custom layers' runtimes, targets, look shaders and compute passes (src/render/pixi/customLayers.js).
    this.customLayers = new PixiCustomLayers(this);
    // N-256: the custom layers' look shaders, made, swapped and unbound (src/render/pixi/lookShaders.js).
    this.lookShaders = new PixiLookShaders(this);
    // DX-LAYERPASSES: the passes of a look before its last one (src/render/pixi/lookPasses.js).
    this.lookPasses = new PixiLookPasses(this);
    // N-256 PW-4: the MESH layers' memory, kernels, UV batches and look composite (src/render/pixi/meshLayers.js).
    this.meshLayers = new PixiMeshLayers(this);

    // Reusable matrices for low-res rendering
    this._meshRtTransform = new PIXI.Matrix();

    // Everything later paths write, declared here (N-32, as in pre-render). A
    // field first written after the loop starts (first pause, first decal, a
    // missing texture) changes this object's hidden class
    // and V8 drops every optimized method that checked the old one. Values have
    // the kind of the first write: a double field must start as a double, or
    // its first fractional write moves the object to a new map anyway.
    this.renderQueueTileMode = null;
    this.renderQueueTileOffsetU = null;
    this.renderQueueTileOffsetV = null;
    this.renderQueueTileMulX = null;
    this.renderQueueTileMulY = null;
    this.renderQueueShadowH = null;
    this.renderQueueShadowOffX = null;
    this.renderQueueShadowOffY = null;
    this.renderQueueStaticGen = null;
    // E-177: the rows' statics keys (renderQueueLayout's key), which the keyed frames pack by.
    this.renderQueueKey = null;
    this._loggedSwapchainBind = false;
    this._renderQueueBindSrc = null;
    this._pixiLayerPack = null;
    this._pixiEntityPack = null;
    this._addSortMs = null;
    this._writeLayerSprites = null;
    this._writeEntitySprites = null;
    this._writeEntityGlow = null;
    this._packBatch = null;
    this._packGlowBatch = null;
    this._packQ = null;
    this._painter = null;
    this._lastDt = 1 / 60;
    this._deferredRenderQueueRelease = 0;
    /** W21c: the decal premultiply kernel, on the decal memory the tiles live in. */
    this._decalPremultiply = null;
    this.gpuCasterBatch = null;
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
    this.renderQueueShadowH = buffer.shadowH;
    this.renderQueueShadowOffX = buffer.shadowOffX;
    this.renderQueueShadowOffY = buffer.shadowOffY;
    this.renderQueueStaticGen = buffer.staticGen || null;
    this.renderQueueKey = buffer.key || null;
    this.renderQueueType = buffer.type;
    this.renderQueueSortKey = buffer.sortKey;
    this._sortKeyU32 = this._sortKeyU32ByBuf[bufferIdx];
    this.renderQueueCamera = this.renderQueueCameraBuffers[bufferIdx];
    this.renderQueuePoseReady = this.renderQueuePoseReadyBuffers[bufferIdx];
    const stampView = this.renderQueueStampBuffers[bufferIdx];
    this._queueStamp = stampView ? stampView[0] : 0;
    this._gpuQueueRead = this.gpuQueueBuffers ? this.gpuQueueBuffers[bufferIdx] : null;
  }

  /**
   * Hook into WebGL context to count draw calls per frame
   */
  setupWebGLHooks() {
    if (this._useWebGpu) {
      // E-97b. Pixi's WebGPU renderer owns the device; nothing else here hooks it.
      this._framePacer.bindDevice(this.pixiApp.renderer?.gpu?.device);
      return;
    }
    this.setupDrawCallMonitoring();

    const gl = this.pixiApp.renderer.gl;
    this._framePacer.bindGl(gl);
  }

  /**
   * N-301: the page's canvas says when its WebGL context goes and comes back, from before Pixi makes it (N-458). The page
   * restarts the scene from a save of the running world once the context is back (the default prevented, so the browser may
   * restore it); this worker's GPU side is not rebuilt in place. A context lost before Pixi is up is boot's to wait for
   * (_startPixi), and the page hears nothing.
   */
  _watchGlContext() {
    const canvas = this.canvasView;
    canvas.addEventListener(
      'webglcontextlost',
      (e) => {
        e.preventDefault();
        if (this.pixiApp === null) return;
        this._framePacer.reset();
        console.warn('[WeedJS] the WebGL context was lost (a driver reset, a GPU switch, too many contexts)');
        self.postMessage({ msg: 'gpuLost', backend: 'webgl' });
      },
      false
    );

    canvas.addEventListener(
      'webglcontextrestored',
      () => {
        if (this.pixiApp === null) return;
        this._framePacer.reset();
        this.scenery.invalidateTilemapCaches();
        self.postMessage({ msg: 'gpuRestored', backend: 'webgl' });
      },
      false
    );
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
      // N-155: opaque, as the WebGL canvas is in effect (its back buffer starts at alpha 1 and every blend keeps it there).
      // Premultiplied let the page show through wherever a blend lowered the alpha: Pixi's 'add' on WebGPU takes
      // src-alpha, one-minus-src-alpha for alpha (WebGL's add is one, one), so a light's glow on an ADD layer drew a
      // brighter core on WebGPU (lightGallery's lamp 8, up to 52/255).
      alphaMode: 'opaque',
    });
    if (source) source._gpuContext = context;
    this._surfaceUnconfigured = false;
    const gpuRt = renderer.renderTarget.getGpuRenderTarget(viewRt);
    gpuRt.contexts[0] = context;
    if (!this._loggedSwapchainBind) {
      this._loggedSwapchainBind = true;
      debugWorkerLog(
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

  /**
   * WebGL's draw calls counted per frame, only with collectDetailedStats: the count is read then alone
   * (RENDERER_STATS.DRAW_CALLS), and each wrapped draw allocates its rest array (N-303 CR-30).
   */
  setupDrawCallMonitoring() {
    if (this._useWebGpu || !this.collectDetailedStats) return;
    const gl = this.pixiApp.renderer.gl;
    if (!gl) {
      console.warn('PIXI WORKER: Could not access WebGL context for draw call monitoring');
      return;
    }
    const renderer = this;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      if (typeof gl[name] !== 'function') continue;
      const draw = gl[name].bind(gl);
      gl[name] = function (...args) {
        renderer.drawCallCount++;
        return draw(...args);
      };
    }
  }

  /**
   * Override reportFPS to write stats to SharedArrayBuffer
   */
  reportFPS() {
    // A paced tick did no work; like a pre-render skip, it leaves the last drawn frame's meters.
    if (this._pacedTick) return;
    // E-198: Pixi's own step (without its wait for the queue), for the next wait's budget.
    const own = this.stepTimeThisFrame - waitMeterMs();
    if (own > 0) this._queueWaitStepMs = this._queueWaitStepMs === this._queueWaitStepMs ? this._queueWaitStepMs * 0.9 + own * 0.1 : own;
    // E-197: this frame drew the queue it consumed; its stamp, if newer than any drawn, is an input reaching the screen.
    if (this._queueStamp > 0 && this._latency !== null) this._lagMeter.note(this._queueStamp, stampNow(this._latency));
    if (this.stats) {
      if (this.stats.length > RENDERER_STATS.INPUT_LAG_N) {
        const lag = this._lagMeter;
        this.stats[RENDERER_STATS.INPUT_LAG_MS] = lag.count ? lag.median : 0;
        this.stats[RENDERER_STATS.INPUT_LAG_P95_MS] = lag.count ? lag.p95 : 0;
        this.stats[RENDERER_STATS.INPUT_LAG_N] = lag.count;
      }
      // The renderer never blocks on a sibling (it has no sync query API), so
      // WAIT_MS is 0 by construction; IDLE_MS is the real number.
      this._writeFrameMeters(RENDERER_STATS);
      this.stats[RENDERER_STATS.DECAL_TILES_DIRTY] = this._decalTilesDirtyThisFrame;
      this.stats[RENDERER_STATS.DECAL_TILES_UPLOADED] = this._decalTilesUploadedThisFrame;
      let sceneryN = 0;
      const sc = this.scenery.layers;
      if (sc) {
        for (let i = 0; i < sc.length; i++) {
          if (sc[i]?.displayObject) sceneryN++;
        }
      }
      this.stats[RENDERER_STATS.SCENERY_COUNT] = sceneryN;
      this.stats[RENDERER_STATS.MESH_FILL_INSTANCES] = this.customLayers.meshFillInstancesThisFrame;
      this.stats[RENDERER_STATS.MESH_RT_DRAWS] = this.customLayers.meshRtDrawsThisFrame;
      if (this.collectDetailedStats) {
        this.stats[RENDERER_STATS.DRAW_CALLS] = this.drawCallCount;

        const totalVisibleSprites =
          this.visibleEntityCount + this.visibleParticleCount + this.visibleDecorationCount;

        const instancedBatchCount =
          (this.entitiesBatch ? 1 : 0) +
          (this.entitiesGlowBatch ? 1 : 0) +
          this.customLayers.list.length;
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
        this.stats[RENDERER_STATS.LAST_UPLOAD_MS] = this._lastUploadMs;
        this.stats[RENDERER_STATS.NEW_QUEUE] = this._newQueueThisFrame;
        this.stats[RENDERER_STATS.SORT_MS] = this.sortTimeThisFrame;
        this.stats[RENDERER_STATS.QUEUE_MS] = this.queueTimeThisFrame;
        this.stats[RENDERER_STATS.PRESENT_MS] = this.presentTimeThisFrame;
        this.stats[RENDERER_STATS.CUSTOM_LAYERS_MS] = this.customLayersTimeThisFrame;
        this.stats[RENDERER_STATS.MISC_MS] = this.miscTimeThisFrame;
      }
      this.stats[RENDERER_STATS.GPU_PASSES] = this._gpuPassesThisFrame;
      this.stats[RENDERER_STATS.GPU_CASTERS] = this._gpuCastersThisFrame;
      this.stats[RENDERER_STATS.GPU_SHADOW_LIGHTS] = this._gpuShadowLightsThisFrame;
      this.stats[RENDERER_STATS.GPU_FPS] = this.currentFPS;
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
      v.meshFloorScale = VolumeShadowCaster.floorScaleY || null;
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
      v.outsetEpoch = MeshRenderer.outsetEpoch;
      v.meshVertOffset = MeshGeometry.vertOffset;
      v.meshVertCount = MeshGeometry.vertCount;
      v.meshIndexOffset = MeshGeometry.indexOffset;
      v.meshIndexCount = MeshGeometry.indexCount;
      v.meshHasUv = MeshGeometry.hasUv;
      v.meshVertexX = MeshGeometry.vertexX;
      v.meshVertexY = MeshGeometry.vertexY;
      v.meshUvU = MeshGeometry.uvU;
      v.meshUvV = MeshGeometry.uvV;
      v.meshIndices = MeshGeometry.indices;
      v.meshGeomRevision = MeshGeometry.revision;
      v.meshVertGen = MeshGeometry.vertGen;
      v.meshVertEpoch = MeshGeometry.vertEpoch;
      v.meshUvGen = MeshGeometry.uvGen;
      v.queueStamp = this._meshQueueStamp;
      v.queuePose = this._meshQueuePose;
      v.queueFrame = -1;
    }
    // N-138: a mesh whose sprite was drawn this frame takes its sprite's pose.
    v.queueFrame = this._meshPoseLists.length !== 0 && this.lastReadFrame > 0 ? this.lastReadFrame : -1;
    v.entityCount = MeshRenderer.active ? MeshRenderer.active.length : 0;
    v.animationFrameStart = this.assets.animationFrameStart;
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
   * World-space display object. Rotation 0 keeps the old top-left pan.
   * A non-zero angle pivots on the follow point so radial up stays screen-up.
   */
  _placeWorldCamera(obj, zoom, cameraX, cameraY, rot) {
    if (!obj) return;
    const z = zoom || 1;
    if (rot) {
      const cw = this.canvasWidth || 0;
      const ch = this.canvasHeight || 0;
      const focusX = cameraX + cw / (2 * z);
      const focusY = cameraY + ch / (2 * z);
      obj.pivot.set(focusX, focusY);
      obj.position.set(cw * 0.5, ch * 0.5);
      obj.scale.set(z);
      obj.rotation = rot;
      return;
    }
    if (obj.rotation) obj.rotation = 0;
    if (obj.pivot && (obj.pivot.x || obj.pivot.y)) obj.pivot.set(0, 0);
    obj.scale.set(z);
    obj.x = -cameraX * z;
    obj.y = -cameraY * z;
  }

  /**
   * Update camera on instanced meshes, background, tilemap root, decals
   */
  updateCameraTransform() {
    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;
    const rot = this._renderCameraRot || 0;

    // Apply camera to ENTITIES root (cutout + blend stay in that order under it)
    if (this._entitiesRoot) {
      this._placeWorldCamera(this._entitiesRoot, zoom, cameraX, cameraY, rot);
    } else if (this.spriteMesh) {
      this._placeWorldCamera(this.spriteMesh, zoom, cameraX, cameraY, rot);
    }
    if (this.spriteGlowMesh) {
      this._placeWorldCamera(this.spriteGlowMesh, zoom, cameraX, cameraY, rot);
    }

    this.scenery.applyCamera(zoom, cameraX, cameraY, rot);
    this.scenery.stepTilemapCaches(zoom, cameraX, cameraY, rot);

    if (this.decalTileContainer) {
      this._placeWorldCamera(this.decalTileContainer, zoom, cameraX, cameraY, rot);
      this.decalTiles.cull(zoom, cameraX, cameraY, rot);
    }

    // Apply camera to custom layer meshes (non-shader layers only).
    // Look-shader MESH keeps world verts; camera is the reused RT Container.
    for (let i = 0; i < this.customLayers.list.length; i++) {
      const cl = this.customLayers.list[i];
      if (!cl.rt) {
        const mesh = cl.worldMesh || cl.batch?.mesh || cl.fillBatch?.mesh || cl.gpu?.container;
        if (mesh) this._placeWorldCamera(mesh, zoom, cameraX, cameraY, rot);
        const uvMesh = cl.uvFillBatch?.mesh;
        if (uvMesh) this._placeWorldCamera(uvMesh, zoom, cameraX, cameraY, rot);
      }
    }
  }

  _bindSpriteQueue(q, src, count) {
    q.count = count;
    q.x = src.x;
    q.y = src.y;
    q.scaleX = src.scaleX;
    q.scaleY = src.scaleY;
    q.rotC = src.rotC;
    q.rotS = src.rotS;
    q.alpha = src.alpha;
    q.type = src.type || this.renderQueueType;
    q.tint = src.tint;
    q.textureId = src.textureId;
    q.anchorX = src.anchorX;
    q.anchorY = src.anchorY;
    q.repeatX = src.repeatX;
    q.repeatY = src.repeatY;
    q.tileMode = src.tileMode;
    q.tileOffsetU = src.tileOffsetU;
    q.tileOffsetV = src.tileOffsetV;
    q.tileMulX = src.tileMulX;
    q.tileMulY = src.tileMulY;
    q.sortKey = src.sortKey || null;
    q.shadowH = src.shadowH || null;
    q.shadowOffX = src.shadowOffX || null;
    q.shadowOffY = src.shadowOffY || null;
    q.staticGen = src.staticGen || null;
    q.key = src.key || null;
  }

  _bindRenderQueueTo(q, count) {
    let src = this._renderQueueBindSrc;
    if (!src) src = this._renderQueueBindSrc = makeBatchViews();
    src.x = this.renderQueueX;
    src.y = this.renderQueueY;
    src.scaleX = this.renderQueueScaleX;
    src.scaleY = this.renderQueueScaleY;
    src.rotC = this.renderQueueRotC;
    src.rotS = this.renderQueueRotS;
    src.alpha = this.renderQueueAlpha;
    src.type = this.renderQueueType;
    src.tint = this.renderQueueTint;
    src.textureId = this.renderQueueTextureId;
    src.anchorX = this.renderQueueAnchorX;
    src.anchorY = this.renderQueueAnchorY;
    src.repeatX = this.renderQueueRepeatX;
    src.repeatY = this.renderQueueRepeatY;
    src.tileMode = this.renderQueueTileMode;
    src.tileOffsetU = this.renderQueueTileOffsetU;
    src.tileOffsetV = this.renderQueueTileOffsetV;
    src.tileMulX = this.renderQueueTileMulX;
    src.tileMulY = this.renderQueueTileMulY;
    src.sortKey = this.renderQueueSortKey;
    src.shadowH = this.renderQueueShadowH;
    src.shadowOffX = this.renderQueueShadowOffX;
    src.shadowOffY = this.renderQueueShadowOffY;
    src.staticGen = this.renderQueueStaticGen;
    src.key = this.renderQueueKey;
    this._bindSpriteQueue(q, src, count);
  }

  _resetSpriteUploadOpts(opts) {
    opts.includeType = -1;
    opts.excludeType0 = -1;
    opts.excludeType1 = -1;
    opts.indices = null;
    opts.indexCount = 0;
    opts.depthMode = BATCH_DEPTH.INDEX;
    opts.sortKey = null;
    opts.texLut = this.assets.texLut;
    opts.texLutCount = this.assets.texLutCount;
    opts.textures = this.assets.flatTextures;
    opts.cameraRot = 0;
  }

  _bindPixiPackWriters() {
    if (this._pixiLayerPack) return;
    this._addSortMs = (ms) => { this.sortTimeThisFrame += ms; };
    this._writeLayerSprites = (packOpts) => this._packBatch.upload(this._packQ, packOpts);
    this._writeEntitySprites = (packOpts) => {
      // E-177: a keyed batch takes the queue frame it draws (its changed marks are that frame's) and its buffer.
      this.entitiesBatch.keyedFrame = this.lastReadFrame;
      this.entitiesBatch.keyedBuffer = (this.lastReadFrame - 1) & 1;
      // E-387: and the columns its keyed pack writes the instances' G-buffer words from (_commitPixiGbuf takes them).
      if (this.entitiesBatch.gbuf && this.entitiesBatch.keyed) {
        this.entitiesBatch.setGbufColumns(SpriteRenderer.gbufFlags, ShadowCaster.selfShadow,
          this._painter !== null && SpriteRenderer.zIndexUsers() > 0 ? SpriteRenderer.zIndex : null);
      }
      return this.entitiesBatch.upload(this._packQ, packOpts);
    };
    this._writeEntityGlow = (packOpts) => this._packGlowBatch.upload(this._packQ, packOpts);
    this._pixiLayerPack = {
      splitGlow: false,
      depthMode: BATCH_DEPTH.INDEX,
      writeSprites: this._writeLayerSprites,
    };
    this._pixiEntityPack = {
      timeGlowSort: true,
      writeSprites: this._writeEntitySprites,
    };
  }

  /**
   * One sprite batch: painter order when `painter` is set, then the mesh upload.
   * Custom layers use this. The entities queue calls packSpriteLayer directly
   * when it also splits the glow batch.
   */
  _uploadSortedSprites(batch, q, opts, painter, keysU32, idxE, ne) {
    this._bindPixiPackWriters();
    this._packBatch = batch;
    this._packQ = q;
    const spec = this._pixiLayerPack;
    spec.count = ne | 0;
    spec.type = opts.type;
    spec.opts = opts;
    spec.dense = !idxE;
    spec.presetIndices = idxE || null;
    spec.painter = painter || null;
    spec.keysU32 = keysU32 || null;
    spec.addSortMs = this.collectDetailedStats ? this._addSortMs : null;
    return packSpriteLayer(spec).sprite;
  }

  // ========================================
  // RENDER QUEUE UPDATE (Optimized Path)
  // ========================================
  _commitPackedBatch(batch, src, count, floats) {
    if (!batch) return 0;
    const n = count | 0;
    if (n <= 0 || !src) {
      if (batch.geometry) batch.geometry.instanceCount = 0;
      if (batch.mesh) batch.hide();
      return 0;
    }
    const cap = batch.capacity | 0;
    const keep = n > cap ? cap : n;
    const len = keep * (floats | 0);
    if (len > batch.data.length) {
      if (batch.geometry) batch.geometry.instanceCount = 0;
      if (batch.mesh) batch.hide();
      return 0;
    }
    batch.copyIn(batch.data, src, len);
    return batch.commitInstances(keep);
  }

  /**
   * Upload main render queue SoA into ENTITIES (one blend, CPU Y-order when
   * ySorting) + glow (add). Particles, decorations, bullets, adobe pieces, and
   * liquid share the entity list — same painter as a custom sprite layer.
   * Type 3 = light glow (_lightGlow) — separate ADD batch avoids gray halos.
   */
  updateSpritesFromRenderQueue() {
    if (!this.renderQueueEnabled || !this.entitiesBatch) return;
    // DX-DEPTH: the floor span this frame's view covers, for the entities' floor depth.
    this.entitiesBatch.setPixelDepthTerms(
      this._groundScaleY || 1,
      cameraHeightScaleY(this.config),
      this._renderCameraY || 0,
      this.canvasHeight / (this._renderZoom || 1),
    );
    const entitiesShown = layerIsVisible(Layer.entitiesId);
    if (!entitiesShown) {
      this.entitiesBatch.hide();
      this.visibleEntityCount = 0;
      this.visibleParticleCount = 0;
      const glowId = Layer.get('lightGlows')?.id;
      const glowOn = this._lightGlowAdd && layerIsVisible(glowId);
      if (!glowOn) {
        if (this.entitiesGlowBatch) this.entitiesGlowBatch.mesh.visible = false;
        return;
      }
    }

    // N-76. A frame with no new queue (before the first one, or a resume redrawing the last) reads its buffer outside
    // the consume/release handshake, while pre-render may be writing it: a frame whose header already reads complete
    // would be committed with two frames' rows. The batches keep what they last committed (nothing before the first
    // frame). Without a sync there is no handshake, and every frame reads the queue.
    if (this._newQueueThisFrame === 0 && this.renderQueueSync) {
      if (this.lastReadFrame <= 0) {
        this.entitiesBatch.hide();
        if (this.entitiesGlowBatch) this.entitiesGlowBatch.mesh.visible = false;
        this.visibleEntityCount = 0;
      }
      return;
    }

    // E-448: the opaque pass needs the canvas's depth and the entities drawn in one piece: not through a SCREEN layer
    // (the stage's target there has no depth on WebGL), nor in chunks around GPU particle groups (last frame's).
    // E-502: nor on Intel's integrated or tile-based GPUs, unless debug.opaquePass forces it (_opaqueOn, set at GL init).
    // DBG-3: nor while the layer fades: the pass draws solid pixels with blending off, so a layer alpha under 1 left them
    // opaque (only the soft edges faded) until 0, where Pixi skips the container. The batch then blends every pixel.
    const root = this._entitiesRoot;
    this.entitiesBatch.setOpaqueAllowed(
      this._opaqueOn && !this._entityChunksActive && !this.screenLayers.shown() && (root === null || root.alpha >= 1),
    );
    // And it draws when its rows cover enough of the canvas at the camera's zoom to pay for their second vertex pass.
    this.entitiesBatch.setOpaqueView(this._renderZoom || 1, this.canvasWidth * this.canvasHeight);

    const gpu = this._gpuQueueRead;
    const packedN = gpu && gpu.header ? (gpu.header[GPU_HDR_SPRITE] | 0) : 0;
    const soaN = this.renderQueueCount ? (this.renderQueueCount[0] | 0) : 0;
    const packedFlags = gpu && gpu.header ? (gpu.header[GPU_HDR_FLAGS] | 0) : 0;
    // An order only where the pipeline keeps one (with Y-sort off nobody sorts: this frame's own pack would not
    // either), so pre-render's unsorted rows are the frame's rows.
    const needOrder = this._sortSpritesOn !== SORT_SPRITES_NONE && (this._entityYSort() || SpriteRenderer.zIndexUsers() > 0);
    const packedOk = !!(
      gpu &&
      gpu.header &&
      (gpu.header[GPU_HDR_VERSION] | 0) === GPU_QUEUE_VERSION &&
      // Pre-render packed nothing of a queue with rows (a frame of glow rows only packs them all as glows).
      !(packedN === 0 && (gpu.header[GPU_HDR_GLOW] | 0) === 0 && soaN > 0) &&
      (!needOrder || (packedFlags & GPU_FLAG_SORTED)) &&
      ((packedFlags & GPU_FLAG_SPLIT) === 0 || this.entitiesBatch.split) &&
      ((packedFlags & GPU_FLAG_INDEXED) === 0 || this.entitiesBatch.indexed) &&
      this._packGpuSpritesOn !== PACK_GPU_SPRITES_PIXI
    );
    if (packedOk) {
      this._syncEntityOrder();
      if (layerIsVisible(Layer.entitiesId)) {
        const batch = this.entitiesBatch;
        if (!batch.split) {
          this.visibleEntityCount = this._commitPackedBatch(batch, gpu.sprites, packedN, GPU_SPRITE_FLOATS);
        } else if (packedFlags & GPU_FLAG_SPLIT) {
          // E-82b: the two streams, the statics copied when their generation or the row count moved.
          this.visibleEntityCount = batch.commitSplit(gpu.spritePose, gpu.spriteStatic, packedN, gpu.header[GPU_HDR_STATIC_GEN]);
        } else if (packedFlags & GPU_FLAG_INDEXED) {
          // E-162: the poses and slot pairs, every queue row's statics to the texture when their generation moved.
          // E-514: or only the rows that changed, where pre-render listed them against what the texture holds.
          const ix = this._ixCommit;
          ix.updates = gpu.spriteIxUpdates;
          ix.texUpdates = gpu.spriteIxTexUpdates;
          ix.count = gpu.header[GPU_HDR_IXUP];
          ix.texCount = gpu.header[GPU_HDR_IXUP_TEX];
          ix.genA = gpu.header[GPU_HDR_IXUP_GEN_A];
          ix.rowsA = gpu.header[GPU_HDR_IXUP_ROWS_A];
          ix.genB = gpu.header[GPU_HDR_IXUP_GEN_B];
          ix.rowsB = gpu.header[GPU_HDR_IXUP_ROWS_B];
          this.visibleEntityCount = batch.commitIndexed(
            gpu.spritePose, gpu.spriteSlots, gpu.spriteRowStatics, packedN,
            gpu.header[GPU_HDR_INDEXED_ROWS], gpu.header[GPU_HDR_STATIC_GEN], gpu.header[GPU_HDR_SLOTS_GEN], ix
          );
        } else if (packedN === 0) {
          // No sprite rows: pre-render's pack wrote none, so it split none. Nothing to draw.
          batch.hide();
          this.visibleEntityCount = 0;
        } else {
          // Pre-render splits whenever this batch is split (the same atlas filter decides both, close-out group B).
          this.visibleEntityCount = this._refusePackedFrame('15-float rows for the split entity batch');
        }
      } else {
        this.entitiesBatch.hide();
        this.visibleEntityCount = 0;
      }
      this.visibleParticleCount = gpu.header[GPU_HDR_PARTICLE] | 0;
      // DX-GBUF: the instances' words pre-render wrote with the frame (none: lit as they always were).
      if (this.entitiesBatch.gbuf && this.visibleEntityCount > 0) {
        this.entitiesBatch.commitGbuf((packedFlags & GPU_FLAG_GBUF) !== 0 ? gpu.spriteGbuf : null, this.visibleEntityCount);
      }
      const glowId = Layer.get('lightGlows')?.id;
      const glowOn = this._lightGlowAdd && layerIsVisible(glowId);
      if (this.entitiesGlowBatch) {
        if (glowOn) {
          const glowN = gpu.header[GPU_HDR_GLOW] | 0;
          this.entitiesGlowBatch.setTargetSpace(false, 0, 0, 1);
          this._commitPackedBatch(this.entitiesGlowBatch, gpu.glow, glowN, GPU_SPRITE_FLOATS);
        } else {
          this.entitiesGlowBatch.mesh.visible = false;
        }
      }
      if (this._proxiesOn) this._applyPackedProxies();
      return;
    }

    // In pre-render pack mode pre-render packs every frame (close-out group B: Pixi has no rows of its own there), so
    // a frame its GPU queue does not describe is one _refusePackedFrame handles; with no rows nothing is lost.
    if (this._packGpuSpritesOn !== PACK_GPU_SPRITES_PIXI) {
      const warn = soaN > 0 && this._newQueueThisFrame !== 0 && !this._refusedFrameWarned;
      this.visibleEntityCount = this._refusePackedFrame(warn
        ? `${soaN} rows that its GPU queue frame does not describe (${this._uncommittedFrameReason(gpu, packedN, packedFlags, needOrder)})`
        : null);
      if (this.entitiesGlowBatch) this.entitiesGlowBatch.mesh.visible = false;
      // A frame drawn without its entities still draws its groups.
      if (this._proxiesOn) this._applyPackedProxies();
      return;
    }

    const count = this.renderQueueCount[0];
    const q = this._entityUploadQ;
    this._bindRenderQueueTo(q, count);

    this._syncEntityOrder();
    const opts = this._entityUploadOpts;
    this._resetSpriteUploadOpts(opts);
    opts.space = BATCH_SPACE.WORLD;
    opts.depthDenom = this.renderQueueMaxItems;
    opts.worldHeight = this.config?.worldHeight || 10000;
    opts.type = this.renderQueueType;
    opts.zoom = 1;
    opts.cameraX = 0;
    opts.cameraY = 0;
    opts.resolution = 1;

    const typeArr = this.renderQueueType;
    const idxE = this._rqIdxEntity;
    const idxG = this._rqIdxGlow;
    const splitGlow = !!(this._lightGlowAdd && typeArr && idxE && (this._painter || this.lightingEnabled));
    const glowBatch = splitGlow
      ? this.entitiesGlowBatch
      : (this._lightGlowAdd && this.lightingEnabled ? this.entitiesGlowBatch : null);
    this._bindPixiPackWriters();
    this._packQ = q;
    this._packGlowBatch = glowBatch;
    const spec = this._pixiEntityPack;
    spec.count = count;
    spec.type = typeArr;
    spec.opts = opts;
    spec.splitGlow = splitGlow;
    spec.idxEntity = idxE;
    spec.idxGlow = idxG;
    spec.painter = this._painter;
    spec.keysU32 = this._sortKeyU32;
    spec.dense = !splitGlow;
    spec.writeEmptyGlow = !!(splitGlow && this.entitiesGlowBatch);
    spec.glowIncludeType = !splitGlow && glowBatch ? 3 : -1;
    spec.addSortMs = this.collectDetailedStats ? this._addSortMs : null;
    spec.writeGlow = glowBatch ? this._writeEntityGlow : null;
    const packed = packSpriteLayer(spec);
    this.visibleEntityCount = packed.sprite;
    this.visibleParticleCount = splitGlow ? packed.splitParticles : 0;
    if (this.entitiesBatch.gbuf && packed.sprite > 0) this._commitPixiGbuf(packed.spriteIndices, packed.sprite);
    if (this._proxiesOn) this._applyLocalProxies(packed.spriteIndices, packed.sprite);
    if (!splitGlow && !glowBatch && this.spriteGlowMesh) this.spriteGlowMesh.visible = false;
    // DBG-1: entities hidden with their glows shown come here for the glows: the pack wrote (and showed) the entities too.
    if (!entitiesShown) {
      this.entitiesBatch.hide();
      this.visibleEntityCount = 0;
    }
  }

  /**
   * DX-GBUF: the G-buffer words of the `count` instances Pixi just packed (`order`: their queue rows, null: row k), from
   * the queue's key column (a sprite row's entity: a keyed scene's emit writes it, pre-render writes it for the others),
   * SpriteRenderer.gbufFlags and ShadowCaster.selfShadow, with zIndex bands when the painter ordered them. E-387: a
   * frame drawn keyed has them from its pack (the columns _writeEntitySprites hands the batch); the others, here.
   */
  _commitPixiGbuf(order, count) {
    const batch = this.entitiesBatch;
    // E-455 step 3: a keyed frame whose pack put the words in the slots' statics: the instances carry the mark alone.
    if (batch.gbufInStatics) {
      batch.commitGbufFromStatics(count);
      return;
    }
    if (batch.gbufPacked) {
      batch.commitGbuf(batch.packedGbuf, count);
      return;
    }
    const flags = SpriteRenderer.gbufFlags;
    const keys = this.renderQueueKey;
    if (!flags || !keys || keys.length === 0) {
      batch.commitGbuf(null, count);
      return;
    }
    const n = count < batch.capacity ? count : batch.capacity;
    const sorted = this._painter !== null && SpriteRenderer.zIndexUsers() > 0;
    writeGbufWords(
      batch.gbufData, n, order || null, null, null, keys, flags.length, flags, ShadowCaster.selfShadow || null,
      sorted ? SpriteRenderer.zIndex : null,
    );
    batch.commitGbuf(batch.gbufData, n);
  }

  /** Which of updateSpritesFromRenderQueue's packedOk terms a GPU queue frame failed, in words. */
  _uncommittedFrameReason(gpu, packedN, packedFlags, needOrder) {
    if (!gpu || !gpu.header) return 'no GPU queue';
    const version = gpu.header[GPU_HDR_VERSION] | 0;
    if (version !== GPU_QUEUE_VERSION) return `GPU queue version ${version}, not ${GPU_QUEUE_VERSION}`;
    if (packedN === 0 && (gpu.header[GPU_HDR_GLOW] | 0) === 0) return 'pre-render packed none of them';
    if (needOrder && !(packedFlags & GPU_FLAG_SORTED)) return 'they need an order and pre-render did not sort them';
    if ((packedFlags & GPU_FLAG_INDEXED) && !this.entitiesBatch.indexed) return 'an indexed frame for an entity batch that reads none';
    return 'two streams for a plain entity batch';
  }

  /**
   * A frame of pre-render's GPU queue Pixi cannot commit: drawn empty, `reason` said once (null: no rows were lost).
   * Frames read outside the consume/release handshake never get here (N-76, updateSpritesFromRenderQueue).
   * @returns {number} the entities drawn
   */
  _refusePackedFrame(reason) {
    if (reason !== null && this._newQueueThisFrame !== 0 && !this._refusedFrameWarned) {
      this._refusedFrameWarned = true;
      console.error(`[PIXI WORKER] ${reason}: the entities are not drawn this frame`);
    }
    if (this.entitiesBatch) this.entitiesBatch.hide();
    return 0;
  }

  /**
   * @param {number} [columns] E-511: only each row's first `columns` texels changed (the rows of `data` stay `width`
   *   long); a texture this source already holds gets just those
   * @param {number} [rows] OL-4: only the first `rows` rows changed
   */
  _uploadRgba32FloatGl(source, data, width, height, columns = width, rows = height) {
    const renderer = this.pixiApp?.renderer;
    const gl = renderer?.gl;
    if (!gl || !source || !data || !renderer?.texture) return;

    // E-259: the texture this source already has, at this size: write its texels in place. source.update() would have
    // Pixi re-specify it (a texImage2D with no data) before ours, and ours re-specified it again: two reallocations a
    // frame, with the sampling parameters set again each time.
    const texSys0 = renderer.texture;
    const held = this._floatTexHeld.get(source);
    if (held !== undefined && held.width === width && held.height === height) {
      const current = typeof texSys0.getGlSource === 'function' ? texSys0.getGlSource(source) : null;
      if (current && current.texture === held.texture) {
        const cols = columns < width ? (columns > 0 ? columns | 0 : 0) : width;
        const high = rows < height ? (rows > 0 ? rows | 0 : 0) : height;
        if (cols === 0 || high === 0) return;
        const prevHeld = gl.getParameter(gl.TEXTURE_BINDING_2D);
        gl.bindTexture(held.target, held.texture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        if (gl.UNPACK_FLIP_Y_WEBGL != null) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        if (gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL != null) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        if (cols < width) {
          // E-511: the rows' first texels, read from rows `width` long.
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, width);
          gl.texSubImage2D(held.target, 0, 0, 0, cols, high, gl.RGBA, gl.FLOAT, data);
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        } else {
          gl.texSubImage2D(held.target, 0, 0, 0, width, high, gl.RGBA, gl.FLOAT, data);
        }
        gl.bindTexture(held.target, prevHeld);
        return;
      }
    }

    source.update();

    const texSys = renderer.texture;
    if (typeof texSys.bind === 'function') {
      texSys.bind(source, 0);
    } else if (typeof texSys.bindSource === 'function') {
      texSys.bindSource(source, 0);
    }

    const glSource = typeof texSys.getGlSource === 'function' ? texSys.getGlSource(source) : null;
    const target = glSource?.target || gl.TEXTURE_2D;
    // N-94: the active unit's binding goes back after the upload (texSys.bind leaves the active unit where it was when
    // the source is bound on unit 0 already, and Pixi would draw that unit's texture as the one it last bound there).
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
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
    gl.bindTexture(target, prev);
    if (glSource?.texture) this._floatTexHeld.set(source, { texture: glSource.texture, target, width, height });
  }

  _bindLutToBatches() {
    const lut = this.assets.texLutSource;
    if (!lut) return;
    if (this.entitiesBatch) this.entitiesBatch.setLutSource(lut);
    if (this.entitiesGlowBatch) this.entitiesGlowBatch.setLutSource(lut);
    if (this.gpuCasterBatch) this.gpuCasterBatch.setLutSource(lut);
    for (let i = 0; i < this.customLayers.list.length; i++) {
      const cl = this.customLayers.list[i];
      if (cl.batch) cl.batch.setLutSource(lut);
      if (cl.fillBatch) cl.fillBatch.setLutSource(lut);
      if (cl.uvFillBatch) cl.uvFillBatch.setLutSource(lut);
    }
  }

  /** After the atlas loads: the texture tables rebuilt (assets.rebuildTextureLut), and every batch pointed at them. */
  rebuildInstancedTextureLut() {
    this.assets.rebuildTextureLut();
    const src = this.assets.resolveAtlasSource();
    if (this.entitiesBatch) {
      this.entitiesBatch.setAtlasSource(src);
      // E-448: which frames the opaque pass may draw.
      this.entitiesBatch.setFrameTexels(textureLutTexels(this.assets.texLut), textureLutSolid(this.assets.texLut));
      // E-549: which frames a keyed row's columns can come from (the keyed statics' copy keeps only those slots).
      const columns = keyedColumnTextures(this.assets.texLut, TEX_LUT_FLOATS);
      this.entitiesBatch.setColumnTextures(columns.flags, columns.count);
      // E-500: whether some frame has heights (the opaque pass with faces in one program or two; a twin made now placed).
      if (this.entitiesBatch.setHeightFrames(this.assets.mapsTableHeights)) this._placeDepthMeshes();
    }
    if (this.entitiesGlowBatch) this.entitiesGlowBatch.setAtlasSource(src);
    if (this.gpuCasterBatch) this.gpuCasterBatch.setAtlasSource(src);
    for (let i = 0; i < this.customLayers.list.length; i++) {
      const cl = this.customLayers.list[i];
      if (cl.batch) cl.batch.setAtlasSource(src);
      if (cl.fillBatch) cl.fillBatch.setAtlasSource(src);
      if (cl.uvFillBatch) cl.uvFillBatch.setAtlasSource(src);
      if (cl.gpu) cl.gpu.setTextures(src, this.assets.texLutSource, this.assets.gpuAnimStartSource);
    }
    this._bindLutToBatches();
  }

  /**
   * WebGL's GPU particle record textures (E-157): RGBA32UI, seven texels a record, filled with raw GL as the lookups
   * are. Pixi only binds them: their upload method is 'unknown', so it never sends or reallocates them itself.
   */
  _gpuRecordTexture() {
    if (this._gpuRecordTextureOps !== null) return this._gpuRecordTextureOps;
    const gl = this.pixiApp?.renderer?.gl;
    this._gpuRecordTextureOps = {
      // A layer whose rings need more falls back to instance attributes (gpuRecordTexturesFit).
      maxSize: gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 0,
      // N-109: the unit an upload binds them in, the last one, where the shader sync puts integer textures
      // (scripts/pixi-stubs/shaderSyncPolyfill.mjs): Pixi's batcher checks units 0 to 15 and drops a draw that finds
      // one there.
      unit: gl ? gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) - 1 : 0,
      make: (bits, width, height, label) => {
        const source = PIXI.TextureSource.from({
          resource: bits,
          width,
          height,
          format: 'rgba32uint',
          scaleMode: 'nearest',
          addressMode: 'clamp-to-edge',
          autoGenerateMipmaps: false,
          label,
        });
        source.uploadMethodId = 'unknown';
        this._gpuRecordRowsGl(source, bits, width, height, 0, -1);
        return source;
      },
      upload: (source, bits, width, height, y0, rows) => this._gpuRecordRowsGl(source, bits, width, height, y0, rows),
      // E-448: the first rows of a record texture from a vertex buffer's words, on the GPU (at render time).
      fromBuffer: (renderer, source, buffer, width, rows) => this._gpuRecordRowsFromBufferGl(renderer, source, buffer, width, rows),
      // E-177: a keyed batch's changed statics into its texture.
      // E-189: and its texture updates.
      scatter: (source, updates, count, width, height, texUpdates, texCount) =>
        this._scatterStaticsGl(source, updates, count, width, height, texUpdates, texCount),
    };
    return this._gpuRecordTextureOps;
  }

  /**
   * E-448: rows [0, rows) of a record texture (`width` texels each) from Pixi vertex buffer `buffer`'s first words, by a
   * pixel unpack from it: the GPU copies them, nothing goes up from the CPU. The buffer is uploaded first if Pixi has not
   * yet this frame (it then skips it at its draw), and must hold the rows whole. Every binding it touches goes back.
   */
  _gpuRecordRowsFromBufferGl(renderer, source, buffer, width, rows) {
    const gl = renderer?.gl;
    const texSys = renderer?.texture;
    const bufSys = renderer?.buffer;
    if (!gl || !texSys || !bufSys || !(rows > 0)) return;
    bufSys.updateBuffer(buffer);
    const glBuffer = bufSys.getGlBuffer(buffer);
    texSys.bind(source, this._gpuRecordTextureOps.unit);
    const glSource = texSys.getGlSource(source);
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(gl.TEXTURE_2D, glSource.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, glBuffer.buffer);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, 0);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, prev);
  }

  /** Rows [y0, y0 + rows) of a record texture from `bits`; rows < 0 allocates it with all of `bits`. */
  _gpuRecordRowsGl(source, bits, width, height, y0, rows) {
    const renderer = this.pixiApp?.renderer;
    const gl = renderer?.gl;
    const texSys = renderer?.texture;
    if (!gl || !texSys) return;
    texSys.bind(source, this._gpuRecordTextureOps.unit);
    const glSource = texSys.getGlSource(source);
    // N-94: the active unit's binding goes back after the upload (see _uploadRgba32FloatGl).
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(gl.TEXTURE_2D, glSource.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (rows < 0) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, width, height, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, bits);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, width, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, bits, y0 * width * 4);
    }
    gl.bindTexture(gl.TEXTURE_2D, prev);
  }

  /**
   * E-177: `count` updates of a keyed batch's statics (GPU_KEYED_ROW_WORDS u32 each) into its texture, `width` x
   * `height` (staticsScatterGl.js), the scatter's GL objects made on the first call.
   */
  _scatterStaticsGl(source, updates, count, width, height, texUpdates = null, texCount = 0) {
    const renderer = this.pixiApp?.renderer;
    const gl = renderer?.gl;
    const texSys = renderer?.texture;
    if (!gl || !texSys || (count <= 0 && texCount <= 0)) return;
    if (this._staticsScatterGl === null || this._staticsScatterGl.gl !== gl) this._staticsScatterGl = createStaticsScatterGl(gl);
    const texture = texSys.getGlSource(source).texture;
    scatterStaticsGl(this._staticsScatterGl, renderer, texture, updates, count, width, height, texUpdates, texCount);
  }

  /**
   * E-187: `count` updates and `texCount` texture updates of a keyed batch's statics into its storage buffer on WebGPU
   * (staticsScatterGpu.js: a compute pass, submitted before the frame's render), the pipelines made on the first call.
   */
  _scatterStaticsGpu(source, updates, count, texUpdates = null, texCount = 0) {
    const renderer = this.pixiApp?.renderer;
    const device = renderer?.gpu?.device;
    if (!device || !renderer.buffer || (count <= 0 && texCount <= 0)) return;
    if (this._staticsScatterGpu === null || this._staticsScatterGpu.device !== device) {
      this._staticsScatterGpu = createStaticsScatterGpu(device);
    }
    scatterStaticsGpu(this._staticsScatterGpu, renderer.buffer.getGPUBuffer(source), updates, count, texUpdates, texCount);
  }

  /** Every frame: new GPU particle records up, each ring's live window and clock set. */
  updateGpuParticleLayers() {
    const batches = this._gpuParticleBatches;
    if (batches.length === 0) return;
    if (this._proxyLayerList.length > 0) this._syncProxiesOn();
    Time.readSimNowInto(this._gpuClock, 0);
    for (let i = 0; i < batches.length; i++) batches[i].update(this._gpuClock);
  }

  /**
   * The sortWithEntities layers draw among the entities while the entities y-sort (gpuParticleProxies.js); with
   * the y-sort off they draw at their zIndex, as any layer.
   */
  _syncProxiesOn() {
    const on = this._entityChunks !== null && this._entityYSort();
    if (on === this._proxiesOn) return;
    this._proxiesOn = on;
    const list = this._proxyLayerList;
    for (let i = 0; i < list.length; i++) {
      const pl = list[i];
      pl.batch.sorted = on;
      // A look layer's full-screen composite gives way to its regions among the entities.
      if (pl.cl.displaySprite) pl.cl.displaySprite.renderable = !on;
    }
    if (!on) this._entityChunks.clear();
  }

  /** After initializeCustomLayers' layers: the sortWithEntities layers, drawn among the entities. */
  _initProxies() {
    const old = this._proxyLayerList;
    for (let i = 0; i < old.length; i++) if (old[i].regions) old[i].regions.destroy();
    this._proxyLayers = [];
    this._proxyLayerList = [];
    this._proxiesOn = false;
    if (this._entityChunks) this._entityChunks.clear();
    for (let i = 0; i < this.customLayers.list.length; i++) {
      const cl = this.customLayers.list[i];
      if (!cl.gpu || !cl.gpu.info.sortWithEntities) continue;
      let regions = null;
      if (cl.gpu.look && cl.rtOut) {
        regions = new RegionQuads({
          useWebGpu: this._useWebGpu,
          shaders: this._engineShaders,
          texture: cl.rtOut,
          // As the layer's full-screen composite draws (the layer's blendMode, not its containerBlend).
          blendMode: cl.displaySprite?.blendMode || 'normal',
          label: `gpu-regions-${cl.layerName}`,
        });
      }
      const pl = { layerId: cl.layerId, cl, batch: cl.gpu, regions };
      this._proxyLayers[cl.layerId] = pl;
      this._proxyLayerList.push(pl);
    }
    if (this._proxyLayerList.length === 0) return;
    if (!this._ySort) {
      console.warn('[PIXI WORKER] sortWithEntities needs renderer.ySort: those GPU particle layers draw at their zIndex');
    }
    if (!this.entitiesBatch || !this._entitiesRoot) return;
    if (!this._entityChunks) {
      this._entityChunks = new EntityChunks({
        batch: this.entitiesBatch,
        root: this._entitiesRoot,
        maxSplits: this.config?.renderer?.maxPainterSplits,
      });
    }
    if (this._packGpuSpritesOn === PACK_GPU_SPRITES_PIXI) {
      if (!this._proxyLocal) {
        this._proxyLocal = localProxyHalf();
        this._proxyCollector = new ProxyCollector();
      }
    } else if (GpuParticles.proxySab) {
      this._proxyHalves = bindProxyHalves(GpuParticles.proxySab);
    }
    if (!this._proxyDrawEntry) this._proxyDrawEntry = (w, out, n) => this._drawProxyEntry(w, out, n);
  }

  /** Pre-render's entries for the frame Pixi took (it packed the entities). */
  _applyPackedProxies() {
    this._applyProxies(this._proxyHalves !== null ? this._proxyHalves[this._proxyReadHalf] : null);
  }

  /** Pixi packed the entities: it lists the groups itself, against the order it just packed. */
  _applyLocalProxies(order, packedCount) {
    const half = this._proxyLocal;
    if (half === null) {
      this._applyProxies(null);
      return;
    }
    const collector = this._proxyCollector;
    const cam = this._proxyCamera;
    cam[PROXY_CAMERA.X] = this._renderCameraX;
    cam[PROXY_CAMERA.Y] = this._renderCameraY;
    cam[PROXY_CAMERA.ZOOM] = this._renderZoom;
    cam[PROXY_CAMERA.ROT] = this._renderCameraRot || 0;
    cam[PROXY_CAMERA.CANVAS_W] = this.canvasWidth;
    cam[PROXY_CAMERA.CANVAS_H] = this.canvasHeight;
    Time.readSimNowInto(this._gpuClock, 0);
    const n = this._painter !== null
      ? collector.collect(GpuParticles.layers, this._gpuClock, proxyView(this._proxyView, cam))
      : 0;
    if (n > 0) collector.write(half, this.renderQueueSortKey, order, packedCount | 0);
    else Atomics.store(half.header, 0, 0);
    this._applyProxies(half);
  }

  /** The entities root this frame: the entities batch in chunks, the entries in the gaps. */
  _applyProxies(half) {
    const chunks = this._entityChunks;
    const count = half !== null ? Math.min(Atomics.load(half.header, 0), PROXY_MAX_ENTRIES) : 0;
    this._entityChunksActive = count > 0;
    if (count <= 0) {
      chunks.clear();
      return;
    }
    const list = this._proxyLayerList;
    const alphas = Layer._alpha;
    const sunFactors = this._layerSunFactor;
    let view = false;
    for (let i = 0; i < list.length; i++) {
      const pl = list[i];
      // The layer's alpha for this frame's group meshes and regions, set once here rather than passed per entry.
      const alpha = alphas ? alphas[pl.layerId] * (pl.layerId < sunFactors.length ? sunFactors[pl.layerId] : 1) : 1;
      pl.batch.alpha = alpha;
      pl.batch.beginGroups();
      if (pl.regions !== null) {
        pl.regions.alpha = alpha;
        const out = pl.cl.rtOut;
        if (out && pl.regions.source !== out.source) pl.regions.setTexture(out);
        // The composite's blend follows Layer blend changes (handleSetLayerProps); the regions follow it.
        const blend = pl.cl.displaySprite ? pl.cl.displaySprite.blendMode : 'normal';
        if (blend !== pl.regions.blendMode) pl.regions.setBlendMode(blend);
        if (!view) {
          // World to screen px this frame, once for every look layer's regions.
          this._writeCameraRtTransform(this._proxyMatrix, null);
          view = true;
        }
        pl.regions.setView(this._proxyMatrix, this.canvasWidth || 1, this.canvasHeight || 1);
        pl.regions.beginFrame();
      }
    }
    this._proxyApplyHalf = half;
    // E-448: the entries drawn between the entities' chunks test no depth, so the opaque pass would draw the entities in
    // front of them first and lose them under them (from the next frame on it is not allowed: _entityChunksActive).
    this.entitiesBatch.dropOpaquePass();
    const mesh = this.entitiesBatch.mesh;
    chunks.apply(half, count, mesh.visible ? mesh.geometry.instanceCount | 0 : 0, this._proxyDrawEntry);
  }

  /** One entry's meshes at out[n…] (a group's ring slices, or a look layer's region); returns the next index. */
  _drawProxyEntry(w, out, n) {
    const half = this._proxyApplyHalf;
    const ints = half.ints;
    const kindLayer = ints[w + PROXY.KIND_LAYER];
    const pl = this._proxyLayers[kindLayer & 0xff];
    if (!pl || !layerIsVisible(pl.layerId)) return n;
    if ((kindLayer >> 8) === PROXY_KIND.GROUP) {
      return pl.batch.groupMeshes(ints[w + PROXY.RING], ints[w + PROXY.GROUP], out, n);
    }
    if (pl.regions === null) return n;
    out[n] = pl.regions.quad(half.floats, w);
    return n + 1;
  }

  _entityYSort() {
    return !!(Layer._ySorting && Layer.entitiesId != null && Layer._ySorting[Layer.entitiesId]);
  }

  _syncEntityOrder() {
    const active = this._entityYSort() || SpriteRenderer.zIndexUsers() > 0;
    if (!active) this._painter = null;
    else if (!this._painter && this.renderQueueMaxItems) {
      this._painter = this._newEntityPainter();
    }
  }

  /** The ENTITIES queue's painter state: on the render-queue memory, sorted by its kernel (W10); null when Pixi does not sort. */
  _newEntityPainter() {
    return this._painterWasm ? createWasmPainterState(this._painterWasm) : null;
  }

  /**
   * W30: a private memory for a batch's arrays (`floats` of them), which copies from the render-queue memory fill by
   * memory.copy; null without that memory or without multi-memory (the batch keeps arrays of its own).
   */
  _batchArena(floats) {
    return createPrivateArena(this._renderQueueMemory, floats * 4 + 4096);
  }

  /** W10: painterRadix.wasm on Pixi's painter regions of the render-queue memory, laid out when Pixi sorts. */
  async _bindPainterRadix(data) {
    this._painterWasm = null;
    const memory = data.renderQueueMemory;
    const layout = data.renderQueueLayout?.pixiPainter || null;
    if (!memory || !layout) return;
    if (layout.rows < (this.renderQueueMaxItems | 0)) {
      throw new Error(`[PIXI WORKER] the painter state holds ${layout.rows} rows for a queue of ${this.renderQueueMaxItems | 0}`);
    }
    this._painterWasm = await bindPainterRadix(memory, layout);
  }

  /**
   * W9d: gpuPack.wasm on Pixi's regions of the render-queue memory, when the scene laid them out.
   */
  async _bindPixiGpuPack(data) {
    const memory = data.renderQueueMemory;
    const layout = data.renderQueueLayout;
    // Close-out group B: Pixi's pack scratch is there whenever the emit's regions are (its custom layers and glow
    // batch pack through it in either pack mode); the entities' rows only in pixi pack mode.
    if (!memory || !layout || !(layout.pixiTableByte >= 0)) return;
    this._pixiGpuPack = await bindGpuPack(memory, {
      tableByte: layout.pixiTableByte,
      tableSlots: layout.pixiTableSlots | 0 || layout.tableSlots,
      indexByte: layout.pixiIndexByte,
      indexCap: layout.indexCap,
      particlesByte: layout.pixiParticlesByte,
      inverseByte: 0,
    });
    const rows = layout.pixiInstanceRows | 0;
    if (rows > 0 && rows >= (this.renderQueueMaxItems | 0)) {
      this._pixiInstanceRows = new Float32Array(memory.buffer, layout.pixiInstanceByte, rows * INSTANCED_SPRITE_FLOATS);
    }
    if ((layout.pixiGlowRows | 0) >= (this.renderQueueMaxItems | 0) && layout.pixiGlowByte >= 0) {
      this._pixiGlowRows = new Float32Array(memory.buffer, layout.pixiGlowByte, (this.renderQueueMaxItems | 0) * INSTANCED_SPRITE_FLOATS);
    }
    // E-177: the keyed frames' updates and resync header, for a scene whose sprites go keyed (keyedSpritesEnabled).
    this._pixiKeyed = (layout.pixiKeyRows | 0) > 0 && layout.pixiKeyHeaderByte >= 0
      ? {
          keyBase: layout.pixiKeyBase | 0,
          keyRows: layout.pixiKeyRows | 0,
          updatesByte: layout.pixiKeyUpdatesByte,
          headerByte: layout.pixiKeyHeaderByte,
          texUpdatesByte: layout.pixiKeyTexUpdatesByte ?? -1,
        }
      : null;
  }

  createEntitiesInstancedBatch(maxItems) {
    const painterWasm = this._painterWasm;
    this._rqIdxEntity = painterWasm ? painterSlotList(painterWasm, 'entity', maxItems) : new Uint32Array(maxItems);
    this._rqIdxGlow = painterWasm ? painterSlotList(painterWasm, 'glow', maxItems) : new Uint32Array(maxItems);
    this._painter = this._ySort ? this._newEntityPainter() : null;
    const gpuCaps = this.gpuQueueBuffers && this.gpuQueueBuffers[0] ? this.gpuQueueBuffers[0].caps : null;
    // E-177: keyed frames where Pixi packs into the render-queue memory and the scene laid out their regions (on WebGPU
    // too since E-187: the scatter a compute pass).
    const keyed = this._pixiKeyed !== null && this._pixiInstanceRows !== null ? this._pixiKeyed : null;
    const indexed = !!(gpuCaps && gpuCaps.indexedSprites) || keyed !== null;
    // DX-DEPTH (F5): an oblique camera with a maps page, faces or walls: each pixel's floor depth corrects the painter, on WebGL and
    // WebGPU (renderer.pixelDepth true or false forces it). WebGPU tests it in the canvas's depth, or the SCREEN passes'
    // frame's (_ensureTargetDepth).
    const wantDepth = this.config?.renderer?.pixelDepth;
    const oblique = cameraFloorScaleY(this.config) < 1 && cameraHeightScaleY(this.config) > 0;
    // DX-FACEDEPTH: faces turn it on too, without a map sheet (an empty twin page: no frame has a window in it), and the
    // depth programs then read them: a face's plane depth, its innerZ in the ties, the opaque pass in two programs.
    const facesDepth = this.lighting.faceDepthWanted();
    // OL-14: so do walls whose light is drawn under the canvas's size: the light's edges need the entities' depth.
    const wallsDepth = wallEdgesWanted(this.config?.lighting);
    const pixelDepth = (this.assets.atlasMapsSource !== null || facesDepth || wallsDepth)
      && (wantDepth === true || (wantDepth !== false && oblique))
      ? {
        maps: this.assets.atlasMapsSource ?? this.lighting.emptyMapsSource(),
        // E-378: a nearest atlas without mipmaps samples texels whole, so the edge pass can leave plain frames out.
        plainEdge: this.atlasScaleMode === 'nearest' && this.autoGenerateMipmaps !== true,
      }
      : null;
    this.entitiesBatch = new InstancedSpriteBatch({
      capacity: maxItems,
      label: 'entities-instanced',
      atlasSource: this.assets.resolveAtlasSource(),
      lutSource: this.assets.texLutSource,
      depthTest: false,
      depthMask: false,
      premultiplyAlpha: true,
      useWebGpu: this._useWebGpu,
      shaders: this._engineShaders,
      data: this._pixiInstanceRows,
      gpuPack: this._pixiGpuPack,
      // E-82b: the plain sprites in two streams, the statics uploaded when they change. E-513: a nearest atlas too (its
      // pixel snap is in the sprite vertex shaders: N-271, pixelSnap.js).
      split: true,
      // E-162: with the queue's indexed frames (renderer.indexedSprites), where their statics go: a texture through the
      // record texture helper (WebGL), or a storage buffer within the device's binding size (WebGPU), which a keyed
      // batch's compute pass scatters into (E-187).
      statics: !indexed
        ? null
        : this._useWebGpu
          ? {
              maxStorageBytes: this.pixiApp?.renderer?.gpu?.device?.limits?.maxStorageBufferBindingSize ?? WEBGPU_DEFAULT_STORAGE_BINDING,
              scatter: (source, updates, count, width, height, texUpdates, texCount) =>
                this._scatterStaticsGpu(source, updates, count, texUpdates, texCount),
            }
          : this._gpuRecordTexture(),
      keyed,
      posesByRow: this._keyedPosesByRow,
      pixelDepth,
      depthFaces: facesDepth,
      // E-496: each frame's window in the twin page, for every program of the batch that reads it.
      mapsTable: this.assets.mapsTableSourceOrEmpty(),
      // E-500: whether some frame of that table has heights (after it, which builds the table).
      heightFrames: this.assets.mapsTableHeights,
      // DX-GBUF (plan §6.4): each instance's G-buffer words (gbufWord.js), where the G-buffer pass runs (faces, a sheet
      // with maps, a shadow map: gbufWanted, as pre-render decides it).
      gbuf: gbufWanted(this.config, { maps: this.assets.atlasMapsSource !== null, unshaded: this.assets.atlasUnshaded }),
      // E-448: the binary frames' solid pixels first, nearest first, with the canvas's depth (opaquePass.js), through the
      // record textures (the pass's pose texture); the batch takes it where it can (WebGL, no pixel depth, no G-buffer
      // words).
      opaquePass: pixelDepth === null && !this._useWebGpu ? this._gpuRecordTexture() : null,
      // W30: room for its two streams (15 floats a row), and an indexed frame's slot
      // stream and statics rows; a keyed one's slot stream, updates (its statics are scattered on the GPU) and, E-191, the
      // shadow stream of the sun's pass over its instances (3 floats a row). E-448: a pose texture row more for the pose
      // stream, which the opaque pass copies whole rows of.
      arena: this._batchArena(maxItems * (SPLIT_POSE_FLOATS + POSE_STATIC_FLOATS) + OPAQUE_POSE_TEXELS * 4
        + (keyed !== null
          ? maxItems * (GPU_INDEXED_SLOT_FLOATS + GPU_KEYED_ROW_WORDS + 3)
          : indexed ? maxItems * GPU_INDEXED_SLOT_FLOATS + gpuIndexedStaticRows(maxItems) * GPU_INDEXED_STATIC_FLOATS : 0)
        // E-201: a by-row keyed batch's pose texture data (four blocks).
        + (keyed !== null && this._keyedPosesByRow ? poseBlockFloats(maxItems) * 4 : 0)),
    });
    this.spriteMesh = this.entitiesBatch.mesh;

    if (!this._lightGlowAdd) {
      this.entitiesGlowBatch = null;
      this.spriteGlowMesh = null;
      if (this.assets.flatTextures?.length) this.rebuildInstancedTextureLut();
      debugWorkerLog(`PIXI WORKER: ENTITIES instanced batch ready (capacity ${maxItems}, one blend)`);
      return;
    }

    this.entitiesGlowBatch = new InstancedSpriteBatch({
      capacity: maxItems,
      label: 'entities-glow-instanced',
      atlasSource: this.assets.resolveAtlasSource(),
      lutSource: this.assets.texLutSource,
      depthTest: false,
      depthMask: false,
      premultiplyAlpha: false,
      blendMode: 'add',
      useWebGpu: this._useWebGpu,
      shaders: this._engineShaders,
      // Pixi packs the glow rows here in pixi pack mode, through gpuPack.wasm into its rows of the memory.
      data: this._pixiGlowRows,
      gpuPack: this._pixiGlowRows ? this._pixiGpuPack : null,
      arena: this._batchArena(maxItems * INSTANCED_SPRITE_FLOATS),
    });
    this.spriteGlowMesh = this.entitiesGlowBatch.mesh;

    if (this.assets.flatTextures?.length) this.rebuildInstancedTextureLut();
    debugWorkerLog(`PIXI WORKER: ENTITIES instanced batch ready (capacity ${maxItems}, one blend + glow ADD)`);
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   */
  presentationIsActive() {
    const flag = this._presentingFlag;
    return !(flag && Atomics.load(flag, 0) === 0);
  }

  rememberDeltaTime(deltaTime) {
    this._lastDt = deltaTime > 0 ? deltaTime / 1000 : 1 / 60;
  }

  gpuIsAvailable() {
    return this._gpuLive();
  }

  /**
   * E-198: wait for pre-render's next queue (it notifies on publishFrame), at most the frame period less Pixi's own
   * step and a millisecond, so the frame is still drawn on its vsync. Each frame drew the queue pre-render published a
   * vsync earlier (Pixi starts before it publishes, about 2 ms in): waiting takes that frame off the input's way to the
   * screen. The wait goes into WAIT_MS. A timeout (pre-render slower than the frame allows) turns the waits off for
   * 120 frames. Returns the ready frame after it.
   */
  _waitForQueue(readyFrame) {
    const frame = this.frameNumber | 0;
    const now = performance.now();
    const last = this._queueWaitLastStart;
    this._queueWaitLastStart = now;
    if (last === last) {
      const gap = now - last;
      if (gap > 0 && gap < 100) this._queueWaitPeriodMs = this._queueWaitPeriodMs === this._queueWaitPeriodMs
        ? this._queueWaitPeriodMs * 0.9 + gap * 0.1 : gap;
    }
    if (frame < this._queueWaitOffUntil) return readyFrame;
    const period = this._queueWaitPeriodMs === this._queueWaitPeriodMs ? this._queueWaitPeriodMs : 1000 / 60;
    const step = this._queueWaitStepMs === this._queueWaitStepMs ? this._queueWaitStepMs : period;
    const budget = period - step - 1;
    if (!(budget > 0.5)) return readyFrame;
    const r = Atomics.wait(this.renderQueueSync, 0, readyFrame, budget > period * 0.75 ? period * 0.75 : budget);
    addWaitMs(performance.now() - now);
    // Only a timeout turns the waits off. Windows rounds a wait of a millisecond or more up to its timer period (about
    // 15 ms), so a queue a little past the budget is taken: turning the waits off for it cost liquidFunQueryStressScene
    // its chain (N-146: input lag 35 -> 50 ms, the frames presented the same).
    if (r === 'timed-out') this._queueWaitOffUntil = frame + 120;
    return Atomics.load(this.renderQueueSync, 0);
  }

  /**
   * Swap to the oldest unread render queue. Pixi never waits (but see _waitForQueue, E-198).
   * Pre-render publishes ~2 ms into the same vsync pixi reads in. Jumping to
   * the newest skips a queue when it wins that race, then repeats one the next
   * frame. Backpressure keeps pre-render at most one queue ahead, so the older
   * slot is still intact.
   * Returns whether a new frame was consumed.
   */
  consumeNextRenderQueue() {
    this._deferredRenderQueueRelease = 0;
    if (!this.renderQueueSync) return false;
    const started = this.collectDetailedStats ? performance.now() : 0;
    let readyFrame = Atomics.load(this.renderQueueSync, 0);
    // E-198: every worker wakes on the vsync together (runFramePhase: within 0.2 ms), so the queue out at this frame's
    // start is the one pre-render published a vsync earlier. Wait for this vsync's, and draw it (the older one unread
    // is skipped, once: from then on each frame draws the queue of its own vsync).
    let waitedNew = false;
    if (this._queueWait && this.lastReadFrame > 0) {
      const after = this._waitForQueue(readyFrame);
      waitedNew = after > readyFrame;
      readyFrame = after;
    }
    if (!waitedNew && this._queueBackpressure && this.lastReadFrame > 0 && readyFrame > this.lastReadFrame + 1) {
      readyFrame = this.lastReadFrame + 1;
    }
    let consumedNewFrame = false;
    if (readyFrame > this.lastReadFrame && readyFrame > 0) {
      consumedNewFrame = true;
      const readBufferIndex = (readyFrame - 1) & 1;
      this._setReadBuffer(readBufferIndex);
      this._proxyReadHalf = readBufferIndex;
      for (let i = 0; i < this.customLayers.list.length; i++) {
        const layer = this.customLayers.list[i];
        if (layer.buffers) layer.readRef = layer.buffers[readBufferIndex];
        if (layer.sortKeyU32ByBuf) layer.sortKeyU32 = layer.sortKeyU32ByBuf[readBufferIndex];
      }
      this._latchPose(false, this.renderQueuePoseReady ? this.renderQueuePoseReady[0] : 0);
      // N-138: before the buffer goes back to pre-render.
      if (this._meshPoseLists.length !== 0) {
        takeMeshPoseList(this._meshPoseLists[readBufferIndex], readyFrame, this._meshQueueStamp, this._meshQueuePose);
      }
      this.customLayers.snapshotComputePose();
      this.lastReadFrame = readyFrame;
      if (this._presenting) this._deferredRenderQueueRelease = readyFrame;
      else {
        Atomics.store(this.renderQueueSync, 1, readyFrame);
        Atomics.notify(this.renderQueueSync, 1, 1);
      }
      if (this.renderQueueCamera) {
        this._renderZoom = this.renderQueueCamera[0];
        this._renderCameraX = this.renderQueueCamera[1];
        this._renderCameraY = this.renderQueueCamera[2];
        this._renderCameraRot = this.renderQueueCamera.length > 3 ? (this.renderQueueCamera[3] || 0) : 0;
        this._cameraInitialized = true;
      }
    }
    if (started) this.queueTimeThisFrame = performance.now() - started;
    return consumedNewFrame;
  }

  shouldDrawFrameLockedPasses(consumedNewFrame, resuming) {
    return consumedNewFrame || resuming || this.lastReadFrame <= 0 || !this.renderQueueSync;
  }

  ensureCameraBeforeFirstFrame() {
    if (this._cameraInitialized || !this.cameraData) return;
    this._renderZoom = this.cameraData[0];
    this._renderCameraX = this.cameraData[1];
    this._renderCameraY = this.cameraData[2];
    this._renderCameraRot = this.cameraData.length > 9 ? (this.cameraData[9] || 0) : 0;
    this._cameraInitialized = true;
  }

  syncLayerAlphaFromSharedState() {
    if (!Layer._alphaDirty) return;
    for (let i = 0; i < Layer.count; i++) {
      if (Atomics.load(Layer._alphaDirty, i) !== 1) continue;
      Atomics.store(Layer._alphaDirty, i, 0);
      const name = Layer.getName(i);
      if (Layer._alpha[i] !== 1) this.meshLayers.ensureLookComposite(this.customLayers.byId[i]);
      const displayObject = name ? this._layerRuntime[name] : null;
      if (displayObject) displayObject.alpha = Layer._alpha[i];
      // On the stage a MESH layer's textured rows are a mesh of their own. Through an RT, the Sprite holds the alpha.
      const cl = this.customLayers.byId[i];
      if (cl && cl.uvFillBatch && !cl.rt) cl.uvFillBatch.mesh.alpha = Layer._alpha[i];
      // DBG-3: the unshaded pixels are added where the light is short of them, so they fade with the light they make up for.
      if (name === 'lighting' && this.lighting.unshadedComposite !== null) this.lighting.unshadedComposite.alpha = Layer._alpha[i];
    }
    this.syncSunLayerAlpha();
  }

  /**
   * DBG-2: blendMode, containerBlendMode and zIndex set at run time (the Layer setters: config SAB plus a dirty flag),
   * applied to every object that draws the layer. _applyLayerPresentation reads the same SAB, so registering a layer's
   * object again (a shader swap, a look composite, the light pass rebuilt) keeps them.
   */
  syncLayerPresentationFromSharedState() {
    const dirty = Layer._presentationDirty;
    if (!dirty) return;
    let moved = false;
    for (let i = 0; i < Layer.count; i++) {
      if (Atomics.load(dirty, i) !== 1) continue;
      Atomics.store(dirty, i, 0);
      const name = Layer.getName(i);
      if (name) {
        this._applyLayerBlendAndZ(i, name);
        moved = true;
      }
    }
    if (moved) this.pixiApp.stage.sortChildren();
  }

  /** DBG-2: one layer's blend and z on its display object and on the objects beside it that draw its pixels. */
  _applyLayerBlendAndZ(id, name) {
    const layer = Layer.get(name);
    if (!layer) return;
    const display = this._layerRuntime[name] ?? null;
    const cl = this.customLayers.byId[id];
    const z = layer.zIndex;
    const blend = cl !== undefined && display !== null && this.customLayers.forcesContainerBlend(cl, display)
      ? layer.containerBlendMode
      : layer.blendMode;
    if (display !== null) {
      display.zIndex = z;
      // With edges the light is two meshes with blends of their own (lightEdges.js): the layer's goes on them, not on
      // their host, whose blend they do not inherit.
      if (name === 'lighting' && this.lighting.lightEdges !== null) this.lighting.setLightEdgesBlend(blend);
      else display.blendMode = blend;
    }
    // The entities' meshes set their own blend, so their root's was never inherited: the batch takes it (its opaque pass
    // drops itself off 'normal').
    if (name === 'entities' && this.entitiesBatch) this.entitiesBatch.setLayerBlend(layer.blendMode);
    if (name === 'lighting' && this.lighting.unshadedComposite !== null) this.lighting.unshadedComposite.zIndex = z;
    if (cl === undefined) return;
    // A layer's pieces drawn into its render texture take the container blend; the one on the stage is the display.
    const pieceBlend = layer.containerBlendMode;
    const pieces = [cl.batch?.mesh, cl.fillBatch?.mesh, cl.splatBatch?.mesh];
    for (let k = 0; k < pieces.length; k++) {
      const piece = pieces[k];
      if (piece && piece !== display) piece.blendMode = pieceBlend;
    }
    const uvMesh = cl.uvFillBatch?.mesh;
    if (uvMesh) {
      // On the stage a MESH layer's textured rows draw beside the fill mesh, as it does; through an RT they are a piece.
      const onStage = !cl.rt && !cl.meshLook;
      uvMesh.blendMode = onStage ? (display !== null ? display.blendMode : blend) : pieceBlend;
      if (onStage) uvMesh.zIndex = z;
    }
  }

  /** Layers with alphaBySun, from layer metadata (one short list, so the general layer loops carry no branch). */
  _collectSunLayers() {
    const metas = Layer._metadata?.layers || [];
    const list = [];
    for (let i = 0; i < metas.length; i++) {
      const spec = metas[i]?.alphaBySun;
      if (!spec) continue;
      list.push({ layerId: i, name: Layer.getName(i), spec });
      this.meshLayers.ensureLookComposite(this.customLayers.byId[i]);
    }
    this._sunLayers = list;
    this._layerSunFactor = new Float32Array(Layer.count).fill(1);
  }

  /** alphaBySun: the layer's alpha times the sun's factor, each frame. layer.alpha stays the game's own. */
  syncSunLayerAlpha() {
    const list = this._sunLayers;
    const factors = this._layerSunFactor;
    for (let i = 0; i < list.length; i++) {
      const sl = list[i];
      const factor = Sun.alphaFactor(sl.spec);
      factors[sl.layerId] = factor;
      const displayObject = this._layerRuntime[sl.name];
      if (displayObject) displayObject.alpha = Layer._alpha[sl.layerId] * factor;
    }
  }

  /**
   * Layer.resolution set at run time: the look layer's render textures at the new scale, as a canvas resize makes
   * them. Before the passes that draw them, so this frame fills them.
   */
  syncLayerResolutionFromSharedState() {
    const list = this.customLayers.list;
    const resolutions = Layer._resolution;
    for (let i = 0; i < list.length; i++) {
      const cl = list[i];
      const resolution = resolutions[cl.layerId];
      if (resolution === cl.resolution) continue;
      cl.resolution = resolution;
      this.customLayers.resizeRTs(cl, this.canvasWidth, this.canvasHeight);
    }
  }

  uploadTextureLookupIfNeeded() {
    if (!this.assets.texLutNeedsGpuUpload) return;
    const started = this.collectDetailedStats ? performance.now() : 0;
    this.assets.uploadTexLutTexture();
    if (started) this.miscTimeThisFrame += performance.now() - started;
  }

  drawFrameShadows() {
    const started = this.collectDetailedStats ? performance.now() : 0;
    this.shadowMaps.update();
    if (started) this.shadowsTimeThisFrame = performance.now() - started;
  }

  drawFrameSprites() {
    const started = this.collectDetailedStats ? performance.now() : 0;
    const sortBefore = this.sortTimeThisFrame;
    this.updateSpritesFromRenderQueue();
    if (started) {
      this.spritesTimeThisFrame = performance.now() - started - (this.sortTimeThisFrame - sortBefore);
      this._lastUploadMs = this.spritesTimeThisFrame;
    }
  }

  drawFrameCustomLayers() {
    const started = this.collectDetailedStats ? performance.now() : 0;
    const sortBefore = this.sortTimeThisFrame;
    this.customLayers.update();
    if (started) this.customLayersTimeThisFrame = performance.now() - started - (this.sortTimeThisFrame - sortBefore);
  }

  /**
   * DX-UNSHADED: the unshaded target (the canvas's size) and the unshaded layer, a quad over the canvas just above the
   * lighting layer that adds unshaded · (1 - light) (unshadedComposite.js), its blend additive.
   */
  /** DX-LIGHTEDGES: the programs' environment for lightEdges.js. */
  _lightEdgesEnv() {
    return { GpuProgram, GlProgram: PIXI.GlProgram, useWebGpu: this._useWebGpu };
  }

  /**
   * N-222: the glow layer off the targets a resize is about to replace (EMPTY in their place), as the face map's
   * resources are. _replaceRT destroys every bind group still listening on the old lighting target, the glow
   * composite's own among them, and _bindUnshadedLayer's next read of it threw: the renderer died on a resize.
   */
  /**
   * DBG-5: the render view to draw (renderViews.js RENDER_VIEW) and its opacity over the picture (1 the buffer alone).
   * A view whose buffer this scene has not falls back to the final picture; the final picture releases the quad.
   */
  _setRenderView(view, opacity) {
    const pair = renderViewTextures(this, view, this._renderViewPair);
    this._renderView = pair[0] !== null ? view : RENDER_VIEW.FINAL;
    this._renderViewOpacity = opacity > 0 && opacity <= 1 ? opacity : 1;
    if (this._renderView === RENDER_VIEW.FINAL) this._releaseRenderView();
  }

  /** DBG-5, each present while a view is on: the view's buffers bound (a resize replaces them), its uniforms, its size. */
  _syncRenderView() {
    const pair = renderViewTextures(this, this._renderView, this._renderViewPair);
    if (pair[0] === null) {
      this._renderView = RENDER_VIEW.FINAL;
      this._releaseRenderView();
      return;
    }
    if (this._renderView === RENDER_VIEW.LIGHT_TILES) {
      if (this._renderViewMesh !== null && this._renderViewMesh.visible) this._renderViewMesh.visible = false;
      this._syncTilesView(pair[0]);
      return;
    }
    if (this._renderTilesMesh !== null && this._renderTilesMesh.visible) this._renderTilesMesh.visible = false;
    if (this._renderViewMesh === null) this._createRenderView();
    const res = this._renderViewMesh.shader.resources;
    const main = pair[0].source;
    const second = pair[1] !== null ? pair[1].source : PIXI.Texture.EMPTY.source;
    if (res.uTex !== main) {
      res.uTex = main;
      if (this._useWebGpu) res.uTexSampler = main.style;
    }
    if (res.uTex2 !== second) {
      res.uTex2 = second;
      if (this._useWebGpu) res.uTex2Sampler = second.style;
    }
    const p = this._renderViewParams;
    const both = pair[1] !== null ? 1 : 0;
    if (p[0] !== this._renderView || p[1] !== Math.fround(this._renderViewOpacity) || p[3] !== both) {
      p[0] = this._renderView;
      p[1] = this._renderViewOpacity;
      p[2] = RENDER_VIEW_HEIGHT_PX;
      p[3] = both;
      this._renderViewUniforms.update();
    }
    const q = this._renderViewQuad;
    if (q[2] !== this.canvasWidth || q[5] !== this.canvasHeight) {
      unshadedQuadPositions(q, this.canvasWidth, this.canvasHeight);
      this._renderViewQuadBuffer.update();
    }
    if (!this._renderViewMesh.visible) this._renderViewMesh.visible = true;
  }

  /** DBG-5: the view's quad over the canvas, on top of the stage, drawn with normal blending (premultiplied). */
  _createRenderView() {
    const q = unshadedQuadPositions(this._renderViewQuad, this.canvasWidth, this.canvasHeight);
    this._renderViewQuadBuffer = new Buffer({ data: q, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    const geometry = new PIXI.Geometry({
      attributes: {
        aPosition: { buffer: this._renderViewQuadBuffer, format: 'float32x2', stride: 8, offset: 0 },
        aUV: [0, 0, 1, 0, 1, 1, 0, 1],
      },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });
    this._renderViewUniforms = new UniformGroup({ uView: { value: this._renderViewParams, type: 'vec4<f32>' } });
    const empty = PIXI.Texture.EMPTY.source;
    const shader = this._useWebGpu
      ? new PIXI.Shader({
          gpuProgram: renderViewGpuProgram(GpuProgram),
          resources: {
            uTex: empty, uTexSampler: empty.style, uTex2: empty, uTex2Sampler: empty.style, viewUniforms: this._renderViewUniforms,
          },
        })
      : new PIXI.Shader({
          glProgram: PIXI.GlProgram.from({ vertex: RENDER_VIEW_VERT, fragment: RENDER_VIEW_FRAG, name: 'weed-render-view' }),
          resources: { uTex: empty, uTex2: empty, viewUniforms: this._renderViewUniforms },
        });
    const state = new PIXI.State();
    state.blendMode = 'normal';
    state.depthTest = false;
    state.depthMask = false;
    state.culling = false;
    const mesh = new PIXI.Mesh({ geometry, shader, state, label: 'weed-render-view' });
    mesh.cullable = false;
    mesh.visible = false;
    mesh.zIndex = RENDER_VIEW_Z;
    this._renderViewParams.fill(-1);
    this._renderViewMesh = mesh;
    this.pixiApp.stage.addChild(mesh);
    this.pixiApp.stage.sortChildren();
  }

  /** DBG-7: the light tiles view each present: the tiles' texture, the grid as the light pass laid it out, the size. */
  _syncTilesView(source) {
    if (this._renderTilesMesh === null) this._createTilesView();
    const res = this._renderTilesMesh.shader.resources;
    if (res.uTiles !== source) res.uTiles = source;
    const t = this.lighting.lightTiles;
    const g = this._renderTilesGrid;
    const w = this._renderTilesWords;
    const c = this._renderTilesCanvas;
    const opacity = Math.fround(this._renderViewOpacity);
    const white = Math.min(this.maxLights, 32);
    if (g[0] !== t.tilePx || g[1] !== t.border || g[2] !== t.cols || g[3] !== t.rows
      || w[0] !== t.wordsUsed || w[1] !== t.rowsPerWord || w[2] !== Math.fround(this.lightingResolution) || w[3] !== opacity
      || c[0] !== this.canvasWidth || c[1] !== this.canvasHeight || c[2] !== white) {
      g[0] = t.tilePx;
      g[1] = t.border;
      g[2] = t.cols;
      g[3] = t.rows;
      w[0] = t.wordsUsed;
      w[1] = t.rowsPerWord;
      w[2] = this.lightingResolution;
      w[3] = opacity;
      c[0] = this.canvasWidth;
      c[1] = this.canvasHeight;
      c[2] = white;
      this._renderTilesUniforms.update();
    }
    const q = this._renderTilesQuad;
    if (q[2] !== this.canvasWidth || q[5] !== this.canvasHeight) {
      unshadedQuadPositions(q, this.canvasWidth, this.canvasHeight);
      this._renderTilesQuadBuffer.update();
    }
    if (!this._renderTilesMesh.visible) this._renderTilesMesh.visible = true;
  }

  /**
   * DBG-7: the light tile under canvas point (x, y) as the light pass binned it this frame: the tile (x, y: -1 outside
   * the grid), the grid's numbers, and the lights the tile lists (indices in the light data, word k's bit j is k·32 + j).
   */
  _lightTileAt(x, y) {
    const t = this.lighting.lightTiles;
    const out = {
      msg: 'lightTile', x: -1, y: -1, cols: t.cols, rows: t.rows, tilePx: t.tilePx, border: t.border, wordsUsed: t.wordsUsed,
      lights: [],
    };
    if (t.texWidth < 1 || !(t.tilePx > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return out;
    const res = this.lightingResolution;
    const cx = Math.floor((x * res) / t.tilePx) + t.border;
    const cy = Math.floor((y * res) / t.tilePx) + t.border;
    if (cx < 0 || cy < 0 || cx >= t.cols || cy >= t.rows) return out;
    out.x = cx;
    out.y = cy;
    for (let k = 0; k < t.wordsUsed; k++) {
      let word = t.bits[(cy + k * t.rowsPerWord) * t.texWidth + cx] >>> 0;
      for (let j = 0; word !== 0; j++, word >>>= 1) {
        if (word & 1) out.lights.push(k * 32 + j);
      }
    }
    return out;
  }

  /** DBG-7: the tiles view's quad over the canvas, on top of the stage. */
  _createTilesView() {
    const q = unshadedQuadPositions(this._renderTilesQuad, this.canvasWidth, this.canvasHeight);
    this._renderTilesQuadBuffer = new Buffer({ data: q, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    const geometry = new PIXI.Geometry({
      attributes: {
        aPosition: { buffer: this._renderTilesQuadBuffer, format: 'float32x2', stride: 8, offset: 0 },
        aUV: [0, 0, 1, 0, 1, 1, 0, 1],
      },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });
    this._renderTilesUniforms = new UniformGroup({
      uGrid: { value: this._renderTilesGrid, type: 'vec4<f32>' },
      uWords: { value: this._renderTilesWords, type: 'vec4<f32>' },
      uCanvas: { value: this._renderTilesCanvas, type: 'vec4<f32>' },
    });
    const source = this.lighting.lightTilesSource;
    const shader = this._useWebGpu
      ? new PIXI.Shader({ gpuProgram: renderTilesGpuProgram(GpuProgram), resources: { uTiles: source, tileUniforms: this._renderTilesUniforms } })
      : new PIXI.Shader({
          glProgram: PIXI.GlProgram.from({ vertex: RENDER_VIEW_VERT, fragment: RENDER_TILES_FRAG, name: 'weed-render-tiles' }),
          resources: { uTiles: source, tileUniforms: this._renderTilesUniforms },
        });
    const state = new PIXI.State();
    state.blendMode = 'normal';
    state.depthTest = false;
    state.depthMask = false;
    state.culling = false;
    const mesh = new PIXI.Mesh({ geometry, shader, state, label: 'weed-render-tiles' });
    mesh.cullable = false;
    mesh.visible = false;
    mesh.zIndex = RENDER_VIEW_Z;
    this._renderTilesGrid.fill(-1);
    this._renderTilesMesh = mesh;
    this.pixiApp.stage.addChild(mesh);
    this.pixiApp.stage.sortChildren();
  }

  /** DBG-5: back to the final picture: the quad, its geometry and buffer go. */
  _releaseRenderView() {
    this._releaseTilesView();
    const mesh = this._renderViewMesh;
    if (mesh === null) return;
    this._renderViewMesh = null;
    if (mesh.parent) mesh.parent.removeChild(mesh);
    const geometry = mesh.geometry;
    mesh.destroy();
    geometry.destroy();
    this._renderViewQuadBuffer = null;
    this._renderViewUniforms = null;
  }

  /** DBG-7: the tiles view's quad, its geometry and buffer go. */
  _releaseTilesView() {
    const mesh = this._renderTilesMesh;
    if (mesh === null) return;
    this._renderTilesMesh = null;
    if (mesh.parent) mesh.parent.removeChild(mesh);
    const geometry = mesh.geometry;
    mesh.destroy();
    geometry.destroy();
    this._renderTilesQuadBuffer = null;
    this._renderTilesUniforms = null;
  }

  /** DBG-5: the view's quad off the targets a resize is about to replace (N-222's rule, as the unshaded layer's). */
  _unbindRenderView() {
    const mesh = this._renderViewMesh;
    if (mesh === null) return;
    const res = mesh.shader.resources;
    const empty = PIXI.Texture.EMPTY.source;
    if (res.uTex !== empty) res.uTex = empty;
    if (res.uTex2 !== empty) res.uTex2 = empty;
    if (this._useWebGpu) {
      if (res.uTexSampler !== empty.style) res.uTexSampler = empty.style;
      if (res.uTex2Sampler !== empty.style) res.uTex2Sampler = empty.style;
    }
  }

  /** DX-DEPTH: whether the entities take pixel depth by the scene's camera (renderer.pixelDepth true, or oblique). */
  _pixelDepthWanted() {
    const want = this.config?.renderer?.pixelDepth;
    return want === true || (want !== false && cameraFloorScaleY(this.config) < 1 && cameraHeightScaleY(this.config) > 0);
  }

  /**
   * DX-FACEDEPTH: the entities batch's pixel depth meshes in their places among the entities' root: the vertex-depth opaque
   * program right before the batch's own mesh, the edge pass right after it.
   */
  _placeDepthMeshes() {
    const root = this._entitiesRoot;
    const batch = this.entitiesBatch;
    if (!root || !batch || this.spriteMesh?.parent !== root) return;
    const { before, after } = batch.pixelDepthMeshes();
    if (before !== null && before.parent !== root) root.addChildAt(before, root.getChildIndex(this.spriteMesh));
    if (after !== null && after.parent !== root) root.addChildAt(after, root.getChildIndex(this.spriteMesh) + 1);
  }

  applyLayerVisibility() {
    const started = this.collectDetailedStats ? performance.now() : 0;
    this._applyLayerVisibility();
    if (started) this.miscTimeThisFrame += performance.now() - started;
  }

  presentStage() {
    const started = this.collectDetailedStats ? performance.now() : 0;
    this._presentStage();
    if (started) this.presentTimeThisFrame = performance.now() - started;
  }

  releaseRenderQueueIfHeld() {
    const frame = this._deferredRenderQueueRelease | 0;
    this._deferredRenderQueueRelease = 0;
    if (!frame || !this.renderQueueSync) return;
    Atomics.store(this.renderQueueSync, 1, frame);
    Atomics.notify(this.renderQueueSync, 1, 1);
  }

  update(deltaTime, dtRatio, resuming) {
    this._pacedTick = false;
    if (!this.presentationIsActive()) this._stopGpuClock();
    this.rememberDeltaTime(deltaTime);
    this.presentTimeThisFrame = 0;
    // Before consumeNextRenderQueue, never after it. Taking a frame sets
    // _deferredRenderQueueRelease and only releaseRenderQueueIfHeld stores it,
    // so returning between the two strands pre-render's backpressure counter:
    // pixiIsMoreThanOneFrameBehind then skips every later frame. No GPU, no
    // queue taken; lastReadFrame holds and the backpressure clamp walks us
    // forward one frame at a time when it comes back.
    if (!this.gpuIsAvailable()) {
      this._newQueueThisFrame = 0;
      return;
    }
    // E-97. Also before the queue is taken. A lockstep step always draws.
    const paced = this._injectedDeltaTime === 0 && this._framePacer.enabled;
    if (paced && this._framePacer.busy()) {
      this._pacedTick = true;
      this._newQueueThisFrame = 0;
      return;
    }
    // E-339: the decal tiles go up before the queue wait (they never read the queue), flushed, so the GPU process copies
    // them while Pixi waits instead of after it, and a tile stamped this frame is culled in the same frame it goes up.
    this._decalTilesDirtyThisFrame = 0;
    this._decalTilesUploadedThisFrame = 0;
    this.decalTiles.update();
    if (this._decalTilesUploadedThisFrame !== 0 && !this._useWebGpu) this.pixiApp.renderer.gl.flush();
    const consumedNewFrame = this.consumeNextRenderQueue();
    this._newQueueThisFrame = consumedNewFrame ? 1 : 0;

    this.lightsTimeThisFrame = 0;
    this.shadowsTimeThisFrame = 0;
    this.spritesTimeThisFrame = 0;
    this.sortTimeThisFrame = 0;
    this.customLayersTimeThisFrame = 0;
    this.miscTimeThisFrame = 0;
    this.customLayers.meshFillInstancesThisFrame = 0;
    this.customLayers.meshRtDrawsThisFrame = 0;
    this._gpuPassesThisFrame = 0;
    this._gpuCastersThisFrame = 0;
    this._gpuShadowLightsThisFrame = 0;

    try {
      this.ensureCameraBeforeFirstFrame();
      this.updateCameraTransform();
      this.updateGpuParticleLayers();
      this.syncLayerAlphaFromSharedState();
      this.syncLayerPresentationFromSharedState();
      if (this.shouldDrawFrameLockedPasses(consumedNewFrame, resuming)) {
        this.syncLayerResolutionFromSharedState();
        this.uploadTextureLookupIfNeeded();
        // DX-BARRIOS: the first decoration with a normal turns faces on (the G-buffer, the depth's planes).
        if (!this._facesUsed && DecorationPool.facesInUse()) this.lighting.useFaces();
        this.lighting.drawFrameLights();
        // E-191: the sprites first, so a keyed frame's statics texture and instances are this frame's when the sun's
        // shadow pass draws them.
        this.drawFrameSprites();
        this.drawFrameShadows();
        this.drawFrameCustomLayers();
        this.lighting.renderLightingToTexture();
        this.glowLayer.draw();
      }
      this.applyLayerVisibility();
      this.presentStage();
      if (paced) this._framePacer.submitted();
    } finally {
      this.releaseRenderQueueIfHeld();
    }
  }

  /**
   * Setup PIXI ticker to call gameLoop (custom scheduler implementation)
   */
  onCustomSchedulerStart() {
    // A boot that failed said so (initialize): there is nothing to draw.
    if (this.pixiApp === null) return;
    if (this.fixedFps > 0 || this.noLimitFPS) {
      // Bypass PIXI ticker — use AbstractWorker scheduleNextFrame (interval / uncapped / RAF)
      this.usesCustomScheduler = false;
      this.scheduleNextFrame();
    } else {
      // Display rate, like every other worker's rAF. Pixi's maxFPS limiter
      // truncates the delta to whole ms, so a 60 cap on a 59.9x Hz display
      // drops a tick every ~0.5 s (and pre-render backpressure then skips one).
      if (this.pixiApp.ticker) this.pixiApp.ticker.maxFPS = 0;
      this.pixiApp.ticker.add(() => this.gameLoop());
    }
  }

  afterManualStep() {
    const app = this.pixiApp;
    if (app?.ticker) {
      app.ticker.autoStart = false;
      app.ticker.stop();
    }
    this._presentStage();
  }

  setPresenting(on) {
    if (!on) {
      this._noteHidden();
      return;
    }
    this._presenting = true;
    if (this.isPaused) return;
    if (this.usesCustomScheduler) this.pixiApp?.ticker?.start();
    else this.scheduleNextFrame();
  }

  rebindSurface() {
    const pending = takePendingResize(this);
    if (pending) {
      this._applyResize(pending.width, pending.height);
      return;
    }
    if (this._useWebGpu) this._bindWebGpuSwapchain();
  }

  /** Main thread stores 0 on hide/unload. Read it before every submit. */
  _gpuLive() {
    const flag = this._presentingFlag;
    if (flag && Atomics.load(flag, 0) === 0) {
      this._stopGpuClock();
      return false;
    }
    return this._presenting;
  }

  _stopGpuClock() {
    this._presenting = false;
    this.pixiApp?.ticker?.stop();
    this._clearFrameSchedulers();
  }

  _noteHidden() {
    this._stopGpuClock();
    this._unconfigureSurface();
  }

  _unconfigureSurface() {
    if (this._surfaceUnconfigured) return;
    this._surfaceUnconfigured = true;
    const renderer = this.pixiApp?.renderer;
    const viewRt = renderer?.view?.renderTarget;
    const colorTexture = viewRt?.colorAttachments?.[0]?.texture ?? viewRt?.colorTextures?.[0];
    const source = colorTexture?.resource ? colorTexture : colorTexture?.source;
    const context = source?._gpuContext;
    if (context && typeof context.unconfigure === 'function') {
      try { context.unconfigure(); } catch (_) { /* surface already gone */ }
    }
  }

  _submitRender(opts) {
    if (!this._gpuLive()) return false;
    this.pixiApp.renderer.render(opts);
    return true;
  }

  /**
   * SST-0: the first frame drawn once the game runs ends the load waterfall: its marks go to the page. Tested once a frame,
   * after the stage's present (_presentStage): a scene without passes into targets (bunnyMark) presents through Pixi's own
   * render (_pixiPresent), which never goes through _submitRender.
   */
  _postFirstDrawMarks() {
    this._loadMarksOpen = false;
    loadMark('first draw');
    self.postMessage({ msg: 'loadMarks', marks: takeLoadMarks() });
  }

  pause() {
    this.isPaused = true;
    this._clearFrameSchedulers();
    this.pixiApp?.ticker?.stop();
  }

  resume() {
    if (!this.isPaused) return; // running already: no second loop (AbstractWorker.resume)
    this.isPaused = false;
    this.lastFrameTime = performance.now();
    if (this.usesCustomScheduler) {
      this.pixiApp?.ticker?.start();
      return;
    }
    this.gameLoop(true);
  }

  /** Weed owns the swapchain present. Skip when the document is hidden. */
  _presentStage() {
    if (!this._gpuLive()) return;
    if (this._renderView !== 0) this._syncRenderView();
    // DX-POST: one test a frame without SCREEN layers; the present as before.
    const throughScreenLayers = this.screenLayers.passes.length > 0 && this.screenLayers.present();
    if (!throughScreenLayers) {
      if (this._pixiPresent !== null) {
        this._pixiPresent();
      } else {
        const app = this.pixiApp;
        if (!app?.renderer || !app.stage) return;
        this._submitRender(app.stage);
      }
    }
    if (this._loadMarksOpen && !this.isPaused) this._postFirstDrawMarks();
  }

  _takePresentOwnership() {
    const app = this.pixiApp;
    if (!app || typeof app.render !== 'function') return;
    const original = app.render;
    this._pixiPresent = original.bind(app);
    if (app.ticker) app.ticker.remove(original, app);
    app.render = () => this._presentStage();
  }

  /**
   * DX-DEPTH: `rt`'s render target with a depth-stencil attachment (Pixi makes it at its size and clears it with the
   * colour), for programs that test or write depth there: the entities' pixel depth on WebGPU.
   */
  _ensureTargetDepth(rt) {
    const system = this.pixiApp?.renderer?.renderTarget;
    const target = system && typeof system.getRenderTarget === 'function' ? system.getRenderTarget(rt) : null;
    if (target && !target.depthStencilAttachment && typeof target.ensureDepthStencilTexture === 'function') {
      target.ensureDepthStencilTexture();
    }
  }

  /* =====================
LIGHTING SYSTEM SETUP
===================== */

  /**
   * N-136. The active particle list the light field walks: the copy the particle worker published last, held until
   * the next take, so the particle worker writes the next lists elsewhere; the one list it was handed when nothing is
   * published (a test).
   */
  _takeActiveParticles() {
    const ctl = this.activeParticlesCtl;
    if (ctl.length === 0) return this.activeParticlesData;
    return this.activeParticlesCopies[takePublishedList(ctl)];
  }

  /* =====================
COMPUTE VISIBLE LIGHTS (used by updateLighting shader)
===================== */

  /* =====================
UPDATE LIGHTING (NO ZOOM SCALING)
===================== */

  /**
   * DX-SHADOW3D (F6): each sun-projected volumes' layer drawn into the sun's map: the same mesh rows, each vertex landing
   * by the map's shift (sunMapTerms, per px of height; the volumes' heights are screen px, so over heightScaleY), its
   * height out, max blending. GLSL on WebGL (sunShadowMap.js volumeMapVertex), WGSL on WebGPU (volumeShadowMap.js
   * volumeMapWgsl). The rows are in world px: the render's transform takes them into the map as its cards land
   * ((world - camera) · screenScale, sunMapVertex).
   */
  /**
   * DX-SHADOW3D: the columns' mesh over a caster geometry: its instance attributes, the column grid instead of the quad,
   * indexed in order (the grid lists its triangles). Made once a geometry (the ring swaps them); the instance count each frame.
   */
  handleCustomMessage(data) {
    const { msg } = data;
    if (msg === 'atlasBitmaps') {
      this.assets.takeEarlyAtlas(data.sheets);
      return;
    }
    if (msg === 'box2dReady' && data.channelOffsets) {
      bindBox2dHotFields(data);
      if (data.commandSab) {
        bindCommandRing(data.commandSab);
      }
      if (data.liquidFunHeap) {
        LiquidFun.bindHeapPose(this._liquidFunHeapPayload(data.liquidFunHeap));
      }
      return;
    }
    if (msg === 'liquidFunHeap' && data.liquidFunHeap) {
      LiquidFun.bindHeapPose(this._liquidFunHeapPayload(data.liquidFunHeap));
      return;
    }
    if (msg === 'liquidFunCleared') return;
    if (msg === 'loseGpuForTest') {
      this._loseGpuForTest(data.restoreAfterMs);
      return;
    }
    if (msg === 'setRenderView' || msg === 'listRenderViews') {
      // DBG-5: the debug UI's Render tab; the answer lists the views this scene has now.
      if (msg === 'setRenderView') this._setRenderView(data.view | 0, +data.opacity);
      self.postMessage({ msg: 'renderViews', views: availableRenderViews(this), view: this._renderView });
      return;
    }
    if (msg === 'lightTileAt') {
      // DBG-7: the Render tab's readout of the light tile under a canvas point.
      self.postMessage(this._lightTileAt(+data.x, +data.y));
      return;
    }
    debugWorkerLog(`PIXI WORKER: handleCustomMessage called with msg: ${msg}`);

    if (msg === 'setLayerContent') {
      this.handleSetLayerContent(data);
    } else if (msg === 'setLayerProps') {
      this.customLayers.setLayerProps(data);
    } else {
      debugWorkerLog(`PIXI WORKER: Unhandled message type: ${msg}`);
    }
  }

  /**
   * N-301's test hook: lose the GPU as a driver reset would. WebGL: WEBGL_lose_context, restored after restoreAfterMs.
   * WebGPU: the device destroyed (its lost promise then says 'destroyed', which _gpuLossTest makes count as a loss).
   * @param {number} restoreAfterMs
   */
  _loseGpuForTest(restoreAfterMs) {
    if (this._useWebGpu) {
      const device = this.pixiApp?.renderer?.gpu?.device;
      if (!device) return;
      this._gpuLossTest = true;
      device.destroy();
      return;
    }
    const gl = this.pixiApp?.renderer?.gl;
    const lose = gl && gl.getExtension('WEBGL_lose_context');
    if (!lose) return;
    lose.loseContext();
    setTimeout(() => lose.restoreContext(), Math.max(0, restoreAfterMs | 0));
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

  /** World px -> RT px of a viewport-sized layer RT at `resolution`, rotation included, into `mx`. */
  _writeCameraRtTransform(mx, cl) {
    // The layer's RT resolution (null: the screen, 1). Read here and written field by field: doubles passed to a
    // call TurboFan does not inline (this one, or Matrix.set) are boxed. A Matrix's fields are tagged, so each double
    // written is a heap number: a camera that holds still writes none.
    const resolution = cl !== null ? cl.resolution || 1 : 1;
    const z = this._renderZoom * resolution;
    const rot = this._renderCameraRot || 0;
    if (!rot) {
      const tx = -this._renderCameraX * z;
      const ty = -this._renderCameraY * z;
      if (mx.a !== z) mx.a = z;
      if (mx.b !== 0) mx.b = 0;
      if (mx.c !== 0) mx.c = 0;
      if (mx.d !== z) mx.d = z;
      if (mx.tx !== tx) mx.tx = tx;
      if (mx.ty !== ty) mx.ty = ty;
      return mx;
    }
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const a = z * c;
    const b = z * s;
    const cc = -z * s;
    const d = z * c;
    const focusX = this._renderCameraX + (this.canvasWidth || 0) / (2 * (this._renderZoom || 1));
    const focusY = this._renderCameraY + (this.canvasHeight || 0) / (2 * (this._renderZoom || 1));
    const screenCx = (this.canvasWidth || 0) * resolution * 0.5;
    const screenCy = (this.canvasHeight || 0) * resolution * 0.5;
    mx.a = a;
    mx.b = b;
    mx.c = cc;
    mx.d = d;
    mx.tx = screenCx - a * focusX - cc * focusY;
    mx.ty = screenCy - b * focusX - d * focusY;
    return mx;
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
      const show = on && (name !== 'lightGlows' || this._lightGlowAdd);
      if (displayObj) setDisplayVisible(displayObj, show);
      // DBG-1: on the stage a MESH layer's textured rows are a mesh of their own beside the fill mesh (through an RT the
      // layer's sprite holds both). Its geometry's instanceCount says whether it has triangles (setDisplayVisible).
      const cl = this.customLayers.byId[i];
      if (cl !== undefined && cl.uvFillBatch && !cl.rt && !cl.meshLook) setDisplayVisible(cl.uvFillBatch.mesh, show);
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

  /**
   * PixiJS-specific resize: resize renderer and render textures.
   * Base class (AbstractWorker) already updates canvasWidth/Height, config, and Camera.
   */
  onResize(width, height) {
    if (stashResizeWhileHidden(this, width, height)) return;
    this._applyResize(width, height);
  }

  _applyResize(width, height) {
    // DBG-5: off the targets the resize replaces; the next present binds the new ones.
    this._unbindRenderView();
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
    if (this.lighting.lightingRT) {
      const lw = rtPixelSize(width, this.lightingResolution);
      const lh = rtPixelSize(height, this.lightingResolution);
      if (this.lighting.faceRT !== null) {
        this.lighting.releaseGbufTarget();
        this.lighting.lightingShader.resources.uFaceMap = PIXI.Texture.EMPTY.source;
        this.lighting.faceRT.destroy(true);
        if (this.lighting.faceIdsRT !== null) {
          this.lighting.lightingShader.resources.uFaceIds = PIXI.Texture.EMPTY.source;
          this.lighting.faceIdsRT.destroy(true);
          this.lighting.faceIdsRT = null;
        }
        this.lighting.createFaceMap(lw, lh);
      }
      this.lighting.unbindUnshadedLayer();
      if (this.lighting.lightEdges !== null) {
        // DX-LIGHTEDGES: off the old target before _replaceRT destroys its bind groups; the canvas quad at the new size.
        this.lighting.bindLightEdges(PIXI.Texture.EMPTY.source, PIXI.Texture.EMPTY.source);
        unshadedQuadPositions(this.lighting.lightEdgesQuad, width, height);
        if (this.lighting.lightEdgesQuadBuffer !== null) this.lighting.lightEdgesQuadBuffer.update();
      }
      this.lighting.lightingRT = this._replaceRT(
        this.lighting.lightingRT,
        lw,
        lh,
        this.lighting.lightingDisplaySprite,
        null
      );
      if (this.lighting.lightEdges !== null && this.lighting.unshadedEdges === null) this.lighting.bindLightEdges(this.lighting.lightingRT.source, PIXI.Texture.EMPTY.source);
      if (this.lighting.lightingDisplaySprite) {
        this.lighting.lightingDisplaySprite.scale.set(width / lw, height / lh);
      }
      if (this.lighting.unshadedRT !== null) {
        this.lighting.unshadedRT.destroy(true);
        this.lighting.unshadedRT = PIXI.RenderTexture.create({ width, height });
        unshadedQuadPositions(this.lighting.unshadedQuad, width, height);
        if (this.lighting.unshadedQuadBuffer !== null) this.lighting.unshadedQuadBuffer.update();
      }
      this.lighting.bindUnshadedLayer();
    }

    // Sync lighting shader uniforms immediately
    if (this.lighting.lightingShader) this.lighting.applyLightingViewport(width, height);

    // N-317: the sun's map made again at the new size, its margins too, on the next sun map pass (_fitSunMap).
    if (this.sunMapRT) {
      this._sunMapMargins.fill(0);
      this.shadowMaps.createSunMap(rtPixelSize(width, this.shadowResolution), rtPixelSize(height, this.shadowResolution));
    }

    // E-404: the lightGlows target follows the canvas.
    if (this.glowLayer.rt !== null) this.glowLayer.resizeTarget(this.glowLayer.res, width, height);

    // Viewport look/density RTs (compute layers have rtOut only).
    for (let i = 0; i < this.customLayers.list.length; i++) {
      this.customLayers.resizeRTs(this.customLayers.list[i], width, height);
    }

    this.scenery.applyCoverTransforms();

    debugWorkerLog(`PIXI WORKER: Resized to ${width}x${height}`);
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

    this.scenery.destroy(layerId);

    switch (type) {
      case 'static':
        this.scenery.createStatic(layerId, layerName, textureId, parallaxX, parallaxY);
        break;
      case 'cover':
        this.scenery.createCover(layerId, layerName, textureId, { parallaxX, parallaxY, margin, zoomParallax });
        break;
      case 'tiling':
        this.scenery.createTiling(layerId, layerName, textureId, tileScale, parallaxX, parallaxY);
        break;
      case 'tilemap':
        this.scenery.createTilemap(layerId, layerName, tilemapId, options, parallaxX, parallaxY);
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
      this._renderCameraRot = this.cameraData.length > 9 ? (this.cameraData[9] || 0) : 0;
      this._cameraInitialized = true;
    }
    this.updateCameraTransform();

    this._presentStage();

    self.postMessage({ msg: 'layerContentReady', layerId, requestId });
  }

  /**
   * E-475: links every WebGL program made while the worker started (GlProgram.weedMade) all at once and waits for them
   * without blocking (KHR_parallel_shader_compile: the driver links on its own threads, and COMPLETION_STATUS_KHR, asked
   * every few ms, never waits), so the worker reports ready with its programs linked and no frame waits for one. Pixi
   * linked each program on its first bind and waited for it: Predator by night waited 2.1 s in its first frames, 1.3 s of
   * it for the light pass. A program made later (a pass's on its first use) Pixi links as before.
   */
  async _linkProgramsAhead() {
    const made = this._madePrograms;
    PIXI.GlProgram.weedMade = null;
    const shaders = this._useWebGpu ? null : this.pixiApp?.renderer?.shader;
    if (shaders && typeof shaders.weedLinkAhead === 'function') {
      // SST-1: boot's programs started linking at boot; the rest start now.
      this._startLinksAhead();
      const deadline = performance.now() + LINK_AHEAD_WAIT_MS;
      while (shaders.weedLinksRunning() > 0 && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
    }
    made.length = 0;
  }

  /**
   * SST-1: the renderer's start that needs neither the assets nor the shared buffers, from the page's 'boot' message (posted
   * right after `new Worker`, before the page loads any asset; AbstractWorker keeps its promise in _bootPromise): the
   * engine shaders' fetches and, at the same time, the GPU device and pixiApp.init on the page's canvas; then the programs
   * made so far start linking (E-475). initialize awaits it and does what needs the assets. An error waits for
   * initialize, which reports it as it did when all this ran there.
   * @param {{ config: object, canvas: OffscreenCanvas, canvasWidth: number, canvasHeight: number,
   *   engineShaders?: Object<string, string>|null, pageOrigin?: string }} data
   */
  async boot(data) {
    try {
      await super.boot(data);
      await this._bootRenderer(data);
    } catch (error) {
      this._bootError = error;
    }
  }

  /** SST-1: the renderer's part of boot (AbstractWorker's boot took the config, engine.wasm and the page's origin). */
  async _bootRenderer(data) {
    const config = data.config || {};
    const rendererConfig = config.renderer || {};
    const backend = normalizeRendererBackend(rendererConfig.backend);
    this._useWebGpu = backend === RENDERER_BACKEND_WEBGPU;
    // Bundles embed the engine shaders and post them; source builds fetch them.
    embeddedEngineShaders = data.engineShaders || null;
    if (!data.canvas) throw new Error("WeedJS: the renderer's 'boot' message carries no canvas");
    this.canvasView = data.canvas;
    this.canvasWidth = (data.canvasWidth ?? data.canvas.width) | 0;
    this.canvasHeight = (data.canvasHeight ?? data.canvas.height) | 0;
    // From renderer.atlasScaleMode: the atlas's and the loose textures' sampling, both sprite passes'.
    const atlasScaleMode = rendererConfig.atlasScaleMode;
    this.atlasScaleMode =
      atlasScaleMode === 'nearest' || atlasScaleMode === 'linear' ? atlasScaleMode : RENDERER_DEFAULTS.atlasScaleMode;
    this.pixelSnapCorners = rendererConfig.pixelSnapCorners !== false;
    // At boot too: the atlas's source may be made before the init (SST-19).
    // E-204: null (the default) is on with a linear atlas, off with a nearest one.
    const mipmaps = rendererConfig.autoGenerateMipmaps ?? RENDERER_DEFAULTS.autoGenerateMipmaps;
    this.autoGenerateMipmaps = mipmaps === null ? this.atlasScaleMode === 'linear' : !!mipmaps;

    const shadersFetched = this._fetchEngineShaders().then(() => loadMark('shaders fetched'));
    await Promise.all([shadersFetched, this._startPixi(config, backend)]);

    // N-271: a nearest atlas snaps each sprite to the pixel grid in its vertex shader (pixelSnap.js), before any sprite
    // program is made from these sources; the packs leave the poses as they are. N-302: an axis-aligned sprite's corners
    // (renderer.pixelSnapCorners, default) or its origin.
    if (this.atlasScaleMode === 'nearest') applyPixelSnap(this._engineShaders, this._useWebGpu, this.pixelSnapCorners);
    // E-204: with mip levels, the atlas read sharper than the GPU's own level (renderer.mipmapBias, default -1).
    if (this.autoGenerateMipmaps) {
      const bias = config.renderer?.mipmapBias ?? RENDERER_DEFAULTS.mipmapBias;
      applyMipmapBias(this._engineShaders, Number(bias));
    }
    this.scenery.initTilemapGidProgram();
    // E-475: what boot made links on the driver's threads while the page loads the assets; initialize waits for it.
    this._startLinksAhead();
    loadMark('booted');
  }

  /**
   * N-458: Pixi's start, once more when the WebGL context was lost while it ran and the browser gives it back
   * (BOOT_RESTORE_WAIT_MS at most: a load that cannot start says why instead of waiting for ever).
   */
  async _startPixi(config, backend) {
    if (this._useWebGpu) return this._initPixiApp(config, backend);
    this._watchGlContext();
    try {
      await this._initPixiApp(config, backend);
    } catch (error) {
      if (!this._glContextLost()) throw error;
      console.warn('[WeedJS] the WebGL context was lost while the renderer started: waiting for the browser to restore it');
      if (!(await this._glContextBack(BOOT_RESTORE_WAIT_MS))) {
        throw new Error('WeedJS: the WebGL context was lost while the game loaded, and the browser did not restore it.');
      }
      await this._initPixiApp(config, backend);
    }
  }

  /** N-458: whether the canvas's WebGL context is lost (the context Pixi made there, or asked for). */
  _glContextLost() {
    const gl = this.canvasView.getContext('webgl2');
    return gl !== null && gl.isContextLost();
  }

  /** N-458: true once the canvas's context is not lost, false when it still is after `ms`. */
  _glContextBack(ms) {
    return new Promise((resolve) => {
      if (!this._glContextLost()) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), ms);
      this.canvasView.addEventListener('webglcontextrestored', () => {
        clearTimeout(timer);
        resolve(true);
      }, { once: true });
    });
  }

  /**
   * SST-1: the GPU device (WebGPU) and pixiApp.init on the boot's canvas, and the renderer's own setup that needs no
   * asset: the backend's checks, the GPU's name and class, the present, the context's hooks. this.pixiApp is set once Pixi
   * is up, so a resize before that leaves it alone (and is applied here).
   */
  async _initPixiApp(config, backend) {
    loadMark('gpu device');
    const weedGpu = this._useWebGpu ? await requestWeedGpu('high-performance') : null;
    loadMark('pixi init');
    const app = new PIXI.Application();
    await app.init({
      width: this.canvasWidth,
      height: this.canvasHeight,
      resolution: 1,
      canvas: this.canvasView, // v8 uses 'canvas' instead of 'view'
      backgroundColor: 0x000000,
      depth: true, // root present clears color and depth (Pixi clear defaults to ALL)
      // Performance optimizations
      powerPreference: 'high-performance',
      preference: backend,
      ...(weedGpu ? { gpu: { adapter: weedGpu.adapter, device: weedGpu.device } } : {}),
    });

    if (!app.renderer) {
      throw new Error('PIXI.Application.init() succeeded but renderer is null');
    }
    if (!this._useWebGpu && this._glContextLost()) throw new Error('WeedJS: the WebGL context was lost while Pixi started');
    this.pixiApp = app;
    // E-475: every WebGL program made from here to the end of initialize is linked ahead, all together. E-494: not Pixi's
    // own, made inside its init (its default mesh's, its back buffer's): the engine draws with none of them.
    if (!this._useWebGpu) PIXI.GlProgram.weedMade = this._madePrograms;

    const actualName = pixiRendererTypeName(app.renderer.type, PIXI.RendererType);
    if (this._useWebGpu) {
      if (app.renderer.type !== PIXI.RendererType.WEBGPU) {
        throw errorPixiTypeMismatch(backend, actualName);
      }
      if (!app.renderer.gpu?.device) {
        throw errorMissingGpuDevice();
      }
      const device = app.renderer.gpu.device;
      device.addEventListener('uncapturederror', (ev) => {
        console.error('WebGPU uncapturederror:', ev.error?.message || String(ev.error));
      });
      device.lost.then((info) => {
        if (info && info.reason === 'destroyed' && !this._gpuLossTest) return;
        // N-301: the page restarts the scene from a save of the running world, and its renderer asks for a new device.
        console.warn(`[WeedJS] the WebGPU device was lost (${info?.reason || 'unknown'}: ${info?.message || ''})`);
        self.postMessage({ msg: 'gpuLost', backend: 'webgpu' });
      });
      this._bindWebGpuSwapchain();
      // DX-IGPUWARN: the adapter's GPU, for scene.gpu (a throwaway WebGL context's name where the adapter's is unclear).
      const gpu = webgpuGpu(app.renderer.gpu.adapter?.info ?? null, offscreenWebglRendererName);
      this._gpuRendererName = gpu.name;
      this._gpuVendor = gpu.vendor;
      this._gpuClass = gpu.kind;
    } else {
      if (app.renderer.type !== PIXI.RendererType.WEBGL) {
        throw errorPixiTypeMismatch(backend, actualName);
      }
      if (!app.renderer.gl) {
        throw new Error(
          'WeedJS: This scene requested renderer.backend "webgl", but the WebGL context is missing.'
        );
      }
      // E-502: E-448's opaque pass stays off on Intel's integrated and tile-based GPUs, unless debug.opaquePass says.
      this._gpuRendererName = webglRendererName(app.renderer.gl);
      this._gpuClass = gpuClassOf(this._gpuRendererName);
      this._gpuVendor = gpuVendorOf(this._gpuRendererName);
      this._opaqueOn = opaquePassOn(config.debug?.opaquePass, this._gpuClass, this._gpuVendor);
      debugWorkerLog(`PIXI WORKER: GPU "${this._gpuRendererName}" (${this._gpuClass}), opaque pass ${this._opaqueOn}`);
    }

    this._takePresentOwnership();

    // Enable z-index based sorting on the stage
    app.stage.sortableChildren = true;

    // Hook into WebGL context for draw call monitoring and context loss
    this.setupWebGLHooks();

    // A 'resize' while Pixi started (AbstractWorker kept its size): the canvas at that size.
    if (app.renderer.width !== this.canvasWidth || app.renderer.height !== this.canvasHeight) {
      this._applyResize(this.canvasWidth, this.canvasHeight);
    }
    this.reportLog('finished initializing pixi app');
    loadMark('pixi init end');
  }

  /**
   * E-494: the programs the engine made the first time a pass drew, so that its first frames waited for their links (the
   * second frame, 620 ms at Predator crowd 2.5 by night: the G-buffer's and the unshaded passes' over the entities, the
   * lamps' map, its volumes, the UV meshes, the statics scatter), made here instead, where the config says the pass runs,
   * by the calls the passes make: _linkProgramsAhead then links them with the rest, and a pass's first draw finds its
   * program linked (GlProgram.from hands back the program made here; the batches keep the ones they made). WebGL's
   * programs; on WebGPU the statics scatter's pipelines, the one thing made there on first use outside Pixi.
   */
  _makeFirstUsePrograms() {
    const renderer = this.pixiApp.renderer;
    const batch = this.entitiesBatch;
    if (this._useWebGpu) {
      // E-187: the keyed statics scatter's compute pipelines (_scatterStaticsGpu).
      if (batch !== null && batch.keyed && renderer.gpu?.device) this._staticsScatterGpu = createStaticsScatterGpu(renderer.gpu.device);
      return;
    }
    const shaders = this._engineShaders;
    // E-177: the keyed statics scatter's program (_scatterStaticsGl; compiled and linked here, as on its first call).
    if (batch !== null && batch.keyed && renderer.gl) this._staticsScatterGl = createStaticsScatterGl(renderer.gl);
    // DX-FACES, DX-GBUF, DX-UNSHADED: the light's passes over the entities (_renderFaceMap, _renderUnshaded).
    if (batch !== null && this.lightingEnabled) {
      const maps = this.assets.atlasMapsSource ?? this.lighting.emptyMapsSource();
      const heightScaleY = this._heightScaleY;
      const groundScaleY = this._groundScaleY || 1;
      if (this.lighting.faceRT !== null) {
        const mrt = this._gbufMrt && this.lighting.faceIdsRT !== null ? this.lighting.ensureGbufTarget() : null;
        if (mrt !== null) {
          batch.gbufMesh(heightScaleY, groundScaleY, maps);
        } else {
          batch.faceMesh(heightScaleY, groundScaleY, maps);
          if (this.lighting.faceIdsRT !== null) batch.idsMesh(heightScaleY, groundScaleY, maps);
        }
      }
      // Drawn while a sheet or a sprite is unshaded: a sprite can turn so while the game runs.
      if (this.lighting.unshadedComposite !== null && this.lighting.unshadedRT !== null) batch.unshadedPass(heightScaleY, groundScaleY, maps);
    }
    const casters = this.gpuCasterBatch;
    if (casters && shaders.shadowVert && shaders.sunMapFrag) {
      // E-411: with keyed frames, the maps' programs over keyed caster rows (E-395) too: made on first use, they linked
      // after the first frame (93 and 100 ms of Predator light3d's start).
      const keyed = batch !== null && batch.keyed;
      // DX-SHADOW3D: the sun's map's cards and columns (_drawSunMap).
      if (this._sunMapOn) {
        this.shadowMaps.sunShadowProgram('map');
        this.shadowMaps.sunShadowProgram('mapColumns');
        if (keyed) this.shadowMaps.sunMapKeyedProgram();
      }
      // DX-SHADOW3D (F7): the lamps' map's cards and columns (lampMap.js draw).
      if (this._lampMapOn) {
        this.lampMap.mapProgram(false);
        this.lampMap.mapProgram(true);
        if (keyed) this.lampMap.keyedProgram();
      }
    }
    // E-453: a MESH layer's UV meshes (_ensureMeshUvBatch: one program for every layer's batch, the first layer's name);
    // DX-SHADOW3D: a sun-projected layer's volumes in the sun's map and the lamps' (_drawVolumesInSunMap,
    // lampMap.js _drawVolumes), E-508: the lamps' cache's copy.
    const uvLayers = this.customLayers.list.filter((cl) => (cl.uvVertCapacity | 0) > 0 && (cl.uvIndexCapacity | 0) >= 3);
    if (uvLayers.length > 0 && shaders.meshUvFillVert && shaders.meshUvFillFrag) {
      meshUvFillProgram(false, shaders, `mesh-uv-${uvLayers[0].layerId}`);
      if (casters && uvLayers.some((cl) => cl.sunProjected)) {
        if (this._sunMapOn) this.shadowMaps.sunMapVolumeProgram();
        if (this._lampMapOn) {
          this.lampMap.makeVolumePrograms();
          if (this._lampCacheOn) this.lampMap.cacheCopyProgram();
        }
      }
    }
  }

  /**
   * SST-7 step 3 (E-495): on WebGPU, the render pipelines of the passes every frame draws, built here with
   * createRenderPipelineAsync (Pixi's PipelineSystem.weedPipelineAhead, scripts/buildPixi.mjs) under the keys Pixi's draws
   * look them up by, instead of by Pixi's createRenderPipeline in the first frames (Dawn compiles each on the GPU process's
   * thread, and the frames wait): the entities' batch in each of its programs (plain, indexed) on the canvas, the halos'
   * batch where it is added over them, the light pass into its target. The worker reports ready once they are built.
   */
  async _buildPipelinesAhead() {
    const renderer = this.pixiApp.renderer;
    const pipelines = renderer.pipeline;
    if (!this._useWebGpu || typeof pipelines?.weedPipelineAhead !== 'function') return;
    const builds = [];
    const ahead = (mesh, shader, geometry, surface, blendMode) => {
      if (!mesh || !shader?.gpuProgram || !geometry || !surface) return;
      const target = renderer.renderTarget.getRenderTarget(surface);
      // As a pass's start makes it (GpuRenderTargetAdaptor.startRenderPass): the depth is part of the pipeline's key.
      if ((target.stencil || target.depth) && !target.depthStencilAttachment) target.ensureDepthStencilTexture();
      // Pixi's mesh pipe sets the state's blend mode from the mesh's (its parents' where it inherits) at each draw.
      mesh.state.blendMode = blendMode;
      const built = pipelines.weedPipelineAhead(geometry, shader.gpuProgram, mesh.state, undefined, target);
      if (built !== null) builds.push(built);
    };
    const canvas = renderer.view?.renderTarget ?? null;
    const glowOnCanvas = this._lightGlowAdd && this.spriteGlowMesh !== null && this.spriteGlowMesh.parent === this.pixiApp.stage;
    for (const batch of [this.entitiesBatch, glowOnCanvas ? this.entitiesGlowBatch : null]) {
      if (batch === null || !batch.mesh) continue;
      const blendMode = drawnBlendMode(batch.mesh);
      const variants = batch.drawVariants();
      for (let i = 0; i < variants.length; i++) ahead(batch.mesh, variants[i].shader, variants[i].geometry, canvas, blendMode);
    }
    // The light pass draws its mesh as the render's root (normal blending) into its target.
    if (this.lighting.lightingMesh && this.lighting.lightingRT) {
      ahead(this.lighting.lightingMesh, this.lighting.lightingMesh.shader, this.lighting.lightingMesh.geometry, this.lighting.lightingRT, 'normal');
    }
    try {
      await Promise.all(builds);
    } catch (error) {
      console.warn('WeedJS: a render pipeline built ahead failed; Pixi makes it when it first draws with it', error);
    }
  }

  /**
   * E-494: `shader`'s WebGL program left out of the links ahead (a program no mesh draws with), unless one of `keep`
   * (shaders that are drawn) has the same program.
   */
  _leaveOutOfLinksAhead(shader, keep) {
    const program = shader?.glProgram;
    if (!program) return;
    for (let i = 0; i < keep.length; i++) if (keep[i]?.glProgram === program) return;
    const at = this._madePrograms.indexOf(program);
    if (at >= 0) this._madePrograms.splice(at, 1);
  }

  /**
   * E-475, SST-1: start the links of the programs made so far (GlProgram.weedMade), without waiting; a program already
   * started or linked is left as it is. _linkProgramsAhead starts the rest and waits for all of them.
   */
  _startLinksAhead() {
    const shaders = this._useWebGpu ? null : this.pixiApp?.renderer?.shader;
    if (!shaders || typeof shaders.weedLinkAhead !== 'function') return;
    const made = this._madePrograms;
    for (let i = 0; i < made.length; i++) shaders.weedLinkAhead(made[i]);
  }

  /**
   * SST-1: the engine shaders this backend's passes read, fetched at boot (a bundle's come embedded in the boot message).
   * N-303 CR-14: the additive variant is made from its base as it arrives (shaderVariants.js).
   */
  _fetchEngineShaders() {
    this._engineShaders = {};
    const sh = this._engineShaders;
    const shaderFetches = [];
    if (this._useWebGpu) {
      shaderFetches.push(
        fetchEngineShader('/src/shaders/instancedSprite.wgsl').then((s) => {
          sh.sprite = s;
        }),
        fetchEngineShader('/src/shaders/instancedSpriteShadow.wgsl').then((s) => {
          sh.shadowWgsl = s;
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
        fetchEngineShader('/src/shaders/meshUvFill.wgsl').then((s) => {
          sh.meshUvFill = s;
        }),
        fetchEngineShader('/src/shaders/tilemapGid.wgsl').then((s) => {
          sh.tilemapGid = s;
        }),
        fetchEngineShader('/src/shaders/decalTile.wgsl').then((s) => {
          sh.decalTile = s;
        })
      );
    } else {
      shaderFetches.push(
        fetchEngineShader('/src/shaders/instancedSprite.vert.glsl').then((s) => {
          sh.spriteVert = s;
        }),
        fetchEngineShader('/src/shaders/instancedSpriteShadow.vert.glsl').then((s) => {
          sh.shadowVert = s;
        }),
        fetchEngineShader('/src/shaders/instancedSprite.frag.glsl').then((s) => {
          sh.spriteFrag = s;
          sh.spriteFragAdd = additiveFragGlsl(s);
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
        fetchEngineShader('/src/shaders/faceMap.frag.glsl').then((s) => {
          sh.faceFrag = s;
        }),
        fetchEngineShader('/src/shaders/sunShadowMap.frag.glsl').then((s) => {
          sh.sunMapFrag = s;
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
        fetchEngineShader('/src/shaders/meshUvFill.vert.glsl').then((s) => {
          sh.meshUvFillVert = s;
        }),
        fetchEngineShader('/src/shaders/meshUvFill.frag.glsl').then((s) => {
          sh.meshUvFillFrag = s;
        }),
        fetchEngineShader('/src/shaders/tilemapGid.vert.glsl').then((s) => {
          sh.tilemapGidVert = s;
        }),
        fetchEngineShader('/src/shaders/tilemapGid.frag.glsl').then((s) => {
          sh.tilemapGidFrag = s;
        }),
        fetchEngineShader('/src/shaders/decalTile.vert.glsl').then((s) => {
          sh.decalTileVert = s;
        }),
        fetchEngineShader('/src/shaders/decalTile.frag.glsl').then((s) => {
          sh.decalTileFrag = s;
        })
      );
    }
    return Promise.all(shaderFetches);
  }

  /**
   * Initialize the PIXI renderer with provided data: what needs the assets and the shared buffers, once boot is done
   * (SST-1).
   */
  async initialize(data) {
    if (this._bootPromise == null) throw new Error("WeedJS: the renderer got 'init' without 'boot' (its canvas comes with boot)");
    await this._bootPromise;
    if (this._bootError !== null) {
      this.reportError('PIXI Initialization Failed', this._bootError);
      return;
    }
    // N-256 PW-2: the steps, in this order (each one's doc says what it makes).
    this._reportGpuInfo();
    await this._fetchParticleShaders(data);
    this._readRendererConfig(data);
    this._bindRendererViews(data);
    this._loadAssets(data);
    const decalBind = this._initDecals(data);
    this._initRenderQueue(data);
    this._initCastedShadows(data);
    await this._bindKernels(data, decalBind);
    this._initEntitiesLayer();
    this._initLighting(data);
    this._initSun();
    await this._initLayersAndPrograms(data);
  }

  /**
   * N-256 PW-2, initialize's step: DX-IGPUWARN: the GPU the page got to the scene, and a manual step's ticker stopped.
   */
  _reportGpuInfo() {
    // DX-IGPUWARN: the GPU the page got, to the scene (scene.gpu) before this worker reports ready.
    self.postMessage({
      msg: 'gpuInfo',
      backend: this._useWebGpu ? 'webgpu' : 'webgl',
      name: this._gpuRendererName,
      vendor: this._gpuVendor,
      kind: this._gpuClass,
    });
    if (this.config?.manualStep && this.pixiApp.ticker) {
      this.pixiApp.ticker.autoStart = false;
      this.pixiApp.ticker.stop();
    }
  }

  /**
   * N-256 PW-2, initialize's step: GPU particle layers (LAYER_KIND.GPU_PARTICLES): their shaders, fetched only in a
   * scene that has one.
   */
  async _fetchParticleShaders(data) {
    const sh = this._engineShaders;
    const shaderFetches = [];
    // GPU particle layers (LAYER_KIND.GPU_PARTICLES): their programs, only in a scene that has one.
    if (data.gpuParticles?.layers?.length) {
      // A look layer drawn among the entities draws its finished target in regions (gpuParticleChunks.js).
      const regionShaders = data.gpuParticles.layers.some((l) => l.sortWithEntities && l.look);
      if (this._useWebGpu) {
        shaderFetches.push(
          fetchEngineShader('/src/shaders/gpuParticle.wgsl').then((s) => {
            sh.gpuParticle = s;
          })
        );
        if (regionShaders) {
          shaderFetches.push(fetchEngineShader('/src/shaders/gpuRegion.wgsl').then((s) => {
            sh.gpuRegion = s;
          }));
        }
      } else {
        shaderFetches.push(
          fetchEngineShader('/src/shaders/gpuParticle.vert.glsl').then((s) => {
            sh.gpuParticleVert = s;
          }),
          fetchEngineShader('/src/shaders/gpuParticle.frag.glsl').then((s) => {
            sh.gpuParticleFrag = s;
            sh.gpuParticleFragAdd = additiveFragGlsl(s);
          })
        );
        if (regionShaders) {
          shaderFetches.push(
            fetchEngineShader('/src/shaders/gpuRegion.vert.glsl').then((s) => {
              sh.gpuRegionVert = s;
            }),
            fetchEngineShader('/src/shaders/gpuRegion.frag.glsl').then((s) => {
              sh.gpuRegionFrag = s;
            })
          );
        }
      }
      await Promise.all(shaderFetches);
      loadMark('particle shaders fetched');
    }
  }

  /**
   * N-256 PW-2, initialize's step: the stats buffer, the canvas and world sizes, and the renderer, pre-render and
   * lighting settings this worker reads.
   */
  _readRendererConfig(data) {
    // Initialize stats buffer for writing metrics
    if (data.buffers.rendererStats) {
      this.stats = createStatsWriter(data.buffers.rendererStats, RENDERER_STATS);
      debugWorkerLog('PIXI WORKER: Stats buffer initialized');
    }

    // Store viewport and world dimensions from config
    this.worldWidth = data.config.worldWidth;
    this.worldHeight = data.config.worldHeight;
    this.canvasWidth = data.config.canvasWidth;
    this.canvasHeight = data.config.canvasHeight;
    // The canvas came with boot at the page's size then; the page's size now, if it changed since.
    const renderer = this.pixiApp.renderer;
    if (renderer.width !== this.canvasWidth || renderer.height !== this.canvasHeight) {
      this._applyResize(this.canvasWidth, this.canvasHeight);
    }
    this._presentingFlag = data.presentingFlag || null;

    // Read renderer-specific configuration
    const rendererConfig = this.config.renderer || {};
    this._keyedPosesByRow = (rendererConfig.keyedPosesByRow ?? RENDERER_DEFAULTS.keyedPosesByRow) === true;

    this._ySortMode = rendererConfig.ySort;
    this._ySort = ySortEnabled(this._ySortMode);
    const preCfg = this.config.preRender || {};
    this._queueBackpressure = preCfg.backpressure !== false;
    this._queueWait = rendererConfig.waitForQueue !== false;
    const spritePipe = resolveSpritePipeline({
      ySort: this._ySortMode,
      packGpuSprites: preCfg.packGpuSprites,
      sortSprites: preCfg.sortSprites,
    });
    this._packGpuSpritesOn = spritePipe.packGpuSprites;
    this._sortSpritesOn = spritePipe.sortSprites;
    // The halos sorted among the entities ('sorted', the default) or added over everything ('add'). OL-1: any other value
    // (the old 'sprite' among them) warns and draws as 'add'.
    const lightGlow = this.config.lighting?.lightGlow ?? LIGHTING_DEFAULTS.lightGlow;
    if (lightGlow !== 'add' && lightGlow !== 'sorted') {
      console.warn(`WeedJS: lighting.lightGlow is 'add' or 'sorted', not ${JSON.stringify(lightGlow)}: the halos are added over everything`);
    }
    this._lightGlowAdd = lightGlow !== 'sorted';

    // autoGenerateMipmaps, atlasScaleMode and N-271's pixel snap: read at boot, before any program or atlas source was made.

    const maxDecalUploads = rendererConfig.maxDecalTileUploadsPerFrame;
    this.maxDecalTileUploadsPerFrame =
      Number.isFinite(maxDecalUploads) && maxDecalUploads > 0
        ? maxDecalUploads
        : RENDERER_DEFAULTS.maxDecalTileUploadsPerFrame;
  }

  /**
   * N-256 PW-2, initialize's step: the mesh pose lists and the particle, decoration and light counts from the shared
   * buffers.
   */
  _bindRendererViews(data) {
    // Note: Component arrays are automatically initialized by AbstractWorker.initializeAllComponents()
    // This includes Transform, RigidBody, SpriteRenderer, and all custom components

    // Note: ParticleComponent is automatically initialized by AbstractWorker.initializeCommonBuffers()
    const meshPoses = data.buffers.meshPoseLists;
    if (meshPoses && meshPoses.length === 2) {
      const cap = data.buffers.meshPoseCapacity | 0;
      const n = this.globalEntityCount | 0;
      this._meshPoseLists = [bindMeshPoseList(meshPoses[0], cap), bindMeshPoseList(meshPoses[1], cap)];
      this._meshQueueStamp = new Int32Array(n);
      this._meshQueuePose = new Float32Array(n * MESH_POSE_FLOATS);
    }
    this.maxParticles = data.maxParticles || 0;
    if (data.buffers.componentData.ParticleComponent && this.maxParticles > 0) {
      debugWorkerLog(`PIXI WORKER: ParticleComponent initialized for ${this.maxParticles} particles`);
    }

    // Note: DecorationComponent is automatically initialized by AbstractWorker.initializeCommonBuffers()
    this.maxDecorations = data.maxDecorations || 0;
    if (data.buffers.componentData.DecorationComponent && this.maxDecorations > 0) {
      debugWorkerLog(
        `PIXI WORKER: DecorationComponent initialized for ${this.maxDecorations} decorations`
      );
    }

    // Note: LightEmitter is automatically initialized by AbstractWorker.initializeAllComponents()
    if (data.buffers.componentData.LightEmitter) {
      debugWorkerLog(
        `PIXI WORKER: LightEmitter component initialized (${this.globalEntityCount} slots)`
      );
    }
  }

  /**
   * N-256 PW-2, initialize's step: the spritesheets' metadata and the assets (src/render/pixi/assets.js): textures,
   * sheets, tilesets, on the GPU.
   */
  _loadAssets(data) {
    // Deserialize spritesheet metadata for animation lookups
    if (data.spritesheetMetadata) {
      SpriteSheetRegistry.deserialize(data.spritesheetMetadata);
      // console.log(
      //   `PIXI WORKER: Loaded ${
      //     SpriteSheetRegistry.getSpritesheetNames().length
      //   } spritesheets`
      // );
    }

    // Load simple textures
    this.assets.loadTextures(data.textures);
    this.reportLog('finished loading textures');

    // Load spritesheets (synchronous now - manually parsed)
    this.assets.loadSpritesheets(data.spritesheets, data.bigAtlasProxySheets);
    this.assets.earlyAtlas = {};
    this.reportLog('finished loading spritesheets');
    loadMark('spritesheets');

    // Load tileset textures (tile data comes from TileMap SAB via AbstractWorker)
    this.assets.loadTilesetBitmaps(data.tilesetBitmaps);
    this.reportLog('finished loading tileset textures');
    // SST-7: on the GPU now, while the programs link, not at the first frame that draws them.
    this.assets.uploadAssetTextures();
    loadMark('textures uploaded');
  }

  /**
   * N-256 PW-2, initialize's step: the blood decal grid (SAB tiles): its views and sprites. @returns {Promise|null} its
   * premultiply kernel's bind
   */
  _initDecals(data) {
    // ========================================
    // BLOOD DECAL SPLAT GRID - Initialize (SAB tiles, not TileMap background)
    // ========================================
    // Its kernel binds with the others, below.
    let decalBind = null;
    if (data.decals && data.decals.enabled) {
      this.decalsEnabled = true;
      this.decalsTileSize = data.decals.tileSize; // World units per tile
      this.decalsTilePixelSize = data.decals.tilePixelSize; // Actual texture pixels
      this.decalsResolution = data.decals.resolution; // Resolution multiplier
      this.decalsTilesX = data.decals.tilesX;
      this.decalsTilesY = data.decals.tilesY;
      this.decalsTotalTiles = data.decals.totalTiles;

      // Create typed array views over SharedArrayBuffers
      // W21c: dirty tiles premultiplied by decalPremultiply.wasm, on the decal memory the tiles live in.
      if (!data.decals.memory || !data.decals.memoryLayout) throw new Error('decals without the decal memory (installDecalMemory)');
      decalBind = bindDecalPremultiply(data.decals.memory, data.decals.memoryLayout).then((kernel) => {
        this._decalPremultiply = kernel;
      });
      this.decalsTilesDirty = new Uint8Array(data.decals.tilesDirty);
      this._decalDirtyWords = new Uint32Array(data.decals.tilesDirty, 0, data.decals.tilesDirty.byteLength >> 2);

      // Create decal tile container (renders between background and entities). E-175: a render group, so the camera
      // moving it each frame moves the group's transform, not every tile's, and its batches are kept until a tile changes.
      this.decalTileContainer = new PIXI.Container({ isRenderGroup: true });
      this._registerLayerDisplayObject('decals', this.decalTileContainer);

      // E-552: the tiles' program and their slots (the chunks come with the first stamped tiles)
      this.decalTiles.create();

      // Add decal tile container to stage
      this.pixiApp.stage.addChild(this.decalTileContainer);

      debugWorkerLog(
        `PIXI WORKER: decal decals enabled - ${this.decalsTilesX}×${this.decalsTilesY} tiles (${this.decalsTileSize}px world, ${this.decalsTilePixelSize}px texture @ ${this.decalsResolution}x)`
      );
    }
    return decalBind;
  }

  /**
   * N-256 PW-2, initialize's step: the double-buffered render queue's views, the GPU queues' and the entity texture
   * lookup.
   */
  _initRenderQueue(data) {
    // ========================================
    // RENDER QUEUE SYSTEM - Initialize (DOUBLE BUFFERED)
    // ========================================
    if (data.renderQueue && data.renderQueue.dataA && data.renderQueue.dataB) {
      debugWorkerLog('PIXI WORKER: Initializing double-buffered render queue system...');
      this.renderQueueEnabled = true;
      this.renderQueueMaxItems = data.renderQueue.maxItems;

      // Initialize sync buffer
      this.renderQueueSync = new Int32Array(data.renderQueue.sync);
      this.lastReadFrame = -1;

      const maxItems = this.renderQueueMaxItems;

      // Create typed array views for BOTH buffers (must match RenderQueueLayout / Scene alloc)
      const bufferSABs = [data.renderQueue.dataA, data.renderQueue.dataB];
      const bufferBytes = [data.renderQueue.dataAByte | 0, data.renderQueue.dataBByte | 0];
      const cameraSABs = [data.renderQueue.cameraA || null, data.renderQueue.cameraB || null];

      for (let bufIdx = 0; bufIdx < 2; bufIdx++) {
        const views = createRenderQueueViews(bufferSABs[bufIdx], maxItems, bufferBytes[bufIdx]);
        this.renderQueueBuffers[bufIdx] = views;
        this._sortKeyU32ByBuf[bufIdx] = views.sortKeyU32;
        const camViews = createRenderQueueCameraViews(cameraSABs[bufIdx]);
        this.renderQueueCameraBuffers[bufIdx] = camViews ? camViews.camera : null;
        this.renderQueuePoseReadyBuffers[bufIdx] = camViews ? camViews.poseReady : null;
        this.renderQueueStampBuffers[bufIdx] = camViews ? camViews.stamp : null;
      }

      // Set initial read buffer (frame 0 uses buffer 0)
      this._setReadBuffer(0);

      if (data.gpuQueue && data.gpuQueue.dataA && data.gpuQueue.dataB && data.gpuQueue.caps) {
        const caps = data.gpuQueue.caps;
        this.gpuQueueBuffers = [
          createGpuQueueViews(data.gpuQueue.dataA, caps, data.gpuQueue.dataAByte | 0),
          createGpuQueueViews(data.gpuQueue.dataB, caps, data.gpuQueue.dataBByte | 0),
        ];
        this._gpuQueueRead = this.gpuQueueBuffers[0];
        debugWorkerLog(`PIXI WORKER: GPU queues ready (sprites ${caps.maxSprites}, stamp ${caps.maxStamp})`);
      }

      // Entity texture lookup buffer (separate SAB)
      // Maps entityIndex -> last computed globalTextureId for shadow system
      if (data.renderQueue.entityTextureData) {
        this.entityLastTextureId = new Uint16Array(
          data.renderQueue.entityTextureData,
          data.renderQueue.entityTextureByte | 0,
          this.globalEntityCount
        );
      }

      debugWorkerLog(`PIXI WORKER: Double-buffered render queue initialized (max ${maxItems} items)`);
    } else {
      debugWorkerLog('PIXI WORKER: Render queue NOT enabled');
    }
  }

  /** N-256 PW-2, initialize's step: the casted shadows system, over the render queue's memory. */
  _initCastedShadows(data) {
    // ========================================
    // CASTED SHADOWS SYSTEM - Initialize
    // ========================================
    this._renderQueueMemory = data.renderQueueMemory || null;
    this.createCastedShadowsSystem(data);
  }

  /** N-256 PW-2, initialize's step: the worker's kernels, bound together (SST-2). */
  async _bindKernels(data, decalBind) {
    // The worker's kernels, which do not depend on each other, bound together (SST-2): the decals' premultiply, the entity
    // batch's pack and sort, the MESH layers' corners (initializeCustomLayers takes this bind). loadMark: each bind's
    // 'kernel' marks come from wasmKernel.js.
    await Promise.all([
      decalBind,
      this.renderQueueEnabled ? this._bindPixiGpuPack(data) : null,
      this.renderQueueEnabled ? this._bindPainterRadix(data) : null,
      this.meshLayers.bindMemory(data),
    ]);
    loadMark('kernels bound');
  }

  /**
   * N-256 PW-2, initialize's step: the entities' instanced batch and its layer (with its opaque, depth and glow
   * meshes).
   */
  _initEntitiesLayer() {
    // ENTITIES always render through the instanced Mesh (no ParticleContainer path)
    if (this.renderQueueEnabled) {
      this.createEntitiesInstancedBatch(this.renderQueueMaxItems);
      this._entitiesRoot = new Container();
      this._entitiesRoot.label = 'entities-root';
      // E-448: the batch's opaque pass right before it.
      if (this.entitiesBatch.opaqueHost !== null) this._entitiesRoot.addChild(this.entitiesBatch.opaqueHost);
      this._entitiesRoot.addChild(this.spriteMesh);
      // DX-DEPTH (F5 v2): with pixel depth, the batch's edge pass right after its opaque one; DX-FACEDEPTH: its vertex-depth
      // opaque program right before.
      this._placeDepthMeshes();
      this._registerLayerDisplayObject('entities', this._entitiesRoot);
      this.pixiApp.stage.addChild(this._entitiesRoot);
      if (this.spriteGlowMesh) {
        const glowRes = this.glowLayer.resolution();
        if (glowRes < 1) {
          this.glowLayer.createTarget(glowRes);
        } else {
          this._registerLayerDisplayObject('lightGlows', this.spriteGlowMesh);
          this.pixiApp.stage.addChild(this.spriteGlowMesh);
        }
        if (!this._lightGlowAdd) this.spriteGlowMesh.visible = false;
      }
      const order = this._ySort ? 'painter' : 'emit order';
      const glow = this._lightGlowAdd ? 'glow ADD' : 'glow in entity list';
      debugWorkerLog(`PIXI WORKER: ENTITIES layer using instanced sprite mesh (${order}, ${glow})`);
    }
  }

  /**
   * N-256 PW-2, initialize's step: the lighting system: its settings, the shadow maps' modes, the lights' slots and its
   * splats.
   */
  _initLighting(data) {
    // ========================================
    // LIGHTING SYSTEM - Initialize
    // ========================================
    const lightingConfig = this.config.lighting || {};
    if (lightingConfig.enabled && data.buffers.componentData.LightEmitter) {
      this.lightingEnabled = true;
      this._groundScaleY = cameraFloorScaleY(this.config);
      this._groundInvScaleY = 1 / this._groundScaleY;
      this.lighting.visibleLightsData = data.buffers.visibleLightsData
        ? new Uint16Array(data.buffers.visibleLightsData)
        : null;
      this.lightingResolution = lightingConfig.resolution || 1.0;
      // DX-BARRIOS: a px of height rises the camera's heightScaleY; faces have no switch: the light pass reads the face map
      // with maps or a shadow map (below), or once a decoration carries a normal (_useFaces).
      this._heightScaleY = cameraHeightScaleY(this.config);
      this._facesWatch = true;
      this._facesOn = DecorationPool.facesInUse();
      // E-531: with shadows on, the sun's and the lamps' shadows come from their shadow maps, each light's term alone
      // (WebGL and WebGPU): the one way (the classic shadows' layer is gone).
      const shadowsOn = !!(data.shadows && data.shadows.enabled);
      if (shadowsOn) this._sunMapOn = true;
      // DX-SELFSHADOW: faces and sprites with maps shade themselves from the sun (screen-space steps over the face map).
      if (lightingConfig.selfShadow === true) this._selfShadowOn = true;
      // E-423: its walk, fixed steps or every cell the ray crosses; anything else takes the default and says so once.
      this._selfShadowMarch = selfShadowMarchOf(lightingConfig);
      if (lightingConfig.selfShadowMarch !== undefined && lightingConfig.selfShadowMarch !== this._selfShadowMarch) {
        console.warn(`WeedJS: lighting.selfShadowMarch is ${SELF_SHADOW_MARCHES.map((m) => `'${m}'`).join(' or ')}, not ${JSON.stringify(lightingConfig.selfShadowMarch)}: the self-shadow takes '${this._selfShadowMarch}'`);
      }
      // DX-PIXELSHADOW: each world pixel lit whole, the maps read with one tap (lighting.pixelArt).
      this._pixelArtLight = lightingConfig.pixelArt === true;
      // lighting.shadowSamples and lighting.lightCullingTileSize: a number outside their range is clamped, anything else
      // not a number takes the default, and either says so once.
      this._shadowSamples = shadowSamplesOf(lightingConfig);
      if (lightingConfig.shadowSamples !== undefined && lightingConfig.shadowSamples !== this._shadowSamples) {
        console.warn(`WeedJS: lighting.shadowSamples is a whole number from 1 to ${SHADOW_SAMPLES_MAX}, not ${JSON.stringify(lightingConfig.shadowSamples)}: the shadows take ${this._shadowSamples}`);
      }
      this._lightCullingTileSize = lightCullingTileSizeOf(lightingConfig);
      if (lightingConfig.lightCullingTileSize !== undefined && lightingConfig.lightCullingTileSize !== this._lightCullingTileSize) {
        console.warn(`WeedJS: lighting.lightCullingTileSize is a whole number of px from ${LIGHT_CULLING_TILE_SIZE_MIN} to ${LIGHT_CULLING_TILE_SIZE_MAX}, not ${JSON.stringify(lightingConfig.lightCullingTileSize)}: the light's tiles take ${this._lightCullingTileSize}`);
      }
      // DX-GBUF (plan §6.4): the G-buffer's targets in one pass (MRT, the default: E-377) or a pass each.
      const gbufMode = lightingConfig.gbuffer ?? 'mrt';
      if (gbufMode !== 'pass' && gbufMode !== 'mrt') {
        console.warn(`WeedJS: lighting.gbuffer is 'pass' or 'mrt', not ${JSON.stringify(gbufMode)}: the G-buffer draws a pass a target`);
      }
      this._gbufMrt = gbufMode === 'mrt';
      // DX-SHADOW3D (F7), E-531: a map a lamp, each lamp's own light alone.
      if (shadowsOn) {
        this._lampMapOn = true;
        // N-196: 'auto' (the default) sizes the tile by the casting lamps' reach and lighting.shadowResolution.
        const tile = lightingConfig.lampShadowTile;
        this._lampTileAuto = tile === undefined || tile === null || tile === 'auto';
        // E-551: a fixed tile in whole steps of LAMP_RECT_UNIT (16 texels), as a tile's rect is carried (lampRectCode).
        this._lampTileSize = this._lampTileAuto ? 256 : Math.ceil(Math.max(32, Math.min(1024, (tile | 0) || 256)) / 16) * 16;
        // E-508: a still lamp's volumes drawn once into a cache and copied each frame (default on).
        this._lampCacheOn = lightingConfig.lampMapCache !== false;
      }
      // DX-MAPS: a sprite with height and normal maps is lit as the surface they say, through the faces' pass. DX-GBUF: so
      // is every entity's in the shadow maps' modes (a card standing on its foot, plan §5.4): the maps keep their highest
      // caster's entity, and a caster's own shadow never paints its own sprite.
      if (this.assets.atlasMapsSource !== null || this._sunMapOn || this._lampMapOn) this._facesOn = true;
      // OL-4: walls (lighting.walls) read by this pass: pre-render's rows and their texture, and the G-buffer, since a
      // wall's own pixels are told by their entity's id.
      const wallRows = data.visibilityPolygons;
      if (wallRows && wallRows.enabled && wallRows.rowsA && wallRows.rowsB) {
        this.lighting.initWallRows(wallRows);
        this._facesOn = true;
      }
      // baseAmbient is the night/minimum light level (when sun is down)
      this.baseAmbient = lightingConfig.baseAmbient !== undefined ? lightingConfig.baseAmbient : 0.05;
      this.maxLights = lightingConfig.maxLights !== undefined ? lightingConfig.maxLights : 128;
      const lightSlots = Math.max(1, this.maxLights | 0);
      this.lighting.visibleLightsAll = new Array(lightSlots);
      for (let i = 0; i < lightSlots; i++) {
        this.lighting.visibleLightsAll[i] = { entityId: 0, distSq: 0 };
      }
      this.maxShadowCastingLights =
        lightingConfig.maxShadowCastingLights !== undefined
          ? lightingConfig.maxShadowCastingLights
          : LIGHTING_DEFAULTS.maxShadowCastingLights;
      this.liquidFunMaxCount = data.liquidFunMaxCount | 0;
      const particleLights = resolveParticleLights(lightingConfig.particleLights);
      if (particleLights.warning) console.warn(`PIXI WORKER: ${particleLights.warning}`);
      this._particleLightsEnabled = particleLights.enabled;
      this._particleLightMax = particleLights.max;

      // Create lighting mesh (full-screen quad with multiply blend)
      // Shadows are now sprites, not in shader
      this.lighting.createLightingSystem();
      this.lighting.createLiquidFunLightSplat(this.liquidFunMaxCount);
      this.lighting.createParticleLightSplat(this._particleLightMax);

      debugWorkerLog(
        `PIXI WORKER: Lighting system enabled (baseAmbient: ${this.baseAmbient}, maxLights: ${this.maxLights}, shadowLights: ${this.maxShadowCastingLights}, resolution: ${this.lightingResolution}, shadowResolution: ${this.shadowResolution})`
      );
    }
  }

  /**
   * N-256 PW-2, initialize's step: the sun's switch, from the Sun static class (AbstractWorker.initializeCommonBuffers
   * bound it).
   */
  _initSun() {
    // ========================================
    // SUN SYSTEM - Initialize
    // ========================================
    // Note: Sun static class is initialized by AbstractWorker.initializeCommonBuffers()
    if (Sun.isInitialized) {
      this.sunEnabled = Sun.enabled;
      debugWorkerLog(`PIXI WORKER: Sun system initialized (enabled: ${this.sunEnabled})`);
    }
  }

  /**
   * N-256 PW-2, initialize's step: the custom layers, the layers' map, then every program made, linked and built before
   * ready.
   */
  async _initLayersAndPrograms(data) {
    // Debug visualization is handled by DebugUI on the page thread
    // This removes ~400 lines of debug rendering code from pixi_worker

    // Entity / particle / decoration sprites come from the render queue
    // (see updateSpritesFromRenderQueue); no per-slot sprite arrays in this worker.

    // ========================================
    // CUSTOM LAYER RENDERING INFRASTRUCTURE
    // ========================================
    await this.customLayers.initialize(data, true);

    // ========================================
    // LAYER REFERENCES MAP - For debug UI control
    // ========================================
    this.buildLayerRefsMap();
    loadMark('custom layers');

    this._makeFirstUsePrograms();
    loadMark('first-use programs');
    await this._linkProgramsAhead();
    loadMark('programs linked');
    await this._buildPipelinesAhead();
    loadMark('pipelines built');

    debugWorkerLog('PIXI WORKER: Initialization complete, waiting for start signal...');
    debugWorkerLog(
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
  /**
   * Build a map of layer name -> PIXI display object for debug UI control
   * Called after all layers are initialized
   */
  buildLayerRefsMap() {
    for (let i = 0; i < this.scenery.layers.length; i++) {
      const s = this.scenery.layers[i];
      const name = Layer.getName(i);
      if (s?.displayObject && name) this._registerLayerDisplayObject(name, s.displayObject);
    }
    if (this.decalTileContainer) this._registerLayerDisplayObject('decals', this.decalTileContainer);
    if (this._entitiesRoot) {
      this._registerLayerDisplayObject('entities', this._entitiesRoot);
    } else if (this.spriteMesh) {
      this._registerLayerDisplayObject('entities', this.spriteMesh);
    }
    if (this.glowLayer.sprite !== null) {
      this._registerLayerDisplayObject('lightGlows', this.glowLayer.sprite);
    } else if (this.spriteGlowMesh) {
      this._registerLayerDisplayObject('lightGlows', this.spriteGlowMesh);
      if (!this._lightGlowAdd) this.spriteGlowMesh.visible = false;
    }
    if (this.lighting.lightEdges !== null) this._registerLayerDisplayObject('lighting', this.lighting.lightEdges.host);
    else if (this.lighting.lightingDisplaySprite) this._registerLayerDisplayObject('lighting', this.lighting.lightingDisplaySprite);
    else if (this.lighting.lightingMesh) this._registerLayerDisplayObject('lighting', this.lighting.lightingMesh);
    for (let i = 0; i < this.customLayers.list.length; i++) {
      const cl = this.customLayers.list[i];
      // E-504: a cached worldRect layer is its holder (the stage mesh and the target's sprite, one of them shown), not
      // the sprite: the layer's visibility, applied every frame, would show the sprite under the mesh drawn on the stage.
      const displayObject = cl.worldHolder || cl.displaySprite || cl.shaderMesh || cl.batch?.mesh || cl.fillBatch?.mesh;
      if (!displayObject) continue;
      this._registerLayerDisplayObject(cl.layerName, displayObject, this.customLayers.forcesContainerBlend(cl, displayObject));
    }
    this._syncLayerRefsFromRuntime();

    const layerNames = Object.keys(this.layerRefs);
    debugWorkerLog(
      `PIXI WORKER: Layer refs map built (${layerNames.length} layers: ${layerNames.join(', ')})`
    );
  }

  createCastedShadowsSystem(data) {
    if (data.shadows && data.shadows.enabled) {
      this.shadowsEnabled = true;
      this.shadowMaps.create();
    }
  }
}

// Create singleton instance and setup message handler
self.pixiRenderer = new PixiRenderer(self);
