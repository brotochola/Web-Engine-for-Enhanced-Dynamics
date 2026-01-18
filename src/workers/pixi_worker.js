self.postMessage({
  msg: "log",
  message: "js loaded",
  when: Date.now(),
});

// pixi_worker.js - Rendering worker using PixiJS with AnimatedSprite support
// Reads GameObject arrays and renders sprites with animations

// Import engine dependencies
import { GameObject } from "../core/gameObject.js";
import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { ParticleComponent } from "../components/ParticleComponent.js";
import { DecorationComponent } from "../components/DecorationComponent.js";
import { DecorationPool } from "../core/DecorationPool.js";
import { SpriteSheetRegistry } from "../core/SpriteSheetRegistry.js";
import { AbstractWorker } from "./AbstractWorker.js";
import { DEBUG_FLAGS } from "../core/DebugFlags.js";
import { Mouse } from "../core/Mouse.js";
import { MouseComponent } from "../components/MouseComponent.js";
import { LightEmitter } from "../components/LightEmitter.js";
import { Grid } from "../core/Grid.js";
import { Ray } from "../core/Ray.js";
import { Z_INDICES, LAYER_DEFAULT_BLEND_MODES } from "../core/ConfigDefaults.js";
import {
  drawLine,
  drawCircle,
  drawCross,
  sortByY,
  drawDigit,
  setNestedProperty,
  normalizeAngleDifference,
  extractRGBNormalized,
} from "../core/utils.js";
import { RENDERER_STATS, createStatsWriter } from "./workers-utils.js";

// Import PixiJS 8 library (ES6 module with named exports)
import {
  Application,
  Container,
  Sprite,
  Texture,
  Rectangle,
  Graphics,
  TilingSprite,
  TextureSource,
  ImageSource,
  Ticker,
  ParticleContainer,
  Particle,
  Matrix,
  // Shader/Mesh for lighting system
  Geometry,
  Mesh,
  Shader,
  GlProgram,
  extensions,
  RendererType,
  RenderTexture,
} from "./pixi8webworker.js";
import { convertRGBtoBGR } from "../core/utils.js";
// Import @pixi/tilemap for efficient tilemap rendering (modified to import from pixi8webworker.js)
import {
  CompositeTilemap,
  TilemapPipe,
  settings as tilemapSettings,
} from "../lib/pixi-tilemap-module.js";

// Enable 32-bit indices for large tilemaps (>16K tiles)
// Without this, only ~16,383 tiles can be rendered due to 16-bit index limit
tilemapSettings.use32bitIndex = true;

// Register @pixi/tilemap extension
extensions.add(TilemapPipe);

// Create PIXI-like namespace for compatibility with existing code patterns
const PIXI = {
  Application,
  Container,
  Sprite,
  Texture,
  Rectangle,
  Graphics,
  TilingSprite,
  TextureSource,
  ImageSource,
  Ticker,
  ParticleContainer,
  Particle,
  Matrix,
  Geometry,
  Mesh,
  Shader,
  GlProgram,
  RendererType,
  RenderTexture,
};

// Note: Core engine classes (GameObject, Mouse, etc.) and components
// (Transform, RigidBody, etc.) are now registered automatically by AbstractWorker.
// Game-specific entity classes are loaded dynamically.

// Make PIXI namespace available globally (renderer-specific)
self.PIXI = PIXI;

// Single ParticleContainer with Y-sorting for depth

/**
 * Centralized pool for PIXI.Particle objects
 * All sprites (entities, decorations, particles) share the same pool for maximum reuse
 */
class PixiParticlePool {
  constructor() {
    this.particles = []; // Array of all created PIXI.Particle objects
    this.freeIndices = []; // Stack of available particle indices
    this.createdCount = 0; // Total particles created (for stats)
    this.defaultTexture = null; // Default texture for new particles

    // Deferred allocation tracking (allocate during idle frames)
    this.newParticlesThisFrame = 0; // Particles created this frame
    this.accumulatedNewParticles = 0; // Total demand across frames
    this.framesSinceLastAcquire = 0; // Idle frame counter

    // PERFORMANCE: Reusable acquire result object to avoid GC pressure
    this._acquireResult = { particle: null, index: -1 };
  }

  /**
   * Set the default texture for newly created particles
   * Must be from bigAtlas to ensure all particles share the same source
   */
  setDefaultTexture(texture) {
    this.defaultTexture = texture;
  }

  /**
   * Get a particle from the pool (reuse free one or create new)
   * @returns {{ particle: PIXI.Particle, index: number }}
   */
  acquire() {
    let particleIndex;
    let particle;

    // Try to reuse a freed particle first
    if (this.freeIndices.length > 0) {
      particleIndex = this.freeIndices.pop();
      particle = this.particles[particleIndex];

      // Reset particle to default visible state (caller will set actual values)
      particle.visible = false; // Caller makes it visible when ready
      particle.alpha = 1;
      particle.scaleX = 1;
      particle.scaleY = 1;
      particle.tint = 0xffffff;
      particle.rotation = 0;
      particle.anchorX = 0.5;
      particle.anchorY = 0.5;

      // CRITICAL: Reset texture to default to prevent texture bleeding between entities
      if (this.defaultTexture) {
        particle.texture = this.defaultTexture;
      }
    } else {
      // No free particles available - create a new one
      const texture = this.defaultTexture || PIXI.Texture.WHITE;
      particle = new PIXI.Particle({
        texture,
        anchorX: 0.5,
        anchorY: 0.5,
      });

      particle.visible = false; // Start hidden

      particleIndex = this.particles.length;
      this.particles.push(particle);
      this.createdCount++;

      // Track that we created a particle THIS FRAME
      this.newParticlesThisFrame++;
      this.framesSinceLastAcquire = 0;
    }

    // Reuse result object to avoid GC pressure
    this._acquireResult.particle = particle;
    this._acquireResult.index = particleIndex;
    return this._acquireResult;
  }

  /**
   * Return a particle to the pool for reuse
   * @param {number} particleIndex - Index of particle in particles array
   */
  release(particleIndex) {
    if (particleIndex < 0 || particleIndex >= this.particles.length) return;

    const particle = this.particles[particleIndex];
    if (!particle) return;

    // Hide particle and reset state for reuse
    particle.visible = false;
    particle.alpha = 1;
    particle.scaleX = 1;
    particle.scaleY = 1;
    particle.tint = 0xffffff;
    particle.x = 0;
    particle.y = 0;
    particle.rotation = 0;

    // Add to free list
    this.freeIndices.push(particleIndex);
  }

  /**
   * Called once per frame after all sprite updates
   * Detects idle frames and triggers deferred pre-allocation
   */
  endFrame() {
    if (this.newParticlesThisFrame > 0) {
      // Active frame - accumulate demand
      this.accumulatedNewParticles += this.newParticlesThisFrame;
      this.newParticlesThisFrame = 0;
      this.framesSinceLastAcquire = 0;
    } else {
      // Idle frame - no new particles were acquired
      this.framesSinceLastAcquire++;

      // First idle frame after demand - pre-allocate based on accumulated demand
      if (
        this.framesSinceLastAcquire === 1 &&
        this.accumulatedNewParticles > 0
      ) {
        const extraCount = Math.ceil(this.accumulatedNewParticles * 0.1);
        this.preallocate(extraCount);
        this.accumulatedNewParticles = 0; // Reset accumulator
      }
    }
  }

  /**
   * Pre-allocate particles into the free pool (batch operation during idle frames)
   * @param {number} count - Number of particles to pre-allocate
   */
  preallocate(count) {
    const texture = this.defaultTexture || PIXI.Texture.WHITE;

    for (let i = 0; i < count; i++) {
      const particle = new PIXI.Particle({
        texture,
        anchorX: 0.5,
        anchorY: 0.5,
      });
      particle.visible = false;

      const index = this.particles.length;
      this.particles.push(particle);
      this.freeIndices.push(index); // Add to free pool immediately
      this.createdCount++;
    }
  }

  /**
   * Get current pool statistics
   */
  getStats() {
    return {
      created: this.createdCount,
      free: this.freeIndices.length,
      inUse: this.createdCount - this.freeIndices.length,
    };
  }
}

/**
 * PixiRenderer - Manages rendering of game objects using PixiJS in a web worker
 * Extends AbstractWorker for common worker functionality
 */
class PixiRenderer extends AbstractWorker {
  // Z_INDICES imported from ConfigDefaults.js for centralized layer ordering
  static Z_INDICES = Z_INDICES;

  queryConfig = [SpriteRenderer];

  constructor(selfRef) {
    super(selfRef);

    // Use PIXI ticker instead of requestAnimationFrame
    this.usesCustomScheduler = true;

    // Renderer configuration options (set during initialize)
    this.ySorting = false; // Enable/disable Y-sorting for depth ordering
    this.bgTextureName = null; // Texture name to use for background
    this.interpolation = true; // Enable/disable interpolation based on physics FPS
    this.physicsWorkerIndex = 1; // Index of physics worker in frameRateData (Scene.WORKER_INDICES.PHYSICS)

    // PIXI application and rendering
    this.pixiApp = null;
    // Single ParticleContainer with Y-sorting for proper depth ordering
    // Will be created during initialization with correct entityCount
    this.particleContainer = null;
    this.backgroundSprite = null;

    // Texture and spritesheet storage
    this.textures = {}; // Store simple PIXI textures by name
    this.spritesheets = {}; // Store loaded spritesheets by name
    this.tilemaps = {}; // Store loaded tilemap data (Tiled JSON + tileset texture)
    this.currentTilemap = null; // Currently active tilemap background
    this.tilemapScale = { x: 1, y: 1 }; // Base scale for tilemap (renders at scan * zoom)

    // ========================================
    // CENTRALIZED PARTICLE POOL
    // ========================================
    // All sprites (entities, decorations, particles) share the same pool
    this.particlePool = new PixiParticlePool();

    // Entity rendering
    // this.containers = []; // Array of PIXI containers (one per entity)
    this.bodySprites = []; // Array of PIXI.Particle references (indexed by entityIndex, null if not spawned)
    this.bodySpritePoolIndices = null; // Int32Array - Maps entityIndex to pool index (or -1 if no sprite)
    this.entitySpriteConfigs = {}; // Store sprite config per entityType
    this.previousAnimStates = null; // Int16Array - Track previous animation state per entity (-1 = unset, initialized in createSprites)

    // Manual animation tracking (for regular Sprites)
    this.currentAnimationFrames = []; // Array of texture arrays (one per entity)
    this.currentFrameIndex = null; // Uint16Array - Current frame index in animation (initialized in createSprites)
    this.frameAccumulator = null; // Float32Array - Time accumulator for frame advancement (initialized in createSprites)
    this.animationSpeed = null; // Float32Array - Animation speed per entity (frames per second) (initialized in createSprites)

    // Particle rendering (separate from entities)
    this.particleSprites = []; // Array of PIXI.Particle references (indexed 0 to maxParticles-1, null if not active)
    this.particleSpritePoolIndices = null; // Int32Array - Maps particle index to pool index (or -1 if no sprite)
    this.maxParticles = 0; // Number of particle slots
    this.particleTextureCache = {}; // Cache for particle textures by textureId

    // Decoration rendering (separate from entities, static sprites)
    this.decorationSprites = []; // Array of PIXI.Particle references (indexed by decoration, null if not spawned)
    this.decorationSpritePoolIndices = null; // Int32Array - Maps decoration index to pool index (or -1 if no sprite)
    this.decorationSpriteTextureIds = null; // Uint16Array - Track current textureId per decoration (for texture change detection)
    this.maxDecorations = 0; // Number of decoration slots
    this.visibleDecorationCount = 0; // Number of visible decorations

    // World and viewport dimensions
    this.worldWidth = 0;
    this.worldHeight = 0;
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.canvasView = null;

    // Visible units tracking (throttled reporting)
    this.lastReportedVisibleCount = -1;
    this.visibleUnitsReportInterval = 500; // Report every 500ms
    this.lastVisibleUnitsReportTime = 0;

    // Draw call tracking
    this.drawCallCount = 0;
    this.visibleEntityCount = 0;
    this.visibleParticleCount = 0;

    // Debug visualization
    this.debugLayer = null; // PIXI.Graphics for debug overlays
    this.debugFlags = null; // Uint8Array view of debug flags from SharedArrayBuffer
    this.raycastDebugBuffer = null; // Float32Array - raycast visualization data
    this.maxDebugRaycasts = 100; // Maximum raycasts to render
    this.frameCount = 0; // Frame counter for clearing debug raycasts every 3 frames
    this.debugColors = {
      collider: 0x00ff00, // Green
      trigger: 0xffff00, // Yellow
      velocity: 0x0088ff, // Blue
      acceleration: 0xff0044, // Red
      neighbor: 0x00ffff, // Cyan
      grid: 0x444444, // Gray
      aabb: 0xff8800, // Orange
      text: 0xffffff, // White
    };

    // Per-instance spritesheet tracking
    this.currentSpritesheetIds = null; // Will be initialized in createSprites

    // ========================================
    // Y-SORTING POOL (GC optimization)
    // ========================================
    // Reusable pool of objects for Y-sorting to avoid per-frame allocations
    this._ySortPool = [];
    this._ySortPoolSize = 0;

    // ========================================
    // decal DECALS TILEMAP SYSTEM
    // ========================================
    // Renders decal splats stamped by particle_worker onto tile sprites
    this.decalsEnabled = false;
    this.decalsTileSize = 256; // World units each tile covers
    this.decalsTilePixelSize = 256; // Actual texture pixel size
    this.decalsResolution = 1.0; // Resolution multiplier
    this.decalsTilesX = 0;
    this.decalsTilesY = 0;
    this.decalsTotalTiles = 0;

    // SharedArrayBuffer views (shared with particle_worker)
    this.decalTilesRGBA = null; // Uint8ClampedArray - RGBA pixel data
    this.decalTilesDirty = null; // Uint8Array - dirty flags (0=clean, 1=modified)

    // PIXI rendering
    this.decalTileContainer = null; // Container for decal tile sprites
    this.decalTileSprites = []; // Array of Sprite per tile
    this.decalTileTextureSources = []; // TextureSource per tile (for updating)

    // ========================================
    // LIGHTING SYSTEM
    // ========================================
    // Full-screen shader mesh for dynamic lighting (multiply blend)
    // Configured via config.lighting: { enabled, lightingAmbient }
    this.lightingEnabled = false;
    this.lightingMesh = null; // PIXI.Mesh with lighting shader
    this.lightingShader = null; // Shader instance for updating uniforms
    this.lightingAmbient = 0.05; // Ambient light level (0-1), read from config
    this.maxLights = 128; // Maximum number of lights (default: 128), read from config
    this.lightingResolution = 1.0; // Resolution multiplier for lighting (e.g. 0.5 for half res)
    this.lightingRT = null; // RenderTexture for low-res lighting
    this.lightingDisplaySprite = null; // Sprite to display the lightingRT on stage

    // Reusable pool for light sorting (GC optimization)
    this._lightPool = [];
    this._lightPoolSize = 0;

    // ========================================
    // RENDER-TEXTURE SHADOW SYSTEM
    // ========================================
    // Shadows are rendered to a RenderTexture with interleaved light gradients
    // For each light: render light gradient (white/colored), then shadows (black)
    // Later lights' gradients overwrite earlier shadows, creating realistic light interaction
    // The final texture is applied with MULTIPLY blend to darken the scene
    this.shadowSpritesEnabled = false;
    this.maxShadowSprites = 0;
    this.shadowSprites = []; // Array of Particle objects for shadows
    this.shadowLightSprites = []; // Array of Particle objects for light gradients (one per light)

    // RenderTexture-based shadow compositing
    this.shadowRT = null; // RenderTexture for shadow compositing
    this.shadowParticleContainer = null; // ParticleContainer for lights + shadows
    this.shadowDisplaySprite = null; // Sprite to display shadowRT with multiply blend
    this.shadowResolution = 1.0; // Resolution multiplier for shadow RT
    this.shadowBackgroundSprite = null; // White square covering screen (first particle = white bg)

    // Reusable render-state for interpolation
    this._renderCameraX = 0;
    this._renderCameraY = 0;
    this._renderZoom = 1.0;
    this._cameraInitialized = false;

    // Reusable matrices for low-res rendering
    this._shadowTransform = new PIXI.Matrix();
    this._lightingTransform = new PIXI.Matrix(); // NDC mesh doesn't really need it but good to have

    // ========================================
    // LIGHT GLOW SPRITE SYSTEM
    // ========================================
    // Additive-blend glow sprites rendered at light positions
    // Uses _lightGradient texture from BigAtlas
    this.lightGlowEnabled = false;
    this.lightGlowContainer = null; // ParticleContainer for glow sprites
    this.lightGlowSprites = []; // Array of Particle objects (one per entity slot)
    this.lightGlowTexture = null; // PIXI.Texture reference to _lightGradient
  }

  /**
   * Hook into WebGL context to count draw calls per frame
   */
  setupWebGLHooks() {
    this.setupDrawCallMonitoring();

    const gl = this.pixiApp.renderer.gl;
    if (gl && gl.canvas) {
      gl.canvas.addEventListener(
        "webglcontextlost",
        (e) => {
          e.preventDefault();
          this.reportError(
            "WebGL Context Lost",
            new Error(
              "The GPU context was lost. This usually happens due to GPU driver crashes or excessive resource usage."
            )
          );
        },
        false
      );

      gl.canvas.addEventListener(
        "webglcontextrestored",
        () => {
          this.reportLog("WebGL context restored");
          // In a real engine we might need to reload textures here,
          // but PIXI often handles some of this.
        },
        false
      );
    }
  }

