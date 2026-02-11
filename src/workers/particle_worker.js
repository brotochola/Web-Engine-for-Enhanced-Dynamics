// particle_worker.js - Dedicated worker for particle physics
// Updates particle positions, applies gravity, handles lifetime
// Particles are NOT GameObjects - they use ParticleComponent directly

import { ParticleComponent } from '../components/ParticleComponent.js';
import { ParticleEmitter } from '../core/ParticleEmitter.js';
import { DecorationComponent } from '../components/DecorationComponent.js';
import { DecorationPool } from '../core/DecorationPool.js';
import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { LightEmitter } from '../components/LightEmitter.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { ShadowCaster } from '../components/ShadowCaster.js';
import { FlashComponent } from '../components/FlashComponent.js';
import { AbstractWorker } from './AbstractWorker.js';
import { Grid } from '../core/Grid.js';
import {
  calculateTotalLightAtPosition,
  brightnessToTint,
  extractRGB,
  calculateSpeed,
  calculateVelocityAngle,
  calculateDecalTileBounds,
  calculateTileClipRegion,
  _decalTileBounds,
  _tileClipRegion,
  countTrailingZeros,
} from '../core/utils.js';
import { PARTICLE_STATS, createStatsWriter } from './workers-utils.js';
import { RENDERER_DEFAULTS } from '../core/ConfigDefaults.js';
import { SpriteSheetRegistry } from '../core/SpriteSheetRegistry.js';

// Note: Components (Transform, RigidBody, etc.) are now registered automatically
// by AbstractWorker.registerAllComponents() after entity classes are loaded

/**
 * ParticleWorker - Handles particle physics simulation
 * Updates positions, applies gravity, manages particle lifecycle
 * Particles have their own separate pool (indices 0 to maxParticles-1)
 *
 * BLOOD DECALS SYSTEM:
 * When particles with stayOnTheFloor=1 hit the ground, they stamp a blood
 * pattern onto a tilemap. The stamping happens in two phases:
 * 1. Physics loop: collect particle indices that need to stamp
 * 2. Post-physics: stamp all collected particles at once (better cache locality)
 */
class ParticleWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Particle worker doesn't create GameObject instances (but has access to all components)
    this.needsGameScripts = false;

    // Particle pool size (separate from entity system)
    this.maxParticles = 0;

    // Active particle count for FPS reporting
    this.activeParticleCount = 0;

    // Stats tracking
    this.particlesStampedThisFrame = 0;
    this.flashesUpdatedThisFrame = 0;
    this.shadowsUpdatedThisFrame = 0;

    // ========================================
    // BLOOD DECALS TILEMAP SYSTEM
    // ========================================
    this.decalsEnabled = false;
    this.decalsTileSize = 256; // World units each tile covers
    this.decalsTilePixelSize = 256; // Actual pixel size of tile textures
    this.decalsResolution = 1.0; // Resolution multiplier (0.5 = half res)
    this.decalsTilesX = 0;
    this.decalsTilesY = 0;
    this.decalsTotalTiles = 0;

    // SharedArrayBuffer views for blood decals
    // tilesRGBA: Uint8ClampedArray - RGBA pixel data for all tiles
    // tilesDirty: Uint8Array - dirty flag per tile (0=clean, 1=modified)
    this.bloodTilesRGBA = null;
    this.bloodTilesDirty = null;

    // Reusable array to collect particles that need stamping this frame
    // Cleared each frame, populated during physics, processed after physics
    this.particlesToStamp = null; // Initialized after maxParticles is known
    this.particlesToStampCount = 0;

    // ========================================
    // DECAL TEXTURE DATA
    // ========================================
    // Maps textureId -> { width, height, rgba: Uint8ClampedArray }
    // Received from gameEngine during initialization
    // Each texture's RGBA pixel data is extracted from the bigAtlas
    this.decalTextures = {};

    // ========================================
    // PARTICLE LIGHTING SYSTEM
    // ========================================
    // CPU-based per-particle lighting using LightEmitter components
    this.lightingEnabled = false;
    this.entityLightingEnabled = false; // Separate flag for entity tint updates
    this.lightingAmbient = 0.05; // Base ambient light level
    this.globalEntityCount = 0; // Number of game entities (for iterating lights)

    // ========================================
    // GC OPTIMIZATION: Cached objects
    // ========================================
    // Reusable camera bounds object to avoid per-frame allocations
    this._cameraBounds = {
      zoom: 0,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
    };

    // Reusable grid query result to avoid per-frame allocations
    this._gridQueryResult = null;

    // ========================================
    // SHADOW SPRITE SYSTEM
    // ========================================
    // Calculates shadow positions for entities near lights
    // Writes to ShadowSprite buffer, read by pixi_worker
    this.shadowsEnabled = false;
    this.maxShadowCastingLights = 20;
    this.maxShadowsPerLight = 15;
    this.maxShadowsPerEntity = 0; // 0 = unlimited
    this.maxShadowSprites = 0;

    // Per-entity shadow count tracking (reused each frame)
    this._entityShadowCounts = null;

    // ========================================
    // SHADOW RENDER QUEUE
    // ========================================
    // Pre-sorted shadow renderables (light gradients + shadows) for pixi_worker
    // Order: light1_gradient, light1_shadows..., light2_gradient, light2_shadows...
    this._shadowCollector = null;

    // ========================================
    // DERIVED PROPERTIES (moved from physics_worker)
    // ========================================
    // Minimum speed threshold for rotation updates (prevents jitter when stationary)
    this.minSpeedForRotation = 0.1;
    this.rigidBodyCount = 0;

    // ========================================
    // RENDER QUEUE SYSTEM
    // ========================================
    // Pre-sorted, screen-visible renderables for pixi_worker
    // Built inline during visibility checks, consumed by pixi_worker
    this.renderQueueEnabled = false;
    this.renderQueueMaxItems = 0;
    this.renderQueueCount = null;  // Int32Array[1] - current item count
    // Per-item arrays (all maxItems length):
    this.renderQueueX = null;      // Float32Array - interpolated X
    this.renderQueueY = null;      // Float32Array - interpolated Y
    this.renderQueueScaleX = null; // Float32Array
    this.renderQueueScaleY = null; // Float32Array
    this.renderQueueRotation = null; // Float32Array
    this.renderQueueAlpha = null;  // Float32Array
    this.renderQueueTint = null;   // Uint32Array
    this.renderQueueTextureId = null; // Uint16Array (resolved frame)
    this.renderQueueAnchorX = null; // Float32Array
    this.renderQueueAnchorY = null; // Float32Array
    this.renderQueueFrameIndex = null; // Uint8Array (for entity animations)

    // Smoothed position buffers (for interpolation, indexed by globalIndex)
    // Only entities need smoothing - particles/decorations update at 120fps
    this.smoothedX = null;  // Float32Array[globalEntityCount]
    this.smoothedY = null;  // Float32Array[globalEntityCount]

    // Animation frame tracking (for entities, indexed by globalIndex)
    this.entityFrameIndex = null;     // Uint16Array[globalEntityCount] - current frame
    this.entityFrameAccumulator = null; // Float32Array[globalEntityCount] - time accumulator

    // Texture metadata for globalTextureId computation
    this.animationFrameStart = null;  // [animIdx] → starting index in flat texture array
    this.animationFrameCount = null;  // [animIdx] → number of frames
    this.proxyToGlobalAnim = null;    // [sheetId][localAnimIdx] → globalAnimIdx

    // Temp array for collecting renderables before Y-sort
    this._renderableCollector = null;  // [{y, type, index}, ...]
    this._renderableCount = 0;

    // Interpolation alpha (0-1, how far between physics frames)
    this.interpolationAlpha = 0.5;

    // ========================================
    // SLEEPING OPTIMIZATION
    // ========================================
    // Entities below sleepThreshold speed for sleepDuration frames will be put to sleep
    this.sleepThreshold = 0.1; // Speed threshold (units/frame)
    this.sleepDuration = 30; // Frames of stillness required (0.5 seconds at 60fps)

    // ========================================
    // FLASH SYSTEM
    // ========================================
    // Flashes are short-lived light sources (muzzle flashes, sparks, etc.)
    // Updated here in particle_worker, not in logic workers
    this.flashesEnabled = false;
    this.maxFlashes = 0;
    this.flashStartIndex = 0; // Entity index where flashes start

    // Note: activeEntitiesData is now initialized in AbstractWorker.initializeCommonBuffers
  }

  /**
   * Initialize the particle worker
   */
  async initialize(data) {
    console.log('[PARTICLE WORKER] Starting initialize()...');

    // Initialize stats buffer for writing metrics
    if (data.buffers.particleStats) {
      this.stats = createStatsWriter(data.buffers.particleStats, PARTICLE_STATS);
      console.log('[PARTICLE WORKER] Stats buffer initialized');
    } else {
      console.warn('[PARTICLE WORKER] No particleStats buffer provided');
    }

    // Get max particles from config (passed from gameEngine)
    this.maxParticles = data.maxParticles || 0;
    console.log(`[PARTICLE WORKER] Max particles: ${this.maxParticles}`);

    // Store viewport dimensions for screen visibility checks
    this.canvasWidth = this.config.canvasWidth;
    this.canvasHeight = this.config.canvasHeight;
    this.cullingRatio = this.config.renderer?.cullingRatio ?? RENDERER_DEFAULTS.cullingRatio;
    console.log(`[PARTICLE WORKER] Canvas: ${this.canvasWidth}x${this.canvasHeight}, cullingRatio: ${this.cullingRatio}`);

    // Note: ParticleComponent and ParticleEmitter are automatically initialized
    // by AbstractWorker.initializeCommonBuffers() with shared free list
    if (this.maxParticles > 0) {
      if (!data.buffers.componentData.ParticleComponent) {
        console.warn(
          '[PARTICLE WORKER] ParticleComponent buffer not found, particle physics disabled'
        );
        this.maxParticles = 0;
      } else {
        console.log('[PARTICLE WORKER] Initializing particle arrays...');
        // Initialize typed array for particle stamping (performance optimization)
        this.particlesToStamp = new Uint16Array(this.maxParticles);

        // OPTIMIZATION: Track active particles to avoid scanning inactive ones
        this.activeParticleIndices = new Uint16Array(this.maxParticles);

        console.log('[PARTICLE WORKER] Particle arrays initialized');
      }
    } else {
      console.log('[PARTICLE WORKER] No particles configured, skipping particle initialization');
    }
    // Note: Worker continues initialization for other systems (lighting, shadows, flashes, etc.)
    // even when no particles are configured

    // ========================================
    // BLOOD DECALS TILEMAP - Initialize SABs
    // ========================================
    console.log('[PARTICLE WORKER] Checking decals configuration...', {
      hasDecals: !!data.decals,
      enabled: data.decals?.enabled
    });

    if (data.decals && data.decals.enabled) {
      console.log('[PARTICLE WORKER] Initializing decals system...');
      this.decalsEnabled = true;
      this.decalsTileSize = data.decals.tileSize; // World units per tile
      this.decalsTilePixelSize = data.decals.tilePixelSize; // Actual texture pixels
      this.decalsResolution = data.decals.resolution; // Resolution multiplier
      this.decalsTilesX = data.decals.tilesX;
      this.decalsTilesY = data.decals.tilesY;
      this.decalsTotalTiles = data.decals.totalTiles;

      // Create typed array views over the SharedArrayBuffers
      // These are shared with pixi_worker for rendering
      this.bloodTilesRGBA = new Uint8ClampedArray(data.decals.tilesRGBA);
      this.bloodTilesDirty = new Uint8Array(data.decals.tilesDirty);

      // Store texture pixel data for stamping
      // Each entry: { width, height, rgba: Uint8ClampedArray }
      if (data.decals.textures) {
        const textureCount = Object.keys(data.decals.textures).length;
        console.log(`[PARTICLE WORKER] Loading ${textureCount} decal textures...`);
        for (const [textureId, textureData] of Object.entries(data.decals.textures)) {
          this.decalTextures[textureId] = {
            width: textureData.width,
            height: textureData.height,
            rgba: new Uint8ClampedArray(textureData.rgba),
          };
        }
        console.log(`[PARTICLE WORKER] Decal textures loaded: ${Object.keys(this.decalTextures).length}`);
      } else {
        console.warn('[PARTICLE WORKER] No decal textures provided!');
      }
      console.log('[PARTICLE WORKER] Decals system initialized');
    } else {
      console.log('[PARTICLE WORKER] Blood decals NOT enabled');
    }

    // ========================================
    // PARTICLE LIGHTING - Initialize
    // ========================================
    console.log('[PARTICLE WORKER] Checking lighting configuration...');
    const lightingConfig = this.config.lighting || {};
    if (
      lightingConfig.enabled &&
      data.buffers.componentData.LightEmitter &&
      data.buffers.componentData.Transform
    ) {
      console.log('[PARTICLE WORKER] Initializing lighting system...');
      this.lightingEnabled = true;
      this.lightingAmbient = lightingConfig.lightingAmbient ?? LIGHTING_DEFAULTS.lightingAmbient;
      this.globalEntityCount = data.globalEntityCount || 0;

      // Note: Component arrays (Transform, LightEmitter, SpriteRenderer) are automatically
      // initialized by AbstractWorker.initializeAllComponents()

      // Enable entity lighting by default when lighting is on
      // Can be disabled via config.lighting.entityLighting = false
      if (lightingConfig.entityLighting !== false && data.buffers.componentData.SpriteRenderer) {
        this.entityLightingEnabled = true;
        console.log(
          `[PARTICLE WORKER] Entity lighting enabled (${this.globalEntityCount} entities)`
        );
      }

      console.log(
        `[PARTICLE WORKER] Lighting enabled (ambient: ${this.lightingAmbient}, entities: ${this.globalEntityCount})`
      );
    } else {
      console.log('[PARTICLE WORKER] Lighting not enabled or missing buffers');
    }

    // ========================================
    // ENTITY SCREEN VISIBILITY - Initialize
    // ========================================
    // Store entity count for screen visibility even without lighting
    if (data.globalEntityCount && !this.lightingEnabled) {
      this.globalEntityCount = data.globalEntityCount;
      // Note: Transform and SpriteRenderer are automatically initialized by
      // AbstractWorker.initializeAllComponents()
    }

    // ========================================
    // RIGIDBODY - Configure for derived properties
    // ========================================
    // Note: RigidBody is automatically initialized by AbstractWorker.initializeAllComponents()
    // Speed and velocityAngle calculations (moved from physics_worker)
    if (data.buffers.componentData.RigidBody && data.componentPools?.RigidBody) {
      this.rigidBodyCount = data.componentPools.RigidBody.count || 0;

      // Get physics config values
      const physicsConfig = this.config.physics || {};
      this.minSpeedForRotation = physicsConfig.minSpeedForRotation ?? PHYSICS_DEFAULTS.minSpeedForRotation;
      this.sleepThreshold = physicsConfig.sleepThreshold ?? PHYSICS_DEFAULTS.sleepThreshold;
      this.sleepDuration = physicsConfig.sleepDuration ?? PHYSICS_DEFAULTS.sleepDuration;
    }

    // ========================================
    // SHADOW SPRITE SYSTEM - Initialize
    // ========================================
    console.log('[PARTICLE WORKER] Checking shadows configuration...', {
      hasShadows: !!data.shadows,
      enabled: data.shadows?.enabled,
      hasRenderQueueData: !!data.shadows?.renderQueueData,
      hasShadowCaster: !!data.buffers.componentData.ShadowCaster
    });

    if (
      data.shadows &&
      data.shadows.enabled &&
      data.shadows.renderQueueData &&
      data.buffers.componentData.ShadowCaster
    ) {
      console.log('[PARTICLE WORKER] Initializing shadow render queue system...');
      this.shadowsEnabled = true;
      this.maxShadowCastingLights = data.shadows.maxShadowCastingLights;
      this.maxShadowsPerLight = data.shadows.maxShadowsPerLight;
      this.maxShadowsPerEntity = data.shadows.maxShadowsPerEntity || 0; // 0 = unlimited
      this.maxShadowSprites = data.shadows.maxShadowSprites;
      this.maxShadowLights = data.shadows.maxLights || 128;
      this.maxShadowRenderItems = data.shadows.maxRenderItems;

      // Allocate per-entity shadow count tracking array if limit is set
      if (this.maxShadowsPerEntity > 0) {
        this._entityShadowCounts = new Uint8Array(this.globalEntityCount);
      }

      // Note: ShadowCaster is automatically initialized by AbstractWorker.initializeAllComponents()

      // ========================================
      // SHADOW RENDER QUEUE - Initialize typed array views
      // ========================================
      // Layout: [count:Int32, then per-item: x, y, scaleX, scaleY, rotation, alpha, tint, textureId, anchorX, anchorY]
      const sab = data.shadows.renderQueueData;
      const maxItems = this.maxShadowRenderItems;
      let offset = 0;

      this.shadowRenderQueueCount = new Int32Array(sab, offset, 1);
      offset += 4;

      this.shadowRenderQueueX = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueY = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueScaleX = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueScaleY = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueRotation = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueAlpha = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueTint = new Uint32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueTextureId = new Uint16Array(sab, offset, maxItems);
      offset += maxItems * 2;

      // Align to 4 bytes for Float32Array
      offset = Math.ceil(offset / 4) * 4;

      this.shadowRenderQueueAnchorX = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueAnchorY = new Float32Array(sab, offset, maxItems);

      // Pre-allocate collector for shadow renderables (light gradients + shadows)
      // Ordered: light1_gradient, light1_shadows..., light2_gradient, light2_shadows...
      this._shadowCollector = new Array(maxItems);
      for (let i = 0; i < maxItems; i++) {
        this._shadowCollector[i] = {
          type: 0, // 0 = light gradient, 1 = shadow
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
          alpha: 1,
          tint: 0xFFFFFF,
          textureId: 0,
          anchorX: 0.5,
          anchorY: 0.5,
        };
      }

      console.log(`[PARTICLE WORKER] Shadow render queue enabled (${maxItems} max items: ${this.maxShadowSprites} shadows + ${this.maxShadowLights} lights)`);
    } else {
      console.log('[PARTICLE WORKER] Shadows not enabled or missing buffers');
    }

    // ========================================
    // FLASH SYSTEM - Initialize
    // ========================================
    console.log('[PARTICLE WORKER] Checking flashes configuration...', {
      hasFlashes: !!data.flashes,
      enabled: data.flashes?.enabled
    });

    if (data.flashes && data.flashes.enabled) {
      console.log('[PARTICLE WORKER] Initializing flash system...');
      this.flashesEnabled = true;
      this.maxFlashes = data.flashes.maxFlashes;
      this.flashStartIndex = data.flashes.startIndex;

      // Note: FlashComponent is automatically initialized by AbstractWorker.initializeAllComponents()
      if (data.buffers.componentData.FlashComponent) {
        console.log(
          `[PARTICLE WORKER] Flash system enabled (${this.maxFlashes} flashes, starting at index ${this.flashStartIndex})`
        );
      } else {
        console.warn('[PARTICLE WORKER] FlashComponent buffer not found - flashes disabled');
        this.flashesEnabled = false;
      }
    } else {
      console.log('[PARTICLE WORKER] Flashes not enabled');
    }

    // Note: activeEntitiesData is initialized in AbstractWorker.initializeCommonBuffers

    // ========================================
    // RENDER QUEUE - Initialize
    // ========================================
    if (data.renderQueue && data.renderQueue.data) {
      console.log('[PARTICLE WORKER] Initializing render queue system...');
      this.renderQueueEnabled = true;
      this.renderQueueMaxItems = data.renderQueue.maxItems;
      const itemSize = data.renderQueue.itemSize; // 40 bytes
      const sab = data.renderQueue.data;

      // Create typed array views over the SharedArrayBuffer
      // Layout: [count:Int32, then per-item data...]
      this.renderQueueCount = new Int32Array(sab, 0, 1);

      // Calculate offsets for each array (starting after count, 4-byte aligned)
      const maxItems = this.renderQueueMaxItems;
      let offset = 4; // After count

      this.renderQueueX = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.renderQueueY = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.renderQueueScaleX = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.renderQueueScaleY = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.renderQueueRotation = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.renderQueueAlpha = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.renderQueueTint = new Uint32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.renderQueueTextureId = new Uint16Array(sab, offset, maxItems);
      offset += maxItems * 2;

      // Align to 4 bytes for next Float32Array
      offset = Math.ceil(offset / 4) * 4;

      this.renderQueueAnchorX = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.renderQueueAnchorY = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      // Frame index for entity animations (Uint8 is enough - max 256 frames per animation)
      this.renderQueueFrameIndex = new Uint8Array(sab, offset, maxItems);
      offset += maxItems;

      // Align to 4 bytes for next array
      offset = Math.ceil(offset / 4) * 4;

      // Type (0=entity, 1=particle, 2=decoration) - for shadow system
      this.renderQueueType = new Uint8Array(sab, offset, maxItems);
      offset += maxItems;

      // Align to 4 bytes for Int32Array
      offset = Math.ceil(offset / 4) * 4;

      // Entity index (original index for shadow texture lookup, -1 for non-entities)
      this.renderQueueEntityIndex = new Int32Array(sab, offset, maxItems);

      // Entity texture lookup buffer (separate SAB)
      // Maps entityIndex -> last computed globalTextureId for shadow system
      if (data.renderQueue.entityTextureData) {
        this.entityLastTextureId = new Uint16Array(data.renderQueue.entityTextureData);
      }

      // Initialize smoothed position buffers (local, not shared)
      if (this.globalEntityCount > 0) {
        this.smoothedX = new Float32Array(this.globalEntityCount);
        this.smoothedY = new Float32Array(this.globalEntityCount);
        this.entityFrameIndex = new Uint16Array(this.globalEntityCount);
        this.entityFrameAccumulator = new Float32Array(this.globalEntityCount);

        // Initialize smoothed positions from current positions
        for (let i = 0; i < this.globalEntityCount; i++) {
          this.smoothedX[i] = Transform.x[i];
          this.smoothedY[i] = Transform.y[i];
        }
      }

      // Pre-allocate renderable collector (avoid per-frame allocation)
      // Each entry: { y: number, type: 0=entity|1=particle|2=decoration, index: number }
      const maxRenderables = maxItems;
      this._renderableCollector = new Array(maxRenderables);
      for (let i = 0; i < maxRenderables; i++) {
        this._renderableCollector[i] = { y: 0, type: 0, index: 0 };
      }

      console.log(`[PARTICLE WORKER] Render queue initialized (max ${maxItems} items)`);
    } else {
      console.log('[PARTICLE WORKER] Render queue NOT enabled (no data provided)');
    }

    // ========================================
    // TEXTURE METADATA - Initialize
    // ========================================
    if (data.textureMetadata) {
      this.animationFrameStart = data.textureMetadata.animationFrameStart;
      this.animationFrameCount = data.textureMetadata.animationFrameCount;
      this.proxyToGlobalAnim = data.textureMetadata.proxyToGlobalAnim;
      this.animationNameToIndex = data.textureMetadata.animationNameToIndex;
      console.log(`[PARTICLE WORKER] Texture metadata loaded: ${data.textureMetadata.totalFrames} total frames`);
    }

    console.log('[PARTICLE WORKER] ✅ Initialize() completed successfully!');
  }

  /**
   * Build compact list of active entities for load-balanced processing
   * Scans Transform.active[] and writes indices to activeEntitiesData (shared with all workers)
   * Called at start of each frame before other workers process entities
   *
   * NOTE: The list is already naturally sorted because we scan indices 0->N
   * If entities are sparse (e.g., every 8th entity active), cache locality is still
   * good within contiguous blocks, but there may be gaps between entity types.
   */
  buildActiveEntityList() {
    if (!this.activeEntitiesData) return;

    const active = Transform.active;
    const buffer = this.activeEntitiesData;
    let writeIdx = 1; // Start at index 1 (index 0 is for count)

    // Scan all entities and collect active indices
    // This naturally produces a sorted list since we iterate 0->globalEntityCount
    for (let i = 0; i < this.globalEntityCount; i++) {
      if (active[i]) {
        buffer[writeIdx++] = i;
      }
    }

    // Write count at index 0
    buffer[0] = writeIdx - 1;

    // PERFORMANCE NOTE: List is already sorted by entity index (0, 1, 2, ...)
    // This provides good cache locality for sequential entity pools.
    // If you see poor cache performance, consider entity pool compaction
    // or spatial sorting (sort by grid cell) for better locality.
  }

  /**
   * Populate pre-computed query result buffers with active entity indices
   * Uses binary search on the already-sorted activeEntitiesData to find
   * active entities within each entity type's index range.
   *
   * Called after buildActiveEntityList() so activeEntitiesData is fresh.
   */
  populateQueryResults() {
    // Check if query system is initialized with SABs
    if (!this._queryResultViews || !this._precomputedQueries || !this._queryEntityMetadata) {
      return;
    }

    const activeData = this.activeEntitiesData;
    if (!activeData) return;

    const totalActive = activeData[0];
    if (totalActive === 0) {
      // No active entities - clear all result buffers
      for (let q = 0; q < this._queryResultViews.length; q++) {
        this._queryResultViews[q][0] = 0;
      }
      return;
    }

    // For each pre-computed query, find active entities from matching types
    for (let q = 0; q < this._precomputedQueries.length; q++) {
      const query = this._precomputedQueries[q];
      const resultView = this._queryResultViews[q];
      let resultCount = 0;

      // Bit-scan typeMask to iterate matching entity types
      let typeMask = query.typeMask;
      while (typeMask !== 0n) {
        // Find lowest set bit (trailing zeros)
        const typeIndex = countTrailingZeros(typeMask);
        const meta = this._queryEntityMetadata[typeIndex];

        // Binary search activeEntitiesData for indices in [startIndex, endIndex)
        const start = meta.startIndex;
        const end = meta.endIndex;

        // Find first index >= start
        let lo = 1;
        let hi = 1 + totalActive;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (activeData[mid] < start) lo = mid + 1;
          else hi = mid;
        }
        const first = lo;

        // Find first index >= end
        hi = 1 + totalActive;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (activeData[mid] < end) lo = mid + 1;
          else hi = mid;
        }
        const last = lo;

        // Copy matching indices to result buffer
        for (let i = first; i < last; i++) {
          resultView[1 + resultCount++] = activeData[i];
        }

        // Clear lowest set bit
        typeMask &= typeMask - 1n;
      }

      // Write count at index 0
      resultView[0] = resultCount;
    }
  }

  /**
   * Build compact list of active particles
   * Scans ParticleComponent.active[] and writes indices to local activeParticleIndices
   * OPTIMIZED: Early-exit when we've found all active particles (derived from free list)
   */
  buildActiveParticleList() {
    if (this.maxParticles === 0) return;

    const active = ParticleComponent.active;
    const indices = this.activeParticleIndices;
    let count = 0;

    // Calculate expected active count from free list: active = total - free
    // freeListTop is the number of free slots available
    const freeListTop = ParticleEmitter.freeListTop;
    const expectedActive = freeListTop ? this.maxParticles - freeListTop[0] : this.maxParticles;

    // Early exit once we've found all active particles
    for (let i = 0; i < this.maxParticles && count < expectedActive; i++) {
      if (active[i]) {
        indices[count++] = i;
      }
    }

    this.activeParticleCount = count;
  }

  // NOTE: rebuildSpatialGrid() removed - now handled by spatial workers using row-based partitioning
  // Each spatial worker owns specific rows (cellY % workerCount === workerId) and rebuilds only its own rows.
  // This eliminates all race conditions without synchronization overhead.
  // See spatial_worker.js rebuildOwnedRows() for the new implementation.

  /**
   * Update all active particles
   * Called every frame by the game loop
   *
   * BLOOD DECALS: Particles with stayOnTheFloor=1 are collected during
   * the physics loop, then stamped all at once after the loop finishes.
   * This batching improves cache locality for SAB writes.
   *
   * NOTE: Grid rebuilding is now handled by spatial workers using row-based partitioning.
   * Each spatial worker owns specific rows (cellY % workerCount === workerId) and
   * rebuilds only its own rows. This eliminates all race conditions without any
   * synchronization overhead.
   */
  update(deltaTime, dtRatio) {
    if (this.maxParticles === 0 && this.globalEntityCount === 0) return;

    // Note: Debug raycast clearing is now handled by pixi_worker at start of render frame

    // OPTIMIZATION: Active entity list and query results are now maintained incrementally
    // by spawn() and despawn() in gameObject.js. This eliminates the O(N) per-frame scan.
    // The old buildActiveEntityList() and populateQueryResults() calls are no longer needed.
    //
    // See: GameObject._addToActiveEntities(), GameObject._removeFromActiveEntities(),
    //      GameObject._addToMatchingQueries(), GameObject._removeFromMatchingQueries()

    // NOTE: Grid rebuilding moved to spatial workers (row-based partitioning)
    // Each spatial worker now rebuilds its own rows, eliminating race conditions
    // without any synchronization. See spatial_worker.js rebuildOwnedRows().

    // Reset render queue collector for this frame
    this._renderableCount = 0;

    // Build active particle list - optimize physics by skipping inactive particles
    this.buildActiveParticleList();

    // Reset stats counters for this frame
    this.particlesStampedThisFrame = 0;
    this.flashesUpdatedThisFrame = 0;
    this.shadowsUpdatedThisFrame = 0;

    // Clear stamp collection for this frame
    this.clearParticleStampList();

    // Calculate camera bounds for screen visibility checks
    const cameraBounds = this.calculateCameraBounds();

    // Run particle physics and collect particles to stamp
    // Also collects visible particles for render queue
    const activeCount = this.updateParticlePhysics(deltaTime, dtRatio, cameraBounds);

    // Stamp collected particles onto blood decal tiles
    this.stampCollectedParticles();

    // Update lighting tints for all active particles
    // this.updateParticleLighting();

    // Update lighting tints for all visible game entities
    // this.updateEntityLighting();

    this.updateFlashes(deltaTime);

    // Update screen visibility for all game entities BEFORE shadows
    // Also collects visible entities for render queue
    this.updateEntityScreenVisibility();

    // Build shadow render queue (light gradients + shadows, pre-sorted for pixi_worker)
    this.buildShadowRenderQueue();

    // Update derived properties (speed, velocityAngle) for RigidBody entities
    this.updateDerivedProperties();

    // Update cell sleeping states based on entity sleeping/static states
    this.updateCellSleepingStates();

    // Update screen visibility for all decorations
    // Also collects visible decorations for render queue
    this.updateDecorationScreenVisibility(cameraBounds);

    // Build the final render queue (sorts by Y, applies interpolation, writes to SAB)
    this.buildRenderQueue(deltaTime, this.interpolationAlpha);

    // Store for FPS reporting
    this.activeParticleCount = activeCount;
  }

  /**
   * Update all active flashes
   * Decreases intensity over lifespan, despawns when expired
   * Flashes use LightEmitter for rendering - intensity decay makes them fade out
   * @param {number} deltaTime - Frame time in milliseconds
   */
  updateFlashes(deltaTime) {
    if (!this.flashesEnabled || this.maxFlashes === 0) return;

    // Cache component arrays for performance
    const flashActive = FlashComponent.active;
    const lifespan = FlashComponent.lifespan;
    const currentLife = FlashComponent.currentLife;
    const initialIntensity = FlashComponent.initialIntensity;

    const transformActive = Transform.active;
    const lightActive = LightEmitter.active;
    const lightIntensity = LightEmitter.lightIntensity;
    const sqrtLightIntensity = LightEmitter.sqrtLightIntensity; // OPTIMIZED: Pre-calculated sqrt(intensity)

    const startIndex = this.flashStartIndex;
    const endIndex = startIndex + this.maxFlashes;

    let flashesUpdated = 0;

    // Update all flashes in the pool
    for (let entityIndex = startIndex; entityIndex < endIndex; entityIndex++) {
      // FlashComponent uses entity index directly (dense allocation)
      if (!flashActive[entityIndex]) continue;
      if (!transformActive[entityIndex]) continue;

      flashesUpdated++;

      // Update lifetime
      currentLife[entityIndex] += deltaTime;

      // Calculate remaining life ratio (1.0 -> 0.0)
      const remaining = 1 - currentLife[entityIndex] / lifespan[entityIndex];

      if (remaining <= 0) {
        // Flash expired - deactivate it
        flashActive[entityIndex] = 0;
        lightActive[entityIndex] = 0;
        transformActive[entityIndex] = 0;

        // Note: We can't return to free list from worker
        // The free list is managed by GameObject.spawn() in logic worker
        // However, since Flash.create() scans for inactive slots,
        // setting active = 0 is sufficient for reuse
      } else {
        // Update light intensity based on remaining life
        // Linear fade from initialIntensity to 0
        const newIntensity = initialIntensity[entityIndex] * remaining;
        lightIntensity[entityIndex] = newIntensity;
        // OPTIMIZED: Also update cached sqrt(intensity) to avoid recalculating every frame
        sqrtLightIntensity[entityIndex] = Math.sqrt(newIntensity);
      }
    }

    // Track flashes updated for stats
    this.flashesUpdatedThisFrame = flashesUpdated;
  }

  /**
   * Clear the list of particles to stamp this frame
   * Reuses array to avoid allocations
   */
  clearParticleStampList() {
    this.particlesToStampCount = 0;
  }

  /**
   * Calculate camera viewport bounds for screen visibility checks
   * GC OPTIMIZED: Reuses cached _cameraBounds object to avoid per-frame allocations
   * @returns {Object|null} Camera bounds object or null if no camera
   */
  calculateCameraBounds() {
    if (this.cameraData === null) return null;

    // Read camera data: [zoom, cameraX, cameraY]
    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];

    // Pre-calculate all bounds once
    const cameraOffsetX = cameraX * zoom;
    const cameraOffsetY = cameraY * zoom;
    const marginX = this.canvasWidth * this.cullingRatio;
    const marginY = this.canvasHeight * this.cullingRatio;

    // GC OPTIMIZATION: Reuse cached object instead of creating new one each frame
    const bounds = this._cameraBounds;
    bounds.zoom = zoom;
    bounds.cameraOffsetX = cameraOffsetX;
    bounds.cameraOffsetY = cameraOffsetY;
    bounds.minX = -marginX;
    bounds.maxX = this.canvasWidth + marginX;
    bounds.minY = -marginY;
    bounds.maxY = this.canvasHeight + marginY;

    return bounds;
  }

  /**
   * Update particle physics: positions, velocities, lifetimes, ground collision
   * Collects particles that hit the floor for stamping
   * @param {number} deltaTime - Frame time in milliseconds
   * @param {number} dtRatio - Delta time ratio for frame-rate independence
   * @param {Object|null} cameraBounds - Camera bounds for screen visibility
   * @returns {number} Count of active particles
   */
  updateParticlePhysics(deltaTime, dtRatio, cameraBounds) {
    if (this.maxParticles === 0) return 0;

    // Cache array references for performance
    const active = ParticleComponent.active;
    const x = ParticleComponent.x;
    const y = ParticleComponent.y;
    const z = ParticleComponent.z;
    const vx = ParticleComponent.vx;
    const vy = ParticleComponent.vy;
    const vz = ParticleComponent.vz;
    const lifespan = ParticleComponent.lifespan;
    const currentLife = ParticleComponent.currentLife;
    const gravity = ParticleComponent.gravity;
    const alpha = ParticleComponent.alpha;
    const fadeOnTheFloor = ParticleComponent.fadeOnTheFloor;
    const timeOnFloor = ParticleComponent.timeOnFloor;
    const initialAlpha = ParticleComponent.initialAlpha;
    const isItOnScreen = ParticleComponent.isItOnScreen;
    const stayOnTheFloor = ParticleComponent.stayOnTheFloor;
    const despawnOnGroundContact = ParticleComponent.despawnOnGroundContact;
    const tweenToAlpha0 = ParticleComponent.tweenToAlpha0;

    let activeCount = 0;

    // Update all active particles using compact list
    const activeIndices = this.activeParticleIndices;
    const count = this.activeParticleCount;

    // Hoist camera bounds properties to avoid object lookups in loop
    let camZoom = 1;
    let camOffX = 0;
    let camOffY = 0;
    let camMinX = 0;
    let camMaxX = 0;
    let camMinY = 0;
    let camMaxY = 0;
    const hasCamera = !!cameraBounds;

    if (hasCamera) {
      camZoom = cameraBounds.zoom;
      camOffX = cameraBounds.cameraOffsetX;
      camOffY = cameraBounds.cameraOffsetY;
      camMinX = cameraBounds.minX;
      camMaxX = cameraBounds.maxX;
      camMinY = cameraBounds.minY;
      camMaxY = cameraBounds.maxY;
    }

    for (let idx = 0; idx < count; idx++) {
      const i = activeIndices[idx];

      // Note: active[i] check is redundant since list only contains active particles
      // but we keep it implicitly by how list is built.
      // Need to be careful: if particle dies during this loop, active[i] becomes 0
      // but subsequent logic handles it by 'continue' or just setting active=0.

      // Update lifetime
      currentLife[i] += deltaTime;

      // Check if particle expired
      if (currentLife[i] >= lifespan[i]) {
        active[i] = 0;
        ParticleEmitter.returnToPool(i);
        continue;
      }

      // Alpha tweening: linearly fade from initial alpha to 0 over lifespan
      if (tweenToAlpha0[i]) {
        const lifeProgress = currentLife[i] / lifespan[i];
        alpha[i] = initialAlpha[i] * (1 - lifeProgress);
      }

      // Apply gravity to vertical velocity (z-axis)
      vz[i] += gravity[i] * dtRatio;

      // Ground collision - particles can't go below ground (z > 0)
      if (z[i] < 0) {
        // In the air - normal physics
        x[i] += vx[i] * dtRatio;
        y[i] += vy[i] * dtRatio;
        z[i] += vz[i] * dtRatio;
      } else {
        // On the floor - stop movement
        z[i] = 0;
        vx[i] = 0;
        vy[i] = 0;
        vz[i] = 0;

        // If despawnOnGroundContact is enabled, despawn immediately (no decal)
        if (despawnOnGroundContact[i]) {
          active[i] = 0;
          ParticleEmitter.returnToPool(i);
          continue;
        }

        // If stayOnTheFloor is enabled, collect particle for stamping
        if (stayOnTheFloor[i]) {
          if (this.decalsEnabled) {
            this.particlesToStamp[this.particlesToStampCount++] = i;
          }
          active[i] = 0;
          ParticleEmitter.returnToPool(i);
          // Note: we don't decrement activeCount here because it's just a return value
          // and the list index iteration continues. The particle is marked inactive.
          continue;
        }

        // Handle fade on floor (only if not stamping)
        if (fadeOnTheFloor[i] > 0) {
          if (timeOnFloor[i] === 0) {
            initialAlpha[i] = alpha[i];
          }

          timeOnFloor[i] += deltaTime;
          const fadeProgress = Math.min(timeOnFloor[i] / fadeOnTheFloor[i], 1);
          alpha[i] = initialAlpha[i] * (1 - fadeProgress);

          if (alpha[i] <= 0) {
            active[i] = 0;
            ParticleEmitter.returnToPool(i);
            continue;
          }
        }
      }

      // Update screen visibility for this particle
      if (hasCamera) {
        const screenX = x[i] * camZoom - camOffX;
        const screenY = y[i] * camZoom - camOffY;

        const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;
        isItOnScreen[i] = onScreen ? 1 : 0;

        // Collect for render queue if visible
        if (onScreen) {
          this.collectRenderable(1, i, y[i]); // type=1 for particle
        }
      }

      activeCount++;
    }

    return activeCount;
  }

  /**
   * Stamp all collected particles onto blood decal tiles
   * Batching improves cache locality for tile writes
   */
  stampCollectedParticles() {
    if (this.particlesToStampCount === 0 || !this.decalsEnabled) return;

    const particleX = ParticleComponent.x;
    const particleY = ParticleComponent.y;
    const particleTint = ParticleComponent.tint;
    const particleScaleX = ParticleComponent.scaleX;
    const particleScaleY = ParticleComponent.scaleY;
    const particleTextureId = ParticleComponent.textureId;
    const particleAlpha = ParticleComponent.alpha;
    const particleBlendMode = ParticleComponent.blendMode;

    for (let i = 0; i < this.particlesToStampCount; i++) {
      const particleIndex = this.particlesToStamp[i];

      this.stampParticleToTile(
        particleX[particleIndex],
        particleY[particleIndex],
        particleTint[particleIndex],
        particleScaleX[particleIndex],
        particleScaleY[particleIndex],
        particleTextureId[particleIndex],
        particleAlpha[particleIndex],
        particleBlendMode[particleIndex]
      );
    }

    // Track stamped particles for stats
    this.particlesStampedThisFrame = this.particlesToStampCount;
  }

  /**
   * Stamp a particle's texture onto the blood decal tilemap
   * Supports multi-tile stamping for decals larger than tile size
   * Handles both NORMAL (alpha over) and MULTIPLY blend modes
   *
   * OPTIMIZATION: blendMode branches inside inner loop - branch predictor learns
   * the constant pattern quickly since blendMode is fixed per particle call.
   *
   * @param {number} worldX - World X position of the particle
   * @param {number} worldY - World Y position of the particle
   * @param {number} tint - Color tint (0xRRGGBB)
   * @param {number} scaleX - Particle horizontal scale (affects stamp width)
   * @param {number} scaleY - Particle vertical scale (affects stamp height)
   * @param {number} textureId - Index into decalTextures map
   * @param {number} alpha - Particle alpha at time of stamping (0-1)
   * @param {number} blendMode - 0 = normal (alpha over), 1 = multiply (darken)
   */
  stampParticleToTile(worldX, worldY, tint, scaleX, scaleY, textureId, alpha, blendMode) {
    // Get texture data for this particle
    const texture = this.decalTextures[textureId];

    if (!texture) {
      // No texture data available for this textureId
      return;
    }

    // Cache frequently accessed values
    const tileSize = this.decalsTileSize;
    const tilePixelSize = this.decalsTilePixelSize;
    const tilesX = this.decalsTilesX;
    const tilesY = this.decalsTilesY;
    const bloodTiles = this.bloodTilesRGBA;
    const textureRgba = texture.rgba;
    const texWidth = texture.width;
    const texHeight = texture.height;

    // Calculate scaled texture dimensions in world units
    const scaledWidthWorld = texture.width * scaleX;
    const scaledHeightWorld = texture.height * scaleY;
    const halfWidthWorld = scaledWidthWorld / 2;
    const halfHeightWorld = scaledHeightWorld / 2;

    // Calculate scaled dimensions in pixels (for UV sampling)
    const resolution = this.decalsResolution;
    const scaledWidthPixels = (scaledWidthWorld * resolution + 0.999) | 0;
    const scaledHeightPixels = (scaledHeightWorld * resolution + 0.999) | 0;

    // Calculate which tiles this decal touches
    calculateDecalTileBounds(
      worldX,
      worldY,
      halfWidthWorld,
      halfHeightWorld,
      tileSize,
      tilesX,
      tilesY,
      _decalTileBounds
    );

    if (!_decalTileBounds.valid) {
      return; // Decal is completely outside world bounds
    }

    // Extract RGB from tint (0xRRGGBB) - do once, not per-tile
    const tintR = (tint >> 16) & 0xff;
    const tintG = (tint >> 8) & 0xff;
    const tintB = tint & 0xff;

    // Pre-calculate UV mapping constants
    const invScaledWidth = texWidth / scaledWidthPixels;
    const invScaledHeight = texHeight / scaledHeightPixels;

    // Iterate over all affected tiles
    for (let ty = _decalTileBounds.minTileY; ty <= _decalTileBounds.maxTileY; ty++) {
      for (let tx = _decalTileBounds.minTileX; tx <= _decalTileBounds.maxTileX; tx++) {
        // Calculate clip region for this tile
        calculateTileClipRegion(
          worldX,
          worldY,
          halfWidthWorld,
          halfHeightWorld,
          tx,
          ty,
          tileSize,
          tilePixelSize,
          texWidth,
          texHeight,
          scaledWidthPixels,
          scaledHeightPixels,
          _tileClipRegion
        );

        if (!_tileClipRegion.valid) continue;

        const tileIndex = tx + ty * tilesX;
        const tileByteOffset = tileIndex * tilePixelSize * tilePixelSize * 4;

        // Destination pixel bounds (clamped to tile)
        const dstStartX = _tileClipRegion.dstStartX;
        const dstStartY = _tileClipRegion.dstStartY;
        const dstEndX = _tileClipRegion.dstEndX;
        const dstEndY = _tileClipRegion.dstEndY;

        // Source texture offset (where to start sampling in scaled coordinates)
        const srcOffsetX = _tileClipRegion.srcOffsetX;
        const srcOffsetY = _tileClipRegion.srcOffsetY;
        const uvScaleX = _tileClipRegion.uvScaleX;
        const uvScaleY = _tileClipRegion.uvScaleY;

        // Stamp only the clipped region - no wasted iterations!
        for (let dstY = dstStartY; dstY < dstEndY; dstY++) {
          // Calculate source Y in scaled texture coordinates
          const srcScaledY = srcOffsetY + (dstY - dstStartY) * uvScaleY;
          const srcY = (srcScaledY * invScaledHeight) | 0;

          // Bounds check source Y
          if (srcY < 0 || srcY >= texHeight) continue;

          const srcRowOffset = srcY * texWidth;
          const dstRowOffset = tileByteOffset + dstY * tilePixelSize * 4;

          for (let dstX = dstStartX; dstX < dstEndX; dstX++) {
            // Calculate source X in scaled texture coordinates
            const srcScaledX = srcOffsetX + (dstX - dstStartX) * uvScaleX;
            const srcX = (srcScaledX * invScaledWidth) | 0;

            // Bounds check source X
            if (srcX < 0 || srcX >= texWidth) continue;

            // Sample from source texture (nearest-neighbor)
            const srcOffset = (srcRowOffset + srcX) * 4;
            const texAlpha = textureRgba[srcOffset + 3];

            // Skip fully transparent pixels (common to both blend modes)
            if (texAlpha < 1) continue;

            // Get source RGB
            const srcR = textureRgba[srcOffset];
            const srcG = textureRgba[srcOffset + 1];
            const srcB = textureRgba[srcOffset + 2];

            // Calculate destination offset in tile buffer
            const dstOffset = dstRowOffset + dstX * 4;

            // Branch on blend mode - predictor learns pattern since blendMode is constant per call
            if (blendMode === 1) {
              // ========================================
              // MULTIPLY BLEND: darkness of source = opacity of darkening effect
              // ========================================
              // Apply tint to source color
              const tintedR = (srcR * tintR + 127) >> 8;
              const tintedG = (srcG * tintG + 127) >> 8;
              const tintedB = (srcB * tintB + 127) >> 8;

              // Calculate luminance (0-255): white=255, black=0
              const luminance = (tintedR * 77 + tintedG * 150 + tintedB * 29) >> 8;

              // Darkness = inverse luminance: white=0 (invisible), black=255 (full darken)
              const darkness = 255 - luminance;

              // Effective alpha = texture alpha * particle alpha * darkness
              const effectiveAlpha = (((texAlpha * darkness) >> 8) * alpha) | 0;

              // Skip light pixels (effectively transparent in multiply)
              if (effectiveAlpha < 2) continue;

              // Integer-only alpha blending: dst * (255 - alpha) / 255
              const invEffectiveAlpha = 255 - effectiveAlpha;
              const dstR = bloodTiles[dstOffset];
              const dstG = bloodTiles[dstOffset + 1];
              const dstB = bloodTiles[dstOffset + 2];
              const dstA = bloodTiles[dstOffset + 3];

              // Blend black (0) with existing content
              bloodTiles[dstOffset] = (dstR * invEffectiveAlpha + 127) >> 8;
              bloodTiles[dstOffset + 1] = (dstG * invEffectiveAlpha + 127) >> 8;
              bloodTiles[dstOffset + 2] = (dstB * invEffectiveAlpha + 127) >> 8;
              bloodTiles[dstOffset + 3] = effectiveAlpha + ((dstA * invEffectiveAlpha + 127) >> 8);
            } else {
              // ========================================
              // NORMAL BLEND (alpha over)
              // ========================================
              const srcA = (texAlpha * alpha) | 0; // 0-255 range

              // Skip nearly transparent pixels
              if (srcA < 1) continue;

              // Apply tint to source color
              const finalR = (srcR * tintR + 127) >> 8;
              const finalG = (srcG * tintG + 127) >> 8;
              const finalB = (srcB * tintB + 127) >> 8;

              // Integer-only alpha blending: dst + ((src - dst) * alpha + 127) >> 8
              const invSrcA = 255 - srcA;
              const dstR = bloodTiles[dstOffset];
              const dstG = bloodTiles[dstOffset + 1];
              const dstB = bloodTiles[dstOffset + 2];
              const dstA = bloodTiles[dstOffset + 3];

              // Blend colors
              bloodTiles[dstOffset] = dstR + (((finalR - dstR) * srcA + 127) >> 8);
              bloodTiles[dstOffset + 1] = dstG + (((finalG - dstG) * srcA + 127) >> 8);
              bloodTiles[dstOffset + 2] = dstB + (((finalB - dstB) * srcA + 127) >> 8);
              // Alpha: combine using "over" operator
              bloodTiles[dstOffset + 3] = srcA + ((dstA * invSrcA + 127) >> 8);
            }
          }
        }

        // Mark tile as dirty so pixi_worker updates its texture
        this.bloodTilesDirty[tileIndex] = 1;
      }
    }
  }

  /**
   * Build shadow render queue with light gradients and shadows
   * Order: light1_gradient, light1_shadows..., light2_gradient, light2_shadows...
   * This pre-sorted queue is consumed directly by pixi_worker (no additional sorting needed)
   */
  buildShadowRenderQueue() {
    if (!this.shadowsEnabled || !this.shadowRenderQueueCount) {
      if (this.shadowRenderQueueCount) this.shadowRenderQueueCount[0] = 0;
      return;
    }

    // Cache Grid data and metadata
    const neighborData = Grid.neighborData;
    const stride = Grid._stride;

    // Check if we have precomputed distances from Grid (spatial worker)
    if (!neighborData || Grid.maxNeighbors <= 0) {
      this.shadowRenderQueueCount[0] = 0;
      return;
    }

    // Cache component arrays
    const worldX = Transform.x;
    const worldY = Transform.y;
    const transformActive = Transform.active;
    const lightEnabled = LightEmitter.active;
    const lightIntensity = LightEmitter.lightIntensity;
    const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;
    const lightHeight = LightEmitter.height;
    const lightColor = LightEmitter.lightColor;
    const shadowCasterActive = ShadowCaster.active;
    const entityShadowRadius = ShadowCaster.shadowRadius;
    const entityShadowHeight = ShadowCaster.height;
    const flashActive = FlashComponent.active;

    // Per-entity shadow limit tracking
    const maxShadowsPerEntity = this.maxShadowsPerEntity;
    const entityShadowCounts = this._entityShadowCounts;
    if (maxShadowsPerEntity > 0 && entityShadowCounts) {
      entityShadowCounts.fill(0);
    }

    // Output arrays
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

    // Entity texture lookup for shadow textures
    const entityLastTextureId = this.entityLastTextureId;

    // Light gradient texture ID (from bigAtlas)
    // Use animationNameToIndex to get the animation index, then animationFrameStart for texture ID
    const lightGradientAnimIdx = this.animationNameToIndex?.['_lightGradient'] ?? 0;
    const lightGradientTextureId = this.animationFrameStart?.[lightGradientAnimIdx] ?? 0;

    let writeIdx = 0;
    let lightsProcessed = 0;
    const maxItems = this.maxShadowRenderItems;
    const maxShadowSprites = this.maxShadowSprites;
    const PI = Math.PI;

    // Track shadow count for stats
    let shadowCount = 0;

    // Compute world-space viewport bounds for shadow culling
    // Shadows should be visible if any part appears on screen, not just if the caster is on screen
    const zoom = this.cameraData ? this.cameraData[0] : 1;
    const camX = this.cameraData ? this.cameraData[1] : 0;
    const camY = this.cameraData ? this.cameraData[2] : 0;
    const camOffsetX = camX * zoom;
    const camOffsetY = camY * zoom;
    const invZoom = 1 / zoom;
    const cullMarginX = this.canvasWidth * this.cullingRatio;
    const cullMarginY = this.canvasHeight * this.cullingRatio;
    const viewMinX = (-cullMarginX + camOffsetX) * invZoom;
    const viewMaxX = (this.canvasWidth + cullMarginX + camOffsetX) * invZoom;
    const viewMinY = (-cullMarginY + camOffsetY) * invZoom;
    const viewMaxY = (this.canvasHeight + cullMarginY + camOffsetY) * invZoom;

    // OPTIMIZED: Query only active entities with LightEmitter
    const lightEntities = this.queryActiveEntities([LightEmitter]);

    // For each LIGHT, add light gradient then its shadows
    for (let i = 0; i < lightEntities.length; i++) {
      if (writeIdx >= maxItems) break;
      if (lightsProcessed >= this.maxShadowCastingLights) break;

      const lightIdx = lightEntities[i];
      if (!lightEnabled[lightIdx]) continue;

      const isFlash = flashActive[lightIdx] === 1;
      const intensity = lightIntensity[lightIdx];
      if (intensity <= 0) continue;

      // Collect shadows for this light first (we need to know if there are any)
      const lightX = worldX[lightIdx];
      const lightY = worldY[lightIdx];
      const lightH = lightHeight[lightIdx] || 0;

      // Check if light's influence area reaches the viewport
      // A light off-screen can still cast visible shadows on entities near the viewport edge
      // sqrt(intensity) * 10 is a generous world-space radius covering gradient + shadow reach
      if (!isFlash) {
        const lightInfluenceRadius = sqrtLightIntensity[lightIdx] * 10;
        if (lightX + lightInfluenceRadius < viewMinX || lightX - lightInfluenceRadius > viewMaxX ||
          lightY + lightInfluenceRadius < viewMinY || lightY - lightInfluenceRadius > viewMaxY) continue;
      }

      // Get neighbors of this light
      const offset = lightIdx * stride;
      const neighborCountForLight = neighborData[offset];

      // Temporary collection for this light's shadows
      const shadowStartIdx = writeIdx + 1; // Reserve slot 0 for light gradient
      let shadowsForThisLight = 0;

      for (let k = 0; k < neighborCountForLight; k++) {
        if (shadowsForThisLight >= this.maxShadowsPerLight) break;
        if (shadowCount >= maxShadowSprites) break;
        if (writeIdx + 1 + shadowsForThisLight >= maxItems) break;

        const neighborIdx = neighborData[offset + 2 + k];

        // Skip if not a shadow caster or inactive
        if (!shadowCasterActive[neighborIdx] || !transformActive[neighborIdx]) continue;

        // Per-entity shadow limit
        if (maxShadowsPerEntity > 0 && entityShadowCounts[neighborIdx] >= maxShadowsPerEntity) continue;

        // Calculate distance
        const lightXWithOffset = Transform.x[lightIdx] + (Collider.offsetX[lightIdx] || 0);
        const lightYWithOffset = Transform.y[lightIdx] + (Collider.offsetY[lightIdx] || 0);
        const neighborX = Transform.x[neighborIdx] + (Collider.offsetX[neighborIdx] || 0);
        const neighborY = Transform.y[neighborIdx] + (Collider.offsetY[neighborIdx] || 0);
        const dx = neighborX - lightXWithOffset;
        const dy = neighborY - lightYWithOffset;
        const distSq = dx * dx + dy * dy;

        if (distSq < 1) continue;

        // Calculate shadow properties
        const casterX = worldX[neighborIdx];
        const casterY = worldY[neighborIdx];
        let casterRadius = entityShadowRadius[neighborIdx];
        if (Number.isNaN(casterRadius) || casterRadius <= 0) casterRadius = 10;
        const casterHeight = entityShadowHeight[neighborIdx] || casterRadius;

        const dist = Math.sqrt(distSq);
        const invDist = 1 / dist;
        const dirX = dx * invDist;
        const dirY = dy * invDist;

        // Shadow position
        const posX = casterX - dirX * casterRadius * 0.5;
        const posY = casterY - dirY * casterRadius * 0.5;

        if (Number.isNaN(posX) || Number.isNaN(posY)) continue;

        // Shadow scale
        const distRatio = dist * 0.00390625; // 1/256
        const clampedDistRatio = distRatio > 1 ? 1 : distRatio;
        const heightFactor = casterHeight * 0.025;
        const lengthScale = (0.3 + clampedDistRatio * 0.9) * heightFactor;
        const widthScale = 1;

        // Cull shadow by its actual world position instead of caster's screen status
        // This ensures shadows are visible whenever any part appears on screen
        // Use casterHeight (visual height) as the base extent, not casterRadius (collider size)
        const shadowExtent = casterHeight * (1 + lengthScale);
        if (posX + shadowExtent < viewMinX || posX - shadowExtent > viewMaxX ||
          posY + shadowExtent < viewMinY || posY - shadowExtent > viewMaxY) continue;

        // Alpha and angle
        let alpha = intensity / (intensity + distSq);
        if (Number.isNaN(alpha)) alpha = 0;
        if (alpha > 1) alpha = 1;
        if (alpha < 0) alpha = 0;
        alpha *= 0.33;

        const angle = Math.atan2(dy, dx);

        // Get entity's current texture for shadow
        const textureId = entityLastTextureId ? entityLastTextureId[neighborIdx] : 0;

        // Write shadow to queue
        const idx = shadowStartIdx + shadowsForThisLight;
        rqX[idx] = posX;
        rqY[idx] = posY;
        rqScaleX[idx] = widthScale;
        rqScaleY[idx] = lengthScale;
        rqRotation[idx] = angle - 1.5707963267948966 + PI; // PI/2 + PI (point away from light)
        rqAlpha[idx] = alpha;
        rqTint[idx] = 0x000000; // Black shadows
        rqTextureId[idx] = textureId;
        rqAnchorX[idx] = 0.5;
        rqAnchorY[idx] = 1.0; // Bottom anchor for shadows

        shadowsForThisLight++;
        shadowCount++;
        if (maxShadowsPerEntity > 0) entityShadowCounts[neighborIdx]++;
      }

      // Only add light gradient if there are shadows for this light
      if (shadowsForThisLight > 0) {
        lightsProcessed++;

        // Write light gradient FIRST (before its shadows in the queue)
        const gradientScale = 10 * sqrtLightIntensity[lightIdx] * 3 / 100; // Match pixi_worker formula
        const gradientAlpha = intensity / 50000;

        rqX[writeIdx] = lightX;
        rqY[writeIdx] = lightY - lightH;
        rqScaleX[writeIdx] = gradientScale;
        rqScaleY[writeIdx] = gradientScale;
        rqRotation[writeIdx] = 0;
        rqAlpha[writeIdx] = gradientAlpha;
        rqTint[writeIdx] = 0xFFFFFF; // White light gradient
        rqTextureId[writeIdx] = lightGradientTextureId;
        rqAnchorX[writeIdx] = 0.5;
        rqAnchorY[writeIdx] = 0.5; // Center anchor for light gradients

        // Move write index past light gradient + all its shadows
        writeIdx = shadowStartIdx + shadowsForThisLight;
      }
    }

    // Write count
    this.shadowRenderQueueCount[0] = writeIdx;

    // Track shadows updated for stats
    this.shadowsUpdatedThisFrame = shadowCount;
  }

  /**
   * Update isItOnScreen property for all game entities
   * OPTIMIZED: Uses spatial grid to only check entities in visible cells
   * Moved from spatial_worker to balance workload
   */
  updateEntityScreenVisibility() {

    if (!this.cameraData || this.globalEntityCount === 0 || !SpriteRenderer.isItOnScreen)
      return console.warn('PARTICLE WORKER: No camera data or entity count');

    const x = Transform.x;
    const y = Transform.y;
    const active = Transform.active;
    const isItOnScreen = SpriteRenderer.isItOnScreen;
    const screenX = SpriteRenderer.screenX;
    const screenY = SpriteRenderer.screenY;
    const spriteRendererActive = SpriteRenderer.active;

    // Read camera data: [zoom, cameraX, cameraY]
    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];

    // Pre-calculate screen bounds (with culling margin)
    const cameraOffsetX = cameraX * zoom;
    const cameraOffsetY = cameraY * zoom;
    const marginX = this.canvasWidth * this.cullingRatio;
    const marginY = this.canvasHeight * this.cullingRatio;
    const screenMinX = -marginX;
    const screenMaxX = this.canvasWidth + marginX;
    const screenMinY = -marginY;
    const screenMaxY = this.canvasHeight + marginY;

    // Convert screen bounds to world bounds for grid query
    // Formula: screenX = worldX * zoom - cameraOffsetX
    // Therefore: worldX = (screenX + cameraOffsetX) / zoom
    const invZoom = 1 / zoom;

    // Add safety margin for large entities that span multiple cells
    // Entities are registered in ALL cells they occupy (based on collider bounds)
    // If ANY of those cells is in this query rect, the entity will be found
    // We add 2 cells margin to handle entities up to ~4 cells wide/tall
    const cellMargin = Grid.cellSize * 2;
    const worldMinX = (screenMinX + cameraOffsetX) * invZoom - cellMargin;
    const worldMaxX = (screenMaxX + cameraOffsetX) * invZoom + cellMargin;
    const worldMinY = (screenMinY + cameraOffsetY) * invZoom - cellMargin;
    const worldMaxY = (screenMaxY + cameraOffsetY) * invZoom + cellMargin;

    // Verify Grid is initialized - fail loudly if not
    if (Grid.cellSize <= 0 || Grid.gridWidth <= 0) {
      console.error(`[PARTICLE_WORKER] Grid NOT initialized! cellSize=${Grid.cellSize}, gridWidth=${Grid.gridWidth}`);
      return;
    }

    // OPTIMIZATION: Query grid for entities in visible world rectangle
    // This only checks entities in cells that intersect the viewport
    this._gridQueryResult = Grid.getEntitiesInRect(worldMinX, worldMinY, worldMaxX, worldMaxY);

    // Iterate only entities in visible cells
    for (let idx = 0; idx < this._gridQueryResult.count; idx++) {
      const i = this._gridQueryResult.entities[idx];

      // Skip inactive entities
      if (!active[i]) {
        if (isItOnScreen[i] !== 0) {
          isItOnScreen[i] = 0;
        }
        continue;
      }

      // Skip entities without SpriteRenderer
      if (!spriteRendererActive || !spriteRendererActive[i]) {
        continue;
      }

      // Transform world coordinates to screen coordinates
      const sx = x[i] * zoom - cameraOffsetX;
      const sy = y[i] * zoom - cameraOffsetY;
      screenX[i] = sx;
      screenY[i] = sy;

      // Check if screen position is within viewport bounds (with margin)
      const onScreen = sx >= screenMinX && sx <= screenMaxX && sy >= screenMinY && sy <= screenMaxY;
      isItOnScreen[i] = onScreen ? 1 : 0;

      // Collect for render queue if visible AND renderVisible
      if (onScreen && SpriteRenderer.renderVisible[i]) {
        this.collectRenderable(0, i, y[i]); // type=0 for entity
      }

      // Collect light glow as separate renderable (type=3) if entity has a glow sprite
      // Sorted at y+1 so it renders just above the entity in depth order
      if (onScreen && LightEmitter.active[i] && LightEmitter.hasGlowSprite[i]) {
        this.collectRenderable(3, i, y[i] + 10); // type=3 for light glow
      }
    }

  }

  /**
   * Update isItOnScreen property for all decorations
   * Decorations are static, so we just need to check screen visibility
   * @param {Object|null} cameraBounds - Pre-calculated camera bounds (from particle physics)
   */
  updateDecorationScreenVisibility(cameraBounds) {
    if (!this.maxDecorations || this.maxDecorations === 0 || !DecorationComponent.active) return;

    // Precompute sway base angle once per frame (not per decoration)
    this._swayBaseAngle = this.accumulatedTime * 0.002;

    // Calculate expected active count from free list for early exit optimization
    // activeCount = maxDecorations - freeSlots
    const freeListTop = DecorationPool.freeListTop;
    const expectedActive = freeListTop ? this.maxDecorations - freeListTop[0] : this.maxDecorations;

    // Early exit if no decorations are active
    if (expectedActive === 0) {
      return;
    }

    const active = DecorationComponent.active;
    const x = DecorationComponent.x;
    const y = DecorationComponent.y;
    const isItOnScreen = DecorationComponent.isItOnScreen;
    const sway = DecorationComponent.sway;
    const swayAmplitude = DecorationComponent.swayAmplitude;
    const swayFrequency = DecorationComponent.swayFrequency;
    const rotation = DecorationComponent.rotation;
    const baseRotation = DecorationComponent.baseRotation;

    // Use cameraBounds if provided, otherwise calculate from cameraData
    let zoom, cameraOffsetX, cameraOffsetY, minX, maxX, minY, maxY;

    if (cameraBounds) {
      zoom = cameraBounds.zoom;
      cameraOffsetX = cameraBounds.cameraOffsetX;
      cameraOffsetY = cameraBounds.cameraOffsetY;
      minX = cameraBounds.minX;
      maxX = cameraBounds.maxX;
      minY = cameraBounds.minY;
      maxY = cameraBounds.maxY;
    } else if (this.cameraData) {
      zoom = this.cameraData[0];
      const cameraX = this.cameraData[1];
      const cameraY = this.cameraData[2];
      cameraOffsetX = cameraX * zoom;
      cameraOffsetY = cameraY * zoom;
      const marginX = this.canvasWidth * this.cullingRatio;
      const marginY = this.canvasHeight * this.cullingRatio;
      minX = -marginX;
      maxX = this.canvasWidth + marginX;
      minY = -marginY;
      maxY = this.canvasHeight + marginY;
    } else {
      return; // No camera data available
    }

    // Iterate all decoration slots, early-exit when we've found all active ones
    // (same pattern as buildActiveParticleList)
    let activeFound = 0;
    for (let i = 0; i < this.maxDecorations && activeFound < expectedActive; i++) {
      if (!active[i]) continue;
      activeFound++;

      // Transform world coordinates to screen coordinates
      const screenX = x[i] * zoom - cameraOffsetX;
      const screenY = y[i] * zoom - cameraOffsetY;

      // Check if screen position is within viewport bounds (with margin)
      const onScreen = screenX > minX && screenX < maxX && screenY > minY && screenY < maxY;
      isItOnScreen[i] = onScreen ? 1 : 0;

      // Collect for render queue if visible
      if (onScreen) {
        this.collectRenderable(2, i, y[i]); // type=2 for decoration
      }

      if (sway[i]) {
        rotation[i] = baseRotation[i] + Math.sin(this._swayBaseAngle * swayFrequency[i] + i * 0.1) * swayAmplitude[i];
      }
    }
  }

  // /**
  //  * Update derived properties from positions
  //  * Calculates speed and velocityAngle from velocity data
  //  * Moved from physics_worker to balance workload
  //  *
  //  * ENHANCED: Minimum speed threshold prevents rotation jitter when stationary
  //  * OPTIMIZED: Uses query system to iterate only entities with RigidBody
  //  */
  updateDerivedProperties() {
    if (this.rigidBodyCount === 0 || !RigidBody.vx) return;

    const active = Transform.active;
    const rigidBodyActive = RigidBody.active;
    const vx = RigidBody.vx;
    const vy = RigidBody.vy;
    const velocityAngle = RigidBody.velocityAngle;
    const speed = RigidBody.speed;
    const minSpeedForRotation = this.minSpeedForRotation;
    const sleepThreshold = this.sleepThreshold;
    const sleepDuration = this.sleepDuration;
    const sleeping = RigidBody.sleeping;
    const stillnessTime = RigidBody.stillnessTime;
    const isStatic = RigidBody.static;

    // OPTIMIZATION: Query only active entities that have RigidBody component
    // This skips inactive entities and those without physics (static decorations, etc.)
    const physicsEntities = this.queryActiveEntities([RigidBody]);

    for (let idx = 0; idx < physicsEntities.length; idx++) {
      const i = physicsEntities[idx];
      // Note: active[i] check no longer needed - queryActiveEntities already filters
      if (!rigidBodyActive[i]) continue;

      // Skip static entities (they're always "sleeping" but don't need sleep tracking)
      if (isStatic[i]) continue;

      // Velocity is already stored in vx/vy from moveBallsVerlet
      const currentSpeed = calculateSpeed(vx[i], vy[i]);
      speed[i] = currentSpeed;

      // SLEEPING DETECTION: Track stillness and put entities to sleep
      if (currentSpeed < sleepThreshold) {
        // Entity is still - increment stillness timer
        stillnessTime[i]++;

        // Put to sleep if still for long enough
        if (stillnessTime[i] >= sleepDuration) {
          sleeping[i] = 1;
        }
      }
      else {
        // Entity is moving - wake it up and reset timer
        sleeping[i] = 0;
        stillnessTime[i] = 0;
      }

      // Only update rotation if moving above minimum threshold
      // This prevents visual jitter when entities are nearly stationary
      if (currentSpeed > minSpeedForRotation) {
        velocityAngle[i] = calculateVelocityAngle(vx[i], vy[i]);
      }
    }
  }

  /**
   * Update cell sleeping states based on entity sleeping/static states
   *
   * PERFORMANCE OPTIMIZED:
   * - Only checks cells that have entities (skips empty cells)
   * - Uses direct buffer access for maximum speed
   * - Caches component array references to avoid property lookups
   * - Early exit when any awake entity is found
   *
   * LOGIC:
   * - A cell is sleeping if ALL entities in it are either:
   *   1. Have RigidBody and are sleeping (RigidBody.sleeping === 1)
   *   2. Have RigidBody and are static (RigidBody.static === 1)
   *   3. Have Collider but no RigidBody (static decorations - count as sleeping)
   * - A cell is awake if ANY entity is:
   *   1. Has RigidBody and is not sleeping and not static
   *   2. Doesn't have RigidBody or Collider (treat as awake)
   * - Empty cells are marked as awake (0)
   */
  updateCellSleepingStates() {
    // Early exit if cell sleeping buffer not initialized
    if (!Grid.cellSleepingData || Grid.totalCells === 0) return;

    // PERFORMANCE: Cache component array references locally to avoid property lookups
    // These are NOT copying data - they're caching references for faster access
    const transformActive = Transform.active;
    const rigidBodyActive = RigidBody.active;
    const colliderActive = Collider.active;
    const rigidBodySleeping = RigidBody.sleeping;
    const rigidBodyStatic = RigidBody.static;

    // PERFORMANCE: Cache grid arrays for direct access
    // Note: Accessing private static properties directly for maximum performance
    // These are safe to access as they're initialized before this method is called
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;
    const cellSleepingData = Grid.cellSleepingData;
    const cellByteSize = Grid.cellByteSize;
    const totalCells = Grid.totalCells;

    // PERFORMANCE: Early exit if grid arrays not initialized
    if (!gridCounts || !gridEntities) return;

    // Iterate through all cells
    for (let cellIndex = 0; cellIndex < totalCells; cellIndex++) {
      // PERFORMANCE: Direct buffer access - calculate byte offset once
      const byteOffset = cellIndex * cellByteSize;
      const cellCount = gridCounts[byteOffset];

      // PERFORMANCE: Skip empty cells (mark as awake, but don't write if already 0)
      if (cellCount === 0) {
        // Only write if not already awake (avoid unnecessary writes)
        if (cellSleepingData[cellIndex] !== 0) {
          cellSleepingData[cellIndex] = 0;
        }
        continue;
      }

      // PERFORMANCE: Direct buffer access for entity list
      const cellEntityBase = (byteOffset >> 2) + 1; // Uint32 offset after count

      // Check all entities in this cell
      let allEntitiesSleeping = true;

      for (let k = 0; k < cellCount; k++) {
        const entityId = gridEntities[cellEntityBase + k];

        // Skip inactive entities (they don't affect sleeping state)
        if (!transformActive[entityId]) continue;

        // Check if entity has RigidBody component
        // NOTE: active arrays are Uint8, so check for === 1 explicitly
        const hasRigidBody = rigidBodyActive && rigidBodyActive[entityId] === 1;
        const hasCollider = colliderActive && colliderActive[entityId] === 1;

        if (hasRigidBody) {
          // Entity has RigidBody - check sleeping and static states
          const isSleeping = rigidBodySleeping && rigidBodySleeping[entityId] === 1;
          const isStatic = rigidBodyStatic && rigidBodyStatic[entityId] === 1;

          // If entity is awake (not sleeping and not static), cell is awake
          if (!isSleeping && !isStatic) {
            allEntitiesSleeping = false;
            break; // PERFORMANCE: Early exit - no need to check remaining entities
          }
        } else if (hasCollider) {
          // Entity has Collider but no RigidBody (static decoration)
          // Count as sleeping for cell sleeping calculation
          // Continue checking other entities
        } else {
          // Entity has neither RigidBody nor Collider
          // Treat as awake - cell must be awake
          allEntitiesSleeping = false;
          break; // PERFORMANCE: Early exit
        }
      }

      // Write sleeping state (only if changed to avoid unnecessary writes)
      const newSleepingState = allEntitiesSleeping ? 1 : 0;
      if (cellSleepingData[cellIndex] !== newSleepingState) {
        cellSleepingData[cellIndex] = newSleepingState;
      }
    }
  }

  // ========================================
  // RENDER QUEUE BUILDING
  // ========================================

  /**
   * Collect a visible renderable for the render queue
   * Called inline during visibility checks
   * @param {number} type - 0=entity, 1=particle, 2=decoration, 3=light glow
   * @param {number} index - Index within that type's pool
   * @param {number} y - Y position for sorting
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
   * Build the final render queue from collected renderables
   * - Sorts by Y for depth ordering
   * - Applies interpolation to entity positions
   * - Advances animation frames for entities
   * - Writes all properties to render queue SAB
   * @param {number} deltaTime - Frame time in milliseconds
   * @param {number} interpolationAlpha - Lerp factor for smoothing (0-1)
   */
  buildRenderQueue(deltaTime, interpolationAlpha) {
    if (!this.renderQueueEnabled || this._renderableCount === 0) {
      if (this.renderQueueCount) this.renderQueueCount[0] = 0;
      return;
    }

    const count = this._renderableCount;
    const collector = this._renderableCollector;

    // Sort by Y (ascending for proper depth - lower Y renders first)
    // Using a simple insertion sort for small-ish arrays, or native sort for larger
    if (count > 100) {
      // For larger arrays, use native sort (optimized timsort)
      const slice = collector.slice(0, count);
      slice.sort((a, b) => a.y - b.y);
      for (let i = 0; i < count; i++) {
        collector[i] = slice[i];
      }
    } else {
      // Insertion sort for small arrays (avoids allocation)
      for (let i = 1; i < count; i++) {
        const current = collector[i];
        let j = i - 1;
        while (j >= 0 && collector[j].y > current.y) {
          collector[j + 1] = collector[j];
          j--;
        }
        collector[j + 1] = current;
      }
    }

    // Write sorted renderables to queue
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
    const rqFrameIndex = this.renderQueueFrameIndex;
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

    // Light glow component arrays
    const lightColor = LightEmitter.lightColor;
    const lightIntensity = LightEmitter.lightIntensity;
    const glowHeightOffset = LightEmitter.glowHeightOffset;
    const visualRange = Collider.visualRange;
    // Light gradient texture ID (from bigAtlas) - same lookup as shadow system
    const lightGradientAnimIdx = this.animationNameToIndex?.['_lightGradient'] ?? 0;
    const lightGradientTextureId = this.animationFrameStart?.[lightGradientAnimIdx] ?? 0;
    const GLOW_TEXTURE_RADIUS = 100; // Gradient texture base size (200px diameter)

    const decoX = DecorationComponent.x;
    const decoY = DecorationComponent.y;
    const decoScaleX = DecorationComponent.scaleX;
    const decoScaleY = DecorationComponent.scaleY;
    const decoRotation = DecorationComponent.rotation;
    const decoAlpha = DecorationComponent.alpha;
    const decoTint = DecorationComponent.tint;
    const decoTextureId = DecorationComponent.textureId;
    const decoAnchorX = DecorationComponent.anchorX;
    const decoAnchorY = DecorationComponent.anchorY;

    // Smoothed position buffers
    const smoothedX = this.smoothedX;
    const smoothedY = this.smoothedY;

    // Animation tracking
    const frameIndex = this.entityFrameIndex;
    const frameAccum = this.entityFrameAccumulator;
    const deltaSeconds = deltaTime / 1000;

    for (let i = 0; i < count; i++) {
      const entry = collector[i];
      const type = entry.type;
      const idx = entry.index;

      if (type === 0) {
        // === ENTITY ===
        // Apply interpolation: smooth towards current position
        const currX = entityX[idx];
        const currY = entityY[idx];
        // smoothedX[idx] += (currX - smoothedX[idx]) * interpolationAlpha;
        // smoothedY[idx] += (currY - smoothedY[idx]) * interpolationAlpha;

        rqX[i] = currX
        rqY[i] = currY
        rqScaleX[i] = srScaleX[idx];
        rqScaleY[i] = srScaleY[idx];
        rqRotation[i] = entityRotation[idx];
        rqAlpha[i] = srAlpha[idx];
        rqTint[i] = srTint[idx];
        rqAnchorX[i] = srAnchorX[idx];
        rqAnchorY[i] = srAnchorY[idx];

        // Write type and entityIndex for shadow system
        rqType[i] = 0; // Entity
        rqEntityIndex[i] = idx;

        // Get animation info and compute globalTextureId
        const sheetId = srSpritesheetId[idx];
        const animState = srAnimState[idx];

        // Map (sheetId, animState) → global animation index
        const proxyMap = this.proxyToGlobalAnim?.[sheetId];
        const globalAnimIdx = proxyMap ? (proxyMap[animState] ?? 0) : 0;

        // Get frame count from cached metadata (O(1), no registry lookup!)
        const animFrameCount = this.animationFrameCount?.[globalAnimIdx] ?? 1;

        // Animation frame advancement
        if (srIsAnimated[idx] && animFrameCount > 1) {
          // Accumulate time
          frameAccum[idx] += deltaSeconds;

          // Calculate frame duration (animationSpeed is in FPS)
          const frameDuration = 1 / (srAnimSpeed[idx] * 60);

          // Advance frames if needed
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

        // Compute globalTextureId (O(1) - no strings, no registry lookups!)
        const animStart = this.animationFrameStart?.[globalAnimIdx] ?? 0;
        const globalTextureId = animStart + frameIndex[idx];
        rqTextureId[i] = globalTextureId;

        // Update entity texture lookup for shadow system
        if (entityLastTextureId) {
          entityLastTextureId[idx] = globalTextureId;
        }
      } else if (type === 1) {
        // === PARTICLE ===
        // Particles update at 120fps, no interpolation needed
        rqX[i] = particleX[idx];
        rqY[i] = particleY[idx] + particleZ[idx]; // Apply Z offset for visual height
        rqScaleX[i] = particleScaleX[idx];
        rqScaleY[i] = particleScaleY[idx];
        rqRotation[i] = particleRotation[idx];
        rqAlpha[i] = particleAlpha[idx];
        rqTint[i] = particleTint[idx];
        // Particle textureId is bigAtlas animation index - convert to globalTextureId
        const pAnimIdx = particleTextureId[idx];
        rqTextureId[i] = this.animationFrameStart?.[pAnimIdx] ?? 0; // Frame 0 of animation
        rqAnchorX[i] = 0.5; // Particles always centered
        rqAnchorY[i] = 0.5;
        // Write type and entityIndex for shadow system
        rqType[i] = 1; // Particle
        rqEntityIndex[i] = -1; // Not an entity
      } else if (type === 2) {
        // === DECORATION ===
        // Decorations are static, no interpolation needed
        rqX[i] = decoX[idx];
        rqY[i] = decoY[idx];
        rqScaleX[i] = decoScaleX[idx];
        rqScaleY[i] = decoScaleY[idx];
        rqRotation[i] = decoRotation[idx];
        rqAlpha[i] = decoAlpha[idx];
        rqTint[i] = decoTint[idx];
        // Decoration textureId is bigAtlas animation index - convert to globalTextureId
        const dAnimIdx = decoTextureId[idx];
        rqTextureId[i] = this.animationFrameStart?.[dAnimIdx] ?? 0; // Frame 0 of animation
        rqAnchorX[i] = decoAnchorX[idx];
        rqAnchorY[i] = decoAnchorY[idx];
        // Write type and entityIndex for shadow system
        rqType[i] = 2; // Decoration
        rqEntityIndex[i] = -1; // Not an entity
      } else {
        // === LIGHT GLOW (type=3) ===
        // Light glow sprites: _lightGradient texture, scaled by visualRange, tinted by lightColor
        const rangeVal = visualRange[idx] || 200;
        const scale = (rangeVal * 4) / GLOW_TEXTURE_RADIUS;
        const glowAlpha = lightIntensity[idx] / 50000;

        // console.log('scale', scale);
        // console.log('glowAlpha', glowAlpha);

        // Skip glow sprites that are too small or too dim
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
        rqType[i] = 3; // Light glow
        rqEntityIndex[i] = idx;
      }
    }

    // Write count
    this.renderQueueCount[0] = count;

    // Reset collector for next frame
    this._renderableCount = 0;
  }

  /**
   * Override reportFPS to write stats to SharedArrayBuffer
   */
  reportFPS() {
    // Write stats to SharedArrayBuffer every frame
    if (this.stats) {
      this.stats[PARTICLE_STATS.FPS] = this.currentFPS;
      this.stats[PARTICLE_STATS.ACTIVE_PARTICLES] = this.activeParticleCount;
      this.stats[PARTICLE_STATS.TOTAL_PARTICLES] = this.maxParticles;
      this.stats[PARTICLE_STATS.PARTICLES_STAMPED] = this.particlesStampedThisFrame;
      this.stats[PARTICLE_STATS.FLASHES_UPDATED] = this.flashesUpdatedThisFrame;
      this.stats[PARTICLE_STATS.SHADOWS_UPDATED] = this.shadowsUpdatedThisFrame;
      this.stats[PARTICLE_STATS.ACTIVE_ENTITIES] = this.activeEntityList
        ? this.activeEntityList.length
        : 0;
      this.stats[PARTICLE_STATS.TOTAL_ENTITIES] = this.globalEntityCount || 0;
    }
  }
  getNumberOfShadows() {
    // OPTIMIZED: Query only active entities with ShadowCaster
    const shadowCasters = this.queryActiveEntities([ShadowCaster]);
    const ret = new Uint16Array(shadowCasters.length);
    let count = 0;
    for (let i = 0; i < shadowCasters.length; i++) {
      const entityIdx = shadowCasters[i];
      // Note: Transform.active check no longer needed - queryActiveEntities already filters
      if (
        ShadowCaster.active[entityIdx] &&
        SpriteRenderer.active[entityIdx] &&
        SpriteRenderer.isItOnScreen[entityIdx]
      ) {
        ret[count] = entityIdx;
        count++;
      }
    }
    return ret.subarray(0, count);
  }
}

// Create singleton instance
self.particleWorker = new ParticleWorker(self);
