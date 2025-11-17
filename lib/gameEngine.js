// GameEngine.js - Centralized game initialization and state management
// Handles workers, SharedArrayBuffers, class registration, and input management

class GameEngine {
  constructor(config, imageUrls) {
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

    // Shared buffers
    this.buffers = {
      gameObjectData: null,
      entityData: new Map(), // Map of EntityClassName -> SharedArrayBuffer
      neighborData: null,
      inputData: null,
      cameraData: null,
    };

    // Typed array views
    this.views = {
      input: null,
      camera: null,
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

    // Initialize GameObject with neighbor buffer
    GameObject.initializeArrays(
      this.buffers.gameObjectData,
      this.totalEntityCount,
      this.buffers.neighborData
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

    // Input buffer: [mouseX, mouseY, key0, key1, key2, ...]
    const INPUT_BUFFER_SIZE = 32 * 4;
    this.buffers.inputData = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    this.views.input = new Int32Array(this.buffers.inputData);

    // Camera buffer: [zoom, containerX, containerY]
    const CAMERA_BUFFER_SIZE = 3 * 4;
    this.buffers.cameraData = new SharedArrayBuffer(CAMERA_BUFFER_SIZE);
    this.views.camera = new Float32Array(this.buffers.cameraData);

    // Initialize camera buffer
    this.views.camera[0] = 1; // zoom

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

  async preloadAssets(imageUrls) {
    // Define your image URLs with their names

    this.loadedTextures = {};

    // Load all images in parallel
    const loadPromises = Object.entries(imageUrls).map(async ([name, url]) => {
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

      // console.log(`✅ Loaded texture: ${name}`);
    });

    // Wait for all images to load
    await Promise.all(loadPromises);

    // console.log(`✅ Preloaded ${Object.keys(loadedTextures).length} textures`);
  }

  // Create and initialize all workers
  async createWorkers() {
    const { canvasWidth, canvasHeight, worldWidth, worldHeight } = this.config;

    // Create workers
    this.workers.spatial = new Worker("lib/spatial_worker.js");
    this.workers.logic = new Worker("lib/logic_worker.js");
    this.workers.physics = new Worker("lib/physics_worker.js");
    this.workers.renderer = new Worker("lib/pixi_worker.js");

    this.workers.spatial.name = "spatial";
    this.workers.logic.name = "logic";
    this.workers.physics.name = "physics";
    this.workers.renderer.name = "renderer";

    // Preload assets before initializing workers
    await this.preloadAssets(this.imageUrls);

    // Collect unique script paths for workers (filter out nulls)
    // Adjust paths to be relative to worker location (workers are in lib/ folder)
    const scriptsToLoad = [
      ...new Set(
        this.registeredClasses
          .map((r) => r.scriptPath)
          .filter((path) => path !== null)
          .map((path) => {
            // If path doesn't start with ../ or http, prepend ../ for workers in lib/
            if (!path.startsWith("../") && !path.startsWith("http")) {
              return `../${path}`;
            }
            return path;
          })
      ),
    ];

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

    // Initialize spatial worker
    this.workers.spatial.postMessage(initData);

    // Initialize logic worker
    this.workers.logic.postMessage(initData);

    // Initialize physics worker
    this.workers.physics.postMessage(initData);

    // Initialize renderer worker (transfer canvas and all textures)
    const offscreenCanvas = this.canvas.transferControlToOffscreen();

    this.workers.renderer.postMessage(
      {
        ...initData,
        view: offscreenCanvas,
        textures: this.loadedTextures, // Send as object with named keys
      },
      [offscreenCanvas, ...Object.values(this.loadedTextures)] // Transfer canvas and all textures
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
    else if (e.data.msg === "toAnotherWorker") {
      const { message, workerName } = e.data;
      this.workers[workerName].postMessage({
        msg: "fromAnotherWorker",
        from: e.currentTarget.name,
        message,
      });
    }

    // console.log("Message from worker:", e);
  }
  updateFPS(id, fps) {
    const element = document.getElementById(id + "FPS");
    if (element) {
      element.textContent = element.textContent.split(":")[0] + `: ${fps}`;
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
