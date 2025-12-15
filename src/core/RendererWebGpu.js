// RendererWebGpu.js - Main thread rendering using PixiJS with WebGPU backend
// Adapted from pixi_worker.js for main thread execution
// Reads GameObject arrays and renders sprites with animations

import { GameObject } from "./gameObject.js";
import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { ParticleComponent } from "../components/ParticleComponent.js";
import { SpriteSheetRegistry } from "./SpriteSheetRegistry.js";
import { DEBUG_FLAGS } from "./Debug.js";
import { Mouse } from "./Mouse.js";
import { LightEmitter } from "../components/LightEmitter.js";
import {
  buildVertexShaderGLSL,
  buildFragmentShaderGLSL,
  DEFAULT_MAX_LIGHTS,
} from "./lightingShaders.js";

// Import PixiJS 8 (standard browser version, not worker version)
import * as PIXI from "./pixi8.6esm.js";

/**
 * RendererWebGpu - Manages rendering of game objects using PixiJS on main thread
 * Uses WebGPU backend for better performance
 */
export class RendererWebGpu {
  static Z_INDICES = {
    BACKGROUND: 0,
    DECALS: 1,
    CASTED_SHADOWS: 2,
    ENTITIES: 3,
    LIGHTING: 4,
  };

  constructor() {
    // Renderer configuration options (set during initialize)
    this.ySorting = false;
    this.bgTextureName = null;

    // PIXI application and rendering
    this.pixiApp = null;
    this.particleContainer = null;
    this.backgroundSprite = null;

    // Texture and spritesheet storage
    this.textures = {};
    this.spritesheets = {};

    // Entity rendering
    this.bodySprites = [];
    this.entitySpriteConfigs = {};
    this.previousAnimStates = [];

    // Manual animation tracking
    this.currentAnimationFrames = [];
    this.currentFrameIndex = [];
    this.frameAccumulator = [];
    this.animationSpeed = [];

    // Particle rendering
    this.particleSprites = [];
    this.maxParticles = 0;
    this.particleTextureCache = {};

    // World and viewport dimensions
    this.worldWidth = 0;
    this.worldHeight = 0;
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.canvas = null;

    // Camera data (Float32Array view of SharedArrayBuffer)
    this.cameraData = null;

    // Entity count
    this.entityCount = 0;

    // Config reference
    this.config = null;

    // Debug visualization
    this.debugLayer = null;
    this.debugFlags = null;
    this.debugColors = {
      collider: 0x00ff00,
      trigger: 0xffff00,
      velocity: 0x0088ff,
      acceleration: 0xff0044,
      neighbor: 0x00ffff,
      grid: 0x444444,
      aabb: 0xff8800,
      text: 0xffffff,
    };

    // Per-instance spritesheet tracking
    this.currentSpritesheetIds = null;

    // Y-SORTING POOL (GC optimization)
    this._ySortPool = [];
    this._ySortPoolSize = 0;

    // DECALS TILEMAP SYSTEM
    this.decalsEnabled = false;
    this.decalsTileSize = 256;
    this.decalsTilePixelSize = 256;
    this.decalsResolution = 1.0;
    this.decalsTilesX = 0;
    this.decalsTilesY = 0;
    this.decalsTotalTiles = 0;
    this.decalTilesRGBA = null;
    this.decalTilesDirty = null;
    this.decalTileContainer = null;
    this.decalTileSprites = [];
    this.decalTileTextureSources = [];

    // LIGHTING SYSTEM
    this.lightingEnabled = false;
    this.lightingMesh = null;
    this.lightingShader = null;
    this.lightingAmbient = 0.05;
    this.maxLights = 128;

    // SHADOW SPRITE SYSTEM
    this.shadowSpritesEnabled = false;
    this.maxShadowSprites = 0;
    this.shadowSpriteContainer = null;
    this.shadowSprites = [];
    this.shadowConeTexture = null;

    // Frame timing
    this.lastFrameTime = performance.now();
    this.frameNumber = 0;

    // Running state
    this.running = false;
    this.paused = false;
  }

