// GameEngine.js - Centralized game initialization and state management
// Handles workers, SharedArrayBuffers, class registration, and input management

import { GameObject } from "./gameObject.js";
import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { ParticleComponent } from "../components/ParticleComponent.js";
import { ShadowCaster } from "../components/ShadowCaster.js";
import { SpriteSheetRegistry } from "./SpriteSheetRegistry.js";
import { setupWorkerCommunication, seededRandom } from "./utils.js";
import { Debug } from "./Debug.js";
import { Mouse } from "./Mouse.js";
import { BigAtlasInspector } from "./BigAtlasInspector.js";
import { MainThreadLogicHelper } from "./MainThreadLogicHelper.js";
// Note: Particles are NOT GameObjects - they use ParticleComponent directly

class GameEngine {
  static now = Date.now();
  constructor(config, imageUrls) {
    this.log = [];
    this.loadedTextures = null;
    this.imageUrls = imageUrls;
    this.seed = config.seed || Math.random();
    this.rng = seededRandom(this.seed);
    // Make seeded random available globally for entity code
    globalThis.rng = this.rng;
    this.state = {
      pause: false,
    };

    // Apply default physics settings if not provided
    this.config = {
      gravity: { x: 0, y: 0 }, // Global gravity { x: 0, y: 0.5 } for downward
      ...config,
    };

    this.config.physics = {
      subStepCount: 4,
      boundaryElasticity: 0.8,
      collisionResponseStrength: 0.5,
      verletDamping: 0.995,
      minSpeedForRotation: 0.1,
      ...(config.physics || {}),
    };
    this.config.physics.gravity = this.config.physics.gravity ||
      this.config.gravity || { x: 0, y: 0 };
    this.config.gravity = this.config.physics.gravity;

    // State
    this.keyboard = {};
    // Mouse is accessed via Mouse static class (writes directly to SharedArrayBuffer)
    this.camera = {
      zoom: 1,
      x: 0, // Will be centered on world after init
      y: 0,
    };

    // Get number of logic workers from config (default to 1 for backward compatibility)
    // Note: Use ?? instead of || to allow 0 logic workers (main thread only mode)
    this.numberOfLogicWorkers = this.config.logic?.numberOfLogicWorkers ?? 1;

    // Workers
    this.workers = {
      spatial: null,
      logicWorkers: [], // Array of logic workers
      physics: null,
      renderer: null,
      particle: null, // Particle physics worker
    };

    this.pendingPhysicsUpdates = [];

    const engine = this;
    this.physics = new Proxy(this.config.physics, {
      get(target, prop) {
        return target[prop];
      },
      set(target, prop, value) {
        target[prop] = value;
        engine.updatePhysicsConfig({ [prop]: value });
        return true;
      },
    });

    // Worker synchronization (for two-phase initialization)
    // Dynamically create ready states for all logic workers
    this.workerReadyStates = {
      spatial: false,
      physics: false,
      renderer: false,
    };
    // Add ready states for each logic worker
    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      this.workerReadyStates[`logic${i}`] = false;
    }
    // Add particle worker if configured
    this.hasParticles = !!(this.config.particle?.maxParticles > 0);
    if (this.hasParticles) {
      this.workerReadyStates.particle = false;
    }
    this.totalWorkers =
      3 + this.numberOfLogicWorkers + (this.hasParticles ? 1 : 0);

    // Shared buffers
    this.buffers = {
      gameObjectData: null, // Entity metadata (just entityType now)
      neighborData: null,
      distanceData: null, // Squared distances for each neighbor
      collisionData: null,
      inputData: null,
      cameraData: null,
      syncData: null, // Synchronization buffer for logic workers
      jobQueueData: null, // Job queue buffer for dynamic work distribution
      debugData: null, // Debug flags for visualization
      // Component buffers (core + custom components auto-registered)
      componentData: {
        Transform: null,
        RigidBody: null,
        Collider: null,
        SpriteRenderer: null,
      },
    };

    // Component pool tracking
    // DENSE ALLOCATION: All components have slots for all entities
    // Just track ComponentClass for buffer creation
    // Note: ParticleComponent is handled separately (not entity-based)
    this.componentPools = {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      Collider: { ComponentClass: Collider },
      SpriteRenderer: { ComponentClass: SpriteRenderer },
    };

    // Particle pool size (separate from entity system)
    this.maxParticles = this.config.particle?.maxParticles || 0;

    // ========================================
    // SHADOW SPRITE SYSTEM
    // ========================================
    // Shadows are rendered as sprites in a separate ParticleContainer
    // Buffer is written by particle_worker, read by pixi_worker
    const lightingConfig = this.config.lighting || {};
    this.shadowsEnabled =
      lightingConfig.enabled && lightingConfig.shadowsEnabled !== false;
    this.maxShadowCastingLights = lightingConfig.maxShadowCastingLights || 20;
    this.maxShadowsPerLight = lightingConfig.maxShadowsPerLight || 15;
    this.maxShadowSprites =
      this.maxShadowCastingLights * this.maxShadowsPerLight;
    this.maxDistanceFromLight = lightingConfig.maxDistanceFromLight || 512;

    // ========================================
    // BLOOD DECALS TILEMAP SYSTEM
    // ========================================
    // When particles with stayOnTheFloor=true hit the ground, they stamp
    // a permanent blood splat onto a tilemap. This allows thousands of
    // decals without individual sprites.
    //
    // Architecture:
    // - World is divided into tiles (e.g., 256x256 pixels each)
    // - Each tile has an RGBA buffer for pixel data
    // - particle_worker stamps blood patterns into tiles when particles land
    // - pixi_worker renders dirty tiles as textures
    console.log("DEBUG: config.particle =", JSON.stringify(config.particle));
    console.log(
      "DEBUG: this.config.particle =",
      JSON.stringify(this.config.particle)
    );
    console.log(
      "DEBUG: this.config.particle?.decals =",
      this.config.particle?.decals
    );
    this.decalsEnabled = this.config.particle?.decals || false;
    this.decalsTileSize = this.config.particle?.decalsTileSize || 256; // World units each tile covers
    this.decalsResolution = this.config.particle?.decalsResolution || 1.0; // 0.5 = half res
    this.decalsTilePixelSize = Math.floor(
      this.decalsTileSize * this.decalsResolution
    ); // Actual pixel size
    console.log("DEBUG: decalsEnabled =", this.decalsEnabled);

    // Typed array views
    this.views = {
      input: null,
      camera: null,
      collision: null,
    };

    // Main thread FPS tracking (same technique as workers)
    this.mainFPS = 0;
    this.mainFPSFrameCount = 60; // Average over last 60 frames
    this.mainFrameTimes = new Array(this.mainFPSFrameCount).fill(16.67);
    this.mainFrameTimeIndex = 0;
    this.mainFrameTimesSum = 16.67 * this.mainFPSFrameCount;
    this.mainFPSReportInterval = 30; // Update UI every N frames
    this.mainFrameNumber = 0;

    // Main thread job stealing (helps workers by claiming jobs from shared queue)
    // Configure via config.logic.mainThreadJobStealing: { enabled, maxJobsPerFrame }
    this.mainThreadHelper = null; // Initialized in init() after buffers are created

