self.postMessage({
  msg: 'log',
  message: 'js loaded',
  when: Date.now(),
});

// pixi_worker.js - Rendering worker using PixiJS with AnimatedSprite support
// Reads GameObject arrays and renders sprites with animations

// Import engine dependencies

import { Transform } from '../components/Transform.js';

import { Collider } from '../components/Collider.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { ParticleComponent } from '../components/ParticleComponent.js';
import { DecorationComponent } from '../components/DecorationComponent.js';
import { DecorationPool } from '../core/DecorationPool.js';
import { SpriteSheetRegistry } from '../core/SpriteSheetRegistry.js';
import { AbstractWorker } from './AbstractWorker.js';

import { LightEmitter } from '../components/LightEmitter.js';
import { Sun } from '../core/Sun.js';

import { Z_INDICES, LAYER_DEFAULT_BLEND_MODES, RENDERER_DEFAULTS } from '../core/ConfigDefaults.js';
import { Layer } from '../core/Layer.js';
import { createViews as createRenderQueueViews } from '../core/RenderQueueLayout.js';
import { sortByY, normalizeAngleDifference, extractRGBNormalizedMut } from '../core/utils.js';

// OPTIMIZED: Pre-defined comparator function for light sorting (avoids closure allocation per frame)
function sortByDistSq(a, b) {
  return a.distSq - b.distSq;
}

const PARTICLE_PREWARM_POLICY = {
  BOOT_MAIN_FRACTION: 0.15,
  BOOT_SHADOW_FRACTION: 0.1,
  BOOT_CUSTOM_FRACTION: 0.1,
  FRAME_SAFETY_MARGIN: 32,
  MAX_PREWARM_COUNT: 12000,
};
import { RENDERER_STATS, createStatsWriter } from './workers-utils.js';

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
  // Web Worker adapter - REQUIRED for PixiJS 8 in workers
  DOMAdapter,
  WebWorkerAdapter,
} from '../lib/pixi_8.16_.min.js'

// CRITICAL: Set the WebWorkerAdapter BEFORE any PixiJS operations
// This enables OffscreenCanvas and WebGL support in web workers
DOMAdapter.set(WebWorkerAdapter);

