// AbstractWorker.ts - Base class for all game engine workers
// Provides common functionality: frame timing, FPS tracking, pause state, message handling

import { GameObject } from '../core/gameObject.js';
import type { GameConfig, EntityClassInfo, WorkerMessage } from '../types/index.js';

/**
 * Frame timing data
 */
interface FrameTiming {
  deltaTime: number;
  dtRatio: number;
}

/**
 * Initialization data from main thread
 */
interface WorkerInitData {
  entityCount: number;
  config?: GameConfig;
  scriptsToLoad?: string[];
  buffers?: {
    gameObjectData?: SharedArrayBuffer;
    neighborData?: SharedArrayBuffer;
    distanceData?: SharedArrayBuffer;
    inputData?: SharedArrayBuffer;
    cameraData?: SharedArrayBuffer;
    entityData?: Record<string, SharedArrayBuffer>;
  };
  registeredClasses?: EntityClassInfo[];
  workerPorts?: Record<string, MessagePort>;
}

/**
 * AbstractWorker - Base class for all game engine workers
 * Handles common worker functionality like frame timing, FPS tracking, and message handling
 */
export abstract class AbstractWorker {
  protected self: DedicatedWorkerGlobalScope;

  // Frame timing and FPS tracking
  protected frameNumber: number = 0;
  protected lastFrameTime: number = 0;
  protected currentFPS: number = 0;
  protected fpsReportInterval: number = 30; // Report FPS every N frames

  // Moving average FPS calculation
  protected fpsFrameCount: number = 60; // Average over last 60 frames
  protected frameTimes: number[];
  protected frameTimeIndex: number = 0;
  protected frameTimesSum: number;

  // State
  protected isPaused: boolean = true;
  protected entityCount: number = 0;
  protected config: GameConfig = {} as GameConfig;

  // Scheduling
  protected usesCustomScheduler: boolean = false; // Override in subclass if using custom scheduler
  protected noLimitFPS: boolean = false; // Set to true to run as fast as possible (no RAF limiting)
  protected timeoutId: number | null = null; // Store timeout ID for clearing

  // Script loading
  protected needsGameScripts: boolean = true; // Override to false in generic workers (spatial, physics)

  // Shared buffers (common to most workers)
  protected inputData: Int32Array | null = null;
  protected cameraData: Float32Array | null = null;
  protected neighborData: Int32Array | null = null;
  protected distanceData: Float32Array | null = null; // Squared distances for each neighbor

  // Registered entity classes information
  protected registeredClasses: EntityClassInfo[] = [];

  // MessagePorts for direct worker-to-worker communication
  protected workerPorts: Map<string, MessagePort> = new Map();

  constructor(selfRef: DedicatedWorkerGlobalScope) {
    this.self = selfRef;

    this.self.onmessage = (e: MessageEvent) => {
      this.handleMessage(e);
    };

    // Initialize frame timing
    this.lastFrameTime = performance.now();

    // Initialize moving average FPS calculation
    this.frameTimes = new Array(this.fpsFrameCount).fill(16.67); // Pre-fill with 60fps baseline
    this.frameTimesSum = 16.67 * this.fpsFrameCount;

    // Bind methods
    this.gameLoop = this.gameLoop.bind(this);
    this.handleMessage = this.handleMessage.bind(this);
    this.reportLog('finished constructor');
  }