  /**
   * Initialize the renderer with game engine data
   * @param {Object} data - Initialization data from GameEngine
   */
  async initialize(data) {
    console.log("RENDERER: Initializing WebGPU renderer on main thread...");

    this.entityCount = data.entityCount;
    this.config = data.config;
    this.worldWidth = data.config.worldWidth;
    this.worldHeight = data.config.worldHeight;
    this.canvasWidth = data.config.canvasWidth;
    this.canvasHeight = data.config.canvasHeight;
    this.canvas = data.canvas;
    this.maxParticles = data.maxParticles || 0;

    // Setup camera data view
    this.cameraData = new Float32Array(data.buffers.cameraData);

    // Read renderer-specific configuration
    const rendererConfig = this.config.renderer || {};
    this.ySorting =
      rendererConfig.ySorting !== undefined ? rendererConfig.ySorting : true;
    this.bgTextureName = rendererConfig.bg;

    // Create ParticleContainer
    this.particleContainer = new PIXI.ParticleContainer({
      dynamicProperties: {
        vertex: false,
        position: true,
        rotation: true,
        uvs: true,
        color: true,
      },
    });

    // Initialize component arrays from SharedArrayBuffers
    Transform.initializeArrays(
      data.buffers.componentData.Transform,
      this.entityCount
    );

    if (data.buffers.componentData.RigidBody) {
      RigidBody.initializeArrays(
        data.buffers.componentData.RigidBody,
        this.entityCount
      );
    }

    if (data.buffers.componentData.SpriteRenderer) {
      SpriteRenderer.initializeArrays(
        data.buffers.componentData.SpriteRenderer,
        this.entityCount
      );
    }

    if (data.buffers.componentData.ParticleComponent && this.maxParticles > 0) {
      ParticleComponent.initializeArrays(
        data.buffers.componentData.ParticleComponent,
        this.maxParticles
      );
      ParticleComponent.particleCount = this.maxParticles;
    }

    if (data.buffers.componentData.LightEmitter) {
      LightEmitter.initializeArrays(
        data.buffers.componentData.LightEmitter,
        this.entityCount
      );
    }

    // Deserialize spritesheet metadata
    if (data.spritesheetMetadata) {
      SpriteSheetRegistry.deserialize(data.spritesheetMetadata);
    }

    // Initialize neighbor data for debug rendering
    if (data.buffers.neighborData) {
      GameObject.neighborData = new Int32Array(data.buffers.neighborData);
    }

    // Create PIXI application with WebGPU preference
    this.pixiApp = new PIXI.Application();
    await this.pixiApp.init({
      width: this.canvasWidth,
      height: this.canvasHeight,
      resolution: 1,
      canvas: this.canvas,
      backgroundColor: 0x000000,
      powerPreference: "high-performance",
      preference: "webgpu", // Use WebGPU backend
    });

    // Log which renderer is being used
    console.log(
      `RENDERER: Using ${
        this.pixiApp.renderer.type === 0x02 ? "WebGPU" : "WebGL"
      } backend`
    );

    // Enable z-index based sorting on the stage
    this.pixiApp.stage.sortableChildren = true;

    // Load textures and spritesheets
    await this.loadTextures(data.textures);
    await this.loadSpritesheets(data.spritesheets, data.bigAtlasProxySheets);

    // Create background
    this.createBackground();

    // Initialize decals system
    if (data.decals && data.decals.enabled) {
      this.initializeDecals(data.decals);
    }

    // Initialize shadow system
    this.createCastedShadowsSystem(data);

    // Add particle container to stage
    this.particleContainer.zIndex = RendererWebGpu.Z_INDICES.ENTITIES;
    this.pixiApp.stage.addChild(this.particleContainer);

    // Initialize lighting system
    const lightingConfig = this.config.lighting || {};
    if (lightingConfig.enabled && data.buffers.componentData.LightEmitter) {
      this.lightingEnabled = true;
      this.lightingAmbient =
        lightingConfig.lightingAmbient !== undefined
          ? lightingConfig.lightingAmbient
          : 0.05;
      this.maxLights =
        lightingConfig.maxLights !== undefined
          ? lightingConfig.maxLights
          : DEFAULT_MAX_LIGHTS;
      this.createLightingSystem();
    }

    // Initialize debug visualization
    if (data.buffers.debugData) {
      this.debugFlags = new Uint8Array(data.buffers.debugData);
      this.debugLayer = new PIXI.Graphics();
      this.debugLayer.zIndex = 10000;
      this.pixiApp.stage.addChild(this.debugLayer);

      if (data.buffers.componentData.Collider) {
        Collider.initializeArrays(
          data.buffers.componentData.Collider,
          this.entityCount
        );
      }
    }

    // Build entity sprite configs
    this.buildEntitySpriteConfigs(data.registeredClasses);

    // Create sprites
    this.createSprites();

    // Create particle sprites
    this.createParticleSprites();

    console.log("RENDERER: Initialization complete");
  }

  /**
   * Start the render loop
   */
  start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.lastFrameTime = performance.now();

    // Use PIXI ticker for rendering
    this.pixiApp.ticker.add((ticker) => {
      if (!this.paused) {
        this.update(ticker.deltaMS);
      }
    });

