// pre_render_worker.js - Pre-render worker for visibility, animation and render queue building
// Handles all visual calculations AFTER physics, BEFORE pixi_worker renders
// This worker is purely visual - no physics or game logic

import { ParticleComponent as ParticleComponentImport } from '../components/particleComponent.js';
import { DecorationComponent as DecorationComponentImport } from '../components/decorationComponent.js';
import { BulletComponent as BulletComponentImport } from '../components/bulletComponent.js';
import { Transform as TransformImport } from '../components/transform.js';
import { RigidBody as RigidBodyImport } from '../components/rigidBody.js';
import { Collider as ColliderImport } from '../components/collider.js';
import { ColliderFixture } from '../core/colliderFixture.js';
import { LightEmitter as LightEmitterImport } from '../components/lightEmitter.js';
import { SpriteRenderer as SpriteRendererImport } from '../components/spriteRenderer.js';
import { AdobeAnimComponent as AdobeAnimComponentImport } from '../components/adobeAnimComponent.js';
import { ShadowCaster as ShadowCasterImport } from '../components/shadowCaster.js';
import { FlashComponent as FlashComponentImport } from '../components/flashComponent.js';
import { LightOccluder as LightOccluderImport, LIGHT_OCCLUDER_MASK_SPRITE } from '../components/lightOccluder.js';
import { AbstractWorker } from './abstractWorker.js';
import { poseRotationLive } from '../box2d/box2dBodySync.js';
import { Camera } from '../core/camera.js';
import { Query as QueryImport } from '../core/query.js';
import {
    bindPolarBins,
    clearPolarBins,
    ensureCompoundSolid,
    OCC_CIRCLE,
    OCC_POLY,
    polarBinsActive,
    skipPolarBins,
    warnSweepOverflow,
    writeOrientedBoxVerts,
    writePolygonVerts,
} from '../render/visibility/angularSweep.js';
import {
    GATHER_EVENT_F64,
    GATHER_EVENT_I32,
    GATHER_EV_SOLID,
    bindVisibilityGather,
    writeGatherColumns,
} from '../render/visibility/visibilityGatherClient.js';
import {
    bindVisibilitySweep,
    SWEEP_OWNER_SEEN,
    SWEEP_OWNER_STAMP,
    SWEEP_R_EVENT_OVERFLOW,
    SWEEP_R_OWNERS_MARKED,
    SWEEP_R_SEEN_VALID,
    SWEEP_R_STAMP,
} from '../render/visibility/visibilitySweepClient.js';
import {
    SOLID_ARGS,
    bindSolidSegments,
    collectSolidRefused,
    collectSolidWasm,
    unbindSolidSegments,
} from '../render/visibility/solidSegmentsClient.js';
import { VISIBILITY_MAX_OCCLUDERS, createVisibilityMemory, visibilityMemoryOpts } from '../util/visibilityMemory.js';
import { Grid as GridImport } from '../core/grid.js';
import { Sun } from '../core/sun.js';
import {
    calculateCameraScreenBounds,
    screenBoundsToWorldBounds,
    lightInfluenceRadius,
    lightCookieScale,
} from '../util/utils.js';
import { viewWorldBounds } from '../util/viewBounds.js';
import { PRE_RENDER_STATS, createMultiWorkerStatsWriter } from '../util/workersUtils.js';
import { orderSortKey, spriteYSortKey, spriteSortFootY, zSortBand } from '../util/sortIndexByKey.js';
import { Time } from '../core/timeScale.js';
import { GpuParticles } from '../core/gpuParticles.js';
import { PROXY_CAMERA, PROXY_MAX_ENTRIES, ProxyCollector, bindProxyHalves, proxyView } from '../render/gpuParticleProxies.js';
import {
    RENDERER_DEFAULTS,
    PRE_RENDER_DEFAULTS,
    LIGHTING_DEFAULTS,
    resolvePreRenderInterpolation,
    CAMERA_TYPES,
    DECORATION_Y_SORT_SCALE,
    ENTITY_GLOW_SORT_BIAS,
    PARTICLE_SORT_BIAS,
    ShapeType,
    MAX_POLYGON_VERTICES,
    resolveZenithalMaxHeight,
} from '../util/configDefaults.js';
import { ySortEnabled, resolveSpritePipeline, PACK_GPU_SPRITES_PRERENDER, SORT_SPRITES_PRERENDER } from '../render/rendererBackend.js';
import { Layer } from '../core/layer.js';
import { computeBufferSize, createViews as createRenderQueueViews, createRenderQueueCameraViews } from '../render/renderQueueLayout.js';
import { bindGpuPack, packInstancedRowsWasm, packSplitRowsWasm } from '../render/gpuPackClient.js';
import { bindPainterRadix, createWasmPainterState, painterSlotList, radixSortIndicesWasm } from '../render/painterRadixClient.js';
import { bindShadowStamp, stampLightRangeWasm } from '../render/shadowStampClient.js';
import { bindPreRenderCollect, writeCollectColumns, writeCollectList } from './preRenderCollectClient.js';
import {
    bindEmitAdobe,
    bindPreRenderEmit,
    writeEmitAdobeAssets,
    writeEmitAdobeColumns,
    writeEmitBulletColumns,
    writeEmitGlowColumns,
    writeEmitParticleColumns,
    writeEmitLiquidFunColumns,
    writeEmitColumns,
    writeEmitTextures,
    writePersistColumns,
    EMIT_BOUNDS,
    EMIT_DECLINED,
    EMIT_NO_CASTERS,
    EMIT_PERSIST_MISS,
    EMIT_PRESORTED,
    EMIT_OTHERS_ONLY,
    EMIT_SORT_KEY,
    EMIT_TILES_DIRTY,
    EMIT_WARN_BULLET_START,
    EMIT_WARN_PARTICLE_START,
    EMIT_WARN_LF_START,
    EMIT_WARN_NO_ANIM,
    EMIT_WARN_NO_START,
    EMIT_Y_SORT,
} from './preRenderEmitClient.js';
import {
    GPU_SPRITE_FLOATS,
    GPU_CASTER_FLOATS,
    GPU_SPACE_WORLD,
    GPU_SPACE_SCREEN,
    GPU_FLAG_SORTED,
    GPU_FLAG_SPLIT,
    createGpuQueueViews,
    clearGpuQueueHeader,
    writeGpuQueueHeader,
    makePackContext,
} from '../render/gpuQueueLayout.js';
import {
    compactShadowCasterIndices,
    rtPixelSize,
    rtPixelScale,
} from '../render/gpuShadowCasters.js';
import { packSpriteLayer } from '../render/packSpriteLayer.js';
import { bindLiquidFunRender } from '../render/liquidFunRender.js';
import { LiquidFun } from '../core/liquidFun.js';
import { AdobeAnimRegistry } from '../core/adobeAnimRegistry.js';
import { Messages, MESSAGE_ANIMATION_END } from '../core/messages.js';
import { staticSceneryGen } from '../core/staticScenery.js';
import { StaticSceneryGrid } from '../render/staticSceneryGrid.js';

// Hot code reads these as module consts, not imports. TurboFan folds a module
// const (and the typed arrays its class holds); an import is a cell it reads
// at run time. See HOW_WE_MEASURE, "Imports in hot code".
const ParticleComponent = ParticleComponentImport;
const DecorationComponent = DecorationComponentImport;
const BulletComponent = BulletComponentImport;
const Transform = TransformImport;
const RigidBody = RigidBodyImport;
const Collider = ColliderImport;
const LightEmitter = LightEmitterImport;
const SpriteRenderer = SpriteRendererImport;
const AdobeAnimComponent = AdobeAnimComponentImport;
const ShadowCaster = ShadowCasterImport;
const FlashComponent = FlashComponentImport;
const LightOccluder = LightOccluderImport;
const Query = QueryImport;
const Grid = GridImport;

const INVALID_TEXTURE_ID = 0xFFFF;
const EMPTY_OWNED_IDS = new Uint32Array(0);
// Placeholders for render-queue columns until initialize() binds the real views.
const EMPTY_F32 = new Float32Array(0);
const EMPTY_U8 = new Uint8Array(0);
const EMPTY_U16 = new Uint16Array(0);
const EMPTY_U32 = new Uint32Array(0);
const EMPTY_I32 = new Int32Array(0);

/**
 * E-07. Kinds of animation-row source, as numeric tags.
 *
 * `emitSpriteQueue` resolves one animation id per queued row. The label used to be
 * passed as a pre-built template string (`particle:${pAnimIdx}` and three siblings)
 * and is read ONLY on the two warning branches of `_resolveAnimFrameStart`. Passing
 * a tag instead means the string is built only when a frame is already reporting a
 * missing texture, where the cost is irrelevant.
 *
 * Predator queues 20 000 swaying grass decorations, so this was ~20 000 string
 * concatenations per frame in a loop that runs 20 000 times per frame.
 */
const ANIM_LABEL_TAG = Object.freeze({
    PARTICLE: 0,
    LIQUID_FUN: 1,
    DECORATION: 2,
    BULLET: 3,
});
const ANIM_LABEL_NAMES = Object.freeze(['particle', 'liquidFun', 'decoration', 'bullet']);

/** Copy n floats, no view allocated (copies run per skipped shadow frame). */
function copyF32(dst, src, n) {
    for (let i = 0; i < n; i++) dst[i] = src[i];
}

// _sortPrefix: insertion sort up to this many items, merge sort above (E-08).
const SORT_PREFIX_INSERTION_MAX = 64;
const SORT_PREFIX_RUN = 32;

/**
 * Stable bottom-up merge sort of arr[0, n) through tmp (length >= n): runs of
 * SORT_PREFIX_RUN insertion-sorted in place, then merge passes alternating
 * between the two. Stable like the insertion sort it takes over from, so the
 * order is the same, ties included. Slots at n and past it are not touched.
 */
function mergeSortPrefix(arr, tmp, n, compare) {
    for (let lo = 0; lo < n; lo += SORT_PREFIX_RUN) {
        const hi = lo + SORT_PREFIX_RUN < n ? lo + SORT_PREFIX_RUN : n;
        for (let i = lo + 1; i < hi; i++) {
            const item = arr[i];
            let j = i - 1;
            while (j >= lo && compare(arr[j], item) > 0) {
                arr[j + 1] = arr[j];
                j--;
            }
            arr[j + 1] = item;
        }
    }
    // Every run boundary in order: the whole prefix already is (n / RUN compares).
    let ordered = true;
    for (let r = SORT_PREFIX_RUN; r < n; r += SORT_PREFIX_RUN) {
        if (compare(arr[r - 1], arr[r]) > 0) {
            ordered = false;
            break;
        }
    }
    if (ordered) return;
    let src = arr;
    let dst = tmp;
    for (let width = SORT_PREFIX_RUN; width < n; width *= 2) {
        for (let lo = 0; lo < n; lo += 2 * width) {
            const mid = lo + width < n ? lo + width : n;
            const hi = lo + 2 * width < n ? lo + 2 * width : n;
            let i = lo;
            let j = mid;
            let k = lo;
            // Halves already in order (a nearly sorted list): copy, no compares.
            if (j >= hi || compare(src[j - 1], src[j]) <= 0) {
                while (k < hi) dst[k] = src[k++];
                continue;
            }
            while (i < mid && j < hi) dst[k++] = compare(src[i], src[j]) <= 0 ? src[i++] : src[j++];
            while (i < mid) dst[k++] = src[i++];
            while (j < hi) dst[k++] = src[j++];
        }
        const t = src;
        src = dst;
        dst = t;
    }
    if (src !== arr) for (let i = 0; i < n; i++) arr[i] = src[i];
}

// Light sort orders (E-66). A comparator's double result is boxed on its way
// back to the sort, and Chrome made a heap number per comparison. ±1 has the
// same sign; ±0 and NaN come back as they are, so Array.prototype.sort and
// every `> 0` / `<= 0` test in _sortPrefix read the order `a - b` gave.
function lightYOrder(a, b) {
    const d = Transform.y[a] - Transform.y[b];
    return d > 0 ? 1 : d < 0 ? -1 : d;
}

/** Nearest first, then id: `a.distSq - b.distSq || a.id - b.id`, unboxed. */
function stampLightOrder(a, b) {
    const d = a.distSq - b.distSq;
    if (d > 0) return 1;
    if (d < 0) return -1;
    return a.id - b.id;
}

/**
 * Build the diagnostic label. Only ever called on a warn path.
 * A string `kind` is passed through, so the name-based caller still works.
 */
function formatAnimLabel(kind, animIdx) {
    const name = typeof kind === 'string' ? kind : ANIM_LABEL_NAMES[kind];
    // Undefined/null animIdx used to render as "undefined" via template coercion;
    // String() keeps that identical.
    return `${name}:${String(animIdx)}`;
}

/** E-138. col[0..n) = col[order[0..n)], through tmp. */
function permuteF32(col, order, n, tmp) {
    for (let k = 0; k < n; k++) tmp[k] = col[order[k]];
    col.set(tmp.subarray(0, n));
}



/** Composite depth sort: worldY * scale + innerZ (entities, decorations, bullets) */
const Y_SORT_K = DECORATION_Y_SORT_SCALE;
// The sort key of the renderable being collected (E-86). collectRenderable and _writeRenderable are
// too big for TurboFan to inline into the collect loops, and the key passed as an argument was a
// heap number per visible particle, bullet, decoration and glow. Callers write it here first.
// Sprites (types 0 and 6) need none: _writeRenderable stores their drawn Y.
const COLLECT_Y = new Float64Array(1);
/**
 * PreRenderWorker - Handles all visual pre-calculations before rendering
 *
 * Responsibilities:
 * 1. Entity visibility; consume particle/decoration visible lists from particle_worker
 * 2. Animation frame advancement for entities
 * 3. Building main render queue (sortKey for the CPU painter)
 * 4. Building shadow render queue (light cookies + black shadow sprites)
 *
 * Data Flow:
 * - Reads: Transform, SpriteRenderer, ParticleComponent, DecorationComponent, LightEmitter, ShadowCaster
 * - Writes: Render queue SAB (consumed by pixi_worker), Shadow queue SAB
 */
class PreRenderWorker extends AbstractWorker {
    constructor(selfRef) {
        super(selfRef);

        // Pre-render worker doesn't need game scripts or GameObject instances
        this.needsGameScripts = false;

        // Per-frame subtimers (ms) — written to PRE_RENDER_STATS in reportFPS
        this.collectTimeThisFrame = 0;
        this.sortTimeThisFrame = 0;
        this.emitTimeThisFrame = 0;
        this.customLayerTimeThisFrame = 0;
        this.spritePackTimeThisFrame = 0;
        this.shadowQTimeThisFrame = 0;
        this.visibilityTimeThisFrame = 0;
        this.adobeTimeThisFrame = 0;
        // E-29. The two phases that had no timer. See the PRE_RENDER_STATS comments:
        // VISIBLE_LIGHTS_MS is a peer of the others, STAMP_LIGHTS_MS is a sub-timer of
        // SHADOW_Q_MS.
        this.visibleLightsTimeThisFrame = 0;
        this.stampLightsTimeThisFrame = 0;

        // Entity and particle counts
        this.globalEntityCount = 0;
        this.maxParticles = 0;
        this.liquidFun = null;
        this.liquidFunMaxCount = 0;
        // HEAP prev pose latch (replaces thin SAB px/py after zero-copy bind)
        this._prevLfX = null;
        this._prevLfY = null;
        this._prevLfCount = 0;
        this._lfSnapX = null;
        this._lfSnapY = null;
        this._lfSnapCount = 0;
        this._lfSnapValid = false;
        this._lfPoseReadyFrame = -1;
        this.maxDecorations = 0;
        this.maxBullets = 0;

        // ========================================
        // GC OPTIMIZATION: Cached objects
        // ========================================
        this._cameraBounds = {
            zoom: 0,
            cameraOffsetX: 0,
            cameraOffsetY: 0,
            minX: 0,
            maxX: 0,
            minY: 0,
            maxY: 0,
        };
        this._worldBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

        // ========================================
        // RENDER QUEUE SYSTEM (DOUBLE BUFFERED)
        // ========================================
        // Two buffers: pre_render writes to back buffer while pixi reads from front
        // pixi_worker never waits; pre_render skips a frame if >1 ahead (backpressure)
        this.renderQueueEnabled = false;
        this.renderQueueMaxItems = 0;

        // Double buffer storage - each buffer has its own typed array views
        // Index 0 = buffer A, Index 1 = buffer B
        this.renderQueueBuffers = [null, null];
        this.renderQueueCameraBuffers = [null, null];
        this.renderQueuePoseReadyBuffers = [null, null];

        // Sync buffer for coordination: [readyFrame, consumedFrame]
        this.renderQueueSync = null;
        this.renderQueueFrame = 0; // Current frame counter (increments each update)
        this._queueBuf = 0; // Write buffer. Flips next to renderQueueFrame++. Matches frame & 1.

        // Current write buffer reference (set each frame based on frame counter)
        // Tile fields (tileMode / tileOffset / tileMul): see renderQueueLayout.js
        // Columns start as empty arrays of their class, not null: see E-71 below.
        this.renderQueueCount = null;
        this.renderQueueX = EMPTY_F32;
        this.renderQueueY = EMPTY_F32;
        this.renderQueueScaleX = EMPTY_F32;
        this.renderQueueScaleY = EMPTY_F32;
        this.renderQueueRotC = EMPTY_F32;
        this.renderQueueRotS = EMPTY_F32;
        this.renderQueueAlpha = EMPTY_F32;
        this.renderQueueTint = EMPTY_U32;
        this.renderQueueTextureId = EMPTY_U16;
        this.renderQueueAnchorX = EMPTY_F32;
        this.renderQueueAnchorY = EMPTY_F32;
        /** The main queue's staticGen column (renderQueueLayout.js), and the count written there. */
        this.renderQueueStaticGen = EMPTY_U32;
        this._staticGen = 1;
        // Sprites whose animation moved to a new frame on the last persist frame (a new texture).
        this._persistFramesMoved = 0;
        // E-98g: rows the last persist check repaired (a frame another buffer moved). Bumps staticGen.
        this._persistFramesRepaired = 0;
        // E-102b. The tileMode columns a repeating sprite has written (one per queue buffer, and per
        // custom layer's). A column set starts at zero and only that branch writes anything else, so
        // until it has, the other rows need not write zeros there (repeat, tile mode, offsets, muls).
        this._tiledTileColumns = new Set();
        this.renderQueueType = EMPTY_U8;
        /** The instanced-row pack kernel (E-76 W9), bound when the queues live in the render-queue memory. */
        this._gpuPackWasm = null;
        // E-82b: the main sprites go into the GPU queue as a pose stream and a static stream,
        // the statics written only when the GPU queue buffer does not hold this generation's already. Per GPU
        // queue buffer: the generation its statics hold (0: none) and their rows; and this frame's split.
        this._gpuSplit = false;
        this._gpuStaticGen = new Uint32Array(2);
        this._gpuStaticRows = new Int32Array(2);
        this._packSplitUsed = false;
        this._packSplitGen = 0;
        /** The main queue's painter state (painterRadixClient's wasmPainterState), when pre-render sorts it. */
        this._gpuPainter = null;
        /** The painter sort kernel (W10) on pre-render's painter regions of the render-queue memory, when laid out. */
        this._gpuPainterWasm = null;
        /** The emit kernel (E-112), bound when the emit's columns live in the render-queue memory. */
        this._emitWasm = null;
        /** The sprite collect kernel (W4b), bound when a scene without physics keeps Transform in that memory. */
        this._collectWasm = null;
        /** The shadow stamp kernel (E-114), on its regions of the render-queue memory (with shadows and sun casters). */
        this._stampWasm = null;
        /** Whether the kernel's last frame wrote a repeating sprite (emitSpriteQueue's tiledRows). */
        this._emitTiledRows = false;
        this.renderQueueSortKey = EMPTY_F32;
        this.renderQueueSortKeyU32 = EMPTY_U32;
        this.renderQueueRepeatX = EMPTY_U16;
        this.renderQueueRepeatY = EMPTY_U16;
        this.renderQueueCamera = null;
        this.renderQueuePoseReady = null;
        this._frameCameraZoom = 1;
        this._frameCameraX = 0;
        this._frameCameraY = 0;
        this._frameCameraRot = 0;
        /** GPU queue buffer that holds the last shadow pack (see _republishGpuShadows). */
        this._gpuShadowsFrom = null;
        /** Camera.resolveDrawnCamera scratch. */
        this._drawnCam = { zoom: 1, x: 0, y: 0, rotation: 0 };

        // Entity texture lookup buffer
        this.entityLastTextureId = null;

        // Component arrays for spriteSortFootY, bound once on first use
        this._spriteSortArrays = null;
        // E-98. Whether the entities layer is Y-sorted this frame. Without Y-sort a sprite's key is
        // its zIndex (orderSortKey), so its sort line is not computed.
        this._entitySortY = false;

        // Animation frame tracking
        this.entityFrameIndex = null;
        this.entityFrameAccumulator = null;
        // onAnimationEnd: types that define it, and the last (animation + 1,
        // spawn generation) reported per entity, so a held last frame reports once.
        this._animEndByType = new Uint8Array(0);
        this._animEndAnim = new Uint16Array(0);
        this._animEndGen = new Uint16Array(0);

        // Scratch for published physics pose / Transform (no per-call alloc)
        // Display pose scratch: [x, y, rotC, rotS]. A typed array, as Chrome boxed the
        // doubles stored into an object's x and y here: two heap numbers per drawn
        // entity per frame, 17.6 MB/s in Predator (E-66).
        this._displayPoseOut = Float64Array.of(0, 0, 1, 0);
        this.backpressure = true;

        // Physics pose publish latch (mirror renderQueueSync)
        this._rbActive = null;

        // Pose smoothing (preRender.interpolation) - self-measured physics-step
        // timing, no cross-worker config needed. Computed once per tick in
        // _latchPose(), consumed per-entity in _displayPose()/LiquidFun collect.
        this.interpolatePhysicsPose = false;
        this.skipCull = false;
        this._poseLastSeenReadyFrame = 0;
        this._poseLastChangeWallClock = 0;
        this._poseMeasuredIntervalMs = 0;
        this._poseAlpha = 1; // interpolate: 0..1 progress toward the latched frame

        // Texture metadata
        this.animationFrameStart = null;
        this.animationFrameCount = null;
        this.proxyToGlobalAnim = null;
        this.animationNameToIndex = null;

        // Renderable collector (struct-of-arrays for better cache locality)
        this._renderableY = null;
        this._renderableType = null;
        this._renderableIndex = null;
        // Pose stash (types 0/2/6): filled at collect, consumed at emit — avoid double _displayPose
        this._renderablePx = null;
        this._renderablePy = null;
        this._renderableRotC = null;
        this._renderableRotS = null;
        // E-98d. Where this frame's collect writes poses: the stash above, or the main queue's own
        // x, y, rotC, rotS columns when no row can expand (no Adobe root), queue row i being
        // collector row i. Then the persist frame has no pose copy left to do.
        this._collectPx = EMPTY_F32;
        this._collectPy = EMPTY_F32;
        this._collectRotC = EMPTY_F32;
        this._collectRotS = EMPTY_F32;
        this._renderableCount = 0;

        // Pre-allocated query arrays
        this._queryLightEmitter = null;
        this._querySpriteRenderer = null;
        // E-127. The static scenery's grid; empty without static types.
        this._staticGrid = new StaticSceneryGrid();
        this._queryAdobeAnim = null;

        // Per-frame cached query results (avoids duplicate queryActiveEntities calls)
        this._frameAdobeEntities = null;
        // _emitRefused said its reason.
        this._emitRefusedWarned = false;
        // _collectRefused said its reason.
        this._collectRefusedWarned = false;
        // _packRows said a call was refused.
        this._packRefusedWarned = false;
        // Per-frame cached camera bounds (avoids redundant calculateCameraBounds calls)
        this._frameCameraBoundsValid = false;

        // Visible lights SAB: written here, read by pixi (avoids duplicate query)
        this.visibleLightsData = null;

        this.shadowsEnabled = false;
        this.maxShadowCastingLights = 20;
        this.maxShadowsPerLight = 15;
        this.maxShadowsPerEntity = 0;
        this.shadowUpdateInterval = 1;
        this.adaptiveShadowBudget = true;
        this._shadowUpdateTick = 0;

        // GC OPTIMIZATION: Pre-allocated buffer for Y-sorted light indices
        this._sortedLightEntities = [];
        this._lightPersistScratch = [];
        this._lightFlashScratch = [];
        this._lightYComparator = lightYOrder;
        this._sortPrefixTmp = null;

        // Stats tracking
        this.shadowsUpdatedThisFrame = 0;
        this.visibleEntitiesCount = 0;
        this.visibleParticlesCount = 0;
        this.visibleDecorationsCount = 0;
        this.skippedFramesThisFrame = 0;

        // ========================================
        // SUN / DIRECTIONAL LIGHT
        // ========================================
        // Sun provides parallel shadows (all shadows same direction)
        // and modulates point light shadow visibility (uses static Sun class)
        this.sunEnabled = false;

        // Sun shadow values are now computed centrally in Sun class
        // Workers just read: Sun.shadowDirX, Sun.shadowDirY, Sun.shadowLengthRatio, Sun.shadowAngle

        // One-shot cap warnings. These are only checked on truncation paths.
        this._warnedVisibleLightsCap = false;
        this._warnedShadowCastingLightsCap = false;
        this._warnedShadowRenderQueueCap = false;
        this._warnedShadowSpriteCap = false;
        this._warnedVisibilityPolygonLightCap = false;
        this._warnedVisibilityPolygonOccluderCap = false;
        this._renderQueueOverflowWarned = false;
        this._adobeRenderQueueOverflowWarned = false;
        this._missingTextureWarns = null;

        // Everything the frame paths write later, declared here (N-32). A field
        // first written after the loop starts changes this object's hidden
        // class, and V8 drops every optimized method that checked the old one.
        // After the first full-queue warning, one method deoptimized every frame
        // for ~8 s before V8 compiled it again.
        // initialize() and the paths below overwrite these as before.
        // A column starts as an empty array of its own class, not null (E-71).
        // From null, V8 types the field Any, and optimized code checks the
        // array's class before it indexes it: 15 % of the emit kernel.
        this.renderQueueShadowH = EMPTY_F32;
        this.renderQueueShadowOffX = EMPTY_F32;
        this.renderQueueShadowOffY = EMPTY_F32;
        this.renderQueueTileMode = EMPTY_U8;
        this.renderQueueTileOffsetU = EMPTY_U16;
        this.renderQueueTileOffsetV = EMPTY_U16;
        this.renderQueueTileMulX = EMPTY_F32;
        this.renderQueueTileMulY = EMPTY_F32;
        this._vpWriteBuffer = null;
        this._selfLitWriteBuffer = null;
        // N-19: per self-lit item, 1 if it is a compound solid; per entity, the
        // stamp of the last light whose polygon showed that solid. N-39: per
        // simple item, its occluder index in this light's sweep.
        this._selfLitSolid = EMPTY_U8;
        this._selfLitOcc = EMPTY_I32;
        this._selfLitSeen = EMPTY_U32;
        this._selfLitSeenStamp = 0;
        // W2a: the per-light sweep in visibilitySweep.wasm (bindVisibilitySweep's binding), on the visibility
        // memory pre-render makes for it; null before an init with raycasted lighting.
        this._visSweep = null;
        this._visMemory = null;
        // buildVisibilityPolygons said the sweep is missing.
        this._visRefusedWarned = false;
        // W1: the swept light loop's compound raster, solidSegments.wasm (collectSolidWasm); without a fixture pool
        // no compound solid comes, and collectSolidRefused says so if one does.
        this._visCollectSolid = collectSolidRefused;
        // W2b: the light's neighbour gather in visibilityGather.wasm (bindVisibilityGather's binding), with the
        // visibility memory placed in the engine block; null gathers in JS (the spatial memory outside the block).
        this._visGather = null;
        this._decorationZoomAlpha = 1;
        this._emitWriteCount = 0;
        // E-138. A frame whose emit expands its rows (Adobe Animate roots into pieces) sorts the collector before the
        // emit (_presortCollector), so the queue comes out in painter order and the pack takes it in order. Whether
        // this frame's queue was, the collector's count and the rows the emit wrote last frame (resetFrameCounters
        // clears _emitWriteCount before the collect), and the sort's keys, order and column scratch (sized on the
        // first such frame).
        this._queuePresorted = false;
        this._lastCollectCount = 0;
        this._lastEmitCount = 0;
        /** The presorted collector's glow rows (type 3): with none, the pack takes every row with no slot list. */
        this._presortGlowRows = 0;
        /**
         * True only while the main queue's emit runs on a presorted frame: the kernel then leaves the sort keys and
         * the shadow terms, which nothing reads that frame (custom layers emit after it and keep theirs).
         */
        this._emitPresorted = false;
        this._presortKeys = EMPTY_F32;
        this._presortKeysU32 = EMPTY_U32;
        this._presortOrder = EMPTY_U32;
        this._presortF32 = EMPTY_F32;
        this._presortU8 = EMPTY_U8;
        this._presortI32 = EMPTY_I32;
        this._emptyAdobeEntities = null;
        this._columnSnapshot = null;
        this._lightGlowAsSprite = false;
        this._glowEmit = false;
        this._glowLayerAlpha = 1;
        this._emitSource = null;
        this._gpuSoa = null;
        this._gpuBoundViews = null;
        this._gpuCounts = null;
        this._gpuShadowsResult = null;
        this._gpuSpritesResult = null;
        // GPU particle groups in the y-sort painter (gpuParticleProxies.js): the split memory's halves, A and B,
        // when a GPU layer sorts with the entities and this worker packs them; null otherwise.
        this._proxyHalves = null;
        this._proxyCollector = null;
        // The proxies' camera, culled view and sim clock (gpuParticleProxies.js proxyView): typed arrays, so no
        // double crosses a call.
        this._proxyCamera = new Float64Array(6);
        this._proxyView = new Float64Array(4);
        this._proxyClock = new Float64Array(1);
        this._proxyDroppedWarned = false;
        this._stampLightCmp = stampLightOrder;
        // Stamp lights and their scratch: first written when a light first shows.
        this._stampLights = null;
        this._stampLightCount = 0;
        this._stampSortLights = false;
        this._stampRangeSpec = null;
        this._gpuLightVec = null;
        this._gpuStampTmp = null;
        this._gpuStampDist = null;
        this._gpuStampOrder = null;
        this._gpuCasterUsed = null;
        this._gpuKeepIdx = null;
        this._stampGridCounts = null;
        this._stampGridStarts = null;
        this._stampGridItems = null;
        // GPU pack writers, bound on the first packed frame.
        this._gpuPackSpec = null;
        this._addPackSortMs = null;
        this._writePackedSprites = null;
        this._writePackedGlow = null;
        this._packParticles = 0;
        this._packDst = null;
        this._packQ = null;
    }