  /**
   * Calculate delta time and update FPS using moving average
   * @returns Frame timing data
   */
  protected updateFrameTiming(): FrameTiming {
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
  protected reportFPS(): void {
    if (this.frameNumber % this.fpsReportInterval === 0) {
      self.postMessage({ msg: 'fps', fps: this.currentFPS.toFixed(2) });
    }
  }

  protected reportLog(message: string): void {
    self.postMessage({ msg: 'log', message, when: Date.now() });
  }

  /**
   * Main game loop - calls update() method each frame
   * @param resuming - Whether we're resuming from pause
   */
  protected gameLoop(resuming: boolean = false): void {
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
  protected scheduleNextFrame(): void {
    if (this.noLimitFPS) {
      // Run as fast as possible while still yielding to event loop
      // setTimeout(0) runs after current event loop but doesn't wait for next frame
      this.timeoutId = self.setTimeout(() => this.gameLoop(), 2) as any;
    } else {
      // Standard 60fps using requestAnimationFrame
      requestAnimationFrame(() => this.gameLoop());
    }
  }

  /**
   * Start the game loop (call this from initialize())
   */
  protected startGameLoop(): void {
    this.reportLog('starting game loop');
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
  protected onCustomSchedulerStart(): void {
    // Override in subclass
  }

  /**
   * Initialize common buffers
   * @param data - Initialization data from main thread
   */
  protected async initializeCommonBuffers(data: WorkerInitData): Promise<void> {
    this.reportLog('initializing common buffers');
    this.entityCount = data.entityCount;

    // Store config for worker access
    this.config = data.config || ({} as GameConfig);

    // Check if this worker should run with unlimited FPS (no RAF limiting)
    // Each worker type can have its own noLimitFPS setting in its nested config
    const workerType = this.constructor.name
      .replace('Worker', '')
      .toLowerCase();

    // Check nested config first, then fall back to root level
    const workerConfig = (this.config as any)[workerType] || {};
    if (workerConfig.noLimitFPS === true) {
      this.noLimitFPS = true;
      console.log(
        `${this.constructor.name}: Running in unlimited FPS mode (noLimitFPS)`
      );
    }

    // Load game-specific scripts dynamically (if this worker needs them)
    // Some workers (spatial, physics) are generic and don't need game classes
    if (
      this.needsGameScripts &&
      data.scriptsToLoad &&
      data.scriptsToLoad.length > 0
    ) {
      console.log(
        `${this.constructor.name}: Loading ${data.scriptsToLoad.length} game scripts...`
      );

      // Use dynamic import() for ES6 modules (async/await)
      for (const scriptPath of data.scriptsToLoad) {
        try {
          const module = await import(scriptPath);
          // Make the exported class(es) available globally in worker
          Object.keys(module).forEach((key) => {
            (self as any)[key] = module[key];
          });
          console.log(`${this.constructor.name}: ✓ Loaded ${scriptPath}`);
        } catch (error) {
          console.error(
            `${this.constructor.name}: ✗ Failed to load ${scriptPath}:`,
            error
          );
        }
      }
    } else if (!this.needsGameScripts) {
      console.log(
        `${this.constructor.name}: Skipping game scripts (generic worker)`
      );
    }

    // Initialize GameObject arrays if buffer provided
    if (data.buffers?.gameObjectData) {
      GameObject.initializeArrays(
        data.buffers.gameObjectData,
        this.entityCount,
        data.buffers.neighborData || null, // Automatically initialize neighbor data
        data.buffers.distanceData || null // Automatically initialize distance data
      );
    }

    // Initialize common shared buffers using Buffer->Data naming pattern
    if (data.buffers?.inputData) {
      this.inputData = new Int32Array(data.buffers.inputData);
    }

    if (data.buffers?.cameraData) {
      this.cameraData = new Float32Array(data.buffers.cameraData);
    }

    // Initialize neighbor data reference (redundant with GameObject but kept for clarity)
    if (data.buffers?.neighborData) {
      this.neighborData = new Int32Array(data.buffers.neighborData);
    }

    // Initialize distance data reference
    if (data.buffers?.distanceData) {
      this.distanceData = new Float32Array(data.buffers.distanceData);
    }

    // Store registered classes (used by logic worker and potentially others)
    this.registeredClasses = data.registeredClasses || [];
    this.reportLog('finished initializing common buffers');

    // Initialize all entity arrays using standardized method
    if (data.buffers?.entityData && this.registeredClasses.length > 0) {
      this.initializeEntityArrays(
        data.buffers.entityData,
        this.registeredClasses
      );
    }

    // Keep a reference to neighbor data for easy access (already set above, but also from GameObject)
    if (GameObject.neighborData) {
      this.neighborData = GameObject.neighborData;
    }

    // Keep a reference to distance data for easy access
    if (GameObject.distanceData) {
      this.distanceData = GameObject.distanceData;
    }
  }

  /**
   * Initialize entity-specific arrays from entityBuffers
   * @param entityBuffers - Map of entity class name to SharedArrayBuffer
   * @param entityCounts - Array of class info objects
   */
  protected initializeEntityArrays(
    entityBuffers: Record<string, SharedArrayBuffer>,
    entityCounts: EntityClassInfo[]
  ): void {
    this.reportLog('initializing entity arrays');
    if (!entityBuffers) return;

    for (const classInfo of entityCounts) {
      const { name, count } = classInfo;
      const EntityClass = (self as any)[name];
      const buffer = entityBuffers[name];

      if (EntityClass && EntityClass.initializeArrays && buffer) {
        // IMPORTANT: Use entityCount (total) not count (class-specific)
        // Entity arrays must be sized for all entities because subclasses use global indices
        EntityClass.initializeArrays(buffer, this.entityCount);
        console.log(
          `${this.constructor.name}: Initialized ${name} arrays for ${this.entityCount} total entities (${count} of this type)`
        );

        // AUTOMATIC PROPERTY CREATION: Create getters/setters for this class's ARRAY_SCHEMA
        // This makes properties accessible as instance properties (e.g., this.x instead of GameObject.x[this.index])
        // Only create properties if the class has an ARRAY_SCHEMA and we have GameObject._createSchemaProperties
        if (
          EntityClass.ARRAY_SCHEMA &&
          GameObject &&
          GameObject._createSchemaProperties
        ) {
          GameObject._createSchemaProperties(EntityClass);
          console.log(
            `${this.constructor.name}: Auto-created ${
              Object.keys(EntityClass.ARRAY_SCHEMA).length
            } properties for ${name}`
          );
        }
      }
    }
    this.reportLog('finished initializing entity arrays');
  }

  /**
   * Handle incoming messages from main thread
   * @param e - Message event
   */
  protected async handleMessage(e: MessageEvent): Promise<void> {
    const { msg } = e.data;

    switch (msg) {
      case 'init':
        this.isPaused = true; // Keep paused until "start" message
        await this.initializeCommonBuffers(e.data);
        this.initializeWorkerPorts(e.data.workerPorts); // Initialize direct worker communication
        this.initialize(e.data);
        // After initialization, signal ready to main thread
        this.reportReady();
        break;

      case 'start':
        // All workers are ready, start the game loop
        this.reportLog('received start signal, beginning game loop');
        this.startGameLoop();
        break;

      case 'pause':
        this.pause();
        break;

      case 'resume':
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
  protected reportReady(): void {
    this.reportLog('initialization complete, signaling ready');
    self.postMessage({ msg: 'workerReady', worker: this.constructor.name });
  }

  /**
   * Initialize MessagePorts for direct worker-to-worker communication
   * Called during init with ports object from main thread
   * @param ports - Object mapping worker names to MessagePorts
   */
  protected initializeWorkerPorts(ports?: Record<string, MessagePort>): void {
    this.reportLog('initializing worker ports');
    if (!ports) return;

    Object.entries(ports).forEach(([workerName, port]) => {
      this.workerPorts.set(workerName, port);

      // Setup message handler for this port
      port.onmessage = (e: MessageEvent) => {
        this.handleWorkerMessage(workerName, e.data);
      };
    });

    console.log(
      `${this.constructor.name}: Connected to workers:`,
      Array.from(this.workerPorts.keys())
    );
  }

  /**
   * Send data directly to another worker via MessagePort
   * This bypasses the main thread for faster communication
   * @param workerName - Target worker name ('renderer', 'logic', 'physics', etc.)
   * @param data - Data to send
   */
  sendDataToWorker(workerName: string, data: any): void {
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
   * @param fromWorker - Name of sender worker
   * @param data - Message data
   */
  protected handleWorkerMessage(fromWorker: string, data: any): void {
    // Default implementation - subclasses can override
    // Or just pass to handleCustomMessage for unified handling
    this.handleCustomMessage({ ...data, _fromWorker: fromWorker });
  }

  /**
   * Pause the worker
   */
  pause(): void {
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
  resume(): void {
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
   * @param data - Initialization data
   */
  protected abstract initialize(data: WorkerInitData): void;

  /**
   * Update logic called each frame
   * @abstract
   * @param deltaTime - Time since last frame in milliseconds
   * @param dtRatio - Delta time ratio normalized to 60fps
   * @param resuming - Whether we're resuming from pause
   */
  protected abstract update(deltaTime: number, dtRatio: number, resuming: boolean): void;

  /**
   * Handle custom messages not covered by standard messages
   * @param data - Message data
   */
  protected handleCustomMessage(data: any): void {
    // Override in subclass if needed
  }
}