    console.log("RENDERER: Started");
  }

  /**
   * Pause rendering
   */
  pause() {
    this.paused = true;
  }

  /**
   * Resume rendering
   */
  resume() {
    this.paused = false;
    this.lastFrameTime = performance.now();
  }

  /**
   * Main update method called each frame
   */
  update(deltaTime) {
    this.frameNumber++;

    this.updateCameraTransform();
    this.updateDecalTiles();
    this.updateLighting();
    this.updateShadowSprites();
    this.updateSprites(deltaTime);

    if (this.debugLayer) {
      this.renderDebugOverlays();
    }
  }

  /**
   * Update camera transform on containers
   */
  updateCameraTransform() {
    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];

    this.particleContainer.scale.set(zoom);
    this.particleContainer.x = -cameraX * zoom;
    this.particleContainer.y = -cameraY * zoom;

    if (this.backgroundSprite) {
      this.backgroundSprite.scale.set(zoom);
      this.backgroundSprite.x = -cameraX * zoom;
      this.backgroundSprite.y = -cameraY * zoom;
    }

    if (this.decalTileContainer) {
      this.decalTileContainer.scale.set(zoom);
      this.decalTileContainer.x = -cameraX * zoom;
      this.decalTileContainer.y = -cameraY * zoom;
    }

    if (this.shadowSpriteContainer) {
      this.shadowSpriteContainer.scale.set(zoom);
      this.shadowSpriteContainer.x = -cameraX * zoom;
      this.shadowSpriteContainer.y = -cameraY * zoom;
    }
  }

  /**
   * Load simple textures
   */
  async loadTextures(texturesData) {
    if (!texturesData) return;

    for (const [name, imageBitmap] of Object.entries(texturesData)) {
      const source = new PIXI.ImageSource({ resource: imageBitmap });
      this.textures[name] = new PIXI.Texture({ source });
    }
  }

  /**
   * Load spritesheets from JSON + texture data
   */
  async loadSpritesheets(spritesheetData, proxySheets = {}) {
    if (!spritesheetData) return;

    for (const [name, data] of Object.entries(spritesheetData)) {
      try {
        if (!data.imageBitmap || !data.json) {
          throw new Error(`Missing imageBitmap or json for ${name}`);
        }

        const source = new PIXI.ImageSource({ resource: data.imageBitmap });
        const jsonData = data.json;

        // Create textures for each frame
        const frameTextures = {};
        for (const [frameName, frameData] of Object.entries(jsonData.frames)) {
          const frame = frameData.frame;
          const texture = new PIXI.Texture({
            source,
            frame: new PIXI.Rectangle(frame.x, frame.y, frame.w, frame.h),
          });
          frameTextures[frameName] = texture;
        }

        // Build animation arrays
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

        this.spritesheets[name] = {
          textures: frameTextures,
          animations: animations,
          source: source,
        };

        // BigAtlas support
        if (name === "bigAtlas") {
          for (const [frameName, texture] of Object.entries(frameTextures)) {
            this.textures[frameName] = texture;
          }
          console.log(
            `RENDERER: BigAtlas loaded: ${
              Object.keys(frameTextures).length
            } frames`
          );
        }
      } catch (error) {
        console.error(`RENDERER: Failed to load spritesheet ${name}:`, error);
      }
    }

    // Create proxy spritesheet entries
    if (proxySheets && Object.keys(proxySheets).length > 0) {
      const bigAtlas = this.spritesheets["bigAtlas"];
      if (!bigAtlas) {
        console.error(
          "RENDERER: Cannot create proxy sheets: bigAtlas not loaded!"
        );
        return;
      }

      for (const [proxyName, proxyData] of Object.entries(proxySheets)) {
        const proxyAnimations = {};
        const proxyTextures = {};

        for (const [animName, animInfo] of Object.entries(
          proxyData.animations
        )) {
          const prefixedName = animInfo.prefixedName;
          if (bigAtlas.animations[prefixedName]) {
            proxyAnimations[animName] = bigAtlas.animations[prefixedName];
          }
        }

        const prefix = proxyData.prefix;
        for (const [frameName, texture] of Object.entries(bigAtlas.textures)) {
          if (frameName.startsWith(prefix)) {
            const unprefixedName = frameName.substring(prefix.length);
            proxyTextures[unprefixedName] = texture;
          }
        }

        this.spritesheets[proxyName] = {
          textures: proxyTextures,
          animations: proxyAnimations,
          source: bigAtlas.source,
          isProxy: true,
          targetSheet: "bigAtlas",
        };

        SpriteSheetRegistry.registerProxy(proxyName, proxyData);
      }
    }
  }

  /**
   * Create tiling background sprite
   */
  createBackground() {
    if (!this.bgTextureName) return;

    const bgTexture = this.textures[this.bgTextureName];
    if (!bgTexture) {
      console.warn(
        `RENDERER: Background texture "${this.bgTextureName}" not found`
      );
      return;
    }

    this.backgroundSprite = new PIXI.TilingSprite({
      texture: bgTexture,
      width: this.worldWidth,
      height: this.worldHeight,
    });
    this.backgroundSprite.tileScale.set(0.5, 0.5);
    this.backgroundSprite.tilePosition.set(0, 0);
    this.backgroundSprite.zIndex = RendererWebGpu.Z_INDICES.BACKGROUND;
    this.pixiApp.stage.addChild(this.backgroundSprite);
  }

  /**
   * Initialize decals system
   */
  initializeDecals(decalsConfig) {
    this.decalsEnabled = true;
    this.decalsTileSize = decalsConfig.tileSize;
    this.decalsTilePixelSize = decalsConfig.tilePixelSize;
    this.decalsResolution = decalsConfig.resolution;
    this.decalsTilesX = decalsConfig.tilesX;
    this.decalsTilesY = decalsConfig.tilesY;
    this.decalsTotalTiles = decalsConfig.totalTiles;

    this.decalTilesRGBA = new Uint8ClampedArray(decalsConfig.tilesRGBA);
    this.decalTilesDirty = new Uint8Array(decalsConfig.tilesDirty);

    this.decalTileContainer = new PIXI.Container();
    this.decalTileContainer.zIndex = RendererWebGpu.Z_INDICES.DECALS;

    this.createDecalTileSprites();
    this.pixiApp.stage.addChild(this.decalTileContainer);
  }

  /**
   * Create sprites for each decal tile
   */
  createDecalTileSprites() {
    const tileSize = this.decalsTileSize;

    for (let ty = 0; ty < this.decalsTilesY; ty++) {
      for (let tx = 0; tx < this.decalsTilesX; tx++) {
        const tileIndex = tx + ty * this.decalsTilesX;

        const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
        sprite.x = tx * tileSize;
        sprite.y = ty * tileSize;
        sprite.width = tileSize;
        sprite.height = tileSize;
        sprite.visible = false;

        this.decalTileSprites[tileIndex] = sprite;
        this.decalTileTextureSources[tileIndex] = null;
        this.decalTileContainer.addChild(sprite);
      }
    }
  }

  /**
   * Update decal tile textures for dirty tiles
   */
  updateDecalTiles() {
    if (!this.decalsEnabled) return;

    const tilePixelSize = this.decalsTilePixelSize;
    const bytesPerTile = tilePixelSize * tilePixelSize * 4;

    for (let tileIndex = 0; tileIndex < this.decalsTotalTiles; tileIndex++) {
      if (this.decalTilesDirty[tileIndex] === 0) continue;

      this.decalTilesDirty[tileIndex] = 0;

      const tileByteOffset = tileIndex * bytesPerTile;
      const tileRGBAShared = new Uint8ClampedArray(
        this.decalTilesRGBA.buffer,
        tileByteOffset,
        bytesPerTile
      );

      const tileRGBA = new Uint8ClampedArray(tileRGBAShared);
      const imageData = new ImageData(tileRGBA, tilePixelSize, tilePixelSize);

      const sprite = this.decalTileSprites[tileIndex];

      createImageBitmap(imageData).then((bitmap) => {
        const source = new PIXI.ImageSource({ resource: bitmap });
        sprite.texture = new PIXI.Texture({ source });
        sprite.visible = true;
      });
    }
  }

  /**
   * Create the lighting system
   */
  createLightingSystem() {
    const vertexSrc = buildVertexShaderGLSL();
    const fragmentSrc = buildFragmentShaderGLSL(this.maxLights);

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

    // Pre-allocate Float32Arrays for light uniforms
    this._lightX = new Float32Array(this.maxLights);
    this._lightY = new Float32Array(this.maxLights);
    this._lightIntensity = new Float32Array(this.maxLights);
    this._lightR = new Float32Array(this.maxLights).fill(1);
    this._lightG = new Float32Array(this.maxLights).fill(1);
    this._lightB = new Float32Array(this.maxLights).fill(1);

    this.lightingShader = new PIXI.Shader({
      glProgram,
      resources: {
        uniforms: {
          uCameraPos: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
          uZoom: { value: 1.0, type: "f32" },
          uViewport: {
            value: new Float32Array([this.canvasWidth, this.canvasHeight]),
            type: "vec2<f32>",
          },
          uLightX: { value: this._lightX, type: "f32", size: this.maxLights },
          uLightY: { value: this._lightY, type: "f32", size: this.maxLights },
          uLightIntensity: {
            value: this._lightIntensity,
            type: "f32",
            size: this.maxLights,
          },
          uLightR: { value: this._lightR, type: "f32", size: this.maxLights },
          uLightG: { value: this._lightG, type: "f32", size: this.maxLights },
          uLightB: { value: this._lightB, type: "f32", size: this.maxLights },
          uLightCount: { value: 0, type: "i32" },
          uAmbient: { value: this.lightingAmbient, type: "f32" },
        },
      },
    });

    this.lightingMesh = new PIXI.Mesh({
      geometry,
      shader: this.lightingShader,
    });
    this.lightingMesh.blendMode = "multiply";
    this.lightingMesh.zIndex = RendererWebGpu.Z_INDICES.LIGHTING;

    this.pixiApp.stage.addChild(this.lightingMesh);

    console.log(
      `RENDERER: Lighting system enabled (ambient: ${this.lightingAmbient}, maxLights: ${this.maxLights})`
    );
  }

  /**
   * Update lighting shader uniforms
   */
  updateLighting() {
    if (!this.lightingEnabled || !this.lightingShader) return;

    const uniformGroup = this.lightingShader.resources.uniforms;

    const active = Transform.active;
    const worldX = Transform.x;
    const worldY = Transform.y;
    const lightEnabled = LightEmitter.active;
    const lightColor = LightEmitter.lightColor;
    const lightIntensity = LightEmitter.lightIntensity;

    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];

    uniformGroup.uniforms.uCameraPos[0] = cameraX;
    uniformGroup.uniforms.uCameraPos[1] = cameraY;
    uniformGroup.uniforms.uZoom = zoom;

    const lightX = this._lightX;
    const lightY = this._lightY;
    const lightIntensityArr = this._lightIntensity;
    const lightR = this._lightR;
    const lightG = this._lightG;
    const lightB = this._lightB;

    let lightIndex = 0;

    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i] || !lightEnabled[i]) continue;
      if (lightIndex >= this.maxLights) break;

      const color = lightColor[i];

      lightX[lightIndex] = worldX[i];
      lightY[lightIndex] = worldY[i];
      lightIntensityArr[lightIndex] = lightIntensity[i];

      lightR[lightIndex] = ((color >> 16) & 0xff) / 255;
      lightG[lightIndex] = ((color >> 8) & 0xff) / 255;
      lightB[lightIndex] = (color & 0xff) / 255;

      lightIndex++;
    }

    uniformGroup.uniforms.uLightCount = lightIndex;
  }

  /**
   * Create shadow sprite system
   */
  createCastedShadowsSystem(data) {
    if (data.shadows && data.shadows.enabled && data.shadows.spriteData) {
      this.shadowSpritesEnabled = true;
      this.maxShadowSprites = data.shadows.maxShadowSprites;

      // Create typed array views for shadow sprite data
      this.shadowSpriteActive = new Uint8Array(
        data.shadows.spriteData,
        0,
        this.maxShadowSprites
      );

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

      this.createShadowSpriteSystem();
      this.pixiApp.stage.addChild(this.shadowSpriteContainer);

      console.log(
        `RENDERER: Shadow sprites enabled (${this.maxShadowSprites} sprites)`
      );
    }
  }

  /**
   * Create shadow sprite container and texture
   */
  createShadowSpriteSystem() {
    const width = 64;
    const height = 128;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    ctx.filter = "blur(4px)";

    const gradient = ctx.createLinearGradient(width / 2, 0, width / 2, height);
    gradient.addColorStop(0, "rgba(0, 0, 0, 0.5)");
    gradient.addColorStop(0.3, "rgba(0, 0, 0, 0.35)");
    gradient.addColorStop(0.7, "rgba(0, 0, 0, 0.15)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");

    ctx.fillStyle = gradient;
    ctx.beginPath();

    const topLeft = { x: width * 0.35, y: 8 };
    const topRight = { x: width * 0.65, y: 8 };
    const bottomLeft = { x: width * 0.15, y: height - 8 };
    const bottomRight = { x: width * 0.85, y: height - 8 };

    ctx.moveTo(topLeft.x, topLeft.y);
    ctx.quadraticCurveTo(width / 2, topLeft.y - 6, topRight.x, topRight.y);
    ctx.lineTo(bottomRight.x, bottomRight.y);
    ctx.quadraticCurveTo(
      width / 2,
      bottomRight.y + 10,
      bottomLeft.x,
      bottomLeft.y
    );
    ctx.lineTo(topLeft.x, topLeft.y);
    ctx.closePath();
    ctx.fill();

    ctx.filter = "none";

    createImageBitmap(canvas).then((bitmap) => {
      const source = new PIXI.ImageSource({ resource: bitmap });
      this.shadowConeTexture = new PIXI.Texture({ source });
      this.createShadowSprites();
    });

    this.shadowSpriteContainer = new PIXI.ParticleContainer({
      blendMode: "multiply",
      dynamicProperties: {
        vertex: true,
        position: true,
        rotation: true,
        uvs: true,
        color: true,
      },
    });
    this.shadowSpriteContainer.zIndex = RendererWebGpu.Z_INDICES.CASTED_SHADOWS;
  }

  /**
   * Create pool of shadow sprites
   */
  createShadowSprites() {
    if (!this.shadowConeTexture) return;

    for (let i = 0; i < this.maxShadowSprites; i++) {
      const shadowSprite = new PIXI.Particle({
        texture: this.shadowConeTexture,
        anchorX: 0.5,
        anchorY: 0,
      });

      shadowSprite.visible = false;
      this.shadowSprites[i] = shadowSprite;
      this.shadowSpriteContainer.addParticle(shadowSprite);
    }
  }

  /**
   * Update shadow sprites from buffer
   */
  updateShadowSprites() {
    if (!this.shadowSpritesEnabled || !this.shadowSpriteActive) return;

    const sprites = this.shadowSprites;
    const maxSprites = this.maxShadowSprites;

    const active = this.shadowSpriteActive;
    const x = this.shadowSpriteX;
    const y = this.shadowSpriteY;
    const rotation = this.shadowSpriteRotation;
    const scaleX = this.shadowSpriteScaleX;
    const scaleY = this.shadowSpriteScaleY;
    const alpha = this.shadowSpriteAlpha;

    for (let i = 0; i < maxSprites; i++) {
      const sprite = sprites[i];
      if (!sprite) continue;

      if (!active[i]) {
        sprite.alpha = 0;
        continue;
      }

      sprite.x = x[i];
      sprite.y = y[i];
      sprite.rotation = rotation[i];
      sprite.scaleX = scaleX[i];
      sprite.scaleY = scaleY[i];
      sprite.alpha = alpha[i];
    }
  }

  /**
   * Build entity sprite configs
   */
  buildEntitySpriteConfigs(registeredClasses) {
    for (const registration of registeredClasses) {
      if (registration.count === 0) continue;
      if (!registration.components?.includes("SpriteRenderer")) continue;

      const entityType = registration.entityType;
      if (entityType === undefined || typeof entityType !== "number") continue;

      this.entitySpriteConfigs[entityType] = { hasSpriteRenderer: true };
    }
  }

  /**
   * Create sprites for all entities
   */
  createSprites() {
    this.currentSpritesheetIds = new Uint8Array(this.entityCount);

    for (let i = 0; i < this.entityCount; i++) {
      const entityType = Transform.entityType[i];
      const config = this.entitySpriteConfigs[entityType];

      if (!config || !config.hasSpriteRenderer) {
        this.bodySprites[i] = null;
        this.currentAnimationFrames[i] = [];
        this.currentFrameIndex[i] = 0;
        this.frameAccumulator[i] = 0;
        this.animationSpeed[i] = 0;
        continue;
      }

      const bodySprite = new PIXI.Particle({
        texture: PIXI.Texture.WHITE,
        anchorX: 0.5,
        anchorY: 0.5,
      });

      this.bodySprites[i] = bodySprite;
      this.previousAnimStates[i] = -1;
      this.currentAnimationFrames[i] = [];
      this.currentFrameIndex[i] = 0;
      this.frameAccumulator[i] = 0;
      this.animationSpeed[i] = 0;
      this.currentSpritesheetIds[i] = 0;

      if (!this.ySorting) {
        this.particleContainer.addParticle(bodySprite);
      }
    }
  }

  /**
   * Create particle sprites
   */
  createParticleSprites() {
    if (this.maxParticles === 0) return;

    for (let i = 0; i < this.maxParticles; i++) {
      const particleSprite = new PIXI.Particle({
        texture: PIXI.Texture.WHITE,
        anchorX: 0.5,
        anchorY: 0.5,
      });

      particleSprite.visible = false;
      this.particleSprites[i] = particleSprite;

      if (!this.ySorting) {
        this.particleContainer.addParticle(particleSprite);
      }
    }
  }

  /**
   * Update all sprites
   */
  updateSprites(deltaTime) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const rotation = Transform.rotation;

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
    const renderDirty = SpriteRenderer.renderDirty;

    const deltaSeconds = deltaTime / 1000;

    this._ySortPoolSize = 0;

    for (let i = 0; i < this.entityCount; i++) {
      const bodySprite = this.bodySprites[i];
      if (!bodySprite) continue;

      const shouldBeVisible = active[i] && renderVisible[i] && isItOnScreen[i];

      if (!shouldBeVisible) {
        if (bodySprite.visible) {
          bodySprite.visible = false;
        }
        continue;
      }

      if (this.ySorting) {
        if (!bodySprite.visible) {
          bodySprite.visible = true;
        }
        const poolIdx = this._ySortPoolSize++;
        if (!this._ySortPool[poolIdx]) {
          this._ySortPool[poolIdx] = { entityId: 0, sprite: null, y: 0 };
        }
        const item = this._ySortPool[poolIdx];
        item.entityId = i;
        item.sprite = bodySprite;
        item.y = y[i];
      } else {
        if (!bodySprite.visible) {
          bodySprite.visible = true;
        }
      }

      bodySprite.x = x[i];
      bodySprite.y = y[i];
      bodySprite.rotation = rotation[i];

      if (bodySprite.scaleX !== scaleX[i]) bodySprite.scaleX = scaleX[i];
      if (bodySprite.scaleY !== scaleY[i]) bodySprite.scaleY = scaleY[i];
      if (bodySprite.anchorX !== anchorX[i]) bodySprite.anchorX = anchorX[i];
      if (bodySprite.anchorY !== anchorY[i]) bodySprite.anchorY = anchorY[i];

      if (renderDirty[i]) {
        const spritesheetId = SpriteRenderer.spritesheetId;
        if (
          spritesheetId &&
          this.currentSpritesheetIds &&
          this.currentSpritesheetIds[i] !== spritesheetId[i]
        ) {
          this.updateEntitySpritesheet(bodySprite, i, spritesheetId[i]);
          this.currentSpritesheetIds[i] = spritesheetId[i];
        }

        bodySprite.tint = tint[i];
        bodySprite.alpha = alpha[i];

        this.updateSpriteAnimation(bodySprite, i, animationState[i]);
        this.changeFrameOfSprite(bodySprite, i, deltaSeconds);

        this.animationSpeed[i] = animationSpeed[i];
        renderDirty[i] = 0;
      }
    }

    if (this.maxParticles > 0) {
      this.updateParticleSprites();
    }

    if (this.ySorting) {
      const pool = this._ySortPool;
      const poolSize = this._ySortPoolSize;
      pool.length = poolSize;
      pool.sort((a, b) => a.y - b.y);

      this.particleContainer.particleChildren.length = 0;

      for (let i = 0; i < poolSize; i++) {
        this.particleContainer.addParticle(pool[i].sprite);
      }

      this.particleContainer.update();
    }
  }

  /**
   * Update animation state for an entity
   */
  updateSpriteAnimation(sprite, entityId, newState) {
    if (this.previousAnimStates[entityId] === newState) return;
    this.previousAnimStates[entityId] = newState;

    const spritesheetId = SpriteRenderer.spritesheetId[entityId];
    if (!spritesheetId || spritesheetId === 0) return;

    const sheetName = SpriteSheetRegistry.getSpritesheetName(spritesheetId);
    if (!sheetName) return;

    const sheet = this.spritesheets[sheetName];
    if (!sheet || !sheet.animations) return;

    const animName = SpriteSheetRegistry.getAnimationName(sheetName, newState);
    if (!animName || !sheet.animations[animName]) return;

    const frames = sheet.animations[animName];
    this.currentAnimationFrames[entityId] = frames;
    this.currentFrameIndex[entityId] = 0;
    this.frameAccumulator[entityId] = 0;

    if (frames.length > 0) {
      sprite.texture = frames[0];
    }
  }

  /**
   * Update entity spritesheet
   */
  updateEntitySpritesheet(sprite, entityId, newSpritesheetId) {
    if (newSpritesheetId === 0) return;

    const targetName = SpriteSheetRegistry.getSpritesheetName(newSpritesheetId);
    if (!targetName) return;

    const sheet = this.spritesheets[targetName];

    if (sheet && sheet.animations && Object.keys(sheet.animations).length > 0) {
      this.setAnimatedSpritesheet(sprite, entityId, targetName, sheet);
    } else {
      const texture = this.textures[targetName];
      if (texture) {
        this.setStaticTexture(sprite, entityId, texture);
      }
    }
  }

  /**
   * Set animated spritesheet on sprite
   */
  setAnimatedSpritesheet(sprite, entityId, sheetName, sheet) {
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

    if (!animName) {
      animName = SpriteSheetRegistry.getAnimationName(
        sheetName,
        currentAnimState
      );
    }

    if (!animName || !sheet.animations[animName]) {
      animName = Object.keys(sheet.animations)[0];
    }

    if (!animName) return;

    const frames = sheet.animations[animName];
    this.currentAnimationFrames[entityId] = frames;
    this.currentFrameIndex[entityId] = 0;
    this.frameAccumulator[entityId] = 0;
    sprite.texture = frames[0];

    const newIndex = SpriteSheetRegistry.getAnimationIndex(sheetName, animName);
    if (newIndex !== undefined) {
      SpriteRenderer.animationState[entityId] = newIndex;
      this.previousAnimStates[entityId] = newIndex;
    }
  }

  /**
   * Set static texture on sprite
   */
  setStaticTexture(sprite, entityId, texture) {
    sprite.texture = texture;
    this.currentAnimationFrames[entityId] = [];
    this.currentFrameIndex[entityId] = 0;
    this.frameAccumulator[entityId] = 0;
  }

  /**
   * Advance animation frame
   */
  changeFrameOfSprite(bodySprite, i, deltaSeconds) {
    const frames = this.currentAnimationFrames[i];
    if (frames && frames.length > 1) {
      this.frameAccumulator[i] += deltaSeconds;

      const frameDuration = 1 / (this.animationSpeed[i] * 60);

      if (this.frameAccumulator[i] >= frameDuration) {
        this.frameAccumulator[i] -= frameDuration;
        this.currentFrameIndex[i] =
          (this.currentFrameIndex[i] + 1) % frames.length;

        bodySprite.texture = frames[this.currentFrameIndex[i]];
      }
    }
  }

  /**
   * Update particle sprites
   */
  updateParticleSprites() {
    if (this.maxParticles === 0) return;

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

      if (!active[i] || !isItOnScreen[i]) {
        if (sprite.visible) {
          sprite.visible = false;
        }
        continue;
      }

      const renderY = y[i] + z[i];

      sprite.x = x[i];
      sprite.y = renderY;
      sprite.scaleX = scale[i];
      sprite.scaleY = scale[i];
      sprite.alpha = alpha[i];
      sprite.tint = tint[i];

      const tid = textureId[i];
      if (tid > 0 && !this.particleTextureCache[i + "_" + tid]) {
        const textureName = SpriteSheetRegistry.getAnimationName(
          "bigAtlas",
          tid
        );
        if (textureName && this.textures[textureName]) {
          sprite.texture = this.textures[textureName];
          this.particleTextureCache[i + "_" + tid] = true;
        }
      }

      if (this.ySorting) {
        if (!sprite.visible) {
          sprite.visible = true;
        }
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
        item.entityId = -1;
        item.particleIndex = i;
        item.sprite = sprite;
        item.y = y[i];
      } else {
        if (!sprite.visible) {
          sprite.visible = true;
        }
      }
    }
  }

  /**
   * Render debug overlays
   */
  renderDebugOverlays() {
    if (!this.debugLayer || !this.debugFlags) return;

    this.debugLayer.clear();

    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];
    this.debugLayer.scale.set(zoom);
    this.debugLayer.x = -cameraX * zoom;
    this.debugLayer.y = -cameraY * zoom;

    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isOnScreen = SpriteRenderer.isItOnScreen;

    if (this.debugFlags[DEBUG_FLAGS.SHOW_SPATIAL_GRID]) {
      this.renderSpatialGrid();
    }

    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i]) continue;
      if (!isOnScreen[i]) continue;

      const posX = x[i];
      const posY = y[i];

      if (this.debugFlags[DEBUG_FLAGS.SHOW_COLLIDERS]) {
        this.renderCollider(i, posX, posY);
      }

      if (this.debugFlags[DEBUG_FLAGS.SHOW_VELOCITY]) {
        this.renderVelocityVector(i, posX, posY);
      }

      if (this.debugFlags[DEBUG_FLAGS.SHOW_ACCELERATION]) {
        this.renderAccelerationVector(i, posX, posY);
      }

      if (this.debugFlags[DEBUG_FLAGS.SHOW_ENTITY_INDICES]) {
        this.renderEntityIndex(i, posX, posY);
      }
    }

    if (this.debugFlags[DEBUG_FLAGS.SHOW_NEIGHBORS]) {
      this.renderNeighborConnections();
    }
  }

  renderCollider(entityIndex, posX, posY) {
    if (!Collider) return;

    const radius = Collider.radius[entityIndex];
    if (radius === 0) return;

    const isTrigger = Collider.isTrigger[entityIndex];
    const color = isTrigger
      ? this.debugColors.trigger
      : this.debugColors.collider;

    this.debugLayer.circle(posX, posY, radius);
    this.debugLayer.stroke({
      width: 2 / this.cameraData[0],
      color,
      alpha: 0.8,
    });
  }

  renderVelocityVector(entityIndex, posX, posY) {
    if (!RigidBody) return;

    const vx = RigidBody.vx[entityIndex];
    const vy = RigidBody.vy[entityIndex];

    if (Math.abs(vx) < 0.01 && Math.abs(vy) < 0.01) return;

    const scale = 10;
    const endX = posX + vx * scale;
    const endY = posY + vy * scale;

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

  renderAccelerationVector(entityIndex, posX, posY) {
    if (!RigidBody) return;

    const ax = RigidBody.ax[entityIndex];
    const ay = RigidBody.ay[entityIndex];

    if (Math.abs(ax) < 0.01 && Math.abs(ay) < 0.01) return;

    const scale = 50;
    const endX = posX + ax * scale;
    const endY = posY + ay * scale;

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

  renderEntityIndex(entityIndex, posX, posY) {
    this.debugLayer
      .circle(posX, posY, 2 / this.cameraData[0])
      .fill({ color: this.debugColors.text, alpha: 0.8 });
  }

  renderNeighborConnections() {
    if (!GameObject.neighborData) return;

    const mouseX = Mouse.x;
    const mouseY = Mouse.y;
    const mousePresent = Mouse.isPresent;

    if (!mousePresent) return;

    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const maxNeighbors = this.config.spatial?.maxNeighbors || 100;

    const mouseOffset = 0 * (1 + maxNeighbors);
    const mouseNeighborCount = GameObject.neighborData[mouseOffset];

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

    if (closestEntity === -1) return;

    const myX = x[closestEntity];
    const myY = y[closestEntity];

    const highlightRadius = Collider.radius[closestEntity] * 1.5 || 10;
    this.debugLayer
      .circle(myX, myY, highlightRadius)
      .stroke({ width: 3 / this.cameraData[0], color: 0xffff00, alpha: 1.0 });

    const offset = closestEntity * (1 + maxNeighbors);
    const neighborCount = GameObject.neighborData[offset];

    for (let n = 0; n < neighborCount; n++) {
      const neighborIndex = GameObject.neighborData[offset + 1 + n];
      if (!active[neighborIndex]) continue;

      const neighborX = x[neighborIndex];
      const neighborY = y[neighborIndex];

      this.debugLayer
        .moveTo(myX, myY)
        .lineTo(neighborX, neighborY)
        .stroke({
          width: 2 / this.cameraData[0],
          color: this.debugColors.neighbor,
          alpha: 0.7,
        });

      this.debugLayer
        .circle(neighborX, neighborY, 3 / this.cameraData[0])
        .fill({ color: this.debugColors.neighbor, alpha: 0.5 });
    }

    this.debugLayer
      .circle(myX, myY - 20 / this.cameraData[0], 4 / this.cameraData[0])
      .fill({ color: 0xffffff, alpha: 0.9 });
  }

  renderSpatialGrid() {
    const cellSize = this.config.spatial?.cellSize || 100;
    const worldWidth = this.worldWidth;
    const worldHeight = this.worldHeight;

    for (let x = 0; x <= worldWidth; x += cellSize) {
      this.debugLayer.moveTo(x, 0).lineTo(x, worldHeight);
    }

    for (let y = 0; y <= worldHeight; y += cellSize) {
      this.debugLayer.moveTo(0, y).lineTo(worldWidth, y);
    }

    this.debugLayer.stroke({
      width: 1 / this.cameraData[0],
      color: this.debugColors.grid,
      alpha: 0.2,
    });
  }

  /**
   * Cleanup
   */
  destroy() {
    if (this.pixiApp) {
      this.pixiApp.destroy(true);
      this.pixiApp = null;
    }
    this.running = false;
    console.log("RENDERER: Destroyed");
  }
}

export default RendererWebGpu;
