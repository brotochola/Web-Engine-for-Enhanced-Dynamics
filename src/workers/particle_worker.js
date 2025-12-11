// particle_worker.js - Dedicated worker for particle physics
// Updates particle positions, applies gravity, handles lifetime
// Particles are NOT GameObjects - they use ParticleComponent directly

import { ParticleComponent } from "../components/ParticleComponent.js";
import { AbstractWorker } from "./AbstractWorker.js";

// Make components globally available
self.ParticleComponent = ParticleComponent;

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
    if (this.maxParticles === 0) return;

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

    // Count active particles
    let activeCount = 0;

    // ========================================
    // PHASE 1: Clear particles-to-stamp list
    // ========================================
    // Reuse array to avoid allocations
    this.particlesToStamp.length = 0;

    // Pre-calculate camera/viewport bounds for screen visibility (same as spatial_worker)
    let zoom = 1,
      cameraOffsetX = 0,
      cameraOffsetY = 0;
    let minX = 0,
      maxX = 0,
      minY = 0,
      maxY = 0;
    const hasCamera = this.cameraData !== null;

    if (hasCamera) {
      // Read camera data: [zoom, cameraX, cameraY]
      zoom = this.cameraData[0];
      const cameraX = this.cameraData[1];
      const cameraY = this.cameraData[2];

      // Pre-calculate all bounds once
      cameraOffsetX = cameraX * zoom;
      cameraOffsetY = cameraY * zoom;
      const marginX = this.canvasWidth * 0.15;
      const marginY = this.canvasHeight * 0.15;
      minX = -marginX;
      maxX = this.canvasWidth + marginX;
      minY = -marginY;
      maxY = this.canvasHeight + marginY;
    }

    // Update all particles in pool (indices 0 to maxParticles-1)
    for (let i = 0; i < this.maxParticles; i++) {
      if (!active[i]) continue;

      activeCount++;

      // Update lifetime
      currentLife[i] += deltaTime;

      // Check if particle expired
      if (currentLife[i] >= lifespan[i]) {
        // Despawn particle
        active[i] = 0;
        activeCount--; // Particle just died, decrement count
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

        // ========================================
        // BLOOD DECALS: Stamp and despawn
        // ========================================
        // If stayOnTheFloor is enabled, collect particle for stamping
        // Particle will be despawned immediately after stamping
        if (stayOnTheFloor[i]) {
          if (this.decalsEnabled) {
            // Collect particle index for batch stamping after physics loop
            this.particlesToStamp.push(i);
          }
          // Despawn particle immediately (stamp will use cached position/properties)
          active[i] = 0;
          activeCount--;
          continue;
        }

        // Handle fade on floor (only if not stamping)
        if (fadeOnTheFloor[i] > 0) {
          // First frame on floor - store initial alpha
          if (timeOnFloor[i] === 0) {
            initialAlpha[i] = alpha[i];
          }

          // Increment time on floor
          timeOnFloor[i] += deltaTime;

          // Calculate fade progress (0 to 1)
          const fadeProgress = Math.min(timeOnFloor[i] / fadeOnTheFloor[i], 1);

          // Lerp alpha from initial to 0
          alpha[i] = initialAlpha[i] * (1 - fadeProgress);

          // Despawn when fully faded
          if (alpha[i] <= 0) {
            active[i] = 0;
            activeCount--;
            continue;
          }
        }
      }

      // Update screen visibility for this particle (same as spatial_worker)
      if (hasCamera) {
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

    // ========================================
    // PHASE 3: Stamp all collected particles
    // ========================================
    // Process all particles that hit the floor this frame
    // Batching improves cache locality for tile writes
    if (this.particlesToStamp.length > 0) {
      if (this.decalsEnabled) {
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
    }

    // Store for FPS reporting
    this.activeParticleCount = activeCount;
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
