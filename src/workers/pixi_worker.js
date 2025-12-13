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
import { SpriteSheetRegistry } from "../core/SpriteSheetRegistry.js";
import { AbstractWorker } from "./AbstractWorker.js";
import { DEBUG_FLAGS } from "../core/Debug.js";
import { Mouse } from "../core/Mouse.js";
import { MouseComponent } from "../components/MouseComponent.js";
import { LightEmitter } from "../components/LightEmitter.js";

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
  // Shader/Mesh for lighting system
  Geometry,
  Mesh,
  Shader,
  GlProgram,
} from "./pixi8webworker.js";

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
  Geometry,
  Mesh,
  Shader,
  GlProgram,
};

// Make imported classes globally available for dynamic instantiation
self.GameObject = GameObject;
self.Transform = Transform;
self.RigidBody = RigidBody;
self.SpriteRenderer = SpriteRenderer;
self.MouseComponent = MouseComponent;
self.Mouse = Mouse;
self.PIXI = PIXI;

// Note: Game-specific scripts are loaded dynamically by AbstractWorker

// Single ParticleContainer with Y-sorting for depth

/**
 * PixiRenderer - Manages rendering of game objects using PixiJS in a web worker
 * Extends AbstractWorker for common worker functionality
 */
class PixiRenderer extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Use PIXI ticker instead of requestAnimationFrame
    this.usesCustomScheduler = true;

    // Renderer configuration options (set during initialize)
    this.ySorting = false; // Enable/disable Y-sorting for depth ordering
    this.bgTextureName = null; // Texture name to use for background

    // PIXI application and rendering
    this.pixiApp = null;
    // Single ParticleContainer with Y-sorting for proper depth ordering
    // Will be created during initialization with correct entityCount
    this.particleContainer = null;
    this.backgroundSprite = null;

    // Texture and spritesheet storage
    this.textures = {}; // Store simple PIXI textures by name
    this.spritesheets = {}; // Store loaded spritesheets by name

    // Entity rendering
    // this.containers = []; // Array of PIXI containers (one per entity)
    this.bodySprites = []; // Array of main body sprites (now regular Sprite, not AnimatedSprite)
    this.entitySpriteConfigs = {}; // Store sprite config per entityType
    this.previousAnimStates = []; // Track previous animation state per entity

    // Manual animation tracking (for regular Sprites)
    this.currentAnimationFrames = []; // Array of texture arrays (one per entity)
    this.currentFrameIndex = []; // Current frame index in animation
    this.frameAccumulator = []; // Time accumulator for frame advancement
    this.animationSpeed = []; // Animation speed per entity (frames per second)

    // Particle rendering (separate from entities)
    this.particleSprites = []; // Array of particle sprites (indexed 0 to maxParticles-1)
    this.maxParticles = 0; // Number of particles in pool
    this.particleTextureCache = {}; // Cache for particle textures by textureId

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

    // Debug visualization
    this.debugLayer = null; // PIXI.Graphics for debug overlays
    this.debugFlags = null; // Uint8Array view of debug flags from SharedArrayBuffer
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
  }

  /**
   * Update camera transform on particle container, background, and decal tiles
   */
  updateCameraTransform() {
    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];

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

    // Apply camera state to decal tile container
    if (this.decalTileContainer) {
      this.decalTileContainer.scale.set(zoom);
      this.decalTileContainer.x = -cameraX * zoom;
      this.decalTileContainer.y = -cameraY * zoom;
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
    // DENSE ALLOCATION: entityIndex === componentIndex for all components
    for (let i = 0; i < this.entityCount; i++) {
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
  }

  /**
   * Render collision shape for an entity
   * DENSE ALLOCATION: entityIndex === componentIndex
   */
  renderCollider(entityIndex, posX, posY) {
    if (!Collider) return;

    // DENSE: use entity index directly for component access
    const radius = Collider.radius[entityIndex];
    if (radius === 0) return; // No collider (default value)

    const isTrigger = Collider.isTrigger[entityIndex];

    // Debug: log a few mappings
    if (this.frameNumber === 60 && entityIndex >= 1 && entityIndex <= 5) {
      console.log(
        `DEBUG: Entity ${entityIndex} -> Collider radius=${radius.toFixed(
          2
        )}, pos=(${posX.toFixed(0)}, ${posY.toFixed(0)})`
      );
    }

    // Choose color based on trigger status
    const color = isTrigger
      ? this.debugColors.trigger
      : this.debugColors.collider;

    // PixiJS 8: draw shape first, then stroke
    this.debugLayer.circle(posX, posY, radius);
    this.debugLayer.stroke({
      width: 2 / this.cameraData[0],
      color,
      alpha: 0.8,
    });
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
   * Render entity index number
   */
  renderEntityIndex(entityIndex, posX, posY) {
    // Note: Text rendering in PIXI.Graphics is not optimal
    // For production, consider using a separate PIXI.Text pool
    // For now, we'll draw a simple marker and developers can use console
    // PixiJS 8: draw shape then fill
    this.debugLayer
      .circle(posX, posY, 2 / this.cameraData[0])
      .fill({ color: this.debugColors.text, alpha: 0.8 });
  }

  /**
   * Render neighbor connections (requires neighbor data from spatial worker)
   * INTERACTIVE: Only shows neighbors for the entity closest to the mouse
   */
  renderNeighborConnections() {
    if (!GameObject.neighborData) return;

    // Get mouse position from input buffer (world coordinates)
    const mouseX = Mouse.x;
    const mouseY = Mouse.y;
    const mousePresent = Mouse.isPresent;

    // If no mouse, don't render anything
    if (!mousePresent) return;

    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const maxNeighbors = this.config.spatial?.maxNeighbors || 100;

    // Mouse is always at entity index 0
    // Get the Mouse's neighbors to find the closest entity to the mouse
    const mouseOffset = 0 * (1 + maxNeighbors);
    const mouseNeighborCount = GameObject.neighborData[mouseOffset];

    // Find the entity closest to the mouse from its neighbor list
    let closestEntity = -1;
    let closestDist2 = Infinity;

    for (let n = 0; n < mouseNeighborCount; n++) {
      const neighborIndex = GameObject.neighborData[mouseOffset + 1 + n];
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

    // Highlight the selected entity with a bright ring
    // DENSE: use entity index directly for component access
    const highlightRadius = Collider.radius[closestEntity] * 1.5 || 10;
    this.debugLayer
      .circle(myX, myY, highlightRadius)
      .stroke({ width: 3 / this.cameraData[0], color: 0xffff00, alpha: 1.0 });

    const offset = closestEntity * (1 + maxNeighbors);
    const neighborCount = GameObject.neighborData[offset];

    // Draw all neighbors for this entity (no limit needed since it's just one entity)
    for (let n = 0; n < neighborCount; n++) {
      const neighborIndex = GameObject.neighborData[offset + 1 + n];
      if (!active[neighborIndex]) continue;

      const neighborX = x[neighborIndex];
      const neighborY = y[neighborIndex];

      // Draw the line connection
      this.debugLayer
        .moveTo(myX, myY)
        .lineTo(neighborX, neighborY)
        .stroke({
          width: 2 / this.cameraData[0],
          color: this.debugColors.neighbor,
          alpha: 0.7,
        });

      // Draw a small circle on the neighbor
      this.debugLayer
        .circle(neighborX, neighborY, 3 / this.cameraData[0])
        .fill({ color: this.debugColors.neighbor, alpha: 0.5 });
    }

    // Draw entity info text (index and neighbor count)
    // Note: We'll use a simple marker for now, full text rendering would need PIXI.Text pool
    this.debugLayer
      .circle(myX, myY - 20 / this.cameraData[0], 4 / this.cameraData[0])
      .fill({ color: 0xffffff, alpha: 0.9 });
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
   */
  updateSprites(deltaTime) {
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

    // Array to collect visible sprites for Y-sorting (only if ySorting is enabled)
    const visibleSprites = this.ySorting ? [] : null;

    // First pass: update sprite properties and collect visible sprites
    for (let i = 0; i < this.entityCount; i++) {
      const bodySprite = this.bodySprites[i];

      if (!bodySprite) continue;

      // DENSE ALLOCATION: entityIndex === componentIndex
      // Determine if sprite should be visible
      const shouldBeVisible = active[i] && renderVisible[i] && isItOnScreen[i];

      // Hide inactive or explicitly hidden entities
      if (!shouldBeVisible) {
        if (bodySprite.visible) {
          bodySprite.visible = false;
        }
        continue;
      }

      // Entity should be visible - count it
      visibleCount++;

      // Collect for Y-sorting if enabled
      if (this.ySorting) {
        // Make sprite visible before adding to sort list
        if (!bodySprite.visible) {
          bodySprite.visible = true;
        }
        visibleSprites.push({ entityId: i, sprite: bodySprite, y: y[i] });
      } else {
        // No Y-sorting: just make sprite visible
        if (!bodySprite.visible) {
          bodySprite.visible = true;
        }
      }

      // Update transform (position, rotation, scale)
      bodySprite.x = x[i];
      bodySprite.y = y[i];
      bodySprite.rotation = rotation[i];

      // DENSE: use entity index directly for all component data
      // PixiJS 8 Particle uses scaleX/scaleY instead of scale.x/scale.y
      if (bodySprite.scaleX !== scaleX[i]) bodySprite.scaleX = scaleX[i];
      if (bodySprite.scaleY !== scaleY[i]) bodySprite.scaleY = scaleY[i];

      // Update anchor points (0-1 range)
      // PixiJS 8 Particle uses anchorX/anchorY instead of anchor.x/anchor.y
      if (bodySprite.anchorX !== anchorX[i]) bodySprite.anchorX = anchorX[i];
      if (bodySprite.anchorY !== anchorY[i]) bodySprite.anchorY = anchorY[i];

      // OPTIMIZATION: Only update visual properties if dirty flag is set
      // This skips expensive operations (tint, alpha, flipping, animations) when unchanged
      if (renderDirty[i]) {
        // Check if spritesheet changed (per-instance override)
        const spritesheetId = SpriteRenderer.spritesheetId;
        if (
          spritesheetId &&
          this.currentSpritesheetIds &&
          this.currentSpritesheetIds[i] !== spritesheetId[i]
        ) {
          this.updateEntitySpritesheet(bodySprite, i, spritesheetId[i]);
          this.currentSpritesheetIds[i] = spritesheetId[i];
        }

        // Update body sprite visual properties
        bodySprite.tint = tint[i];
        bodySprite.alpha = alpha[i];

        // Update animation if changed
        this.updateSpriteAnimation(bodySprite, i, animationState[i]);
        this.changeFrameOfSprite(bodySprite, i, deltaSeconds);

        // Update animation speed (stored locally for manual animation)
        this.animationSpeed[i] = animationSpeed[i];

        // Clear dirty flag after updating
        renderDirty[i] = 0;
      }
    }

    // Update particle sprites (adds to visibleSprites if Y-sorting is enabled)
    if (this.maxParticles > 0) {
      this.updateParticleSprites(visibleSprites);
    }

    // Second pass: Y-sort and re-add all sprites to container (only if ySorting is enabled)
    if (this.ySorting) {
      // Sort by Y position (lower Y = render first/background, higher Y = foreground)
      visibleSprites.sort((a, b) => a.y - b.y);

      // PixiJS 8: Clear particleChildren array and re-add in sorted order
      this.particleContainer.particleChildren.length = 0;

      // Re-add all sprites (entities + particles) in sorted order
      for (const item of visibleSprites) {
        this.particleContainer.addParticle(item.sprite);
      }

      // Mark container as needing update
      this.particleContainer.update();
    }
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
    this.updateCameraTransform();

    // Update decal decal tiles (check for dirty tiles from particle_worker)
    this.updateDecalTiles();

    // Update lighting shader uniforms from LightEmitter components
    this.updateLighting();

    this.updateSprites(deltaTime);

    // Render debug overlays (only if debug system is enabled)
    if (this.debugLayer) {
      this.renderDebugOverlays();
    }
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
    this.backgroundSprite.tileScale.set(0.5, 0.5);
    this.backgroundSprite.tilePosition.set(0, 0);
    // Add background to stage directly (ParticleContainer can't hold TilingSprites)
    this.pixiApp.stage.addChildAt(this.backgroundSprite, 0); // Add at bottom
  }

  /**
   * Create the lighting system - full-screen mesh with lighting shader
   * Renders between decals and particle container with multiply blend
   */
  createLightingSystem() {
    // Vertex shader - simple full-screen quad
    const vertexSrc = `
      in vec2 aPosition;
      in vec2 aUV;
      out vec2 vUV;
      void main() {
        vUV = aUV;
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `;

    // Fragment shader - accumulates light from all sources using 1/(d*d) falloff
    // Uses this.maxLights to set array sizes dynamically
    const fragmentSrc = `
      precision mediump float;
      
      in vec2 vUV;
      
      // Light data arrays - sized by maxLights config
      uniform float uLightX[${this.maxLights}];
      uniform float uLightY[${this.maxLights}];
      uniform float uLightIntensity[${this.maxLights}];
      uniform float uLightR[${this.maxLights}];
      uniform float uLightG[${this.maxLights}];
      uniform float uLightB[${this.maxLights}];
      uniform int uLightCount;
      uniform float uAmbient;

      void main() {
        vec2 p = vUV * 2.0 - 1.0;
        vec3 totalLight = vec3(uAmbient);

        for (int i = 0; i < ${this.maxLights}; i++) {
          if (i >= uLightCount) break;
          
          vec2 lightPos = vec2(uLightX[i], uLightY[i]);
          float intensity = uLightIntensity[i] * 0.03;
          vec3 color = vec3(uLightR[i], uLightG[i], uLightB[i]);
          
          float d = length(p - lightPos);
          // Inverse square falloff with small offset to prevent division by zero
          float attenuation = intensity / (d * d + 0.01);
          
          totalLight += color * attenuation;
        }

        totalLight = min(totalLight, vec3(1.0));
        gl_FragColor = vec4(totalLight, 1.0);
      }
    `;

    // Create full-screen quad geometry
    const geometry = new PIXI.Geometry({
      attributes: {
        aPosition: [-1, -1, 1, -1, 1, 1, -1, 1],
        aUV: [0, 0, 1, 0, 1, 1, 0, 1],
      },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });

    // Create shader program
    const glProgram = new PIXI.GlProgram({
      vertex: vertexSrc,
      fragment: fragmentSrc,
    });

    // Initialize uniform arrays (configurable max lights buffer size)
    const maxLights = this.maxLights;
    const initialX = new Array(maxLights).fill(0);
    const initialY = new Array(maxLights).fill(0);
    const initialIntensity = new Array(maxLights).fill(0);
    const initialR = new Array(maxLights).fill(1);
    const initialG = new Array(maxLights).fill(1);
    const initialB = new Array(maxLights).fill(1);

    // Create shader with uniforms
    this.lightingShader = new PIXI.Shader({
      glProgram,
      resources: {
        uniforms: {
          uLightX: { value: initialX, type: "f32", size: maxLights },
          uLightY: { value: initialY, type: "f32", size: maxLights },
          uLightIntensity: {
            value: initialIntensity,
            type: "f32",
            size: maxLights,
          },
          uLightR: { value: initialR, type: "f32", size: maxLights },
          uLightG: { value: initialG, type: "f32", size: maxLights },
          uLightB: { value: initialB, type: "f32", size: maxLights },
          uLightCount: { value: 0, type: "i32" },
          uAmbient: { value: this.lightingAmbient, type: "f32" },
        },
      },
    });

    // Create mesh with multiply blend mode
    this.lightingMesh = new PIXI.Mesh({
      geometry,
      shader: this.lightingShader,
    });
    this.lightingMesh.blendMode = "multiply";

    // Add to stage (after decals, before particle container)
    this.pixiApp.stage.addChild(this.lightingMesh);
  }

  /**
   * Update lighting shader uniforms from LightEmitter components
   * Collects all active lights and updates shader uniforms
   */
  updateLighting() {
    if (!this.lightingEnabled || !this.lightingShader) return;

    const uniforms = this.lightingShader.resources.uniforms.uniforms;

    // Cache component arrays
    const active = Transform.active;
    const worldX = Transform.x;
    const worldY = Transform.y;

    const lightEnabled = LightEmitter.enabled;
    const lightColor = LightEmitter.lightColor;
    const lightIntensity = LightEmitter.lightIntensity;

    // Get camera data for world→screen transform
    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];

    let lightIndex = 0;

    // Iterate all entities looking for active light emitters
    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i]) continue;
      if (!lightEnabled[i]) continue;
      // Stop if we've reached maxLights limit (shader uniform array size)
      if (lightIndex >= this.maxLights) break;

      // Calculate screen position locally using the same camera data we use for intensity
      // This avoids race conditions with spatial_worker's stale SpriteRenderer.screenX values
      const screenX = (worldX[i] - cameraX) * zoom;
      const screenY = (worldY[i] - cameraY) * zoom;

      // Convert screen position to shader space (-1 to 1)
      const shaderX = (screenX / this.canvasWidth) * 2.0 - 1.0;
      const shaderY = -((screenY / this.canvasHeight) * 2.0 - 1.0);

      // Extract RGB from lightColor (0xRRGGBB)
      const color = lightColor[i];
      const r = ((color >> 16) & 0xff) / 255;
      const g = ((color >> 8) & 0xff) / 255;
      const b = (color & 0xff) / 255;

      // Scale intensity by zoom² to maintain consistent world-space light radius
      // When zoomed out, lights cover less screen space so need higher intensity
      const scaledIntensity = lightIntensity[i] * zoom ** 1.57;

      // Update uniforms
      uniforms.uLightX[lightIndex] = shaderX;
      uniforms.uLightY[lightIndex] = shaderY;
      uniforms.uLightIntensity[lightIndex] = scaledIntensity;
      uniforms.uLightR[lightIndex] = r;
      uniforms.uLightG[lightIndex] = g;
      uniforms.uLightB[lightIndex] = b;

      lightIndex++;
    }

    // Update light count
    uniforms.uLightCount = lightIndex;
  }

  /**
   * Build map of entity types that have SpriteRenderer component
   * Spritesheets are now set per-instance via setSpritesheet(), not per-class
   */
  buildEntitySpriteConfigs(registeredClasses) {
    // Track which entity types have SpriteRenderer (they need placeholder sprites)
    for (const registration of registeredClasses) {
      if (registration.count === 0) continue;
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
          console.log(
            `✅ BigAtlas loaded: ${
              Object.keys(frameTextures).length
            } frames available as textures`
          );
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
          `  ✅ Proxy "${proxyName}": ${
            Object.keys(proxyAnimations).length
          } animations`
        );
      }
    }

    // console.log("PIXI WORKER: Finished loading all spritesheets");
  }

  /**
   * Create particle sprites (separate from entity sprites)
   * Particles are static sprites with fixed anchor (0.5, 0.5)
   */
  createParticleSprites() {
    if (this.maxParticles === 0) return;

    console.log(`PIXI WORKER: Creating ${this.maxParticles} particle sprites`);

    for (let i = 0; i < this.maxParticles; i++) {
      // Create Particle object for ParticleContainer
      const particleSprite = new PIXI.Particle({
        texture: PIXI.Texture.WHITE, // Default texture, will be set when particle spawns
        anchorX: 0.5,
        anchorY: 0.5,
      });

      // Start invisible (particles are spawned by ParticleEmitter)
      particleSprite.visible = false;

      this.particleSprites[i] = particleSprite;

      // Add to container if Y-sorting is disabled
      // (if Y-sorting is enabled, particles are added during updateSprites)
      if (!this.ySorting) {
        this.particleContainer.addParticle(particleSprite);
      }
    }

    console.log(
      `PIXI WORKER: Created ${this.maxParticles} particle sprites (separate pool)`
    );
  }

  /**
   * Update particle sprites from ParticleComponent data
   * Returns array of visible particle info for Y-sorting
   * @param {Array} visibleSprites - Array to add visible particles to (for Y-sorting)
   */
  updateParticleSprites(visibleSprites) {
    if (this.maxParticles === 0) return;

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

    for (let i = 0; i < this.maxParticles; i++) {
      const sprite = this.particleSprites[i];
      if (!sprite) continue;

      // Check if particle is active
      if (!active[i] || !isItOnScreen[i]) {
        if (sprite.visible) {
          sprite.visible = false;
        }
        continue;
      }

      // Calculate render Y (ground Y + height offset)
      const renderY = y[i] + z[i];

      // Update sprite properties from ParticleComponent
      sprite.x = x[i];
      sprite.y = renderY;
      sprite.scaleX = scale[i];
      sprite.scaleY = scale[i];
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

      // Add to Y-sort list if sorting is enabled
      // Use ground Y (y[i]) for sorting, renderY for display
      if (visibleSprites) {
        // Make sprite visible before adding to sort list
        if (!sprite.visible) {
          sprite.visible = true;
        }
        visibleSprites.push({
          entityId: -1, // Mark as particle (not an entity)
          particleIndex: i,
          sprite: sprite,
          y: y[i], // Sort by ground position
        });
      } else {
        // Y-sorting disabled - just show the sprite
        if (!sprite.visible) {
          sprite.visible = true;
        }
      }
    }
  }

  /**
   * Create placeholder particles for all entities with SpriteRenderer
   * Actual textures/spritesheets are set per-instance via setSpritesheet()
   * PixiJS 8: Uses Particle objects instead of Sprite for ParticleContainer
   */
  createSprites() {
    // Initialize spritesheet tracking array once
    this.currentSpritesheetIds = new Uint8Array(this.entityCount);

    for (let i = 0; i < this.entityCount; i++) {
      const entityType = Transform.entityType[i];
      const config = this.entitySpriteConfigs[entityType];

      // Skip entities without SpriteRenderer (e.g., Mouse entity for spatial tracking)
      if (!config || !config.hasSpriteRenderer) {
        this.bodySprites[i] = null;
        this.currentAnimationFrames[i] = [];
        this.currentFrameIndex[i] = 0;
        this.frameAccumulator[i] = 0;
        this.animationSpeed[i] = 0;
        continue;
      }

      // Create Particle object - PixiJS 8 ParticleContainer uses Particle, not Sprite
      const bodySprite = new PIXI.Particle({
        texture: PIXI.Texture.WHITE,
        anchorX: 0.5,
        anchorY: 0.5,
      });

      // Store references
      this.bodySprites[i] = bodySprite;
      this.previousAnimStates[i] = -1;

      // Initialize animation tracking
      this.currentAnimationFrames[i] = [];
      this.currentFrameIndex[i] = 0;
      this.frameAccumulator[i] = 0;
      this.animationSpeed[i] = 0;

      // Initialize spritesheet tracking (0 = not set yet)
      this.currentSpritesheetIds[i] = 0;

      // Add particle to container if Y-sorting is disabled
      if (!this.ySorting) {
        this.particleContainer.addParticle(bodySprite);
      }
    }
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
        this.setNestedProperty(sprite, prop, value);
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
            this.setNestedProperty(sprite, key, val);
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

    // Handle old-style messages if they still arrive via main thread
    if (msg === "toRenderer") {
      this.handleSpriteCommand(data);
    }
  }

  /**
   * Helper to set nested properties (supports dot notation)
   */
  setNestedProperty(obj, path, value) {
    const keys = path.split(".");
    const lastKey = keys.pop();
    const target = keys.reduce((o, k) => o?.[k], obj);
    if (target && lastKey) {
      target[lastKey] = value;
    }
  }

  /**
   * Initialize the PIXI renderer with provided data
   */
  async initialize(data) {
    // console.log("PIXI WORKER: Initializing with component system", data);

    // Store viewport and world dimensions from config
    this.worldWidth = data.config.worldWidth;
    this.worldHeight = data.config.worldHeight;
    this.canvasWidth = data.config.canvasWidth;
    this.canvasHeight = data.config.canvasHeight;
    this.canvasView = data.view;

    // Create ParticleContainer with dynamic properties for sprites
    // PixiJS 8 ParticleContainer API
    this.particleContainer = new PIXI.ParticleContainer({
      blendMode: "normal-npm",
      dynamicProperties: {
        vertex: false,
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

    // Configure background texture name (default: 'bg')
    this.bgTextureName = rendererConfig.bg; //|| "bg";
    // console.log(
    //   `PIXI WORKER: Background texture set to "${this.bgTextureName}"`
    // );

    // Initialize component arrays from SharedArrayBuffers
    // console.log("PIXI WORKER: Initializing component arrays...");

    // DENSE ALLOCATION: All components have slots for all entities
    // entityIndex === componentIndex for all components (much simpler!)

    // Transform (for positions)
    Transform.initializeArrays(
      data.buffers.componentData.Transform,
      this.entityCount
    );

    // RigidBody (for rotation, velocity, acceleration)
    if (data.buffers.componentData.RigidBody) {
      RigidBody.initializeArrays(
        data.buffers.componentData.RigidBody,
        this.entityCount // DENSE: all entities have slots
      );
    }

    // MouseComponent (for mouse input state)
    if (data.buffers.componentData.MouseComponent) {
      MouseComponent.initializeArrays(
        data.buffers.componentData.MouseComponent,
        this.entityCount // DENSE: all entities have slots
      );
    }

    // SpriteRenderer (for visual properties)
    if (data.buffers.componentData.SpriteRenderer) {
      SpriteRenderer.initializeArrays(
        data.buffers.componentData.SpriteRenderer,
        this.entityCount // DENSE: all entities have slots
      );
    }

    // ParticleComponent (separate from entity system)
    // Particles have their own pool with maxParticles size
    this.maxParticles = data.maxParticles || 0;
    if (data.buffers.componentData.ParticleComponent && this.maxParticles > 0) {
      ParticleComponent.initializeArrays(
        data.buffers.componentData.ParticleComponent,
        this.maxParticles
      );
      ParticleComponent.particleCount = this.maxParticles;
      console.log(
        `PIXI WORKER: ParticleComponent initialized for ${this.maxParticles} particles`
      );
    }

    // LightEmitter (for lighting system)
    if (data.buffers.componentData.LightEmitter) {
      LightEmitter.initializeArrays(
        data.buffers.componentData.LightEmitter,
        this.entityCount
      );
      console.log(
        `PIXI WORKER: LightEmitter component initialized (${this.entityCount} slots)`
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
    this.reportLog("finished initializing pixi app");
    // Load simple textures
    this.loadTextures(data.textures);
    this.reportLog("finished loading textures");

    // Load spritesheets (synchronous now - manually parsed)
    this.loadSpritesheets(data.spritesheets, data.bigAtlasProxySheets);
    this.reportLog("finished loading spritesheets");

    // Create background
    this.createBackground();

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

      // Create sprites for each tile
      this.createDecalTileSprites();

      // Add decal tile container to stage (between background and entities)
      // decal decals render above background but below entities
      this.pixiApp.stage.addChild(this.decalTileContainer);

      console.log(
        `PIXI WORKER: decal decals enabled - ${this.decalsTilesX}×${this.decalsTilesY} tiles (${this.decalsTileSize}px world, ${this.decalsTilePixelSize}px texture @ ${this.decalsResolution}x)`
      );
    }

    // ========================================
    // LIGHTING SYSTEM - Initialize
    // ========================================
    const lightingConfig = this.config.lighting || {};
    if (lightingConfig.enabled && data.buffers.componentData.LightEmitter) {
      this.lightingEnabled = true;
      this.lightingAmbient =
        lightingConfig.lightingAmbient !== undefined
          ? lightingConfig.lightingAmbient
          : 0.05;
      this.maxLights =
        lightingConfig.maxLights !== undefined ? lightingConfig.maxLights : 128;

      // Create lighting mesh (full-screen quad with multiply blend)
      this.createLightingSystem();

      console.log(
        `PIXI WORKER: Lighting system enabled (ambient: ${this.lightingAmbient}, maxLights: ${this.maxLights})`
      );
    }

    // Add particle container to the stage
    // Sprites are Y-sorted and re-added every frame for proper depth ordering
    this.pixiApp.stage.addChild(this.particleContainer);

    // Initialize debug visualization system
    if (data.buffers.debugData) {
      this.debugFlags = new Uint8Array(data.buffers.debugData);
      this.debugLayer = new PIXI.Graphics();
      this.debugLayer.zIndex = 10000; // Always on top
      this.pixiApp.stage.addChild(this.debugLayer);

      // Initialize Collider component arrays for debug rendering
      // DENSE: all entities have slots, use entityIndex directly
      if (data.buffers.componentData.Collider) {
        Collider.initializeArrays(
          data.buffers.componentData.Collider,
          this.entityCount // DENSE: all entities have slots
        );
        console.log(
          `PIXI WORKER: Collider component loaded for debug rendering (${this.entityCount} slots)`
        );
      }

      console.log("PIXI WORKER: Debug visualization layer initialized");
    }

    // Build entity sprite configs from class definitions
    this.buildEntitySpriteConfigs(data.registeredClasses);
    this.reportLog("finished building entity sprite configs");
    // Create sprites for all entities
    this.createSprites();
    this.reportLog("finished creating sprites");
    // Create particle sprites (separate pool)
    this.createParticleSprites();
    this.reportLog("finished creating particle sprites");
    console.log(
      "PIXI WORKER: Initialization complete, waiting for start signal..."
    );
    // Note: Game loop will start when "start" message is received from main thread
  }
}

// Create singleton instance and setup message handler
self.pixiRenderer = new PixiRenderer(self);
