// MainThreadLogicHelper.js - Enables main thread to participate in job stealing
// The main thread claims jobs from the same Atomics-based job queue as logic workers
// This leverages idle main thread cycles to help with entity processing

import { GameObject } from "./gameObject.js";
import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { ParticleComponent } from "../components/ParticleComponent.js";
import { ShadowCaster } from "../components/ShadowCaster.js";
import { LightEmitter } from "../components/LightEmitter.js";
import { SpriteSheetRegistry } from "./SpriteSheetRegistry.js";
import Keyboard from "./Keyboard.js";
import { collectComponents } from "./utils.js";

/**
 * MainThreadLogicHelper - Allows main thread to participate in job stealing
 *
 * The job queue is shared between all logic workers via SharedArrayBuffer.
 * Workers atomically claim jobs using Atomics.add(). This class enables
 * the main thread to also claim and process jobs, utilizing otherwise idle cycles.
 *
 * IMPORTANT: This runs on the main thread, so heavy processing will affect UI responsiveness.
 * The helper is designed to claim a limited number of jobs per frame to balance
 * between helping workers and maintaining smooth UI.
 */
export class MainThreadLogicHelper {
  constructor(gameEngine) {
    this.engine = gameEngine;
    this.config = gameEngine.config;

    // Game objects - mirrors logic_worker's gameObjects array
    this.gameObjects = [];

    // Shared buffer views (initialized after buffers are created)
    this.jobQueueData = null; // Int32Array: [currentJobIndex, totalJobs, job0_start, job0_end, ...]
    this.syncData = null; // Int32Array: [frameNum, completionCounter, totalWorkers, barrier]
    this.neighborData = null; // Neighbor indices for each entity
    this.distanceData = null; // Squared distances for each neighbor
    this.inputData = null; // Keyboard input state

    // Configuration
    this.enabled = false; // Disabled until explicitly enabled
    this.maxJobsPerFrame = 2; // Limit jobs per frame to avoid blocking UI (0 = unlimited)
    this.isMainThreadOnlyMode = false; // True when numberOfLogicWorkers === 0

    // Performance tracking
    this.jobsProcessedThisFrame = 0;
    this.entitiesProcessedThisFrame = 0;
    this.totalJobsProcessed = 0;
    this.totalEntitiesProcessed = 0;

    // Worker index for main thread (-1 to distinguish from real workers)
    // Note: Main thread doesn't participate in collision callbacks (workers handle those)
    this.workerIndex = -1;

    // Frame timing
    this.lastFrameTime = performance.now();
    this.frameNumber = 0;
  }

  /**
   * Initialize the helper after GameEngine creates SharedArrayBuffers
   * Must be called after createSharedBuffers() and before start()
   */
  initialize() {
    const { buffers, views } = this.engine;

    // Create typed array views over SharedArrayBuffers
    if (buffers.jobQueueData) {
      this.jobQueueData = new Int32Array(buffers.jobQueueData);
    }

    if (buffers.syncData) {
      this.syncData = new Int32Array(buffers.syncData);
      // Worker count already includes main thread (set in GameEngine.createSharedBuffers)
      // console.log(`🧵 MainThreadLogicHelper: Total workers = ${this.syncData[2]}`);
    }

    if (buffers.neighborData) {
      this.neighborData = new Int32Array(buffers.neighborData);
    }

    if (buffers.distanceData) {
      this.distanceData = new Float32Array(buffers.distanceData);
    }

    if (buffers.inputData) {
      this.inputData = new Int32Array(buffers.inputData);
      // Initialize Keyboard for main thread
      Keyboard.initialize(this.inputData, this.engine.keyMap);
    }

    // Initialize component arrays (they're already created, just get views)
    this.initializeComponentArrays();

    // Check if we're the only entity processor (0 logic workers)
    this.isMainThreadOnlyMode = this.engine.numberOfLogicWorkers === 0;

    // Create game object instances (calls start() if main-thread-only mode)
    this.createGameObjectInstances();

    this.enabled = true;
    const modeText = this.isMainThreadOnlyMode ? "MAIN THREAD ONLY" : "HELPER";
    console.log(
      `🧵 MainThreadLogicHelper: Initialized as ${modeText} with ${this.gameObjects.length} game objects`
    );
  }