    // Canvas
    this.canvas = null;

    // Entity registration
    this.registeredClasses = []; // [{class, count, startIndex}, ...]
    this.gameObjects = []; // All entity instances
    this.totalEntityCount = 0;

    // Key mapping for input buffer - comprehensive key support
    // Using a more extensive mapping for all common keys
    this.keyMap = {};
    let keyIndex = 0;

    // Letters a-z (indices 0-25)
    for (let i = 0; i < 26; i++) {
      this.keyMap[String.fromCharCode(97 + i)] = keyIndex++; // 'a' = 97 in ASCII
    }

    // Numbers 0-9 (indices 26-35)
    for (let i = 0; i < 10; i++) {
      this.keyMap[String.fromCharCode(48 + i)] = keyIndex++; // '0' = 48 in ASCII
    }

    // Special keys (indices 36+)
    this.keyMap[" "] = keyIndex++; // space (36)
    this.keyMap["enter"] = keyIndex++;
    this.keyMap["escape"] = keyIndex++;
    this.keyMap["tab"] = keyIndex++;
    this.keyMap["backspace"] = keyIndex++;
    this.keyMap["delete"] = keyIndex++;
    this.keyMap["shift"] = keyIndex++;
    this.keyMap["control"] = keyIndex++;
    this.keyMap["alt"] = keyIndex++;
    this.keyMap["meta"] = keyIndex++; // Command/Windows key

    // Arrow keys (indices 46+)
    this.keyMap["arrowup"] = keyIndex++;
    this.keyMap["arrowdown"] = keyIndex++;
    this.keyMap["arrowleft"] = keyIndex++;
    this.keyMap["arrowright"] = keyIndex++;

    // Function keys F1-F12 (indices 50+)
    for (let i = 1; i <= 12; i++) {
      this.keyMap[`f${i}`] = keyIndex++;
    }

    // Common punctuation (indices 62+)
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

    // Total keys mapped: ~73
    this.inputBufferSize = keyIndex; // Keyboard only (mouse uses Transform/MouseComponent)

    // Frame timing
    this.lastFrameTime = performance.now();
    this.updateRate = 1000 / 60; // 60 fps

