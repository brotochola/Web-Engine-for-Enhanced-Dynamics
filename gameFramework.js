// GameFramework.js - Centralized game initialization and state management
// Handles workers, SharedArrayBuffers, and input management

class GameFramework {
  constructor(config) {
    this.config = {
      entityCount: config.entityCount || 20000,
      canvasWidth: config.canvasWidth || 800,
      canvasHeight: config.canvasHeight || 600,
      worldWidth: config.worldWidth || 2200,
      worldHeight: config.worldHeight || 1500,
      maxNeighbors: config.maxNeighbors || 100,
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

  // Initialize everything
  async init() {
    console.log("🎮 GameFramework: Initializing...");

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
      numberBoidsElement.textContent = `Number of boids: ${this.config.entityCount}`;
    }

    console.log("✅ GameFramework: Initialized successfully!");
  }

  // Create all SharedArrayBuffers
  createSharedBuffers() {
    const { entityCount, maxNeighbors } = this.config;

    // Boid data buffer (Structure of Arrays)
    const ARRAYS_COUNT = 8;
    const BYTES_PER_ARRAY = entityCount * 4; // Float32
    const TOTAL_BOID_BUFFER_SIZE = ARRAYS_COUNT * BYTES_PER_ARRAY;
    this.buffers.boidData = new SharedArrayBuffer(TOTAL_BOID_BUFFER_SIZE);

    // Neighbor data buffer
    const NEIGHBOR_BUFFER_SIZE = entityCount * (1 + maxNeighbors) * 4; // Int32
    this.buffers.neighborData = new SharedArrayBuffer(NEIGHBOR_BUFFER_SIZE);

    // Input buffer: [mouseX, mouseY, key0, key1, key2, ...]
    const INPUT_BUFFER_SIZE = 32 * 4; // 32 Int32s
    this.buffers.inputData = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    this.views.input = new Int32Array(this.buffers.inputData);

    // Camera buffer: [zoom, containerX, containerY]
    const CAMERA_BUFFER_SIZE = 3 * 4; // 3 Float32s
    this.buffers.cameraData = new SharedArrayBuffer(CAMERA_BUFFER_SIZE);
    this.views.camera = new Float32Array(this.buffers.cameraData);

    // Initialize camera buffer
    this.views.camera[0] = 1; // zoom
    this.views.camera[1] = 0; // containerX
    this.views.camera[2] = 0; // containerY

    console.log(`✅ Created SharedArrayBuffers:`);
    console.log(`   - Boid Data: ${TOTAL_BOID_BUFFER_SIZE} bytes`);
    console.log(`   - Neighbor Data: ${NEIGHBOR_BUFFER_SIZE} bytes`);
    console.log(`   - Input Data: ${INPUT_BUFFER_SIZE} bytes`);
    console.log(`   - Camera Data: ${CAMERA_BUFFER_SIZE} bytes`);

    // Initialize boid data with random values
    this.initializeBoidData();
  }

  // Initialize boid positions and velocities
  initializeBoidData() {
    const { entityCount, worldWidth, worldHeight } = this.config;
    const arrays = new BoidArrays(this.buffers.boidData);

    for (let i = 0; i < entityCount; i++) {
      arrays.x[i] = Math.random() * worldWidth;
      arrays.y[i] = Math.random() * worldHeight;
      arrays.vx[i] = (Math.random() - 0.5) * 2;
      arrays.vy[i] = (Math.random() - 0.5) * 2;
      arrays.ax[i] = 0;
      arrays.ay[i] = 0;
      arrays.rotation[i] = 0;
      arrays.scale[i] = 0.45 + Math.random() * 0.15;
    }

    console.log(`✅ Initialized ${entityCount} boids with random data`);
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
    this.workers.spatial = new Worker("front/spatial_worker.js");
    this.workers.logic = new Worker("front/logic_worker.js");
    this.workers.physics = new Worker("front/physics_worker.js");
    this.workers.pixi = new Worker("front/pixi_worker.js");

    // Setup FPS monitoring
    this.setupWorkerFPSMonitoring();

    // Initialize spatial worker
    this.workers.spatial.postMessage({
      msg: "init",
      sharedBuffer: this.buffers.boidData,
      neighborBuffer: this.buffers.neighborData,
    });

    // Initialize logic worker
    this.workers.logic.postMessage({
      msg: "init",
      sharedBuffer: this.buffers.boidData,
      neighborBuffer: this.buffers.neighborData,
      inputBuffer: this.buffers.inputData,
      cameraBuffer: this.buffers.cameraData,
    });

    // Initialize physics worker
    this.workers.physics.postMessage({
      msg: "init",
      sharedBuffer: this.buffers.boidData,
      inputBuffer: this.buffers.inputData,
      cameraBuffer: this.buffers.cameraData,
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
        sharedBuffer: this.buffers.boidData,
        inputBuffer: this.buffers.inputData,
        cameraBuffer: this.buffers.cameraData,
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
      // Convert screen coordinates to world coordinates
      // 1. Get position relative to canvas
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;
      // 2. Convert to world space using camera transform
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

    // Mouse position (first 2 elements)
    input[0] = this.mouse.x;
    input[1] = this.mouse.y;

    // Keyboard states (remaining elements)
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

    // Update camera based on keyboard input
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

    // Write camera state to shared buffer
    this.updateCameraBuffer();
  }

  // Cleanup
  destroy() {
    // Terminate workers
    Object.values(this.workers).forEach((worker) => {
      if (worker) worker.terminate();
    });

    // Remove canvas
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    console.log("🔴 GameFramework destroyed");
  }
}

// Export for use
if (typeof module !== "undefined" && module.exports) {
  module.exports = GameFramework;
}
