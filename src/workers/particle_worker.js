// particle_worker.js - Dedicated worker for particle physics
// Updates particle positions, applies gravity, handles lifetime
// Particles are NOT GameObjects - they use ParticleComponent directly

import { ParticleComponent } from "../components/ParticleComponent.js";
import { DecorationComponent } from "../components/DecorationComponent.js";
import { DecorationPool } from "../core/DecorationPool.js";
import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { LightEmitter } from "../components/LightEmitter.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { ShadowCaster } from "../components/ShadowCaster.js";
import { FlashComponent } from "../components/FlashComponent.js";
import { AbstractWorker } from "./AbstractWorker.js";
import { Grid } from "../core/Grid.js";
import {
  calculateTotalLightAtPosition,
  brightnessToTint,
} from "../core/utils.js";
import { PARTICLE_STATS, createStatsWriter } from "./workers-utils.js";

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
    this._shadowPairToSlot = new Map(); // Key: "lightIdx-neighborIdx", Value: slot index
    this._shadowSlotToPair = new Map(); // Key: slot index, Value: "lightIdx-neighborIdx"
    this._usedSlotsThisFrame = new Set(); // Set of slots used this frame

    this.howMuchMoreLightToParticles = 8;

    // ========================================
    // DERIVED PROPERTIES (moved from physics_worker)
    // ========================================
    // Minimum speed threshold for rotation updates (prevents jitter when stationary)
    this.minSpeedForRotation = 0.1;
    this.rigidBodyCount = 0;

    // ========================================
    // FLASH SYSTEM
    // ========================================
    // Flashes are short-lived light sources (muzzle flashes, sparks, etc.)
    // Updated here in particle_worker, not in logic workers
    this.flashesEnabled = false;
    this.maxFlashes = 0;
    this.flashStartIndex = 0; // Entity index where flashes start

    // ========================================
    // SPATIAL GRID REBUILDING
    // ========================================
    // Grid rebuilding moved to particle_worker for load balancing
    // particle_worker has spare capacity, spatial_workers are bottlenecked
    this.occupiedCells = null; // Track occupied grid cells for efficient clearing
    this.occupiedCount = 0;
    this.entityPosX = null; // Pre-computed entity positions for spatial_workers
    this.entityPosY = null;
    this.entityHalfExtent = null; // Pre-computed half-extents for neighbor checks
    this.gridSyncData = null; // Atomics sync buffer for coordinating with spatial_workers

    // Note: activeEntitiesData is now initialized in AbstractWorker.initializeCommonBuffers
  }

  /**
   * Initialize the particle worker
   */
  async initialize(data) {
    // Initialize stats buffer for writing metrics
    if (data.buffers.particleStats) {
      this.stats = createStatsWriter(
        data.buffers.particleStats,
        PARTICLE_STATS
      );
      console.log("PARTICLE WORKER: Stats buffer initialized");
    }

    // Get max particles from config (passed from gameEngine)
    this.maxParticles = data.maxParticles || 0;

    // Store viewport dimensions for screen visibility checks
    this.canvasWidth = this.config.canvasWidth;
    this.canvasHeight = this.config.canvasHeight;
    this.cullingRatio = this.config.renderer?.cullingRatio ?? 0.1;

    // Note: ParticleComponent is automatically initialized by AbstractWorker.initializeCommonBuffers()
    if (this.maxParticles > 0) {
      if (!data.buffers.componentData.ParticleComponent) {
        console.warn(
          "PARTICLE WORKER: ParticleComponent buffer not found, particle physics disabled"
        );
        this.maxParticles = 0;
      } else {
        // Initialize typed array for particle stamping (performance optimization)
        this.particlesToStamp = new Uint16Array(this.maxParticles);

        // OPTIMIZATION: Track active particles to avoid scanning inactive ones
        this.activeParticleIndices = new Int32Array(this.maxParticles);
      }
    }
    // Note: Worker continues initialization for other systems (lighting, shadows, flashes, etc.)
    // even when no particles are configured

    // ========================================
    // BLOOD DECALS TILEMAP - Initialize SABs
    // ========================================

    if (data.decals && data.decals.enabled) {
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
        for (const [textureId, textureData] of Object.entries(
          data.decals.textures
        )) {
          this.decalTextures[textureId] = {
            width: textureData.width,
            height: textureData.height,
            rgba: new Uint8ClampedArray(textureData.rgba),
          };
        }
      } else {
        console.warn("PARTICLE WORKER: No decal textures provided!");
      }
    } else {
      console.warn("PARTICLE WORKER: Blood decals NOT enabled!", {
        decals: data.decals,
        hasDecals: !!data.decals,
        enabled: data.decals?.enabled,
      });
    }

    // ========================================
    // PARTICLE LIGHTING - Initialize
    // ========================================
    const lightingConfig = this.config.lighting || {};
    if (
      lightingConfig.enabled &&
      data.buffers.componentData.LightEmitter &&
      data.buffers.componentData.Transform
    ) {
      this.lightingEnabled = true;
      this.lightingAmbient = lightingConfig.lightingAmbient ?? 0.05;
      this.globalEntityCount = data.globalEntityCount || 0;

      // Note: Component arrays (Transform, LightEmitter, SpriteRenderer) are automatically
      // initialized by AbstractWorker.initializeAllComponents()

      // Enable entity lighting by default when lighting is on
      // Can be disabled via config.lighting.entityLighting = false
      if (
        lightingConfig.entityLighting !== false &&
        data.buffers.componentData.SpriteRenderer
      ) {
        this.entityLightingEnabled = true;
        console.log(
          `PARTICLE WORKER: Entity lighting enabled (${this.globalEntityCount} entities)`
        );
      }

      console.log(
        `PARTICLE WORKER: Lighting enabled (ambient: ${this.lightingAmbient}, entities: ${this.globalEntityCount})`
      );
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
    if (
      data.buffers.componentData.RigidBody &&
      data.componentPools?.RigidBody
    ) {
      this.rigidBodyCount = data.componentPools.RigidBody.count || 0;

      // Get minSpeedForRotation from physics config
      const physicsConfig = this.config.physics || {};
      this.minSpeedForRotation = physicsConfig.minSpeedForRotation ?? 0.1;
    }

    // ========================================
    // SHADOW SPRITE SYSTEM - Initialize
    // ========================================
    if (
      data.shadows &&
      data.shadows.enabled &&
      data.shadows.spriteData &&
      data.buffers.componentData.ShadowCaster
    ) {
      this.shadowsEnabled = true;
      this.maxShadowCastingLights = data.shadows.maxShadowCastingLights;
      this.maxShadowsPerLight = data.shadows.maxShadowsPerLight;
      this.maxShadowsPerEntity = data.shadows.maxShadowsPerEntity || 0; // 0 = unlimited
      this.maxShadowSprites = data.shadows.maxShadowSprites;

      // Allocate per-entity shadow count tracking array if limit is set
      if (this.maxShadowsPerEntity > 0) {
        this._entityShadowCounts = new Uint8Array(this.globalEntityCount);
      }

      // Note: ShadowCaster is automatically initialized by AbstractWorker.initializeAllComponents()

      // Create separate typed array views for shadow SPRITE data
      // Uses same schema as ShadowCaster but different buffer
      this.shadowSpriteActive = new Uint8Array(
        data.shadows.spriteData,
        0,
        this.maxShadowSprites
      );

      // Calculate offsets for Float32 arrays (after Uint8 active array, aligned to 4 bytes)
      const float32Offset = Math.ceil(this.maxShadowSprites / 4) * 4;
      const floatCount = this.maxShadowSprites;

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
      this.shadowSpriteRotation = new Float32Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 12,
        floatCount
      );
      this.shadowSpriteScaleX = new Float32Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 16,
        floatCount
      );
      this.shadowSpriteScaleY = new Float32Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 20,
        floatCount
      );
      this.shadowSpriteAlpha = new Float32Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 24,
        floatCount
      );
      this.shadowSpriteEntityIdx = new Int32Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 28,
        floatCount
      );

      console.log(
        `PARTICLE WORKER: Shadow system enabled (${this.maxShadowSprites} shadow slots)`
      );
    }

    // ========================================
    // FLASH SYSTEM - Initialize
    // ========================================
    if (data.flashes && data.flashes.enabled) {
      this.flashesEnabled = true;
      this.maxFlashes = data.flashes.maxFlashes;
      this.flashStartIndex = data.flashes.startIndex;

      // Note: FlashComponent is automatically initialized by AbstractWorker.initializeAllComponents()
      if (data.buffers.componentData.FlashComponent) {
        console.log(
          `PARTICLE WORKER: Flash system enabled (${this.maxFlashes} flashes, starting at index ${this.flashStartIndex})`
        );
      } else {
        console.warn(
          "PARTICLE WORKER: FlashComponent buffer not found - flashes disabled"
        );
        this.flashesEnabled = false;
      }
    }

    // ========================================
    // SPATIAL GRID REBUILDING - Initialize arrays
    // ========================================
    if (data.gridMetadata && data.buffers.entityPosX) {
      const totalCells = data.gridMetadata.totalCells;
      const maxEntitiesPerCell = data.gridMetadata.maxEntitiesPerCell;

      // Track occupied cells - worst case is ALL cells occupied (local array)
      this.occupiedCells =
        totalCells <= 65535
          ? new Uint16Array(totalCells)
          : new Uint32Array(totalCells);
      this.occupiedCount = 0;

      // Pre-computed entity data - SHARED arrays written here, read by spatial_workers
      // NOTE: Pre-compute for ALL entities (spatial workers need full grid awareness)
      this.entityPosX = new Float32Array(data.buffers.entityPosX);
      this.entityPosY = new Float32Array(data.buffers.entityPosY);
      this.entityHalfExtent = new Float32Array(data.buffers.entityHalfExtent);

      // Grid synchronization - Atomics to prevent spatial workers reading during rebuild
      if (data.buffers.gridSyncData) {
        this.gridSyncData = new Int32Array(data.buffers.gridSyncData);
      }

      console.log(
        `PARTICLE WORKER: Grid rebuilding enabled (${totalCells} cells, ${this.globalEntityCount} entities)`
      );
    }

    // Note: activeEntitiesData is initialized in AbstractWorker.initializeCommonBuffers
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
   * Build compact list of active particles
   * Scans ParticleComponent.active[] and writes indices to local activeParticleIndices
   * Avoiding the scan in updateParticlePhysics allows skipping inactive particles efficiently
   */
  buildActiveParticleList() {
    if (this.maxParticles === 0) return;

    const active = ParticleComponent.active;
    const indices = this.activeParticleIndices;
    let count = 0;

    for (let i = 0; i < this.maxParticles; i++) {
      if (active[i]) {
        indices[count++] = i;
      }
    }

    this.activeParticleCount = count;
  }

  /**
   * Rebuild spatial grid (moved from spatial_worker for load balancing)
   * ARCHITECTURE: particle_worker has spare capacity (125 FPS), spatial_workers are bottlenecked (40 FPS)
   * Grid rebuild takes ~1.6ms, freeing spatial_workers to focus on neighbor detection (~33ms)
   *
   * OPTIMIZED: Uses flat grid structure with TypedArrays
   * - Zero GC pressure (no array allocations)
   * - Cache-friendly sequential access
   * - Pre-computes entity positions and half-extents for spatial_workers to use
   * - Only clears occupied cells (not entire grid)
   *
   * NOTE: Writes to SHARED grid buffer, read by spatial_workers and raycasting
   */
  rebuildGrid() {
    if (!this.occupiedCells) return; // Grid not initialized

    // DOUBLE BUFFERING: Always write to the write-only grid buffer
    // This allows spatial_workers to read the previous stable grid while we rebuild
    const gridEntities = Grid._gridEntitiesWrite;
    const gridCounts = Grid._gridCountsWrite;

    if (!gridEntities || !gridCounts) return;

    const occupiedCells = this.occupiedCells;
    const maxEntitiesPerCell = Grid.maxEntitiesPerCell;
    const gridCols = Grid.gridCols;
    const gridRows = Grid.gridRows;

    if (gridCols <= 0) return;

    // Safety: Clear the entire counts buffer for the write-target.
    // With double-buffering, we can't easily use the 'occupiedCells' optimization
    // without tracking two sets of occupied cells. Full clear is fast and safe.
    gridCounts.fill(0);
    this.occupiedCount = 0;

    // Cache frequently accessed values
    const x = Transform.x;
    const y = Transform.y;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const colliderActive = Collider.active;
    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const width = Collider.width;
    const height = Collider.height;
    const invCellSize = Grid.invCellSize;
    const maxCol = gridCols - 1;
    const maxRow = gridRows - 1;

    // Pre-computed entity data arrays (for spatial_workers to use)
    const entityPosX = this.entityPosX;
    const entityPosY = this.entityPosY;
    const entityHalfExtent = this.entityHalfExtent;

    // Shape type constants
    const SHAPE_CIRCLE = 0;

    // OPTIMIZED: Use active entity list (already built by buildActiveEntityList)
    // This eliminates the need to check active[i] for every entity
    const activeEntitiesData = this.activeEntitiesData;
    const totalActiveEntities = activeEntitiesData ? activeEntitiesData[0] : 0;

    // Insert only active entities into grid (iterate active list)
    for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
      const i = activeEntitiesData[1 + activeIdx];

      // Use collider position (transform + offset) for grid placement
      const posX = x[i] + (offsetX[i] || 0);
      const posY = y[i] + (offsetY[i] || 0);

      // Skip entities with invalid positions (NaN check via self-comparison)
      if (posX !== posX || posY !== posY) continue;

      // PRE-COMPUTE: Store collider position for spatial_workers to use
      entityPosX[i] = posX;
      entityPosY[i] = posY;

      // Calculate entity's bounding box half-extents based on collider type
      let halfW = 0,
        halfH = 0;
      if (colliderActive[i]) {
        if (shapeType[i] === SHAPE_CIRCLE) {
          // Circle: use radius for both dimensions
          halfW = halfH = radius[i] || 0;
        } else {
          // Box: use half width/height
          halfW = (width[i] || 0) * 0.5;
          halfH = (height[i] || 0) * 0.5;
        }
      }

      // PRE-COMPUTE: Store max half-extent for neighbor distance checks
      entityHalfExtent[i] = halfW > halfH ? halfW : halfH;

      // Calculate cell range the entity's bounding box covers
      let minCol = ((posX - halfW) * invCellSize) | 0;
      let maxColBB = ((posX + halfW) * invCellSize) | 0;
      let minRow = ((posY - halfH) * invCellSize) | 0;
      let maxRowBB = ((posY + halfH) * invCellSize) | 0;

      // Clamp to grid bounds
      minCol = minCol < 0 ? 0 : minCol > maxCol ? maxCol : minCol;
      maxColBB = maxColBB < 0 ? 0 : maxColBB > maxCol ? maxCol : maxColBB;
      minRow = minRow < 0 ? 0 : minRow > maxRow ? maxRow : minRow;
      maxRowBB = maxRowBB < 0 ? 0 : maxRowBB > maxRow ? maxRow : maxRowBB;

      // Add entity to ALL cells its bounding box overlaps
      for (let r = minRow; r <= maxRowBB; r++) {
        for (let c = minCol; c <= maxColBB; c++) {
          const cellIndex = r * gridCols + c;
          const count = gridCounts[cellIndex];

          // Add entity to cell if not full
          if (count < maxEntitiesPerCell) {
            gridEntities[cellIndex * maxEntitiesPerCell + count] = i;
            gridCounts[cellIndex] = count + 1;
          }
        }
      }
    }
  }

  /**
   * Update all active particles
   * Called every frame by the game loop
   *
   * BLOOD DECALS: Particles with stayOnTheFloor=1 are collected during
   * the physics loop, then stamped all at once after the loop finishes.
   * This batching improves cache locality for SAB writes.
   */
  update(deltaTime, dtRatio) {
    if (this.maxParticles === 0 && this.globalEntityCount === 0) return;

    // Note: Debug raycast clearing is now handled by pixi_worker at start of render frame

    // Rebuild spatial grid (uses active entity list) - spatial_workers will read this
    // ATOMICS: Signal spatial workers that grid (and active list) is being rebuilt
    if (this.gridSyncData) {
      Atomics.store(this.gridSyncData, 0, 0); // 0 = rebuilding
    }

    // Build active entity list FIRST - spatial workers need this to split work evenly
    this.buildActiveEntityList();

    // Rebuild spatial grid (uses active entity list)
    this.rebuildGrid();

    // DOUBLE BUFFER SWAP: Make the newly built grid available for reading
    Grid.swapGridBuffers();

    if (this.gridSyncData) {
      Atomics.store(this.gridSyncData, 0, 1); // 1 = ready
      Atomics.notify(this.gridSyncData, 0, Infinity); // Wake all waiting spatial workers
    }

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
    const activeCount = this.updateParticlePhysics(
      deltaTime,
      dtRatio,
      cameraBounds
    );

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
        lightIntensity[entityIndex] = initialIntensity[entityIndex] * remaining;
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
        continue;
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

        // If stayOnTheFloor is enabled, collect particle for stamping
        if (stayOnTheFloor[i]) {
          if (this.decalsEnabled) {
            this.particlesToStamp[this.particlesToStampCount++] = i;
          }
          active[i] = 0;
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
            continue;
          }
        }
      }

      // Update screen visibility for this particle
      if (hasCamera) {
        const screenX = x[i] * camZoom - camOffX;
        const screenY = y[i] * camZoom - camOffY;

        isItOnScreen[i] =
          screenX > camMinX &&
          screenX < camMaxX &&
          screenY > camMinY &&
          screenY < camMaxY
            ? 1
            : 0;
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
    const particleScale = ParticleComponent.scale;
    const particleTextureId = ParticleComponent.textureId;
    const particleAlpha = ParticleComponent.alpha;

    for (let i = 0; i < this.particlesToStampCount; i++) {
      const particleIndex = this.particlesToStamp[i];
      this.stampParticleToTile(
        particleX[particleIndex],
        particleY[particleIndex],
        particleTint[particleIndex],
        particleScale[particleIndex],
        particleTextureId[particleIndex],
        particleAlpha[particleIndex]
      );
    }

    // Track stamped particles for stats
    this.particlesStampedThisFrame = this.particlesToStampCount;
  }

  /**
   * Stamp a particle's texture onto the blood decal tilemap
   *
   * @param {number} worldX - World X position of the particle
   * @param {number} worldY - World Y position of the particle
   * @param {number} tint - Color tint (0xRRGGBB)
   * @param {number} scale - Particle scale (affects stamp size)
   * @param {number} textureId - Index into decalTextures map
   * @param {number} alpha - Particle alpha at time of stamping (0-1)
   */
  stampParticleToTile(worldX, worldY, tint, scale, textureId, alpha) {
    // Get texture data for this particle
    const texture = this.decalTextures[textureId];

    if (!texture) {
      // No texture data available for this textureId
      return;
    }

    // Calculate which tile this particle is on (bitwise floor for positive values)
    const tileX = (worldX / this.decalsTileSize) | 0;
    const tileY = (worldY / this.decalsTileSize) | 0;

    // Bounds check - particle outside world
    if (
      tileX < 0 ||
      tileX >= this.decalsTilesX ||
      tileY < 0 ||
      tileY >= this.decalsTilesY
    ) {
      return;
    }

    const tileIndex = tileX + tileY * this.decalsTilesX;

    // Calculate local position within tile in PIXEL coordinates
    // World position % tileSize gives world-space local pos, then scale by resolution
    const localX = ((worldX % this.decalsTileSize) * this.decalsResolution) | 0;
    const localY = ((worldY % this.decalsTileSize) * this.decalsResolution) | 0;

    // Calculate scaled texture dimensions (also scaled by resolution)
    // Using | 0 + 1 as a fast ceil for positive numbers
    const scaledWidth =
      (texture.width * scale * this.decalsResolution + 0.999) | 0;
    const scaledHeight =
      (texture.height * scale * this.decalsResolution + 0.999) | 0;

    // Calculate stamp bounds (centered on localX, localY)
    const halfWidth = (scaledWidth / 2) | 0;
    const halfHeight = (scaledHeight / 2) | 0;
    const startX = localX - halfWidth;
    const startY = localY - halfHeight;

    // Extract RGB from tint (0xRRGGBB)
    const tintR = (tint >> 16) & 0xff;
    const tintG = (tint >> 8) & 0xff;
    const tintB = tint & 0xff;

    // Cache frequently accessed values
    const tilePixelSize = this.decalsTilePixelSize;
    const bloodTiles = this.bloodTilesRGBA;
    const textureRgba = texture.rgba;
    const texWidth = texture.width;
    const texHeight = texture.height;

    // Tile byte offset in the big RGBA buffer
    const tileByteOffset = tileIndex * tilePixelSize * tilePixelSize * 4;

    // Pre-calculate inverse dimensions for UV mapping (avoid division in loop)
    const invScaledWidth = texWidth / scaledWidth;
    const invScaledHeight = texHeight / scaledHeight;

    // Stamp texture pixels onto tile
    // Uses simple nearest-neighbor scaling for performance
    for (let dy = 0; dy < scaledHeight; dy++) {
      const tilePixelY = startY + dy;
      // Skip entire row if outside tile bounds
      if (tilePixelY < 0 || tilePixelY >= tilePixelSize) continue;

      // Pre-calculate source Y and row offsets
      const srcY = (dy * invScaledHeight) | 0;
      const srcRowOffset = srcY * texWidth;
      const dstRowOffset = tileByteOffset + tilePixelY * tilePixelSize * 4;

      for (let dx = 0; dx < scaledWidth; dx++) {
        const tilePixelX = startX + dx;
        // Skip pixels outside tile bounds
        if (tilePixelX < 0 || tilePixelX >= tilePixelSize) continue;

        // Sample from source texture (nearest-neighbor)
        const srcX = (dx * invScaledWidth) | 0;
        const srcOffset = (srcRowOffset + srcX) * 4;

        // Apply particle alpha to texture alpha
        const srcA = textureRgba[srcOffset + 3] * alpha;

        // Skip fully transparent pixels
        if (srcA < 1) continue;

        // Get source RGB
        const srcR = textureRgba[srcOffset];
        const srcG = textureRgba[srcOffset + 1];
        const srcB = textureRgba[srcOffset + 2];

        // Calculate destination offset in tile buffer
        const dstOffset = dstRowOffset + tilePixelX * 4;

        // Apply tint to source color (multiply blend) - use bitwise for speed
        const finalR = ((srcR * tintR) / 255) | 0;
        const finalG = ((srcG * tintG) / 255) | 0;
        const finalB = ((srcB * tintB) / 255) | 0;

        // Alpha blending with existing tile content
        const srcAlphaNorm = srcA / 255;
        const invSrcAlpha = 1 - srcAlphaNorm;

        // Blend colors (bitwise truncation)
        bloodTiles[dstOffset] =
          (finalR * srcAlphaNorm + bloodTiles[dstOffset] * invSrcAlpha) | 0;
        bloodTiles[dstOffset + 1] =
          (finalG * srcAlphaNorm + bloodTiles[dstOffset + 1] * invSrcAlpha) | 0;
        bloodTiles[dstOffset + 2] =
          (finalB * srcAlphaNorm + bloodTiles[dstOffset + 2] * invSrcAlpha) | 0;
        // Alpha: combine using "over" operator
        bloodTiles[dstOffset + 3] =
          (srcA + bloodTiles[dstOffset + 3] * invSrcAlpha) | 0;
      }
    }

    // Mark tile as dirty so pixi_worker updates its texture
    this.bloodTilesDirty[tileIndex] = 1;
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
    const distanceData = Grid.distanceData;
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
    usedSlots.clear();

    // Track which slots are currently "owned" by pairs from previous frame
    // We will avoid using these for NEW pairs until we're sure the owner is gone
    const ownedSlots = new Set(pairToSlot.values());

    // Track pairs processed this frame
    const pairsThisFrame = new Set();

    let shadowCount = 0;
    let lightsProcessed = 0;

    // Query only entities with LightEmitter
    const lightEntities = this.query([LightEmitter]);

    // For each LIGHT, find nearby shadow casters and generate shadows
    for (let i = 0; i < lightEntities.length; i++) {
      if (shadowCount >= maxSprites) break;
      if (lightsProcessed >= this.maxShadowCastingLights) break;

      const lightIdx = lightEntities[i];
      if (!lightEnabled[lightIdx] || !transformActive[lightIdx]) continue;

      // Check if light is on screen (with margin)
      const isFlash = flashActive[lightIdx] === 1;
      if (!isFlash && !isOnScreen[lightIdx]) continue;

      const intensity = lightIntensity[lightIdx];
      if (intensity <= 0) continue;

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

        const neighborIdx = neighborData[offset + 1 + k];

        // Skip if not a shadow caster or inactive
        if (!shadowCasterActive[neighborIdx] || !transformActive[neighborIdx])
          continue;

        // Shadow casters should be considered if they are anywhere near the screen
        // isOnScreen already includes a 15% margin
        if (!isOnScreen[neighborIdx]) continue;

        // Create stable pair key
        const pairKey = `${lightIdx}-${neighborIdx}`;

        // Skip duplicate pairs (shouldn't happen with Grid but good for safety)
        if (pairsThisFrame.has(pairKey)) continue;
        pairsThisFrame.add(pairKey);

        // Per-entity shadow limit
        if (
          maxShadowsPerEntity > 0 &&
          entityShadowCounts[neighborIdx] >= maxShadowsPerEntity
        )
          continue;

        const distSq = distanceData[offset + 1 + k];
        if (distSq < 1) continue; // Avoid division by zero

        // ========================================
        // GET OR ASSIGN STABLE SLOT
        // ========================================
        let slotIdx = -1;
        if (pairToSlot.has(pairKey)) {
          slotIdx = pairToSlot.get(pairKey);
        } else {
          // Find a free slot: not used this frame AND not owned by any pair
          for (let s = 0; s < maxSprites; s++) {
            if (!usedSlots.has(s) && !ownedSlots.has(s)) {
              slotIdx = s;
              break;
            }
          }

          // Fallback: If no truly free slots, take ANY slot not used this frame
          if (slotIdx === -1) {
            for (let s = 0; s < maxSprites; s++) {
              if (!usedSlots.has(s)) {
                slotIdx = s;
                // If this slot was owned by someone else, we must evict them
                const oldPairKey = slotToPair.get(slotIdx);
                if (oldPairKey) {
                  pairToSlot.delete(oldPairKey);
                }
                break;
              }
            }
          }

          if (slotIdx === -1) break; // Still no slots? Limit reached.

          // Assign new slot
          pairToSlot.set(pairKey, slotIdx);
          slotToPair.set(slotIdx, pairKey);
        }

        // Mark slot as used
        usedSlots.add(slotIdx);

        // Calculate shadow properties
        const casterX = worldX[neighborIdx];
        const casterY = worldY[neighborIdx];
        let casterRadius = entityShadowRadius[neighborIdx];

        // Guard against NaN or zero radius
        if (isNaN(casterRadius) || casterRadius <= 0) {
          casterRadius = 10;
        }

        const casterHeight = entityShadowHeight[neighborIdx] || casterRadius;

        const dx = casterX - lightX;
        const dy = casterY - lightY;
        const dist = Math.sqrt(distSq);
        const invDist = 1 / dist;
        const dirX = dx * invDist;
        const dirY = dy * invDist;

        // Shadow position
        const posX = casterX + dirX * -casterRadius + dx;
        const posY = casterY + dirY * -casterRadius + dy;

        // Shadow scale
        const distRatio = dist * 0.00390625; // 1/256
        const clampedDistRatio = distRatio > 1 ? 1 : distRatio;
        const heightFactor = casterHeight * 0.025; // Normalizes 40 units to 1.0
        const lengthScale = (0.3 + clampedDistRatio * 0.9) * heightFactor;
        const widthScale = casterRadius * 0.0714;

        // Alpha and Angle
        let alpha = intensity / (distSq * 2);
        const angle = Math.atan2(dy, dx);

        // Guard against NaN
        if (isNaN(alpha)) alpha = 0;
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
      if (!usedSlots.has(i)) {
        if (shadowActive[i]) {
          shadowActive[i] = 0;
          const stalePairKey = slotToPair.get(i);
          if (stalePairKey) {
            pairToSlot.delete(stalePairKey);
            slotToPair.delete(i);
          }
        }
      }
    }

    // Final sweep for any pairs that weren't processed but somehow stayed in map
    if (pairToSlot.size > usedSlots.size) {
      for (const [key, slot] of pairToSlot.entries()) {
        if (!pairsThisFrame.has(key)) {
          pairToSlot.delete(key);
          slotToPair.delete(slot);
        }
      }
    }

    // Track shadows updated for stats
    this.shadowsUpdatedThisFrame = shadowCount;
  }

  /**
   * Update isItOnScreen property for all game entities
   * OPTIMIZED: Uses query system to iterate only entities with SpriteRenderer
   * Moved from spatial_worker to balance workload
   */
  updateEntityScreenVisibility() {
    if (
      !this.cameraData ||
      this.globalEntityCount === 0 ||
      !SpriteRenderer.isItOnScreen
    )
      return console.warn("PARTICLE WORKER: No camera data or entity count");

    const x = Transform.x;
    const y = Transform.y;
    const active = Transform.active;
    const isItOnScreen = SpriteRenderer.isItOnScreen;
    const screenX = SpriteRenderer.screenX;
    const screenY = SpriteRenderer.screenY;

    // Read camera data: [zoom, cameraX, cameraY]
    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];

    // Pre-calculate all bounds once
    const cameraOffsetX = cameraX * zoom;
    const cameraOffsetY = cameraY * zoom;
    const marginX = this.canvasWidth * this.cullingRatio;
    const marginY = this.canvasHeight * this.cullingRatio;
    const minX = -marginX;
    const maxX = this.canvasWidth + marginX;
    const minY = -marginY;
    const maxY = this.canvasHeight + marginY;

    // OPTIMIZATION: Query only entities that have SpriteRenderer
    // This skips non-renderable entities (triggers, invisible objects, etc.)
    const renderableEntities = this.query([Transform, SpriteRenderer]);

    for (let idx = 0; idx < renderableEntities.length; idx++) {
      const i = renderableEntities[idx];

      if (!active[i]) {
        isItOnScreen[i] = 0;
        continue;
      }

      // Transform world coordinates to screen coordinates
      const sx = x[i] * zoom - cameraOffsetX;
      const sy = y[i] * zoom - cameraOffsetY;
      screenX[i] = sx;
      screenY[i] = sy;

      // Check if screen position is within viewport bounds (with margin)
      isItOnScreen[i] =
        sx > minX && sx < maxX && sy > minY && sy < maxY ? 1 : 0;
    }
  }

  /**
   * Update isItOnScreen property for all decorations
   * Decorations are static, so we just need to check screen visibility
   * @param {Object|null} cameraBounds - Pre-calculated camera bounds (from particle physics)
   */
  updateDecorationScreenVisibility(cameraBounds) {
    if (
      !this.maxDecorations ||
      this.maxDecorations === 0 ||
      !DecorationComponent.active
    )
      return;

    // Early exit if no decorations are active (shared counter from DecorationPool)
    if (DecorationPool.activeCount && DecorationPool.activeCount[0] === 0) {
      return;
    }

    const active = DecorationComponent.active;
    const x = DecorationComponent.x;
    const y = DecorationComponent.y;
    const isItOnScreen = DecorationComponent.isItOnScreen;

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

    for (let i = 0; i < this.maxDecorations; i++) {
      if (!active[i]) {
        isItOnScreen[i] = 0;
        continue;
      }

      // Transform world coordinates to screen coordinates
      const screenX = x[i] * zoom - cameraOffsetX;
      const screenY = y[i] * zoom - cameraOffsetY;

      // Check if screen position is within viewport bounds (with margin)
      isItOnScreen[i] =
        screenX > minX && screenX < maxX && screenY > minY && screenY < maxY
          ? 1
          : 0;
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

    // OPTIMIZATION: Query only entities that have RigidBody component
    // This skips entities without physics (static decorations, etc.)
    const physicsEntities = this.query([RigidBody, Transform]);

    for (let idx = 0; idx < physicsEntities.length; idx++) {
      const i = physicsEntities[idx];
      if (!active[i] || !rigidBodyActive[i]) continue;

      // Velocity is already stored in vx/vy from moveBallsVerlet
      const currentSpeed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
      speed[i] = currentSpeed;

      // Only update rotation if moving above minimum threshold
      // This prevents visual jitter when entities are nearly stationary
      if (currentSpeed > minSpeedForRotation) {
        velocityAngle[i] = Math.atan2(vy[i], vx[i]) + Math.PI / 2;
      }
    }
  }

  /**
   * Get light data object for lighting calculations
   * Caches array references for reuse between particle and entity lighting
   * @returns {Object} Light data with arrays for positions, intensities, and enabled flags
   */
  getLightData() {
    return {
      lightX: Transform.x,
      lightY: Transform.y,
      lightIntensity: LightEmitter.lightIntensity,
      lightEnabled: LightEmitter.active,
      lightCount: this.globalEntityCount,
    };
  }

  /**
   * Apply brightness multiplier to a color while preserving hue
   * OPTIMIZED: Uses bitwise ops instead of Math.round for speed
   * @param {number} color - Original color in 0xRRGGBB format
   * @param {number} brightness - Brightness multiplier (0 to 1+)
   * @returns {number} Lit color in 0xRRGGBB format
   */
  applyBrightnessToColor(color, brightness) {
    // Clamp brightness to prevent over-saturation (branchless would be even faster but less readable)
    const b = brightness > 1.0 ? 1.0 : brightness;

    // Extract RGB and apply brightness using bitwise truncation (faster than Math.round)
    const litR = (((color >> 16) & 0xff) * b) | 0;
    const litG = (((color >> 8) & 0xff) * b) | 0;
    const litB = ((color & 0xff) * b) | 0;

    return (litR << 16) | (litG << 8) | litB;
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
      this.stats[PARTICLE_STATS.PARTICLES_STAMPED] =
        this.particlesStampedThisFrame;
      this.stats[PARTICLE_STATS.FLASHES_UPDATED] = this.flashesUpdatedThisFrame;
      this.stats[PARTICLE_STATS.SHADOWS_UPDATED] = this.shadowsUpdatedThisFrame;
    }
  }
  getNumberOfShadows() {
    const shadowCasters = this.query([ShadowCaster]);
    const ret = new Int32Array(shadowCasters.length);
    let count = 0;
    for (let i = 0; i < shadowCasters.length; i++) {
      const entityIdx = shadowCasters[i];
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
