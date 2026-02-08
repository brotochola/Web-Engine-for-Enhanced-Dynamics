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
  cantorPair,
  calculateDecalTileBounds,
  calculateTileClipRegion,
  _decalTileBounds,
  _tileClipRegion,
  countTrailingZeros,
} from '../core/utils.js';
import { PARTICLE_STATS, createStatsWriter } from './workers-utils.js';
import { RENDERER_DEFAULTS } from '../core/ConfigDefaults.js';

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
    // STABLE SHADOW SLOT ASSIGNMENT
    // ========================================
    // Maps (light, entity) pairs to shadow slots for stable assignment
    // This prevents flickering and allows proper interpolation in pixi_worker
    this._shadowPairToSlot = new Map(); // Key: cantorPair(lightIdx, neighborIdx), Value: slot index
    this._shadowSlotToPair = null; // Int32Array[maxShadowSprites] - direct lookup by slot, -1 = empty
    this._usedSlotsThisFrame = null; // Uint8Array bitmap - 1 if slot used this frame
    this._ownedSlots = null; // Uint8Array bitmap - 1 if slot owned by a pair from previous frame
    this._pairsThisFrame = new Set(); // Reusable Set for tracking pairs processed this frame (avoids allocation each frame)

    // ========================================
    // DERIVED PROPERTIES (moved from physics_worker)
    // ========================================
    // Minimum speed threshold for rotation updates (prevents jitter when stationary)
    this.minSpeedForRotation = 0.1;
    this.rigidBodyCount = 0;

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

    // Note: ParticleComponent is automatically initialized by AbstractWorker.initializeCommonBuffers()
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

        // Initialize shared free list for returning dead particles
        if (data.particleFreeList && data.particleFreeListTop) {
          ParticleEmitter.maxParticles = this.maxParticles;
          ParticleEmitter.initializeFreeList(data.particleFreeList, data.particleFreeListTop);
          console.log('[PARTICLE WORKER] Particle free list initialized');
        }
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
      hasSpriteData: !!data.shadows?.spriteData,
      hasShadowCaster: !!data.buffers.componentData.ShadowCaster
    });

    if (
      data.shadows &&
      data.shadows.enabled &&
      data.shadows.spriteData &&
      data.buffers.componentData.ShadowCaster
    ) {
      console.log('[PARTICLE WORKER] Initializing shadow system...');
      this.shadowsEnabled = true;
      this.maxShadowCastingLights = data.shadows.maxShadowCastingLights;
      this.maxShadowsPerLight = data.shadows.maxShadowsPerLight;
      this.maxShadowsPerEntity = data.shadows.maxShadowsPerEntity || 0; // 0 = unlimited
      this.maxShadowSprites = data.shadows.maxShadowSprites;

      // GC OPTIMIZATION: Use typed arrays instead of Map/Set for slot tracking
      // These are O(1) access with zero hashing overhead
      this._usedSlotsThisFrame = new Uint8Array(this.maxShadowSprites);
      this._ownedSlots = new Uint8Array(this.maxShadowSprites);
      this._shadowSlotToPair = new Int32Array(this.maxShadowSprites);
      this._shadowSlotToPair.fill(-1); // -1 indicates empty slot

      // Allocate per-entity shadow count tracking array if limit is set
      if (this.maxShadowsPerEntity > 0) {
        this._entityShadowCounts = new Uint8Array(this.globalEntityCount);
      }

      // Note: ShadowCaster is automatically initialized by AbstractWorker.initializeAllComponents()

      // Create separate typed array views for shadow SPRITE data
      // Uses same schema as ShadowCaster but different buffer
      this.shadowSpriteActive = new Uint8Array(data.shadows.spriteData, 0, this.maxShadowSprites);

      // Calculate offsets for Float32 arrays (after Uint8 active array, aligned to 4 bytes)
      const float32Offset = Math.ceil(this.maxShadowSprites / 4) * 4;
      const floatCount = this.maxShadowSprites;

      // Buffer layout matches ShadowCaster.ARRAY_SCHEMA order:
      // active(Uint8), shadowRadius, x, y, height, rotation, scaleX, scaleY, alpha, entityIdx, lightIdx
      this.shadowSpriteRadius = new Float32Array(
        data.shadows.spriteData,
        float32Offset,
        floatCount
      );
      this.shadowSpriteX = new Float32Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 4,
        floatCount
      );
      this.shadowSpriteY = new Float32Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 8,
        floatCount
      );
      // height is at offset 12 but not used for sprite buffer (skipped)
      this.shadowSpriteRotation = new Float32Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 16, // After height (12 + 4)
        floatCount
      );
      this.shadowSpriteScaleX = new Float32Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 20,
        floatCount
      );
      this.shadowSpriteScaleY = new Float32Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 24,
        floatCount
      );
      this.shadowSpriteAlpha = new Float32Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 28,
        floatCount
      );
      this.shadowSpriteEntityIdx = new Uint16Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 32,
        floatCount
      );
      this.shadowSpriteLightIdx = new Uint16Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 36,
        floatCount
      );

      console.log(`[PARTICLE WORKER] Shadow system enabled (${this.maxShadowSprites} shadow slots)`);
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
    const activeCount = this.updateParticlePhysics(deltaTime, dtRatio, cameraBounds);

    // Stamp collected particles onto blood decal tiles
    this.stampCollectedParticles();

    // Update lighting tints for all active particles
    // this.updateParticleLighting();

    // Update lighting tints for all visible game entities
    // this.updateEntityLighting();

    this.updateFlashes(deltaTime);

    // Update screen visibility for all game entities BEFORE shadows
    this.updateEntityScreenVisibility();

    // Calculate shadow sprite positions (uses same neighbor data as lighting)
    this.updateShadowSprites();

    // Update derived properties (speed, velocityAngle) for RigidBody entities
    this.updateDerivedProperties();

    // Update cell sleeping states based on entity sleeping/static states
    this.updateCellSleepingStates();

    // Update screen visibility for all decorations
    this.updateDecorationScreenVisibility(cameraBounds);

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

        isItOnScreen[i] =
          screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY ? 1 : 0;
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
   * Update shadow sprites using STABLE SLOT ASSIGNMENT
   * Each (light, entity) pair keeps the same slot across frames for smooth interpolation.
   * Slots are only reassigned when pairs change.
   */
  updateShadowSprites() {
    if (!this.shadowsEnabled || !this.shadowSpriteActive) return;

    const shadowActive = this.shadowSpriteActive;
    const maxSprites = this.maxShadowSprites;

    // Cache Grid data and metadata once per call to avoid repeated Atomics.load calls
    // and potential race conditions if the buffer swaps mid-loop.
    const neighborData = Grid.neighborData;
    const stride = Grid._stride;

    // Check if we have precomputed distances from Grid (spatial worker)
    if (!neighborData || Grid.maxNeighbors <= 0) {
      // No spatial data - deactivate all shadows
      for (let i = 0; i < maxSprites; i++) {
        shadowActive[i] = 0;
      }
      return;
    }

    // Cache component arrays (entity data)
    const worldX = Transform.x;
    const worldY = Transform.y;
    const transformActive = Transform.active;
    const lightEnabled = LightEmitter.active;
    const lightIntensity = LightEmitter.lightIntensity;
    const shadowCasterActive = ShadowCaster.active;
    const entityShadowRadius = ShadowCaster.shadowRadius;
    const entityShadowHeight = ShadowCaster.height;
    const isOnScreen = SpriteRenderer.isItOnScreen;
    const flashActive = FlashComponent.active;

    // Shadow sprite output arrays
    const shadowRadius = this.shadowSpriteRadius;
    const shadowX = this.shadowSpriteX;
    const shadowY = this.shadowSpriteY;
    const shadowRotation = this.shadowSpriteRotation;
    const shadowScaleX = this.shadowSpriteScaleX;
    const shadowScaleY = this.shadowSpriteScaleY;
    const shadowAlpha = this.shadowSpriteAlpha;
    const shadowEntityIdx = this.shadowSpriteEntityIdx;
    const shadowLightIdx = this.shadowSpriteLightIdx;

    // Per-entity shadow limit tracking
    const maxShadowsPerEntity = this.maxShadowsPerEntity;
    const entityShadowCounts = this._entityShadowCounts;
    if (maxShadowsPerEntity > 0 && entityShadowCounts) {
      entityShadowCounts.fill(0);
    }

    // ========================================
    // STABLE SLOT ASSIGNMENT PREP
    // ========================================
    const pairToSlot = this._shadowPairToSlot;
    const slotToPair = this._shadowSlotToPair;
    const usedSlots = this._usedSlotsThisFrame;
    usedSlots.fill(0); // Clear bitmap

    // Track which slots are currently "owned" by pairs from previous frame
    // We will avoid using these for NEW pairs until we're sure the owner is gone
    // GC OPTIMIZATION: Use typed array bitmap instead of Set
    const ownedSlots = this._ownedSlots;
    // Populate ownedSlots from slotToPair (slot is owned if it has a valid pair)
    for (let s = 0; s < maxSprites; s++) {
      ownedSlots[s] = slotToPair[s] !== -1 ? 1 : 0;
    }

    // Track pairs processed this frame
    // REUSE: Clear to avoid allocation each frame
    const pairsThisFrame = this._pairsThisFrame;
    pairsThisFrame.clear();

    let shadowCount = 0;
    let lightsProcessed = 0;

    // OPTIMIZED: Query only active entities with LightEmitter
    const lightEntities = this.queryActiveEntities([LightEmitter]);

    // For each LIGHT, find nearby shadow casters and generate shadows
    for (let i = 0; i < lightEntities.length; i++) {
      if (shadowCount >= maxSprites) break;
      if (lightsProcessed >= this.maxShadowCastingLights) break;

      const lightIdx = lightEntities[i];
      // Note: transformActive check no longer needed - queryActiveEntities already filters
      if (!lightEnabled[lightIdx]) {
        continue;
      }

      // Check if light is on screen (with margin)
      const isFlash = flashActive[lightIdx] === 1;
      if (!isFlash && !isOnScreen[lightIdx]) {
        continue;
      }

      const intensity = lightIntensity[lightIdx];
      if (intensity <= 0) {
        continue;
      }

      lightsProcessed++;

      const lightX = worldX[lightIdx];
      const lightY = worldY[lightIdx];

      // Get neighbors of this light using direct buffer access (safer and much faster)
      const offset = lightIdx * stride;
      const neighborCountForLight = neighborData[offset];
      let shadowsForThisLight = 0;

      for (let k = 0; k < neighborCountForLight; k++) {
        if (shadowsForThisLight >= this.maxShadowsPerLight) break;
        if (shadowCount >= maxSprites) break;

        const neighborIdx = neighborData[offset + 2 + k];

        // Skip if not a shadow caster or inactive
        if (!shadowCasterActive[neighborIdx] || !transformActive[neighborIdx]) {
          continue;
        }

        // Shadow casters should be considered if they are anywhere near the screen
        // isOnScreen already includes a 15% margin
        if (!isOnScreen[neighborIdx]) {
          continue;
        }

        // Create stable pair key
        const pairKey = cantorPair(lightIdx, neighborIdx);

        // Skip duplicate pairs (shouldn't happen with Grid but good for safety)
        if (pairsThisFrame.has(pairKey)) {
          continue;
        }
        pairsThisFrame.add(pairKey);

        // Per-entity shadow limit
        if (maxShadowsPerEntity > 0 && entityShadowCounts[neighborIdx] >= maxShadowsPerEntity) {
          continue;
        }

        // Calculate distance on-the-fly (collider positions)
        // Distance from light to shadow caster (neighbor)
        const lightXWithOffset = Transform.x[lightIdx] + (Collider.offsetX[lightIdx] || 0);
        const lightYWithOffset = Transform.y[lightIdx] + (Collider.offsetY[lightIdx] || 0);
        const neighborX = Transform.x[neighborIdx] + (Collider.offsetX[neighborIdx] || 0);
        const neighborY = Transform.y[neighborIdx] + (Collider.offsetY[neighborIdx] || 0);
        const dx = neighborX - lightXWithOffset;
        const dy = neighborY - lightYWithOffset;
        // OPTIMIZED: Inline since dx/dy are already calculated
        const distSq = dx * dx + dy * dy;

        if (distSq < 1) {
          continue; // Avoid division by zero
        }

        // ========================================
        // GET OR ASSIGN STABLE SLOT
        // ========================================
        let slotIdx = -1;
        if (pairToSlot.has(pairKey)) {
          slotIdx = pairToSlot.get(pairKey);
        } else {
          // Find a free slot: not used this frame AND not owned by any pair
          for (let s = 0; s < maxSprites; s++) {
            if (usedSlots[s] === 0 && ownedSlots[s] === 0) {
              slotIdx = s;
              break;
            }
          }

          // Fallback: If no truly free slots, take ANY slot not used this frame
          if (slotIdx === -1) {
            for (let s = 0; s < maxSprites; s++) {
              if (usedSlots[s] === 0) {
                slotIdx = s;
                // If this slot was owned by someone else, we must evict them
                const oldPairKey = slotToPair[slotIdx];
                if (oldPairKey !== -1) {
                  pairToSlot.delete(oldPairKey);
                }
                break;
              }
            }
          }

          if (slotIdx === -1) break; // Still no slots? Limit reached.

          // Assign new slot
          pairToSlot.set(pairKey, slotIdx);
          slotToPair[slotIdx] = pairKey;
        }

        // Mark slot as used
        usedSlots[slotIdx] = 1;

        // Calculate shadow properties
        const casterX = worldX[neighborIdx];
        const casterY = worldY[neighborIdx];
        let casterRadius = entityShadowRadius[neighborIdx];

        // Guard against NaN or zero radius
        if (isNaN(casterRadius) || casterRadius <= 0) {
          casterRadius = 10;
        }

        const casterHeight = entityShadowHeight[neighborIdx] || casterRadius;

        // BUGFIX: Use collider positions for direction vector to match distSq calculation
        // distSq is calculated from collider positions (lightXWithOffset, neighborX)
        // so lightDx/lightDy must also use collider positions for correct normalization
        const lightDx = neighborX - lightXWithOffset;
        const lightDy = neighborY - lightYWithOffset;
        const dist = Math.sqrt(distSq);
        const invDist = 1 / dist;
        const dirX = lightDx * invDist;
        const dirY = lightDy * invDist;

        // Shadow position
        const posX = casterX - dirX * casterRadius * 0.5;
        const posY = casterY - dirY * casterRadius * 0.5;

        // Shadow scale
        const distRatio = dist * 0.00390625; // 1/256
        const clampedDistRatio = distRatio > 1 ? 1 : distRatio;
        const heightFactor = casterHeight * 0.025; // Normalizes 40 units to 1.0
        const lengthScale = (0.3 + clampedDistRatio * 0.9) * heightFactor;
        const widthScale = 1; //casterRadius * 0.0714;

        // Alpha and Angle
        let alpha = intensity / (intensity + distSq);
        const angle = Math.atan2(dy, dx);

        // Guard against NaN
        if (isNaN(alpha)) alpha = 0;
        if (alpha > 1) alpha = 1;
        if (alpha < 0) alpha = 0;
        alpha *= 0.33;
        if (isNaN(posX) || isNaN(posY)) {
          shadowActive[slotIdx] = 0;
          continue;
        }

        // Write shadow data
        shadowActive[slotIdx] = 1;
        shadowRadius[slotIdx] = casterRadius;
        shadowX[slotIdx] = posX;
        shadowY[slotIdx] = posY;
        shadowRotation[slotIdx] = angle - 1.5707963267948966; // PI/2
        shadowScaleX[slotIdx] = widthScale;
        shadowScaleY[slotIdx] = lengthScale;
        shadowAlpha[slotIdx] = alpha;
        shadowEntityIdx[slotIdx] = neighborIdx;
        shadowLightIdx[slotIdx] = lightIdx;

        shadowCount++;
        shadowsForThisLight++;
        if (maxShadowsPerEntity > 0) entityShadowCounts[neighborIdx]++;
      }
    }

    // ========================================
    // CLEANUP
    // ========================================
    // Deactivate unused slots and remove stale mappings
    for (let i = 0; i < maxSprites; i++) {
      if (usedSlots[i] === 0) {
        if (shadowActive[i]) {
          shadowActive[i] = 0;
          const stalePairKey = slotToPair[i];
          if (stalePairKey !== -1) {
            pairToSlot.delete(stalePairKey);
            slotToPair[i] = -1;
          }
        }
      }
    }

    // Final sweep for any pairs that weren't processed but somehow stayed in map
    if (pairToSlot.size > shadowCount) {
      for (const [key, slot] of pairToSlot.entries()) {
        if (!pairsThisFrame.has(key)) {
          pairToSlot.delete(key);
          slotToPair[slot] = -1;
        }
      }
    }

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
      isItOnScreen[i] = sx >= screenMinX && sx <= screenMaxX && sy >= screenMinY && sy <= screenMaxY ? 1 : 0;
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

    // Early exit if no decorations are active (shared counter from DecorationPool)
    if (DecorationPool.activeCount && DecorationPool.activeCount[0] === 0) {
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

    // Use active indices list if available (O(activeCount) instead of O(maxDecorations))
    const activeIndices = DecorationPool.activeIndices;
    const activeCount = DecorationPool.activeCount;

    if (activeIndices && activeCount && activeCount[0] > 0) {
      // OPTIMIZED: Iterate only active decorations using compact list
      const count = activeCount[0];
      for (let idx = 0; idx < count; idx++) {
        const i = activeIndices[idx];

        // Transform world coordinates to screen coordinates
        const screenX = x[i] * zoom - cameraOffsetX;
        const screenY = y[i] * zoom - cameraOffsetY;

        // Check if screen position is within viewport bounds (with margin)
        isItOnScreen[i] =
          screenX > minX && screenX < maxX && screenY > minY && screenY < maxY ? 1 : 0;

        if (sway[i]) {
          rotation[i] = baseRotation[i] + Math.sin(this._swayBaseAngle * swayFrequency[i] + i * 0.1) * swayAmplitude[i];
        }
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
