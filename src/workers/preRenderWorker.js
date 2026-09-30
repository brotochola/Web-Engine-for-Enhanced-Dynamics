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
import { poseRotationLive } from '../box2d/box2dBodySync.js';
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
    lightInfluenceRadius,
    lightCookieScale,
    lightGlowScale,
} from '../util/utils.js';
import { PRE_RENDER_STATS, createMultiWorkerStatsWriter } from '../util/workersUtils.js';
import { orderSortKey, spriteYSortKey, zSortBand, createPainterState } from '../util/sortIndexByKey.js';
import {
    RENDERER_DEFAULTS,
    PRE_RENDER_DEFAULTS,
    LIGHTING_DEFAULTS,
    resolvePreRenderInterpolation,
    CAMERA_TYPES,
    DECORATION_Y_SORT_SCALE,
    ENTITY_GLOW_SORT_BIAS,
    ShapeType,
    MAX_POLYGON_VERTICES,
    SPRITE_TILE_MODE,
} from '../util/configDefaults.js';
import { ySortEnabled, resolveSpritePipeline, PACK_GPU_SPRITES_PRERENDER, SORT_SPRITES_PRERENDER } from '../render/rendererBackend.js';
import { Layer } from '../core/layer.js';
import { createViews as createRenderQueueViews, createRenderQueueCameraViews } from '../render/renderQueueLayout.js';
import {
    GPU_SPRITE_FLOATS,
    GPU_CASTER_FLOATS,
    GPU_SPACE_WORLD,
    GPU_SPACE_SCREEN,
    GPU_FLAG_SORTED,
    createGpuQueueViews,
    clearGpuQueueHeader,
    writeGpuQueueHeader,
    packInstancedRows,
    makePackContext,
} from '../render/gpuQueueLayout.js';
import {
    compactShadowCasterIndices,
    stampLightRange,
    rtPixelSize,
    rtPixelScale,
} from '../render/gpuShadowCasters.js';
import { packSpriteLayer } from '../render/packSpriteLayer.js';
import { bindLiquidFunRender } from '../render/liquidFunRender.js';
import { LiquidFun } from '../core/liquidFun.js';
import { AdobeAnimRegistry } from '../core/adobeAnimRegistry.js';
const INVALID_TEXTURE_ID = 0xFFFF;
const EMPTY_OWNED_IDS = new Uint32Array(0);
const TILE_MODE_LOCAL = SPRITE_TILE_MODE.LOCAL;

/** Stretch / skip tiling on non-entity queue rows (particles, adobe pieces, …). */
function clearTileFields(ref, out) {
    if (ref.tileMode) ref.tileMode[out] = 0;
    if (ref.tileOffsetU) ref.tileOffsetU[out] = 0;
    if (ref.tileOffsetV) ref.tileOffsetV[out] = 0;
    if (ref.tileMulX) ref.tileMulX[out] = 0;
    if (ref.tileMulY) ref.tileMulY[out] = 0;
}