    _warnOnce(flagName, message) {
        if (this[flagName]) return;
        this[flagName] = true;
        console.warn(message);
    }

    /** Deduped warn for missing anim / texture resolution (avoids per-frame spam). */
    _warnMissingTexture(key, message) {
        if (!this._missingTextureWarns) this._missingTextureWarns = new Set();
        if (this._missingTextureWarns.has(key)) return;
        this._missingTextureWarns.add(key);
        console.warn(message);
    }

    /**
     * Resolve animationFrameStart[animIdx], or INVALID + warn.
     * @param {number} animIdx
     * @param {string} label
     * @returns {number}
     */
    _resolveAnimFrameStart(animIdx, kind) {
        if (animIdx === undefined || animIdx === null || animIdx < 0) {
            const label = formatAnimLabel(kind, animIdx);
            this._warnMissingTexture(
                `anim:${label}`,
                `[PRE_RENDER] missing animation "${label}" (animIdx=${animIdx})`
            );
            return INVALID_TEXTURE_ID;
        }
        const start = this.animationFrameStart?.[animIdx];
        if (start === undefined || start === null) {
            const label = formatAnimLabel(kind, animIdx);
            this._warnMissingTexture(
                `frameStart:${label}`,
                `[PRE_RENDER] animationFrameStart missing for "${label}" (animIdx=${animIdx})`
            );
            return INVALID_TEXTURE_ID;
        }
        return start | 0;
    }

    /**
     * Look up builtin anim by name → first frame texture id, or INVALID + warn.
     * @param {string} name
     * @returns {number}
     */
    _resolveBuiltinTextureId(name) {
        const map = this.animationNameToIndex;
        if (!map || map[name] === undefined) {
            this._warnMissingTexture(
                `name:${name}`,
                `[PRE_RENDER] animationNameToIndex missing "${name}"`
            );
            return INVALID_TEXTURE_ID;
        }
        return this._resolveAnimFrameStart(map[name], name);
    }

    /**
     * Resolve sprite texture for an entity (emit-equivalent). Used when
     * entityLastTextureId is still INVALID (sharded shadows run before emit).
     * Writes the cache on success. Warns only if resolution fails.
     * @param {number} idx
     * @returns {number}
     */
    _resolveEntitySpriteTextureId(idx) {
        const i = idx | 0;
        if (!SpriteRenderer.active || !SpriteRenderer.active[i]) {
            this._warnMissingTexture(
                `entitySprite:${i}:inactive`,
                `[PRE_RENDER] entity=${i} has no active SpriteRenderer; cannot resolve texture`
            );
            return INVALID_TEXTURE_ID;
        }
        const sheetId = SpriteRenderer.spritesheetId[i];
        const animState = SpriteRenderer.animationState[i];
        // sheetId 0 = unset sentinel (spawn reset / collect→emit pool recycle). Not a bug.
        if (!sheetId) {
            if (this.entityLastTextureId) this.entityLastTextureId[i] = INVALID_TEXTURE_ID;
            return INVALID_TEXTURE_ID;
        }
        const proxyMap = this.proxyToGlobalAnim?.[sheetId];
        const globalAnimIdx = proxyMap?.[animState];
        if (globalAnimIdx === undefined) {
            this._warnMissingTexture(
                `entitySprite:${sheetId}:${animState}`,
                `[PRE_RENDER] no global anim for sheetId=${sheetId} animState=${animState} entity=${i}`
            );
            if (this.entityLastTextureId) this.entityLastTextureId[i] = INVALID_TEXTURE_ID;
            return INVALID_TEXTURE_ID;
        }
        const animStart = this.animationFrameStart?.[globalAnimIdx];
        if (animStart === undefined || animStart === null) {
            this._warnMissingTexture(
                `animStart:${globalAnimIdx}`,
                `[PRE_RENDER] animationFrameStart missing for globalAnimIdx=${globalAnimIdx} entity=${i}`
            );
            return INVALID_TEXTURE_ID;
        }
        const frameIndex = this.entityFrameIndex;
        let frame = frameIndex ? (frameIndex[i] | 0) : 0;
        const animFrameCount = this.animationFrameCount?.[globalAnimIdx] ?? 1;
        if (frame < 0 || frame >= animFrameCount) frame = 0;
        const textureId = (animStart | 0) + frame;
        if (this.entityLastTextureId) this.entityLastTextureId[i] = textureId;
        return textureId;
    }

    /**
     * Cached texture or resolve-on-cold. No warn for cold cache alone.
     * @param {number} idx
     * @returns {number}
     */
    _entityTextureIdOrResolve(idx) {
        const last = this.entityLastTextureId;
        let textureId = last ? last[idx | 0] : INVALID_TEXTURE_ID;
        if (textureId === INVALID_TEXTURE_ID) {
            textureId = this._resolveEntitySpriteTextureId(idx);
        }
        return textureId;
    }

