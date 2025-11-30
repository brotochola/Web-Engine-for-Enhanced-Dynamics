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
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { AbstractWorker } from "./AbstractWorker.js";

// Import PixiJS library (now ES6 module)
import { PIXI } from "./pixi4webworkers.js";

// Make imported classes globally available for dynamic instantiation
self.GameObject = GameObject;
self.Transform = Transform;
self.RigidBody = RigidBody;
self.SpriteRenderer = SpriteRenderer;
self.PIXI = PIXI;

// Note: Game-specific scripts are loaded dynamically by AbstractWorker

// Number of layer containers for depth sorting
const NUM_LAYERS = 1;

/**
 * PixiRenderer - Manages rendering of game objects using PixiJS in a web worker
 * Extends AbstractWorker for common worker functionality
 */
class PixiRenderer extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Use PIXI ticker instead of requestAnimationFrame
    this.usesCustomScheduler = true;

    // PIXI application and rendering
    this.pixiApp = null;
    // Array of ParticleContainers for layer-based rendering
    // Lower indices = background layers, higher indices = foreground layers
    this.layerContainers = [];
    for (let i = 0; i < NUM_LAYERS; i++) {
      this.layerContainers[i] = new PIXI.ParticleContainer(10000, {
        scale: true,
        position: true,
        rotation: true,
        uvs: false,
        tint: true,
        alpha: true,
      });
    }
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
  }

  /**
   * Update camera transform on all layer containers and background
   */
  updateCameraTransform() {
    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];

    // Apply camera state to all layer containers
    for (let i = 0; i < this.layerContainers.length; i++) {
      this.layerContainers[i].scale.set(zoom);
      this.layerContainers[i].x = -cameraX * zoom;
      this.layerContainers[i].y = -cameraY * zoom;
    }

    // Apply camera state to background (since it's not a child of layerContainers)
    if (this.backgroundSprite) {
      this.backgroundSprite.scale.set(zoom);
      this.backgroundSprite.x = -cameraX * zoom;
      this.backgroundSprite.y = -cameraY * zoom;
    }
  }

  /**
   * Update animation state for an entity (manual animation with regular Sprite)
   */
  updateSpriteAnimation(sprite, entityId, newState) {
    // Check if animation state changed
    if (this.previousAnimStates[entityId] === newState) return;
    this.previousAnimStates[entityId] = newState;

    // Get entity type and config
    const entityType = GameObject.entityType[entityId];
    const config = this.entitySpriteConfigs[entityType];
    if (!config || config.type !== "animated") return;

    // Get animation name from animStates
    if (!config.animStates || !config.animStates[newState]) return;

    const animName = config.animStates[newState].name;
    if (!animName) return;

    // Get spritesheet
    const sheet = this.spritesheets[config.spritesheet];
    if (!sheet || !sheet.animations[animName]) {
      console.warn(
        `Animation "${animName}" not found in spritesheet "${config.spritesheet}"`
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
    const renderVisible = SpriteRenderer.renderVisible;
    const zOffset = SpriteRenderer.zOffset;
    const isItOnScreen = SpriteRenderer.isItOnScreen;
    const screenY = SpriteRenderer.screenY;
    const renderDirty = SpriteRenderer.renderDirty; // OPTIMIZATION: Dirty flag

    // Track visible units count
    let visibleCount = 0;

    // Convert deltaTime from ms to seconds for frame calculation
    const deltaSeconds = deltaTime / 1000;

    // Array to collect visible sprites for Y-sorting
    const visibleSprites = [];

    // First pass: update sprite properties and collect visible sprites
    for (let i = 0; i < this.entityCount; i++) {
      const bodySprite = this.bodySprites[i];

      if (!bodySprite) continue;

      // Determine if sprite should be visible
      const shouldBeVisible = active[i] && renderVisible[i] && isItOnScreen[i];

      // Hide inactive or explicitly hidden entities
      if (!shouldBeVisible) {
        if (bodySprite.visible) {
          bodySprite.visible = false;
        }
        continue;
      }

      // Entity should be visible - count it and collect for sorting
      visibleCount++;
      visibleSprites.push({ entityId: i, sprite: bodySprite, y: y[i] });

      // Update transform (position, rotation, scale)
      bodySprite.x = x[i];
      bodySprite.y = y[i];
      bodySprite.rotation = rotation[i];

      // Optimize scale update - direct assignment is cheaper than .set()
      if (bodySprite.scale.x !== scaleX[i]) bodySprite.scale.x = scaleX[i];
      if (bodySprite.scale.y !== scaleY[i]) bodySprite.scale.y = scaleY[i];

      // OPTIMIZATION: Only update visual properties if dirty flag is set
      // This skips expensive operations (tint, alpha, flipping, animations) when unchanged
      if (renderDirty[i]) {
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

    // Second pass: Y-sort and re-add sprites to container in correct order
    // Sort by Y position (lower Y = render first/background, higher Y = foreground)
    visibleSprites.sort((a, b) => a.y - b.y);

    // Get the single container
    const container = this.layerContainers[0];

    // Remove all children from container
    container.removeChildren();

    // Re-add sprites in sorted order and make them visible
    for (const item of visibleSprites) {
      container.addChild(item.sprite);
      if (!item.sprite.visible) {
        item.sprite.visible = true;
      }
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
    this.updateSprites(deltaTime);
  }

  /**
   * Setup PIXI ticker to call gameLoop (custom scheduler implementation)
   */
  onCustomSchedulerStart() {
    // PIXI ticker will call gameLoop on every tick
    this.pixiApp.ticker.add(() => this.gameLoop());
  }

  /**
   * Create tiling background sprite
   * Note: Background is added to stage, not ParticleContainer (which only supports simple sprites)
   */
  createBackground() {
    if (!this.textures.bg) {
      console.warn("Background texture not found");
      return;
    }

    this.backgroundSprite = new PIXI.TilingSprite(
      this.textures.bg,
      this.worldWidth,
      this.worldHeight
    );
    this.backgroundSprite.tileScale.set(0.5);
    this.backgroundSprite.tilePosition.set(0, 0);
    // Add background to stage directly (ParticleContainer can't hold TilingSprites)
    this.pixiApp.stage.addChildAt(this.backgroundSprite, 0); // Add at bottom
  }

  /**
   * Build sprite configuration map from registered entity classes
   */
  buildEntitySpriteConfigs(registeredClasses) {
    console.log(
      `🎨 Building sprite configs for ${registeredClasses.length} registered classes...`
    );

    for (const registration of registeredClasses) {
      // Skip classes with 0 instances (base classes that won't be rendered)
      if (registration.count === 0) {
        console.log(
          `⏭️  Skipping ${registration.name} (0 instances, base class)`
        );
        continue;
      }

      // Dynamically get class from global scope (self)
      const EntityClass = self[registration.name];

      if (!EntityClass) {
        console.warn(
          `⚠️ Class ${registration.name} not found in worker global scope`
        );
        continue;
      }

      // Get entityType - handle both static property and TypedArray after initialization
      const entityType =
        typeof EntityClass.entityType === "number"
          ? EntityClass.entityType
          : undefined;

      if (entityType === undefined) {
        console.warn(
          `⚠️ ${registration.name} has no valid entityType (static property)`
        );
        continue;
      }

      // Validate and handle spriteConfig (standardized approach only)
      if (!EntityClass.spriteConfig) {
        console.error(
          `❌ ${registration.name} (entityType ${entityType}) has no spriteConfig defined!`
        );
        console.error(
          `   All entities extending RenderableGameObject must define spriteConfig`
        );
        console.error(`   See SPRITE_CONFIG_GUIDE.md for examples`);
        continue;
      }

      const config = EntityClass.spriteConfig;

      // Validate config has required type field
      if (!config.type) {
        console.error(
          `❌ ${registration.name}.spriteConfig missing 'type' field! Use 'static' or 'animated'`
        );
        continue;
      }

      this.entitySpriteConfigs[entityType] = config;

      // Log appropriate message based on type
      if (config.type === "animated") {
        console.log(
          `✅ Mapped entityType ${entityType} (${registration.name}) -> animated spritesheet "${config.spritesheet}"`
        );
      } else if (config.type === "static") {
        console.log(
          `✅ Mapped entityType ${entityType} (${registration.name}) -> static texture "${config.textureName}"`
        );
      }
    }

    console.log(`📋 Final entitySpriteConfigs:`, this.entitySpriteConfigs);
  }

  /**
   * Load simple textures from transferred ImageBitmaps
   */
  loadTextures(texturesData) {
    if (!texturesData) return;

    console.log(
      `PIXI WORKER: Loading ${Object.keys(texturesData).length} textures`
    );

    for (const [name, imageBitmap] of Object.entries(texturesData)) {
      // Create PIXI BaseTexture from ImageBitmap
      const baseTexture = PIXI.BaseTexture.from(imageBitmap);
      // Create PIXI Texture from BaseTexture
      this.textures[name] = new PIXI.Texture(baseTexture);

      console.log(`✅ Loaded texture: ${name}`);
    }
  }

  /**
   * Load spritesheets from JSON + texture data
   * NOTE: PIXI.Spritesheet.parse() doesn't work in workers, so we manually build animations
   */
  loadSpritesheets(spritesheetData) {
    if (!spritesheetData) {
      console.log("PIXI WORKER: No spritesheets to load");
      return;
    }

    console.log(
      `PIXI WORKER: Loading ${Object.keys(spritesheetData).length} spritesheets`
    );

    for (const [name, data] of Object.entries(spritesheetData)) {
      try {
        console.log(`  Loading spritesheet "${name}"...`);

        // Validate data
        if (!data.imageBitmap || !data.json) {
          throw new Error(`Missing imageBitmap or json for ${name}`);
        }

        // Create base texture from ImageBitmap
        const baseTexture = PIXI.BaseTexture.from(data.imageBitmap);
        const jsonData = data.json;

        // Manually create textures for each frame
        const frameTextures = {};
        for (const [frameName, frameData] of Object.entries(jsonData.frames)) {
          const frame = frameData.frame;
          const texture = new PIXI.Texture(
            baseTexture,
            new PIXI.Rectangle(frame.x, frame.y, frame.w, frame.h)
          );
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
          baseTexture: baseTexture,
        };

        console.log(
          `✅ Loaded spritesheet: ${name} with ${
            Object.keys(animations).length
          } animations`
        );
      } catch (error) {
        console.error(`❌ Failed to load spritesheet ${name}:`, error);
      }
    }

    console.log("PIXI WORKER: Finished loading all spritesheets");
  }

  /**
   * Create container and sprite for each entity
   */
  createSprites() {
    console.log(
      `PIXI WORKER: Creating sprites for ${this.entityCount} entities...`
    );
    for (let i = 0; i < this.entityCount; i++) {
      const entityType = GameObject.entityType[i];
      const config = this.entitySpriteConfigs[entityType];

      // Create container for this entity
      // const container = new PIXI.Container();
      // container.sortableChildren = true;

      let bodySprite = null;

      // Handle sprite creation based on standardized config
      if (!config) {
        console.error(
          `❌ No sprite config found for entityType ${entityType}! Cannot create sprite.`
        );
        // Create placeholder to prevent crashes
        bodySprite = new PIXI.Sprite(PIXI.Texture.WHITE);
        // Initialize tracking arrays
        this.currentAnimationFrames[i] = [];
        this.currentFrameIndex[i] = 0;
        this.frameAccumulator[i] = 0;
        this.animationSpeed[i] = 0;
      } else if (config.type === "animated" && config.spritesheet) {
        // Create regular Sprite from spritesheet (manual animation)
        const sheet = this.spritesheets[config.spritesheet];

        if (!sheet) {
          console.error(
            `❌ Spritesheet "${config.spritesheet}" not found for entityType ${entityType}`
          );
          bodySprite = new PIXI.Sprite(PIXI.Texture.WHITE);
          this.currentAnimationFrames[i] = [];
        } else {
          const defaultAnim = config.defaultAnimation;

          if (!defaultAnim || !sheet.animations[defaultAnim]) {
            console.error(
              `❌ Default animation "${defaultAnim}" not found in spritesheet "${config.spritesheet}"`
            );
            // Use first available animation as emergency fallback
            const firstAnim = Object.keys(sheet.animations)[0];
            if (firstAnim) {
              const frames = sheet.animations[firstAnim];
              bodySprite = new PIXI.Sprite(frames[0]); // Start with first frame
              this.currentAnimationFrames[i] = frames;
              console.warn(`   Using "${firstAnim}" as fallback animation`);
            } else {
              bodySprite = new PIXI.Sprite(PIXI.Texture.WHITE);
              this.currentAnimationFrames[i] = [];
            }
          } else {
            const frames = sheet.animations[defaultAnim];
            bodySprite = new PIXI.Sprite(frames[0]); // Start with first frame
            this.currentAnimationFrames[i] = frames;
          }
        }

        // Initialize animation tracking
        this.currentFrameIndex[i] = 0;
        this.frameAccumulator[i] = 0;
        this.animationSpeed[i] = config.animationSpeed || 0.2;
      } else if (config.type === "static" && config.textureName) {
        // Create static Sprite from texture
        const texture = this.textures[config.textureName];

        if (!texture) {
          console.error(
            `❌ Texture "${config.textureName}" not found for entityType ${entityType}`
          );
          bodySprite = new PIXI.Sprite(PIXI.Texture.WHITE);
        } else {
          bodySprite = new PIXI.Sprite(texture);
        }

        // Initialize tracking arrays (no animation for static sprites)
        this.currentAnimationFrames[i] = [];
        this.currentFrameIndex[i] = 0;
        this.frameAccumulator[i] = 0;
        this.animationSpeed[i] = 0;
      } else {
        console.error(
          `❌ Invalid sprite config for entityType ${entityType}:`,
          config
        );
        bodySprite = new PIXI.Sprite(PIXI.Texture.WHITE);
        // Initialize tracking arrays
        this.currentAnimationFrames[i] = [];
        this.currentFrameIndex[i] = 0;
        this.frameAccumulator[i] = 0;
        this.animationSpeed[i] = 0;
      }

      // Setup sprite
      bodySprite.anchor.set(0.5, 1);
      bodySprite.zIndex = 0;

      // Add sprite to container
      // container.addChild(bodySprite);

      // Store references
      // this.containers[i] = bodySprite;
      this.bodySprites[i] = bodySprite;
      this.previousAnimStates[i] = -1; // Initialize to invalid state

      // Note: Sprites will be added to container during first updateSprites() call
      // based on Y-sorting, so we don't add them here
    }

    console.log(`PIXI WORKER: Created ${this.entityCount} entity containers`);
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
  initialize(data) {
    console.log("PIXI WORKER: Initializing with component system", data);

    // Store viewport and world dimensions from config
    this.worldWidth = data.config.worldWidth;
    this.worldHeight = data.config.worldHeight;
    this.canvasWidth = data.config.canvasWidth;
    this.canvasHeight = data.config.canvasHeight;
    this.canvasView = data.view;

    // Initialize component arrays from SharedArrayBuffers
    console.log("PIXI WORKER: Initializing component arrays...");

    // Transform (for positions)
    Transform.initializeArrays(
      data.buffers.componentData.Transform,
      this.entityCount
    );
    console.log(`  ✅ Transform: ${this.entityCount} slots`);

    // RigidBody (for rotation)
    if (data.buffers.componentData.RigidBody) {
      RigidBody.initializeArrays(
        data.buffers.componentData.RigidBody,
        data.componentPools.RigidBody.count
      );
      console.log(
        `  ✅ RigidBody: ${data.componentPools.RigidBody.count} slots`
      );
    }

    // SpriteRenderer (for visual properties)
    if (data.buffers.componentData.SpriteRenderer) {
      SpriteRenderer.initializeArrays(
        data.buffers.componentData.SpriteRenderer,
        data.componentPools.SpriteRenderer.count
      );
      console.log(
        `  ✅ SpriteRenderer: ${data.componentPools.SpriteRenderer.count} slots`
      );
    }

    // Create PIXI application
    this.pixiApp = new PIXI.Application({
      width: this.canvasWidth,
      height: this.canvasHeight,
      resolution: 1,
      view: this.canvasView,
      backgroundColor: 0x000000,
      // Performance optimizations
      // antialias: true,
      powerPreference: "high-performance",
    });
    this.reportLog("finished initializing pixi app");
    // Load simple textures
    this.loadTextures(data.textures);
    this.reportLog("finished loading textures");

    // Load spritesheets (synchronous now - manually parsed)
    this.loadSpritesheets(data.spritesheets);
    this.reportLog("finished loading spritesheets");

    // Create background
    // this.createBackground();

    // Add all layer containers to the stage in order (background to foreground)
    // Note: ParticleContainer doesn't support sortableChildren, but uses zIndex internally for ordering
    for (let i = 0; i < this.layerContainers.length; i++) {
      this.pixiApp.stage.addChild(this.layerContainers[i]);
    }

    // Build entity sprite configs from class definitions
    this.buildEntitySpriteConfigs(data.registeredClasses);
    this.reportLog("finished building entity sprite configs");
    // Create sprites for all entities
    this.createSprites();
    this.reportLog("finished creating sprites");
    console.log(
      "PIXI WORKER: Initialization complete, waiting for start signal..."
    );
    // Note: Game loop will start when "start" message is received from main thread
  }
}

// Create singleton instance and setup message handler
self.pixiRenderer = new PixiRenderer(self);
