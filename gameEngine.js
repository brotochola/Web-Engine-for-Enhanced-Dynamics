// GameEngine.js - Centralized game initialization and state management
// Handles workers, SharedArrayBuffers, class registration, and input management

class GameEngine {
  constructor(config) {
    this.state = {
      pause: false,
    };
    this.config = {
      canvasWidth: config.canvasWidth || CANVAS_WIDTH,
      canvasHeight: config.canvasHeight || CANVAS_HEIGHT,
      worldWidth: config.worldWidth || WIDTH,
      worldHeight: config.worldHeight || HEIGHT,
      maxNeighbors: config.maxNeighbors || MAX_NEIGHBORS_PER_ENTITY,
      ...config,
    };

    // State
    this.keyboard = {};
    this.mouse = { x: 0, y: 0 };
    this.camera = {
      zoom: 1,
      x: 0,
      y: 0,
    };

    // Workers
    this.workers = {
      spatial: null,
      logic: null,
      physics: null,
      pixi: null,
    };

    // Shared buffers
    this.buffers = {
      gameObjectData: null,
      boidData: null,
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
   */
  registerEntityClass(EntityClass, count) {
    const startIndex = this.totalEntityCount;

    this.registeredClasses.push({
      class: EntityClass,
      count: count,
      startIndex: startIndex,
    });

    this.totalEntityCount += count;

    console.log(
      `✅ Registered ${
        EntityClass.name
      }: ${count} entities (indices ${startIndex}-${startIndex + count - 1})`
    );
  }

  // Initialize everything
  async init() {
    console.log("🎮 GameEngine: Initializing...");

    // Check SharedArrayBuffer support
    if (typeof SharedArrayBuffer === "undefined") {
      throw new Error("SharedArrayBuffer not available! Check CORS headers.");
    }

    // Create shared buffers
    this.createSharedBuffers();

    // Initialize canvas
    this.createCanvas();

    // Create entity instances
    this.createEntityInstances();

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

    console.log("✅ GameEngine: Initialized successfully!");
  }

  // Create all SharedArrayBuffers
  createSharedBuffers() {
    // GameObject buffer (transform + physics + perception)
    const gameObjectBufferSize = GameObject.getBufferSize(
      this.totalEntityCount
    );
    this.buffers.gameObjectData = new SharedArrayBuffer(gameObjectBufferSize);
    GameObject.initializeArrays(
      this.buffers.gameObjectData,
      this.totalEntityCount
    );

    // Initialize subclass buffers
    for (const registration of this.registeredClasses) {
      const { class: EntityClass, count } = registration;

      if (EntityClass.getBufferSize && EntityClass.initializeArrays) {
        const bufferSize = EntityClass.getBufferSize(count);
        const buffer = new SharedArrayBuffer(bufferSize);

        // Store buffer reference
        if (EntityClass.name === "Boid") {
          this.buffers.boidData = buffer;
        }
        // Add more entity types here as needed

        EntityClass.initializeArrays(buffer, count);
      }
    }

    // Neighbor data buffer
    const NEIGHBOR_BUFFER_SIZE =
      this.totalEntityCount * (1 + this.config.maxNeighbors) * 4;
    this.buffers.neighborData = new SharedArrayBuffer(NEIGHBOR_BUFFER_SIZE);

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
    this.views.camera[1] = 0; // containerX
    this.views.camera[2] = 0; // containerY

    console.log(`✅ Created SharedArrayBuffers:`);
    console.log(`   - GameObject Data: ${gameObjectBufferSize} bytes`);
    if (this.buffers.boidData) {
      console.log(`   - Boid Data: ${this.buffers.boidData.byteLength} bytes`);
    }
    console.log(`   - Neighbor Data: ${NEIGHBOR_BUFFER_SIZE} bytes`);
    console.log(`   - Input Data: ${INPUT_BUFFER_SIZE} bytes`);
    console.log(`   - Camera Data: ${CAMERA_BUFFER_SIZE} bytes`);
  }

  // Create entity instances and initialize their values
  createEntityInstances() {
    for (const registration of this.registeredClasses) {
      const { class: EntityClass, count, startIndex } = registration;

      for (let i = 0; i < count; i++) {
        const index = startIndex + i;
        const entity = new EntityClass(index);
        this.gameObjects[index] = entity;
      }

      console.log(`✅ Created ${count} ${EntityClass.name} instances`);
    }
  }

  // Create canvas element
  createCanvas() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.config.canvasWidth;
    this.canvas.height = this.config.canvasHeight;
    document.body.appendChild(this.canvas);

    console.log(
      `✅ Created canvas: ${this.config.canvasWidth}x${this.config.canvasHeight}`
    );
  }

  // Create and initialize all workers
  createWorkers() {
    const { canvasWidth, canvasHeight, worldWidth, worldHeight } = this.config;

    // Create workers
    this.workers.spatial = new Worker("spatial_worker.js");
    this.workers.logic = new Worker("logic_worker.js");
    this.workers.physics = new Worker("physics_worker.js");
    this.workers.pixi = new Worker("pixi_worker.js");

    // Setup FPS monitoring
    this.setupWorkerFPSMonitoring();

    // Initialize spatial worker
    this.workers.spatial.postMessage({
      msg: "init",
      gameObjectBuffer: this.buffers.gameObjectData,
      neighborBuffer: this.buffers.neighborData,
      entityCount: this.totalEntityCount,
    });

    // Initialize logic worker
    this.workers.logic.postMessage({
      msg: "init",
      gameObjectBuffer: this.buffers.gameObjectData,
      boidBuffer: this.buffers.boidData,
      neighborBuffer: this.buffers.neighborData,
      inputBuffer: this.buffers.inputData,
      cameraBuffer: this.buffers.cameraData,
      entityCount: this.totalEntityCount,
      registeredClasses: this.registeredClasses.map((r) => ({
        name: r.class.name,
        count: r.count,
        startIndex: r.startIndex,
      })),
    });

    // Initialize physics worker
    this.workers.physics.postMessage({
      msg: "init",
      gameObjectBuffer: this.buffers.gameObjectData,
      inputBuffer: this.buffers.inputData,
      cameraBuffer: this.buffers.cameraData,
      entityCount: this.totalEntityCount,
    });

    // Initialize pixi worker (transfer canvas)
    const offscreenCanvas = this.canvas.transferControlToOffscreen();
    this.workers.pixi.postMessage(
      {
        msg: "init",
        width: worldWidth,
        height: worldHeight,
        canvasWidth: canvasWidth,
        canvasHeight: canvasHeight,
        resolution: 1,
        view: offscreenCanvas,
        gameObjectBuffer: this.buffers.gameObjectData,
        inputBuffer: this.buffers.inputData,
        cameraBuffer: this.buffers.cameraData,
        entityCount: this.totalEntityCount,
      },
      [offscreenCanvas]
    );

    console.log("✅ Created and initialized 4 workers");
  }

  // Setup FPS monitoring for workers
  setupWorkerFPSMonitoring() {
    const updateFPS = (id, fps) => {
      const element = document.getElementById(id);
      if (element) {
        element.textContent = element.textContent.split(":")[0] + `: ${fps}`;
      }
    };

    this.workers.spatial.onmessage = (e) => {
      if (e.data.msg === "fps") updateFPS("spatialFPS", e.data.fps);
    };

    this.workers.logic.onmessage = (e) => {
      if (e.data.msg === "fps") updateFPS("logicFPS", e.data.fps);
    };

    this.workers.physics.onmessage = (e) => {
      if (e.data.msg === "fps") updateFPS("physicsFPS", e.data.fps);
    };

    this.workers.pixi.onmessage = (e) => {
      if (e.data.msg === "fps") updateFPS("renderFPS", e.data.fps);
    };
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

    // Mouse events
    this.canvas.addEventListener("mousemove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;
      this.mouse.x = (canvasX - this.camera.x) / this.camera.zoom;
      this.mouse.y = (canvasY - this.camera.y) / this.camera.zoom;
      this.updateInputBuffer();
    });

    // Mouse wheel for zoom
    window.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.camera.zoom += -e.deltaY * 0.001;
        this.camera.zoom = Math.max(0.1, Math.min(5, this.camera.zoom));
        this.updateCameraBuffer();
      },
      { passive: false }
    );

    console.log("✅ Setup event listeners");
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
    console.log("✅ Started main loop");
  }

  // Main update function (60fps)
  update(deltaTime) {
    const dtRatio = deltaTime / 16.67;
    const moveSpeed = (10 / this.camera.zoom) * dtRatio;

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

    console.log("🔴 GameEngine destroyed");
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
