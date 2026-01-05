// AbstractWorker.js - Base class for all game engine workers
// Provides common functionality: frame timing,  FPS tracking, pause state, message handling

import { GameObject } from "../core/gameObject.js";
import Keyboard from "../core/Keyboard.js";
import { Mouse } from "../core/Mouse.js";
import { ParticleEmitter } from "../core/ParticleEmitter.js";
import { Flash } from "../core/Flash.js";
import { seededRandom } from "../core/utils.js";
import { Camera } from "../core/Camera.js";
import { ParticleComponent } from "../components/ParticleComponent.js";

/**
 * AbstractWorker - Base class for all game engine workers
 * Handles common worker functionality like frame timing, FPS tracking, and message handling
 */
export class AbstractWorker {
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
    this.noLimitFPS = false; // Set to true to run as fast as possible (no RAF limiting)
    this.timeoutId = null; // Store timeout ID for clearing

    // Script loading (ALL workers now load scripts and initialize components)
    // This flag now indicates if worker needs to CREATE GameObject instances (logic workers only)
    this.needsGameScripts = true; // Override to false in generic workers (spatial, physics)

    // Shared buffers (common to most workers)
    // Following the naming pattern: xBuffer (SharedArrayBuffer) -> xData (TypedArray view)
    this.inputData = null;
    this.cameraData = null;
    this.neighborData = null;
    this.distanceData = null; // Squared distances for each neighbor
    this.frameRateData = null; // Real-time FPS tracking for all workers
    this.frameRateIndex = -1; // Index into frameRateData array (different from workerIndex used by logic workers!)

    // Registered entity classes information (set during initialization)
    this.registeredClasses = [];

    // Query system cache for component-based entity filtering
    this.queryCache = null; // Will be initialized from main thread
    this.emptyQueryWarnings = new Set(); // Track empty query warnings (log once per query key)

    // MessagePorts for direct worker-to-worker communication
    this.workerPorts = new Map(); // Map<workerName, MessagePort>

    // Bind methods
    this.gameLoop = this.gameLoop.bind(this);
    this.handleMessage = this.handleMessage.bind(this);
    this.reportLog("finished constructor");
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

    // Calculate instantaneous FPS (real frame time, not moving average)
    const instantaneousFPS = 1000 / deltaTime;

    // Write instantaneous FPS to SharedArrayBuffer for cross-worker access
    if (this.frameRateData && this.frameRateIndex >= 0) {
      this.frameRateData[this.frameRateIndex] = instantaneousFPS;
    }

    // Normalize delta time to 60fps (16.67ms per frame)
    const dtRatio = deltaTime / 16.67;

