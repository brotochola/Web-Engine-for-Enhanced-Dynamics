// pixi_worker.js - Rendering worker using PixiJS
// Reads GameObject arrays and renders sprites

importScripts("config.js");
importScripts("gameObject.js");
importScripts("AbstractWorker.js");
importScripts("pixi4webworkers.js");

// Lighting constants
const MAX_LIGHTS_TO_RENDER = 200;
const AMBIENT_LIGHT = 0.05;

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

    // Lighting system
    this.lightingSprite = null;
    this.lightingFilter = null;
    this.lightData = new Float32Array(MAX_LIGHTS_TO_RENDER * 7); // 7 values per light
    this.lightCount = 0;
    this.objectTints = null;

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

          // Keep sprites at full brightness - lighting layer handles dimming
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
    this.updateLightingShader();
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
   * Create lighting layer with custom fragment shader
   */
  createLightingLayer() {
    // Create a texture to hold light data (avoids uniform limit)
    // Each light = 7 floats, pack into RGBA texture (4 floats per pixel)
    // Need 2 pixels per light: pixel1(x,y,r,g) pixel2(b,radius,intensity,unused)
    const texWidth = 2; // 2 pixels per light
    const texHeight = MAX_LIGHTS_TO_RENDER; // One row per light

    this.lightDataTexture = PIXI.RenderTexture.create({
      width: texWidth,
      height: texHeight,
      format: PIXI.FORMATS.RGBA,
      type: PIXI.TYPES.UNSIGNED_BYTE,
    });

    // Fragment shader for lighting with ADD blend mode
    // Output black (0) where there's no light, bright values where there are lights
    const fragmentShader = `
      precision mediump float;
      
      varying vec2 vTextureCoord;
      
      uniform vec2 resolution;
      uniform sampler2D lightDataTexture;
      uniform int lightCount;
      
      vec4 readTexel(sampler2D tex, float x, float y, vec2 size) {
        return texture2D(tex, vec2(x / size.x, y / size.y));
      }
      
      void main() {
        vec2 pixelPos = gl_FragCoord.xy;
        
        // Start with no light (black) - ADD blend mode will add light on top
        float brightness = 0.0;
        
        vec2 texSize = vec2(2.0, ${MAX_LIGHTS_TO_RENDER.toFixed(1)});
        vec2 canvasSize = vec2(${this.canvasWidth.toFixed(
          1
        )}, ${this.canvasHeight.toFixed(1)});
        float maxDimension = max(canvasSize.x, canvasSize.y);
        
        // Process each light
        for (int i = 0; i < ${MAX_LIGHTS_TO_RENDER}; i++) {
          if (i >= lightCount) break;
          
          float row = float(i);
          
          // Read normalized light data from texture
          vec4 data1 = readTexel(lightDataTexture, 0.5, row + 0.5, texSize);
          vec4 data2 = readTexel(lightDataTexture, 1.5, row + 0.5, texSize);
          
          // Denormalize values
          vec2 lightPos = vec2(data1.x * canvasSize.x, data1.y * canvasSize.y);
          float lightRadius = data2.y * 1000.0; // Denormalize from 0-1000 range
          float intensity = data2.z * 5.0; // High intensity since we reduced K factor
          
          // Calculate distance from pixel to light
          float dist = distance(pixelPos, lightPos);
          
          // Smooth falloff with quadratic attenuation
          if (dist < lightRadius) {
            float attenuation = 1.0 - (dist / lightRadius);
            attenuation = attenuation * attenuation; // Quadratic falloff
            brightness += attenuation * intensity;
          }
        }
        
        // Clamp brightness
        brightness = clamp(brightness, 0.0, 1.0);
        
        // Output as grayscale - this will be ADDED to the scene below
        gl_FragColor = vec4(brightness, brightness, brightness, 1.0);
      }
    `;

    // Create filter with the shader
    this.lightingFilter = new PIXI.Filter(null, fragmentShader, {
      resolution: [this.canvasWidth, this.canvasHeight],
      lightDataTexture: this.lightDataTexture,
      lightCount: 0,
    });

    // Create full-screen sprite to apply the filter to
    this.lightingSprite = new PIXI.Sprite(PIXI.Texture.WHITE);
    this.lightingSprite.width = this.canvasWidth;
    this.lightingSprite.height = this.canvasHeight;
    this.lightingSprite.filters = [this.lightingFilter];

    // Add to stage with correct layer order
    this.pixiApp.stage.addChild(this.mainContainer);
    this.pixiApp.stage.addChild(this.lightingSprite);

    // Use ADD blend mode instead of MULTIPLY - this adds light to the scene
    this.lightingSprite.blendMode = PIXI.BLEND_MODES.ADD;

    // Start with lighting disabled (will enable when we receive first light data)
    this.lightingSprite.visible = false;

    console.log("PIXI WORKER: Created lighting layer with shader");
  }

  /**
   * Update lighting shader with latest light data
   */
  updateLightingShader() {
    if (!this.lightingFilter || !this.lightDataTexture) return;

    // Skip update if no light data yet
    if (
      !this.lightData ||
      this.lightData.length === 0 ||
      this.lightCount === 0
    ) {
      this.lightingSprite.visible = false;
      return;
    }

    // Debug: Log first light's data
    if (this.frameNumber % 60 === 0) {
      console.log("PIXI: Light count:", this.lightCount);
      console.log("PIXI: First light data:", {
        screenX: this.lightData[0],
        screenY: this.lightData[1],
        r: this.lightData[2],
        g: this.lightData[3],
        b: this.lightData[4],
        radius: this.lightData[5],
        intensity: this.lightData[6],
      });
    }

    // Enable lighting layer once we have data
    this.lightingSprite.visible = true;

    // Pack light data into texture format
    // Each light = 7 floats packed into 2 RGBA pixels (8 floats, 1 unused)
    const texWidth = 2;
    const texHeight = MAX_LIGHTS_TO_RENDER;

    // Create pixel data array - use Uint8Array for RGBA8 format
    const pixelData = new Uint8Array(texWidth * texHeight * 4);

    for (let i = 0; i < this.lightCount && i < texHeight; i++) {
      const lightIndex = i * 7; // Source data: 7 floats per light
      const pixel1Index = (i * texWidth + 0) * 4; // First pixel for this light
      const pixel2Index = (i * texWidth + 1) * 4; // Second pixel for this light

      // Normalize floats to 0-255 range for Uint8Array
      // Pixel 1: x, y, r, g (positions are in screen space 0-800, colors 0-1)
      pixelData[pixel1Index + 0] = Math.floor(
        (this.lightData[lightIndex + 0] / this.canvasWidth) * 255
      ); // x normalized
      pixelData[pixel1Index + 1] = Math.floor(
        (this.lightData[lightIndex + 1] / this.canvasHeight) * 255
      ); // y normalized
      pixelData[pixel1Index + 2] = Math.floor(
        this.lightData[lightIndex + 2] * 255
      ); // r
      pixelData[pixel1Index + 3] = Math.floor(
        this.lightData[lightIndex + 3] * 255
      ); // g

      // Pixel 2: b, radius, intensity
      pixelData[pixel2Index + 0] = Math.floor(
        this.lightData[lightIndex + 4] * 255
      ); // b
      pixelData[pixel2Index + 1] = Math.floor(
        (this.lightData[lightIndex + 5] / 1000) * 255
      ); // radius normalized to 0-1000 range
      pixelData[pixel2Index + 2] = Math.floor(
        Math.min(this.lightData[lightIndex + 6], 1.0) * 255
      ); // intensity
      pixelData[pixel2Index + 3] = 0; // unused
    }

    // Create a BaseTexture from the data
    const resource = new PIXI.BufferResource(pixelData, {
      width: texWidth,
      height: texHeight,
    });
    this.lightDataTexture.baseTexture.resource = resource;
    this.lightDataTexture.baseTexture.update();

    // Update light count uniform
    this.lightingFilter.uniforms.lightCount = this.lightCount;
  }

  /**
   * Handle incoming lighting data from lighting_worker (via main thread)
   */
  handleLightingData(data) {
    // Update light data
    this.lightData = new Float32Array(data.lightData);
    this.lightCount = data.lightCount;

    // Update object tints (copy to avoid transfer issues)
    if (data.objectTints) {
      this.objectTints = new Float32Array(data.objectTints);
    }
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
    // Use the texture by name (e.g., textures.texture1 or textures['texture1'])
    const defaultTexture =
      this.textures.texture1 || Object.values(this.textures)[0];

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
    if (data.msg === "lightingData") {
      this.handleLightingData(data);
    }
  }

  /**
   * Initialize the PIXI renderer with provided data (implementation of AbstractWorker.initialize)
   */
  async initialize(data) {
    console.log("PIXI WORKER: Initializing PIXI with GameObject arrays");

    // Initialize common buffers from AbstractWorker
    this.initializeCommonBuffers(data);

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

    // Setup main container (don't add to stage yet - lighting layer will do it)
    this.mainContainer.sortableChildren = true;

    // Create lighting layer (adds both lighting sprite and main container to stage)
    this.createLightingLayer();

    // Create sprites for all entities
    this.createSprites();

    // Start render loop (will setup PIXI ticker via onCustomSchedulerStart)
    this.startGameLoop();
  }
}

// Create singleton instance and setup message handler
const pixiRenderer = new PixiRenderer(self);