/** Non-caster rows: zero stamp extras instead of fill() of the whole prefix. */
function clearQueueShadow(ref, out) {
    if (ref.shadowH) ref.shadowH[out] = 0;
    if (ref.shadowOffX) ref.shadowOffX[out] = 0;
    if (ref.shadowOffY) ref.shadowOffY[out] = 0;
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
        this.shadowQTimeThisFrame = 0;
        this.visibilityTimeThisFrame = 0;
        this.adobeTimeThisFrame = 0;
        this.waitTimeThisFrame = 0;

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
        this._renderableCount = 0;

        // Pre-allocated query arrays
        this._queryLightEmitter = null;
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
            anchorX: null, anchorY: null, type: null,
            repeatX: null, repeatY: null,
            tileMode: null, tileOffsetU: null, tileOffsetV: null,
            tileMulX: null, tileMulY: null,
        };

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
    _resolveAnimFrameStart(animIdx, label) {
        if (animIdx === undefined || animIdx === null || animIdx < 0) {
            this._warnMissingTexture(
                `anim:${label}`,
                `[PRE_RENDER] missing animation "${label}" (animIdx=${animIdx})`
            );
            return INVALID_TEXTURE_ID;
        }
        const start = this.animationFrameStart?.[animIdx];
        if (start === undefined || start === null) {
            this._warnMissingTexture(
                `frameStart:${label}:${animIdx}`,
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
        });
        this._packGpuSpritesOn = spritePipe.packGpuSprites;
        this._sortSprites = spritePipe.sortSprites;
        this._gpuPackCtx = {};
        this._zBand = zSortBand(this.config.worldHeight || 0);
        this._glowLayerAlpha = 1;

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
            this._persistEntity = [new Int32Array(maxItems), new Int32Array(maxItems)];
            this._persistType = [new Uint8Array(maxItems), new Uint8Array(maxItems)];
            this._persistFrame = [new Uint16Array(maxItems), new Uint16Array(maxItems)];
            this._persistAnim = [new Uint16Array(maxItems), new Uint16Array(maxItems)];
            this._persistCount = [0, 0];

            // Pre-allocate query arrays
            this._queryLightEmitter = [LightEmitter];
            this._querySpriteRenderer = [SpriteRenderer];
            this._queryAdobeAnim = [AdobeAnimComponent];

            if (data.gpuQueue && data.gpuQueue.dataA && data.gpuQueue.dataB && data.gpuQueue.caps) {
                const caps = data.gpuQueue.caps;
                this.gpuQueueCaps = caps;
                this.gpuQueueBuffers = [
                    createGpuQueueViews(data.gpuQueue.dataA, caps),
                    createGpuQueueViews(data.gpuQueue.dataB, caps),
                ];
                this._gpuIdxEntity = new Uint32Array(maxItems);
                this._gpuIdxGlow = new Uint32Array(maxItems);
                this._gpuPackCtx = {};
                this._gpuCasterIdx = new Uint32Array(Math.max(1, caps.maxSun | 0, maxItems));
                this._gpuStampTmp = new Uint32Array(Math.max(1, caps.maxStamp | 0, maxItems));
                this._gpuStampDist = new Float32Array(Math.max(1, caps.maxStamp | 0, maxItems));
                this._gpuStampOrder = new Uint32Array(Math.max(1, caps.maxStamp | 0, maxItems));
                this._gpuCasterUsed = new Uint8Array(Math.max(1, caps.maxSun | 0, maxItems));
                this._gpuKeepIdx = new Uint32Array(Math.max(1, caps.maxStamp | 0, maxItems));
                this._gpuPackOpts = {};
                this._gpuCookieQ = null;
                const cookieN = Math.max(1, caps.maxCookie | 0);
                if (cookieN > 0) {
                    const cookieRot = new Float32Array(cookieN);
                    const cookieAnchor = new Float32Array(cookieN);
                    const cookieTint = new Uint32Array(cookieN);
                    cookieRot.fill(1);
                    cookieAnchor.fill(0.5);
                    cookieTint.fill(0xffffff);
                    this._gpuCookieQ = {
                        count: 0,
                        x: new Float32Array(cookieN),
                        y: new Float32Array(cookieN),
                        scaleX: new Float32Array(cookieN),
                        scaleY: new Float32Array(cookieN),
                        rotC: cookieRot,
                        rotS: new Float32Array(cookieN),
                        alpha: new Float32Array(cookieN),
                        tint: cookieTint,
                        textureId: new Uint16Array(cookieN),
                        anchorX: cookieAnchor,
                        anchorY: cookieAnchor,
                    };
                }
                this._gpuCounts = { sprite: 0, glow: 0, sun: 0, stamp: 0, cookie: 0, particle: 0 };
                if (this._ySort) this._gpuPainter = createPainterState(maxItems);
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
        }

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
            for (let i = 0; i < lightCap; i++) {
                this._stampLights[i] = {
                    id: 0, x: 0, y: 0, intensity: 0, rangeSq: 0, sqrtI: 0, distSq: 0,
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

        }
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

    latchCamera(writeQueueCamera = true) {
        if (!this.cameraData) return;
        this._frameCameraZoom = this.cameraData[0];
        this._frameCameraX = this.cameraData[1];
        this._frameCameraY = this.cameraData[2];
        const aligned = Camera.alignFollowCameraToLatchedPose(
            this._frameCameraX, this._frameCameraY, this._poseX, this._poseY
        );
        this._frameCameraX = aligned.x;
        this._frameCameraY = aligned.y;
        const worldWidth = Camera.worldWidth;
        const worldHeight = Camera.worldHeight;
        if (worldWidth !== Infinity && worldHeight !== Infinity && this._frameCameraZoom > 0) {
            const viewWidth = Camera.canvasWidth / this._frameCameraZoom;
            const viewHeight = Camera.canvasHeight / this._frameCameraZoom;
            const maxX = Math.max(0, worldWidth - viewWidth);
            const maxY = Math.max(0, worldHeight - viewHeight);
            this._frameCameraX = Math.max(0, Math.min(this._frameCameraX, maxX));
            this._frameCameraY = Math.max(0, Math.min(this._frameCameraY, maxY));
        }
        if (writeQueueCamera && this.renderQueueCamera) {
            this.renderQueueCamera[0] = this._frameCameraZoom;
            this.renderQueueCamera[1] = this._frameCameraX;
            this.renderQueueCamera[2] = this._frameCameraY;
        }
    }

    resetFrameCounters() {
        this.visibleEntitiesCount = 0;
        this.visibleParticlesCount = 0;
        this.visibleDecorationsCount = 0;
        this.shadowsUpdatedThisFrame = 0;
        this._renderableCount = 0;
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
        this.shadowQTimeThisFrame = 0;
        this.visibilityTimeThisFrame = 0;
        this.adobeTimeThisFrame = 0;
        this.waitTimeThisFrame = 0;
    }

    packSpriteAndShadowQueues() {
        if (!this.gpuQueueBuffers) return;
        const detail = this.collectDetailedStats;
        const started = detail ? performance.now() : 0;
        const sortBefore = this.sortTimeThisFrame;
        this._packGpuQueues(this.gpuQueueBuffers[this._queueBuf]);
        if (detail) {
            const packed = performance.now() - started;
            const sortDelta = this.sortTimeThisFrame - sortBefore;
            this.shadowQTimeThisFrame = packed - (sortDelta > 0 ? sortDelta : 0);
        }
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
        this.latchCamera();
        this.resetFrameCounters();
        this._frameAdobeEntities = AdobeAnimComponent.active
            ? Query.queryActiveEntities(this._queryAdobeAnim || [AdobeAnimComponent])
            : (this._emptyAdobeEntities || (this._emptyAdobeEntities = []));

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

        this.collectVisibleLights();
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
            this._cameraBounds
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
        const from = 0;
        const to = count;

        const x = lf.x;
        const y = lf.y;
        const bounds = this._frameCameraBoundsValid ? this.calculateCameraBounds() : null;
        if (!bounds) {
            for (let i = from; i < to; i++) {
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
        for (let i = from; i < to; i++) {
            const sx = x[i] * camZoom - camOffX;
            const sy = y[i] * camZoom - camOffY;
            if (sx > minX && sx < maxX && sy > minY && sy < maxY) {
                this.collectRenderable(7, i, y[i] * Y_SORT_K);
                this.visibleParticlesCount++;
            }
        }
    }

    /**
     * Entity visibility + collect for the sprite queue.
     */
    collectVisibleEntities() {
        if (this.globalEntityCount === 0 || !SpriteRenderer.active || !this.cameraData) return;

        const cameraBounds = this.calculateCameraBounds();
        if (!cameraBounds) return;

        const x = Transform.x;
        const y = Transform.y;
        const active = Transform.active;
        const spriteRendererActive = SpriteRenderer.active;
        const renderVisible = SpriteRenderer.renderVisible;
        const visualRange = Collider.visualRange;

        const camZoom = cameraBounds.zoom;
        const cameraOffsetX = cameraBounds.cameraOffsetX;
        const cameraOffsetY = cameraBounds.cameraOffsetY;
        const screenMinX = cameraBounds.minX;
        const screenMaxX = cameraBounds.maxX;
        const screenMinY = cameraBounds.minY;
        const screenMaxY = cameraBounds.maxY;

        // Iteration source: published sprite query, else full index scan (not the live SAB list).
        // Normalized to (array, base offset) instead of a per-frame closure so the
        // hot loop below stays allocation-free and the index load stays inlineable.
        let iterCount, iterSource;
        const spriteEntities = Query.queryActiveEntities(this._querySpriteRenderer || [SpriteRenderer]);
        if (spriteEntities && spriteEntities.length > 0) {
            iterCount = spriteEntities.length;
            iterSource = spriteEntities;
        } else {
            // Do not walk live activeEntitiesData — logic0 may be mid-merge
            // with count=1. Empty published query falls back to a full scan
            // (inactive slots skip). create() drain publishes before start.
            iterCount = this.globalEntityCount;
            iterSource = null;
        }

        const boundsHalfW = SpriteRenderer.boundsHalfW;
        const boundsHalfH = SpriteRenderer.boundsHalfH;
        const spritesheetId = SpriteRenderer.spritesheetId;

        for (let idx = 0; idx < iterCount; idx++) {
            const i = iterSource ? iterSource[idx] : idx;
            if (!active[i]) continue;
            if (!spriteRendererActive || !spriteRendererActive[i]) continue;

            if (!this.skipCull) {
                const sx = x[i] * camZoom - cameraOffsetX;
                const sy = y[i] * camZoom - cameraOffsetY;

                // Use cached bounds (updated on scale/animation change)
                let halfExtent = 0;
                if (boundsHalfW) {
                    const halfW = boundsHalfW[i] || 0;
                    const halfH = boundsHalfH ? (boundsHalfH[i] || 0) : 0;
                    if (halfW > halfH) halfExtent = halfW;
                    else if (halfH > 0) halfExtent = halfH;
                }
                if (halfExtent <= 0 && visualRange) halfExtent = visualRange[i] || 0;
                const extent = halfExtent * camZoom;
                const onScreen = sx >= screenMinX - extent && sx <= screenMaxX + extent &&
                    sy >= screenMinY - extent && sy <= screenMaxY + extent;
                if (!onScreen) continue;
            }

            // sheetId 0 = unset (spawn reset / pool recycle). Never queue.
            if (renderVisible[i] && spritesheetId && spritesheetId[i]) {
                this.collectRenderable(0, i, 0);
                this.visibleEntitiesCount++;
            }

            // Sun shadows are a second draw of this sprite. No shadow-queue row.
        }

        // PRE-HOT: glow collect in a separate pass over LightEmitter actives only
        this._collectEntityGlow(x, y, visualRange, camZoom, cameraOffsetX, cameraOffsetY,
            screenMinX, screenMaxX, screenMinY, screenMaxY);
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
                for (let li = 0; li < lights.length; li++) {
                    const i = lights[li];
                    if (!leActive[i] || !leGlow[i]) continue;
                    if (leIntensity[i] < MIN_GLOW_INTENSITY) continue;
                    if ((visualRange[i] || leSqrt[i] || 200) < MIN_GLOW_RANGE) continue;
                    if (!this.skipCull) {
                        const sx = x[i] * camZoom - cameraOffsetX;
                        const sy = y[i] * camZoom - cameraOffsetY;
                        let halfExtent = 0;
                        const halfW = SpriteRenderer.boundsHalfW?.[i] ?? 0;
                        const halfH = SpriteRenderer.boundsHalfH?.[i] ?? 0;
                        if (halfW > 0 || halfH > 0) halfExtent = halfW > halfH ? halfW : halfH;
                        if (halfExtent <= 0) halfExtent = visualRange[i] || 0;
                        const extent = halfExtent * camZoom;
                        if (
                            sx < screenMinX - extent || sx > screenMaxX + extent ||
                            sy < screenMinY - extent || sy > screenMaxY + extent
                        ) continue;
                    }
                    this.collectRenderable(3, i, y[i] * Y_SORT_K + ENTITY_GLOW_SORT_BIAS);
                }
            }
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
                this.collectRenderable(6, i, 0);
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

    _setQueueType(ref, out, type) {
        if (ref.type) ref.type[out] = type;
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

    _type0PersistHit(bufIdx, count, collectorType, collectorIndex) {
        if (!this._persistEntity || this._persistCount[bufIdx] !== count) return false;
        const prevE = this._persistEntity[bufIdx];
        const prevT = this._persistType[bufIdx];
        const prevF = this._persistFrame[bufIdx];
        const prevA = this._persistAnim[bufIdx];
        const dirty = SpriteRenderer.renderDirty;
        const frameIndex = this.entityFrameIndex;
        const animState = SpriteRenderer.animationState;
        for (let i = 0; i < count; i++) {
            const type = collectorType[i];
            const idx = collectorIndex[i];
            if (prevT[i] !== type || prevE[i] !== idx) return false;
            // Adobe (type 6) expands to N queue rows. Persist writes at the
            // collector index, which is not the emit write index once any
            // expanded row is in the list — skip persist for that frame.
            if (type === 6) return false;
            if (type !== 0) continue;
            if (dirty && dirty[idx]) return false;
            if (frameIndex && prevF[i] !== (frameIndex[idx] | 0)) return false;
            if (animState && prevA[i] !== (animState[idx] | 0)) return false;
        }
        return true;
    }

    _rememberType0Set(bufIdx, count, collectorType, collectorIndex) {
        if (!this._persistEntity) return;
        const prevE = this._persistEntity[bufIdx];
        const prevT = this._persistType[bufIdx];
        const prevF = this._persistFrame[bufIdx];
        const prevA = this._persistAnim[bufIdx];
        const dirty = SpriteRenderer.renderDirty;
        const frameIndex = this.entityFrameIndex;
        const animState = SpriteRenderer.animationState;
        for (let i = 0; i < count; i++) {
            const type = collectorType[i];
            const idx = collectorIndex[i];
            prevT[i] = type;
            prevE[i] = idx;
            prevF[i] = frameIndex ? (frameIndex[idx] | 0) : 0;
            prevA[i] = type === 0 && animState ? (animState[idx] | 0) : 0;
            if (type === 0 && dirty) dirty[idx] = 0;
        }
        this._persistCount[bufIdx] = count;
    }

    _writeQueueShadow(out, entityIndex, ref) {
        const shadowH = (ref && ref.shadowH) || this.renderQueueShadowH;
        if (!shadowH) return;
        const i = entityIndex | 0;
        const cast = ShadowCaster.active && ShadowCaster.active[i];
        shadowH[out] = cast ? (ShadowCaster.heightMultiplier[i] || 0) : 0;
        const offX = (ref && ref.shadowOffX) || this.renderQueueShadowOffX;
        const offY = (ref && ref.shadowOffY) || this.renderQueueShadowOffY;
        if (offX) offX[out] = cast ? (ShadowCaster.anchorOffsetX[i] || 0) : 0;
        if (offY) offY[out] = cast ? (ShadowCaster.anchorOffsetY[i] || 0) : 0;
    }

    _writeType0PosesOnly(count, collectorType, collectorIndex, collectorY, stashPx, stashPy, stashRc, stashRs) {
        const rqX = this.renderQueueX;
        const rqY = this.renderQueueY;
        const rqRotC = this.renderQueueRotC;
        const rqRotS = this.renderQueueRotS;
        const rqSortKey = this.renderQueueSortKey;
        const writeSortKey = !!(rqSortKey && this._queueHasOrder());
        const ySort = writeSortKey && this._entityYSort();
        const inherit = SpriteRenderer.inheritTransformRotation;
        for (let i = 0; i < count; i++) {
            if (collectorType[i] !== 0) continue;
            const idx = collectorIndex[i];
            rqX[i] = stashPx[i];
            rqY[i] = stashPy[i];
            if (inherit && inherit[idx]) {
                rqRotC[i] = stashRc[i];
                rqRotS[i] = stashRs[i];
            }
            if (writeSortKey) rqSortKey[i] = this._orderKey(0, idx, collectorY[i], ySort);
            this._writeQueueShadow(i, idx);
        }
    }

    _spriteSortY(index, pose) {
        return spriteYSortKey(this._spriteSortFootY(index, pose), Y_SORT_K);
    }

    /**
     * Y-sort line is the sprite's bottom edge, not the pose.
     * Identity rotation: y + (1 - anchorY) * height * |scaleY|.
     * Rotation uses the same local offset as the sprite vertex shader.
     */
    _spriteSortFootY(index, pose) {
        const anchorX = SpriteRenderer.anchorX;
        const anchorY = SpriteRenderer.anchorY;
        const scaleX = SpriteRenderer.scaleX;
        const scaleY = SpriteRenderer.scaleY;
        if (!anchorX || !anchorY || !scaleX || !scaleY) {
            return pose.y;
        }
        const textureId = this._entityTextureIdOrResolve(index);
        let w = 0;
        let h = 0;
        if (textureId !== INVALID_TEXTURE_ID && this.frameWidth && this.frameHeight) {
            w = this.frameWidth[textureId] || 0;
            h = this.frameHeight[textureId] || 0;
        }
        const ox = (0.5 - anchorX[index]) * w * scaleX[index];
        const oy = (1 - anchorY[index]) * h * Math.abs(scaleY[index]);
        return pose.y + ox * pose.rotS + oy * pose.rotC;
    }

    _writeRenderable(type, index, y, layerId) {
        if (this._customLayerCollectors && layerId !== Layer.entitiesId) {
            const collector = this._customLayerCollectors[layerId];
            if (collector) {
                if (collector.count < collector.maxItems) {
                    const wi = collector.count;
                    let sortY = y;
                    if (type === 0 || type === 6) {
                        const pose = this._displayPoseOut;
                        this._displayPose(index, pose);
                        sortY = this._spriteSortY(index, pose);
                    }
                    collector.y[wi] = sortY;
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
            // Drawn Y, whole pixels. A raw pose.y key changes bits on a
            // fraction of a pixel and the painter swaps two sprites that
            // did not cross.
            this._renderableY[writeIdx] = this._spriteSortY(index, pose);
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
        if (!this.interpolatePhysicsPose) return;
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
     * Writes into caller-provided `out` (no alloc). Applies preRender.interpolation
     * (mode 'interpolate' | 'off') when a published pose is available.
     * @param {number} idx
     * @param {{ x: number, y: number, rotC: number, rotS: number }} out
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
                out.x = px + (poseX[idx] - px) * alpha;
                out.y = py + (this._poseY[idx] - py) * alpha;
                const pc = prevPoseRotC[idx];
                const ps = prevPoseRotS[idx];
                const c = poseRotC[idx];
                const s = poseRotS[idx];
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
            out.rotC = poseRotC[idx];
            out.rotS = poseRotS[idx];
            return;
        }
        out.x = Transform.x[idx];
        out.y = Transform.y[idx];
        const rotC = Transform.rotC;
        const rotS = Transform.rotS;
        out.rotC = rotC && rotC[idx] !== undefined ? rotC[idx] : 1;
        out.rotS = rotS ? (rotS[idx] || 0) : 0;
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

        let feetSlot = -1;
        let feetY = 0;
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
            this._setQueueType(ref, writeIndex, 6, entityIndex);
            if (ref.repeatX) ref.repeatX[writeIndex] = 0;
            if (ref.repeatY) ref.repeatY[writeIndex] = 0;
            clearTileFields(ref, writeIndex);
            if (ref.sortKey) ref.sortKey[writeIndex] = sortKey;
            if (ref.shadowH) {
                ref.shadowH[writeIndex] = 0;
                if (ref.shadowOffX) ref.shadowOffX[writeIndex] = 0;
                if (ref.shadowOffY) ref.shadowOffY[writeIndex] = 0;
            }
            const pieceWorldY = ref.y[writeIndex];
            if (feetSlot < 0 || pieceWorldY >= feetY) {
                feetY = pieceWorldY;
                feetSlot = writeIndex;
            }
            writeIndex++;
        }

        if (feetSlot >= 0) this._writeQueueShadow(feetSlot, entityIndex, ref);

        if (p < end && !this._adobeRenderQueueOverflowWarned) {
            this._adobeRenderQueueOverflowWarned = true;
            console.warn('[PRE_RENDER] Adobe Animate piece expansion exceeded render queue capacity. Increase renderer.maxVisibleRenderables.');
        }

        return writeIndex;
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
        if (!this.renderQueueEnabled || this._renderableCount === 0) {
            if (this.renderQueueCount) this.renderQueueCount[0] = 0;
            return;
        }

        const count = this._renderableCount;
        const hasOrder = this._queueHasOrder();
        const writeCount = this.emitSpriteQueue(deltaTime, this._fillEmitSource(
            count,
            this.renderQueueMaxItems,
            this._renderableY,
            this._renderableType,
            this._renderableIndex,
            this._renderablePx,
            this._renderablePy,
            this._renderableRotC,
            this._renderableRotS,
            true,
            hasOrder,
            hasOrder && this._entityYSort()
        ));
        this.renderQueueCount[0] = writeCount;
        this._emitWriteCount = writeCount;
        this._renderableCount = 0;
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
     * Write one sprite layer from a collector into SoA columns already bound
     * on this.renderQueue*. Main queue and custom layers share this loop.
     */
    emitSpriteQueue(deltaTime, source) {
        const count = source.count;
        const maxItems = source.maxItems;
        const collectorY = source.collectorY;
        const collectorType = source.collectorType;
        const collectorIndex = source.collectorIndex;
        const stashPx = source.stashX;
        const stashPy = source.stashY;
        const stashRc = source.stashRotC;
        const stashRs = source.stashRotS;

        // sortKey is written for the CPU painter. Pixi reinserts; this pass does not sort.
        const detail = source.persist && this.collectDetailedStats;
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
        const glowSprite = LightEmitter.hasGlowSprite;
        const lightGradientTextureId = this._resolveBuiltinTextureId('_lightGradient');
        const whiteCircleTextureId = this._resolveBuiltinTextureId('_whiteCircle');

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

        const bulletTrailTextureId = this._resolveBuiltinTextureId('_bulletTrail');
        const BULLET_TRAIL_MIN_LENGTH_SQ = 0.01;

        const frameIndex = this.entityFrameIndex;
        const frameAccum = this.entityFrameAccumulator;
        const deltaSeconds = deltaTime / 1000;
        const ref = this._emitRef;
        ref.x = rqX; ref.y = rqY; ref.scaleX = rqScaleX; ref.scaleY = rqScaleY;
        ref.rotC = rqRotC; ref.rotS = rqRotS; ref.alpha = rqAlpha; ref.tint = rqTint;
        ref.textureId = rqTextureId; ref.anchorX = rqAnchorX; ref.anchorY = rqAnchorY;
        ref.type = rqType;
        ref.sortKey = rqSortKey;
        ref.repeatX = rqRepeatX; ref.repeatY = rqRepeatY;
        ref.tileMode = rqTileMode; ref.tileOffsetU = rqTileOffsetU; ref.tileOffsetV = rqTileOffsetV;
        ref.tileMulX = rqTileMulX; ref.tileMulY = rqTileMulY;
        ref.shadowH = this.renderQueueShadowH;
        ref.shadowOffX = this.renderQueueShadowOffX;
        ref.shadowOffY = this.renderQueueShadowOffY;

        let writeCount = 0;
        const stashPose = this._displayPoseOut;
        const writeSortKey = !!(rqSortKey && source.hasOrder);
        const ySort = !!source.ySort;
        const persistBuf = source.persist ? this._queueBuf : null;
        const persistHit = persistBuf
            ? this._type0PersistHit(persistBuf, count, collectorType, collectorIndex)
            : false;
        if (persistHit) {
            this._writeType0PosesOnly(count, collectorType, collectorIndex, collectorY, stashPx, stashPy, stashRc, stashRs);
        }

        for (let i = 0; i < count && writeCount < maxItems; i++) {
            const type = collectorType[i];
            const idx = collectorIndex[i];
            const yKey = collectorY[i];
            const sk = writeSortKey ? this._orderKey(type, idx, yKey, ySort) : yKey;

            if (persistHit && type === 0) {
                writeCount++;
                continue;
            }

            if (type === 6) {
                if (stashPx) {
                    stashPose.x = stashPx[i];
                    stashPose.y = stashPy[i];
                    stashPose.rotC = stashRc[i];
                    stashPose.rotS = stashRs[i];
                    writeCount = this._emitAdobePieces(ref, writeCount, idx, sk, stashPose);
                } else {
                    writeCount = this._emitAdobePieces(ref, writeCount, idx, sk, null);
                }
                continue;
            }

            const out = writeCount++;
            if (writeSortKey) rqSortKey[out] = sk;
            if (type !== 0) {
                if (rqRepeatX) rqRepeatX[out] = 0;
                if (rqRepeatY) rqRepeatY[out] = 0;
                clearTileFields(ref, out);
                clearQueueShadow(ref, out);
            }

            if (type === 0) {
                // === ENTITY === (pose stashed at collect when the collector has it)
                let currX;
                let currY;
                let rc;
                let rs;
                if (stashPx) {
                    currX = stashPx[i];
                    currY = stashPy[i];
                    if (srInheritTransformRotation[idx]) {
                        rc = stashRc[i];
                        rs = stashRs[i];
                    } else {
                        rc = srSpriteRotC[idx];
                        rs = srSpriteRotS[idx];
                    }
                } else {
                    this._displayPose(idx, stashPose);
                    currX = stashPose.x;
                    currY = stashPose.y;
                    if (srInheritTransformRotation[idx]) {
                        rc = stashPose.rotC;
                        rs = stashPose.rotS;
                    } else {
                        rc = srSpriteRotC[idx];
                        rs = srSpriteRotS[idx];
                    }
                }
                const sx = srScaleX[idx];
                const sy = srScaleY[idx];
                const a = srAlpha[idx];
                const tint = srTint[idx];
                const ax = srAnchorX[idx];
                const ay = srAnchorY[idx];
                rqAlpha[out] = a;
                this._writeQueueShadow(out, idx);
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

                rqX[out] = currX;
                rqY[out] = currY;
                rqScaleX[out] = sx;
                rqScaleY[out] = sy;
                rqRotC[out] = rc;
                rqRotS[out] = rs;
                rqTint[out] = tint;
                rqAnchorX[out] = ax;
                rqAnchorY[out] = ay;

                this._setQueueType(ref, out, 0, idx);
                const sheetId = srSpritesheetId[idx];
                const animState = srAnimState[idx];
                let tex = INVALID_TEXTURE_ID;

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

                    const animStart = this.animationFrameStart?.[globalAnimIdx];
                    if (animStart === undefined) {
                        this._warnMissingTexture(
                            `animStart:${globalAnimIdx}`,
                            `[PRE_RENDER] animationFrameStart missing for globalAnimIdx=${globalAnimIdx} entity=${idx}`
                        );
                    } else {
                        tex = animStart + frameIndex[idx];
                        if (entityLastTextureId) entityLastTextureId[idx] = tex;
                    }
                } else {
                    // Never reuse stale lastTextureId (pool recycle / spawn before setSprite).
                    if (entityLastTextureId) entityLastTextureId[idx] = INVALID_TEXTURE_ID;
                    // sheetId 0 = unset sentinel — expected under collect→emit recycle. No warn.
                    if (sheetId) {
                        this._warnMissingTexture(
                            `sprite:${sheetId}:${animState}`,
                            `[PRE_RENDER] no global anim for sheetId=${sheetId} animState=${animState} entity=${idx}; using INVALID textureId`
                        );
                    }
                }
                rqTextureId[out] = tex;
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
                    : this._resolveAnimFrameStart(pAnimIdx, `particle:${pAnimIdx}`);
                rqAnchorX[out] = 0.5;
                rqAnchorY[out] = 0.5;
                this._setQueueType(ref, out, 1, idx);
            } else if (type === 7) {
                const lf = this.liquidFun;
                if (
                    this.interpolatePhysicsPose &&
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
                    : this._resolveAnimFrameStart(lfAnimIdx, `liquidFun:${lfAnimIdx}`);
                rqAnchorX[out] = 0.5;
                rqAnchorY[out] = 0.5;
                this._setQueueType(ref, out, 1, idx);
            } else if (type === 2) {
                // === DECORATION === (world xy + facing stashed at collect when present)
                let decoWorldX;
                let decoWorldY;
                let decoRotCos;
                let decoRotSin;
                if (stashPx) {
                    decoWorldX = stashPx[i];
                    decoWorldY = stashPy[i];
                    decoRotCos = stashRc[i];
                    decoRotSin = stashRs[i];
                } else {
                    this._decorationWorldXY(idx, stashPose);
                    decoWorldX = stashPose.x;
                    decoWorldY = stashPose.y;
                    decoRotCos = decoRotC[idx];
                    decoRotSin = decoRotS[idx];
                }
                rqX[out] = decoWorldX;
                rqY[out] = decoWorldY;
                rqScaleX[out] = decoScaleX[idx];
                rqScaleY[out] = decoScaleY[idx];
                rqRotC[out] = decoRotCos;
                rqRotS[out] = decoRotSin;
                rqAlpha[out] = decoAlpha[idx] * this._decorationZoomAlpha;
                rqTint[out] = decoTint[idx];
                const dAnimIdx = decoTextureId[idx];
                rqTextureId[out] = this._resolveAnimFrameStart(dAnimIdx, `decoration:${dAnimIdx}`);
                rqAnchorX[out] = decoAnchorX[idx];
                rqAnchorY[out] = decoAnchorY[idx];
                this._setQueueType(ref, out, 2, idx);
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
                    rqTextureId[out] = this._resolveAnimFrameStart(bAnimIdx, `bullet:${bAnimIdx}`);
                    rqAnchorX[out] = bulletAnchorX[idx];
                    rqAnchorY[out] = bulletAnchorY[idx];
                }
                this._setQueueType(ref, out, 4, idx);
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
                this._setQueueType(ref, out, 5, idx);
            } else {
                // === LIGHT GLOW (type=3) ===
                const scale = lightGlowScale(sqrtLightIntensity[idx]);
                // hasGlowSprite 0.5 → /50000; 1 → /25000
                const glowAlpha = lightIntensity[idx] * glowSprite[idx] * (1 / 25000);

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
                if (this._lightGlowAsSprite && rqAlpha[out] > 0) rqAlpha[out] *= this._glowLayerAlpha;
                this._setQueueType(ref, out, 3, idx);
            }
        }

        if (detail) this.emitTimeThisFrame = performance.now() - tEmit;
        if (source.persist && !persistHit) {
            this._rememberType0Set(persistBuf, count, collectorType, collectorIndex);
        }
        return writeCount;
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
                    null,
                    null,
                    null,
                    null,
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
        v.shadowH = this.renderQueueShadowH;
        v.shadowOffX = this.renderQueueShadowOffX;
        v.shadowOffY = this.renderQueueShadowOffY;
        v.type = this.renderQueueType;
        return this._gpuSoAFromViews(v);
    }

    _sortKeyBits(sk) {
        if (!sk) return null;
        if (
            this._sortKeyU32View &&
            this._sortKeyU32View.buffer === sk.buffer &&
            this._sortKeyU32View.byteOffset === sk.byteOffset
        ) {
            return this._sortKeyU32View;
        }
        this._sortKeyU32View = new Uint32Array(sk.buffer, sk.byteOffset, sk.length);
        return this._sortKeyU32View;
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
        const viewW = this.canvasWidth / (zoom > 0 ? zoom : 1);
        const viewH = this.canvasHeight / (zoom > 0 ? zoom : 1);
        const viewRight = camX + viewW;
        const viewBottom = camY + viewH;
        const cx = camX + viewW * 0.5;
        const cy = camY + viewH * 0.5;
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
                x + influence < camX ||
                x - influence > viewRight ||
                y + influence < camY ||
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
        if (!this._stampLightCmp) {
            this._stampLightCmp = (a, b) => a.distSq - b.distSq || a.id - b.id;
        }
        // Cookie pack needs the list; dist-order is only for stamping casters.
        if (this._stampSortLights) this._sortPrefix(out, n, this._stampLightCmp);
    }

    _sortPrefix(arr, count, compare) {
        const n = count | 0;
        if (n <= 1) return;
        // takeClosest keep: native sort, not insertion. Prefix copy keeps pooled slots.
        if (n === arr.length) {
            arr.sort(compare);
            return;
        }
        const tmp = this._sortPrefixTmp || (this._sortPrefixTmp = []);
        tmp.length = n;
        for (let i = 0; i < n; i++) tmp[i] = arr[i];
        tmp.sort(compare);
        for (let i = 0; i < n; i++) arr[i] = tmp[i];
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
                ? packInstancedRows(q, sctx, dst.sun, dst.sunU32, GPU_CASTER_FLOATS, caps.maxSun, true)
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
        this._collectStampLights();
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

        return stampLightRange(spec);
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
            ? packInstancedRows(cq, cctx, dst.cookie, dst.cookieU32, GPU_SPRITE_FLOATS, caps.maxCookie, false)
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
            return res;
        }
        const sunN = this._packGpuSun(dst, q);
        const stamp = this._stampAgainstSun(dst, dst.sun, sunN, 0, 0, 1);
        const cookie = this._packGpuCookies(dst);
        res.sun = sunN;
        res.stamp = stamp;
        res.cookie = cookie;
        return res;
    }

    _allowGpuPainter() {
        return this._packGpuSpritesOn === PACK_GPU_SPRITES_PRERENDER
            && this._sortSprites === SORT_SPRITES_PRERENDER;
    }

    _bindGpuPackWriters() {
        if (this._gpuPackSpec) return;
        this._addPackSortMs = (ms) => { this.sortTimeThisFrame += ms; };
        this._writePackedSprites = (opts) => {
            const q = this._packQ;
            const dst = this._packDst;
            const cap = this.gpuQueueCaps.maxSprites;
            const ctx = makePackContext(q, opts, cap, this._gpuPackCtx);
            const n = ctx
                ? packInstancedRows(q, ctx, dst.sprites, dst.spritesU32, GPU_SPRITE_FLOATS, cap, false)
                : 0;
            this._packParticles = ctx ? (ctx.particleCount | 0) : 0;
            return n;
        };
        this._writePackedGlow = (opts) => {
            const q = this._packQ;
            const dst = this._packDst;
            const cap = this.gpuQueueCaps.maxGlow;
            const ctx = makePackContext(q, opts, cap, this._gpuPackCtx);
            return ctx
                ? packInstancedRows(q, ctx, dst.glow, dst.glowU32, GPU_SPRITE_FLOATS, cap, false)
                : 0;
        };
        this._gpuPackSpec = {
            fillAll: true,
            sortedFlag: GPU_FLAG_SORTED,
            writeSprites: this._writePackedSprites,
            writeGlow: this._writePackedGlow,
        };
    }

    _packGpuSprites(dst, q, allowPainter) {
        const caps = this.gpuQueueCaps;
        const opts = this._gpuPackOpts;
        this._resetGpuPackOpts(opts);
        const count = q.count | 0;
        const res = this._gpuSpritesResult || (this._gpuSpritesResult = { sprite: 0, glow: 0, particle: 0, flags: 0 });
        if (this._packGpuSpritesOn !== PACK_GPU_SPRITES_PRERENDER || count <= 0 || !caps) {
            res.sprite = 0;
            res.glow = 0;
            res.particle = 0;
            res.flags = 0;
            return res;
        }
        this._bindGpuPackWriters();
        const typeArr = this.renderQueueType;
        const allowSort = !!(allowPainter && this._gpuPainter && q.sortKey);
        this._packDst = dst;
        this._packQ = q;
        this._packParticles = 0;
        const spec = this._gpuPackSpec;
        spec.count = count;
        spec.type = typeArr;
        spec.opts = opts;
        spec.splitGlow = !!(this._lightGlowAsSprite === false && typeArr && this._gpuIdxEntity);
        spec.idxEntity = this._gpuIdxEntity;
        spec.idxGlow = this._gpuIdxGlow;
        spec.painter = allowSort ? this._gpuPainter : null;
        spec.keysU32 = allowSort ? this._sortKeyBits(q.sortKey) : null;
        spec.addSortMs = this.collectDetailedStats ? this._addPackSortMs : null;
        spec.glowCapacity = caps.maxGlow | 0;
        const packed = packSpriteLayer(spec);
        res.sprite = packed.sprite;
        res.glow = packed.glow;
        res.particle = this._packParticles | 0;
        res.flags = packed.flags;
        return res;
    }

    _packGpuQueues(dst) {
        if (!dst || !this.gpuQueueCaps) return;
        clearGpuQueueHeader(dst.header);
        const q = this._gpuSoAFromBound();
        if ((this._emitWriteCount | 0) > (q.count | 0)) q.count = this._emitWriteCount | 0;
        const sprites = this._packGpuSprites(dst, q, this._allowGpuPainter());
        const shadows = this._packGpuShadows(dst, q);
        const counts = this._gpuCounts || (this._gpuCounts = {});
        counts.sprite = sprites.sprite | 0;
        counts.glow = sprites.glow | 0;
        counts.particle = sprites.particle | 0;
        counts.sun = shadows.sun | 0;
        counts.stamp = shadows.stamp | 0;
        counts.cookie = shadows.cookie | 0;
        counts.flags = sprites.flags | 0;
        writeGpuQueueHeader(dst.header, counts, counts.flags);
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
                    zoom, camX, camY, this.canvasWidth, this.canvasHeight, this.cullingRatio, this._cameraBounds
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
                    if (occluderBlock && !(occluderBlock[nIdx] > 0)) continue;

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
                        let texId = entityLastTextureId ? entityLastTextureId[nIdx] : INVALID_TEXTURE_ID;
                        if (texId === INVALID_TEXTURE_ID) {
                            texId = this._resolveEntitySpriteTextureId(nIdx);
                        }
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
        this.stats[PRE_RENDER_STATS.VISIBLE_ENTITIES] = this.visibleEntitiesCount;
        if (!this.collectDetailedStats) return;
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
        this.stats[PRE_RENDER_STATS.WAIT_MS] = this.waitTimeThisFrame;
    }
}

// Create singleton instance
self.preRenderWorker = new PreRenderWorker(self);