  setupDrawCallMonitoring() {
    const gl = this.pixiApp.renderer.gl;
    if (!gl) {
      console.warn(
        "PIXI WORKER: Could not access WebGL context for draw call monitoring"
      );
      return;
    }

    const renderer = this;

    // Wrap drawArrays
    const originalDrawArrays = gl.drawArrays.bind(gl);
    gl.drawArrays = function (...args) {
      renderer.drawCallCount++;
      return originalDrawArrays(...args);
    };

    // Wrap drawElements
    const originalDrawElements = gl.drawElements.bind(gl);
    gl.drawElements = function (...args) {
      renderer.drawCallCount++;
      return originalDrawElements(...args);
    };

    // Wrap drawArraysInstanced (for instanced rendering)
    if (gl.drawArraysInstanced) {
      const originalDrawArraysInstanced = gl.drawArraysInstanced.bind(gl);
      gl.drawArraysInstanced = function (...args) {
        renderer.drawCallCount++;
        return originalDrawArraysInstanced(...args);
      };
    }

    // Wrap drawElementsInstanced (for instanced rendering)
    if (gl.drawElementsInstanced) {
      const originalDrawElementsInstanced = gl.drawElementsInstanced.bind(gl);
      gl.drawElementsInstanced = function (...args) {
        renderer.drawCallCount++;
        return originalDrawElementsInstanced(...args);
      };
    }

    console.log("PIXI WORKER: Draw call monitoring enabled");
  }

  /**
   * Override reportFPS to write stats to SharedArrayBuffer
   */
  reportFPS() {
    // Write stats to SharedArrayBuffer every frame (no throttling needed - it's just memory writes)
    if (this.stats) {
      this.stats[RENDERER_STATS.FPS] = this.currentFPS;
      this.stats[RENDERER_STATS.DRAW_CALLS] = this.drawCallCount;

      // Total visible sprites = entities + particles + decorations
      const totalVisibleSprites =
        this.visibleEntityCount +
        this.visibleParticleCount +
        this.visibleDecorationCount;

      // SPRITES_CREATED = total PIXI.Particle objects created (from centralized pool)
      this.stats[RENDERER_STATS.SPRITES_CREATED] =
        this.particlePool.createdCount;

      // VISIBLE_SPRITES = sprites currently visible on screen
      this.stats[RENDERER_STATS.VISIBLE_SPRITES] = totalVisibleSprites;

      // Keep decoration stats for DebugUI (reuse same values)
      this.stats[RENDERER_STATS.DECORATION_SPRITES] =
        this.particlePool.createdCount;
      this.stats[RENDERER_STATS.VISIBLE_DECORATIONS] =
        this.visibleDecorationCount;

      // NEW: Separate counts for entities and particles
      this.stats[RENDERER_STATS.VISIBLE_ENTITIES] = this.visibleEntityCount;
      this.stats[RENDERER_STATS.VISIBLE_PARTICLES] = this.visibleParticleCount;

      // Active decorations count (from shared counter)
      this.stats[RENDERER_STATS.ACTIVE_DECORATIONS] = DecorationPool.activeCount
        ? DecorationPool.activeCount[0]
        : 0;
    }

    // Reset draw call counter for next frame
    this.drawCallCount = 0;
  }

  /**
   * Update camera transform on particle container, background, and decal tiles
   */
  updateCameraTransform() {
    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;

    // Apply camera state to particle container
    this.particleContainer.scale.set(zoom);
    this.particleContainer.x = -cameraX * zoom;
    this.particleContainer.y = -cameraY * zoom;

    // Apply camera state to background (since it's not a child of particleContainer)
    if (this.backgroundSprite) {
      this.backgroundSprite.scale.set(zoom);
      this.backgroundSprite.x = -cameraX * zoom;
      this.backgroundSprite.y = -cameraY * zoom;
    }

    // Apply camera state to tilemap background
    if (this.currentTilemap) {
      this.currentTilemap.scale.set(
        zoom * this.tilemapScale.x,
        zoom * this.tilemapScale.y
      );
      this.currentTilemap.x = -cameraX * zoom;
      this.currentTilemap.y = -cameraY * zoom;
    }

    // Apply camera state to decal tile container
    if (this.decalTileContainer) {
      this.decalTileContainer.scale.set(zoom);
      this.decalTileContainer.x = -cameraX * zoom;
      this.decalTileContainer.y = -cameraY * zoom;
    }

    // Shadow sprites are now in main particleContainer (get camera transform automatically)

    // Apply camera state to light glow container
    if (this.lightGlowContainer) {
      this.lightGlowContainer.scale.set(zoom);
      this.lightGlowContainer.x = -cameraX * zoom;
      this.lightGlowContainer.y = -cameraY * zoom;
    }
  }

  /**
   * Render debug overlays based on enabled flags
   */
  renderDebugOverlays() {
    if (!this.debugLayer || !this.debugFlags) return;

    // Clear previous debug drawings
    this.debugLayer.clear();

    // Apply camera transform to debug layer so it moves with the world
    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];
    this.debugLayer.scale.set(zoom);
    this.debugLayer.x = -cameraX * zoom;
    this.debugLayer.y = -cameraY * zoom;

    // Cache array references
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isOnScreen = SpriteRenderer.isItOnScreen;

    // Render spatial grid if enabled
    if (this.debugFlags[DEBUG_FLAGS.SHOW_SPATIAL_GRID]) {
      this.renderSpatialGrid();
    }

    // Render per-entity debug visualizations
    // OPTIMIZED: Iterate only ACTIVE entities for debug rendering
    // Avoids checking 100k entities when only a few hundred are active
    const activeEntitiesData = this.activeEntitiesData;
    const count = activeEntitiesData ? activeEntitiesData[0] : 0;

    for (let j = 0; j < count; j++) {
      // activeEntitiesData layout: [count, idx0, idx1, ...]
      const i = activeEntitiesData[1 + j];

      // Double check active state (redundant but safe)
      if (!active[i]) continue;

      // DENSE: use entity index directly for component access
      if (!isOnScreen[i]) continue;

      const posX = x[i];
      const posY = y[i];

      // Render colliders
      if (this.debugFlags[DEBUG_FLAGS.SHOW_COLLIDERS]) {
        this.renderCollider(i, posX, posY);
      }

      // Render velocity vectors
      if (this.debugFlags[DEBUG_FLAGS.SHOW_VELOCITY]) {
        this.renderVelocityVector(i, posX, posY);
      }

      // Render acceleration vectors
      if (this.debugFlags[DEBUG_FLAGS.SHOW_ACCELERATION]) {
        this.renderAccelerationVector(i, posX, posY);
      }

      // Render entity index
      if (this.debugFlags[DEBUG_FLAGS.SHOW_ENTITY_INDICES]) {
        this.renderEntityIndex(i, posX, posY);
      }
    }

    // Render neighbor connections (after all entities to avoid occlusion)
    if (this.debugFlags[DEBUG_FLAGS.SHOW_NEIGHBORS]) {
      this.renderNeighborConnections();
    }