    /**
     * Initialize the pre-render worker
     */
    async initialize(data) {
        const preRenderConfig = this.config.preRender || {};

        if (data.buffers.preRenderStats) {
            this.stats = createMultiWorkerStatsWriter(
                data.buffers.preRenderStats,
                PRE_RENDER_STATS,
                0
            );
        }

        // Configure scheduling from preRender config (camelCase key)
        const fixedFps = Number(preRenderConfig.fixedFps);
        if (fixedFps > 0) {
            this.fixedFps = fixedFps;
            this.noLimitFPS = false;
        } else if (preRenderConfig.noLimitFPS === true) {
            this.noLimitFPS = true;
        }
        this.backpressure = preRenderConfig.backpressure !== false;

        // Physics-pose blend while packing. preRender.interpolation is a boolean.
        const interpRaw = preRenderConfig.interpolation !== undefined
            ? preRenderConfig.interpolation
            : PRE_RENDER_DEFAULTS.interpolation;
        this.interpolatePhysicsPose = resolvePreRenderInterpolation(interpRaw);
        this.skipCull = preRenderConfig.skipCull === true;

        // Store counts
        this.globalEntityCount = data.globalEntityCount || 0;
        this.maxParticles = data.maxParticles || 0;
        this.liquidFunMaxCount = data.liquidFunMaxCount || 0;
        if (data.buffers?.liquidFunRender && this.liquidFunMaxCount > 0) {
            this.liquidFun = bindLiquidFunRender(data.buffers.liquidFunRender, this.liquidFunMaxCount, data.buffers.liquidFunRenderByte | 0);
        }
        this.maxDecorations = data.maxDecorations || 0;
        this.maxBullets = data.maxBullets || 0;

        // Zenithal projection curve (scene-level). Mode is per-particle (viewMode).
        const particleConfig = this.config.particle || {};
        this.zenithalMaxHeight = resolveZenithalMaxHeight(particleConfig);
        this.zenithalScaleFactor = particleConfig.zenithalScaleFactor ?? 0.5;
        this.zenithalAlphaFade = particleConfig.zenithalAlphaFade ?? 0;

        // Store viewport dimensions
        this.canvasWidth = this.config.canvasWidth;
        this.canvasHeight = this.config.canvasHeight;
        const preCfg = this.config.preRender || {};
        this.cullingRatio = preCfg.cullingRatio ?? PRE_RENDER_DEFAULTS.cullingRatio;

        // Decoration zoom-based fade/hide thresholds
        const rendererConfig = this.config.renderer || {};
        this.decorationFadeStartZoom = preCfg.startFadingDecorationsAtZoom ?? PRE_RENDER_DEFAULTS.startFadingDecorationsAtZoom;
        this.decorationHideZoom = preCfg.hideDecorationsAtZoom ?? PRE_RENDER_DEFAULTS.hideDecorationsAtZoom;
        this._decorationZoomAlpha = 1;
        this._lightGlowAsSprite = (this.config.lighting?.lightGlow ?? LIGHTING_DEFAULTS.lightGlow) === 'sprite';
        this._ySortMode = rendererConfig.ySort;
        this._ySort = ySortEnabled(this._ySortMode);
        const spritePipe = resolveSpritePipeline({
            ySort: this._ySortMode,
            packGpuSprites: preRenderConfig.packGpuSprites,
            sortSprites: preRenderConfig.sortSprites,
            rendererInterpolation: rendererConfig.interpolation === true,
        });
        this._packGpuSpritesOn = spritePipe.packGpuSprites;
        this._sortSprites = spritePipe.sortSprites;
        this._gpuPackCtx = {};
        this._zBand = zSortBand(this.config.worldHeight || 0);
        this._glowLayerAlpha = 1;
        if (GpuParticles.proxySab && this._packGpuSpritesOn === PACK_GPU_SPRITES_PRERENDER) {
            this._proxyHalves = bindProxyHalves(GpuParticles.proxySab);
            this._proxyCollector = new ProxyCollector();
        }

        // ========================================
        // RENDER QUEUE - Initialize (DOUBLE BUFFERED)
        // ========================================
        if (data.renderQueue && data.renderQueue.dataA && data.renderQueue.dataB) {
            this.renderQueueEnabled = true;
            this.renderQueueMaxItems = data.renderQueue.maxItems;

            // Initialize sync buffer for coordination with pixi_worker
            this.renderQueueSync = new Int32Array(data.renderQueue.sync);
            this.renderQueueFrame = 0;
            this._queueBuf = 0;

            const maxItems = this.renderQueueMaxItems;

            // Create typed array views for BOTH buffers
            const bufferSABs = [data.renderQueue.dataA, data.renderQueue.dataB];
            const bufferBytes = [data.renderQueue.dataAByte | 0, data.renderQueue.dataBByte | 0];
            const cameraSABs = [data.renderQueue.cameraA || null, data.renderQueue.cameraB || null];

            for (let bufIdx = 0; bufIdx < 2; bufIdx++) {
                this.renderQueueBuffers[bufIdx] = createRenderQueueViews(bufferSABs[bufIdx], maxItems, bufferBytes[bufIdx]);
                const camViews = createRenderQueueCameraViews(cameraSABs[bufIdx]);
                this.renderQueueCameraBuffers[bufIdx] = camViews ? camViews.camera : null;
                this.renderQueuePoseReadyBuffers[bufIdx] = camViews ? camViews.poseReady : null;
            }

            // Set initial write buffer (will be updated each frame)
            this._setWriteBuffer(0);

            // E-112: in the emit memory the emit's state is regions of it, where its kernel reads them.
            const emitLayout = data.renderQueueLayout?.emit && data.renderQueueMemory
                && data.renderQueueLayout.emit.entities === this.globalEntityCount
                ? data.renderQueueLayout.emit
                : null;
            const emitBuffer = emitLayout ? data.renderQueueMemory.buffer : null;

            // Entity texture lookup buffer
            if (data.renderQueue.entityTextureData) {
                this.entityLastTextureId = new Uint16Array(
                    data.renderQueue.entityTextureData,
                    data.renderQueue.entityTextureByte | 0,
                    this.globalEntityCount
                );
                this.entityLastTextureId.fill(INVALID_TEXTURE_ID);
            }

            // Animation state buffers
            if (this.globalEntityCount > 0) {
                this.entityFrameIndex = emitLayout
                    ? new Uint16Array(emitBuffer, emitLayout.frameByte, this.globalEntityCount)
                    : new Uint16Array(this.globalEntityCount);
                this.entityFrameAccumulator = emitLayout
                    ? new Float32Array(emitBuffer, emitLayout.accumByte, this.globalEntityCount)
                    : new Float32Array(this.globalEntityCount);
            }
            this._bindAnimationEndTypes(data.registeredClasses);
            this._staticGrid.bindTypes(data.registeredClasses, this.globalEntityCount);

            // Pre-allocate renderable collector buffers
            this._renderableY = emitLayout
                ? new Float32Array(emitBuffer, emitLayout.collectorYByte, maxItems)
                : new Float32Array(maxItems);
            this._renderableType = emitLayout
                ? new Uint8Array(emitBuffer, emitLayout.collectorTypeByte, maxItems)
                : new Uint8Array(maxItems);
            this._renderableIndex = emitLayout
                ? new Int32Array(emitBuffer, emitLayout.collectorIndexByte, maxItems)
                : new Int32Array(maxItems);
            // The LiquidFun rows' previous positions, where the emit kernel reads them (_latchLiquidFunPrevPose
            // keeps arrays of this length).
            if (emitLayout && emitLayout.lfPrevByte >= 0) {
                const lfN = emitLayout.lfMaxCount;
                this._prevLfX = new Float32Array(emitBuffer, emitLayout.lfPrevByte, lfN);
                this._prevLfY = new Float32Array(emitBuffer, emitLayout.lfPrevByte + 4 * lfN, lfN);
            }
            // E-112, close-out group B: the emit is preRenderEmit.wasm, on the render-queue memory where every column
            // it reads is (the scene makes the memory, or fails to start when it cannot).
            if (!emitLayout) {
                throw new Error('[PRE_RENDER] the render queue has no emit regions in the render-queue memory '
                    + '(renderQueueLayout.emit for this entity count): the emit kernel has nothing to run on');
            }
            try {
                this._emitWasm = await bindPreRenderEmit(data.renderQueueMemory, emitLayout);
            } catch (err) {
                throw new Error(`[PRE_RENDER] preRenderEmit.wasm did not load: ${err?.message ?? err}`, { cause: err });
            }
            // W27: the Adobe roots too, from a copy of the registry's assets (deserialized before initialize).
            if (bindEmitAdobe(this._emitWasm, emitLayout)) this._copyEmitAdobeAssets();
            // W4b: the sprite collect runs only in preRenderCollect.wasm, on Transform, its pose and Collider in the
            // memory (the scene lays them out whenever the emit reads sprites or glows).
            this._collectWasm = null;
            const collectLayout = data.renderQueueLayout?.collect || null;
            if (collectLayout) {
                try {
                    this._collectWasm = await bindPreRenderCollect(data.renderQueueMemory, collectLayout);
                } catch (err) {
                    throw new Error(`[PRE_RENDER] preRenderCollect.wasm did not load: ${err?.message ?? err}`, { cause: err });
                }
            }
            // W27: the pose stash in the memory too when the emit kernel expands Adobe roots (the collect writes
            // the poses there on a frame with one, _bindCollectPoses).
            const stashIn = emitLayout !== null && emitLayout.persistRows === maxItems && emitLayout.stashXByte >= 0;
            const stash = (byte) => (stashIn ? new Float32Array(emitBuffer, byte, maxItems) : new Float32Array(maxItems));
            // E-138: the presort's keys and order in the memory, where the painter kernel sorts them.
            if (emitLayout !== null && emitLayout.persistRows === maxItems && emitLayout.presortKeysByte >= 0) {
                this._presortKeys = new Float32Array(emitBuffer, emitLayout.presortKeysByte, maxItems);
                this._presortKeysU32 = new Uint32Array(emitBuffer, emitLayout.presortKeysByte, maxItems);
                this._presortOrder = new Uint32Array(emitBuffer, emitLayout.presortOrderByte, maxItems);
            }
            this._renderablePx = stash(emitLayout?.stashXByte);
            this._renderablePy = stash(emitLayout?.stashYByte);
            this._renderableRotC = stash(emitLayout?.stashRotCByte);
            this._renderableRotS = stash(emitLayout?.stashRotSByte);
            // W4c: in the memory, where the emit kernel's persist path reads them.
            const persistRows = emitLayout && emitLayout.persistRows === maxItems ? maxItems : 0;
            const persistView = (Type, byte, b) => (persistRows
                ? new Type(emitBuffer, byte + b * persistRows * Type.BYTES_PER_ELEMENT, persistRows)
                : new Type(maxItems));
            this._persistEntity = [0, 1].map((b) => persistView(Int32Array, emitLayout?.persistEntityByte, b));
            this._persistType = [0, 1].map((b) => persistView(Uint8Array, emitLayout?.persistTypeByte, b));
            this._persistFrame = [0, 1].map((b) => persistView(Uint16Array, emitLayout?.persistFrameByte, b));
            this._persistAnim = [0, 1].map((b) => persistView(Uint16Array, emitLayout?.persistAnimByte, b));
            this._persistCount = [0, 0];

            // Pre-allocate query arrays
            this._queryLightEmitter = [LightEmitter];
            this._querySpriteRenderer = [SpriteRenderer];
            this._queryAdobeAnim = [AdobeAnimComponent];

            if (data.gpuQueue && data.gpuQueue.dataA && data.gpuQueue.dataB && data.gpuQueue.caps) {
                const caps = data.gpuQueue.caps;
                this.gpuQueueCaps = caps;
                this.gpuQueueBuffers = [
                    createGpuQueueViews(data.gpuQueue.dataA, caps, data.gpuQueue.dataAByte | 0),
                    createGpuQueueViews(data.gpuQueue.dataB, caps, data.gpuQueue.dataBByte | 0),
                ];
                // W10: the painter sort is painterRadix.wasm on pre-render's painter state, next to the keys it
                // writes, when pre-render sorts (the scene lays the state out then); the slot lists it sorts are
                // regions there too.
                this._gpuPainterWasm = null;
                const painterLayout = data.renderQueueLayout?.preRenderPainter || null;
                if (this._ySort && data.renderQueueMemory && painterLayout) {
                    if (painterLayout.rows < maxItems) {
                        throw new Error(`[PRE_RENDER] the painter state holds ${painterLayout.rows} rows for a queue of ${maxItems}`);
                    }
                    try {
                        this._gpuPainterWasm = await bindPainterRadix(data.renderQueueMemory, painterLayout);
                    } catch (err) {
                        throw new Error(`[PRE_RENDER] painterRadix.wasm did not load: ${err?.message ?? err}`, { cause: err });
                    }
                } else if (this._ySort && this._sortSprites === SORT_SPRITES_PRERENDER
                    && this._packGpuSpritesOn === PACK_GPU_SPRITES_PRERENDER) {
                    console.error('[PRE_RENDER] pre-render sorts the sprites (preRender.sortSprites), but the render-queue '
                        + 'memory has no painter state for it: they are drawn unsorted');
                }
                const painterWasm = this._gpuPainterWasm;
                this._gpuIdxEntity = painterWasm ? painterSlotList(painterWasm, 'entity', maxItems) : new Uint32Array(maxItems);
                this._gpuIdxGlow = painterWasm ? painterSlotList(painterWasm, 'glow', maxItems) : new Uint32Array(maxItems);
                this._gpuPackCtx = {};
                this._gpuCasterIdx = new Uint32Array(Math.max(1, caps.maxSun | 0, maxItems));
                this._gpuStampTmp = new Uint32Array(Math.max(1, caps.maxStamp | 0, maxItems));
                this._gpuStampDist = new Float32Array(Math.max(1, caps.maxStamp | 0, maxItems));
                this._gpuStampOrder = new Uint32Array(Math.max(1, caps.maxStamp | 0, maxItems));
                this._gpuCasterUsed = new Uint8Array(Math.max(1, caps.maxSun | 0, maxItems));
                this._gpuKeepIdx = new Uint32Array(Math.max(1, caps.maxStamp | 0, maxItems));
                this._gpuPackOpts = {};
                this._gpuCookieQ = null;
                // E-76 W9: the pack is gpuPack.wasm, on the render-queue memory where both queues live (the scene
                // makes the memory, or does not start).
                if (!data.renderQueueMemory || !data.renderQueueLayout) {
                    throw new Error('[PRE_RENDER] the GPU queue has no render-queue memory: gpuPack.wasm has nothing to pack');
                }
                try {
                    this._gpuPackWasm = await bindGpuPack(data.renderQueueMemory, data.renderQueueLayout);
                } catch (err) {
                    throw new Error(`[PRE_RENDER] gpuPack.wasm did not load: ${err?.message ?? err}`, { cause: err });
                }
                // E-82b: plain sprites in two streams (a nearest atlas, which snaps every pose, keeps 15-float rows).
                this._gpuSplit = true;
                this._gpuStaticGen.fill(0);
                // E-114: the shadow stamp in WASM, where its scratch and light table are stamp regions (made with
                // shadows and sun casters; without them nothing is stamped).
                this._stampWasm = null;
                if (data.renderQueueMemory && data.renderQueueLayout?.stamp) {
                    this._stampWasm = await bindShadowStamp(data.renderQueueMemory, data.renderQueueLayout.stamp);
                }
                const cookieN = Math.max(1, caps.maxCookie | 0);
                if (cookieN > 0) {
                    // A render queue of the cookies' rows: in the stamp's regions of the render-queue memory when it
                    // has them (with shadows), where the pack kernel packs it; else views of a buffer of its own.
                    const st = data.renderQueueLayout?.stamp;
                    const inMemory = data.renderQueueMemory && st && st.cookieQueueByte >= 0 && st.cookies >= cookieN;
                    const cv = inMemory
                        ? createRenderQueueViews(data.renderQueueMemory.buffer, cookieN, st.cookieQueueByte)
                        : createRenderQueueViews(new SharedArrayBuffer(computeBufferSize(cookieN)), cookieN, 0);
                    cv.rotC.fill(1);
                    cv.anchorX.fill(0.5);
                    cv.anchorY.fill(0.5);
                    cv.tint.fill(0xffffff);
                    this._gpuCookieQ = {
                        count: 0,
                        x: cv.x, y: cv.y, scaleX: cv.scaleX, scaleY: cv.scaleY, rotC: cv.rotC, rotS: cv.rotS,
                        alpha: cv.alpha, tint: cv.tint, textureId: cv.textureId, anchorX: cv.anchorX, anchorY: cv.anchorY,
                        // No tiling, no shadow terms: zeros the kernel reads as the JS reads absent columns.
                        tileMulX: cv.tileMulX, tileMulY: cv.tileMulY, tileOffsetU: cv.tileOffsetU, tileOffsetV: cv.tileOffsetV,
                        shadowH: cv.shadowH, shadowOffX: cv.shadowOffX, shadowOffY: cv.shadowOffY,
                    };
                }
                this._gpuCounts = { sprite: 0, glow: 0, sun: 0, stamp: 0, cookie: 0, particle: 0 };
                this._gpuPainter = this._ySort && this._gpuPainterWasm ? createWasmPainterState(this._gpuPainterWasm) : null;
                this._atlasNearest = (rendererConfig.atlasScaleMode || RENDERER_DEFAULTS.atlasScaleMode) === 'nearest';
            }

            // Initialize per-custom-layer collectors and render queue buffers
            // Indexed by layerId for O(1) lookup in collectRenderable()
            this._customLayerCollectors = {};
            this._customLayerQueueBuffers = {};
            this._customLayerQueueRefs = {};
            // Flat cached arrays for zero-alloc iteration in hot paths
            this._customLayerEntries = [];

            if (data.customLayerRenderQueues) {
                for (const [idStr, lrq] of Object.entries(data.customLayerRenderQueues)) {
                    const layerId = parseInt(idStr);
                    const layerMax = lrq.maxItems;

                    // The collector with its pose stash, as the entities' (E-98d): the emit reads the poses the
                    // collect took. In the render-queue memory when it holds the layer (close-out group B), where the
                    // emit kernel reads them (CUSTOM_COLLECTOR_ROW_BYTES a row).
                    const at = lrq.collectorByte | 0;
                    const inMemory = lrq.collectorByte >= 0 && lrq.dataA === data.renderQueueMemory?.buffer;
                    const f32 = (k) => (inMemory ? new Float32Array(lrq.dataA, at + k * 4 * layerMax, layerMax) : new Float32Array(layerMax));
                    const collector = {
                        y: f32(0),
                        type: inMemory ? new Uint8Array(lrq.dataA, at + 24 * layerMax, layerMax) : new Uint8Array(layerMax),
                        index: inMemory ? new Int32Array(lrq.dataA, at + 4 * layerMax, layerMax) : new Int32Array(layerMax),
                        stashX: f32(2),
                        stashY: f32(3),
                        stashRotC: f32(4),
                        stashRotS: f32(5),
                        count: 0,
                        maxItems: layerMax,
                        ySorting: Layer.getById(layerId)?.ySorting !== false,
                        _overflowWarned: false,
                    };
                    this._customLayerCollectors[layerId] = collector;

                    const bufs = [
                        createRenderQueueViews(lrq.dataA, layerMax, lrq.dataAByte | 0),
                        createRenderQueueViews(lrq.dataB, layerMax, lrq.dataBByte | 0),
                    ];
                    this._customLayerQueueBuffers[layerId] = bufs;
                    this._customLayerQueueRefs[layerId] = {};

                    this._customLayerEntries.push({ layerId, collector, bufs, ref: null });
                }
            }
        }

        // ========================================
        // TEXTURE METADATA - Initialize
        // ========================================
        if (data.textureMetadata) {
            this.animationFrameStart = data.textureMetadata.animationFrameStart;
            this.animationFrameCount = data.textureMetadata.animationFrameCount;
            this.proxyToGlobalAnim = data.textureMetadata.proxyToGlobalAnim;
            this.animationNameToIndex = data.textureMetadata.animationNameToIndex;
            this.frameWidth = data.textureMetadata.frameWidth;   // Uint16Array[textureId]
            this.frameHeight = data.textureMetadata.frameHeight; // Uint16Array[textureId]
            // E-112: the kernel's copy of it (u8 sheets and states, u16 textures: valid metadata always fits).
            if (this._emitWasm !== null && !writeEmitTextures(this._emitWasm, data.textureMetadata)) {
                throw new Error('[PRE_RENDER] the texture metadata does not fit the emit kernel\'s tables (a sheet past 255, '
                    + 'more than 65 536 animations or frames, or a hole in animationFrameStart/animationFrameCount)');
            }
        }

        // Component SoA views are per-scene. Drop the cached sort-line binding
        // so it can never outlive them (a cached null would silently pin every
        // sort line to the pose for the rest of the session).
        this._spriteSortArrays = null;

        if (
            data.shadows &&
            data.shadows.enabled &&
            data.buffers?.componentData?.ShadowCaster
        ) {
            this.shadowsEnabled = true;
            this.maxShadowCastingLights = data.shadows.maxShadowCastingLights;
            this.maxShadowsPerLight = data.shadows.maxShadowsPerLight;
            this.maxShadowsPerEntity = data.shadows.maxShadowsPerEntity || 0;
            this.shadowUpdateInterval = (data.shadows.shadowUpdateInterval | 0)
                || (this.config.lighting?.shadowUpdateInterval | 0)
                || 1;
            this.adaptiveShadowBudget = this.config.lighting?.adaptiveShadowBudget !== false;
            this._shadowUpdateTick = 0;
        }

        // ========================================
        // VISIBLE LIGHTS BUFFER - Initialize
        // ========================================
        // Written here, read by pixi (avoids duplicate queryActiveEntities)
        if (data.buffers?.visibleLightsData) {
            this.visibleLightsData = new Uint16Array(data.buffers.visibleLightsData);
            const lightCap = Math.max(1, this.visibleLightsData.length - 1);
            this._sortedLightEntities = new Array(lightCap);
            this._lightPersistScratch = new Array(lightCap);
            this._lightFlashScratch = new Array(lightCap);
            this._stampLights = new Array(lightCap);
            // Every field _collectStampLights writes, the doubles as doubles: a field added or turned from
            // a small integer to a double in the frame loop moves the slot to a new map (N-32).
            for (let i = 0; i < lightCap; i++) {
                this._stampLights[i] = {
                    id: 0, x: NaN, y: NaN, intensity: NaN, rangeSq: NaN, sqrtI: NaN, distSq: NaN, maxShadows: 0,
                };
            }
        }

        // ========================================
        // SUN SYSTEM - Initialize
        // ========================================
        // Note: Sun static class is initialized by AbstractWorker.initializeCommonBuffers()
        // Shadow values are precomputed in Sun.setTimeOfDay (Scene advances time)
        if (Sun.isInitialized) {
            this.sunEnabled = Sun.enabled;
        }

        // ========================================
        // VISIBILITY POLYGONS - Initialize (raycasted light occlusion)
        // ========================================
        this.visibilityPolygonsEnabled = false;
        // W2a: a previous scene's visibility memory goes, and the polar bins are angularSweep.js' own until the
        // next binds them.
        this._visSweep = null;
        this._visMemory = null;
        this._visCollectSolid = collectSolidRefused;
        this._visGather = null;
        unbindSolidSegments();
        bindPolarBins(null, null);
        if (
            data.visibilityPolygons &&
            data.visibilityPolygons.enabled &&
            data.visibilityPolygons.dataA &&
            data.visibilityPolygons.dataB &&
            data.buffers?.componentData?.LightOccluder
        ) {
            this.visibilityPolygonsEnabled = true;
            this._vpMaxLights = data.visibilityPolygons.maxLights;
            this._vpMaxVerts = data.visibilityPolygons.maxPolygonVertices;
            const maxVerts = this._vpMaxVerts;
            const maxLts = this._vpMaxLights;
            // Per-light slot size in Float32 elements: lightIdx(1 int32) + lightX,lightY(2 float32) + vertexCount(1 int32) + x[N] + y[N]
            // In bytes: 4 + 8 + 4 + N*4*2 = 16 + N*8
            this._vpSlotBytes = 16 + maxVerts * 8;

            const sabs = [data.visibilityPolygons.dataA, data.visibilityPolygons.dataB];
            this._vpBuffers = [];
            for (let b = 0; b < 2; b++) {
                const sab = sabs[b];
                this._vpBuffers[b] = {
                    sab,
                    header: new Int32Array(sab, 0, 1),    // totalLights count
                    i32: new Int32Array(sab),
                    f32: new Float32Array(sab),
                };
            }
            this._vpWriteBuffer = this._vpBuffers[0];
            if (this._selfLitBuffers) {
                this._selfLitWriteBuffer = this._selfLitBuffers[0];
            }

            // Scratch arrays for collecting nearby occluders (circle + convex)
            const maxOccluders = VISIBILITY_MAX_OCCLUDERS;
            // Max verts: 4 per box, MAX_POLYGON_VERTICES per poly, rare all-poly worst case
            const poolVerts = maxOccluders * MAX_POLYGON_VERTICES;
            // W2a: the scratch below, the polar bins and the seen stamps are views on a visibility memory, where
            // visibilitySweep.wasm reads them (a memory that cannot be made, or a kernel that does not load, is an
            // init error).
            const vm = await this._bindVisibilitySweep(maxVerts, data);
            this._vpOccKind = vm.kind;
            this._vpCircleX = vm.cx;
            this._vpCircleY = vm.cy;
            this._vpCircleR = vm.cr;
            this._vpVertStart = vm.vertStart;
            this._vpVertCount = vm.vertCount;
            this._vpVertsX = vm.vertsX;
            this._vpVertsY = vm.vertsY;
            this._vpMaxOccluders = maxOccluders;

            // Output scratch for polygon vertices
            this._vpOutX = vm.outX;
            this._vpOutY = vm.outY;

            // Self-lit queue (entity under own occluder fill)
            this._selfLitMax = data.visibilityPolygons.maxOccluderSelfLit || 512;
            this._selfLitItemBytes = 28;
            this._selfLitSolid = new Uint8Array(this._selfLitMax);
            this._selfLitOcc = new Int32Array(this._selfLitMax);
            this._selfLitSeen = vm.ownerSeen;
            const selfLitSabs = [
                data.visibilityPolygons.selfLitDataA,
                data.visibilityPolygons.selfLitDataB,
            ];
            this._selfLitBuffers = [null, null];
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

        }
    }

    /**
     * W2a. Make the visibility memory (src/util/visibilityMemory.js: the light's gather and polygon, the polar
     * bins, the seen stamps, the sweep's scratch) and bind visibilitySweep.wasm on it (wasm.visibilitySweepF32
     * picks the float32 sweep or the double SIMD one). Returns the views the scratch binds to; a memory that cannot
     * be made or a kernel that does not load is an error.
     * W1: with a fixture pool the memory also holds the compound solids' outlines, and solidSegments.wasm rasters
     * them into its bins.
     * W2b: when the scene laid the gather's regions in the engine block with these options, the memory is placed
     * there and visibilityGather.wasm is bound on it; otherwise it is a memory of its own and the JS gathers.
     */
    async _bindVisibilitySweep(maxVerts, data) {
        const opts = visibilityMemoryOpts({
            maxVerts,
            entities: this.globalEntityCount,
            fixtures: ColliderFixture.maxCount | 0,
        });
        const v = data.renderQueueLayout?.collect?.visibility || null;
        const memory = data.renderQueueMemory || null;
        const sameOpts = (a, b) => a.maxOccluders === b.maxOccluders && a.poolVerts === b.poolVerts
            && a.maxVerts === b.maxVerts && a.entities === b.entities && a.fixtures === b.fixtures;
        let place = v && memory && sameOpts(v.opts, opts) ? { memory, baseByte: v.byte } : null;
        let vm = createVisibilityMemory(opts, place);
        if (!vm && place) {
            place = null;
            vm = createVisibilityMemory(opts, null);
        }
        if (!vm) {
            throw new Error('[PRE_RENDER] the visibility memory could not be made (a shared WebAssembly.Memory was refused): '
                + 'raycasted lighting needs it');
        }
        let sweep;
        try {
            sweep = await bindVisibilitySweep(vm, { maxVerts, f32: this.config?.wasm?.visibilitySweepF32 !== false });
        } catch (err) {
            throw new Error(`[PRE_RENDER] visibilitySweep.wasm did not load: ${err?.message ?? err}`, { cause: err });
        }
        this._visSweep = sweep;
        this._visMemory = vm.memory;
        bindPolarBins(vm.views.polarDist, vm.views.polarOwner);
        if (vm.layout.solidBytes > 0) {
            try {
                if (await bindSolidSegments(vm)) this._visCollectSolid = collectSolidWasm;
            } catch (err) {
                throw new Error(`[PRE_RENDER] solidSegments.wasm did not load: ${err?.message ?? err}`, { cause: err });
            }
        }
        if (place) {
            try {
                this._visGather = await bindVisibilityGather(memory, v, vm);
            } catch (err) {
                throw new Error(`[PRE_RENDER] visibilityGather.wasm did not load: ${err?.message ?? err}`, { cause: err });
            }
        }
        return vm.views;
    }

