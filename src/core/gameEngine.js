// GameEngine.js - Centralized game initialization and state management
// Handles workers, SharedArrayBuffers, class registration, and input management

import { GameObject } from "./gameObject.js";
import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { SpriteSheetRegistry } from "./SpriteSheetRegistry.js";
import { setupWorkerCommunication } from "./utils.js";
import { Debug } from "./Debug.js";
import { Mouse } from "./Mouse.js";
import { BigAtlasInspector } from "./BigAtlasInspector.js";

class GameEngine {
  static now = Date.now();
  constructor(config, imageUrls) {
    this.log = [];
    this.loadedTextures = null;
    this.imageUrls = imageUrls;
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
    this.numberOfLogicWorkers = this.config.logic?.numberOfLogicWorkers || 1;

    // Workers
    this.workers = {
      spatial: null,
      logicWorkers: [], // Array of logic workers
      physics: null,
      renderer: null,
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
    this.totalWorkers = 3 + this.numberOfLogicWorkers; // spatial + physics + renderer + N logic workers

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
    this.componentPools = {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      Collider: { ComponentClass: Collider },
      SpriteRenderer: { ComponentClass: SpriteRenderer },
    };

    // Typed array views
    this.views = {
      input: null,
      camera: null,
      collision: null,
    };

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
    // Auto-detect script path from EntityClass.scriptUrl (set via import.meta.url)
    if (!scriptPath && EntityClass.scriptUrl) {
      scriptPath = this._urlToPath(EntityClass.scriptUrl);
      // console.log(
      //   `🔍 Auto-detected script path for ${EntityClass.name}: ${scriptPath}`
      // );
    }

    // Auto-detect and register parent classes (if not already registered)
    this._autoRegisterParentClasses(EntityClass);

    // Collect all components for this entity class
    const components = GameObject._collectComponents(EntityClass);

    // Check if this class is already registered
    const existing = this.registeredClasses.find(
      (r) => r.class === EntityClass
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
      const alreadyRegistered = this.registeredClasses.some(
        (r) => r.class === ParentClass
      );

      if (!alreadyRegistered && ParentClass !== EntityClass) {
        // Register parent class with 0 instances
        const startIndex = this.totalEntityCount;

        // Parent classes don't get script paths automatically
        // Developer must explicitly register base classes that workers need to load
        // Library classes (GameObject, RenderableGameObject) are already imported by workers

        this.registeredClasses.push({
          class: ParentClass,
          count: 0,
          startIndex: startIndex,
          scriptPath: null, // No automatic script path
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

    // console.log("✅ GameEngine: Initialized successfully!");
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
    // [2]: Total number of logic workers
    // [3]: Barrier flag for Atomics.wait/notify
    const SYNC_BUFFER_SIZE = 4 * 4;
    this.buffers.syncData = new SharedArrayBuffer(SYNC_BUFFER_SIZE);
    const syncView = new Int32Array(this.buffers.syncData);
    syncView[0] = 0; // Initialize frame counter
    syncView[1] = 0; // Initialize completion counter
    syncView[2] = this.numberOfLogicWorkers; // Total workers
    syncView[3] = 0; // Barrier flag

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
      this.updateFPS(e.currentTarget.name, e.data.fps, e.data.activeEntities);
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
  updateFPS(id, fps, activeEntities) {
    const element = document.getElementById(id + "FPS");
    if (element) {
      const baseText = element.textContent.split(":")[0];
      if (activeEntities !== undefined) {
        element.textContent = `${baseText}: ${fps} FPS (${activeEntities} active)`;
      } else {
        element.textContent = `${baseText}: ${fps}`;
      }
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

    // console.log("✅ Setup event listeners");
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

      if (deltaTime >= this.updateRate) {
        this.update(deltaTime);
        this.lastFrameTime = currentTime;
      }

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
    // console.log("✅ Started main loop");
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
    if (!this.workers.logicWorkers || this.workers.logicWorkers.length === 0) {
      console.error("Logic workers not initialized");
      return;
    }

    // Broadcast to all logic workers - each worker manages its own entity range
    this.workers.logicWorkers.forEach((worker) => {
      worker.postMessage({
        msg: "spawn",
        className: className,
        spawnConfig: spawnConfig,
      });
    });
  }

  /**
   * Despawn all entities of a specific type
   *
   * @param {string} className - Name of the entity class to despawn
   */
  despawnAllEntities(className) {
    if (!this.workers.logicWorkers || this.workers.logicWorkers.length === 0) {
      console.error("Logic workers not initialized");
      return;
    }

    // Broadcast to all logic workers - each worker despawns entities in its range
    this.workers.logicWorkers.forEach((worker) => {
      worker.postMessage({
        msg: "despawnAll",
        className: className,
      });
    });
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
}

// ES6 module export
export { GameEngine };