  /**
   * Initialize component array views from SharedArrayBuffers
   * Components use static arrays, so we just need to ensure they're initialized
   */
  initializeComponentArrays() {
    const { buffers, componentPools, totalEntityCount } = this.engine;

    // Collect all unique component classes from registered entities
    const componentClasses = new Map();

    for (const classInfo of this.engine.registeredClasses) {
      const EntityClass = classInfo.class;
      if (!EntityClass) continue;

      const components = collectComponents(EntityClass, GameObject, Transform);
      for (const ComponentClass of components) {
        componentClasses.set(ComponentClass.name, ComponentClass);
      }
    }

    // Initialize each component's static arrays from SharedArrayBuffers
    for (const [componentName, ComponentClass] of componentClasses) {
      const buffer = buffers.componentData?.[componentName];
      const pool = componentPools?.[componentName];

      if (buffer && pool) {
        // Component.initializeArrays() creates typed array views over the SharedArrayBuffer
        // This is idempotent - calling it again just recreates the same views
        ComponentClass.initializeArrays(buffer, pool.count || totalEntityCount);
      }
    }
  }

  /**
   * Create GameObject instances for all registered entity classes
   * Mirrors logic_worker.js createGameObjectInstances()
   */
  createGameObjectInstances() {
    for (const classInfo of this.engine.registeredClasses) {
      const { class: EntityClass, count, startIndex, entityType } = classInfo;

      if (!EntityClass) {
        console.warn(
          `MainThreadLogicHelper: Class not found for registration`,
          classInfo
        );
        continue;
      }

      // Store metadata for spawning system (already done by GameEngine, but ensure it's set)
      EntityClass.startIndex = startIndex;
      EntityClass.totalCount = count;
      EntityClass.entityType = entityType;

      // Ensure instances array exists
      if (!EntityClass.hasOwnProperty("instances")) {
        EntityClass.instances = [];
      }

      // Create component class map for this entity
      const componentClassMap = {};
      const components = collectComponents(EntityClass, GameObject, Transform);

      for (const ComponentClass of components) {
        const componentName = ComponentClass.name;
        const camelCaseName =
          componentName.charAt(0).toLowerCase() + componentName.slice(1);
        componentClassMap[camelCaseName] = ComponentClass;
      }
      EntityClass._componentClassMap = componentClassMap;

      // Create instances
      for (let i = 0; i < count; i++) {
        const index = startIndex + i;

        // Create instance - GameObject will use entity index for all component access
        // Pass `this` as logicWorker reference (for compatibility)
        const instance = new EntityClass(index, this.config, this);
        this.gameObjects[index] = instance;

        // Call start() if we're in main-thread-only mode (0 logic workers)
        // When there are logic workers, they call start() to avoid duplicates
        if (this.isMainThreadOnlyMode && instance.start) {
          instance.start();
        }
      }
    }
  }

  /**
   * Process jobs from the shared job queue
   * Called each frame from GameEngine.update()
   *
   * @param {number} deltaTime - Time since last frame in ms
   * @param {number} dtRatio - Delta time ratio (1.0 = 16.67ms)
   */
  processJobs(deltaTime, dtRatio) {
    if (!this.enabled || !this.jobQueueData) return;

    this.frameNumber++;
    this.jobsProcessedThisFrame = 0;
    this.entitiesProcessedThisFrame = 0;

    const totalJobs = this.jobQueueData[1];
    let jobsClaimed = 0;

    // Claim and process jobs until queue is empty or we hit our limit
    while (true) {
      // Check if we've hit our per-frame limit (0 = unlimited)
      if (this.maxJobsPerFrame > 0 && jobsClaimed >= this.maxJobsPerFrame) {
        break;
      }

      // Atomically claim the next job
      const jobIndex = Atomics.add(this.jobQueueData, 0, 1);

      // Check if all jobs are claimed
      if (jobIndex >= totalJobs) {
        break; // No more jobs available
      }

      jobsClaimed++;
      this.jobsProcessedThisFrame++;

      // Get job range from buffer
      const jobStartIndex = this.jobQueueData[2 + jobIndex * 2];
      const jobEndIndex = this.jobQueueData[2 + jobIndex * 2 + 1];

      // Process all entities in this job's range
      this.processEntityRange(jobStartIndex, jobEndIndex, dtRatio);
    }

    // Participate in job queue reset (same logic as logic_worker)
    this.signalFrameComplete();

    // Update totals
    this.totalJobsProcessed += this.jobsProcessedThisFrame;
    this.totalEntitiesProcessed += this.entitiesProcessedThisFrame;
  }