    // Initialization promise
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    // CRITICAL: Auto-register Mouse FIRST (must be at index 0)
    // This happens in constructor so Mouse is always registered before user entities
    this.registerEntityClass(Mouse, 1);
    console.log(`🖱️ Mouse auto-registered at index 0`);
  }

  /**
   * Register an entity class (e.g., Ball, Car)
   * This calculates buffer sizes and tracks entity ranges
   * @param {Class} EntityClass - The class to register (must extend GameObject)
   * @param {number} count - Number of entities of this type
   * @param {string} scriptPath - Path to the script file (for worker loading)
   *                              If omitted, auto-detected from EntityClass.scriptUrl
   */
  registerEntityClass(EntityClass, count, scriptPath = null) {
    console.log(import.meta);
    // Auto-detect script path from EntityClass.scriptUrl (set via import.meta.url)
    if (!scriptPath && EntityClass.scriptUrl) {
      scriptPath = this._urlToPath(EntityClass.scriptUrl);
    }

    // Auto-detect and register parent classes (if not already registered)
    this._autoRegisterParentClasses(EntityClass);

    // Collect all components for this entity class
    const components = GameObject._collectComponents(EntityClass);

    // Check if this class is already registered (by identity OR name)
    // BUGFIX: Check by name to handle ES module edge cases where same class
    // may appear as different objects due to different import paths
    const existing = this.registeredClasses.find(
      (r) => r.class === EntityClass || r.class.name === EntityClass.name
    );
    if (existing) {
      console.warn(
        `⚠️ ${EntityClass.name} is already registered. Skipping duplicate registration.`
      );
      return;
    }

    const startIndex = this.totalEntityCount;

    // AUTO-ASSIGN ENTITY TYPE ID
    // Sequential ID assignment: 0 = Mouse, 1 = first registered class, 2 = second, etc.
    const entityTypeId = this.registeredClasses.length;
    EntityClass.entityType = entityTypeId;

    // DENSE ALLOCATION: Just register custom components (no index tracking needed)
    // All components will have slots for ALL entities (entityIndex === componentIndex)
    for (const ComponentClass of components) {
      const componentName = ComponentClass.name;

      // Auto-create pool for custom components (e.g., Flocking)
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
      entityType: entityTypeId, // Store for workers
      scriptPath: scriptPath, // Track script path for workers
      components: components, // Track which components this entity uses
      // Note: componentIndices removed - dense allocation means entityIndex === componentIndex
    });

    this.totalEntityCount += count;

    // Auto-initialize required static properties if they don't exist
    if (!EntityClass.hasOwnProperty("instances")) {
      EntityClass.instances = [];
    }

    // Store spawning system metadata
    EntityClass.startIndex = startIndex;
    EntityClass.totalCount = count;

    // console.log(
    //   `✅ Registered ${
    //     EntityClass.name
    //   }: ${count} entities with entityType=${entityTypeId}, components: ${components
    //     .map((c) => c.name)
    //     .join(", ")}`
    // );
  }

  /**
   * Convert a full URL (from import.meta.url) to an absolute path
   * @param {string} url - Full URL like "http://localhost:3000/demos/predators/prey.js"
   * @returns {string} Absolute path like "/demos/predators/prey.js"
   * @private
   */
  _urlToPath(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.pathname; // Returns "/demos/predators/prey.js"
    } catch (e) {
      // If URL parsing fails, return as-is (might already be a path)
      return url;
    }
  }

  /**
   * Auto-detect and register parent classes in the inheritance chain
   * This ensures base classes are registered even if they have 0 instances
   * @private
   */
  _autoRegisterParentClasses(EntityClass) {
    const parentChain = [];
    let current = EntityClass;

    // Walk up the prototype chain until we hit GameObject
    while (current && current !== GameObject) {
      parentChain.unshift(current); // Add to front (we want base classes first)
      current = Object.getPrototypeOf(current);
    }

    // Register each class in the chain (if not already registered)
    for (const ParentClass of parentChain) {
      // BUGFIX: Check by class NAME, not identity, to handle ES module edge cases
      // where the same class may appear as different objects due to import paths
      const alreadyRegistered = this.registeredClasses.some(
        (r) => r.class === ParentClass || r.class.name === ParentClass.name
      );

      if (!alreadyRegistered && ParentClass !== EntityClass) {
        // Register parent class with 0 instances
        const startIndex = this.totalEntityCount;

        // Collect components for parent class
        const parentComponents = GameObject._collectComponents(ParentClass);

        // Register parent components in component pools
        for (const ComponentClass of parentComponents) {
          const componentName = ComponentClass.name;
          if (!this.componentPools[componentName]) {
            this.componentPools[componentName] = {
              ComponentClass: ComponentClass,
            };
          }
        }

        // Assign entity type ID to parent class
        const entityTypeId = this.registeredClasses.length;
        ParentClass.entityType = entityTypeId;

        // Parent classes don't get script paths automatically
        // Developer must explicitly register base classes that workers need to load
        // Library classes (GameObject, RenderableGameObject) are already imported by workers

        this.registeredClasses.push({
          class: ParentClass,
          count: 0,
          startIndex: startIndex,
          entityType: entityTypeId, // Store for workers
          scriptPath: null, // No automatic script path
          components: parentComponents, // CRITICAL: Must include components!
        });

        // Initialize static properties for parent class
        if (!ParentClass.hasOwnProperty("sharedBuffer")) {
          ParentClass.sharedBuffer = null;
        }
        if (!ParentClass.hasOwnProperty("entityCount")) {
          ParentClass.entityCount = 0;
        }
        if (!ParentClass.hasOwnProperty("instances")) {
          ParentClass.instances = [];
        }

        // console.log(
        //   `🔧 Auto-registered parent class ${ParentClass.name} (0 instances) for ${EntityClass.name}`
        // );
      }
    }
  }

  // Initialize everything
  async init() {
    // console.log("🎮 GameEngine: Initializing...");

    // Check SharedArrayBuffer support
    if (typeof SharedArrayBuffer === "undefined") {
      throw new Error("SharedArrayBuffer not available! Check CORS headers.");
    }

    // Note: Particles are NOT registered as entities - they have their own separate pool
    // ParticleComponent buffer is created in createSharedBuffers() with maxParticles size

    // Create shared buffers
    this.createSharedBuffers();

    // Initialize canvas
    this.createCanvas();

    // Create workers
    this.createWorkers();

    // Setup event listeners
    this.setupEventListeners();

    // Start main loop
    this.startMainLoop();

    // Update boid count display
    const numberBoidsElement = document.getElementById("numberBoids");
    if (numberBoidsElement) {
      numberBoidsElement.textContent = `Number of entities: ${this.totalEntityCount}`;
    }

    // Wait for all workers to be ready
    await this.readyPromise;

    // Initialize main thread job stealing (after buffers and workers are ready)
    this.initMainThreadHelper();

    // console.log("✅ GameEngine: Initialized successfully!");
  }

  /**
   * Initialize the MainThreadLogicHelper for job stealing
   * The main thread can participate in entity tick() processing by claiming
   * jobs from the same Atomics-based job queue used by logic workers.
   *
   * Configure via config.logic.mainThreadJobStealing: {
   *   enabled: boolean,      // Enable/disable (default: false)
   *   maxJobsPerFrame: number // Max jobs per frame, 0 = unlimited (default: 0)
   * }
   */
  initMainThreadHelper() {
    const jobStealingConfig = this.config.logic?.mainThreadJobStealing || {};
    const enabled = jobStealingConfig.enabled ?? false;

    if (!enabled) {
      // console.log("🧵 MainThreadLogicHelper: Disabled (config.logic.mainThreadJobStealing.enabled = false)");
      return;
    }

    // Create and initialize the helper
    this.mainThreadHelper = new MainThreadLogicHelper(this);
    this.mainThreadHelper.initialize();

    // Configure max jobs per frame (0 = unlimited)
    const maxJobsPerFrame = jobStealingConfig.maxJobsPerFrame ?? 0;
    this.mainThreadHelper.setMaxJobsPerFrame(maxJobsPerFrame);

    console.log(
      `🧵 MainThreadLogicHelper: ENABLED (maxJobsPerFrame: ${
        maxJobsPerFrame === 0 ? "unlimited" : maxJobsPerFrame
      })`
    );
  }

  // Create all SharedArrayBuffers
  createSharedBuffers() {
    // CRITICAL: Mouse must always be at index 0 for simplified static access
    // Mouse is auto-registered in constructor, but verify it's still at index 0
    if (Mouse.startIndex !== 0) {
      throw new Error(
        `INTERNAL ERROR: Mouse should be at index 0 but got startIndex=${Mouse.startIndex}. ` +
          `This should never happen - Mouse is registered in GameEngine constructor.`
      );
    }

    // 1. GameObject entity metadata buffer (just entityType)
    // Note: 'active' moved to Transform, 'isItOnScreen' moved to SpriteRenderer
    const gameObjectBufferSize = GameObject.getBufferSize(
      this.totalEntityCount
    );
    this.buffers.gameObjectData = new SharedArrayBuffer(gameObjectBufferSize);

    // Neighbor data buffer (create before initializing GameObject)
    const maxNeighbors =
      this.config.spatial?.maxNeighbors || this.config.maxNeighbors || 100;
    const NEIGHBOR_BUFFER_SIZE = this.totalEntityCount * (1 + maxNeighbors) * 4;
    this.buffers.neighborData = new SharedArrayBuffer(NEIGHBOR_BUFFER_SIZE);

    // Distance data buffer (stores squared distances for each neighbor)
    const DISTANCE_BUFFER_SIZE = this.totalEntityCount * (1 + maxNeighbors) * 4;
    this.buffers.distanceData = new SharedArrayBuffer(DISTANCE_BUFFER_SIZE);

    // Initialize GameObject entity state arrays
    GameObject.initializeArrays(
      this.buffers.gameObjectData,
      this.totalEntityCount,
      this.buffers.neighborData,
      this.buffers.distanceData
    );

    // 2. Create Component buffers
    // SIMPLIFIED: ALL components are allocated for ALL entities (dense allocation)
    // This means entity index === component index, making code much simpler
    console.log("📦 Creating component buffers (dense allocation)...");

    console.log(
      `   Component pools: ${Object.keys(this.componentPools).join(", ")}`
    );

    for (const [componentName, pool] of Object.entries(this.componentPools)) {
      if (pool.ComponentClass) {
        const ComponentClass = pool.ComponentClass;
        // DENSE: Use totalEntityCount for ALL components, not pool.count
        const bufferSize = ComponentClass.getBufferSize(this.totalEntityCount);
        this.buffers.componentData[componentName] = new SharedArrayBuffer(
          bufferSize
        );
        ComponentClass.initializeArrays(
          this.buffers.componentData[componentName],
          this.totalEntityCount
        );

        console.log(
          `   ✅ ${componentName}: ${bufferSize} bytes for ${this.totalEntityCount} entities`
        );
      }
    }

    // Create ParticleComponent buffer separately (NOT entity-based)
    // Particles have their own pool with indices 0 to maxParticles-1
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

      console.log(
        `   🎆 ParticleComponent: ${particleBufferSize} bytes for ${this.maxParticles} particles (separate pool)`
      );
    }

    // ========================================
    // SHADOW SPRITE SYSTEM - SharedArrayBuffer Creation
    // ========================================
    // Creates buffer for shadow sprite data (written by particle_worker, read by pixi_worker)
    // Uses ShadowCaster component schema for both entity markers AND sprite data
    if (this.shadowsEnabled && this.maxShadowSprites > 0) {
      const shadowSpriteBufferSize = ShadowCaster.getBufferSize(
        this.maxShadowSprites
      );
      this.buffers.shadowSpriteData = new SharedArrayBuffer(
        shadowSpriteBufferSize
      );

      console.log(
        `   🌑 ShadowCaster sprites: ${shadowSpriteBufferSize} bytes for ${this.maxShadowSprites} shadows (${this.maxShadowCastingLights} lights × ${this.maxShadowsPerLight} shadows/light)`
      );
    }

    // ========================================
    // BLOOD DECALS TILEMAP - SharedArrayBuffer Creation
    // ========================================
    // Creates two SABs:
    // 1. bloodTilesRGBA: Stores RGBA pixel data for all tiles (write by particle_worker, read by pixi_worker)
    // 2. bloodTilesDirty: Dirty flags per tile (set by particle_worker, cleared by pixi_worker)
    if (this.decalsEnabled) {
      const tileSize = this.decalsTileSize; // World units each tile covers
      const tilePixelSize = this.decalsTilePixelSize; // Actual pixel dimensions
      const worldWidth = this.config.worldWidth;
      const worldHeight = this.config.worldHeight;

      // Calculate tile grid dimensions (based on world coverage, not pixel size)
      const tilesX = Math.ceil(worldWidth / tileSize);
      const tilesY = Math.ceil(worldHeight / tileSize);
      const totalTiles = tilesX * tilesY;

      // Each tile is tilePixelSize × tilePixelSize pixels × 4 bytes (RGBA)
      // Lower resolution = smaller buffers = better performance
      const bytesPerTile = tilePixelSize * tilePixelSize * 4;
      const totalTileBytes = totalTiles * bytesPerTile;

      // Create SharedArrayBuffer for tile RGBA data
      // particle_worker writes blood patterns here
      // pixi_worker reads and converts to textures
      this.buffers.bloodTilesRGBA = new SharedArrayBuffer(totalTileBytes);

      // Create SharedArrayBuffer for dirty flags (1 byte per tile)
      // particle_worker sets flag to 1 when a tile is modified
      // pixi_worker clears flag to 0 after updating texture
      this.buffers.bloodTilesDirty = new SharedArrayBuffer(totalTiles);

      // Store tile grid metadata for workers
      this.decalsTilesX = tilesX;
      this.decalsTilesY = tilesY;
      this.decalsTotalTiles = totalTiles;

      console.log(
        `   🩸 Blood Decals: ${tilesX}×${tilesY} = ${totalTiles} tiles (${tileSize}px world, ${tilePixelSize}px texture @ ${
          this.decalsResolution
        }x), ${(totalTileBytes / 1024 / 1024).toFixed(1)} MB`
      );
    } else {
      console.log(
        `   🩸 Blood Decals: DISABLED (decalsEnabled=${this.decalsEnabled}, config.particle.decals=${this.config.particle?.decals})`
      );
    }

    // Pre-initialize entityType values (MUST be after Transform initialization!)
    this.preInitializeEntityTypeArrays();

    // Mouse is always at index 0 (registered first), no configuration needed

    // Collision data buffer (for Unity-style collision detection)
    const maxCollisionPairs =
      this.config.physics?.maxCollisionPairs ||
      this.config.maxCollisionPairs ||
      10000;
    const COLLISION_BUFFER_SIZE = (1 + maxCollisionPairs * 2) * 4;
    this.buffers.collisionData = new SharedArrayBuffer(COLLISION_BUFFER_SIZE);
    this.views.collision = new Int32Array(this.buffers.collisionData);
    this.views.collision[0] = 0; // Initialize pair count to 0

    const INPUT_BUFFER_SIZE = this.inputBufferSize * 4; // 4 bytes per Int32
    this.buffers.inputData = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    this.views.input = new Int32Array(this.buffers.inputData);

    // Camera buffer: [zoom, containerX, containerY]
    const CAMERA_BUFFER_SIZE = 3 * 4;
    this.buffers.cameraData = new SharedArrayBuffer(CAMERA_BUFFER_SIZE);
    this.views.camera = new Float32Array(this.buffers.cameraData);

    // Initialize camera buffer
    this.views.camera[0] = this.camera.zoom; // zoom

    // Debug buffer: [flag0, flag1, flag2, ..., flag31]
    const DEBUG_BUFFER_SIZE = 32; // 32 debug flags (1 byte each)
    this.buffers.debugData = new SharedArrayBuffer(DEBUG_BUFFER_SIZE);

    // Initialize Debug API
    this.debug = new Debug(this.buffers.debugData);
    // console.log("🔧 Debug system initialized");

    // Synchronization buffer for logic workers (uses Atomics for thread-safe operations)
    // [0]: Current frame number (for debugging)
    // [1]: Worker completion counter (how many workers finished current frame)
    // [2]: Total number of logic workers (including main thread if job stealing enabled)
    // [3]: Barrier flag for Atomics.wait/notify
    // [4]: Main thread active flag (1 = active/visible, 0 = inactive/hidden tab)
    const SYNC_BUFFER_SIZE = 5 * 4;
    this.buffers.syncData = new SharedArrayBuffer(SYNC_BUFFER_SIZE);
    const syncView = new Int32Array(this.buffers.syncData);
    syncView[0] = 0; // Initialize frame counter
    syncView[1] = 0; // Initialize completion counter

    // Count main thread as a worker if job stealing is enabled
    this.mainThreadJobStealingEnabled =
      this.config.logic?.mainThreadJobStealing?.enabled ?? false;
    const totalWorkers = this.mainThreadJobStealingEnabled
      ? this.numberOfLogicWorkers + 1
      : this.numberOfLogicWorkers;
    syncView[2] = totalWorkers; // Total workers (logic workers + main thread if enabled)
    syncView[3] = 0; // Barrier flag
    syncView[4] = 1; // Main thread active (starts active)

    // Job queue buffer for dynamic work distribution
    // [0]: Current job index (atomically incremented by workers)
    // [1]: Total number of jobs
    // [2+]: Job ranges (start, end, start, end, ...) - each job is 2 ints
    const entitiesPerJob = this.config.logic?.numberOfEntitiesPerJob || 250;
    const totalJobs = Math.ceil(this.totalEntityCount / entitiesPerJob);
    const JOB_QUEUE_SIZE = (2 + totalJobs * 2) * 4; // header + (start,end) pairs
    this.buffers.jobQueueData = new SharedArrayBuffer(JOB_QUEUE_SIZE);
    const jobQueueView = new Int32Array(this.buffers.jobQueueData);
    jobQueueView[0] = 0; // Current job index (reset each frame by first worker)
    jobQueueView[1] = totalJobs; // Total jobs

    // Pre-create job ranges
    for (let i = 0; i < totalJobs; i++) {
      const startIndex = i * entitiesPerJob;
      const endIndex = Math.min(
        (i + 1) * entitiesPerJob,
        this.totalEntityCount
      );
      jobQueueView[2 + i * 2] = startIndex; // Job start
      jobQueueView[2 + i * 2 + 1] = endIndex; // Job end
    }

    // console.log(
    //   `📋 Created ${totalJobs} jobs (${entitiesPerJob} entities per job)`
    // );

    // Center camera on world
    const worldCenterX =
      this.config.worldWidth / 2 - this.config.canvasWidth / 2;
    const worldCenterY =
      this.config.worldHeight / 2 - this.config.canvasHeight / 2;
    this.camera.x = worldCenterX;
    this.camera.y = worldCenterY;

    this.views.camera[1] = this.camera.x; // containerX
    this.views.camera[2] = this.camera.y; // containerY
  }
  preInitializeEntityTypeArrays() {
    // PRE-INITIALIZE entityType values to prevent race condition
    // This ensures pixi_worker can read correct entityType values immediately
    // when creating sprites, even before logic_worker creates instances
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

  // Create canvas element
  createCanvas() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.config.canvasWidth;
    this.canvas.height = this.config.canvasHeight;
    document.body.appendChild(this.canvas);

    // console.log(
    //   `✅ Created canvas: ${this.config.canvasWidth}x${this.config.canvasHeight}`
    // );
  }

  async preloadAssets(imageUrls, spritesheetConfigs = {}) {
    this.loadedTextures = {};
    this.loadedSpritesheets = {};

    // NEW: Generate BigAtlas from all assets
    console.log("🎨 Generating BigAtlas from all assets...");

    try {
      const bigAtlas = await SpriteSheetRegistry.createBigAtlas(imageUrls, {
        maxWidth: 4096,
        maxHeight: 4096,
        padding: 2,
        heuristic: "best-short-side",
      });

      // Convert canvas to ImageBitmap for worker transfer
      const imageBitmap = await createImageBitmap(bigAtlas.canvas);

      // Store the bigAtlas as the only "spritesheet"
      this.loadedSpritesheets["bigAtlas"] = {
        json: bigAtlas.json,
        imageBitmap: imageBitmap,
      };

      // Register the bigAtlas in the registry
      SpriteSheetRegistry.register("bigAtlas", bigAtlas.json);

      // Register all proxy sheets for transparent lookups
      for (const [sheetName, proxyData] of Object.entries(
        bigAtlas.proxySheets
      )) {
        SpriteSheetRegistry.registerProxy(sheetName, proxyData);
      }

      console.log(
        `✅ BigAtlas ready with ${
          Object.keys(bigAtlas.proxySheets).length
        } proxy sheets`
      );

      // Store proxy sheets for worker initialization
      this.bigAtlasProxySheets = bigAtlas.proxySheets;

      // Store canvas and JSON reference for debugging/visualization
      this.bigAtlasCanvas = bigAtlas.canvas;
      this.bigAtlasJson = bigAtlas.json;

      // ========================================
      // BLOOD DECALS: Extract texture pixel data
      // ========================================
      // Extract RGBA pixel data for each frame in the bigAtlas
      // This data is sent to particle_worker for stamping
      if (this.decalsEnabled) {
        this.decalTextureData = this.extractDecalTextures(
          bigAtlas.canvas,
          bigAtlas.json
        );
        console.log(
          `🩸 Extracted ${
            Object.keys(this.decalTextureData).length
          } textures for blood decals`
        );
      }

      // Make helper functions available globally for easy access
      window.downloadBigAtlas = () => {
        const link = document.createElement("a");
        link.download = `bigAtlas_${bigAtlas.json.meta.size.w}x${bigAtlas.json.meta.size.h}.png`;
        link.href = this.bigAtlasCanvas.toDataURL();
        link.click();
        console.log(`📥 Downloaded bigAtlas: ${link.download}`);
      };

      window.inspectBigAtlas = () => {
        BigAtlasInspector.show(this.bigAtlasCanvas, this.bigAtlasJson);
      };

      console.log(
        "💡 TIP: Call inspectBigAtlas() or downloadBigAtlas() in console"
      );
    } catch (error) {
      console.error("❌ Failed to generate BigAtlas:", error);
      throw error;
    }
  }

  /**
   * Extract RGBA pixel data for decal textures from the bigAtlas
   * Used by particle_worker for stamping blood decals
   *
   * For particles, textureId = animation index in bigAtlas
   * Each animation in bigAtlas maps to a frame (or first frame of an animation)
   *
   * @param {HTMLCanvasElement} atlasCanvas - The bigAtlas canvas
   * @param {Object} atlasJson - The bigAtlas JSON metadata
   * @returns {Object} Map of textureId -> { width, height, rgba: ArrayBuffer }
   */
  extractDecalTextures(atlasCanvas, atlasJson) {
    const ctx = atlasCanvas.getContext("2d");
    const textures = {};

    // Iterate through all animations in bigAtlas
    // textureId in ParticleComponent = animation index
    // We extract the first frame of each animation
    const animationNames = Object.keys(atlasJson.animations);

    for (let textureId = 0; textureId < animationNames.length; textureId++) {
      const animName = animationNames[textureId];
      const frameList = atlasJson.animations[animName];

      if (!frameList || frameList.length === 0) continue;

      // Get the first frame of this animation
      const firstFrameName = frameList[0];
      const frameData = atlasJson.frames[firstFrameName];

      if (!frameData) {
        console.warn(
          `Decal texture: Frame "${firstFrameName}" not found for animation "${animName}"`
        );
        continue;
      }

      const frame = frameData.frame;

      // Extract pixel data for this frame
      const imageData = ctx.getImageData(frame.x, frame.y, frame.w, frame.h);

      // Store as transferable ArrayBuffer
      textures[textureId] = {
        width: frame.w,
        height: frame.h,
        rgba: imageData.data.buffer, // ArrayBuffer (transferable)
      };
    }

    console.log(
      `   Extracted ${
        Object.keys(textures).length
      } decal textures from bigAtlas`
    );

    return textures;
  }

  /**
   * Setup direct MessagePort communication between workers (delegates to utils.js)
   * This allows workers to communicate without going through the main thread
   * @returns {Object} workerPorts - Object mapping worker names to their ports
   */
  setupWorkerCommunication() {
    // Define which workers need direct communication
    const connections = [
      { from: "physics", to: "renderer" }, // Physics could send debug info to renderer
      // Add more connections as needed
    ];

    // Add connection for each logic worker to renderer
    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      connections.push({ from: `logic${i}`, to: "renderer" });
    }

    // console.log("🔗 Worker communication channels established:", connections);
    return setupWorkerCommunication(connections);
  }

  // Create and initialize all workers
  async createWorkers() {
    const { canvasWidth, canvasHeight, worldWidth, worldHeight } = this.config;

    // Create workers with module type
    // Add cache-busting parameter to force reload of workers
    const cacheBust = `?v=${Date.now()}`;
    this.workers.spatial = new Worker(
      `/src/workers/spatial_worker.js${cacheBust}`,
      { type: "module" }
    );

    // Create multiple logic workers based on config
    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      const logicWorker = new Worker(
        `/src/workers/logic_worker.js${cacheBust}`,
        { type: "module" }
      );
      logicWorker.name = `logic${i}`;
      this.workers.logicWorkers.push(logicWorker);
    }

    this.workers.physics = new Worker(
      `/src/workers/physics_worker.js${cacheBust}`,
      { type: "module" }
    );
    this.workers.renderer = new Worker(
      `/src/workers/pixi_worker.js${cacheBust}`,
      { type: "module" }
    );

    // Create particle worker if particles are configured
    if (this.hasParticles) {
      this.workers.particle = new Worker(
        `/src/workers/particle_worker.js${cacheBust}`,
        { type: "module" }
      );
      this.workers.particle.name = "particle";
    }

    this.workers.spatial.name = "spatial";
    this.workers.physics.name = "physics";
    this.workers.renderer.name = "renderer";

    // Preload assets before initializing workers
    // Extract spritesheet configs from imageUrls (or use separate config)
    const spritesheetConfigs = this.imageUrls.spritesheets || {};
    await this.preloadAssets(this.imageUrls, spritesheetConfigs);

    // Collect unique script paths for workers (filter out nulls/undefined)
    // Supports: absolute paths (/demos/...), relative paths (../../demos/...), and URLs (http://...)
    const scriptsToLoad = [
      ...new Set(
        this.registeredClasses
          .map((r) => r.scriptPath)
          .filter((path) => path !== null && path !== undefined)
          .map((path) => {
            // Absolute paths starting with / work directly with dynamic import()
            if (path.startsWith("/") || path.startsWith("http")) {
              return path;
            }
            // Legacy relative paths (../../demos/...) - keep as-is
            if (path.startsWith("../")) {
              return path;
            }
            // Other relative paths - prepend ../ for workers in src/workers/
            return `../${path}`;
          })
      ),
    ];

    // console.log("📜 Game scripts to load in workers:", scriptsToLoad);

    // Setup direct worker-to-worker communication via MessagePorts
    const workerPorts = this.setupWorkerCommunication();

    // Create single initialization object for all workers
    // Config is passed as-is with nested structure (physics, spatial, logic sub-configs)
    const initData = {
      msg: "init",
      buffers: {
        gameObjectData: this.buffers.gameObjectData,
        neighborData: this.buffers.neighborData,
        distanceData: this.buffers.distanceData,
        collisionData: this.buffers.collisionData,
        inputData: this.buffers.inputData,
        cameraData: this.buffers.cameraData,
        syncData: this.buffers.syncData, // Synchronization buffer for logic workers
        jobQueueData: this.buffers.jobQueueData, // Job queue for dynamic work distribution
        debugData: this.buffers.debugData, // Debug visualization flags
        // Component buffers
        componentData: this.buffers.componentData,
      },
      entityCount: this.totalEntityCount,
      config: this.config,
      scriptsToLoad: scriptsToLoad, // Scripts for workers to load dynamically
      registeredClasses: this.registeredClasses.map((r) => ({
        name: r.class.name,
        count: r.count,
        startIndex: r.startIndex,
        entityType: r.entityType, // Auto-assigned entity type ID
        components: r.components.map((c) => c.name), // Component names
        // Note: componentIndices no longer needed - dense allocation means entityIndex === componentIndex
      })),
      // Component pool sizes (all pools have totalEntityCount slots - dense allocation)
      componentPools: Object.fromEntries(
        Object.entries(this.componentPools).map(([name, pool]) => [
          name,
          { count: this.totalEntityCount }, // DENSE: all components have slots for all entities
        ])
      ),
      // Key index mapping for Keyboard class
      keyIndexMap: this.createKeyIndexMap(),
      // Spritesheet registry metadata for animation lookups
      spritesheetMetadata: SpriteSheetRegistry.serialize(),
      // Particle system info (separate from entity system)
      maxParticles: this.maxParticles,

      // ========================================
      // BLOOD DECALS TILEMAP - Worker Data
      // ========================================
      // Passed to both particle_worker (for stamping) and pixi_worker (for rendering)
      decals: this.decalsEnabled
        ? {
            enabled: true,
            tileSize: this.decalsTileSize, // World units each tile covers
            tilePixelSize: this.decalsTilePixelSize, // Actual pixel size of textures
            resolution: this.decalsResolution, // Resolution multiplier (0.5 = half res)
            tilesX: this.decalsTilesX,
            tilesY: this.decalsTilesY,
            totalTiles: this.decalsTotalTiles,
            // SharedArrayBuffers for cross-worker communication
            tilesRGBA: this.buffers.bloodTilesRGBA, // RGBA pixel data
            tilesDirty: this.buffers.bloodTilesDirty, // Dirty flags
            // Texture pixel data for stamping (particle_worker needs this)
            // Map of textureId -> { width, height, rgba: ArrayBuffer }
            textures: this.decalTextureData,
          }
        : null,

      // ========================================
      // SHADOW SPRITE SYSTEM - Worker Data
      // ========================================
      // Passed to particle_worker (for calculating) and pixi_worker (for rendering)
      shadows: this.shadowsEnabled
        ? {
            enabled: true,
            maxShadowCastingLights: this.maxShadowCastingLights,
            maxShadowsPerLight: this.maxShadowsPerLight,
            maxShadowSprites: this.maxShadowSprites,
            maxDistanceFromLight: this.maxDistanceFromLight,
            // SharedArrayBuffer for shadow sprite data (uses ShadowCaster schema)
            spriteData: this.buffers.shadowSpriteData,
          }
        : null,
    };

    // Initialize spatial worker (no ports needed for now)
    this.workers.spatial.postMessage(initData);

    // Initialize logic workers (using job-based system - no static ranges)
    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      this.workers.logicWorkers[i].postMessage(
        {
          ...initData,
          workerPorts: workerPorts[`logic${i}`],
          workerIndex: i, // Just for identification/logging
          bigAtlasProxySheets: this.bigAtlasProxySheets || {}, // Proxy sheet metadata for animation lookups
        },
        workerPorts[`logic${i}`] ? Object.values(workerPorts[`logic${i}`]) : []
      );

      // console.log(`🧠 Logic Worker ${i}: Initializing...`);
    }

    // Initialize physics worker (with port to renderer)
    this.workers.physics.postMessage(
      {
        ...initData,
        workerPorts: workerPorts.physics,
      },
      workerPorts.physics ? Object.values(workerPorts.physics) : []
    );

    // Initialize particle worker if configured
    if (this.hasParticles && this.workers.particle) {
      this.workers.particle.postMessage(initData);
    }

    // Initialize renderer worker (transfer canvas, textures, spritesheets, and ports)
    const offscreenCanvas = this.canvas.transferControlToOffscreen();

    // Prepare transferable objects: canvas + texture ImageBitmaps + spritesheet ImageBitmaps + MessagePorts
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
        textures: this.loadedTextures, // Simple textures (empty with bigAtlas)
        spritesheets: this.loadedSpritesheets, // Spritesheets with JSON + ImageBitmap (bigAtlas only)
        bigAtlasProxySheets: this.bigAtlasProxySheets || {}, // Proxy sheet metadata for transparent lookups
        workerPorts: workerPorts.renderer, // MessagePorts for direct communication
      },
      transferables
    );

    // Setup message handlers for all workers
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

      // Add error handler to catch worker crashes
      worker.onerror = (e) => {
        console.error(
          `❌ ERROR in ${worker.name} worker:\n`,
          `Message: ${e.message}\n`,
          `File: ${e.filename}:${e.lineno}:${e.colno}`,
          e
        );
        // We don't prevent default so it still shows up as an error in dev tools
      };
    }

    // console.log("✅ Created and initialized 4 workers");
  }

  handleMessageFromWorker(e) {
    // const fromWorker = this.workers[e.currentTarget.name];

    if (e.data.msg === "fps") {
      this.updateFPS(
        e.currentTarget.name,
        e.data.fps,
        e.data.activeEntities,
        e.data
      );
    } else if (e.data.msg === "log") {
      this.log.push({
        worker: e.currentTarget.name,
        message: e.data.message,
        when: e.data.when - GameEngine.now,
      });
    } else if (e.data.msg === "workerReady") {
      this.handleWorkerReady(e.currentTarget.name);
    }
  }

  /**
   * Handle worker ready signal - part of two-phase initialization
   * When all workers are ready, broadcast start signal
   */
  handleWorkerReady(workerName) {
    // console.log(`✅ ${workerName} worker is ready`);
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

    // Check if all workers are ready
    const allReady = Object.values(this.workerReadyStates).every(
      (ready) => ready
    );

    if (allReady) {
      // console.log("🎮 All workers ready! Starting synchronized game loop...");
      this.startAllWorkers();
      if (this.resolveReady) this.resolveReady();
    } else {
      // Count how many are ready
      const readyCount = Object.values(this.workerReadyStates).filter(
        (r) => r
      ).length;
      // console.log(
      //   `   Waiting... (${readyCount}/${this.totalWorkers} workers ready)`
      // );
    }
  }

  /**
   * Send start signal to all workers once they're all ready
   * This ensures synchronized startup with no race conditions
   */
  startAllWorkers() {
    // console.log("📢 Broadcasting START to all workers");

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

    // Spawn the Mouse entity for spatial grid tracking
    this.spawnEntity("Mouse", {});
    // console.log("🖱️ Mouse entity spawned for spatial tracking");

    // console.log("✅ All workers started synchronously!");
  }

  updatePhysicsConfig(partialConfig = {}) {
    if (!partialConfig || typeof partialConfig !== "object") {
      return;
    }

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
  updateFPS(id, fps, activeEntities, data = {}) {
    const element = document.getElementById(id + "FPS");
    if (element) {
      const baseText = element.textContent.split(":")[0];
      if (id === "particle" && data.activeParticles !== undefined) {
        // Particle worker - show active/total particles
        element.textContent = `${baseText}: ${fps} FPS (${data.activeParticles}/${data.totalParticles} particles)`;
      } else if (id === "renderer" && data.drawCalls !== undefined) {
        // Renderer worker - show draw calls and visible counts
        const visible = (data.visibleEntities || 0) + (data.visibleParticles || 0);
        element.textContent = `${baseText}: ${fps} FPS (${data.drawCalls} draw calls, ${visible} visible)`;
      } else if (activeEntities !== undefined) {
        element.textContent = `${baseText}: ${fps} FPS (${activeEntities} active)`;
      } else {
        element.textContent = `${baseText}: ${fps}`;
      }
    }
  }

  updateMainFPS() {
    const element = document.getElementById("mainFPS");
    if (element) {
      element.textContent = `Main Thread: ${this.mainFPS.toFixed(2)} FPS`;
    }

    // Update job stealing stats if enabled
    this.updateJobStealingUI();
  }

  updateJobStealingUI() {
    const element = document.getElementById("jobStealing");
    if (!element) return;

    if (this.mainThreadHelper && this.mainThreadHelper.enabled) {
      const stats = this.mainThreadHelper.getStats();
      const modeLabel = stats.isMainThreadOnlyMode ? " [ONLY]" : "";
      element.textContent = `Main Thread${modeLabel}: ${stats.entitiesThisFrame} entities (${stats.jobsThisFrame} jobs)`;
    } else {
      element.textContent = `Main Thread Jobs: disabled`;
    }
  }

  updateActiveUnits(count) {
    const element = document.getElementById("activeUnits");
    if (element) {
      element.textContent = `ACtive units: ${count} / ${this.totalEntityCount}`;
    }
  }

  updateVisibleUnits(count) {
    const element = document.getElementById("visibleUnits");
    if (element) {
      element.textContent = `Visible units: ${count} / ${this.totalEntityCount}`;
    }
  }

  // Setup all event listeners
  setupEventListeners() {
    // Keyboard events
    window.addEventListener("keydown", (e) => {
      const key = e.key.toLowerCase();
      this.keyboard[key] = true;
      this.updateKeyboardBuffer();
    });

    window.addEventListener("keyup", (e) => {
      const key = e.key.toLowerCase();
      this.keyboard[key] = false;
      this.updateKeyboardBuffer();
    });

    this.canvas.addEventListener("mousedown", (e) => {
      if (e.button == 0) Mouse.isButton0Down = true;
      if (e.button == 1) Mouse.isButton1Down = true;
      if (e.button == 2) Mouse.isButton2Down = true;
    });

    this.canvas.addEventListener("mouseup", (e) => {
      if (e.button == 0) Mouse.isButton0Down = false;
      if (e.button == 1) Mouse.isButton1Down = false;
      if (e.button == 2) Mouse.isButton2Down = false;
    });

    // Mouse events - convert canvas pixels to world coordinates
    this.canvas.addEventListener("mousemove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      Mouse.isPresent = true;
      Mouse.setCanvasPosition(
        e.clientX - rect.left,
        e.clientY - rect.top,
        this.camera
      );
    });

    this.canvas.addEventListener("mouseleave", () => {
      Mouse.isPresent = false;
    });

    // Mouse wheel for zoom
    window.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();

        const oldZoom = this.camera.zoom;
        const newZoom = Math.max(0.1, Math.min(5, oldZoom + -e.deltaY * 0.001));

        // Zoom around the center of the screen
        const centerX = this.config.canvasWidth / 2;
        const centerY = this.config.canvasHeight / 2;

        // World position of the center point before zoom
        const worldCenterX = centerX / oldZoom + this.camera.x;
        const worldCenterY = centerY / oldZoom + this.camera.y;

        // Adjust camera position so the center point stays at the same world position
        this.camera.x = worldCenterX - centerX / newZoom;
        this.camera.y = worldCenterY - centerY / newZoom;
        this.camera.zoom = newZoom;

        this.updateCameraBuffer();
      },
      { passive: false }
    );

    // Visibility change listener for job stealing optimization
    // When tab/window is inactive, requestAnimationFrame stops, so workers
    // should not count on the main thread to process entities or signal completion
    document.addEventListener("visibilitychange", () => {
      this.handleVisibilityChange();
    });

    // console.log("✅ Setup event listeners");
  }

  /**
   * Handle visibility change (tab becomes visible/hidden)
   * Updates syncData[4] so workers know whether to count the main thread
   */
  handleVisibilityChange() {
    const isVisible = !document.hidden;

    // Only relevant if main thread job stealing is enabled
    if (!this.mainThreadJobStealingEnabled || !this.buffers.syncData) {
      return;
    }

    const syncView = new Int32Array(this.buffers.syncData);

    // Update main thread active flag atomically
    // syncData[4]: 1 = active (visible), 0 = inactive (hidden)
    Atomics.store(syncView, 4, isVisible ? 1 : 0);

    // Also notify the MainThreadLogicHelper about visibility change
    if (this.mainThreadHelper) {
      this.mainThreadHelper.setWindowVisible(isVisible);
    }

    console.log(
      `🪟 Window visibility changed: ${
        isVisible ? "VISIBLE" : "HIDDEN"
      } - Main thread ${
        isVisible ? "participating in" : "excluded from"
      } job stealing`
    );
  }

  // Update keyboard state in inputData buffer
  updateKeyboardBuffer() {
    const input = this.views.input;
    for (const [key, index] of Object.entries(this.keyMap)) {
      input[index] = this.keyboard[key] ? 1 : 0;
    }
  }

  // Update camera buffer
  updateCameraBuffer() {
    const cam = this.views.camera;
    cam[0] = this.camera.zoom;
    cam[1] = this.camera.x;
    cam[2] = this.camera.y;

    // Update mouse world position when camera changes
    Mouse.updateWorldPosition(this.camera);
  }

  // Main game loop (runs in main thread)
  startMainLoop() {
    const loop = (currentTime) => {
      const deltaTime = currentTime - this.lastFrameTime;
      this.lastFrameTime = currentTime;

      // Update game logic
      this.update(deltaTime);

      // Update main thread FPS using moving average
      this.mainFrameNumber++;
      this.mainFrameTimesSum -= this.mainFrameTimes[this.mainFrameTimeIndex];
      this.mainFrameTimes[this.mainFrameTimeIndex] = deltaTime;
      this.mainFrameTimesSum += deltaTime;
      this.mainFrameTimeIndex =
        (this.mainFrameTimeIndex + 1) % this.mainFPSFrameCount;

      const averageFrameTime = this.mainFrameTimesSum / this.mainFPSFrameCount;
      this.mainFPS = 1000 / averageFrameTime;

      // Update UI periodically
      if (this.mainFrameNumber % this.mainFPSReportInterval === 0) {
        this.updateMainFPS();
      }

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }

  // Main update function (60fps)
  update(deltaTime) {
    const dtRatio = deltaTime / 16.67;
    const moveSpeed = (-10 / this.camera.zoom) * dtRatio;

    if (this.keyboard.w || this.keyboard.arrowup) {
      this.camera.y += moveSpeed;
    }
    if (this.keyboard.s || this.keyboard.arrowdown) {
      this.camera.y -= moveSpeed;
    }
    if (this.keyboard.a || this.keyboard.arrowleft) {
      this.camera.x += moveSpeed;
    }
    if (this.keyboard.d || this.keyboard.arrowright) {
      this.camera.x -= moveSpeed;
    }

    this.updateCameraBuffer();

    // Main thread job stealing: help workers by processing entity jobs
    if (this.mainThreadHelper) {
      this.mainThreadHelper.processJobs(deltaTime, dtRatio);
    }

    this.updateVisibleUnits(
      SpriteRenderer.isItOnScreen.filter((v) => !!v).length
    );
    this.updateActiveUnits(Transform.active.filter((v) => !!v).length);
  }

  /**
   * Create key index mapping for workers
   * Returns the keyMap that maps key names to their buffer indices
   * @returns {Object} - Key-to-index mapping
   */
  createKeyIndexMap() {
    return this.keyMap;
  }

  // Cleanup
  destroy() {
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

    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    // console.log("🔴 GameEngine destroyed");
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

  /**
   * Spawn an entity from the pool
   * Sends spawn command to all logic workers (they coordinate internally)
   *
   * @param {string} className - Name of the entity class (e.g., 'Prey', 'Predator')
   * @param {Object} spawnConfig - Initial configuration (position, velocity, etc.)
   *
   * @example
   * gameEngine.spawnEntity('Prey', { x: 500, y: 300, vx: 2, vy: -1 });
   */
  spawnEntity(className, spawnConfig = {}) {
    // If we have logic workers, broadcast to them
    if (this.workers.logicWorkers && this.workers.logicWorkers.length > 0) {
      // Broadcast to all logic workers - each worker manages its own entity range
      this.workers.logicWorkers.forEach((worker) => {
        worker.postMessage({
          msg: "spawn",
          className: className,
          spawnConfig: spawnConfig,
        });
      });
    } else if (this.mainThreadHelper) {
      // Main thread only mode - spawn directly
      this.mainThreadHelper.spawnEntity(className, spawnConfig);
    } else {
      console.error(
        "No logic workers or main thread helper available for spawning"
      );
    }
  }

  /**
   * Despawn all entities of a specific type
   *
   * @param {string} className - Name of the entity class to despawn
   */
  despawnAllEntities(className) {
    // If we have logic workers, broadcast to them
    if (this.workers.logicWorkers && this.workers.logicWorkers.length > 0) {
      // Broadcast to all logic workers - each worker despawns entities in its range
      this.workers.logicWorkers.forEach((worker) => {
        worker.postMessage({
          msg: "despawnAll",
          className: className,
        });
      });
    } else if (this.mainThreadHelper) {
      // Main thread only mode - despawn directly
      this.mainThreadHelper.despawnAllEntities(className);
    } else {
      console.error(
        "No logic workers or main thread helper available for despawning"
      );
    }
  }

  /**
   * Get pool statistics for an entity class
   * Note: This reads from SharedArrayBuffer so it's always current
   *
   * @param {Class} EntityClass - The entity class to check
   * @returns {Object} - { total, active, available }
   */
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

  /**
   * Enable or disable detailed profiling in logic workers
   * When enabled, workers will log performance breakdowns every ~2 seconds
   * @param {boolean} enabled - Whether to enable profiling
   */
  enableProfiling(enabled = true) {
    if (!this.workers.logicWorkers || this.workers.logicWorkers.length === 0) {
      console.error("Logic workers not initialized");
      return;
    }

    console.log(
      `${enabled ? "Enabling" : "Disabling"} profiling on all logic workers...`
    );

    this.workers.logicWorkers.forEach((worker) => {
      worker.postMessage({
        msg: "enableProfiling",
        enabled: enabled,
      });
    });
  }

  /**
   * Get statistics from the main thread job stealing helper
   * @returns {Object|null} - Stats object or null if not enabled
   */
  getJobStealingStats() {
    if (!this.mainThreadHelper) return null;
    return this.mainThreadHelper.getStats();
  }

  /**
   * Enable or disable main thread job stealing at runtime
   * Note: This only works if mainThreadJobStealing was enabled in config
   * (otherwise the helper won't be initialized)
   * @param {boolean} enabled - Whether to enable job stealing
   */
  setJobStealingEnabled(enabled) {
    if (!this.mainThreadHelper) {
      console.warn(
        "Main thread job stealing not initialized. " +
          "Set config.logic.mainThreadJobStealing.enabled = true to use this feature."
      );
      return;
    }
    this.mainThreadHelper.setEnabled(enabled);
  }

  /**
   * Set the maximum number of jobs the main thread processes per frame
   * Lower values = more responsive UI, less help to workers
   * Higher values = more help to workers, potentially choppy UI
   * @param {number} max - Max jobs per frame (0 = unlimited)
   */
  setJobStealingMaxJobsPerFrame(max) {
    if (!this.mainThreadHelper) {
      console.warn(
        "Main thread job stealing not initialized. " +
          "Set config.logic.mainThreadJobStealing.enabled = true to use this feature."
      );
      return;
    }
    this.mainThreadHelper.setMaxJobsPerFrame(max);
  }
}

// ES6 module export
export { GameEngine };
