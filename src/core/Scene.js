// Scene.js - Scene management with workers and entity pools
// Handles workers, SharedArrayBuffers, entity registration, and scene lifecycle
// This was previously GameEngine.js - renamed to better reflect its role

import { GameObject } from "./gameObject.js";
import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { ParticleComponent } from "../components/ParticleComponent.js";
import { ShadowCaster } from "../components/ShadowCaster.js";
// import { FlashComponent } from "../components/FlashComponent.js";
// import { LightEmitter } from "../components/LightEmitter.js";
import { SpriteSheetRegistry } from "./SpriteSheetRegistry.js";
import { setupWorkerCommunication, seededRandom } from "./utils.js";
import { DebugFlags } from "./DebugFlags.js";
import { Mouse } from "./Mouse.js";
import { Flash } from "./Flash.js";
import { BigAtlasInspector } from "./BigAtlasInspector.js";
import { MainThreadLogicHelper } from "./MainThreadLogicHelper.js";
import { Camera } from "./Camera.js";

class Scene {
  // Static declarations - override these in subclasses
  static config = {};
  static assets = {};
  static entities = []; // [[EntityClass, poolSize], ...]

  static now = Date.now();

  constructor(game) {
    this.game = game; // Reference to GameEngine orchestrator
    this.log = [];
    this.loadedTextures = null;

    // Merge static config with any runtime config
    this.config = { ...this.constructor.config };
    this.imageUrls = { ...this.constructor.assets };

    this.seed = this.config.seed || Math.random();
    this.rng = seededRandom(this.seed);
    // Make seeded random available globally for entity code
    globalThis.rng = this.rng;
    this.state = {
      pause: false,
    };

    // Apply default physics settings if not provided
    this.config = {
      gravity: { x: 0, y: 0 },
      ...this.config,
    };

    this.config.physics = {
      subStepCount: 4,
      boundaryElasticity: 0.8,
      collisionResponseStrength: 0.5,
      verletDamping: 0.995,
      minSpeedForRotation: 0.1,
      ...(this.config.physics || {}),
    };
    this.config.physics.gravity = this.config.physics.gravity ||
      this.config.gravity || { x: 0, y: 0 };
    this.config.gravity = this.config.physics.gravity;

    // State
    this.keyboard = {};
    // Mouse is accessed via Mouse static class (writes directly to SharedArrayBuffer)
    this.camera = {
      zoom: 1,
      x: 0,
      y: 0,
    };

    // Get number of logic workers from config
    this.numberOfLogicWorkers = this.config.logic?.numberOfLogicWorkers ?? 1;

    // Workers
    this.workers = {
      spatial: null,
      logicWorkers: [],
      physics: null,
      renderer: null,
      particle: null,
    };

    this.pendingPhysicsUpdates = [];

    const scene = this;
    this.physics = new Proxy(this.config.physics, {
      get(target, prop) {
        return target[prop];
      },
      set(target, prop, value) {
        target[prop] = value;
        scene.updatePhysicsConfig({ [prop]: value });
        return true;
      },
    });

    // Worker synchronization
    this.workerReadyStates = {
      spatial: false,
      physics: false,
      renderer: false,
    };
    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      this.workerReadyStates[`logic${i}`] = false;
    }
    this.hasParticles = !!(this.config.particle?.maxParticles > 0);
    if (this.hasParticles) {
      this.workerReadyStates.particle = false;
    }
    this.totalWorkers =
      3 + this.numberOfLogicWorkers + (this.hasParticles ? 1 : 0);

    // Shared buffers
    this.buffers = {
      gameObjectData: null,
      neighborData: null,
      distanceData: null,
      collisionData: null,
      inputData: null,
      cameraData: null,
      syncData: null,
      jobQueueData: null,
      debugData: null,
      componentData: {
        Transform: null,
        RigidBody: null,
        Collider: null,
        SpriteRenderer: null,
      },
    };

    // Component pool tracking
    this.componentPools = {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      Collider: { ComponentClass: Collider },
      SpriteRenderer: { ComponentClass: SpriteRenderer },
    };

    // Particle pool size
    this.maxParticles = this.config.particle?.maxParticles || 0;

    // Shadow sprite system
    const lightingConfig = this.config.lighting || {};
    this.shadowsEnabled =
      lightingConfig.enabled && lightingConfig.shadowsEnabled !== false;
    this.maxShadowCastingLights = lightingConfig.maxShadowCastingLights || 20;
    this.maxShadowsPerLight = lightingConfig.maxShadowsPerLight || 15;
    this.maxShadowsPerEntity = lightingConfig.maxShadowsPerEntity || 0;
    this.maxShadowSprites =
      this.maxShadowCastingLights * this.maxShadowsPerLight;

    // Blood decals tilemap system
    this.decalsEnabled = this.config.particle?.decals || false;
    this.decalsTileSize = this.config.particle?.decalsTileSize || 256;
    this.decalsResolution = this.config.particle?.decalsResolution || 1.0;
    this.decalsTilePixelSize = Math.floor(
      this.decalsTileSize * this.decalsResolution
    );

    // Typed array views
    this.views = {
      input: null,
      camera: null,
      collision: null,
    };

    // Main thread FPS tracking
    this.mainFPS = 0;
    this.mainFPSFrameCount = 60;
    this.mainFrameTimes = new Array(this.mainFPSFrameCount).fill(16.67);
    this.mainFrameTimeIndex = 0;
    this.mainFrameTimesSum = 16.67 * this.mainFPSFrameCount;
    this.mainFPSReportInterval = 30;
    this.mainFrameNumber = 0;

