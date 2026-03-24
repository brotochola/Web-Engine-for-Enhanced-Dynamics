// pre_render_worker.js - Pre-render worker for visibility, animation and render queue building
// Handles all visual calculations AFTER physics, BEFORE pixi_worker renders
// This worker is purely visual - no physics or game logic

import { ParticleComponent } from '../components/ParticleComponent.js';
import { DecorationComponent } from '../components/DecorationComponent.js';
import { BulletComponent } from '../components/BulletComponent.js';
import { Transform } from '../components/Transform.js';
import { Collider } from '../components/Collider.js';
import { LightEmitter } from '../components/LightEmitter.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { ShadowCaster } from '../components/ShadowCaster.js';
import { FlashComponent } from '../components/FlashComponent.js';
import { LightOccluder } from '../components/LightOccluder.js';
import { AbstractWorker } from './AbstractWorker.js';
import { buildVisibilityPolygon } from './visibility/AngularSweep.js';
import { Grid } from '../core/Grid.js';
import { Sun } from '../core/Sun.js';
import {
    calculateCameraScreenBounds,
    screenBoundsToWorldBounds,
    generateSymmetricalCirclePattern,
} from '../core/utils.js';
import { PRE_RENDER_STATS, createStatsWriter } from './workers-utils.js';
import { RENDERER_DEFAULTS, CAMERA_TYPES } from '../core/ConfigDefaults.js';
import { Layer } from '../core/Layer.js';
import { createViews as createRenderQueueViews } from '../core/RenderQueueLayout.js';

const INVALID_TEXTURE_ID = 0xFFFF;