// Import @pixi/tilemap for efficient tilemap rendering
import {
  CompositeTilemap,
  TilemapPipe,
  settings as tilemapSettings,
} from '../lib/pixi-tilemap-module.js';

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

      // Reset particle to default state (caller will set actual values)
      // Note: visible=false doesn't work in ParticleContainer - we use x:-99999,y:-99999 to hide
      particle.visible = false;
      particle.alpha = 1;
      particle.scaleX = 1;
      particle.scaleY = 1;
      particle.tint = 0xffffff;
      particle.rotation = 0;
      particle.anchorX = 0.5;
      particle.anchorY = 0.5;
      particle.x = -99999;
      particle.y = -99999;
      // CRITICAL: Always reset texture to prevent texture bleeding when slot reused for different entity
      particle.texture = this.defaultTexture || PIXI.Texture.WHITE;
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

    // Hide particle and reset state for reuse (x:-99999 used because visible=false doesn't work in ParticleContainer)
    particle.visible = false;
    particle.alpha = 1;
    particle.scaleX = 0.001;
    particle.scaleY = 0.001;
    particle.tint = 0xffffff;
    particle.x = -99999;
    particle.y = -99999;
    particle.rotation = 0;
    particle.texture = this.defaultTexture || PIXI.Texture.WHITE;

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
      if (this.framesSinceLastAcquire === 1 && this.accumulatedNewParticles > 0) {
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
    this.particleAppliedTextureId = null; // Uint16Array - Track last-applied textureId per particle (0xFFFF = none)

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

    // Per-instance spritesheet tracking
    this.currentSpritesheetIds = null; // Will be initialized in createSprites

    // ========================================
    // Y-SORTING POOL (GC optimization)
    // ========================================
    // Reusable pool of objects for Y-sorting to avoid per-frame allocations
    this._ySortPool = [];
    this._ySortPoolSize = 0;

    // ========================================
    // RENDER QUEUE SYSTEM (DOUBLE BUFFERED)
    // ========================================
    // Pre-sorted, screen-visible renderables from pre_render_worker
    // pixi_worker NEVER waits - always reads from latest ready buffer
    // pre_render_worker waits if >1 frame ahead (to avoid overwriting unread data)
    this.renderQueueEnabled = false;
    this.renderQueueMaxItems = 0;

    // Double buffer storage - views for both buffers
    this.renderQueueBuffers = [null, null];
    this.renderQueueCameraBuffers = [null, null];

    // Sync buffer for coordination: [readyFrame, consumedFrame]
    this.renderQueueSync = null;
    this.lastReadFrame = -1; // Last frame we read (to signal consumption)

    // Current read buffer reference (set each frame based on readyFrame)
    this.renderQueueCount = null;  // Int32Array[1] - current item count
    this.renderQueueX = null;      // Float32Array - interpolated X
    this.renderQueueY = null;      // Float32Array - interpolated Y
    this.renderQueueScaleX = null; // Float32Array
    this.renderQueueScaleY = null; // Float32Array
    this.renderQueueRotation = null; // Float32Array
    this.renderQueueAlpha = null;  // Float32Array
    this.renderQueueTint = null;   // Uint32Array
    this.renderQueueTextureId = null; // Uint16Array (encoded)
    this.renderQueueAnchorX = null; // Float32Array
    this.renderQueueAnchorY = null; // Float32Array
    this.renderQueueCamera = null; // Float32Array[3] -> [zoom, x, y]

    // Render queue sprite pool (separate from entity/particle pools)
    // Sprites are pooled and reused based on count diff between frames
    this._rqSprites = [];      // Array of PIXI.Particle references
    this._rqSpritePoolIndices = []; // Pool indices for release
    this._rqPrevCount = 0;     // Previous frame's renderable count

    // Custom layer rendering infrastructure (populated during initialize)
    this._customLayers = {};  // layerId -> { buffers, readRef, sprites, poolIndices, prevCount, pc, rt, displaySprite, filter }
    this._customLayerList = []; // Cached array of custom layer objects, set once during init
    this._layerRuntime = Object.create(null); // layerName -> display object
    this.layerRefs = {};

    // ========================================
    // FLAT TEXTURE LOOKUP (Zero-cost texture resolution)
    // ========================================
    // All textures flattened into single array for O(1) lookup
    // Index = globalTextureId computed by particle_worker
    this.flatTextures = [];           // PIXI.Texture[] indexed by globalTextureId
    this.animationFrameStart = [];    // Starting index in flatTextures for each animation
    this.animationFrameCount = [];    // Number of frames per animation

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
    // Configured via config.lighting: { enabled, baseAmbient }
    this.lightingEnabled = false;
    this.lightingMesh = null; // PIXI.Mesh with lighting shader
    this.lightingShader = null; // Shader instance for updating uniforms
    this.baseAmbient = 0.05; // Base ambient light level (0-1), read from config (night/minimum light)
    this.maxLights = 128; // Maximum number of lights (default: 128), read from config
    this.lightingResolution = 1.0; // Resolution multiplier for lighting (e.g. 0.5 for half res)
    this.lightingRT = null; // RenderTexture for low-res lighting
    this.lightingDisplaySprite = null; // Sprite to display the lightingRT on stage

    // ========================================
    // SUN / DIRECTIONAL LIGHT
    // ========================================
    // Sun provides global ambient light that varies with time of day
    // Reads from SharedArrayBuffer via static Sun class (initialized by AbstractWorker)
    this.sunEnabled = false;

    // Reusable pool for light sorting (GC optimization)
    this._lightPool = [];
    this._lightPoolSize = 0;

    // Pre-computed visible lights (computed once per frame, used by updateLighting shader)
    this._visibleLightsAll = [];      // All visible lights (for shader uniforms)
    this._visibleLightsAllCount = 0;

    // ========================================
    // RENDER-TEXTURE SHADOW SYSTEM (DOUBLE BUFFERED)
    // ========================================
    // Shadows are rendered to a RenderTexture from pre-sorted shadowRenderQueue
    // Built by pre_render_worker: light1_gradient, light1_shadows..., light2_gradient, etc.
    // The final texture is applied with MULTIPLY blend to darken the scene
    // Uses same sync as main render queue (swapped together)
    this.shadowSpritesEnabled = false;
    this.maxShadowRenderItems = 0;

    // Double buffer storage for shadows
    this.shadowRenderQueueBuffers = [null, null];

    // Current read buffer reference (set each frame based on readyFrame)
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

    // Shadow sprite pool (uses central PixiParticlePool)
    this._shadowSprites = [];      // Array of PIXI.Particle references
    this._shadowSpritePoolIndices = []; // Pool indices for release
    this._shadowPrevCount = 0;     // Previous frame's shadow count

    // RenderTexture-based shadow compositing
    this.shadowRT = null; // RenderTexture for shadow compositing
    this.shadowParticleContainer = null; // ParticleContainer for lights + shadows
    this.shadowDisplaySprite = null; // Sprite to display shadowRT with multiply blend
    this.shadowResolution = 1.0; // Resolution multiplier for shadow RT

    // Reusable render-state for interpolation
    this._renderCameraX = 0;
    this._renderCameraY = 0;
    this._renderZoom = 1.0;
    this._cameraInitialized = false;

    // OPTIMIZED: Preallocated RGB object to avoid allocation per light per frame
    this._rgbResult = { r: 0, g: 0, b: 0 };

    // Reusable matrices for low-res rendering
    this._shadowTransform = new PIXI.Matrix();
    this._lightingTransform = new PIXI.Matrix(); // NDC mesh doesn't really need it but good to have

  }

  /**
   * Set the current read buffer for main render queue
   * @param {number} bufferIdx - 0 or 1
   */
  _setReadBuffer(bufferIdx) {
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
  }

  /**
   * Set the current read buffer for shadow render queue
   * @param {number} bufferIdx - 0 or 1
   */
  _setShadowReadBuffer(bufferIdx) {
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
   * Hook into WebGL context to count draw calls per frame
   */
  setupWebGLHooks() {
    this.setupDrawCallMonitoring();

    const gl = this.pixiApp.renderer.gl;
    if (gl && gl.canvas) {
      gl.canvas.addEventListener(
        'webglcontextlost',
        (e) => {
          e.preventDefault();
          this.reportError(
            'WebGL Context Lost',
            new Error(
              'The GPU context was lost. This usually happens due to GPU driver crashes or excessive resource usage.'
            )
          );
        },
        false
      );

      gl.canvas.addEventListener(
        'webglcontextrestored',
        () => {
          this.reportLog('WebGL context restored');
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
      console.warn('PIXI WORKER: Could not access WebGL context for draw call monitoring');
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

    console.log('PIXI WORKER: Draw call monitoring enabled');
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
        this.visibleEntityCount + this.visibleParticleCount + this.visibleDecorationCount;

      // SPRITES_CREATED = total PIXI.Particle objects created (from centralized pool)
      this.stats[RENDERER_STATS.SPRITES_CREATED] = this.particlePool.createdCount;

      // VISIBLE_SPRITES = sprites currently visible on screen
      this.stats[RENDERER_STATS.VISIBLE_SPRITES] = totalVisibleSprites;

      // Keep decoration stats for DebugUI (reuse same values)
      this.stats[RENDERER_STATS.DECORATION_SPRITES] = this.particlePool.createdCount;
      this.stats[RENDERER_STATS.VISIBLE_DECORATIONS] = this.visibleDecorationCount;

      // NEW: Separate counts for entities and particles
      this.stats[RENDERER_STATS.VISIBLE_ENTITIES] = this.visibleEntityCount;
      this.stats[RENDERER_STATS.VISIBLE_PARTICLES] = this.visibleParticleCount;

      // Active decorations count (derived from free list)
      this.stats[RENDERER_STATS.ACTIVE_DECORATIONS] = DecorationPool.getActiveCount();
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
      this.currentTilemap.scale.set(zoom * this.tilemapScale.x, zoom * this.tilemapScale.y);
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

    // Apply camera to custom layer ParticleContainers (non-shader layers only;
    // shader layers render to RT in screen space so no container transform needed)
    for (let i = 0; i < this._customLayerList.length; i++) {
      const cl = this._customLayerList[i];
      if (!cl.rt) {
        cl.pc.scale.set(zoom);
        cl.pc.x = -cameraX * zoom;
        cl.pc.y = -cameraY * zoom;
      }
    }
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
      console.warn(`Invalid spritesheetId ${newSpritesheetId} for entity ${entityId}`);
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
      const oldSheetName = SpriteSheetRegistry.getSpritesheetName(oldSpritesheetId);
      if (oldSheetName) {
        animName = SpriteSheetRegistry.getAnimationName(oldSheetName, currentAnimState);
      }
    }

    // BUGFIX: If oldSpritesheetId is 0 (first time setting sprite), try to get animation name from NEW sheet
    // This respects the animationState that was set by logic worker's setSprite()
    if (!animName) {
      animName = SpriteSheetRegistry.getAnimationName(sheetName, currentAnimState);
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

        const currentFrame = this.currentFrameIndex[i];
        const isLastFrame = currentFrame >= frames.length - 1;
        const shouldLoop = SpriteRenderer.loop[i] === 1;

        // Only advance if looping OR not at last frame
        if (shouldLoop || !isLastFrame) {
          this.currentFrameIndex[i] = (currentFrame + 1) % frames.length;
          // Update sprite texture
          bodySprite.texture = frames[this.currentFrameIndex[i]];
        }
        // If non-looping and at last frame, stay there (do nothing)
      }
    }
  }

  // ========================================
  // RENDER QUEUE UPDATE (Optimized Path)
  // ========================================
  /**
   * Update sprites from the pre-sorted render queue
   * This bypasses all visibility checks and sorting - particle_worker already did it
   * Sprite pool is resized based on count diff from previous frame
   */
  updateSpritesFromRenderQueue() {
    if (!this.renderQueueEnabled) return;

    const count = this.renderQueueCount[0];
    const prevCount = this._rqPrevCount;

    // Resize sprite pool based on count diff
    if (count > prevCount) {
      // Need more sprites - acquire the difference
      for (let i = prevCount; i < count; i++) {
        const { particle, index } = this.particlePool.acquire();
        this._rqSprites[i] = particle;
        this._rqSpritePoolIndices[i] = index;
      }
    } else if (count < prevCount) {
      // Need fewer sprites - release the extras
      for (let i = count; i < prevCount; i++) {
        if (this._rqSpritePoolIndices[i] !== -1) {
          this.particlePool.release(this._rqSpritePoolIndices[i]);
          this._rqSprites[i] = null;
          this._rqSpritePoolIndices[i] = -1;
        }
      }
    }
    this._rqPrevCount = count;

    if (count === 0) {
      // Clear the particle container (O(1) array truncation)
      this.particleContainer.particleChildren.length = 0;
      return;
    }

    // Cache render queue arrays
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

    // Get flat texture array for O(1) lookup
    const flatTextures = this.flatTextures;

    // Build particle container children in Y-sorted order
    // Clear and re-add for proper depth ordering
    // Use direct array manipulation (O(1)) instead of removeParticles() which is expensive
    this.particleContainer.particleChildren.length = 0;

    let visibleCount = 0;

    // Apply render queue properties to sprites (zero-branching on type!)
    // CRITICAL: Set texture FIRST before position - prevents "texture bleeding" when pool slots
    // are reused (e.g. civilian showing grass texture for one frame). visible=false doesn't work
    // in ParticleContainer, so we rely on correct texture+position assignment order.
    const fallbackTexture = this.particlePool.defaultTexture || (flatTextures.length > 0 ? flatTextures[0] : PIXI.Texture.WHITE);
    for (let i = 0; i < count; i++) {
      const sprite = this._rqSprites[i];
      if (!sprite) continue;

      // Resolve texture FIRST - always set to prevent stale texture from previous pool reuse
      const texId = rqTextureId[i];
      sprite.texture = (texId < flatTextures.length && texId >= 0) ? flatTextures[texId] : fallbackTexture;

      // Apply transform properties
      sprite.x = rqX[i];
      sprite.y = rqY[i];
      sprite.scaleX = rqScaleX[i];
      sprite.scaleY = rqScaleY[i];
      sprite.rotation = rqRotation[i];
      sprite.alpha = rqAlpha[i];
      sprite.tint = rqTint[i];
      sprite.anchorX = rqAnchorX[i];
      sprite.anchorY = rqAnchorY[i];

      // Add to container (already Y-sorted by particle_worker!)
      this.particleContainer.addParticle(sprite);
      visibleCount++;
    }

    // Update particle container
    // this.particleContainer.update();

    this.visibleEntityCount = visibleCount;
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   */
  update(deltaTime, dtRatio, resuming) {
    // ========================================
    // DOUBLE BUFFER SYNC: Select read buffer
    // ========================================
    // pixi_worker NEVER waits - always reads the latest available frame
    // If pre_render hasn't written anything new, we just re-render the same buffer
    // pre_render writes to (renderQueueFrame % 2) BEFORE incrementing, then stores sync[0]=renderQueueFrame
    // So when sync[0]=N, the data is in buffer (N-1)%2, not N%2
    if (this.renderQueueSync) {
      const readyFrame = Atomics.load(this.renderQueueSync, 0);

      // Only switch buffers if a new frame is available (readyFrame>0 ensures at least one frame was written)
      if (readyFrame > this.lastReadFrame && readyFrame > 0) {
        const readBufferIdx = (readyFrame - 1) % 2;
        this._setReadBuffer(readBufferIdx);

        // Shadow queue uses same buffer index (swapped together)
        if (this.shadowSpritesEnabled) {
          this._setShadowReadBuffer(readBufferIdx);
        }

        // Custom layer queues also swap with the same frame
        for (let i = 0; i < this._customLayerList.length; i++) {
          this._customLayerList[i].readRef = this._customLayerList[i].buffers[readBufferIdx];
        }

        // Signal that we've consumed this frame
        // This allows pre_render_worker to reuse this buffer
        this.lastReadFrame = readyFrame;
        Atomics.store(this.renderQueueSync, 1, readyFrame);
        // Wake pre_render_worker if it was waiting (it might be if >1 frame ahead)
        Atomics.notify(this.renderQueueSync, 1, 1);

        // Frame-locked camera: consume camera snapshot from the same renderQueue generation.
        if (this.renderQueueCamera) {
          this._renderZoom = this.renderQueueCamera[0];
          this._renderCameraX = this.renderQueueCamera[1];
          this._renderCameraY = this.renderQueueCamera[2];
          this._cameraInitialized = true;
        }
      }
    }

    // Camera is always provided by the pre-render worker via renderQueueCamera.
    // Fall back to live SAB only during the very first frames before init completes.
    if (!this._cameraInitialized && this.cameraData) {
      this._renderZoom = this.cameraData[0];
      this._renderCameraX = this.cameraData[1];
      this._renderCameraY = this.cameraData[2];
      this._cameraInitialized = true;
    }

    this.updateCameraTransform();

    // Update decal decal tiles (check for dirty tiles from particle_worker)
    this.updateDecalTiles();

    // Pre-compute visible lights once (shared by updateLighting, updateShadowSprites)
    this.computeVisibleLights();

    // Grow the central pool before any queue update loops acquire particles.
    this.prewarmParticlePoolForFrameDemand();

    // Update lighting shader uniforms from LightEmitter components
    this.updateLighting();

    // Update shadow RenderTexture with interleaved lights + shadows
    // This renders lights and shadows to shadowRT, which is displayed via shadowDisplaySprite (multiply blend)
    this.updateShadowSprites();

    // Use render queue from pre_render_worker - no fallback
    this.updateSpritesFromRenderQueue();

    // Update custom layer sprites and render shader layers to their RenderTextures
    this.updateCustomLayers();

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
    const tilePixelSize = this.decalsTilePixelSize;

    // Create a single shared OffscreenCanvas for synchronous bitmap generation
    // Reused for all tiles - transferToImageBitmap is sync and zero-copy
    this._decalTileCanvas = new OffscreenCanvas(tilePixelSize, tilePixelSize);
    this._decalTileCtx = this._decalTileCanvas.getContext('2d', { willReadFrequently: true });

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

    console.log(`PIXI WORKER: Created ${this.decalsTotalTiles} decal tile sprites`);
  }

  /**
   * Update decal tile textures for any dirty tiles
   * Called each frame to check for tiles modified by particle_worker
   * Uses synchronous transferToImageBitmap for zero-allocation texture updates
   * Optimized to reuse buffers, ImageData, and textures to reduce GC pressure
   */
  updateDecalTiles() {
    if (!this.decalsEnabled) return;

    // Use pixel size for buffer operations (not world tile size)
    const tilePixelSize = this.decalsTilePixelSize;
    const bytesPerTile = tilePixelSize * tilePixelSize * 4;
    const ctx = this._decalTileCtx;

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

      // Reuse pre-allocated buffer and ImageData if available
      let tileRGBA = this._decalCopyBuffers?.[tileIndex];
      let imageData = this._decalImageDatas?.[tileIndex];

      if (!tileRGBA) {
        // Lazy init on first use - allocate once per tile, reuse forever
        this._decalCopyBuffers ??= [];
        this._decalImageDatas ??= [];
        tileRGBA = new Uint8ClampedArray(bytesPerTile);
        imageData = new ImageData(tileRGBA, tilePixelSize, tilePixelSize);
        this._decalCopyBuffers[tileIndex] = tileRGBA;
        this._decalImageDatas[tileIndex] = imageData;
      }

      // Copy data into reusable buffer
      tileRGBA.set(tileRGBAShared);

      // Synchronous bitmap creation via OffscreenCanvas - no promises, no closures
      // putImageData + transferToImageBitmap is sync and zero-copy
      ctx.putImageData(imageData, 0, 0);
      const bitmap = this._decalTileCanvas.transferToImageBitmap();

      const sprite = this.decalTileSprites[tileIndex];

      // Close old bitmap to release GPU memory immediately (avoid GC delay)
      const oldBitmap = sprite.texture?.source?.resource;
      if (oldBitmap?.close) oldBitmap.close();

      // Reuse existing texture source instead of creating new ones
      if (sprite.texture !== PIXI.Texture.EMPTY && sprite.texture.source) {
        sprite.texture.source.resource = bitmap;
        sprite.texture.source.update();
      } else {
        const source = new PIXI.ImageSource({ resource: bitmap });
        sprite.texture = new PIXI.Texture({ source });
      }
      sprite.visible = true; // Show the tile now that it has content
    }
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
          uCameraPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uZoom: { value: 1.0, type: 'f32' },
          uViewport: {
            value: new Float32Array([
              this.canvasWidth * this.lightingResolution,
              this.canvasHeight * this.lightingResolution,
            ]),
            type: 'vec2<f32>',
          },
          uFullCanvasSize: {
            value: new Float32Array([this.canvasWidth, this.canvasHeight]),
            type: 'vec2<f32>',
          },
          uInvResolution: { value: 1.0 / this.lightingResolution, type: 'f32' },

          uLightX: { value: this._lightX, type: 'f32', size: maxLights },
          uLightY: { value: this._lightY, type: 'f32', size: maxLights },
          uLightIntensity: {
            value: this._lightIntensity,
            type: 'f32',
            size: maxLights,
          },
          uLightR: { value: this._lightR, type: 'f32', size: maxLights },
          uLightG: { value: this._lightG, type: 'f32', size: maxLights },
          uLightB: { value: this._lightB, type: 'f32', size: maxLights },
          uLightCount: { value: 0, type: 'i32' },
          uBaseAmbient: { value: this.baseAmbient, type: 'f32' },
          // Sun uniforms
          uSunIntensity: { value: 0, type: 'f32' },
          uSunR: { value: 1.0, type: 'f32' },
          uSunG: { value: 1.0, type: 'f32' },
          uSunB: { value: 1.0, type: 'f32' },
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
      this._registerLayerDisplayObject('LIGHTING', this.lightingDisplaySprite);
      this.pixiApp.stage.addChild(this.lightingDisplaySprite);

      console.log(
        `PIXI WORKER: Lighting RenderTexture created (${this.lightingRT.width}x${this.lightingRT.height})`
      );
    } else {
      this._registerLayerDisplayObject('LIGHTING', this.lightingMesh);
      this.pixiApp.stage.addChild(this.lightingMesh);
    }
  }

  buildFragmentShaderBasic() {
    return `
    precision highp float;

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
    uniform float uBaseAmbient;
    // Sun uniforms
    uniform float uSunIntensity;
    uniform float uSunR;
    uniform float uSunG;
    uniform float uSunB;

    void main() {
      // Use normalized coordinates (0 to 1) to avoid resolution-scaling ambiguity.
      vec2 normCoord = gl_FragCoord.xy / uViewport;

      // Map normalized coordinates back to full-screen pixels.
      // When rendering to RenderTexture, PixiJS 8 may have already flipped Y coordinates.
      // We test without the Y-flip first to see if that fixes the coordinate issue.
      vec2 screenPos = normCoord * uFullCanvasSize;

      vec2 fragWorld = (screenPos / uZoom) + uCameraPos;

      // Start with base ambient (night/minimum light)
      vec3 totalLight = vec3(uBaseAmbient);

      // Add sun contribution (global directional light)
      // Sun color is applied uniformly across the scene
      vec3 sunColor = vec3(uSunR, uSunG, uSunB);
      totalLight += sunColor * uSunIntensity;

      // Add point light contributions
      // Point lights are suppressed when sun is bright (handled by intensity modulation)
      for (int i = 0; i < ${this.maxLights}; i++) {
        if (i >= uLightCount) break;

        vec2 lightWorld = vec2(uLightX[i], uLightY[i]);
        float intensity = uLightIntensity[i];
        vec3 color = vec3(uLightR[i], uLightG[i], uLightB[i]);

        // Keep attenuation math numerically stable on mobile fragment shaders.
        // Many mobile GPUs run mediump in fragment stage (even when highp is requested),
        // and d*d can overflow at common world distances, causing hard light cutoffs.
        // Scale both intensity and distance by the same factor so the equation remains
        // visually equivalent while staying in a safe numeric range:
        //   I/(I + d²) == (I*k²)/((I*k²) + (d*k)²)
        const float DISTANCE_SCALE = 1.0 / 1024.0;
        vec2 deltaScaled = (fragWorld - lightWorld) * DISTANCE_SCALE;
        float d2Scaled = dot(deltaScaled, deltaScaled);
        float intensityScaled = intensity * DISTANCE_SCALE * DISTANCE_SCALE;
        // Formula: intensity / (intensity + d²) → caps at 1.0 when d=0, falls off with distance.
        float attenuation = intensityScaled / (intensityScaled + d2Scaled);

        totalLight += color * attenuation;
      }

      totalLight = min(totalLight, vec3(1.0));
      gl_FragColor = vec4(totalLight, 1.0);
    }
    `;
  }

  /* =====================
COMPUTE VISIBLE LIGHTS (used by updateLighting shader)
===================== */

  /**
   * Pre-compute visible lights once per frame.
   * updateLighting() uses this data for shader uniforms.
   * Avoids duplicate queryActiveEntities, culling, and sorting.
   */
  computeVisibleLights() {
    // Early return if lighting is disabled (LightEmitter arrays not initialized)
    if (!LightEmitter.active) return;

    const worldX = Transform.x;
    const worldY = Transform.y;
    const lightEnabled = LightEmitter.active;
    const lightHeight = LightEmitter.height;
    const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;

    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;

    // Calculate viewport bounds for culling
    const viewWidth = this.canvasWidth / zoom;
    const viewHeight = this.canvasHeight / zoom;
    const viewRight = cameraX + viewWidth;
    const viewBottom = cameraY + viewHeight;

    // Viewport center for sorting by distance
    const viewCenterX = cameraX + viewWidth / 2;
    const viewCenterY = cameraY + viewHeight / 2;

    // Use pre_render's visible lights buffer when available (avoids duplicate queryActiveEntities)
    const useSharedBuffer = !!this.visibleLightsData;
    const lightCount = useSharedBuffer ? this.visibleLightsData[0] : 0;
    const lightEntities = useSharedBuffer ? null : this.queryActiveEntities([LightEmitter]);

    // Reset pool
    this._visibleLightsAllCount = 0;

    const iterCount = useSharedBuffer ? lightCount : lightEntities.length;
    for (let idx = 0; idx < iterCount; idx++) {
      const i = useSharedBuffer ? this.visibleLightsData[1 + idx] : lightEntities[idx];
      if (!lightEnabled[i]) continue;

      // Use sprite position if available (already interpolated)
      const sprite = this.bodySprites[i];
      const x = sprite ? sprite.x : worldX[i];
      const yForLight = (sprite ? sprite.y : worldY[i]) - (lightHeight[i] || 0);

      // Viewport culling: influenceRadius = 10 * sqrt(intensity)
      const influenceRadius = 10 * sqrtLightIntensity[i];

      if (
        x + influenceRadius < cameraX ||
        x - influenceRadius > viewRight ||
        yForLight + influenceRadius < cameraY ||
        yForLight - influenceRadius > viewBottom
      ) {
        continue;
      }

      // Distance squared to camera center (for prioritization)
      const dx = x - viewCenterX;
      const dy = yForLight - viewCenterY;
      const distSq = dx * dx + dy * dy;

      // Add to "all lights" pool (for shader uniforms)
      const allIdx = this._visibleLightsAllCount++;
      if (!this._visibleLightsAll[allIdx]) {
        this._visibleLightsAll[allIdx] = { entityId: 0, distSq: 0 };
      }
      this._visibleLightsAll[allIdx].entityId = i;
      this._visibleLightsAll[allIdx].distSq = distSq;
    }

    // Sort by distance (closest first), truncate to active size
    this._visibleLightsAll.length = this._visibleLightsAllCount;
    this._visibleLightsAll.sort(sortByDistSq);
  }

  /* =====================
UPDATE LIGHTING (NO ZOOM SCALING)
===================== */

  updateLighting() {
    if (!this.lightingEnabled || !this.lightingShader) return;

    const uniformGroup = this.lightingShader.resources.uniforms;

    // Cache component arrays
    const worldX = Transform.x;
    const worldY = Transform.y;
    const lightColor = LightEmitter.lightColor;
    const lightIntensity = LightEmitter.lightIntensity;
    const lightHeight = LightEmitter.height;

    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;

    // Update camera uniforms (vec2 types)
    uniformGroup.uniforms.uCameraPos[0] = cameraX;
    uniformGroup.uniforms.uCameraPos[1] = cameraY;
    uniformGroup.uniforms.uZoom = zoom;

    // Update viewport uniform every frame (handles resizes and resolution changes)
    uniformGroup.uniforms.uViewport[0] = this.canvasWidth * this.lightingResolution;
    uniformGroup.uniforms.uViewport[1] = this.canvasHeight * this.lightingResolution;

    uniformGroup.uniforms.uFullCanvasSize[0] = this.canvasWidth;
    uniformGroup.uniforms.uFullCanvasSize[1] = this.canvasHeight;

    // Use pre-allocated Float32Arrays for light data
    const lightX = this._lightX;
    const lightY = this._lightY;
    const lightIntensityArr = this._lightIntensity;
    const lightR = this._lightR;
    const lightG = this._lightG;
    const lightB = this._lightB;

    // Use pre-computed visible lights (computed in computeVisibleLights())
    const visibleLights = this._visibleLightsAll;
    const countToRender = Math.min(this._visibleLightsAllCount, this.maxLights);

    // OPTIMIZED: Reuse preallocated RGB object to avoid allocation per light
    const rgb = this._rgbResult;

    for (let i = 0; i < countToRender; i++) {
      const entityIndex = visibleLights[i].entityId;
      const color = lightColor[entityIndex];

      // Always use world coordinates for lights (shader converts screen to world)
      // sprite.x/y are in container space (already transformed), so we use worldX/worldY
      // Apply height offset to position light above the entity
      lightX[i] = worldX[entityIndex];
      lightY[i] = worldY[entityIndex] - (lightHeight[entityIndex] || 0);
      lightIntensityArr[i] = lightIntensity[entityIndex]; // NO ZOOM SCALING

      extractRGBNormalizedMut(color, rgb);
      lightR[i] = rgb.r;
      lightG[i] = rgb.g;
      lightB[i] = rgb.b;
    }

    // Update light count uniform
    uniformGroup.uniforms.uLightCount = countToRender;

    // ========================================
    // SUN UNIFORMS
    // ========================================
    // Sun provides global ambient light that varies with time of day
    if (Sun.isInitialized && Sun.enabled) {
      const sunIntensity = Sun.intensity;
      const sunColor = Sun.color;

      uniformGroup.uniforms.uSunIntensity = sunIntensity;

      // Extract sun color RGB
      extractRGBNormalizedMut(sunColor, rgb);
      uniformGroup.uniforms.uSunR = rgb.r;
      uniformGroup.uniforms.uSunG = rgb.g;
      uniformGroup.uniforms.uSunB = rgb.b;
    } else {
      // Sun disabled - no sun contribution
      uniformGroup.uniforms.uSunIntensity = 0;
    }
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
      blendMode: 'normal',
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
    this._registerLayerDisplayObject('CASTED_SHADOWS', this.shadowDisplaySprite);

    // Add to stage
    this.pixiApp.stage.addChild(this.shadowDisplaySprite);

    console.log(
      `PIXI WORKER: Shadow RenderTexture system initialized (${this.maxShadowRenderItems} max items, ${this.shadowRT.width}x${this.shadowRT.height} RT)`
    );
  }

  /**
   * Update shadow sprites from pre-sorted shadowRenderQueue
   * Queue is built by particle_worker: light1_gradient, light1_shadows..., light2_gradient, etc.
   * Rendering happens in SCREEN SPACE (shadowRT coordinates)
   */
  updateShadowSprites() {
    if (!this.shadowSpritesEnabled || !this.shadowRenderQueueCount) return;
    if (!this.shadowParticleContainer || !this.shadowRT) return;

    const count = this.shadowRenderQueueCount[0];
    const prevCount = this._shadowPrevCount;

    // Resize sprite pool based on count diff (same pattern as main renderQueue)
    if (count > prevCount) {
      // Need more sprites - acquire from central pool
      for (let i = prevCount; i < count; i++) {
        const { particle, index } = this.particlePool.acquire();
        this._shadowSprites[i] = particle;
        this._shadowSpritePoolIndices[i] = index;
      }
    } else if (count < prevCount) {
      // Need fewer sprites - release extras back to pool
      for (let i = count; i < prevCount; i++) {
        if (this._shadowSpritePoolIndices[i] !== -1) {
          this.particlePool.release(this._shadowSpritePoolIndices[i]);
          this._shadowSprites[i] = null;
          this._shadowSpritePoolIndices[i] = -1;
        }
      }
    }
    this._shadowPrevCount = count;

    if (count === 0) {
      // Clear the particle container
      this.shadowParticleContainer.particleChildren.length = 0;
      this.pixiApp.renderer.render({
        container: this.shadowParticleContainer,
        target: this.shadowRT,
        clear: true,
      });
      return;
    }

    // Cache render queue arrays
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

    // Get flat texture array for O(1) lookup
    const flatTextures = this.flatTextures;

    // Camera transform for world-to-screen conversion
    const zoom = this._renderZoom;
    const cameraX = this._renderCameraX;
    const cameraY = this._renderCameraY;
    const resolution = this.shadowResolution;

    // Clear particle container and rebuild
    this.shadowParticleContainer.particleChildren.length = 0;

    // Apply render queue properties to sprites (pre-sorted by particle_worker!)
    // CRITICAL: Set texture FIRST to prevent texture bleeding when pool slots are reused
    const fallbackTexture = this.particlePool.defaultTexture || (flatTextures.length > 0 ? flatTextures[0] : PIXI.Texture.WHITE);
    for (let i = 0; i < count; i++) {
      const sprite = this._shadowSprites[i];
      if (!sprite) continue;

      // Resolve texture FIRST - always set to prevent stale texture from previous pool reuse
      const texId = rqTextureId[i];
      sprite.texture = (texId < flatTextures.length && texId >= 0) ? flatTextures[texId] : fallbackTexture;

      // Convert world coordinates to screen space (shadowRT coordinates)
      sprite.x = (rqX[i] - cameraX) * zoom * resolution;
      sprite.y = (rqY[i] - cameraY) * zoom * resolution;
      sprite.scaleX = rqScaleX[i] * zoom * resolution;
      sprite.scaleY = rqScaleY[i] * zoom * resolution;
      sprite.rotation = rqRotation[i];
      sprite.alpha = rqAlpha[i];
      sprite.tint = rqTint[i];
      sprite.anchorX = rqAnchorX[i];
      sprite.anchorY = rqAnchorY[i];

      // Add to container (already ordered by particle_worker!)
      this.shadowParticleContainer.addParticle(sprite);
    }

    // Render to shadowRT
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
      if (!registration.components?.includes('SpriteRenderer')) continue;

      const entityType = registration.entityType;
      if (entityType === undefined || typeof entityType !== 'number') continue;

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
        // BigAtlas/canvas content uses premultiplied alpha - required for 'normal' blend mode
        const source = new PIXI.ImageSource({
          resource: data.imageBitmap,
          // alphaMode: "premultiply-alpha-on-upload",
        });
        const jsonData = data.json;

        // Manually create textures for each frame
        const frameTextures = {};
        for (const [frameName, frameData] of Object.entries(jsonData.frames)) {
          const frame = frameData.frame;
          const sourceSize = frameData.sourceSize;
          const spriteSourceSize = frameData.spriteSourceSize;

          // Build texture options
          const textureOptions = {
            source,
            frame: new PIXI.Rectangle(frame.x, frame.y, frame.w, frame.h),
          };

          // If frame is trimmed, add orig and trim for proper anchor handling
          // PixiJS uses these to offset the sprite so anchors work relative to original size
          if (sourceSize && spriteSourceSize &&
            (sourceSize.w !== frame.w || sourceSize.h !== frame.h)) {
            textureOptions.orig = new PIXI.Rectangle(0, 0, sourceSize.w, sourceSize.h);
            textureOptions.trim = new PIXI.Rectangle(
              spriteSourceSize.x, spriteSourceSize.y,
              spriteSourceSize.w, spriteSourceSize.h
            );
          }

          const texture = new PIXI.Texture(textureOptions);
          frameTextures[frameName] = texture;
        }

        // Manually build animation arrays
        const animations = {};
        if (jsonData.animations) {
          for (const [animName, frameNames] of Object.entries(jsonData.animations)) {
            animations[animName] = frameNames.map((frameName) => frameTextures[frameName]);
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
        if (name === 'bigAtlas') {
          for (const [frameName, texture] of Object.entries(frameTextures)) {
            this.textures[frameName] = texture;
          }

          // Initialize particle pool with default texture (_white square)
          // Using _white ensures particles without explicit textures show a neutral default
          // rather than whatever happens to be first in the atlas (which depends on packing order)
          if (frameTextures['_white']) {
            this.particlePool.setDefaultTexture(frameTextures['_white']);
          } else {
            const textureKeys = Object.keys(frameTextures);
            if (textureKeys.length > 0) {
              this.particlePool.setDefaultTexture(frameTextures[textureKeys[0]]);
            }
          }

          console.log(
            `✅ BigAtlas loaded: ${Object.keys(frameTextures).length} frames available as textures`
          );

          // DEBUG: Check if _lightGradient texture is available
          if (this.textures['_lightGradient']) {
            console.log(`✅ PIXI WORKER: _lightGradient texture found in BigAtlas textures`);
          } else {
            console.warn(`⚠️ PIXI WORKER: _lightGradient texture NOT found in BigAtlas textures`);
            console.log(`   Available texture keys (first 20):`, textureKeys.slice(0, 20));
            console.log(
              `   Looking for textures with "light" or "gradient" in name:`,
              textureKeys.filter(
                (k) => k.toLowerCase().includes('light') || k.toLowerCase().includes('gradient')
              )
            );
          }

          // Note: Shadow sprites are now acquired from central PixiParticlePool on demand
          // (in updateShadowSprites based on shadowRenderQueue count)

          // ========================================
          // BUILD FLAT TEXTURE LOOKUP ARRAY
          // ========================================
          // Flatten all animation frames into single array for O(1) lookup
          // particle_worker computes: globalTextureId = animationFrameStart[animIdx] + frameIdx
          // pixi_worker does: sprite.texture = flatTextures[globalTextureId]
          this.flatTextures = [];
          this.animationFrameStart = [];
          this.animationFrameCount = [];

          // Get animation names in consistent order (same as SpriteSheetRegistry)
          const animNames = Object.keys(animations);
          for (let animIdx = 0; animIdx < animNames.length; animIdx++) {
            const animName = animNames[animIdx];
            const frames = animations[animName];

            this.animationFrameStart[animIdx] = this.flatTextures.length;
            this.animationFrameCount[animIdx] = frames.length;

            for (let f = 0; f < frames.length; f++) {
              this.flatTextures.push(frames[f]);
            }
          }

          console.log(`✅ Built flat texture array: ${this.flatTextures.length} textures, ${animNames.length} animations`);
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
      console.log(`🔗 Creating ${Object.keys(proxySheets).length} proxy spritesheets...`);

      const bigAtlas = this.spritesheets.bigAtlas;
      if (!bigAtlas) {
        console.error('❌ Cannot create proxy sheets: bigAtlas not loaded!');
        return;
      }

      for (const [proxyName, proxyData] of Object.entries(proxySheets)) {
        const prefix = proxyData.prefix;

        // Extract animations from bigAtlas that match this proxy's prefix
        const proxyAnimations = {};
        const proxyTextures = {};

        for (const [animName, animInfo] of Object.entries(proxyData.animations)) {
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
          targetSheet: 'bigAtlas',
        };

        // Also register in SpriteSheetRegistry (for animation lookups)
        SpriteSheetRegistry.registerProxy(proxyName, proxyData);

        console.log(`  ✅ Proxy "${proxyName}": ${Object.keys(proxyAnimations).length} animations`);
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

    console.log(`PIXI WORKER: Loading ${Object.keys(tilemapsData).length} tilemaps...`);

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
    this.particleSpritePoolIndices = new Uint16Array(this.maxParticles).fill(0xFFFF);
    this.particleAppliedTextureId = new Uint16Array(this.maxParticles).fill(0xFFFF); // 0xFFFF = no texture applied
    this.particleSpriteCount = 0; // Number of sprites currently allocated for particles

    console.log(
      `PIXI WORKER: Particle system initialized (${this.maxParticles} slots, using central particle pool)`
    );
  }

  /**
   * Create decoration sprites (separate from entity sprites)
   * OPTIMIZATION: Uses lazy creation - sprites are acquired from central pool when needed
   */
  createDecorationSprites() {
    if (this.maxDecorations === 0) return;

    // Initialize arrays for decoration tracking
    this.decorationSprites = new Array(this.maxDecorations).fill(null);
    this.decorationSpritePoolIndices = new Uint16Array(this.maxDecorations).fill(0xFFFF);
    this.decorationSpriteTextureIds = new Uint16Array(this.maxDecorations);
    this.decorationSpriteCount = 0; // Track allocated sprites for cleanup

    console.log(
      `PIXI WORKER: Decoration system initialized (${this.maxDecorations} slots, using central particle pool)`
    );
  }

  /**
   * Initialize entity sprite tracking arrays
   * OPTIMIZATION: Sprites are now acquired lazily from central pool when entities spawn
   * This saves memory for unused entity slots
   */
  createSprites() {
    // Initialize sprite tracking arrays
    this.bodySprites = new Array(this.globalEntityCount).fill(null);
    this.bodySpritePoolIndices = new Uint16Array(this.globalEntityCount).fill(0xFFFF);
    this.currentSpritesheetIds = new Uint8Array(this.globalEntityCount);

    // Initialize animation tracking typed arrays
    this.previousAnimStates = new Int16Array(this.globalEntityCount).fill(-1);
    this.currentFrameIndex = new Uint16Array(this.globalEntityCount);
    this.frameAccumulator = new Float32Array(this.globalEntityCount);
    this.animationSpeed = new Float32Array(this.globalEntityCount);
    this.currentAnimationFrames = new Array(this.globalEntityCount).fill(null).map(() => []);

    console.log(
      `PIXI WORKER: Entity sprite system initialized (${this.globalEntityCount} slots, using central particle pool)`
    );
  }

  /**
   * Handle custom messages
   */
  handleCustomMessage(data) {
    const { msg } = data;
    console.log(`PIXI WORKER: handleCustomMessage called with msg: ${msg}`);

    if (msg === 'setBackground') {
      this.handleSetBackground(data);
    } else if (msg === 'setLayerProps') {
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
    const { layer, visible, alpha, blendMode, containerBlendMode, zIndex } = data;

    const displayObject = this.layerRefs?.[layer];
    if (!displayObject) {
      return;
    }

    if (visible !== undefined) {
      displayObject.visible = visible;
    }

    if (alpha !== undefined) {
      displayObject.alpha = Math.max(0, Math.min(1, alpha));
    }

    if (blendMode !== undefined) {
      displayObject.blendMode = blendMode;
    }

    if (containerBlendMode !== undefined) {
      const layerObj = Layer.get(layer);
      if (layerObj) {
        const cl = this._customLayers[layerObj.id];
        if (cl?.pc) {
          cl.pc.blendMode = containerBlendMode;
        }
      }
    }

    if (zIndex !== undefined) {
      displayObject.zIndex = zIndex;
      this.pixiApp.stage.sortChildren();
    }
  }

  _applyLayerPresentation(layerName, displayObject) {
    if (!displayObject) return;
    const layer = Layer.get(layerName);
    if (!layer) return;
    displayObject.zIndex = layer.zIndex;
    const useContainerBlend = displayObject instanceof PIXI.ParticleContainer;
    displayObject.blendMode = useContainerBlend ? layer.containerBlendMode : layer.blendMode;
  }

  _registerLayerDisplayObject(layerName, displayObject) {
    if (!layerName || !displayObject) return;
    this._applyLayerPresentation(layerName, displayObject);
    this._layerRuntime[layerName] = displayObject;
  }

  _syncLayerRefsFromRuntime() {
    const refs = {};
    const allLayers = Layer.getAll();
    for (let i = 0; i < allLayers.length; i++) {
      const layer = allLayers[i];
      if (!layer) continue;
      const runtimeObj = this._layerRuntime[layer.name];
      if (runtimeObj) refs[layer.name] = runtimeObj;
    }
    this.layerRefs = refs;
  }

  _recreateCustomLayerRTs(cl, width, height) {
    if (!cl || !cl.rt) return;
    const resolution = cl.resolution || 1.0;
    const lw = width * resolution;
    const lh = height * resolution;

    cl.rt.destroy(true);
    cl.rt = PIXI.RenderTexture.create({ width: lw, height: lh });

    if (cl.shader) {
      cl.shader.resources.uTexture = cl.rt.source;
    }

    if (cl.rtOut) {
      cl.rtOut.destroy(true);
      cl.rtOut = PIXI.RenderTexture.create({ width: lw, height: lh });
    }

    if (cl.displaySprite) {
      cl.displaySprite.texture = cl.rtOut || cl.rt;
      cl.displaySprite.scale.set(1.0 / resolution);
    }
  }

  prewarmParticlePoolAtBoot() {
    let target = 0;
    target += (this.renderQueueMaxItems * PARTICLE_PREWARM_POLICY.BOOT_MAIN_FRACTION) | 0;
    if (this.shadowSpritesEnabled) {
      target += (this.maxShadowRenderItems * PARTICLE_PREWARM_POLICY.BOOT_SHADOW_FRACTION) | 0;
    }
    for (let i = 0; i < this._customLayerList.length; i++) {
      target += (this._customLayerList[i].maxItems * PARTICLE_PREWARM_POLICY.BOOT_CUSTOM_FRACTION) | 0;
    }
    if (target > PARTICLE_PREWARM_POLICY.MAX_PREWARM_COUNT) {
      target = PARTICLE_PREWARM_POLICY.MAX_PREWARM_COUNT;
    }

    const missing = target - this.particlePool.freeIndices.length;
    if (missing > 0) {
      this.particlePool.preallocate(missing);
    }
  }

  prewarmParticlePoolForFrameDemand() {
    let needed = 0;
    if (this.renderQueueCount) {
      const mainCount = this.renderQueueCount[0];
      if (mainCount > this._rqPrevCount) needed += (mainCount - this._rqPrevCount);
    }
    if (this.shadowRenderQueueCount) {
      const shadowCount = this.shadowRenderQueueCount[0];
      if (shadowCount > this._shadowPrevCount) needed += (shadowCount - this._shadowPrevCount);
    }
    for (let i = 0; i < this._customLayerList.length; i++) {
      const cl = this._customLayerList[i];
      const ref = cl.readRef;
      if (!ref) continue;
      const count = ref.count[0];
      if (count > cl.prevCount) needed += (count - cl.prevCount);
    }

    if (needed <= 0) return;
    needed += PARTICLE_PREWARM_POLICY.FRAME_SAFETY_MARGIN;
    const missing = needed - this.particlePool.freeIndices.length;
    if (missing > 0) {
      this.particlePool.preallocate(missing);
    }
  }

  /**
   * PixiJS-specific resize: resize renderer and render textures.
   * Base class (AbstractWorker) already updates canvasWidth/Height, config, and Camera.
   */
  onResize(width, height) {
    // Let PixiJS resize the renderer first (updates viewport, projection, and canvas)
    if (this.pixiApp) {
      this.pixiApp.renderer.resize(width, height);
    }

    // Fallback: ensure the OffscreenCanvas pixel buffer actually matches.
    // Do this AFTER renderer.resize() so we don't confuse PixiJS's internal size tracking.
    if (this.canvasView) {
      if (this.canvasView.width !== width) this.canvasView.width = width;
      if (this.canvasView.height !== height) this.canvasView.height = height;
    }

    // Recreate lighting RenderTexture at the new size.
    // RT.resize() in PixiJS 8 can fail to update the GPU framebuffer;
    // destroy + create guarantees a fresh texture at the correct dimensions.
    if (this.lightingRT) {
      const lw = width * this.lightingResolution;
      const lh = height * this.lightingResolution;
      this.lightingRT.destroy(true);
      this.lightingRT = PIXI.RenderTexture.create({ width: lw, height: lh });
      if (this.lightingDisplaySprite) {
        this.lightingDisplaySprite.texture = this.lightingRT;
        this.lightingDisplaySprite.scale.set(1.0 / this.lightingResolution);
      }
    }

    // Sync lighting shader uniforms immediately
    if (this.lightingShader) {
      const u = this.lightingShader.resources.uniforms.uniforms;
      u.uViewport[0] = width * this.lightingResolution;
      u.uViewport[1] = height * this.lightingResolution;
      u.uFullCanvasSize[0] = width;
      u.uFullCanvasSize[1] = height;
    }

    // Recreate shadow RenderTexture at the new size
    if (this.shadowRT) {
      const sw = width * this.shadowResolution;
      const sh = height * this.shadowResolution;
      this.shadowRT.destroy(true);
      this.shadowRT = PIXI.RenderTexture.create({ width: sw, height: sh });
      if (this.shadowDisplaySprite) {
        this.shadowDisplaySprite.texture = this.shadowRT;
        this.shadowDisplaySprite.scale.set(1.0 / this.shadowResolution);
      }
    }

    // Recreate custom layer RenderTextures at new size
    for (let i = 0; i < this._customLayerList.length; i++) {
      const cl = this._customLayerList[i];
      if (cl.rt) {
        this._recreateCustomLayerRTs(cl, width, height);
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
      case 'static':
        this.createStaticBackground(textureId);
        break;
      case 'tiling':
        this.createTilingBackground(textureId, tileScale);
        break;
      case 'tilemap':
        this.createTilemapBackground(tilemapId, options);
        break;
      case 'none':
        // No background
        console.log(`PIXI WORKER: No background`);
        break;
      default:
        console.warn(`PIXI WORKER: Unknown background type: ${type}`);
    }

    // Update layer refs after background change
    this._updateBackgroundLayerRef();

    // Warm-up render: force GPU to compile shaders and upload geometry/textures now,
    // rather than causing a frame spike on the first visible frame.
    if (this.pixiApp && this.pixiApp.renderer) {
      this.pixiApp.renderer.render(this.pixiApp.stage);
      console.log(`PIXI WORKER: Warm-up render completed (GPU shaders/geometry uploaded)`);
    }

    self.postMessage({ msg: 'backgroundReady' });
  }

  /**
   * Update the BACKGROUND layer reference after background changes
   */
  _updateBackgroundLayerRef() {
    if (this.currentTilemap) {
      this._registerLayerDisplayObject('BACKGROUND', this.currentTilemap);
    } else if (this.backgroundSprite) {
      this._registerLayerDisplayObject('BACKGROUND', this.backgroundSprite);
    } else {
      delete this._layerRuntime.BACKGROUND;
    }
    this._syncLayerRefsFromRuntime();
  }

  /**
   * Create a static background (simple Sprite, does not tile)
   */
  createStaticBackground(textureId) {
    const texture = this.textures[textureId];
    if (!texture) {
      console.warn(`PIXI WORKER: Texture "${textureId}" not found for static background`);
      return;
    }

    this.backgroundSprite = new PIXI.Sprite(texture);
    this.backgroundSprite.width = this.worldWidth;
    this.backgroundSprite.height = this.worldHeight;
    this._registerLayerDisplayObject('BACKGROUND', this.backgroundSprite);
    this.pixiApp.stage.addChild(this.backgroundSprite);

    console.log(`PIXI WORKER: Static background set to "${textureId}"`);
  }

  /**
   * Create a tiling background (TilingSprite - repeats pattern)
   */
  createTilingBackground(textureId, tileScale = 1) {
    const texture = this.textures[textureId];
    if (!texture) {
      console.warn(`PIXI WORKER: Texture "${textureId}" not found for tiling background`);
      return;
    }

    this.backgroundSprite = new PIXI.TilingSprite({
      texture: texture,
      width: this.worldWidth,
      height: this.worldHeight,
    });
    this.backgroundSprite.tileScale.set(tileScale, tileScale);
    this.backgroundSprite.tilePosition.set(0, 0);
    this._registerLayerDisplayObject('BACKGROUND', this.backgroundSprite);
    this.pixiApp.stage.addChild(this.backgroundSprite);

    console.log(`PIXI WORKER: Tiling background set to "${textureId}" (scale: ${tileScale})`);
  }

  /**
   * Create a tilemap background using @pixi/tilemap (Tiled editor format)
   * Parses Tiled JSON and renders tiles with automatic culling
   */
  createTilemapBackground(tilemapId, options = {}) {
    console.log(`PIXI WORKER: createTilemapBackground called with "${tilemapId}"`);
    console.log(`PIXI WORKER: Available tilemaps:`, Object.keys(this.tilemaps));

    const tilemapData = this.tilemaps[tilemapId];
    if (!tilemapData) {
      console.warn(`PIXI WORKER: Tilemap "${tilemapId}" not found in loaded tilemaps`);
      return;
    }

    const { data, tilesetTexture } = tilemapData;
    console.log(`PIXI WORKER: Tilemap data:`, data);
    console.log(`PIXI WORKER: Tileset texture:`, tilesetTexture);

    // Create CompositeTilemap instance with tileset texture
    // NOTE: CompositeTilemap.tileset() expects an ARRAY of textures, not a single texture!
    console.log(`PIXI WORKER: Creating CompositeTilemap instance...`);
    this.currentTilemap = new CompositeTilemap([tilesetTexture]);
    console.log(`PIXI WORKER: CompositeTilemap instance created:`, this.currentTilemap);

    // Parse scale option
    if (options.scale !== undefined) {
      if (typeof options.scale === 'number') {
        this.tilemapScale = { x: options.scale, y: options.scale };
      } else if (typeof options.scale === 'object' && options.scale.x !== undefined) {
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
    this._registerLayerDisplayObject('BACKGROUND', this.currentTilemap);
    this.pixiApp.stage.addChild(this.currentTilemap);

    // Apply initial scale immediately
    this.currentTilemap.scale.set(
      this.cameraData ? this.cameraData[0] * this.tilemapScale.x : this.tilemapScale.x,
      this.cameraData ? this.cameraData[0] * this.tilemapScale.y : this.tilemapScale.y
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

    console.log(`PIXI WORKER: Tilemap background set to "${tilemapId}" and added to stage`);
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
      console.error('PIXI WORKER: No tileset found in Tiled JSON');
      return;
    }

    const tilesetColumns = tileset.columns || 1;
    const firstGid = tileset.firstgid || 1;

    // Filter layers to render (if specified in options)
    const layersToRender = options.layers || null;

    // Process each layer
    let layerIndex = 0;
    for (const layer of tiledData.layers) {
      layerIndex++;

      // Skip non-tilelayer types (objectgroup, imagelayer, etc)
      if (layer.type !== 'tilelayer') {
        continue;
      }

      // Skip if layers filter is specified and this layer is not in it
      if (layersToRender && !layersToRender.includes(layer.name)) {
        continue;
      }

      // Skip invisible layers
      if (layer.visible === false) {
        continue;
      }

      const layerData = layer.data;
      if (!layerData || layerData.length === 0) {
        continue;
      }

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
            gid & ~(FLIPPED_HORIZONTALLY_FLAG | FLIPPED_VERTICALLY_FLAG | FLIPPED_DIAGONALLY_FLAG);

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
          // Tiled uses: H = horizontal flip, V = vertical flip, D = diagonal (90° base)
          // PIXI groupD8 rotation values:
          // 0 = none, 2 = 90° CW, 4 = 180°, 6 = 90° CCW (270° CW)
          // 8 = vertical flip, 10 = 90° CW + V flip, 12 = horizontal flip, 14 = 90° CCW + H flip
          let rotation = 0;
          if (flippedD) {
            if (flippedH && flippedV) {
              rotation = 2; // D + H + V = 90° clockwise
            } else if (flippedH) {
              rotation = 6; // D + H = 90° counter-clockwise (270° CW)
            } else if (flippedV) {
              rotation = 2; // D + V = 90° clockwise
            } else {
              rotation = 6; // D only = 90° counter-clockwise
            }
          } else if (flippedH && flippedV) {
            rotation = 4; // H + V = 180 degrees
          } else if (flippedH) {
            rotation = 12; // Horizontal flip (mirror)
          } else if (flippedV) {
            rotation = 8; // Vertical flip (mirror)
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
        }" - added ${tilesAdded} non-empty tiles out of ${layerData.length} total tiles`
      );
    }

    // Calculate total tilemap dimensions in world pixels
    const totalWidth = mapWidth * tileWidth;
    const totalHeight = mapHeight * tileHeight;

    // Log buffer stats for debugging
    if (tilemap.children && tilemap.children[0]) {
      const child = tilemap.children[0];
      const pointsBufLength = child.pointsBuf ? child.pointsBuf.length : 0;
      const tilesInBuffer = pointsBufLength / 14; // 14 values per tile
      console.log(
        `PIXI WORKER: Total tiles in buffer: ${tilesInBuffer} (pointsBuf length: ${pointsBufLength})`
      );
    }

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
      this.stats = createStatsWriter(data.buffers.rendererStats, RENDERER_STATS);
      console.log('PIXI WORKER: Stats buffer initialized');
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
      blendMode: Layer.get('ENTITIES')?.blendMode || LAYER_DEFAULT_BLEND_MODES.ENTITIES,
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
    this.ySorting = rendererConfig.ySorting !== undefined ? rendererConfig.ySorting : true;
    // console.log(
    //   `PIXI WORKER: Y-sorting ${this.ySorting ? "enabled" : "disabled"}`
    // );

    // Configure interpolation (default: true)
    this.interpolation =
      rendererConfig.interpolation !== undefined ? rendererConfig.interpolation : true;
    // console.log(
    //   `PIXI WORKER: Interpolation ${this.interpolation ? "enabled" : "disabled"}`
    // );

    // Configure decoration zoom culling thresholds
    this.decorationFadeStartZoom =
      rendererConfig.startFadingDecorationsAtZoom !== undefined
        ? rendererConfig.startFadingDecorationsAtZoom
        : RENDERER_DEFAULTS.startFadingDecorationsAtZoom;
    this.decorationHideZoom =
      rendererConfig.hideDecorationsAtZoom !== undefined
        ? rendererConfig.hideDecorationsAtZoom
        : RENDERER_DEFAULTS.hideDecorationsAtZoom;

    // Note: Component arrays are automatically initialized by AbstractWorker.initializeAllComponents()
    // This includes Transform, RigidBody, SpriteRenderer, and all custom components

    // Note: ParticleComponent is automatically initialized by AbstractWorker.initializeCommonBuffers()
    this.maxParticles = data.maxParticles || 0;
    if (data.buffers.componentData.ParticleComponent && this.maxParticles > 0) {
      console.log(`PIXI WORKER: ParticleComponent initialized for ${this.maxParticles} particles`);
    }

    // Initialize particle free list for early-exit optimization
    // freeListTop tells us how many slots are free, so activeCount = maxParticles - freeListTop[0]
    this.particleFreeListTop = data.particleFreeListTop
      ? new Int32Array(data.particleFreeListTop)
      : null;

    // Note: DecorationComponent is automatically initialized by AbstractWorker.initializeCommonBuffers()
    this.maxDecorations = data.maxDecorations || 0;
    if (data.buffers.componentData.DecorationComponent && this.maxDecorations > 0) {
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
        powerPreference: 'high-performance',
        preference: 'webgl', // Force WebGL for worker compatibility
      });

      // Check if renderer was successfully created
      if (!this.pixiApp.renderer) {
        throw new Error('PIXI.Application.init() succeeded but renderer is null');
      }

      // Check for WebGL context
      if (this.pixiApp.renderer.type === PIXI.RendererType.WEBGL && !this.pixiApp.renderer.gl) {
        throw new Error('WebGL context initialization failed (gl is null)');
      }
    } catch (error) {
      this.reportError('PIXI Initialization Failed', error);
      return;
    }

    // Enable z-index based sorting on the stage
    this.pixiApp.stage.sortableChildren = true;

    // Hook into WebGL context for draw call monitoring and context loss
    this.setupWebGLHooks();

    this.reportLog('finished initializing pixi app');
    // Load simple textures
    this.loadTextures(data.textures);
    this.reportLog('finished loading textures');

    // Load spritesheets (synchronous now - manually parsed)
    this.loadSpritesheets(data.spritesheets, data.bigAtlasProxySheets);
    this.reportLog('finished loading spritesheets');

    // Load tilemaps (Tiled JSON + tileset textures)
    this.loadTilemaps(data.tilemaps);
    this.reportLog('finished loading tilemaps');

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
      this._registerLayerDisplayObject('DECALS', this.decalTileContainer);

      // Create sprites for each tile
      this.createDecalTileSprites();

      // Add decal tile container to stage
      this.pixiApp.stage.addChild(this.decalTileContainer);

      console.log(
        `PIXI WORKER: decal decals enabled - ${this.decalsTilesX}×${this.decalsTilesY} tiles (${this.decalsTileSize}px world, ${this.decalsTilePixelSize}px texture @ ${this.decalsResolution}x)`
      );
    }

    // ========================================
    // RENDER QUEUE SYSTEM - Initialize (DOUBLE BUFFERED)
    // ========================================
    if (data.renderQueue && data.renderQueue.dataA && data.renderQueue.dataB) {
      console.log('PIXI WORKER: Initializing double-buffered render queue system...');
      this.renderQueueEnabled = true;
      this.renderQueueMaxItems = data.renderQueue.maxItems;

      // Initialize sync buffer
      this.renderQueueSync = new Int32Array(data.renderQueue.sync);
      this.lastReadFrame = -1;

      const maxItems = this.renderQueueMaxItems;

      // Create typed array views for BOTH buffers
      const bufferSABs = [data.renderQueue.dataA, data.renderQueue.dataB];
      const cameraSABs = [data.renderQueue.cameraA || null, data.renderQueue.cameraB || null];

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

        buffer.type = new Uint8Array(sab, offset, maxItems);
        offset += maxItems;

        offset = Math.ceil(offset / 4) * 4;

        buffer.entityIndex = new Int32Array(sab, offset, maxItems);

        this.renderQueueBuffers[bufIdx] = buffer;
        this.renderQueueCameraBuffers[bufIdx] = cameraSABs[bufIdx]
          ? new Float32Array(cameraSABs[bufIdx], 0, 3)
          : null;
      }

      // Set initial read buffer (frame 0 uses buffer 0)
      this._setReadBuffer(0);

      // Entity texture lookup buffer (separate SAB)
      // Maps entityIndex -> last computed globalTextureId for shadow system
      if (data.renderQueue.entityTextureData) {
        this.entityLastTextureId = new Uint16Array(data.renderQueue.entityTextureData);
      }

      // Pre-allocate sprite arrays
      this._rqSprites = new Array(maxItems).fill(null);
      this._rqSpritePoolIndices = new Array(maxItems).fill(-1);
      this._rqPrevCount = 0;

      console.log(`PIXI WORKER: Double-buffered render queue initialized (max ${maxItems} items)`);
    } else {
      console.log('PIXI WORKER: Render queue NOT enabled');
    }

    // ========================================
    // CASTED SHADOWS SYSTEM - Initialize
    // ========================================
    this.createCastedShadowsSystem(data);

    // Add particle container to the stage
    // Sprites are Y-sorted and re-added every frame for proper depth ordering
    this._registerLayerDisplayObject('ENTITIES', this.particleContainer);
    this.pixiApp.stage.addChild(this.particleContainer);

    // ========================================
    // LIGHTING SYSTEM - Initialize
    // ========================================
    const lightingConfig = this.config.lighting || {};
    if (lightingConfig.enabled && data.buffers.componentData.LightEmitter) {
      this.lightingEnabled = true;
      this.visibleLightsData = data.buffers.visibleLightsData
        ? new Uint16Array(data.buffers.visibleLightsData)
        : null;
      this.lightingResolution = lightingConfig.resolution || 1.0;
      // baseAmbient is the night/minimum light level (when sun is down)
      this.baseAmbient = lightingConfig.baseAmbient !== undefined ? lightingConfig.baseAmbient : 0.05;
      this.maxLights = lightingConfig.maxLights !== undefined ? lightingConfig.maxLights : 128;

      // Create lighting mesh (full-screen quad with multiply blend)
      // Shadows are now sprites, not in shader
      this.createLightingSystem();

      console.log(
        `PIXI WORKER: Lighting system enabled (baseAmbient: ${this.baseAmbient}, maxLights: ${this.maxLights}, resolution: ${this.lightingResolution})`
      );

    }

    // ========================================
    // SUN SYSTEM - Initialize
    // ========================================
    // Note: Sun static class is initialized by AbstractWorker.initializeCommonBuffers()
    if (Sun.isInitialized) {
      this.sunEnabled = Sun.enabled;
      console.log(`PIXI WORKER: Sun system initialized (enabled: ${this.sunEnabled})`);
    }

    // Note: Debug visualization is now handled by DebugUI on main thread
    // This removes ~400 lines of debug rendering code from pixi_worker

    // Build entity sprite configs from class definitions
    this.buildEntitySpriteConfigs(data.registeredClasses);
    // Query system is already initialized in AbstractWorker and handles light entity lookups
    this.reportLog('finished building entity sprite configs');
    // Create sprites for all entities
    this.createSprites();
    this.reportLog('finished creating sprites');
    // Create particle sprites (separate pool)
    this.createParticleSprites();
    this.reportLog('finished creating particle sprites');
    // Create decoration sprites (separate pool)
    this.createDecorationSprites();
    this.reportLog('finished creating decoration sprites');

    // ========================================
    // CUSTOM LAYER RENDERING INFRASTRUCTURE
    // ========================================
    this.initializeCustomLayers(data);
    this.prewarmParticlePoolAtBoot();

    // ========================================
    // LAYER REFERENCES MAP - For debug UI control
    // ========================================
    this.buildLayerRefsMap();

    console.log('PIXI WORKER: Initialization complete, waiting for start signal...');
    console.log(
      `PIXI WORKER: Centralized particle pool ready (entities: ${this.globalEntityCount} slots, particles: ${this.maxParticles} slots, decorations: ${this.maxDecorations} slots)`
    );

    // Note: Game loop will start when "start" message is received from main thread
  }

  // ========================================
  // CUSTOM LAYER SYSTEM
  // ========================================

  /**
   * Standard fullscreen quad vertex shader for post-processing meshes.
   * Maps NDC quad to UV space so the fragment shader can sample a RenderTexture.
   */
  static FULLSCREEN_VERTEX = `
    attribute vec2 aPosition;
    attribute vec2 aUV;
    varying vec2 vTextureCoord;
    void main() {
      vTextureCoord = aUV;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;

  /**
   * Initialize custom layer rendering infrastructure.
   *
   * NON-SHADER LAYERS:
   *   ParticleContainer added directly to stage at the layer's zIndex.
   *   Camera transform applied via container.scale / container.position.
   *
   * SHADER LAYERS (two-RT pipeline):
   *   1. ParticleContainer rendered (additive blend) → raw density RenderTexture (RT)
   *   2. Fullscreen Mesh with custom fragment shader reads density RT → output RT
   *   3. Output RT displayed on stage via Sprite at the layer's zIndex
   *   This enables screen-space effects (metaballs, heat distortion, etc.)
   *   driven by entity positions without per-entity shader overhead.
   *
   * Uniforms are shared via Layer SABs with Atomics dirty flags -- any thread
   * can call Layer.get('water').setUniform('uThreshold', 0.4) and the change
   * is picked up next frame with zero postMessage overhead.
   */
  initializeCustomLayers(data) {
    if (!data.customLayerRenderQueues || !data.layerData) return;

    const metadata = data.layerData.metadata;
    if (!metadata?.layers) return;

    const layerMetas = metadata.layers;
    for (let mi = 0; mi < layerMetas.length; mi++) {
      const config = layerMetas[mi];
      if (!config || config.builtIn || !config.hasRenderQueue || config.id === metadata.entitiesId) continue;
      const layerId = config.id;
      const layerName = config.name;
      const lrq = data.customLayerRenderQueues[layerId];
      if (!lrq) continue;

      const layerObj = Layer.getById(layerId);
      if (!layerObj) continue;

      const maxItems = lrq.maxItems;
      const resolution = layerObj.resolution;
      const hasShader = layerObj.hasShader;

      const buffers = [
        createRenderQueueViews(lrq.dataA, maxItems),
        createRenderQueueViews(lrq.dataB, maxItems),
      ];

      // Create ParticleContainer for this layer
      const containerBlend = layerObj.containerBlendMode;
      const pc = new PIXI.ParticleContainer({
        blendMode: containerBlend,
        dynamicProperties: {
          vertex: true,
          position: true,
          rotation: true,
          uvs: true,
          color: true,
          alpha: true,
        },
      });

      const cl = {
        layerId,
        layerName,
        maxItems,
        baseResolution: resolution,
        resolution,
        buffers,
        readRef: buffers[0],
        sprites: new Array(maxItems).fill(null),
        poolIndices: new Array(maxItems).fill(-1),
        prevCount: 0,
        pc,
        rt: null,          // Raw density RT (additive blend output)
        rtOut: null,        // Post-processed RT (after threshold shader)
        shaderMesh: null,   // Fullscreen quad Mesh with custom shader
        shader: null,       // Shader instance for uniform updates
        displaySprite: null,
        uniformEntries: config.uniformMap ? Object.entries(config.uniformMap) : null,
        uniformStore: null,
      };

      if (hasShader && config.shaderFragment) {
        const w = this.canvasWidth * resolution;
        const h = this.canvasHeight * resolution;

        // Two RTs: raw (density accumulation via additive PC) and processed (after shader)
        cl.rt = PIXI.RenderTexture.create({ width: w, height: h });
        cl.rtOut = PIXI.RenderTexture.create({ width: w, height: h });

        // Build fullscreen quad geometry (NDC -1..1 mapped to UV 0..1)
        const geometry = new Geometry({
          attributes: {
            aPosition: { buffer: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), format: 'float32x2' },
            aUV: { buffer: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), format: 'float32x2' },
          },
          indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
        });

        // Build uniform resources from the layer's SAB initial values
        const uniformDefs = {};
        if (config.uniformMap) {
          for (const [uName, entry] of Object.entries(config.uniformMap)) {
            const uType = config.uniformTypes?.[uName] || 'f32';
            const floats = Layer._uniformFloats[layerId];
            if (entry.size === 1) {
              uniformDefs[uName] = { value: floats[entry.offset], type: uType };
            } else {
              const arr = new Float32Array(entry.size);
              for (let k = 0; k < entry.size; k++) arr[k] = floats[entry.offset + k];
              uniformDefs[uName] = { value: arr, type: uType };
            }
          }
        }

        try {
          cl.shader = new Shader({
            glProgram: GlProgram.from({
              vertex: PixiRenderer.FULLSCREEN_VERTEX,
              fragment: config.shaderFragment,
            }),
            resources: {
              uTexture: cl.rt.source,
              customUniforms: uniformDefs,
            },
          });
          cl.uniformStore = cl.shader.resources?.customUniforms?.uniforms || null;

          cl.shaderMesh = new Mesh({ geometry, shader: cl.shader });
        } catch (err) {
          console.error(`PIXI WORKER: Failed to compile shader for layer "${layerName}":`, err);
        }

        // Display sprite shows the post-processed RT on the main stage
        cl.displaySprite = new PIXI.Sprite(cl.rtOut);
        cl.displaySprite.anchor.set(0, 0);
        cl.displaySprite.position.set(0, 0);
        cl.displaySprite.scale.set(1.0 / resolution);
        this._registerLayerDisplayObject(layerName, cl.displaySprite);

        this.pixiApp.stage.addChild(cl.displaySprite);
        console.log(`PIXI WORKER: Custom shader layer "${layerName}" initialized (resolution=${resolution}, RT=${w}x${h})`);
      } else {
        // Non-shader layer: PC goes directly on stage
        this._registerLayerDisplayObject(layerName, pc);
        this.pixiApp.stage.addChild(pc);
        console.log(`PIXI WORKER: Custom layer "${layerName}" initialized (no shader)`);
      }

      this._customLayers[layerId] = cl;
    }

    // Cache the list once -- layers never change at runtime
    this._customLayerList = Object.values(this._customLayers);

    if (this._customLayerList.length > 0) {
      this.pixiApp.stage.sortChildren();
    }
    this._syncLayerRefsFromRuntime();
  }

  /**
   * Update all custom layer sprites from their render queues and render shader
   * layers through the two-RT pipeline (density → threshold → display).
   */
  updateCustomLayers() {
    const flatTextures = this.flatTextures;
    const fallbackTexture = this.particlePool.defaultTexture || (flatTextures.length > 0 ? flatTextures[0] : PIXI.Texture.WHITE);

    for (let li = 0; li < this._customLayerList.length; li++) {
      const cl = this._customLayerList[li];
      const ref = cl.readRef;
      if (!ref) continue;

      const count = ref.count[0];
      const prevCount = cl.prevCount;

      // Resize sprite pool
      if (count > prevCount) {
        for (let i = prevCount; i < count; i++) {
          const { particle, index } = this.particlePool.acquire();
          cl.sprites[i] = particle;
          cl.poolIndices[i] = index;
        }
      } else if (count < prevCount) {
        for (let i = count; i < prevCount; i++) {
          if (cl.poolIndices[i] !== -1) {
            this.particlePool.release(cl.poolIndices[i]);
            cl.sprites[i] = null;
            cl.poolIndices[i] = -1;
          }
        }
      }
      cl.prevCount = count;

      cl.pc.particleChildren.length = 0;

      if (count === 0) {
        // Clear both RTs when empty
        if (cl.rt) {
          this.pixiApp.renderer.render({ container: cl.pc, target: cl.rt, clear: true });
        }
        if (cl.rtOut && cl.shaderMesh) {
          this.pixiApp.renderer.render({ container: cl.shaderMesh, target: cl.rtOut, clear: true });
        }
        continue;
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

      const zoom = this._renderZoom;
      const cameraX = this._renderCameraX;
      const cameraY = this._renderCameraY;
      const resolution = cl.resolution || 1.0;
      const renderToRT = !!cl.rt;

      for (let i = 0; i < count; i++) {
        const sprite = cl.sprites[i];
        if (!sprite) continue;

        const texId = rqTextureId[i];
        sprite.texture = (texId < flatTextures.length && texId >= 0) ? flatTextures[texId] : fallbackTexture;

        if (renderToRT) {
          // Screen-space coordinates for RT rendering (like shadow system)
          sprite.x = (rqX[i] - cameraX) * zoom * resolution;
          sprite.y = (rqY[i] - cameraY) * zoom * resolution;
          sprite.scaleX = rqScaleX[i] * zoom * resolution;
          sprite.scaleY = rqScaleY[i] * zoom * resolution;
        } else {
          // World-space coordinates (camera applied via container transform)
          sprite.x = rqX[i];
          sprite.y = rqY[i];
          sprite.scaleX = rqScaleX[i];
          sprite.scaleY = rqScaleY[i];
        }

        sprite.rotation = rqRotation[i];
        sprite.alpha = rqAlpha[i];
        sprite.tint = rqTint[i];
        sprite.anchorX = rqAnchorX[i];
        sprite.anchorY = rqAnchorY[i];

        cl.pc.addParticle(sprite);
      }

      // Two-pass shader pipeline for shader layers:
      // 1. Render additive ParticleContainer → raw density RT
      // 2. Render fullscreen Mesh (threshold shader reads raw RT) → processed RT
      if (cl.rt && cl.shaderMesh && cl.rtOut) {
        this.pixiApp.renderer.render({ container: cl.pc, target: cl.rt, clear: true });
        this.pixiApp.renderer.render({ container: cl.shaderMesh, target: cl.rtOut, clear: true });
      } else if (!cl.rt) {
        // Non-shader layer: PC already on stage (no RT needed)
      }

      // Update shader uniforms from Layer SABs (cross-worker dirty flag)
      if (cl.shader && Layer._uniformDirty[cl.layerId]) {
        const dirtyRef = Layer._uniformDirty[cl.layerId];
        if (Atomics.load(dirtyRef, 0) === 1) {
          Atomics.store(dirtyRef, 0, 0);
          const floats = Layer._uniformFloats[cl.layerId];
          const entries = cl.uniformEntries;
          const u = cl.uniformStore;
          if (floats && entries && u) {
            for (let ei = 0; ei < entries.length; ei++) {
              const [uName, entry] = entries[ei];
              if (entry.size === 1) {
                u[uName] = floats[entry.offset];
              } else {
                const target = u[uName];
                if (target && typeof target.set === 'function') {
                  target.set(floats.subarray(entry.offset, entry.offset + entry.size));
                } else if (target && typeof target === 'object' && target.length) {
                  for (let k = 0; k < entry.size; k++) {
                    target[k] = floats[entry.offset + k];
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  /**
   * Build a map of layer name -> PIXI display object for debug UI control
   * Called after all layers are initialized
   */
  buildLayerRefsMap() {
    if (this.currentTilemap) this._registerLayerDisplayObject('BACKGROUND', this.currentTilemap);
    else if (this.backgroundSprite) this._registerLayerDisplayObject('BACKGROUND', this.backgroundSprite);
    if (this.decalTileContainer) this._registerLayerDisplayObject('DECALS', this.decalTileContainer);
    if (this.shadowDisplaySprite) this._registerLayerDisplayObject('CASTED_SHADOWS', this.shadowDisplaySprite);
    if (this.particleContainer) this._registerLayerDisplayObject('ENTITIES', this.particleContainer);
    if (this.lightingDisplaySprite) this._registerLayerDisplayObject('LIGHTING', this.lightingDisplaySprite);
    else if (this.lightingMesh) this._registerLayerDisplayObject('LIGHTING', this.lightingMesh);
    for (let i = 0; i < this._customLayerList.length; i++) {
      const cl = this._customLayerList[i];
      this._registerLayerDisplayObject(cl.layerName, cl.displaySprite || cl.pc);
    }
    this._syncLayerRefsFromRuntime();

    const layerNames = Object.keys(this.layerRefs);
    console.log(
      `PIXI WORKER: Layer refs map built (${layerNames.length} layers: ${layerNames.join(', ')})`
    );
  }

  createCastedShadowsSystem(data) {
    // ========================================
    // SHADOW RENDER QUEUE - Initialize (DOUBLE BUFFERED)
    // ========================================
    if (data.shadows && data.shadows.enabled && data.shadows.renderQueueDataA && data.shadows.renderQueueDataB) {
      this.shadowSpritesEnabled = true;
      this.maxShadowRenderItems = data.shadows.maxRenderItems;

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

      // Set initial read buffer (same as main queue)
      this._setShadowReadBuffer(0);

      // Pre-allocate sprite arrays (uses central PixiParticlePool)
      this._shadowSprites = new Array(maxItems).fill(null);
      this._shadowSpritePoolIndices = new Array(maxItems).fill(-1);
      this._shadowPrevCount = 0;

      // Create shadow RenderTexture system
      this.createShadowSpriteSystem();

      console.log(`PIXI WORKER: Double-buffered shadow render queue enabled (${maxItems} max items)`);
    }
  }
}

// Create singleton instance and setup message handler
self.pixiRenderer = new PixiRenderer(self);