    // Worker stats (populated by worker messages, read by DebugUI)
    this.workerStats = {
      spatial: { fps: 0, active: 0 },
      logic: [], // Array for multiple logic workers
      physics: { fps: 0, active: 0 },
      renderer: {
        fps: 0,
        drawCalls: 0,
        visibleEntities: 0,
        visibleParticles: 0,
      },
      particle: { fps: 0, active: 0, total: 0 },
    };
    // Initialize logic worker stats
    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      this.workerStats.logic.push({ fps: 0, active: 0 });
    }

    // Main thread job stealing
    this.mainThreadHelper = null;

    // Canvas - now provided by GameEngine
    this.canvas = game.canvas;

    // Entity registration
    this.registeredClasses = [];
    this.gameObjects = [];
    this.totalEntityCount = 0;

    // Key mapping for input buffer
    this.keyMap = {};
    let keyIndex = 0;

    // Letters a-z
    for (let i = 0; i < 26; i++) {
      this.keyMap[String.fromCharCode(97 + i)] = keyIndex++;
    }

    // Numbers 0-9
    for (let i = 0; i < 10; i++) {
      this.keyMap[String.fromCharCode(48 + i)] = keyIndex++;
    }

    // Special keys
    this.keyMap[" "] = keyIndex++;
    this.keyMap["enter"] = keyIndex++;
    this.keyMap["escape"] = keyIndex++;
    this.keyMap["tab"] = keyIndex++;
    this.keyMap["backspace"] = keyIndex++;
    this.keyMap["delete"] = keyIndex++;
    this.keyMap["shift"] = keyIndex++;
    this.keyMap["control"] = keyIndex++;
    this.keyMap["alt"] = keyIndex++;
    this.keyMap["meta"] = keyIndex++;

    // Arrow keys
    this.keyMap["arrowup"] = keyIndex++;
    this.keyMap["arrowdown"] = keyIndex++;
    this.keyMap["arrowleft"] = keyIndex++;
    this.keyMap["arrowright"] = keyIndex++;

    // Function keys F1-F12
    for (let i = 1; i <= 12; i++) {
      this.keyMap[`f${i}`] = keyIndex++;
    }

    // Punctuation
    const punctuation = [
      "-",
      "=",
      "[",
      "]",
      "\\",
      ";",
      "'",
      ",",
      ".",
      "/",
      "`",
    ];
    punctuation.forEach((char) => {
      this.keyMap[char] = keyIndex++;
    });

    this.inputBufferSize = keyIndex;

    // Frame timing
    this.lastFrameTime = performance.now();
    this.updateRate = 1000 / 60;
    this.animationFrameId = null; // Store RAF ID so we can cancel it

    // Initialization promise
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    // CRITICAL: Auto-register Mouse FIRST
    this.registerEntityClass(Mouse, 1);

    // Auto-register Flash if lighting is enabled
    this.maxFlashes = this.config.lighting?.maxFlashes || 0;
    if (this.maxFlashes > 0) {
      this.registerEntityClass(Flash, this.maxFlashes);
      Flash.initialize(this.maxFlashes);
    }

    // Register entities from static declaration
    for (const [EntityClass, poolSize] of this.constructor.entities) {
      this.registerEntityClass(EntityClass, poolSize);
    }
  }

  /**
   * Register an entity class
   */
  registerEntityClass(EntityClass, count, scriptPath = null) {
    // Auto-detect script path
    if (!scriptPath && EntityClass.scriptUrl) {
      scriptPath = this._urlToPath(EntityClass.scriptUrl);
    }

    // Auto-detect and register parent classes
    this._autoRegisterParentClasses(EntityClass);

    // Collect components
    const components = GameObject._collectComponents(EntityClass);

    // Check if already registered
    const existing = this.registeredClasses.find(
      (r) => r.class === EntityClass || r.class.name === EntityClass.name
    );
    if (existing) {
      console.warn(
        `⚠️ ${EntityClass.name} is already registered. Skipping duplicate.`
      );
      return;
    }

    const startIndex = this.totalEntityCount;
    const entityTypeId = this.registeredClasses.length;
    EntityClass.entityType = entityTypeId;

    // Register custom components
    for (const ComponentClass of components) {
      const componentName = ComponentClass.name;
      if (!this.componentPools[componentName]) {
        this.componentPools[componentName] = {
          ComponentClass: ComponentClass,
        };
      }
    }

    this.registeredClasses.push({
      class: EntityClass,
      count: count,
      startIndex: startIndex,
      entityType: entityTypeId,
      scriptPath: scriptPath,
      components: components,
    });

    this.totalEntityCount += count;

    // Auto-initialize static properties
    if (!EntityClass.hasOwnProperty("instances")) {
      EntityClass.instances = [];
    }

    EntityClass.startIndex = startIndex;
    EntityClass.totalCount = count;
  }

  _urlToPath(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.pathname;
    } catch (e) {
      return url;
    }
  }

  _autoRegisterParentClasses(EntityClass) {
    const parentChain = [];
    let current = EntityClass;

    while (current && current !== GameObject) {
      parentChain.unshift(current);
      current = Object.getPrototypeOf(current);
    }

    for (const ParentClass of parentChain) {
      const alreadyRegistered = this.registeredClasses.some(
        (r) => r.class === ParentClass || r.class.name === ParentClass.name
      );

      if (!alreadyRegistered && ParentClass !== EntityClass) {
        const startIndex = this.totalEntityCount;
        const parentComponents = GameObject._collectComponents(ParentClass);

        for (const ComponentClass of parentComponents) {
          const componentName = ComponentClass.name;
          if (!this.componentPools[componentName]) {
            this.componentPools[componentName] = {
              ComponentClass: ComponentClass,
            };
          }
        }

        const entityTypeId = this.registeredClasses.length;
        ParentClass.entityType = entityTypeId;

        this.registeredClasses.push({
          class: ParentClass,
          count: 0,
          startIndex: startIndex,
          entityType: entityTypeId,
          scriptPath: null,
          components: parentComponents,
        });

        if (!ParentClass.hasOwnProperty("sharedBuffer")) {
          ParentClass.sharedBuffer = null;
        }
        if (!ParentClass.hasOwnProperty("entityCount")) {
          ParentClass.entityCount = 0;
        }
        if (!ParentClass.hasOwnProperty("instances")) {
          ParentClass.instances = [];
        }
      }
    }
  }

  // Initialize everything
  async init() {
    console.log(`🎬 Scene ${this.constructor.name}: Initializing...`);

    // Check SharedArrayBuffer support
    if (typeof SharedArrayBuffer === "undefined") {
      throw new Error("SharedArrayBuffer not available! Check CORS headers.");
    }

    // Create shared buffers
    this.createSharedBuffers();

    // Create workers
    await this.createWorkers();

    // Setup event listeners
    this.setupEventListeners();

    // Start main loop
    this.startMainLoop();

    // Update entity count display
    const numberBoidsElement = document.getElementById("numberBoids");
    if (numberBoidsElement) {
      numberBoidsElement.textContent = `Number of entities: ${this.totalEntityCount}`;
    }

    // Wait for all workers to be ready
    await this.readyPromise;

    // Initialize main thread helper
    this.initMainThreadHelper();

    console.log(`✅ Scene ${this.constructor.name}: Initialized!`);

    // Call user's create() hook
    this.create();
  }

  // User lifecycle hooks - override these in subclasses
  create() {
    // Override this to spawn initial entities
  }

  /**
   * Called once per frame on the main thread.
   *
   * Override this method in subclasses to implement per-frame scene logic.
   * Runs after all core engine updates and before rendering.
   *
   * @param {number} time - The current high-resolution timestamp (ms).
   * @param {number} delta - The time elapsed since the last frame (ms).
   */
  update(time, delta) {
    // Override this for per-frame scene logic
  }

  // ... (rest of the methods from GameEngine.js - kept exactly the same)
  // I'll include the essential ones inline and reference the rest

  initMainThreadHelper() {
    const enabled = this.config.logic?.useMainThreadAsLogicWorker ?? false;
    if (!enabled) return;

    this.mainThreadHelper = new MainThreadLogicHelper(this);
    this.mainThreadHelper.initialize();

    const maxJobsPerFrame = this.config.logic?.mainThreadMaxJobsPerFrame ?? 0;
    this.mainThreadHelper.setMaxJobsPerFrame(maxJobsPerFrame);
  }

  createSharedBuffers() {
    // Verify Mouse is at index 0
    if (Mouse.startIndex !== 0) {
      throw new Error(
        `INTERNAL ERROR: Mouse should be at index 0 but got startIndex=${Mouse.startIndex}`
      );
    }

    // GameObject entity metadata buffer
    const gameObjectBufferSize = GameObject.getBufferSize(
      this.totalEntityCount
    );
    this.buffers.gameObjectData = new SharedArrayBuffer(gameObjectBufferSize);

    // Neighbor data buffer
    const maxNeighbors =
      this.config.spatial?.maxNeighbors || this.config.maxNeighbors || 100;
    const NEIGHBOR_BUFFER_SIZE = this.totalEntityCount * (1 + maxNeighbors) * 4;
    this.buffers.neighborData = new SharedArrayBuffer(NEIGHBOR_BUFFER_SIZE);

    const DISTANCE_BUFFER_SIZE = this.totalEntityCount * (1 + maxNeighbors) * 4;
    this.buffers.distanceData = new SharedArrayBuffer(DISTANCE_BUFFER_SIZE);

    GameObject.initializeArrays(
      this.buffers.gameObjectData,
      this.totalEntityCount,
      this.buffers.neighborData,
      this.buffers.distanceData
    );

    // Create Component buffers
    for (const [componentName, pool] of Object.entries(this.componentPools)) {
      if (pool.ComponentClass) {
        const ComponentClass = pool.ComponentClass;
        const bufferSize = ComponentClass.getBufferSize(this.totalEntityCount);
        this.buffers.componentData[componentName] = new SharedArrayBuffer(
          bufferSize
        );
        ComponentClass.initializeArrays(
          this.buffers.componentData[componentName],
          this.totalEntityCount
        );
      }
    }

    // ParticleComponent buffer
    if (this.hasParticles && this.maxParticles > 0) {
      const particleBufferSize = ParticleComponent.getBufferSize(
        this.maxParticles
      );
      this.buffers.componentData.ParticleComponent = new SharedArrayBuffer(
        particleBufferSize
      );
      ParticleComponent.initializeArrays(
        this.buffers.componentData.ParticleComponent,
        this.maxParticles
      );
      ParticleComponent.particleCount = this.maxParticles;
    }

    // Shadow sprite system
    if (this.shadowsEnabled && this.maxShadowSprites > 0) {
      const shadowSpriteBufferSize = ShadowCaster.getBufferSize(
        this.maxShadowSprites
      );
      this.buffers.shadowSpriteData = new SharedArrayBuffer(
        shadowSpriteBufferSize
      );
    }

    // Blood decals tilemap
    if (this.decalsEnabled) {
      const tileSize = this.decalsTileSize;
      const tilePixelSize = this.decalsTilePixelSize;
      const worldWidth = this.config.worldWidth;
      const worldHeight = this.config.worldHeight;

      const tilesX = Math.ceil(worldWidth / tileSize);
      const tilesY = Math.ceil(worldHeight / tileSize);
      const totalTiles = tilesX * tilesY;

      const bytesPerTile = tilePixelSize * tilePixelSize * 4;
      const totalTileBytes = totalTiles * bytesPerTile;

      this.buffers.bloodTilesRGBA = new SharedArrayBuffer(totalTileBytes);
      this.buffers.bloodTilesDirty = new SharedArrayBuffer(totalTiles);

      this.decalsTilesX = tilesX;
      this.decalsTilesY = tilesY;
      this.decalsTotalTiles = totalTiles;
    }

    // Pre-initialize entityType values
    this.preInitializeEntityTypeArrays();

    // Collision data buffer
    const maxCollisionPairs =
      this.config.physics?.maxCollisionPairs ||
      this.config.maxCollisionPairs ||
      10000;
    const COLLISION_BUFFER_SIZE = (1 + maxCollisionPairs * 2) * 4;
    this.buffers.collisionData = new SharedArrayBuffer(COLLISION_BUFFER_SIZE);
    this.views.collision = new Int32Array(this.buffers.collisionData);
    this.views.collision[0] = 0;

    const INPUT_BUFFER_SIZE = this.inputBufferSize * 4;
    this.buffers.inputData = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    this.views.input = new Int32Array(this.buffers.inputData);

    // Camera buffer
    const CAMERA_BUFFER_SIZE = 3 * 4;
    this.buffers.cameraData = new SharedArrayBuffer(CAMERA_BUFFER_SIZE);
    this.views.camera = new Float32Array(this.buffers.cameraData);
    this.views.camera[0] = this.camera.zoom;

    // Initialize Camera static class with shared buffer
    Camera.initialize(
      this.views.camera,
      this.config.canvasWidth,
      this.config.canvasHeight
    );

    // Set world bounds for camera clamping
    if (this.config.worldWidth && this.config.worldHeight) {
      Camera.setWorldBounds(this.config.worldWidth, this.config.worldHeight);
    }

    // Debug buffer
    const DEBUG_BUFFER_SIZE = 32;
    this.buffers.debugData = new SharedArrayBuffer(DEBUG_BUFFER_SIZE);
    this.debugFlags = new DebugFlags(this.buffers.debugData);

    // Synchronization buffer
    const SYNC_BUFFER_SIZE = 5 * 4;
    this.buffers.syncData = new SharedArrayBuffer(SYNC_BUFFER_SIZE);
    const syncView = new Int32Array(this.buffers.syncData);
    syncView[0] = 0;
    syncView[1] = 0;

    this.mainThreadJobStealingEnabled =
      this.config.logic?.useMainThreadAsLogicWorker ?? false;
    const totalWorkers = this.mainThreadJobStealingEnabled
      ? this.numberOfLogicWorkers + 1
      : this.numberOfLogicWorkers;
    syncView[2] = totalWorkers;
    syncView[3] = 0;
    syncView[4] = 1;

    // Job queue buffer
    const entitiesPerJob = this.config.logic?.numberOfEntitiesPerJob || 250;
    const totalJobs = Math.ceil(this.totalEntityCount / entitiesPerJob);
    const JOB_QUEUE_SIZE = (2 + totalJobs * 2) * 4;
    this.buffers.jobQueueData = new SharedArrayBuffer(JOB_QUEUE_SIZE);
    const jobQueueView = new Int32Array(this.buffers.jobQueueData);
    jobQueueView[0] = 0;
    jobQueueView[1] = totalJobs;

    for (let i = 0; i < totalJobs; i++) {
      const startIndex = i * entitiesPerJob;
      const endIndex = Math.min(
        (i + 1) * entitiesPerJob,
        this.totalEntityCount
      );
      jobQueueView[2 + i * 2] = startIndex;
      jobQueueView[2 + i * 2 + 1] = endIndex;
    }

    // Center camera on world
    const worldCenterX =
      this.config.worldWidth / 2 - this.config.canvasWidth / 2;
    const worldCenterY =
      this.config.worldHeight / 2 - this.config.canvasHeight / 2;
    this.camera.x = worldCenterX;
    this.camera.y = worldCenterY;

    this.views.camera[1] = this.camera.x;
    this.views.camera[2] = this.camera.y;
  }

  preInitializeEntityTypeArrays() {
    for (let i = 0; i < this.totalEntityCount; i++) {
      for (const registration of this.registeredClasses) {
        const { class: EntityClass, startIndex, count } = registration;
        if (i >= startIndex && i < startIndex + count) {
          Transform.entityType[i] = EntityClass.entityType;
          break;
        }
      }
    }
  }

  async preloadAssets(imageUrls, spritesheetConfigs = {}) {
    this.loadedTextures = {};
    this.loadedSpritesheets = {};

    console.log("🎨 Generating BigAtlas from all assets...");

    // Transform new format to old format expected by createBigAtlas
    // New format: { textures: {...}, spritesheets: {...} }
    // Old format: { texture1: "url", texture2: "url", spritesheets: {...} }
    const flattenedAssets = {};

    if (imageUrls.textures) {
      // Flatten textures to root level
      Object.assign(flattenedAssets, imageUrls.textures);
    }

    if (imageUrls.spritesheets) {
      // Keep spritesheets nested
      flattenedAssets.spritesheets = imageUrls.spritesheets;
    }

    // If imageUrls is already in old format (no textures/spritesheets keys), use as-is
    const assetsToLoad =
      imageUrls.textures || imageUrls.spritesheets
        ? flattenedAssets
        : imageUrls;

    try {
      const bigAtlas = await SpriteSheetRegistry.createBigAtlas(assetsToLoad, {
        maxWidth: 4096,
        maxHeight: 4096,
        padding: 2,
        heuristic: "best-short-side",
      });

      const imageBitmap = await createImageBitmap(bigAtlas.canvas);

      this.loadedSpritesheets["bigAtlas"] = {
        json: bigAtlas.json,
        imageBitmap: imageBitmap,
      };

      SpriteSheetRegistry.register("bigAtlas", bigAtlas.json);

      for (const [sheetName, proxyData] of Object.entries(
        bigAtlas.proxySheets
      )) {
        SpriteSheetRegistry.registerProxy(sheetName, proxyData);
      }

      this.bigAtlasProxySheets = bigAtlas.proxySheets;
      this.bigAtlasCanvas = bigAtlas.canvas;
      this.bigAtlasJson = bigAtlas.json;

      // Extract decal textures
      if (this.decalsEnabled) {
        this.decalTextureData = this.extractDecalTextures(
          bigAtlas.canvas,
          bigAtlas.json
        );
      }

      // Make helper functions available globally
      window.downloadBigAtlas = () => {
        const link = document.createElement("a");
        link.download = `bigAtlas_${bigAtlas.json.meta.size.w}x${bigAtlas.json.meta.size.h}.png`;
        link.href = this.bigAtlasCanvas.toDataURL();
        link.click();
      };

      window.inspectBigAtlas = () => {
        BigAtlasInspector.show(this.bigAtlasCanvas, this.bigAtlasJson);
      };
    } catch (error) {
      console.error("❌ Failed to generate BigAtlas:", error);
      throw error;
    }
  }

  extractDecalTextures(atlasCanvas, atlasJson) {
    const ctx = atlasCanvas.getContext("2d");
    const textures = {};
    const animationNames = Object.keys(atlasJson.animations);

    for (let textureId = 0; textureId < animationNames.length; textureId++) {
      const animName = animationNames[textureId];
      const frameList = atlasJson.animations[animName];

      if (!frameList || frameList.length === 0) continue;

      const firstFrameName = frameList[0];
      const frameData = atlasJson.frames[firstFrameName];

      if (!frameData) continue;

      const frame = frameData.frame;
      const imageData = ctx.getImageData(frame.x, frame.y, frame.w, frame.h);

      textures[textureId] = {
        width: frame.w,
        height: frame.h,
        rgba: imageData.data.buffer,
      };
    }

    return textures;
  }

  setupWorkerCommunication() {
    const connections = [{ from: "physics", to: "renderer" }];

    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      connections.push({ from: `logic${i}`, to: "renderer" });
    }

    return setupWorkerCommunication(connections);
  }

  async createWorkers() {
    const { canvasWidth, canvasHeight, worldWidth, worldHeight } = this.config;

    const cacheBust = `?v=${Date.now()}`;
    this.workers.spatial = new Worker(
      `/src/workers/spatial_worker.js${cacheBust}`,
      {
        type: "module",
      }
    );

    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      const logicWorker = new Worker(
        `/src/workers/logic_worker.js${cacheBust}`,
        {
          type: "module",
        }
      );
      logicWorker.name = `logic${i}`;
      this.workers.logicWorkers.push(logicWorker);
    }

    this.workers.physics = new Worker(
      `/src/workers/physics_worker.js${cacheBust}`,
      {
        type: "module",
      }
    );
    this.workers.renderer = new Worker(
      `/src/workers/pixi_worker.js${cacheBust}`,
      {
        type: "module",
      }
    );

    if (this.hasParticles) {
      this.workers.particle = new Worker(
        `/src/workers/particle_worker.js${cacheBust}`,
        {
          type: "module",
        }
      );
      this.workers.particle.name = "particle";
    }

    this.workers.spatial.name = "spatial";
    this.workers.physics.name = "physics";
    this.workers.renderer.name = "renderer";

    // Preload assets
    const spritesheetConfigs = this.imageUrls.spritesheets || {};
    await this.preloadAssets(this.imageUrls, spritesheetConfigs);

    // Collect script paths
    const scriptsToLoad = [
      ...new Set(
        this.registeredClasses
          .map((r) => r.scriptPath)
          .filter((path) => path !== null && path !== undefined)
          .map((path) => {
            if (path.startsWith("/") || path.startsWith("http")) {
              return path;
            }
            if (path.startsWith("../")) {
              return path;
            }
            return `../${path}`;
          })
      ),
    ];

    const workerPorts = this.setupWorkerCommunication();

    // Create initialization data
    const initData = {
      msg: "init",
      buffers: {
        gameObjectData: this.buffers.gameObjectData,
        neighborData: this.buffers.neighborData,
        distanceData: this.buffers.distanceData,
        collisionData: this.buffers.collisionData,
        inputData: this.buffers.inputData,
        cameraData: this.buffers.cameraData,
        syncData: this.buffers.syncData,
        jobQueueData: this.buffers.jobQueueData,
        debugData: this.buffers.debugData,
        componentData: this.buffers.componentData,
      },
      entityCount: this.totalEntityCount,
      config: this.config,
      scriptsToLoad: scriptsToLoad,
      registeredClasses: this.registeredClasses.map((r) => ({
        name: r.class.name,
        count: r.count,
        startIndex: r.startIndex,
        entityType: r.entityType,
        components: r.components.map((c) => c.name),
      })),
      componentPools: Object.fromEntries(
        Object.entries(this.componentPools).map(([name, pool]) => [
          name,
          { count: this.totalEntityCount },
        ])
      ),
      keyIndexMap: this.createKeyIndexMap(),
      spritesheetMetadata: SpriteSheetRegistry.serialize(),
      maxParticles: this.maxParticles,
      decals: this.decalsEnabled
        ? {
            enabled: true,
            tileSize: this.decalsTileSize,
            tilePixelSize: this.decalsTilePixelSize,
            resolution: this.decalsResolution,
            tilesX: this.decalsTilesX,
            tilesY: this.decalsTilesY,
            totalTiles: this.decalsTotalTiles,
            tilesRGBA: this.buffers.bloodTilesRGBA,
            tilesDirty: this.buffers.bloodTilesDirty,
            textures: this.decalTextureData,
          }
        : null,
      shadows: this.shadowsEnabled
        ? {
            enabled: true,
            maxShadowCastingLights: this.maxShadowCastingLights,
            maxShadowsPerLight: this.maxShadowsPerLight,
            maxShadowsPerEntity: this.maxShadowsPerEntity,
            maxShadowSprites: this.maxShadowSprites,
            spriteData: this.buffers.shadowSpriteData,
          }
        : null,
      flashes:
        this.maxFlashes > 0
          ? {
              enabled: true,
              maxFlashes: this.maxFlashes,
              startIndex: Flash.startIndex,
            }
          : null,
    };

    // Initialize workers
    this.workers.spatial.postMessage(initData);

    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      this.workers.logicWorkers[i].postMessage(
        {
          ...initData,
          workerPorts: workerPorts[`logic${i}`],
          workerIndex: i,
          bigAtlasProxySheets: this.bigAtlasProxySheets || {},
        },
        workerPorts[`logic${i}`] ? Object.values(workerPorts[`logic${i}`]) : []
      );
    }

    this.workers.physics.postMessage(
      {
        ...initData,
        workerPorts: workerPorts.physics,
      },
      workerPorts.physics ? Object.values(workerPorts.physics) : []
    );

    if (this.hasParticles && this.workers.particle) {
      this.workers.particle.postMessage(initData);
    }

    // Initialize renderer
    const offscreenCanvas = this.canvas.transferControlToOffscreen();

    const transferables = [
      offscreenCanvas,
      ...Object.values(this.loadedTextures),
      ...Object.values(this.loadedSpritesheets).map(
        (sheet) => sheet.imageBitmap
      ),
      ...(workerPorts.renderer ? Object.values(workerPorts.renderer) : []),
    ];

    this.workers.renderer.postMessage(
      {
        ...initData,
        view: offscreenCanvas,
        textures: this.loadedTextures,
        spritesheets: this.loadedSpritesheets,
        bigAtlasProxySheets: this.bigAtlasProxySheets || {},
        workerPorts: workerPorts.renderer,
      },
      transferables
    );

    // Setup message handlers
    const allWorkers = [
      this.workers.spatial,
      ...this.workers.logicWorkers,
      this.workers.physics,
      this.workers.renderer,
      ...(this.hasParticles && this.workers.particle
        ? [this.workers.particle]
        : []),
    ];

    for (let worker of allWorkers) {
      worker.onmessage = (e) => {
        this.handleMessageFromWorker(e);
      };

      worker.onerror = (e) => {
        console.error(
          `❌ ERROR in ${worker.name} worker:\n`,
          `Message: ${e.message}\n`,
          `File: ${e.filename}:${e.lineno}:${e.colno}`,
          e
        );
      };
    }
  }

  handleMessageFromWorker(e) {
    if (e.data.msg === "fps") {
      // Store worker stats (DebugUI will read these)
      this._storeWorkerStats(
        e.currentTarget.name,
        e.data.fps,
        e.data.activeEntities,
        e.data
      );
    } else if (e.data.msg === "log") {
      this.log.push({
        worker: e.currentTarget.name,
        message: e.data.message,
        when: e.data.when - Scene.now,
      });
    } else if (e.data.msg === "workerReady") {
      this.handleWorkerReady(e.currentTarget.name);
    }
  }

  handleWorkerReady(workerName) {
    this.workerReadyStates[workerName] = true;

    if (workerName === "physics" && this.pendingPhysicsUpdates.length) {
      this.pendingPhysicsUpdates.forEach((update) => {
        this.workers.physics.postMessage({
          msg: "updatePhysicsConfig",
          config: update,
        });
      });
      this.pendingPhysicsUpdates = [];
    }

    const allReady = Object.values(this.workerReadyStates).every(
      (ready) => ready
    );

    if (allReady) {
      this.startAllWorkers();
      if (this.resolveReady) this.resolveReady();
    }
  }

  startAllWorkers() {
    const allWorkers = [
      this.workers.spatial,
      ...this.workers.logicWorkers,
      this.workers.physics,
      this.workers.renderer,
      ...(this.hasParticles && this.workers.particle
        ? [this.workers.particle]
        : []),
    ];

    for (const worker of allWorkers) {
      if (worker) {
        worker.postMessage({ msg: "start" });
      }
    }

    // Spawn the Mouse entity
    this.spawnEntity("Mouse", {});
  }

  updatePhysicsConfig(partialConfig = {}) {
    if (!partialConfig || typeof partialConfig !== "object") return;

    Object.assign(this.config.physics, partialConfig);
    const updatePayload = { ...partialConfig };

    if (
      this.workers.physics &&
      this.workerReadyStates &&
      this.workerReadyStates.physics
    ) {
      this.workers.physics.postMessage({
        msg: "updatePhysicsConfig",
        config: updatePayload,
      });
    } else {
      this.pendingPhysicsUpdates.push(updatePayload);
    }
  }

  /**
   * Store worker stats (called from worker messages, read by DebugUI)
   */
  _storeWorkerStats(id, fps, activeEntities, data = {}) {
    // Handle logic workers (logic0, logic1, etc.)
    if (id.startsWith("logic")) {
      const index = parseInt(id.replace("logic", ""), 10);
      if (this.workerStats.logic[index]) {
        this.workerStats.logic[index] = {
          fps,
          active: activeEntities || 0,
        };
      }
      return;
    }

    // Handle other workers
    switch (id) {
      case "spatial":
        this.workerStats.spatial = { fps, active: activeEntities || 0 };
        break;
      case "physics":
        this.workerStats.physics = { fps, active: activeEntities || 0 };
        break;
      case "renderer":
        this.workerStats.renderer = {
          fps,
          drawCalls: data.drawCalls || 0,
          visibleEntities: data.visibleEntities || 0,
          visibleParticles: data.visibleParticles || 0,
        };
        break;
      case "particle":
        this.workerStats.particle = {
          fps,
          active: data.activeParticles || 0,
          total: data.totalParticles || 0,
        };
        break;
    }
  }

  setupEventListeners() {
    // Store bound handlers so we can remove them later
    this._keydownHandler = (e) => {
      const key = e.key.toLowerCase();
      this.keyboard[key] = true;
      this.updateKeyboardBuffer();
    };

    this._keyupHandler = (e) => {
      const key = e.key.toLowerCase();
      this.keyboard[key] = false;
      this.updateKeyboardBuffer();
    };

    this._mousedownHandler = (e) => {
      // Skip button state updates when debug tool is active (DebugUI painter/eraser)
      if (Mouse.isDebugToolActive) return;
      if (e.button == 0) Mouse.isButton0Down = true;
      if (e.button == 1) Mouse.isButton1Down = true;
      if (e.button == 2) Mouse.isButton2Down = true;
    };

    this._mouseupHandler = (e) => {
      // Always process mouseup to prevent stuck button state
      if (e.button == 0) Mouse.isButton0Down = false;
      if (e.button == 1) Mouse.isButton1Down = false;
      if (e.button == 2) Mouse.isButton2Down = false;
    };

    this._mousemoveHandler = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      Mouse.isPresent = true;
      Mouse.setCanvasPosition(
        e.clientX - rect.left,
        e.clientY - rect.top,
        this.camera
      );
    };

    this._mouseleaveHandler = () => {
      Mouse.isPresent = false;
    };

    this._wheelHandler = (e) => {
      e.preventDefault();

      const oldZoom = this.camera.zoom;
      const newZoom = Math.max(0.1, Math.min(5, oldZoom + -e.deltaY * 0.001));

      const centerX = this.config.canvasWidth / 2;
      const centerY = this.config.canvasHeight / 2;

      const worldCenterX = centerX / oldZoom + this.camera.x;
      const worldCenterY = centerY / oldZoom + this.camera.y;

      this.camera.x = worldCenterX - centerX / newZoom;
      this.camera.y = worldCenterY - centerY / newZoom;
      this.camera.zoom = newZoom;

      this.updateCameraBuffer();
    };

    this._visibilityChangeHandler = () => {
      this.handleVisibilityChange();
    };

    window.addEventListener("keydown", this._keydownHandler);
    window.addEventListener("keyup", this._keyupHandler);
    this.canvas.addEventListener("mousedown", this._mousedownHandler);
    this.canvas.addEventListener("mouseup", this._mouseupHandler);
    this.canvas.addEventListener("mousemove", this._mousemoveHandler);
    this.canvas.addEventListener("mouseleave", this._mouseleaveHandler);
    window.addEventListener("wheel", this._wheelHandler, { passive: false });
    document.addEventListener(
      "visibilitychange",
      this._visibilityChangeHandler
    );
  }

  handleVisibilityChange() {
    const isVisible = !document.hidden;

    if (!this.mainThreadJobStealingEnabled || !this.buffers.syncData) {
      return;
    }

    const syncView = new Int32Array(this.buffers.syncData);
    Atomics.store(syncView, 4, isVisible ? 1 : 0);

    if (this.mainThreadHelper) {
      this.mainThreadHelper.setWindowVisible(isVisible);
    }
  }

  updateKeyboardBuffer() {
    const input = this.views.input;
    for (const [key, index] of Object.entries(this.keyMap)) {
      input[index] = this.keyboard[key] ? 1 : 0;
    }
  }

  updateCameraBuffer() {
    // Sync zoom from main thread to Camera (zoom controlled by main thread)
    Camera.zoom = this.camera.zoom;

    // Sync position from Camera to this.camera (position controlled by worker/entity)
    this.camera.x = Camera.x;
    this.camera.y = Camera.y;

    // Update mouse world position based on camera
    Mouse.updateWorldPosition(this.camera);
  }

  startMainLoop() {
    const loop = (currentTime) => {
      const deltaTime = currentTime - this.lastFrameTime;
      this.lastFrameTime = currentTime;

      this.updateInternal(deltaTime);

      this.mainFrameNumber++;
      this.mainFrameTimesSum -= this.mainFrameTimes[this.mainFrameTimeIndex];
      this.mainFrameTimes[this.mainFrameTimeIndex] = deltaTime;
      this.mainFrameTimesSum += deltaTime;
      this.mainFrameTimeIndex =
        (this.mainFrameTimeIndex + 1) % this.mainFPSFrameCount;

      const averageFrameTime = this.mainFrameTimesSum / this.mainFPSFrameCount;
      this.mainFPS = 1000 / averageFrameTime;

      // mainFPS is now read directly by DebugUI

      // Store the RAF ID so we can cancel it later
      this.animationFrameId = requestAnimationFrame(loop);
    };

    this.animationFrameId = requestAnimationFrame(loop);
  }

  updateInternal(deltaTime) {
    const dtRatio = deltaTime / 16.67;

    // Note: Camera following is now handled in Player.tick() which writes directly to cameraData SharedArrayBuffer
    // Main thread reads from cameraData and syncs to this.camera in updateCameraBuffer()
    this.updateCameraBuffer();

    if (this.mainThreadHelper) {
      this.mainThreadHelper.processJobs(deltaTime, dtRatio);
    }

    // Visible/active units are now read directly by DebugUI from Transform/SpriteRenderer arrays

    // Call user's update hook
    this.update(performance.now(), deltaTime);
  }

  createKeyIndexMap() {
    return this.keyMap;
  }

  async destroy() {
    console.log(`🔴 Scene ${this.constructor.name}: Destroying...`);

    // Stop the main loop immediately
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Terminate all workers
    const allWorkers = [
      this.workers.spatial,
      ...this.workers.logicWorkers,
      this.workers.physics,
      this.workers.renderer,
      ...(this.hasParticles && this.workers.particle
        ? [this.workers.particle]
        : []),
    ];

    allWorkers.forEach((worker) => {
      if (worker) worker.terminate();
    });

    // Remove event listeners
    if (this._keydownHandler) {
      window.removeEventListener("keydown", this._keydownHandler);
    }
    if (this._keyupHandler) {
      window.removeEventListener("keyup", this._keyupHandler);
    }
    if (this._mousedownHandler) {
      this.canvas.removeEventListener("mousedown", this._mousedownHandler);
    }
    if (this._mouseupHandler) {
      this.canvas.removeEventListener("mouseup", this._mouseupHandler);
    }
    if (this._mousemoveHandler) {
      this.canvas.removeEventListener("mousemove", this._mousemoveHandler);
    }
    if (this._mouseleaveHandler) {
      this.canvas.removeEventListener("mouseleave", this._mouseleaveHandler);
    }
    if (this._wheelHandler) {
      window.removeEventListener("wheel", this._wheelHandler);
    }
    if (this._visibilityChangeHandler) {
      document.removeEventListener(
        "visibilitychange",
        this._visibilityChangeHandler
      );
    }

    // Clear keyboard state
    this.keyboard = {};

    // Clear all entity instances
    for (const registration of this.registeredClasses) {
      const EntityClass = registration.class;
      if (EntityClass.instances) {
        EntityClass.instances = [];
      }
      if (EntityClass.entityCount !== undefined) {
        EntityClass.entityCount = 0;
      }
    }

    // Clear gameObjects array
    this.gameObjects = [];

    // Reset component arrays to initial state (all inactive)
    if (Transform.active) {
      for (let i = 0; i < this.totalEntityCount; i++) {
        Transform.active[i] = 0;
      }
    }
    if (RigidBody.active) {
      for (let i = 0; i < this.totalEntityCount; i++) {
        RigidBody.active[i] = 0;
      }
    }
    if (Collider.active) {
      for (let i = 0; i < this.totalEntityCount; i++) {
        Collider.active[i] = 0;
      }
    }
    if (SpriteRenderer.active) {
      for (let i = 0; i < this.totalEntityCount; i++) {
        SpriteRenderer.active[i] = 0;
      }
    }

    // Reset GameObject active array
    if (GameObject.active) {
      for (let i = 0; i < this.totalEntityCount; i++) {
        GameObject.active[i] = 0;
      }
    }

    // Clear ParticleComponent if it exists
    if (ParticleComponent.active) {
      for (let i = 0; i < this.maxParticles; i++) {
        ParticleComponent.active[i] = 0;
      }
    }

    // Clean up main thread helper
    if (this.mainThreadHelper) {
      this.mainThreadHelper = null;
    }

    // Reset Mouse state
    Mouse.isPresent = false;
    Mouse.isButton0Down = false;
    Mouse.isButton1Down = false;
    Mouse.isButton2Down = false;

    // Clear Flash if it was initialized
    if (this.maxFlashes > 0 && Flash.instances) {
      Flash.instances = [];
    }

    // Clear global rng reference
    if (globalThis.rng === this.rng) {
      globalThis.rng = null;
    }

    // Clear registered classes for next scene
    this.registeredClasses = [];
    this.totalEntityCount = 0;

    console.log(`✅ Scene ${this.constructor.name}: Destroyed!`);
  }

  pause() {
    this.state.pause = true;
    const allWorkers = [
      this.workers.spatial,
      ...this.workers.logicWorkers,
      this.workers.physics,
      this.workers.renderer,
      ...(this.hasParticles && this.workers.particle
        ? [this.workers.particle]
        : []),
    ];

    allWorkers.forEach((worker) => {
      if (worker) worker.postMessage({ msg: "pause" });
    });
  }

  resume() {
    this.state.pause = false;
    const allWorkers = [
      this.workers.spatial,
      ...this.workers.logicWorkers,
      this.workers.physics,
      this.workers.renderer,
      ...(this.hasParticles && this.workers.particle
        ? [this.workers.particle]
        : []),
    ];

    allWorkers.forEach((worker) => {
      if (worker) worker.postMessage({ msg: "resume" });
    });
  }

  spawnEntity(EntityClassOrName, spawnConfig = {}) {
    // Accept either a class or a string name
    const className =
      typeof EntityClassOrName === "function"
        ? EntityClassOrName.name
        : EntityClassOrName;

    if (this.workers.logicWorkers && this.workers.logicWorkers.length > 0) {
      this.workers.logicWorkers.forEach((worker) => {
        worker.postMessage({
          msg: "spawn",
          className: className,
          spawnConfig: spawnConfig,
        });
      });
    } else if (this.mainThreadHelper) {
      this.mainThreadHelper.spawnEntity(className, spawnConfig);
    }
  }

  despawnAllEntities(className) {
    if (this.workers.logicWorkers && this.workers.logicWorkers.length > 0) {
      this.workers.logicWorkers.forEach((worker) => {
        worker.postMessage({
          msg: "despawnAll",
          className: className,
        });
      });
    } else if (this.mainThreadHelper) {
      this.mainThreadHelper.despawnAllEntities(className);
    }
  }

  getPoolStats(EntityClass) {
    if (!EntityClass.startIndex || !EntityClass.totalCount) {
      return { total: 0, active: 0, available: 0 };
    }

    const startIndex = EntityClass.startIndex;
    const total = EntityClass.totalCount;
    let activeCount = 0;

    for (let i = startIndex; i < startIndex + total; i++) {
      if (Transform.active[i]) {
        activeCount++;
      }
    }

    return {
      total: total,
      active: activeCount,
      available: total - activeCount,
    };
  }

  enableProfiling(enabled = true) {
    if (!this.workers.logicWorkers || this.workers.logicWorkers.length === 0) {
      console.error("Logic workers not initialized");
      return;
    }

    this.workers.logicWorkers.forEach((worker) => {
      worker.postMessage({
        msg: "enableProfiling",
        enabled: enabled,
      });
    });
  }

  getJobStealingStats() {
    if (!this.mainThreadHelper) return null;
    return this.mainThreadHelper.getStats();
  }

  setJobStealingEnabled(enabled) {
    if (!this.mainThreadHelper) {
      console.warn("Main thread job stealing not initialized.");
      return;
    }
    this.mainThreadHelper.setEnabled(enabled);
  }

  setJobStealingMaxJobsPerFrame(max) {
    if (!this.mainThreadHelper) {
      console.warn("Main thread job stealing not initialized.");
      return;
    }
    this.mainThreadHelper.setMaxJobsPerFrame(max);
  }
}

export { Scene };
