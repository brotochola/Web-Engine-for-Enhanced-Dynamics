// pre_render_worker.js - Pre-render worker for visibility, animation and render queue building
// Handles all visual calculations AFTER physics, BEFORE pixi_worker renders
// This worker is purely visual - no physics or game logic

import { ParticleComponent } from '../components/particleComponent.js';
import { DecorationComponent } from '../components/decorationComponent.js';
import { BulletComponent } from '../components/bulletComponent.js';
import { Transform } from '../components/transform.js';
import { RigidBody } from '../components/rigidBody.js';
import { Collider } from '../components/collider.js';
import { LightEmitter } from '../components/lightEmitter.js';
import { SpriteRenderer } from '../components/spriteRenderer.js';
import { AdobeAnimComponent } from '../components/adobeAnimComponent.js';
import { ShadowCaster } from '../components/shadowCaster.js';
import { FlashComponent } from '../components/flashComponent.js';
import { LightOccluder } from '../components/lightOccluder.js';
import { AbstractWorker } from './abstractWorker.js';
import { Camera } from '../core/camera.js';
import { Query } from '../core/query.js';
import {
    buildVisibilityPolygon,
    OCC_CIRCLE,
    OCC_POLY,
    writeOrientedBoxVerts,
    writePolygonVerts,
} from '../render/visibility/angularSweep.js';
import { Grid } from '../core/grid.js';
import { Sun } from '../core/sun.js';
import {
    calculateCameraScreenBounds,
    screenBoundsToWorldBounds,
    generateSymmetricalCirclePattern,
    lightInfluenceRadius,
    lightCookieScale,
    lightGlowScale,
} from '../util/utils.js';
import { PRE_RENDER_STATS, createStatsWriter } from '../util/workersUtils.js';
import {
    RENDERER_DEFAULTS,
    PRE_RENDER_DEFAULTS,
    CAMERA_TYPES,
    DECORATION_Y_SORT_SCALE,
    ENTITY_GLOW_SORT_BIAS,
    ShapeType,
    MAX_POLYGON_VERTICES,
    SPRITE_TILE_MODE,
} from '../util/configDefaults.js';
import { Layer } from '../core/layer.js';
import { createViews as createRenderQueueViews, createRenderQueueCameraViews } from '../render/renderQueueLayout.js';
import { bindLiquidFunRender } from '../render/liquidFunRender.js';
import { LiquidFun } from '../core/liquidFun.js';
import { DECORATION_NO_PARENT } from '../core/decorationPool.js';
import { AdobeAnimRegistry } from '../core/adobeAnimRegistry.js';
const INVALID_TEXTURE_ID = 0xFFFF;
const TILE_MODE_LOCAL = SPRITE_TILE_MODE.LOCAL;

/** Stretch / skip tiling on non-entity queue rows (particles, adobe pieces, …). */
function clearTileFields(ref, out) {
    if (ref.tileMode) ref.tileMode[out] = 0;
    if (ref.tileOffsetU) ref.tileOffsetU[out] = 0;
    if (ref.tileOffsetV) ref.tileOffsetV[out] = 0;
    if (ref.tileMulX) ref.tileMulX[out] = 0;
    if (ref.tileMulY) ref.tileMulY[out] = 0;
}

/**
 * Copy SoA tile fields and resolve signed GPU mul:
 * WORLD (or legacy repeatX with mode 0): +1/period
 * LOCAL: -(2 * boundsHalf) / period
 */