/**
 * PreRenderWorker - Handles all visual pre-calculations before rendering
 *
 * Responsibilities:
 * 1. Screen visibility for entities, particles, and decorations
 * 2. Animation frame advancement for entities
 * 3. Building main render queue (Y-sorted, interpolated)
 * 4. Building shadow render queue (light gradients + shadow sprites)
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

        // Entity and particle counts
        this.globalEntityCount = 0;
        this.maxParticles = 0;
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
        // pixi_worker never waits; pre_render_worker waits if >1 frame ahead
        this.renderQueueEnabled = false;
        this.renderQueueMaxItems = 0;

        // Double buffer storage - each buffer has its own typed array views
        // Index 0 = buffer A, Index 1 = buffer B
        this.renderQueueBuffers = [null, null];
        this.renderQueueCameraBuffers = [null, null];

        // Sync buffer for coordination: [readyFrame, consumedFrame]
        this.renderQueueSync = null;
        this.renderQueueFrame = 0; // Current frame counter (increments each update)

        // Current write buffer reference (set each frame based on frame counter)
        this.renderQueueCount = null;
        this.renderQueueX = null;
        this.renderQueueY = null;
        this.renderQueueScaleX = null;
        this.renderQueueScaleY = null;
        this.renderQueueRotation = null;
        this.renderQueueAlpha = null;
        this.renderQueueTint = null;
        this.renderQueueTextureId = null;
        this.renderQueueAnchorX = null;
        this.renderQueueAnchorY = null;
        this.renderQueueType = null;
        this.renderQueueEntityIndex = null;
        this.renderQueueCamera = null;
        this._frameCameraZoom = 1;
        this._frameCameraX = 0;
        this._frameCameraY = 0;

        // Entity texture lookup buffer
        this.entityLastTextureId = null;

        // Animation frame tracking
        this.entityFrameIndex = null;
        this.entityFrameAccumulator = null;

        // Texture metadata
        this.animationFrameStart = null;
        this.animationFrameCount = null;
        this.proxyToGlobalAnim = null;
        this.animationNameToIndex = null;

        // Renderable collector (struct-of-arrays for better cache locality)
        this._renderableY = null;
        this._renderableType = null;
        this._renderableIndex = null;
        this._renderableCount = 0;

        // Pre-allocated query arrays
        this._queryLightEmitter = null;
        this._queryShadowCaster = null;
        this._querySpriteRenderer = null;

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
        this.shadowRenderQueueRotation = null;
        this.shadowRenderQueueAlpha = null;
        this.shadowRenderQueueTint = null;
        this.shadowRenderQueueTextureId = null;
        this.shadowRenderQueueAnchorX = null;
        this.shadowRenderQueueAnchorY = null;

        // Per-entity shadow count tracking
        this._entityShadowCounts = null;

        // GC OPTIMIZATION: Pre-allocated buffer for Y-sorted light indices
        this._sortedLightEntities = [];
        this._lightYComparator = (a, b) => Transform.y[a] - Transform.y[b];

        // Stats tracking
        this.shadowsUpdatedThisFrame = 0;
        this.visibleEntitiesCount = 0;
        this.visibleParticlesCount = 0;
        this.visibleDecorationsCount = 0;

        // ========================================
        // SUN / DIRECTIONAL LIGHT
        // ========================================
        // Sun provides parallel shadows (all shadows same direction)
        // and modulates point light shadow visibility (uses static Sun class)
        this.sunEnabled = false;

        // Sun shadow values are now computed centrally in Sun class
        // Workers just read: Sun.shadowDirX, Sun.shadowDirY, Sun.shadowLengthRatio, Sun.shadowAngle
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

        // Configure noLimitFPS from preRender config
        // (AbstractWorker uses lowercase class name, but config uses camelCase 'preRender')
        const preRenderConfig = this.config.preRender || {};
        if (preRenderConfig.noLimitFPS === true) {
            this.noLimitFPS = true;
            console.log('[PRE_RENDER WORKER] Running in unlimited FPS mode');
        }

        // Store counts
        this.globalEntityCount = data.globalEntityCount || 0;
        this.maxParticles = data.maxParticles || 0;
        this.maxDecorations = data.maxDecorations || 0;
        this.maxBullets = data.maxBullets || 0;

        // Particle camera view (from PARTICLE_DEFAULTS)
        const particleConfig = this.config.particle || {};
        this.particleCameraView = particleConfig.cameraView ?? CAMERA_TYPES.TOPDOWN;
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
                this.renderQueueCameraBuffers[bufIdx] = cameraSABs[bufIdx]
                    ? new Float32Array(cameraSABs[bufIdx], 0, 3)
                    : null;
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

            // Pre-allocate query arrays
            this._queryLightEmitter = [LightEmitter];
            this._queryShadowCaster = [ShadowCaster];
            this._querySpriteRenderer = [SpriteRenderer];

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

                buffer.rotation = new Float32Array(sab, offset, maxItems);
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
        // Shadow values are precomputed in Sun.setTimeOfDay() on main thread
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
                    data: new DataView(sab),
                };
            }
            this._vpWriteBuffer = this._vpBuffers[0];

            // Scratch arrays for collecting nearby occluder circles
            const maxOccluders = 256;
            this._vpCircleX = new Float32Array(maxOccluders);
            this._vpCircleY = new Float32Array(maxOccluders);
            this._vpCircleR = new Float32Array(maxOccluders);
            this._vpCircleOpacity = new Float32Array(maxOccluders);
            this._vpMaxOccluders = maxOccluders;

            // Output scratch for polygon vertices
            this._vpOutX = new Float32Array(maxVerts);
            this._vpOutY = new Float32Array(maxVerts);

            console.log(`[PRE_RENDER WORKER] Visibility polygons initialized (max ${maxLts} lights, ${maxVerts} verts/polygon)`);
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
        this.renderQueueRotation = buffer.rotation;
        this.renderQueueAlpha = buffer.alpha;
        this.renderQueueTint = buffer.tint;
        this.renderQueueTextureId = buffer.textureId;
        this.renderQueueAnchorX = buffer.anchorX;
        this.renderQueueAnchorY = buffer.anchorY;
        this.renderQueueType = buffer.type;
        this.renderQueueEntityIndex = buffer.entityIndex;
        this.renderQueueCamera = this.renderQueueCameraBuffers[bufferIdx];

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
        this.shadowRenderQueueRotation = buffer.rotation;
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
        // ========================================
        // DOUBLE BUFFER SYNC: Wait if needed
        // ========================================
        // Only wait if we're more than 1 frame ahead of pixi_worker
        // This prevents overwriting a buffer pixi hasn't consumed yet
        // pixi_worker NEVER waits - it always reads the latest available frame
        if (this.renderQueueSync && this.renderQueueFrame > 0) {
            const consumedFrame = Atomics.load(this.renderQueueSync, 1);
            // If we're about to write to a buffer pixi hasn't read yet, wait
            // (this only happens if pre_render is >1 frame ahead)
            if (this.renderQueueFrame > consumedFrame + 1) {
                // Wait for pixi to consume at least one more frame
                // Timeout after 16ms to avoid deadlock (just skip sync if timeout)
                Atomics.wait(this.renderQueueSync, 1, consumedFrame, 16);
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
            }
        }

        // Latch camera once per pre-render frame to keep all culling and queue writes coherent.
        if (this.cameraData) {
            this._frameCameraZoom = this.cameraData[0];
            this._frameCameraX = this.cameraData[1];
            this._frameCameraY = this.cameraData[2];

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

        // Compute decoration zoom alpha (fully visible above fadeStart, fades to 0 at hideZoom)
        const zoom = this._frameCameraZoom;
        if (zoom >= this.decorationFadeStartZoom) {
            this._decorationZoomAlpha = 1;
        } else if (zoom <= this.decorationHideZoom) {
            this._decorationZoomAlpha = 0;
        } else {
            this._decorationZoomAlpha = (zoom - this.decorationHideZoom) / (this.decorationFadeStartZoom - this.decorationHideZoom);
        }

        // Collect visible renderables for render queue (entities + sun shadows fused in one pass)
        this.collectVisibleParticles();
        this.collectVisibleEntities();
        this.collectVisibleDecorations();
        this.collectVisibleBullets();

        // Build the final render queue (sorts by Y, applies interpolation, writes to SAB)
        this.buildRenderQueue(deltaTime);

        // Build custom layer render queues (entities routed by SpriteRenderer.layerId)
        this.buildCustomLayerQueues(deltaTime);

        // Build shadow render queue (sun shadows already done in collectVisibleEntities)
        this.buildShadowRenderQueue();

        // Build visibility polygons for raycasted light occlusion
        this.buildVisibilityPolygons();

        // ========================================
        // SIGNAL FRAME READY
        // ========================================
        // Increment frame counter and notify pixi_worker
        if (this.renderQueueSync) {
            this.renderQueueFrame++;
            Atomics.store(this.renderQueueSync, 0, this.renderQueueFrame);
            // Wake pixi_worker if it was waiting (it shouldn't be, but just in case)
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
        const y = ParticleComponent.y;
        const z = ParticleComponent.z;
        const isZenithal = this.particleCameraView === CAMERA_TYPES.ZENITHAL;

        for (let idx = 0; idx < visibleCount; idx++) {
            const i = visibleData[1 + idx];
            const sortKey = isZenithal ? -z[i] : y[i];
            this.collectRenderable(1, i, sortKey);
            this.visibleParticlesCount++;
        }
    }

    /**
     * Entity visibility + collect for render queue + sun shadows (fused pass)
     * Iterates activeEntitiesData (or all entities), viewport culling, sets isItOnScreen/screenX/screenY,
     * adds visible to queue. When shadows enabled, also writes sun shadows in same pass.
     */
    collectVisibleEntities() {
        if (this.globalEntityCount === 0 || !SpriteRenderer.isItOnScreen || !this.cameraData) return;

        const cameraBounds = this.calculateCameraBounds();
        if (!cameraBounds) return;

        const x = Transform.x;
        const y = Transform.y;
        const active = Transform.active;
        const isItOnScreen = SpriteRenderer.isItOnScreen;
        const screenX = SpriteRenderer.screenX;
        const screenY = SpriteRenderer.screenY;
        const spriteRendererActive = SpriteRenderer.active;
        const renderVisible = SpriteRenderer.renderVisible;
        const lightEmitterActive = LightEmitter.active;
        const hasGlowSprite = LightEmitter.hasGlowSprite;
        const lightIntensity = LightEmitter.lightIntensity;
        const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;
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

        // Iteration source: queryActiveEntities([SpriteRenderer]) for only sprite entities, else fallback
        let iterCount, getEntityIdx;
        const spriteEntities = this.queryActiveEntities(this._querySpriteRenderer || [SpriteRenderer]);
        if (spriteEntities && spriteEntities.length > 0) {
            iterCount = spriteEntities.length;
            getEntityIdx = (idx) => spriteEntities[idx];
        } else if (this.activeEntitiesData && this.activeEntitiesData[0] > 0) {
            const activeData = this.activeEntitiesData;
            iterCount = activeData[0];
            getEntityIdx = (idx) => activeData[1 + idx];
        } else {
            iterCount = this.globalEntityCount;
            getEntityIdx = (idx) => idx;
        }

        // Sun shadows (fused): write during same pass when enabled
        let sunShadowWriteIdx = 0;
        let sunShadowCount = 0;
        const doSunShadows = this.shadowsEnabled &&
            Sun.isInitialized && Sun.enabled && Sun.intensity > 0.1 &&
            this.shadowRenderQueueX && this.maxShadowRenderItems > 0 &&
            ShadowCaster.active;
        let rqX, rqY, rqScaleX, rqScaleY, rqRotation, rqAlpha, rqTint, rqTextureId, rqAnchorX, rqAnchorY;
        let viewMinX, viewMaxX, viewMinY, viewMaxY;
        let sunShadowRotation, sunShadowAlpha;
        let shadowCasterActive, shadowHeightMultiplier, shadowAnchorOffsetX, shadowAnchorOffsetY;
        let worldX, worldY, transformActive, spriteScaleY, spriteAnchorX, spriteAnchorY;
        let entityShadowCounts, toClear, maxShadowsPerEntity;
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
            sunShadowRotation = Sun.shadowAngle - 1.5707963267948966;
            rqX = this.shadowRenderQueueX;
            rqY = this.shadowRenderQueueY;
            rqScaleX = this.shadowRenderQueueScaleX;
            rqScaleY = this.shadowRenderQueueScaleY;
            rqRotation = this.shadowRenderQueueRotation;
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
            maxShadowsPerEntity = this.maxShadowsPerEntity ?? 0;
            // Clear entityShadowCounts for entities from previous frame
            const prevToClearCount = this._entityShadowIndicesToClearCount ?? 0;
            if (maxShadowsPerEntity > 0 && entityShadowCounts && toClear) {
                for (let k = 0; k < prevToClearCount; k++) entityShadowCounts[toClear[k]] = 0;
            }
            this._entityShadowIndicesToClearCount = 0;
        }

        const maxItems = this.maxShadowRenderItems ?? 0;
        const maxShadowSprites = this.maxShadowSprites ?? 0;

        for (let idx = 0; idx < iterCount; idx++) {
            const i = getEntityIdx(idx);
            if (!active[i]) {
                if (isItOnScreen[i] !== 0) isItOnScreen[i] = 0;
                continue;
            }
            if (!spriteRendererActive || !spriteRendererActive[i]) continue;

            const sx = x[i] * camZoom - cameraOffsetX;
            const sy = y[i] * camZoom - cameraOffsetY;
            screenX[i] = sx;
            screenY[i] = sy;

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
            isItOnScreen[i] = 1;

            if (renderVisible[i]) {
                this.collectRenderable(0, i, y[i]);
                this.visibleEntitiesCount++;
            }
            if (
                lightEmitterActive &&
                lightEmitterActive[i] &&
                hasGlowSprite[i] &&
                lightIntensity[i] >= MIN_GLOW_INTENSITY &&
                (visualRange[i] || sqrtLightIntensity[i] || 200) >= MIN_GLOW_RANGE
            ) {
                this.collectRenderable(3, i, y[i] + 10);
            }

            // Sun shadows (fused)
            if (doSunShadows && sunShadowWriteIdx < maxItems && sunShadowCount < maxShadowSprites) {
                if (shadowCasterActive[i] && transformActive[i]) {
                    const heightMult = shadowHeightMultiplier[i];
                    if (heightMult > 0 && (maxShadowsPerEntity <= 0 || (entityShadowCounts[i] ?? 0) < maxShadowsPerEntity)) {
                        const casterX = worldX[i];
                        const casterY = worldY[i];
                        const textureId = this.entityLastTextureId ? this.entityLastTextureId[i] : INVALID_TEXTURE_ID;
                        if (textureId === INVALID_TEXTURE_ID) continue;
                        const entityScaleY = Math.abs(spriteScaleY[i]) || 1;
                        const anchorX = spriteAnchorX[i] ?? 0.5;
                        const anchorY = spriteAnchorY[i] ?? 0.95;
                        const lengthScale = -entityScaleY * heightMult * Sun.shadowLengthRatio;
                        const originalHeight = this.frameHeight ? this.frameHeight[textureId] : 50;
                        const shadowExtent = Math.abs(lengthScale) * originalHeight + 100;
                        if (!(casterX + shadowExtent < viewMinX || casterX - shadowExtent > viewMaxX ||
                            casterY + shadowExtent < viewMinY || casterY - shadowExtent > viewMaxY)) {
                            rqX[sunShadowWriteIdx] = casterX;
                            rqY[sunShadowWriteIdx] = casterY;
                            rqScaleX[sunShadowWriteIdx] = 1;
                            rqScaleY[sunShadowWriteIdx] = lengthScale;
                            rqRotation[sunShadowWriteIdx] = sunShadowRotation;
                            rqAlpha[sunShadowWriteIdx] = sunShadowAlpha;
                            rqTint[sunShadowWriteIdx] = 0x000000;
                            rqTextureId[sunShadowWriteIdx] = textureId;
                            rqAnchorX[sunShadowWriteIdx] = anchorX + (shadowAnchorOffsetX[i] || 0);
                            rqAnchorY[sunShadowWriteIdx] = anchorY + (shadowAnchorOffsetY[i] || 0);
                            sunShadowWriteIdx++;
                            sunShadowCount++;
                            if (maxShadowsPerEntity > 0 && entityShadowCounts && toClear) {
                                entityShadowCounts[i] = (entityShadowCounts[i] ?? 0) + 1;
                                toClear[this._entityShadowIndicesToClearCount++] = i;
                            }
                        }
                    }
                }
            }
        }

        if (doSunShadows) {
            this._sunShadowWriteIdx = sunShadowWriteIdx;
            this._sunShadowCount = sunShadowCount;
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

        for (let idx = 0; idx < visibleCount; idx++) {
            const i = visibleData[1 + idx];
            this.collectRenderable(2, i, y[i]);
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
            this.collectRenderable(4, i, y[i]);
            if (trailWidth[i] > 0) {
                this.collectRenderable(5, i, y[i] - 0.01);
            }
        }
    }

    /**
     * Collect a visible renderable for the render queue.
     * Any renderable with a non-default layerId is routed to that layer's
     * dedicated collector; everything else goes into the default ENTITIES queue.
     *
     * Layer routing by type:
     *   type 0 (entity)       -> SpriteRenderer.layerId[index]
     *   type 1 (particle)     -> ParticleComponent.layerId[index]
     *   type 2 (decoration)   -> DecorationComponent.layerId[index]
     *   type 3 (light glow)   -> LightEmitter.layerIdOfGlowSprite[index] || SpriteRenderer.layerId[index]
     *   type 4 (bullet)       -> BulletComponent.layerId[index]
     *   type 5 (bullet trail) -> BulletComponent.layerId[index]
     *
     * @param {number} type - Renderable type (0-5)
     * @param {number} index - Pool index into the corresponding component arrays
     * @param {number} y - Sort key (world Y or -Z for zenithal particles)
     */
    collectRenderable(type, index, y) {
        if (!this.renderQueueEnabled) return;

        if (this._customLayerCollectors) {
            let layerId = 0;
            if (type === 0) layerId = SpriteRenderer.layerId[index];
            else if (type === 1) layerId = ParticleComponent.layerId[index];
            else if (type === 2) layerId = DecorationComponent.layerId[index];
            else if (type === 3) layerId = LightEmitter.layerIdOfGlowSprite[index] || SpriteRenderer.layerId[index];
            else if (type === 4 || type === 5) layerId = BulletComponent.layerId[index];

            if (layerId !== 0 && layerId !== Layer.ENTITIES_ID) {
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
        }

        // Default ENTITIES layer
        if (this._renderableCount >= this.renderQueueMaxItems) return;
        const writeIdx = this._renderableCount;
        this._renderableY[writeIdx] = y;
        this._renderableType[writeIdx] = type;
        this._renderableIndex[writeIdx] = index;
        this._renderableCount = writeIdx + 1;
    }

    /**
     * In-place heapsort for any renderable collector triplet (Y, type, index).
     * Used by both main ENTITIES queue and custom layer queues.
     */
    _heapsortCollector(count, yArr, typeArr, indexArr) {
        for (let i = (count >> 1) - 1; i >= 0; i--) {
            this._heapifyRenderables(count, i, yArr, typeArr, indexArr);
        }

        for (let i = count - 1; i > 0; i--) {
            const tempY = yArr[0];
            const tempType = typeArr[0];
            const tempIndex = indexArr[0];
            yArr[0] = yArr[i];
            typeArr[0] = typeArr[i];
            indexArr[0] = indexArr[i];
            yArr[i] = tempY;
            typeArr[i] = tempType;
            indexArr[i] = tempIndex;
            this._heapifyRenderables(i, 0, yArr, typeArr, indexArr);
        }
    }

    _heapsortRenderables(count) {
        this._heapsortCollector(count, this._renderableY, this._renderableType, this._renderableIndex);
    }

    _heapifyRenderables(heapSize, i, yArr, typeArr, indexArr) {
        while (true) {
            let largest = i;
            const left = (i << 1) + 1;
            const right = left + 1;

            if (left < heapSize && yArr[left] > yArr[largest]) {
                largest = left;
            }

            if (right < heapSize && yArr[right] > yArr[largest]) {
                largest = right;
            }

            if (largest === i) break;

            const tempY = yArr[i];
            const tempType = typeArr[i];
            const tempIndex = indexArr[i];
            yArr[i] = yArr[largest];
            typeArr[i] = typeArr[largest];
            indexArr[i] = indexArr[largest];
            yArr[largest] = tempY;
            typeArr[largest] = tempType;
            indexArr[largest] = tempIndex;
            i = largest;
        }
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

        const entitiesLayer = Layer.getById(Layer.ENTITIES_ID);
        const shouldSortByY = entitiesLayer ? entitiesLayer.ySorting : true;

        // Sort by Y (ENTITIES layer policy)
        if (shouldSortByY && count > 1) {
            if (count > 256) {
                this._heapsortRenderables(count);
            } else {
                for (let i = 1; i < count; i++) {
                    const currentY = collectorY[i];
                    const currentType = collectorType[i];
                    const currentIndex = collectorIndex[i];
                    let j = i - 1;
                    while (j >= 0 && collectorY[j] > currentY) {
                        collectorY[j + 1] = collectorY[j];
                        collectorType[j + 1] = collectorType[j];
                        collectorIndex[j + 1] = collectorIndex[j];
                        j--;
                    }
                    collectorY[j + 1] = currentY;
                    collectorType[j + 1] = currentType;
                    collectorIndex[j + 1] = currentIndex;
                }
            }
        }

        // Cache output arrays
        const rqX = this.renderQueueX;
        const rqY = this.renderQueueY;
        const rqScaleX = this.renderQueueScaleX;
        const rqScaleY = this.renderQueueScaleY;
        const rqRotation = this.renderQueueRotation;
        const rqAlpha = this.renderQueueAlpha;
        const rqTint = this.renderQueueTint;
        const rqTextureId = this.renderQueueTextureId;
        const rqAnchorX = this.renderQueueAnchorX;
        const rqAnchorY = this.renderQueueAnchorY;
        const rqType = this.renderQueueType;
        const rqEntityIndex = this.renderQueueEntityIndex;
        const entityLastTextureId = this.entityLastTextureId;

        // Cache component arrays
        const entityX = Transform.x;
        const entityY = Transform.y;
        const entityRotation = Transform.rotation;

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

        const particleX = ParticleComponent.x;
        const particleY = ParticleComponent.y;
        const particleZ = ParticleComponent.z;
        const particleScaleX = ParticleComponent.scaleX;
        const particleScaleY = ParticleComponent.scaleY;
        const particleRotation = ParticleComponent.rotation;
        const particleAlpha = ParticleComponent.alpha;
        const particleTint = ParticleComponent.tint;
        const particleTextureId = ParticleComponent.textureId;

        const lightColor = LightEmitter.lightColor;
        const lightIntensity = LightEmitter.lightIntensity;
        const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;
        const glowHeightOffset = LightEmitter.glowHeightOffset;
        const visualRange = Collider.visualRange;
        const lightGradientAnimIdx = this.animationNameToIndex?.['_lightGradient'] ?? 0;
        const lightGradientTextureId = this.animationFrameStart?.[lightGradientAnimIdx] ?? 0;
        const GLOW_TEXTURE_RADIUS = 100;

        const decoX = DecorationComponent.x;
        const decoY = DecorationComponent.y;
        const decoOffsetX = DecorationComponent.offsetX;
        const decoOffsetY = DecorationComponent.offsetY;
        const decoScaleX = DecorationComponent.scaleX;
        const decoScaleY = DecorationComponent.scaleY;
        const decoRotation = DecorationComponent.rotation;
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
        const bulletSpriteRotation = BulletComponent.spriteRotation;
        const bulletTrailWidth = BulletComponent.trailWidth;
        const bulletAngle = BulletComponent.bulletAngle;
        const bulletAnchorX = BulletComponent.anchorX;
        const bulletAnchorY = BulletComponent.anchorY;
        const bulletActive = BulletComponent.active;

        const bulletTrailAnimIdx = this.animationNameToIndex?.['_bulletTrail'] ?? 0;
        const bulletTrailTextureId = this.animationFrameStart?.[bulletTrailAnimIdx] ?? 0;
        const BULLET_TRAIL_MIN_LENGTH_SQ = 0.01;

        const frameIndex = this.entityFrameIndex;
        const frameAccum = this.entityFrameAccumulator;
        const deltaSeconds = deltaTime / 1000;

        for (let i = 0; i < count; i++) {
            const type = collectorType[i];
            const idx = collectorIndex[i];

            if (type === 0) {
                // === ENTITY ===
                const currX = entityX[idx];
                const currY = entityY[idx];

                rqX[i] = currX;
                rqY[i] = currY;
                rqScaleX[i] = srScaleX[idx];
                rqScaleY[i] = srScaleY[idx];
                rqRotation[i] = entityRotation[idx];
                rqAlpha[i] = srAlpha[idx];
                rqTint[i] = srTint[idx];
                rqAnchorX[i] = srAnchorX[idx];
                rqAnchorY[i] = srAnchorY[idx];

                rqType[i] = 0;
                rqEntityIndex[i] = idx;

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
                    rqTextureId[i] = globalTextureId;

                    if (entityLastTextureId) {
                        entityLastTextureId[idx] = globalTextureId;
                    }
                } else {
                    rqTextureId[i] = entityLastTextureId ? entityLastTextureId[idx] : INVALID_TEXTURE_ID;
                }
            } else if (type === 1) {
                // === PARTICLE ===
                rqX[i] = particleX[idx];
                if (this.particleCameraView === CAMERA_TYPES.ZENITHAL) {
                    rqY[i] = particleY[idx];
                    const height = -particleZ[idx];
                    const heightFactor = 1 + (height / this.zenithalMaxHeight) * this.zenithalScaleFactor;
                    rqScaleX[i] = particleScaleX[idx] * heightFactor;
                    rqScaleY[i] = particleScaleY[idx] * heightFactor;
                    let a = particleAlpha[idx];
                    if (this.zenithalAlphaFade > 0) {
                        const alphaFade = Math.min(1, (height / this.zenithalMaxHeight) * this.zenithalAlphaFade);
                        a *= Math.max(0, 1 - alphaFade);
                    }
                    rqAlpha[i] = a;
                } else {
                    rqY[i] = particleY[idx] + particleZ[idx];
                    rqScaleX[i] = particleScaleX[idx];
                    rqScaleY[i] = particleScaleY[idx];
                    rqAlpha[i] = particleAlpha[idx];
                }
                rqRotation[i] = particleRotation[idx];
                rqTint[i] = particleTint[idx];
                const pAnimIdx = particleTextureId[idx];
                rqTextureId[i] = this.animationFrameStart?.[pAnimIdx] ?? INVALID_TEXTURE_ID;
                rqAnchorX[i] = 0.5;
                rqAnchorY[i] = 0.5;
                rqType[i] = 1;
                rqEntityIndex[i] = -1;
            } else if (type === 2) {
                // === DECORATION ===
                rqX[i] = decoX[idx] + decoOffsetX[idx];
                rqY[i] = decoY[idx] + decoOffsetY[idx];
                rqScaleX[i] = decoScaleX[idx];
                rqScaleY[i] = decoScaleY[idx];
                rqRotation[i] = decoRotation[idx];
                rqAlpha[i] = decoAlpha[idx] * this._decorationZoomAlpha;
                rqTint[i] = decoTint[idx];
                const dAnimIdx = decoTextureId[idx];
                rqTextureId[i] = this.animationFrameStart?.[dAnimIdx] ?? INVALID_TEXTURE_ID;
                rqAnchorX[i] = decoAnchorX[idx];
                rqAnchorY[i] = decoAnchorY[idx];
                rqType[i] = 2;
                rqEntityIndex[i] = -1;
            } else if (type === 4) {
                // === BULLET ===
                if (!bulletActive[idx]) {
                    rqAlpha[i] = 0;
                    rqScaleX[i] = 0;
                    rqScaleY[i] = 0;
                    rqX[i] = -10000;
                    rqY[i] = -10000;
                } else {
                    rqX[i] = bulletX[idx];
                    rqY[i] = bulletY[idx] + (bulletOffsetY[idx] ?? 0);
                    rqScaleX[i] = bulletScale[idx];
                    rqScaleY[i] = bulletScale[idx];
                    rqRotation[i] = bulletSpriteRotation[idx];
                    rqAlpha[i] = bulletAlpha[idx];
                    rqTint[i] = bulletTint[idx];
                    const bAnimIdx = bulletTextureId[idx];
                    rqTextureId[i] = this.animationFrameStart?.[bAnimIdx] ?? INVALID_TEXTURE_ID;
                    rqAnchorX[i] = bulletAnchorX[idx];
                    rqAnchorY[i] = bulletAnchorY[idx];
                }
                rqType[i] = 4;
                rqEntityIndex[i] = -1;
            } else if (type === 5) {
                // === BULLET TRAIL (line from start to curr, 0-alpha at start) ===
                if (!bulletActive[idx]) {
                    rqAlpha[i] = 0;
                    rqScaleX[i] = 0;
                    rqScaleY[i] = 0;
                    rqX[i] = -10000;
                    rqY[i] = -10000;
                } else {
                    const currX = bulletX[idx];
                    const currY = bulletY[idx] + (bulletOffsetY[idx] ?? 0);
                    const startX = bulletStartX[idx];
                    const startY = bulletStartY[idx] + (bulletOffsetY[idx] ?? 0);
                    const dx = currX - startX;
                    const dy = currY - startY;
                    const lenSq = dx * dx + dy * dy;

                    if (lenSq < BULLET_TRAIL_MIN_LENGTH_SQ) {
                        rqAlpha[i] = 0;
                        rqScaleX[i] = 0;
                        rqScaleY[i] = 0;
                        rqX[i] = -10000;
                        rqY[i] = -10000;
                    } else {
                        const adx = dx < 0 ? -dx : dx;
                        const ady = dy < 0 ? -dy : dy;
                        const max = adx > ady ? adx : ady;
                        const min = adx > ady ? ady : adx;
                        const lengthApprox = 0.96 * max + 0.4 * min;

                        rqX[i] = (startX + currX) * 0.5;
                        rqY[i] = (startY + currY) * 0.5;
                        rqScaleX[i] = lengthApprox / 10;
                        rqScaleY[i] = bulletTrailWidth[idx];
                        rqRotation[i] = bulletAngle[idx];
                        rqAlpha[i] = bulletAlpha[idx] * 0.9;
                        rqTint[i] = 0xffffff;
                    }
                }
                rqTextureId[i] = bulletTrailTextureId;
                rqAnchorX[i] = 0.5;
                rqAnchorY[i] = 0.5;
                rqType[i] = 5;
                rqEntityIndex[i] = -1;
            } else {
                // === LIGHT GLOW (type=3) ===
                // Flash entities have no Collider, so visualRange is 0; fall back to sqrtLightIntensity
                const rangeVal = visualRange[idx] || sqrtLightIntensity[idx] || 200;
                const scale = (rangeVal * 4) / GLOW_TEXTURE_RADIUS;
                const glowAlpha = lightIntensity[idx] / 50000;

                if (scale < 0.1 || glowAlpha < 0.001) {
                    rqAlpha[i] = 0;
                    rqScaleX[i] = 0;
                    rqScaleY[i] = 0;
                    rqX[i] = -10000;
                    rqY[i] = -10000;
                } else {
                    rqX[i] = entityX[idx];
                    rqY[i] = entityY[idx] - (glowHeightOffset[idx] || 0);
                    rqScaleX[i] = scale;
                    rqScaleY[i] = scale;
                    rqAlpha[i] = glowAlpha;
                    rqTint[i] = lightColor[idx];
                }
                rqRotation[i] = 0;
                rqTextureId[i] = lightGradientTextureId;
                rqAnchorX[i] = 0.5;
                rqAnchorY[i] = 0.5;
                rqType[i] = 3;
                rqEntityIndex[i] = idx;
            }
        }

        this.renderQueueCount[0] = count;
        this._renderableCount = 0;
    }

    /**
     * Build render queues for all custom layers.
     * Each custom layer's collector may contain any renderable type (0-5):
     * entities, particles, decorations, light glows, bullets, and bullet trails.
     *
     * Per-type dispatch mirrors the corresponding branches in buildRenderQueue(),
     * writing the same fields (x, y, scaleX, scaleY, rotation, alpha, tint,
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
        const entityRotation = Transform.rotation;
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
        const particleRotation = ParticleComponent.rotation;
        const particleAlpha = ParticleComponent.alpha;
        const particleTint = ParticleComponent.tint;
        const particleTextureId = ParticleComponent.textureId;

        // Decoration arrays
        const decoX = DecorationComponent.x;
        const decoY = DecorationComponent.y;
        const decoOffsetX = DecorationComponent.offsetX;
        const decoOffsetY = DecorationComponent.offsetY;
        const decoScaleX = DecorationComponent.scaleX;
        const decoScaleY = DecorationComponent.scaleY;
        const decoRotation = DecorationComponent.rotation;
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
        const bulletSpriteRotation = BulletComponent.spriteRotation;
        const bulletTrailWidth = BulletComponent.trailWidth;
        const bulletAngle = BulletComponent.bulletAngle;
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
        const visualRange = Collider.visualRange;
        const lightGradientAnimIdx = this.animationNameToIndex?.['_lightGradient'] ?? 0;
        const lightGradientTextureId = this.animationFrameStart?.[lightGradientAnimIdx] ?? 0;
        const GLOW_TEXTURE_RADIUS = 100;

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

            // Y-sort (per-layer policy), same threshold as main ENTITIES queue
            if (collector.ySorting && layerCount > 1) {
                if (layerCount > 256) {
                    this._heapsortCollector(layerCount, cY, cType, cIndex);
                } else {
                    for (let i = 1; i < layerCount; i++) {
                        const currentY = cY[i];
                        const currentType = cType[i];
                        const currentIndex = cIndex[i];
                        let j = i - 1;
                        while (j >= 0 && cY[j] > currentY) {
                            cY[j + 1] = cY[j];
                            cType[j + 1] = cType[j];
                            cIndex[j + 1] = cIndex[j];
                            j--;
                        }
                        cY[j + 1] = currentY;
                        cType[j + 1] = currentType;
                        cIndex[j + 1] = currentIndex;
                    }
                }
            }

            const rqX = ref.x;
            const rqY = ref.y;
            const rqScaleX = ref.scaleX;
            const rqScaleY = ref.scaleY;
            const rqRotation = ref.rotation;
            const rqAlpha = ref.alpha;
            const rqTint = ref.tint;
            const rqTextureId = ref.textureId;
            const rqAnchorX = ref.anchorX;
            const rqAnchorY = ref.anchorY;
            const rqType = ref.type;
            const rqEntityIndex = ref.entityIndex;

            for (let i = 0; i < layerCount; i++) {
                const type = cType[i];
                const idx = cIndex[i];

                if (type === 0) {
                    // === ENTITY ===
                    rqX[i] = entityX[idx];
                    rqY[i] = entityY[idx];
                    rqScaleX[i] = srScaleX[idx];
                    rqScaleY[i] = srScaleY[idx];
                    rqRotation[i] = entityRotation[idx];
                    rqAlpha[i] = srAlpha[idx];
                    rqTint[i] = srTint[idx];
                    rqAnchorX[i] = srAnchorX[idx];
                    rqAnchorY[i] = srAnchorY[idx];
                    rqType[i] = 0;
                    rqEntityIndex[i] = idx;

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
                                if (srLoop[idx] === 1 || !isLastFrame) {
                                    frameIndex[idx] = (currentFrame + 1) % animFrameCount;
                                }
                            }
                        }

                        const animStart = this.animationFrameStart?.[globalAnimIdx] ?? 0;
                        const globalTextureId = animStart + frameIndex[idx];
                        rqTextureId[i] = globalTextureId;
                        if (entityLastTextureId) entityLastTextureId[idx] = globalTextureId;
                    } else {
                        rqTextureId[i] = entityLastTextureId ? entityLastTextureId[idx] : INVALID_TEXTURE_ID;
                    }

                } else if (type === 1) {
                    // === PARTICLE ===
                    rqX[i] = particleX[idx];
                    if (this.particleCameraView === CAMERA_TYPES.ZENITHAL) {
                        rqY[i] = particleY[idx];
                        const height = -particleZ[idx];
                        const heightFactor = 1 + (height / this.zenithalMaxHeight) * this.zenithalScaleFactor;
                        rqScaleX[i] = particleScaleX[idx] * heightFactor;
                        rqScaleY[i] = particleScaleY[idx] * heightFactor;
                        let a = particleAlpha[idx];
                        if (this.zenithalAlphaFade > 0) {
                            const alphaFade = Math.min(1, (height / this.zenithalMaxHeight) * this.zenithalAlphaFade);
                            a *= Math.max(0, 1 - alphaFade);
                        }
                        rqAlpha[i] = a;
                    } else {
                        rqY[i] = particleY[idx] + particleZ[idx];
                        rqScaleX[i] = particleScaleX[idx];
                        rqScaleY[i] = particleScaleY[idx];
                        rqAlpha[i] = particleAlpha[idx];
                    }
                    rqRotation[i] = particleRotation[idx];
                    rqTint[i] = particleTint[idx];
                    const pAnimIdx = particleTextureId[idx];
                    rqTextureId[i] = this.animationFrameStart?.[pAnimIdx] ?? INVALID_TEXTURE_ID;
                    rqAnchorX[i] = 0.5;
                    rqAnchorY[i] = 0.5;
                    rqType[i] = 1;
                    rqEntityIndex[i] = -1;

                } else if (type === 2) {
                    // === DECORATION ===
                    rqX[i] = decoX[idx] + decoOffsetX[idx];
                    rqY[i] = decoY[idx] + decoOffsetY[idx];
                    rqScaleX[i] = decoScaleX[idx];
                    rqScaleY[i] = decoScaleY[idx];
                    rqRotation[i] = decoRotation[idx];
                    rqAlpha[i] = decoAlpha[idx] * this._decorationZoomAlpha;
                    rqTint[i] = decoTint[idx];
                    const dAnimIdx = decoTextureId[idx];
                    rqTextureId[i] = this.animationFrameStart?.[dAnimIdx] ?? INVALID_TEXTURE_ID;
                    rqAnchorX[i] = decoAnchorX[idx];
                    rqAnchorY[i] = decoAnchorY[idx];
                    rqType[i] = 2;
                    rqEntityIndex[i] = -1;

                } else if (type === 3) {
                    // === LIGHT GLOW ===
                    const rangeVal = visualRange[idx] || sqrtLightIntensity[idx] || 200;
                    const scale = (rangeVal * 4) / GLOW_TEXTURE_RADIUS;
                    const glowAlpha = lightIntensity[idx] / 50000;

                    if (scale < 0.1 || glowAlpha < 0.001) {
                        rqAlpha[i] = 0;
                        rqScaleX[i] = 0;
                        rqScaleY[i] = 0;
                        rqX[i] = -10000;
                        rqY[i] = -10000;
                    } else {
                        rqX[i] = entityX[idx];
                        rqY[i] = entityY[idx] - (glowHeightOffset[idx] || 0);
                        rqScaleX[i] = scale;
                        rqScaleY[i] = scale;
                        rqAlpha[i] = glowAlpha;
                        rqTint[i] = lightColor[idx];
                    }
                    rqRotation[i] = 0;
                    rqTextureId[i] = lightGradientTextureId;
                    rqAnchorX[i] = 0.5;
                    rqAnchorY[i] = 0.5;
                    rqType[i] = 3;
                    rqEntityIndex[i] = idx;

                } else if (type === 4) {
                    // === BULLET ===
                    if (!bulletActive[idx]) {
                        rqAlpha[i] = 0;
                        rqScaleX[i] = 0;
                        rqScaleY[i] = 0;
                        rqX[i] = -10000;
                        rqY[i] = -10000;
                    } else {
                        rqX[i] = bulletX[idx];
                        rqY[i] = bulletY[idx] + (bulletOffsetY[idx] ?? 0);
                        rqScaleX[i] = bulletScale[idx];
                        rqScaleY[i] = bulletScale[idx];
                        rqRotation[i] = bulletSpriteRotation[idx];
                        rqAlpha[i] = bulletAlpha[idx];
                        rqTint[i] = bulletTint[idx];
                        const bAnimIdx = bulletTextureId[idx];
                        rqTextureId[i] = this.animationFrameStart?.[bAnimIdx] ?? INVALID_TEXTURE_ID;
                        rqAnchorX[i] = bulletAnchorX[idx];
                        rqAnchorY[i] = bulletAnchorY[idx];
                    }
                    rqType[i] = 4;
                    rqEntityIndex[i] = -1;

                } else if (type === 5) {
                    // === BULLET TRAIL ===
                    if (!bulletActive[idx]) {
                        rqAlpha[i] = 0;
                        rqScaleX[i] = 0;
                        rqScaleY[i] = 0;
                        rqX[i] = -10000;
                        rqY[i] = -10000;
                    } else {
                        const currX = bulletX[idx];
                        const currY = bulletY[idx] + (bulletOffsetY[idx] ?? 0);
                        const startX = bulletStartX[idx];
                        const startY = bulletStartY[idx] + (bulletOffsetY[idx] ?? 0);
                        const dx = currX - startX;
                        const dy = currY - startY;
                        const lenSq = dx * dx + dy * dy;

                        if (lenSq < BULLET_TRAIL_MIN_LENGTH_SQ) {
                            rqAlpha[i] = 0;
                            rqScaleX[i] = 0;
                            rqScaleY[i] = 0;
                            rqX[i] = -10000;
                            rqY[i] = -10000;
                        } else {
                            const adx = dx < 0 ? -dx : dx;
                            const ady = dy < 0 ? -dy : dy;
                            const max = adx > ady ? adx : ady;
                            const min = adx > ady ? ady : adx;
                            const lengthApprox = 0.96 * max + 0.4 * min;

                            rqX[i] = (startX + currX) * 0.5;
                            rqY[i] = (startY + currY) * 0.5;
                            rqScaleX[i] = lengthApprox / 10;
                            rqScaleY[i] = bulletTrailWidth[idx];
                            rqRotation[i] = bulletAngle[idx];
                            rqAlpha[i] = bulletAlpha[idx] * 0.9;
                            rqTint[i] = 0xffffff;
                        }
                    }
                    rqTextureId[i] = bulletTrailTextureId;
                    rqAnchorX[i] = 0.5;
                    rqAnchorY[i] = 0.5;
                    rqType[i] = 5;
                    rqEntityIndex[i] = -1;
                }
            }

            ref.count[0] = layerCount;
            collector.count = 0;
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
        const lightIntensity = LightEmitter.lightIntensity;
        const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;
        const lightHeight = LightEmitter.height;
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

        // Compute visible lights FIRST -- needed by both shadow system and buildVisibilityPolygons
        const lightEntitiesRaw = this.queryActiveEntities(this._queryLightEmitter);
        const lightEntities = this._sortedLightEntities;
        lightEntities.length = 0;
        for (let i = 0; i < lightEntitiesRaw.length; i++) {
            const lightIdx = lightEntitiesRaw[i];
            if (!lightEnabled[lightIdx]) continue;

            const intensity = lightIntensity[lightIdx];
            if (intensity <= 0) continue;

            const isFlash = flashActive ? flashActive[lightIdx] === 1 : false;
            if (!isFlash) {
                const lightX = worldX[lightIdx];
                const lightY = worldY[lightIdx];
                const lightInfluenceRadius = sqrtLightIntensity[lightIdx] * 10;
                if (lightX + lightInfluenceRadius < viewMinX || lightX - lightInfluenceRadius > viewMaxX ||
                    lightY + lightInfluenceRadius < viewMinY || lightY - lightInfluenceRadius > viewMaxY) {
                    continue;
                }
            }

            lightEntities.push(lightIdx);
        }
        lightEntities.sort(this._lightYComparator);

        if (this.visibleLightsData) {
            const maxWrite = this.visibleLightsData.length - 1;
            const n = Math.min(lightEntities.length, maxWrite);
            this.visibleLightsData[0] = n;
            for (let w = 0; w < n; w++) this.visibleLightsData[1 + w] = lightEntities[w];
        }

        // Shadow-specific: bail if no ShadowCaster entities exist
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
        const rqRotation = this.shadowRenderQueueRotation;
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
        // POINT LIGHT SHADOWS (suppressed when sun is bright)
        // ========================================
        const sunIntensity = Sun.isInitialized && Sun.enabled ? Sun.intensity : 0;
        const pointLightShadowMultiplier = 1 - (sunIntensity * 0.9);
        const pointShadowAlphaScale = 0.33 * pointLightShadowMultiplier;
        const MIN_POINT_SHADOW_ALPHA = 0.003;
        if (pointShadowAlphaScale <= MIN_POINT_SHADOW_ALPHA) {
            this.shadowRenderQueueCount[0] = writeIdx;
            this.shadowsUpdatedThisFrame = shadowCount;
            return;
        }

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

        // Frame-unique dedup tag (avoids clearing the marker array each light)
        let dedupTag = 0;

        for (let i = 0; i < lightEntities.length; i++) {
            if (writeIdx >= maxItems) break;
            if (lightsProcessed >= this.maxShadowCastingLights) break;

            const lightIdx = lightEntities[i];
            const intensity = lightIntensity[lightIdx];
            const lightX = worldX[lightIdx];
            const lightY = worldY[lightIdx];
            const lightH = lightHeight[lightIdx] || 0;
            const maxShadowDistSq = pointShadowAlphaScale > MIN_POINT_SHADOW_ALPHA
                ? intensity * ((pointShadowAlphaScale / MIN_POINT_SHADOW_ALPHA) - 1)
                : 0;

            const isFlash = flashActive ? flashActive[lightIdx] === 1 : false;

            // ── Determine candidate source ────────────────────────────
            let candidateCount;
            let candidateSource;   // typed array holding entity indices
            let candidateOffset;   // first candidate starts at candidateSource[candidateOffset]

            if (isFlash && gridCounts && flashCandidateBuffer && flashDedupMarker) {
                // FLASH PATH: circle pattern (fewer cells than rect, distance-sorted)
                const searchRadius = sqrtLightIntensity[lightIdx] || 100;
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

                        const entityBase = (byteOff >> 2) + 1;
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
            } else {
                // REGULAR LIGHT PATH: use precomputed neighbor data
                const offset = lightIdx * stride;
                candidateCount = neighborData[offset];
                candidateSource = neighborData;
                candidateOffset = offset + 2;
            }

            // ── Process candidates into shadow sprites ────────────────
            const shadowStartIdx = writeIdx + 1;
            let shadowsForThisLight = 0;

            // Flash has no Collider offsets; regular lights may have them
            const lightXWithOffset = isFlash ? lightX : lightX + (colliderOffsetX[lightIdx] || 0);
            const lightYWithOffset = isFlash ? lightY : lightY + (colliderOffsetY[lightIdx] || 0);

            for (let k = 0; k < candidateCount; k++) {
                if (shadowsForThisLight >= this.maxShadowsPerLight) break;
                if (shadowCount >= maxShadowSprites) break;
                if (writeIdx + 1 + shadowsForThisLight >= maxItems) break;

                const neighborIdx = candidateSource[candidateOffset + k];

                if (!shadowCasterActive[neighborIdx] || !transformActive[neighborIdx]) continue;

                const heightMult = shadowHeightMultiplier[neighborIdx];
                if (heightMult <= 0) continue;

                if (maxShadowsPerEntity > 0 && entityShadowCounts[neighborIdx] >= maxShadowsPerEntity) continue;

                const neighborX = worldX[neighborIdx] + (colliderOffsetX[neighborIdx] || 0);
                const neighborY = worldY[neighborIdx] + (colliderOffsetY[neighborIdx] || 0);
                const dx = neighborX - lightXWithOffset;
                const dy = neighborY - lightYWithOffset;
                const distSq = dx * dx + dy * dy;

                if (distSq < 1) continue;
                if (maxShadowDistSq > 0 && distSq > maxShadowDistSq) continue;

                const casterX = worldX[neighborIdx];
                const casterY = worldY[neighborIdx];
                const textureId = entityLastTextureId ? entityLastTextureId[neighborIdx] : INVALID_TEXTURE_ID;
                if (textureId === INVALID_TEXTURE_ID) continue;

                const entityScaleY = Math.abs(spriteScaleY[neighborIdx]) || 1;
                const anchorX = spriteAnchorX[neighborIdx] ?? 0.5;
                const anchorY = spriteAnchorY[neighborIdx] ?? 0.95;

                const dist = Math.sqrt(distSq);

                const distRatio = dist * 0.00390625;
                const clampedDistRatio = distRatio > 1 ? 1 : distRatio;
                const lengthScale = -(0.3 + clampedDistRatio * 0.9) * entityScaleY * heightMult;

                const originalHeight = this.frameHeight ? this.frameHeight[textureId] : 50;
                const shadowExtent = Math.abs(lengthScale) * originalHeight + 100;
                if (casterX + shadowExtent < viewMinX || casterX - shadowExtent > viewMaxX ||
                    casterY + shadowExtent < viewMinY || casterY - shadowExtent > viewMaxY) continue;

                let alpha = intensity / (intensity + distSq);
                if (Number.isNaN(alpha)) alpha = 0;
                if (alpha > 1) alpha = 1;
                if (alpha < 0) alpha = 0;
                alpha *= pointShadowAlphaScale;
                if (alpha < MIN_POINT_SHADOW_ALPHA) continue;

                const angle = Math.atan2(dy, dx);

                const shadowIdx = shadowStartIdx + shadowsForThisLight;
                rqX[shadowIdx] = casterX;
                rqY[shadowIdx] = casterY;
                rqScaleX[shadowIdx] = 1;
                rqScaleY[shadowIdx] = lengthScale;
                const pointShadowRotation = angle - 1.5707963267948966;
                rqRotation[shadowIdx] = pointShadowRotation;
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

            if (shadowsForThisLight > 0) {
                lightsProcessed++;

                const gradientScale = 10 * sqrtLightIntensity[lightIdx] * 3 / 100;
                const gradientAlpha = intensity / 50000;

                rqX[writeIdx] = lightX;
                rqY[writeIdx] = lightY - lightH;
                rqScaleX[writeIdx] = gradientScale;
                rqScaleY[writeIdx] = gradientScale;
                rqRotation[writeIdx] = 0;
                rqAlpha[writeIdx] = gradientAlpha;
                rqTint[writeIdx] = 0xFFFFFF;
                rqTextureId[writeIdx] = lightGradientTextureId;
                rqAnchorX[writeIdx] = 0.5;
                rqAnchorY[writeIdx] = 0.5;

                writeIdx = shadowStartIdx + shadowsForThisLight;
            }
        }

        this.shadowRenderQueueCount[0] = writeIdx;
        this.shadowsUpdatedThisFrame = shadowCount;
    }

    /**
     * Build visibility polygons for all visible lights (raycasted light occlusion).
     * For each light, collects nearby LightOccluder circles, runs Angular Sweep,
     * and writes the resulting polygon vertices to the shared buffer.
     */
    buildVisibilityPolygons() {
        if (!this.visibilityPolygonsEnabled) return;

        const buf = this._vpWriteBuffer;
        if (!buf) { return; }

        const worldX = Transform.x;
        const worldY = Transform.y;
        const transformActive = Transform.active;
        const occluderActive = LightOccluder.active;
        const occluderRadius = LightOccluder.radius;
        const occluderOpacity = LightOccluder.opacity;
        const lightEnabled = LightEmitter.active;
        const lightIntensity = LightEmitter.lightIntensity;
        const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;

        const neighborData = Grid.neighborData;
        const stride = Grid._stride;

        const maxVerts = this._vpMaxVerts;
        const maxLts = this._vpMaxLights;
        const slotBytes = this._vpSlotBytes;
        const cX = this._vpCircleX;
        const cY = this._vpCircleY;
        const cR = this._vpCircleR;
        const cO = this._vpCircleOpacity;
        const maxOccluders = this._vpMaxOccluders;
        const outX = this._vpOutX;
        const outY = this._vpOutY;
        const dv = buf.data;

        // Use the same visible lights list that buildShadowRenderQueue already wrote
        const visibleLights = this.visibleLightsData;
        if (!visibleLights) { buf.header[0] = 0; return; }

        const lightCount = visibleLights[0];
        if (lightCount === 0) { buf.header[0] = 0; return; }

        let lightsWritten = 0;

        for (let li = 0; li < lightCount && lightsWritten < maxLts; li++) {
            const lightIdx = visibleLights[1 + li];
            if (!lightEnabled[lightIdx]) continue;

            const intensity = lightIntensity[lightIdx];
            if (intensity <= 0) continue;

            const lx = worldX[lightIdx];
            const ly = worldY[lightIdx];
            const influenceRadius = sqrtLightIntensity[lightIdx] * 10;

            // Collect nearby occluder circles from neighbor data
            let circleCount = 0;

            if (neighborData && stride > 0) {
                const offset = lightIdx * stride;
                const nCount = neighborData[offset];
                for (let k = 0; k < nCount && circleCount < maxOccluders; k++) {
                    const nIdx = neighborData[offset + 2 + k];
                    if (!transformActive[nIdx] || !occluderActive[nIdx]) continue;
                    const r = occluderRadius[nIdx];
                    if (r <= 0) continue;

                    cX[circleCount] = worldX[nIdx];
                    cY[circleCount] = worldY[nIdx];
                    cR[circleCount] = r;
                    cO[circleCount] = occluderOpacity[nIdx] || 1;
                    circleCount++;
                }
            }

            // Run angular sweep
            const vertCount = buildVisibilityPolygon(
                lx, ly, influenceRadius,
                cX, cY, cR, cO,
                circleCount, outX, outY, maxVerts
            );

            // Write to SAB slot
            // Layout: [lightIdx: Int32, lightX: Float32, lightY: Float32, vertexCount: Int32, x[N]: Float32, y[N]: Float32]
            const baseOffset = 4 + lightsWritten * slotBytes; // 4 bytes header
            dv.setInt32(baseOffset, lightIdx, true);
            dv.setFloat32(baseOffset + 4, lx, true);
            dv.setFloat32(baseOffset + 8, ly, true);
            dv.setInt32(baseOffset + 12, vertCount, true);

            const vertDataOffset = baseOffset + 16;
            for (let v = 0; v < vertCount; v++) {
                dv.setFloat32(vertDataOffset + v * 4, outX[v], true);
            }
            const yOffset = vertDataOffset + maxVerts * 4;
            for (let v = 0; v < vertCount; v++) {
                dv.setFloat32(yOffset + v * 4, outY[v], true);
            }

            lightsWritten++;
        }

        buf.header[0] = lightsWritten;
    }

    /**
     * Override reportFPS to write stats to SharedArrayBuffer
     */
    reportFPS() {
        if (this.stats) {
            this.stats[PRE_RENDER_STATS.FPS] = this.currentFPS;
            this.stats[PRE_RENDER_STATS.VISIBLE_ENTITIES] = this.visibleEntitiesCount;
            this.stats[PRE_RENDER_STATS.VISIBLE_PARTICLES] = this.visibleParticlesCount;
            this.stats[PRE_RENDER_STATS.VISIBLE_DECORATIONS] = this.visibleDecorationsCount;
            this.stats[PRE_RENDER_STATS.SHADOWS_UPDATED] = this.shadowsUpdatedThisFrame;
            this.stats[PRE_RENDER_STATS.RENDER_QUEUE_SIZE] = this.renderQueueCount ? this.renderQueueCount[0] : 0;
            this.stats[PRE_RENDER_STATS.MSG_MS] = this.messageTimeThisFrame;
        }
    }
}

// Create singleton instance
self.preRenderWorker = new PreRenderWorker(self);