    return { deltaTime, dtRatio };
  }

  /**
   * Report FPS to main thread
   */
  reportFPS() {
    if (this.frameNumber % this.fpsReportInterval === 0) {
      const message = { msg: "fps", fps: this.currentFPS.toFixed(2) };

      // Include active entity count if available (for logic workers)
      if (this.activeEntityCount !== undefined) {
        message.activeEntities = this.activeEntityCount;
      }

      self.postMessage(message);
    }
  }

  reportLog(message) {
    self.postMessage({ msg: "log", message, when: Date.now() });
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
   * Uses setTimeout(0ms) if noLimitFPS is true to yield to event loop but run ASAP
   * Otherwise uses requestAnimationFrame for standard 60fps
   */
  scheduleNextFrame() {
    if (this.noLimitFPS) {
      // Run as fast as possible while still yielding to event loop
      // setTimeout(0) runs after current event loop but doesn't wait for next frame
      this.timeoutId = setTimeout(this.gameLoop, 2);
    } else {
      // Standard 60fps using requestAnimationFrame
      requestAnimationFrame(this.gameLoop);
    }
  }

  /**
   * Start the game loop (call this from initialize())
   */
  startGameLoop() {
    this.reportLog("starting game loop");
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
  async initializeCommonBuffers(data) {
    // console.log(
    //   `${this.constructor.name}: initializeCommonBuffers called, needsGameScripts=${this.needsGameScripts}`
    // );
    this.reportLog("initializing common buffers");
    this.entityCount = data.entityCount;

    // Store config for worker access
    this.config = data.config || {};

    // Check if this worker should run with unlimited FPS (no RAF limiting)
    // Each worker type can have its own noLimitFPS setting in its nested config
    const workerType = this.constructor.name
      .replace("Worker", "")
      .toLowerCase();

    // Check nested config first, then fall back to root level
    const workerConfig = this.config[workerType] || {};
    if (workerConfig.noLimitFPS === true) {
      this.noLimitFPS = true;
      // console.log(
      //   `${this.constructor.name}: Running in unlimited FPS mode (noLimitFPS)`
      // );
    }

    // Load game-specific scripts dynamically (entity classes + custom components)
    // ALL workers now receive entity classes for consistent component access
    if (data.scriptsToLoad && data.scriptsToLoad.length > 0) {
      // console.log(
      //   `${this.constructor.name}: Loading ${data.scriptsToLoad.length} game scripts...`
      // );

      // Use dynamic import() for ES6 modules (async/await)
      for (const scriptPath of data.scriptsToLoad) {
        try {
          const module = await import(scriptPath);
          // Make the exported class(es) available globally in worker
          Object.keys(module).forEach((key) => {
            self[key] = module[key];
            // console.log(
            //   `${this.constructor.name}: ✓ Registered ${key} from ${scriptPath}`
            // );
          });
          // console.log(`${this.constructor.name}: ✓ Loaded ${scriptPath}`);
        } catch (error) {
          // console.error(
          //   `${this.constructor.name}: ✗ Failed to load ${scriptPath}:`,
          //   error
          // );
          // console.error(`Error stack:`, error.stack);
        }
      }
    }

    // Initialize GameObject arrays if buffer provided
    if (data.buffers?.gameObjectData) {
      GameObject.initializeArrays(
        data.buffers.gameObjectData,
        this.entityCount,
        data.buffers.neighborData, // Automatically initialize neighbor data
        data.buffers.distanceData // Automatically initialize distance data
      );
    }

    // Initialize ParticleComponent arrays (separate particle pool system)
    // Particles are NOT entities - they have their own pool with maxParticles size
    if (data.maxParticles && data.maxParticles > 0) {
      if (data.buffers?.componentData?.ParticleComponent) {
        ParticleComponent.initializeArrays(
          data.buffers.componentData.ParticleComponent,
          data.maxParticles
        );
        ParticleComponent.particleCount = data.maxParticles;
        this.reportLog(
          `initialized ParticleComponent for ${data.maxParticles} particles`
        );
      }
    }

    // Initialize common shared buffers using Buffer->Data naming pattern
    if (data.buffers?.inputData) {
      this.inputData = new Int32Array(data.buffers.inputData);
    }

    if (data.buffers?.cameraData) {
      this.cameraData = new Float32Array(data.buffers.cameraData);
      // Initialize Camera static class for entity code
      Camera.initialize(
        this.cameraData,
        this.config.canvasWidth || 800,
        this.config.canvasHeight || 600
      );
      // Set world bounds for camera clamping
      if (this.config.worldWidth && this.config.worldHeight) {
        Camera.setWorldBounds(this.config.worldWidth, this.config.worldHeight);
      }
    }

    // Initialize neighbor data reference (redundant with GameObject but kept for clarity)
    if (data.buffers?.neighborData) {
      this.neighborData = new Int32Array(data.buffers.neighborData);
    }

    // Initialize distance data reference
    if (data.buffers?.distanceData) {
      this.distanceData = new Float32Array(data.buffers.distanceData);
    }

    // Initialize frame rate tracking buffer
    if (data.buffers?.frameRateData) {
      this.frameRateData = new Float32Array(data.buffers.frameRateData);
    }

    // Store frame rate buffer index for writing to frameRateData
    // Note: This is different from workerIndex used by logic workers for job partitioning!
    if (data.frameRateIndex !== undefined) {
      this.frameRateIndex = data.frameRateIndex;
    }

    // Store registered classes (used by logic worker and potentially others)
    this.registeredClasses = data.registeredClasses || [];

    // Initialize query system for component-based entity filtering
    if (data.queries) {
      this.queryCache = new Map();
      Object.entries(data.queries).forEach(([key, array]) => {
        this.queryCache.set(key, new Int32Array(array));
      });
      this.reportLog(`initialized with ${this.queryCache.size} queries`);
    }

    this.reportLog("finished initializing common buffers");

    // Keep a reference to neighbor data for easy access (already set above, but also from GameObject)
    if (GameObject.neighborData) {
      this.neighborData = GameObject.neighborData;
    }

    // Keep a reference to distance data for easy access
    if (GameObject.distanceData) {
      this.distanceData = GameObject.distanceData;
    }

    // Make camera data available to GameObject for direct access
    if (this.cameraData) {
      GameObject.cameraData = this.cameraData;
    }

    // Register core engine classes globally (GameObject, Mouse, Keyboard, etc.)
    this.registerCoreClasses();

    // Initialize ALL components (core + custom) for ALL workers
    // Connects components to SharedArrayBuffers and makes them globally available
    if (this.registeredClasses && this.registeredClasses.length > 0) {
      this.initializeAllComponents(data);
    }
  }

  /**
   * Register core engine classes globally for all workers
   * These are the fundamental engine classes needed across all worker types
   */
  registerCoreClasses() {
    self.GameObject = GameObject;
    self.Mouse = Mouse;
    self.Keyboard = Keyboard;
    self.ParticleEmitter = ParticleEmitter;
    self.ParticleComponent = ParticleComponent;
    self.Flash = Flash;
    self.Camera = Camera;

    this.reportLog("registered core engine classes globally");
  }

  /**
   * Initialize ALL components by collecting them from entity classes
   * This runs in ALL workers, making all components available everywhere with SharedArrayBuffer connections
   * Handles both core (Transform, RigidBody) and custom (FlockingBehavior, PredatorBehavior) components
   * @param {Object} data - Initialization data containing componentPools and buffers
   */
  initializeAllComponents(data) {
    if (!this.registeredClasses || this.registeredClasses.length === 0) {
      return; // No entity classes registered
    }

    const componentClasses = new Map(); // componentName -> ComponentClass

    // Collect ALL components from all registered entity classes
    for (const classInfo of this.registeredClasses) {
      const EntityClass = self[classInfo.name];
      if (!EntityClass) continue;

      // Use GameObject's static method to collect components (handles inheritance)
      const components = GameObject._collectComponents(EntityClass);
      for (const ComponentClass of components) {
        const componentName = ComponentClass.name;
        componentClasses.set(componentName, ComponentClass);
      }
    }

    // Initialize all component arrays AND make them globally available
    let initializedCount = 0;
    for (const [componentName, ComponentClass] of componentClasses) {
      const pool = data.componentPools?.[componentName];
      const buffer = data.buffers?.componentData?.[componentName];

      // Initialize SharedArrayBuffer connection if data is available
      if (buffer && pool && pool.count > 0) {
        ComponentClass.initializeArrays(buffer, pool.count);
        initializedCount++;
      }

      // Make component globally available for dynamic lookups (even if no buffer)
      self[componentName] = ComponentClass;
    }

    // Log initialization for debugging
    if (componentClasses.size > 0) {
      this.reportLog(
        `initialized ${initializedCount}/${componentClasses.size} component classes with SharedArrayBuffers`
      );
    }
  }

  initSeendedRandom(seed) {
    if (seed == null || seed == undefined) {
      seed = Date.now();
    }
    self.rng = seededRandom(seed);
    // Also make it available globally without 'self.' prefix for entity code
    globalThis.rng = self.rng;
  }

  /**
   * Handle incoming messages from main thread
   * @param {MessageEvent} e - Message event
   */
  async handleMessage(e) {
    const { msg } = e.data;

    switch (msg) {
      case "init":
        this.initSeendedRandom(e.data.config.seed);
        this.isPaused = true; // Keep paused until "start" message
        await this.initializeCommonBuffers(e.data);
        this.initializeWorkerPorts(e.data.workerPorts); // Initialize direct worker communication
        this.initialize(e.data);
        // After initialization, signal ready to main thread
        this.reportReady();
        break;

      case "start":
        // All workers are ready, start the game loop
        this.reportLog("received start signal, beginning game loop");
        this.startGameLoop();
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
   * Report to main thread that this worker is ready
   * Called automatically after initialization completes
   */
  reportReady() {
    this.reportLog("initialization complete, signaling ready");
    self.postMessage({ msg: "workerReady", worker: this.constructor.name });
  }

  /**
   * Initialize MessagePorts for direct worker-to-worker communication
   * Called during init with ports object from main thread
   * @param {Object} ports - Object mapping worker names to MessagePorts
   */
  initializeWorkerPorts(ports) {
    this.reportLog("initializing worker ports");
    if (!ports) return;

    Object.entries(ports).forEach(([workerName, port]) => {
      this.workerPorts.set(workerName, port);

      // Setup message handler for this port
      port.onmessage = (e) => {
        this.handleWorkerMessage(workerName, e.data);
      };
    });

    // console.log(
    //   `${this.constructor.name}: Connected to workers:`,
    //   Array.from(this.workerPorts.keys())
    // );
  }

  /**
   * Send data directly to another worker via MessagePort
   * This bypasses the main thread for faster communication
   * @param {string} workerName - Target worker name ('renderer', 'logic', 'physics', etc.)
   * @param {Object} data - Data to send
   */
  sendDataToWorker(workerName, data) {
    const port = this.workerPorts.get(workerName);
    if (!port) {
      console.warn(
        `${this.constructor.name}: No port to worker "${workerName}". Available:`,
        Array.from(this.workerPorts.keys())
      );
      return;
    }
    port.postMessage(data);
  }

  /**
   * Handle messages from other workers (via MessagePort)
   * Override in subclass for custom handling, or handle in handleCustomMessage
   * @param {string} fromWorker - Name of sender worker
   * @param {Object} data - Message data
   */
  handleWorkerMessage(fromWorker, data) {
    // Default implementation - subclasses can override
    // Or just pass to handleCustomMessage for unified handling
    this.handleCustomMessage({ ...data, _fromWorker: fromWorker });
  }

  /**
   * Pause the worker
   */
  pause() {
    this.isPaused = true;
    // Clear timeout if we're using noLimitFPS mode
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
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

  /**
   * Query entities by component combination
   * Returns indices of entities that have ALL specified components
   *
   * @param {Array<Component>} componentClasses - Array of component classes to query
   * @returns {Int32Array} - Indices of matching entities
   *
   * @example
   * const rigidBodies = this.query([RigidBody]);
   * const physicsObjects = this.query([RigidBody, Collider]);
   */
  query(componentClasses) {
    if (!this.queryCache) {
      console.warn(`[${this.constructor.name}] Query system not initialized!`);
      return new Int32Array(0);
    }

    const key = componentClasses
      .map((CompClass) => CompClass.name)
      .sort()
      .join(",");

    const result = this.queryCache.get(key);

    if (!result) {
      // Only warn once per query key to avoid console spam
      // Empty queries are normal at startup or in scenes without certain entity types
      if (!this.emptyQueryWarnings.has(key)) {
        console.warn(
          `[${this.constructor.name}] No entities found for query: ${key} (this warning will only show once)`
        );
        this.emptyQueryWarnings.add(key);
      }
      return new Int32Array(0);
    }

    return result;
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
