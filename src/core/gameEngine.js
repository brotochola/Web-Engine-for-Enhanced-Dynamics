// GameEngine.js - Centralized game initialization and state management
// Handles workers, SharedArrayBuffers, class registration, and input management

import { GameObject } from "./gameObject.js";
import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { setupWorkerCommunication } from "./utils.js";

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
    this.mouse = null; //{ x: -100000, y: -100000 };
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
      // Component buffers (core + custom components auto-registered)
      componentData: {
        Transform: null,
        RigidBody: null,
        Collider: null,
        SpriteRenderer: null,
      },
    };

    // Component pool tracking
    this.componentPools = {
      Transform: { count: 0, ComponentClass: Transform, indices: new Map() },
      RigidBody: { count: 0, ComponentClass: RigidBody, indices: new Map() },
      Collider: { count: 0, ComponentClass: Collider, indices: new Map() },
      SpriteRenderer: {
        count: 0,
        ComponentClass: SpriteRenderer,
        indices: new Map(),
      },
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

    // Key mapping for input buffer
    this.keyMap = {
      w: 0,
      a: 1,
      s: 2,
      d: 3,
      arrowup: 4,
      arrowdown: 5,
      arrowleft: 6,
      arrowright: 7,
      " ": 8, // spacebar
      shift: 9,
      control: 10,
    };

    // Frame timing
    this.lastFrameTime = performance.now();
    this.updateRate = 1000 / 60; // 60 fps

    // Initialization promise
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  /**
   * Register an entity class (e.g., Ball, Car)
   * This calculates buffer sizes and tracks entity ranges
   * @param {Class} EntityClass - The class to register (must extend GameObject)
   * @param {number} count - Number of entities of this type
   * @param {string} scriptPath - Path to the script file (for worker loading)
   */
  registerEntityClass(EntityClass, count, scriptPath = null) {
    // Auto-detect and register parent classes (if not already registered)
    this._autoRegisterParentClasses(EntityClass);

    // Validate spriteConfig for entities that have SpriteRenderer component
    const components = GameObject._collectComponents(EntityClass);
    if (components.includes(SpriteRenderer) && count > 0) {
      // Validate spriteConfig
      if (!EntityClass.spriteConfig) {
        console.error(
          `❌ ${EntityClass.name} has SpriteRenderer component but no spriteConfig defined!`
        );
        throw new Error(`${EntityClass.name} must define static spriteConfig`);
      }
    }

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

    // Allocate component pool space for this entity class
    const componentIndices = {};
    for (const ComponentClass of components) {
      const componentName = ComponentClass.name;
      let pool = this.componentPools[componentName];

      // Auto-create pool for custom components (e.g., Flocking)
      if (!pool) {
        console.log(`📦 Auto-registering custom component: ${componentName}`);
        pool = {
          count: 0,
          ComponentClass: ComponentClass,
          indices: new Map(),
        };
        this.componentPools[componentName] = pool;
      }

      // Allocate space in this component's pool
      componentIndices[componentName] = {
        start: pool.count,
        count: count,
      };

      pool.count += count;
      pool.indices.set(EntityClass.name, componentIndices[componentName]);
    }

    this.registeredClasses.push({
      class: EntityClass,
      count: count,
      startIndex: startIndex,
      scriptPath: scriptPath, // Track script path for workers
      components: components, // Track which components this entity uses
      componentIndices: componentIndices, // Track component pool allocations
    });

    this.totalEntityCount += count;

    // Auto-initialize required static properties if they don't exist
    if (!EntityClass.hasOwnProperty("instances")) {
      EntityClass.instances = [];
    }

    // Store spawning system metadata
    EntityClass.startIndex = startIndex;
    EntityClass.totalCount = count;

    console.log(
      `✅ Registered ${
        EntityClass.name
      }: ${count} entities with components: ${components
        .map((c) => c.name)
        .join(", ")}`
    );
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

        console.log(
          `🔧 Auto-registered parent class ${ParentClass.name} (0 instances) for ${EntityClass.name}`
        );
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

    this.preInitializeEntityTypeArrays();

    // 2. Create Component buffers
    console.log("📦 Creating component buffers...");

    // Initialize ALL components (core and custom) using the same logic
    console.log(
      `   Component pools: ${Object.keys(this.componentPools).join(", ")}`
    );

    for (const [componentName, pool] of Object.entries(this.componentPools)) {
      if (pool.count > 0 && pool.ComponentClass) {
        const ComponentClass = pool.ComponentClass;
        const bufferSize = ComponentClass.getBufferSize(pool.count);
        this.buffers.componentData[componentName] = new SharedArrayBuffer(
          bufferSize
        );
        ComponentClass.initializeArrays(
          this.buffers.componentData[componentName],
          pool.count
        );

        const isTransform = componentName === "Transform";
        const note = isTransform ? " (all entities have Transform)" : "";
        console.log(
          `   ✅ ${componentName}: ${bufferSize} bytes for ${pool.count} entities${note}`
        );
      }
    }

    // Collision data buffer (for Unity-style collision detection)
    const maxCollisionPairs =
      this.config.physics?.maxCollisionPairs ||
      this.config.maxCollisionPairs ||
      10000;
    const COLLISION_BUFFER_SIZE = (1 + maxCollisionPairs * 2) * 4;
    this.buffers.collisionData = new SharedArrayBuffer(COLLISION_BUFFER_SIZE);
    this.views.collision = new Int32Array(this.buffers.collisionData);
    this.views.collision[0] = 0; // Initialize pair count to 0

    // Input buffer: [mouseX, mouseY, key0, key1, key2, ...]
    const INPUT_BUFFER_SIZE = 32 * 4;
    this.buffers.inputData = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    this.views.input = new Int32Array(this.buffers.inputData);

    // Camera buffer: [zoom, containerX, containerY]
    const CAMERA_BUFFER_SIZE = 3 * 4;
    this.buffers.cameraData = new SharedArrayBuffer(CAMERA_BUFFER_SIZE);
    this.views.camera = new Float32Array(this.buffers.cameraData);

    // Initialize camera buffer
    this.views.camera[0] = this.camera.zoom; // zoom

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
    const entitiesPerJob = this.config.logic?.numberOfEntitiesPerJob || 1000;
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

    console.log(
      `📋 Created ${totalJobs} jobs (${entitiesPerJob} entities per job)`
    );

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
          GameObject.entityType[i] = EntityClass.entityType;
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

    // Debug: log what we received
    console.log("📦 preloadAssets called with:", {
      imageUrls: imageUrls,
      imageUrlsKeys: Object.keys(imageUrls),
      spritesheetConfigsKeys: Object.keys(spritesheetConfigs),
    });

    // Load simple textures (filter out 'spritesheets' key and non-string values)
    const textureEntries = Object.entries(imageUrls).filter(([name, url]) => {
      console.log(
        `  Checking entry: "${name}" = ${
          typeof url === "string" ? url : `[${typeof url}]`
        }`
      );

      // Skip the spritesheets object
      if (name === "spritesheets") {
        console.log(`    ⏭️ Skipping "spritesheets" object`);
        return false;
      }
      // Skip non-string URLs
      if (typeof url !== "string") {
        console.warn(
          `    ⚠️ Skipping invalid texture "${name}": not a string URL`
        );
        return false;
      }
      console.log(`    ✅ Including texture "${name}"`);
      return true;
    });

    console.log(`📦 Loading ${textureEntries.length} textures...`);

    const texturePromises = textureEntries.map(async ([name, url]) => {
      try {
        const img = new Image();
        img.crossOrigin = "anonymous";

        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = url;
        });

        // Convert to ImageBitmap (transferable to worker)
        const imageBitmap = await createImageBitmap(img);
        this.loadedTextures[name] = imageBitmap;

        console.log(`✅ Loaded texture: ${name}`);
      } catch (error) {
        console.error(`❌ Failed to load texture ${name} from ${url}:`, error);
      }
    });

    // Load spritesheets (JSON + PNG)
    console.log(
      `📦 Loading ${Object.keys(spritesheetConfigs).length} spritesheets...`
    );

    const spritesheetPromises = Object.entries(spritesheetConfigs).map(
      async ([name, config]) => {
        try {
          console.log(`  Loading spritesheet "${name}"...`);

          // Validate config
          if (!config.json || !config.png) {
            throw new Error(
              `Invalid spritesheet config: missing json or png property`
            );
          }

          // Load JSON
          const jsonResponse = await fetch(config.json);
          const jsonData = await jsonResponse.json();

          // Load image
          const img = new Image();
          img.crossOrigin = "anonymous";

          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = config.png;
          });

          // Convert to ImageBitmap (transferable to worker)
          const imageBitmap = await createImageBitmap(img);

          this.loadedSpritesheets[name] = {
            json: jsonData,
            imageBitmap: imageBitmap,
          };

          console.log(
            `✅ Loaded spritesheet: ${name} with ${
              Object.keys(jsonData.animations || {}).length
            } animations`
          );
        } catch (error) {
          console.error(`❌ Failed to load spritesheet ${name}:`, error);
        }
      }
    );

    // Wait for all assets to load
    await Promise.all([...texturePromises, ...spritesheetPromises]);

    console.log(
      `✅ Preloaded ${Object.keys(this.loadedTextures).length} textures and ${
        Object.keys(this.loadedSpritesheets).length
      } spritesheets`
    );
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

    console.log("🔗 Worker communication channels established:", connections);
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
    // Adjust paths to be relative to worker location (workers are in lib/ folder)
    const scriptsToLoad = [
      ...new Set(
        this.registeredClasses
          .map((r) => r.scriptPath)
          .filter((path) => path !== null && path !== undefined)
          .map((path) => {
            // If path doesn't start with ../ or http, prepend ../ for workers in lib/
            if (!path.startsWith("../") && !path.startsWith("http")) {
              return `../${path}`;
            }
            return path;
          })
      ),
    ];

    console.log("📜 Game scripts to load in workers:", scriptsToLoad);

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
        components: r.components.map((c) => c.name), // Component names
        componentIndices: r.componentIndices, // Component pool allocation { Transform: {start, count}, ... }
      })),
      // Component pool sizes (for workers to know buffer sizes)
      // Send ALL component pools (core and custom)
      componentPools: Object.fromEntries(
        Object.entries(this.componentPools).map(([name, pool]) => [
          name,
          { count: pool.count },
        ])
      ),
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
        },
        workerPorts[`logic${i}`] ? Object.values(workerPorts[`logic${i}`]) : []
      );

      console.log(`🧠 Logic Worker ${i}: Ready for job-based processing`);
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
        textures: this.loadedTextures, // Simple textures
        spritesheets: this.loadedSpritesheets, // Spritesheets with JSON + ImageBitmap
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
    console.log(`✅ ${workerName} worker is ready`);
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
      console.log("🎮 All workers ready! Starting synchronized game loop...");
      this.startAllWorkers();
      if (this.resolveReady) this.resolveReady();
    } else {
      // Count how many are ready
      const readyCount = Object.values(this.workerReadyStates).filter(
        (r) => r
      ).length;
      console.log(
        `   Waiting... (${readyCount}/${this.totalWorkers} workers ready)`
      );
    }
  }

  /**
   * Send start signal to all workers once they're all ready
   * This ensures synchronized startup with no race conditions
   */
  startAllWorkers() {
    console.log("📢 Broadcasting START to all workers");

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

    console.log("✅ All workers started synchronously!");
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
      this.updateInputBuffer();
    });

    window.addEventListener("keyup", (e) => {
      const key = e.key.toLowerCase();
      this.keyboard[key] = false;
      this.updateInputBuffer();
    });

    this.canvas.addEventListener("mousedown", (e) => {
      if (!this.mouse) this.mouse = {};
      if (e.button == 0) {
        this.mouse.button0Down = true;
      }
      if (e.button == 1) {
        this.mouse.button1Down = true;
      }
      if (e.button == 2) {
        this.mouse.button2Down = true;
      }
      this.updateInputBuffer();
    });

    this.canvas.addEventListener("mouseup", (e) => {
      if (!this.mouse) this.mouse = {};
      if (e.button == 0) {
        this.mouse.button0Down = false;
      }
      if (e.button == 1) {
        this.mouse.button1Down = false;
      }
      if (e.button == 2) {
        this.mouse.button2Down = false;
      }
      this.updateInputBuffer();
    });

    // Mouse events - convert canvas pixels to world coordinates
    this.canvas.addEventListener("mousemove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      // Convert to world coordinates (Y-down system)
      // World position = (canvas position + camera position) / zoom
      if (!this.mouse) this.mouse = {};
      this.mouse.x = canvasX / this.camera.zoom + this.camera.x;
      this.mouse.y = canvasY / this.camera.zoom + this.camera.y;

      this.updateInputBuffer();
    });

    this.canvas.addEventListener("mouseleave", (e) => {
      this.mouse = null;
      this.updateInputBuffer();
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

  // Update input buffer with current input state
  updateInputBuffer() {
    const input = this.views.input;
    if (this.mouse) {
      input[0] = this.mouse.x;
      input[1] = this.mouse.y;
      input[2] = 1; // Mouse present flag
      input[3] = this.mouse.button0Down ? 1 : 0; // Mouse down flag
      input[4] = this.mouse.button1Down ? 1 : 0; // Mouse down flag
      input[5] = this.mouse.button2Down ? 1 : 0; // Mouse down flag
    } else {
      input[0] = 0; // Clear mouse position
      input[1] = 0;
      input[2] = 0; // Mouse NOT present
      input[3] = 0;
      input[4] = 0;
      input[5] = 0;
    }

    for (const [key, index] of Object.entries(this.keyMap)) {
      input[6 + index] = this.keyboard[key] ? 1 : 0; // Keyboard starts at index 3
    }
  }

  // Update camera buffer
  updateCameraBuffer() {
    const cam = this.views.camera;
    cam[0] = this.camera.zoom;
    cam[1] = this.camera.x;
    cam[2] = this.camera.y;
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
}

// ES6 module export
export { GameEngine };
