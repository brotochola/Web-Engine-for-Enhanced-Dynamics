// Scene.js - Scene management with workers and entity pools
// Handles workers, SharedArrayBuffers, entity registration, and scene lifecycle
// This was previously GameEngine.js - renamed to better reflect its role

import { GameObject } from "./gameObject.js";
import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { ParticleComponent } from "../components/ParticleComponent.js";
import { DecorationComponent } from "../components/DecorationComponent.js";
import { DecorationPool } from "./DecorationPool.js";
import { ShadowCaster } from "../components/ShadowCaster.js";
// import { FlashComponent } from "../components/FlashComponent.js";
// import { LightEmitter } from "../components/LightEmitter.js";
import { SpriteSheetRegistry } from "./SpriteSheetRegistry.js";
import {
  setupWorkerCommunication,
  seededRandom,
  loadEntityScripts,
  collectAllComponentsFromClasses,
  initializeComponentViews,
  exposeComponentsGlobally,
  exposeEntityClassesGlobally,
} from "./utils.js";
import { DebugFlags } from "./DebugFlags.js";
import { Mouse } from "./Mouse.js";
import { Flash } from "./Flash.js";
import { BigAtlasInspector } from "./BigAtlasInspector.js";
import { MainThreadLogicHelper } from "./MainThreadLogicHelper.js";
import { Camera } from "./Camera.js";
import { QuerySystem } from "./QuerySystem.js";
import {
  SCENE_DEFAULTS,
  PHYSICS_DEFAULTS,
  SPATIAL_DEFAULTS,
  PARTICLE_DEFAULTS,
  DECORATION_DEFAULTS,
  LOGIC_DEFAULTS,
  RENDERER_DEFAULTS,
  LIGHTING_DEFAULTS,
} from "./ConfigDefaults.js";
import {
  RENDERER_STATS,
  PARTICLE_STATS,
  PHYSICS_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
} from "../workers/workers-utils.js";

class Scene {
  // Worker index constants for FrameRate SharedArrayBuffer
  // NOTE: Spatial workers now occupy indices 0 to N-1 (where N = numberOfSpatialWorkers)
  // Other worker indices are calculated dynamically based on numberOfSpatialWorkers
  static WORKER_INDICES = {
    SPATIAL_START: 0, // First spatial worker index
    // Dynamic indices (calculated at runtime):
    // PHYSICS: numberOfSpatialWorkers
    // RENDERER: numberOfSpatialWorkers + 1
    // PARTICLE: numberOfSpatialWorkers + 2
    // LOGIC_START: numberOfSpatialWorkers + 3
  };

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

    // Apply all default config values
    this._applyConfigDefaults();

    // State
    this.keyboard = {};
    // Mouse is accessed via Mouse static class (writes directly to SharedArrayBuffer)
    this.camera = {
      zoom: 1,
      x: 0,
      y: 0,
    };

    // Workers
    this.workers = {
      spatialWorkers: [], // Multiple spatial workers for parallel neighbor detection
      logicWorkers: [],
      physics: null,
      renderer: null,
      particle: null,
    };