    // Render raycasts (after all entities)
    if (this.debugFlags[DEBUG_FLAGS.SHOW_RAYCASTS]) {
      this.renderRaycasts();
    }
  }

  /**
   * Render collision shape for an entity
   * DENSE ALLOCATION: entityIndex === componentIndex
   */
  renderCollider(entityIndex, posX, posY) {
    if (!Collider) return;

    // DENSE: use entity index directly for component access
    const shapeType = Collider.shapeType[entityIndex];
    const isTrigger = Collider.isTrigger[entityIndex];

    // Get offset from entity position
    const offsetX = Collider.offsetX[entityIndex] || 0;
    const offsetY = Collider.offsetY[entityIndex] || 0;
    const renderX = posX + offsetX;
    const renderY = posY + offsetY;

    // Choose color based on trigger status
    const color = isTrigger
      ? this.debugColors.trigger
      : this.debugColors.collider;

    const strokeWidth = 2 / this.cameraData[0];
    const strokeOptions = {
      width: strokeWidth,
      color,
      alpha: 0.8,
    };

    // Render based on shape type
    if (shapeType === 0) {
      // Circle shape
      const radius = Collider.radius[entityIndex];
      if (radius === 0) return; // No collider (default value)

      // Debug: log a few mappings
      if (this.frameNumber === 60 && entityIndex >= 1 && entityIndex <= 5) {
        console.log(
          `DEBUG: Entity ${entityIndex} -> Collider radius=${radius.toFixed(
            2
          )}, pos=(${posX.toFixed(0)}, ${posY.toFixed(0)})`
        );
      }

      // PixiJS 8: draw circle then stroke
      this.debugLayer.circle(renderX, renderY, radius);
      this.debugLayer.stroke(strokeOptions);
    } else if (shapeType === 1) {
      // Box shape
      const width = Collider.width[entityIndex];
      const height = Collider.height[entityIndex];

      if (width === 0 || height === 0) return; // No collider (default value)

      // Debug: log a few mappings
      if (this.frameNumber === 60 && entityIndex >= 1 && entityIndex <= 5) {
        console.log(
          `DEBUG: Entity ${entityIndex} -> Collider box=${width.toFixed(
            2
          )}x${height.toFixed(2)}, pos=(${posX.toFixed(0)}, ${posY.toFixed(0)})`
        );
      }

      // PixiJS 8: draw rectangle then stroke
      // Draw from center (offset by half width/height)
      const halfWidth = width / 2;
      const halfHeight = height / 2;
      this.debugLayer.rect(
        renderX - halfWidth,
        renderY - halfHeight,
        width,
        height
      );
      this.debugLayer.stroke(strokeOptions);
    }
    // TODO: Add polygon shape support (shapeType === 2) in the future
  }

  /**
   * Render velocity vector for an entity
   * DENSE ALLOCATION: entityIndex === componentIndex
   */
  renderVelocityVector(entityIndex, posX, posY) {
    if (!RigidBody) return;

    // DENSE: use entity index directly for component access
    const vx = RigidBody.vx[entityIndex];
    const vy = RigidBody.vy[entityIndex];

    // Skip if velocity is too small
    if (Math.abs(vx) < 0.01 && Math.abs(vy) < 0.01) return;

    const scale = 10; // Scale factor for visualization
    const endX = posX + vx * scale;
    const endY = posY + vy * scale;

    // PixiJS 8: draw path then stroke
    const angle = Math.atan2(vy, vx);
    const arrowSize = 5;

    this.debugLayer
      .moveTo(posX, posY)
      .lineTo(endX, endY)
      .lineTo(
        endX - arrowSize * Math.cos(angle - Math.PI / 6),
        endY - arrowSize * Math.sin(angle - Math.PI / 6)
      )
      .moveTo(endX, endY)
      .lineTo(
        endX - arrowSize * Math.cos(angle + Math.PI / 6),
        endY - arrowSize * Math.sin(angle + Math.PI / 6)
      )
      .stroke({
        width: 2 / this.cameraData[0],
        color: this.debugColors.velocity,
        alpha: 0.9,
      });
  }

  /**
   * Render acceleration vector for an entity
   * DENSE ALLOCATION: entityIndex === componentIndex
   */
  renderAccelerationVector(entityIndex, posX, posY) {
    if (!RigidBody) return;

    // DENSE: use entity index directly for component access
    const ax = RigidBody.ax[entityIndex];
    const ay = RigidBody.ay[entityIndex];

    // Skip if acceleration is too small
    if (Math.abs(ax) < 0.01 && Math.abs(ay) < 0.01) return;

    const scale = 50; // Scale factor for visualization (acceleration is smaller than velocity)
    const endX = posX + ax * scale;
    const endY = posY + ay * scale;

    // PixiJS 8: draw path then stroke
    const angle = Math.atan2(ay, ax);
    const arrowSize = 5;

    this.debugLayer
      .moveTo(posX, posY)
      .lineTo(endX, endY)
      .lineTo(
        endX - arrowSize * Math.cos(angle - Math.PI / 6),
        endY - arrowSize * Math.sin(angle - Math.PI / 6)
      )
      .moveTo(endX, endY)
      .lineTo(
        endX - arrowSize * Math.cos(angle + Math.PI / 6),
        endY - arrowSize * Math.sin(angle + Math.PI / 6)
      )
      .stroke({
        width: 2 / this.cameraData[0],
        color: this.debugColors.acceleration,
        alpha: 0.9,
      });
  }

  /**
   * Render entity index number using 7-segment style digits
   * Works in web worker without DOM text rendering
   */
  renderEntityIndex(entityIndex, posX, posY) {
    const zoom = this.cameraData[0];
    const digitHeight = 10 / zoom;
    const digitWidth = 6 / zoom;
    const digitSpacing = 2 / zoom;
    const lineWidth = 1.5 / zoom;

    // Convert index to string and draw each digit
    const indexStr = entityIndex.toString();
    const totalWidth =
      indexStr.length * digitWidth + (indexStr.length - 1) * digitSpacing;

    // Start position (centered above entity)
    let startX = posX - totalWidth / 2;
    const startY = posY - digitHeight - 8 / zoom;

    // Draw background for readability
    this.debugLayer
      .roundRect(
        startX - 2 / zoom,
        startY - 2 / zoom,
        totalWidth + 4 / zoom,
        digitHeight + 4 / zoom,
        2 / zoom
      )
      .fill({ color: 0x000000, alpha: 0.7 });

    // Draw each digit
    for (let i = 0; i < indexStr.length; i++) {
      drawDigit(
        this.debugLayer,
        parseInt(indexStr[i]),
        startX,
        startY,
        digitWidth,
        digitHeight,
        lineWidth,
        this.debugColors.text
      );
      startX += digitWidth + digitSpacing;
    }
  }

  /**
   * Render neighbor connections (requires neighbor data from Grid)
   * INTERACTIVE: Only shows neighbors for the entity closest to the mouse
   * Uses cached Grid arrays for performance
   */
  renderNeighborConnections() {
    if (!Grid.neighborData) return;

    // Get mouse position from input buffer (world coordinates)
    const mouseX = Mouse.x;
    const mouseY = Mouse.y;
    const mousePresent = Mouse.isPresent;

    // If no mouse, don't render anything
    if (!mousePresent) return;

    // PERFORMANCE: Cache Grid arrays locally
    const neighborData = Grid.neighborData;
    const stride = Grid._stride;

    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;

    // Mouse is always at entity index 0
    // Get the Mouse's neighbors to find the closest entity to the mouse
    const mouseOffset = 0;
    const mouseNeighborCount = neighborData[mouseOffset];

    // Find the entity closest to the mouse from its neighbor list
    let closestEntity = -1;
    let closestDist2 = Infinity;

    for (let n = 0; n < mouseNeighborCount; n++) {
      const neighborIndex = neighborData[mouseOffset + 1 + n];
      if (!active[neighborIndex]) continue;

      const dx = x[neighborIndex] - mouseX;
      const dy = y[neighborIndex] - mouseY;
      const dist2 = dx * dx + dy * dy;

      if (dist2 < closestDist2) {
        closestDist2 = dist2;
        closestEntity = neighborIndex;
      }
    }

    // No entity found near mouse
    if (closestEntity === -1) return;

    const myX = x[closestEntity];
    const myY = y[closestEntity];
    const zoom = this.cameraData[0];

    // Highlight the selected entity with a bright ring
    // DENSE: use entity index directly for component access
    const highlightRadius = Collider.radius[closestEntity] * 1.5 || 10;
    this.debugLayer
      .circle(myX, myY, highlightRadius)
      .stroke({ width: 3 / zoom, color: 0xffff00, alpha: 1.0 });

    const offset = closestEntity * stride;
    const neighborCount = neighborData[offset];

    // Draw all neighbors for this entity (no limit needed since it's just one entity)
    for (let n = 0; n < neighborCount; n++) {
      const neighborIndex = neighborData[offset + 1 + n];
      if (!active[neighborIndex]) continue;

      const neighborX = x[neighborIndex];
      const neighborY = y[neighborIndex];

      // Draw the line connection using drawLine utility
      drawLine(this.debugLayer, {
        startX: myX,
        startY: myY,
        endX: neighborX,
        endY: neighborY,
        color: this.debugColors.neighbor,
        alpha: 0.7,
        width: 2,
        zoom,
      });

      // Draw a small circle on the neighbor
      drawCircle(this.debugLayer, {
        x: neighborX,
        y: neighborY,
        radius: 3,
        color: this.debugColors.neighbor,
        alpha: 0.5,
        zoom,
      });
    }

    // Draw entity info marker
    drawCircle(this.debugLayer, {
      x: myX,
      y: myY - 20 / zoom,
      radius: 4,
      color: 0xffffff,
      alpha: 0.9,
      zoom,
    });
  }

  /**
   * Render raycasts from debug buffer
   * Uses drawLine, drawCircle, drawCross utilities for consistent debug rendering
   */
  renderRaycasts() {
    if (!this.raycastDebugBuffer) return;

    // Get count of raycasts to render
    const count = Math.min(
      this.raycastDebugBuffer[0],
      this.maxDebugRaycasts || 100
    );

    if (count === 0) return;

    const zoom = this.cameraData[0];

    // Render each raycast
    for (let i = 0; i < count; i++) {
      const offset = 1 + i * 7;
      const startX = this.raycastDebugBuffer[offset];
      const startY = this.raycastDebugBuffer[offset + 1];
      const endX = this.raycastDebugBuffer[offset + 2];
      const endY = this.raycastDebugBuffer[offset + 3];
      const hitX = this.raycastDebugBuffer[offset + 4];
      const hitY = this.raycastDebugBuffer[offset + 5];
      const didHit = this.raycastDebugBuffer[offset + 6] === 1;

      if (didHit) {
        // Hit: Draw line to hit point in green
        drawLine(this.debugLayer, {
          startX,
          startY,
          endX: hitX,
          endY: hitY,
          color: 0x00ff00,
          alpha: 0.8,
          width: 2,
          zoom,
        });

        // Draw dashed line from hit to end in red
        drawLine(this.debugLayer, {
          startX: hitX,
          startY: hitY,
          endX,
          endY,
          color: 0xff0000,
          alpha: 0.4,
          width: 1,
          zoom,
          dashed: true,
          dashLength: 10,
        });

        // Draw hit point circle
        drawCircle(this.debugLayer, {
          x: hitX,
          y: hitY,
          radius: 4,
          color: 0xff0000,
          alpha: 1.0,
          zoom,
        });

        // Draw impact cross
        drawCross(this.debugLayer, {
          x: hitX,
          y: hitY,
          size: 8,
          color: 0xffffff,
          alpha: 1.0,
          width: 2,
          zoom,
        });
      } else {
        // Miss: Draw full line in yellow/orange
        drawLine(this.debugLayer, {
          startX,
          startY,
          endX,
          endY,
          color: 0xffaa00,
          alpha: 0.5,
          width: 1,
          zoom,
        });
      }

      // Draw start point
      drawCircle(this.debugLayer, {
        x: startX,
        y: startY,
        radius: 3,
        color: 0x00ffff,
        alpha: 0.8,
        zoom,
      });
    }
  }

  /**
   * Render spatial hash grid
   */
  renderSpatialGrid() {
    const cellSize = this.config.spatial?.cellSize || 100;
    const worldWidth = this.worldWidth;
    const worldHeight = this.worldHeight;

    // PixiJS 8: build all lines then stroke once
    // Draw vertical lines
    for (let x = 0; x <= worldWidth; x += cellSize) {
      this.debugLayer.moveTo(x, 0).lineTo(x, worldHeight);
    }

    // Draw horizontal lines
    for (let y = 0; y <= worldHeight; y += cellSize) {
      this.debugLayer.moveTo(0, y).lineTo(worldWidth, y);
    }

    // Apply stroke to all grid lines
    this.debugLayer.stroke({
      width: 1 / this.cameraData[0],
      color: this.debugColors.grid,
      alpha: 0.2,
    });
  }

  /**
   * Update animation state for an entity (manual animation with regular Sprite)
   * Requires spritesheet to be set via setSpritesheet() first
   */
  updateSpriteAnimation(sprite, entityId, newState) {
    // Check if animation state changed
    if (this.previousAnimStates[entityId] === newState) return;
    this.previousAnimStates[entityId] = newState;

    // Get the entity's current spritesheet (set via setSpritesheet)
    const spritesheetId = SpriteRenderer.spritesheetId[entityId];
    if (!spritesheetId || spritesheetId === 0) return; // No spritesheet set yet

    const sheetName = SpriteSheetRegistry.getSpritesheetName(spritesheetId);
    if (!sheetName) return;

    // Check if this is an animated spritesheet
    const sheet = this.spritesheets[sheetName];
    if (!sheet || !sheet.animations) return; // Static texture, no animation

    // Get animation name from registry using numeric index
    const animName = SpriteSheetRegistry.getAnimationName(sheetName, newState);
    if (!animName) {
      console.warn(
        `Animation index ${newState} not found in SpriteSheetRegistry for "${sheetName}"`
      );
      return;
    }

    if (!sheet.animations[animName]) {
      console.warn(
        `Animation "${animName}" (index ${newState}) not found in PIXI spritesheet "${sheetName}"`,
        `\nAvailable animations:`,
        Object.keys(sheet.animations || {})
      );
      return;
    }

    // Update animation frames array for manual playback
    const frames = sheet.animations[animName];
    this.currentAnimationFrames[entityId] = frames;
    this.currentFrameIndex[entityId] = 0;
    this.frameAccumulator[entityId] = 0;

    // Set initial texture
    if (frames.length > 0) {
      sprite.texture = frames[0];
    }
  }

  /**
   * Update an entity's sprite to use a different spritesheet or texture
   * Handles both animated spritesheets and static textures
   * Called when spritesheetId changes in SharedArrayBuffer
   *
   * @param {PIXI.Sprite} sprite - The entity's sprite
   * @param {number} entityId - Entity index
   * @param {number} newSpritesheetId - New spritesheet ID (0 = not set, 1-255 = valid)
   */
  updateEntitySpritesheet(sprite, entityId, newSpritesheetId) {
    if (newSpritesheetId === 0) return; // Not set yet

    const targetName = SpriteSheetRegistry.getSpritesheetName(newSpritesheetId);
    if (!targetName) {
      console.warn(
        `Invalid spritesheetId ${newSpritesheetId} for entity ${entityId}`
      );
      return;
    }

    // Check if it's an animated spritesheet or a static texture
    const sheet = this.spritesheets[targetName];

    if (sheet && sheet.animations && Object.keys(sheet.animations).length > 0) {
      // ANIMATED SPRITESHEET - has animations
      this.setAnimatedSpritesheet(sprite, entityId, targetName, sheet);
    } else {
      // STATIC TEXTURE - check textures map
      const texture = this.textures[targetName];
      if (texture) {
        this.setStaticTexture(sprite, entityId, texture);
      } else {
        console.warn(`Neither spritesheet nor texture "${targetName}" found`);
      }
    }
  }

  /**
   * Set an animated spritesheet on a sprite
   * @private
   */
  setAnimatedSpritesheet(sprite, entityId, sheetName, sheet) {
    // Get current animation name from OLD spritesheet (if any)
    const oldSpritesheetId = this.currentSpritesheetIds[entityId];
    const currentAnimState = SpriteRenderer.animationState[entityId];

    let animName = null;
    if (oldSpritesheetId > 0) {
      const oldSheetName =
        SpriteSheetRegistry.getSpritesheetName(oldSpritesheetId);
      if (oldSheetName) {
        animName = SpriteSheetRegistry.getAnimationName(
          oldSheetName,
          currentAnimState
        );
      }
    }

    // BUGFIX: If oldSpritesheetId is 0 (first time setting sprite), try to get animation name from NEW sheet
    // This respects the animationState that was set by logic worker's setSprite()
    if (!animName) {
      animName = SpriteSheetRegistry.getAnimationName(
        sheetName,
        currentAnimState
      );
    }

    // If no animation name resolved, or it doesn't exist in new sheet, use first animation
    if (!animName || !sheet.animations[animName]) {
      animName = Object.keys(sheet.animations)[0];
    }

    if (!animName) {
      console.warn(`No animations found in spritesheet "${sheetName}"`);
      return;
    }

    // Update to new spritesheet's animation
    const frames = sheet.animations[animName];
    if (!frames || !frames[0]) {
      console.error(
        `PIXI: Animation "${animName}" has no frames! sheet.animations:`,
        Object.keys(sheet.animations)
      );
      return;
    }
    this.currentAnimationFrames[entityId] = frames;
    this.currentFrameIndex[entityId] = 0;
    this.frameAccumulator[entityId] = 0;
    sprite.texture = frames[0];

    // Update animation state to match new sheet's index
    const newIndex = SpriteSheetRegistry.getAnimationIndex(sheetName, animName);
    if (newIndex !== undefined) {
      SpriteRenderer.animationState[entityId] = newIndex;
      this.previousAnimStates[entityId] = newIndex;
    }
  }

  /**
   * Set a static texture on a sprite
   * @private
   */
  setStaticTexture(sprite, entityId, texture) {
    sprite.texture = texture;
    // Clear animation data for static sprites
    this.currentAnimationFrames[entityId] = [];
    this.currentFrameIndex[entityId] = 0;
    this.frameAccumulator[entityId] = 0;
  }

  /**
   * Update all sprite positions, visibility, and properties from SharedArrayBuffer
   * Uses dirty flags to skip unnecessary visual property updates
   * @param {number} deltaTime - Time elapsed since last frame in milliseconds
   * @param {number} interpolationAlpha - Interpolation factor for smooth movement
   */
  updateSprites(deltaTime, interpolationAlpha) {
    // Guard against uninitialized state
    if (!this.bodySpritePoolIndices) return;

    // Cache array references for performance
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const rotation = Transform.rotation;

    // SpriteRenderer properties
    const animationState = SpriteRenderer.animationState;
    const animationSpeed = SpriteRenderer.animationSpeed;
    const tint = SpriteRenderer.tint;
    const alpha = SpriteRenderer.alpha;

    const scaleX = SpriteRenderer.scaleX;
    const scaleY = SpriteRenderer.scaleY;
    const anchorX = SpriteRenderer.anchorX;
    const anchorY = SpriteRenderer.anchorY;
    const renderVisible = SpriteRenderer.renderVisible;

    const isItOnScreen = SpriteRenderer.isItOnScreen;

    const renderDirty = SpriteRenderer.renderDirty; // OPTIMIZATION: Dirty flag

    // Track visible units count
    let visibleCount = 0;

    // Convert deltaTime from ms to seconds for frame calculation
    const deltaSeconds = deltaTime / 1000;

    // Reset Y-sort pool for this frame (reuse array, avoid GC pressure)
    // Instead of creating new array + objects every frame, we reuse a pre-allocated pool
    this._ySortPoolSize = 0;
    const allEntitiesWithSpriteRenderer = this.query(this.queryConfig);

    for (
      let i = 0;
      i < /*this.globalEntityCount*/ allEntitiesWithSpriteRenderer.length;
      i++
    ) {
      const entityIndex = allEntitiesWithSpriteRenderer[i];
      let bodySprite = this.bodySprites[entityIndex];
      const poolIndex = this.bodySpritePoolIndices[entityIndex];

      // ========================================
      // LAZY SPRITE CREATION (Memory Optimization)
      // ========================================
      // Sprites are only created when entities become visible on screen.
      // This saves memory by not allocating PIXI.Particle objects for:
      // - Inactive entities (in pool but not spawned)
      // - Active but off-screen entities (outside camera viewport)
      // The centralized particle pool handles reuse across all sprite types.
      const shouldHaveSprite =
        active[entityIndex] &&
        renderVisible[entityIndex] &&
        isItOnScreen[entityIndex];

      // Acquire sprite from central pool when entity becomes visible
      if (!bodySprite && shouldHaveSprite) {
        const entityType = Transform.entityType[entityIndex];
        const config = this.entitySpriteConfigs[entityType];

        // Skip entities without SpriteRenderer (e.g., Mouse entity)
        if (!config || !config.hasSpriteRenderer) {
          continue;
        }

        // Entity has SpriteRenderer and is visible - acquire sprite from pool
        const { particle, index } = this.particlePool.acquire();
        bodySprite = particle;
        this.bodySprites[entityIndex] = particle;
        this.bodySpritePoolIndices[entityIndex] = index;

        // Add to container if Y-sorting is disabled
        if (!this.ySorting) {
          this.particleContainer.addParticle(particle);
        }

        // Mark as needing sprite setup (texture, animation, etc)
        renderDirty[entityIndex] = 1;
      }

      // Skip entities without sprites (either not visible or no SpriteRenderer)
      if (!bodySprite) {
        continue;
      }

      // OPTIMIZATION: Only update visual properties if dirty flag is set
      // This skips expensive operations (tint, alpha, flipping, animations) when unchanged
      if (renderDirty[entityIndex]) {
        // Check if spritesheet changed (per-instance override)
        const spritesheetId = SpriteRenderer.spritesheetId;
        if (
          spritesheetId &&
          this.currentSpritesheetIds &&
          this.currentSpritesheetIds[entityIndex] !== spritesheetId[entityIndex]
        ) {
          this.updateEntitySpritesheet(
            bodySprite,
            entityIndex,
            spritesheetId[entityIndex]
          );
          this.currentSpritesheetIds[entityIndex] = spritesheetId[entityIndex];
        }

        // Update body sprite visual properties
        bodySprite.tint = tint[entityIndex];
        bodySprite.alpha = alpha[entityIndex];

        // Update animation if changed
        this.updateSpriteAnimation(
          bodySprite,
          entityIndex,
          animationState[entityIndex]
        );
        this.changeFrameOfSprite(bodySprite, entityIndex, deltaSeconds);

        // Update animation speed (stored locally for manual animation)
        this.animationSpeed[entityIndex] = animationSpeed[entityIndex];

        // Clear dirty flag after updating
        renderDirty[entityIndex] = 0;
      }

      // DENSE: use entity index directly for all component data
      // PixiJS 8 Particle uses scaleX/scaleY instead of scale.x/scale.y
      if (bodySprite.scaleX !== scaleX[entityIndex])
        bodySprite.scaleX = scaleX[entityIndex];
      if (bodySprite.scaleY !== scaleY[entityIndex])
        bodySprite.scaleY = scaleY[entityIndex];

      // Update anchor points (0-1 range)
      // PixiJS 8 Particle uses anchorX/anchorY instead of anchor.x/anchor.y
      if (bodySprite.anchorX !== anchorX[entityIndex])
        bodySprite.anchorX = anchorX[entityIndex];
      if (bodySprite.anchorY !== anchorY[entityIndex])
        bodySprite.anchorY = anchorY[entityIndex];

      // ========================================
      // SPRITE LIFECYCLE MANAGEMENT
      // ========================================
      // Release sprites back to pool when entities go off-screen or despawn.
      // This allows the same PIXI.Particle to be reused for different entities.
      const shouldBeVisible =
        active[entityIndex] &&
        renderVisible[entityIndex] &&
        isItOnScreen[entityIndex];

      // Release sprite when entity despawns OR goes off-screen
      if (!active[entityIndex] || !isItOnScreen[entityIndex]) {
        if (bodySprite && this.bodySpritePoolIndices[entityIndex] !== -1) {
          this.particlePool.release(this.bodySpritePoolIndices[entityIndex]);
          this.bodySprites[entityIndex] = null;
          this.bodySpritePoolIndices[entityIndex] = -1;

          // CRITICAL: Always reset spritesheet tracking when sprite is released
          // This forces texture update when entity gets a new sprite from pool
          this.currentSpritesheetIds[entityIndex] = 0;

          // Only reset animation state if entity despawned (not just off-screen)
          // This preserves animation state when entity goes off-screen temporarily
          if (!active[entityIndex]) {
            this.previousAnimStates[entityIndex] = -1;
            this.currentAnimationFrames[entityIndex] = [];
          }
        }
        continue;
      }

      // Hide explicitly hidden entities (renderVisible=false, but keep sprite allocated)
      if (!renderVisible[entityIndex]) {
        if (bodySprite.visible) {
          bodySprite.visible = false;
        }
        continue;
      }

      // Entity should be visible - count it
      visibleCount++;

      // BUGFIX: Always collect visible sprites into the pool
      // This ensures sprites are properly managed even when Y-sorting is disabled
      // Check if sprite is becoming visible for the first time (or after being hidden)
      const wasInvisible = !bodySprite.visible;

      // Make sprite visible before adding to pool
      if (wasInvisible) {
        bodySprite.visible = true;
      }

      // GC OPTIMIZATION: Reuse pooled objects instead of allocating new ones each frame
      const poolIdx = this._ySortPoolSize++;
      if (!this._ySortPool[poolIdx]) {
        this._ySortPool[poolIdx] = { entityId: 0, sprite: null, y: 0 };
      }
      const item = this._ySortPool[poolIdx];
      item.entityId = entityIndex;
      item.sprite = bodySprite;
      item.y = y[entityIndex];

      // Update transform (position, rotation, scale)

      // // Skip interpolation if sprite just became visible (to avoid slow lerp from 0,0)
      // // or if interpolation is disabled
      if (this.interpolation && this.frameRateData && !wasInvisible) {
        // Interpolate from current sprite position toward physics target
        bodySprite.x += (x[entityIndex] - bodySprite.x) * interpolationAlpha;
        bodySprite.y += (y[entityIndex] - bodySprite.y) * interpolationAlpha;

        // Handle rotation interpolation with angle wrapping
        // Normalize angle difference to [-PI, PI] to avoid going the long way
        const angleDiff = normalizeAngleDifference(
          bodySprite.rotation,
          rotation[entityIndex]
        );
        bodySprite.rotation += angleDiff * interpolationAlpha;
      } else {
        // No interpolation - directly set position
        // (first frame visible, interpolation disabled, or no frameRateData)
        bodySprite.x = x[entityIndex];
        bodySprite.y = y[entityIndex];
        bodySprite.rotation = rotation[entityIndex];
      }
    }

    // Store visible entity count for reporting
    this.visibleEntityCount = visibleCount;

    // Update particle sprites (adds to _ySortPool if Y-sorting is enabled)
    if (this.maxParticles > 0) {
      this.updateParticleSprites();
    }

    // Update decoration sprites (adds to _ySortPool if Y-sorting is enabled)
    if (this.maxDecorations > 0) {
      this.updateDecorationSprites();
    }

    // Second pass: Y-sort and re-add all sprites to container
    // BUGFIX: Always rebuild the container, not just when ySorting is enabled
    // This ensures despawned entities are properly removed from the render tree
    const pool = this._ySortPool;
    const poolSize = this._ySortPoolSize;

    // GC OPTIMIZATION: Truncate pool to active size before sorting
    // This allows native sort (O(n log n)) to only process active items
    // Setting .length doesn't allocate - pool regrows lazily next frame if needed
    pool.length = poolSize;

    if (this.ySorting) {
      // Sort by Y position using native Timsort (O(n log n), highly optimized)
      // OPTIMIZED: Use pre-defined comparator to avoid closure allocation
      pool.sort(sortByY);
    }

    // PixiJS 8: Clear particleChildren array and re-add in sorted order
    this.particleContainer.particleChildren.length = 0;

    // Note: Shadows are now rendered separately via shadowRT system (RenderTexture-based)
    // They are no longer added to the main particleContainer

    // Re-add all sprites (entities + particles) in Y-sorted order
    for (let i = 0; i < poolSize; i++) {
      this.particleContainer.addParticle(pool[i].sprite);
    }

    // Mark container as needing update
    this.particleContainer.update();
  }

  changeFrameOfSprite(bodySprite, i, deltaSeconds) {
    // Manual animation frame advancement (for animated sprites only)
    const frames = this.currentAnimationFrames[i];
    if (frames && frames.length > 1) {
      // Accumulate time
      this.frameAccumulator[i] += deltaSeconds;

      // Calculate frame duration based on animation speed
      // animationSpeed represents frames per second (FPS)
      const frameDuration = 1 / (this.animationSpeed[i] * 60); // Convert to seconds per frame

      // Advance frames if enough time has passed
      if (this.frameAccumulator[i] >= frameDuration) {
        this.frameAccumulator[i] -= frameDuration;
        this.currentFrameIndex[i] =
          (this.currentFrameIndex[i] + 1) % frames.length;

        // Update sprite texture
        bodySprite.texture = frames[this.currentFrameIndex[i]];
      }
    }
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   */
  update(deltaTime, dtRatio, resuming) {
    // Increment frame counter
    this.frameCount++;

    // Clear debug raycasts every 3 frames (allows raycasts to persist for 2-3 frames)
    if (this.frameCount % 3 === 0) {
      Ray.clearDebugRaycasts();
    }

    // Calculate interpolation alpha for smooth movement
    // When renderer FPS > physics FPS, alpha < 1.0 (smooth interpolation)
    let interpolationAlpha = 1.0;
    if (this.interpolation && this.frameRateData) {
      const physicsFPS = this.frameRateData[this.physicsWorkerIndex] || 60;
      if (physicsFPS > 0 && this.currentFPS > physicsFPS) {
        interpolationAlpha = Math.min(1.0, physicsFPS / this.currentFPS);
      }
    }

    // Interpolate camera state for smooth background and lighting movement
    const targetZoom = this.cameraData[0];
    const targetCamX = this.cameraData[1];
    const targetCamY = this.cameraData[2];

    // Initialize or interpolate
    if (!this._cameraInitialized) {
      this._renderCameraX = targetCamX;
      this._renderCameraY = targetCamY;
      this._renderZoom = targetZoom;
      this._cameraInitialized = true;
    } else {
      this._renderCameraX +=
        (targetCamX - this._renderCameraX) * interpolationAlpha;
      this._renderCameraY +=
        (targetCamY - this._renderCameraY) * interpolationAlpha;
      this._renderZoom += (targetZoom - this._renderZoom) * interpolationAlpha;
    }

    this.updateCameraTransform();

    // Update decal decal tiles (check for dirty tiles from particle_worker)
    this.updateDecalTiles();

    // Update lighting shader uniforms from LightEmitter components
    this.updateLighting(interpolationAlpha);

    // Update shadow RenderTexture with interleaved lights + shadows
    // This renders lights and shadows to shadowRT, which is displayed via shadowDisplaySprite (multiply blend)
    this.updateShadowSprites(interpolationAlpha);

    // Update light glow sprites from LightEmitter component arrays
    this.updateLightGlowSprites(interpolationAlpha);

    this.updateSprites(deltaTime, interpolationAlpha);

    // ========================================
    // LOW-RES OFF-SCREEN RENDERING
    // ========================================
    // Render lighting to lower-resolution texture if configured.
    // This significantly improves performance on GPU-bound systems.

    // Render low-res lighting
    if (this.lightingRT && this.lightingMesh) {
      this.pixiApp.renderer.render({
        container: this.lightingMesh,
        target: this.lightingRT,
        clear: true,
      });
    }

    // Render debug overlays (only if debug system is enabled)
    if (this.debugLayer) {
      this.renderDebugOverlays();
    }

    // Let particle pool handle deferred pre-allocation during idle frames
    this.particlePool.endFrame();
  }

  /**
   * Setup PIXI ticker to call gameLoop (custom scheduler implementation)
   */
  onCustomSchedulerStart() {
    if (this.noLimitFPS) {
      // When noLimitFPS is true, bypass PIXI ticker and use standard loop
      // This allows unlimited FPS like other workers
      // console.log(
      //   "PIXI WORKER: Using unlimited FPS mode (bypassing PIXI ticker)"
      // );
      this.usesCustomScheduler = false; // Switch to standard scheduler
      this.scheduleNextFrame(); // Start the standard loop
    } else {
      // Standard mode: PIXI ticker will call gameLoop on every tick (60fps)
      this.pixiApp.ticker.add(() => this.gameLoop());
    }
  }

  /**
   * Create sprites for each decal decal tile
   * Each tile is a Sprite with an initially transparent texture
   * Textures are updated when particle_worker marks tiles as dirty
   */
  createDecalTileSprites() {
    const tileSize = this.decalsTileSize;

    for (let ty = 0; ty < this.decalsTilesY; ty++) {
      for (let tx = 0; tx < this.decalsTilesX; tx++) {
        const tileIndex = tx + ty * this.decalsTilesX;

        // Create an initially transparent texture for this tile
        // We'll update the texture source when the tile becomes dirty
        const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
        sprite.x = tx * tileSize;
        sprite.y = ty * tileSize;
        sprite.width = tileSize;
        sprite.height = tileSize;
        sprite.visible = false; // Hidden until first decal splat

        this.decalTileSprites[tileIndex] = sprite;
        this.decalTileTextureSources[tileIndex] = null; // Created on first update
        this.decalTileContainer.addChild(sprite);
      }
    }

    console.log(
      `PIXI WORKER: Created ${this.decalsTotalTiles} decal tile sprites`
    );
  }

  /**
   * Update decal tile textures for any dirty tiles
   * Called each frame to check for tiles modified by particle_worker
   * Uses fire-and-forget createImageBitmap for async texture updates
   */
  updateDecalTiles() {
    if (!this.decalsEnabled) return;

    // Use pixel size for buffer operations (not world tile size)
    const tilePixelSize = this.decalsTilePixelSize;
    const bytesPerTile = tilePixelSize * tilePixelSize * 4;

    for (let tileIndex = 0; tileIndex < this.decalsTotalTiles; tileIndex++) {
      // Check if this tile was modified by particle_worker
      if (this.decalTilesDirty[tileIndex] === 0) continue;

      // Clear dirty flag immediately (particle_worker may set it again)
      this.decalTilesDirty[tileIndex] = 0;

      // Get the RGBA data for this tile from SharedArrayBuffer
      const tileByteOffset = tileIndex * bytesPerTile;
      const tileRGBAShared = new Uint8ClampedArray(
        this.decalTilesRGBA.buffer,
        tileByteOffset,
        bytesPerTile
      );

      // Create a non-shared copy for ImageData (ImageData can't use SharedArrayBuffer)
      const tileRGBA = new Uint8ClampedArray(tileRGBAShared);

      // Create ImageData from the tile's RGBA buffer (uses pixel size)
      const imageData = new ImageData(tileRGBA, tilePixelSize, tilePixelSize);

      // Fire-and-forget: create ImageBitmap and update texture
      // The tile will appear on the next frame after the bitmap is ready
      // PIXI will scale the lower-res texture up to the sprite's world size
      const sprite = this.decalTileSprites[tileIndex];

      createImageBitmap(imageData).then((bitmap) => {
        // Create or update texture source
        const source = new PIXI.ImageSource({ resource: bitmap });
        sprite.texture = new PIXI.Texture({ source });
        sprite.visible = true; // Show the tile now that it has content
      });
    }
  }

  /**
   * Create tiling background sprite
   * Note: Background is added to stage, not ParticleContainer (which only supports simple sprites)
   */
  createBackground() {
    const bgTexture = this.textures[this.bgTextureName];

    if (!bgTexture) {
      console.warn(`Background texture "${this.bgTextureName}" not found`);
      return;
    }

    // PixiJS 8: TilingSprite uses options object
    this.backgroundSprite = new PIXI.TilingSprite({
      texture: bgTexture,
      width: this.worldWidth,
      height: this.worldHeight,
    });
    this.backgroundSprite.tileScale.set(
      this.config.renderer.bgTileScale || 1,
      this.config.renderer.bgTileScale || 1
    );
    this.backgroundSprite.tilePosition.set(0, 0);
    this.backgroundSprite.zIndex = PixiRenderer.Z_INDICES.BACKGROUND;
    // Add background to stage directly (ParticleContainer can't hold TilingSprites)
    this.pixiApp.stage.addChild(this.backgroundSprite);
  }
  /* =====================
LIGHTING SYSTEM SETUP
===================== */

  createLightingSystem() {
    const vertexSrc = `
  in vec2 aPosition;
  void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  }
  `;

    const fragmentSrc = this.buildFragmentShaderBasic();

    const geometry = new PIXI.Geometry({
      attributes: {
        aPosition: [-1, -1, 1, -1, 1, 1, -1, 1],
      },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });

    const glProgram = new PIXI.GlProgram({
      vertex: vertexSrc,
      fragment: fragmentSrc,
    });

    const maxLights = this.maxLights;

    // Pre-allocate Float32Arrays for light uniforms (reused each frame)
    this._lightX = new Float32Array(maxLights);
    this._lightY = new Float32Array(maxLights);
    this._lightIntensity = new Float32Array(maxLights);
    this._lightR = new Float32Array(maxLights).fill(1);
    this._lightG = new Float32Array(maxLights).fill(1);
    this._lightB = new Float32Array(maxLights).fill(1);

    this.lightingShader = new PIXI.Shader({
      glProgram,
      resources: {
        uniforms: {
          uCameraPos: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
          uZoom: { value: 1.0, type: "f32" },
          uViewport: {
            value: new Float32Array([
              this.canvasWidth * this.lightingResolution,
              this.canvasHeight * this.lightingResolution,
            ]),
            type: "vec2<f32>",
          },
          uFullCanvasSize: {
            value: new Float32Array([this.canvasWidth, this.canvasHeight]),
            type: "vec2<f32>",
          },
          uInvResolution: { value: 1.0 / this.lightingResolution, type: "f32" },

          uLightX: { value: this._lightX, type: "f32", size: maxLights },
          uLightY: { value: this._lightY, type: "f32", size: maxLights },
          uLightIntensity: {
            value: this._lightIntensity,
            type: "f32",
            size: maxLights,
          },
          uLightR: { value: this._lightR, type: "f32", size: maxLights },
          uLightG: { value: this._lightG, type: "f32", size: maxLights },
          uLightB: { value: this._lightB, type: "f32", size: maxLights },
          uLightCount: { value: 0, type: "i32" },
          uAmbient: { value: this.lightingAmbient, type: "f32" },
        },
      },
    });

    this.lightingMesh = new PIXI.Mesh({
      geometry,
      shader: this.lightingShader,
    });

    // Handle low-res lighting via RenderTexture
    if (this.lightingResolution < 1.0) {
      this.lightingRT = PIXI.RenderTexture.create({
        width: this.canvasWidth * this.lightingResolution,
        height: this.canvasHeight * this.lightingResolution,
      });
      this.lightingDisplaySprite = new PIXI.Sprite(this.lightingRT);
      this.lightingDisplaySprite.anchor.set(0, 0); // Ensure top-left anchor
      this.lightingDisplaySprite.position.set(0, 0); // Position at top-left of screen
      this.lightingDisplaySprite.scale.set(1.0 / this.lightingResolution);
      this.lightingDisplaySprite.blendMode = LAYER_DEFAULT_BLEND_MODES.LIGHTING;
      this.lightingDisplaySprite.zIndex = PixiRenderer.Z_INDICES.LIGHTING;
      this.pixiApp.stage.addChild(this.lightingDisplaySprite);

      console.log(
        `PIXI WORKER: Lighting RenderTexture created (${this.lightingRT.width}x${this.lightingRT.height})`
      );
    } else {
      this.lightingMesh.blendMode = LAYER_DEFAULT_BLEND_MODES.LIGHTING;
      this.lightingMesh.zIndex = PixiRenderer.Z_INDICES.LIGHTING;
      this.pixiApp.stage.addChild(this.lightingMesh);
    }
  }

  buildFragmentShaderBasic() {
    return `
    precision mediump float;
    
    uniform vec2 uCameraPos;
    uniform float uZoom;
    uniform vec2 uViewport;
    uniform vec2 uFullCanvasSize;
    
    uniform float uLightX[${this.maxLights}];
    uniform float uLightY[${this.maxLights}];
    uniform float uLightIntensity[${this.maxLights}];
    uniform float uLightR[${this.maxLights}];
    uniform float uLightG[${this.maxLights}];
    uniform float uLightB[${this.maxLights}];
    uniform int uLightCount;
    uniform float uAmbient;
    
    void main() {
      // Use normalized coordinates (0 to 1) to avoid resolution-scaling ambiguity.
      vec2 normCoord = gl_FragCoord.xy / uViewport;
      
      // Map normalized coordinates back to full-screen pixels.
      // When rendering to RenderTexture, PixiJS 8 may have already flipped Y coordinates.
      // We test without the Y-flip first to see if that fixes the coordinate issue.
      vec2 screenPos = normCoord * uFullCanvasSize;
      
      vec2 fragWorld = (screenPos / uZoom) + uCameraPos;
      
      vec3 totalLight = vec3(uAmbient);
      
      for (int i = 0; i < ${this.maxLights}; i++) {
        if (i >= uLightCount) break;
        
        vec2 lightWorld = vec2(uLightX[i], uLightY[i]);
        float intensity = uLightIntensity[i];
        vec3 color = vec3(uLightR[i], uLightG[i], uLightB[i]);
        
        float d = length(fragWorld - lightWorld);
        // Formula: intensity / (intensity + d²) → caps at 1.0 when d=0, falls off with distance
        // Higher intensity = light reaches farther, but max brightness is always 1.0
        float attenuation = intensity / (intensity + d*d);
        
        totalLight += color * attenuation;
      }
      
      totalLight = min(totalLight, vec3(1.0));
      gl_FragColor = vec4(totalLight, 1.0);
    }
    `;
  }

  /* =====================
UPDATE LIGHTING (NO ZOOM SCALING)
===================== */

  updateLighting(interpolationAlpha) {
    if (!this.lightingEnabled || !this.lightingShader) return;

    const uniformGroup = this.lightingShader.resources.uniforms;

    const active = Transform.active;
    const worldX = Transform.x;
    const worldY = Transform.y;
    const lightEnabled = LightEmitter.active;
    const lightColor = LightEmitter.lightColor;
    const lightIntensity = LightEmitter.lightIntensity;
    const lightHeight = LightEmitter.height;

    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;

    // Calculate viewport bounds for culling (using interpolated camera)
    const viewWidth = this.canvasWidth / zoom;
    const viewHeight = this.canvasHeight / zoom;
    const viewRight = cameraX + viewWidth;
    const viewBottom = cameraY + viewHeight;

    // Viewport center for sorting
    const viewCenterX = cameraX + viewWidth / 2;
    const viewCenterY = cameraY + viewHeight / 2;

    // Update camera uniforms (vec2 types)
    uniformGroup.uniforms.uCameraPos[0] = cameraX;
    uniformGroup.uniforms.uCameraPos[1] = cameraY;
    uniformGroup.uniforms.uZoom = zoom;

    // Update viewport uniform every frame (handles resizes and resolution changes)
    uniformGroup.uniforms.uViewport[0] =
      this.canvasWidth * this.lightingResolution;
    uniformGroup.uniforms.uViewport[1] =
      this.canvasHeight * this.lightingResolution;

    uniformGroup.uniforms.uFullCanvasSize[0] = this.canvasWidth;
    uniformGroup.uniforms.uFullCanvasSize[1] = this.canvasHeight;

    // Use pre-allocated Float32Arrays for light data
    const lightX = this._lightX;
    const lightY = this._lightY;
    const lightIntensityArr = this._lightIntensity;
    const lightR = this._lightR;
    const lightG = this._lightG;
    const lightB = this._lightB;

    let lightIndex = 0;

    // OPTIMIZATION: Use query system to iterate only entities with LightEmitter
    // This is O(numPotentialLights) instead of O(allEntities)
    const lightEntities = this.query([LightEmitter]);

    // Reset light pool for this frame (reuse objects to avoid GC)
    this._lightPoolSize = 0;

    for (let idx = 0; idx < lightEntities.length; idx++) {
      const i = lightEntities[idx];
      if (!active[i] || !lightEnabled[i]) continue;

      // Use sprite position if available (it's already interpolated)
      const sprite = this.bodySprites[i];
      const x = sprite ? sprite.x : worldX[i];
      const y = (sprite ? sprite.y : worldY[i]) - (lightHeight[i] || 0);
      const intensity = lightIntensity[i];

      // Viewport culling: Only include lights that actually affect the visible screen
      // Attenuation formula: I / (I + d^2). At d = 10 * sqrt(I), attenuation is ~0.01
      const influenceRadius = 10 * Math.sqrt(intensity);

      if (
        x + influenceRadius < cameraX ||
        x - influenceRadius > viewRight ||
        y + influenceRadius < cameraY ||
        y - influenceRadius > viewBottom
      ) {
        continue;
      }

      // Add to pool for sorting
      const poolIdx = this._lightPoolSize++;
      if (!this._lightPool[poolIdx]) {
        this._lightPool[poolIdx] = { entityId: 0, distSq: 0 };
      }
      const item = this._lightPool[poolIdx];
      item.entityId = i;

      // Distance squared to camera center (for prioritization)
      const dx = x - viewCenterX;
      const dy = y - viewCenterY;
      item.distSq = dx * dx + dy * dy;
    }

    // Sort visible lights by distance (closest first)
    // Slice to only sort active items and avoid sorting thousands of empty slots
    const visibleLights = this._lightPool.slice(0, this._lightPoolSize);
    visibleLights.sort((a, b) => a.distSq - b.distSq);

    const countToRender = Math.min(visibleLights.length, this.maxLights);

    for (let i = 0; i < countToRender; i++) {
      const entityIndex = visibleLights[i].entityId;
      const color = lightColor[entityIndex];

      // Always use world coordinates for lights (shader converts screen to world)
      // sprite.x/y are in container space (already transformed), so we use worldX/worldY
      // Apply height offset to position light above the entity
      lightX[i] = worldX[entityIndex];
      lightY[i] = worldY[entityIndex] - (lightHeight[entityIndex] || 0);
      lightIntensityArr[i] = lightIntensity[entityIndex]; // NO ZOOM SCALING

      const { r, g, b } = extractRGBNormalized(color);
      lightR[i] = r;
      lightG[i] = g;
      lightB[i] = b;

      lightIndex++;
    }

    // Update light count uniform
    uniformGroup.uniforms.uLightCount = lightIndex;
  }

  /**
   * Create the RenderTexture-based shadow system:
   * 1. Create shadowRT (RenderTexture) - cleared to white each frame
   * 2. Create shadowParticleContainer - holds light gradients + shadows
   * 3. Create shadowDisplaySprite - displays shadowRT with multiply blend
   *
   * Rendering order per frame:
   * - Clear shadowRT to white
   * - For each light: add light gradient (white/colored), then its shadows (black)
   * - Render shadowParticleContainer to shadowRT
   * - shadowDisplaySprite (multiply) darkens the scene where shadows exist
   */
  createShadowSpriteSystem() {
    // Read shadow resolution from config (default 1.0)
    this.shadowResolution = this.config.lighting?.shadowResolution || 1.0;

    // Create RenderTexture for shadow compositing
    // Cleared to white each frame (white = no darkening when multiplied)
    this.shadowRT = PIXI.RenderTexture.create({
      width: this.canvasWidth * this.shadowResolution,
      height: this.canvasHeight * this.shadowResolution,
    });

    // Create ParticleContainer for lights + shadows
    // Uses normal blend internally - the multiply happens on shadowDisplaySprite
    this.shadowParticleContainer = new PIXI.ParticleContainer({
      blendMode: "normal-npm",
      dynamicProperties: {
        vertex: true,
        position: true,
        rotation: true,
        uvs: true,
        color: true,
        alpha: true,
      },
    });

    // Create display sprite to show shadowRT with multiply blend
    this.shadowDisplaySprite = new PIXI.Sprite(this.shadowRT);
    this.shadowDisplaySprite.anchor.set(0, 0);
    this.shadowDisplaySprite.position.set(0, 0);
    this.shadowDisplaySprite.scale.set(1.0 / this.shadowResolution);
    this.shadowDisplaySprite.blendMode = LAYER_DEFAULT_BLEND_MODES.CASTED_SHADOWS;
    this.shadowDisplaySprite.zIndex = PixiRenderer.Z_INDICES.CASTED_SHADOWS;

    // Add to stage
    this.pixiApp.stage.addChild(this.shadowDisplaySprite);

    console.log(
      `PIXI WORKER: Shadow RenderTexture system initialized (${this.maxShadowSprites} shadow slots, ${this.shadowRT.width}x${this.shadowRT.height} RT)`
    );
  }

  /**
   * Create pool of shadow and light gradient Particle objects
   * All sprites go into shadowParticleContainer (rendered to shadowRT)
   *
   * Rendering order:
   * 1. White background sprite (ensures white = no darkening base)
   * 2. For each light: light gradient (white/colored), then shadows (black)
   *
   * Light gradients: white circles that "brighten" the shadow map
   * Shadows: black sprites that darken the shadow map
   */
  createShadowSprites() {
    if (!this.shadowParticleContainer) {
      console.warn(
        "PIXI WORKER: Cannot create shadow sprites - shadowParticleContainer not ready"
      );
      return;
    }

    // Get textures
    const defaultTexture =
      this.particlePool.defaultTexture || PIXI.Texture.EMPTY;
    const lightGradientTexture =
      this.textures["_lightGradient"] || PIXI.Texture.WHITE;

    // Create white background sprite (covers entire shadowRT)
    // This ensures the base is white (no darkening when multiplied)
    // Uses _white texture from BigAtlas (8x8 white square)
    const whiteTexture = this.textures["_white"] || PIXI.Texture.WHITE;
    this.shadowBackgroundSprite = new PIXI.Particle({
      texture: whiteTexture,
      anchorX: 0,
      anchorY: 0,
    });
    this.shadowBackgroundSprite.tint = 0xffffff;
    this.shadowBackgroundSprite.alpha = 1.0;
    // Size will be set each frame in updateShadowSprites to match shadowRT dimensions

    // Create light gradient sprites (one per maxLights)
    // These are rendered BEFORE shadows to "illuminate" the shadow map
    for (let i = 0; i < this.maxLights; i++) {
      const lightSprite = new PIXI.Particle({
        texture: lightGradientTexture,
        anchorX: 0.5,
        anchorY: 0.5,
      });

      lightSprite.alpha = 0; // Start invisible
      lightSprite.tint = 0xffffff; // White by default (will be set to light color)
      lightSprite.visible = true;
      lightSprite.x = -10000; // Off-screen when not in use
      lightSprite.y = -10000;

      this.shadowLightSprites[i] = lightSprite;
      // Note: NOT added to container yet - added dynamically during updateShadowSprites
    }

    // Create shadow sprites (one per maxShadowSprites)
    for (let i = 0; i < this.maxShadowSprites; i++) {
      const shadowSprite = new PIXI.Particle({
        texture: defaultTexture,
        anchorX: 0.5,
        anchorY: 1.0, // Anchor at top - shadow extends downward
      });

      shadowSprite.alpha = 0; // Start invisible
      shadowSprite.tint = 0x000000; // Black tint for shadows
      shadowSprite.visible = true;
      shadowSprite.x = -10000; // Off-screen when not in use
      shadowSprite.y = -10000;

      this.shadowSprites[i] = shadowSprite;
      // Note: NOT added to container yet - added dynamically during updateShadowSprites
    }

    console.log(
      `PIXI WORKER: Created ${this.maxLights} light gradient sprites + ${this.maxShadowSprites} shadow sprites`
    );
  }

  // ========================================
  // LIGHT GLOW SYSTEM
  // ========================================

  /**
   * Create the light glow system:
   * 1. Get _lightGradient texture from BigAtlas
   * 2. Create ParticleContainer with additive blend
   * 3. Create glow sprites for each entity slot
   */
  createLightGlowSystem() {
    // Get the gradient texture from BigAtlas
    console.log(
      `🔍 PIXI WORKER: createLightGlowSystem() called. Checking for _lightGradient texture...`
    );
    console.log(
      `   Total textures available: ${Object.keys(this.textures).length}`
    );
    console.log(
      `   _lightGradient in textures: ${"_lightGradient" in this.textures}`
    );
    this.lightGlowTexture = this.textures["_lightGradient"];
    if (!this.lightGlowTexture) {
      console.warn("PIXI WORKER: _lightGradient texture not found in BigAtlas");
      console.warn(
        `   Available texture keys (first 30):`,
        Object.keys(this.textures).slice(0, 30)
      );
      return;
    }

    // Create ParticleContainer with additive blend for glow effect
    // Note: vertex: false is required for alpha to work properly in PixiJS 8
    // Scale changes still work without vertex: true
    // Use "add" blend mode for additive light glow effect
    this.lightGlowContainer = new PIXI.ParticleContainer({
      blendMode: LAYER_DEFAULT_BLEND_MODES.LIGHT_GLOW,
      dynamicProperties: {
        vertex: true,
        position: true,
        rotation: false, // Glows don't rotate
        uvs: true,
        color: true, // For light color
        alpha: true,
      },
    });

    // Render above entities but below UI
    this.lightGlowContainer.zIndex = PixiRenderer.Z_INDICES.LIGHT_GLOW;

    // Ensure container is visible
    this.lightGlowContainer.visible = true;
    this.lightGlowContainer.alpha = 0.5;

    console.log(
      `PIXI WORKER: Light glow system created - container visible: ${this.lightGlowContainer.visible}, alpha: ${this.lightGlowContainer.alpha}, zIndex: ${this.lightGlowContainer.zIndex}`
    );
  }

  /**
   * Create glow sprites pool (size = maxLights)
   * Called after textures are loaded
   */
  createLightGlowSprites() {
    console.log(
      `🔍 PIXI WORKER: createLightGlowSprites() called. lightGlowTexture:`,
      this.lightGlowTexture,
      `lightGlowContainer:`,
      this.lightGlowContainer
    );
    if (!this.lightGlowTexture || !this.lightGlowContainer) {
      console.warn(
        `⚠️ PIXI WORKER: Cannot create light glow sprites - missing texture or container`
      );
      return;
    }

    // Create only maxLights sprites (same limit as shader)
    for (let i = 0; i < this.maxLights; i++) {
      const glowSprite = new PIXI.Particle({
        texture: this.lightGlowTexture,
        anchorX: 0.5,
        anchorY: 0.5, // Center anchor for radial glow
      });

      // Start hidden AND off-screen to prevent (0,0) flash
      glowSprite.alpha = 0;
      glowSprite.scaleX = 0;
      glowSprite.scaleY = 0;
      glowSprite.x = -10000;
      glowSprite.y = -10000;
      glowSprite.visible = true; // Make sure sprite is visible (alpha controls opacity)

      this.lightGlowSprites[i] = glowSprite;
      this.lightGlowContainer.addParticle(glowSprite);
    }

    console.log(
      `✅ PIXI WORKER: Created ${this.maxLights} light glow sprites (container has ${this.lightGlowContainer.children.length} children)`
    );
  }

  /**
   * Update light glow sprites each frame
   * Iterates through entities with LightEmitter, maps to sprite pool (maxLights)
   * Same iteration pattern as updateLighting() for consistency
   */
  updateLightGlowSprites(interpolationAlpha) {
    if (!this.lightGlowEnabled || !this.lightGlowContainer) {
      // Only log once per frame to avoid spam, use a flag
      if (!this._lightGlowWarningLogged) {
        if (!this.lightGlowEnabled) {
          console.warn(
            `⚠️ PIXI WORKER: updateLightGlowSprites() called but lightGlowEnabled is false`
          );
        }
        if (!this.lightGlowContainer) {
          console.warn(
            `⚠️ PIXI WORKER: updateLightGlowSprites() called but lightGlowContainer is null`
          );
        }
        this._lightGlowWarningLogged = true;
      }
      return;
    }

    // Skip updates when container is invisible to prevent WebGL buffer desync
    // ParticleContainer doesn't sync vertex buffers when hidden, causing GL_INVALID_OPERATION
    // errors when made visible again if sprite properties were modified while hidden
    if (!this.lightGlowContainer.visible) {
      return;
    }

    const sprites = this.lightGlowSprites;
    const maxLights = this.maxLights;

    // Cache component array references
    const active = Transform.active;
    const worldX = Transform.x;
    const worldY = Transform.y;
    const lightEnabled = LightEmitter.active;
    const lightColor = LightEmitter.lightColor;
    const glowHeightOffset = LightEmitter.glowHeightOffset;
    const hasGlowSprite = LightEmitter.hasGlowSprite;
    const visualRange = Collider.visualRange;
    const lightIntensity = LightEmitter.lightIntensity;

    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;

    // Calculate viewport bounds for culling
    const viewWidth = this.canvasWidth / zoom;
    const viewHeight = this.canvasHeight / zoom;
    const viewRight = cameraX + viewWidth;
    const viewBottom = cameraY + viewHeight;

    // Viewport center for sorting
    const viewCenterX = cameraX + viewWidth / 2;
    const viewCenterY = cameraY + viewHeight / 2;

    // Gradient texture base size (200px diameter = radius 100)
    const textureRadius = 100;

    // Sprite pool index (maps active lights to sprite pool)
    let spriteIndex = 0;

    // OPTIMIZATION: Use query system to iterate only entities with LightEmitter
    // This is O(numPotentialLights) instead of O(allEntities)
    const lightEntities = this.query([LightEmitter]);

    // Log first successful update (one-time)
    if (!this._lightGlowUpdateLogged) {
      console.log(
        `✅ PIXI WORKER: updateLightGlowSprites() running successfully. Found ${lightEntities.length} entities with LightEmitter component`
      );
      this._lightGlowUpdateLogged = true;
    }

    // Reset light pool for this frame (reuse objects to avoid GC)
    this._lightPoolSize = 0;

    for (let idx = 0; idx < lightEntities.length; idx++) {
      const i = lightEntities[idx];
      // Skip inactive entities, entities without LightEmitter active, or entities without glow sprite
      if (!active[i] || !lightEnabled[i] || !hasGlowSprite[i]) continue;

      // Use sprite position if available (already interpolated)
      const bodySprite = this.bodySprites[i];
      const x = bodySprite ? bodySprite.x : worldX[i];
      const y =
        (bodySprite ? bodySprite.y : worldY[i]) - (glowHeightOffset[i] || 0);
      const intensity = lightIntensity[i];

      // Viewport culling: Only include lights that actually affect the visible screen
      // Use roughly same logic as updateLighting for consistency
      const influenceRadius = 10 * Math.sqrt(intensity);

      if (
        x + influenceRadius < cameraX ||
        x - influenceRadius > viewRight ||
        y + influenceRadius < cameraY ||
        y - influenceRadius > viewBottom
      ) {
        continue;
      }

      // Add to pool for sorting
      const poolIdx = this._lightPoolSize++;
      if (!this._lightPool[poolIdx]) {
        this._lightPool[poolIdx] = { entityId: 0, distSq: 0 };
      }
      const item = this._lightPool[poolIdx];
      item.entityId = i;

      // Distance squared to camera center (for prioritization)
      const dx = x - viewCenterX;
      const dy = y - viewCenterY;
      item.distSq = dx * dx + dy * dy;
    }

    // Sort visible lights by distance (closest first)
    const visibleLights = this._lightPool.slice(0, this._lightPoolSize);
    // visibleLights.sort((a, b) => a.distSq - b.distSq);

    const countToRender = Math.min(visibleLights.length, maxLights);

    // Log first update with details (one-time)
    if (!this._lightGlowFirstUpdateLogged && countToRender > 0) {
      console.log(
        `🔍 PIXI WORKER: updateLightGlowSprites() - Rendering ${countToRender} lights (${visibleLights.length} visible, maxLights: ${maxLights})`
      );
      console.log(
        `   Container visible: ${this.lightGlowContainer.visible}, alpha: ${this.lightGlowContainer.alpha
        }, children: ${this.lightGlowContainer.children?.length || "N/A"}`
      );
      this._lightGlowFirstUpdateLogged = true;
    }

    for (let i = 0; i < countToRender; i++) {
      const entityIndex = visibleLights[i].entityId;
      const sprite = sprites[spriteIndex];
      if (!sprite) {
        console.warn(`⚠️ PIXI WORKER: Sprite at index ${spriteIndex} is null!`);
        spriteIndex++;
        continue;
      }

      const bodySprite = this.bodySprites[entityIndex];

      // Get visual range for this entity (from Collider component)
      const rangeVal = visualRange[entityIndex] || 200;
      const glowDiameter = rangeVal;
      const scale = (glowDiameter * 3) / textureRadius;

      // Position: entity position with height offset (light is above entity)
      sprite.x = bodySprite ? bodySprite.x : worldX[entityIndex];
      sprite.y =
        (bodySprite ? bodySprite.y : worldY[entityIndex]) -
        (glowHeightOffset[entityIndex] || 0);

      // Scale based on visualRange
      sprite.scaleX = scale;
      sprite.scaleY = scale;

      sprite.tint = convertRGBtoBGR(lightColor[entityIndex]);

      // Show this sprite (alpha controls visibility for ParticleContainer)
      const newAlpha = lightIntensity[entityIndex] / 1000000;
      sprite.alpha = newAlpha;
      sprite.visible = true; // Ensure sprite is visible

      // Log first sprite update details (one-time)
      if (i === 0 && !this._lightGlowSpriteUpdateLogged) {
        console.log(
          `🔍 PIXI WORKER: First light glow sprite update - entityIndex: ${entityIndex}, x: ${sprite.x
          }, y: ${sprite.y
          }, scale: ${scale}, alpha: ${newAlpha}, tint: 0x${sprite.tint.toString(
            16
          )}`
        );
        console.log(
          `   Sprite visible: ${sprite.visible}, texture: ${sprite.texture?.width}x${sprite.texture?.height}`
        );
        this._lightGlowSpriteUpdateLogged = true;
      }

      spriteIndex++;
    }

    // Hide any unused sprites in the pool
    // Move off-screen AND set alpha=0 to prevent (0,0) rendering
    for (let i = spriteIndex; i < maxLights; i++) {
      const sprite = sprites[i];
      if (sprite && sprite.alpha !== 0) {
        sprite.alpha = 0;
        sprite.scaleX = 0;
        sprite.scaleY = 0;
        sprite.x = -10000;
        sprite.y = -10000;
      }
    }
  }

  /**
   * Update shadow sprites using RenderTexture-based interleaved rendering
   *
   * For each light: render light gradient (white/colored), then its shadows (black)
   * Later lights' gradients overwrite earlier shadows, creating realistic light interaction
   * The final texture is applied with MULTIPLY blend to darken the scene
   *
   * Rendering happens in SCREEN SPACE (shadowRT coordinates)
   */
  updateShadowSprites(interpolationAlpha) {
    if (!this.shadowSpritesEnabled || !this.shadowSpriteActive) return;
    if (!this.shadowParticleContainer || !this.shadowRT) return;

    const shadowSprites = this.shadowSprites;
    const lightSprites = this.shadowLightSprites;
    const maxShadows = this.maxShadowSprites;
    const maxLights = this.maxLights;

    // Cache shadow buffer arrays
    const shadowActive = this.shadowSpriteActive;
    const shadowX = this.shadowSpriteX;
    const shadowY = this.shadowSpriteY;
    const shadowRotation = this.shadowSpriteRotation;
    const shadowScaleX = this.shadowSpriteScaleX;
    const shadowScaleY = this.shadowSpriteScaleY;
    const shadowAlpha = this.shadowSpriteAlpha;
    const shadowEntityIdx = this.shadowSpriteEntityIdx;
    const shadowLightIdx = this.shadowSpriteLightIdx;
    const prevEntityIdx = this._shadowPrevEntityIdx;

    // Cache light component arrays
    const transformActive = Transform.active;
    const worldX = Transform.x;
    const worldY = Transform.y;
    const lightEnabled = LightEmitter.active;
    const lightColor = LightEmitter.lightColor;
    const lightIntensity = LightEmitter.lightIntensity;
    const lightHeight = LightEmitter.height;

    // Camera transform for world-to-screen conversion
    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;
    const resolution = this.shadowResolution;

    // ========================================
    // STEP 1: Group shadows by light index
    // ========================================
    // Create a map: lightIdx -> array of shadow indices
    if (!this._shadowsByLight) {
      this._shadowsByLight = new Map();
    }
    const shadowsByLight = this._shadowsByLight;
    shadowsByLight.clear();

    // Also track which lights have active shadows (for ordering)
    if (!this._activeLightIndices) {
      this._activeLightIndices = [];
    }
    const activeLightIndices = this._activeLightIndices;
    activeLightIndices.length = 0;

    let activeShadowCount = 0;
    for (let i = 0; i < maxShadows; i++) {
      if (!shadowActive[i]) continue;
      activeShadowCount++;

      const lightIdx = shadowLightIdx[i];
      if (lightIdx < 0) continue;

      if (!shadowsByLight.has(lightIdx)) {
        shadowsByLight.set(lightIdx, []);
        activeLightIndices.push(lightIdx);
      }
      shadowsByLight.get(lightIdx).push(i);
    }



    // ========================================
    // STEP 2: Clear particle container and rebuild
    // ========================================
    this.shadowParticleContainer.particleChildren.length = 0;

    // // Add white background sprite FIRST (ensures white base = no darkening)
    // if (this.shadowBackgroundSprite) {
    //   // Size to cover entire shadowRT
    //   this.shadowBackgroundSprite.x = 0;
    //   this.shadowBackgroundSprite.y = 0;
    //   this.shadowBackgroundSprite.scaleX = this.shadowRT.width;
    //   this.shadowBackgroundSprite.scaleY = this.shadowRT.height;
    //   this.shadowParticleContainer.addParticle(this.shadowBackgroundSprite);
    // }

    // Gradient texture base size (200px diameter = radius 100)
    const gradientTextureRadius = 100;

    let lightSpriteIndex = 0;

    // ========================================
    // STEP 3: For each light, add gradient then shadows
    // ========================================
    for (let li = 0; li < activeLightIndices.length; li++) {
      if (lightSpriteIndex >= maxLights) break;

      const lightIdx = activeLightIndices[li];
      if (!transformActive[lightIdx] || !lightEnabled[lightIdx]) continue;

      const shadowIndices = shadowsByLight.get(lightIdx);
      if (!shadowIndices || shadowIndices.length === 0) continue;



      // --- Add shadows for this light ---
      for (let si = 0; si < shadowIndices.length; si++) {
        const shadowIdx = shadowIndices[si];
        const sprite = shadowSprites[shadowIdx];
        if (!sprite) continue;

        // Get shadow world position
        const sx = shadowX[shadowIdx];
        const sy = shadowY[shadowIdx];

        // Convert to screen space
        const screenSX = (sx - cameraX) * zoom * resolution;
        const screenSY = (sy - cameraY) * zoom * resolution;

        // Update sprite properties
        sprite.x = screenSX;
        sprite.y = screenSY;
        sprite.rotation = shadowRotation[shadowIdx] + Math.PI; // Point away from light
        sprite.scaleX = shadowScaleX[shadowIdx] * zoom * resolution;
        sprite.scaleY = shadowScaleY[shadowIdx] * zoom * resolution;
        sprite.alpha = shadowAlpha[shadowIdx];
        sprite.tint = 0x000000; // Black for shadows

        // Mirror texture from parent entity
        const currentEntity = shadowEntityIdx[shadowIdx];
        if (currentEntity >= 0 && currentEntity < this.bodySprites.length) {
          const bodySprite = this.bodySprites[currentEntity];
          if (bodySprite && bodySprite.texture) {
            sprite.texture = bodySprite.texture;
          }
        }

        // Update ownership tracking
        prevEntityIdx[shadowIdx] = currentEntity;

        this.shadowParticleContainer.addParticle(sprite);
      }


      // --- Add light gradient sprite ---
      const lightSprite = lightSprites[lightSpriteIndex];
      if (lightSprite) {
        // Light position in screen space
        const lx = worldX[lightIdx];
        const ly = worldY[lightIdx] - (lightHeight[lightIdx] || 0);
        const screenLX = (lx - cameraX) * zoom * resolution;
        const screenLY = (ly - cameraY) * zoom * resolution;

        // Light gradient size based on intensity
        // Using similar formula to lighting shader: influence radius = 10 * sqrt(intensity)
        const intensity = lightIntensity[lightIdx];
        const influenceRadius = 10 * Math.sqrt(intensity);
        const gradientScale =
          ((influenceRadius * zoom * resolution) / gradientTextureRadius) *
          3;

        lightSprite.x = screenLX;
        lightSprite.y = screenLY;
        lightSprite.scaleX = gradientScale
        lightSprite.scaleY = gradientScale
        lightSprite.tint = 0xffffff;
        lightSprite.alpha = intensity / 50000

        this.shadowParticleContainer.addParticle(lightSprite);
        lightSpriteIndex++;
      }
    }

    // Update the container
    this.shadowParticleContainer.update();

    // ========================================
    // STEP 4: Render to shadowRT
    // ========================================
    // White background is provided by shadowBackgroundSprite (first particle)
    this.pixiApp.renderer.render({
      container: this.shadowParticleContainer,
      target: this.shadowRT,
      clear: true,
    });
  }

  /**
   * Build map of entity types that have SpriteRenderer component
   * Spritesheets are now set per-instance via setSpritesheet(), not per-class
   */
  buildEntitySpriteConfigs(registeredClasses) {
    // Track which entity types have SpriteRenderer (they need placeholder sprites)
    for (const registration of registeredClasses) {
      if (registration.poolSize === 0) continue;
      if (!registration.components?.includes("SpriteRenderer")) continue;

      const entityType = registration.entityType;
      if (entityType === undefined || typeof entityType !== "number") continue;

      // Mark this entity type as having SpriteRenderer (spritesheet set per-instance)
      this.entitySpriteConfigs[entityType] = { hasSpriteRenderer: true };
    }
  }

  /**
   * Load simple textures from transferred ImageBitmaps
   * PixiJS 8: Uses ImageSource instead of BaseTexture
   */
  loadTextures(texturesData) {
    if (!texturesData) return;

    // console.log(
    //   `PIXI WORKER: Loading ${Object.keys(texturesData).length} textures`
    // );

    for (const [name, imageBitmap] of Object.entries(texturesData)) {
      // PixiJS 8: Create TextureSource from ImageBitmap, then create Texture
      const source = new PIXI.ImageSource({ resource: imageBitmap });
      this.textures[name] = new PIXI.Texture({ source });

      // console.log(`✅ Loaded texture: ${name}`);
    }
  }

  /**
   * Load spritesheets from JSON + texture data
   * NOTE: PIXI.Spritesheet.parse() doesn't work in workers, so we manually build animations
   */
  loadSpritesheets(spritesheetData, proxySheets = {}) {
    if (!spritesheetData) {
      // console.log("PIXI WORKER: No spritesheets to load");
      return;
    }

    // console.log(
    //   `PIXI WORKER: Loading ${Object.keys(spritesheetData).length} spritesheets`
    // );

    for (const [name, data] of Object.entries(spritesheetData)) {
      try {
        // console.log(`  Loading spritesheet "${name}"...`);

        // Validate data
        if (!data.imageBitmap || !data.json) {
          throw new Error(`Missing imageBitmap or json for ${name}`);
        }

        // PixiJS 8: Create ImageSource from ImageBitmap
        const source = new PIXI.ImageSource({ resource: data.imageBitmap });
        const jsonData = data.json;

        // Manually create textures for each frame
        const frameTextures = {};
        for (const [frameName, frameData] of Object.entries(jsonData.frames)) {
          const frame = frameData.frame;
          // PixiJS 8: Texture constructor takes options object with source and frame
          const texture = new PIXI.Texture({
            source,
            frame: new PIXI.Rectangle(frame.x, frame.y, frame.w, frame.h),
          });
          frameTextures[frameName] = texture;
        }

        // Manually build animation arrays
        const animations = {};
        if (jsonData.animations) {
          for (const [animName, frameNames] of Object.entries(
            jsonData.animations
          )) {
            animations[animName] = frameNames.map(
              (frameName) => frameTextures[frameName]
            );
          }
        }

        // Store as a spritesheet-like object
        this.spritesheets[name] = {
          textures: frameTextures,
          animations: animations,
          source: source, // PixiJS 8: uses source instead of baseTexture
        };

        // BIGATLAST SUPPORT: If this is the bigAtlas, also populate this.textures
        // This allows static textures (like "bunny") to be accessed directly
        if (name === "bigAtlas") {
          for (const [frameName, texture] of Object.entries(frameTextures)) {
            this.textures[frameName] = texture;
          }

          // Initialize particle pool with a texture from bigAtlas
          const textureKeys = Object.keys(frameTextures);
          if (textureKeys.length > 0) {
            this.particlePool.setDefaultTexture(frameTextures[textureKeys[0]]);
          }

          console.log(
            `✅ BigAtlas loaded: ${Object.keys(frameTextures).length
            } frames available as textures`
          );

          // DEBUG: Check if _lightGradient texture is available
          if (this.textures["_lightGradient"]) {
            console.log(
              `✅ PIXI WORKER: _lightGradient texture found in BigAtlas textures`
            );
          } else {
            console.warn(
              `⚠️ PIXI WORKER: _lightGradient texture NOT found in BigAtlas textures`
            );
            console.log(
              `   Available texture keys (first 20):`,
              textureKeys.slice(0, 20)
            );
            console.log(
              `   Looking for textures with "light" or "gradient" in name:`,
              textureKeys.filter(
                (k) =>
                  k.toLowerCase().includes("light") ||
                  k.toLowerCase().includes("gradient")
              )
            );
          }

          // Create shadow sprites now that BigAtlas is loaded
          // Shadows are rendered via shadowRT system (RenderTexture-based)
          if (
            this.shadowSpritesEnabled &&
            this.shadowSprites.length === 0 &&
            this.shadowParticleContainer
          ) {
            this.createShadowSprites();
          }
        }

        // console.log(
        //   `✅ Loaded spritesheet: ${name} with ${
        //     Object.keys(animations).length
        //   } animations`
        // );
      } catch (error) {
        console.error(`❌ Failed to load spritesheet ${name}:`, error);
      }
    }

    // Create proxy spritesheet entries that redirect to bigAtlas
    if (proxySheets && Object.keys(proxySheets).length > 0) {
      console.log(
        `🔗 Creating ${Object.keys(proxySheets).length} proxy spritesheets...`
      );

      const bigAtlas = this.spritesheets["bigAtlas"];
      if (!bigAtlas) {
        console.error("❌ Cannot create proxy sheets: bigAtlas not loaded!");
        return;
      }

      for (const [proxyName, proxyData] of Object.entries(proxySheets)) {
        const prefix = proxyData.prefix;

        // Extract animations from bigAtlas that match this proxy's prefix
        const proxyAnimations = {};
        const proxyTextures = {};

        for (const [animName, animInfo] of Object.entries(
          proxyData.animations
        )) {
          const prefixedName = animInfo.prefixedName;
          if (bigAtlas.animations[prefixedName]) {
            // Map unprefixed name to bigAtlas animation
            proxyAnimations[animName] = bigAtlas.animations[prefixedName];
          } else {
            console.warn(
              `⚠️ Proxy "${proxyName}": Animation "${animName}" (${prefixedName}) not found in bigAtlas`
            );
          }
        }

        // Also extract frame textures with this prefix
        for (const [frameName, texture] of Object.entries(bigAtlas.textures)) {
          if (frameName.startsWith(prefix)) {
            const unprefixedName = frameName.substring(prefix.length);
            proxyTextures[unprefixedName] = texture;
          }
        }

        // Create proxy spritesheet entry (for PIXI rendering)
        this.spritesheets[proxyName] = {
          textures: proxyTextures,
          animations: proxyAnimations,
          source: bigAtlas.source, // PixiJS 8: uses source instead of baseTexture
          isProxy: true,
          targetSheet: "bigAtlas",
        };

        // Also register in SpriteSheetRegistry (for animation lookups)
        SpriteSheetRegistry.registerProxy(proxyName, proxyData);

        console.log(
          `  ✅ Proxy "${proxyName}": ${Object.keys(proxyAnimations).length
          } animations`
        );
      }
    }

    // console.log("PIXI WORKER: Finished loading all spritesheets");
  }

  /**
   * Load tilemaps from transferred data (Tiled JSON + tileset ImageBitmap)
   */
  loadTilemaps(tilemapsData) {
    if (!tilemapsData || Object.keys(tilemapsData).length === 0) {
      return;
    }

    console.log(
      `PIXI WORKER: Loading ${Object.keys(tilemapsData).length} tilemaps...`
    );

    for (const [tilemapId, tilemapData] of Object.entries(tilemapsData)) {
      try {
        // Create PIXI Texture from transferred ImageBitmap
        const source = new PIXI.ImageSource({
          resource: tilemapData.tilesetBitmap,
        });
        const tilesetTexture = new PIXI.Texture({ source });

        // Store tilemap data with PIXI texture
        this.tilemaps[tilemapId] = {
          data: tilemapData.data,
          tilesetTexture: tilesetTexture,
        };

        console.log(`  ✅ Loaded tilemap: ${tilemapId}`);
      } catch (error) {
        console.error(`  ❌ Failed to load tilemap "${tilemapId}":`, error);
      }
    }
  }

  /**
   * Initialize particle sprite tracking arrays
   * OPTIMIZATION: Sprites are acquired lazily from central pool when particles spawn
   */
  createParticleSprites() {
    if (this.maxParticles === 0) return;

    // Initialize particle tracking arrays
    this.particleSprites = new Array(this.maxParticles).fill(null);
    this.particleSpritePoolIndices = new Int32Array(this.maxParticles).fill(-1);

    console.log(
      `PIXI WORKER: Particle system initialized (${this.maxParticles} slots, using central particle pool)`
    );
  }

  /**
   * Update particle sprites from ParticleComponent data
   * Adds visible particles to _ySortPool for Y-sorting (GC optimized)
   */
  updateParticleSprites() {
    if (this.maxParticles === 0) {
      this.visibleParticleCount = 0;
      return;
    }

    // Cache array references
    const active = ParticleComponent.active;
    const x = ParticleComponent.x;
    const y = ParticleComponent.y;
    const z = ParticleComponent.z;
    const scale = ParticleComponent.scale;
    const alpha = ParticleComponent.alpha;
    const tint = ParticleComponent.tint;
    const textureId = ParticleComponent.textureId;
    const isItOnScreen = ParticleComponent.isItOnScreen;
    const rotation = ParticleComponent.rotation;
    const flipX = ParticleComponent.flipX;
    const flipY = ParticleComponent.flipY;

    let visibleParticleCount = 0;

    for (let i = 0; i < this.maxParticles; i++) {
      let sprite = this.particleSprites[i];
      const poolIndex = this.particleSpritePoolIndices[i];

      // ========================================
      // LAZY SPRITE CREATION & RELEASE
      // ========================================
      // Particle effects use the same centralized pool as entities and decorations.
      // Sprites are acquired when particles spawn, released when they despawn or go off-screen.

      // Release sprite when particle despawns or goes off-screen
      if (!active[i] || !isItOnScreen[i]) {
        if (sprite && poolIndex !== -1) {
          this.particlePool.release(poolIndex);
          this.particleSprites[i] = null;
          this.particleSpritePoolIndices[i] = -1;
          // Clear texture cache for this particle
          delete this.particleTextureCache[i + "_" + textureId[i]];
        }
        continue;
      }

      // Acquire sprite from central pool when particle becomes active and visible
      if (!sprite) {
        const { particle, index } = this.particlePool.acquire();
        sprite = particle;
        this.particleSprites[i] = particle;
        this.particleSpritePoolIndices[i] = index;

        // Add to container if Y-sorting is disabled
        if (!this.ySorting) {
          this.particleContainer.addParticle(particle);
        }
      }

      // Calculate render Y (ground Y + height offset)
      const renderY = y[i] + z[i];

      // Update sprite properties from ParticleComponent
      sprite.x = x[i];
      sprite.y = renderY;
      sprite.scaleX = flipX[i] ? -scale[i] : scale[i];
      sprite.scaleY = flipY[i] ? -scale[i] : scale[i];
      sprite.rotation = rotation[i];
      sprite.alpha = alpha[i];
      sprite.tint = tint[i];

      // Update texture if needed (check cache)
      const tid = textureId[i];
      if (tid > 0 && !this.particleTextureCache[i + "_" + tid]) {
        // Get texture from bigAtlas by animation index
        const textureName = SpriteSheetRegistry.getAnimationName(
          "bigAtlas",
          tid
        );
        if (textureName && this.textures[textureName]) {
          sprite.texture = this.textures[textureName];
          this.particleTextureCache[i + "_" + tid] = true;
        }
      }

      // Count visible particles
      visibleParticleCount++;

      // Add to Y-sort list if sorting is enabled
      // Use ground Y (y[i]) for sorting, renderY for display
      if (this.ySorting) {
        // Make sprite visible before adding to sort list
        if (!sprite.visible) {
          sprite.visible = true;
        }
        // GC OPTIMIZATION: Reuse pooled objects instead of allocating new ones each frame
        const poolIdx = this._ySortPoolSize++;
        if (!this._ySortPool[poolIdx]) {
          this._ySortPool[poolIdx] = {
            entityId: 0,
            particleIndex: 0,
            sprite: null,
            y: 0,
          };
        }
        const item = this._ySortPool[poolIdx];
        item.entityId = -1; // Mark as particle (not an entity)
        item.particleIndex = i;
        item.sprite = sprite;
        item.y = y[i]; // Sort by ground position
      } else {
        // Y-sorting disabled - just show the sprite
        if (!sprite.visible) {
          sprite.visible = true;
        }
      }
    }

    // Store visible particle count for reporting
    this.visibleParticleCount = visibleParticleCount;
  }

  /**
   * Create decoration sprites (separate from entity sprites)
   * OPTIMIZATION: Uses lazy creation - sprites are acquired from central pool when needed
   */
  createDecorationSprites() {
    if (this.maxDecorations === 0) return;

    // Initialize arrays for decoration tracking
    this.decorationSprites = new Array(this.maxDecorations).fill(null);
    this.decorationSpritePoolIndices = new Int32Array(this.maxDecorations).fill(
      -1
    );
    this.decorationSpriteTextureIds = new Uint16Array(this.maxDecorations);

    console.log(
      `PIXI WORKER: Decoration system initialized (${this.maxDecorations} slots, using central particle pool)`
    );
  }

  /**
   * Update decoration sprites from DecorationComponent data
   * Adds visible decorations to _ySortPool for Y-sorting (GC optimized)
   */
  updateDecorationSprites() {
    if (this.maxDecorations === 0) {
      this.visibleDecorationCount = 0;
      return;
    }

    // Early exit if no decorations are active (shared counter from DecorationPool)
    if (DecorationPool.activeCount && DecorationPool.activeCount[0] === 0) {
      this.visibleDecorationCount = 0;
      return;
    }

    // Cache array references
    const active = DecorationComponent.active;
    const x = DecorationComponent.x;
    const y = DecorationComponent.y;
    const scale = DecorationComponent.scale;
    const alpha = DecorationComponent.alpha;
    const tint = DecorationComponent.tint;
    const textureId = DecorationComponent.textureId;
    const anchorX = DecorationComponent.anchorX;
    const anchorY = DecorationComponent.anchorY;
    const isItOnScreen = DecorationComponent.isItOnScreen;

    let visibleDecorationCount = 0;

    for (let i = 0; i < this.maxDecorations; i++) {
      const sprite = this.decorationSprites[i];
      const poolIndex = this.decorationSpritePoolIndices[i];

      // ========================================
      // LAZY SPRITE CREATION & RELEASE
      // ========================================
      // Decorations use the same centralized pool as entities and particles.
      // Sprites are acquired when decorations become visible, released when off-screen.

      // Release sprite when decoration despawns or goes off-screen
      if (!active[i] || !isItOnScreen[i]) {
        if (sprite && poolIndex !== -1) {
          this.particlePool.release(poolIndex);
          this.decorationSprites[i] = null;
          this.decorationSpritePoolIndices[i] = -1;
          this.decorationSpriteTextureIds[i] = 0;
        }
        continue;
      }

      // Acquire sprite from central pool when decoration becomes visible
      let actualSprite = sprite;
      if (!actualSprite) {
        const { particle, index } = this.particlePool.acquire();
        actualSprite = particle;
        this.decorationSprites[i] = particle;
        this.decorationSpritePoolIndices[i] = index;
        this.decorationSpriteTextureIds[i] = 0; // Reset texture tracking

        // Add to container if Y-sorting is disabled
        if (!this.ySorting) {
          this.particleContainer.addParticle(particle);
        }
      }

      // Update sprite properties from DecorationComponent
      actualSprite.x = x[i];
      actualSprite.y = y[i];
      actualSprite.scaleX = scale[i];
      actualSprite.scaleY = scale[i];
      actualSprite.alpha = alpha[i];
      actualSprite.tint = tint[i];
      actualSprite.anchorX = anchorX[i];
      actualSprite.anchorY = anchorY[i];

      // Update texture if it changed
      const tid = textureId[i];
      if (tid > 0 && this.decorationSpriteTextureIds[i] !== tid) {
        // Get texture from bigAtlas by animation index
        const textureName = SpriteSheetRegistry.getAnimationName(
          "bigAtlas",
          tid
        );
        if (textureName && this.textures[textureName]) {
          actualSprite.texture = this.textures[textureName];
          this.decorationSpriteTextureIds[i] = tid; // Track decoration's current texture
        }
      }

      // Count visible decorations
      visibleDecorationCount++;

      // Add to Y-sort list if sorting is enabled
      if (this.ySorting) {
        // Make sprite visible before adding to sort list
        if (!actualSprite.visible) {
          actualSprite.visible = true;
        }
        // GC OPTIMIZATION: Reuse pooled objects instead of allocating new ones each frame
        const poolIdx = this._ySortPoolSize++;
        if (!this._ySortPool[poolIdx]) {
          this._ySortPool[poolIdx] = {
            entityId: 0,
            particleIndex: 0,
            decorationIndex: 0,
            sprite: null,
            y: 0,
          };
        }
        const item = this._ySortPool[poolIdx];
        item.entityId = -2; // Mark as decoration (not an entity, not a particle)
        item.decorationIndex = i;
        item.sprite = actualSprite;
        item.y = y[i]; // Sort by Y position
      } else {
        // Y-sorting disabled - just show the sprite
        if (!actualSprite.visible) {
          actualSprite.visible = true;
        }
      }
    }

    // Store visible decoration count for reporting
    this.visibleDecorationCount = visibleDecorationCount;
  }

  /**
   * Initialize entity sprite tracking arrays
   * OPTIMIZATION: Sprites are now acquired lazily from central pool when entities spawn
   * This saves memory for unused entity slots
   */
  createSprites() {
    // Initialize sprite tracking arrays
    this.bodySprites = new Array(this.globalEntityCount).fill(null);
    this.bodySpritePoolIndices = new Int32Array(this.globalEntityCount).fill(
      -1
    );
    this.currentSpritesheetIds = new Uint8Array(this.globalEntityCount);

    // Initialize animation tracking typed arrays
    this.previousAnimStates = new Int16Array(this.globalEntityCount).fill(-1);
    this.currentFrameIndex = new Uint16Array(this.globalEntityCount);
    this.frameAccumulator = new Float32Array(this.globalEntityCount);
    this.animationSpeed = new Float32Array(this.globalEntityCount);
    this.currentAnimationFrames = new Array(this.globalEntityCount)
      .fill(null)
      .map(() => []);

    console.log(
      `PIXI WORKER: Entity sprite system initialized (${this.globalEntityCount} slots, using central particle pool)`
    );
  }

  /**
   * Handle messages from other workers (via MessagePort)
   * This receives sprite commands directly from logic worker
   */
  handleWorkerMessage(fromWorker, data) {
    if (fromWorker === "logic" || fromWorker === "physics") {
      this.handleSpriteCommand(data);
    }
  }

  /**
   * Handle sprite commands from logic worker
   * Commands: setProp, callMethod, batchUpdate
   */
  handleSpriteCommand(data) {
    const { cmd, entityId, prop, value, method, args, set, call } = data;

    const sprite = this.bodySprites[entityId];
    if (!sprite) return;

    switch (cmd) {
      case "setProp":
        // Set nested property
        setNestedProperty(sprite, prop, value);
        break;

      case "callMethod":
        // Call method on sprite
        if (typeof sprite[method] === "function") {
          sprite[method](...args);
        }
        break;

      case "batchUpdate":
        // Batch set properties
        if (set) {
          Object.entries(set).forEach(([key, val]) => {
            setNestedProperty(sprite, key, val);
          });
        }
        // Batch call methods
        if (call && call.method) {
          if (typeof sprite[call.method] === "function") {
            sprite[call.method](...(call.args || []));
          }
        }
        break;
    }
  }

  /**
   * Handle custom messages (for backwards compatibility)
   * @deprecated - Use handleWorkerMessage for direct worker communication
   */
  handleCustomMessage(data) {
    const { msg } = data;
    console.log(`PIXI WORKER: handleCustomMessage called with msg: ${msg}`);

    // Handle old-style messages if they still arrive via main thread
    if (msg === "toRenderer") {
      this.handleSpriteCommand(data);
    } else if (msg === "setBackground") {
      this.handleSetBackground(data);
    } else if (msg === "resize") {
      this.handleResize(data);
    } else if (msg === "setLayerProps") {
      this.handleSetLayerProps(data);
    } else {
      console.log(`PIXI WORKER: Unhandled message type: ${msg}`);
    }
  }

  /**
   * Handle layer property changes from debug UI
   * @param {Object} data - { layer: string, visible?: boolean, alpha?: number, blendMode?: string, zIndex?: number }
   */
  handleSetLayerProps(data) {
    const { layer, visible, alpha, blendMode, zIndex } = data;

    const displayObject = this.layerRefs?.[layer];
    if (!displayObject) {
      // Layer doesn't exist in current scene config - silently ignore
      return;
    }

    // Apply visibility
    if (visible !== undefined) {
      displayObject.visible = visible;
    }

    // Apply alpha
    if (alpha !== undefined) {
      displayObject.alpha = Math.max(0, Math.min(1, alpha));
    }

    // Apply blend mode
    if (blendMode !== undefined) {
      // Pass through directly - PIXI supports these blend modes
      displayObject.blendMode = blendMode;
    }

    // Apply z-index
    if (zIndex !== undefined) {
      displayObject.zIndex = zIndex;
      // Re-sort stage children after z-index change
      this.pixiApp.stage.sortChildren();
    }

    console.log(`PIXI WORKER: Layer "${layer}" updated:`, { visible, alpha, blendMode, zIndex });
  }

  /**
   * Handle canvas resize messages
   */
  handleResize(data) {
    const { width, height } = data;
    this.canvasWidth = width;
    this.canvasHeight = height;

    if (this.pixiApp) {
      this.pixiApp.renderer.resize(width, height);
    }

    // Resize lighting RenderTexture
    if (this.lightingRT) {
      this.lightingRT.resize(
        width * this.lightingResolution,
        height * this.lightingResolution
      );
      if (this.lightingDisplaySprite) {
        this.lightingDisplaySprite.scale.set(1.0 / this.lightingResolution);
      }
    }

    // Resize shadow RenderTexture
    if (this.shadowRT) {
      this.shadowRT.resize(
        width * this.shadowResolution,
        height * this.shadowResolution
      );
      if (this.shadowDisplaySprite) {
        this.shadowDisplaySprite.scale.set(1.0 / this.shadowResolution);
      }
    }

    console.log(`PIXI WORKER: Resized to ${width}x${height}`);
  }

  /**
   * Handle background change requests from Scene
   * Supports: static, tiling, tilemap, or none
   */
  handleSetBackground(data) {
    console.log(`PIXI WORKER: handleSetBackground called with:`, data);
    const { type, textureId, tileScale, tilemapId, options } = data;

    // Remove existing background if any
    if (this.backgroundSprite) {
      console.log(`PIXI WORKER: Removing existing backgroundSprite`);
      this.pixiApp.stage.removeChild(this.backgroundSprite);
      this.backgroundSprite.destroy();
      this.backgroundSprite = null;
    }

    // Remove existing tilemap if any
    if (this.currentTilemap) {
      console.log(`PIXI WORKER: Removing existing tilemap`);
      this.pixiApp.stage.removeChild(this.currentTilemap);
      this.currentTilemap.destroy();
      this.currentTilemap = null;
    }

    // Create new background based on type
    console.log(`PIXI WORKER: Creating background of type: ${type}`);
    switch (type) {
      case "static":
        this.createStaticBackground(textureId);
        break;
      case "tiling":
        this.createTilingBackground(textureId, tileScale);
        break;
      case "tilemap":
        this.createTilemapBackground(tilemapId, options);
        break;
      case "none":
        // No background
        console.log(`PIXI WORKER: No background`);
        break;
      default:
        console.warn(`PIXI WORKER: Unknown background type: ${type}`);
    }

    // Update layer refs after background change
    this._updateBackgroundLayerRef();
  }

  /**
   * Update the BACKGROUND layer reference after background changes
   */
  _updateBackgroundLayerRef() {
    if (!this.layerRefs) return;

    if (this.currentTilemap) {
      this.layerRefs.BACKGROUND = this.currentTilemap;
    } else if (this.backgroundSprite) {
      this.layerRefs.BACKGROUND = this.backgroundSprite;
    } else {
      delete this.layerRefs.BACKGROUND;
    }
  }

  /**
   * Create a static background (simple Sprite, does not tile)
   */
  createStaticBackground(textureId) {
    const texture = this.textures[textureId];
    if (!texture) {
      console.warn(
        `PIXI WORKER: Texture "${textureId}" not found for static background`
      );
      return;
    }

    this.backgroundSprite = new PIXI.Sprite(texture);
    this.backgroundSprite.width = this.worldWidth;
    this.backgroundSprite.height = this.worldHeight;
    this.backgroundSprite.zIndex = PixiRenderer.Z_INDICES.BACKGROUND;
    this.pixiApp.stage.addChild(this.backgroundSprite);

    console.log(`PIXI WORKER: Static background set to "${textureId}"`);
  }

  /**
   * Create a tiling background (TilingSprite - repeats pattern)
   */
  createTilingBackground(textureId, tileScale = 1) {
    const texture = this.textures[textureId];
    if (!texture) {
      console.warn(
        `PIXI WORKER: Texture "${textureId}" not found for tiling background`
      );
      return;
    }

    this.backgroundSprite = new PIXI.TilingSprite({
      texture: texture,
      width: this.worldWidth,
      height: this.worldHeight,
    });
    this.backgroundSprite.tileScale.set(tileScale, tileScale);
    this.backgroundSprite.tilePosition.set(0, 0);
    this.backgroundSprite.zIndex = PixiRenderer.Z_INDICES.BACKGROUND;
    this.pixiApp.stage.addChild(this.backgroundSprite);

    console.log(
      `PIXI WORKER: Tiling background set to "${textureId}" (scale: ${tileScale})`
    );
  }

  /**
   * Create a tilemap background using @pixi/tilemap (Tiled editor format)
   * Parses Tiled JSON and renders tiles with automatic culling
   */
  createTilemapBackground(tilemapId, options = {}) {
    console.log(
      `PIXI WORKER: createTilemapBackground called with "${tilemapId}"`
    );
    console.log(`PIXI WORKER: Available tilemaps:`, Object.keys(this.tilemaps));

    const tilemapData = this.tilemaps[tilemapId];
    if (!tilemapData) {
      console.warn(
        `PIXI WORKER: Tilemap "${tilemapId}" not found in loaded tilemaps`
      );
      return;
    }

    const { data, tilesetTexture } = tilemapData;
    console.log(`PIXI WORKER: Tilemap data:`, data);
    console.log(`PIXI WORKER: Tileset texture:`, tilesetTexture);

    // Create CompositeTilemap instance with tileset texture
    // NOTE: CompositeTilemap.tileset() expects an ARRAY of textures, not a single texture!
    console.log(`PIXI WORKER: Creating CompositeTilemap instance...`);
    this.currentTilemap = new CompositeTilemap([tilesetTexture]);
    console.log(
      `PIXI WORKER: CompositeTilemap instance created:`,
      this.currentTilemap
    );

    // Parse scale option
    if (options.scale !== undefined) {
      if (typeof options.scale === "number") {
        this.tilemapScale = { x: options.scale, y: options.scale };
      } else if (
        typeof options.scale === "object" &&
        options.scale.x !== undefined
      ) {
        this.tilemapScale = {
          x: options.scale.x,
          y: options.scale.y !== undefined ? options.scale.y : options.scale.x,
        };
      }
    } else {
      this.tilemapScale = { x: 1, y: 1 };
    }

    console.log(
      `PIXI WORKER: Parsing Tiled JSON... (Base scale: ${this.tilemapScale.x}x${this.tilemapScale.y})`
    );
    this.parseTiledJSON(this.currentTilemap, data, options);

    // Set z-index and add to stage
    this.currentTilemap.zIndex = PixiRenderer.Z_INDICES.BACKGROUND;
    this.pixiApp.stage.addChild(this.currentTilemap);

    // Apply initial scale immediately
    this.currentTilemap.scale.set(
      this.cameraData
        ? this.cameraData[0] * this.tilemapScale.x
        : this.tilemapScale.x,
      this.cameraData
        ? this.cameraData[0] * this.tilemapScale.y
        : this.tilemapScale.y
    );

    // Debug: Check tilemap children and bounds
    console.log(
      `PIXI WORKER: CompositeTilemap has ${this.currentTilemap.children.length} child tilemaps`
    );
    if (this.currentTilemap.children.length > 0) {
      const child = this.currentTilemap.children[0];
      console.log(
        `PIXI WORKER: First child tilemap has ${child.pointsBuf ? child.pointsBuf.length : 0
        } point buffer entries`
      );
    }

    console.log(
      `PIXI WORKER: Tilemap background set to "${tilemapId}" and added to stage`
    );
  }

  /**
   * Parse Tiled JSON format and populate tilemap with tiles
   * Supports: orthogonal tilemaps, multiple layers, tile rotation
   */
  parseTiledJSON(tilemap, tiledData, options = {}) {
    const tileWidth = tiledData.tilewidth;
    const tileHeight = tiledData.tileheight;
    const mapWidth = tiledData.width;
    const mapHeight = tiledData.height;

    // Get tileset info (assumes single tileset for now)
    const tileset = tiledData.tilesets && tiledData.tilesets[0];
    if (!tileset) {
      console.error("PIXI WORKER: No tileset found in Tiled JSON");
      return;
    }

    const tilesetColumns = tileset.columns || 1;
    const firstGid = tileset.firstgid || 1;

    // Filter layers to render (if specified in options)
    const layersToRender = options.layers || null;

    // Process each layer
    for (const layer of tiledData.layers) {
      // Skip non-tilelayer types (objectgroup, imagelayer, etc)
      if (layer.type !== "tilelayer") continue;

      // Skip if layers filter is specified and this layer is not in it
      if (layersToRender && !layersToRender.includes(layer.name)) continue;

      // Skip invisible layers
      if (layer.visible === false) continue;

      const layerData = layer.data;
      if (!layerData || layerData.length === 0) continue;

      console.log(
        `PIXI WORKER: Processing layer "${layer.name}" with ${layerData.length
        } tiles (expected ${mapWidth * mapHeight})`
      );

      let tilesAdded = 0;

      // Iterate through each tile in the layer
      for (let y = 0; y < mapHeight; y++) {
        for (let x = 0; x < mapWidth; x++) {
          const tileIndex = y * mapWidth + x;
          let gid = layerData[tileIndex];

          // 0 = empty tile
          if (gid === 0) continue;

          // Handle tile flipping flags (highest 3 bits)
          const FLIPPED_HORIZONTALLY_FLAG = 0x80000000;
          const FLIPPED_VERTICALLY_FLAG = 0x40000000;
          const FLIPPED_DIAGONALLY_FLAG = 0x20000000;

          const flippedH = (gid & FLIPPED_HORIZONTALLY_FLAG) !== 0;
          const flippedV = (gid & FLIPPED_VERTICALLY_FLAG) !== 0;
          const flippedD = (gid & FLIPPED_DIAGONALLY_FLAG) !== 0;

          // Clear flags to get actual tile ID
          gid =
            gid &
            ~(
              FLIPPED_HORIZONTALLY_FLAG |
              FLIPPED_VERTICALLY_FLAG |
              FLIPPED_DIAGONALLY_FLAG
            );

          // Convert GID to local tile index (0-based)
          const tileId = gid - firstGid;
          if (tileId < 0) continue;

          // Calculate tile position in world coordinates
          const worldX = x * tileWidth;
          const worldY = y * tileHeight;

          // Calculate tile UV coordinates in tileset
          const tileCol = tileId % tilesetColumns;
          const tileRow = Math.floor(tileId / tilesetColumns);
          const u = tileCol * tileWidth;
          const v = tileRow * tileHeight;

          // Calculate rotation based on flip flags
          let rotation = 0;
          if (flippedD) {
            rotation = flippedH ? 6 : 4; // Diagonal flip
          } else if (flippedH && flippedV) {
            rotation = 4; // 180 degrees
          } else if (flippedH) {
            rotation = 6; // Horizontal flip
          } else if (flippedV) {
            rotation = 2; // Vertical flip
          }

          // Add tile to tilemap
          tilemap.tile(0, worldX, worldY, {
            u: u,
            v: v,
            tileWidth: tileWidth,
            tileHeight: tileHeight,
            rotate: rotation,
            alpha: layer.opacity !== undefined ? layer.opacity : 1,
          });
          tilesAdded++;
        }
      }

      console.log(
        `PIXI WORKER: Layer "${layer.name
        }" - added ${tilesAdded} tiles, last tile at (${(mapWidth - 1) * tileWidth
        }, ${(mapHeight - 1) * tileHeight})`
      );
    }

    // Calculate total tilemap dimensions in world pixels
    const totalWidth = mapWidth * tileWidth;
    const totalHeight = mapHeight * tileHeight;

    console.log(
      `PIXI WORKER: Parsed Tiled JSON - ${mapWidth}x${mapHeight} tiles (${tileWidth}x${tileHeight}px) = ${totalWidth}x${totalHeight}px total`
    );
  }

  /**
   * Initialize the PIXI renderer with provided data
   */
  async initialize(data) {
    // console.log("PIXI WORKER: Initializing with component system", data);

    // Initialize stats buffer for writing metrics
    if (data.buffers.rendererStats) {
      this.stats = createStatsWriter(
        data.buffers.rendererStats,
        RENDERER_STATS
      );
      console.log("PIXI WORKER: Stats buffer initialized");
    }

    // Store viewport and world dimensions from config
    this.worldWidth = data.config.worldWidth;
    this.worldHeight = data.config.worldHeight;
    this.canvasWidth = data.config.canvasWidth;
    this.canvasHeight = data.config.canvasHeight;
    this.canvasView = data.view;

    // Create ParticleContainer with dynamic properties for sprites
    // PixiJS 8 ParticleContainer API
    this.particleContainer = new PIXI.ParticleContainer({
      blendMode: LAYER_DEFAULT_BLEND_MODES.ENTITIES,
      dynamicProperties: {
        vertex: true, // Must be true to allow dynamic scale changes
        position: true,
        rotation: true,
        uvs: true,
        color: true,
        alpha: true,
      },
    });

    // Read renderer-specific configuration
    const rendererConfig = this.config.renderer || {};

    // Configure noLimitFPS (AbstractWorker checks for workerType, but we use 'renderer' key)
    if (rendererConfig.noLimitFPS === true) {
      this.noLimitFPS = true;
      // console.log(`PIXI WORKER: Running in unlimited FPS mode (noLimitFPS)`);
    }

    // Configure Y-sorting (default: true)
    this.ySorting =
      rendererConfig.ySorting !== undefined ? rendererConfig.ySorting : true;
    // console.log(
    //   `PIXI WORKER: Y-sorting ${this.ySorting ? "enabled" : "disabled"}`
    // );

    // Configure interpolation (default: true)
    this.interpolation =
      rendererConfig.interpolation !== undefined
        ? rendererConfig.interpolation
        : true;
    // console.log(
    //   `PIXI WORKER: Interpolation ${this.interpolation ? "enabled" : "disabled"}`
    // );

    // Configure background texture name (default: 'bg')
    this.bgTextureName = rendererConfig.bg; //|| "bg";
    // console.log(
    //   `PIXI WORKER: Background texture set to "${this.bgTextureName}"`
    // );

    // Note: Component arrays are automatically initialized by AbstractWorker.initializeAllComponents()
    // This includes Transform, RigidBody, MouseComponent, SpriteRenderer, and all custom components

    // Note: ParticleComponent is automatically initialized by AbstractWorker.initializeCommonBuffers()
    this.maxParticles = data.maxParticles || 0;
    if (data.buffers.componentData.ParticleComponent && this.maxParticles > 0) {
      console.log(
        `PIXI WORKER: ParticleComponent initialized for ${this.maxParticles} particles`
      );
    }

    // Note: DecorationComponent is automatically initialized by AbstractWorker.initializeCommonBuffers()
    this.maxDecorations = data.maxDecorations || 0;
    if (
      data.buffers.componentData.DecorationComponent &&
      this.maxDecorations > 0
    ) {
      console.log(
        `PIXI WORKER: DecorationComponent initialized for ${this.maxDecorations} decorations`
      );
    }

    // Note: LightEmitter is automatically initialized by AbstractWorker.initializeAllComponents()
    if (data.buffers.componentData.LightEmitter) {
      console.log(
        `PIXI WORKER: LightEmitter component initialized (${this.globalEntityCount} slots)`
      );
    }

    // Deserialize spritesheet metadata for animation lookups
    if (data.spritesheetMetadata) {
      SpriteSheetRegistry.deserialize(data.spritesheetMetadata);
      // console.log(
      //   `PIXI WORKER: Loaded ${
      //     SpriteSheetRegistry.getSpritesheetNames().length
      //   } spritesheets`
      // );
    }

    // Create PIXI application (PixiJS 8 uses async init)
    try {
      this.pixiApp = new PIXI.Application();
      await this.pixiApp.init({
        width: this.canvasWidth,
        height: this.canvasHeight,
        resolution: 1,
        canvas: this.canvasView, // v8 uses 'canvas' instead of 'view'
        backgroundColor: 0x000000,
        // Performance optimizations
        powerPreference: "high-performance",
        preference: "webgl", // Force WebGL for worker compatibility
      });

      // Check if renderer was successfully created
      if (!this.pixiApp.renderer) {
        throw new Error(
          "PIXI.Application.init() succeeded but renderer is null"
        );
      }

      // Check for WebGL context
      if (
        this.pixiApp.renderer.type === PIXI.RendererType.WEBGL &&
        !this.pixiApp.renderer.gl
      ) {
        throw new Error("WebGL context initialization failed (gl is null)");
      }
    } catch (error) {
      this.reportError("PIXI Initialization Failed", error);
      return;
    }

    // Enable z-index based sorting on the stage
    this.pixiApp.stage.sortableChildren = true;

    // Hook into WebGL context for draw call monitoring and context loss
    this.setupWebGLHooks();

    this.reportLog("finished initializing pixi app");
    // Load simple textures
    this.loadTextures(data.textures);
    this.reportLog("finished loading textures");

    // Load spritesheets (synchronous now - manually parsed)
    this.loadSpritesheets(data.spritesheets, data.bigAtlasProxySheets);
    this.reportLog("finished loading spritesheets");

    // Load tilemaps (Tiled JSON + tileset textures)
    this.loadTilemaps(data.tilemaps);
    this.reportLog("finished loading tilemaps");

    // Create background (legacy - kept for backwards compatibility if bg is set in config)
    if (this.bgTextureName) {
      this.createBackground();
    }

    // ========================================
    // decal DECALS TILEMAP - Initialize
    // ========================================
    if (data.decals && data.decals.enabled) {
      this.decalsEnabled = true;
      this.decalsTileSize = data.decals.tileSize; // World units per tile
      this.decalsTilePixelSize = data.decals.tilePixelSize; // Actual texture pixels
      this.decalsResolution = data.decals.resolution; // Resolution multiplier
      this.decalsTilesX = data.decals.tilesX;
      this.decalsTilesY = data.decals.tilesY;
      this.decalsTotalTiles = data.decals.totalTiles;

      // Create typed array views over SharedArrayBuffers
      this.decalTilesRGBA = new Uint8ClampedArray(data.decals.tilesRGBA);
      this.decalTilesDirty = new Uint8Array(data.decals.tilesDirty);

      // Create decal tile container (renders between background and entities)
      this.decalTileContainer = new PIXI.Container();
      this.decalTileContainer.zIndex = PixiRenderer.Z_INDICES.DECALS;

      // Create sprites for each tile
      this.createDecalTileSprites();

      // Add decal tile container to stage
      this.pixiApp.stage.addChild(this.decalTileContainer);

      console.log(
        `PIXI WORKER: decal decals enabled - ${this.decalsTilesX}×${this.decalsTilesY} tiles (${this.decalsTileSize}px world, ${this.decalsTilePixelSize}px texture @ ${this.decalsResolution}x)`
      );
    }

    // ========================================
    // CASTED SHADOWS SYSTEM - Initialize
    // ========================================
    this.createCastedShadowsSystem(data);

    // Add particle container to the stage
    // Sprites are Y-sorted and re-added every frame for proper depth ordering
    this.particleContainer.zIndex = PixiRenderer.Z_INDICES.ENTITIES;
    this.pixiApp.stage.addChild(this.particleContainer);

    // ========================================
    // LIGHTING SYSTEM - Initialize
    // ========================================
    const lightingConfig = this.config.lighting || {};
    if (lightingConfig.enabled && data.buffers.componentData.LightEmitter) {
      this.lightingEnabled = true;
      this.lightingResolution = lightingConfig.resolution || 1.0;
      this.lightingAmbient =
        lightingConfig.lightingAmbient !== undefined
          ? lightingConfig.lightingAmbient
          : 0.05;
      this.maxLights =
        lightingConfig.maxLights !== undefined ? lightingConfig.maxLights : 128;

      // Create lighting mesh (full-screen quad with multiply blend)
      // Shadows are now sprites, not in shader
      this.createLightingSystem();

      console.log(
        `PIXI WORKER: Lighting system enabled (ambient: ${this.lightingAmbient}, maxLights: ${this.maxLights}, resolution: ${this.lightingResolution})`
      );

      // ========================================
      // LIGHT GLOW SPRITES - Initialize
      // ========================================
      // Create glow system (needs textures to be loaded first)
      console.log(
        `🔍 PIXI WORKER: Initializing light glow system (maxLights: ${this.maxLights})...`
      );
      this.lightGlowEnabled = true;
      this.createLightGlowSystem();

      if (this.lightGlowContainer) {
        // Create glow sprites pool (size = maxLights)
        this.createLightGlowSprites();

        // Add glow container to stage
        this.pixiApp.stage.addChild(this.lightGlowContainer);

        // Verify container is on stage
        const isOnStage = this.pixiApp.stage.children.includes(
          this.lightGlowContainer
        );
        console.log(
          `✅ PIXI WORKER: Light glow system enabled (${this.maxLights} sprites, container added to stage: ${isOnStage}, stage children: ${this.pixiApp.stage.children.length})`
        );
      } else {
        console.error(
          `❌ PIXI WORKER: Light glow container was NOT created! lightGlowTexture:`,
          this.lightGlowTexture
        );
      }
    }

    // Initialize debug visualization system
    if (data.buffers.debugData) {
      this.debugFlags = new Uint8Array(data.buffers.debugData);
      this.debugLayer = new PIXI.Graphics();
      this.debugLayer.zIndex = 10000; // Always on top
      this.pixiApp.stage.addChild(this.debugLayer);

      // Initialize raycast debug buffer
      if (data.buffers.raycastDebugData) {
        this.raycastDebugBuffer = new Float32Array(
          data.buffers.raycastDebugData
        );
        this.maxDebugRaycasts = data.maxDebugRaycasts || 100;
        console.log(
          `PIXI WORKER: Raycast debug buffer initialized (max ${this.maxDebugRaycasts} raycasts)`
        );
      }

      // Note: Collider component arrays are automatically initialized by
      // AbstractWorker.initializeAllComponents()
      if (data.buffers.componentData.Collider) {
        console.log(
          `PIXI WORKER: Collider component loaded for debug rendering (${this.globalEntityCount} slots)`
        );
      }

      console.log("PIXI WORKER: Debug visualization layer initialized");
    }

    // Build entity sprite configs from class definitions
    this.buildEntitySpriteConfigs(data.registeredClasses);
    // Query system is already initialized in AbstractWorker and handles light entity lookups
    this.reportLog("finished building entity sprite configs");
    // Create sprites for all entities
    this.createSprites();
    this.reportLog("finished creating sprites");
    // Create particle sprites (separate pool)
    this.createParticleSprites();
    this.reportLog("finished creating particle sprites");
    // Create decoration sprites (separate pool)
    this.createDecorationSprites();
    this.reportLog("finished creating decoration sprites");

    // ========================================
    // LAYER REFERENCES MAP - For debug UI control
    // ========================================
    this.buildLayerRefsMap();

    console.log(
      "PIXI WORKER: Initialization complete, waiting for start signal..."
    );
    console.log(
      `PIXI WORKER: Centralized particle pool ready (entities: ${this.globalEntityCount} slots, particles: ${this.maxParticles} slots, decorations: ${this.maxDecorations} slots)`
    );

    // Note: Game loop will start when "start" message is received from main thread
  }

  /**
   * Build a map of layer name -> PIXI display object for debug UI control
   * Called after all layers are initialized
   */
  buildLayerRefsMap() {
    this.layerRefs = {};

    // BACKGROUND layer
    if (this.backgroundSprite) {
      this.layerRefs.BACKGROUND = this.backgroundSprite;
    }
    if (this.currentTilemap) {
      this.layerRefs.BACKGROUND = this.currentTilemap;
    }

    // DECALS layer
    if (this.decalTileContainer) {
      this.layerRefs.DECALS = this.decalTileContainer;
    }

    // CASTED_SHADOWS layer
    if (this.shadowDisplaySprite) {
      this.layerRefs.CASTED_SHADOWS = this.shadowDisplaySprite;
    }

    // ENTITIES layer (particle container)
    if (this.particleContainer) {
      this.layerRefs.ENTITIES = this.particleContainer;
    }

    // LIGHTING layer
    if (this.lightingDisplaySprite) {
      this.layerRefs.LIGHTING = this.lightingDisplaySprite;
    } else if (this.lightingMesh) {
      this.layerRefs.LIGHTING = this.lightingMesh;
    }

    // LIGHT_GLOW layer
    if (this.lightGlowContainer) {
      this.layerRefs.LIGHT_GLOW = this.lightGlowContainer;
    }

    const layerNames = Object.keys(this.layerRefs);
    console.log(`PIXI WORKER: Layer refs map built (${layerNames.length} layers: ${layerNames.join(", ")})`);
  }

  createCastedShadowsSystem(data) {
    // ========================================
    // SHADOW SPRITES - Initialize (requires lighting)
    // ========================================
    if (data.shadows && data.shadows.enabled && data.shadows.spriteData) {
      this.shadowSpritesEnabled = true;
      this.maxShadowSprites = data.shadows.maxShadowSprites;

      // Create typed array views for shadow sprite data (uses ShadowCaster schema)
      this.shadowSpriteActive = new Uint8Array(
        data.shadows.spriteData,
        0,
        this.maxShadowSprites
      );

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
      this.shadowSpriteEntityIdx = new Int32Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 32,
        floatCount
      );
      this.shadowSpriteLightIdx = new Int32Array(
        data.shadows.spriteData,
        float32Offset + floatCount * 36,
        floatCount
      );

      // Track previous entity indices for interpolation (detect ownership changes)
      // -1 means no previous owner (first frame or was inactive)
      this._shadowPrevEntityIdx = new Int32Array(this.maxShadowSprites).fill(
        -1
      );

      // Create shadow RenderTexture system (shadows rendered separately via shadowRT)
      this.createShadowSpriteSystem();

      // IMPORTANT: Create shadow sprites immediately if shadowParticleContainer exists
      // (BigAtlas may load later or might not be used)
      if (this.shadowParticleContainer && this.shadowSprites.length === 0) {
        console.log(
          "PIXI WORKER: Creating shadow sprites immediately (no BigAtlas wait)"
        );
        this.createShadowSprites();
      }

      console.log(
        `PIXI WORKER: Shadow sprites enabled (${this.maxShadowSprites} sprites)`
      );
    }
  }
}

// Create singleton instance and setup message handler
self.pixiRenderer = new PixiRenderer(self);
