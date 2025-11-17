// pixi_worker.js - Rendering worker using PixiJS
// Reads GameObject arrays and renders sprites

importScripts("gameObject.js");
importScripts("AbstractWorker.js");
importScripts("pixi4webworkers.js");

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
    this.textures = {}; // Store loaded PIXI textures by name
    this.sprites = []; // Array of PIXI sprites for entities

    // World and viewport dimensions
    this.worldWidth = 0;
    this.worldHeight = 0;
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.resolution = 1;
    this.canvasView = null;
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

  /**
   * Check if a sprite at world coordinates is visible on screen
   */
  isSpriteVisible(worldX, worldY) {
    const screenPos = this.worldToScreenPosition(worldX, worldY);
    const marginX = this.canvasWidth * 0.15;
    const marginY = this.canvasHeight * 0.15;

    return (
      screenPos.x > -marginX &&
      screenPos.x < this.canvasWidth + marginX &&
      screenPos.y > -marginY &&
      screenPos.y < this.canvasHeight + marginY
    );
  }

  /**
   * Update camera transform on the main container
   */
  updateCameraTransform() {
    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];

    // Apply camera state to main container
    // Camera position represents the world coordinates of the top-left corner of the viewport
    // PIXI applies scale first, then position, so we multiply by zoom
    this.mainContainer.scale.set(zoom);
    this.mainContainer.x = -cameraX * zoom;
    this.mainContainer.y = -cameraY * zoom;
  }

  /**
   * Update all sprite positions and visibility from GameObject arrays
   */
  updateSprites() {
    // Cache array references for performance
    const active = GameObject.active;
    const x = GameObject.x;
    const y = GameObject.y;
    const rotation = GameObject.rotation;
    const scale = GameObject.scale;

    // Update sprite positions
    // This is cache-friendly! Sequential reads from GameObject arrays
    for (let i = 0; i < this.entityCount; i++) {
      const sprite = this.sprites[i];
      if (sprite) {
        // Hide inactive entities immediately - skip visibility and transform calculations
        if (!active[i]) {
          sprite.visible = false;
          continue;
        }

        if (this.isSpriteVisible(x[i], y[i])) {
          sprite.visible = true;
          sprite.x = x[i];
          sprite.y = y[i];
          sprite.rotation = rotation[i];
          sprite.scale.set(scale[i]);
          sprite.zIndex = y[i];
          sprite.tint = 0xffffff;
        } else {
          sprite.visible = false;
        }
      }
    }
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   * @param {number} deltaTime - Time since last frame
   * @param {number} dtRatio - Delta time ratio normalized to 60fps
   * @param {boolean} resuming - Whether resuming from pause
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
   * Load textures from transferred ImageBitmaps
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
   * Create PIXI sprites for all entities
   */
  createSprites() {
    const defaultTexture = this.textures.bunny;

    if (!defaultTexture) {
      console.error("No textures available for sprites");
      return;
    }

    for (let i = 0; i < this.entityCount; i++) {
      const sprite = new PIXI.Sprite(defaultTexture);
      sprite.anchor.set(0.5);
      sprite.scale.set(GameObject.scale[i]);
      sprite.x = GameObject.x[i];
      sprite.y = GameObject.y[i];
      this.sprites.push(sprite);
      this.mainContainer.addChild(sprite);
    }

    console.log(`PIXI WORKER: Created ${this.entityCount} sprites`);
  }

  /**
   * Handle custom messages from main thread (implementation of AbstractWorker.handleCustomMessage)
   */
  handleCustomMessage(data) {
    // Override in subclass if needed
  }

  /**
   * Initialize the PIXI renderer with provided data (implementation of AbstractWorker.initialize)
   */
  async initialize(data) {
    console.log("PIXI WORKER: Initializing PIXI with GameObject arrays", data);

    // Store viewport and world dimensions
    this.worldWidth = data.width;
    this.worldHeight = data.height;
    this.canvasWidth = data.canvasWidth;
    this.canvasHeight = data.canvasHeight;
    this.resolution = data.resolution;
    this.canvasView = data.view;

    // Create PIXI application
    this.pixiApp = new PIXI.Application({
      width: this.canvasWidth,
      height: this.canvasHeight,
      resolution: this.resolution,
      view: this.canvasView,
      backgroundColor: 0x000000,
      // Performance optimizations
      antialias: false,
      powerPreference: "high-performance",
    });

    // Load textures
    this.loadTextures(data.textures);
    this.createBackground();

    // Setup main container
    this.mainContainer.sortableChildren = true;

    // Add main container to stage
    this.pixiApp.stage.addChild(this.mainContainer);

    // Create sprites for all entities
    this.createSprites();

    // Start render loop (will setup PIXI ticker via onCustomSchedulerStart)
    this.startGameLoop();
  }
}

// Create singleton instance and setup message handler
const pixiRenderer = new PixiRenderer(self);