    // Query system for component-based entity filtering
    this.querySystem = new QuerySystem();

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
      physics: false,
      renderer: false,
    };
    // Store worker counts for use throughout constructor
    this.numberOfSpatialWorkers = this.config.spatial.numberOfSpatialWorkers;
    for (let i = 0; i < this.numberOfSpatialWorkers; i++) {
      this.workerReadyStates[`spatial${i}`] = false;
    }
    const numberOfLogicWorkers = this.config.logic.numberOfLogicWorkers;
    for (let i = 0; i < numberOfLogicWorkers; i++) {
      this.workerReadyStates[`logic${i}`] = false;
    }
    // Particle worker always runs - it handles lighting, shadows, visibility, etc.
    this.workerReadyStates.particle = false;
    this.totalWorkers = 3 + this.numberOfSpatialWorkers + numberOfLogicWorkers; // physics, renderer, particle + spatial workers + logic workers

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
      frameRateData: null, // Real-time FPS tracking per worker
      componentData: {
        Transform: null,
        RigidBody: null,
        Collider: null,
        SpriteRenderer: null,
      },
      // Worker stat buffers (strided SharedArrayBuffers for detailed metrics)
      rendererStats: null,
      particleStats: null,
      physicsStats: null,
      spatialStats: null,
      logicStats: null,
    };

    // Component type ID tracking (similar to entityType)
    this.nextComponentId = 0;

    // Component pool tracking - assign componentId IDs to core components
    this.componentPools = {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      Collider: { ComponentClass: Collider },
      SpriteRenderer: { ComponentClass: SpriteRenderer },
    };

    // Assign componentId IDs to core components
    Transform.componentId = this.nextComponentId++;
    RigidBody.componentId = this.nextComponentId++;
    Collider.componentId = this.nextComponentId++;
    SpriteRenderer.componentId = this.nextComponentId++;

    // Typed array views
    this.views = {
      input: null,
      camera: null,
      collision: null,
      frameRate: null,
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
      spatial: [], // Array for multiple spatial workers
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
    // Initialize spatial worker stats
    for (let i = 0; i < this.numberOfSpatialWorkers; i++) {
      this.workerStats.spatial.push({ fps: 0, active: 0 });
    }
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
    const maxFlashes = this.config.lighting.maxFlashes;
    if (maxFlashes > 0) {
      this.registerEntityClass(Flash, maxFlashes);
      Flash.initialize(maxFlashes);
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

    // Register custom components and assign componentId IDs
    for (const ComponentClass of components) {
      const componentName = ComponentClass.name;
      if (!this.componentPools[componentName]) {
        this.componentPools[componentName] = {
          ComponentClass: ComponentClass,
        };
        // Assign unique componentId ID (similar to entityType)
        if (ComponentClass.componentId === undefined) {
          ComponentClass.componentId = this.nextComponentId++;
        }
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
    EntityClass.poolSize = count;
    EntityClass.endIndex = startIndex + count;

    // Pre-computed typed array of all entity indices for this class
    // Enables zero-allocation iteration: Prey.entityIndices.forEach(...)
    EntityClass.entityIndices = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      EntityClass.entityIndices[i] = startIndex + i;
    }
  }

  _urlToPath(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.pathname;
    } catch (e) {
      return url;
    }
  }

  /**
   * Apply default values to all config sections.
   * After this method, all config values are guaranteed to exist with sensible defaults.
   * Access config via this.config.section.property (e.g., this.config.lighting.maxFlashes)
   */
  _applyConfigDefaults() {
    // Top-level defaults from centralized config
    this.config = {
      ...SCENE_DEFAULTS,
      ...this.config,
    };

    // Physics defaults from centralized config
    this.config.physics = {
      ...PHYSICS_DEFAULTS,
      gravity: this.config.gravity, // Use top-level gravity as default
      ...(this.config.physics || {}),
    };
    // Ensure gravity is synced
    this.config.physics.gravity =
      this.config.physics.gravity || this.config.gravity;
    this.config.gravity = this.config.physics.gravity;

    // Spatial defaults from centralized config
    this.config.spatial = {
      ...SPATIAL_DEFAULTS,
      ...(this.config.spatial || {}),
    };

    // Particle defaults from centralized config
    this.config.particle = {
      ...PARTICLE_DEFAULTS,
      ...(this.config.particle || {}),
    };
    // Compute decalsTilePixelSize
    this.config.particle.decalsTilePixelSize = Math.floor(
      this.config.particle.decalsTileSize *
        this.config.particle.decalsResolution
    );

    // Decoration defaults from centralized config
    this.config.decoration = {
      ...DECORATION_DEFAULTS,
      ...(this.config.decoration || {}),
    };

    // Logic defaults from centralized config
    this.config.logic = {
      ...LOGIC_DEFAULTS,
      ...(this.config.logic || {}),
    };

    // Renderer defaults from centralized config
    this.config.renderer = {
      ...RENDERER_DEFAULTS,
      ...(this.config.renderer || {}),
    };

    // Lighting defaults from centralized config
    this.config.lighting = {
      ...LIGHTING_DEFAULTS,
      ...(this.config.lighting || {}),
    };
    // Compute maxShadowSprites
    this.config.lighting.maxShadowSprites =
      this.config.lighting.maxShadowCastingLights *
      this.config.lighting.maxShadowsPerLight;
    // Compute shadowsEnabled (requires both enabled and shadowsEnabled)
    this.config.lighting.shadowsEnabled =
      this.config.lighting.enabled &&
      this.config.lighting.shadowsEnabled !== false;
  }

  // ========================================
  // CONFIG CONVENIENCE GETTERS
  // These provide quick access to commonly used config values
  // ========================================

  /** @returns {number} Number of logic workers */
  get numberOfLogicWorkers() {
    return this.config.logic.numberOfLogicWorkers;
  }

  /** @returns {boolean} Whether particles are enabled */
  get hasParticles() {
    return this.config.particle.maxParticles > 0;
  }

  /** @returns {number} Maximum number of particles */
  get maxParticles() {
    return this.config.particle.maxParticles;
  }

  /** @returns {boolean} Whether decorations are enabled */
  get hasDecorations() {
    return this.config.decoration.maxDecorations > 0;
  }

  /** @returns {number} Maximum number of decorations */
  get maxDecorations() {
    return this.config.decoration.maxDecorations;
  }

  /**
   * @returns {boolean} Whether the particle worker is needed
   * Particle worker handles more than particles: lighting, shadows, flashes, entity visibility
   */
  get needsParticleWorker() {
    return true; // Always run particle worker - it handles lighting, shadows, visibility, etc.
  }

  /** @returns {boolean} Whether shadows are enabled */
  get shadowsEnabled() {
    return this.config.lighting.shadowsEnabled;
  }

  /** @returns {number} Maximum shadow-casting lights */
  get maxShadowCastingLights() {
    return this.config.lighting.maxShadowCastingLights;
  }

  /** @returns {number} Maximum shadows per light */
  get maxShadowsPerLight() {
    return this.config.lighting.maxShadowsPerLight;
  }

  /** @returns {number} Maximum shadows per entity */
  get maxShadowsPerEntity() {
    return this.config.lighting.maxShadowsPerEntity;
  }

  /** @returns {number} Total maximum shadow sprites */
  get maxShadowSprites() {
    return this.config.lighting.maxShadowSprites;
  }

  /** @returns {boolean} Whether decals are enabled */
  get decalsEnabled() {
    return this.config.particle.decals;
  }

  /** @returns {number} Decal tile size in world units */
  get decalsTileSize() {
    return this.config.particle.decalsTileSize;
  }

  /** @returns {number} Decal resolution multiplier */
  get decalsResolution() {
    return this.config.particle.decalsResolution;
  }

  /** @returns {number} Decal tile pixel size */
  get decalsTilePixelSize() {
    return this.config.particle.decalsTilePixelSize;
  }

  /** @returns {number} Maximum flash effects */
  get maxFlashes() {
    return this.config.lighting.maxFlashes;
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
        if (!ParentClass.hasOwnProperty("poolSize")) {
          ParentClass.poolSize = 0;
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

    // Load entity scripts dynamically in main thread (like workers do)
    await this.loadEntityScriptsInMainThread();

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

    // Expose scene and component references globally for console access
    this.exposeGlobalReferences();

    console.log(`✅ Scene ${this.constructor.name}: Initialized!`);
    console.log(
      `💡 Debug tip: Use 'scene', 'game', component classes, and entity classes from console`
    );

    // Call user's create() hook
    this.create();
  }

  /**
   * Load entity scripts dynamically in main thread
   * Uses the unified loadEntityScripts function (auto-detects window context)
   */
  async loadEntityScriptsInMainThread() {
    const scriptsToLoad = [];

    // Collect script paths from registered entity classes
    for (const classInfo of this.registeredClasses) {
      if (classInfo.scriptPath) {
        scriptsToLoad.push(classInfo.scriptPath);
      }
    }

    if (scriptsToLoad.length > 0) {
      await loadEntityScripts(scriptsToLoad);
    }
  }

  /**
   * Expose all components and entity classes globally for console access
   * Makes it possible to access SharedArrayBuffer views and iterate entities
   */
  exposeGlobalReferences() {
    // Expose scene and game
    window.scene = this;
    window.game = this.game;

    // Collect all components from all registered entity classes
    const componentMap = collectAllComponentsFromClasses(
      this.registeredClasses,
      window
    );

    // Initialize component views from SharedArrayBuffers (ensures all custom components are connected)
    const initializedCount = initializeComponentViews(
      componentMap,
      this.buffers.componentData,
      this.componentPools,
      this.totalEntityCount
    );

    // Expose all components globally (both core and custom)
    exposeComponentsGlobally(componentMap, window);

    // Expose all registered entity classes
    const exposedEntities = exposeEntityClassesGlobally(
      this.registeredClasses,
      window
    );

    // Expose core classes that might not be in componentMap (system classes)
    window.GameObject = GameObject;
    window.Camera = Camera;
    window.SpriteSheetRegistry = SpriteSheetRegistry;
    window.Mouse = Mouse;
    window.Flash = Flash;

    console.log(
      `🌍 Exposed ${exposedEntities.length} entity classes and ${componentMap.size} components globally (${initializedCount} with SAB views)`
    );
    if (exposedEntities.length > 0) {
      console.log(
        `💡 Try: ${exposedEntities[0]}.forEach(i => console.log(i)) or RigidBody.vx[0]`
      );
    }
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
    if (!this.config.logic.useMainThreadAsLogicWorker) return;

    this.mainThreadHelper = new MainThreadLogicHelper(this);
    this.mainThreadHelper.initialize();
    this.mainThreadHelper.setMaxJobsPerFrame(
      this.config.logic.mainThreadMaxJobsPerFrame
    );
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
    const maxNeighbors = this.config.spatial.maxNeighbors;
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
    const maxParticles = this.config.particle.maxParticles;
    if (maxParticles > 0) {
      const particleBufferSize = ParticleComponent.getBufferSize(maxParticles);
      this.buffers.componentData.ParticleComponent = new SharedArrayBuffer(
        particleBufferSize
      );
      ParticleComponent.initializeArrays(
        this.buffers.componentData.ParticleComponent,
        maxParticles
      );
      ParticleComponent.particleCount = maxParticles;
    }

    // DecorationComponent buffer
    const maxDecorations = this.config.decoration.maxDecorations;
    if (maxDecorations > 0) {
      const decorationBufferSize =
        DecorationComponent.getBufferSize(maxDecorations);
      this.buffers.componentData.DecorationComponent = new SharedArrayBuffer(
        decorationBufferSize
      );
      DecorationComponent.initializeArrays(
        this.buffers.componentData.DecorationComponent,
        maxDecorations
      );
      DecorationComponent.decorationCount = maxDecorations;

      // Create shared buffer for active decoration count (4 bytes for Uint32)
      this.buffers.decorationActiveCount = new SharedArrayBuffer(4);
      // Initialize to 0
      new Uint32Array(this.buffers.decorationActiveCount)[0] = 0;

      // Initialize DecorationPool on main thread for scene-level spawning
      DecorationPool.initialize(maxDecorations);
      DecorationPool.initializeActiveCount(this.buffers.decorationActiveCount);
    }

    // Shadow sprite system
    const maxShadowSprites = this.config.lighting.maxShadowSprites;
    if (this.config.lighting.shadowsEnabled && maxShadowSprites > 0) {
      const shadowSpriteBufferSize =
        ShadowCaster.getBufferSize(maxShadowSprites);
      this.buffers.shadowSpriteData = new SharedArrayBuffer(
        shadowSpriteBufferSize
      );
    }

    // Blood decals tilemap
    if (this.config.particle.decals) {
      const tileSize = this.config.particle.decalsTileSize;
      const tilePixelSize = this.config.particle.decalsTilePixelSize;
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

    // Build query system for fast component-based entity filtering
    console.log("[Scene] Building query system...");
    this.querySystem.buildQueries(this.registeredClasses);
    console.log("[Scene] Query system ready!");

    // Collision data buffer
    const maxCollisionPairs = this.config.physics.maxCollisionPairs;
    const COLLISION_BUFFER_SIZE = (1 + maxCollisionPairs * 2) * 4;
    this.buffers.collisionData = new SharedArrayBuffer(COLLISION_BUFFER_SIZE);
    this.views.collision = new Int32Array(this.buffers.collisionData);
    this.views.collision[0] = 0;

    const INPUT_BUFFER_SIZE = this.inputBufferSize * 4;
    this.buffers.inputData = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    this.views.input = new Int32Array(this.buffers.inputData);

    // Camera buffer: [zoom, x, y, followTargetX, followTargetY, targetZoom]
    const CAMERA_BUFFER_SIZE = 6 * 4;
    this.buffers.cameraData = new SharedArrayBuffer(CAMERA_BUFFER_SIZE);
    this.views.camera = new Float32Array(this.buffers.cameraData);
    this.views.camera[0] = this.camera.zoom;
    // Initialize follow target to NaN (indicates no target)
    this.views.camera[3] = NaN;
    this.views.camera[4] = NaN;
    // Initialize target zoom to current zoom
    this.views.camera[5] = this.camera.zoom;

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

    // FrameRate buffer: stores real-time FPS for each worker
    // Layout: [spatial0_fps, spatial1_fps, ..., physics_fps, renderer_fps, particle_fps, logic0_fps, logic1_fps, ...]
    const numberOfSpatialWorkers = this.config.spatial.numberOfSpatialWorkers;
    const maxWorkers = numberOfSpatialWorkers + 3 + this.numberOfLogicWorkers; // spatial workers + physics + renderer + particle + logic workers
    const FRAMERATE_BUFFER_SIZE = maxWorkers * 4; // 1 float per worker
    this.buffers.frameRateData = new SharedArrayBuffer(FRAMERATE_BUFFER_SIZE);
    this.views.frameRate = new Float32Array(this.buffers.frameRateData);

    // Worker stat buffers: detailed metrics for each worker type
    // Each buffer uses strided layout for cache-line isolation (64 bytes per worker)
    this.buffers.rendererStats = new SharedArrayBuffer(
      RENDERER_STATS.BUFFER_SIZE
    );
    this.buffers.particleStats = new SharedArrayBuffer(
      PARTICLE_STATS.BUFFER_SIZE
    );
    this.buffers.physicsStats = new SharedArrayBuffer(
      PHYSICS_STATS.BUFFER_SIZE
    );
    this.buffers.spatialStats = new SharedArrayBuffer(
      SPATIAL_STATS.BUFFER_SIZE_PER_WORKER * numberOfSpatialWorkers
    );
    this.buffers.logicStats = new SharedArrayBuffer(
      LOGIC_STATS.BUFFER_SIZE_PER_WORKER * this.numberOfLogicWorkers
    );

    // Synchronization buffer
    const SYNC_BUFFER_SIZE = 5 * 4;
    this.buffers.syncData = new SharedArrayBuffer(SYNC_BUFFER_SIZE);
    const syncView = new Int32Array(this.buffers.syncData);
    syncView[0] = 0;
    syncView[1] = 0;

    this.mainThreadJobStealingEnabled =
      this.config.logic.useMainThreadAsLogicWorker;
    const totalWorkers = this.mainThreadJobStealingEnabled
      ? this.config.logic.numberOfLogicWorkers + 1
      : this.config.logic.numberOfLogicWorkers;
    syncView[2] = totalWorkers;
    syncView[3] = 0;
    syncView[4] = 1;

    // Job queue buffer
    const entitiesPerJob = this.config.logic.numberOfEntitiesPerJob;
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
    this.loadedTilemaps = {}; // Store loaded tilemap data

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
      if (this.config.particle.decals) {
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

    // Load tilemaps (Tiled JSON + tileset images)
    if (imageUrls.tilemaps) {
      console.log(
        `🗺️ Loading ${Object.keys(imageUrls.tilemaps).length} tilemaps...`
      );

      for (const [tilemapId, tilemapConfig] of Object.entries(
        imageUrls.tilemaps
      )) {
        try {
          // Load Tiled JSON file
          const jsonResponse = await fetch(tilemapConfig.json);
          if (!jsonResponse.ok) {
            throw new Error(
              `Failed to load tilemap JSON: ${tilemapConfig.json}`
            );
          }
          const tilemapData = await jsonResponse.json();

          // Load tileset image
          const tilesetResponse = await fetch(tilemapConfig.png);
          if (!tilesetResponse.ok) {
            throw new Error(
              `Failed to load tileset image: ${tilemapConfig.png}`
            );
          }
          const tilesetBlob = await tilesetResponse.blob();
          const tilesetBitmap = await createImageBitmap(tilesetBlob);

          // Store loaded tilemap data
          this.loadedTilemaps[tilemapId] = {
            data: tilemapData,
            tilesetBitmap: tilesetBitmap,
          };

          console.log(`  ✅ Loaded tilemap: ${tilemapId}`);
        } catch (error) {
          console.error(`❌ Failed to load tilemap "${tilemapId}":`, error);
        }
      }
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

    // Connect all logic workers to logic0 for spawn/despawn routing
    // This ensures freeList synchronization across workers
    for (let i = 1; i < this.numberOfLogicWorkers; i++) {
      connections.push({ from: `logic${i}`, to: "logic0" });
    }

    return setupWorkerCommunication(connections);
  }

  async createWorkers() {
    const { canvasWidth, canvasHeight, worldWidth, worldHeight } = this.config;

    const cacheBust = `?v=${Date.now()}`;

    // Create multiple spatial workers for parallel neighbor detection
    const numberOfSpatialWorkers = this.config.spatial.numberOfSpatialWorkers;
    for (let i = 0; i < numberOfSpatialWorkers; i++) {
      const spatialWorker = new Worker(
        `/src/workers/spatial_worker.js${cacheBust}`,
        {
          type: "module",
        }
      );
      spatialWorker.name = `spatial${i}`;
      this.workers.spatialWorkers.push(spatialWorker);
    }

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

    // Particle worker always runs - handles particles, lighting, shadows, visibility, etc.
    this.workers.particle = new Worker(
      `/src/workers/particle_worker.js${cacheBust}`,
      {
        type: "module",
      }
    );

    this.workers.physics.name = "physics";
    this.workers.renderer.name = "renderer";
    this.workers.particle.name = "particle";

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
        frameRateData: this.buffers.frameRateData,
        componentData: this.buffers.componentData,
        // Worker stat buffers (detailed metrics)
        rendererStats: this.buffers.rendererStats,
        particleStats: this.buffers.particleStats,
        physicsStats: this.buffers.physicsStats,
        spatialStats: this.buffers.spatialStats,
        logicStats: this.buffers.logicStats,
      },
      globalEntityCount: this.totalEntityCount,
      config: this.config,
      scriptsToLoad: scriptsToLoad,
      registeredClasses: this.registeredClasses.map((r) => ({
        name: r.class.name,
        poolSize: r.count,
        startIndex: r.startIndex,
        endIndex: r.startIndex + r.count,
        entityType: r.entityType,
        components: r.components.map((c) => c.name),
      })),
      componentPools: Object.fromEntries(
        Object.entries(this.componentPools).map(([name, pool]) => [
          name,
          {
            count: this.totalEntityCount,
            componentId: pool.ComponentClass.componentId,
          },
        ])
      ),
      keyIndexMap: this.createKeyIndexMap(),
      spritesheetMetadata: SpriteSheetRegistry.serialize(),
      maxParticles: this.config.particle.maxParticles,
      maxDecorations: this.config.decoration.maxDecorations,
      decorationActiveCount: this.buffers.decorationActiveCount || null,
      decals: this.config.particle.decals
        ? {
            enabled: true,
            tileSize: this.config.particle.decalsTileSize,
            tilePixelSize: this.config.particle.decalsTilePixelSize,
            resolution: this.config.particle.decalsResolution,
            tilesX: this.decalsTilesX,
            tilesY: this.decalsTilesY,
            totalTiles: this.decalsTotalTiles,
            tilesRGBA: this.buffers.bloodTilesRGBA,
            tilesDirty: this.buffers.bloodTilesDirty,
            textures: this.decalTextureData,
          }
        : null,
      shadows: this.config.lighting.shadowsEnabled
        ? {
            enabled: true,
            maxShadowCastingLights: this.config.lighting.maxShadowCastingLights,
            maxShadowsPerLight: this.config.lighting.maxShadowsPerLight,
            maxShadowsPerEntity: this.config.lighting.maxShadowsPerEntity,
            maxShadowSprites: this.config.lighting.maxShadowSprites,
            spriteData: this.buffers.shadowSpriteData,
          }
        : null,
      flashes:
        this.config.lighting.maxFlashes > 0
          ? {
              enabled: true,
              maxFlashes: this.config.lighting.maxFlashes,
              startIndex: Flash.startIndex,
            }
          : null,
      queries: this.querySystem.serialize(), // Pre-calculated entity queries
    };

    // Initialize workers
    // Initialize multiple spatial workers (each builds full grid, processes subset of entities)
    // const numberOfSpatialWorkers = this.config.spatial.numberOfSpatialWorkers;

    // Calculate dynamic worker indices based on numberOfSpatialWorkers
    const PHYSICS_INDEX = numberOfSpatialWorkers;
    const RENDERER_INDEX = numberOfSpatialWorkers + 1;
    const PARTICLE_INDEX = numberOfSpatialWorkers + 2;
    const LOGIC_START_INDEX = numberOfSpatialWorkers + 3;

    for (let i = 0; i < numberOfSpatialWorkers; i++) {
      this.workers.spatialWorkers[i].postMessage({
        ...initData,
        frameRateIndex: Scene.WORKER_INDICES.SPATIAL_START + i,
        workerIndex: i,
        totalSpatialWorkers: numberOfSpatialWorkers,
      });
    }

    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      this.workers.logicWorkers[i].postMessage(
        {
          ...initData,
          workerPorts: workerPorts[`logic${i}`],
          workerIndex: i, // For logic worker job partitioning (0, 1, 2, ...)
          frameRateIndex: LOGIC_START_INDEX + i, // For FPS tracking
          bigAtlasProxySheets: this.bigAtlasProxySheets || {},
        },
        workerPorts[`logic${i}`] ? Object.values(workerPorts[`logic${i}`]) : []
      );
    }

    this.workers.physics.postMessage(
      {
        ...initData,
        workerPorts: workerPorts.physics,
        frameRateIndex: PHYSICS_INDEX,
      },
      workerPorts.physics ? Object.values(workerPorts.physics) : []
    );

    // Particle worker always receives init data
    this.workers.particle.postMessage({
      ...initData,
      frameRateIndex: PARTICLE_INDEX,
    });

    // Initialize renderer
    const offscreenCanvas = this.canvas.transferControlToOffscreen();

    const transferables = [
      offscreenCanvas,
      ...Object.values(this.loadedTextures),
      ...Object.values(this.loadedSpritesheets).map(
        (sheet) => sheet.imageBitmap
      ),
      ...Object.values(this.loadedTilemaps || {}).map(
        (tilemap) => tilemap.tilesetBitmap
      ),
      ...(workerPorts.renderer ? Object.values(workerPorts.renderer) : []),
    ];

    this.workers.renderer.postMessage(
      {
        ...initData,
        view: offscreenCanvas,
        textures: this.loadedTextures,
        spritesheets: this.loadedSpritesheets,
        tilemaps: this.loadedTilemaps || {}, // Pass loaded tilemap data
        bigAtlasProxySheets: this.bigAtlasProxySheets || {},
        frameRateIndex: RENDERER_INDEX,
        workerPorts: workerPorts.renderer,
      },
      transferables
    );

    // Setup message handlers
    const allWorkers = [
      ...this.workers.spatialWorkers,
      ...this.workers.logicWorkers,
      this.workers.physics,
      this.workers.renderer,
      this.workers.particle,
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
      ...this.workers.spatialWorkers,
      ...this.workers.logicWorkers,
      this.workers.physics,
      this.workers.renderer,
      this.workers.particle,
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
    // Handle spatial workers (spatial0, spatial1, etc.)
    if (id.startsWith("spatial")) {
      const index = parseInt(id.replace("spatial", ""), 10);
      if (this.workerStats.spatial[index]) {
        this.workerStats.spatial[index] = {
          fps,
          active: activeEntities || 0,
        };
      }
      return;
    }

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

      const currentZoom = Camera.targetZoom;
      const newZoom = currentZoom + -e.deltaY * 0.001;

      // Set target zoom - Camera.follow() will lerp toward it
      Camera.setZoom(newZoom);
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
    // Sync all camera state from Camera static class (controlled by worker/entity via follow())
    this.camera.zoom = Camera.zoom;
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
      ...this.workers.spatialWorkers,
      ...this.workers.logicWorkers,
      this.workers.physics,
      this.workers.renderer,
      this.workers.particle,
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
      if (EntityClass.poolSize !== undefined) {
        EntityClass.poolSize = 0;
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
      for (let i = 0; i < this.config.particle.maxParticles; i++) {
        ParticleComponent.active[i] = 0;
      }
    }

    // Clear DecorationComponent if it exists
    if (DecorationComponent.active) {
      for (let i = 0; i < this.config.decoration.maxDecorations; i++) {
        DecorationComponent.active[i] = 0;
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
    if (this.config.lighting.maxFlashes > 0 && Flash.instances) {
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
      ...this.workers.spatialWorkers,
      ...this.workers.logicWorkers,
      this.workers.physics,
      this.workers.renderer,
      this.workers.particle,
    ];

    allWorkers.forEach((worker) => {
      if (worker) worker.postMessage({ msg: "pause" });
    });
  }

  resume() {
    this.state.pause = false;
    const allWorkers = [
      ...this.workers.spatialWorkers,
      ...this.workers.logicWorkers,
      this.workers.physics,
      this.workers.renderer,
      this.workers.particle,
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

  despawnEntity(entityIndex) {
    if (this.workers.logicWorkers && this.workers.logicWorkers.length > 0) {
      this.workers.logicWorkers.forEach((worker) => {
        worker.postMessage({
          msg: "despawn",
          entityIndex: entityIndex,
        });
      });
    } else if (this.mainThreadHelper) {
      this.mainThreadHelper.despawnEntity(entityIndex);
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
    if (!EntityClass.startIndex || !EntityClass.poolSize) {
      return { total: 0, active: 0, available: 0 };
    }

    const startIndex = EntityClass.startIndex;
    const total = EntityClass.poolSize;
    let activeCount = 0;

    for (let i = startIndex; i < EntityClass.endIndex; i++) {
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

  // ========================================
  // BACKGROUND CONTROL METHODS
  // ========================================

  /**
   * Set a static background (simple Sprite, does not tile)
   * @param {string} textureId - ID of texture in assets.textures
   */
  setStaticBackground(textureId) {
    if (!this.workers.renderer) {
      console.warn("Renderer worker not initialized");
      return;
    }

    this.workers.renderer.postMessage({
      msg: "setBackground",
      type: "static",
      textureId: textureId,
    });
  }

  /**
   * Set a tiling background (TilingSprite - repeats pattern)
   * @param {string} textureId - ID of texture in assets.textures
   * @param {number} tileScale - Scale of tiles (default: 1)
   */
  setTilingBackground(textureId, tileScale = 1) {
    if (!this.workers.renderer) {
      console.warn("Renderer worker not initialized");
      return;
    }

    this.workers.renderer.postMessage({
      msg: "setBackground",
      type: "tiling",
      textureId: textureId,
      tileScale: tileScale,
    });
  }

  /**
   * Set a tilemap background (@pixi/tilemap - varied tiles from Tiled editor)
   * @param {string} tilemapId - ID of tilemap in assets.tilemaps
   * @param {object} options - Options: { layers: [...], scale: 1 }
   */
  setTilemapBackground(tilemapId, options = {}) {
    if (!this.workers.renderer) {
      console.warn("Renderer worker not initialized");
      return;
    }

    // Check if the tilemap asset exists
    if (!this.loadedTilemaps || !this.loadedTilemaps[tilemapId]) {
      const availableTilemaps = this.loadedTilemaps
        ? Object.keys(this.loadedTilemaps)
        : [];
      console.error(
        `Tilemap "${tilemapId}" not found. ` +
          `Available tilemaps: [${availableTilemaps.join(", ") || "none"}]`
      );
      return;
    }

    this.workers.renderer.postMessage({
      msg: "setBackground",
      type: "tilemap",
      tilemapId: tilemapId,
      options: options,
    });
  }

  /**
   * Remove the current background
   */
  clearBackground() {
    if (!this.workers.renderer) {
      console.warn("Renderer worker not initialized");
      return;
    }

    this.workers.renderer.postMessage({
      msg: "setBackground",
      type: "none",
    });
  }
}

export { Scene };