  /**
   * Process a range of entities (one job's worth)
   *
   * @param {number} startIndex - First entity index
   * @param {number} endIndex - Last entity index (exclusive)
   * @param {number} dtRatio - Delta time ratio
   */
  processEntityRange(startIndex, endIndex, dtRatio) {
    for (let i = startIndex; i < endIndex; i++) {
      const obj = this.gameObjects[i];

      // Skip if no game object or entity is inactive
      if (!obj || !Transform.active[i]) continue;

      this.entitiesProcessedThisFrame++;

      // Update neighbor references before tick
      obj.updateNeighbors(this.neighborData, this.distanceData);

      // Tick entity logic
      obj.tick(dtRatio);

      // Note: Screen visibility callbacks are handled by logic workers only
      // to avoid duplicate callbacks
    }
  }

  /**
   * Signal that this "worker" (main thread) has finished its frame
   * Participates in the Atomics-based completion counter
   */
  signalFrameComplete() {
    if (!this.syncData) return;

    const totalWorkers = this.syncData[2]; // Includes main thread
    const finishedCount = Atomics.add(this.syncData, 1, 1) + 1;

    if (finishedCount === totalWorkers) {
      // Last worker to finish - reset job queue for next frame
      Atomics.store(this.jobQueueData, 0, 0); // Reset job counter
      Atomics.store(this.syncData, 1, 0); // Reset finished counter
    }
  }

  /**
   * Set maximum jobs to process per frame
   * Lower values = more responsive UI, less help to workers
   * Higher values = more help to workers, potentially choppy UI
   *
   * @param {number} max - Max jobs per frame (0 = unlimited)
   */
  setMaxJobsPerFrame(max) {
    this.maxJobsPerFrame = max;
  }

  /**
   * Enable or disable job stealing
   *
   * @param {boolean} enabled - Whether to enable job stealing
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    console.log(
      `🧵 MainThreadLogicHelper: ${enabled ? "ENABLED" : "DISABLED"}`
    );
  }

  /**
   * Get performance statistics
   *
   * @returns {Object} Stats object
   */
  getStats() {
    return {
      enabled: this.enabled,
      maxJobsPerFrame: this.maxJobsPerFrame,
      jobsThisFrame: this.jobsProcessedThisFrame,
      entitiesThisFrame: this.entitiesProcessedThisFrame,
      totalJobs: this.totalJobsProcessed,
      totalEntities: this.totalEntitiesProcessed,
      frameNumber: this.frameNumber,
      isMainThreadOnlyMode: this.isMainThreadOnlyMode,
    };
  }

  /**
   * Spawn an entity (main-thread-only mode)
   * Used when there are 0 logic workers
   *
   * @param {string} className - Name of the entity class
   * @param {Object} spawnConfig - Initial configuration
   */
  spawnEntity(className, spawnConfig = {}) {
    // Find the entity class by name
    const classInfo = this.engine.registeredClasses.find(
      (c) => c.class?.name === className
    );

    if (!classInfo || !classInfo.class) {
      console.error(
        `MainThreadLogicHelper: Cannot spawn ${className} - class not found!`
      );
      return null;
    }

    const EntityClass = classInfo.class;
    const instance = GameObject.spawn(EntityClass, spawnConfig);

    if (!instance) {
      console.warn(
        `MainThreadLogicHelper: Failed to spawn ${className} - pool exhausted!`
      );
      return null;
    }

    return instance;
  }

  /**
   * Despawn all entities of a specific type (main-thread-only mode)
   * Used when there are 0 logic workers
   *
   * @param {string} className - Name of the entity class to despawn
   */
  despawnAllEntities(className) {
    // Find the entity class by name
    const classInfo = this.engine.registeredClasses.find(
      (c) => c.class?.name === className
    );

    if (!classInfo || !classInfo.class) {
      console.error(
        `MainThreadLogicHelper: Cannot despawn ${className} - class not found!`
      );
      return;
    }

    const EntityClass = classInfo.class;
    const entityType = EntityClass.entityType;
    let count = 0;

    for (let i = 0; i < this.engine.totalEntityCount; i++) {
      if (
        Transform.active[i] &&
        Transform.entityType[i] === entityType &&
        this.gameObjects[i]
      ) {
        this.gameObjects[i].despawn();
        count++;
      }
    }

    console.log(
      `MainThreadLogicHelper: Despawned ${count} ${className} entities`
    );
  }
}