    /**
     * Set the current write buffer for main render queue
     * @param {number} bufferIdx - 0 or 1
     */
    _setWriteBuffer(bufferIdx) {
        const buffer = this.renderQueueBuffers[bufferIdx];
        if (!buffer) return;

        this.renderQueueCount = buffer.count;
        this.renderQueueStaticGen = buffer.staticGen || EMPTY_U32;
        this.renderQueueX = buffer.x;
        this.renderQueueY = buffer.y;
        this.renderQueueShadowH = buffer.shadowH;
        this.renderQueueShadowOffX = buffer.shadowOffX;
        this.renderQueueShadowOffY = buffer.shadowOffY;
        this.renderQueueScaleX = buffer.scaleX;
        this.renderQueueScaleY = buffer.scaleY;
        this.renderQueueRotC = buffer.rotC;
        this.renderQueueRotS = buffer.rotS;
        this.renderQueueAlpha = buffer.alpha;
        this.renderQueueTint = buffer.tint;
        this.renderQueueTextureId = buffer.textureId;
        this.renderQueueAnchorX = buffer.anchorX;
        this.renderQueueAnchorY = buffer.anchorY;
        this.renderQueueType = buffer.type;
        this.renderQueueSortKey = buffer.sortKey;
        this.renderQueueSortKeyU32 = buffer.sortKeyU32;
        this.renderQueueRepeatX = buffer.repeatX;
        this.renderQueueRepeatY = buffer.repeatY;
        this.renderQueueTileMode = buffer.tileMode;
        this.renderQueueTileOffsetU = buffer.tileOffsetU;
        this.renderQueueTileOffsetV = buffer.tileOffsetV;
        this.renderQueueTileMulX = buffer.tileMulX;
        this.renderQueueTileMulY = buffer.tileMulY;
        this.renderQueueCamera = this.renderQueueCameraBuffers[bufferIdx];
        this.renderQueuePoseReady = this.renderQueuePoseReadyBuffers[bufferIdx];

        // Swap custom layer write buffers in sync
        const entries = this._customLayerEntries;
        if (entries) {
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                e.ref = e.bufs[bufferIdx];
                this._customLayerQueueRefs[e.layerId] = e.ref;
            }
        }
    }

    latchPhysicsPose() {
        this._latchPose();
        if (this.renderQueuePoseReady) this.renderQueuePoseReady[0] = this._poseReadyFrame;
    }

    collectVisibleLights() {
        this._collectVisibleLights();
    }

    pixiIsMoreThanOneFrameBehind() {
        if (!this.backpressure || !this.renderQueueSync || this.renderQueueFrame <= 0) return false;
        const consumedFrame = Atomics.load(this.renderQueueSync, 1);
        return this.renderQueueFrame > consumedFrame + 1;
    }

    selectWriteBuffers() {
        if (!this.renderQueueEnabled) return;
        const writeBufferIndex = this._queueBuf;
        this._setWriteBuffer(writeBufferIndex);
        if (this.visibilityPolygonsEnabled) {
            this._vpWriteBuffer = this._vpBuffers[writeBufferIndex];
            if (this._selfLitBuffers) {
                this._selfLitWriteBuffer = this._selfLitBuffers[writeBufferIndex];
            }
        }
    }

    latchCamera(simMs = 0) {
        if (!this.cameraData) return;
        const cam = Camera.resolveDrawnCamera(this._poseX, this._poseY, this._drawnCam);
        const shake = Camera.advanceShake(simMs);
        this._frameCameraZoom = cam.zoom;
        this._frameCameraX = cam.x + shake.x;
        this._frameCameraY = cam.y + shake.y;
        this._frameCameraRot = cam.rotation;
        if (this.renderQueueCamera) {
            this.renderQueueCamera[0] = this._frameCameraZoom;
            this.renderQueueCamera[1] = this._frameCameraX;
            this.renderQueueCamera[2] = this._frameCameraY;
            if (this.renderQueueCamera.length > 3) {
                this.renderQueueCamera[3] = this._frameCameraRot || 0;
            }
        }
    }

    resetFrameCounters() {
        this.visibleEntitiesCount = 0;
        this.visibleParticlesCount = 0;
        this.visibleDecorationsCount = 0;
        this.shadowsUpdatedThisFrame = 0;
        this._renderableCount = 0;
        this._entitySortY = this._entityYSort();
        const zoom = this._frameCameraZoom;
        if (zoom >= this.decorationFadeStartZoom) this._decorationZoomAlpha = 1;
        else if (zoom <= this.decorationHideZoom) this._decorationZoomAlpha = 0;
        else this._decorationZoomAlpha = (zoom - this.decorationHideZoom) / (this.decorationFadeStartZoom - this.decorationHideZoom);
        this._emitWriteCount = 0;
        this._frameCameraBoundsValid = this.cameraData !== null;
        if (this._frameCameraBoundsValid) this.calculateCameraBounds();
        this.collectTimeThisFrame = 0;
        this.sortTimeThisFrame = 0;
        this.emitTimeThisFrame = 0;
        this.customLayerTimeThisFrame = 0;
        this.spritePackTimeThisFrame = 0;
        this.shadowQTimeThisFrame = 0;
        this.visibilityTimeThisFrame = 0;
        this.adobeTimeThisFrame = 0;
        // E-29.
        this.visibleLightsTimeThisFrame = 0;
        this.stampLightsTimeThisFrame = 0;
    }

    packSpriteAndShadowQueues() {
        if (!this.gpuQueueBuffers) return;
        this._packGpuQueues(this.gpuQueueBuffers[this._queueBuf]);
    }

    publishFrame() {
        if (!this.renderQueueSync) return;
        this.renderQueueFrame++;
        this._queueBuf ^= 1;
        Atomics.store(this.renderQueueSync, 0, this.renderQueueFrame);
        Atomics.notify(this.renderQueueSync, 0, 1);
    }

    /**
     * Update method called each frame
     */
    update(deltaTime, dtRatio) {
        this.skippedFramesThisFrame = 0;
        if (this.pixiIsMoreThanOneFrameBehind()) {
            this.skippedFramesThisFrame = 1;
            return;
        }
        this.selectWriteBuffers();
        this.latchPhysicsPose();
        this.latchCamera(deltaTime);
        this.resetFrameCounters();
        this._frameAdobeEntities = AdobeAnimComponent.active
            ? Query.queryActiveEntities(this._queryAdobeAnim || [AdobeAnimComponent])
            : (this._emptyAdobeEntities || (this._emptyAdobeEntities = []));
        this._bindCollectPoses();

        const detail = this.collectDetailedStats;
        let started = 0;
        if (detail) started = performance.now();
        this.advanceAdobeAnimations(deltaTime);
        if (detail) this.adobeTimeThisFrame = performance.now() - started;

        if (detail) started = performance.now();
        this.collectVisibleParticles();
        this.collectVisibleLiquidFun();
        this.collectVisibleEntities();
        this.collectVisibleAdobeAnimations();
        this.collectVisibleDecorations();
        this.collectVisibleBullets();
        if (detail) this.collectTimeThisFrame = performance.now() - started;

        this.buildRenderQueue(deltaTime);

        if (detail) started = performance.now();
        this.buildCustomLayerQueues(deltaTime);
        if (detail) this.customLayerTimeThisFrame = performance.now() - started;

        // E-29. This call had no timer and belonged to no existing one. It runs after
        // `buildCustomLayerQueues` (whose COLLECT/CUSTOM_LAYER_MS windows both closed at
        // the line above) and before `buildVisibilityPolygons` (whose VISIBILITY_MS window
        // opens below), so its cost landed in a gap that no published stat covered. On a
        // frame where the light list is long that gap was real money, and there was no way
        // to see it. Gated on `detail` like every other sub-timer: two performance.now()
        // calls per frame is not free when you only want them when someone is looking.
        const detailLights = this.collectDetailedStats;
        let tLights = 0;
        if (detailLights) tLights = performance.now();
        this.collectVisibleLights();
        if (detailLights) this.visibleLightsTimeThisFrame = performance.now() - tLights;

        this.packSpriteAndShadowQueues();

        if (detail) started = performance.now();
        this.buildVisibilityPolygons();
        if (detail) this.visibilityTimeThisFrame = performance.now() - started;

        this.publishFrame();
    }

    _applyMainColumns(views) {
        if (!views) return;
        this.renderQueueCount = views.count;
        this.renderQueueX = views.x;
        this.renderQueueY = views.y;
        this.renderQueueScaleX = views.scaleX;
        this.renderQueueScaleY = views.scaleY;
        this.renderQueueRotC = views.rotC;
        this.renderQueueRotS = views.rotS;
        this.renderQueueAlpha = views.alpha;
        this.renderQueueTint = views.tint;
        this.renderQueueTextureId = views.textureId;
        this.renderQueueAnchorX = views.anchorX;
        this.renderQueueAnchorY = views.anchorY;
        this.renderQueueType = views.type;
        this.renderQueueSortKey = views.sortKey;
        this.renderQueueSortKeyU32 = views.sortKeyU32;
        this.renderQueueRepeatX = views.repeatX;
        this.renderQueueRepeatY = views.repeatY;
        this.renderQueueTileMode = views.tileMode;
        this.renderQueueTileOffsetU = views.tileOffsetU;
        this.renderQueueTileOffsetV = views.tileOffsetV;
        this.renderQueueTileMulX = views.tileMulX;
        this.renderQueueTileMulY = views.tileMulY;
        this.renderQueueShadowH = views.shadowH;
        this.renderQueueShadowOffX = views.shadowOffX;
        this.renderQueueShadowOffY = views.shadowOffY;
    }

    _mainColumnSnapshot() {
        const saved = this._columnSnapshot || (this._columnSnapshot = {});
        saved.count = this.renderQueueCount;
        saved.x = this.renderQueueX;
        saved.y = this.renderQueueY;
        saved.scaleX = this.renderQueueScaleX;
        saved.scaleY = this.renderQueueScaleY;
        saved.rotC = this.renderQueueRotC;
        saved.rotS = this.renderQueueRotS;
        saved.alpha = this.renderQueueAlpha;
        saved.tint = this.renderQueueTint;
        saved.textureId = this.renderQueueTextureId;
        saved.anchorX = this.renderQueueAnchorX;
        saved.anchorY = this.renderQueueAnchorY;
        saved.type = this.renderQueueType;
        saved.sortKey = this.renderQueueSortKey;
        saved.sortKeyU32 = this.renderQueueSortKeyU32;
        saved.repeatX = this.renderQueueRepeatX;
        saved.repeatY = this.renderQueueRepeatY;
        saved.tileMode = this.renderQueueTileMode;
        saved.tileOffsetU = this.renderQueueTileOffsetU;
        saved.tileOffsetV = this.renderQueueTileOffsetV;
        saved.tileMulX = this.renderQueueTileMulX;
        saved.tileMulY = this.renderQueueTileMulY;
        saved.shadowH = this.renderQueueShadowH;
        saved.shadowOffX = this.renderQueueShadowOffX;
        saved.shadowOffY = this.renderQueueShadowOffY;
        return saved;
    }

    calculateCameraBounds() {
        if (this.cameraData === null) return null;
        const zoom = this._frameCameraZoom;
        const cameraX = this._frameCameraX;
        const cameraY = this._frameCameraY;

        return calculateCameraScreenBounds(
            zoom,
            cameraX,
            cameraY,
            this.canvasWidth,
            this.canvasHeight,
            this.cullingRatio,
            this._cameraBounds,
            this._frameCameraRot
        );
    }

    /**
     * Collect visible particles for render queue.
     * Uses visibleParticlesData SAB populated by particle_worker.
     */
    collectVisibleParticles() {
        if (this.maxParticles === 0) return;

        const visibleData = this.visibleParticlesData;
        if (!visibleData) return;

        const visibleCount = visibleData[0];
        // renderOnly particles are drawn by their compute layer. Dropped here,
        // before they take a collector slot or a queue row.
        const renderOnly = ParticleComponent.renderOnlyLive &&
            Atomics.load(ParticleComponent.renderOnlyLive, 0) > 0
            ? ParticleComponent.renderOnly
            : null;
        if (!Layer.anyYSorting()) {
            // A particle's key orders it only in a layer that y-sorts: orderSortKey keeps the zIndex alone otherwise,
            // and the emit writes no key. With none this frame they all take one key, and none is computed (its
            // floor and loads cost pre-render 3 % with 65 000 particles in view), in a loop of its own.
            COLLECT_Y[0] = 0;
            for (let idx = 0; idx < visibleCount; idx++) {
                const i = visibleData[1 + idx];
                if (renderOnly && renderOnly[i]) continue;
                this.collectRenderable(1, i);
                this.visibleParticlesCount++;
            }
            return;
        }
        const y = ParticleComponent.y;
        const z = ParticleComponent.z;
        const flat = ParticleComponent.flat;
        const viewMode = ParticleComponent.viewMode;

        for (let idx = 0; idx < visibleCount; idx++) {
            const i = visibleData[1 + idx];
            if (renderOnly && renderOnly[i]) continue;
            const isZenithal =
                viewMode &&
                viewMode[i] === CAMERA_TYPES.ZENITHAL &&
                !(flat && flat[i]);
            // Heighted and flat particles sort by their ground row, as a sprite sorts by its feet: a spark in
            // the air is in front of the tree it flies in front of, though it is drawn at y + z. The row is
            // spriteYSortKey's Math.round(y) written as floor(y + 0.5): the same for every float32 y (the sum is
            // exact in double), and Math.round here cost pre-render 10 % with 38 000 particles in view.
            COLLECT_Y[0] = isZenithal ? -z[i] : Math.floor(y[i] + 0.5) * Y_SORT_K + PARTICLE_SORT_BIAS;
            this.collectRenderable(1, i);
            this.visibleParticlesCount++;
        }
    }

    collectVisibleLiquidFun() {
        const lf = this.liquidFun;
        if (!lf) return;
        const count = lf.count[0] | 0;
        if (count <= 0) return;
        const from = 0;
        const to = count;

        const x = lf.x;
        const y = lf.y;
        const bounds = this._frameCameraBoundsValid ? this.calculateCameraBounds() : null;
        if (!bounds) {
            for (let i = from; i < to; i++) {
                COLLECT_Y[0] = y[i] * Y_SORT_K;
                this.collectRenderable(7, i);
                this.visibleParticlesCount++;
            }
            return;
        }

        const camZoom = bounds.zoom;
        const camOffX = bounds.cameraOffsetX;
        const camOffY = bounds.cameraOffsetY;
        const minX = bounds.minX;
        const maxX = bounds.maxX;
        const minY = bounds.minY;
        const maxY = bounds.maxY;
        for (let i = from; i < to; i++) {
            const sx = x[i] * camZoom - camOffX;
            const sy = y[i] * camZoom - camOffY;
            if (sx > minX && sx < maxX && sy > minY && sy < maxY) {
                COLLECT_Y[0] = y[i] * Y_SORT_K;
                this.collectRenderable(7, i);
                this.visibleParticlesCount++;
            }
        }
    }

    /**
     * Entity visibility + collect for the sprite queue, in preRenderCollect.wasm (W4b, close-out group B): every column
     * it reads is in the render-queue memory (with physics, Phase 4, the bodies' published poses there too; with
     * Y-sort, the emit kernel's frame sizes). A frame it cannot take collects no sprite and pre-render says why once
     * (_collectRefused). The JS loops it replaced are tests/reference/preRenderCollectJs.mjs.
     */
    collectVisibleEntities() {
        if (this.globalEntityCount === 0 || !SpriteRenderer.active || !this.cameraData || !this.renderQueueEnabled) return;
        if (this._collectWasm === null) {
            this._collectRefused('the render-queue memory has no collect regions');
            return;
        }
        if (!writeCollectColumns(this._collectWasm, this, Transform, SpriteRenderer, Collider)) {
            this._collectRefused('a column it reads is outside the render-queue memory');
            return;
        }
        this._collectVisibleEntitiesWasm();
    }

    /** A frame the collect kernel cannot take: no sprite is collected, the reason said once. */
    _collectRefused(reason) {
        if (this._collectRefusedWarned) return;
        this._collectRefusedWarned = true;
        console.error(`[PRE_RENDER] the collect kernel cannot take the sprites (${reason}): they are not drawn`);
    }

    /**
     * W4b. collectVisibleEntities' walk through preRenderCollect.wasm: the iteration source, camera bounds and
     * turned-camera margins, one call for the walk, and for each sprite it hands back (a layer mask, or a sort line
     * whose frame is not resolved yet) collectRenderable before the walk goes on from the next one, so the
     * collectors fill in the walk's order.
     */
    _collectVisibleEntitiesWasm() {
        const cb = this.calculateCameraBounds();
        if (!cb) return;
        const b = this._collectWasm;
        const spriteEntities = Query.queryActiveEntities(this._querySpriteRenderer || [SpriteRenderer]);
        // E-127: with static scenery, the walk of the moving sprites and the static ones in the cells in view.
        const walked = this._staticSceneryWalk(spriteEntities, cb);
        const walk = walked >= 0 ? this._staticGrid.list : spriteEntities;
        const listed = walked >= 0 ? writeCollectList(b, walk, walked) : writeCollectList(b, spriteEntities);
        const count = walked >= 0 ? walked : listed > 0 ? listed : this.globalEntityCount;
        const res = b.results;
        res[0] = this._renderableCount;
        res[1] = 0;
        res[2] = 0;
        const maxItems = this.renderQueueMaxItems;
        // A sprite has no collector key of its own: under Y-sort its sort line (the kernel writes it), else unread (the
        // emit's depth is its zIndex): 0.
        const keyY = 0;
        const zoom = cb.zoom;
        const rot = this._frameCameraRot || 0;
        const turned = rot && !this.skipCull;
        let rc = 0;
        let rs = 0;
        let halfCw = 0;
        let halfCh = 0;
        let limW = 0;
        let limH = 0;
        if (turned) {
            rc = Math.cos(rot);
            rs = Math.sin(rot);
            halfCw = this.canvasWidth * 0.5;
            halfCh = this.canvasHeight * 0.5;
            const marginScale = zoom < 1 ? zoom : 1;
            limW = halfCw + this.canvasWidth * this.cullingRatio * marginScale;
            limH = halfCh + this.canvasHeight * this.cullingRatio * marginScale;
        }
        const mode = b.mode;
        const alpha = this._poseAlpha;
        let visible = 0;
        let from = 0;
        for (;;) {
            const stop = turned
                ? b.collectSpritesTurned(b.tableByte, from, count, maxItems, keyY, zoom, cb.cameraOffsetX,
                    cb.cameraOffsetY, halfCw, halfCh, rc, rs, limW, limH, mode, alpha, Y_SORT_K)
                : b.collectSprites(b.tableByte, from, count, maxItems, this.skipCull ? 1 : 0, keyY, zoom,
                    cb.cameraOffsetX, cb.cameraOffsetY, cb.minX, cb.maxX, cb.minY, cb.maxY, mode, alpha, Y_SORT_K);
            if (stop >= count) break;
            this._renderableCount = res[0];
            this.collectRenderable(0, listed > 0 ? walk[stop] : stop);
            res[0] = this._renderableCount;
            visible++;
            from = stop + 1;
        }
        this._renderableCount = res[0];
        if (res[2]) this._collectorFull();
        this.visibleEntitiesCount += visible + res[1];
        this._collectEntityGlow(Transform.x, Transform.y, Collider.visualRange, zoom, cb.cameraOffsetX,
            cb.cameraOffsetY, cb.minX, cb.maxX, cb.minY, cb.maxY);
    }

    /**
     * E-127. The collect's walk with the static scenery culled by its grid: the published sprite list's moving
     * entities and the static ones in the cells that meet the view (widened by the largest static half extent), in
     * entity order, in this._staticGrid.list. Returns its length, or -1 when the collect walks the list as given
     * (no static types, the cull off, or no published list). The grid is binned again when the static counter moved;
     * the counter is read after the list, so a static entity the list holds was binned.
     */
    _staticSceneryWalk(spriteEntities, cb) {
        const grid = this._staticGrid;
        if (!grid.enabled || this.skipCull || !cb || !spriteEntities || spriteEntities.length === 0) return -1;
        const gen = staticSceneryGen();
        if (gen !== grid.builtGen) {
            grid.build(gen, this.config?.worldWidth || 0, this.config?.worldHeight || 0, Transform.active,
                Transform.x, Transform.y, SpriteRenderer.boundsHalfW, SpriteRenderer.boundsHalfH, Collider.visualRange);
        }
        const zoom = cb.zoom;
        const half = grid.maxHalf;
        const rot = this._frameCameraRot || 0;
        let minX;
        let maxX;
        let minY;
        let maxY;
        if (rot) {
            // The turned camera's test (collectVisibleEntities) in view space, its box turned back into the world.
            const rc = Math.abs(Math.cos(rot));
            const rs = Math.abs(Math.sin(rot));
            const marginScale = zoom < 1 ? zoom : 1;
            const halfCw = this.canvasWidth * 0.5;
            const halfCh = this.canvasHeight * 0.5;
            const w = halfCw + this.canvasWidth * this.cullingRatio * marginScale + half * zoom;
            const h = halfCh + this.canvasHeight * this.cullingRatio * marginScale + half * zoom;
            const cx = (cb.cameraOffsetX + halfCw) / zoom;
            const cy = (cb.cameraOffsetY + halfCh) / zoom;
            const hx = (rc * w + rs * h) / zoom + 1;
            const hy = (rs * w + rc * h) / zoom + 1;
            minX = cx - hx;
            maxX = cx + hx;
            minY = cy - hy;
            maxY = cy + hy;
        } else {
            minX = (cb.minX + cb.cameraOffsetX) / zoom - half - 1;
            maxX = (cb.maxX + cb.cameraOffsetX) / zoom + half + 1;
            minY = (cb.minY + cb.cameraOffsetY) / zoom - half - 1;
            maxY = (cb.maxY + cb.cameraOffsetY) / zoom + half + 1;
        }
        return grid.walk(spriteEntities, spriteEntities.length, minX, minY, maxX, maxY);
    }

    _collectEntityGlow(x, y, visualRange, camZoom, cameraOffsetX, cameraOffsetY,
        screenMinX, screenMaxX, screenMinY, screenMaxY) {
        const MIN_GLOW_INTENSITY = 50;
        const MIN_GLOW_RANGE = 2.5;
        this._syncGlowLayer();
        if (this._glowEmit && this._queryLightEmitter && LightEmitter.active && LightEmitter.hasGlowSprite) {
            const lights = Query.queryActiveEntities(this._queryLightEmitter);
            if (lights && lights.length > 0) {
                const leActive = LightEmitter.active;
                const leGlow = LightEmitter.hasGlowSprite;
                const leIntensity = LightEmitter.lightIntensity;
                const leSqrt = LightEmitter.sqrtLightIntensity;
                // H-19, same hoist as collectVisibleEntities, and worse here:
                // `SpriteRenderer.boundsHalfW?.[i]` was a static property lookup
                // plus an optional chain PER LIGHT, not just a truthiness test.
                const skipCull = this.skipCull;
                const glowHalfW = SpriteRenderer.boundsHalfW;
                const glowHalfH = SpriteRenderer.boundsHalfH;
                for (let li = 0; li < lights.length; li++) {
                    const i = lights[li];
                    if (!leActive[i] || !leGlow[i]) continue;
                    if (leIntensity[i] < MIN_GLOW_INTENSITY) continue;
                    if ((visualRange[i] || leSqrt[i] || 200) < MIN_GLOW_RANGE) continue;
                    if (!skipCull) {
                        const sx = x[i] * camZoom - cameraOffsetX;
                        const sy = y[i] * camZoom - cameraOffsetY;
                        let halfExtent = 0;
                        const halfW = glowHalfW ? (glowHalfW[i] ?? 0) : 0;
                        const halfH = glowHalfH ? (glowHalfH[i] ?? 0) : 0;
                        if (halfW > 0 || halfH > 0) halfExtent = halfW > halfH ? halfW : halfH;
                        if (halfExtent <= 0) halfExtent = visualRange[i] || 0;
                        const extent = halfExtent * camZoom;
                        if (
                            sx < screenMinX - extent || sx > screenMaxX + extent ||
                            sy < screenMinY - extent || sy > screenMaxY + extent
                        ) continue;
                    }
                    COLLECT_Y[0] = y[i] * Y_SORT_K + ENTITY_GLOW_SORT_BIAS;
                    this.collectRenderable(3, i);
                }
            }
        }
    }

    /** Types whose class defines onAnimationEnd (main computed it per registered class). */
    _bindAnimationEndTypes(registeredClasses) {
        const list = registeredClasses || [];
        let maxType = -1;
        for (let r = 0; r < list.length; r++) if (list[r].entityType > maxType) maxType = list[r].entityType;
        this._animEndByType = new Uint8Array(maxType + 1);
        let any = false;
        for (let r = 0; r < list.length; r++) {
            if (list[r].animationEnd) {
                this._animEndByType[list[r].entityType] = 1;
                any = true;
            }
        }
        const n = any ? this.globalEntityCount | 0 : 0;
        this._animEndAnim = new Uint16Array(n);
        this._animEndGen = new Uint16Array(n);
    }

    /** Report once per (animation, spawn): the last frame is held, so this runs again every frame duration. */
    _spriteAnimationEnded(idx, animState) {
        if (idx >= this._animEndAnim.length) return;
        const anim = (animState + 1) & 0xffff;
        const gen = idx < Messages.spawnGen.length ? Messages.spawnGen[idx] : 0;
        if (this._animEndAnim[idx] === anim && this._animEndGen[idx] === gen) return;
        this._animEndAnim[idx] = anim;
        this._animEndGen[idx] = gen;
        Messages.sendSystem(idx, MESSAGE_ANIMATION_END, 0, animState);
    }

    /** A play-once Adobe clip reached its end (playing went 0, so this runs once per play). */
    _adobeAnimationEnded(i) {
        if (this._animEndByType[Transform.entityType[i]] !== 1) return;
        Messages.sendSystem(i, MESSAGE_ANIMATION_END, 1, AdobeAnimComponent.clipId[i]);
    }

    /** The frame's Adobe clocks, in preRenderEmit.wasm (adobe_advance, W27); the JS loop is tests/reference/preRenderEmitJs.mjs. */
    advanceAdobeAnimations(deltaTime) {
        // No render queue (nothing to draw): no kernel, and nothing to advance for.
        if (!AdobeAnimComponent.active || this._emitWasm === null) return;
        const deltaSeconds = deltaTime / 1000;
        if (deltaSeconds <= 0) return;
        const adobeEntities = this._frameAdobeEntities;
        if (!adobeEntities || adobeEntities.length === 0) return;
        if (!this._emitWasm.adobe || !this._advanceAdobeWasm(adobeEntities, deltaSeconds)) {
            this._emitRefused("the Adobe clocks (AdobeAnimComponent outside the memory, or no asset tables)");
        }
    }

    /**
     * W27. advanceAdobeAnimations' loop in preRenderEmit.wasm (adobe_advance), on the frame's Adobe entities copied
     * into its list; the ended play-once clips come back in order and get their end message here. False when the
     * kernel cannot take the frame (AdobeAnimComponent or an asset a playing clock reads not in its tables): the JS
     * loop runs it.
     */
    _advanceAdobeWasm(adobeEntities, deltaSeconds) {
        const b = this._emitWasm;
        const assets = AdobeAnimRegistry.assetById;
        if (assets !== b.adobeFrom || assets.length !== b.adobeAssets) this._copyEmitAdobeAssets();
        const n = adobeEntities.length;
        if (n > b.adobeListCap || !writeEmitAdobeColumns(b, AdobeAnimComponent, true)) return false;
        const list = b.adobeList;
        list.set(adobeEntities);
        const ended = b.adobeAdvance(b.tableByte, n, deltaSeconds);
        if (ended === EMIT_DECLINED) return false;
        for (let k = 0; k < ended; k++) this._adobeAnimationEnded(list[k]);
        return true;
    }

    collectVisibleAdobeAnimations() {
        if (this.globalEntityCount === 0 || !AdobeAnimComponent.active || !this._frameCameraBoundsValid) return;

        const cameraBounds = this._cameraBounds;

        const x = Transform.x;
        const y = Transform.y;
        const active = Transform.active;
        const adobeActive = AdobeAnimComponent.active;
        const renderVisible = AdobeAnimComponent.renderVisible;
        const halfW = AdobeAnimComponent.boundsHalfW;
        const halfH = AdobeAnimComponent.boundsHalfH;

        const camZoom = cameraBounds.zoom;
        const cameraOffsetX = cameraBounds.cameraOffsetX;
        const cameraOffsetY = cameraBounds.cameraOffsetY;
        const screenMinX = cameraBounds.minX;
        const screenMaxX = cameraBounds.maxX;
        const screenMinY = cameraBounds.minY;
        const screenMaxY = cameraBounds.maxY;

        const adobeEntities = this._frameAdobeEntities;
        if (!adobeEntities || adobeEntities.length === 0) return;

        for (let idx = 0; idx < adobeEntities.length; idx++) {
            const i = adobeEntities[idx];
            if (!active[i] || !adobeActive[i]) continue;

            if (!this.skipCull) {
                const sx = x[i] * camZoom - cameraOffsetX;
                const sy = y[i] * camZoom - cameraOffsetY;

                const extent = (halfW[i] > halfH[i] ? halfW[i] : halfH[i]) * camZoom;
                const onScreen =
                    sx >= screenMinX - extent &&
                    sx <= screenMaxX + extent &&
                    sy >= screenMinY - extent &&
                    sy <= screenMaxY + extent;

                if (!onScreen) continue;
            }

            if (renderVisible[i]) {
                this.collectRenderable(6, i);
                this.visibleEntitiesCount++;
            }
        }
    }

    /**
     * Collect visible decorations for render queue.
     * Uses visibleDecorationsData SAB from particle_worker.
     * (Grid membership is maintained for light queries; collect stays on the
     * particle visible list so decoration load matches the linear path.)
     */
    collectVisibleDecorations() {
        if (!this.maxDecorations || this.maxDecorations === 0 || !DecorationComponent.active) return;
        if (this._decorationZoomAlpha <= 0) return;

        const visibleData = this.visibleDecorationsData;
        if (!visibleData) return;

        const visibleCount = visibleData[0];
        const y = DecorationComponent.y;
        const parentEntityIndex = DecorationComponent.parentEntityIndex;
        const innerZ = DecorationComponent.innerZ;
        const ty = Transform.y;
        const tActive = Transform.active;

        for (let idx = 0; idx < visibleCount; idx++) {
            const i = visibleData[1 + idx];
            const p = parentEntityIndex[i];
            let sortY;
            if (p !== this._noParent && tActive[p]) {
                sortY = ty[p] * Y_SORT_K + innerZ[i];
            } else {
                sortY = y[i] * Y_SORT_K + innerZ[i];
            }
            COLLECT_Y[0] = sortY;
            this.collectRenderable(2, i);
            this.visibleDecorationsCount++;
        }
    }

    /**
     * Collect visible bullets for render queue
     * Uses visibleBulletsData SAB populated by particle_worker
     */
    collectVisibleBullets() {
        if (!this.maxBullets || this.maxBullets === 0 || !BulletComponent.active) return;

        const visibleData = this.visibleBulletsData;
        if (!visibleData) return;

        // collectRenderable queues nothing then.
        if (!this.renderQueueEnabled) return;

        const visibleCount = visibleData[0];
        const y = BulletComponent.y;
        const trailWidth = BulletComponent.trailWidth;
        const active = BulletComponent.active;
        // E-137. A bullet whose mask is none or the entities layer's bit alone (the pool's default,
        // Layer.resolveSubscriptions) goes to the main collector, its rows (and its trail's) written here as
        // _writeRenderable writes them, without collectRenderable's dispatch and bit scan (E-98c and E-98e for
        // sprites); other masks take that path. `n` is the collector's count, synced around that call and after
        // the loop. The last key goes back to COLLECT_Y, where the loop left it before.
        const layerMask = BulletComponent.layerMask || null;
        const entitiesBit = Layer.entitiesId != null ? Layer.entitiesMask() : 0;
        const rY = this._renderableY;
        const rType = this._renderableType;
        const rIndex = this._renderableIndex;
        const maxItems = this.renderQueueMaxItems;
        let n = this._renderableCount;
        let lastKey = COLLECT_Y[0];

        for (let idx = 0; idx < visibleCount; idx++) {
            const i = visibleData[1 + idx];
            if (!active[i]) continue;
            const key = y[i] * Y_SORT_K;
            const trail = trailWidth[i] > 0;
            lastKey = trail ? key - 1 : key;
            const mask = layerMask === null ? 0 : layerMask[i];
            if (mask === 0 || mask === entitiesBit) {
                if (n < maxItems) {
                    rY[n] = key;
                    rType[n] = 4;
                    rIndex[n] = i;
                    n++;
                } else {
                    this._collectorFull();
                }
                if (trail) {
                    if (n < maxItems) {
                        rY[n] = key - 1;
                        rType[n] = 5;
                        rIndex[n] = i;
                        n++;
                    } else {
                        this._collectorFull();
                    }
                }
            } else {
                this._renderableCount = n;
                COLLECT_Y[0] = key;
                this.collectRenderable(4, i);
                if (trail) {
                    COLLECT_Y[0] = key - 1;
                    this.collectRenderable(5, i);
                }
                n = this._renderableCount;
            }
        }
        this._renderableCount = n;
        COLLECT_Y[0] = lastKey;
    }

    _entityYSort() {
        return !!(Layer._ySorting && Layer.entitiesId != null && Layer._ySorting[Layer.entitiesId]);
    }

    _queueHasOrder() {
        return this._entityYSort() || SpriteRenderer.zIndexUsers() > 0;
    }

    _orderKey(type, idx, yKey, ySort) {
        let z = 0;
        if ((type === 0 || type === 3 || type === 6) && SpriteRenderer.zIndex) {
            z = SpriteRenderer.zIndex[idx] | 0;
        }
        return orderSortKey(yKey, z, ySort, this._zBand);
    }

    /**
     * Collect a visible renderable for the render queue, its sort key in COLLECT_Y[0].
     * layerMask bits route to each sprite-queue layer. Density bits are splat, not queued.
     */
    collectRenderable(type, index) {
        if (!this.renderQueueEnabled) return;

        let mask = 0;
        if (type === 0) mask = SpriteRenderer.layerMask ? SpriteRenderer.layerMask[index] | 0 : 0;
        else if (type === 1) mask = ParticleComponent.layerMask ? ParticleComponent.layerMask[index] | 0 : 0;
        else if (type === 7) mask = this.liquidFun?.layerMask?.[index] | 0;
        else if (type === 2) mask = DecorationComponent.layerMask ? DecorationComponent.layerMask[index] | 0 : 0;
        else if (type === 3) {
            const g = LightEmitter.layerIdOfGlowSprite[index] | 0;
            if (g) mask = 1 << g;
            else mask = SpriteRenderer.layerMask ? SpriteRenderer.layerMask[index] | 0 : 0;
        } else if (type === 4 || type === 5) {
            mask = BulletComponent.layerMask ? BulletComponent.layerMask[index] | 0 : 0;
        } else if (type === 6) {
            mask = AdobeAnimComponent.layerMask ? AdobeAnimComponent.layerMask[index] | 0 : 0;
        }

        const isParticle = type === 1 || type === 7;
        if (!mask) {
            if (isParticle) return;
            mask = Layer.entitiesMask();
        }

        // Bit-scan only the sprite-queue bits (precomputed; density/compute-only bits
        // in `mask` are never set here) — popcount(mask) iterations, no per-bit
        // Layer method calls, instead of looping 0..Layer.count every renderable.
        let wroteSprite = false;
        let bits = mask & Layer._spriteQueueBits;
        while (bits) {
            const lsb = bits & -bits;
            const layerId = 31 - Math.clz32(lsb);
            this._writeRenderable(type, index, layerId);
            wroteSprite = true;
            bits ^= lsb;
        }
        if (!wroteSprite && !isParticle) {
            this._writeRenderable(type, index, Layer.entitiesId);
        }
    }

    /**
     * E-98d. An Adobe root is the only row the emit expands into several; without one, the emit
     * writes queue row i from collector row i, so the collect can write poses there directly.
     */
    _bindCollectPoses() {
        const adobe = this._frameAdobeEntities;
        const inQueue = (adobe === null || adobe.length === 0) && this._renderablePx !== null
            && this.renderQueueX.length >= this._renderablePx.length;
        this._collectPx = inQueue ? this.renderQueueX : (this._renderablePx || EMPTY_F32);
        this._collectPy = inQueue ? this.renderQueueY : (this._renderablePy || EMPTY_F32);
        this._collectRotC = inQueue ? this.renderQueueRotC : (this._renderableRotC || EMPTY_F32);
        this._collectRotS = inQueue ? this.renderQueueRotS : (this._renderableRotS || EMPTY_F32);
    }

    /**
     * Sort key for a sprite (type 0) or an Adobe root (type 6), into dst[at].
     * The Y-sort line is the sprite's bottom edge, not the pose; the rotation half
     * of that lives in spriteSortFootY so there is one definition of it. An Adobe
     * root has no sprite frame, so its line is the pose: the sprite path would
     * miss the feet fast path on its zero anchors and resolve a texture it does
     * not have, every frame, to get the same pose y.
     * It stores the key instead of returning it. Inlined into collectVisibleEntities
     * the budget runs out, the sort-line helper stayed a call, and its returned
     * double was boxed: a heap number per drawn entity per frame (E-66).
     */
    _storeEntitySortY(type, index, pose, dst, at) {
        let y = pose[1];
        if (type !== 6) {
            const src = this._spriteSortSrc();
            // The helper's own fast path, before the frame lookup: feet-anchored
            // sprites are the common case and never need the texture resolved.
            if (!(src.anchorX[index] === 0.5 && src.anchorY[index] === 1.0)) {
                const textureId = this._entityTextureIdOrResolve(index);
                let w = 0;
                let h = 0;
                if (textureId !== INVALID_TEXTURE_ID && this.frameWidth && this.frameHeight) {
                    w = this.frameWidth[textureId] || 0;
                    h = this.frameHeight[textureId] || 0;
                }
                y = spriteSortFootY(src, index, y, pose[2], pose[3], w, h);
            }
        }
        dst[at] = spriteYSortKey(y, Y_SORT_K);
    }

    /**
     * Component arrays the sort line reads, bound once. Rebuilt never: these
     * are the worker's own SoA views for its lifetime.
     */
    _spriteSortSrc() {
        let src = this._spriteSortArrays;
        if (src) return src;
        src = this._spriteSortArrays = {};
        src.anchorX = SpriteRenderer.anchorX;
        src.anchorY = SpriteRenderer.anchorY;
        src.scaleX = SpriteRenderer.scaleX;
        src.scaleY = SpriteRenderer.scaleY;
        src.inheritRotation = SpriteRenderer.inheritTransformRotation;
        src.spriteRotC = SpriteRenderer.spriteRotC;
        src.spriteRotS = SpriteRenderer.spriteRotS;
        return src;
    }

    /** Warns once that the main collector is full. */
    _collectorFull() {
        if (this._renderQueueOverflowWarned) return;
        this._renderQueueOverflowWarned = true;
        console.warn(`[PRE_RENDER] Main render queue collector full (max ${this.renderQueueMaxItems}). Increase renderer.maxVisibleRenderables.`);
    }

    /** One renderable into the main collector or a custom layer's; its sort key is COLLECT_Y[0]. */
    _writeRenderable(type, index, layerId) {
        const y = COLLECT_Y[0];
        if (this._customLayerCollectors && layerId !== Layer.entitiesId) {
            const collector = this._customLayerCollectors[layerId];
            if (collector) {
                if (collector.count < collector.maxItems) {
                    const wi = collector.count;
                    collector.y[wi] = y;
                    // The pose the emit reads, as the entities' collector stashes it (E-98d). A sprite's sort line
                    // only where the layer is Y-sorted (E-98); an Adobe root's key also goes to its pieces' sortKey
                    // column, so it is always computed.
                    if (type === 0 || type === 6) {
                        const pose = this._displayPoseOut;
                        this._displayPose(index, pose);
                        collector.stashX[wi] = pose[0];
                        collector.stashY[wi] = pose[1];
                        collector.stashRotC[wi] = pose[2];
                        collector.stashRotS[wi] = pose[3];
                        if (type === 6 || (Layer._ySorting && Layer._ySorting[layerId])) {
                            this._storeEntitySortY(type, index, pose, collector.y, wi);
                        }
                    } else if (type === 2) {
                        const pose = this._displayPoseOut;
                        this._decorationWorldXY(index, pose);
                        collector.stashX[wi] = pose[0];
                        collector.stashY[wi] = pose[1];
                        collector.stashRotC[wi] = DecorationComponent.rotC[index];
                        collector.stashRotS[wi] = DecorationComponent.rotS[index];
                    }
                    collector.type[wi] = type;
                    collector.index[wi] = index;
                    collector.count = wi + 1;
                } else if (!collector._overflowWarned) {
                    collector._overflowWarned = true;
                    console.warn(`[PRE_RENDER] Layer ${Layer.getName(layerId)} render queue full (max ${collector.maxItems}). Increase maxItems in scene config.`);
                }
            }
            return;
        }

        if (this._renderableCount >= this.renderQueueMaxItems) {
            this._collectorFull();
            return;
        }
        const writeIdx = this._renderableCount;
        this._renderableY[writeIdx] = y;
        this._renderableType[writeIdx] = type;
        this._renderableIndex[writeIdx] = index;
        if (type === 0 || type === 6) {
            const pose = this._displayPoseOut;
            this._displayPose(index, pose);
            this._collectPx[writeIdx] = pose[0];
            this._collectPy[writeIdx] = pose[1];
            this._collectRotC[writeIdx] = pose[2];
            this._collectRotS[writeIdx] = pose[3];
            // Drawn Y, whole pixels. A raw pose[1] key changes bits on a
            // fraction of a pixel and the painter swaps two sprites that
            // did not cross. Read only under Y-sort (E-98), and by an Adobe root's pieces.
            if (type === 6 || this._entitySortY) {
                this._storeEntitySortY(type, index, pose, this._renderableY, writeIdx);
            }
        } else if (type === 2) {
            const pose = this._displayPoseOut;
            this._decorationWorldXY(index, pose);
            this._collectPx[writeIdx] = pose[0];
            this._collectPy[writeIdx] = pose[1];
            this._collectRotC[writeIdx] = DecorationComponent.rotC[index];
            this._collectRotS[writeIdx] = DecorationComponent.rotS[index];
        }
        this._renderableCount = writeIdx + 1;
    }

    /**
     * Latch latest published physics pose buffer. Consume like pixi (store consumedFrame).
     */
    _latchPose() {
        super._latchPose(true);
        this._rbActive = RigidBody.active;
        this._updatePoseTiming();
        this._latchLiquidFunPrevPose();
    }

    /**
     * On each new physics publish: `_prevLf*` is the previous snapshot;
     * then snapshot current HEAP x/y for the next transition.
     * Shrinking count (zombie compaction) clears prev (index reshuffle).
     */
    _latchLiquidFunPrevPose() {
        const lf = this.liquidFun;
        if (!lf?.x || !lf?.count) return;
        if (!this.interpolatePhysicsPose) return;
        const ready = this.poseSync ? Atomics.load(this.poseSync, 0) : 0;
        if (ready === this._lfPoseReadyFrame) return;

        const n = lf.count[0] | 0;
        const maxN = this.liquidFunMaxCount | 0;
        if (!this._lfSnapX || this._lfSnapX.length < maxN) {
            this._lfSnapX = new Float32Array(maxN);
            this._lfSnapY = new Float32Array(maxN);
        }
        // In the render-queue memory when it has their region (bound with the emit kernel), where it reads them.
        if (!this._prevLfX || this._prevLfX.length < maxN) {
            this._prevLfX = new Float32Array(maxN);
            this._prevLfY = new Float32Array(maxN);
        }

        const shrinking = n < (this._lfSnapCount | 0);
        this._lfPoseReadyFrame = ready;

        if (shrinking || n <= 0 || !this._lfSnapValid) {
            this._prevLfCount = 0;
        } else {
            this._prevLfX.set(this._lfSnapX.subarray(0, this._lfSnapCount));
            this._prevLfY.set(this._lfSnapY.subarray(0, this._lfSnapCount));
            this._prevLfCount = this._lfSnapCount;
        }

        if (n > 0) {
            this._lfSnapX.set(lf.x.subarray(0, n));
            this._lfSnapY.set(lf.y.subarray(0, n));
            this._lfSnapCount = n;
            this._lfSnapValid = true;
        } else {
            this._lfSnapCount = 0;
            this._lfSnapValid = false;
        }
    }

    handleCustomMessage(data) {
        super.handleCustomMessage(data);
        if (
            (data?.msg === 'box2dReady' || data?.msg === 'liquidFunHeap') &&
            data.liquidFunHeap &&
            this.liquidFun
        ) {
            const v = LiquidFun.getViews();
            if (v?.x) {
                this.liquidFun.count = v.count;
                this.liquidFun.x = v.x;
                this.liquidFun.y = v.y;
                if (v.alpha) this.liquidFun.alpha = v.alpha;
            }
            if (data.msg === 'liquidFunHeap') {
                this._lfSnapValid = false;
                this._lfSnapCount = 0;
                this._prevLfCount = 0;
            }
        } else if (data?.msg === 'liquidFunCleared') {
            this._lfSnapValid = false;
            this._lfSnapCount = 0;
            this._prevLfCount = 0;
        }
    }

    /**
     * Self-measured physics-step timing for preRender.interpolation - no need
     * to know the configured physics.fixedFps, self-calibrates from observed
     * readyFrame transitions. Computed once per tick, not per entity.
     */
    _updatePoseTiming() {
        if (!this.interpolatePhysicsPose) return;
        if (!this.poseSync) return;
        const ready = Atomics.load(this.poseSync, 0);
        const now = performance.now();
        if (ready !== this._poseLastSeenReadyFrame) {
            if (this._poseLastSeenReadyFrame > 0) {
                const gap = now - this._poseLastChangeWallClock;
                if (gap > 0) {
                    this._poseMeasuredIntervalMs = this._poseMeasuredIntervalMs
                        ? this._poseMeasuredIntervalMs * 0.8 + gap * 0.2
                        : gap;
                }
            }
            this._poseLastSeenReadyFrame = ready;
            this._poseLastChangeWallClock = now;
        }
        const elapsedMs = now - this._poseLastChangeWallClock;
        this._poseAlpha = this._poseMeasuredIntervalMs > 0 ? Math.min(1, elapsedMs / this._poseMeasuredIntervalMs) : 1;
    }

    /**
     * Display pose: published post-step snapshot when latched, else Transform (boot).
     * Writes [x, y, rotC, rotS] into the caller's `out` (no alloc). Applies preRender.interpolation
     * (mode 'interpolate' | 'off') when a published pose is available.
     * @param {number} idx
     * @param {Float64Array} out [x, y, rotC, rotS]
     */
    _displayPose(idx, out) {
        const poseX = this._poseX;
        const rb = this._rbActive;
        const poseRotC = this._poseRotC;
        const poseRotS = this._poseRotS;
        const live = poseX && rb && rb[idx] && poseRotationLive(poseRotC ? poseRotC[idx] : 0, poseRotS ? poseRotS[idx] : 0);
        if (live) {
            const prevPoseX = this._prevPoseX;
            const prevPoseRotC = this._prevPoseRotC;
            const prevPoseRotS = this._prevPoseRotS;
            if (
                this.interpolatePhysicsPose &&
                prevPoseX &&
                poseRotationLive(prevPoseRotC ? prevPoseRotC[idx] : 0, prevPoseRotS ? prevPoseRotS[idx] : 0)
            ) {
                const alpha = this._poseAlpha;
                const px = prevPoseX[idx];
                const py = this._prevPoseY[idx];
                out[0] = px + (poseX[idx] - px) * alpha;
                out[1] = py + (this._poseY[idx] - py) * alpha;
                const pc = prevPoseRotC[idx];
                const ps = prevPoseRotS[idx];
                const c = poseRotC[idx];
                const s = poseRotS[idx];
                if (pc === c && ps === s) {
                    // Rotation unchanged this interval (fixedRotation bodies,
                    // or a rotating body momentarily still) - any alpha blend
                    // is exactly this same value, already unit length. Skip
                    // the lerp+renormalize below entirely (exact, not lossy).
                    out[2] = c;
                    out[3] = s;
                    return;
                }
                const rc = pc + (c - pc) * alpha;
                const rs = ps + (s - ps) * alpha;
                // Renormalize the lerped unit complex number (rotC,rotS) - plain
                // sqrt, not Math.hypot (its overflow/underflow guard is wasted
                // cost here; c,s are always small, bounded values).
                const len = Math.sqrt(rc * rc + rs * rs) || 1;
                out[2] = rc / len;
                out[3] = rs / len;
                return;
            }
            out[0] = poseX[idx];
            out[1] = this._poseY[idx];
            out[2] = poseRotC[idx];
            out[3] = poseRotS[idx];
            return;
        }
        out[0] = Transform.x[idx];
        out[1] = Transform.y[idx];
        const rotC = Transform.rotC;
        const rotS = Transform.rotS;
        out[2] = rotC && rotC[idx] !== undefined ? rotC[idx] : 1;
        out[3] = rotS ? (rotS[idx] || 0) : 0;
    }

    /**
     * World xy for a decoration slot. Parented: compose from parent published pose + local.
     * Writes x/y into out; facing left to DecorationComponent.rotC/rotS by caller.
     */
    _decorationWorldXY(decoIdx, out) {
        const p = DecorationComponent.parentEntityIndex[decoIdx];
        const ox = DecorationComponent.offsetX[decoIdx];
        const oy = DecorationComponent.offsetY[decoIdx];
        if (p !== this._noParent && Transform.active?.[p]) {
            this._displayPose(p, out);
            const lx = DecorationComponent.localX[decoIdx];
            const ly = DecorationComponent.localY[decoIdx];
            if (DecorationComponent.inheritParentRotation[decoIdx]) {
                const c = out[2];
                const s = out[3];
                out[0] += c * lx - s * ly + ox;
                out[1] += s * lx + c * ly + oy;
            } else {
                out[0] += lx + ox;
                out[1] += ly + oy;
            }
            return;
        }
        out[0] = DecorationComponent.x[decoIdx] + ox;
        out[1] = DecorationComponent.y[decoIdx] + oy;
    }

    /**
     * Sprite mode does not register lightGlows. Glows stay in the entity queue.
     * Add mode: a hidden lightGlows layer skips the collect.
     */
    _syncGlowLayer() {
        const sprite = (this.config.lighting?.lightGlow ?? LIGHTING_DEFAULTS.lightGlow) === 'sprite';
        this._lightGlowAsSprite = sprite;
        this._glowEmit = true;
        this._glowLayerAlpha = 1;
        if (sprite) return;
        const layer = Layer.get('lightGlows');
        if (layer && !layer.visible) this._glowEmit = false;
    }

    buildRenderQueue(deltaTime) {
        this._syncGlowLayer();
        this._queuePresorted = false;
        if (!this.renderQueueEnabled || this._renderableCount === 0) {
            if (this.renderQueueCount) this.renderQueueCount[0] = 0;
            this._lastCollectCount = 0;
            this._lastEmitCount = 0;
            return;
        }

        const count = this._renderableCount;
        const hasOrder = this._queueHasOrder();
        this._queuePresorted = hasOrder && this._presortCollector(count, this._entityYSort());
        this._emitPresorted = this._queuePresorted;
        const writeCount = this.emitSpriteQueue(deltaTime, this._fillEmitSource(
            count,
            this.renderQueueMaxItems,
            this._renderableY,
            this._renderableType,
            this._renderableIndex,
            this._collectPx,
            this._collectPy,
            this._collectRotC,
            this._collectRotS,
            true,
            hasOrder,
            hasOrder && this._entityYSort()
        ));
        this._emitPresorted = false;
        this.renderQueueCount[0] = writeCount;
        this._emitWriteCount = writeCount;
        this._lastCollectCount = count;
        this._lastEmitCount = writeCount;
        this._renderableCount = 0;
    }

    /**
     * E-138. Sort the collector by the keys the emit will write, before the emit, when last frame's emit wrote at
     * least twice the rows it was given (Adobe Animate roots expand into their pieces): the painter would sort the
     * queue's runs and the pack scatter its rows to their painter slots, a random write per run. A stable sort of
     * the collector expanded in place is a stable sort of the queue (a root's pieces are consecutive under its key),
     * so the queue comes out in that order and _packGpuSprites packs it as it is (GPU_FLAG_SORTED, no painter).
     * Equal keys keep the collector's order, as the painter's full sort keeps the queue's (its reinsert of moved
     * keys, which this frame skips, puts them after the unmoved ones). Only where the painter is pre-render's, no
     * sun casters are packed (they are listed in queue order) and the queue did not fill (which rows are cut
     * would change). The poses are in the stash then (E-98d); the collector's columns are permuted in place.
     * @returns {boolean} whether the collector was sorted
     */
    _presortCollector(count, ySort) {
        const last = this._lastCollectCount;
        const wrote = this._lastEmitCount;
        if (count < 2 || last <= 0 || wrote < 2 * last || wrote >= this.renderQueueMaxItems) return false;
        if (!this.renderQueueSortKey || !this._gpuPainter || !this._allowGpuPainter()) return false;
        // The keys and the order are regions of the render-queue memory, where the painter kernel sorts them.
        if (this._presortOrder.length < count || this._presortOrder.buffer !== this._gpuPainter.kernel.buffer) return false;
        if (this.shadowsEnabled && this.gpuQueueCaps && this.gpuQueueCaps.maxSun > 0) return false;
        const px = this._collectPx;
        if (px === this.renderQueueX || px.length < count) return false;
        this._sortCollectorByKey(count, ySort);
        return true;
    }

    /** E-138. The collector's rows and their poses in the stash, stably sorted by the key the emit writes for them. */
    _sortCollectorByKey(count, ySort) {
        // The keys and the order are regions of the render-queue memory (bound at init, _presortCollector checks),
        // where pre-render's painter kernel sorts them; the permutation's scratch is pre-render's own.
        if (this._presortF32.length < count) {
            const n = this.renderQueueMaxItems;
            this._presortF32 = new Float32Array(n);
            this._presortU8 = new Uint8Array(n);
            this._presortI32 = new Int32Array(n);
        }
        const keys = this._presortKeys;
        const order = this._presortOrder;
        const cY = this._renderableY;
        const cType = this._renderableType;
        const cIndex = this._renderableIndex;
        // The key emitSpriteQueue writes for the row (and every piece of a root), as the queue's Float32 stores it.
        let glows = 0;
        for (let i = 0; i < count; i++) {
            const type = cType[i];
            if (type === 3) glows++;
            keys[i] = this._orderKey(type, cIndex[i], cY[i], ySort);
            order[i] = i;
        }
        this._presortGlowRows = glows;
        radixSortIndicesWasm(this._gpuPainter, order, count, this._presortKeysU32);
        let i = 0;
        while (i < count && order[i] === i) i++;
        if (i === count) return;
        const f32 = this._presortF32;
        for (let k = 0; k < count; k++) f32[k] = cY[order[k]];
        cY.set(f32.subarray(0, count));
        permuteF32(this._collectPx, order, count, f32);
        permuteF32(this._collectPy, order, count, f32);
        permuteF32(this._collectRotC, order, count, f32);
        permuteF32(this._collectRotS, order, count, f32);
        const u8 = this._presortU8;
        for (let k = 0; k < count; k++) u8[k] = cType[order[k]];
        cType.set(u8.subarray(0, count));
        const i32 = this._presortI32;
        for (let k = 0; k < count; k++) i32[k] = cIndex[order[k]];
        cIndex.set(i32.subarray(0, count));
    }

    _fillEmitSource(count, maxItems, collectorY, collectorType, collectorIndex, stashX, stashY, stashRotC, stashRotS, persist, hasOrder, ySort) {
        const src = this._emitSource || (this._emitSource = {});
        src.count = count;
        src.maxItems = maxItems;
        src.collectorY = collectorY;
        src.collectorType = collectorType;
        src.collectorIndex = collectorIndex;
        src.stashX = stashX;
        src.stashY = stashY;
        src.stashRotC = stashRotC;
        src.stashRotS = stashRotS;
        src.persist = persist;
        src.hasOrder = hasOrder;
        src.ySort = ySort;
        return src;
    }

    /**
     * The emit of one queue (the entities' or a custom layer's), in preRenderEmit.wasm (E-112, W4a-W4d, W27, close-out
     * group B): every row type, the persist path of the entities queue (W4c) and, on a persist frame, the rows of other
     * types. Every column it reads is in the render-queue memory (preRenderEmitClient.js); a queue it cannot take is drawn
     * empty and pre-render says why once (_emitRefused). The JS emit it replaced is tests/reference/preRenderEmitJs.mjs.
     * @returns {number} the rows written
     */
    emitSpriteQueue(deltaTime, source) {
        const count = source.count;
        const maxItems = source.maxItems;
        // sortKey is written for the CPU painter. Pixi reinserts; this pass does not sort.
        const detail = source.persist && this.collectDetailedStats;
        if (detail) this.sortTimeThisFrame = 0;
        const tEmit = detail ? performance.now() : 0;
        const rqTileMode = this.renderQueueTileMode;
        const tilesDirty = rqTileMode !== null && this._tiledTileColumns.has(rqTileMode);
        const writeSortKey = !!(this.renderQueueSortKey && source.hasOrder);
        const ySort = !!source.ySort;
        // -1 when off: buffer 0 is a valid persist target (it used to read as false).
        const persistBuf = source.persist ? this._queueBuf : -1;
        if (!this._writeEmitTable(source, this._resolveBuiltinTextureId('_bulletTrail'))) {
            return this._emitRefused('a column it reads is outside the render-queue memory');
        }
        const persistWasm = persistBuf >= 0 && writePersistColumns(this._emitWasm, this, SpriteRenderer, persistBuf);
        let writeCount = 0;
        let persistHit = false;
        // Rows other than sprites are rewritten in full on a persist frame too (E-82 staticGen).
        let persistOthers = 0;
        if (persistWasm) {
            persistOthers = this._persistFrameWasm(persistBuf, count, maxItems, deltaTime);
            persistHit = persistOthers >= 0;
            if (!persistHit) persistOthers = 0;
        }
        let tiledRows = false;
        if (persistHit && persistOthers === 0) {
            // E-98b. A persist frame of sprites only: persist_frame wrote them.
            writeCount = count < maxItems ? count : maxItems;
        } else if (count > 0) {
            // The full emit, or on a persist frame the rows of other types (the sprites skipped).
            const written = this._emitRowsWasm(deltaTime, source, writeSortKey, ySort, tilesDirty, persistHit);
            if (written < 0) return this._emitRefused('the kernel declined a frame');
            writeCount = written;
            tiledRows = this._emitTiledRows;
        }

        if (detail) this.emitTimeThisFrame = performance.now() - tEmit;
        // E-102b: from now on this queue's other rows must clear what a repeating sprite left.
        if (tiledRows && rqTileMode !== null) this._tiledTileColumns.add(rqTileMode);
        if (persistWasm && !persistHit) this._rememberType0SetWasm(persistBuf, count, maxItems);
        if (source.persist) {
            // E-82. A frame that only moved sprites keeps the count; anything else is a new one
            // (0 is skipped: it means unknown).
            if (!persistHit || persistOthers > 0 || this._persistFramesMoved > 0 || this._persistFramesRepaired > 0) {
                this._staticGen = ((this._staticGen + 1) >>> 0) || 1;
            }
            if (this.renderQueueStaticGen.length) this.renderQueueStaticGen[0] = this._staticGen;
        }
        return writeCount;
    }

    /** A queue the emit kernel cannot take: drawn empty this frame, the reason said once. */
    _emitRefused(reason) {
        if (!this._emitRefusedWarned) {
            this._emitRefusedWarned = true;
            console.error(`[PRE_RENDER] the emit kernel cannot take a render queue (${reason}): it is drawn empty`);
        }
        return 0;
    }

    /**
     * E-112, W4c. preRenderEmit.wasm's column table for this frame; false when the kernel cannot take the
     * frame (no texture tables yet, a column outside its memory), and the JS runs it. W4d: with BulletComponent
     * in the memory the kernel writes the bullet and trail rows too, the trail's texture `trailTexture`; else
     * they are left to the JS. With LightEmitter and Transform there, the glow rows too; with ParticleComponent, the
     * particle rows.
     */
    _writeEmitTable(source, trailTexture) {
        const b = this._emitWasm;
        if (!b.texturesReady || !writeEmitColumns(b, this, SpriteRenderer, ShadowCaster, DecorationComponent, source)) return false;
        writeEmitBulletColumns(b, BulletComponent, trailTexture);
        writeEmitGlowColumns(b, LightEmitter, Transform, this._resolveBuiltinTextureId('_lightGradient'));
        const white = this._resolveBuiltinTextureId('_whiteCircle');
        writeEmitParticleColumns(b, ParticleComponent, white, this.zenithalMaxHeight, this.zenithalScaleFactor, this.zenithalAlphaFade);
        // A LiquidFun row interpolates when emitSpriteQueue would: interpolatePhysicsPose, _prevLfX, _prevLfCount > idx.
        const lfPrev = this.interpolatePhysicsPose && this._prevLfX ? this._prevLfCount : 0;
        writeEmitLiquidFunColumns(b, this.liquidFun, this._prevLfX, this._prevLfY, lfPrev, this._poseAlpha, white);
        // W27: Adobe roots expand in the kernel when its tables hold the registry's assets and AdobeAnimComponent is
        // in the memory (else it declines a frame with one), on a queue whose texture column is the source's length
        // (_emitAdobePieces stops at that column's end, the loop at maxItems).
        if (b.adobe) {
            const assets = AdobeAnimRegistry.assetById;
            if (assets !== b.adobeFrom || assets.length !== b.adobeAssets) this._copyEmitAdobeAssets();
            writeEmitAdobeColumns(b, AdobeAnimComponent, this.renderQueueTextureId.length === source.maxItems);
        }
        return true;
    }

    /**
     * W27. The registry's assets into the emit kernel's tables. An asset the tables could not take is not drawn (nor
     * are its clips advanced): an error per asset, once per copy, says why and what to change.
     */
    _copyEmitAdobeAssets() {
        const skipped = writeEmitAdobeAssets(this._emitWasm, AdobeAnimRegistry.assetById);
        for (let k = 0; k < skipped.length; k++) {
            const s = skipped[k];
            if (s.reason === 'room') {
                const mb = this.config?.preRender?.adobeTablesMB ?? PRE_RENDER_DEFAULTS.adobeTablesMB;
                console.error(`[PRE_RENDER] Adobe Animate asset "${s.name}" needs ${s.bytes} bytes of tables in the render-queue `
                    + `memory and preRender.adobeTablesMB (${mb} MB) has no room left: its characters are not drawn. `
                    + 'Raise preRender.adobeTablesMB.');
            } else if (s.reason === 'ids') {
                console.error(`[PRE_RENDER] ${s.name}: the emit's asset directory holds ids 0 to 255, their characters are not drawn.`);
            } else {
                console.error(`[PRE_RENDER] Adobe Animate asset "${s.name}" is malformed (an array that is not one, frame lists `
                    + 'of two lengths, a frame whose pieces run past its piece arrays, or bounds that are not numbers): its '
                    + 'characters are not drawn.');
            }
        }
    }

    /**
     * W4c, E-116. The JS persist check and poses-only pass (_type0PersistHit and _writeType0PosesOnly in
     * tests/reference/preRenderEmitJs.mjs) in one preRenderEmit.wasm walk (persist_frame),
     * on this frame's table: the rows of other types when the rows are the ones this buffer last held,
     * else -1 (the full emit that follows rewrites the pose columns the walk wrote). The repairs go to
     * _persistFramesRepaired, the sprites whose frame moved to _persistFramesMoved, the play-once ends
     * through the entity-type filter, as the JS sends them.
     */
    _persistFrameWasm(bufIdx, count, maxItems, deltaTime) {
        if (this._persistCount[bufIdx] !== count) return -1;
        this._persistFramesRepaired = 0;
        const b = this._emitWasm;
        const writeSortKey = !!(this.renderQueueSortKey && this._queueHasOrder());
        const ySort = writeSortKey && this._entityYSort();
        const bounds = this.frameWidth && this.frameHeight && SpriteRenderer.boundsHalfW && SpriteRenderer.boundsHalfH;
        // E-117. Without ShadowCaster every sprite row's shadow terms are the zeros the full emit wrote.
        const flags = (writeSortKey ? EMIT_SORT_KEY : 0) | (ySort ? EMIT_Y_SORT : 0) | (bounds ? EMIT_BOUNDS : 0)
            | (ShadowCaster.active ? 0 : EMIT_NO_CASTERS);
        const others = b.persistFrame(b.tableByte, count, maxItems, flags, deltaTime / 1000, this._zBand);
        if (others === EMIT_PERSIST_MISS) return -1;
        const results = b.results;
        this._persistFramesMoved = results[1];
        this._persistFramesRepaired = results[2];
        const ends = results[0];
        const u32 = b.u32;
        for (let k = 0, at = b.endsAt; k < ends; k++, at += 2) {
            const idx = u32[at];
            if (this._animEndByType[Transform.entityType[idx]] === 1) this._spriteAnimationEnded(idx, u32[at + 1]);
        }
        return others;
    }

    /** W4c. _rememberType0Set in preRenderEmit.wasm (persist_remember). */
    _rememberType0SetWasm(bufIdx, count, maxItems) {
        const b = this._emitWasm;
        const cleared = b.persistRemember(b.tableByte, count, maxItems);
        this._persistCount[bufIdx] = count;
        // As in _rememberType0Set: the other buffer still holds the old columns of a sprite that changed.
        if (cleared) this._persistCount[bufIdx ^ 1] = -1;
    }

    /**
     * E-112. The full emit's rows through preRenderEmit.wasm, on this frame's table (_writeEmitTable): every row type
     * (W4d, close-out group B) and the Adobe roots' pieces (W27), or with \`othersOnly\` a persist frame's rows but the
     * sprites; its play-once ends are sent through the entity-type filter and its missing textures warned as the JS
     * emit warned them.
     * Returns the rows written, or -1 when the kernel cannot take the frame (a declined frame, or rows it listed
     * because their columns are outside the memory).
     */
    _emitRowsWasm(deltaTime, source, writeSortKey, ySort, tilesDirty, othersOnly) {
        const b = this._emitWasm;
        const bounds = this.frameWidth && this.frameHeight && SpriteRenderer.boundsHalfW && SpriteRenderer.boundsHalfH;
        const flags = (writeSortKey ? EMIT_SORT_KEY : 0) | (ySort ? EMIT_Y_SORT : 0)
            | (tilesDirty ? EMIT_TILES_DIRTY : 0) | (bounds ? EMIT_BOUNDS : 0) | (this._emitPresorted ? EMIT_PRESORTED : 0)
            | (othersOnly ? EMIT_OTHERS_ONLY : 0);
        const written = b.emitRows(b.tableByte, source.count, source.maxItems, flags,
            deltaTime / 1000, this._decorationZoomAlpha, this._zBand);
        if (written === EMIT_DECLINED) return -1;
        const results = b.results;
        const u32 = b.u32;
        // Rows the kernel lists are of a type whose columns are outside the memory: nothing would write them.
        if (results[3] > 0) return -1;
        const ends = results[0];
        for (let k = 0, at = b.endsAt; k < ends; k++, at += 2) {
            const idx = u32[at];
            if (this._animEndByType[Transform.entityType[idx]] === 1) this._spriteAnimationEnded(idx, u32[at + 1]);
        }
        const warns = results[1];
        for (let k = 0, at = b.warnsAt; k < warns; k++, at += 2) this._emitWarn(u32[at], u32[at + 1]);
        this._emitTiledRows = results[2] !== 0;
        // W27: an Adobe root's pieces ran past the queue's end (_emitAdobePieces warns once).
        if (results[4] !== 0 && !this._adobeRenderQueueOverflowWarned) {
            this._adobeRenderQueueOverflowWarned = true;
            console.warn('[PRE_RENDER] Adobe Animate piece expansion exceeded render queue capacity. Increase renderer.maxVisibleRenderables.');
        }
        return written;
    }

    /** E-112. A missing texture the kernel met, warned under the key and text the JS emit uses. */
    _emitWarn(idx, kind) {
        if (kind === EMIT_WARN_NO_ANIM || kind === EMIT_WARN_NO_START) {
            const sheetId = SpriteRenderer.spritesheetId[idx];
            const animState = SpriteRenderer.animationState[idx];
            if (kind === EMIT_WARN_NO_ANIM) {
                this._warnMissingTexture(
                    `sprite:${sheetId}:${animState}`,
                    `[PRE_RENDER] no global anim for sheetId=${sheetId} animState=${animState} entity=${idx}; using INVALID textureId`
                );
                return;
            }
            const globalAnimIdx = this.proxyToGlobalAnim?.[sheetId]?.[animState];
            this._warnMissingTexture(
                `animStart:${globalAnimIdx}`,
                `[PRE_RENDER] animationFrameStart missing for globalAnimIdx=${globalAnimIdx} entity=${idx}`
            );
            return;
        }
        if (kind === EMIT_WARN_BULLET_START) {
            this._resolveAnimFrameStart(BulletComponent.textureId[idx], ANIM_LABEL_TAG.BULLET);
            return;
        }
        if (kind === EMIT_WARN_PARTICLE_START) {
            this._resolveAnimFrameStart(ParticleComponent.textureId[idx], ANIM_LABEL_TAG.PARTICLE);
            return;
        }
        if (kind === EMIT_WARN_LF_START) {
            this._resolveAnimFrameStart(this.liquidFun.textureId[idx], ANIM_LABEL_TAG.LIQUID_FUN);
            return;
        }
        this._resolveAnimFrameStart(DecorationComponent.textureId[idx], ANIM_LABEL_TAG.DECORATION);
    }

    /**
     * Each custom sprite layer goes through emitSpriteQueue, the same row writer
     * as the entities queue. Type-0 persist stays on the entities queue only.
     */
    buildCustomLayerQueues(deltaTime) {
        const entries = this._customLayerEntries;
        if (!entries) return;
        const saved = this._mainColumnSnapshot();
        try {
            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                const collector = entry.collector;
                const views = entry.ref;
                if (!collector) continue;
                if (!views) {
                    collector.count = 0;
                    continue;
                }
                if (collector.count === 0) {
                    if (views.count) views.count[0] = 0;
                    continue;
                }
                this._applyMainColumns(views);
                const ySorting = !!(Layer._ySorting && Layer._ySorting[entry.layerId]);
                const writeCount = this.emitSpriteQueue(deltaTime, this._fillEmitSource(
                    collector.count,
                    collector.maxItems,
                    collector.y,
                    collector.type,
                    collector.index,
                    collector.stashX,
                    collector.stashY,
                    collector.stashRotC,
                    collector.stashRotS,
                    false,
                    ySorting,
                    ySorting
                ));
                if (views.count) views.count[0] = writeCount;
                collector.count = 0;
            }
        } finally {
            this._applyMainColumns(saved);
        }
    }

    _gpuSoAFromViews(views) {
        if (!views) return this._gpuSoAFromBound();
        if (!this._gpuSoa) this._gpuSoa = {};
        const q = this._gpuSoa;
        q.count = views.count ? (views.count[0] | 0) : 0;
        q.x = views.x;
        q.y = views.y;
        q.scaleX = views.scaleX;
        q.scaleY = views.scaleY;
        q.rotC = views.rotC;
        q.rotS = views.rotS;
        q.alpha = views.alpha;
        q.tint = views.tint;
        q.textureId = views.textureId;
        q.anchorX = views.anchorX;
        q.anchorY = views.anchorY;
        q.repeatX = views.repeatX;
        q.repeatY = views.repeatY;
        q.tileMulX = views.tileMulX;
        q.tileMulY = views.tileMulY;
        q.tileOffsetU = views.tileOffsetU;
        q.tileOffsetV = views.tileOffsetV;
        q.sortKey = views.sortKey;
        q.sortKeyU32 = views.sortKeyU32;
        q.shadowH = views.shadowH;
        q.shadowOffX = views.shadowOffX;
        q.shadowOffY = views.shadowOffY;
        q.type = views.type;
        return q;
    }

    _gpuSoAFromBound() {
        const v = this._gpuBoundViews || (this._gpuBoundViews = {});
        v.count = this.renderQueueCount;
        v.x = this.renderQueueX;
        v.y = this.renderQueueY;
        v.scaleX = this.renderQueueScaleX;
        v.scaleY = this.renderQueueScaleY;
        v.rotC = this.renderQueueRotC;
        v.rotS = this.renderQueueRotS;
        v.alpha = this.renderQueueAlpha;
        v.tint = this.renderQueueTint;
        v.textureId = this.renderQueueTextureId;
        v.anchorX = this.renderQueueAnchorX;
        v.anchorY = this.renderQueueAnchorY;
        v.repeatX = this.renderQueueRepeatX;
        v.repeatY = this.renderQueueRepeatY;
        v.tileMulX = this.renderQueueTileMulX;
        v.tileMulY = this.renderQueueTileMulY;
        v.tileOffsetU = this.renderQueueTileOffsetU;
        v.tileOffsetV = this.renderQueueTileOffsetV;
        v.sortKey = this.renderQueueSortKey;
        v.sortKeyU32 = this.renderQueueSortKeyU32;
        v.shadowH = this.renderQueueShadowH;
        v.shadowOffX = this.renderQueueShadowOffX;
        v.shadowOffY = this.renderQueueShadowOffY;
        v.type = this.renderQueueType;
        return this._gpuSoAFromViews(v);
    }

    _resetGpuPackOpts(opts) {
        opts.includeType = -1;
        opts.excludeType0 = -1;
        opts.excludeType1 = -1;
        opts.indices = null;
        opts.indexCount = 0;
        opts.sortKey = null;
        opts.space = GPU_SPACE_WORLD;
        opts.zoom = 1;
        opts.cameraX = 0;
        opts.cameraY = 0;
        opts.resolution = 1;
        opts.depthDenom = this.renderQueueMaxItems;
        opts.worldHeight = this.config.worldHeight || 10000;
        opts.pixelSnap = !!this._atlasNearest;
        opts.snapZoom = this._frameCameraZoom;
        opts.snapCameraX = this._frameCameraX;
        opts.snapCameraY = this._frameCameraY;
        opts.type = this.renderQueueType;
        opts.sortKey = null;
    }

    _collectStampLights() {
        const out = this._stampLights || (this._stampLights = []);
        let n = 0;
        if (!LightEmitter.active || !this._queryLightEmitter) {
            out.length = 0;
            return;
        }
        const worldX = Transform.x;
        const worldY = Transform.y;
        const lightEnabled = LightEmitter.active;
        const lightIntensity = LightEmitter.lightIntensity;
        const sqrtI = LightEmitter.sqrtLightIntensity;
        const lightHeight = LightEmitter.height;
        const vr = Collider.visualRange;
        const zoom = this._frameCameraZoom || 1;
        const camX = this._frameCameraX || 0;
        const camY = this._frameCameraY || 0;
        const view = viewWorldBounds(
            zoom, camX, camY, this.canvasWidth, this.canvasHeight, this._frameCameraRot, this._worldBounds
        );
        const viewLeft = view.minX;
        const viewTop = view.minY;
        const viewRight = view.maxX;
        const viewBottom = view.maxY;
        // The view turns about its focus, so the sort center ignores rotation.
        const cx = camX + this.canvasWidth / (zoom > 0 ? zoom : 1) * 0.5;
        const cy = camY + this.canvasHeight / (zoom > 0 ? zoom : 1) * 0.5;
        const raw = Query.queryPublishedFrame(this._queryLightEmitter) === -1
            ? EMPTY_OWNED_IDS
            : Query.queryActiveEntities(this._queryLightEmitter);
        for (let i = 0; i < raw.length; i++) {
            const id = raw[i];
            if (!lightEnabled[id]) continue;
            if (!(sqrtI[id] > 0)) continue;
            const x = worldX[id];
            const y = worldY[id] - (lightHeight[id] || 0);
            const influence = lightInfluenceRadius(sqrtI[id]);
            if (
                x + influence < viewLeft ||
                x - influence > viewRight ||
                y + influence < viewTop ||
                y - influence > viewBottom
            ) {
                continue;
            }
            const dx = x - cx;
            const dy = y - cy;
            const vrRange = vr ? (vr[id] || 0) : 0;
            const range = vrRange > 0 ? vrRange : influence;
            const slot = out[n];
            if (!slot) break;
            slot.id = id;
            slot.x = x;
            slot.y = y;
            slot.intensity = lightIntensity[id];
            slot.rangeSq = range * range;
            slot.sqrtI = sqrtI[id];
            slot.distSq = dx * dx + dy * dy;
            slot.maxShadows = 0;
            n++;
        }
        this._stampLightCount = n;
        // Cookie pack needs the list; dist-order is only for stamping casters.
        if (this._stampSortLights) this._sortPrefix(out, n, this._stampLightCmp);
    }

    _sortPrefix(arr, count, compare) {
        const n = count | 0;
        if (n <= 1) return;
        if (n === arr.length) {
            arr.sort(compare);
            return;
        }
        // Slots at n and past it are pooled and must stay put, so this cannot
        // hand the whole array to sort. Insertion sort costs ~n on a nearly
        // sorted list (lights spawned in rows: 3.4 µs at 360) and n²/4 moves on
        // one far from sorted (moving lights in entity order: 54 µs at 360).
        // Past SORT_PREFIX_INSERTION_MAX it gets a budget of 16 moves per item;
        // a list that spends it finishes in a merge sort through a scratch kept
        // across frames, grown and never reallocated per frame (E-08).
        const budget = n > SORT_PREFIX_INSERTION_MAX ? n * 16 : Infinity;
        let moves = 0;
        for (let i = 1; i < n; i++) {
            const item = arr[i];
            let j = i - 1;
            while (j >= 0 && compare(arr[j], item) > 0) {
                arr[j + 1] = arr[j];
                j--;
            }
            arr[j + 1] = item;
            moves += i - 1 - j;
            if (moves > budget) {
                let tmp = this._sortPrefixTmp;
                if (!tmp || tmp.length < n) {
                    let cap = tmp ? tmp.length : SORT_PREFIX_INSERTION_MAX * 2;
                    while (cap < n) cap *= 2;
                    tmp = this._sortPrefixTmp = new Array(cap);
                }
                mergeSortPrefix(arr, tmp, n, compare);
                return;
            }
        }
    }

    _packGpuSun(dst, q) {
        const caps = this.gpuQueueCaps;
        if (!this.shadowsEnabled || !caps || !(caps.maxSun > 0)) return 0;
        const opts = this._gpuPackOpts;
        const typeArr = q.type || this.renderQueueType;
        const count = q.count | 0;
        let sunN = compactShadowCasterIndices(q.shadowH, typeArr, count, this._gpuCasterIdx);
        if (sunN > caps.maxSun) sunN = caps.maxSun;
        if (sunN > 0) {
            this._resetGpuPackOpts(opts);
            opts.indices = this._gpuCasterIdx;
            opts.indexCount = sunN;
            opts.sortKey = null;
            const sctx = makePackContext(q, opts, caps.maxSun, this._gpuPackCtx);
            sunN = sctx
                ? this._packRows(q, sctx, dst.sun, dst.sunU32, GPU_CASTER_FLOATS, caps.maxSun, true)
                : 0;
        }
        return sunN;
    }

    _ensureStampScratch(sunN) {
        const n = sunN | 0;
        if (n > (this._gpuStampTmp ? this._gpuStampTmp.length : 0)) {
            this._gpuStampTmp = new Uint32Array(n);
            this._gpuStampDist = new Float32Array(n);
            this._gpuStampOrder = new Uint32Array(n);
        }
        if (n > (this._gpuCasterUsed ? this._gpuCasterUsed.length : 0)) {
            this._gpuCasterUsed = new Uint8Array(n);
        }
        if (n > (this._gpuKeepIdx ? this._gpuKeepIdx.length : 0)) {
            this._gpuKeepIdx = new Uint32Array(n);
        }
        const maxCells = 128 * 128;
        if (!this._stampGridCounts) {
            this._stampGridCounts = new Int32Array(maxCells);
            this._stampGridStarts = new Int32Array(maxCells + 1);
        }
        if (!this._stampGridItems || this._stampGridItems.length < n) {
            this._stampGridItems = new Uint32Array(n);
        }
    }

    _stampAgainstSun(dst, sun, sunN, stampBase, lightBegin, lightStride) {
        this._stampSortLights = (sunN | 0) > 0;
        // E-29. A SUB-TIMER of SHADOW_Q_MS, not a peer of it. `_stampAgainstSun` is
        // reached from `_packGpuShadows`, inside the window SHADOW_Q_MS measures, so this
        // time is already counted there. It gets its own slot because that window was the
        // only untested-but-large phase on the critical path (E-33) and a caller had no
        // way to tell "choosing the lights" from "stamping against them" - which are
        // different costs with different fixes, and only one of them is a sort.
        const detailStamp = this.collectDetailedStats;
        const tStamp = detailStamp ? performance.now() : 0;
        this._collectStampLights();
        if (detailStamp) this.stampLightsTimeThisFrame = performance.now() - tStamp;
        const lights = this._stampLights;
        const capL = Math.min(this._stampLightCount | 0, this.maxShadowCastingLights | 0);
        const caps = this.gpuQueueCaps;
        const stampCap = caps ? (caps.maxStamp | 0) : 0;
        const maxPL = this.maxShadowsPerLight | 0;
        if (this.adaptiveShadowBudget !== false && maxPL > 0 && capL > 0) {
            const zoom = this._frameCameraZoom > 0 ? this._frameCameraZoom : 1;
            const shadowRes = this.config.lighting?.shadowResolution || 0.25;
            const texScale = zoom * shadowRes;
            if (texScale < 0.25) {
                const scaleSq = texScale * texScale;
                for (let i = 0; i < capL; i++) {
                    const L = lights[i];
                    if (!L || !(L.rangeSq > 0)) continue;
                    const texArea = 3.14159 * L.rangeSq * scaleSq;
                    const budget = Math.max(16, (texArea * 0.05 + 0.5) | 0);
                    L.maxShadows = budget < maxPL ? budget : maxPL;
                }
            }
        }
        this._ensureStampScratch(sunN);
        if (!this._gpuLightVec) this._gpuLightVec = new Float32Array(4);

        let spec = this._stampRangeSpec;
        if (!spec) {
            spec = this._stampRangeSpec = {
                sun: null,
                sunN: 0,
                sunFloats: GPU_CASTER_FLOATS,
                lights: null,
                lightBegin: 0,
                lightEnd: 0,
                lightStride: 1,
                maxPerLight: 0,
                maxPerEntity: 0,
                used: null,
                tmpIdx: null,
                dist: null,
                order: null,
                keepIdx: null,
                gridCounts: null,
                gridStarts: null,
                gridItems: null,
                stamp: null,
                stampFloats: GPU_CASTER_FLOATS,
                stampCap: 0,
                stampBase: 0,
                stampLightIdx: null,
                lightVec: null,
            };
        }
        spec.sun = sun;
        spec.sunN = sunN;
        spec.lights = lights;
        spec.lightBegin = lightBegin;
        spec.lightEnd = capL;
        spec.lightStride = lightStride;
        spec.maxPerLight = this.maxShadowsPerLight | 0;
        spec.maxPerEntity = this.maxShadowsPerEntity | 0;
        spec.used = this._gpuCasterUsed;
        spec.tmpIdx = this._gpuStampTmp;
        spec.dist = this._gpuStampDist;
        spec.order = this._gpuStampOrder;
        spec.keepIdx = this._gpuKeepIdx;
        spec.gridCounts = this._stampGridCounts;
        spec.gridStarts = this._stampGridStarts;
        spec.gridItems = this._stampGridItems;
        spec.stamp = dst.stamp;
        spec.stampCap = stampCap;
        spec.stampBase = stampBase;
        spec.stampLightIdx = dst.stampLightIdx;
        spec.lightVec = this._gpuLightVec;

        return this._stampRange(spec, sunN, stampBase);
    }

    /** E-114: the stamp in shadowStamp.wasm, its only stamp. Without its regions there are no sun casters. */
    _stampRange(spec, sunN, stampBase) {
        if (this._stampWasm === null) {
            if ((sunN | 0) > 0) throw new Error('shadowStamp: sun casters without the stamp regions of the render-queue memory');
            return stampBase;
        }
        return stampLightRangeWasm(this._stampWasm, spec);
    }

    _packGpuCookies(dst) {
        const caps = this.gpuQueueCaps;
        const cq = this._gpuCookieQ;
        const lights = this._stampLights;
        const capL = lights ? Math.min(this._stampLightCount | 0, this.maxShadowCastingLights | 0) : 0;
        if (!cq || capL <= 0 || !caps || !(caps.maxCookie > 0)) return 0;
        const texId = this._resolveBuiltinTextureId('_lightGradient');
        let n = 0;
        const room = cq.x.length;
        const shadowRes = this.config.lighting?.shadowResolution;
        const res = rtPixelScale(this.canvasWidth, rtPixelSize(this.canvasWidth, shadowRes));
        for (let i = 0; i < capL && n < room; i++) {
            const L = lights[i];
            if (!(L.rangeSq > 0) || !(L.intensity > 0)) continue;
            cq.x[n] = L.x;
            cq.y[n] = L.y;
            const scale = lightCookieScale(L.sqrtI);
            cq.scaleX[n] = scale;
            cq.scaleY[n] = scale;
            cq.alpha[n] = L.intensity / 50000;
            cq.textureId[n] = texId;
            n++;
        }
        cq.count = n;
        if (n <= 0) return 0;
        const opts = this._gpuPackOpts;
        this._resetGpuPackOpts(opts);
        opts.space = GPU_SPACE_SCREEN;
        opts.zoom = this._frameCameraZoom;
        opts.cameraX = this._frameCameraX;
        opts.cameraY = this._frameCameraY;
        opts.resolution = res;
        opts.sortKey = null;
        opts.type = null;
        opts.depthDenom = Math.max(1, n);
        const cctx = makePackContext(cq, opts, caps.maxCookie, this._gpuPackCtx);
        return cctx
            ? this._packRows(cq, cctx, dst.cookie, dst.cookieU32, GPU_SPRITE_FLOATS, caps.maxCookie, false)
            : 0;
    }

    _packGpuShadows(dst, q) {
        const caps = this.gpuQueueCaps;
        const res = this._gpuShadowsResult || (this._gpuShadowsResult = { sun: 0, stamp: 0, cookie: 0 });
        if (!this.shadowsEnabled || !caps || !(caps.maxSun > 0)) {
            res.sun = 0;
            res.stamp = 0;
            res.cookie = 0;
            return res;
        }
        const interval = this.shadowUpdateInterval | 0;
        const skip = interval > 1 && (this._shadowUpdateTick % interval) !== 0;
        this._shadowUpdateTick++;
        if (skip) {
            this._republishGpuShadows(dst, res);
            return res;
        }
        const sunN = this._packGpuSun(dst, q);
        const stamp = this._stampAgainstSun(dst, dst.sun, sunN, 0, 0, 1);
        const cookie = this._packGpuCookies(dst);
        res.sun = sunN;
        res.stamp = stamp;
        res.cookie = cookie;
        this._gpuShadowsFrom = dst;
        return res;
    }

    /**
     * A skipped shadow frame (shadowUpdateInterval > 1) reports the last
     * pack's counts, but the queue buffer alternates every frame: this one
     * holds rows from an older pack, or none (interval 2 always packs into the
     * same buffer). Copy the last pack's rows in. Plain loops: no per-frame view.
     */
    _republishGpuShadows(dst, res) {
        const src = this._gpuShadowsFrom;
        if (!src || src === dst) return;
        copyF32(dst.sun, src.sun, (res.sun | 0) * GPU_CASTER_FLOATS);
        copyF32(dst.stamp, src.stamp, (res.stamp | 0) * GPU_CASTER_FLOATS);
        const stampN = res.stamp | 0;
        const di = dst.stampLightIdx;
        const si = src.stampLightIdx;
        for (let i = 0; i < stampN; i++) di[i] = si[i];
        copyF32(dst.cookie, src.cookie, (res.cookie | 0) * GPU_SPRITE_FLOATS);
    }

    _allowGpuPainter() {
        return this._packGpuSpritesOn === PACK_GPU_SPRITES_PRERENDER
            && this._sortSprites === SORT_SPRITES_PRERENDER;
    }

    /**
     * A queue's rows through gpuPack.wasm (E-76 W9, close-out group B: every call, the JS packer it replaced is
     * tests/reference/gpuPackJs.mjs); a call it cannot take (a column outside the render-queue memory) packs nothing
     * and says so once.
     */
    _packRows(q, ctx, dst, dstU32, floatsPer, capacity, shadowCast) {
        const n = packInstancedRowsWasm(this._gpuPackWasm, q, ctx, dst, floatsPer, capacity, shadowCast);
        if (n >= 0) return n;
        if (!this._packRefusedWarned) {
            this._packRefusedWarned = true;
            console.error('[PRE_RENDER] gpuPack.wasm cannot pack a queue (a column outside the render-queue memory): its rows are not drawn');
        }
        return 0;
    }

    _bindGpuPackWriters() {
        if (this._gpuPackSpec) return;
        this._addPackSortMs = (ms) => { this.sortTimeThisFrame += ms; };
        this._writePackedSprites = (opts) => {
            const q = this._packQ;
            const dst = this._packDst;
            const cap = this.gpuQueueCaps.maxSprites;
            const ctx = makePackContext(q, opts, cap, this._gpuPackCtx);
            let n = 0;
            if (ctx) {
                n = this._gpuSplit ? this._packSpritesSplit(q, ctx, dst, cap) : -1;
                if (n < 0) {
                    // 15-float rows: whatever statics this buffer held are gone.
                    this._gpuStaticGen[this._queueBuf & 1] = 0;
                    n = this._packRows(q, ctx, dst.sprites, dst.spritesU32, GPU_SPRITE_FLOATS, cap, false);
                }
            }
            this._packParticles = ctx ? (ctx.particleCount | 0) : 0;
            return n;
        };
        this._writePackedGlow = (opts) => {
            const q = this._packQ;
            const dst = this._packDst;
            const cap = this.gpuQueueCaps.maxGlow;
            const ctx = makePackContext(q, opts, cap, this._gpuPackCtx);
            return ctx
                ? this._packRows(q, ctx, dst.glow, dst.glowU32, GPU_SPRITE_FLOATS, cap, false)
                : 0;
        };
        this._gpuPackSpec = {
            fillAll: true,
            sortedFlag: GPU_FLAG_SORTED,
            glowIncludeType: -1,
            writeSprites: this._writePackedSprites,
            writeGlow: this._writePackedGlow,
        };
    }

    /**
     * E-82b: the main sprites as two streams through gpuPack.wasm, the statics only when this GPU queue buffer
     * does not hold the queue's current generation (renderQueueStaticGen) for the same rows. The glow split's
     * list (_gpuIdxEntity: the rows that are not glows, in order) follows from the queue's types, which the
     * generation covers; a painter's order may move with the poses alone, so a sorted frame writes both. -1 when
     * the kernel does not take the call; the caller then packs 15-float rows and the frame goes without
     * GPU_FLAG_SPLIT.
     */
    _packSpritesSplit(q, ctx, dst, cap) {
        const slot = this._queueBuf & 1;
        const genView = this.renderQueueStaticGen;
        const sorted = ctx.useIndices && ctx.indices !== this._gpuIdxEntity;
        const gen = !sorted && genView.length ? genView[0] >>> 0 : 0;
        const scan = ctx.scanCount | 0;
        const rows = scan < cap ? scan : cap;
        const current = gen !== 0 && this._gpuStaticGen[slot] === gen && this._gpuStaticRows[slot] === rows;
        const n = packSplitRowsWasm(this._gpuPackWasm, q, ctx, dst.spritePose, current ? null : dst.spriteStatic, cap);
        if (n < 0) return -1;
        this._gpuStaticGen[slot] = gen;
        this._gpuStaticRows[slot] = n;
        this._packSplitUsed = true;
        this._packSplitGen = gen;
        return n;
    }

    _packGpuSprites(dst, q, allowPainter) {
        const caps = this.gpuQueueCaps;
        const opts = this._gpuPackOpts;
        this._resetGpuPackOpts(opts);
        const count = q.count | 0;
        const res = this._gpuSpritesResult
            || (this._gpuSpritesResult = { sprite: 0, glow: 0, particle: 0, flags: 0, staticGen: 0, indices: null });
        this._packSplitUsed = false;
        this._packSplitGen = 0;
        if (this._packGpuSpritesOn !== PACK_GPU_SPRITES_PRERENDER || count <= 0 || !caps) {
            res.sprite = 0;
            res.glow = 0;
            res.particle = 0;
            res.flags = 0;
            res.staticGen = 0;
            res.indices = null;
            return res;
        }
        this._bindGpuPackWriters();
        const typeArr = this.renderQueueType;
        // E-138: a presorted queue is in painter order already; it is packed as it is, and says so. Without glow
        // rows there is nothing to split out either: every row in queue order, with no slot list.
        const presorted = this._queuePresorted;
        const presortedNoGlow = presorted && this._presortGlowRows === 0;
        const allowSort = !presorted && !!(allowPainter && this._gpuPainter && q.sortKey);
        this._packDst = dst;
        this._packQ = q;
        this._packParticles = 0;
        const spec = this._gpuPackSpec;
        spec.count = count;
        spec.type = typeArr;
        spec.opts = opts;
        spec.splitGlow = !presortedNoGlow && !!(this._lightGlowAsSprite === false && typeArr && this._gpuIdxEntity);
        // Unsplit, the glow rows go to the glow batch only when glows are not sprites (as Pixi's layer sets it); the
        // spec read undefined, so an unsplit frame packed its sprite rows (type 0) into the glow batch.
        spec.glowIncludeType = !spec.splitGlow && !presortedNoGlow && this._lightGlowAsSprite === false ? 3 : -1;
        spec.idxEntity = this._gpuIdxEntity;
        spec.idxGlow = this._gpuIdxGlow;
        spec.painter = allowSort ? this._gpuPainter : null;
        spec.keysU32 = allowSort ? q.sortKeyU32 : null;
        spec.addSortMs = this.collectDetailedStats ? this._addPackSortMs : null;
        spec.glowCapacity = caps.maxGlow | 0;
        const packed = packSpriteLayer(spec);
        res.sprite = packed.sprite;
        res.glow = packed.glow;
        res.particle = this._packParticles | 0;
        res.flags = packed.flags | (this._packSplitUsed ? GPU_FLAG_SPLIT : 0) | (presorted ? GPU_FLAG_SORTED : 0);
        res.staticGen = this._packSplitUsed ? this._packSplitGen : 0;
        res.indices = packed.spriteIndices;
        return res;
    }

    _packGpuQueues(dst) {
        if (!dst || !this.gpuQueueCaps) return;
        const detail = this.collectDetailedStats;
        const tSprites = detail ? performance.now() : 0;
        const sortBefore = this.sortTimeThisFrame;
        clearGpuQueueHeader(dst.header);
        const q = this._gpuSoAFromBound();
        if ((this._emitWriteCount | 0) > (q.count | 0)) q.count = this._emitWriteCount | 0;
        const sprites = this._packGpuSprites(dst, q, this._allowGpuPainter());
        if (this._proxyHalves !== null) this._writeProxies(q, sprites);
        if (detail) {
            const sortDelta = this.sortTimeThisFrame - sortBefore;
            let ms = performance.now() - tSprites;
            if (sortDelta > 0) ms -= sortDelta;
            this.spritePackTimeThisFrame = ms > 0 ? ms : 0;
        }
        const tShadows = detail ? performance.now() : 0;
        const shadows = this._packGpuShadows(dst, q);
        const counts = this._gpuCounts || (this._gpuCounts = {});
        counts.sprite = sprites.sprite | 0;
        counts.glow = sprites.glow | 0;
        counts.particle = sprites.particle | 0;
        counts.sun = shadows.sun | 0;
        counts.stamp = shadows.stamp | 0;
        counts.cookie = shadows.cookie | 0;
        counts.flags = sprites.flags | 0;
        counts.staticGen = sprites.staticGen | 0;
        writeGpuQueueHeader(dst.header, counts, counts.flags);
        if (detail) this.shadowQTimeThisFrame = performance.now() - tShadows;
    }

    /**
     * The frame's GPU particle groups among the entities (gpuParticleProxies.js), into the split half of the
     * queue buffer being written: each group with the packed entity it is drawn before. Nothing listed when the
     * entities are not y-sorted (the layers then draw at their zIndex).
     */
    _writeProxies(q, sprites) {
        const half = this._proxyHalves[this._queueBuf & 1];
        const collector = this._proxyCollector;
        // Packed in painter order (or nothing packed): Pixi commits only such a frame when the entities y-sort.
        const ordered = (sprites.sprite | 0) === 0 || (sprites.flags & GPU_FLAG_SORTED) !== 0;
        let n = 0;
        if (this._entitySortY && ordered) {
            Time.readSimNowInto(this._proxyClock, 0);
            n = collector.collect(GpuParticles.layers, this._proxyClock, this._proxyFrameView());
        }
        if (n === 0) {
            half.header[1] = 0;
            Atomics.store(half.header, 0, 0);
            return;
        }
        collector.write(half, q.sortKey, sprites.indices, sprites.sprite | 0);
        if (collector.dropped > 0 && !this._proxyDroppedWarned) {
            this._proxyDroppedWarned = true;
            console.warn(`[PRE_RENDER] ${collector.dropped} GPU particle groups past the ${PROXY_MAX_ENTRIES} a frame among the entities are not drawn`);
        }
    }

    _proxyFrameView() {
        if (!this.cameraData) return null;
        const cam = this._proxyCamera;
        cam[PROXY_CAMERA.X] = this._frameCameraX;
        cam[PROXY_CAMERA.Y] = this._frameCameraY;
        cam[PROXY_CAMERA.ZOOM] = this._frameCameraZoom;
        cam[PROXY_CAMERA.ROT] = this._frameCameraRot || 0;
        cam[PROXY_CAMERA.CANVAS_W] = this.canvasWidth;
        cam[PROXY_CAMERA.CANVAS_H] = this.canvasHeight;
        return proxyView(this._proxyView, cam);
    }

    /**
     * LightEmitter list → visibleLightsData SAB (cookie shadows not required).
     * Independent of cookie ShadowCaster queue (raycasted lighting still needs this).
     */
    _collectVisibleLights() {
        const lightEntities = this._sortedLightEntities;
        let written = 0;

        const lightEnabled = LightEmitter.active;
        if (lightEnabled && this._queryLightEmitter) {
            const worldX = Transform.x;
            const worldY = Transform.y;
            const lightIntensity = LightEmitter.lightIntensity;
            const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;
            const flashActive = FlashComponent.active;
            const zoom = this.cameraData ? this._frameCameraZoom : 1;
            const camX = this.cameraData ? this._frameCameraX : 0;
            const camY = this.cameraData ? this._frameCameraY : 0;
            const screenBounds = this._frameCameraBoundsValid
                ? this._cameraBounds
                : calculateCameraScreenBounds(
                    zoom, camX, camY, this.canvasWidth, this.canvasHeight, this.cullingRatio, this._cameraBounds,
                    this._frameCameraRot
                );
            const worldBounds = screenBoundsToWorldBounds(screenBounds, 0, 0, this._worldBounds);
            const viewMinX = worldBounds.minX;
            const viewMaxX = worldBounds.maxX;
            const viewMinY = worldBounds.minY;
            const viewMaxY = worldBounds.maxY;

            const persistScratch = this._lightPersistScratch;
            const flashScratch = this._lightFlashScratch;
            let persistN = 0;
            let flashN = 0;

            const lightEntitiesRaw = Query.queryPublishedFrame(this._queryLightEmitter) === -1
                ? EMPTY_OWNED_IDS
                : Query.queryActiveEntities(this._queryLightEmitter);
            for (let i = 0; i < lightEntitiesRaw.length; i++) {
                const lightIdx = lightEntitiesRaw[i];
                if (!lightEnabled[lightIdx]) continue;

                const intensity = lightIntensity[lightIdx];
                if (!(intensity > 0)) continue;

                const lightX = worldX[lightIdx];
                const lightY = worldY[lightIdx];
                const lightInfluenceR = lightInfluenceRadius(sqrtLightIntensity[lightIdx]);
                if (lightX + lightInfluenceR < viewMinX || lightX - lightInfluenceR > viewMaxX ||
                    lightY + lightInfluenceR < viewMinY || lightY - lightInfluenceR > viewMaxY) {
                    continue;
                }

                const isFlash = flashActive ? flashActive[lightIdx] === 1 : false;
                if (isFlash) flashScratch[flashN++] = lightIdx;
                else persistScratch[persistN++] = lightIdx;
            }
            const maxWrite = this.visibleLightsData
                ? this.visibleLightsData.length - 1
                : persistN + flashN;

            if (persistN + flashN > maxWrite) {
                this._warnOnce(
                    '_warnedVisibleLightsCap',
                    `[PRE_RENDER] visible light list full (${maxWrite}). Increase lighting.maxLights or reduce visible lights.`
                );
                this._sortPrefix(persistScratch, persistN, this._lightYComparator);
                this._sortPrefix(flashScratch, flashN, this._lightYComparator);
                const persistTake = Math.min(persistN, maxWrite);
                for (let i = 0; i < persistTake; i++) lightEntities[written++] = persistScratch[i];
                const flashTake = Math.min(flashN, maxWrite - written);
                for (let i = 0; i < flashTake; i++) lightEntities[written++] = flashScratch[i];
            } else {
                for (let i = 0; i < persistN; i++) lightEntities[written++] = persistScratch[i];
                for (let i = 0; i < flashN; i++) lightEntities[written++] = flashScratch[i];
            }
            this._sortPrefix(lightEntities, written, this._lightYComparator);
        }

        if (this.visibleLightsData) {
            this.visibleLightsData[0] = written;
            for (let w = 0; w < written; w++) this.visibleLightsData[1 + w] = lightEntities[w];
        }
    }

    buildVisibilityPolygons() {
        if (!this.visibilityPolygonsEnabled) return;
        // W2a: the sweep runs only in visibilitySweep.wasm (close-out group B), which init binds whenever visibility
        // polygons are on. The JS sweep it replaced is tests/reference/visibilitySweepJs.mjs.
        if (this._visSweep === null) {
            if (!this._visRefusedWarned) {
                this._visRefusedWarned = true;
                console.error('[PRE_RENDER] raycasted lighting has no visibility sweep bound: the lights get no polygon');
            }
            return;
        }
        this._buildVisibilityPolygonsSwept();
    }

    /**
     * W2a. The light loop, each light's sweep in visibilitySweep.wasm: the gather (visibilityGather.wasm where the
     * scene placed its regions in the engine block, else the JS below) into the scratch on the visibility memory,
     * then one call per light for the sweep, the polar clip and the seen owners, and _dropUnseenSwept on what it
     * left.
     */
    _buildVisibilityPolygonsSwept() {
        const buf = this._vpWriteBuffer;
        if (!buf) { return; }

        const selfLitBuf = this._selfLitWriteBuffer;
        if (selfLitBuf) selfLitBuf.header[0] = 0;

        // Optional SoA may be absent when scene never registered LightEmitter / LightOccluder
        if (!LightEmitter.active || !LightOccluder.active || !Collider.active) {
            buf.header[0] = 0;
            return;
        }

        const transformActive = Transform.active;
        const occluderActive = LightOccluder.active;
        const occluderMaskMode = LightOccluder.maskMode;
        const occluderBlock = LightOccluder.block;
        const colliderActive = Collider.active;
        const shapeType = Collider.shapeType;
        const colRadius = Collider.radius;
        const colWidth = Collider.width;
        const colHeight = Collider.height;
        const colOffX = Collider.offsetX;
        const colOffY = Collider.offsetY;
        const polyCountArr = Collider.polyCount;
        const polyVertX = Collider.polyVertexX;
        const polyVertY = Collider.polyVertexY;
        const polyCentroidX = Collider.polyCentroidX;
        const polyCentroidY = Collider.polyCentroidY;
        const fixtureCountArr = Collider.fixtureCount;
        const fixtureHead = ColliderFixture.head;
        const fixtureNext = ColliderFixture.next;
        const fixtureActiveArr = ColliderFixture.active;
        const fixtureVertCount = ColliderFixture.vertCount;
        const fixtureVertX = ColliderFixture.vertexX;
        const fixtureVertY = ColliderFixture.vertexY;
        const fixturePoolMax = ColliderFixture.maxCount | 0;
        const fixtureRevision = ColliderFixture.revision;
        const lightEnabled = LightEmitter.active;
        const lightIntensity = LightEmitter.lightIntensity;
        const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;

        const neighborData = Grid.neighborData;
        const stride = Grid._stride;

        const maxVerts = this._vpMaxVerts;
        const maxLts = this._vpMaxLights;
        const slotBytes = this._vpSlotBytes;
        const kind = this._vpOccKind;
        const cX = this._vpCircleX;
        const cY = this._vpCircleY;
        const cR = this._vpCircleR;
        const vertStart = this._vpVertStart;
        const vertCountArr = this._vpVertCount;
        const vertsX = this._vpVertsX;
        const vertsY = this._vpVertsY;
        const maxOccluders = this._vpMaxOccluders;
        const outX = this._vpOutX;
        const outY = this._vpOutY;
        const i32 = buf.i32;
        const f32 = buf.f32;
        const pose = this._displayPoseOut;
        const sweepK = this._visSweep;
        const sweepLight = sweepK.sweep;
        const sweepTable = sweepK.table;
        const sweepTableByte = sweepK.tableByte;
        const sweepResults = sweepK.results;
        const ownerSeenByte = sweepK.ownerSeenByte;
        // W1: solidSegments.wasm (collectSolidWasm), bound at init; the doubles go through SOLID_ARGS.
        const collectSolid = this._visCollectSolid;

        const entityLastTextureId = this.entityLastTextureId;
        const maxSelfLit = this._selfLitMax || 0;
        let selfLitCount = 0;
        const selfLitI32 = selfLitBuf ? selfLitBuf.i32 : null;
        const selfLitF32 = selfLitBuf ? selfLitBuf.f32 : null;
        const selfLitU16 = selfLitBuf ? selfLitBuf.u16 : null;
        const selfLitU8 = selfLitBuf ? selfLitBuf.u8 : null;
        const selfLitItemBytes = this._selfLitItemBytes || 28;
        const selfLitSolid = this._selfLitSolid;
        const selfLitOcc = this._selfLitOcc;

        const visibleLights = this.visibleLightsData;
        if (!visibleLights) { buf.header[0] = 0; return; }

        const lightCount = visibleLights[0];
        if (lightCount === 0) { buf.header[0] = 0; return; }
        if (lightCount > maxLts) {
            this._warnOnce(
                '_warnedVisibilityPolygonLightCap',
                `[PRE_RENDER] visibility polygon light cap reached (${maxLts}). Increase lighting.maxLights or reduce raycasted visible lights.`
            );
        }

        let lightsWritten = 0;

        // W2b: each light's neighbour walk in visibilityGather.wasm when every column it reads is in the memory
        // this frame (the published pose generations move); the compound solids and the self-lit candidates come
        // back as events, in neighbour order.
        const gk = this._visGather;
        const gatherOn = gk !== null
            && writeGatherColumns(gk, this, Grid, Transform, Collider, LightOccluder, ColliderFixture, selfLitI32 !== null);
        const gatherRes = gatherOn ? gk.results : null;
        const evI32 = gatherOn ? gk.eventsI32 : null;
        const evF64 = gatherOn ? gk.eventsF64 : null;

        for (let li = 0; li < lightCount && lightsWritten < maxLts; li++) {
            const lightIdx = visibleLights[1 + li];
            if (!lightEnabled[lightIdx]) continue;

            const intensity = lightIntensity[lightIdx];
            if (intensity <= 0) continue;

            // Same display pose as sprites (post-step publish), not live Transform
            this._displayPose(lightIdx, pose);
            const lx = pose[0];
            const ly = pose[1];
            const influenceRadius = lightInfluenceRadius(sqrtLightIntensity[lightIdx]);
            SOLID_ARGS[6] = lx;
            SOLID_ARGS[7] = ly;
            SOLID_ARGS[8] = influenceRadius * influenceRadius;

            let occCount = 0;
            let vertPool = 0;
            let occluderLimitHit = false;
            if (!gatherOn) clearPolarBins(influenceRadius);
            const selfLitStart = selfLitCount;
            let solidsLit = 0;

            if (gatherOn) {
                // The bins are cleared before the light's first solid rasters; a light with none leaves them.
                skipPolarBins();
                let binsCleared = false;
                occCount = gk.gather(gk.tableByte, lightIdx, lx, ly, influenceRadius, this._poseAlpha);
                occluderLimitHit = gatherRes[3] !== 0;
                const events = gatherRes[2];
                for (let e = 0; e < events; e++) {
                    const ei = e * GATHER_EVENT_I32;
                    const ef = e * GATHER_EVENT_F64;
                    const nIdx = evI32[ei + 1];
                    const wx = evF64[ef + 2];
                    const wy = evF64[ef + 3];
                    const c = evF64[ef + 4];
                    const s = evF64[ef + 5];
                    if (evI32[ei] === GATHER_EV_SOLID) {
                        if (!binsCleared) {
                            clearPolarBins(influenceRadius);
                            binsCleared = true;
                        }
                        const solid = ensureCompoundSolid(
                            nIdx,
                            fixtureRevision ? fixtureRevision[0] : 0,
                            fixtureHead, fixtureNext, fixtureActiveArr,
                            fixtureVertCount, fixtureVertX, fixtureVertY,
                            fixtureHead[nIdx], fixturePoolMax,
                            false // segments only: the fill is pixi's (self-lit)
                        );
                        SOLID_ARGS[0] = wx;
                        SOLID_ARGS[1] = wy;
                        SOLID_ARGS[2] = c;
                        SOLID_ARGS[3] = s;
                        SOLID_ARGS[4] = colOffX[nIdx] || 0;
                        SOLID_ARGS[5] = colOffY[nIdx] || 0;
                        const hit = collectSolid(solid, nIdx);
                        if (!(hit > 0 && selfLitI32 && selfLitCount < maxSelfLit)) continue;
                        const byteOff = 4 + selfLitCount * selfLitItemBytes;
                        const i32Off = byteOff >> 2;
                        selfLitI32[i32Off] = nIdx;
                        selfLitI32[i32Off + 1] = lightIdx;
                        selfLitF32[i32Off + 2] = wx;
                        selfLitF32[i32Off + 3] = wy;
                        selfLitF32[i32Off + 4] = c;
                        selfLitF32[i32Off + 5] = s;
                        const u16Off = byteOff >> 1;
                        let texId = entityLastTextureId ? entityLastTextureId[nIdx] : INVALID_TEXTURE_ID;
                        if (texId === INVALID_TEXTURE_ID && (occluderMaskMode[nIdx] | 0) === LIGHT_OCCLUDER_MASK_SPRITE) {
                            texId = this._resolveEntitySpriteTextureId(nIdx);
                        }
                        selfLitU16[u16Off + 12] = texId;
                        selfLitU8[byteOff + 26] = occluderMaskMode[nIdx] | 0;
                        selfLitU8[byteOff + 27] = 0;
                        selfLitSolid[selfLitCount] = 1;
                        solidsLit++;
                        selfLitCount++;
                        continue;
                    }
                    // A packed occluder: the kernel sends these only while the self-lit list is on.
                    if (selfLitCount >= maxSelfLit) continue;
                        const byteOff = 4 + selfLitCount * selfLitItemBytes;
                        const i32Off = byteOff >> 2;
                        selfLitI32[i32Off] = nIdx;
                        selfLitI32[i32Off + 1] = lightIdx;
                        selfLitF32[i32Off + 2] = wx;
                        selfLitF32[i32Off + 3] = wy;
                        selfLitF32[i32Off + 4] = c;
                        selfLitF32[i32Off + 5] = s;
                        const u16Off = byteOff >> 1;
                        let texId = entityLastTextureId ? entityLastTextureId[nIdx] : INVALID_TEXTURE_ID;
                        if (texId === INVALID_TEXTURE_ID && (occluderMaskMode[nIdx] | 0) === LIGHT_OCCLUDER_MASK_SPRITE) {
                            texId = this._resolveEntitySpriteTextureId(nIdx);
                        }
                        selfLitU16[u16Off + 12] = texId;
                        selfLitU8[byteOff + 26] = occluderMaskMode[nIdx] | 0;
                        selfLitU8[byteOff + 27] = 0;
                        selfLitSolid[selfLitCount] = 0;
                        selfLitOcc[selfLitCount] = evI32[ei + 2];
                        selfLitCount++;
                }
            } else if (neighborData && stride > 0) {
                const offset = lightIdx * stride;
                const nCount = neighborData[offset];
                for (let k = 0; k < nCount; k++) {
                    if (occCount >= maxOccluders) {
                        occluderLimitHit = true;
                        break;
                    }
                    const nIdx = neighborData[offset + 1 + k];
                    if (!transformActive[nIdx] || !occluderActive[nIdx] || !colliderActive[nIdx]) continue;
                    if (occluderBlock && !(occluderBlock[nIdx] > 0)) continue;

                    this._displayPose(nIdx, pose);
                    const wx = pose[0];
                    const wy = pose[1];
                    const c = pose[2];
                    const s = pose[3];

                    const shape = shapeType[nIdx];
                    if (shape === ShapeType.Chain) continue;
                    const ox = colOffX[nIdx] || 0;
                    const oy = colOffY[nIdx] || 0;
                    const nFixtures = fixtureCountArr ? (fixtureCountArr[nIdx] | 0) : 0;
                    if (nFixtures > 0 && fixtureHead && nIdx < fixtureHead.length) {
                        const lcx = polyCentroidX ? polyCentroidX[nIdx] : 0;
                        const lcy = polyCentroidY ? polyCentroidY[nIdx] : 0;
                        const centX = wx + c * (ox + lcx) - s * (oy + lcy);
                        const centY = wy + s * (ox + lcx) + c * (oy + lcy);
                        const hw = (colWidth[nIdx] || 0) * 0.5;
                        const hh = (colHeight[nIdx] || 0) * 0.5;
                        const reach = Math.sqrt(hw * hw + hh * hh);
                        const cdx = centX - lx;
                        const cdy = centY - ly;
                        const bound = influenceRadius + reach;
                        if (cdx * cdx + cdy * cdy > bound * bound) continue;

                        const solid = ensureCompoundSolid(
                            nIdx,
                            fixtureRevision ? fixtureRevision[0] : 0,
                            fixtureHead, fixtureNext, fixtureActiveArr,
                            fixtureVertCount, fixtureVertX, fixtureVertY,
                            fixtureHead[nIdx], fixturePoolMax,
                            false // segments only: the fill is pixi's (self-lit)
                        );
                        SOLID_ARGS[0] = wx;
                        SOLID_ARGS[1] = wy;
                        SOLID_ARGS[2] = c;
                        SOLID_ARGS[3] = s;
                        SOLID_ARGS[4] = ox;
                        SOLID_ARGS[5] = oy;
                        const hit = collectSolid(solid, nIdx);
                        if (hit > 0 && selfLitI32 && selfLitCount < maxSelfLit) {
                            const byteOff = 4 + selfLitCount * selfLitItemBytes;
                            const i32Off = byteOff >> 2;
                            selfLitI32[i32Off] = nIdx;
                            selfLitI32[i32Off + 1] = lightIdx;
                            selfLitF32[i32Off + 2] = wx;
                            selfLitF32[i32Off + 3] = wy;
                            selfLitF32[i32Off + 4] = c;
                            selfLitF32[i32Off + 5] = s;
                            const u16Off = byteOff >> 1;
                            let texId = entityLastTextureId ? entityLastTextureId[nIdx] : INVALID_TEXTURE_ID;
                            if (texId === INVALID_TEXTURE_ID && (occluderMaskMode[nIdx] | 0) === LIGHT_OCCLUDER_MASK_SPRITE) {
                                texId = this._resolveEntitySpriteTextureId(nIdx);
                            }
                            selfLitU16[u16Off + 12] = texId;
                            selfLitU8[byteOff + 26] = occluderMaskMode[nIdx] | 0;
                            selfLitU8[byteOff + 27] = 0;
                            selfLitSolid[selfLitCount] = 1;
                            solidsLit++;
                            selfLitCount++;
                        }
                        continue;
                    }
                    const occX = wx + ox;
                    const occY = wy + oy;
                    const dx = occX - lx;
                    const dy = occY - ly;
                    let reach = 0;
                    if (shape === ShapeType.Circle) {
                        reach = colRadius[nIdx] || 0;
                    } else {
                        const hw = (colWidth[nIdx] || 0) * 0.5;
                        const hh = (colHeight[nIdx] || 0) * 0.5;
                        // H-03: sqrt, not Math.hypot - the overflow/underflow guard is wasted here.
                        // Measured ~16x cheaper (5/5 counterbalanced rounds, 1e-3..1e7). NOT
                        // bit-identical to hypot: it agrees on ~64% of in-range pairs and differs by
                        // a few ulps on the rest, because hypot is deliberately the more accurate of
                        // the two. That is ~1e-16 relative, far under the Float32 this value is
                        // stored into. Overflow is unreachable (Float64 squares overflow past ~1.34e154).
                        // Do not reintroduce hypot here without measuring it again.
                        reach = Math.sqrt(hw * hw + hh * hh);
                    }
                    const maxReach = influenceRadius + reach;
                    if (dx * dx + dy * dy > maxReach * maxReach) continue;

                    let packed = false;

                    if (shape === ShapeType.Circle) {
                        const r = colRadius[nIdx];
                        if (!(r > 0)) continue;
                        kind[occCount] = OCC_CIRCLE;
                        cX[occCount] = wx + ox;
                        cY[occCount] = wy + oy;
                        cR[occCount] = r;
                        vertStart[occCount] = 0;
                        vertCountArr[occCount] = 0;
                        packed = true;
                    } else if (shape === ShapeType.Box) {
                        const w = colWidth[nIdx];
                        const h = colHeight[nIdx];
                        if (!(w > 0) || !(h > 0)) continue;
                        kind[occCount] = OCC_POLY;
                        vertStart[occCount] = vertPool;
                        writeOrientedBoxVerts(
                            vertsX, vertsY, vertPool,
                            wx, wy, w, h, c, s, ox, oy
                        );
                        vertCountArr[occCount] = 4;
                        vertPool += 4;
                        packed = true;
                    } else if (shape === ShapeType.Polygon) {
                        const pc = polyCountArr[nIdx] | 0;
                        if (pc >= 3) {
                            kind[occCount] = OCC_POLY;
                            vertStart[occCount] = vertPool;
                            const base = nIdx * MAX_POLYGON_VERTICES;
                            writePolygonVerts(
                                vertsX, vertsY, vertPool,
                                wx, wy, c, s, ox, oy,
                                polyVertX, polyVertY, base, pc
                            );
                            vertCountArr[occCount] = pc;
                            vertPool += pc;
                            packed = true;
                        } else {
                            // Fallback to box extents when poly not filled
                            const w = colWidth[nIdx];
                            const h = colHeight[nIdx];
                            if (!(w > 0) || !(h > 0)) continue;
                            kind[occCount] = OCC_POLY;
                            vertStart[occCount] = vertPool;
                            writeOrientedBoxVerts(
                                vertsX, vertsY, vertPool,
                                wx, wy, w, h, c, s, ox, oy
                            );
                            vertCountArr[occCount] = 4;
                            vertPool += 4;
                            packed = true;
                        }
                    }

                    if (!packed) continue;

                    // Self-lit queue: bake display pose (frame-locked with sprites / umbra)
                    if (selfLitI32 && selfLitCount < maxSelfLit) {
                        const byteOff = 4 + selfLitCount * selfLitItemBytes;
                        const i32Off = byteOff >> 2;
                        selfLitI32[i32Off] = nIdx;
                        selfLitI32[i32Off + 1] = lightIdx;
                        selfLitF32[i32Off + 2] = wx;
                        selfLitF32[i32Off + 3] = wy;
                        selfLitF32[i32Off + 4] = c;
                        selfLitF32[i32Off + 5] = s;
                        const u16Off = byteOff >> 1;
                        let texId = entityLastTextureId ? entityLastTextureId[nIdx] : INVALID_TEXTURE_ID;
                        if (texId === INVALID_TEXTURE_ID && (occluderMaskMode[nIdx] | 0) === LIGHT_OCCLUDER_MASK_SPRITE) {
                            texId = this._resolveEntitySpriteTextureId(nIdx);
                        }
                        selfLitU16[u16Off + 12] = texId; // after 6×i32/f32 = 24 bytes
                        selfLitU8[byteOff + 26] = occluderMaskMode[nIdx] | 0;
                        selfLitU8[byteOff + 27] = 0;
                        selfLitSolid[selfLitCount] = 0;
                        selfLitOcc[selfLitCount] = occCount;
                        selfLitCount++;
                    }

                    occCount++;
                }
            }
            if (occluderLimitHit) {
                this._warnOnce(
                    '_warnedVisibilityPolygonOccluderCap',
                    `[PRE_RENDER] visibility polygon occluder cap reached (${maxOccluders} per light). Reduce occluder density or raise the internal cap.`
                );
            }

            // W2a: the sweep, and with compound solids in the bins the polar clip and the seen owners, in one call
            // on the memory the gather above packed (the _vp* scratch are its views). A light with self-lit items
            // takes a new N-19 stamp, and the kernel marks the solids its polygon shows with it.
            const polarActive = polarBinsActive();
            if (selfLitCount > selfLitStart) {
                let stamp = (this._selfLitSeenStamp + 1) >>> 0;
                if (stamp === 0) {
                    this._selfLitSeen.fill(0);
                    stamp = 1;
                }
                this._selfLitSeenStamp = stamp;
                sweepTable[SWEEP_OWNER_SEEN] = solidsLit > 0 && polarActive ? ownerSeenByte : 0;
                sweepTable[SWEEP_OWNER_STAMP] = stamp;
            } else {
                sweepTable[SWEEP_OWNER_SEEN] = 0;
            }
            const vertCount = sweepLight(sweepTableByte, lx, ly, influenceRadius, occCount, polarActive);
            // A light the sweep gave up on (its event or active cap): the JS sweep's warning, once.
            if (sweepResults[SWEEP_R_SEEN_VALID] === 0) {
                warnSweepOverflow(sweepResults[SWEEP_R_EVENT_OVERFLOW] !== 0, occCount);
            }
            // N-19 / N-39: an occluder is self-lit where this light sees it, not
            // wherever it is in range (rock behind rock, a box behind a box stay dark).
            if (selfLitCount > selfLitStart) {
                selfLitCount = this._dropUnseenSwept(selfLitBuf, selfLitStart, selfLitCount, solidsLit > 0 && polarActive);
            }

            // Layout: [lightIdx:i32, lightX:f32, lightY:f32, vertexCount:i32, x[N]:f32, y[N]:f32]
            const baseIndex = (4 + lightsWritten * slotBytes) >> 2;
            i32[baseIndex] = lightIdx;
            f32[baseIndex + 1] = lx;
            f32[baseIndex + 2] = ly;
            i32[baseIndex + 3] = vertCount;

            // A loop, not set(subarray(...)): two views per light per frame were 2.2 MB/s of garbage
            // in visPolyStressScene (N-1). The same Float32 rounding either way.
            const xStart = baseIndex + 4;
            const yStart = xStart + maxVerts;
            const copyCount = vertCount < maxVerts ? vertCount : maxVerts; // subarray clamped too
            for (let v = 0; v < copyCount; v++) {
                f32[xStart + v] = outX[v];
                f32[yStart + v] = outY[v];
            }

            lightsWritten++;
        }

        buf.header[0] = lightsWritten;
        if (selfLitBuf) selfLitBuf.header[0] = selfLitCount;
    }

    /**
     * W2a, N-19 / N-39. Keep this light's self-lit items [start, end) that its polygon shows, after the sweep
     * kernel: a solid when the light's call marked it with the stamp (the kernel's ownersMarked counts the bins
     * that did, -1 when no merge ran), a simple occluder when the kernel's N-39 stamps say a vertex landed on it
     * (every one after a sweep that gave up, and every one past the occluder cache).
     */
    _dropUnseenSwept(buf, start, end, polarActive) {
        const k = this._visSweep;
        const stamp = this._selfLitSeenStamp;
        const seen = this._selfLitSeen;
        const solidsKnown = !polarActive || k.resultsI32[SWEEP_R_OWNERS_MARKED] >= 0;
        const sawAll = k.results[SWEEP_R_SEEN_VALID] === 0;
        const sweepStamp = k.results[SWEEP_R_STAMP];
        const occSeen = k.seen;
        const occCache = k.occCache;
        const solid = this._selfLitSolid;
        const occ = this._selfLitOcc;
        const itemBytes = this._selfLitItemBytes;
        const i32 = buf.i32;
        const u8 = buf.u8;
        let w = start;
        for (let q = start; q < end; q++) {
            const off = 4 + q * itemBytes;
            if (solid[q]) {
                if (solidsKnown && seen[i32[off >> 2]] !== stamp) continue;
            } else {
                const oi = occ[q];
                if (!sawAll && oi < occCache && occSeen[oi] !== sweepStamp) continue;
            }
            if (w !== q) {
                u8.copyWithin(4 + w * itemBytes, off, off + itemBytes);
                solid[w] = solid[q];
                occ[w] = occ[q];
            }
            w++;
        }
        return w;
    }

    /**
     * Override reportFPS to write stats to SharedArrayBuffer
     */
    reportFPS() {
        if (!this.stats) return;
        // A backpressure skip did no work. Its near-zero step was averaged into
        // STEP_MS, so a Pixi that consumed faster (fewer skips) read as a slower
        // pre-render: +217 % in the E-82 sitting for the same busy time. It
        // publishes the skip and leaves the last frame that worked in the meters.
        if (this.skippedFramesThisFrame) {
            if (this.collectDetailedStats) this.stats[PRE_RENDER_STATS.SKIPPED_FRAMES] = 1;
            return;
        }
        // WAIT_MS stays 0 by construction here: pre-render's only wait on a
        // sibling is the backpressure skip, counted as SKIPPED_FRAMES below.
        this._writeFrameMeters(PRE_RENDER_STATS);
        this.stats[PRE_RENDER_STATS.VISIBLE_ENTITIES] = this.visibleEntitiesCount;
        // M1: a load key of the A/B gate, so it is published with detail off too.
        this.stats[PRE_RENDER_STATS.RENDER_QUEUE_SIZE] = this.renderQueueCount ? this.renderQueueCount[0] : 0;
        if (!this.collectDetailedStats) return;
        this.stats[PRE_RENDER_STATS.VISIBLE_PARTICLES] = this.visibleParticlesCount;
        this.stats[PRE_RENDER_STATS.VISIBLE_DECORATIONS] = this.visibleDecorationsCount;
        this.stats[PRE_RENDER_STATS.SHADOWS_UPDATED] = this.shadowsUpdatedThisFrame;
        this.stats[PRE_RENDER_STATS.MSG_MS] = this.messageTimeThisFrame;
        this.stats[PRE_RENDER_STATS.SKIPPED_FRAMES] = this.skippedFramesThisFrame;
        this.stats[PRE_RENDER_STATS.COLLECT_MS] = this.collectTimeThisFrame;
        this.stats[PRE_RENDER_STATS.SORT_MS] = this.sortTimeThisFrame;
        this.stats[PRE_RENDER_STATS.EMIT_MS] = this.emitTimeThisFrame;
        this.stats[PRE_RENDER_STATS.CUSTOM_LAYER_MS] = this.customLayerTimeThisFrame;
        this.stats[PRE_RENDER_STATS.SPRITE_PACK_MS] = this.spritePackTimeThisFrame;
        this.stats[PRE_RENDER_STATS.SHADOW_Q_MS] = this.shadowQTimeThisFrame;
        // E-29. STAMP_LIGHTS_MS is contained in SHADOW_Q_MS above; do not add them.
        this.stats[PRE_RENDER_STATS.STAMP_LIGHTS_MS] = this.stampLightsTimeThisFrame;
        this.stats[PRE_RENDER_STATS.VISIBLE_LIGHTS_MS] = this.visibleLightsTimeThisFrame;
        this.stats[PRE_RENDER_STATS.VISIBILITY_MS] = this.visibilityTimeThisFrame;
        this.stats[PRE_RENDER_STATS.ADOBE_MS] = this.adobeTimeThisFrame;
    }
}

// Create singleton instance
self.preRenderWorker = new PreRenderWorker(self);
