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
import { Query } from '../core/query.js';
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
  PARTICLE_DEFAULTS,
  LIGHT_CULLING_TILE_SIZE_MAX,
  LIGHT_CULLING_TILE_SIZE_MIN,
  SHADOW_SAMPLES_MAX,
  lightBehindWallsOf,
  lightCullingTileSizeOf,
  normalShadingOf,
  resolveZenithalMaxHeight,
  shadowSamplesOf,
} from '../util/configDefaults.js';
import { Layer } from '../core/layer.js';
import { meshLookFullscreenUvs } from '../render/meshLookUv.js';
import { lightingSource } from '../render/faceMap.js';
import { applyPixelSnap } from '../render/pixelSnap.js';
import {
  LightTiles,
  TILE_CAM_COS,
  TILE_CAM_FULL_H,
  TILE_CAM_FULL_W,
  TILE_CAM_GROUND_INV_Y,
  TILE_CAM_SIN,
  TILE_CAM_SNAP,
  TILE_CAM_X,
  TILE_CAM_Y,
  TILE_CAM_ZOOM,
  binLightTiles,
  layoutLightTiles,
  lightTilesGpuProgram,
  uploadLightTilesGl,
  uploadLightTilesGpu,
  writeLightTileUniforms,
} from '../render/lightTiles.js';
import { gbufEntityId, gbufWanted, writeGbufWords } from '../render/gbufWord.js';
import { WALL_VERT0, wallRowsLayout } from '../render/visibility/lampWallRow.js';
import { UNSHADED_COMPOSITE_FRAG, UNSHADED_COMPOSITE_VERT, unshadedCompositeGpuProgram, unshadedQuadPositions } from '../render/unshadedComposite.js';
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
import { lightEdgesHost, lightEdgesQuad, rgbOnlyHost, unshadedEdgesHost, wallEdgesWanted } from '../render/lightEdges.js';
import { additiveFragGlsl, spritePoseGlsl, spritePoseWgsl } from '../render/shaderVariants.js';
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
import {
  extractRGBNormalizedMut,
  lightDataTextureFloatCount,
  clearUnusedLightDataTexels,
  LIGHT_DATA_TEX_HEIGHT,
  stashResizeWhileHidden,
  takePendingResize,
} from '../util/utils.js';
import { viewWorldBounds } from '../util/viewBounds.js';
import { takePublishedList } from '../util/publishedList.js';
import { bindMeshPoseList, takeMeshPoseList, MESH_POSE_FLOATS } from '../util/meshPoseList.js';
import {
  InstancedSpriteBatch,
  INSTANCED_SPRITE_FLOATS,
  POSE_DYN_FLOATS,
  POSE_STATIC_FLOATS,
  BATCH_SPACE,
  BATCH_DEPTH,
  textureLutSolid,
  textureLutTexels,
} from '../render/instancedSpriteBatch.js';
import { bindPainterRadix, createWasmPainterState, painterSlotList } from '../render/painterRadixClient.js';
import { LiquidFunDensitySplat, LF_SPLAT_STRIDE } from '../render/liquidFunDensitySplat.js';
import { packParticleLights, resolveParticleLights } from '../render/particleLightSplat.js';
import { LiquidFun } from '../core/liquidFun.js';
import { releasePixiBindGroupsOnResource } from '../render/releasePixiBindGroups.js';
import {
  rtPixelSize,
  rtPixelScale,
} from '../render/gpuShadowCasters.js';

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

