// particle_worker.js - Dedicated worker for particle physics
// Updates particle positions, applies gravity, handles lifetime
// Particles are NOT GameObjects - they use ParticleComponent directly

import { ParticleComponent } from "../components/ParticleComponent.js";
import { Transform } from "../components/Transform.js";
import { LightEmitter } from "../components/LightEmitter.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { ShadowCaster } from "../components/ShadowCaster.js";
import { AbstractWorker } from "./AbstractWorker.js";
import {
  calculateTotalLightAtPosition,
  brightnessToTint,
} from "../core/utils.js";

// Make components globally available
self.ParticleComponent = ParticleComponent;
self.Transform = Transform;
self.LightEmitter = LightEmitter;
self.SpriteRenderer = SpriteRenderer;

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

    // Particle worker doesn't need game scripts
    this.needsGameScripts = false;

    // Particle pool size (separate from entity system)
    this.maxParticles = 0;

    // Active particle count for FPS reporting
    this.activeParticleCount = 0;

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
    this.entityCount = 0; // Number of game entities (for iterating lights)

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
    this.maxShadowSprites = 0;
    this.maxDistanceFromLight = 512;
    this.maxDistanceFromLightSq = 512 * 512;
  }

  /**
   * Initialize the particle worker
   */
  async initialize(data) {
    // Get max particles from config (passed from gameEngine)
    this.maxParticles = data.maxParticles || 0;

    // Store viewport dimensions for screen visibility checks
    this.canvasWidth = this.config.canvasWidth;
    this.canvasHeight = this.config.canvasHeight;

    if (this.maxParticles === 0) {
      console.warn("PARTICLE WORKER: No particles configured!");
      return;
    }

    // Initialize ParticleComponent arrays from SharedArrayBuffer
    if (data.buffers.componentData.ParticleComponent) {
      ParticleComponent.initializeArrays(
        data.buffers.componentData.ParticleComponent,
        this.maxParticles
      );
      ParticleComponent.particleCount = this.maxParticles;
    } else {
      console.error("PARTICLE WORKER: ParticleComponent buffer not found!");
      return;
    }

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
      this.entityCount = data.entityCount || 0;

      // Initialize Transform arrays (need light positions)
      Transform.initializeArrays(
        data.buffers.componentData.Transform,
        this.entityCount
      );

      // Initialize LightEmitter arrays
      LightEmitter.initializeArrays(
        data.buffers.componentData.LightEmitter,
        this.entityCount
      );

      // Initialize SpriteRenderer arrays (for entity tint updates)
      // Entity lighting is enabled by default when lighting is on
      // Can be disabled via config.lighting.entityLighting = false
      if (
        lightingConfig.entityLighting !== false &&
        data.buffers.componentData.SpriteRenderer
      ) {
        this.entityLightingEnabled = true;
        SpriteRenderer.initializeArrays(
          data.buffers.componentData.SpriteRenderer,
          this.entityCount
        );
        console.log(
          `PARTICLE WORKER: Entity lighting enabled (${this.entityCount} entities)`
        );
      }

      console.log(
        `PARTICLE WORKER: Lighting enabled (ambient: ${this.lightingAmbient}, entities: ${this.entityCount})`
      );
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
      this.maxShadowSprites = data.shadows.maxShadowSprites;
      this.maxDistanceFromLight = data.shadows.maxDistanceFromLight;
      this.maxDistanceFromLightSq =
        this.maxDistanceFromLight * this.maxDistanceFromLight;

      // Initialize entity-level ShadowCaster arrays (marks which entities cast shadows)
      ShadowCaster.initializeArrays(
        data.buffers.componentData.ShadowCaster,
        this.entityCount
      );

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
        `PARTICLE WORKER: Shadow system enabled (${this.maxShadowSprites} shadow slots, maxDist: ${this.maxDistanceFromLight})`
      );
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
    if (this.maxParticles === 0 && this.entityCount === 0) return;

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
    this.updateParticleLighting();

    // Update lighting tints for all visible game entities
    this.updateEntityLighting();

    // Calculate shadow sprite positions (uses same neighbor data as lighting)
    this.updateShadowSprites();

    // Store for FPS reporting
    this.activeParticleCount = activeCount;
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

    // Calculate which tile this particle is on
    const tileX = Math.floor(worldX / this.decalsTileSize);
    const tileY = Math.floor(worldY / this.decalsTileSize);

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
    const localX = Math.floor(
      (worldX % this.decalsTileSize) * this.decalsResolution
    );
    const localY = Math.floor(
      (worldY % this.decalsTileSize) * this.decalsResolution
    );

    // Calculate scaled texture dimensions (also scaled by resolution)
    const scaledWidth = Math.ceil(
      texture.width * scale * this.decalsResolution
    );
    const scaledHeight = Math.ceil(
      texture.height * scale * this.decalsResolution
    );

    // Calculate stamp bounds (centered on localX, localY)
    const halfWidth = Math.floor(scaledWidth / 2);
    const halfHeight = Math.floor(scaledHeight / 2);
    const startX = localX - halfWidth;
    const startY = localY - halfHeight;

    // Extract RGB from tint (0xRRGGBB)
    const tintR = (tint >> 16) & 0xff;
    const tintG = (tint >> 8) & 0xff;
    const tintB = tint & 0xff;

    // Tile byte offset in the big RGBA buffer (uses pixel size, not world size)
    const tileByteOffset =
      tileIndex * this.decalsTilePixelSize * this.decalsTilePixelSize * 4;

    // Stamp texture pixels onto tile
    // Uses simple nearest-neighbor scaling for performance
    for (let dy = 0; dy < scaledHeight; dy++) {
      for (let dx = 0; dx < scaledWidth; dx++) {
        // Calculate position in tile (pixel coordinates)
        const tilePixelX = startX + dx;
        const tilePixelY = startY + dy;

        // Skip pixels outside tile bounds (uses pixel size)
        if (
          tilePixelX < 0 ||
          tilePixelX >= this.decalsTilePixelSize ||
          tilePixelY < 0 ||
          tilePixelY >= this.decalsTilePixelSize
        ) {
          continue;
        }

        // Sample from source texture (nearest-neighbor)
        const srcX = Math.floor((dx / scaledWidth) * texture.width);
        const srcY = Math.floor((dy / scaledHeight) * texture.height);
        const srcOffset = (srcY * texture.width + srcX) * 4;

        // Get source RGBA
        const srcR = texture.rgba[srcOffset];
        const srcG = texture.rgba[srcOffset + 1];
        const srcB = texture.rgba[srcOffset + 2];
        // Apply particle alpha to texture alpha
        const srcA = texture.rgba[srcOffset + 3] * alpha;

        // Skip fully transparent pixels
        if (srcA < 1) continue;

        // Calculate destination offset in tile buffer (uses pixel size)
        const dstOffset =
          tileByteOffset +
          (tilePixelY * this.decalsTilePixelSize + tilePixelX) * 4;

        // Apply tint to source color (multiply blend)
        // Tint is normalized: (tintChannel / 255) * srcChannel
        const finalR = Math.floor((srcR * tintR) / 255);
        const finalG = Math.floor((srcG * tintG) / 255);
        const finalB = Math.floor((srcB * tintB) / 255);

        // Alpha blending with existing tile content
        // newColor = srcColor * srcA + dstColor * (1 - srcA)
        const srcAlphaNorm = srcA / 255;
        const invSrcAlpha = 1 - srcAlphaNorm;

        const dstR = this.bloodTilesRGBA[dstOffset];
        const dstG = this.bloodTilesRGBA[dstOffset + 1];
        const dstB = this.bloodTilesRGBA[dstOffset + 2];
        const dstA = this.bloodTilesRGBA[dstOffset + 3];

        // Blend colors
        this.bloodTilesRGBA[dstOffset] = Math.floor(
          finalR * srcAlphaNorm + dstR * invSrcAlpha
        );
        this.bloodTilesRGBA[dstOffset + 1] = Math.floor(
          finalG * srcAlphaNorm + dstG * invSrcAlpha
        );
        this.bloodTilesRGBA[dstOffset + 2] = Math.floor(
          finalB * srcAlphaNorm + dstB * invSrcAlpha
        );
        // Alpha: combine using "over" operator
        this.bloodTilesRGBA[dstOffset + 3] = Math.floor(
          srcA + dstA * invSrcAlpha
        );
      }
    }

    // Mark tile as dirty so pixi_worker updates its texture
    this.bloodTilesDirty[tileIndex] = 1;
  }

  /**
   * Calculate lighting tints for all active particles
   * Uses inverse square falloff: brightness = ambient + Σ(intensity / d²)
   * Multiplies original particle tint by brightness to preserve color
   */
  updateParticleLighting() {
    if (!this.lightingEnabled || this.maxParticles === 0) return;

    // Cache particle arrays
    const active = ParticleComponent.active;
    const particleX = ParticleComponent.x;
    const particleY = ParticleComponent.y;
    const tint = ParticleComponent.tint;
    const baseTint = ParticleComponent.baseTint; // Original color set by emitter

    // Prepare light data object for utility function
    const lightData = this.getLightData();

    // Calculate lighting for each active particle
    for (let i = 0; i < this.maxParticles; i++) {
      if (!active[i]) continue;

      // Calculate total light at particle position
      const brightness = calculateTotalLightAtPosition(
        particleX[i],
        particleY[i],
        lightData,
        this.lightingAmbient
      );

      // Apply brightness to the original particle color (baseTint)
      // This preserves blood red color while darkening/brightening based on lighting
      tint[i] = this.applyBrightnessToColor(baseTint[i], brightness * 3000);
    }
  }

  /**
   * Calculate lighting tints for all visible game entities with SpriteRenderer
   * Only updates entities that are active and on screen for performance
   * Requires config.lighting.entityLighting = true to enable
   * Uses precomputed squared distances from spatial worker when available
   */
  updateEntityLighting() {
    if (
      !this.entityLightingEnabled ||
      !SpriteRenderer.tint ||
      !SpriteRenderer.baseTint
    ) {
      return;
    }

    // Cache component arrays
    const active = Transform.active;
    const tint = SpriteRenderer.tint;
    const baseTint = SpriteRenderer.baseTint;
    const isItOnScreen = SpriteRenderer.isItOnScreen;

    // Check if we can use precomputed distances from spatial worker
    const usePrecomputedDistances =
      this.neighborData &&
      this.distanceData &&
      this.config.spatial?.maxNeighbors;

    if (usePrecomputedDistances) {
      // OPTIMIZED PATH: Iterate through LIGHTS and use their neighbors
      // The LIGHT's visualRange determines which entities receive light
      const lightIntensity = LightEmitter.lightIntensity;
      const lightEnabled = LightEmitter.active;
      const maxNeighbors = this.config.spatial.maxNeighbors;
      const stride = 1 + maxNeighbors;
      const ambient = this.lightingAmbient;

      // Reuse or create brightness accumulator array
      if (
        !this.entityBrightness ||
        this.entityBrightness.length < this.entityCount
      ) {
        this.entityBrightness = new Float32Array(this.entityCount);
      }
      const entityBrightness = this.entityBrightness;

      // Initialize all entities to ambient light
      for (let i = 0; i < this.entityCount; i++) {
        entityBrightness[i] = ambient;
      }

      // For each LIGHT, add its contribution to its neighbors
      // This uses the LIGHT's visualRange to determine reach
      for (let lightIdx = 0; lightIdx < this.entityCount; lightIdx++) {
        if (!lightEnabled[lightIdx]) continue;

        const intensity = lightIntensity[lightIdx];
        if (intensity <= 0) continue;

        const offset = lightIdx * stride;
        const neighborCount = this.neighborData[offset];

        // Add this light's contribution to all its neighbors
        for (let k = 0; k < neighborCount; k++) {
          const neighborIdx = this.neighborData[offset + 1 + k];
          const distSq = this.distanceData[offset + 1 + k];

          // inverse square falloff: intensity / (1 + distSq)
          entityBrightness[neighborIdx] += intensity / (1 + distSq);
        }
      }

      // Apply accumulated brightness to visible entities
      for (let i = 0; i < this.entityCount; i++) {
        if (!active[i] || !isItOnScreen[i]) continue;
        //Light Emitters are always fully lit
        if (LightEmitter.active[i] === 1) {
          tint[i] = 0xffffff;
          continue;
        }

        const entityBaseTint = baseTint[i];
        if (entityBaseTint === 0) continue;

        const brightness = entityBrightness[i];
        tint[i] = this.applyBrightnessToColor(
          entityBaseTint,
          brightness * 9000
        );
        SpriteRenderer.renderDirty[i] = 1;
      }
    }
    // else {
    //   // FALLBACK PATH: Calculate distances manually (no spatial data available)
    //   const entityX = Transform.x;
    //   const entityY = Transform.y;
    //   const lightData = this.getLightData();

    //   for (let i = 0; i < this.entityCount; i++) {
    //     // Skip inactive or off-screen entities
    //     if (!active[i] || !isItOnScreen[i]) continue;

    //     // Skip entities with uninitialized baseTint (0 = black, likely not set)
    //     const entityBaseTint = baseTint[i];
    //     if (entityBaseTint === 0) continue;

    //     // Calculate total light at entity position (manual distance calculation)
    //     const brightness = calculateTotalLightAtPosition(
    //       entityX[i],
    //       entityY[i],
    //       lightData,
    //       this.lightingAmbient
    //     );

    //     // Apply brightness to the original entity color (baseTint)
    //     tint[i] = this.applyBrightnessToColor(
    //       entityBaseTint,
    //       brightness * 3000
    //     );
    //   }
    // }
  }

  /**
   * Calculate shadow sprite positions for all active lights
   * Iterates through lights, finds nearby shadow casters, writes to shadow sprite buffer
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
    const isOnScreen = SpriteRenderer.isItOnScreen;

    const maxNeighbors = this.config.spatial.maxNeighbors;
    const stride = 1 + maxNeighbors;
    const maxDistSq = this.maxDistanceFromLightSq;

    // Shadow sprite output arrays (shadowActive already cached above)
    const shadowRadius = this.shadowSpriteRadius;
    const shadowX = this.shadowSpriteX;
    const shadowY = this.shadowSpriteY;
    const shadowRotation = this.shadowSpriteRotation;
    const shadowScaleX = this.shadowSpriteScaleX;
    const shadowScaleY = this.shadowSpriteScaleY;
    const shadowAlpha = this.shadowSpriteAlpha;

    let shadowIdx = 0;
    let lightsProcessed = 0;

    // For each LIGHT, find nearby shadow casters and generate shadows
    for (let lightIdx = 0; lightIdx < this.entityCount; lightIdx++) {
      if (shadowIdx >= this.maxShadowSprites) break;
      if (lightsProcessed >= this.maxShadowCastingLights) break;
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

        const distSq = this.distanceData[offset + 1 + k];

        // Skip if too far from light
        if (distSq > maxDistSq) continue;

        const casterX = worldX[neighborIdx];
        const casterY = worldY[neighborIdx];
        const casterRadius = entityShadowRadius[neighborIdx] || 10;

        // Calculate shadow properties
        const dx = casterX - lightX;
        const dy = casterY - lightY;
        const dist = Math.sqrt(distSq);

        // Skip if light is at caster position (avoid division by zero)
        if (dist < 1) continue;

        // Angle from light to caster = direction shadow should point (AWAY from light)
        const angle = Math.atan2(dy, dx);

        // Shadow position: at caster's feet, slightly offset in shadow direction
        const offsetDist = -casterRadius * 0.5;
        const posX = casterX + Math.cos(angle) * offsetDist;
        const posY = casterY + Math.sin(angle) * offsetDist;

        // Shadow scale based on caster size and distance
        // Closer to light = shorter shadow, farther = longer shadow
        const distRatio = Math.min(dist / this.maxDistanceFromLight, 1);
        const lengthScale = 0.5 + distRatio; // 0.3 to 0.8 (shorter shadows)
        const widthScale = casterRadius / 10; // Use entity's shadowRadius for width

        // Shadow alpha: stronger near light, fades with distance
        const intensityFactor = Math.min(intensity * 0.66, 1);
        const distFade = 1 - distRatio * 0.7; // 1.0 to 0.3
        const alpha = Math.min(intensityFactor * distFade, 0.7);

        // Write shadow data
        // FIXED: angle - PI/2 to make shadow point AWAY from light
        // (texture points down by default, we rotate to point in angle direction)
        shadowActive[shadowIdx] = 1;
        shadowRadius[shadowIdx] = casterRadius;
        shadowX[shadowIdx] = posX;
        shadowY[shadowIdx] = posY;
        shadowRotation[shadowIdx] = angle - Math.PI / 2; // FIXED: was + PI/2, now - PI/2
        shadowScaleX[shadowIdx] = widthScale;
        shadowScaleY[shadowIdx] = lengthScale;
        shadowAlpha[shadowIdx] = alpha;

        shadowIdx++;
        shadowsForThisLight++;
      }
    }

    // RACE CONDITION FIX: Clear only UNUSED slots at the END
    // This prevents pixi_worker from reading a "cleared" buffer while we're still writing.
    // By clearing only the remaining slots AFTER writing active shadows, the buffer
    // always contains valid shadow data, eliminating the flashing issue.
    for (let i = shadowIdx; i < this.maxShadowSprites; i++) {
      shadowActive[i] = 0;
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
      lightCount: this.entityCount,
    };
  }

  /**
   * Apply brightness multiplier to a color while preserving hue
   * @param {number} color - Original color in 0xRRGGBB format
   * @param {number} brightness - Brightness multiplier (0 to 1+)
   * @returns {number} Lit color in 0xRRGGBB format
   */
  applyBrightnessToColor(color, brightness) {
    // Clamp brightness to prevent over-saturation
    const b = Math.min(brightness, 1.0);

    // Extract RGB channels
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const blue = color & 0xff;

    // Apply brightness
    const litR = Math.round(r * b);
    const litG = Math.round(g * b);
    const litB = Math.round(blue * b);

    return (litR << 16) | (litG << 8) | litB;
  }

  /**
   * Override reportFPS to include active/total particle count
   */
  reportFPS() {
    if (this.frameNumber % this.fpsReportInterval === 0) {
      self.postMessage({
        msg: "fps",
        fps: this.currentFPS.toFixed(2),
        activeParticles: this.activeParticleCount,
        totalParticles: this.maxParticles,
      });
    }
  }
}

// Create singleton instance
self.particleWorker = new ParticleWorker(self);