function writeEntityTileFields(
    ref, out, idx,
    srTileMode, srTileOffU, srTileOffV,
    srRepeatX, srRepeatY, srBHW, srBHH
) {
    const mode = srTileMode[idx];
    if (ref.tileMode) ref.tileMode[out] = mode;
    if (ref.tileOffsetU) ref.tileOffsetU[out] = srTileOffU[idx];
    if (ref.tileOffsetV) ref.tileOffsetV[out] = srTileOffV[idx];
    const rx = srRepeatX[idx];
    const ry = srRepeatY[idx];
    let mx = 0;
    let my = 0;
    if (rx > 0) mx = mode === TILE_MODE_LOCAL ? -(srBHW[idx] * 2) / rx : 1 / rx;
    if (ry > 0) my = mode === TILE_MODE_LOCAL ? -(srBHH[idx] * 2) / ry : 1 / ry;
    if (ref.tileMulX) ref.tileMulX[out] = mx;
    if (ref.tileMulY) ref.tileMulY[out] = my;
}
/** Composite depth sort: worldY * scale + innerZ (entities, decorations, bullets) */
const Y_SORT_K = DECORATION_Y_SORT_SCALE;
/**
 * PreRenderWorker - Handles all visual pre-calculations before rendering
 *
 * Responsibilities:
 * 1. Entity visibility; consume particle/decoration visible lists from particle_worker
 * 2. Animation frame advancement for entities
 * 3. Building main render queue (Y-sorted)
 * 4. Building shadow render queue (light cookies + black shadow sprites)
 * 5. Computing screenX/screenY for all visible renderables
 *
 * Data Flow:
 * - Reads: Transform, SpriteRenderer, ParticleComponent, DecorationComponent, LightEmitter, ShadowCaster
 * - Writes: Render queue SAB (consumed by pixi_worker), Shadow queue SAB, screenX/screenY
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
        this.shadowQTimeThisFrame = 0;
        this.visibilityTimeThisFrame = 0;
        this.adobeTimeThisFrame = 0;

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

        // Current write buffer reference (set each frame based on frame counter)
        // Tile fields (tileMode / tileOffset / tileMul): see renderQueueLayout.js
        this.renderQueueCount = null;
        this.renderQueueX = null;
        this.renderQueueY = null;
        this.renderQueueScaleX = null;
        this.renderQueueScaleY = null;
        this.renderQueueRotC = null;
        this.renderQueueRotS = null;
        this.renderQueueAlpha = null;
        this.renderQueueTint = null;
        this.renderQueueTextureId = null;
        this.renderQueueAnchorX = null;
        this.renderQueueAnchorY = null;
        this.renderQueueType = null;
        this.renderQueueEntityIndex = null;
        this.renderQueueSortKey = null;
        this.renderQueueRepeatX = null;
        this.renderQueueRepeatY = null;
        this.renderQueueCamera = null;
        this.renderQueuePoseReady = null;
        this._frameCameraZoom = 1;
        this._frameCameraX = 0;
        this._frameCameraY = 0;

        // Entity texture lookup buffer
        this.entityLastTextureId = null;

        // Animation frame tracking
        this.entityFrameIndex = null;
        this.entityFrameAccumulator = null;

        // Scratch for published physics pose / Transform (no per-call alloc)
        this._displayPoseOut = { x: 0, y: 0, rotC: 1, rotS: 0 };
        this.backpressure = true;

        // Physics pose publish latch (mirror renderQueueSync)
        this._rbActive = null;

        // Pose smoothing (preRender.interpolation) - self-measured physics-step
        // timing, no cross-worker config needed. Computed once per tick in
        // _latchPose(), consumed per-entity in _displayPose()/LiquidFun collect.
        this.interpolationMode = 'off';
        this.skipCull = false;
        this._fusedSunShadow = {
            writeIdx: 0,
            count: 0,
            maxItems: 0,
            maxShadowSprites: 0,
            maxShadowsPerEntity: 0,
            viewMinX: 0,
            viewMaxX: 0,
            viewMinY: 0,
            viewMaxY: 0,
            sunShadowRotC: 1,
            sunShadowRotS: 0,
            sunShadowAlpha: 1,
            rqX: null,
            rqY: null,
            rqScaleX: null,
            rqScaleY: null,
            rqRotC: null,
            rqRotS: null,
            rqAlpha: null,
            rqTint: null,
            rqTextureId: null,
            rqAnchorX: null,
            rqAnchorY: null,
            shadowCasterActive: null,
            shadowHeightMultiplier: null,
            shadowAnchorOffsetX: null,
            shadowAnchorOffsetY: null,
            transformActive: null,
            spriteScaleY: null,
            spriteAnchorX: null,
            spriteAnchorY: null,
            entityShadowCounts: null,
            toClear: null,
        };
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
        this._renderableCount = 0;

        // Pre-allocated query arrays
        this._queryLightEmitter = null;
        this._queryShadowCaster = null;
        this._querySpriteRenderer = null;
        this._queryAdobeAnim = null;

        // Per-frame cached query results (avoids duplicate queryActiveEntities calls)
        this._frameAdobeEntities = null;
        // Per-frame cached camera bounds (avoids redundant calculateCameraBounds calls)
        this._frameCameraBoundsValid = false;

        // Pre-allocated result object for _resolveAdobeFrameIndex (avoids per-entity alloc)
        this._adobeFrameResult = { asset: null, clipId: 0, frameIndex: 0 };

        // Pre-allocated ref for _emitAdobePieces (avoids per-frame alloc in buildRenderQueue)
        this._emitRef = {
            x: null, y: null, scaleX: null, scaleY: null,
            rotC: null, rotS: null, alpha: null, tint: null, textureId: null,
            anchorX: null, anchorY: null, type: null, entityIndex: null,
            repeatX: null, repeatY: null,
            tileMode: null, tileOffsetU: null, tileOffsetV: null,
            tileMulX: null, tileMulY: null,
        };

        // Flash grid-query: scratch buffer for candidate shadow casters + dedup marker
        this._flashCandidateBuffer = null;
        this._flashDedupMarker = null;

        // Precomputed circle patterns for flash grid queries (cellRadius -> Int32Array)
        this._flashCirclePatterns = null;

        // Visible lights SAB: written here, read by pixi (avoids duplicate query)
        this.visibleLightsData = null;

        // Scratch for entityShadowCounts clear (only clear used indices)
        this._entityShadowIndicesToClear = null;
        this._entityShadowIndicesToClearCount = 0;

        // ========================================
        // SHADOW RENDER QUEUE (DOUBLE BUFFERED)
        // ========================================
        // Uses same sync timing as main render queue (swapped together)
        this.shadowsEnabled = false;
        this.maxShadowCastingLights = 20;
        this.maxShadowsPerLight = 15;
        this.maxShadowsPerEntity = 0;
        this.maxShadowSprites = 0;
        this.maxShadowLights = 0;
        this.maxShadowRenderItems = 0;

        // Double buffer storage for shadows
        this.shadowRenderQueueBuffers = [null, null];

        // Current write buffer reference (set each frame based on frame counter)
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

        // Per-entity shadow count tracking
        this._entityShadowCounts = null;

        // GC OPTIMIZATION: Pre-allocated buffer for Y-sorted light indices
        this._sortedLightEntities = [];
        this._lightPersistScratch = [];
        this._lightFlashScratch = [];
        this._lightYComparator = (a, b) => Transform.y[a] - Transform.y[b];

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
    }

    _warnOnce(flagName, message) {
        if (this[flagName]) return;
        this[flagName] = true;
        console.warn(message);
    }

    /**
     * Initialize the pre-render worker
     */
    async initialize(data) {
        console.log('[PRE_RENDER WORKER] Starting initialize()...');

        // Initialize stats buffer
        if (data.buffers.preRenderStats) {
            this.stats = createStatsWriter(data.buffers.preRenderStats, PRE_RENDER_STATS);
            console.log('[PRE_RENDER WORKER] Stats buffer initialized');
        }

        // Configure scheduling from preRender config (camelCase key)
        const preRenderConfig = this.config.preRender || {};
        const fixedFps = Number(preRenderConfig.fixedFps);
        if (fixedFps > 0) {
            this.fixedFps = fixedFps;
            this.noLimitFPS = false;
        } else if (preRenderConfig.noLimitFPS === true) {
            this.noLimitFPS = true;
            console.log('[PRE_RENDER WORKER] Running in unlimited FPS mode');
        }
        this.backpressure = preRenderConfig.backpressure !== false;

        // Pose smoothing when physics runs slower than render (see configDefaults PRE_RENDER_DEFAULTS.interpolation).
        const interpConfig = preRenderConfig.interpolation || {};
        this.interpolationMode = interpConfig.mode ?? PRE_RENDER_DEFAULTS.interpolation.mode;
        this.skipCull = preRenderConfig.skipCull === true;

        // Store counts
        this.globalEntityCount = data.globalEntityCount || 0;
        this.maxParticles = data.maxParticles || 0;
        this.liquidFunMaxCount = data.liquidFunMaxCount || 0;
        if (data.buffers?.liquidFunRender && this.liquidFunMaxCount > 0) {
            this.liquidFun = bindLiquidFunRender(data.buffers.liquidFunRender, this.liquidFunMaxCount);
        }
        this.maxDecorations = data.maxDecorations || 0;
        this.maxBullets = data.maxBullets || 0;

        // Zenithal projection curve (scene-level). Mode is per-particle (viewMode).
        const particleConfig = this.config.particle || {};
        this.zenithalMaxHeight = particleConfig.zenithalMaxHeight ?? 50;
        this.zenithalScaleFactor = particleConfig.zenithalScaleFactor ?? 0.5;
        this.zenithalAlphaFade = particleConfig.zenithalAlphaFade ?? 0;

        // Store viewport dimensions
        this.canvasWidth = this.config.canvasWidth;
        this.canvasHeight = this.config.canvasHeight;
        this.cullingRatio = this.config.renderer?.cullingRatio ?? RENDERER_DEFAULTS.cullingRatio;

        // Decoration zoom-based fade/hide thresholds
        const rendererConfig = this.config.renderer || {};
        this.decorationFadeStartZoom = rendererConfig.startFadingDecorationsAtZoom ?? RENDERER_DEFAULTS.startFadingDecorationsAtZoom;
        this.decorationHideZoom = rendererConfig.hideDecorationsAtZoom ?? RENDERER_DEFAULTS.hideDecorationsAtZoom;
        this._decorationZoomAlpha = 1;

        console.log(`[PRE_RENDER WORKER] Entities: ${this.globalEntityCount}, Particles: ${this.maxParticles}, Decorations: ${this.maxDecorations}`);

        // ========================================
        // RENDER QUEUE - Initialize (DOUBLE BUFFERED)
        // ========================================
        if (data.renderQueue && data.renderQueue.dataA && data.renderQueue.dataB) {
            console.log('[PRE_RENDER WORKER] Initializing double-buffered render queue system...');
            this.renderQueueEnabled = true;
            this.renderQueueMaxItems = data.renderQueue.maxItems;

            // Initialize sync buffer for coordination with pixi_worker
            this.renderQueueSync = new Int32Array(data.renderQueue.sync);
            this.renderQueueFrame = 0;

            const maxItems = this.renderQueueMaxItems;

            // Create typed array views for BOTH buffers
            const bufferSABs = [data.renderQueue.dataA, data.renderQueue.dataB];
            const cameraSABs = [data.renderQueue.cameraA || null, data.renderQueue.cameraB || null];

            for (let bufIdx = 0; bufIdx < 2; bufIdx++) {
                this.renderQueueBuffers[bufIdx] = createRenderQueueViews(bufferSABs[bufIdx], maxItems);
                const camViews = createRenderQueueCameraViews(cameraSABs[bufIdx]);
                this.renderQueueCameraBuffers[bufIdx] = camViews ? camViews.camera : null;
                this.renderQueuePoseReadyBuffers[bufIdx] = camViews ? camViews.poseReady : null;
            }

            // Set initial write buffer (will be updated each frame)
            this._setWriteBuffer(0);

            // Entity texture lookup buffer
            if (data.renderQueue.entityTextureData) {
                this.entityLastTextureId = new Uint16Array(data.renderQueue.entityTextureData);
                this.entityLastTextureId.fill(INVALID_TEXTURE_ID);
            }

            // Animation state buffers
            if (this.globalEntityCount > 0) {
                this.entityFrameIndex = new Uint16Array(this.globalEntityCount);
                this.entityFrameAccumulator = new Float32Array(this.globalEntityCount);
            }

            // Pre-allocate renderable collector buffers
            this._renderableY = new Float32Array(maxItems);
            this._renderableType = new Uint8Array(maxItems);
            this._renderableIndex = new Int32Array(maxItems);
            this._renderablePx = new Float32Array(maxItems);
            this._renderablePy = new Float32Array(maxItems);
            this._renderableRotC = new Float32Array(maxItems);
            this._renderableRotS = new Float32Array(maxItems);

            // Pre-allocate query arrays
            this._queryLightEmitter = [LightEmitter];
            this._queryShadowCaster = [ShadowCaster];
            this._querySpriteRenderer = [SpriteRenderer];
            this._queryAdobeAnim = [AdobeAnimComponent];

            // Flash grid-query buffers (shadow caster candidates for flash lights)
            const maxCandidates = Grid.maxNeighbors || 500;
            this._flashCandidateBuffer = new Uint16Array(maxCandidates);
            if (this.globalEntityCount > 0) {
                this._flashDedupMarker = new Uint32Array(this.globalEntityCount);
            }

            // Precompute circle patterns for flash grid queries (cellRadius 0..6 covers typical flash radii)
            const cellSize = Grid.cellSize || 128;
            this._flashCirclePatterns = new Map();
            for (let r = 0; r <= 6; r++) {
                this._flashCirclePatterns.set(r, generateSymmetricalCirclePattern(r, cellSize));
            }

            console.log(`[PRE_RENDER WORKER] Double-buffered render queue initialized (max ${maxItems} items)`);

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

                    const collector = {
                        y: new Float32Array(layerMax),
                        type: new Uint8Array(layerMax),
                        index: new Int32Array(layerMax),
                        count: 0,
                        maxItems: layerMax,
                        ySorting: Layer.getById(layerId)?.ySorting !== false,
                    };
                    this._customLayerCollectors[layerId] = collector;

                    const bufs = [
                        createRenderQueueViews(lrq.dataA, layerMax),
                        createRenderQueueViews(lrq.dataB, layerMax),
                    ];
                    this._customLayerQueueBuffers[layerId] = bufs;
                    this._customLayerQueueRefs[layerId] = {};

                    this._customLayerEntries.push({ layerId, collector, bufs, ref: null });

                    console.log(`[PRE_RENDER WORKER] Custom layer ${layerId} render queue initialized (max ${layerMax} items)`);
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
            console.log(`[PRE_RENDER WORKER] Texture metadata loaded: ${data.textureMetadata.totalFrames} total frames`);
        }

        // ========================================
        // SHADOW RENDER QUEUE - Initialize (DOUBLE BUFFERED)
        // ========================================
        if (
            data.shadows &&
            data.shadows.enabled &&
            data.shadows.renderQueueDataA &&
            data.shadows.renderQueueDataB &&
            data.buffers?.componentData?.ShadowCaster
        ) {
            this.shadowsEnabled = true;
            this.maxShadowCastingLights = data.shadows.maxShadowCastingLights;
            this.maxShadowsPerLight = data.shadows.maxShadowsPerLight;
            this.maxShadowsPerEntity = data.shadows.maxShadowsPerEntity || 0;
            this.maxShadowSprites = data.shadows.maxShadowSprites;
            this.maxShadowLights = data.shadows.maxLights || 128;
            this.maxShadowRenderItems = data.shadows.maxRenderItems;

            if (this.maxShadowsPerEntity > 0 && this.globalEntityCount > 0) {
                this._entityShadowCounts = new Uint8Array(this.globalEntityCount);
            }

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

            // Set initial write buffer (will be updated each frame along with main queue)
            this._setShadowWriteBuffer(0);

            console.log(`[PRE_RENDER WORKER] Double-buffered shadow render queue initialized (${maxItems} max items)`);
        }

        // ========================================
        // VISIBLE LIGHTS BUFFER - Initialize
        // ========================================
        // Written here, read by pixi (avoids duplicate queryActiveEntities)
        if (data.buffers?.visibleLightsData) {
            this.visibleLightsData = new Uint16Array(data.buffers.visibleLightsData);
        }

        // Scratch for entityShadowCounts: only clear indices we touched (avoids full fill)
        if (this.globalEntityCount > 0) {
            this._entityShadowIndicesToClear = new Uint16Array(this.globalEntityCount);
        }

        // ========================================
        // SUN SYSTEM - Initialize
        // ========================================
        // Note: Sun static class is initialized by AbstractWorker.initializeCommonBuffers()
        // Shadow values are precomputed in Sun.setTimeOfDay (Scene advances time)
        if (Sun.isInitialized) {
            this.sunEnabled = Sun.enabled;
            console.log(`[PRE_RENDER WORKER] Sun system initialized (enabled: ${this.sunEnabled})`);
        }

        // ========================================
        // VISIBILITY POLYGONS - Initialize (raycasted light occlusion)
        // ========================================
        this.visibilityPolygonsEnabled = false;
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
            const maxOccluders = 256;
            this._vpOccKind = new Uint8Array(maxOccluders);
            this._vpCircleX = new Float32Array(maxOccluders);
            this._vpCircleY = new Float32Array(maxOccluders);
            this._vpCircleR = new Float32Array(maxOccluders);
            this._vpVertStart = new Int32Array(maxOccluders);
            this._vpVertCount = new Uint8Array(maxOccluders);
            // Max verts: 4 per box, MAX_POLYGON_VERTICES per poly, rare all-poly worst case
            this._vpVertsX = new Float32Array(maxOccluders * MAX_POLYGON_VERTICES);
            this._vpVertsY = new Float32Array(maxOccluders * MAX_POLYGON_VERTICES);
            this._vpMaxOccluders = maxOccluders;

            // Output scratch for polygon vertices
            this._vpOutX = new Float32Array(maxVerts);
            this._vpOutY = new Float32Array(maxVerts);

            // Self-lit queue (entity under own occluder fill)
            this._selfLitMax = data.visibilityPolygons.maxOccluderSelfLit || 512;
            this._selfLitItemBytes = 28;
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

            console.log(`[PRE_RENDER WORKER] Visibility polygons initialized (max ${maxLts} lights, ${maxVerts} verts/polygon, selfLit ${this._selfLitMax})`);
        }

        console.log('[PRE_RENDER WORKER] ✅ Initialize() completed!');
    }

    /**
     * Set the current write buffer for main render queue
     * @param {number} bufferIdx - 0 or 1
     */
    _setWriteBuffer(bufferIdx) {
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
        this.renderQueueType = buffer.type;
        this.renderQueueEntityIndex = buffer.entityIndex;
        this.renderQueueSortKey = buffer.sortKey;
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

    /**
     * Set the current write buffer for shadow render queue
     * @param {number} bufferIdx - 0 or 1
     */
    _setShadowWriteBuffer(bufferIdx) {
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
     * Update method called each frame
     */
    update(deltaTime, dtRatio) {
        this.skippedFramesThisFrame = 0;

        // ========================================
        // DOUBLE BUFFER BACKPRESSURE: skip instead of waiting
        // ========================================
        if (this.backpressure && this.renderQueueSync && this.renderQueueFrame > 0) {
            const consumedFrame = Atomics.load(this.renderQueueSync, 1);
            if (this.renderQueueFrame > consumedFrame + 1) {
                this.skippedFramesThisFrame = 1;
                return;
            }
        }

        // ========================================
        // SELECT WRITE BUFFER
        // ========================================
        // Alternate between buffer 0 and 1 each frame
        if (this.renderQueueEnabled) {
            const writeBufferIdx = this.renderQueueFrame % 2;
            this._setWriteBuffer(writeBufferIdx);

            // Shadow queue uses same buffer index (swapped together)
            if (this.shadowsEnabled) {
                this._setShadowWriteBuffer(writeBufferIdx);
            }
            // Visibility polygon buffer uses same swap
            if (this.visibilityPolygonsEnabled) {
                this._vpWriteBuffer = this._vpBuffers[writeBufferIdx];
                if (this._selfLitBuffers) {
                    this._selfLitWriteBuffer = this._selfLitBuffers[writeBufferIdx];
                }
            }
        }

        // Latch published physics pose once per frame (Atomics seq, same as pixi render queue).
        this._latchPose();
        if (this.renderQueuePoseReady) this.renderQueuePoseReady[0] = this._poseReadyFrame;

        // Latch camera once per pre-render frame to keep all culling and queue writes coherent.
        if (this.cameraData) {
            this._frameCameraZoom = this.cameraData[0];
            this._frameCameraX = this.cameraData[1];
            this._frameCameraY = this.cameraData[2];

            // followEntity: snap queue cam to this pack's pose + look-ahead
            // lead. Do not add (pack - followUsed) onto the eased SAB cam.
            const aligned = Camera.alignFollowCameraToLatchedPose(
                this._frameCameraX, this._frameCameraY, this._poseX, this._poseY
            );
            this._frameCameraX = aligned.x;
            this._frameCameraY = aligned.y;

            // Re-clamp position for the latched zoom to guard against the SAB
            // race where the logic worker wrote a new zoom but hasn't finished
            // clamping position yet.
            const ww = Camera.worldWidth;
            const wh = Camera.worldHeight;
            if (ww !== Infinity && wh !== Infinity && this._frameCameraZoom > 0) {
                const vpW = Camera.canvasWidth / this._frameCameraZoom;
                const vpH = Camera.canvasHeight / this._frameCameraZoom;
                const maxX = Math.max(0, ww - vpW);
                const maxY = Math.max(0, wh - vpH);
                this._frameCameraX = Math.max(0, Math.min(this._frameCameraX, maxX));
                this._frameCameraY = Math.max(0, Math.min(this._frameCameraY, maxY));
            }

            if (this.renderQueueCamera) {
                this.renderQueueCamera[0] = this._frameCameraZoom;
                this.renderQueueCamera[1] = this._frameCameraX;
                this.renderQueueCamera[2] = this._frameCameraY;
            }
        }

        // Reset stats
        this.visibleEntitiesCount = 0;
        this.visibleParticlesCount = 0;
        this.visibleDecorationsCount = 0;
        this.shadowsUpdatedThisFrame = 0;
        this._renderableCount = 0;
        // Canonical entity visibility for CameraInOutListener. Native fill is
        // cheaper than per-renderer false writes and keeps future renderers simple:
        // any render pass only sets Transform.isItOnScreen[i] = 1 when visible.
        if (Transform.isItOnScreen) Transform.isItOnScreen.fill(0);

        // Compute decoration zoom alpha (fully visible above fadeStart, fades to 0 at hideZoom)
        const zoom = this._frameCameraZoom;
        if (zoom >= this.decorationFadeStartZoom) {
            this._decorationZoomAlpha = 1;
        } else if (zoom <= this.decorationHideZoom) {
            this._decorationZoomAlpha = 0;
        } else {
            this._decorationZoomAlpha = (zoom - this.decorationHideZoom) / (this.decorationFadeStartZoom - this.decorationHideZoom);
        }

        // Cache per-frame camera bounds and adobe entity query (avoids redundant recomputation)
        this._frameCameraBoundsValid = this.cameraData !== null;
        if (this._frameCameraBoundsValid) this.calculateCameraBounds();
        // Optional SoA: skip Adobe query when scene never allocated AdobeAnimComponent
        this._frameAdobeEntities = AdobeAnimComponent.active
            ? Query.queryActiveEntities(this._queryAdobeAnim || [AdobeAnimComponent])
            : (this._emptyAdobeEntities || (this._emptyAdobeEntities = []));

        this.collectTimeThisFrame = 0;
        this.sortTimeThisFrame = 0;
        this.emitTimeThisFrame = 0;
        this.customLayerTimeThisFrame = 0;
        this.shadowQTimeThisFrame = 0;
        this.visibilityTimeThisFrame = 0;
        this.adobeTimeThisFrame = 0;

        const detail = this.collectDetailedStats;
        let t0 = 0;

        if (detail) t0 = performance.now();
        this.advanceAdobeAnimations(deltaTime);
        if (detail) this.adobeTimeThisFrame = performance.now() - t0;

        // Collect visible renderables for render queue (entities + sun shadows fused in one pass)
        if (detail) t0 = performance.now();
        this.collectVisibleParticles();
        this.collectVisibleLiquidFun();
        this.collectVisibleEntities();
        this.collectVisibleAdobeAnimations();
        this.collectVisibleDecorations();
        this.collectVisibleBullets();
        if (detail) this.collectTimeThisFrame = performance.now() - t0;

        // Build the final render queue (sorts by Y, writes to SAB)
        this.buildRenderQueue(deltaTime);

        // Build custom layer render queues (entities routed by layerMask bits)
        if (detail) t0 = performance.now();
        this.buildCustomLayerQueues(deltaTime);
        if (detail) this.customLayerTimeThisFrame = performance.now() - t0;

        // Visible lights SAB feeds lighting shader + vis-poly. Must run even when
        // cookie shadows are off (shadowsEnabled: false, raycasted: true).
        this._collectVisibleLights();

        // Build shadow render queue (sun shadows already done in collectVisibleEntities)
        if (detail) t0 = performance.now();
        this.buildShadowRenderQueue();
        if (detail) this.shadowQTimeThisFrame = performance.now() - t0;

        // Build visibility polygons for raycasted light occlusion
        if (detail) t0 = performance.now();
        this.buildVisibilityPolygons();
        if (detail) this.visibilityTimeThisFrame = performance.now() - t0;

        // ========================================
        // SIGNAL FRAME READY
        // ========================================
        // Increment frame counter and notify pixi_worker
        if (this.renderQueueSync) {
            this.renderQueueFrame++;
            Atomics.store(this.renderQueueSync, 0, this.renderQueueFrame);
            // Notify (pixi does not wait; harmless)
            Atomics.notify(this.renderQueueSync, 0, 1);
        }
    }

    /**
     * Calculate camera viewport bounds for screen visibility checks
     */
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
            this._cameraBounds
        );
    }

    /**
     * Collect visible particles for render queue
     * Uses visibleParticlesData SAB populated by particle_worker
     */
    collectVisibleParticles() {
        if (this.maxParticles === 0) return;

        const visibleData = this.visibleParticlesData;
        if (!visibleData) return;

        const visibleCount = visibleData[0];
        // if (visibleCount > 0 && visibleCount !== this._lastLoggedVisibleParticles) {
        //     this._lastLoggedVisibleParticles = visibleCount;
        //     console.log(`[pre_render_worker] Collecting ${visibleCount} visible particles into render queue`);
        // }
        const y = ParticleComponent.y;
        const z = ParticleComponent.z;
        const flat = ParticleComponent.flat;
        const viewMode = ParticleComponent.viewMode;

        for (let idx = 0; idx < visibleCount; idx++) {
            const i = visibleData[1 + idx];
            const isZenithal =
                viewMode &&
                viewMode[i] === CAMERA_TYPES.ZENITHAL &&
                !(flat && flat[i]);
            const isFlat = !!(flat && flat[i]);
            const sortKey = isZenithal
                ? -z[i]
                : isFlat
                    ? y[i] * Y_SORT_K
                    : (y[i] + z[i]) * Y_SORT_K;
            this.collectRenderable(1, i, sortKey);
            this.visibleParticlesCount++;
        }
    }

    collectVisibleLiquidFun() {
        const lf = this.liquidFun;
        if (!lf) return;
        const count = lf.count[0] | 0;
        if (count <= 0) return;

        const x = lf.x;
        const y = lf.y;
        const bounds = this._frameCameraBoundsValid ? this.calculateCameraBounds() : null;
        if (!bounds) {
            for (let i = 0; i < count; i++) {
                this.collectRenderable(7, i, y[i] * Y_SORT_K);
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
        for (let i = 0; i < count; i++) {
            const sx = x[i] * camZoom - camOffX;
            const sy = y[i] * camZoom - camOffY;
            if (sx > minX && sx < maxX && sy > minY && sy < maxY) {
                this.collectRenderable(7, i, y[i] * Y_SORT_K);
                this.visibleParticlesCount++;
            }
        }
    }

    /**
     * Entity visibility + collect for render queue + sun shadows (fused pass)
     * Iterates activeEntitiesData (or all entities), viewport culling, sets isItOnScreen/screenX/screenY,
     * adds visible to queue. When shadows enabled, also writes sun shadows in same pass.
     */
    _writeFusedSunShadow(i, renderVisibleI) {
        const s = this._fusedSunShadow;
        if (s.writeIdx >= s.maxItems || s.count >= s.maxShadowSprites) return;
        if (!s.shadowCasterActive[i] || !s.transformActive[i]) return;
        const heightMult = s.shadowHeightMultiplier[i];
        if (!(heightMult > 0 && (s.maxShadowsPerEntity <= 0 || (s.entityShadowCounts[i] ?? 0) < s.maxShadowsPerEntity))) return;

        const pose = this._displayPoseOut;
        if (!renderVisibleI) this._displayPose(i, pose);
        const casterX = pose.x;
        const casterY = pose.y;
        const textureId = this.entityLastTextureId ? this.entityLastTextureId[i] : INVALID_TEXTURE_ID;
        if (textureId === INVALID_TEXTURE_ID) return;
        const entityScaleY = Math.abs(s.spriteScaleY[i]) || 1;
        const anchorX = s.spriteAnchorX[i] ?? 0.5;
        const anchorY = s.spriteAnchorY[i] ?? 0.95;
        const lengthScale = -entityScaleY * heightMult * Sun.shadowLengthRatio;
        const originalHeight = this.frameHeight ? this.frameHeight[textureId] : 50;
        const shadowExtent = Math.abs(lengthScale) * originalHeight + 100;
        if (casterX + shadowExtent < s.viewMinX || casterX - shadowExtent > s.viewMaxX ||
            casterY + shadowExtent < s.viewMinY || casterY - shadowExtent > s.viewMaxY) return;

        const wi = s.writeIdx;
        s.rqX[wi] = casterX;
        s.rqY[wi] = casterY;
        s.rqScaleX[wi] = 1;
        s.rqScaleY[wi] = lengthScale;
        s.rqRotC[wi] = s.sunShadowRotC;
        s.rqRotS[wi] = s.sunShadowRotS;
        s.rqAlpha[wi] = s.sunShadowAlpha;
        s.rqTint[wi] = 0x000000;
        s.rqTextureId[wi] = textureId;
        s.rqAnchorX[wi] = anchorX + (s.shadowAnchorOffsetX[i] || 0);
        s.rqAnchorY[wi] = anchorY + (s.shadowAnchorOffsetY[i] || 0);
        s.writeIdx = wi + 1;
        s.count++;
        if (s.maxShadowsPerEntity > 0 && s.entityShadowCounts && s.toClear) {
            s.entityShadowCounts[i] = (s.entityShadowCounts[i] ?? 0) + 1;
            s.toClear[this._entityShadowIndicesToClearCount++] = i;
        }
    }

    collectVisibleEntities() {
        if (this.globalEntityCount === 0 || !SpriteRenderer.isItOnScreen || !this.cameraData) return;

        const cameraBounds = this.calculateCameraBounds();
        if (!cameraBounds) return;

        const x = Transform.x;
        const y = Transform.y;
        const active = Transform.active;
        const entityIsItOnScreen = Transform.isItOnScreen;
        const isItOnScreen = SpriteRenderer.isItOnScreen;
        const screenX = SpriteRenderer.screenX;
        const screenY = SpriteRenderer.screenY;
        const spriteRendererActive = SpriteRenderer.active;
        const renderVisible = SpriteRenderer.renderVisible;
        const visualRange = Collider.visualRange;
        const srScaleX = SpriteRenderer.scaleX;
        const srScaleY = SpriteRenderer.scaleY;
        const MIN_GLOW_INTENSITY = 50;
        const MIN_GLOW_RANGE = 2.5;

        const camZoom = cameraBounds.zoom;
        const cameraOffsetX = cameraBounds.cameraOffsetX;
        const cameraOffsetY = cameraBounds.cameraOffsetY;
        const screenMinX = cameraBounds.minX;
        const screenMaxX = cameraBounds.maxX;
        const screenMinY = cameraBounds.minY;
        const screenMaxY = cameraBounds.maxY;

        // Iteration source: queryActiveEntities([SpriteRenderer]) for only sprite entities, else fallback.
        // Normalized to (array, base offset) instead of a per-frame closure so the
        // hot loop below stays allocation-free and the index load stays inlineable.
        let iterCount, iterSource, iterBase;
        const spriteEntities = Query.queryActiveEntities(this._querySpriteRenderer || [SpriteRenderer]);
        if (spriteEntities && spriteEntities.length > 0) {
            iterCount = spriteEntities.length;
            iterSource = spriteEntities;
            iterBase = 0;
        } else if (this.activeEntitiesData && this.activeEntitiesData[0] > 0) {
            iterSource = this.activeEntitiesData;
            iterCount = iterSource[0];
            iterBase = 1;
        } else {
            iterCount = this.globalEntityCount;
            iterSource = null; // identity: entity index == loop index
            iterBase = 0;
        }

        // Sun shadows (fused): write during same pass when enabled
        const doSunShadows = this.shadowsEnabled &&
            Sun.isInitialized && Sun.enabled && Sun.intensity > 0.1 &&
            this.shadowRenderQueueX && this.maxShadowRenderItems > 0 &&
            ShadowCaster.active;

        const maxShadowsPerEntity = this.maxShadowsPerEntity ?? 0;
        if (this.shadowsEnabled && maxShadowsPerEntity > 0 &&
            this._entityShadowCounts && this._entityShadowIndicesToClear) {
            const prevToClearCount = this._entityShadowIndicesToClearCount ?? 0;
            const counts = this._entityShadowCounts;
            const toClearBuf = this._entityShadowIndicesToClear;
            for (let k = 0; k < prevToClearCount; k++) counts[toClearBuf[k]] = 0;
            this._entityShadowIndicesToClearCount = 0;
        }

        let rqX, rqY, rqScaleX, rqScaleY, rqRotC, rqRotS, rqAlpha, rqTint, rqTextureId, rqAnchorX, rqAnchorY;
        let viewMinX, viewMaxX, viewMinY, viewMaxY;
        let sunShadowRotC, sunShadowRotS, sunShadowAlpha;
        let shadowCasterActive, shadowHeightMultiplier, shadowAnchorOffsetX, shadowAnchorOffsetY;
        let worldX, worldY, transformActive, spriteScaleY, spriteAnchorX, spriteAnchorY;
        let entityShadowCounts, toClear;
        if (doSunShadows) {
            const screenBounds = calculateCameraScreenBounds(
                this._frameCameraZoom, this._frameCameraX, this._frameCameraY,
                this.canvasWidth, this.canvasHeight, this.cullingRatio, this._cameraBounds
            );
            const worldBounds = screenBoundsToWorldBounds(screenBounds, 0, 0, this._worldBounds);
            viewMinX = worldBounds.minX;
            viewMaxX = worldBounds.maxX;
            viewMinY = worldBounds.minY;
            viewMaxY = worldBounds.maxY;
            const si = Sun.intensity;
            sunShadowAlpha = Sun.shadowAlpha * si * (1 - Sun.shadowStretchAlphaFactor * (1 - Sun.shadowMinLengthRatio / Sun.shadowLengthRatio));
            // Sprite facing = shadowDir rotated -90°: cos(θ-π/2)=sin(θ)=dirY, sin(θ-π/2)=-cos(θ)=-dirX
            sunShadowRotC = Sun.shadowDirY;
            sunShadowRotS = -Sun.shadowDirX;
            rqX = this.shadowRenderQueueX;
            rqY = this.shadowRenderQueueY;
            rqScaleX = this.shadowRenderQueueScaleX;
            rqScaleY = this.shadowRenderQueueScaleY;
            rqRotC = this.shadowRenderQueueRotC;
            rqRotS = this.shadowRenderQueueRotS;
            rqAlpha = this.shadowRenderQueueAlpha;
            rqTint = this.shadowRenderQueueTint;
            rqTextureId = this.shadowRenderQueueTextureId;
            rqAnchorX = this.shadowRenderQueueAnchorX;
            rqAnchorY = this.shadowRenderQueueAnchorY;
            shadowCasterActive = ShadowCaster.active;
            shadowHeightMultiplier = ShadowCaster.heightMultiplier;
            shadowAnchorOffsetX = ShadowCaster.anchorOffsetX;
            shadowAnchorOffsetY = ShadowCaster.anchorOffsetY;
            worldX = Transform.x;
            worldY = Transform.y;
            transformActive = Transform.active;
            spriteScaleY = SpriteRenderer.scaleY;
            spriteAnchorX = SpriteRenderer.anchorX;
            spriteAnchorY = SpriteRenderer.anchorY;
            entityShadowCounts = this._entityShadowCounts;
            toClear = this._entityShadowIndicesToClear;
        }

        const maxItems = this.maxShadowRenderItems ?? 0;
        const maxShadowSprites = this.maxShadowSprites ?? 0;
        if (doSunShadows) {
            const s = this._fusedSunShadow;
            s.writeIdx = 0;
            s.count = 0;
            s.maxItems = maxItems;
            s.maxShadowSprites = maxShadowSprites;
            s.maxShadowsPerEntity = maxShadowsPerEntity;
            s.viewMinX = viewMinX;
            s.viewMaxX = viewMaxX;
            s.viewMinY = viewMinY;
            s.viewMaxY = viewMaxY;
            s.sunShadowRotC = sunShadowRotC;
            s.sunShadowRotS = sunShadowRotS;
            s.sunShadowAlpha = sunShadowAlpha;
            s.rqX = rqX;
            s.rqY = rqY;
            s.rqScaleX = rqScaleX;
            s.rqScaleY = rqScaleY;
            s.rqRotC = rqRotC;
            s.rqRotS = rqRotS;
            s.rqAlpha = rqAlpha;
            s.rqTint = rqTint;
            s.rqTextureId = rqTextureId;
            s.rqAnchorX = rqAnchorX;
            s.rqAnchorY = rqAnchorY;
            s.shadowCasterActive = shadowCasterActive;
            s.shadowHeightMultiplier = shadowHeightMultiplier;
            s.shadowAnchorOffsetX = shadowAnchorOffsetX;
            s.shadowAnchorOffsetY = shadowAnchorOffsetY;
            s.transformActive = transformActive;
            s.spriteScaleY = spriteScaleY;
            s.spriteAnchorX = spriteAnchorX;
            s.spriteAnchorY = spriteAnchorY;
            s.entityShadowCounts = entityShadowCounts;
            s.toClear = toClear;
        }

        for (let idx = 0; idx < iterCount; idx++) {
            const i = iterSource ? iterSource[iterBase + idx] : idx;
            if (!active[i]) {
                if (isItOnScreen[i] !== 0) isItOnScreen[i] = 0;
                continue;
            }
            if (!spriteRendererActive || !spriteRendererActive[i]) continue;

            if (this.skipCull) {
                // skip AABB + screenXY
            } else {
                const sx = x[i] * camZoom - cameraOffsetX;
                const sy = y[i] * camZoom - cameraOffsetY;
                // B: SpriteRenderer.screenX/Y have no readers

                // Use cached bounds (updated on scale/animation change)
                let halfExtent = 0;
                const halfW = SpriteRenderer.boundsHalfW?.[i] ?? 0;
                const halfH = SpriteRenderer.boundsHalfH?.[i] ?? 0;
                if (halfW > 0 || halfH > 0) halfExtent = halfW > halfH ? halfW : halfH;
                if (halfExtent <= 0) halfExtent = visualRange[i] || 0;
                const extent = halfExtent * camZoom;
                const onScreen = sx >= screenMinX - extent && sx <= screenMaxX + extent &&
                    sy >= screenMinY - extent && sy <= screenMaxY + extent;
                if (!onScreen) {
                    isItOnScreen[i] = 0;
                    continue;
                }
            }

            isItOnScreen[i] = 1;
            entityIsItOnScreen[i] = 1;

            if (renderVisible[i]) {
                this.collectRenderable(0, i, y[i] * Y_SORT_K);
                this.visibleEntitiesCount++;
            }

            if (doSunShadows) this._writeFusedSunShadow(i, renderVisible[i]);
        }

        // PRE-HOT: glow collect in a separate pass over LightEmitter actives only
        if (this._queryLightEmitter && LightEmitter.active && LightEmitter.hasGlowSprite) {
            const lights = Query.queryActiveEntities(this._queryLightEmitter);
            if (lights && lights.length > 0) {
                const leActive = LightEmitter.active;
                const leGlow = LightEmitter.hasGlowSprite;
                const leIntensity = LightEmitter.lightIntensity;
                const leSqrt = LightEmitter.sqrtLightIntensity;
                const onScreen = SpriteRenderer.isItOnScreen || Transform.isItOnScreen;
                for (let li = 0; li < lights.length; li++) {
                    const i = lights[li];
                    if (!leActive[i] || !leGlow[i]) continue;
                    if (leIntensity[i] < MIN_GLOW_INTENSITY) continue;
                    if ((visualRange[i] || leSqrt[i] || 200) < MIN_GLOW_RANGE) continue;
                    if (onScreen && !onScreen[i]) continue;
                    this.collectRenderable(3, i, y[i] * Y_SORT_K + ENTITY_GLOW_SORT_BIAS);
                }
            }
        }

        if (doSunShadows) {
            this._sunShadowWriteIdx = this._fusedSunShadow.writeIdx;
            this._sunShadowCount = this._fusedSunShadow.count;
        }
    }

    advanceAdobeAnimations(deltaTime) {
        if (!AdobeAnimComponent.active) return;

        const deltaSeconds = deltaTime / 1000;
        if (deltaSeconds <= 0) return;

        const active = AdobeAnimComponent.active;
        const playing = AdobeAnimComponent.playing;
        const playbackRate = AdobeAnimComponent.playbackRate;
        const assetId = AdobeAnimComponent.assetId;
        const clipId = AdobeAnimComponent.clipId;
        const time = AdobeAnimComponent.time;
        const loop = AdobeAnimComponent.loop;

        const adobeEntities = this._frameAdobeEntities;
        if (!adobeEntities || adobeEntities.length === 0) return;

        for (let n = 0; n < adobeEntities.length; n++) {
            const i = adobeEntities[n];
            if (!active[i] || !playing[i]) continue;

            const frameCount = AdobeAnimRegistry.getClipFrameCount(assetId[i], clipId[i]);
            const frameRate = AdobeAnimRegistry.getClipFrameRate(assetId[i], clipId[i]);
            if (frameCount <= 0 || frameRate <= 0) continue;

            const duration = frameCount / frameRate;
            const nextTime = time[i] + deltaSeconds * playbackRate[i];

            if (loop[i]) {
                time[i] = duration > 0 ? ((nextTime % duration) + duration) % duration : 0;
            } else if (nextTime >= duration) {
                time[i] = duration;
                playing[i] = 0;
            } else if (nextTime <= 0) {
                time[i] = 0;
                playing[i] = 0;
            } else {
                time[i] = nextTime;
            }
        }
    }

    collectVisibleAdobeAnimations() {
        if (this.globalEntityCount === 0 || !AdobeAnimComponent.isItOnScreen || !this._frameCameraBoundsValid) return;

        const cameraBounds = this._cameraBounds;

        const x = Transform.x;
        const y = Transform.y;
        const active = Transform.active;
        const entityIsItOnScreen = Transform.isItOnScreen;
        const adobeActive = AdobeAnimComponent.active;
        const renderVisible = AdobeAnimComponent.renderVisible;
        const isItOnScreen = AdobeAnimComponent.isItOnScreen;
        const screenX = AdobeAnimComponent.screenX;
        const screenY = AdobeAnimComponent.screenY;
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
            if (!active[i] || !adobeActive[i]) {
                if (isItOnScreen[i] !== 0) isItOnScreen[i] = 0;
                continue;
            }

            if (this.skipCull) {
                // skip AABB + screenXY
            } else {
                const sx = x[i] * camZoom - cameraOffsetX;
                const sy = y[i] * camZoom - cameraOffsetY;
                // B: AdobeAnimComponent.screenX/Y have no readers

                const extent = (halfW[i] > halfH[i] ? halfW[i] : halfH[i]) * camZoom;
                const onScreen =
                    sx >= screenMinX - extent &&
                    sx <= screenMaxX + extent &&
                    sy >= screenMinY - extent &&
                    sy <= screenMaxY + extent;

                if (!onScreen) {
                    isItOnScreen[i] = 0;
                    continue;
                }
            }

            isItOnScreen[i] = 1;
            entityIsItOnScreen[i] = 1;
            if (renderVisible[i]) {
                this.collectRenderable(6, i, y[i] * Y_SORT_K);
                this.visibleEntitiesCount++;
            }
        }
    }

    /**
     * Collect visible decorations for render queue
     * Uses visibleDecorationsData SAB populated by particle_worker
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
            if (p !== DECORATION_NO_PARENT && tActive[p]) {
                sortY = ty[p] * Y_SORT_K + innerZ[i];
            } else {
                sortY = y[i] * Y_SORT_K + innerZ[i];
            }
            this.collectRenderable(2, i, sortY);
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

        const visibleCount = visibleData[0];
        const y = BulletComponent.y;
        const trailWidth = BulletComponent.trailWidth;
        const active = BulletComponent.active;

        for (let idx = 0; idx < visibleCount; idx++) {
            const i = visibleData[1 + idx];
            if (!active[i]) continue;
            this.collectRenderable(4, i, y[i] * Y_SORT_K);
            if (trailWidth[i] > 0) {
                this.collectRenderable(5, i, y[i] * Y_SORT_K - 1);
            }
        }
    }

    /**
     * Collect a visible renderable for the render queue.
     * layerMask bits route to each sprite-queue layer. Density bits are splat, not queued.
     */
    collectRenderable(type, index, y) {
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
            this._writeRenderable(type, index, y, layerId);
            wroteSprite = true;
            bits ^= lsb;
        }
        if (!wroteSprite && !isParticle) {
            this._writeRenderable(type, index, y, Layer.entitiesId);
        }
    }

    _writeRenderable(type, index, y, layerId) {
        if (this._customLayerCollectors && layerId !== Layer.entitiesId) {
            const collector = this._customLayerCollectors[layerId];
            if (collector) {
                if (collector.count < collector.maxItems) {
                    const wi = collector.count;
                    collector.y[wi] = y;
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
            if (!this._renderQueueOverflowWarned) {
                this._renderQueueOverflowWarned = true;
                console.warn(`[PRE_RENDER] Main render queue collector full (max ${this.renderQueueMaxItems}). Increase renderer.maxVisibleRenderables.`);
            }
            return;
        }
        const writeIdx = this._renderableCount;
        this._renderableY[writeIdx] = y;
        this._renderableType[writeIdx] = type;
        this._renderableIndex[writeIdx] = index;
        if (type === 0 || type === 6) {
            const pose = this._displayPoseOut;
            this._displayPose(index, pose);
            this._renderablePx[writeIdx] = pose.x;
            this._renderablePy[writeIdx] = pose.y;
            this._renderableRotC[writeIdx] = pose.rotC;
            this._renderableRotS[writeIdx] = pose.rotS;
        } else if (type === 2) {
            const pose = this._displayPoseOut;
            this._decorationWorldXY(index, pose);
            this._renderablePx[writeIdx] = pose.x;
            this._renderablePy[writeIdx] = pose.y;
            this._renderableRotC[writeIdx] = DecorationComponent.rotC[index];
            this._renderableRotS[writeIdx] = DecorationComponent.rotS[index];
        }
        this._renderableCount = writeIdx + 1;
    }

    _resolveAdobeFrameIndex(entityIndex) {
        const r = this._adobeFrameResult;
        const assetId = AdobeAnimComponent.assetId[entityIndex];
        const clipId = AdobeAnimComponent.clipId[entityIndex];
        const frameCount = AdobeAnimRegistry.getClipFrameCount(assetId, clipId);
        const frameRate = AdobeAnimRegistry.getClipFrameRate(assetId, clipId);

        if (frameCount <= 0 || frameRate <= 0) {
            r.asset = null; r.clipId = 0; r.frameIndex = 0;
            return r;
        }

        const asset = AdobeAnimRegistry.getAsset(assetId);
        if (!asset) {
            r.asset = null; r.clipId = 0; r.frameIndex = 0;
            return r;
        }

        const duration = frameCount / frameRate;
        let time = AdobeAnimComponent.time[entityIndex];
        if (duration > 0) {
            if (AdobeAnimComponent.loop[entityIndex]) {
                time = ((time % duration) + duration) % duration;
            } else if (time >= duration) {
                time = duration;
            } else if (time < 0) {
                time = 0;
            }
        } else {
            time = 0;
        }

        let frameIndex = frameCount > 1 ? (time * frameRate) | 0 : 0;
        if (frameIndex >= frameCount) frameIndex = frameCount - 1;
        if (frameIndex < 0) frameIndex = 0;

        r.asset = asset; r.clipId = clipId; r.frameIndex = frameIndex;
        return r;
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
        if (this.interpolationMode === 'off') return;
        const ready = this.poseSync ? Atomics.load(this.poseSync, 0) : 0;
        if (ready === this._lfPoseReadyFrame) return;

        const n = lf.count[0] | 0;
        const maxN = this.liquidFunMaxCount | 0;
        if (!this._lfSnapX || this._lfSnapX.length < maxN) {
            this._lfSnapX = new Float32Array(maxN);
            this._lfSnapY = new Float32Array(maxN);
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
        if (this.interpolationMode === 'off') return;
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
     * Writes into caller-provided `out` (no alloc). Applies preRender.interpolation
     * (mode 'interpolate' | 'off') when a published pose is available.
     * @param {number} idx
     * @param {{ x: number, y: number, rotC: number, rotS: number }} out
     */
    _displayPose(idx, out) {
        const poseX = this._poseX;
        const rb = this._rbActive;
        if (poseX && rb && rb[idx]) {
            if (this.interpolationMode === 'interpolate' && this._prevPoseX) {
                const alpha = this._poseAlpha;
                const px = this._prevPoseX[idx];
                const py = this._prevPoseY[idx];
                out.x = px + (poseX[idx] - px) * alpha;
                out.y = py + (this._poseY[idx] - py) * alpha;
                const pc = this._prevPoseRotC[idx];
                const ps = this._prevPoseRotS[idx];
                const c = this._poseRotC[idx];
                const s = this._poseRotS[idx];
                if (pc === c && ps === s) {
                    // Rotation unchanged this interval (fixedRotation bodies,
                    // or a rotating body momentarily still) - any alpha blend
                    // is exactly this same value, already unit length. Skip
                    // the lerp+renormalize below entirely (exact, not lossy).
                    out.rotC = c;
                    out.rotS = s;
                    return;
                }
                const rc = pc + (c - pc) * alpha;
                const rs = ps + (s - ps) * alpha;
                // Renormalize the lerped unit complex number (rotC,rotS) - plain
                // sqrt, not Math.hypot (its overflow/underflow guard is wasted
                // cost here; c,s are always small, bounded values).
                const len = Math.sqrt(rc * rc + rs * rs) || 1;
                out.rotC = rc / len;
                out.rotS = rs / len;
                return;
            }
            out.x = poseX[idx];
            out.y = this._poseY[idx];
            out.rotC = this._poseRotC[idx];
            out.rotS = this._poseRotS[idx];
            return;
        }
        out.x = Transform.x[idx];
        out.y = Transform.y[idx];
        out.rotC = Transform.rotC ? (Transform.rotC[idx] ?? 1) : 1;
        out.rotS = Transform.rotS ? (Transform.rotS[idx] ?? 0) : 0;
    }

    /**
     * World xy for a decoration slot. Parented: compose from parent published pose + local.
     * Writes x/y into out; facing left to DecorationComponent.rotC/rotS by caller.
     */
    _decorationWorldXY(decoIdx, out) {
        const p = DecorationComponent.parentEntityIndex[decoIdx];
        const ox = DecorationComponent.offsetX[decoIdx];
        const oy = DecorationComponent.offsetY[decoIdx];
        if (p !== DECORATION_NO_PARENT && Transform.active?.[p]) {
            this._displayPose(p, out);
            const lx = DecorationComponent.localX[decoIdx];
            const ly = DecorationComponent.localY[decoIdx];
            if (DecorationComponent.inheritParentRotation[decoIdx]) {
                const c = out.rotC;
                const s = out.rotS;
                out.x += c * lx - s * ly + ox;
                out.y += s * lx + c * ly + oy;
            } else {
                out.x += lx + ox;
                out.y += ly + oy;
            }
            return;
        }
        out.x = DecorationComponent.x[decoIdx] + ox;
        out.y = DecorationComponent.y[decoIdx] + oy;
    }

    _emitAdobePieces(ref, writeIndex, entityIndex, sortKey = 0, stashedPose = null) {
        const resolved = this._resolveAdobeFrameIndex(entityIndex);
        const asset = resolved.asset;
        if (!asset) return writeIndex;

        const clipFrameStart = asset.clipFrameStart;
        const framePieceCount = asset.framePieceCount;
        const framePieceStart = asset.framePieceStart;
        const pieceX = asset.pieceX;
        const pieceY = asset.pieceY;
        const pieceScaleX = asset.pieceScaleX;
        const pieceScaleY = asset.pieceScaleY;
        const pieceRotation = asset.pieceRotation;
        const pieceRotCArr = asset.pieceRotC;
        const pieceRotSArr = asset.pieceRotS;
        const pieceAlpha = asset.pieceAlpha;
        const pieceAnchorX = asset.pieceAnchorX;
        const pieceAnchorY = asset.pieceAnchorY;
        const textureIds = asset.pieceTextureId;
        const clipId = resolved.clipId;
        const clipBoundsMinX = asset.clipBoundsMinX;
        const clipBoundsMinY = asset.clipBoundsMinY;
        const clipBoundsMaxX = asset.clipBoundsMaxX;
        const clipBoundsMaxY = asset.clipBoundsMaxY;
        const assetBoundsMinX = asset.assetBoundsMinX;
        const assetBoundsMinY = asset.assetBoundsMinY;
        const assetBoundsMaxX = asset.assetBoundsMaxX;
        const assetBoundsMaxY = asset.assetBoundsMaxY;

        let rootX, rootY, poseC, poseS;
        if (stashedPose) {
            rootX = stashedPose.x;
            rootY = stashedPose.y;
            poseC = stashedPose.rotC;
            poseS = stashedPose.rotS;
        } else {
            const pose = this._displayPoseOut;
            this._displayPose(entityIndex, pose);
            rootX = pose.x;
            rootY = pose.y;
            poseC = pose.rotC;
            poseS = pose.rotS;
        }
        // body pose CS × AdobeAnimComponent CS (inline — hot piece loop)
        const ac = AdobeAnimComponent.rotC[entityIndex];
        const as = AdobeAnimComponent.rotS[entityIndex];
        const rootC = poseC * ac - poseS * as;
        const rootS = poseS * ac + poseC * as;
        const rootScaleX = AdobeAnimComponent.scaleX[entityIndex];
        const rootScaleY = AdobeAnimComponent.scaleY[entityIndex];
        const rootAnchorX = AdobeAnimComponent.anchorX[entityIndex];
        const rootAnchorY = AdobeAnimComponent.anchorY[entityIndex];
        const rootAlpha = AdobeAnimComponent.alpha[entityIndex];
        const rootTint = AdobeAnimComponent.tint[entityIndex];

        const frameIndex = resolved.frameIndex;
        const absoluteFrame = (clipFrameStart?.[clipId] ?? 0) + frameIndex;
        const pieceCount = framePieceCount?.[absoluteFrame] ?? 0;
        const start = framePieceStart?.[absoluteFrame] ?? 0;
        const end = start + pieceCount;
        const maxItems = ref.textureId.length;
        const minX = clipBoundsMinX?.[clipId] ?? assetBoundsMinX ?? 0;
        const minY = clipBoundsMinY?.[clipId] ?? assetBoundsMinY ?? 0;
        const maxX = clipBoundsMaxX?.[clipId] ?? assetBoundsMaxX ?? 0;
        const maxY = clipBoundsMaxY?.[clipId] ?? assetBoundsMaxY ?? 0;
        const pivotX = minX + (maxX - minX) * rootAnchorX;
        const pivotY = minY + (maxY - minY) * rootAnchorY;

        // Mirror sign: -1 when exactly one of the parent scales is negative
        // (a reflection). Required because S(-1,1)*R(θ) = R(-θ)*S(-1,1), so a
        // piece's local rotation must be negated under a single-axis flip,
        // otherwise rotated pieces (e.g. tilted hands in a "running" clip)
        // appear mirrored to the wrong side after a horizontal flip.
        const mirrorSign = ((rootScaleX < 0) !== (rootScaleY < 0)) ? -1 : 1;

        let p = start;
        for (; p < end && writeIndex < maxItems; p++) {
            const localX = (pieceX[p] - pivotX) * rootScaleX;
            const localY = (pieceY[p] - pivotY) * rootScaleY;

            ref.x[writeIndex] = rootX + rootC * localX - rootS * localY;
            ref.y[writeIndex] = rootY + rootS * localX + rootC * localY;
            ref.scaleX[writeIndex] = pieceScaleX[p] * rootScaleX;
            ref.scaleY[writeIndex] = pieceScaleY[p] * rootScaleY;
            // Prebaked piece CS; mirrorSign flips sin under single-axis reflection
            const pc = pieceRotCArr ? pieceRotCArr[p] : Math.cos(pieceRotation[p]);
            const ps = (pieceRotSArr ? pieceRotSArr[p] : Math.sin(pieceRotation[p])) * mirrorSign;
            ref.rotC[writeIndex] = rootC * pc - rootS * ps;
            ref.rotS[writeIndex] = rootS * pc + rootC * ps;
            ref.alpha[writeIndex] = pieceAlpha[p] * rootAlpha;
            ref.tint[writeIndex] = rootTint;
            ref.textureId[writeIndex] = textureIds[p];
            ref.anchorX[writeIndex] = pieceAnchorX[p];
            ref.anchorY[writeIndex] = pieceAnchorY[p];
            ref.type[writeIndex] = 6;
            ref.entityIndex[writeIndex] = entityIndex;
            if (ref.repeatX) ref.repeatX[writeIndex] = 0;
            if (ref.repeatY) ref.repeatY[writeIndex] = 0;
            clearTileFields(ref, writeIndex);
            if (ref.sortKey) ref.sortKey[writeIndex] = sortKey;
            writeIndex++;
        }

        if (p < end && !this._adobeRenderQueueOverflowWarned) {
            this._adobeRenderQueueOverflowWarned = true;
            console.warn('[PRE_RENDER] Adobe Animate piece expansion exceeded render queue capacity. Increase renderer.maxVisibleRenderables.');
        }

        return writeIndex;
    }

    /**
     * Build the final render queue
     */
    buildRenderQueue(deltaTime) {
        if (!this.renderQueueEnabled || this._renderableCount === 0) {
            if (this.renderQueueCount) this.renderQueueCount[0] = 0;
            return;
        }

        const count = this._renderableCount;
        const collectorY = this._renderableY;
        const collectorType = this._renderableType;
        const collectorIndex = this._renderableIndex;

        // Y-order via GPU depth + composite sortKey (instanced path always on).
        // No CPU heapsort when Layer.entities.ySorting — pixi depthMode sortKey.
        const detail = this.collectDetailedStats;
        if (detail) this.sortTimeThisFrame = 0;
        const tEmit = detail ? performance.now() : 0;

        // Cache output arrays
        const rqX = this.renderQueueX;
        const rqY = this.renderQueueY;
        const rqScaleX = this.renderQueueScaleX;
        const rqScaleY = this.renderQueueScaleY;
        const rqRotC = this.renderQueueRotC;
        const rqRotS = this.renderQueueRotS;
        const rqAlpha = this.renderQueueAlpha;
        const rqTint = this.renderQueueTint;
        const rqTextureId = this.renderQueueTextureId;
        const rqAnchorX = this.renderQueueAnchorX;
        const rqAnchorY = this.renderQueueAnchorY;
        const rqType = this.renderQueueType;
        const rqEntityIndex = this.renderQueueEntityIndex;
        const rqSortKey = this.renderQueueSortKey;
        const rqRepeatX = this.renderQueueRepeatX;
        const rqRepeatY = this.renderQueueRepeatY;
        const rqTileMode = this.renderQueueTileMode;
        const rqTileOffsetU = this.renderQueueTileOffsetU;
        const rqTileOffsetV = this.renderQueueTileOffsetV;
        const rqTileMulX = this.renderQueueTileMulX;
        const rqTileMulY = this.renderQueueTileMulY;
        const entityLastTextureId = this.entityLastTextureId;

        // Cache component arrays
        const entityX = Transform.x;
        const entityY = Transform.y;

        const srScaleX = SpriteRenderer.scaleX;
        const srScaleY = SpriteRenderer.scaleY;
        const srAlpha = SpriteRenderer.alpha;
        const srTint = SpriteRenderer.tint;
        const srAnchorX = SpriteRenderer.anchorX;
        const srAnchorY = SpriteRenderer.anchorY;
        const srAnimState = SpriteRenderer.animationState;
        const srSpritesheetId = SpriteRenderer.spritesheetId;
        const srAnimSpeed = SpriteRenderer.animationSpeed;
        const srLoop = SpriteRenderer.loop;
        const srIsAnimated = SpriteRenderer.isAnimated;
        const srInheritTransformRotation = SpriteRenderer.inheritTransformRotation;
        const srSpriteRotC = SpriteRenderer.spriteRotC;
        const srSpriteRotS = SpriteRenderer.spriteRotS;
        const srRepeatX = SpriteRenderer.repeatX;
        const srRepeatY = SpriteRenderer.repeatY;
        const srTileMode = SpriteRenderer.tileMode;
        const srTileOffsetU = SpriteRenderer.tileOffsetU;
        const srTileOffsetV = SpriteRenderer.tileOffsetV;
        const srBoundsHalfW = SpriteRenderer.boundsHalfW;
        const srBoundsHalfH = SpriteRenderer.boundsHalfH;

        const particleX = ParticleComponent.x;
        const particleY = ParticleComponent.y;
        const particleZ = ParticleComponent.z;
        const particleScaleX = ParticleComponent.scaleX;
        const particleScaleY = ParticleComponent.scaleY;
        const particleFlipX = ParticleComponent.flipX;
        const particleFlipY = ParticleComponent.flipY;
        const particleRotC = ParticleComponent.rotC;
        const particleRotS = ParticleComponent.rotS;
        const particleAlpha = ParticleComponent.alpha;
        const particleTint = ParticleComponent.tint;
        const particleTextureId = ParticleComponent.textureId;
        const particleFlat = ParticleComponent.flat;
        const particleViewMode = ParticleComponent.viewMode;

        const lightColor = LightEmitter.lightColor;
        const lightIntensity = LightEmitter.lightIntensity;
        const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;
        const glowHeightOffset = LightEmitter.glowHeightOffset;
        const lightGradientAnimIdx = this.animationNameToIndex?.['_lightGradient'] ?? 0;
        const lightGradientTextureId = this.animationFrameStart?.[lightGradientAnimIdx] ?? 0;
        const whiteCircleAnimIdx = this.animationNameToIndex?.['_whiteCircle'] ?? -1;
        const whiteCircleTextureId = whiteCircleAnimIdx >= 0 ? (this.animationFrameStart?.[whiteCircleAnimIdx] ?? INVALID_TEXTURE_ID) : INVALID_TEXTURE_ID;

        const decoX = DecorationComponent.x;
        const decoY = DecorationComponent.y;
        const decoOffsetX = DecorationComponent.offsetX;
        const decoOffsetY = DecorationComponent.offsetY;
        const decoScaleX = DecorationComponent.scaleX;
        const decoScaleY = DecorationComponent.scaleY;
        const decoRotC = DecorationComponent.rotC;
        const decoRotS = DecorationComponent.rotS;
        const decoAlpha = DecorationComponent.alpha;
        const decoTint = DecorationComponent.tint;
        const decoTextureId = DecorationComponent.textureId;
        const decoAnchorX = DecorationComponent.anchorX;
        const decoAnchorY = DecorationComponent.anchorY;

        const bulletX = BulletComponent.x;
        const bulletY = BulletComponent.y;
        const bulletStartX = BulletComponent.startX ?? BulletComponent.prevX;
        const bulletStartY = BulletComponent.startY ?? BulletComponent.prevY;
        const bulletOffsetY = BulletComponent.offsetY;
        const bulletScale = BulletComponent.scale;
        const bulletAlpha = BulletComponent.alpha;
        const bulletTint = BulletComponent.tint;
        const bulletTextureId = BulletComponent.textureId;
        const bulletSpriteRotC = BulletComponent.spriteRotC;
        const bulletSpriteRotS = BulletComponent.spriteRotS;
        const bulletRotC = BulletComponent.bulletRotC;
        const bulletRotS = BulletComponent.bulletRotS;
        const bulletTrailWidth = BulletComponent.trailWidth;
        const bulletAnchorX = BulletComponent.anchorX;
        const bulletAnchorY = BulletComponent.anchorY;
        const bulletActive = BulletComponent.active;

        const bulletTrailAnimIdx = this.animationNameToIndex?.['_bulletTrail'] ?? 0;
        const bulletTrailTextureId = this.animationFrameStart?.[bulletTrailAnimIdx] ?? 0;
        const BULLET_TRAIL_MIN_LENGTH_SQ = 0.01;

        const frameIndex = this.entityFrameIndex;
        const frameAccum = this.entityFrameAccumulator;
        const deltaSeconds = deltaTime / 1000;
        const ref = this._emitRef;
        ref.x = rqX; ref.y = rqY; ref.scaleX = rqScaleX; ref.scaleY = rqScaleY;
        ref.rotC = rqRotC; ref.rotS = rqRotS; ref.alpha = rqAlpha; ref.tint = rqTint;
        ref.textureId = rqTextureId; ref.anchorX = rqAnchorX; ref.anchorY = rqAnchorY;
        ref.type = rqType; ref.entityIndex = rqEntityIndex;
        ref.sortKey = rqSortKey;
        ref.repeatX = rqRepeatX; ref.repeatY = rqRepeatY;
        ref.tileMode = rqTileMode; ref.tileOffsetU = rqTileOffsetU; ref.tileOffsetV = rqTileOffsetV;
        ref.tileMulX = rqTileMulX; ref.tileMulY = rqTileMulY;

        let writeCount = 0;
        const stashPx = this._renderablePx;
        const stashPy = this._renderablePy;
        const stashRc = this._renderableRotC;
        const stashRs = this._renderableRotS;
        const stashPose = this._displayPoseOut;
        const writeSortKey = !!(rqSortKey && Layer._ySorting && Layer._ySorting[Layer.entitiesId]);

        for (let i = 0; i < count && writeCount < this.renderQueueMaxItems; i++) {
            const type = collectorType[i];
            const idx = collectorIndex[i];
            const sk = collectorY[i];

            if (type === 6) {
                stashPose.x = stashPx[i];
                stashPose.y = stashPy[i];
                stashPose.rotC = stashRc[i];
                stashPose.rotS = stashRs[i];
                writeCount = this._emitAdobePieces(ref, writeCount, idx, sk, stashPose);
                continue;
            }

            const out = writeCount++;
            if (writeSortKey) rqSortKey[out] = sk;
            if (type !== 0) {
                if (rqRepeatX) rqRepeatX[out] = 0;
                if (rqRepeatY) rqRepeatY[out] = 0;
                clearTileFields(ref, out);
            }

            if (type === 0) {
                // === ENTITY === (pose stashed at collect)
                const currX = stashPx[i];
                const currY = stashPy[i];

                rqX[out] = currX;
                rqY[out] = currY;
                rqScaleX[out] = srScaleX[idx];
                rqScaleY[out] = srScaleY[idx];
                if (srInheritTransformRotation[idx]) {
                    rqRotC[out] = stashRc[i];
                    rqRotS[out] = stashRs[i];
                } else {
                    rqRotC[out] = srSpriteRotC[idx];
                    rqRotS[out] = srSpriteRotS[idx];
                }
                rqAlpha[out] = srAlpha[idx];
                rqTint[out] = srTint[idx];
                rqAnchorX[out] = srAnchorX[idx];
                rqAnchorY[out] = srAnchorY[idx];
                const rx0 = srRepeatX[idx];
                const ry0 = srRepeatY[idx];
                if (rx0 !== 0 || ry0 !== 0) {
                    if (rqRepeatX) rqRepeatX[out] = rx0;
                    if (rqRepeatY) rqRepeatY[out] = ry0;
                    writeEntityTileFields(
                        ref, out, idx,
                        srTileMode, srTileOffsetU, srTileOffsetV,
                        srRepeatX, srRepeatY, srBoundsHalfW, srBoundsHalfH
                    );
                } else {
                    if (rqRepeatX) rqRepeatX[out] = 0;
                    if (rqRepeatY) rqRepeatY[out] = 0;
                    if (rqTileMulX) rqTileMulX[out] = 0;
                    if (rqTileMulY) rqTileMulY[out] = 0;
                }

                rqType[out] = 0;
                rqEntityIndex[out] = idx;

                const sheetId = srSpritesheetId[idx];
                const animState = srAnimState[idx];

                const proxyMap = this.proxyToGlobalAnim?.[sheetId];
                const globalAnimIdx = proxyMap?.[animState];

                if (globalAnimIdx !== undefined) {
                    const animFrameCount = this.animationFrameCount?.[globalAnimIdx] ?? 1;
                    if (frameIndex[idx] >= animFrameCount) {
                        frameIndex[idx] = 0;
                    }

                    if (srIsAnimated[idx] && animFrameCount > 1) {
                        frameAccum[idx] += deltaSeconds;
                        const frameDuration = 1 / (srAnimSpeed[idx] * 60);

                        if (frameAccum[idx] >= frameDuration) {
                            frameAccum[idx] -= frameDuration;

                            const currentFrame = frameIndex[idx];
                            const isLastFrame = currentFrame >= animFrameCount - 1;
                            const shouldLoop = srLoop[idx] === 1;

                            if (shouldLoop || !isLastFrame) {
                                frameIndex[idx] = (currentFrame + 1) % animFrameCount;
                                // Bounds may change (variable frame sizes)
                                if (this.frameWidth && this.frameHeight && SpriteRenderer.boundsHalfW && SpriteRenderer.boundsHalfH) {
                                    const texId = (this.animationFrameStart?.[globalAnimIdx] ?? 0) + frameIndex[idx];
                                    const origW = this.frameWidth[texId] || 0;
                                    const origH = this.frameHeight[texId] || 0;
                                    const sx = srScaleX[idx] || 1;
                                    const sy = srScaleY[idx] || 1;
                                    SpriteRenderer.boundsHalfW[idx] = (origW * sx) * 0.5;
                                    SpriteRenderer.boundsHalfH[idx] = (origH * sy) * 0.5;
                                }
                            }
                        }
                    }

                    const animStart = this.animationFrameStart?.[globalAnimIdx] ?? 0;
                    const globalTextureId = animStart + frameIndex[idx];
                    rqTextureId[out] = globalTextureId;

                    if (entityLastTextureId) {
                        entityLastTextureId[idx] = globalTextureId;
                    }
                } else {
                    rqTextureId[out] = entityLastTextureId ? entityLastTextureId[idx] : INVALID_TEXTURE_ID;
                }
            } else if (type === 1) {
                // === PARTICLE ===
                rqX[out] = particleX[idx];
                // Zenithal: height → scale (and alpha). Never fold z into Y.
                // Flat: y only. Else (topdown): screenY = y + z.
                if (particleViewMode && particleViewMode[idx] === CAMERA_TYPES.ZENITHAL && !(particleFlat && particleFlat[idx])) {
                    rqY[out] = particleY[idx];
                    const height = -particleZ[idx];
                    const heightFactor = 1 + (height / this.zenithalMaxHeight) * this.zenithalScaleFactor;
                    rqScaleX[out] = particleScaleX[idx] * heightFactor * (particleFlipX[idx] ? -1 : 1);
                    rqScaleY[out] = particleScaleY[idx] * heightFactor * (particleFlipY[idx] ? -1 : 1);
                    let a = particleAlpha[idx];
                    if (this.zenithalAlphaFade > 0) {
                        const alphaFade = Math.min(1, (height / this.zenithalMaxHeight) * this.zenithalAlphaFade);
                        a *= Math.max(0, 1 - alphaFade);
                    }
                    rqAlpha[out] = a;
                } else if (particleFlat && particleFlat[idx]) {
                    rqY[out] = particleY[idx];
                    rqScaleX[out] = particleScaleX[idx] * (particleFlipX[idx] ? -1 : 1);
                    rqScaleY[out] = particleScaleY[idx] * (particleFlipY[idx] ? -1 : 1);
                    rqAlpha[out] = particleAlpha[idx];
                } else {
                    rqY[out] = particleY[idx] + particleZ[idx];
                    rqScaleX[out] = particleScaleX[idx] * (particleFlipX[idx] ? -1 : 1);
                    rqScaleY[out] = particleScaleY[idx] * (particleFlipY[idx] ? -1 : 1);
                    rqAlpha[out] = particleAlpha[idx];
                }
                rqRotC[out] = particleRotC[idx];
                rqRotS[out] = particleRotS[idx];
                rqTint[out] = particleTint[idx];
                const pAnimIdx = particleTextureId[idx];
                rqTextureId[out] = pAnimIdx === 0
                    ? whiteCircleTextureId
                    : (this.animationFrameStart?.[pAnimIdx] ?? INVALID_TEXTURE_ID);
                rqAnchorX[out] = 0.5;
                rqAnchorY[out] = 0.5;
                rqType[out] = 1;
                rqEntityIndex[out] = -1;
            } else if (type === 7) {
                const lf = this.liquidFun;
                if (
                    this.interpolationMode === 'interpolate' &&
                    this._prevLfX &&
                    this._prevLfCount > idx
                ) {
                    const alpha = this._poseAlpha;
                    const px = this._prevLfX[idx];
                    const py = this._prevLfY[idx];
                    rqX[out] = px + (lf.x[idx] - px) * alpha;
                    rqY[out] = py + (lf.y[idx] - py) * alpha;
                } else {
                    rqX[out] = lf.x[idx];
                    rqY[out] = lf.y[idx];
                }
                rqScaleX[out] = lf.scaleX[idx];
                rqScaleY[out] = lf.scaleY[idx];
                rqAlpha[out] = lf.alpha[idx] * (lf.baseAlpha ? lf.baseAlpha[idx] : 1);
                rqRotC[out] = lf.rotC[idx];
                rqRotS[out] = lf.rotS[idx];
                rqTint[out] = lf.tint[idx];
                const lfAnimIdx = lf.textureId[idx];
                rqTextureId[out] = lfAnimIdx === 0
                    ? whiteCircleTextureId
                    : (this.animationFrameStart?.[lfAnimIdx] ?? INVALID_TEXTURE_ID);
                rqAnchorX[out] = 0.5;
                rqAnchorY[out] = 0.5;
                rqType[out] = 1;
                rqEntityIndex[out] = -1;
            } else if (type === 2) {
                // === DECORATION === (world xy + facing stashed at collect)
                rqX[out] = stashPx[i];
                rqY[out] = stashPy[i];
                rqScaleX[out] = decoScaleX[idx];
                rqScaleY[out] = decoScaleY[idx];
                rqRotC[out] = stashRc[i];
                rqRotS[out] = stashRs[i];
                rqAlpha[out] = decoAlpha[idx] * this._decorationZoomAlpha;
                rqTint[out] = decoTint[idx];
                const dAnimIdx = decoTextureId[idx];
                rqTextureId[out] = this.animationFrameStart?.[dAnimIdx] ?? INVALID_TEXTURE_ID;
                rqAnchorX[out] = decoAnchorX[idx];
                rqAnchorY[out] = decoAnchorY[idx];
                rqType[out] = 2;
                rqEntityIndex[out] = -1;
            } else if (type === 4) {
                // === BULLET ===
                if (!bulletActive[idx]) {
                    rqAlpha[out] = 0;
                    rqScaleX[out] = 0;
                    rqScaleY[out] = 0;
                    rqX[out] = -10000;
                    rqY[out] = -10000;
                } else {
                    rqX[out] = bulletX[idx];
                    rqY[out] = bulletY[idx] + (bulletOffsetY[idx] ?? 0);
                    rqScaleX[out] = bulletScale[idx];
                    rqScaleY[out] = bulletScale[idx];
                    rqRotC[out] = bulletSpriteRotC[idx];
                    rqRotS[out] = bulletSpriteRotS[idx];
                    rqAlpha[out] = bulletAlpha[idx];
                    rqTint[out] = bulletTint[idx];
                    const bAnimIdx = bulletTextureId[idx];
                    rqTextureId[out] = this.animationFrameStart?.[bAnimIdx] ?? INVALID_TEXTURE_ID;
                    rqAnchorX[out] = bulletAnchorX[idx];
                    rqAnchorY[out] = bulletAnchorY[idx];
                }
                rqType[out] = 4;
                rqEntityIndex[out] = -1;
            } else if (type === 5) {
                // === BULLET TRAIL (line from start to curr, 0-alpha at start) ===
                if (!bulletActive[idx]) {
                    rqAlpha[out] = 0;
                    rqScaleX[out] = 0;
                    rqScaleY[out] = 0;
                    rqX[out] = -10000;
                    rqY[out] = -10000;
                } else {
                    const currX = bulletX[idx];
                    const currY = bulletY[idx] + (bulletOffsetY[idx] ?? 0);
                    const startX = bulletStartX[idx];
                    const startY = bulletStartY[idx] + (bulletOffsetY[idx] ?? 0);
                    const dx = currX - startX;
                    const dy = currY - startY;
                    const lenSq = dx * dx + dy * dy;

                    if (lenSq < BULLET_TRAIL_MIN_LENGTH_SQ) {
                        rqAlpha[out] = 0;
                        rqScaleX[out] = 0;
                        rqScaleY[out] = 0;
                        rqX[out] = -10000;
                        rqY[out] = -10000;
                    } else {
                        const adx = dx < 0 ? -dx : dx;
                        const ady = dy < 0 ? -dy : dy;
                        const max = adx > ady ? adx : ady;
                        const min = adx > ady ? ady : adx;
                        const lengthApprox = 0.96 * max + 0.4 * min;

                        rqX[out] = (startX + currX) * 0.5;
                        rqY[out] = (startY + currY) * 0.5;
                        rqScaleX[out] = lengthApprox / 10;
                        rqScaleY[out] = bulletTrailWidth[idx];
                        // Flight dir already in bulletRotC/S (straight bullets)
                        rqRotC[out] = bulletRotC[idx];
                        rqRotS[out] = bulletRotS[idx];
                        rqAlpha[out] = bulletAlpha[idx] * 0.9;
                        rqTint[out] = 0xffffff;
                    }
                }
                rqTextureId[out] = bulletTrailTextureId;
                rqAnchorX[out] = 0.5;
                rqAnchorY[out] = 0.5;
                rqType[out] = 5;
                rqEntityIndex[out] = -1;
            } else {
                // === LIGHT GLOW (type=3) ===
                const scale = lightGlowScale(sqrtLightIntensity[idx]);
                const glowAlpha = lightIntensity[idx] / 50000;

                if (scale < 0.1 || glowAlpha < 0.001) {
                    rqAlpha[out] = 0;
                    rqScaleX[out] = 0;
                    rqScaleY[out] = 0;
                    rqX[out] = -10000;
                    rqY[out] = -10000;
                } else {
                    rqX[out] = entityX[idx];
                    rqY[out] = entityY[idx] - (glowHeightOffset[idx] || 0);
                    rqScaleX[out] = scale;
                    rqScaleY[out] = scale;
                    rqAlpha[out] = glowAlpha;
                    rqTint[out] = lightColor[idx];
                }
                rqRotC[out] = 1;
                rqRotS[out] = 0;
                rqTextureId[out] = lightGradientTextureId;
                rqAnchorX[out] = 0.5;
                rqAnchorY[out] = 0.5;
                rqType[out] = 3;
                rqEntityIndex[out] = idx;
            }
        }

        if (detail) this.emitTimeThisFrame = performance.now() - tEmit;
        this.renderQueueCount[0] = writeCount;
        this._renderableCount = 0;
    }

    /**
     * Build render queues for all custom layers.
     * Each custom layer's collector may contain any renderable type (0-6):
     * entities, particles, decorations, light glows, bullets, and bullet trails.
     *
     * Per-type dispatch mirrors the corresponding branches in buildRenderQueue(),
     * writing the same fields (x, y, scaleX, scaleY, rotC, rotS, alpha, tint,
     * textureId, anchorX, anchorY, type, entityIndex) into per-layer SABs.
     * The pixi_worker reads these fields generically in updateCustomLayers().
     *
     * @param {number} deltaTime - Frame delta in milliseconds (for animation advancement)
     */
    buildCustomLayerQueues(deltaTime) {
        if (!this._customLayerCollectors) return;

        // Entity arrays
        const entityX = Transform.x;
        const entityY = Transform.y;
        const srScaleX = SpriteRenderer.scaleX;
        const srScaleY = SpriteRenderer.scaleY;
        const srAlpha = SpriteRenderer.alpha;
        const srTint = SpriteRenderer.tint;
        const srAnchorX = SpriteRenderer.anchorX;
        const srAnchorY = SpriteRenderer.anchorY;
        const srAnimState = SpriteRenderer.animationState;
        const srSpritesheetId = SpriteRenderer.spritesheetId;
        const srAnimSpeed = SpriteRenderer.animationSpeed;
        const srLoop = SpriteRenderer.loop;
        const srIsAnimated = SpriteRenderer.isAnimated;
        const srInheritTransformRotation = SpriteRenderer.inheritTransformRotation;
        const srSpriteRotC = SpriteRenderer.spriteRotC;
        const srSpriteRotS = SpriteRenderer.spriteRotS;
        const srRepeatX = SpriteRenderer.repeatX;
        const srRepeatY = SpriteRenderer.repeatY;
        const srTileMode = SpriteRenderer.tileMode;
        const srTileOffsetU = SpriteRenderer.tileOffsetU;
        const srTileOffsetV = SpriteRenderer.tileOffsetV;
        const srBoundsHalfW = SpriteRenderer.boundsHalfW;
        const srBoundsHalfH = SpriteRenderer.boundsHalfH;

        const frameIndex = this.entityFrameIndex;
        const frameAccum = this.entityFrameAccumulator;
        const entityLastTextureId = this.entityLastTextureId;
        const deltaSeconds = deltaTime / 1000;
        // Particle arrays
        const particleX = ParticleComponent.x;
        const particleY = ParticleComponent.y;
        const particleZ = ParticleComponent.z;
        const particleScaleX = ParticleComponent.scaleX;
        const particleScaleY = ParticleComponent.scaleY;
        const particleFlipX = ParticleComponent.flipX;
        const particleFlipY = ParticleComponent.flipY;
        const particleRotC = ParticleComponent.rotC;
        const particleRotS = ParticleComponent.rotS;
        const particleAlpha = ParticleComponent.alpha;
        const particleTint = ParticleComponent.tint;
        const particleTextureId = ParticleComponent.textureId;
        const particleFlat = ParticleComponent.flat;
        const particleViewMode = ParticleComponent.viewMode;

        // Decoration arrays
        const decoX = DecorationComponent.x;
        const decoY = DecorationComponent.y;
        const decoOffsetX = DecorationComponent.offsetX;
        const decoOffsetY = DecorationComponent.offsetY;
        const decoScaleX = DecorationComponent.scaleX;
        const decoScaleY = DecorationComponent.scaleY;
        const decoRotC = DecorationComponent.rotC;
        const decoRotS = DecorationComponent.rotS;
        const decoAlpha = DecorationComponent.alpha;
        const decoTint = DecorationComponent.tint;
        const decoTextureId = DecorationComponent.textureId;
        const decoAnchorX = DecorationComponent.anchorX;
        const decoAnchorY = DecorationComponent.anchorY;

        // Bullet arrays
        const bulletX = BulletComponent.x;
        const bulletY = BulletComponent.y;
        const bulletStartX = BulletComponent.startX ?? BulletComponent.prevX;
        const bulletStartY = BulletComponent.startY ?? BulletComponent.prevY;
        const bulletOffsetY = BulletComponent.offsetY;
        const bulletScale = BulletComponent.scale;
        const bulletAlpha = BulletComponent.alpha;
        const bulletTint = BulletComponent.tint;
        const bulletTextureId = BulletComponent.textureId;
        const bulletSpriteRotC = BulletComponent.spriteRotC;
        const bulletSpriteRotS = BulletComponent.spriteRotS;
        const bulletRotC = BulletComponent.bulletRotC;
        const bulletRotS = BulletComponent.bulletRotS;
        const bulletTrailWidth = BulletComponent.trailWidth;
        const bulletAnchorX = BulletComponent.anchorX;
        const bulletAnchorY = BulletComponent.anchorY;
        const bulletActive = BulletComponent.active;

        const bulletTrailAnimIdx = this.animationNameToIndex?.['_bulletTrail'] ?? 0;
        const bulletTrailTextureId = this.animationFrameStart?.[bulletTrailAnimIdx] ?? 0;
        const BULLET_TRAIL_MIN_LENGTH_SQ = 0.01;

        // Light glow arrays
        const lightColor = LightEmitter.lightColor;
        const lightIntensity = LightEmitter.lightIntensity;
        const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;
        const glowHeightOffset = LightEmitter.glowHeightOffset;
        const lightGradientAnimIdx = this.animationNameToIndex?.['_lightGradient'] ?? 0;
        const lightGradientTextureId = this.animationFrameStart?.[lightGradientAnimIdx] ?? 0;
        const whiteCircleAnimIdx2 = this.animationNameToIndex?.['_whiteCircle'] ?? -1;
        const whiteCircleTextureId2 = whiteCircleAnimIdx2 >= 0 ? (this.animationFrameStart?.[whiteCircleAnimIdx2] ?? INVALID_TEXTURE_ID) : INVALID_TEXTURE_ID;

        const layerEntries = this._customLayerEntries;
        for (let li = 0; li < layerEntries.length; li++) {
            const entry = layerEntries[li];
            const collector = entry.collector;
            const layerCount = collector.count;
            if (layerCount === 0) {
                if (entry.ref) entry.ref.count[0] = 0;
                continue;
            }

            const ref = entry.ref;
            if (!ref) { collector.count = 0; continue; }

            const cY = collector.y;
            const cType = collector.type;
            const cIndex = collector.index;

            // Y-order via GPU depth + sortKey when layer.ySorting — no CPU heapsort.
            const rqX = ref.x;
            const rqY = ref.y;
            const rqScaleX = ref.scaleX;
            const rqScaleY = ref.scaleY;
            const rqRotC = ref.rotC;
            const rqRotS = ref.rotS;
            const rqAlpha = ref.alpha;
            const rqTint = ref.tint;
            const rqTextureId = ref.textureId;
            const rqAnchorX = ref.anchorX;
            const rqAnchorY = ref.anchorY;
            const rqType = ref.type;
            const rqEntityIndex = ref.entityIndex;
            const rqSortKey = ref.sortKey;
            const rqRepeatX = ref.repeatX;
            const rqRepeatY = ref.repeatY;
            const rqTileMode = ref.tileMode;
            const rqTileOffsetU = ref.tileOffsetU;
            const rqTileOffsetV = ref.tileOffsetV;
            const rqTileMulX = ref.tileMulX;
            const rqTileMulY = ref.tileMulY;
            const layerRef = this._emitRef;
            layerRef.x = rqX; layerRef.y = rqY; layerRef.scaleX = rqScaleX; layerRef.scaleY = rqScaleY;
            layerRef.rotC = rqRotC; layerRef.rotS = rqRotS; layerRef.alpha = rqAlpha; layerRef.tint = rqTint;
            layerRef.textureId = rqTextureId; layerRef.anchorX = rqAnchorX; layerRef.anchorY = rqAnchorY;
            layerRef.type = rqType; layerRef.entityIndex = rqEntityIndex;
            layerRef.sortKey = rqSortKey;
            layerRef.repeatX = rqRepeatX; layerRef.repeatY = rqRepeatY;
            layerRef.tileMode = rqTileMode; layerRef.tileOffsetU = rqTileOffsetU; layerRef.tileOffsetV = rqTileOffsetV;
            layerRef.tileMulX = rqTileMulX; layerRef.tileMulY = rqTileMulY;

            let writeCount = 0;
            const writeSortKey = !!(rqSortKey && Layer._ySorting && Layer._ySorting[entry.layerId]);

            for (let i = 0; i < layerCount && writeCount < collector.maxItems; i++) {
                const type = cType[i];
                const idx = cIndex[i];
                const sk = cY[i];

                if (type === 6) {
                    writeCount = this._emitAdobePieces(layerRef, writeCount, idx, sk);
                    continue;
                }

                const out = writeCount++;
                if (writeSortKey) rqSortKey[out] = sk;
                if (type !== 0) {
                    if (rqRepeatX) rqRepeatX[out] = 0;
                    if (rqRepeatY) rqRepeatY[out] = 0;
                    clearTileFields(layerRef, out);
                }

                if (type === 0) {
                    // === ENTITY ===
                    const pose = this._displayPoseOut;
                    this._displayPose(idx, pose);
                    rqX[out] = pose.x;
                    rqY[out] = pose.y;
                    rqScaleX[out] = srScaleX[idx];
                    rqScaleY[out] = srScaleY[idx];
                    if (srInheritTransformRotation[idx]) {
                        rqRotC[out] = pose.rotC;
                        rqRotS[out] = pose.rotS;
                    } else {
                        rqRotC[out] = srSpriteRotC[idx];
                        rqRotS[out] = srSpriteRotS[idx];
                    }
                    rqAlpha[out] = srAlpha[idx];
                    rqTint[out] = srTint[idx];
                    rqAnchorX[out] = srAnchorX[idx];
                    rqAnchorY[out] = srAnchorY[idx];
                    const rx0 = srRepeatX[idx];
                    const ry0 = srRepeatY[idx];
                    if (rx0 !== 0 || ry0 !== 0) {
                        if (rqRepeatX) rqRepeatX[out] = rx0;
                        if (rqRepeatY) rqRepeatY[out] = ry0;
                        writeEntityTileFields(
                            layerRef, out, idx,
                            srTileMode, srTileOffsetU, srTileOffsetV,
                            srRepeatX, srRepeatY, srBoundsHalfW, srBoundsHalfH
                        );
                    } else {
                        if (rqRepeatX) rqRepeatX[out] = 0;
                        if (rqRepeatY) rqRepeatY[out] = 0;
                        if (rqTileMulX) rqTileMulX[out] = 0;
                        if (rqTileMulY) rqTileMulY[out] = 0;
                    }
                    rqType[out] = 0;
                    rqEntityIndex[out] = idx;

                    const sheetId = srSpritesheetId[idx];
                    const animState = srAnimState[idx];
                    const proxyMap = this.proxyToGlobalAnim?.[sheetId];
                    const globalAnimIdx = proxyMap?.[animState];

                    if (globalAnimIdx !== undefined) {
                        const animFrameCount = this.animationFrameCount?.[globalAnimIdx] ?? 1;
                        if (frameIndex[idx] >= animFrameCount) {
                            frameIndex[idx] = 0;
                        }

                        // Advance animation (mirrors buildRenderQueue's entity branch).
                        // Routing is exclusive: an entity is either in the main queue or
                        // one custom layer, so the accumulator advances once per frame.
                        if (srIsAnimated[idx] && animFrameCount > 1) {
                            frameAccum[idx] += deltaSeconds;
                            const frameDuration = 1 / (srAnimSpeed[idx] * 60);

                            if (frameAccum[idx] >= frameDuration) {
                                frameAccum[idx] -= frameDuration;

                                const currentFrame = frameIndex[idx];
                                const isLastFrame = currentFrame >= animFrameCount - 1;
                                const shouldLoop = srLoop[idx] === 1;

                                if (shouldLoop || !isLastFrame) {
                                    frameIndex[idx] = (currentFrame + 1) % animFrameCount;
                                    // Bounds may change (variable frame sizes)
                                    if (this.frameWidth && this.frameHeight && SpriteRenderer.boundsHalfW && SpriteRenderer.boundsHalfH) {
                                        const texId = (this.animationFrameStart?.[globalAnimIdx] ?? 0) + frameIndex[idx];
                                        const origW = this.frameWidth[texId] || 0;
                                        const origH = this.frameHeight[texId] || 0;
                                        const sx = srScaleX[idx] || 1;
                                        const sy = srScaleY[idx] || 1;
                                        SpriteRenderer.boundsHalfW[idx] = (origW * sx) * 0.5;
                                        SpriteRenderer.boundsHalfH[idx] = (origH * sy) * 0.5;
                                    }
                                }
                            }
                        }

                        const animStart = this.animationFrameStart?.[globalAnimIdx] ?? 0;
                        const globalTextureId = animStart + frameIndex[idx];
                        rqTextureId[out] = globalTextureId;
                        if (entityLastTextureId) entityLastTextureId[idx] = globalTextureId;
                    } else {
                        rqTextureId[out] = entityLastTextureId ? entityLastTextureId[idx] : INVALID_TEXTURE_ID;
                    }

                } else if (type === 1) {
                    // === PARTICLE ===
                    rqX[out] = particleX[idx];
                    // Zenithal: height → scale (and alpha). Never fold z into Y.
                    // Flat: y only. Else (topdown): screenY = y + z.
                    if (particleViewMode && particleViewMode[idx] === CAMERA_TYPES.ZENITHAL && !(particleFlat && particleFlat[idx])) {
                        rqY[out] = particleY[idx];
                        const height = -particleZ[idx];
                        const heightFactor = 1 + (height / this.zenithalMaxHeight) * this.zenithalScaleFactor;
                        rqScaleX[out] = particleScaleX[idx] * heightFactor;
                        rqScaleY[out] = particleScaleY[idx] * heightFactor;
                        let a = particleAlpha[idx];
                        if (this.zenithalAlphaFade > 0) {
                            const alphaFade = Math.min(1, (height / this.zenithalMaxHeight) * this.zenithalAlphaFade);
                            a *= Math.max(0, 1 - alphaFade);
                        }
                        rqAlpha[out] = a;
                    } else if (particleFlat && particleFlat[idx]) {
                        rqY[out] = particleY[idx];
                        rqScaleX[out] = particleScaleX[idx];
                        rqScaleY[out] = particleScaleY[idx];
                        rqAlpha[out] = particleAlpha[idx];
                    } else {
                        rqY[out] = particleY[idx] + particleZ[idx];
                        rqScaleX[out] = particleScaleX[idx];
                        rqScaleY[out] = particleScaleY[idx];
                        rqAlpha[out] = particleAlpha[idx];
                    }
                    rqRotC[out] = particleRotC[idx];
                    rqRotS[out] = particleRotS[idx];
                    rqTint[out] = particleTint[idx];
                    const pAnimIdx = particleTextureId[idx];
                    rqTextureId[out] = pAnimIdx === 0
                        ? whiteCircleTextureId2
                        : (this.animationFrameStart?.[pAnimIdx] ?? INVALID_TEXTURE_ID);
                    rqAnchorX[out] = 0.5;
                    rqAnchorY[out] = 0.5;
                    rqType[out] = 1;
                    rqEntityIndex[out] = -1;

                } else if (type === 7) {
                    const lf = this.liquidFun;
                    if (
                        this.interpolationMode === 'interpolate' &&
                        this._prevLfX &&
                        this._prevLfCount > idx
                    ) {
                        const alpha = this._poseAlpha;
                        const px = this._prevLfX[idx];
                        const py = this._prevLfY[idx];
                        rqX[out] = px + (lf.x[idx] - px) * alpha;
                        rqY[out] = py + (lf.y[idx] - py) * alpha;
                    } else {
                        rqX[out] = lf.x[idx];
                        rqY[out] = lf.y[idx];
                    }
                    rqScaleX[out] = lf.scaleX[idx];
                    rqScaleY[out] = lf.scaleY[idx];
                    rqAlpha[out] = lf.alpha[idx] * (lf.baseAlpha ? lf.baseAlpha[idx] : 1);
                    rqRotC[out] = lf.rotC[idx];
                    rqRotS[out] = lf.rotS[idx];
                    rqTint[out] = lf.tint[idx];
                    const lfAnimIdx = lf.textureId[idx];
                    rqTextureId[out] = lfAnimIdx === 0
                        ? whiteCircleTextureId2
                        : (this.animationFrameStart?.[lfAnimIdx] ?? INVALID_TEXTURE_ID);
                    rqAnchorX[out] = 0.5;
                    rqAnchorY[out] = 0.5;
                    rqType[out] = 1;
                    rqEntityIndex[out] = -1;

                } else if (type === 2) {
                    // === DECORATION ===
                    const pose = this._displayPoseOut;
                    this._decorationWorldXY(idx, pose);
                    rqX[out] = pose.x;
                    rqY[out] = pose.y;
                    rqScaleX[out] = decoScaleX[idx];
                    rqScaleY[out] = decoScaleY[idx];
                    rqRotC[out] = decoRotC[idx];
                    rqRotS[out] = decoRotS[idx];
                    rqAlpha[out] = decoAlpha[idx] * this._decorationZoomAlpha;
                    rqTint[out] = decoTint[idx];
                    const dAnimIdx = decoTextureId[idx];
                    rqTextureId[out] = this.animationFrameStart?.[dAnimIdx] ?? INVALID_TEXTURE_ID;
                    rqAnchorX[out] = decoAnchorX[idx];
                    rqAnchorY[out] = decoAnchorY[idx];
                    rqType[out] = 2;
                    rqEntityIndex[out] = -1;

                } else if (type === 3) {
                    // === LIGHT GLOW ===
                    const scale = lightGlowScale(sqrtLightIntensity[idx]);
                    const glowAlpha = lightIntensity[idx] / 20000;

                    if (scale < 0.1 || glowAlpha < 0.001) {
                        rqAlpha[out] = 0;
                        rqScaleX[out] = 0;
                        rqScaleY[out] = 0;
                        rqX[out] = -10000;
                        rqY[out] = -10000;
                    } else {
                        rqX[out] = entityX[idx];
                        rqY[out] = entityY[idx] - (glowHeightOffset[idx] || 0);
                        rqScaleX[out] = scale;
                        rqScaleY[out] = scale;
                        rqAlpha[out] = glowAlpha;
                        rqTint[out] = lightColor[idx];
                    }
                    rqRotC[out] = 1;
                    rqRotS[out] = 0;
                    rqTextureId[out] = lightGradientTextureId;
                    rqAnchorX[out] = 0.5;
                    rqAnchorY[out] = 0.5;
                    rqType[out] = 3;
                    rqEntityIndex[out] = idx;

                } else if (type === 4) {
                    // === BULLET ===
                    if (!bulletActive[idx]) {
                        rqAlpha[out] = 0;
                        rqScaleX[out] = 0;
                        rqScaleY[out] = 0;
                        rqX[out] = -10000;
                        rqY[out] = -10000;
                    } else {
                        rqX[out] = bulletX[idx];
                        rqY[out] = bulletY[idx] + (bulletOffsetY[idx] ?? 0);
                        rqScaleX[out] = bulletScale[idx];
                        rqScaleY[out] = bulletScale[idx];
                        rqRotC[out] = bulletSpriteRotC[idx];
                        rqRotS[out] = bulletSpriteRotS[idx];
                        rqAlpha[out] = bulletAlpha[idx];
                        rqTint[out] = bulletTint[idx];
                        const bAnimIdx = bulletTextureId[idx];
                        rqTextureId[out] = this.animationFrameStart?.[bAnimIdx] ?? INVALID_TEXTURE_ID;
                        rqAnchorX[out] = bulletAnchorX[idx];
                        rqAnchorY[out] = bulletAnchorY[idx];
                    }
                    rqType[out] = 4;
                    rqEntityIndex[out] = -1;

                } else if (type === 5) {
                    // === BULLET TRAIL ===
                    if (!bulletActive[idx]) {
                        rqAlpha[out] = 0;
                        rqScaleX[out] = 0;
                        rqScaleY[out] = 0;
                        rqX[out] = -10000;
                        rqY[out] = -10000;
                    } else {
                        const currX = bulletX[idx];
                        const currY = bulletY[idx] + (bulletOffsetY[idx] ?? 0);
                        const startX = bulletStartX[idx];
                        const startY = bulletStartY[idx] + (bulletOffsetY[idx] ?? 0);
                        const dx = currX - startX;
                        const dy = currY - startY;
                        const lenSq = dx * dx + dy * dy;

                        if (lenSq < BULLET_TRAIL_MIN_LENGTH_SQ) {
                            rqAlpha[out] = 0;
                            rqScaleX[out] = 0;
                            rqScaleY[out] = 0;
                            rqX[out] = -10000;
                            rqY[out] = -10000;
                        } else {
                            const adx = dx < 0 ? -dx : dx;
                            const ady = dy < 0 ? -dy : dy;
                            const max = adx > ady ? adx : ady;
                            const min = adx > ady ? ady : adx;
                            const lengthApprox = 0.96 * max + 0.4 * min;

                            rqX[out] = (startX + currX) * 0.5;
                            rqY[out] = (startY + currY) * 0.5;
                            rqScaleX[out] = lengthApprox / 10;
                            rqScaleY[out] = bulletTrailWidth[idx];
                            rqRotC[out] = bulletRotC[idx];
                            rqRotS[out] = bulletRotS[idx];
                            rqAlpha[out] = bulletAlpha[idx] * 0.9;
                            rqTint[out] = 0xffffff;
                        }
                    }
                    rqTextureId[out] = bulletTrailTextureId;
                    rqAnchorX[out] = 0.5;
                    rqAnchorY[out] = 0.5;
                    rqType[out] = 5;
                    rqEntityIndex[out] = -1;
                }
            }

            ref.count[0] = writeCount;
            collector.count = 0;
        }
    }

    /**
     * LightEmitter list → visibleLightsData SAB (cookie shadows not required).
     * Independent of cookie ShadowCaster queue (raycasted lighting still needs this).
     */
    _collectVisibleLights() {
        const lightEntities = this._sortedLightEntities;
        lightEntities.length = 0;

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
            const screenBounds = calculateCameraScreenBounds(
                zoom, camX, camY, this.canvasWidth, this.canvasHeight, this.cullingRatio, this._cameraBounds
            );
            const worldBounds = screenBoundsToWorldBounds(screenBounds, 0, 0, this._worldBounds);
            const viewMinX = worldBounds.minX;
            const viewMaxX = worldBounds.maxX;
            const viewMinY = worldBounds.minY;
            const viewMaxY = worldBounds.maxY;

            const persistScratch = this._lightPersistScratch;
            const flashScratch = this._lightFlashScratch;
            persistScratch.length = 0;
            flashScratch.length = 0;

            const lightEntitiesRaw = Query.queryActiveEntities(this._queryLightEmitter);
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
                if (isFlash) flashScratch.push(lightIdx);
                else persistScratch.push(lightIdx);
            }

            const maxWrite = this.visibleLightsData
                ? this.visibleLightsData.length - 1
                : persistScratch.length + flashScratch.length;

            if (persistScratch.length + flashScratch.length > maxWrite) {
                this._warnOnce(
                    '_warnedVisibleLightsCap',
                    `[PRE_RENDER] visible light list full (${maxWrite}). Increase lighting.maxLights or reduce visible lights.`
                );
            }

            persistScratch.sort(this._lightYComparator);
            flashScratch.sort(this._lightYComparator);
            const persistTake = Math.min(persistScratch.length, maxWrite);
            for (let i = 0; i < persistTake; i++) lightEntities.push(persistScratch[i]);
            const flashTake = Math.min(flashScratch.length, maxWrite - lightEntities.length);
            for (let i = 0; i < flashTake; i++) lightEntities.push(flashScratch[i]);
            lightEntities.sort(this._lightYComparator);
        }

        if (this.visibleLightsData) {
            const n = lightEntities.length;
            this.visibleLightsData[0] = n;
            for (let w = 0; w < n; w++) this.visibleLightsData[1 + w] = lightEntities[w];
        }
    }

    /**
     * Build shadow render queue
     */
    buildShadowRenderQueue() {
        if (!this.shadowsEnabled || !this.shadowRenderQueueCount) {
            if (this.shadowRenderQueueCount) this.shadowRenderQueueCount[0] = 0;
            return;
        }

        const neighborData = Grid.neighborData;
        const stride = Grid._stride;

        if (!neighborData || Grid.maxNeighbors <= 0) {
            this.shadowRenderQueueCount[0] = 0;
            return;
        }

        const worldX = Transform.x;
        const worldY = Transform.y;
        const transformActive = Transform.active;
        const lightEnabled = LightEmitter.active;
        const lightIntensity = lightEnabled ? LightEmitter.lightIntensity : null;
        const sqrtLightIntensity = lightEnabled ? LightEmitter.sqrtLightIntensity : null;
        const lightHeight = lightEnabled ? LightEmitter.height : null;
        const flashActive = FlashComponent.active;

        // Sun shadows: use fused pass from collectVisibleEntities, or skip if not done
        let writeIdx = this._sunShadowWriteIdx ?? 0;
        let shadowCount = this._sunShadowCount ?? 0;
        this._sunShadowWriteIdx = undefined;
        this._sunShadowCount = undefined;

        const zoom = this.cameraData ? this._frameCameraZoom : 1;
        const camX = this.cameraData ? this._frameCameraX : 0;
        const camY = this.cameraData ? this._frameCameraY : 0;
        const screenBounds = calculateCameraScreenBounds(
            zoom, camX, camY, this.canvasWidth, this.canvasHeight, this.cullingRatio, this._cameraBounds
        );
        const worldBounds = screenBoundsToWorldBounds(screenBounds, 0, 0, this._worldBounds);
        const viewMinX = worldBounds.minX;
        const viewMaxX = worldBounds.maxX;
        const viewMinY = worldBounds.minY;
        const viewMaxY = worldBounds.maxY;

        const lightEntities = this._sortedLightEntities;

        // Point shadows suppressed when sun owns the look — before caster/neighbor work.
        // intensity=1 still left scale≈0.033 (> old MIN 0.003) and burned light×neighbor; gate on sun too.
        const sunIntensity = Sun.isInitialized && Sun.enabled ? Sun.intensity : 0;
        const pointLightShadowMultiplier = 1 - (sunIntensity * 0.9);
        const pointShadowAlphaScale = 0.33 * pointLightShadowMultiplier;
        const MIN_POINT_SHADOW_ALPHA = 0.003;
        if (pointShadowAlphaScale <= MIN_POINT_SHADOW_ALPHA || sunIntensity >= 1) {
            this.shadowRenderQueueCount[0] = writeIdx;
            this.shadowsUpdatedThisFrame = shadowCount;
            return;
        }

        // Shadow-specific: bail if no ShadowCaster SoA (optional) or no entities
        const shadowCasterActive = ShadowCaster.active;
        if (!shadowCasterActive) {
            this.shadowRenderQueueCount[0] = writeIdx;
            this.shadowsUpdatedThisFrame = shadowCount;
            return;
        }
        const shadowHeightMultiplier = ShadowCaster.heightMultiplier;
        const shadowAnchorOffsetX = ShadowCaster.anchorOffsetX;
        const shadowAnchorOffsetY = ShadowCaster.anchorOffsetY;
        const spriteScaleY = SpriteRenderer.scaleY;
        const spriteAnchorX = SpriteRenderer.anchorX;
        const spriteAnchorY = SpriteRenderer.anchorY;

        const maxShadowsPerEntity = this.maxShadowsPerEntity;
        const entityShadowCounts = this._entityShadowCounts;
        const toClear = this._entityShadowIndicesToClear;

        // NOTE: Do NOT clear entityShadowCounts here. collectVisibleEntities()
        // already cleared the previous frame's counts and accumulated sun shadow
        // counts for this frame. Point light shadows must respect those counts so
        // the total per-entity shadow budget (sun + point) is enforced correctly.

        const rqX = this.shadowRenderQueueX;
        const rqY = this.shadowRenderQueueY;
        const rqScaleX = this.shadowRenderQueueScaleX;
        const rqScaleY = this.shadowRenderQueueScaleY;
        const rqRotC = this.shadowRenderQueueRotC;
        const rqRotS = this.shadowRenderQueueRotS;
        const rqAlpha = this.shadowRenderQueueAlpha;
        const rqTint = this.shadowRenderQueueTint;
        const rqTextureId = this.shadowRenderQueueTextureId;
        const rqAnchorX = this.shadowRenderQueueAnchorX;
        const rqAnchorY = this.shadowRenderQueueAnchorY;

        const entityLastTextureId = this.entityLastTextureId;

        const lightGradientAnimIdx = this.animationNameToIndex?.['_lightGradient'] ?? 0;
        const lightGradientTextureId = this.animationFrameStart?.[lightGradientAnimIdx] ?? 0;

        let lightsProcessed = 0;
        const maxItems = this.maxShadowRenderItems;
        const maxShadowSprites = this.maxShadowSprites;
        const PI = Math.PI;

        // ========================================
        // POINT LIGHT SHADOWS
        // ========================================

        // Grid cell data (used for flash direct queries)
        const gridCounts = Grid._gridCounts;
        const gridEntities = Grid._gridEntities;
        const cellByteSize = Grid.cellByteSize;
        const gridWidth = Grid.gridWidth;
        const gridHeight = Grid.gridHeight;
        const invCellSize = Grid.invCellSize;
        const flashCandidateBuffer = this._flashCandidateBuffer;
        const flashDedupMarker = this._flashDedupMarker;
        const colliderOffsetX = Collider.offsetX;
        const colliderOffsetY = Collider.offsetY;
        const visualRange = Collider.visualRange;

        // Frame-unique dedup tag (avoids clearing the marker array each light)
        let dedupTag = 0;

        for (let i = 0; i < lightEntities.length; i++) {
            if (writeIdx >= maxItems) {
                this._warnOnce(
                    '_warnedShadowRenderQueueCap',
                    `[PRE_RENDER] shadow render queue full (${maxItems} items). Increase lighting.maxShadowSprites/maxLights or reduce shadow density.`
                );
                break;
            }
            if (lightsProcessed >= this.maxShadowCastingLights) {
                this._warnOnce(
                    '_warnedShadowCastingLightsCap',
                    `[PRE_RENDER] maxShadowCastingLights reached (${this.maxShadowCastingLights}). Increase lighting.maxShadowCastingLights or reduce visible shadow-casting lights.`
                );
                break;
            }

            const lightIdx = lightEntities[i];
            const intensity = lightIntensity[lightIdx];
            const lightX = worldX[lightIdx];
            const lightY = worldY[lightIdx];
            const lightH = lightHeight[lightIdx] || 0;
            const isFlash = flashActive ? flashActive[lightIdx] === 1 : false;

            // Lighting-only flashes skip the expensive flash grid-query + shadow sprites
            if (
                isFlash &&
                FlashComponent.castShadows &&
                FlashComponent.castShadows[lightIdx] === 0
            ) {
                continue;
            }

            // Shadow-caster neighborhood radius: visualRange for lights; flash uses grid search R
            const searchRangeR = isFlash
                ? (sqrtLightIntensity[lightIdx] || 100)
                : (visualRange[lightIdx] || 0);
            const rangeRSq = searchRangeR * searchRangeR;

            let maxShadowDistSq = pointShadowAlphaScale > MIN_POINT_SHADOW_ALPHA
                ? intensity * ((pointShadowAlphaScale / MIN_POINT_SHADOW_ALPHA) - 1)
                : 0;
            if (rangeRSq > 0 && (maxShadowDistSq <= 0 || maxShadowDistSq > rangeRSq)) {
                maxShadowDistSq = rangeRSq;
            }

            // ── Determine candidate source ────────────────────────────
            let candidateCount = 0;
            let candidateSource = null;   // typed array holding entity indices
            let candidateOffset = 0;

            if (isFlash && gridCounts && flashCandidateBuffer && flashDedupMarker) {
                // FLASH PATH: circle pattern (fewer cells than rect, distance-sorted)
                const searchRadius = searchRangeR;
                const cellRadius = Math.min(((searchRadius * invCellSize) | 0) + 1, 6);
                const centerCol = (lightX * invCellSize) | 0;
                const centerRow = (lightY * invCellSize) | 0;
                const maxCol = gridWidth - 1;
                const maxRow = gridHeight - 1;
                const maxCandidates = flashCandidateBuffer.length;

                const pattern = this._flashCirclePatterns?.get(cellRadius);
                if (!pattern) {
                    candidateCount = 0;
                    candidateSource = flashCandidateBuffer;
                    candidateOffset = 0;
                } else {
                    dedupTag++;
                    let count = 0;
                    const patternLen = pattern.length >> 1;
                    for (let p = 0; p < patternLen; p++) {
                        const r = centerRow + pattern[p * 2];
                        const c = centerCol + pattern[p * 2 + 1];
                        if (r < 0 || r > maxRow || c < 0 || c > maxCol) continue;
                        const cellIndex = r * gridWidth + c;
                        const byteOff = cellIndex * cellByteSize;
                        const cellCount = gridCounts[byteOff];
                        if (cellCount === 0) continue;

                        const entityBase = Grid.getCellBase(cellIndex);
                        for (let j = 0; j < cellCount; j++) {
                            const eid = gridEntities[entityBase + j];
                            if (flashDedupMarker[eid] === dedupTag) continue;
                            flashDedupMarker[eid] = dedupTag;
                            if (count < maxCandidates) flashCandidateBuffer[count++] = eid;
                        }
                    }
                    candidateCount = count;
                    candidateSource = flashCandidateBuffer;
                    candidateOffset = 0;
                }
            } else if (searchRangeR > 0) {
                // REGULAR LIGHT PATH: neighbors within Collider.visualRange
                const offset = lightIdx * stride;
                candidateCount = neighborData[offset];
                candidateSource = neighborData;
                candidateOffset = offset + 1;
            }

            // ── Process candidates into shadow sprites ────────────────
            // Reserve writeIdx for light cookie; shadows follow (interleaved per light)
            const shadowStartIdx = writeIdx + 1;
            let shadowsForThisLight = 0;

            // Flash has no Collider offsets; regular lights may have them
            const lightXWithOffset = isFlash ? lightX : lightX + (colliderOffsetX[lightIdx] || 0);
            const lightYWithOffset = isFlash ? lightY : lightY + (colliderOffsetY[lightIdx] || 0);

            for (let k = 0; k < candidateCount; k++) {
                if (shadowsForThisLight >= this.maxShadowsPerLight) {
                    this._warnOnce(
                        '_warnedShadowSpriteCap',
                        `[PRE_RENDER] maxShadowsPerLight reached (${this.maxShadowsPerLight}). Increase lighting.maxShadowsPerLight or reduce nearby shadow casters.`
                    );
                    break;
                }
                if (shadowCount >= maxShadowSprites) {
                    this._warnOnce(
                        '_warnedShadowSpriteCap',
                        `[PRE_RENDER] maxShadowSprites reached (${maxShadowSprites}). Increase lighting.maxShadowSprites or reduce shadow density.`
                    );
                    break;
                }
                if (writeIdx + 1 + shadowsForThisLight >= maxItems) {
                    this._warnOnce(
                        '_warnedShadowRenderQueueCap',
                        `[PRE_RENDER] shadow render queue full (${maxItems} items). Increase lighting.maxShadowSprites/maxLights or reduce shadow density.`
                    );
                    break;
                }

                const neighborIdx = candidateSource[candidateOffset + k];

                if (!shadowCasterActive[neighborIdx] || !transformActive[neighborIdx]) continue;

                const heightMult = shadowHeightMultiplier[neighborIdx];
                if (heightMult <= 0) continue;

                if (maxShadowsPerEntity > 0 && entityShadowCounts[neighborIdx] >= maxShadowsPerEntity) continue;

                const pose = this._displayPoseOut;
                this._displayPose(neighborIdx, pose);
                const neighborX = pose.x + (colliderOffsetX[neighborIdx] || 0);
                const neighborY = pose.y + (colliderOffsetY[neighborIdx] || 0);
                const dx = neighborX - lightXWithOffset;
                const dy = neighborY - lightYWithOffset;
                const distSq = dx * dx + dy * dy;

                if (distSq < 1) continue;
                if (maxShadowDistSq > 0 && distSq > maxShadowDistSq) continue;
                if (rangeRSq > 0 && distSq >= rangeRSq) continue;

                const casterX = pose.x;
                const casterY = pose.y;
                const textureId = entityLastTextureId ? entityLastTextureId[neighborIdx] : INVALID_TEXTURE_ID;
                if (textureId === INVALID_TEXTURE_ID) continue;

                const entityScaleY = Math.abs(spriteScaleY[neighborIdx]) || 1;
                const anchorX = spriteAnchorX[neighborIdx] ?? 0.5;
                const anchorY = spriteAnchorY[neighborIdx] ?? 0.95;

                const invDist = 1 / Math.sqrt(distSq);
                const distRatio = distSq * invDist * 0.00390625; // dist / 256
                const clampedDistRatio = distRatio > 1 ? 1 : distRatio;
                const lengthScale = -(0.3 + clampedDistRatio * 0.9) * entityScaleY * heightMult;

                const originalHeight = this.frameHeight ? this.frameHeight[textureId] : 50;
                const shadowExtent = Math.abs(lengthScale) * originalHeight + 100;
                if (casterX + shadowExtent < viewMinX || casterX - shadowExtent > viewMaxX ||
                    casterY + shadowExtent < viewMinY || casterY - shadowExtent > viewMaxY) continue;

                // Soft fade to 0 at search range R so neighbor-list drop is not a hard pop
                const rangeFade = rangeRSq > 0 ? (1 - distSq / rangeRSq) : 1;
                let alpha = intensity / (intensity + distSq);
                if (Number.isNaN(alpha)) alpha = 0;
                if (alpha > 1) alpha = 1;
                if (alpha < 0) alpha = 0;
                alpha *= pointShadowAlphaScale * rangeFade;
                if (alpha < MIN_POINT_SHADOW_ALPHA) continue;

                // Facing = light→caster dir rotated -90°: cos(θ-π/2)=sin(θ)=dy/r, sin(θ-π/2)=-cos(θ)=-dx/r
                const shadowIdx = shadowStartIdx + shadowsForThisLight;
                rqX[shadowIdx] = casterX;
                rqY[shadowIdx] = casterY;
                rqScaleX[shadowIdx] = 1;
                rqScaleY[shadowIdx] = lengthScale;
                rqRotC[shadowIdx] = dy * invDist;
                rqRotS[shadowIdx] = -dx * invDist;
                rqAlpha[shadowIdx] = alpha;
                rqTint[shadowIdx] = 0x000000;
                rqTextureId[shadowIdx] = textureId;
                rqAnchorX[shadowIdx] = anchorX + (shadowAnchorOffsetX[neighborIdx] || 0);
                rqAnchorY[shadowIdx] = anchorY + (shadowAnchorOffsetY[neighborIdx] || 0);

                shadowsForThisLight++;
                shadowCount++;
                if (maxShadowsPerEntity > 0) {
                    entityShadowCounts[neighborIdx]++;
                    if (toClear) toClear[this._entityShadowIndicesToClearCount++] = neighborIdx;
                }
            }

            // Always emit light cookie (even with 0 casters) so CASTED_SHADOWS lit pools
            // stay on-screen and other lights can attenuate prior shadows.
            lightsProcessed++;

            const gradientScale = lightCookieScale(sqrtLightIntensity[lightIdx]);
            const gradientAlpha = intensity / 50000;

            rqX[writeIdx] = lightX;
            rqY[writeIdx] = lightY - lightH;
            rqScaleX[writeIdx] = gradientScale;
            rqScaleY[writeIdx] = gradientScale;
            rqRotC[writeIdx] = 1;
            rqRotS[writeIdx] = 0;
            rqAlpha[writeIdx] = gradientAlpha;
            rqTint[writeIdx] = 0xFFFFFF;
            rqTextureId[writeIdx] = lightGradientTextureId;
            rqAnchorX[writeIdx] = 0.5;
            rqAnchorY[writeIdx] = 0.5;

            writeIdx = shadowStartIdx + shadowsForThisLight;
        }

        this.shadowRenderQueueCount[0] = writeIdx;
        this.shadowsUpdatedThisFrame = shadowCount;
    }

    /**
     * Build visibility polygons for all visible lights (raycasted light occlusion).
     * Collects nearby LightOccluder entities, packs Collider shapes (circle / OBB / poly),
     * runs Angular Sweep, and writes self-lit queue entries for the lighting fill pass.
     */
    buildVisibilityPolygons() {
        if (!this.visibilityPolygonsEnabled) return;

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

        const entityLastTextureId = this.entityLastTextureId;
        const maxSelfLit = this._selfLitMax || 0;
        let selfLitCount = 0;
        const selfLitI32 = selfLitBuf ? selfLitBuf.i32 : null;
        const selfLitF32 = selfLitBuf ? selfLitBuf.f32 : null;
        const selfLitU16 = selfLitBuf ? selfLitBuf.u16 : null;
        const selfLitU8 = selfLitBuf ? selfLitBuf.u8 : null;
        const selfLitItemBytes = this._selfLitItemBytes || 28;

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

        for (let li = 0; li < lightCount && lightsWritten < maxLts; li++) {
            const lightIdx = visibleLights[1 + li];
            if (!lightEnabled[lightIdx]) continue;

            const intensity = lightIntensity[lightIdx];
            if (intensity <= 0) continue;

            // Same display pose as sprites (post-step publish), not live Transform
            this._displayPose(lightIdx, pose);
            const lx = pose.x;
            const ly = pose.y;
            const influenceRadius = lightInfluenceRadius(sqrtLightIntensity[lightIdx]);

            let occCount = 0;
            let vertPool = 0;
            let occluderLimitHit = false;

            if (neighborData && stride > 0) {
                const offset = lightIdx * stride;
                const nCount = neighborData[offset];
                for (let k = 0; k < nCount; k++) {
                    if (occCount >= maxOccluders) {
                        occluderLimitHit = true;
                        break;
                    }
                    const nIdx = neighborData[offset + 1 + k];
                    if (!transformActive[nIdx] || !occluderActive[nIdx] || !colliderActive[nIdx]) continue;

                    this._displayPose(nIdx, pose);
                    const wx = pose.x;
                    const wy = pose.y;
                    const c = pose.rotC;
                    const s = pose.rotS;

                    const shape = shapeType[nIdx];
                    const ox = colOffX[nIdx] || 0;
                    const oy = colOffY[nIdx] || 0;
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
                        reach = Math.hypot(hw, hh);
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
                        const texId = entityLastTextureId ? entityLastTextureId[nIdx] : INVALID_TEXTURE_ID;
                        selfLitU16[u16Off + 12] = texId; // after 6×i32/f32 = 24 bytes
                        selfLitU8[byteOff + 26] = occluderMaskMode[nIdx] | 0;
                        selfLitU8[byteOff + 27] = 0;
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

            const vertCount = buildVisibilityPolygon(
                lx, ly, influenceRadius,
                kind, cX, cY, cR, vertStart, vertCountArr, vertsX, vertsY,
                occCount, outX, outY, maxVerts
            );

            // Layout: [lightIdx:i32, lightX:f32, lightY:f32, vertexCount:i32, x[N]:f32, y[N]:f32]
            const baseIndex = (4 + lightsWritten * slotBytes) >> 2;
            i32[baseIndex] = lightIdx;
            f32[baseIndex + 1] = lx;
            f32[baseIndex + 2] = ly;
            i32[baseIndex + 3] = vertCount;

            const xStart = baseIndex + 4;
            f32.set(outX.subarray(0, vertCount), xStart);
            f32.set(outY.subarray(0, vertCount), xStart + maxVerts);

            lightsWritten++;
        }

        buf.header[0] = lightsWritten;
        if (selfLitBuf) selfLitBuf.header[0] = selfLitCount;
    }

    /**
     * Override reportFPS to write stats to SharedArrayBuffer
     */
    reportFPS() {
        if (!this.stats) return;
        this.stats[PRE_RENDER_STATS.FPS] = this.currentFPS;
        this.stats[PRE_RENDER_STATS.STEP_MS] = this.stepTimeThisFrame;
        if (!this.collectDetailedStats) return;
        this.stats[PRE_RENDER_STATS.VISIBLE_ENTITIES] = this.visibleEntitiesCount;
        this.stats[PRE_RENDER_STATS.VISIBLE_PARTICLES] = this.visibleParticlesCount;
        this.stats[PRE_RENDER_STATS.VISIBLE_DECORATIONS] = this.visibleDecorationsCount;
        this.stats[PRE_RENDER_STATS.SHADOWS_UPDATED] = this.shadowsUpdatedThisFrame;
        this.stats[PRE_RENDER_STATS.RENDER_QUEUE_SIZE] = this.renderQueueCount ? this.renderQueueCount[0] : 0;
        this.stats[PRE_RENDER_STATS.MSG_MS] = this.messageTimeThisFrame;
        this.stats[PRE_RENDER_STATS.SKIPPED_FRAMES] = this.skippedFramesThisFrame;
        this.stats[PRE_RENDER_STATS.COLLECT_MS] = this.collectTimeThisFrame;
        this.stats[PRE_RENDER_STATS.SORT_MS] = this.sortTimeThisFrame;
        this.stats[PRE_RENDER_STATS.EMIT_MS] = this.emitTimeThisFrame;
        this.stats[PRE_RENDER_STATS.CUSTOM_LAYER_MS] = this.customLayerTimeThisFrame;
        this.stats[PRE_RENDER_STATS.SHADOW_Q_MS] = this.shadowQTimeThisFrame;
        this.stats[PRE_RENDER_STATS.VISIBILITY_MS] = this.visibilityTimeThisFrame;
        this.stats[PRE_RENDER_STATS.ADOBE_MS] = this.adobeTimeThisFrame;
    }
}

// Create singleton instance
self.preRenderWorker = new PreRenderWorker(self);