import { pinGpuTexture, writeRgba32Float, writeRgba8 } from '../render/webgpu/pinGpuTexture.js';
import { bindDecalPremultiply, premultiplyDecalTile } from '../render/decalPremultiplyClient.js';
import { lightingGpuProgram } from '../render/webgpu/pixiMeshWgsl.js';
import {
  normalizeRendererBackend,
  errorPixiTypeMismatch,
  errorMissingGpuDevice,
  errorCompileFailed,
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
import { PixiGlowLayer } from '../render/pixi/glowLayer.js';
import { PixiShadowMaps } from '../render/pixi/shadowMaps.js';
import { finiteOrZero, layerIsVisible, applyEngineLookUniforms } from '../render/pixi/layerHelpers.js';
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

// OPTIMIZED: Pre-defined comparator function for light sorting (avoids closure allocation per frame)
function sortPrefixByDistSq(arr, count) {
  const n = count | 0;
  for (let i = 1; i < n; i++) {
    const item = arr[i];
    const dist = item.distSq;
    let j = i - 1;
    while (j >= 0 && arr[j].distSq > dist) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = item;
  }
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

const QUERY_LIGHT_EMITTER = [LightEmitter];

/** E-475: the longest the worker waits for its programs' links before it reports ready (a driver that never answers). */
const LINK_AHEAD_WAIT_MS = 20000;

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
    this._keyedRowsRefusedWarned = false;
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
    /** @type {InstancedSpriteBatch|null} */
    this.shadowBatch = null;
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

    /** From renderer.autoGenerateMipmaps (default false) — applied at ImageSource create */
    this.autoGenerateMipmaps = RENDERER_DEFAULTS.autoGenerateMipmaps;
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
    this._queueInterp = false;
    /** E-201: renderer.keyedPosesByRow (the entity batch's keyed frames drawn by queue row). */
    this._keyedPosesByRow = false;
    /** N-138: pre-render's lists of the poses its sprites that have a mesh were drawn at, one per queue buffer. */
    this._meshPoseLists = [];
    /** Per entity, the frame whose sprite pose _meshQueuePose holds (x, y, rotC, rotS); the mesh fill takes it. */
    this._meshQueueStamp = new Int32Array(0);
    this._meshQueuePose = new Float32Array(0);
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

    // DX-POST: the LAYER_KIND.SCREEN passes in zIndex order, and the frame they read (the stage drawn into a target).
    this._screenLayers = [];
    this._screenSceneRT = null;
    // DX-DEPTH: the frame target given a depth attachment for the entities' pixel depth (WebGPU), so it is asked once.
    this._screenSceneDepth = null;
    this._screenClear = [0, 0, 0, 1];
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
    this._nextDecalTileScanIndex = 0;
    this._decalTilesDirtyThisFrame = 0;
    this._decalTilesUploadedThisFrame = 0;

    // SharedArrayBuffer views (shared with particle_worker)
    this.decalsTilesDirty = null; // Uint8Array - dirty flags (0=clean, 1=modified)
    // E-272: the same flags four to a word, for the frame's count (an empty array of its class until decals bind).
    this._decalDirtyWords = new Uint32Array(0);

    // PIXI rendering
    this.decalTileContainer = null; // Container for decal tile sprites
    this.decalTileSprites = []; // Array of Sprite per tile
    this.decalTileTextureSources = []; // TextureSource per tile (for updating)
    // E-175: which tiles have been stamped, and the tile range the camera's view covers (x0, y0, x1, y1; -1: none
    // yet): only stamped tiles in it are drawn.
    this._decalTileStamped = new Uint8Array(0);
    this._decalView = new Int32Array([-1, -1, -1, -1]);

    // ========================================
    // LIGHTING SYSTEM
    // ========================================
    // Full-screen shader mesh for dynamic lighting (multiply blend)
    // Configured via config.lighting: { enabled, baseAmbient }
    this.lightingEnabled = false;
    this.lightingMesh = null; // PIXI.Mesh with lighting shader
    this.lightingShader = null; // Shader instance for updating uniforms
    this.baseAmbient = 0.05; // Base ambient light level (0-1), read from config (night/minimum light)
    this._nightRGB = new Float32Array(3); // Sun.nightLightRGB, once a frame
    this.maxLights = 128; // Light-data texture width / capacity (config.lighting.maxLights)
    this.maxShadowCastingLights = LIGHTING_DEFAULTS.maxShadowCastingLights;
    this.lightingResolution = 1.0; // Resolution multiplier for lighting (e.g. 0.5 for half res)
    this.lightingRT = null; // RenderTexture for low-res lighting
    this.faceRT = null; // DX-FACES: the face map (src/render/faceMap.js)
    // DX-GBUF (plan §6.4): the G-buffer's entity ids map (faceMap.js FACE_IDS_SELF), the face map's size, where the light pass
    // reads ids: self-shadow, or a shadow map (a caster's own shadow never paints its own sprite).
    this.faceIdsRT = null;
    this._faceIdsOn = false;
    // DX-GBUF (plan §6.4): lighting.gbuffer 'mrt': the face map and the ids map drawn in one pass, a render target with both
    // as colour targets (made once they are, remade with them); 'pass' (default): a pass each.
    this._gbufMrt = false;
    this._gbufTarget = null;
    // N-274: whether the G-buffer's target has its depth attachment (the batch's gbufDepthOn when it was made).
    this._gbufTargetDepth = false;
    // DX-UNSHADED (was DX-EMISSIVE v2, plan §6.9, F10): two colours a pixel. Where the entities carry their words, the
    // unshaded pass draws their unshaded pixels into a target the canvas's size (unshadedRT) and the unshaded layer adds them
    // over the lighting layer where the light is short of them (unshadedComposite.js); a pass a frame while a sheet
    // (meta.unshaded) or a sprite is unshaded.
    this._unshadedOn = false;
    // DX-UNSHADED: spriteRenderer.unshaded was set in a scene that draws no G-buffer, and that was said.
    this._unshadedWarned = false;
    this.unshadedRT = null;
    this._unshadedComposite = null;
    this._unshadedQuad = new Float32Array(8);
    this._unshadedQuadBuffer = null;
    this._unshadedRtLayer = { resolution: 1 };
    this._unshadedRtTransform = new Matrix();
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
    // DX-SHADOW3D: lighting.sunShadows 'map' (src/render/sunShadowMap.js): the sun's shadow map, its pass and terms.
    this._sunMapOn = false;
    // DX-SHADOW3D (F7): lighting.lampShadows 'map': a shadow map a lamp (lampShadowMap.js), tiles in an atlas.
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
    this.lampMapRT = null;
    this._lampTileOf = new Int16Array(0);
    /** N-212: each lamp's map shadow fade at the cut, by entity (1 inside it), read with its tile (_readLampTiles). */
    this._lampFadeOf = new Float32Array(0);
    // The light pass's uLampAtlas: tiles a row, a tile's texels, the atlas's width and height.
    this._lampAtlas = new Float32Array([1, 256, 256, 256]);
    this._selfShadowOn = false; // DX-SELFSHADOW: lighting.selfShadow, WebGL for now
    this.sunMapRT = null;
    this._sunMapK = new Float32Array(4);
    // N-317: the sun map reaches past the screen so a pixel near its edge finds its ray's landing (sunMapMargins): the
    // margins it was made with (texels: left, top, right, bottom), the ones this frame needs, the light pass's uv into it
    // (uSunMapRect: the screen's uv times xy plus zw), the atlas's tallest frame (screen px, with the texture LUT) and the
    // camera its passes draw from (world px, doubles).
    this._sunMapMargins = new Int32Array(4);
    this._sunMapRect = new Float32Array([1, 1, 0, 0]);
    this._noMapsSource = null; // DX-MAPS: its stand-in when none has (_emptyMapsSource)
    // DX-BARRIOS: faces have no switch. Whether the light pass reads the face map, whether the faces-in-use word was acted
    // on (_useFaces), whether this scene's light can take faces (lit); the px a px of height rises (the
    // camera's); the faces' light terms (uFaceLight: heightScaleY, 0, 0, the sun's direct share 1 - Sun.skyLight) and what a
    // sprite's own normals take (uNormalShade, OL-6: lighting.normalShading's strength and subtract for the sun, then
    // for the lamps).
    this._facesOn = false;
    this._facesUsed = false;
    this._facesWatch = false;
    this._heightScaleY = NaN;
    this._faceLight = new Float32Array(4);
    this._faceSun = new Float32Array(4); // towards the sun, once a frame
    this._normalShade = new Float32Array(4);
    this._faceRtLayer = { resolution: 1 }; // _writeCameraRtTransform's layer for the face map
    this._faceRtTransform = new Matrix();
    this._faceCamera = new Float64Array(4).fill(NaN); // the camera _faceRtTransform was written for
    // N-272: the face map is drawn a texel inside its edges, so its edge ring stays empty (cleared): the light pass's
    // self-shadow march, which samples with clamp-to-edge, reads nothing past the screen instead of the wall at its edge.
    this._faceRtFrame = new PIXI.Rectangle(1, 1, 1, 1);
    this.lightingDisplaySprite = null; // Sprite to display the lightingRT on stage
    // DX-LIGHTEDGES (lightEdges.js): the light shown without crossing the floor's edges, where the entities write depth:
    // its host in the lighting layer's place (the sprite above then stays off the stage), the unshaded layer's two
    // halves, and the canvas quad they share.
    this._lightEdgesOn = false;
    this._lightEdges = null;
    this._unshadedEdges = null;
    this._lightEdgesQuad = new Float32Array(8);
    this._lightEdgesQuadBuffer = null;
    this._lightEdgesGeometry = null;
    this._lightDataFloats = null; // Float32Array RGBA32F payload (maxLights x 2)
    this._lightDataSource = null; // BufferImageSource uploading _lightDataFloats
    /** E-511: the lights the light data texture held at its last upload (-1: none yet, upload it whole). */
    this._lightDataLive = -1;
    // E-205: the light pass loops over the lights of each pixel's tile (src/render/lightTiles.js), not over every light.
    // The bins, their R32UI texture, the texture unit WebGL uploads it in (the shader sync's for integer textures, N-109)
    // and whether that texture holds the grid's size yet.
    this._lightTilesOn = false;
    this._lightTiles = new LightTiles();
    this._lightTilesSource = null;
    this._lightTilesUnit = 0;
    this._lightTilesMade = false;
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
    this._lfLightSplat = null;

    // ========================================
    // SUN / DIRECTIONAL LIGHT
    // ========================================
    // Sun provides global ambient light that varies with time of day
    // Reads from SharedArrayBuffer via static Sun class (initialized by AbstractWorker)
    this.sunEnabled = false;

    // Pre-computed visible lights (computed once per frame, used by updateLighting shader)
    this._visibleLightsAll = [];
    this._visibleLightsAllCount = 0;

    this.shadowSpritesEnabled = false;

    // RenderTexture-based shadow compositing
    this.shadowRT = null; // RenderTexture for shadow compositing
    this.shadowDisplaySprite = null; // Sprite to display shadowRT with multiply blend
    this.shadowResolution = LIGHTING_DEFAULTS.shadowResolution;

    // Reusable camera render-state
    this._renderCameraX = 0;
    this._renderCameraY = 0;
    this._renderCameraRot = 0;
    /** viewWorldBounds scratch for the light cull. */
    this._lightViewBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
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
    this._lfLightOpts = {
      zoom: 1,
      cameraX: 0,
      cameraY: 0,
      cameraRot: 0,
      resolution: 1,
      canvasW: 0,
      canvasH: 0,
    };
    this._particleLightsEnabled = false;
    this._particleLightMax = 0;
    this._particleLightSplat = null;
    this._particleLightOpts = {
      zoom: 1,
      cameraX: 0,
      cameraY: 0,
      cameraRot: 0,
      resolution: 1,
      canvasW: 0,
      canvasH: 0,
      zenithalMaxHeight: PARTICLE_DEFAULTS.zenithalMaxHeight,
      zenithalAlphaFade: 0,
      layerVisible: null,
      layerAlpha: null,
      max: 256,
    };
    this._particleLightViews = {
      active: null,
      lightSqrt: null,
      x: null,
      y: null,
      z: null,
      alpha: null,
      tint: null,
      flat: null,
      viewMode: null,
      renderOnly: null,
      layerMask: null,
    };
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

    // OPTIMIZED: Preallocated RGB object to avoid allocation per light per frame
    this._rgbResult = { r: 0, g: 0, b: 0 };

    // DX-SPOT: each visible light's coneCos as this frame read it, once (the logic worker may write the column meanwhile).
    // Grown, never per frame.
    this._lightConeCosSeen = new Float32Array(0);
    // OL-4: the walls' rows the light pass reads (pre-render's, lampWallRow.js): the pair of shared buffers, a row's floats
    // and texels, this worker's copy of the rows and its texture, each lamp's row this frame (by entity, row + 1; 0: none)
    // and the lamps given one last frame (to clear them).
    this._wallRowsOn = false;
    this._wallRowBuffers = [null, null];
    this._wallRowFloats = 0;
    this._wallRowTexels = 0;
    this._wallRowsData = new Float32Array(0);
    this._wallRowsSource = null;
    this._wallRowOf = new Int16Array(0);
    this._wallRowLamps = new Int32Array(0);
    this._wallRowLampCount = 0;
    this._wallRowsWarned = false;
    // OL-10: where a rows' header holds the frame's signature, the signature of the rows last sent up, and the frames
    // whose rows were those again (nothing copied, nothing uploaded).
    this._wallSignatureAt = 0;
    this._wallSentLo = 0;
    this._wallSentHi = 0;
    this._wallRowsSkipped = 0;
    // lighting.wallDepth and lighting.lightBehindWalls, in the light pass's uWalls (x, y).
    this._wallTerms = new Float32Array(4);
    this._colliderFillViews = null;
    this._colliderFillMeshBitsCached = 0;
    this._colliderFillLayerCount = -1;
    // N-256 PW-3: the custom layers' runtimes, targets, look shaders and compute passes (src/render/pixi/customLayers.js).
    this.customLayers = new PixiCustomLayers(this);
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
    this._decalCopyBuffers = null;
    /** W21c: the decal premultiply kernel, on the decal memory the tiles live in. */
    this._decalPremultiply = null;
    this.gpuCasterBatch = null;
    // NaN: a double, and falsy until the first viewport, like the missing field was.
    this._lightingPixelScale = NaN;
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
    if (gl && gl.canvas) {
      // N-301: the page restarts the scene from a save of the running world once the context is back (the default
      // prevented, so the browser may restore it); this worker's GPU side is not rebuilt in place.
      gl.canvas.addEventListener(
        'webglcontextlost',
        (e) => {
          e.preventDefault();
          this._framePacer.reset();
          console.warn('[WeedJS] the WebGL context was lost (a driver reset, a GPU switch, too many contexts)');
          self.postMessage({ msg: 'gpuLost', backend: 'webgl' });
        },
        false
      );

      gl.canvas.addEventListener(
        'webglcontextrestored',
        () => {
          this._framePacer.reset();
          self.postMessage({ msg: 'gpuRestored', backend: 'webgl' });
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
          (this.shadowBatch ? 1 : 0) +
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

    if (this.decalTileContainer) {
      this._placeWorldCamera(this.decalTileContainer, zoom, cameraX, cameraY, rot);
      this._cullDecalTiles(zoom, cameraX, cameraY, rot);
    }

    // Shadow sprites render in screen space directly to shadowRT (no camera transform needed here)

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
      if (this.entitiesBatch.poseInterp) {
        packOpts.prevX = this._latchedPrevX;
        packOpts.prevY = this._latchedPrevY;
        packOpts.snap = this._poseSnap;
      }
      // E-177: a keyed batch takes the queue frame it draws (its changed marks are that frame's) and its buffer.
      this.entitiesBatch.keyedFrame = this.lastReadFrame;
      this.entitiesBatch.keyedBuffer = (this.lastReadFrame - 1) & 1;
      // E-387: and the columns its keyed pack writes the instances' G-buffer words from (_commitPixiGbuf takes them).
      if (this.entitiesBatch.gbuf && this.entitiesBatch.keyed) {
        this.entitiesBatch.setGbufColumns(SpriteRenderer.gbufFlags, ShadowCaster.selfShadow,
          this._painter !== null && SpriteRenderer.zIndexUsers() > 0 ? SpriteRenderer.zIndex : null);
      }
      const n = this.entitiesBatch.upload(this._packQ, packOpts);
      packOpts.prevX = null;
      packOpts.prevY = null;
      packOpts.snap = false;
      this.entitiesBatch.setPoseAlpha(this._poseAlpha);
      this._posePacked = true;
      return n;
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
   * Type 3 = light glow (_lightGradient) — separate ADD batch avoids gray halos.
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
      this._opaqueOn && !this._entityChunksActive && !this._screenLayersShown() && (root === null || root.alpha >= 1),
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
      !this.entitiesBatch.poseInterp &&
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
      this.entitiesBatch.setPoseAlpha(this._poseAlpha);
      this._posePacked = true;
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
    if (this.entitiesBatch.poseInterp) return 'the entity batch interpolates poses';
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
    if (this.shadowBatch) this.shadowBatch.setLutSource(lut);
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
    }
    if (this.entitiesGlowBatch) this.entitiesGlowBatch.setAtlasSource(src);
    if (this.shadowBatch) this.shadowBatch.setAtlasSource(src);
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
   * W9d: gpuPack.wasm on Pixi's regions of the render-queue memory, when the scene laid them out (W9e: with pose
   * interpolation too, 17 floats a row for the pose batch's two streams).
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
    const floats = layout.pixiInstanceFloats | 0 || INSTANCED_SPRITE_FLOATS;
    // A layout made for the other mode (interpolation on or off) leaves the entity batch packing in JS.
    if (rows > 0 && rows >= (this.renderQueueMaxItems | 0)
      && floats === (this._queueInterp ? POSE_DYN_FLOATS + POSE_STATIC_FLOATS : INSTANCED_SPRITE_FLOATS)) {
      this._pixiInstanceRows = new Float32Array(memory.buffer, layout.pixiInstanceByte, rows * floats);
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
          shadowByte: layout.pixiKeyShadowByte ?? -1,
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
    const facesDepth = this._faceDepthWanted();
    // OL-14: so do walls whose light is drawn under the canvas's size: the light's edges need the entities' depth.
    const wallsDepth = wallEdgesWanted(this.config?.lighting);
    const pixelDepth = (this.assets.atlasMapsSource !== null || facesDepth || wallsDepth)
      && (wantDepth === true || (wantDepth !== false && oblique))
      ? {
        maps: this.assets.atlasMapsSource ?? this._emptyMapsSource(),
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
      poseInterp: this._queueInterp,
      data: this._pixiInstanceRows,
      gpuPack: this._pixiGpuPack,
      // E-82b: the plain sprites in two streams, the statics uploaded when they change. E-513: a nearest atlas too (its
      // pixel snap is in the sprite vertex shaders: N-271, pixelSnap.js).
      split: !this._queueInterp,
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
      // DX-GBUF (plan §6.4): each instance's G-buffer words (gbufWord.js), where the G-buffer pass runs (faces, a sheet
      // with maps, a shadow map: gbufWanted, as pre-render decides it).
      gbuf: gbufWanted(this.config, { maps: this.assets.atlasMapsSource !== null, unshaded: this.assets.atlasUnshaded }),
      // E-448: the binary frames' solid pixels first, nearest first, with the canvas's depth (opaquePass.js), through the
      // record textures (the pass's pose texture); the batch takes it where it can (WebGL, no pixel depth, no G-buffer
      // words).
      opaquePass: pixelDepth === null && !this._useWebGpu ? this._gpuRecordTexture() : null,
      // A pose batch's vertex buffers bound by ANGLE as they are (one upload a frame): no copy of every draw's attributes.
      // Not a keyed or split one, which the hint made slower on the GPU (why is not traced): Predator's keyed colour pass
      // 1.66 -> 2.12 ms (~800 MHz), bunnyMarkStress's split frames 3.12 -> 3.23 ms (medians of 4).
      staticBuffers: this._queueInterp,
      // W30: room for its two streams at their widest (a pose batch's 17 floats a row), and an indexed frame's slot
      // stream and statics rows; a keyed one's slot stream, updates (its statics are scattered on the GPU) and, E-191, the
      // shadow stream of the sun's pass over its instances (3 floats a row). E-448: a pose texture row more for the pose
      // stream, which the opaque pass copies whole rows of.
      arena: this._batchArena(maxItems * (POSE_DYN_FLOATS + POSE_STATIC_FLOATS) + OPAQUE_POSE_TEXELS * 4
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
      if (this._queueInterp && this.renderQueueX) {
        this._latchedPrevX = this.renderQueueX;
        this._latchedPrevY = this.renderQueueY;
        this._latchedPrevCount = this.renderQueueCount[0] | 0;
      }
      const previousReady = this.lastReadFrame;
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
      if (this._queueInterp) {
        const currentCount = this.renderQueueCount ? this.renderQueueCount[0] | 0 : 0;
        const consecutive = previousReady > 0 && readyFrame === previousReady + 1;
        this._poseSnap = !consecutive || this._latchedPrevCount !== currentCount;
        this._notePosePublish();
      }
    }
    if (started) this.queueTimeThisFrame = performance.now() - started;
    return consumedNewFrame;
  }

  shouldDrawFrameLockedPasses(consumedNewFrame, resuming) {
    return consumedNewFrame || resuming || this.lastReadFrame <= 0 || !this.renderQueueSync;
  }

  tickInterpolatedPose() {
    if (!this._queueInterp || !this._posePacked || !this.entitiesBatch) return;
    const started = this.collectDetailedStats ? performance.now() : 0;
    this._tickPoseAlpha();
    this.entitiesBatch.setPoseAlpha(this._poseAlpha);
    if (started) this.miscTimeThisFrame += performance.now() - started;
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
      if (name === 'lighting' && this._unshadedComposite !== null) this._unshadedComposite.alpha = Layer._alpha[i];
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
      // The light's meshes multiply and add by themselves (lightEdges.js): a blend on their host would change nothing.
      if (name !== 'lighting' || this._lightEdges === null) display.blendMode = blend;
    }
    // The entities' meshes set their own blend, so their root's was never inherited: the batch takes it (its opaque pass
    // drops itself off 'normal').
    if (name === 'entities' && this.entitiesBatch) this.entitiesBatch.setLayerBlend(layer.blendMode);
    if (name === 'lighting' && this._unshadedComposite !== null) this._unshadedComposite.zIndex = z;
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

  drawFrameLights() {
    const started = this.collectDetailedStats ? performance.now() : 0;
    this.computeVisibleLights();
    this.updateLighting();
    if (started) this.lightsTimeThisFrame = performance.now() - started;
  }

  drawFrameShadows() {
    const started = this.collectDetailedStats ? performance.now() : 0;
    this.shadowMaps.updateShadowSprites();
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

  renderLightingToTexture() {
    const started = this.collectDetailedStats ? performance.now() : 0;
    if (!this._unshadedOn && !this._unshadedWarned && (this.frameNumber & 127) === 0 && SpriteRenderer.unshadedUsers() > 0) {
      // DX-UNSHADED: a sprite asks to be unshaded where nothing carries its words: said once, with what turns them on.
      this._unshadedWarned = true;
      console.warn(
        'WeedJS: spriteRenderer.unshaded is set, but this scene draws no G-buffer, so nothing is unshaded: set ' +
          'config.lighting.unshaded = true (maps, an unshaded sheet or a shadow map turn it on too).',
      );
    }
    if (this.lightingRT && this.lightingMesh && layerIsVisible(Layer.lighting?.id)) {
      if (this.faceRT !== null) this._renderFaceMap();
      const renderOptions = this._rtRenderOpts;
      renderOptions.transform = null;
      renderOptions.container = this.lightingMesh;
      renderOptions.target = this.lightingRT;
      renderOptions.clear = true;
      renderOptions.clearColor = this._clearTransparent;
      this._submitRender(renderOptions);
      this._renderLiquidFunLightingField();
      this._renderParticleLightingField();
      if (this._unshadedOn) this._renderUnshaded();
    } else if (this._unshadedComposite !== null && this._unshadedComposite.visible) {
      // DBG-1: the unshaded pixels go with the lighting layer: hidden, it would keep adding the last frame's.
      this._unshadedComposite.visible = false;
    }
    if (started) this.lightsTimeThisFrame += performance.now() - started;
  }

  /**
   * DX-UNSHADED: the unshaded target (the canvas's size) and the unshaded layer, a quad over the canvas just above the
   * lighting layer that adds unshaded · (1 - light) (unshadedComposite.js), its blend additive.
   */
  /** DX-LIGHTEDGES: the programs' environment for lightEdges.js. */
  _lightEdgesEnv() {
    return { GpuProgram, GlProgram: PIXI.GlProgram, useWebGpu: this._useWebGpu };
  }

  /** DX-LIGHTEDGES: the light's host (lightEdges.js) over the canvas quad, in the lighting layer's place. */
  _createLightEdges() {
    unshadedQuadPositions(this._lightEdgesQuad, this.canvasWidth, this.canvasHeight);
    this._lightEdgesQuadBuffer = new Buffer({ data: this._lightEdgesQuad, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    this._lightEdgesGeometry = lightEdgesQuad(this._lightEdgesQuadBuffer);
    this._lightEdges = lightEdgesHost(this._lightEdgesEnv(), this._lightEdgesGeometry, this.lightingRT.source);
    this._registerLayerDisplayObject('lighting', this._lightEdges.host);
    this.pixiApp.stage.addChild(this._lightEdges.host);
  }

  /** DX-LIGHTEDGES: the lighting layer's display: the edges' host, or the stretched sprite. */
  _lightingDisplay() {
    return this._lightEdges !== null ? this._lightEdges.host : this.lightingDisplaySprite;
  }

  /**
   * DX-LIGHTEDGES: every mesh of the edges' hosts on `light` (and the unshaded halves on `unshaded`): EMPTY before a
   * resize replaces the targets (_replaceRT destroys the bind groups still listening on the old ones), the new ones after.
   */
  _bindLightEdges(light, unshaded) {
    if (this._lightEdges !== null) {
      const meshes = this._lightEdges.meshes;
      for (let i = 0; i < meshes.length; i++) {
        const res = meshes[i].shader.resources;
        if (res.uLight !== light) res.uLight = light;
      }
    }
    if (this._unshadedEdges !== null) {
      const meshes = this._unshadedEdges.meshes;
      for (let i = 0; i < meshes.length; i++) {
        const res = meshes[i].shader.resources;
        if (res.uLight !== light) res.uLight = light;
        if (res.uUnshaded !== unshaded) res.uUnshaded = unshaded;
        if (this._useWebGpu && res.uUnshadedSampler !== unshaded.style) res.uUnshadedSampler = unshaded.style;
      }
    }
  }

  /** DX-LIGHTEDGES: the hosts off the stage and destroyed (a light pass made again, or a teardown). */
  _releaseLightEdges() {
    const empty = PIXI.Texture.EMPTY.source;
    this._bindLightEdges(empty, empty);
    if (this._lightEdges !== null) {
      this._lightEdges.host.removeFromParent();
      this._lightEdges.host.destroy({ children: true });
      this._lightEdges = null;
    }
    this._unshadedEdges = null;
  }

  _createUnshadedLayer() {
    const width = this.canvasWidth;
    const height = this.canvasHeight;
    // DBG-3: it fades with the lighting layer (syncLayerAlphaFromSharedState), from the alpha that layer has now.
    const lightingId = Layer.lighting?.id;
    const alpha = lightingId !== undefined && Layer._alpha ? Layer._alpha[lightingId] : 1;
    this.unshadedRT = PIXI.RenderTexture.create({ width, height });
    if (this._lightEdges !== null) {
      // DX-LIGHTEDGES: the two halves over the light host's stencil marks, drawn right after it (same zIndex, added later).
      this._unshadedEdges = unshadedEdgesHost(this._lightEdgesEnv(), this._lightEdgesGeometry, this.lightingRT.source, this.unshadedRT.source);
      const host = this._unshadedEdges.host;
      host.visible = false;
      host.alpha = alpha;
      host.zIndex = this._lightEdges.host.zIndex;
      this._unshadedComposite = host;
      this.pixiApp.stage.addChild(host);
      this.pixiApp.stage.sortChildren();
      return;
    }
    unshadedQuadPositions(this._unshadedQuad, width, height);
    this._unshadedQuadBuffer = new Buffer({ data: this._unshadedQuad, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    const geometry = new PIXI.Geometry({
      attributes: {
        aPosition: { buffer: this._unshadedQuadBuffer, format: 'float32x2', stride: 8, offset: 0 },
        aUV: [0, 0, 1, 0, 1, 1, 0, 1],
      },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });
    const glow = this.unshadedRT.source;
    const light = this.lightingRT.source;
    const shader = this._useWebGpu
      ? new PIXI.Shader({
          gpuProgram: unshadedCompositeGpuProgram(GpuProgram),
          resources: { uUnshaded: glow, uUnshadedSampler: glow.style, uLight: light, uLightSampler: light.style },
        })
      : new PIXI.Shader({
          glProgram: PIXI.GlProgram.from({ vertex: UNSHADED_COMPOSITE_VERT, fragment: UNSHADED_COMPOSITE_FRAG, name: 'weed-glow' }),
          resources: { uUnshaded: glow, uLight: light },
        });
    const state = new PIXI.State();
    state.blendMode = 'add';
    state.depthTest = false;
    state.depthMask = false;
    state.culling = false;
    const mesh = new PIXI.Mesh({ geometry, shader, state, label: 'weed-glow' });
    mesh.blendMode = 'add';
    mesh.cullable = false;
    mesh.visible = false;
    mesh.alpha = alpha;
    mesh.zIndex = this.lightingDisplaySprite ? this.lightingDisplaySprite.zIndex : 0;
    this._unshadedComposite = mesh;
    this.pixiApp.stage.addChild(mesh);
    this.pixiApp.stage.sortChildren();
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
    const t = this._lightTiles;
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
    const t = this._lightTiles;
    const out = {
      msg: 'lightTile', x: -1, y: -1, cols: t.cols, rows: t.rows, tilePx: t.tilePx, border: t.border, wordsUsed: t.wordsUsed,
      lights: [],
    };
    if (!this._lightTilesOn || t.texWidth < 1 || !(t.tilePx > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return out;
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
    const source = this._lightTilesSource;
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

  _unbindUnshadedLayer() {
    const mesh = this._unshadedComposite;
    if (mesh === null) return;
    if (this._unshadedEdges !== null) {
      const empty = PIXI.Texture.EMPTY.source;
      this._bindLightEdges(empty, empty);
      return;
    }
    const res = mesh.shader.resources;
    const empty = PIXI.Texture.EMPTY.source;
    if (res.uUnshaded !== empty) res.uUnshaded = empty;
    if (res.uLight !== empty) res.uLight = empty;
    if (this._useWebGpu) {
      if (res.uUnshadedSampler !== empty.style) res.uUnshadedSampler = empty.style;
      if (res.uLightSampler !== empty.style) res.uLightSampler = empty.style;
    }
  }

  /** DX-UNSHADED: the unshaded layer's targets as the light's and the unshaded's are now (a resize remakes them). */
  _bindUnshadedLayer() {
    const mesh = this._unshadedComposite;
    if (mesh === null || this.unshadedRT === null || this.lightingRT === null) return;
    if (this._unshadedEdges !== null) {
      this._bindLightEdges(this.lightingRT.source, this.unshadedRT.source);
      return;
    }
    const res = mesh.shader.resources;
    const glow = this.unshadedRT.source;
    const light = this.lightingRT.source;
    if (res.uUnshaded !== glow) res.uUnshaded = glow;
    if (res.uLight !== light) res.uLight = light;
    if (this._useWebGpu) {
      if (res.uUnshadedSampler !== glow.style) res.uUnshadedSampler = glow.style;
      if (res.uLightSampler !== light.style) res.uLightSampler = light.style;
    }
  }

  /**
   * DX-UNSHADED: this frame's unshaded pixels, while a sheet or a sprite is unshaded: the entities again into the unshaded
   * target (the canvas's size, as they land on it), and the unshaded layer shown with the lighting layer; else hidden.
   */
  _renderUnshaded() {
    const mesh = this._unshadedComposite;
    if (mesh === null || this.unshadedRT === null) return;
    const on = (this.assets.atlasUnshaded || SpriteRenderer.unshadedUsers() > 0) && layerIsVisible(Layer.lighting?.id);
    if (!on) {
      if (mesh.visible) mesh.visible = false;
      return;
    }
    const batch = this.entitiesBatch;
    const maps = this.assets.atlasMapsSource ?? this._emptyMapsSource();
    // E-457: the unshaded mask (an unshaded word or sheet), then the unshaded pass drawn where it marked
    // (InstancedSpriteBatch.unshadedPass).
    const pass = batch !== null && batch.mesh.visible ? batch.unshadedPass(this._heightScaleY, this._groundScaleY || 1, maps) : null;
    const opts = this._rtRenderOpts;
    opts.container = pass !== null ? pass : this._rtEmptyContainer;
    opts.target = this.unshadedRT;
    opts.clear = true;
    opts.clearColor = this._clearTransparent;
    opts.transform = this._writeCameraRtTransform(this._unshadedRtTransform, this._unshadedRtLayer);
    this._submitRender(opts);
    opts.transform = null;
    this._gpuPassesThisFrame++;
    const display = this._lightingDisplay();
    if (display && mesh.zIndex !== display.zIndex) mesh.zIndex = display.zIndex;
    if (!mesh.visible) mesh.visible = true;
  }

  /** DX-FACES: the face map's texture, nearest (its texels are codes), at the light pass's size. */
  _createFaceMap(width, height) {
    this.faceRT = PIXI.RenderTexture.create({ width, height, scaleMode: 'nearest' });
    // N-272: the area drawn, a texel inside each edge (the pass's transform is moved a texel to match).
    this._faceRtFrame.width = Math.max(1, this.faceRT.width - 2);
    this._faceRtFrame.height = Math.max(1, this.faceRT.height - 2);
    this._faceRtLayer.resolution = this.lightingResolution;
    this._faceCamera[0] = NaN; // a turned camera's transform holds the canvas's size
    const res = this.lightingShader?.resources;
    if (res) res.uFaceMap = this.faceRT.source;
    // DX-GBUF: the entity ids map, the face map's size and layout.
    if (this._faceIdsOn) {
      this.faceIdsRT = PIXI.RenderTexture.create({ width, height, scaleMode: 'nearest' });
      if (res) res.uFaceIds = this.faceIdsRT.source;
    }
  }

  /**
   * DX-FACEDEPTH: whether the entities' depth reads faces: once a decoration carries a normal (DecorationPool.facesInUse).
   */
  _faceDepthWanted() {
    return DecorationPool.facesInUse();
  }

  /**
   * DX-BARRIOS: faces have no switch. Once a decoration carries a normal (DecorationPool.facesInUse: normally the first frame,
   * as a scene's create() spawns them): the entities' depth reads faces (DX-FACEDEPTH; an oblique scene without a map sheet
   * turns pixel depth on for them), and a lit scene's light pass, made again, reads the face map. Once.
   */
  _useFaces() {
    this._facesUsed = true;
    const batch = this.entitiesBatch;
    if (batch) {
      if (batch.pixelDepthOn) batch.setDepthFaces(true);
      else if (this._pixelDepthWanted()) batch.enablePixelDepth(this.assets.atlasMapsSource ?? this._emptyMapsSource(), true);
      this._placeDepthMeshes();
    }
    if (this.lightingEnabled && this._facesWatch && !this._facesOn) {
      this._facesOn = true;
      this._rebuildLightPass();
    }
  }

  /** DX-DEPTH: whether the entities take pixel depth by the scene's camera (renderer.pixelDepth true, or oblique). */
  _pixelDepthWanted() {
    const want = this.config?.renderer?.pixelDepth;
    return want === true || (want !== false && cameraFloorScaleY(this.config) < 1 && cameraHeightScaleY(this.config) > 0);
  }

  /**
   * DX-BARRIOS: the light pass made again (faces turned on after it was made): what createLightingSystem put on the stage
   * and in its targets goes, unbound first (as a resize unbinds), and it makes them again, now with the face map.
   */
  _rebuildLightPass() {
    if (!this.lightingMesh) return;
    const empty = PIXI.Texture.EMPTY.source;
    const res = this.lightingShader?.resources;
    if (res) {
      if (res.uFaceMap) res.uFaceMap = empty;
      if (res.uFaceIds) res.uFaceIds = empty;
    }
    if (this._unshadedComposite !== null) {
      this._unbindUnshadedLayer();
      this._unshadedComposite.removeFromParent();
      this._unshadedComposite = null;
    }
    this._releaseLightEdges();
    this._releaseGbufTarget();
    if (this.lightingDisplaySprite) {
      this.lightingDisplaySprite.removeFromParent();
      this.lightingDisplaySprite.destroy();
      this.lightingDisplaySprite = null;
    } else {
      this.lightingMesh.removeFromParent();
    }
    for (const rt of [this.faceRT, this.faceIdsRT, this.unshadedRT, this.lightingRT]) if (rt) rt.destroy(true);
    this.faceRT = null;
    this.faceIdsRT = null;
    this.unshadedRT = null;
    this.lightingRT = null;
    this.lightingMesh = null;
    this.createLightingSystem();
    this.pixiApp?.stage?.sortChildren();
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

  /** DX-MAPS: a 1 × 1 twin page that says "no map", for the faces' pass when no sheet has maps. */
  _emptyMapsSource() {
    if (this._noMapsSource === null) {
      this._noMapsSource = PIXI.TextureSource.from({
        resource: new Uint8Array(4),
        width: 1,
        height: 1,
        format: 'rgba8unorm',
        scaleMode: 'nearest',
        addressMode: 'clamp-to-edge',
        autoGenerateMipmaps: false,
        alphaMode: 'no-premultiply-alpha',
      });
    }
    return this._noMapsSource;
  }

  /**
   * DX-FACES: what each pixel of this frame is, in painter order, for the light pass. DX-GBUF: and, with the ids map, what
   * entity covers it, in a pass of its own over the same instances (lighting.gbuffer 'pass').
   */
  _renderFaceMap() {
    const batch = this.entitiesBatch;
    const maps = this.assets.atlasMapsSource ?? this._emptyMapsSource();
    const mesh = batch !== null ? batch.faceMesh(this._heightScaleY, this._groundScaleY || 1, maps) : null;
    const opts = this._rtRenderOpts;
    opts.container = mesh !== null && batch.mesh.visible ? mesh : this._rtEmptyContainer;
    opts.target = this.faceRT;
    opts.clear = true;
    opts.clearColor = this._clearTransparent;
    // Once a frame this stays in the baseline tiers, where every double it works out is a heap number: a still camera
    // works out none.
    const seen = this._faceCamera;
    const rot = this._renderCameraRot || 0;
    if (seen[0] !== this._renderCameraX || seen[1] !== this._renderCameraY || seen[2] !== this._renderZoom || seen[3] !== rot) {
      seen[0] = this._renderCameraX;
      seen[1] = this._renderCameraY;
      seen[2] = this._renderZoom;
      seen[3] = rot;
      const mx = this._writeCameraRtTransform(this._faceRtTransform, this._faceRtLayer);
      // N-272: the frame's projection starts at its corner (1, 1): a texel back, each pixel lands where it did.
      mx.tx -= 1;
      mx.ty -= 1;
    }
    opts.transform = this._faceRtTransform;
    // N-272: drawn inside the edge ring (the clear still clears the whole target, the ring with it).
    opts.frame = this._faceRtFrame;
    const mrt = this._gbufMrt && this.faceIdsRT !== null ? this._ensureGbufTarget() : null;
    if (mrt !== null) {
      // DX-GBUF (lighting.gbuffer 'mrt'): both targets in this one pass.
      const both = batch !== null ? batch.gbufMesh(this._heightScaleY, this._groundScaleY || 1, maps) : null;
      opts.container = both !== null && batch.mesh.visible ? both : this._rtEmptyContainer;
      opts.target = mrt;
      this._submitRender(opts);
      opts.transform = null;
      opts.frame = null;
      return;
    }
    this._submitRender(opts);
    if (this.faceIdsRT !== null) {
      const ids = batch !== null ? batch.idsMesh(this._heightScaleY, this._groundScaleY || 1, maps) : null;
      opts.container = ids !== null && batch.mesh.visible ? ids : this._rtEmptyContainer;
      opts.target = this.faceIdsRT;
      this._submitRender(opts);
      this._gpuPassesThisFrame++;
    }
    opts.transform = null;
    opts.frame = null;
  }

  /**
   * DX-GBUF (lighting.gbuffer 'mrt'): the render target whose colour targets are the face map and the entity ids map (Pixi's
   * RenderTarget, its class the canvas's target's: the bundle exports none), for the G-buffer's one pass; null where it
   * cannot be made (the passes then draw a target each).
   */
  _ensureGbufTarget() {
    // N-274: with pixel depth the one pass tests and writes depth: a target with a depth attachment, made again if that changed.
    const depth = !!this.entitiesBatch?.gbufDepthOn;
    if (this._gbufTarget !== null && this._gbufTargetDepth === depth) return this._gbufTarget;
    if (this._gbufTarget !== null) this._releaseGbufTarget();
    const RenderTargetClass = this.pixiApp?.renderer?.view?.renderTarget?.constructor;
    if (typeof RenderTargetClass !== 'function' || this.faceRT === null || this.faceIdsRT === null) {
      this._gbufMrt = false;
      return null;
    }
    this._gbufTarget = new RenderTargetClass({
      colorTextures: [this.faceRT, this.faceIdsRT], depthStencilTexture: depth, label: 'weed-gbuffer',
    });
    this._gbufTargetDepth = depth;
    return this._gbufTarget;
  }

  /**
   * DX-GBUF: the G-buffer's one-pass target goes before its textures do (a resize remakes them): its GPU side through the
   * render target system's records (Pixi releases a texture's own target when the texture goes, not one made of several).
   */
  _releaseGbufTarget() {
    const target = this._gbufTarget;
    if (target === null) return;
    this._gbufTarget = null;
    const system = this.pixiApp?.renderer?.renderTarget;
    const gpuTargets = system ? system._gpuRenderTargetHash : null;
    const gpu = gpuTargets ? gpuTargets[target.uid] : null;
    if (gpu && system.adaptor && typeof system.adaptor.destroyGpuRenderTarget === 'function') {
      gpuTargets[target.uid] = null;
      system.adaptor.destroyGpuRenderTarget(gpu);
    }
    if (system && system._renderSurfaceToRenderTargetHash) system._renderSurfaceToRenderTargetHash.delete(target);
    if (typeof target.destroy === 'function') target.destroy();
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
    const consumedNewFrame = this.consumeNextRenderQueue();
    this._newQueueThisFrame = consumedNewFrame ? 1 : 0;

    this.lightsTimeThisFrame = 0;
    this.shadowsTimeThisFrame = 0;
    this.spritesTimeThisFrame = 0;
    this.sortTimeThisFrame = 0;
    this.customLayersTimeThisFrame = 0;
    this.miscTimeThisFrame = 0;
    this._decalTilesDirtyThisFrame = 0;
    this._decalTilesUploadedThisFrame = 0;
    this.customLayers.meshFillInstancesThisFrame = 0;
    this.customLayers.meshRtDrawsThisFrame = 0;
    this._gpuPassesThisFrame = 0;
    this._gpuCastersThisFrame = 0;
    this._gpuShadowLightsThisFrame = 0;

    try {
      if (!consumedNewFrame) this.tickInterpolatedPose();
      this.ensureCameraBeforeFirstFrame();
      this.updateCameraTransform();
      this.updateGpuParticleLayers();
      this.syncLayerAlphaFromSharedState();
      this.syncLayerPresentationFromSharedState();
      this.updateDecalTiles();
      if (this.shouldDrawFrameLockedPasses(consumedNewFrame, resuming)) {
        this.syncLayerResolutionFromSharedState();
        this.uploadTextureLookupIfNeeded();
        // DX-BARRIOS: the first decoration with a normal turns faces on (the G-buffer, the depth's planes).
        if (!this._facesUsed && DecorationPool.facesInUse()) this._useFaces();
        this.drawFrameLights();
        // E-191: the sprites first, so a keyed frame's statics texture and instances are this frame's when the sun's
        // shadow pass draws them.
        this.drawFrameSprites();
        this.drawFrameShadows();
        this.drawFrameCustomLayers();
        this.renderLightingToTexture();
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
    const throughScreenLayers = this._screenLayers.length > 0 && this._presentThroughScreenLayers();
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
   * DX-POST: a LAYER_KIND.SCREEN layer. Its look reads the frame below it (uTexture, bound each frame by
   * _presentThroughScreenLayers), through one full-screen mesh that draws into a target or onto the canvas alike: every
   * frame the passes read is laid out as the canvas is (on WebGL the stage is drawn into it with the canvas's
   * projection), so the mesh copies texel for pixel, no V flip. It is not on the stage: the stage is what the passes read.
   * @param {object} config the layer's worker metadata
   */
  _initScreenLayer(config) {
    const layerId = config.id;
    const layerName = config.name;
    const name = config.shaderName || layerName;
    const uniformDefs = this.customLayers.buildUniformDefs(layerId, config.uniformMap, config.uniformTypes);
    // A pass that names uScene reads the frame before the first pass too (a bloom adds a blurred copy to it).
    const usesScene = typeof config.shaderFragment === 'string' && /\buScene\b/.test(config.shaderFragment);
    let shader;
    try {
      const empty = PIXI.Texture.EMPTY.source;
      shader = this.customLayers.createLookShader(config.shaderFragment, empty, uniformDefs, name, layerName, usesScene ? empty : null);
    } catch (err) {
      if (err && typeof err.message === 'string' && err.message.startsWith('WeedJS:')) throw err;
      throw errorCompileFailed('look', name, layerName, this._useWebGpu ? 'WebGPU' : 'WebGL', err);
    }
    const resolution = Layer._resolution?.[layerId];
    this._screenLayers.push({
      layerId,
      layerName,
      zIndex: Layer._zIndex?.[layerId] ?? 0,
      resolution: resolution > 0 ? resolution : 1,
      // How it samples the frame it reads ('linear', or 'nearest' for pixel art).
      scaleMode: Layer.scaleModeString(Layer._normalizeScaleMode(config.scaleMode)),
      shader,
      uniformStore: shader.resources?.customUniforms?.uniforms || null,
      uniformEntries: config.uniformMap ? Object.entries(config.uniformMap) : null,
      mesh: this.customLayers.makeLookShaderMesh(shader, false),
      usesScene,
      // Its output when it is not the last visible pass: the canvas's size times its resolution.
      target: null,
    });
    this._screenLayers.sort((a, b) => a.zIndex - b.zIndex);
    debugWorkerLog(`PIXI WORKER: SCREEN layer "${layerName}" initialized`);
  }

  _destroyScreenLayers() {
    const layers = this._screenLayers;
    for (let i = 0; i < layers.length; i++) {
      const cl = layers[i];
      this._unbindScreenLayerTextures(cl);
      if (cl.target) {
        this._releaseTextureBindGroups(cl.target);
        cl.target.destroy(true);
      }
      cl.mesh.destroy();
    }
    this._screenLayers = [];
    if (this._screenSceneRT) {
      this._releaseTextureBindGroups(this._screenSceneRT);
      this._screenSceneRT.destroy(true);
      this._screenSceneRT = null;
    }
    this._screenSceneDepth = null;
  }

  /**
   * A target of width × height: `rt` when it has that size, else a new one. The old one is unbound from every pass
   * first and destroyed (a resized source keeps a stale framebuffer, as the other viewport targets found).
   */
  _screenTarget(rt, width, height) {
    if (rt && rt.width === width && rt.height === height) return rt;
    if (rt) {
      const layers = this._screenLayers;
      for (let i = 0; i < layers.length; i++) this._unbindScreenLayerTextures(layers[i]);
      this._releaseTextureBindGroups(rt);
      rt.destroy(true);
    }
    return PIXI.RenderTexture.create({ width, height });
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

  /** DX-POST: whether a SCREEN layer is visible, so the stage goes into a target of its own (_presentThroughScreenLayers). */
  _screenLayersShown() {
    const layers = this._screenLayers;
    for (let i = 0; i < layers.length; i++) if (layerIsVisible(layers[i].layerId)) return true;
    return false;
  }

  /**
   * DX-POST: with a visible SCREEN layer, the stage goes into a target the canvas's size, cleared to the canvas's
   * background. Each visible SCREEN layer then, in zIndex order, reads what came before it and draws into its own
   * target, and the last onto the canvas. Without a visible one: false, and the present is the stage's as before.
   */
  _presentThroughScreenLayers() {
    const layers = this._screenLayers;
    let last = -1;
    for (let i = 0; i < layers.length; i++) if (layerIsVisible(layers[i].layerId)) last = i;
    if (last < 0) return false;
    const app = this.pixiApp;
    if (!app?.renderer || !app.stage) return false;
    // E-448: the stage's target here has no depth buffer on WebGL, which the opaque pass draws with.
    if (this.entitiesBatch !== null) this.entitiesBatch.dropOpaquePass();
    const width = this.canvasWidth;
    const height = this.canvasHeight;
    this._screenSceneRT = this._screenTarget(this._screenSceneRT, width, height);
    // DX-DEPTH: the entities' pixel depth writes frag_depth on WebGPU, and a pipeline that does needs a depth attachment
    // in its target (WebGL draws the painter alone in a target without one).
    if (this._screenSceneDepth !== this._screenSceneRT && this._useWebGpu && this.entitiesBatch !== null
      && this.entitiesBatch.pixelDepthOn) {
      this._ensureTargetDepth(this._screenSceneRT);
      this._screenSceneDepth = this._screenSceneRT;
    }

    const opts = this._rtRenderOpts;
    const background = app.renderer.background?.colorRgba;
    const clear = this._screenClear;
    if (background) {
      clear[0] = background[0];
      clear[1] = background[1];
      clear[2] = background[2];
      clear[3] = background[3];
    }
    opts.transform = null;
    opts.container = app.stage;
    opts.target = this._screenSceneRT;
    opts.clear = true;
    opts.clearColor = clear;
    // WebGL draws into a texture upside down from the canvas (Pixi flips the projection): flipY undoes it, so the
    // stage lands as on the canvas, pixel for pixel, and a copy pass is exact. WebGPU has no such flip.
    opts.flipY = !this._useWebGpu;
    this._submitRender(opts);
    opts.flipY = false;

    const frame = this._computeFrame;
    frame.dt = this._lastDt || 1 / 60;
    frame.cameraX = this._renderCameraX;
    frame.cameraY = this._renderCameraY;
    frame.canvasW = width;
    frame.canvasH = height;
    frame.zoom = this._renderZoom;
    frame.time = (this.accumulatedTime || 0) * 0.001;
    frame.worldW = finiteOrZero(this.worldWidth);
    frame.worldH = finiteOrZero(this.worldHeight);

    let source = this._screenSceneRT;
    for (let i = 0; i <= last; i++) {
      const cl = layers[i];
      if (!layerIsVisible(cl.layerId)) continue;
      this._syncScreenLayerUniforms(cl);
      applyEngineLookUniforms(cl, frame);
      const input = source.source;
      if (input.scaleMode !== cl.scaleMode) input.scaleMode = cl.scaleMode;
      const res = cl.shader.resources;
      if (res.uTexture !== input) res.uTexture = input;
      if (res.uSampler !== undefined && res.uSampler !== input.style) res.uSampler = input.style;
      if (cl.usesScene && res.uScene !== this._screenSceneRT.source) res.uScene = this._screenSceneRT.source;
      if (i === last) {
        // The canvas, cleared to its background first: a pass that copies gives the frame the stage would have.
        this._submitRender(cl.mesh);
      } else {
        cl.target = this._screenTarget(cl.target, rtPixelSize(width, cl.resolution), rtPixelSize(height, cl.resolution));
        opts.container = cl.mesh;
        opts.target = cl.target;
        opts.clear = true;
        opts.clearColor = this._clearTransparent;
        this._submitRender(opts);
        source = cl.target;
      }
    }
    opts.container = null;
    opts.target = null;
    opts.clearColor = this._clearTransparent;
    return true;
  }

  _unbindScreenLayerTextures(cl) {
    this.customLayers.unbindLookShaderTexture(cl.shader);
    if (cl.usesScene) cl.shader.resources.uScene = PIXI.Texture.EMPTY.source;
  }

  /** A SCREEN layer's uniforms written from any thread (Layer.x.setUniform), as updateCustomLayers does for looks. */
  _syncScreenLayerUniforms(cl) {
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

  /**
   * Create sprites for each blood decal splat tile (SAB tiles, not TileMap background)
   * Each tile is a Sprite with an initially transparent texture
   * Textures are updated when particle_worker marks tiles as dirty
   */
  createDecalTileSprites() {
    const tileSize = this.decalsTileSize;

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
        sprite.visible = false; // Hidden until first decal splat, and while outside the view (_cullDecalTiles)

        this.decalTileSprites[tileIndex] = sprite;
        this.decalTileTextureSources[tileIndex] = null; // Created on first update
        this.decalTileContainer.addChild(sprite);
      }
    }

    this._decalTileStamped = new Uint8Array(this.decalsTilesX * this.decalsTilesY);
    this._decalView.fill(-1);
    debugWorkerLog(`PIXI WORKER: Created ${this.decalsTotalTiles} decal tile sprites`);
  }

  /**
   * E-175: only the stamped decal tiles the camera's view covers are drawn (with a rotation, the view's bounding box).
   * The decal container is a render group, so a tile shown or hidden rebuilds its few instructions; a frame whose view
   * stays on the same tiles changes nothing.
   */
  _cullDecalTiles(zoom, cameraX, cameraY, rot) {
    const sprites = this.decalTileSprites;
    const tilesX = this.decalsTilesX | 0;
    const tilesY = this.decalsTilesY | 0;
    const size = this.decalsTileSize;
    if (tilesX <= 0 || tilesY <= 0 || !(size > 0) || sprites.length === 0) return;
    const z = zoom || 1;
    const w = (this.canvasWidth || 0) / z;
    const h = (this.canvasHeight || 0) / z;
    let x0 = cameraX;
    let y0 = cameraY;
    let x1 = cameraX + w;
    let y1 = cameraY + h;
    if (rot) {
      const cx = cameraX + w * 0.5;
      const cy = cameraY + h * 0.5;
      const c = Math.abs(Math.cos(rot));
      const s = Math.abs(Math.sin(rot));
      const hw = (w * c + h * s) * 0.5;
      const hh = (w * s + h * c) * 0.5;
      x0 = cx - hw;
      x1 = cx + hw;
      y0 = cy - hh;
      y1 = cy + hh;
    }
    const tx0 = Math.max(0, Math.min(tilesX - 1, Math.floor(x0 / size)));
    const tx1 = Math.max(0, Math.min(tilesX - 1, Math.floor(x1 / size)));
    const ty0 = Math.max(0, Math.min(tilesY - 1, Math.floor(y0 / size)));
    const ty1 = Math.max(0, Math.min(tilesY - 1, Math.floor(y1 / size)));
    const view = this._decalView;
    if (view[0] === tx0 && view[1] === ty0 && view[2] === tx1 && view[3] === ty1) return;
    const stamped = this._decalTileStamped;
    // The old range's tiles out, the new range's stamped tiles in.
    if (view[0] >= 0) {
      for (let ty = view[1]; ty <= view[3]; ty++) {
        for (let tx = view[0]; tx <= view[2]; tx++) {
          if (tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1) continue;
          const sprite = sprites[tx + ty * tilesX];
          if (sprite.visible) sprite.visible = false;
        }
      }
    }
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const i = tx + ty * tilesX;
        const show = stamped[i] === 1;
        if (sprites[i].visible !== show) sprites[i].visible = show;
      }
    }
    view[0] = tx0;
    view[1] = ty0;
    view[2] = tx1;
    view[3] = ty1;
  }

  /** E-175: whether decal tile `tileIndex` is in the camera's view (_cullDecalTiles' last range). */
  _decalTileInView(tileIndex) {
    const view = this._decalView;
    if (view[0] < 0) return false;
    const tilesX = this.decalsTilesX | 0;
    const tx = tileIndex % tilesX;
    const ty = (tileIndex - tx) / tilesX;
    return tx >= view[0] && tx <= view[2] && ty >= view[1] && ty <= view[3];
  }

  /**
   * Update decal tile textures for any dirty tiles
   * Called each frame to check for tiles modified by particle_worker
   * Copies the SAB into a reused buffer and uploads with texSubImage2D / writeTexture.
   * Bytes are premultiplied so they match ImageBitmap UNPACK_PREMULTIPLY.
   */
  updateDecalTiles() {
    if (!this.decalsEnabled) return;

    // Use pixel size for buffer operations (not world tile size)
    const tilePixelSize = this.decalsTilePixelSize;
    const bytesPerTile = tilePixelSize * tilePixelSize * 4;
    const totalTiles = this.decalsTotalTiles;
    if (totalTiles <= 0) return;

    const maxUploads = Math.min(this.maxDecalTileUploadsPerFrame || totalTiles, totalTiles);
    // E-272: the count with plain reads, four flags a word (carScene's 7 644 tiles: 55 us a frame with Atomics.load
    // per tile, 1.4 in words, Node). It only decides whether to scan and feeds a stat: a flag set while it reads is
    // seen next frame, which the claim below already allows for.
    const dirtyFlags = this.decalsTilesDirty;
    const dirtyWords = this._decalDirtyWords;
    const wordCount = dirtyWords.length;
    let dirtyN = 0;
    for (let k = 0; k < wordCount; k++) {
      const v = dirtyWords[k];
      if (v !== 0) {
        dirtyN += ((v & 0xff) !== 0 ? 1 : 0) + ((v & 0xff00) !== 0 ? 1 : 0) + ((v & 0xff0000) !== 0 ? 1 : 0) + (v >>> 24 !== 0 ? 1 : 0);
      }
    }
    for (let i = wordCount << 2; i < totalTiles; i++) {
      if (dirtyFlags[i] !== 0) dirtyN++;
    }
    this._decalTilesDirtyThisFrame = dirtyN;
    if (dirtyN === 0) {
      this._decalTilesUploadedThisFrame = 0;
      return;
    }

    let processed = 0;
    let scanned = 0;
    let tileIndex = this._nextDecalTileScanIndex % totalTiles;

    // B-03. This flag has two agents writing it from two workers: the stamp
    // side sets 1, this loop sets 0. Both transitions are atomic now, and the
    // claim is an exchange rather than a read-then-clear so the two cannot
    // interleave between the check and the clear. E-272: a plain read first, so a clean tile costs a load, not an
    // exchange (which takes the flag's line from the stamping worker every frame); a flag that turns 1 just after it
    // is read waits a frame, as one set after the exchange does.

    while (scanned < totalTiles && processed < maxUploads) {
      // Claim the tile. If a stamp lands after this exchange it re-sets the
      // flag and the tile is picked up next frame - that is the direction that
      // self-heals, so clearing here can never lose an update.
      if (dirtyFlags[tileIndex] === 0 || Atomics.exchange(dirtyFlags, tileIndex, 0) === 0) {
        tileIndex = (tileIndex + 1) % totalTiles;
        scanned++;
        continue;
      }

      let tileRGBA = this._decalCopyBuffers?.[tileIndex];
      if (!tileRGBA) {
        this._decalCopyBuffers ??= [];
        tileRGBA = new Uint8ClampedArray(bytesPerTile);
        this._decalCopyBuffers[tileIndex] = tileRGBA;
      }
      // The tile, premultiplied in the decal memory's scratch, into its own array for the upload.
      premultiplyDecalTile(this._decalPremultiply, tileIndex, tileRGBA);

      const sprite = this.decalTileSprites[tileIndex];
      let source = this.decalTileTextureSources[tileIndex];
      if (!source) {
        source = new PIXI.ImageSource({
          resource: tileRGBA,
          width: tilePixelSize,
          height: tilePixelSize,
          format: 'rgba8unorm',
          alphaMode: 'premultiplied-alpha',
          autoGenerateMipmaps: false,
        });
        source.uploadMethodId = this._useWebGpu ? 'external' : 'unknown';
        sprite.texture = new PIXI.Texture({ source });
        this.decalTileTextureSources[tileIndex] = source;
      }
      this._uploadDecalRgba8(source, tileRGBA, tilePixelSize, tilePixelSize);
      this._decalTileStamped[tileIndex] = 1;
      sprite.visible = this._decalTileInView(tileIndex);

      processed++;
      tileIndex = (tileIndex + 1) % totalTiles;
      scanned++;
    }

    this._nextDecalTileScanIndex = tileIndex;
    this._decalTilesUploadedThisFrame = processed;
  }

  _uploadDecalRgba8(source, data, width, height) {
    const renderer = this.pixiApp?.renderer;
    if (!renderer || !source || !data) return;
    if (this._useWebGpu) {
      writeRgba8(renderer, source, data, width, height, 'decal-tile');
      return;
    }
    const gl = renderer.gl;
    const texSys = renderer.texture;
    if (!gl || !texSys) return;
    if (!source._decalGlReady) {
      source.update();
      source._decalGlReady = true;
    }
    if (typeof texSys.bind === 'function') texSys.bind(source, 0);
    else if (typeof texSys.bindSource === 'function') texSys.bindSource(source, 0);
    const glSource = typeof texSys.getGlSource === 'function' ? texSys.getGlSource(source) : null;
    const target = glSource?.target || gl.TEXTURE_2D;
    // N-94: the active unit's binding goes back after the upload (see _uploadRgba32FloatGl).
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
    if (glSource?.texture) gl.bindTexture(target, glSource.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (gl.UNPACK_FLIP_Y_WEBGL != null) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    if (gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL != null) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    }
    gl.texSubImage2D(target, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindTexture(target, prev);
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
    this._lightDataLive = -1;
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
          value: new Float32Array([this.canvasWidth, this.canvasHeight]),
          type: 'vec2<f32>',
        },
        uFullCanvasSize: {
          value: new Float32Array([this.canvasWidth, this.canvasHeight]),
          type: 'vec2<f32>',
        },
        uCameraRot: { value: new Float32Array([1, 0]), type: 'vec2<f32>' },
        uInvResolution: { value: 1.0 / this.lightingResolution, type: 'f32' },
        uLightTexWidth: { value: maxLights, type: 'f32' },
        uLightCount: { value: 0, type: 'i32' },
        uBaseAmbient: { value: this.baseAmbient, type: 'f32' },
        uSunIntensity: { value: 0, type: 'f32' },
        uSunR: { value: 1.0, type: 'f32' },
        uSunG: { value: 1.0, type: 'f32' },
        uSunB: { value: 1.0, type: 'f32' },
        uFlipY: { value: 0, type: 'f32' },
        uShadowComposite: { value: 0, type: 'f32' },
        uGroundInvScaleY: { value: this._groundInvScaleY || 1, type: 'f32' },
        uNightR: { value: 0, type: 'f32' },
        uNightG: { value: 0, type: 'f32' },
        uNightB: { value: 0, type: 'f32' },
        // DX-SPOT: the first uConeCount lights are cones (their third row); the shader loops them apart. A float: on
        // WebGPU Pixi writes an i32 uniform with a float's bits (uLightCount survives that only by its loop's texW guard).
        uConeCount: { value: 0, type: 'f32' },
      },
      ...this._lightingShadowResources(),
    };

    const facesOn = this._facesOn;
    if (facesOn) {
      // DX-BARRIOS: no wrap or gain any more; the sun's direct share follows Sun.skyLight (_writeFaceSun, each frame).
      const faceLight = this._faceLight;
      // OL-4: 0 where the camera shows no height (straight down, or from the side): a pixel's height then moves it nowhere
      // on the screen. 1 only where the camera has not been read.
      faceLight[0] = this._heightScaleY >= 0 ? this._heightScaleY : 1;
      faceLight[1] = 0;
      faceLight[2] = 0;
      faceLight[3] = 1 - Sun.skyLight;
      lightingResources.uniforms.uFaceLight = { value: faceLight, type: 'vec4<f32>' };
      lightingResources.uniforms.uFaceSun = { value: this._faceSun, type: 'vec4<f32>' };
      // OL-6 (lighting.normalShading): what a sprite's own normals take from the sun and from each lamp, less the
      // amount subtracted, times the strength. After uFaceSun, as the WGSL's struct has it.
      const shading = normalShadingOf(this.config.lighting);
      const normalShade = this._normalShade;
      normalShade[0] = shading.sun.strength;
      normalShade[1] = shading.sun.subtract;
      normalShade[2] = shading.lamps.strength;
      normalShade[3] = shading.lamps.subtract;
      lightingResources.uniforms.uNormalShade = { value: normalShade, type: 'vec4<f32>' };
      lightingResources.uFaceMap = PIXI.Texture.EMPTY.source;
    }
    if (this._sunMapOn) {
      lightingResources.uniforms.uSunMapK = { value: this._sunMapK, type: 'vec4<f32>' };
      // N-317: right after uSunMapK, as the WGSL struct has it.
      lightingResources.uniforms.uSunMapRect = { value: this._sunMapRect, type: 'vec4<f32>' };
      lightingResources.uSunMap = PIXI.Texture.EMPTY.source;
    }
    if (this._selfShadowOn && facesOn) {
      // A step of 4 floor px, 6 steps, 3 px of bias (plus a quarter of the distance): src/shaders/lightingBasic.frag.glsl.
      lightingResources.uniforms.uSelfShadow = { value: new Float32Array([4, 6, 3, 0]), type: 'vec4<f32>' };
    }
    if (this._lampMapOn) {
      // DX-SHADOW3D (F7): the lamps' map and its layout (_ensureLampMap binds the atlas once it is made).
      lightingResources.uniforms.uLampAtlas = { value: this._lampAtlas, type: 'vec4<f32>' };
      lightingResources.uLampMap = this.lampMapRT ? this.lampMapRT.source : PIXI.Texture.EMPTY.source;
    }
    // DX-GBUF: the entity ids map, where the entities carry their words and something reads ids (self-shadow, a map).
    this._faceIdsOn = facesOn && !!this.entitiesBatch?.gbuf
      && (this._selfShadowOn || this._sunMapOn || this._lampMapOn || this._wallRowsOn);
    if (this._faceIdsOn) lightingResources.uFaceIds = PIXI.Texture.EMPTY.source;
    // OL-4: the walls' rows, where the pass knows whose each pixel is (a wall's own pixels stay lit beyond its edge).
    const wallsOn = this._wallRowsOn && this._faceIdsOn;
    if (wallsOn) lightingResources.uWallRows = this._wallRowsSource;
    else if (this._wallRowsOn && !this._wallRowsWarned) {
      this._wallRowsWarned = true;
      console.warn('WeedJS: lighting.walls is on but the entities carry no G-buffer words, so the walls stop no light');
    }
    if (this._lightTilesOn) {
      // E-205: the lights by tile (lightTiles.js), after every other uniform (the WGSL struct's order); updateLighting lays
      // the grid out at the pass's size and fills the texture before the pass draws.
      this._lightTiles.cam[TILE_CAM_SNAP] = this._pixelArtLight ? 0.5 : 0;
      this._lightTilesSource = PIXI.TextureSource.from({
        resource: new Uint32Array(1),
        width: 1,
        height: 1,
        format: 'r32uint',
        scaleMode: 'nearest',
        addressMode: 'clamp-to-edge',
        autoGenerateMipmaps: false,
        label: 'weed-light-tiles',
      });
      this._lightTilesSource.uploadMethodId = this._useWebGpu ? 'external' : 'unknown';
      const gl = this._useWebGpu ? null : this.pixiApp?.renderer?.gl;
      this._lightTilesUnit = gl ? gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) - 1 : 0;
      lightingResources.uLightTiles = this._lightTilesSource;
      lightingResources.uniforms.uTileGrid = { value: new Float32Array(4), type: 'vec4<f32>' };
      lightingResources.uniforms.uTileWords = { value: new Float32Array(4), type: 'vec4<f32>' };
    }
    if (wallsOn) {
      // OL-4: after every other uniform (the WGSL struct's order): how deep the light enters a wall (lighting.wallDepth)
      // and how much of a lamp's light a wall's shadow keeps (lighting.lightBehindWalls).
      const depth = Number(this.config?.lighting?.wallDepth);
      this._wallTerms[0] = depth > 0 && Number.isFinite(depth) ? depth : 0;
      this._wallTerms[1] = lightBehindWallsOf(this.config?.lighting);
      lightingResources.uniforms.uWalls = { value: this._wallTerms, type: 'vec4<f32>' };
    }
    // DX-LIGHTEDGES: the light at a share of the canvas over entities that write depth (pixel depth) is shown without
    // crossing the floor's edges; lighting.lightEdges false stretches it as a plain texture.
    this._lightEdgesOn = this.lightingResolution < 1 && !!this.entitiesBatch?.pixelDepthOn
      && this.config?.lighting?.lightEdges !== false;
    const lightingSrc = lightingSource(this._engineShaders?.lightingFrag || '', {
      faces: facesOn,
      sunMap: this._sunMapOn,
      selfShadow: this._selfShadowOn,
      lampMap: this._lampMapOn,
      ids: this._faceIdsOn,
      pixelArt: this._pixelArtLight,
      tiles: this._lightTilesOn,
      edges: this._lightEdgesOn,
      // N-277: half a step of noise on the light, against the 8-bit target's rings (off by default: on an Intel iGPU it
      // cost 4 % of the drawn frames).
      dither: this.config?.lighting?.dither === true,
      walls: wallsOn,
      shadowSamples: this._shadowSamples,
    }).replace(
      /MAX_LIGHTS/g,
      String(this.maxLights | 0 || 64)
    );
    if (this._useWebGpu) {
      if (!lightingSrc) {
        throw new Error('WeedJS: Failed to compile look shader "lighting_basic" for layer "LIGHTING" on WebGPU: lighting_basic.wgsl is missing.');
      }
      const makeProgram = (Gp) => lightingGpuProgram(
        Gp, lightingSrc, 'lighting-basic', facesOn, this._sunMapOn, this._lampMapOn, this._faceIdsOn, wallsOn,
      );
      // E-205: with the tiles, their texture at binding 8 of the pass's group.
      const gpuProgram = this._lightTilesOn ? lightTilesGpuProgram(GpuProgram, makeProgram) : makeProgram(GpuProgram);
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
        name: 'lighting-basic',
      });
      this.lightingShader = new PIXI.Shader({ glProgram, resources: lightingResources });
    }

    this.lightingMesh = new PIXI.Mesh({
      geometry,
      shader: this.lightingShader,
    });

    // DX-UNSHADED: where the entities carry their words, a sprite may be unshaded (its sheet or spriteRenderer.unshaded):
    // the G-buffer's passes leave unshaded pixels to the unshaded pass, and the unshaded layer reads the light's target.
    const unshadedShaders = this._useWebGpu ? !!this._engineShaders?.sprite : !!this._engineShaders?.spriteVert;
    this._unshadedOn = !!this.entitiesBatch?.gbuf && unshadedShaders;
    if (this.entitiesBatch) this.entitiesBatch.unshadedOn = this._unshadedOn;
    // Low-res lighting, liquid field splats, or particle lights need an RT target.
    const needRt = this.lightingResolution < 1.0 || this.liquidFunMaxCount > 0 || this._particleLightsEnabled || facesOn
      || this._unshadedOn;
    if (needRt) {
      const lw = rtPixelSize(this.canvasWidth, this.lightingResolution);
      const lh = rtPixelSize(this.canvasHeight, this.lightingResolution);
      this.lightingRT = PIXI.RenderTexture.create({ width: lw, height: lh });
      if (facesOn) this._createFaceMap(lw, lh);
      this.lightingDisplaySprite = new PIXI.Sprite(this.lightingRT);
      this.lightingDisplaySprite.anchor.set(0, 0); // Ensure top-left anchor
      this.lightingDisplaySprite.position.set(0, 0); // Position at top-left of screen
      this.lightingDisplaySprite.scale.set(this.canvasWidth / lw, this.canvasHeight / lh);
      if (this._lightEdgesOn) {
        this._createLightEdges();
      } else {
        this._registerLayerDisplayObject('lighting', this.lightingDisplaySprite);
        this.pixiApp.stage.addChild(this.lightingDisplaySprite);
      }
      this._applyLightingViewport(this.canvasWidth, this.canvasHeight);
      if (this._unshadedOn) this._createUnshadedLayer();

      debugWorkerLog(
        `PIXI WORKER: Lighting RenderTexture created (${this.lightingRT.width}x${this.lightingRT.height})`
      );
    } else {
      this._registerLayerDisplayObject('lighting', this.lightingMesh);
      this.pixiApp.stage.addChild(this.lightingMesh);
    }
  }

  /**
   * An additive light splat (LiquidFun lit groups, particle lights), or null
   * when the light-splat shaders are missing.
   */
  _createLightSplat(capacity, label) {
    const shaders = this._useWebGpu
      ? { lfSplat: this._engineShaders.lfLightSplat }
      : {
        lfSplatVert: this._engineShaders.lfLightSplatVert,
        lfSplatFrag: this._engineShaders.lfLightSplatFrag,
      };
    if (this._useWebGpu && !shaders.lfSplat) return null;
    if (!this._useWebGpu && (!shaders.lfSplatVert || !shaders.lfSplatFrag)) return null;
    const splat = new LiquidFunDensitySplat({
      capacity,
      label,
      blendMode: 'add',
      useWebGpu: this._useWebGpu,
      shaders,
      shaderResources: {
        uniforms: {
          uInvScreenScale: { value: 1.0, type: 'f32' },
          uGroundAxes: { value: new Float32Array([1, 0, 0, 1]), type: 'vec4<f32>' },
        },
      },
    });
    splat.mesh.blendMode = 'add';
    // DX-LIGHTEDGES: in RGB alone, so the light target's alpha keeps the light pass's floor mark.
    splat.lightHost = rgbOnlyHost(splat.mesh, this._useWebGpu);
    return splat;
  }

  /** Draw a packed light splat into the lighting RT. */
  _drawLightSplat(splat, resolution) {
    const screenScale = (this._renderZoom || 1) * (resolution || 1);
    const u = splat.shader?.resources?.uniforms?.uniforms;
    if (u) {
      u.uInvScreenScale = screenScale > 0 ? 1 / screenScale : 0;
      // The splat is packed on screen: world x is (cos, sin) there and world y (-sin, cos), y foreshortened.
      const axes = u.uGroundAxes;
      if (axes) {
        const rot = this._renderCameraRot || 0;
        const c = rot ? Math.cos(rot) : 1;
        const s = rot ? Math.sin(rot) : 0;
        const g = this._groundScaleY || 1;
        axes[0] = c;
        axes[1] = s;
        axes[2] = -s * g;
        axes[3] = c * g;
      }
    }
    const rtOpts = this._rtRenderOptsNoClear;
    rtOpts.container = splat.lightHost !== null ? splat.lightHost : splat.mesh;
    rtOpts.target = this.lightingRT;
    this._submitRender(rtOpts);
  }

  _createLiquidFunLightSplat(lfMax) {
    const cap = lfMax | 0;
    if (cap <= 0) return;
    this._lfLightSplat = this._createLightSplat(cap, 'lf-light-splat');
  }

  _createParticleLightSplat(maxLights) {
    const cap = maxLights | 0;
    if (cap <= 0 || !this._particleLightsEnabled) return;
    this._particleLightSplat = this._createLightSplat(cap, 'particle-light-splat');
  }

  _renderLiquidFunLightingField() {
    const splat = this._lfLightSplat;
    if (!splat || !this.lightingRT) return;
    const views = LiquidFun.getViews();
    const groups = LiquidFun.getGroupViews();
    const o = this._lfLightOpts;
    o.zoom = this._renderZoom;
    o.cameraX = this._renderCameraX;
    o.cameraY = this._renderCameraY;
    o.cameraRot = this._renderCameraRot || 0;
    o.resolution = this._lightingPixelScale || this.lightingResolution;
    o.canvasW = this.canvasWidth;
    o.canvasH = this.canvasHeight;
    const packed = splat.uploadLitGroups(views, groups, o);
    if (packed <= 0) return;
    this._drawLightSplat(splat, o.resolution);
  }

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

  _renderParticleLightingField() {
    const splat = this._particleLightSplat;
    if (!splat || !this.lightingRT) return;
    const active = this._takeActiveParticles();
    const lightSqrt = ParticleComponent.lightSqrt;
    if (!active || !(active[0] > 0) || !lightSqrt) return;
    const o = this._particleLightOpts;
    o.zoom = this._renderZoom;
    o.cameraX = this._renderCameraX;
    o.cameraY = this._renderCameraY;
    o.cameraRot = this._renderCameraRot || 0;
    o.resolution = this._lightingPixelScale || this.lightingResolution;
    o.canvasW = this.canvasWidth;
    o.canvasH = this.canvasHeight;
    const pcfg = this.config && this.config.particle;
    o.zenithalMaxHeight = resolveZenithalMaxHeight(pcfg);
    o.zenithalAlphaFade = pcfg && pcfg.zenithalAlphaFade > 0 ? pcfg.zenithalAlphaFade : 0;
    o.layerVisible = Layer._visible;
    o.layerAlpha = Layer._alpha;
    o.max = this._particleLightMax;
    const views = this._particleLightViews;
    views.active = active;
    views.lightSqrt = lightSqrt;
    views.x = ParticleComponent.x;
    views.y = ParticleComponent.y;
    views.z = ParticleComponent.z;
    views.alpha = ParticleComponent.alpha;
    views.tint = ParticleComponent.tint;
    views.flat = ParticleComponent.flat;
    views.viewMode = ParticleComponent.viewMode;
    views.renderOnly = ParticleComponent.renderOnly;
    views.layerMask = ParticleComponent.layerMask;
    const packed = packParticleLights(splat.data, splat.dataU32, splat.capacity, views, o);
    if (packed <= 0) {
      splat.geometry.instanceCount = 0;
      splat.mesh.visible = false;
      return;
    }
    splat.buffer.update(packed * LF_SPLAT_STRIDE);
    splat.geometry.instanceCount = packed;
    splat.mesh.visible = true;
    this._drawLightSplat(splat, o.resolution);
  }

  _stampLightCamera(uniforms, cameraX, cameraY, zoom) {
    uniforms.uCameraPos[0] = cameraX;
    uniforms.uCameraPos[1] = cameraY;
    uniforms.uZoom = zoom;
    const rc = uniforms.uCameraRot;
    if (!rc) return;
    const rot = this._renderCameraRot || 0;
    rc[0] = Math.cos(rot);
    rc[1] = Math.sin(rot);
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
    const lightRadius = LightEmitter.radius;
    const offsetX = LightEmitter.offsetX;
    const offsetY = LightEmitter.offsetY;
    const rotC = Transform.rotC;
    const rotS = Transform.rotS;

    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;

    // Viewport box for culling; a rotated camera grows it to cover the turned view
    const viewWidth = this.canvasWidth / zoom;
    const viewHeight = this.canvasHeight / zoom;
    const view = viewWorldBounds(
      zoom, cameraX, cameraY, this.canvasWidth, this.canvasHeight, this._renderCameraRot || 0, this._lightViewBounds
    );
    const viewLeft = view.minX;
    const viewTop = view.minY;
    const viewRight = view.maxX;
    const viewBottom = view.maxY;

    // Viewport center for sorting by distance (only needed if candidates exceed maxLights)
    const maxLights = this.maxLights | 0;
    const useSharedBuffer = !!this.visibleLightsData;
    const lightCount = useSharedBuffer ? this.visibleLightsData[0] : 0;
    const lightEntities = useSharedBuffer ? null : Query.queryActiveEntities(QUERY_LIGHT_EMITTER);
    const iterCount = useSharedBuffer ? lightCount : (lightEntities ? lightEntities.length : 0);

    const needDistSort = iterCount > maxLights;
    const viewCenterX = needDistSort ? cameraX + viewWidth * 0.5 : 0;
    const viewCenterY = needDistSort ? cameraY + viewHeight * 0.5 : 0;

    // Reset pool
    this._visibleLightsAllCount = 0;

    for (let idx = 0; idx < iterCount; idx++) {
      const i = useSharedBuffer ? this.visibleLightsData[1 + idx] : lightEntities[idx];
      if (!lightEnabled[i]) continue;
      if (!(lightRadius[i] > 0)) continue;

      // World-space light position from Transform SAB, same source as
      // updateLighting/updateShadowSprites use.
      const ox = offsetX[i];
      const oy = offsetY[i];
      const x = worldX[i] + ox * rotC[i] - oy * rotS[i];
      const yForLight = worldY[i] + ox * rotS[i] + oy * rotC[i];

      // Viewport culling by the light's reach
      const influenceRadius = lightRadius[i];

      if (
        x + influenceRadius < viewLeft ||
        x - influenceRadius > viewRight ||
        yForLight + influenceRadius < viewTop ||
        yForLight - influenceRadius > viewBottom
      ) {
        continue;
      }

      // Add to "all lights" pool (for shader uniforms)
      const allIdx = this._visibleLightsAllCount++;
      let entry = this._visibleLightsAll[allIdx];
      if (!entry) {
        entry = this._visibleLightsAll[allIdx] = { entityId: 0, distSq: 0 };
      }
      entry.entityId = i;
      if (needDistSort) {
        const dx = x - viewCenterX;
        const dy = yForLight - viewCenterY;
        entry.distSq = dx * dx + dy * dy;
      }
    }

    if (this._visibleLightsAllCount > maxLights) {
      sortPrefixByDistSq(this._visibleLightsAll, this._visibleLightsAllCount);
    }
  }

  /**
   * OL-4: the walls' rows pre-render published for this frame (lampWallRow.js: a row a lamp with walls in its reach) and
   * their texture. Rows a frame does not use are left as they were: no lamp's tag points at them.
   * @param {{ maxLights: number, maxPolygonVertices: number, rowsA: SharedArrayBuffer, rowsB: SharedArrayBuffer }} vp
   */
  _initWallRows(vp) {
    const layout = wallRowsLayout(vp.maxLights, vp.maxPolygonVertices);
    const sabs = [vp.rowsA, vp.rowsB];
    for (let b = 0; b < 2; b++) {
      this._wallRowBuffers[b] = {
        header: new Int32Array(sabs[b], 0, layout.headerInts),
        f32: new Float32Array(sabs[b], layout.rowsByte, layout.lights * layout.rowFloats),
        // OL-13: each row as views of 512, 1024, 2048 ... floats (a row's width at most), made the first time a row of
        // that length is read: a row is copied out with one set() of the shortest that holds it.
        views: [],
      };
    }
    this._wallSignatureAt = layout.signatureAt;
    this._wallSentLo = 0;
    this._wallSentHi = 0;
    this._wallRowFloats = layout.rowFloats;
    this._wallRowTexels = layout.rowTexels;
    this._wallRowsData = new Float32Array(layout.lights * layout.rowFloats);
    this._wallRowLamps = new Int32Array(layout.lights);
    this._wallRowLampCount = 0;
    this._wallRowsSource = PIXI.TextureSource.from({
      resource: this._wallRowsData,
      width: layout.rowTexels,
      height: layout.lights,
      format: 'rgba32float',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
      label: 'weed-wall-rows',
    });
    this._wallRowsSource.uploadMethodId = this._useWebGpu ? 'external' : 'unknown';
    this._wallRowsOn = true;
  }

  /**
   * OL-4: this frame's rows: which lamp has which (for _packLightData's tags), and the rows in use copied and sent up.
   */
  _readWallRows() {
    const syncFrame = this.renderQueueSync ? Atomics.load(this.renderQueueSync, 0) : 0;
    const buf = this._wallRowBuffers[syncFrame > 0 ? (syncFrame - 1) & 1 : 0];
    if (buf === null) return;
    const entities = Transform.x ? Transform.x.length : 0;
    // OL-10: pre-render signs a frame's rows (its lamps in order, each row's inputs). The same signature as the rows
    // last sent up: the same lamps hold the same rows, the texture has them and the lamps' tags stand. A second word
    // of 0 is no signature (a lamp moved, or lighting.wallCache is off).
    const sigLo = buf.header[this._wallSignatureAt];
    const sigHi = buf.header[this._wallSignatureAt + 1];
    if (sigHi !== 0 && sigLo === this._wallSentLo && sigHi === this._wallSentHi && this._wallRowOf.length === entities) {
      this._wallRowsSkipped++;
      return;
    }
    this._wallSentLo = sigLo;
    this._wallSentHi = sigHi;
    if (this._wallRowOf.length !== entities) this._wallRowOf = new Int16Array(entities);
    const rowOf = this._wallRowOf;
    const lamps = this._wallRowLamps;
    for (let i = 0; i < this._wallRowLampCount; i++) {
      const lamp = lamps[i];
      if (lamp >= 0 && lamp < entities) rowOf[lamp] = 0;
    }
    const header = buf.header;
    let count = header[0];
    if (count > lamps.length) count = lamps.length;
    if (count < 0) count = 0;
    const rowFloats = this._wallRowFloats;
    const src = buf.f32;
    const dst = this._wallRowsData;
    const views = buf.views || (buf.views = []);
    // The widest row in use, in texels: the upload sends that many columns of each row, not the row's whole width (a
    // row is as wide as lighting.maxPolygonVertices allows, a polygon usually a tenth of it).
    let usedTexels = 1;
    for (let r = 0; r < count; r++) {
      const lamp = header[1 + r];
      lamps[r] = lamp;
      if (lamp >= 0 && lamp < entities) rowOf[lamp] = r + 1;
      // The row's floats in use: its header, its directions and its vertices with the closing one.
      const o = r * rowFloats;
      const n = src[o] | 0;
      const used = n >= 3 ? 4 * (WALL_VERT0 + n + 1) : 4;
      // OL-13: one set() from a view of the row, the shortest of 512, 1024 ... floats that holds what is in use (a
      // float at a time it was 0.5 ms a frame for 720 rows, the lamps moving).
      let c = 0;
      let len = 512;
      while (len < used) {
        len *= 2;
        c++;
      }
      if (len > rowFloats) len = rowFloats;
      let ofLength = views[c];
      if (ofLength === undefined) ofLength = views[c] = [];
      let view = ofLength[r];
      if (view === undefined) view = ofLength[r] = new Float32Array(src.buffer, src.byteOffset + o * 4, len);
      dst.set(view, o);
      if (used > 4 * usedTexels) usedTexels = used >> 2;
    }
    this._wallRowLampCount = count;
    if (count === 0) return;
    const source = this._wallRowsSource;
    const width = this._wallRowTexels;
    const height = lamps.length;
    if (this._useWebGpu) {
      const renderer = this.pixiApp?.renderer;
      if (renderer?.gpu?.device) writeRgba32Float(renderer, source, dst, width, height, 'weed-wall-rows', usedTexels, count);
    } else {
      this._uploadRgba32FloatGl(source, dst, width, height, usedTexels, count);
    }
  }

  /**
   * Pack path mutates _lightDataFloats in place. Pin RGBA32F GPUTexture (no RENDER_ATTACHMENT).
   */
  _uploadLightDataTexture(columns = this.maxLights) {
    const source = this._lightDataSource;
    const data = this._lightDataFloats;
    if (!source || !data) return false;
    if (this._useWebGpu) {
      const renderer = this.pixiApp?.renderer;
      if (!renderer?.gpu?.device) return false;
      writeRgba32Float(
        renderer,
        source,
        data,
        this.maxLights,
        LIGHT_DATA_TEX_HEIGHT,
        'weed-light-data',
        columns,
      );
      return true;
    }
    this._uploadRgba32FloatGl(source, data, this.maxLights, LIGHT_DATA_TEX_HEIGHT, columns);
    return true;
  }

  /* =====================
UPDATE LIGHTING (NO ZOOM SCALING)
===================== */

  /**
   * E-311. updateLighting's per-light pack: each visible light's texels (packLightDataTexel's layout, E-109), the cone
   * lights first. In its own method because inside updateLighting (1 395 bytecode bytes, 21 functions inlined)
   * TurboFan left a double boxed per light per frame (Predator crowd 1.5: 54.5 KB/s, a sixth of Pixi's allocation);
   * compiled alone the loop allocates nothing.
   */
  _packLightData(countToRender, visibleLights, coneCosSeen, coneCount, lightData, row1, row2, groundInvY, vr) {
    // DX-SHADOW3D (F7): a lamp with a tile in the lamps' map: its first row's w carries -(tile + 1).
    const tileOf = this._lampTileOf;
    // N-212: and its fourth row's x its map shadow's fade at the cut (1 for any other light).
    const fadeOf = this._lampFadeOf;
    const row3 = row2 + row2 - row1;
    const ids = this._faceIdsOn;
    // OL-4: each lamp's row of the walls' texture, + 1 (0: nothing stops it), in its fourth row's z.
    const wallRowOf = this._wallRowOf;
    const worldX = Transform.x;
    const worldY = Transform.y;
    const lightColor = LightEmitter.color;
    const lightRadius = LightEmitter.radius;
    const lightBrightness = LightEmitter.brightness;
    const lightElevation = LightEmitter.elevation;
    const offsetX = LightEmitter.offsetX;
    const offsetY = LightEmitter.offsetY;
    const rotC = Transform.rotC;
    const rotS = Transform.rotS;
    const lightConeInvSpan = LightEmitter.coneInvSpan;
    const lightDirC = LightEmitter.dirC;
    const lightDirS = LightEmitter.dirS;
    // E-510: how far each light's shadows reach (0: its radius).
    const lightShadowRange = LightEmitter.shadowRange;
    let coneSlot = 0;
    let pointSlot = coneCount;
    for (let i = 0; i < countToRender; i++) {
      const entityIndex = visibleLights[i].entityId;
      const color = lightColor[entityIndex];
      const range = vr ? (vr[entityIndex] || 0) : 0;
      const coneCos = coneCosSeen[i];
      const isCone = coneCos > -1;
      const slot = isCone ? coneSlot++ : pointSlot++;

      // A source h above the floor: I / (I + h² + d²) = k * I' / (I' + d²) with I' = I + h², k = I / I'.
      // So the shader keeps one formula: it gets I' and the colour scaled by k (and by the brightness).
      // I = (radius / 10)², divided so a whole radius gives I exactly.
      const rad = lightRadius[entityIndex];
      let intensity = (rad * rad) / 100;
      let colorScale = lightBrightness[entityIndex];
      const h = lightElevation[entityIndex];
      if (h > 0) {
        const raised = intensity + h * h;
        colorScale = (intensity / raised) * colorScale;
        intensity = raised;
      }

      // packLightDataTexel's layout, written here (E-109): where TurboFan left that call out, each of its seven
      // doubles was a heap number per light per frame. World coordinates (the shader converts screen to world),
      // the light raised by its height, y in floor units (times 1 / groundScaleY).
      const i0 = slot * 4;
      const ox = offsetX[entityIndex];
      const oy = offsetY[entityIndex];
      lightData[i0] = worldX[entityIndex] + ox * rotC[entityIndex] - oy * rotS[entityIndex];
      lightData[i0 + 1] = (worldY[entityIndex] + ox * rotS[entityIndex] + oy * rotC[entityIndex]) * groundInvY;
      lightData[i0 + 2] = intensity;
      lightData[i0 + 3] = range * range;
      const i3 = row3 + i0;
      lightData[i3] = 1;
      lightData[i3 + 1] = 0;
      lightData[i3 + 2] = entityIndex < wallRowOf.length ? wallRowOf[entityIndex] : 0;
      lightData[i3 + 3] = 0;
      if (entityIndex < tileOf.length) {
        const tile = tileOf[entityIndex];
        if (tile >= 0 && h > 0) {
          lightData[i0 + 3] = -(tile + 1);
          // DX-GBUF: with the ids map, its entity's id in the fourth row's w, so a pixel of its own entity does not shade
          // from it (lightingBasic lampOwner). N-189: it rode in the tag, -(tile + 1 + 256 · id), which held 256 tiles.
          if (ids) lightData[i3 + 3] = gbufEntityId(entityIndex);
          if (entityIndex < fadeOf.length) lightData[i3] = fadeOf[entityIndex];
          // E-510: how far its shadows reach, where its shadowRange is under its radius (its tile spans that).
          const shadowRange = lightShadowRange[entityIndex];
          if (shadowRange > 0 && shadowRange < rad) lightData[i3 + 1] = shadowRange;
        }
      }
      const i1 = row1 + i0;
      lightData[i1] = (((color >> 16) & 0xff) / 255) * colorScale;
      lightData[i1 + 1] = (((color >> 8) & 0xff) / 255) * colorScale;
      lightData[i1 + 2] = ((color & 0xff) / 255) * colorScale;
      lightData[i1 + 3] = h; // DX-FACES: a face needs the source's height itself
      if (isCone) {
        // The cone's direction: the entity's facing turns the light's own (dirC, dirS); on the floor, y over
        // groundScaleY, unit length. Then the cosine of the half aperture and 1 / the soft edge's width.
        const dc = lightDirC[entityIndex];
        const ds = lightDirS[entityIndex];
        const rc = rotC[entityIndex];
        const rs = rotS[entityIndex];
        const wx = rc * dc - rs * ds;
        const wy = (rs * dc + rc * ds) * groundInvY;
        const len = Math.sqrt(wx * wx + wy * wy);
        const i2 = row2 + i0;
        lightData[i2] = len > 0 ? wx / len : 1;
        lightData[i2 + 1] = len > 0 ? wy / len : 0;
        lightData[i2 + 2] = coneCos;
        lightData[i2 + 3] = lightConeInvSpan[entityIndex];
      }
    }

  }

  /**
   * E-205: the packed lights binned into the light pass's tiles (lightTiles.js) for the camera, viewport and floor scale the
   * pass reads this frame (its uniforms, float32 as the GPU gets them), the bands in use sent up and the grid's uniforms
   * written. The grid follows the pass's size (a resize lays it out again and makes the texture anew).
   */
  _updateLightTiles(u, count) {
    const t = this._lightTiles;
    const rowAlign = this._useWebGpu ? 64 : 1;
    const tile = this._lightCullingTileSize;
    if (layoutLightTiles(t, u.uViewport[0] | 0, u.uViewport[1] | 0, this.maxLights | 0, rowAlign, tile)) {
      this._lightTilesMade = false;
    }
    const cam = t.cam;
    cam[TILE_CAM_ZOOM] = Math.fround(u.uZoom);
    cam[TILE_CAM_X] = u.uCameraPos[0];
    cam[TILE_CAM_Y] = u.uCameraPos[1];
    cam[TILE_CAM_COS] = u.uCameraRot[0];
    cam[TILE_CAM_SIN] = u.uCameraRot[1];
    cam[TILE_CAM_FULL_W] = u.uFullCanvasSize[0];
    cam[TILE_CAM_FULL_H] = u.uFullCanvasSize[1];
    cam[TILE_CAM_GROUND_INV_Y] = Math.fround(u.uGroundInvScaleY);
    binLightTiles(t, this._lightDataFloats, this.maxLights | 0, count);
    const renderer = this.pixiApp?.renderer;
    if (this._useWebGpu) {
      uploadLightTilesGpu(renderer, this._lightTilesSource, t, pinGpuTexture);
    } else {
      if (uploadLightTilesGl(renderer, this._lightTilesSource, t, this._lightTilesUnit, !this._lightTilesMade)) {
        this._lightTilesMade = true;
      }
    }
    writeLightTileUniforms(t, u.uTileGrid, u.uTileWords);
  }

  /**
   * E-311. updateLighting's sun and night uniforms. In its own method for the reason _packLightData is: inside
   * updateLighting TurboFan boxed more of these doubles (12 KB/s with the pack already out, about 3 alone).
   */
  _writeSunUniforms(uniforms, rgb) {
    if (Sun.isInitialized && Sun.enabled) {
      const sunIntensity = Sun.intensity;
      const sunColor = Sun.color;

      uniforms.uSunIntensity = sunIntensity;

      // Extract sun color RGB
      extractRGBNormalizedMut(sunColor, rgb);
      if (this.faceRT !== null) this._writeFaceSun();
      uniforms.uSunR = rgb.r;
      uniforms.uSunG = rgb.g;
      uniforms.uSunB = rgb.b;

      // Night light: its own term, so Sun.intensity (shadows, game logic) never hears of it
      const night = this._nightRGB;
      Sun.nightLightRGB(night);
      uniforms.uNightR = night[0];
      uniforms.uNightG = night[1];
      uniforms.uNightB = night[2];
    } else {
      // Sun disabled - no sun contribution
      uniforms.uSunIntensity = 0;
      uniforms.uNightR = 0;
      uniforms.uNightG = 0;
      uniforms.uNightB = 0;
    }

  }

  updateLighting() {
    if (!this.lightingEnabled || !this.lightingShader) return;
    // DX-SHADOW3D (F7): which lamps have a tile in the lamps' map this frame, before their texels are packed.
    if (this._lampMapOn) this.shadowMaps.readLampTiles();

    const uniformGroup = this.lightingShader.resources.uniforms;

    // The floor's foreshortening: the shader scales the fragment's world y by this once, the lights' y here.
    const groundInvY = this._groundInvScaleY || 1;

    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;

    // Update camera uniforms (vec2 types)
    this._stampLightCamera(uniformGroup.uniforms, cameraX, cameraY, zoom);
    this._applyLightingViewport(this.canvasWidth, this.canvasHeight);

    const lightData = this._lightDataFloats;
    const maxLights = this.maxLights;

    // Use pre-computed visible lights (computed in computeVisibleLights())
    const visibleLights = this._visibleLightsAll;
    const countToRender = Math.min(this._visibleLightsAllCount, maxLights);

    const rgb = this._rgbResult; // the sun's colour, once a frame
    const vr = Collider.visualRange;
    const row1 = maxLights * 4;
    const row2 = maxLights * 8;
    // DX-SPOT: the cone lights take the first slots, so the shader loops them apart and a point light pays nothing; with
    // no cone in view the slots are the visible order, as before.
    const lightConeCos = LightEmitter.coneCos;
    // Each light's coneCos, read once: the count and the slots must agree, or a light the logic worker turns into a cone
    // in between takes a slot twice and leaves one with last frame's light.
    if (this._lightConeCosSeen.length < countToRender) this._lightConeCosSeen = new Float32Array(Math.max(countToRender, maxLights | 0));
    const coneCosSeen = this._lightConeCosSeen;
    let coneCount = 0;
    for (let i = 0; i < countToRender; i++) {
      const seen = lightConeCos[visibleLights[i].entityId];
      coneCosSeen[i] = seen;
      if (seen > -1) coneCount++;
    }
    // OL-4: which lamp has which row of the walls' texture this frame, before the pack tags them.
    if (this._wallRowsOn) this._readWallRows();
    // E-311: the per-light pack in its own method (see _packLightData).
    this._packLightData(countToRender, visibleLights, coneCosSeen, coneCount, lightData, row1, row2, groundInvY, vr);

    // E-511: the columns that changed since the last upload, the lights now and last frame's (now cleared); the whole
    // texture after it is made (_lightDataLive -1). The barrio uploaded its 1024 columns (64 KB) a frame for a few dozen.
    const lastLive = this._lightDataLive;
    const columns = lastLive < 0 || lastLive > maxLights ? maxLights : Math.max(countToRender, lastLive);
    clearUnusedLightDataTexels(lightData, maxLights, countToRender, columns);

    if (this._lightDataSource && this._uploadLightDataTexture(columns)) {
      this._lightDataLive = countToRender;
    }

    // Update light count uniform
    uniformGroup.uniforms.uLightCount = countToRender;
    uniformGroup.uniforms.uConeCount = coneCount;

    // E-205: the frame's lights by tile, for the camera stamped above.
    if (this._lightTilesSource !== null) this._updateLightTiles(uniformGroup.uniforms, countToRender);

    // ========================================
    // SUN UNIFORMS
    // ========================================
    // Sun provides global ambient light that varies with time of day
    // E-311: in its own method, as the per-light pack.
    this._writeSunUniforms(uniformGroup.uniforms, rgb);

    if (typeof uniformGroup.update === 'function') uniformGroup.update();
  }

  _syncUniformGroup(group) {
    if (group && typeof group.update === 'function') group.update();
  }

  /**
   * E-191 step 2: `mesh` over this frame's `count` keyed caster rows of `floats` floats from `src` (committed to the caster
   * batch), or null: none, or no such pass (a frame of keyed rows Pixi cannot draw is left out, and that said once).
   */
  _keyedRowsMesh(mesh, src, count, floats) {
    if (mesh === null) {
      if (!this._keyedRowsRefusedWarned) {
        this._keyedRowsRefusedWarned = true;
        console.error('PIXI WORKER: keyed caster rows without their shadow passes: those shadows are not drawn');
      }
      return null;
    }
    const geometry = this.gpuCasterBatch.commitKeyedCasterRows(src, count, floats);
    if (geometry === null) return null;
    mesh.geometry = geometry;
    return mesh;
  }

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

  _lightingShadowSource() {
    return this.shadowRT?.source || PIXI.Texture.EMPTY.source;
  }

  /** DX-FACES: towards the sun in the floor's space, from the shadows' direction on the screen and its elevation. */
  _writeFaceSun() {
    const a = (Sun.elevation * Math.PI) / 180;
    const sinE = Math.sin(a);
    const cosE = Math.cos(a);
    const dirX = Sun.shadowDirX;
    const dirY = Sun.shadowDirY / (this._groundScaleY || 1);
    const len = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
    const sun = this._faceSun;
    sun[0] = (-dirX / len) * cosE;
    sun[1] = (-dirY / len) * cosE;
    sun[2] = sinE;
    sun[3] = 1 / (sinE > 0.25 ? sinE : 0.25);
    // DX-BARRIOS: the sun's share that follows where a face looks; the rest is its sky (Sun.skyLight), on every face.
    this._faceLight[3] = 1 - Sun.skyLight;
  }

  _lightingShadowResources() {
    const src = this._lightingShadowSource();
    return { uShadowMap: src, uShadowSampler: src.style };
  }

  _unbindLightingShadowMap() {
    const res = this.lightingShader?.resources;
    if (!res) return;
    const empty = PIXI.Texture.EMPTY.source;
    res.uShadowMap = empty;
    res.uShadowSampler = empty.style;
  }

  _bindLightingShadowMap() {
    const res = this.lightingShader?.resources;
    if (!res) return;
    const src = this._lightingShadowSource();
    res.uShadowMap = src;
    res.uShadowSampler = src.style;
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
   * uViewport is the real framebuffer (gl_FragCoord). Display scale is canvas/RT
   * so a nominal 0.5 and 0.25 still land on the same screen pixel.
   */
  _applyLightingViewport(canvasW, canvasH) {
    const u = this.lightingShader && this.lightingShader.resources.uniforms.uniforms;
    const rt = this.lightingRT;
    const vw = rt ? rt.width : canvasW;
    const vh = rt ? rt.height : canvasH;
    this._lightingPixelScale = rtPixelScale(canvasW, vw);
    if (!u) return;
    u.uViewport[0] = vw;
    u.uViewport[1] = vh;
    u.uFullCanvasSize[0] = canvasW;
    u.uFullCanvasSize[1] = canvasH;
    u.uInvResolution = canvasW > 0 && vw > 0 ? canvasW / vw : 1;
    // Canvas WebGL: gl_FragCoord.y is the bottom. Pixi entities are top-left.
    // An RT sprite samples the texture flipped, so that path stays unflipped.
    u.uFlipY = !rt && !this._useWebGpu ? 1 : 0;
  }

  _shadowPixelScale() {
    const rt = this.shadowRT;
    return rtPixelScale(this.canvasWidth, rt ? rt.width : rtPixelSize(this.canvasWidth, this.shadowResolution));
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
      // Cookie RT is empty while shadowSpritesEnabled is false; multiply would crush the frame.
      const show =
        on &&
        (name !== 'lightGlows' || this._lightGlowAdd) &&
        (name !== 'castedShadows' || this.shadowSpritesEnabled);
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
    if (this.lightingRT) {
      const lw = rtPixelSize(width, this.lightingResolution);
      const lh = rtPixelSize(height, this.lightingResolution);
      if (this.faceRT !== null) {
        this._releaseGbufTarget();
        this.lightingShader.resources.uFaceMap = PIXI.Texture.EMPTY.source;
        this.faceRT.destroy(true);
        if (this.faceIdsRT !== null) {
          this.lightingShader.resources.uFaceIds = PIXI.Texture.EMPTY.source;
          this.faceIdsRT.destroy(true);
          this.faceIdsRT = null;
        }
        this._createFaceMap(lw, lh);
      }
      this._unbindUnshadedLayer();
      if (this._lightEdges !== null) {
        // DX-LIGHTEDGES: off the old target before _replaceRT destroys its bind groups; the canvas quad at the new size.
        this._bindLightEdges(PIXI.Texture.EMPTY.source, PIXI.Texture.EMPTY.source);
        unshadedQuadPositions(this._lightEdgesQuad, width, height);
        if (this._lightEdgesQuadBuffer !== null) this._lightEdgesQuadBuffer.update();
      }
      this.lightingRT = this._replaceRT(
        this.lightingRT,
        lw,
        lh,
        this.lightingDisplaySprite,
        null
      );
      if (this._lightEdges !== null && this._unshadedEdges === null) this._bindLightEdges(this.lightingRT.source, PIXI.Texture.EMPTY.source);
      if (this.lightingDisplaySprite) {
        this.lightingDisplaySprite.scale.set(width / lw, height / lh);
      }
      if (this.unshadedRT !== null) {
        this.unshadedRT.destroy(true);
        this.unshadedRT = PIXI.RenderTexture.create({ width, height });
        unshadedQuadPositions(this._unshadedQuad, width, height);
        if (this._unshadedQuadBuffer !== null) this._unshadedQuadBuffer.update();
      }
      this._bindUnshadedLayer();
    }

    // Sync lighting shader uniforms immediately
    if (this.lightingShader) this._applyLightingViewport(width, height);

    if (this.shadowRT) {
      const sw = rtPixelSize(width, this.shadowResolution);
      const sh = rtPixelSize(height, this.shadowResolution);
      this._unbindLightingShadowMap();
      this.shadowRT = this._replaceRT(
        this.shadowRT,
        sw,
        sh,
        this.shadowDisplaySprite,
        null
      );
      if (this.shadowDisplaySprite) this.shadowDisplaySprite.scale.set(width / sw, height / sh);
      this._bindLightingShadowMap();
      // N-317: made again, its margins too, on the next sun map pass (_fitSunMap).
      if (this.sunMapRT) {
        this._sunMapMargins.fill(0);
        this.shadowMaps.createSunMap(sw, sh);
      }
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
    this.autoGenerateMipmaps =
      rendererConfig.autoGenerateMipmaps !== undefined
        ? !!rendererConfig.autoGenerateMipmaps
        : RENDERER_DEFAULTS.autoGenerateMipmaps;

    const shadersFetched = this._fetchEngineShaders().then(() => loadMark('shaders fetched'));
    await Promise.all([shadersFetched, this._initPixiApp(config, backend)]);

    // N-271: a nearest atlas snaps each sprite to the pixel grid in its vertex shader (pixelSnap.js), before any sprite
    // program is made from these sources; the packs leave the poses as they are. N-302: an axis-aligned sprite's corners
    // (renderer.pixelSnapCorners, default) or its origin.
    if (this.atlasScaleMode === 'nearest') applyPixelSnap(this._engineShaders, this._useWebGpu, this.pixelSnapCorners);
    this.scenery.initTilemapGidProgram();
    // E-475: what boot made links on the driver's threads while the page loads the assets; initialize waits for it.
    this._startLinksAhead();
    loadMark('booted');
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
      const maps = this.assets.atlasMapsSource ?? this._emptyMapsSource();
      const heightScaleY = this._heightScaleY;
      const groundScaleY = this._groundScaleY || 1;
      if (this.faceRT !== null) {
        const mrt = this._gbufMrt && this.faceIdsRT !== null ? this._ensureGbufTarget() : null;
        if (mrt !== null) {
          batch.gbufMesh(heightScaleY, groundScaleY, maps);
        } else {
          batch.faceMesh(heightScaleY, groundScaleY, maps);
          if (this.faceIdsRT !== null) batch.idsMesh(heightScaleY, groundScaleY, maps);
        }
      }
      // Drawn while a sheet or a sprite is unshaded: a sprite can turn so while the game runs.
      if (this._unshadedComposite !== null && this.unshadedRT !== null) batch.unshadedPass(heightScaleY, groundScaleY, maps);
    }
    const casters = this.gpuCasterBatch;
    if (casters && shaders.shadowVert && shaders.sunMapFrag) {
      // DX-SHADOW3D: the sun's map (_drawSunMap), else a scene with height maps casts its solids (_drawSunSolids).
      if (this._sunMapOn) {
        this.shadowMaps.sunShadowProgram('map');
        this.shadowMaps.sunShadowProgram('mapColumns');
      } else if (this.shadowMaps.sunSolidsOn()) {
        this.shadowMaps.sunShadowProgram('cards');
        this.shadowMaps.sunShadowProgram('columns');
      }
      // DX-SHADOW3D (F7): the lamps' map's cards and columns (_drawLampMap).
      if (this._lampMapOn) {
        this.shadowMaps.lampMapProgram(false);
        this.shadowMaps.lampMapProgram(true);
      }
      // E-191: the sun pass over the entities' keyed instances (_keyedSunFor) and over pre-render's keyed caster rows
      // (_ensureKeyedCasters), where those can run.
      if (batch !== null && batch.keyed) {
        const keyedSun = this.config?.lighting?.keyedCasters !== false && this.config?.lighting?.directionalCasters !== true;
        const keyedRows = !(this._sunMapOn || this._lampMapOn || this.shadowMaps.sunSolidsOn());
        batch.makeKeyedShadowPrograms(keyedSun, keyedRows);
      }
    }
    // E-453: a MESH layer's UV meshes (_ensureMeshUvBatch: one program for every layer's batch, the first layer's name);
    // DX-SHADOW3D: a sun-projected layer's volumes in the sun's map and the lamps' (_drawVolumesInSunMap,
    // _drawVolumesInLampMap), E-508: the lamps' cache's copy.
    const uvLayers = this.customLayers.list.filter((cl) => (cl.uvVertCapacity | 0) > 0 && (cl.uvIndexCapacity | 0) >= 3);
    if (uvLayers.length > 0 && shaders.meshUvFillVert && shaders.meshUvFillFrag) {
      meshUvFillProgram(false, shaders, `mesh-uv-${uvLayers[0].layerId}`);
      if (casters && uvLayers.some((cl) => cl.sunProjected)) {
        if (this._sunMapOn) this.shadowMaps.sunMapVolumeProgram();
        if (this._lampMapOn) {
          this.shadowMaps.makeVolumeLampPrograms();
          if (this._lampCacheOn) this.shadowMaps.lampCacheCopyProgram();
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
    if (this.lightingMesh && this.lightingRT) {
      ahead(this.lightingMesh, this.lightingMesh.shader, this.lightingMesh.geometry, this.lightingRT, 'normal');
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
   * N-303 CR-14: the pose and additive variants are made from their base as it arrives (shaderVariants.js).
   */
  _fetchEngineShaders() {
    this._engineShaders = {};
    const sh = this._engineShaders;
    const shaderFetches = [];
    if (this._useWebGpu) {
      shaderFetches.push(
        fetchEngineShader('/src/shaders/instancedSprite.wgsl').then((s) => {
          sh.sprite = s;
          sh.spritePose = spritePoseWgsl(s);
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
        })
      );
    } else {
      shaderFetches.push(
        fetchEngineShader('/src/shaders/instancedSprite.vert.glsl').then((s) => {
          sh.spriteVert = s;
          sh.spriteVertPose = spritePoseGlsl(s);
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
    this._queueInterp = rendererConfig.interpolation === true;
    this._keyedPosesByRow = (rendererConfig.keyedPosesByRow ?? RENDERER_DEFAULTS.keyedPosesByRow) === true;

    this._ySortMode = rendererConfig.ySort;
    this._ySort = ySortEnabled(this._ySortMode);
    const preCfg = this.config.preRender || {};
    this._queueBackpressure = preCfg.backpressure !== false;
    this._queueWait = rendererConfig.waitForQueue !== false && !this._queueInterp;
    const spritePipe = resolveSpritePipeline({
      ySort: this._ySortMode,
      packGpuSprites: preCfg.packGpuSprites,
      sortSprites: preCfg.sortSprites,
      rendererInterpolation: this._queueInterp,
    });
    this._packGpuSpritesOn = spritePipe.packGpuSprites;
    this._sortSpritesOn = spritePipe.sortSprites;
    // The halos added over everything ('add', the default) or sorted among the entities ('sorted'). OL-1: any other value
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

      // Create sprites for each tile
      this.createDecalTileSprites();

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
      this.visibleLightsData = data.buffers.visibleLightsData
        ? new Uint16Array(data.buffers.visibleLightsData)
        : null;
      this.lightingResolution = lightingConfig.resolution || 1.0;
      // DX-BARRIOS: a px of height rises the camera's heightScaleY; faces have no switch: the light pass reads the face map
      // with maps or a shadow map (below), or once a decoration carries a normal (_useFaces).
      this._heightScaleY = cameraHeightScaleY(this.config);
      this._facesWatch = true;
      this._facesOn = DecorationPool.facesInUse();
      // DX-SHADOW3D: the sun's shadows on the shadows' layer ('layer', the default) or from a shadow map, the sun's term
      // alone (WebGL and WebGPU). OL-1: any other value (the old 'sprite' among them) warns and draws on the layer.
      const sunShadows = lightingConfig.sunShadows ?? LIGHTING_DEFAULTS.sunShadows;
      if (sunShadows !== 'layer' && sunShadows !== 'map') {
        console.warn(`WeedJS: lighting.sunShadows is 'layer' or 'map', not ${JSON.stringify(sunShadows)}: the sun's shadows are drawn on the layer`);
      }
      if (sunShadows === 'map') this._sunMapOn = true;
      // DX-SELFSHADOW: faces and sprites with maps shade themselves from the sun (screen-space steps over the face map).
      if (lightingConfig.selfShadow === true) this._selfShadowOn = true;
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
      // E-205: the light pass loops over the lights of each pixel's screen tile: the same picture, faster at every light
      // count gpuPassBench measured (4 to 128). The shader keeps the loop over every light for when this is false.
      this._lightTilesOn = true;
      // DX-GBUF (plan §6.4): the G-buffer's targets in one pass (MRT, the default: E-377) or a pass each.
      const gbufMode = lightingConfig.gbuffer ?? 'mrt';
      if (gbufMode !== 'pass' && gbufMode !== 'mrt') {
        console.warn(`WeedJS: lighting.gbuffer is 'pass' or 'mrt', not ${JSON.stringify(gbufMode)}: the G-buffer draws a pass a target`);
      }
      this._gbufMrt = gbufMode === 'mrt';
      // DX-SHADOW3D (F7): the lamps' shadows stamped on the shadows' layer ('layer', the default) or from a map a lamp, each
      // lamp's own light alone (WebGL and WebGPU). OL-1: any other value warns and stamps on the layer.
      const lampShadows = lightingConfig.lampShadows ?? LIGHTING_DEFAULTS.lampShadows;
      if (lampShadows !== 'layer' && lampShadows !== 'map') {
        console.warn(`WeedJS: lighting.lampShadows is 'layer' or 'map', not ${JSON.stringify(lampShadows)}: the lamps' shadows are stamped on the layer`);
      }
      if (lampShadows === 'map') {
        this._lampMapOn = true;
        // N-196: 'auto' (the default) sizes the tile by the casting lamps' reach and lighting.shadowResolution.
        const tile = lightingConfig.lampShadowTile;
        this._lampTileAuto = tile === undefined || tile === null || tile === 'auto';
        this._lampTileSize = this._lampTileAuto ? 256 : Math.max(32, Math.min(1024, (tile | 0) || 256));
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
        this._initWallRows(wallRows);
        this._facesOn = true;
      }
      // baseAmbient is the night/minimum light level (when sun is down)
      this.baseAmbient = lightingConfig.baseAmbient !== undefined ? lightingConfig.baseAmbient : 0.05;
      this.maxLights = lightingConfig.maxLights !== undefined ? lightingConfig.maxLights : 128;
      const lightSlots = Math.max(1, this.maxLights | 0);
      this._visibleLightsAll = new Array(lightSlots);
      for (let i = 0; i < lightSlots; i++) {
        this._visibleLightsAll[i] = { entityId: 0, distSq: 0 };
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
      this.createLightingSystem();
      this._createLiquidFunLightSplat(this.liquidFunMaxCount);
      this._createParticleLightSplat(this._particleLightMax);

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
    if (this.shadowDisplaySprite) this._registerLayerDisplayObject('castedShadows', this.shadowDisplaySprite);
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
    if (this._lightEdges !== null) this._registerLayerDisplayObject('lighting', this._lightEdges.host);
    else if (this.lightingDisplaySprite) this._registerLayerDisplayObject('lighting', this.lightingDisplaySprite);
    else if (this.lightingMesh) this._registerLayerDisplayObject('lighting', this.lightingMesh);
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
      this.shadowSpritesEnabled = true;
      this.shadowMaps.createShadowSpriteSystem();
    }
  }
}

// Create singleton instance and setup message handler
self.pixiRenderer = new PixiRenderer(self);
