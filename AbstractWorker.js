// AbstractWorker.js - Base class for all game engine workers
// Provides common functionality: frame timing, FPS tracking, pause state, message handling

/**
 * AbstractWorker - Base class for all game engine workers
 * Handles common worker functionality like frame timing, FPS tracking, and message handling
 */
class AbstractWorker {
  constructor(selfRef) {
    this.self = selfRef;

    this.self.onmessage = (e) => {
      this.handleMessage(e);
    };

    // Frame timing and FPS tracking
    this.frameNumber = 0;
    this.lastFrameTime = performance.now();
    this.currentFPS = 0;
    this.fpsReportInterval = 30; // Report FPS every N frames

    // Moving average FPS calculation
    this.fpsFrameCount = 60; // Average over last 60 frames
    this.frameTimes = new Array(this.fpsFrameCount).fill(16.67); // Pre-fill with 60fps baseline
    this.frameTimeIndex = 0;
    this.frameTimesSum = 16.67 * this.fpsFrameCount;

    // State
    this.isPaused = true;
    this.entityCount = 0;

    // Scheduling
    this.usesCustomScheduler = false; // Override in subclass if using custom scheduler

    // Shared buffers (common to most workers)
    this.inputData = null;
    this.cameraData = null;

    // Bind methods
    this.gameLoop = this.gameLoop.bind(this);
    this.handleMessage = this.handleMessage.bind(this);
  }

  /**
   * Calculate delta time and update FPS using moving average
   * @returns {Object} - { deltaTime, dtRatio }
   */
  updateFrameTiming() {
    const now = performance.now();
    const deltaTime = now - this.lastFrameTime;
    this.lastFrameTime = now;

    // Update moving average FPS calculation
    // Remove oldest frame time from sum
    this.frameTimesSum -= this.frameTimes[this.frameTimeIndex];
    // Add new frame time
    this.frameTimes[this.frameTimeIndex] = deltaTime;
    this.frameTimesSum += deltaTime;
    // Move to next index (circular buffer)
    this.frameTimeIndex = (this.frameTimeIndex + 1) % this.fpsFrameCount;

    // Calculate FPS from average frame time over last N frames
    const averageFrameTime = this.frameTimesSum / this.fpsFrameCount;
    this.currentFPS = 1000 / averageFrameTime;

    // Normalize delta time to 60fps (16.67ms per frame)
    const dtRatio = deltaTime / 16.67;

    return { deltaTime, dtRatio };
  }

  /**
   * Report FPS to main thread
   */
  reportFPS() {
    if (this.frameNumber % this.fpsReportInterval === 0) {
      self.postMessage({ msg: "fps", fps: this.currentFPS.toFixed(2) });
    }
  }

  /**
   * Main game loop - calls update() method each frame
   * @param {boolean} resuming - Whether we're resuming from pause
   */
  gameLoop(resuming = false) {
    if (this.isPaused) return;

    this.frameNumber++;
    const timing = this.updateFrameTiming();

    // Call the worker-specific update logic
    this.update(timing.deltaTime, timing.dtRatio, resuming);

    // Report FPS
    this.reportFPS();

    // Schedule next frame (only if not using custom scheduler)
    if (!this.usesCustomScheduler) {
      this.scheduleNextFrame();
    }
  }

  /**
   * Schedule the next frame (can be overridden for custom scheduling)
   */
  scheduleNextFrame() {
    requestAnimationFrame(this.gameLoop);
  }

  /**
   * Start the game loop (call this from initialize())
   */
  startGameLoop() {
    this.isPaused = false;
    this.lastFrameTime = performance.now(); // Reset timing

    if (this.usesCustomScheduler) {
      // Custom scheduler will call gameLoop manually
      this.onCustomSchedulerStart();
    } else {
      // Use requestAnimationFrame
      this.gameLoop();
    }
  }

  /**
   * Override this if using custom scheduler (like PIXI ticker)
   */
  onCustomSchedulerStart() {
    // Override in subclass
  }

  /**
   * Initialize common buffers
   * @param {Object} data - Initialization data from main thread
   */
  initializeCommonBuffers(data) {
    this.entityCount = data.entityCount;

    // Initialize GameObject arrays if buffer provided
    if (data.gameObjectBuffer) {
      GameObject.initializeArrays(data.gameObjectBuffer, this.entityCount);
    }

    // Initialize common shared buffers
    if (data.inputBuffer) {
      this.inputData = new Int32Array(data.inputBuffer);
    }

    if (data.cameraBuffer) {
      this.cameraData = new Float32Array(data.cameraBuffer);
    }
  }

  /**
   * Handle incoming messages from main thread
   * @param {MessageEvent} e - Message event
   */
  handleMessage(e) {
    const { msg } = e.data;

    switch (msg) {
      case "init":
        this.isPaused = false;
        this.initialize(e.data);
        break;

      case "pause":
        this.pause();
        break;

      case "resume":
        this.resume();
        break;

      default:
        this.handleCustomMessage(e.data);
        break;
    }
  }

  /**
   * Pause the worker
   */
  pause() {
    this.isPaused = true;
  }

  /**
   * Resume the worker
   */
  resume() {
    this.isPaused = false;
    this.lastFrameTime = performance.now(); // Reset timing to avoid large delta

    // Reset moving average to avoid pause spike affecting FPS
    this.frameTimes.fill(16.67);
    this.frameTimesSum = 16.67 * this.fpsFrameCount;
    this.frameTimeIndex = 0;

    if (!this.usesCustomScheduler) {
      this.gameLoop(true);
    }
    // If using custom scheduler, it will continue calling gameLoop automatically
  }

  // ==========================================
  // ABSTRACT METHODS - Must be implemented by subclasses
  // ==========================================

  /**
   * Initialize the worker with data from main thread
   * @abstract
   * @param {Object} data - Initialization data
   */
  initialize(data) {
    throw new Error("initialize() must be implemented by subclass");
  }

  /**
   * Update logic called each frame
   * @abstract
   * @param {number} deltaTime - Time since last frame in milliseconds
   * @param {number} dtRatio - Delta time ratio normalized to 60fps
   * @param {boolean} resuming - Whether we're resuming from pause
   */
  update(deltaTime, dtRatio, resuming) {
    throw new Error("update() must be implemented by subclass");
  }

  /**
   * Handle custom messages not covered by standard messages
   * @param {Object} data - Message data
   */
  handleCustomMessage(data) {
    // Override in subclass if needed
  }
}
