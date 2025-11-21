self.postMessage({
  msg: "log",
  message: "js loaded",
  when: Date.now(),
});
// pixi_worker.js - Rendering worker using PixiJS with AnimatedSprite support
// Reads GameObject arrays and renders sprites with animations

// Import engine dependencies
importScripts("gameObject.js");
importScripts("RenderableGameObject.js");
importScripts("AbstractWorker.js");
importScripts("pixi4webworkers.js");

// Note: Game-specific scripts are loaded dynamically by AbstractWorker

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
    this.mainContainer = new PIXI.Container();
    this.backgroundSprite = null;

    // Texture and spritesheet storage
    this.textures = {}; // Store simple PIXI textures by name
    this.spritesheets = {}; // Store loaded spritesheets by name

    // Entity rendering
    this.containers = []; // Array of PIXI containers (one per entity)
    this.bodySprites = []; // Array of main body sprites (AnimatedSprite or Sprite)
    this.entitySpriteConfigs = {}; // Store sprite config per entityType
    this.previousAnimStates = []; // Track previous animation state per entity

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
   * Convert world coordinates to screen coordinates
   */
  worldToScreenPosition(worldX, worldY) {
    return {
      x: worldX * this.mainContainer.scale.x + this.mainContainer.x,
      y: worldY * this.mainContainer.scale.y + this.mainContainer.y,
    };
  }

  // /**
  //  * Check if a sprite at world coordinates is visible on screen
  //  */
  // isSpriteVisible(worldX, worldY) {
  //   const screenPos = this.worldToScreenPosition(worldX, worldY);
  //   const marginX = this.canvasWidth * 0.15;
  //   const marginY = this.canvasHeight * 0.15;

  //   return (
  //     screenPos.x > -marginX &&
  //     screenPos.x < this.canvasWidth + marginX &&
  //     screenPos.y > -marginY &&
  //     screenPos.y < this.canvasHeight + marginY
  //   );
  // }

  /**
   * Update camera transform on the main container
   */
  updateCameraTransform() {
    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];

    // Apply camera state to main container
    this.mainContainer.scale.set(zoom);
    this.mainContainer.x = -cameraX * zoom;
    this.mainContainer.y = -cameraY * zoom;
  }

  /**
   * Update animation state for an entity
   */
  updateSpriteAnimation(sprite, entityId, newState) {
    // Check if animation state changed
    if (this.previousAnimStates[entityId] === newState) return;
    this.previousAnimStates[entityId] = newState;

    // Skip if not an AnimatedSprite
    if (!sprite.textures || !Array.isArray(sprite.textures)) return;

    // Get entity type and config
    const entityType = GameObject.entityType[entityId];
    const config = this.entitySpriteConfigs[entityType];
    if (!config) return;

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

    // Update sprite textures and play
    sprite.textures = sheet.animations[animName];
    sprite.gotoAndPlay(0);
  }

  /**
   * Update all sprite positions, visibility, and properties from SharedArrayBuffer
   * Uses dirty flags to skip unnecessary visual property updates
   */
  updateSprites() {
    // Cache array references for performance
    const active = GameObject.active;
    const x = GameObject.x;
    const y = GameObject.y;
    const rotation = GameObject.rotation;

    // Renderable properties
    const animationState = RenderableGameObject.animationState;
    const animationSpeed = RenderableGameObject.animationSpeed;
    const tint = RenderableGameObject.tint;
    const alpha = RenderableGameObject.alpha;
    const flipX = RenderableGameObject.flipX;
    const flipY = RenderableGameObject.flipY;
    const scaleX = RenderableGameObject.scaleX;
    const scaleY = RenderableGameObject.scaleY;
    const renderVisible = RenderableGameObject.renderVisible;
    const zOffset = RenderableGameObject.zOffset;
    const isItOnScreen = GameObject.isItOnScreen;
    const renderDirty = RenderableGameObject.renderDirty; // OPTIMIZATION: Dirty flag

    // Track visible units count
    let visibleCount = 0;

    // Update all entities
    for (let i = 0; i < this.entityCount; i++) {
      const container = this.containers[i];
      const bodySprite = this.bodySprites[i];

      if (!container || !bodySprite) continue;

      // Hide inactive or explicitly hidden entities
      if (!active[i] || !renderVisible[i] || !isItOnScreen[i]) {
        container.visible = false;
        continue;
      }

      // Entity is active and on-screen
      container.visible = true;
      visibleCount++;

      // ALWAYS update transform (position, rotation, scale) - these change frequently
      container.x = x[i];
      container.y = y[i];
      container.rotation = rotation[i];
      container.scale.set(scaleX[i], scaleY[i]);
      container.zIndex = y[i] + zOffset[i];

      // OPTIMIZATION: Only update visual properties if dirty flag is set
      // This skips expensive operations (tint, alpha, flipping, animations) when unchanged
      if (renderDirty[i]) {
        // Update body sprite visual properties
        bodySprite.tint = tint[i];
        bodySprite.alpha = alpha[i];

        // Handle flipping
        bodySprite.scale.x = flipX[i] ? -1 : 1;
        bodySprite.scale.y = flipY[i] ? -1 : 1;

        // Update animation if changed
        this.updateSpriteAnimation(bodySprite, i, animationState[i]);

        // Update animation speed for AnimatedSprites
        if (bodySprite.animationSpeed !== undefined) {
          bodySprite.animationSpeed = animationSpeed[i];
        }

        // Clear dirty flag after updating
        renderDirty[i] = 0;
      }
    }
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   */
  update(deltaTime, dtRatio, resuming) {
    this.updateCameraTransform();
    this.updateSprites();
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
    this.mainContainer.addChild(this.backgroundSprite);
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
      const container = new PIXI.Container();
      container.sortableChildren = true;

      let bodySprite = null;

      // Handle sprite creation based on standardized config
      if (!config) {
        console.error(
          `❌ No sprite config found for entityType ${entityType}! Cannot create sprite.`
        );
        // Create placeholder to prevent crashes
        bodySprite = new PIXI.Sprite(PIXI.Texture.WHITE);
      } else if (config.type === "animated" && config.spritesheet) {
        // Create AnimatedSprite from spritesheet
        const sheet = this.spritesheets[config.spritesheet];

        if (!sheet) {
          console.error(
            `❌ Spritesheet "${config.spritesheet}" not found for entityType ${entityType}`
          );
          bodySprite = new PIXI.Sprite(PIXI.Texture.WHITE);
        } else {
          const defaultAnim = config.defaultAnimation;

          if (!defaultAnim || !sheet.animations[defaultAnim]) {
            console.error(
              `❌ Default animation "${defaultAnim}" not found in spritesheet "${config.spritesheet}"`
            );
            // Use first available animation as emergency fallback
            const firstAnim = Object.keys(sheet.animations)[0];
            if (firstAnim) {
              bodySprite = new PIXI.AnimatedSprite(sheet.animations[firstAnim]);
              console.warn(`   Using "${firstAnim}" as fallback animation`);
            } else {
              bodySprite = new PIXI.Sprite(PIXI.Texture.WHITE);
            }
          } else {
            bodySprite = new PIXI.AnimatedSprite(sheet.animations[defaultAnim]);
            bodySprite.animationSpeed = config.animationSpeed || 0.2;
            bodySprite.play();
          }
        }
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
      } else {
        console.error(
          `❌ Invalid sprite config for entityType ${entityType}:`,
          config
        );
        bodySprite = new PIXI.Sprite(PIXI.Texture.WHITE);
      }

      // Setup sprite
      bodySprite.anchor.set(0.5, 1);
      bodySprite.zIndex = 0;

      // Add sprite to container
      container.addChild(bodySprite);

      // Store references
      this.containers[i] = container;
      this.bodySprites[i] = bodySprite;
      this.previousAnimStates[i] = -1; // Initialize to invalid state

      // Add container to main scene
      this.mainContainer.addChild(container);
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
        console.log("setProp", prop, value);
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
    console.log("PIXI WORKER: Initializing PIXI with spritesheets", data);

    // Store viewport and world dimensions from config
    this.worldWidth = data.config.worldWidth;
    this.worldHeight = data.config.worldHeight;
    this.canvasWidth = data.config.canvasWidth;
    this.canvasHeight = data.config.canvasHeight;
    this.canvasView = data.view;

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
    this.createBackground();

    // Setup main container
    this.mainContainer.sortableChildren = true;
    this.pixiApp.stage.addChild(this.mainContainer);

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
const pixiRenderer = new PixiRenderer(self);
