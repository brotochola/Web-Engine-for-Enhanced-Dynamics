// pre_render_worker.js - Pre-render worker for visibility, animation and render queue building
// Handles all visual calculations AFTER physics, BEFORE pixi_worker renders
// This worker is purely visual - no physics or game logic

import { ParticleComponent } from '../components/ParticleComponent.js';
import { DecorationComponent } from '../components/DecorationComponent.js';
import { Transform } from '../components/Transform.js';
import { Collider } from '../components/Collider.js';
import { LightEmitter } from '../components/LightEmitter.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { ShadowCaster } from '../components/ShadowCaster.js';
import { FlashComponent } from '../components/FlashComponent.js';
import { AbstractWorker } from './AbstractWorker.js';
import { Grid } from '../core/Grid.js';
import { Sun } from '../core/Sun.js';
import {
    calculateCameraScreenBounds,
    screenBoundsToWorldBounds,
} from '../core/utils.js';
import { PRE_RENDER_STATS, createStatsWriter } from './workers-utils.js';
import { RENDERER_DEFAULTS } from '../core/ConfigDefaults.js';

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
        this.renderQueueFrameIndex = null;
        this.renderQueueType = null;
        this.renderQueueEntityIndex = null;

        // Entity texture lookup buffer
        this.entityLastTextureId = null;

        // Smoothed position buffers (for interpolation)
        this.smoothedX = null;
        this.smoothedY = null;

        // Animation frame tracking
        this.entityFrameIndex = null;
        this.entityFrameAccumulator = null;

        // Texture metadata
        this.animationFrameStart = null;
        this.animationFrameCount = null;
        this.proxyToGlobalAnim = null;
        this.animationNameToIndex = null;

        // Renderable collector
        this._renderableCollector = null;
        this._renderableCount = 0;

        // Pre-allocated query arrays
        this._queryLightEmitter = null;
        this._queryShadowCaster = null;

        // Interpolation alpha
        this.interpolationAlpha = 0.5;

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

        // Store viewport dimensions
        this.canvasWidth = this.config.canvasWidth;
        this.canvasHeight = this.config.canvasHeight;
        this.cullingRatio = this.config.renderer?.cullingRatio ?? RENDERER_DEFAULTS.cullingRatio;

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

            for (let bufIdx = 0; bufIdx < 2; bufIdx++) {
                const sab = bufferSABs[bufIdx];
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
                offset += maxItems * 4;

                buffer.frameIndex = new Uint8Array(sab, offset, maxItems);
                offset += maxItems;

                offset = Math.ceil(offset / 4) * 4;

                buffer.type = new Uint8Array(sab, offset, maxItems);
                offset += maxItems;

                offset = Math.ceil(offset / 4) * 4;

                buffer.entityIndex = new Int32Array(sab, offset, maxItems);

                this.renderQueueBuffers[bufIdx] = buffer;
            }

            // Set initial write buffer (will be updated each frame)
            this._setWriteBuffer(0);

            // Entity texture lookup buffer
            if (data.renderQueue.entityTextureData) {
                this.entityLastTextureId = new Uint16Array(data.renderQueue.entityTextureData);
            }

            // Initialize smoothed position buffers
            if (this.globalEntityCount > 0) {
                this.smoothedX = new Float32Array(this.globalEntityCount);
                this.smoothedY = new Float32Array(this.globalEntityCount);
                this.entityFrameIndex = new Uint16Array(this.globalEntityCount);
                this.entityFrameAccumulator = new Float32Array(this.globalEntityCount);

                for (let i = 0; i < this.globalEntityCount; i++) {
                    this.smoothedX[i] = Transform.x[i];
                    this.smoothedY[i] = Transform.y[i];
                }
            }

            // Pre-allocate renderable collector
            this._renderableCollector = new Array(maxItems);
            for (let i = 0; i < maxItems; i++) {
                this._renderableCollector[i] = { y: 0, type: 0, index: 0 };
            }

            // Pre-allocate query arrays
            this._queryLightEmitter = [LightEmitter];
            this._queryShadowCaster = [ShadowCaster];

            console.log(`[PRE_RENDER WORKER] Double-buffered render queue initialized (max ${maxItems} items)`);
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
        // SUN SYSTEM - Initialize
        // ========================================
        // Note: Sun static class is initialized by AbstractWorker.initializeCommonBuffers()
        // Shadow values are precomputed in Sun.setTimeOfDay() on main thread
        if (Sun.isInitialized) {
            this.sunEnabled = Sun.enabled;
            console.log(`[PRE_RENDER WORKER] Sun system initialized (enabled: ${this.sunEnabled})`);
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
        this.renderQueueFrameIndex = buffer.frameIndex;
        this.renderQueueType = buffer.type;
        this.renderQueueEntityIndex = buffer.entityIndex;
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
        }

        // Reset stats
        this.visibleEntitiesCount = 0;
        this.visibleParticlesCount = 0;
        this.visibleDecorationsCount = 0;
        this.shadowsUpdatedThisFrame = 0;
        this._renderableCount = 0;

        // Collect visible renderables for render queue
        // (visibility flags already set by particle_worker)
        this.collectVisibleParticles();
        this.collectVisibleEntities();
        this.collectVisibleDecorations();

        // Build the final render queue (sorts by Y, applies interpolation, writes to SAB)
        this.buildRenderQueue(deltaTime, this.interpolationAlpha);

        // Build shadow render queue
        this.buildShadowRenderQueue();

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

        const zoom = this.cameraData[0];
        const cameraX = this.cameraData[1];
        const cameraY = this.cameraData[2];

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

        for (let idx = 0; idx < visibleCount; idx++) {
            const i = visibleData[1 + idx];
            this.collectRenderable(1, i, y[i]);
            this.visibleParticlesCount++;
        }
    }

    /**
     * Collect visible entities for render queue
     * Uses visibleEntitiesData SAB populated by particle_worker
     */
    collectVisibleEntities() {
        if (this.globalEntityCount === 0 || !SpriteRenderer.isItOnScreen) return;

        const visibleData = this.visibleEntitiesData;
        if (!visibleData) return;

        const visibleCount = visibleData[0];
        const y = Transform.y;
        const renderVisible = SpriteRenderer.renderVisible;
        const lightEmitterActive = LightEmitter.active;
        const hasGlowSprite = LightEmitter.hasGlowSprite;

        for (let idx = 0; idx < visibleCount; idx++) {
            const i = visibleData[1 + idx];

            // Collect entity sprite if renderVisible
            if (renderVisible[i]) {
                this.collectRenderable(0, i, y[i]);
                this.visibleEntitiesCount++;
            }

            // Light glow sprites
            if (lightEmitterActive && lightEmitterActive[i] && hasGlowSprite[i]) {
                this.collectRenderable(3, i, y[i] + 10);
            }
        }
    }

    /**
     * Collect visible decorations for render queue
     * Uses visibleDecorationsData SAB populated by particle_worker
     */
    collectVisibleDecorations() {
        if (!this.maxDecorations || this.maxDecorations === 0 || !DecorationComponent.active) return;

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
     * Collect a visible renderable for the render queue
     */
    collectRenderable(type, index, y) {
        if (!this.renderQueueEnabled) return;
        if (this._renderableCount >= this.renderQueueMaxItems) return;

        const entry = this._renderableCollector[this._renderableCount];
        entry.y = y;
        entry.type = type;
        entry.index = index;
        this._renderableCount++;
    }

    /**
     * In-place heapsort for renderable collector
     */
    _heapsortRenderables(arr, count) {
        for (let i = (count >> 1) - 1; i >= 0; i--) {
            this._heapifyRenderables(arr, count, i);
        }

        for (let i = count - 1; i > 0; i--) {
            const temp = arr[0];
            arr[0] = arr[i];
            arr[i] = temp;
            this._heapifyRenderables(arr, i, 0);
        }
    }

    _heapifyRenderables(arr, heapSize, i) {
        while (true) {
            let largest = i;
            const left = (i << 1) + 1;
            const right = left + 1;

            if (left < heapSize && arr[left].y > arr[largest].y) {
                largest = left;
            }

            if (right < heapSize && arr[right].y > arr[largest].y) {
                largest = right;
            }

            if (largest === i) break;

            const temp = arr[i];
            arr[i] = arr[largest];
            arr[largest] = temp;
            i = largest;
        }
    }

    /**
     * Build the final render queue
     */
    buildRenderQueue(deltaTime, interpolationAlpha) {
        if (!this.renderQueueEnabled || this._renderableCount === 0) {
            if (this.renderQueueCount) this.renderQueueCount[0] = 0;
            return;
        }

        const count = this._renderableCount;
        const collector = this._renderableCollector;

        // Sort by Y
        if (count > 1) {
            if (count > 256) {
                this._heapsortRenderables(collector, count);
            } else {
                for (let i = 1; i < count; i++) {
                    const current = collector[i];
                    const currentY = current.y;
                    let j = i - 1;
                    while (j >= 0 && collector[j].y > currentY) {
                        collector[j + 1] = collector[j];
                        j--;
                    }
                    collector[j + 1] = current;
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

        const frameIndex = this.entityFrameIndex;
        const frameAccum = this.entityFrameAccumulator;
        const deltaSeconds = deltaTime / 1000;

        for (let i = 0; i < count; i++) {
            const entry = collector[i];
            const type = entry.type;
            const idx = entry.index;

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
                const globalAnimIdx = proxyMap ? (proxyMap[animState] ?? 0) : 0;
                const animFrameCount = this.animationFrameCount?.[globalAnimIdx] ?? 1;

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
                        }
                    }
                }

                const animStart = this.animationFrameStart?.[globalAnimIdx] ?? 0;
                const globalTextureId = animStart + frameIndex[idx];
                rqTextureId[i] = globalTextureId;

                if (entityLastTextureId) {
                    entityLastTextureId[idx] = globalTextureId;
                }
            } else if (type === 1) {
                // === PARTICLE ===
                rqX[i] = particleX[idx];
                rqY[i] = particleY[idx] + particleZ[idx];
                rqScaleX[i] = particleScaleX[idx];
                rqScaleY[i] = particleScaleY[idx];
                rqRotation[i] = particleRotation[idx];
                rqAlpha[i] = particleAlpha[idx];
                rqTint[i] = particleTint[idx];
                const pAnimIdx = particleTextureId[idx];
                rqTextureId[i] = this.animationFrameStart?.[pAnimIdx] ?? 0;
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
                rqAlpha[i] = decoAlpha[idx];
                rqTint[i] = decoTint[idx];
                const dAnimIdx = decoTextureId[idx];
                rqTextureId[i] = this.animationFrameStart?.[dAnimIdx] ?? 0;
                rqAnchorX[i] = decoAnchorX[idx];
                rqAnchorY[i] = decoAnchorY[idx];
                rqType[i] = 2;
                rqEntityIndex[i] = -1;
            } else {
                // === LIGHT GLOW (type=3) ===
                const rangeVal = visualRange[idx] || 200;
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
        const shadowCasterActive = ShadowCaster.active;
        const shadowHeightMultiplier = ShadowCaster.heightMultiplier;
        const flashActive = FlashComponent.active;
        const spriteScaleY = SpriteRenderer.scaleY;
        const spriteAnchorX = SpriteRenderer.anchorX;
        const spriteAnchorY = SpriteRenderer.anchorY;

        const maxShadowsPerEntity = this.maxShadowsPerEntity;
        const entityShadowCounts = this._entityShadowCounts;
        if (maxShadowsPerEntity > 0 && entityShadowCounts) {
            entityShadowCounts.fill(0);
        }

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

        let writeIdx = 0;
        let lightsProcessed = 0;
        const maxItems = this.maxShadowRenderItems;
        const maxShadowSprites = this.maxShadowSprites;
        const PI = Math.PI;

        let shadowCount = 0;

        const zoom = this.cameraData ? this.cameraData[0] : 1;
        const camX = this.cameraData ? this.cameraData[1] : 0;
        const camY = this.cameraData ? this.cameraData[2] : 0;
        const screenBounds = calculateCameraScreenBounds(
            zoom, camX, camY, this.canvasWidth, this.canvasHeight, this.cullingRatio, this._cameraBounds
        );
        const worldBounds = screenBoundsToWorldBounds(screenBounds, 0, 0, this._worldBounds);
        const viewMinX = worldBounds.minX;
        const viewMaxX = worldBounds.maxX;
        const viewMinY = worldBounds.minY;
        const viewMaxY = worldBounds.maxY;

        // ========================================
        // SUN SHADOWS (rendered first, parallel direction)
        // ========================================
        // SUN SHADOWS (precomputed in Sun class)
        if (Sun.isInitialized && Sun.enabled) {
            // Only render sun shadows when sun is up (intensity > threshold)
            const sunIntensity = Sun.intensity;
            if (sunIntensity > 0.1) {
                const sunShadowAngle = Sun.shadowAngle;
                const sunShadowLengthRatio = Sun.shadowLengthRatio;

                // Stretch-based alpha: longer shadows = more transparent
                const sunShadowBaseAlpha = Sun.shadowAlpha * sunIntensity;
                const stretchRatio = Sun.shadowMinLengthRatio / sunShadowLengthRatio;
                const stretchAlphaMultiplier = 1 - Sun.shadowStretchAlphaFactor * (1 - stretchRatio);
                const sunShadowAlpha = sunShadowBaseAlpha * stretchAlphaMultiplier;

                // Query all visible entities with ShadowCaster
                const visibleData = this.visibleEntitiesData;
                const visibleCount = visibleData ? visibleData[0] : 0;

                for (let idx = 0; idx < visibleCount && writeIdx < maxItems && shadowCount < maxShadowSprites; idx++) {
                    const entityIdx = visibleData[1 + idx];

                    if (!shadowCasterActive[entityIdx] || !transformActive[entityIdx]) continue;

                    // heightMultiplier: 0 = no shadow, 1 = normal, 2 = 2x longer
                    const heightMult = shadowHeightMultiplier[entityIdx];
                    if (heightMult <= 0) continue;

                    if (maxShadowsPerEntity > 0 && entityShadowCounts[entityIdx] >= maxShadowsPerEntity) continue;

                    const casterX = worldX[entityIdx];
                    const casterY = worldY[entityIdx];
                    const textureId = entityLastTextureId ? entityLastTextureId[entityIdx] : 0;

                    // Shadow uses SAME position and anchor as sprite - no offset needed
                    const entityScaleY = Math.abs(spriteScaleY[entityIdx]) || 1;
                    const anchorX = spriteAnchorX[entityIdx] ?? 0.5;
                    const anchorY = spriteAnchorY[entityIdx] ?? 0.95;

                    // Shadow length = spriteScaleY × heightMultiplier × sunShadowLengthRatio
                    // Negative to flip shadow (extends away from anchor, not same direction as sprite)
                    const lengthScale = -entityScaleY * heightMult * sunShadowLengthRatio;

                    // Cull shadows outside view
                    const originalHeight = this.frameHeight ? this.frameHeight[textureId] : 50;
                    const shadowExtent = Math.abs(lengthScale) * originalHeight + 100;
                    if (casterX + shadowExtent < viewMinX || casterX - shadowExtent > viewMaxX ||
                        casterY + shadowExtent < viewMinY || casterY - shadowExtent > viewMaxY) continue;

                    rqX[writeIdx] = casterX;
                    rqY[writeIdx] = casterY;
                    rqScaleX[writeIdx] = 1;
                    rqScaleY[writeIdx] = lengthScale;
                    // Sprite's natural "up" is -π/2, so subtract π/2 to align shadow direction
                    rqRotation[writeIdx] = sunShadowAngle - 1.5707963267948966;
                    rqAlpha[writeIdx] = sunShadowAlpha;
                    rqTint[writeIdx] = 0x000000;
                    rqTextureId[writeIdx] = textureId;
                    rqAnchorX[writeIdx] = anchorX;
                    rqAnchorY[writeIdx] = anchorY;

                    writeIdx++;
                    shadowCount++;
                    if (maxShadowsPerEntity > 0) entityShadowCounts[entityIdx]++;
                }
            }
        }

        // ========================================
        // POINT LIGHT SHADOWS (suppressed when sun is bright)
        // ========================================
        // When sun intensity is high, point light shadows are less visible
        const sunIntensity = Sun.isInitialized && Sun.enabled ? Sun.intensity : 0;
        const pointLightShadowMultiplier = 1 - (sunIntensity * 0.9); // At noon: 10% visibility

        const lightEntitiesRaw = this.queryActiveEntities(this._queryLightEmitter);

        const lightEntities = this._sortedLightEntities;
        lightEntities.length = lightEntitiesRaw.length;
        for (let i = 0; i < lightEntitiesRaw.length; i++) {
            lightEntities[i] = lightEntitiesRaw[i];
        }
        lightEntities.sort(this._lightYComparator);

        for (let i = 0; i < lightEntities.length; i++) {
            if (writeIdx >= maxItems) break;
            if (lightsProcessed >= this.maxShadowCastingLights) break;

            const lightIdx = lightEntities[i];
            if (!lightEnabled[lightIdx]) continue;

            const isFlash = flashActive[lightIdx] === 1;
            const intensity = lightIntensity[lightIdx];
            if (intensity <= 0) continue;

            const lightX = worldX[lightIdx];
            const lightY = worldY[lightIdx];
            const lightH = lightHeight[lightIdx] || 0;

            if (!isFlash) {
                const lightInfluenceRadius = sqrtLightIntensity[lightIdx] * 10;
                if (lightX + lightInfluenceRadius < viewMinX || lightX - lightInfluenceRadius > viewMaxX ||
                    lightY + lightInfluenceRadius < viewMinY || lightY - lightInfluenceRadius > viewMaxY) continue;
            }

            const offset = lightIdx * stride;
            const neighborCountForLight = neighborData[offset];

            const shadowStartIdx = writeIdx + 1;
            let shadowsForThisLight = 0;

            const lightXWithOffset = worldX[lightIdx] + (Collider.offsetX[lightIdx] || 0);
            const lightYWithOffset = worldY[lightIdx] + (Collider.offsetY[lightIdx] || 0);

            for (let k = 0; k < neighborCountForLight; k++) {
                if (shadowsForThisLight >= this.maxShadowsPerLight) break;
                if (shadowCount >= maxShadowSprites) break;
                if (writeIdx + 1 + shadowsForThisLight >= maxItems) break;

                const neighborIdx = neighborData[offset + 2 + k];

                if (!shadowCasterActive[neighborIdx] || !transformActive[neighborIdx]) continue;

                // heightMultiplier: 0 = no shadow, 1 = normal, 2 = 2x longer
                const heightMult = shadowHeightMultiplier[neighborIdx];
                if (heightMult <= 0) continue;

                if (maxShadowsPerEntity > 0 && entityShadowCounts[neighborIdx] >= maxShadowsPerEntity) continue;

                const neighborX = worldX[neighborIdx] + (Collider.offsetX[neighborIdx] || 0);
                const neighborY = worldY[neighborIdx] + (Collider.offsetY[neighborIdx] || 0);
                const dx = neighborX - lightXWithOffset;
                const dy = neighborY - lightYWithOffset;
                const distSq = dx * dx + dy * dy;

                if (distSq < 1) continue;

                const casterX = worldX[neighborIdx];
                const casterY = worldY[neighborIdx];
                const textureId = entityLastTextureId ? entityLastTextureId[neighborIdx] : 0;

                // Shadow uses SAME anchor as sprite
                const entityScaleY = Math.abs(spriteScaleY[neighborIdx]) || 1;
                const anchorX = spriteAnchorX[neighborIdx] ?? 0.5;
                const anchorY = spriteAnchorY[neighborIdx] ?? 0.95;

                const dist = Math.sqrt(distSq);

                // Shadow length based on distance and sprite scale
                // Negative to flip shadow (extends away from anchor)
                const distRatio = dist * 0.00390625;
                const clampedDistRatio = distRatio > 1 ? 1 : distRatio;
                const lengthScale = -(0.3 + clampedDistRatio * 0.9) * entityScaleY * heightMult;

                // Cull shadows outside view
                const originalHeight = this.frameHeight ? this.frameHeight[textureId] : 50;
                const shadowExtent = Math.abs(lengthScale) * originalHeight + 100;
                if (casterX + shadowExtent < viewMinX || casterX - shadowExtent > viewMaxX ||
                    casterY + shadowExtent < viewMinY || casterY - shadowExtent > viewMaxY) continue;

                let alpha = intensity / (intensity + distSq);
                if (Number.isNaN(alpha)) alpha = 0;
                if (alpha > 1) alpha = 1;
                if (alpha < 0) alpha = 0;
                alpha *= 0.33;
                // Suppress point light shadows when sun is bright
                alpha *= pointLightShadowMultiplier;

                const angle = Math.atan2(dy, dx);

                const shadowIdx = shadowStartIdx + shadowsForThisLight;
                rqX[shadowIdx] = casterX;
                rqY[shadowIdx] = casterY;
                rqScaleX[shadowIdx] = 1;
                rqScaleY[shadowIdx] = lengthScale;
                // Sprite's natural "up" is -π/2, so subtract π/2 to align shadow direction
                rqRotation[shadowIdx] = angle - 1.5707963267948966;
                rqAlpha[shadowIdx] = alpha;
                rqTint[shadowIdx] = 0x000000;
                rqTextureId[shadowIdx] = textureId;
                rqAnchorX[shadowIdx] = anchorX;
                rqAnchorY[shadowIdx] = anchorY;

                shadowsForThisLight++;
                shadowCount++;
                if (maxShadowsPerEntity > 0) entityShadowCounts[neighborIdx]++;
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
        }
    }
}

// Create singleton instance
self.preRenderWorker = new PreRenderWorker(self);
