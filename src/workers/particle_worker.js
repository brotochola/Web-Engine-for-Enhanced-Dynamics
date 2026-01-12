// particle_worker.js - Dedicated worker for particle physics
// Updates particle positions, applies gravity, handles lifetime
// Particles are NOT GameObjects - they use ParticleComponent directly

import { ParticleComponent } from "../components/ParticleComponent.js";
import { DecorationComponent } from "../components/DecorationComponent.js";
import { DecorationPool } from "../core/DecorationPool.js";
import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { LightEmitter } from "../components/LightEmitter.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { ShadowCaster } from "../components/ShadowCaster.js";
import { FlashComponent } from "../components/FlashComponent.js";
import { AbstractWorker } from "./AbstractWorker.js";
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
    this.particlesToStamp = [];

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

    // Note: ParticleComponent is automatically initialized by AbstractWorker.initializeCommonBuffers()
    if (this.maxParticles > 0) {
      if (!data.buffers.componentData.ParticleComponent) {
        console.warn(
          "PARTICLE WORKER: ParticleComponent buffer not found, particle physics disabled"
        );
        this.maxParticles = 0;
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
   * Update all active particles
   * Called every frame by the game loop
   *
   * BLOOD DECALS: Particles with stayOnTheFloor=1 are collected during
   * the physics loop, then stamped all at once after the loop finishes.
   * This batching improves cache locality for SAB writes.
   */
  update(deltaTime, dtRatio) {
    if (this.maxParticles === 0 && this.globalEntityCount === 0) return;

    // Build active entity list FIRST - spatial workers need this to split work evenly
    this.buildActiveEntityList();

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

    // Calculate shadow sprite positions (uses same neighbor data as lighting)
    this.updateShadowSprites();

    // Update screen visibility for all game entities
    this.updateEntityScreenVisibility();
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
    this.particlesToStamp.length = 0;
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
    const marginX = this.canvasWidth * 0.15;
    const marginY = this.canvasHeight * 0.15;

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

    // Update all particles in pool (indices 0 to maxParticles-1)
    for (let i = 0; i < this.maxParticles; i++) {
      if (!active[i]) continue;

      activeCount++;

      // Update lifetime
      currentLife[i] += deltaTime;

      // Check if particle expired
      if (currentLife[i] >= lifespan[i]) {
        active[i] = 0;
        activeCount--;
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
            this.particlesToStamp.push(i);
          }
          active[i] = 0;
          activeCount--;
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
            activeCount--;
            continue;
          }
        }
      }

      // Update screen visibility for this particle
      if (cameraBounds) {
        const screenX = x[i] * cameraBounds.zoom - cameraBounds.cameraOffsetX;
        const screenY = y[i] * cameraBounds.zoom - cameraBounds.cameraOffsetY;

        isItOnScreen[i] =
          screenX > cameraBounds.minX &&
          screenX < cameraBounds.maxX &&
          screenY > cameraBounds.minY &&
          screenY < cameraBounds.maxY
            ? 1
            : 0;
      }
    }

    return activeCount;
  }

  /**
   * Stamp all collected particles onto blood decal tiles
   * Batching improves cache locality for tile writes
   */
  stampCollectedParticles() {
    if (this.particlesToStamp.length === 0 || !this.decalsEnabled) return;

    const particleX = ParticleComponent.x;
    const particleY = ParticleComponent.y;
    const particleTint = ParticleComponent.tint;
    const particleScale = ParticleComponent.scale;
    const particleTextureId = ParticleComponent.textureId;
    const particleAlpha = ParticleComponent.alpha;

    for (const particleIndex of this.particlesToStamp) {
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
    this.particlesStampedThisFrame = this.particlesToStamp.length;
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

  // /**
  //  * Calculate lighting tints for all active particles
  //  * Uses inverse square falloff: brightness = ambient + Σ(intensity / d²)
  //  * Multiplies original particle tint by brightness to preserve color
  //  *
  //  * OPTIMIZED: Inlined light calculation, distance culling, on-screen only
  //  */
  // updateParticleLighting() {
  //   if (!this.lightingEnabled || this.maxParticles === 0) return;

  //   // Cache particle arrays
  //   const active = ParticleComponent.active;
  //   const particleX = ParticleComponent.x;
  //   const particleY = ParticleComponent.y;
  //   const tint = ParticleComponent.tint;
  //   const baseTint = ParticleComponent.baseTint;
  //   const isItOnScreen = ParticleComponent.isItOnScreen;

  //   // Cache light arrays directly (avoid object destructuring in hot path)
  //   const lightX = Transform.x;
  //   const lightY = Transform.y;
  //   const lightIntensity = LightEmitter.lightIntensity;
  //   const lightEnabled = LightEmitter.active;
  //   const lightCount = this.globalEntityCount;

  //   const ambient = this.lightingAmbient;
  //   // Max distance squared beyond which light contribution is negligible
  //   // intensity / (1 + distSq) < 0.001 when distSq > intensity * 1000
  //   const maxLightDistSq = 500000; // ~707 world units for typical light intensities

  //   // Calculate lighting for each active, on-screen particle
  //   for (let i = 0; i < this.maxParticles; i++) {
  //     if (!active[i]) continue;
  //     // Skip off-screen particles - they won't be rendered anyway
  //     if (!isItOnScreen[i]) continue;

  //     const px = particleX[i];
  //     const py = particleY[i];
  //     let totalLight = ambient;

  //     // Inlined light calculation - no function call overhead
  //     for (let j = 0; j < lightCount; j++) {
  //       if (!lightEnabled[j]) continue;

  //       const dx = px - lightX[j];
  //       const dy = py - lightY[j];
  //       const distSq = dx * dx + dy * dy;

  //       // Early exit: skip lights too far away to contribute meaningfully
  //       if (distSq > maxLightDistSq) continue;

  //       // Inverse square falloff
  //       totalLight +=
  //         (lightIntensity[j] * this.howMuchMoreLightToParticles) / (1 + distSq);
  //     }

  //     // Apply brightness to the original particle color (baseTint)
  //     tint[i] = this.applyBrightnessToColor(baseTint[i], totalLight * 3000);
  //   }
  // }

  // /**
  //  * Calculate lighting tints for all visible game entities with SpriteRenderer
  //  * Only updates entities that are active and on screen for performance
  //  * Requires config.lighting.entityLighting = true to enable
  //  * Uses precomputed squared distances from spatial worker when available
  //  */
  // updateEntityLighting() {
  //   if (
  //     !this.entityLightingEnabled ||
  //     !SpriteRenderer.tint ||
  //     !SpriteRenderer.baseTint
  //   ) {
  //     return;
  //   }

  //   // Cache component arrays
  //   const active = Transform.active;
  //   const tint = SpriteRenderer.tint;
  //   const baseTint = SpriteRenderer.baseTint;
  //   const isItOnScreen = SpriteRenderer.isItOnScreen;

  //   // Check if we can use precomputed distances from spatial worker
  //   const usePrecomputedDistances =
  //     this.neighborData &&
  //     this.distanceData &&
  //     this.config.spatial?.maxNeighbors;

  //   if (usePrecomputedDistances) {
  //     // OPTIMIZED PATH: Iterate through LIGHTS and use their neighbors
  //     // The LIGHT's visualRange determines which entities receive light
  //     const lightIntensity = LightEmitter.lightIntensity;
  //     const lightEnabled = LightEmitter.active;
  //     const maxNeighbors = this.config.spatial.maxNeighbors;
  //     const stride = 1 + maxNeighbors;
  //     const ambient = this.lightingAmbient;

  //     // Reuse or create brightness accumulator array
  //     if (
  //       !this.entityBrightness ||
  //       this.entityBrightness.length < this.globalEntityCount
  //     ) {
  //       this.entityBrightness = new Float32Array(this.globalEntityCount);
  //     }
  //     const entityBrightness = this.entityBrightness;

  //     // Initialize all entities to ambient light
  //     for (let i = 0; i < this.globalEntityCount; i++) {
  //       entityBrightness[i] = ambient;
  //     }

  //     // For each LIGHT, add its contribution to its neighbors
  //     // This uses the LIGHT's visualRange to determine reach
  //     for (let lightIdx = 0; lightIdx < this.globalEntityCount; lightIdx++) {
  //       if (!lightEnabled[lightIdx]) continue;

  //       const intensity = lightIntensity[lightIdx];
  //       if (intensity <= 0) continue;

  //       const offset = lightIdx * stride;
  //       const neighborCount = this.neighborData[offset];

  //       // Add this light's contribution to all its neighbors
  //       for (let k = 0; k < neighborCount; k++) {
  //         const neighborIdx = this.neighborData[offset + 1 + k];
  //         const distSq = this.distanceData[offset + 1 + k];

  //         // inverse square falloff: intensity / (1 + distSq)
  //         entityBrightness[neighborIdx] += intensity / (1 + distSq);
  //       }
  //     }

  //     // Apply accumulated brightness to visible entities
  //     for (let i = 0; i < this.globalEntityCount; i++) {
  //       if (!active[i] || !isItOnScreen[i]) continue;
  //       //Light Emitters are always fully lit
  //       if (LightEmitter.active[i] === 1) {
  //         tint[i] = 0xffffff;
  //         continue;
  //       }

  //       const entityBaseTint = baseTint[i];
  //       if (entityBaseTint === 0) continue;

  //       const brightness = entityBrightness[i];
  //       tint[i] = this.applyBrightnessToColor(
  //         entityBaseTint,
  //         brightness * 9000
  //       );
  //       SpriteRenderer.renderDirty[i] = 1;
  //     }
  //   }
  //   // else {
  //   //   // FALLBACK PATH: Calculate distances manually (no spatial data available)
  //   //   const entityX = Transform.x;
  //   //   const entityY = Transform.y;
  //   //   const lightData = this.getLightData();

  //   //   for (let i = 0; i < this.globalEntityCount; i++) {
  //   //     // Skip inactive or off-screen entities
  //   //     if (!active[i] || !isItOnScreen[i]) continue;

  //   //     // Skip entities with uninitialized baseTint (0 = black, likely not set)
  //   //     const entityBaseTint = baseTint[i];
  //   //     if (entityBaseTint === 0) continue;

  //   //     // Calculate total light at entity position (manual distance calculation)
  //   //     const brightness = calculateTotalLightAtPosition(
  //   //       entityX[i],
  //   //       entityY[i],
  //   //       lightData,
  //   //       this.lightingAmbient
  //   //     );

  //   //     // Apply brightness to the original entity color (baseTint)
  //   //     tint[i] = this.applyBrightnessToColor(
  //   //       entityBaseTint,
  //   //       brightness * 3000
  //   //     );
  //   //   }
  //   // }
  // }

  /**
   * Calculate shadow sprite positions for all active lights
   * OPTIMIZED: Uses query system to iterate only entities with LightEmitter
   * Uses precomputed neighbor/distance data from spatial worker
   */
  updateShadowSprites() {
    if (!this.shadowsEnabled || !this.shadowSpriteActive) return;

    const shadowActive = this.shadowSpriteActive;

    // Check if we have precomputed distances from spatial worker
    const usePrecomputedDistances =
      this.neighborData &&
      this.distanceData &&
      this.config.spatial?.maxNeighbors;

    if (!usePrecomputedDistances) {
      // Clear all slots only when no data available
      for (let i = 0; i < this.maxShadowSprites; i++) {
        shadowActive[i] = 0;
      }
      return;
    }

    // Cache component arrays (entity data)
    const transformActive = Transform.active;
    const worldX = Transform.x;
    const worldY = Transform.y;
    const lightEnabled = LightEmitter.active;
    const lightIntensity = LightEmitter.lightIntensity;
    const shadowCasterActive = ShadowCaster.active;
    const entityShadowRadius = ShadowCaster.shadowRadius;
    const entityShadowHeight = ShadowCaster.height;
    const isOnScreen = SpriteRenderer.isItOnScreen;

    const maxNeighbors = this.config.spatial.maxNeighbors;
    const stride = 1 + maxNeighbors;

    // Shadow sprite output arrays (shadowActive already cached above)
    const shadowRadius = this.shadowSpriteRadius;
    const shadowX = this.shadowSpriteX;
    const shadowY = this.shadowSpriteY;
    const shadowRotation = this.shadowSpriteRotation;
    const shadowScaleX = this.shadowSpriteScaleX;
    const shadowScaleY = this.shadowSpriteScaleY;
    const shadowAlpha = this.shadowSpriteAlpha;

    // Per-entity shadow limit tracking
    const maxShadowsPerEntity = this.maxShadowsPerEntity;
    const entityShadowCounts = this._entityShadowCounts;

    // Reset entity shadow counts if limit is enabled
    if (maxShadowsPerEntity > 0 && entityShadowCounts) {
      entityShadowCounts.fill(0);
    }

    let shadowIdx = 0;
    let lightsProcessed = 0;

    // OPTIMIZATION: Query only entities with LightEmitter instead of iterating all entities
    // Dramatically reduces iterations (e.g., 10 lights vs 10,000 entities)
    const lightEntities = this.query([LightEmitter]);

    // For each LIGHT, find nearby shadow casters and generate shadows
    for (
      let lightEntityIdx = 0;
      lightEntityIdx < lightEntities.length;
      lightEntityIdx++
    ) {
      if (shadowIdx >= this.maxShadowSprites) break;
      if (lightsProcessed >= this.maxShadowCastingLights) break;

      const lightIdx = lightEntities[lightEntityIdx];
      if (!lightEnabled[lightIdx]) continue;
      if (!transformActive[lightIdx]) continue;
      if (!isOnScreen[lightIdx]) continue;

      const intensity = lightIntensity[lightIdx];
      if (intensity <= 0) continue;

      lightsProcessed++;

      const lightX = worldX[lightIdx];
      const lightY = worldY[lightIdx];

      // Get neighbors of this light (entities within its visualRange)
      const offset = lightIdx * stride;
      const neighborCount = this.neighborData[offset];

      let shadowsForThisLight = 0;

      // Process neighbors, create shadows for shadow casters
      for (let k = 0; k < neighborCount; k++) {
        if (shadowsForThisLight >= this.maxShadowsPerLight) break;
        if (shadowIdx >= this.maxShadowSprites) break;

        const neighborIdx = this.neighborData[offset + 1 + k];

        // Skip if not a shadow caster
        if (!shadowCasterActive[neighborIdx]) continue;
        if (!transformActive[neighborIdx]) continue;
        if (!isOnScreen[neighborIdx]) continue;

        // Skip if entity has already cast max shadows (if limit is enabled)
        if (
          maxShadowsPerEntity > 0 &&
          entityShadowCounts[neighborIdx] >= maxShadowsPerEntity
        )
          continue;

        const distSq = this.distanceData[offset + 1 + k];

        const casterX = worldX[neighborIdx];
        const casterY = worldY[neighborIdx];
        const casterRadius = entityShadowRadius[neighborIdx] || 10;
        const casterHeight = entityShadowHeight[neighborIdx] || casterRadius;

        // Calculate shadow properties
        const dx = casterX - lightX;
        const dy = casterY - lightY;
        const dist = Math.sqrt(distSq);

        // Skip if light is at caster position (avoid division by zero)
        if (dist < 1) continue;

        // Use normalized direction instead of trig functions (faster)
        const invDist = 1 / dist;
        const dirX = dx * invDist; // cos(angle)
        const dirY = dy * invDist; // sin(angle)

        // Shadow position: at caster's feet, slightly offset in shadow direction
        const posX = casterX + dirX * -casterRadius;
        const posY = casterY + dirY * -casterRadius;

        // Shadow scale based on caster size, height, and distance
        // Closer to light = shorter shadow, farther = longer shadow
        // Taller objects cast longer shadows (height factor)
        // Use distance directly with a reasonable scaling factor (256 as reference)
        const distRatio = dist * 0.00390625; // 1/256 pre-computed
        const clampedDistRatio = distRatio > 1 ? 1 : distRatio;
        const heightFactor = casterHeight * 0.025; // Normalize height: 40 units → 1.0
        const lengthScale = (0.3 + clampedDistRatio * 0.9) * heightFactor;
        const widthScale = casterRadius * 0.0714; // Use entity's shadowRadius for width

        // Shadow alpha: stronger near light, fades with distance

        const alpha = intensity / (distSq * 2);

        // Angle from light to caster (still need atan2 for rotation, but only once per shadow)
        const angle = Math.atan2(dy, dx);

        // Write shadow data
        // FIXED: angle - PI/2 to make shadow point AWAY from light
        // (texture points down by default, we rotate to point in angle direction)
        shadowActive[shadowIdx] = 1;
        shadowRadius[shadowIdx] = casterRadius;
        shadowX[shadowIdx] = posX;
        shadowY[shadowIdx] = posY;
        shadowRotation[shadowIdx] = angle - 1.5707963267948966; // PI/2 as constant
        shadowScaleX[shadowIdx] = widthScale;
        shadowScaleY[shadowIdx] = lengthScale;
        shadowAlpha[shadowIdx] = alpha;

        shadowIdx++;
        shadowsForThisLight++;

        // Track per-entity shadow count (if limit is enabled)
        if (maxShadowsPerEntity > 0) {
          entityShadowCounts[neighborIdx]++;
        }
      }
    }

    // RACE CONDITION FIX: Clear only UNUSED slots at the END
    // This prevents pixi_worker from reading a "cleared" buffer while we're still writing.
    // By clearing only the remaining slots AFTER writing active shadows, the buffer
    // always contains valid shadow data, eliminating the flashing issue.
    for (let i = shadowIdx; i < this.maxShadowSprites; i++) {
      shadowActive[i] = 0;
    }

    // Track shadows updated for stats
    this.shadowsUpdatedThisFrame = shadowIdx;
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
    const marginX = this.canvasWidth * 0.15;
    const marginY = this.canvasHeight * 0.15;
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
      const marginX = this.canvasWidth * 0.15;
      const marginY = this.canvasHeight * 0.15;
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
}

// Create singleton instance
self.particleWorker = new ParticleWorker(self);
