// GameEngine.js - Centralized game initialization and state management
// Handles workers, SharedArrayBuffers, class registration, and input management

class GameEngine {
  static now = Date.now();
  constructor(config, imageUrls) {
    this.log = [];
    this.loadedTextures = null;
    this.imageUrls = imageUrls;
    this.state = {
      pause: false,
    };
    this.config = config;

    // State
    this.keyboard = {};
    this.mouse = { x: -100000, y: -100000 };
    this.camera = {
      zoom: 1,
      x: 0, // Will be centered on world after init
      y: 0,
    };

    // Workers
    this.workers = {
      spatial: null,
      logic: null,
      physics: null,
      renderer: null,
    };

    // Worker synchronization (for two-phase initialization)
    this.workerReadyStates = {
      spatial: false,
      logic: false,
      physics: false,
      renderer: false,
    };
    this.totalWorkers = 4;

    // Shared buffers
    this.buffers = {
      gameObjectData: null,
      entityData: new Map(), // Map of EntityClassName -> SharedArrayBuffer
      neighborData: null,
      distanceData: null, // Squared distances for each neighbor
      collisionData: null,
      inputData: null,
      cameraData: null,
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
  }

  /**
   * Register an entity class (e.g., Boid, Enemy)
   * This calculates buffer sizes and tracks entity ranges
   * @param {Class} EntityClass - The class to register (must extend GameObject)
   * @param {number} count - Number of entities of this type
   * @param {string} scriptPath - Path to the script file (for worker loading)
   */
  registerEntityClass(EntityClass, count, scriptPath = null) {
    // Auto-detect and register parent classes (if not already registered)
    this._autoRegisterParentClasses(EntityClass);

    // Validate spriteConfig for entities that extend RenderableGameObject
    if (
      typeof RenderableGameObject !== "undefined" &&
      EntityClass.prototype instanceof RenderableGameObject &&
      count > 0
    ) {
      // Only validate if instances will be created
      const validation = RenderableGameObject.validateSpriteConfig(EntityClass);
      if (!validation.valid) {
        console.error(`❌ ${validation.error}`);
        console.error(
          `   Please define a proper spriteConfig in ${EntityClass.name}`
        );
        console.error(`   See SPRITE_CONFIG_GUIDE.md for examples`);
        throw new Error(validation.error);
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

    this.registeredClasses.push({
      class: EntityClass,
      count: count,
      startIndex: startIndex,
      scriptPath: scriptPath, // Track script path for workers
    });

    this.totalEntityCount += count;

    // Auto-initialize required static properties if they don't exist
    // This eliminates boilerplate from entity class definitions!
    if (!EntityClass.hasOwnProperty("sharedBuffer")) {
      EntityClass.sharedBuffer = null;
    }
    if (!EntityClass.hasOwnProperty("entityCount")) {
      EntityClass.entityCount = 0;
    }
    if (!EntityClass.hasOwnProperty("instances")) {
      EntityClass.instances = [];
    }

    // Automatically create schema properties for this entity class
    // This eliminates the need for developers to add a static block in each entity class!
    if (EntityClass.ARRAY_SCHEMA && EntityClass !== GameObject) {
      GameObject._createSchemaProperties(EntityClass);
    }

    // console.log(
    //   `✅ Registered ${
    //     EntityClass.name
    //   }: ${count} entities (indices ${startIndex}-${startIndex + count - 1})`
    // );
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

        // Initialize schema properties for parent class
        if (ParentClass.ARRAY_SCHEMA && ParentClass !== GameObject) {
          GameObject._createSchemaProperties(ParentClass);
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

    // console.log("✅ GameEngine: Initialized successfully!");
  }

  // Create all SharedArrayBuffers
  createSharedBuffers() {
    // GameObject buffer (transform + physics + perception)
    const gameObjectBufferSize = GameObject.getBufferSize(
      this.totalEntityCount
    );
    this.buffers.gameObjectData = new SharedArrayBuffer(gameObjectBufferSize);

    // Neighbor data buffer (create before initializing GameObject)
    const NEIGHBOR_BUFFER_SIZE =
      this.totalEntityCount * (1 + this.config.maxNeighbors) * 4;
    this.buffers.neighborData = new SharedArrayBuffer(NEIGHBOR_BUFFER_SIZE);

    // Distance data buffer (stores squared distances for each neighbor)
    // Same structure as neighborData: [count, dist1, dist2, ..., distN]
    // This eliminates duplicate distance calculations between spatial & logic workers
    const DISTANCE_BUFFER_SIZE =
      this.totalEntityCount * (1 + this.config.maxNeighbors) * 4;
    this.buffers.distanceData = new SharedArrayBuffer(DISTANCE_BUFFER_SIZE);

    // Initialize GameObject with neighbor and distance buffers
    GameObject.initializeArrays(
      this.buffers.gameObjectData,
      this.totalEntityCount,
      this.buffers.neighborData,
      this.buffers.distanceData
    );

    this.preInitializeEntityTypeArrays();

    // Initialize subclass buffers - generic for any entity type
    // IMPORTANT: Size arrays for TOTAL entity count, not just class count!
    // This is because subclasses use global indices (e.g., Predator at index 15000
    // needs to access Boid arrays, which must be sized for all entities)
    for (const registration of this.registeredClasses) {
      const { class: EntityClass, count } = registration;

      if (EntityClass.getBufferSize && EntityClass.initializeArrays) {
        const bufferSize = EntityClass.getBufferSize(this.totalEntityCount);
        const buffer = new SharedArrayBuffer(bufferSize);

        // Store buffer reference generically by class name
        this.buffers.entityData.set(EntityClass.name, buffer);

        EntityClass.initializeArrays(buffer, this.totalEntityCount);
      }
    }

    // Collision data buffer (for Unity-style collision detection)
    // Structure: [pairCount, entityA, entityB, entityA, entityB, ...]
    // Physics worker writes collision pairs, logic worker reads for callbacks
    const maxCollisionPairs = this.config.maxCollisionPairs || 10000;
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

    // Center camera on world
    const worldCenterX =
      this.config.worldWidth / 2 - this.config.canvasWidth / 2;
    const worldCenterY =
      this.config.worldHeight / 2 - this.config.canvasHeight / 2;
    this.camera.x = worldCenterX;
    this.camera.y = worldCenterY;

    this.views.camera[1] = this.camera.x; // containerX
    this.views.camera[2] = this.camera.y; // containerY

    // console.log(`✅ Created SharedArrayBuffers:`);
    // console.log(`   - GameObject Data: ${gameObjectBufferSize} bytes`);
    // this.buffers.entityData.forEach((buffer, className) => {
    //   console.log(`   - ${className} Data: ${buffer.byteLength} bytes`);
    // });
    // console.log(`   - Neighbor Data: ${NEIGHBOR_BUFFER_SIZE} bytes`);
    // console.log(`   - Input Data: ${INPUT_BUFFER_SIZE} bytes`);
    // console.log(`   - Camera Data: ${CAMERA_BUFFER_SIZE} bytes`);
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
   * Setup direct MessagePort communication between workers
   * This allows workers to communicate without going through the main thread
   * @returns {Object} workerPorts - Object mapping worker names to their ports
   */
  setupWorkerCommunication() {
    // Define which workers need direct communication
    const connections = [
      { from: "logic", to: "renderer" }, // Logic worker sends sprite commands to renderer
      { from: "physics", to: "renderer" }, // Physics could send debug info to renderer
      // Add more connections as needed
    ];

    const workerPorts = {}; // { logic: { renderer: port }, renderer: { logic: port } }

    connections.forEach(({ from, to }) => {
      const channel = new MessageChannel();

      // Initialize nested objects if they don't exist
      if (!workerPorts[from]) workerPorts[from] = {};
      if (!workerPorts[to]) workerPorts[to] = {};

      // Assign ports (bidirectional communication)
      workerPorts[from][to] = channel.port1;
      workerPorts[to][from] = channel.port2;
    });

    console.log("🔗 Worker communication channels established:", connections);
    return workerPorts;
  }

  // Create and initialize all workers
  async createWorkers() {
    const { canvasWidth, canvasHeight, worldWidth, worldHeight } = this.config;

    // Create workers
    // Add cache-busting parameter to force reload of workers
    const cacheBust = `?v=${Date.now()}`;
    this.workers.spatial = new Worker(`lib/spatial_worker.js${cacheBust}`);
    this.workers.logic = new Worker(`lib/logic_worker.js${cacheBust}`);
    this.workers.physics = new Worker(`lib/physics_worker.js${cacheBust}`);
    this.workers.renderer = new Worker(`lib/pixi_worker.js${cacheBust}`);

    this.workers.spatial.name = "spatial";
    this.workers.logic.name = "logic";
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
    const initData = {
      msg: "init",
      buffers: {
        ...this.buffers,
        entityData: Object.fromEntries(this.buffers.entityData), // Convert Map to plain object
      },
      entityCount: this.totalEntityCount,
      config: this.config,
      scriptsToLoad: scriptsToLoad, // Scripts for workers to load dynamically
      registeredClasses: this.registeredClasses.map((r) => ({
        name: r.class.name,
        count: r.count,
        startIndex: r.startIndex,
      })),
    };

    // Initialize spatial worker (no ports needed for now)
    this.workers.spatial.postMessage(initData);

    // Initialize logic worker (with port to renderer)
    this.workers.logic.postMessage(
      {
        ...initData,
        workerPorts: workerPorts.logic,
      },
      workerPorts.logic ? Object.values(workerPorts.logic) : []
    );

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

    for (let worker of Object.values(this.workers)) {
      worker.onmessage = (e) => {
        this.handleMessageFromWorker(e);
      };
    }

    // console.log("✅ Created and initialized 4 workers");
  }

  handleMessageFromWorker(e) {
    // const fromWorker = this.workers[e.currentTarget.name];

    if (e.data.msg === "fps") this.updateFPS(e.currentTarget.name, e.data.fps);
    else if (e.data.msg === "log") {
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

    // Check if all workers are ready
    const allReady = Object.values(this.workerReadyStates).every(
      (ready) => ready
    );

    if (allReady) {
      console.log("🎮 All workers ready! Starting synchronized game loop...");
      this.startAllWorkers();
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

    for (const [name, worker] of Object.entries(this.workers)) {
      if (worker) {
        worker.postMessage({ msg: "start" });
      }
    }

    console.log("✅ All workers started synchronously!");
  }
  updateFPS(id, fps) {
    const element = document.getElementById(id + "FPS");
    if (element) {
      element.textContent = element.textContent.split(":")[0] + `: ${fps}`;
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

    // Mouse events - convert canvas pixels to world coordinates
    this.canvas.addEventListener("mousemove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      // Convert to world coordinates (Y-down system)
      // World position = (canvas position + camera position) / zoom
      this.mouse.x = canvasX / this.camera.zoom + this.camera.x;
      this.mouse.y = canvasY / this.camera.zoom + this.camera.y;

      this.updateInputBuffer();
    });

    this.canvas.addEventListener("mouseleave", (e) => {
      this.mouse.x = -100000;
      this.mouse.y = -100000;
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
    input[0] = this.mouse.x;
    input[1] = this.mouse.y;

    for (const [key, index] of Object.entries(this.keyMap)) {
      input[2 + index] = this.keyboard[key] ? 1 : 0;
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

    this.updateVisibleUnits(GameObject.isItOnScreen.filter((v) => !!v).length);
    this.updateActiveUnits(GameObject.active.filter((v) => !!v).length);
  }

  // Cleanup
  destroy() {
    Object.values(this.workers).forEach((worker) => {
      if (worker) worker.terminate();
    });

    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    // console.log("🔴 GameEngine destroyed");
  }

  pause() {
    this.state.pause = true;
    Object.values(this.workers).forEach((worker) => {
      if (worker) worker.postMessage({ msg: "pause" });
    });
  }

  resume() {
    this.state.pause = false;
    Object.values(this.workers).forEach((worker) => {
      if (worker) worker.postMessage({ msg: "resume" });
    });
  }
}

// Export for use
if (typeof module !== "undefined" && module.exports) {
  module.exports = GameEngine;
}
